import test from "node:test";
import assert from "node:assert/strict";
import { normalizeToolSchema } from "../src/schema.js";

test("object schemas get strict defaults and required is filtered to real properties", () => {
  const schema = normalizeToolSchema({
    type: "object",
    properties: { a: { type: "string" }, nested: { type: "object", properties: { b: { type: "number" } } } },
    required: ["a", "missing"]
  });
  assert.deepEqual(schema.required, ["a"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.nested.required, []);
  assert.equal(schema.properties.nested.additionalProperties, false);
});

test("accepts a JSON string and rejects non-object schemas", () => {
  assert.equal(normalizeToolSchema('{"type":"object"}').type, "object");
  assert.throws(() => normalizeToolSchema("{not json"), (error) => error.code === "invalid_schema");
  assert.throws(() => normalizeToolSchema({ type: "string" }), (error) => error.code === "invalid_schema");
  assert.throws(() => normalizeToolSchema([]), (error) => error.code === "invalid_schema");
});

test("does not mutate its input", () => {
  const input = { type: "object", properties: { a: { type: "string" } } };
  normalizeToolSchema(input);
  assert.equal("required" in input, false);
});
