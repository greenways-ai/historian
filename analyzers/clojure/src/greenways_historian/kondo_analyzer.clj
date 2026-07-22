(ns greenways-historian.kondo-analyzer
  (:require [babashka.pods :as pods]
            [cheshire.core :as json]
            [greenways-historian.structural :as structural]
            [clojure.string :as str]
            [rewrite-clj.node :as node]
            [rewrite-clj.parser :as parser])
  (:import [java.nio.charset StandardCharsets]
           [java.nio.file Files]
           [java.security MessageDigest]))

(def protocol-version "1.0")
(def analyzer-version "0.2.0-kondo")
(def max-message-bytes (* 10 1024 1024))
(def kondo-run! (atom nil))

(defn sha256 [value]
  (let [digest (.digest (MessageDigest/getInstance "SHA-256")
                        (.getBytes (str value) StandardCharsets/UTF_8))]
    (apply str (map #(format "%02x" (bit-and % 0xff)) digest))))

(defn byte-count [value]
  (alength (.getBytes (str value) StandardCharsets/UTF_8)))

(defn value-text [value]
  (cond
    (nil? value) nil
    (keyword? value) (name value)
    :else (str value)))

(defn ensure-kondo! []
  (or @kondo-run!
      (do
        (pods/load-pod "clj-kondo")
        (require 'pod.borkdude.clj-kondo)
        (reset! kondo-run! (resolve 'pod.borkdude.clj-kondo/run!))
        @kondo-run!)))

(defn char-offset [source row col]
  (let [lines (str/split source #"\n" -1)
        before (take (max 0 (dec (or row 1))) lines)]
    (+ (reduce #(+ % (count %2) 1) 0 before)
       (max 0 (dec (or col 1))))))

(defn position [row col]
  {:line (max 1 (or row 1)), :column (max 1 (or col 1))})

(defn line-column [source char-offset]
  (let [lines (str/split (subs source 0 char-offset) #"\n" -1)]
    {:line (count lines), :column (inc (count (last lines)))}))

(defn source-range [source snippet cursor]
  (let [found (.indexOf source snippet cursor)
        start-char (if (neg? found) cursor found)
        end-char (+ start-char (count snippet))]
    {:range {:start_byte (byte-count (subs source 0 start-char))
             :end_byte (byte-count (subs source 0 end-char))
             :start (line-column source start-char)
             :end (line-column source end-char)}
     :next-cursor end-char}))

(defn range-for [source data]
  (let [start-row (:row data)
        start-col (:col data)
        end-row (or (:end-row data) start-row)
        end-col (or (:end-col data) start-col)
        start-char (char-offset source start-row start-col)
        end-char (char-offset source end-row end-col)
        start-char (min start-char (count source))
        end-char (min (max start-char end-char) (count source))]
    {:start_byte (byte-count (subs source 0 start-char))
     :end_byte (byte-count (subs source 0 end-char))
     :start (position start-row start-col)
     :end (position end-row end-col)}))

(defn name-range [source data]
  (let [name (or (value-text (:name data)) "")
        row (or (:name-row data) (:row data) 1)
        col (or (:name-col data) (:col data) 1)
        end-row (or (:name-end-row data) row)
        end-col (or (:name-end-col data) (+ col (count name)))]
    (range-for source
               (merge data {:row row
                            :col col
                            :end-row end-row
                            :end-col end-col}))))

(defn kondo-kind [data symbol-name]
  (let [defined-by (:defined-by data)
        value (or (value-text defined-by) "")]
    (cond
      (:protocol-name data) "method"
      (str/includes? value "defmacro") "macro"
      (str/includes? value "defmulti") "multimethod"
      (str/includes? value "defmethod") "method"
      (str/includes? value "defprotocol") "protocol"
      (str/includes? value "defrecord") "record"
      (str/includes? value "deftype") "type"
      (str/includes? value "deftest") "test"
      (or (str/includes? value "defn")
          (str/starts-with? (or symbol-name "") "->")
          (str/starts-with? (or symbol-name "") "map->")) "function"
      :else "variable")))

(defn qualified-name [ns name]
  (when name (if ns (str ns "/" name) name)))

(defn symbol-fact [source namespace data]
  (let [name (value-text (:name data))
        qualified (qualified-name (or (some-> (:ns data) str) namespace) name)
        kind (kondo-kind data name)
        range (range-for source data)
        selection (name-range source data)
        start (char-offset source (:row data) (:col data))
        end (char-offset source (or (:end-row data) (:row data))
                         (or (:end-col data) (:col data)))
        structural-features (when-not (= "local" (str (:defined-by data)))
                             (structural/features-for-text
                              (subs source start (min (count source) (max start end)))))]
    {:local_id (str "kondo-symbol-" (:row data) "-" (or (:name-col data) (:col data)) "-" name)
     :kind kind
     :name name
     :qualified_name qualified
     :range range
     :selection_range selection
     :signature (first (:arglist-strs data))
     :modifiers (cond-> [] (:private data) (conj "private"))
     :metadata (select-keys data [:doc :added :deprecated :protocol-name :protocol-ns :defined-by])
     :source_hash (sha256 (str name (:row data) (:col data) (:end-row data) (:end-col data)))
     :structural_hash (or (:shape_hash structural-features)
                          (sha256 (select-keys data [:ns :name :defined-by :arglist-strs :protocol-name :protocol-ns])))
     :structural_features structural-features
     :structure {:source "clj-kondo" :analysis (select-keys data [:ns :name :defined-by :arglist-strs :protocol-name :protocol-ns])}}))

(defn namespace-fact [source data]
  (let [name (str (:name data))
        range (range-for source data)
        selection (name-range source data)]
    {:local_id (str "kondo-namespace-" name)
     :kind "namespace"
     :name name
     :qualified_name name
     :range range
     :selection_range selection
     :source_hash (sha256 name)
     :structural_hash (sha256 {:namespace name})
     :structure {:source "clj-kondo"}}))

(defn meaningful-children [form]
  (->> (node/children form)
       (remove #(contains? #{:whitespace :newline :comment :comma} (node/tag %)))))

(defn token-text [form]
  (when form
    (try (value-text (node/sexpr form))
         (catch Exception _ (node/string form)))))

(defn top-level-forms [source]
  (try
    (let [root (parser/parse-string-all source)]
      (filter #(= :list (node/tag %)) (meaningful-children root)))
    (catch Exception _ [])))

(defn supplemental-symbol [source namespace form index cursor]
  (let [children (vec (meaningful-children form))
        head (token-text (first children))
        raw-name (token-text (second children))
        dispatch (token-text (nth children 2 nil))
        [kind name metadata]
        (cond
          (= head "defmethod") ["method" (when (and raw-name dispatch) (str raw-name "/" dispatch)) {:defined-by head :dispatch-value dispatch}]
          (= head "deftest") ["test" raw-name {:defined-by head}]
          :else [nil nil nil])]
    (when name
      (let [snippet (node/string form)
            {form-range :range next-cursor :next-cursor} (source-range source snippet cursor)
            form-start (max cursor (.indexOf source snippet cursor))
            {selection-range :range} (source-range source name form-start)
            features (structural/features-for-text snippet)]
        {:symbol {:local_id (str "kondo-form-" index "-" kind)
                  :kind kind
                  :name name
                  :qualified_name (qualified-name namespace name)
                  :range form-range
                  :selection_range selection-range
                  :metadata metadata
                  :source_hash (sha256 snippet)
                  :structural_hash (:shape_hash features)
                  :structural_features features
                  :structure {:source "rewrite-clj" :head head}}
         :next-cursor next-cursor}))))

(defn supplemental-field-symbols [source namespace form index cursor]
  (let [children (vec (meaningful-children form))
        head (token-text (first children))
        owner (token-text (second children))
        fields (nth children 2 nil)]
    (when (and (contains? #{"defrecord" "deftype"} head)
               owner
               (= :vector (node/tag fields)))
      (loop [remaining (seq (meaningful-children fields)), field-cursor (max cursor (.indexOf source (node/string form) cursor)), field-index 0, result []]
        (if-let [field (first remaining)]
          (let [name (token-text field)
                text (node/string field)
                {field-range :range next-cursor :next-cursor} (source-range source text field-cursor)
                qualified (qualified-name namespace (str owner "/" name))]
            (recur (next remaining)
                   next-cursor
                   (inc field-index)
                   (conj result
                         {:local_id (str "kondo-field-" index "-" field-index)
                          :kind "field"
                          :name name
                          :qualified_name qualified
                          :range field-range
                          :selection_range field-range
                          :metadata {:defined-by head :owner owner}
                          :source_hash (sha256 text)
                          :structural_hash (sha256 {:owner owner :field name :defined-by head})
                          :structure {:source "rewrite-clj" :head head}})))
          result)))))

(defn supplemental-symbols [source namespace]
  (loop [forms (seq (top-level-forms source)), cursor 0, index 0, result []]
    (if-let [form (first forms)]
      (let [{:keys [symbol next-cursor]} (or (supplemental-symbol source namespace form index cursor) {})]
        (recur (next forms) (or next-cursor cursor) (inc index) (cond-> result symbol (conj symbol))))
      result)))

(defn dedupe-symbols [symbols]
  (reduce (fn [result symbol]
            (let [same-index (first (keep-indexed
                                    (fn [index existing]
                                      (when (or (and (= (:qualified_name existing) (:qualified_name symbol))
                                                     (= (:kind existing) (:kind symbol)))
                                                (and (= (get-in existing [:range :start_byte]) (get-in symbol [:range :start_byte]))
                                                     (= (get-in existing [:range :end_byte]) (get-in symbol [:range :end_byte]))))
                                        index))
                                    result))]
              (cond
                (nil? same-index) (conj result symbol)
                (and (= "variable" (:kind (nth result same-index)))
                     (not= "variable" (:kind symbol))) (assoc result same-index symbol)
                :else result)))
          []
          symbols))

(defn usage-resolution [data]
  (let [target (:to data)]
    (cond
      (and target (not= target :clj-kondo/unknown-namespace)) "resolved"
      (:alias data) "candidate"
      :else "unresolved")))

(defn source-symbol-local-id [source symbols data]
  (let [from (value-text (:from-var data))]
    (or (some (fn [symbol]
                (when (and from
                           (or (= from (:name symbol))
                               (= from (:qualified_name symbol))))
                  (:local_id symbol)))
              symbols)
        (let [reference (range-for source data)
              reference-start (:start_byte reference)
              reference-end (:end_byte reference)
              enclosing (->> symbols
                             (filter #(and (not (contains? #{"namespace" "variable" "field"} (:kind %)))
                                           (<= (get-in % [:range :start_byte]) reference-start)
                                           (>= (get-in % [:range :end_byte]) reference-end)))
                             (sort-by #(let [range (:range %)]
                                         (- (:end_byte range) (:start_byte range))))
                             first)]
          (:local_id enclosing)))))

(defn var-reference [source symbols data]
  (let [name (value-text (:name data))
        target (when (:to data) (qualified-name (value-text (:to data)) name))]
    {:kind (if (:arity data) "call" "read")
     :range (range-for source data)
     :source_symbol_local_id (source-symbol-local-id source symbols data)
     :target_text name
     :target_qualified_name target
     :resolution (usage-resolution data)
     :confidence (if (= "resolved" (usage-resolution data)) 1.0 0.5)}))

(defn local-reference [source symbols data]
  {:kind "read"
   :range (range-for source data)
   :source_symbol_local_id (source-symbol-local-id source symbols data)
   :target_text (value-text (:name data))
   :resolution "resolved"
   :confidence 1.0})

(defn namespace-reference [source symbols data]
  {:kind "import"
   :range (range-for source data)
   :source_symbol_local_id (source-symbol-local-id source symbols data)
   :target_text (value-text (:to data))
   :target_qualified_name (value-text (:to data))
   :resolution "resolved"
   :confidence 1.0})

(defn diagnostic [source data]
  {:message (or (value-text (:message data)) "analysis diagnostic")
   :severity (if (keyword? (:level data)) (name (:level data)) (str (or (:level data) "error")))
   :range (range-for source data)
   :code (if (keyword? (:type data)) (name (:type data)) (str (or (:type data) "analysis")))})

(defn temp-suffix [path]
  (or (some #(when (str/ends-with? path %) %) [".bb" ".clj"])
      ".clj"))

(defn run-analysis [source path blob-oid language]
  (when-not (contains? #{"clojure" "babashka"} language)
    (throw (ex-info "unsupported language" {:code "unsupported_language"})))
  (let [file (Files/createTempFile "greenways-historian-kondo-" (temp-suffix path) (make-array java.nio.file.attribute.FileAttribute 0))
        temp-path (.toString file)]
    (try
      (spit temp-path source)
      (let [result (try
                     (@(ensure-kondo!) {:lint [temp-path]
                                        :config {:analysis {:locals true
                                                            :symbols true
                                                            :protocol-impls true
                                                            :arglists true}
                                                 :linters {:namespace-name-mismatch {:level :off}}}})
                     (catch Exception error
                       {:analysis {}
                        :findings [{:message (.getMessage error), :level :error, :type :parse-error}]}))
            analysis (or (:analysis result) {})
            namespace (some-> (first (:namespace-definitions analysis)) :name str)
            vars (map #(symbol-fact source namespace %)
                      (:var-definitions analysis))
            namespaces (map #(namespace-fact source %) (:namespace-definitions analysis))
            locals (map (fn [data]
                          (let [local-data (assoc data
                                                   :defined-by "local"
                                                   :name-row (:row data)
                                                   :name-col (:col data)
                                                   :name-end-row (:end-row data)
                                                   :name-end-col (:end-col data))]
                            (assoc (symbol-fact source namespace local-data)
                                 :local_id (str "kondo-local-" (:id data))
                                 :kind "variable")))
                        (:locals analysis))
            supplemental (supplemental-symbols source namespace)
            fields (mapcat (fn [[index form]]
                             (supplemental-field-symbols source namespace form index 0))
                           (map-indexed vector (top-level-forms source)))
            symbols (->> (concat namespaces vars locals supplemental fields)
                         dedupe-symbols
                         (sort-by (juxt #(get-in % [:range :start_byte]) :kind :name))
                         vec)
            references (->> (concat (map #(var-reference source symbols %) (:var-usages analysis))
                                   (map #(local-reference source symbols %) (:local-usages analysis))
                                   (map #(namespace-reference source symbols %) (:namespace-usages analysis)))
                           (sort-by (juxt #(get-in % [:range :start_byte]) :kind :target_text))
                           vec)
            imports (->> (:namespace-usages analysis) (map :to) (map value-text) (remove nil?) distinct sort vec)]
        {:file {:language language
                :path path
                :blob_oid blob-oid
                :namespace namespace
                :imports imports
                :source_bytes (byte-count source)}
         :symbols symbols
         :references references
         :diagnostics (mapv #(diagnostic source %) (:findings result))})
      (finally
        (Files/deleteIfExists file)))))

(defn response [request body-key body]
  (merge {:protocol_version protocol-version
          :request_id (or (:request_id request) "unknown")
          :op (or (:op request) "unknown")}
         {body-key body}))

(defn handle-request [request]
  (try
    (when-not (= protocol-version (:protocol_version request))
      (throw (ex-info "unsupported protocol version" {:code "invalid_request"})))
    (case (:op request)
      "describe" (response request :result {:name "greenways-historian-clojure-kondo"
                                             :version analyzer-version
                                             :protocol_versions [protocol-version]
                                             :languages ["clojure" "babashka"]
                                             :extensions [".clj" ".bb"]
                                             :capabilities ["symbols" "locals" "references" "protocol_impls" "metadata" "structural_features"]
                                             :max_message_bytes max-message-bytes
                                             :fingerprint (sha256 (str analyzer-version ":clj-kondo"))})
      "ping" (response request :result {:ok true})
      "shutdown" (response request :result {:ok true})
      "analyze" (response request :result (run-analysis (:source request)
                                                         (:path request)
                                                         (:blob_oid request)
                                                         (or (:language request) "clojure")))
      (throw (ex-info "unsupported operation" {:code "unsupported_operation"})))
    (catch Exception error
      (response request :error {:code (or (:code (ex-data error)) "internal_error")
                                :message (.getMessage error)}))))

(defn -main [& _]
  (loop []
    (when-let [line (read-line)]
      (let [request (try (json/parse-string line true)
                         (catch Exception _ {:request_id "unknown" :op "unknown"}))
            result (handle-request request)]
        (println (json/generate-string result))
        (flush)
        (when-not (= "shutdown" (:op request)) (recur))))))
