(ns greenways-historian.structural
  (:require [clojure.string :as str]
            [rewrite-clj.node :as node]
            [rewrite-clj.parser :as parser])
  (:import [java.nio.charset StandardCharsets]
           [java.security MessageDigest]))

(def ignored-tags #{:whitespace :newline :comment :comma})
(def special-forms #{"if" "if-not" "when" "when-not" "cond" "case" "condp" "do"
                     "let" "letfn" "loop" "recur" "fn" "fn*" "quote" "var"
                     "set!" "try" "catch" "finally" "throw" "new" "." ".."
                     "def" "defn" "defn-" "defonce" "defmacro" "defmulti"
                     "defmethod" "defprotocol" "defrecord" "deftype"})

(defn sha256 [value]
  (let [digest (.digest (MessageDigest/getInstance "SHA-256")
                        (.getBytes (str value) StandardCharsets/UTF_8))]
    (apply str (map #(format "%02x" (bit-and % 0xff)) digest))))

(defn meaningful-children [n]
  (if (node/inner? n)
    (remove #(contains? ignored-tags (node/tag %)) (node/children n))
    []))

(defn token-text [n]
  (when n
    (try (str (node/sexpr n))
         (catch Exception _ (node/string n)))))

(defn literal-shape [tag text]
  (cond
    (= tag :keyword) [:keyword text]
    (= tag :string) [:string]
    (= tag :number) [:number]
    (re-matches #"[-+]?\d+(\.\d+)?[MN]?" (or text "")) [:number]
    (re-matches #"[Tt]rue|[Ff]alse|nil" (or text "")) [:literal]
    :else [:symbol]))

(declare shape-node)

(defn shape-list [children]
  (let [head (token-text (first children))
        head-shape (if (contains? special-forms head) [:special head] [:call])]
    (into [head-shape]
          (map shape-node (rest children)))))

(defn shape-node [n]
  (let [tag (node/tag n)
        children (vec (meaningful-children n))]
    (case tag
      :list (shape-list children)
      :vector (into [:vector] (map shape-node children))
      :map (into [:map] (map shape-node children))
      :set (into [:set] (map shape-node children))
      :namespaced-map (into [:namespaced-map] (map shape-node children))
      :deref [:deref (some-> (first children) shape-node)]
      :quote [:quote (some-> (first children) shape-node)]
      :syntax-quote [:syntax-quote (some-> (first children) shape-node)]
      :unquote [:unquote (some-> (first children) shape-node)]
      :unquote-splicing [:unquote-splicing (some-> (first children) shape-node)]
      (literal-shape tag (token-text n)))))

(defn subtrees [shape]
  (tree-seq vector? rest shape))

(defn metrics [shape]
  (let [nodes (vec (subtrees shape))
        depth (fn depth [value]
                (if (vector? value)
                  (inc (apply max 0 (map depth (rest value))))
                  1))
        arities (keep #(when (and (vector? %) (= :call (first %))) (dec (count %))) nodes)]
    {:node_count (count nodes)
     :depth (depth shape)
     :arity (or (apply max 0 arities) 0)
     :features (->> nodes (map pr-str) distinct sort vec)}))

(defn features-for-node [n]
  (let [shape (shape-node n)
        encoded (pr-str shape)]
    (merge {:shape encoded
            :shape_hash (sha256 encoded)}
           (metrics shape))))

(defn features-for-text [source]
  (try
    (let [root (parser/parse-string-all source)
          first-node (first (remove #(contains? ignored-tags (node/tag %))
                                    (node/children root)))]
      (when first-node (features-for-node first-node)))
    (catch Exception _ nil)))
