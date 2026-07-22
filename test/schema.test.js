import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";

const schema = (path) => Bun.file(path).json();

describe("protocol schemas", () => {
  test("accept valid fixtures and reject invalid fixtures", async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const [requestSchema, responseSchema, resultSchema] = await Promise.all([
      schema("spec/schema/request.schema.json"),
      schema("spec/schema/response.schema.json"),
      schema("spec/schema/result.schema.json")
    ]);
    ajv.addSchema(resultSchema);
    const validateRequest = ajv.compile(requestSchema);
    const validateResponse = ajv.compile(responseSchema);
    expect(validateRequest(await schema("spec/schema/examples/valid-describe-request.json"))).toBe(true);
    expect(validateResponse(await schema("spec/schema/examples/valid-analyze-response.json"))).toBe(true);
    expect(validateRequest(await schema("spec/schema/examples/invalid-analyze-request.json"))).toBe(false);
    expect(validateResponse(await schema("spec/schema/examples/invalid-response-both-result-and-error.json"))).toBe(false);
  });
});
