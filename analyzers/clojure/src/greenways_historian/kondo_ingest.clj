(ns greenways-historian.kondo-ingest
  (:require [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [greenways-historian.kondo-analyzer :as analyzer]))

(def supported-extensions #{".clj" ".bb"})

(defn extension [path]
  (some #(when (str/ends-with? path %) %) supported-extensions))

(defn source-file? [file]
  (let [path (.getName file)]
    (and (.isFile file)
         (extension path)
         (not (str/starts-with? path ".#")))))

(defn language-for [path]
  (if (str/ends-with? path ".bb") "babashka" "clojure"))

(defn relative-path [root file]
  (-> (.relativize (.toPath root) (.toPath file))
      str
      (str/replace java.io.File/separator "/")))

(defn analyze-file [root file]
  (let [path (relative-path root file)
        source (slurp file :encoding "UTF-8")]
    (analyzer/handle-request
     {:protocol_version analyzer/protocol-version
      :request_id path
      :op "analyze"
      :path path
      :language (language-for path)
      :blob_oid (analyzer/sha256 source)
      :source source})))

(defn parse-options [args]
  (loop [remaining args
         options {:root "../foundation-base/src"}]
    (if-let [arg (first remaining)]
      (cond
        (= arg "--output") (recur (nnext remaining) (assoc options :output (second remaining)))
        (= arg "--root") (recur (nnext remaining) (assoc options :root (second remaining)))
        :else (recur (next remaining) (assoc options :root arg)))
      options)))

(defn -main [& args]
  (let [{:keys [root output]} (parse-options args)
        root-file (io/file root)]
    (when-not (.isDirectory root-file)
      (throw (ex-info (str "source root does not exist: " root) {:root root})))
    (with-open [writer (when output (io/writer output))]
      (let [counts (atom {:files 0 :symbols 0 :references 0 :diagnostics 0 :errors 0})]
        (doseq [file (sort-by #(.getPath %) (filter source-file? (file-seq root-file)))]
          (let [record (try
                         (analyze-file root-file file)
                         (catch Exception error
                           {:protocol_version analyzer/protocol-version
                            :request_id (relative-path root-file file)
                            :op "analyze"
                            :error {:code "ingest_error"
                                    :message (.getMessage error)}}))
                result (:result record)
                error (:error record)]
            (swap! counts update :files inc)
            (swap! counts update :symbols + (count (:symbols result)))
            (swap! counts update :references + (count (:references result)))
            (swap! counts update :diagnostics + (count (:diagnostics result)))
            (when error (swap! counts update :errors inc))
            (when writer
              (.write writer (json/generate-string record))
              (.write writer "\n"))))
        (println (json/generate-string (assoc @counts :root (.getPath root-file) :output output)))))))
