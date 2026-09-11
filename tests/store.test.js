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
  moduleSource: "export const definition = {};\nexport async function execute(args, ctx) {\nreturn args;\n}\n",
  enabled: true,
  ...overrides
});

test("save, get, list, remove, and history", () =>
  withTempDir((dir) => {
    const store = new ToolStore(path.join(dir, "t.sqlite"));
    try {
      const saved = store.save(record(), "create");
      assert.equal(saved.name, "echo");
      assert.equal(typeof saved.versionId, "number");
      assert.equal("executeSource" in saved, false, "source is not returned unless asked for");
      assert.equal(store.get("echo", { includeSource: true }).executeSource, "return args;");

      store.save(record({ executeSource: "return 2;", enabled: false }), "update");
      assert.equal(store.list().length, 1);
      assert.equal(store.list({ enabledOnly: true }).length, 0);
      assert.equal(store.get("echo").createdAt, saved.createdAt, "createdAt survives updates");

      const removed = store.remove("echo");
      assert.equal(removed.executeSource, "return 2;");
      assert.equal(store.get("echo"), null);
      assert.equal(store.remove("echo"), null);

      const history = store.history("echo");
      assert.deepEqual(
        history.map((v) => [v.operation, v.executeSource, v.enabled]),
        [
          ["delete", "return 2;", false],
          ["update", "return 2;", false],
          ["create", "return args;", true]
        ]
      );
      assert.equal(store.getVersion("echo", history[2].id).executeSource, "return args;");
      assert.equal(store.getVersion("echo", 999), null);
      assert.equal(store.getVersion("other", history[2].id), null, "versions are scoped by name");
    } finally {
      store.close();
    }
  }));

test("names are unique ignoring case", () =>
  withTempDir((dir) => {
    const store = new ToolStore(path.join(dir, "t.sqlite"));
    try {
      store.save(record({ name: "Echo" }), "create");
      assert.equal(store.findCollision("echo"), "Echo");
      assert.equal(store.findCollision("ECHO"), "Echo");
      assert.equal(store.findCollision("other"), null);
      assert.equal(store.get("echo"), null, "get is exact");
      assert.throws(() => store.save(record({ name: "echo" }), "create"), (error) => error.code === "exists");
      assert.equal(store.get("Echo").updatedAt, store.get("Echo").createdAt, "the colliding save touched nothing");
    } finally {
      store.close();
    }
  }));
