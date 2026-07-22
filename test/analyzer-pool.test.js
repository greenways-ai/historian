import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AnalyzerPool } from "../src/analyzer-pool.js";

describe("analyzer worker pool", () => {
  test("retries a crashed worker once", async () => {
    const directory = await mkdtemp("/tmp/historian-analyzer-retry-");
    const marker = join(directory, "crashed");
    const pool = new AnalyzerPool({ commands: { javascript: ["bun", resolve("test/fixtures/retry-analyzer.js"), marker] } });
    try {
      const response = await pool.analyze({ language: "javascript", path: "value.js", blob_oid: "blob-1", source: "export const value = 1;" });
      expect(response.result.file.path).toBe("value.js");
    } finally {
      await pool.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
