(ns greenways-historian.kondo-analyzer-test
  (:require [clojure.test :refer [deftest is run-tests]]
            [greenways-historian.kondo-analyzer :as analyzer]))

(def source
  "(ns sample.core\n  (:require [clojure.set :as set]))\n\n(defprotocol Greeter\n  (greet [this]))\n\n(defrecord Person [name]\n  Greeter\n  (greet [this] name))\n\n(defn add [x]\n  (+ x 1))\n\n(defn use-it [x]\n  (set/union #{x} #{1}))\n")

(deftest kondo-analysis-normalizes-to-protocol
  (let [response (analyzer/handle-request
                  {:protocol_version "1.0"
                   :request_id "kondo-test"
                   :op "analyze"
                   :path "sample/core.clj"
                   :language "clojure"
                   :blob_oid "fixture-kondo"
                   :source source})
        result (:result response)
        symbols (:symbols result)
        names (set (map :qualified_name symbols))
        references (:references result)]
    (is (nil? (:error response)))
    (is (= "fixture-kondo" (get-in result [:file :blob_oid])))
    (is (= "sample.core" (get-in result [:file :namespace])))
    (is (contains? names "sample.core/Greeter"))
    (is (contains? names "sample.core/Person"))
    (is (contains? names "sample.core/add"))
    (is (some #(= "variable" (:kind %)) symbols))
    (is (some #(= "clojure.set/union" (:target_qualified_name %)) references))))

(deftest kondo-analysis-covers-clj-bb-definition-and-error-facts
  (let [source "(ns sample.bb (:require [clojure.set :as set] [clojure.test :refer [deftest is]]))\n\n(defn- private-fn [value] (set/union #{value} #{}))\n(defmulti render type)\n(defmethod render String [value] (private-fn value))\n(deftest renders (is (= #{} (render \"value\"))))\n"
        response (analyzer/handle-request
                  {:protocol_version "1.0"
                   :request_id "rich-kondo"
                   :op "analyze"
                   :path "sample.bb"
                   :language "babashka"
                   :blob_oid "fixture-rich"
                   :source source})
        result (:result response)
        symbols (:symbols result)
        names (set (map :name symbols))
        kinds (set (map :kind symbols))]
    (is (nil? (:error response)))
    (is (= "sample.bb" (get-in result [:file :namespace])))
    (is (contains? names "private-fn"))
    (is (contains? names "render"))
    (is (contains? names "renders"))
    (is (contains? kinds "multimethod"))
    (is (contains? kinds "method"))
    (is (contains? kinds "test"))
    (is (some #(some #{"private"} (:modifiers %)) symbols))
    (is (every? #(< (get-in % [:selection_range :start_byte])
                    (get-in % [:selection_range :end_byte])) symbols))
    (is (some #(= "clojure.set/union" (:target_qualified_name %)) (:references result))))
  (let [response (analyzer/handle-request
                  {:protocol_version "1.0"
                   :request_id "malformed-kondo"
                   :op "analyze"
                   :path "broken.clj"
                   :language "clojure"
                   :blob_oid "fixture-broken"
                   :source "(ns broken.core)\n(defn incomplete ["})]
    (is (nil? (:error response)))
    (is (= "broken.clj" (get-in response [:result :file :path])))
    (is (seq (get-in response [:result :diagnostics])))))

(deftest kondo-analysis-normalizes-methods-and-reference-owners
  (let [source "(ns sample.core)\n(defprotocol Greeter (greet [this]))\n(defrecord Person [name] Greeter (greet [this] name))\n(deftype Box [value] Object (toString [this] value))\n(defn use-it [person] (greet person))\n"
        result (:result (analyzer/handle-request
                         {:protocol_version "1.0"
                          :request_id "ownership-kondo"
                          :op "analyze"
                          :path "sample/core.clj"
                          :language "clojure"
                          :blob_oid "fixture-ownership"
                          :source source}))
        symbols (:symbols result)
        names (set (map :name symbols))
        qualified-names (set (map :qualified_name symbols))
        kinds (set (map :kind symbols))
        ids (set (map :local_id symbols))
        use-it (some #(when (= "use-it" (:name %)) %) symbols)
        owned-references (filter :source_symbol_local_id (:references result))]
    (is (contains? names "Greeter"))
    (is (contains? names "greet"))
    (is (contains? names "Person"))
    (is (contains? names "Box"))
    (is (contains? qualified-names "sample.core/Person/name"))
    (is (contains? qualified-names "sample.core/Box/value"))
    (is (contains? kinds "method"))
    (is (contains? kinds "record"))
    (is (contains? kinds "type"))
    (is (contains? kinds "field"))
    (is (some #(= (:local_id use-it) (:source_symbol_local_id %)) (:references result)))
    (is (some #(and (= "person" (:target_text %))
                    (= (:local_id use-it) (:source_symbol_local_id %)))
              (:references result)))
    (is (every? #(contains? ids (:source_symbol_local_id %)) owned-references))))

(defn -main [& _]
  (let [{:keys [fail error]} (run-tests 'greenways-historian.kondo-analyzer-test)]
    (when (pos? (+ fail error))
      (System/exit 1))))

(deftest golden-declarations-and-bindings
  (let [source "(ns sample.golden\n  (:require [clojure.test :refer [deftest is]]))\n\n(def ^:private ^{:doc \"cached value\" :added \"1.0\"} secret 1)\n(defonce cache (atom {}))\n(defmacro with-value [value] value)\n\n(defn destructure\n  [{:keys [value] :as data} & args]\n  (let [local (get data :value)]\n    (with-value (+ value local))))\n\n(deftest destructure-test\n  (let [data {:value 1}]\n    (is (= 2 (destructure data)))))\n"
        result (:result (analyzer/handle-request
                         {:protocol_version "1.0"
                          :request_id "golden-bindings"
                          :op "analyze"
                          :path "golden.clj"
                          :language "clojure"
                          :blob_oid "fixture-golden-bindings"
                          :source source}))
        symbols (:symbols result)
        references (:references result)
        by-name (fn [name]
                  (some #(when (= name (:name %)) %) symbols))
        names (set (map :name symbols))
        destructure-symbol (by-name "destructure")
        owner-ids (set (keep :id symbols))]
    (is (contains? names "secret"))
    (is (contains? names "cache"))
    (is (contains? names "with-value"))
    (is (contains? names "destructure"))
    (is (= "variable" (:kind (by-name "secret"))))
    (is (= "variable" (:kind (by-name "cache"))))
    (is (= "macro" (:kind (by-name "with-value"))))
    (is (= "function" (:kind destructure-symbol)))
    (is (contains? (set (:modifiers (by-name "secret"))) "private"))
    (is (= "cached value" (get-in (by-name "secret") [:metadata :doc])))
    (is (= "1.0" (get-in (by-name "secret") [:metadata :added])))
    (is (every? names #{"value" "data" "args" "local"}))
    (is (some #(= "destructure" (:name %)) symbols))
    (is (seq references))
    (is (every? #(or (nil? (:source-symbol-id %))
                     (contains? owner-ids (:source-symbol-id %)))
                references))
    (is (some #(= (:source-symbol-id %) (:id destructure-symbol)) references))))
