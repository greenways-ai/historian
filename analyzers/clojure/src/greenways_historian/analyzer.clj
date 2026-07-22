(ns greenways-historian.analyzer
  (:require [cheshire.core :as json]
            [clojure.string :as str]
            [greenways-historian.structural :as structural]
            [rewrite-clj.node :as node]
            [rewrite-clj.parser :as parser])
  (:import [java.nio.charset StandardCharsets]
           [java.security MessageDigest]))

(def protocol-version "1.0")
(def analyzer-version "0.1.0")
(def max-message-bytes (* 10 1024 1024))

(def definition-kinds
  {"def" "variable", "defonce" "variable", "defn" "function",
   "defn-" "function", "defmacro" "macro", "defmulti" "multimethod",
   "defmethod" "method", "defprotocol" "protocol", "defrecord" "record",
   "deftype" "type", "deftest" "test"})

(def non-call-heads
  (into (set (keys definition-kinds))
        ["ns" "fn" "fn*" "let" "letfn" "loop" "recur" "if" "if-not"
         "when" "when-not" "cond" "condp" "case" "do" "quote" "var" "set!"
         "try" "catch" "finally" "throw" "new" "." ".." "doto" "locking"
         "with-open" "binding" "for" "doseq" "dotimes" "comment"]))

(defn sha256 [value]
  (let [digest (.digest (MessageDigest/getInstance "SHA-256")
                        (.getBytes (str value) StandardCharsets/UTF_8))]
    (apply str (map #(format "%02x" (bit-and % 0xff)) digest))))

(defn meaningful-children [n]
  (->> (node/children n)
       (remove #(contains? #{:whitespace :newline :comment :comma} (node/tag %)))))

(defn token-text [n]
  (when n
    (try (str (node/sexpr n))
         (catch Exception _ (node/string n)))))

(defn byte-count [s]
  (alength (.getBytes (str s) StandardCharsets/UTF_8)))

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

(defn top-level-forms [root]
  (filter #(= :list (node/tag %)) (meaningful-children root)))

(defn ns-name [forms]
  (some (fn [form]
          (let [[head name] (meaningful-children form)]
            (when (= "ns" (token-text head)) (token-text name))))
        forms))

(defn ns-imports [forms]
  (some (fn [form]
          (let [children (meaningful-children form)]
            (when (= "ns" (token-text (first children)))
              (->> (rest children)
                   (filter #(= :list (node/tag %)))
                   (filter #(contains? #{"require" ":require"}
                                      (token-text (first (meaningful-children %)))))
                   (mapcat #(map token-text (rest (meaningful-children %))))
                   (remove nil?)
                   vec))))
        forms))

(defn signature [children]
  (some #(when (= :vector (node/tag %)) (node/string %)) children))

(defn normalize-form [form]
  (-> (node/string form)
      (str/replace #";[^\n]*" "")
      (str/replace #"\s+" " ")
      str/trim))

(defn symbol-for [source namespace form index cursor]
  (let [children (vec (meaningful-children form))
        head (token-text (first children))
        name (token-text (second children))
        kind (get definition-kinds head)
        snippet (node/string form)
        structural-features (structural/features-for-node form)
        {:keys [range next-cursor]} (source-range source snippet cursor)
        name-range (source-range source name cursor)]
    (when (and kind name)
      {:symbol {:local_id (str "symbol-" index)
                :kind kind
                :name name
                :qualified_name (if namespace (str namespace "/" name) name)
                :range range
                :selection_range (:range name-range)
                :signature (signature (drop 2 children))
                :modifiers (cond-> [] (= head "defn-") (conj "private"))
        :source_hash (sha256 snippet)
        :structural_hash (:shape_hash structural-features)
        :structural_features structural-features
        :structure {:head head, :normalized (normalize-form form)}}
       :next-cursor next-cursor})))

(defn descendants [root]
  (tree-seq node/inner? node/children root))

(defn references-for [symbols forms]
  (->> (map vector symbols forms)
       (mapcat
        (fn [[symbol form]]
          (for [list-node (descendants form)
                :when (= :list (node/tag list-node))
                :let [head (token-text (first (meaningful-children list-node)))]
                :when (and head
                           (not (contains? non-call-heads head))
                           (not (str/starts-with? head ":")))]
            {:kind "call"
             :range {:start_byte 0, :end_byte 0,
                     :start {:line 1, :column 1}, :end {:line 1, :column 1}}
             :source_symbol_local_id (:local_id symbol)
             :target_text head
             :resolution (if (str/includes? head "/") "candidate" "unresolved")
             :confidence (if (str/includes? head "/") 0.7 0.3)})))
       (sort-by (juxt :source_symbol_local_id :target_text))
       vec))

(defn analyze-source [{:keys [language path blob_oid source]}]
  (when-not (contains? #{"clojure" "clojurescript"} language)
    (throw (ex-info "unsupported language" {:code "unsupported_language"})))
  (when (> (byte-count source) max-message-bytes)
    (throw (ex-info "source exceeds analyzer limit" {:code "too_large"})))
  (let [root (parser/parse-string-all source)
        forms (vec (top-level-forms root))
        namespace (ns-name forms)
        definitions (filterv #(contains? definition-kinds
                                        (token-text (first (meaningful-children %)))) forms)
        symbols (loop [remaining definitions, index 0, cursor 0, result []]
                  (if-let [form (first remaining)]
                    (let [{:keys [symbol next-cursor]} (symbol-for source namespace form index cursor)]
                      (recur (next remaining) (inc index) next-cursor
                             (cond-> result symbol (conj symbol))))
                    result))]
    {:file {:language language, :path path, :blob_oid blob_oid,
            :namespace namespace, :imports (or (ns-imports forms) []), :source_bytes (byte-count source)}
     :symbols symbols
     :references (references-for symbols definitions)
     :diagnostics []}))

(defn describe-result []
  {:name "greenways-historian-clojure"
   :version analyzer-version
   :protocol_versions [protocol-version]
   :languages ["clojure" "clojurescript"]
   :extensions [".clj" ".cljs" ".cljc" ".bb"]
   :capabilities ["symbols" "calls" "structural_hashes" "structural_features" "partial_parse"]
   :max_message_bytes max-message-bytes
   :fingerprint (sha256 (str analyzer-version ":rewrite-clj-1.2.55"))})

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
      "describe" (response request :result (describe-result))
      "ping" (response request :result {:ok true})
      "shutdown" (response request :result {:ok true})
      "analyze" (response request :result (analyze-source request))
      (throw (ex-info "unsupported operation" {:code "unsupported_operation"})))
    (catch Exception error
      (let [data (ex-data error)
            code (or (:code data)
                     (when (instance? clojure.lang.ExceptionInfo error) "parse_error")
                     "internal_error")]
        (response request :error
                  {:code code
                   :message (.getMessage error)})))))

(defn run-worker []
  (loop []
    (when-let [line (read-line)]
      (let [request (try (json/parse-string line true)
                         (catch Exception _ {:request_id "unknown" :op "unknown"}))
            result (handle-request request)]
        (println (json/generate-string result))
        (flush)
        (when-not (= "shutdown" (:op request)) (recur))))))

(defn -main [& _]
  (run-worker))
