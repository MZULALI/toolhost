import test from "node:test";
import assert from "node:assert/strict";
import { assertModuleSource, buildModuleSource, unwrapExecuteSource } from "../src/source.js";

test("a plain body is returned as-is", () => {
  assert.equal(unwrapExecuteSource("return args.value;"), "return args.value;");
});

test("a full function declaration is unwrapped", () => {
  const body = unwrapExecuteSource("async function execute(args, ctx) {\n  return { v: args.value };\n}");
  assert.equal(body, "return { v: args.value };");
});

test("exported, default-exported, and arrow forms are unwrapped", () => {
  for (const source of [
    "export async function execute(args) { return 1; }",
    "export default async function (args) { return 1; }",
    "const execute = async (args, ctx) => { return 1; };",
    "async function execute(args) { return 1; };"
  ]) {
    assert.equal(unwrapExecuteSource(source), "return 1;", source);
  }
});

test("braces inside strings, templates, comments and regex literals do not confuse unwrapping", () => {
  const source = [
    "async function execute(args, ctx) {",
    "  // a comment with } in it",
    "  const re = /\\}+/g; /* block } comment */",
    "  const s = `tell app \"${args.value}\" to } launch`;",
    "  return { s, hit: re.test(\"}}}\"), brace: '}' };",
    "}"
  ].join("\n");
  const body = unwrapExecuteSource(source);
  assert.match(body, /^\/\/ a comment/);
  assert.match(body, /return \{ s, hit/);
  assert.doesNotMatch(body, /async function execute/);
});

test("a body that closes the function early is rejected", () => {
  assert.throws(
    () => unwrapExecuteSource("return 1; }\nconsole.log('escaped');\nasync function other() {"),
    (error) => error.code === "invalid_source" && /closes the function early/.test(error.message)
  );
});

test("a syntax error reports the line inside the body", () => {
  assert.throws(
    () => unwrapExecuteSource("const a = 1;\nconst b = ;\nreturn a;"),
    (error) => error.code === "invalid_source" && error.details.line === 2 && /Syntax error/.test(error.message)
  );
});

test("empty source is rejected", () => {
  assert.throws(() => unwrapExecuteSource("   "), (error) => error.code === "invalid_source");
  assert.throws(() => unwrapExecuteSource(undefined), (error) => error.code === "invalid_source");
});

test("the assembled module has exactly the expected exports", () => {
  const moduleSource = buildModuleSource({
    name: "echo",
    description: "Echo the value back.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    executeSource: "return args;"
  });
  assert.doesNotThrow(() => assertModuleSource(moduleSource));
  assert.match(moduleSource, /export const definition = \{/);
  assert.match(moduleSource, /export async function execute\(args, ctx\) \{\n {2}return args;\n\}/);
  assert.throws(() => assertModuleSource(moduleSource + "\nconsole.log(1);"), (error) => error.code === "invalid_source");
});
