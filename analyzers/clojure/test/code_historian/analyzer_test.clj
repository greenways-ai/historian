(require '[clojure.test :refer [deftest is run-tests]])
(require '[code-historian.analyzer :as analyzer])

(deftest describes-protocol
  (let [response (analyzer/handle-request
                  {:protocol_version "1.0", :request_id "d1", :op "describe"})]
    (is (= "d1" (:request_id response)))
    (is (= "code-historian-clojure" (get-in response [:result :name])))))

(deftest extracts-clojure-symbols-and-calls
  (let [source "(ns example.core)\n\n(defn answer [x]\n  (inc x))\n"
        response (analyzer/handle-request
                  {:protocol_version "1.0", :request_id "a1", :op "analyze",
                   :language "clojure", :path "src/example/core.clj",
                   :blob_oid "abc", :source source, :config {}})
        result (:result response)]
    (is (= "example.core" (get-in result [:file :namespace])))
    (is (= ["example.core/answer"] (mapv :qualified_name (:symbols result))))
    (is (= ["inc"] (mapv :target_text (:references result))))))

(deftest rejects-unknown-operations
  (is (= "unsupported_operation"
         (get-in (analyzer/handle-request
                  {:protocol_version "1.0", :request_id "x", :op "explode"})
                 [:error :code]))))

(let [{:keys [fail error]} (run-tests)]
  (when (pos? (+ fail error)) (System/exit 1)))

