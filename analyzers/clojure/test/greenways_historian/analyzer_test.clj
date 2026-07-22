(require '[clojure.test :refer [deftest is run-tests]])
(require '[greenways-historian.analyzer :as analyzer])

(deftest describes-protocol
  (let [response (analyzer/handle-request
                  {:protocol_version "1.0", :request_id "d1", :op "describe"})]
    (is (= "d1" (:request_id response)))
    (is (= "greenways-historian-clojure" (get-in response [:result :name])))))

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

(deftest extracts-imports-and-name-selection-range
  (let [source "(ns example.core (:require [foo.bar :as bar]))\n(defn answer [x] (bar/inc x))\n"
        result (:result (analyzer/handle-request
                         {:protocol_version "1.0", :request_id "ranges", :op "analyze",
                          :language "clojure", :path "core.clj", :blob_oid "ranges",
                          :source source, :config {}}))
        symbol (first (:symbols result))
        selection (:selection_range symbol)
        definition (:range symbol)]
    (is (some #(= "[foo.bar :as bar]" %) (get-in result [:file :imports])))
    (is (< (:start_byte selection) (:end_byte selection)))
    (is (< (- (:end_byte selection) (:start_byte selection))
           (- (:end_byte definition) (:start_byte definition))))))

(let [{:keys [fail error]} (run-tests)]
  (when (pos? (+ fail error)) (System/exit 1)))
