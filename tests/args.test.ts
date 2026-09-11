import test from "node:test";
import assert from "node:assert/strict";
import { validateArgs } from "../src/validate/args.ts";
import { normalizeToolSchema } from "../src/validate/schema.ts";

const schema = normalizeToolSchema({
  type: "object",
  properties: {
    text: { type: "string", minLength: 1 },
    count: { type: "integer", minimum: 0, maximum: 10 },
    mode: { type: "string", enum: ["fast", "slow"] },
    tags: { type: "array", items: { type: "string" }, maxItems: 2 },
    nested: { type: "object", properties: { flag: { type: "boolean" } }, required: ["flag"] },
    either: { anyOf: [{ type: "string" }, { type: "number" }] }
  },
  required: ["text"]
});

test("valid arguments produce no problems", () => {
  assert.deepEqual(validateArgs(schema, { text: "hi", count: 3, mode: "fast", tags: ["a"], nested: { flag: true }, either: 2 }), []);
  assert.deepEqual(validateArgs(schema, { text: "hi" }), []);
});

test("each kind of mismatch is named with a path and what was received", () => {
  const problems = validateArgs(schema, {
    text: 123,
    count: 11,
    mode: "medium",
    tags: ["a", "b", 3],
    nested: {},
    either: true,
    extra: 1
  });
  assert.deepEqual(problems, [
    "args.extra is not a known property",
    "args.text must be string, got number 123",
    "args.count must be <= 10",
    'args.mode must be one of "fast", "slow", got a string ("medium")',
    "args.tags must have at most 2 items, got 3",
    "args.tags[2] must be string, got number 3",
    "args.nested.flag is required",
    "args.either does not match any of the allowed shapes"
  ]);
});

test("missing required, wrong integer, empty string, and non-object args", () => {
  assert.deepEqual(validateArgs(schema, {}), ["args.text is required"]);
  assert.deepEqual(validateArgs(schema, { text: "", count: 1.5 }), ["args.text must be at least 1 characters", "args.count must be integer, got number 1.5"]);
  assert.deepEqual(validateArgs(schema, "nope"), ["args must be object, got a string (\"nope\")"]);
});

test("keywords the validator does not know are ignored rather than rejected", () => {
  assert.deepEqual(validateArgs({ type: "object", properties: { a: { type: "string", format: "email", $comment: "x" } } }, { a: "not an email" }), []);
});
