import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ToolStore } from "../src/store.js";
import { withTempDir } from "./helpers.js";

const record = (overrides = {}) => ({
  name: "echo",
  description: "Echo the value back.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  executeSource: "return args;",
  moduleSource: "export const definition = {};\nexport async function execute(args, ctx) {\n  return args;\n}\n",
  enabled: true,
  ...overrides
});

test("save, get, list, remove, and history", () =>
  withTempDir((dir) => {
    const store = new ToolStore(path.join(dir, "t.sqlite"));
    try {
      const saved = store.save(record(), "create");
      assert.equal(saved.name, "echo");
      assert.equal("executeSource" in saved, false, "source is not returned unless asked for");
      assert.equal(store.get("echo", { includeSource: true }).executeSource, "return args;");

      store.save(record({ executeSource: "return 2;", enabled: false }), "update");
      assert.equal(store.list().length, 1);
      assert.equal(store.list({ enabledOnly: true }).length, 0);
      assert.equal(store.get("echo").createdAt, saved.createdAt, "createdAt survives updates");

      const removed = store.remove("echo");
      assert.equal(removed.executeSource, "return 2;");
      assert.equal(store.has("echo"), false);
      assert.equal(store.remove("echo"), null);

      assert.deepEqual(
        store.history("echo").map((v) => v.operation),
        ["delete", "update", "create"]
      );
    } finally {
      store.close();
    }
  }));

test("clear removes every tool and records each deletion", () =>
  withTempDir((dir) => {
    const store = new ToolStore(path.join(dir, "t.sqlite"));
    try {
      store.save(record({ name: "a" }), "create");
      store.save(record({ name: "b" }), "create");
      assert.deepEqual(store.clear(), ["a", "b"]);
      assert.equal(store.list().length, 0);
      assert.equal(store.history("b")[0].operation, "delete");
    } finally {
      store.close();
    }
  }));
