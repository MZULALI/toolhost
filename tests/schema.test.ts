import test from "node:test";
import assert from "node:assert/strict";
import { normalizeToolSchema as normalize } from "../src/validate/schema.ts";

const normalizeToolSchema = (input: unknown): any => normalize(input);

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

test("array forms of items and prefixItems are normalised too", () => {
  const schema = normalizeToolSchema({
    type: "object",
    properties: {
      pairs: { type: "array", prefixItems: [{ type: "object" }, { type: "string" }], items: { type: "object" } },
      tuple: { type: "array", items: [{ type: "object" }] }
    }
  });
  assert.equal(schema.properties.pairs.prefixItems[0].additionalProperties, false);
  assert.equal(schema.properties.pairs.items.additionalProperties, false);
  assert.equal(schema.properties.tuple.items[0].additionalProperties, false);
});

test("accepts a JSON string and rejects non-object schemas", () => {
  assert.equal(normalizeToolSchema('{"type":"object"}').type, "object");
  assert.throws(() => normalizeToolSchema("{not json"), (error: any) => error.code === "invalid_schema");
  assert.throws(() => normalizeToolSchema({ type: "string" }), (error: any) => error.code === "invalid_schema");
  assert.throws(() => normalizeToolSchema([]), (error: any) => error.code === "invalid_schema");
});

test("cycles, absurd depth, and non-JSON values are invalid_schema, never a raw error", () => {
  const cyclic: any = { type: "object", properties: {} };
  cyclic.properties.self = cyclic;
  assert.throws(() => normalizeToolSchema(cyclic), (error: any) => error.code === "invalid_schema" && /cycle/.test(error.message));

  let deep: any = { type: "object" };
  for (let i = 0; i < 2000; i += 1) deep = { type: "object", properties: { d: deep } };
  assert.throws(() => normalizeToolSchema(deep), (error: any) => error.code === "invalid_schema" && /levels deep/.test(error.message));

  assert.throws(() => normalizeToolSchema({ type: "object", properties: { f: { fn: () => 1 } } }), (error: any) => error.code === "invalid_schema");
});

test("a subschema shared in two places is not a cycle", () => {
  const addr = { type: "object", properties: { street: { type: "string" } } };
  const schema = normalizeToolSchema({ type: "object", properties: { home: addr, work: addr } });
  assert.equal(schema.properties.home.additionalProperties, false);
  assert.equal(schema.properties.work.additionalProperties, false);
});

test("does not mutate its input", () => {
  const input = { type: "object", properties: { a: { type: "string" } } };
  normalizeToolSchema(input);
  assert.equal("required" in input, false);
});

test("a densely shared schema graph normalises in linear time", () => {
  let node: any = { type: "object", properties: { leaf: { type: "string" } } };
  for (let i = 0; i < 40; i += 1) node = { type: "object", properties: { a: node, b: node } };
  const started = Date.now();
  const schema = normalizeToolSchema(node);
  assert.ok(Date.now() - started < 500, "exponential walks would take hours here");
  assert.equal(schema.properties.a.properties.b.additionalProperties, false);
});
