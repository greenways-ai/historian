import { describe, expect, test } from "bun:test";

describe("CLI", () => {
  test("prints its version", async () => {
    const process = Bun.spawn(["bun", "src/cli.js", "--version"], { stdout: "pipe" });
    expect((await new Response(process.stdout).text()).trim()).toBe("0.1.0");
    expect(await process.exited).toBe(0);
  });
});

