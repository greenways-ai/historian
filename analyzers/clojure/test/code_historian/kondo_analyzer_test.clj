(ns code-historian.kondo-analyzer-test
  (:require [clojure.test :refer [deftest is run-tests]]
            [code-historian.kondo-analyzer :as analyzer]))

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

(defn -main [& _]
  (let [{:keys [fail error]} (run-tests 'code-historian.kondo-analyzer-test)]
    (when (pos? (+ fail error))
      (System/exit 1))))
