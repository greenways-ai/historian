(ns code-historian.kondo-analyzer
  (:require [babashka.pods :as pods]
            [cheshire.core :as json]
            [code-historian.structural :as structural]
            [clojure.string :as str])
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
  (range-for source
             (merge data {:row (:name-row data)
                          :col (:name-col data)
                          :end-row (:name-end-row data)
                          :end-col (:name-end-col data)})))

(defn kondo-kind [defined-by symbol-name]
  (let [value (or (some-> defined-by name str) "")]
    (cond
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
  (let [name (some-> (:name data) str)
        qualified (qualified-name (or (some-> (:ns data) str) namespace) name)
        kind (kondo-kind (:defined-by data) name)
        range (range-for source data)
        selection (name-range source data)
        start (char-offset source (:row data) (:col data))
        end (char-offset source (or (:end-row data) (:row data))
                         (or (:end-col data) (:col data)))
        structural-features (structural/features-for-text
                             (subs source start (min (count source) (max start end))))]
    {:local_id (str "kondo-symbol-" (:row data) "-" (:name-col data) "-" name)
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

(defn usage-resolution [data]
  (let [target (:to data)]
    (cond
      (and target (not= target :clj-kondo/unknown-namespace)) "resolved"
      (:alias data) "candidate"
      :else "unresolved")))

(defn var-reference [source data]
  (let [name (str (:name data))
        target (when (:to data) (qualified-name (str (:to data)) name))]
    {:kind (if (:arity data) "call" "read")
     :range (range-for source data)
     :source_symbol_local_id (when (:from-var data) (str "kondo-var-" (:from-var data)))
     :target_text name
     :target_qualified_name target
     :resolution (usage-resolution data)
     :confidence (if (= "resolved" (usage-resolution data)) 1.0 0.5)}))

(defn local-reference [source data]
  {:kind "read"
   :range (range-for source data)
   :target_text (str (:name data))
   :resolution "resolved"
   :confidence 1.0})

(defn namespace-reference [source data]
  {:kind "import"
   :range (range-for source data)
   :target_text (str (:to data))
   :target_qualified_name (str (:to data))
   :resolution "resolved"
   :confidence 1.0})

(defn diagnostic [source data]
  {:message (:message data)
   :severity (name (or (:level data) :error))
   :range (range-for source data)
   :code (name (or (:type data) :analysis))})

(defn temp-suffix [path]
  (or (some #(when (str/ends-with? path %) %) [".cljs" ".cljc" ".bb" ".clj"])
      ".clj"))

(defn run-analysis [source path blob-oid language]
  (let [file (Files/createTempFile "code-historian-kondo-" (temp-suffix path) (make-array java.nio.file.attribute.FileAttribute 0))
        temp-path (.toString file)]
    (try
      (spit temp-path source)
      (let [result (@(ensure-kondo!) {:lint [temp-path]
                                      :config {:analysis {:locals true
                                                          :symbols true
                                                          :protocol-impls true
                                                          :arglists true}
                                               :linters {:namespace-name-mismatch {:level :off}}}})
            analysis (:analysis result)
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
            symbols (->> (concat namespaces vars locals)
                         (sort-by (juxt #(get-in % [:range :start_byte]) :kind :name))
                         vec)
            references (->> (concat (map #(var-reference source %) (:var-usages analysis))
                                   (map #(local-reference source %) (:local-usages analysis))
                                   (map #(namespace-reference source %) (:namespace-usages analysis)))
                           (sort-by (juxt #(get-in % [:range :start_byte]) :kind :target_text))
                           vec)
            imports (->> (:namespace-usages analysis) (map :to) (map str) distinct sort vec)]
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
      "describe" (response request :result {:name "code-historian-clojure-kondo"
                                             :version analyzer-version
                                             :protocol_versions [protocol-version]
                                             :languages ["clojure" "clojurescript"]
                                             :extensions [".clj" ".cljs" ".cljc" ".bb"]
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
