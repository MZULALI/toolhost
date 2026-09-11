import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { ToolRegistry } from "../src/registry.js";
import { ToolStore } from "../src/store.js";
import { echoSchema, withTempDir } from "./helpers.js";

async function setup(dir) {
  const store = new ToolStore(path.join(dir, "t.sqlite"));
  const registry = new ToolRegistry({ store, modulesDir: path.join(dir, "modules") });
  await registry.init();
  return { store, registry };
}

test("create writes the store and a module file; update and delete keep them in sync", () =>
  withTempDir(async (dir) => {
    const { store, registry } = await setup(dir);
    try {
      const tool = await registry.create({
        name: "echo",
        description: "Echo the value back.",
        parameters: JSON.stringify(echoSchema),
        executeSource: "return { echoed: args.value };"
      });
      assert.equal(tool.enabled, true);
      const file = path.join(dir, "modules", "echo.mjs");
      assert.match(await fs.readFile(file, "utf8"), /return \{ echoed: args.value \};/);

      const updated = await registry.update({ name: "echo", executeSource: "return 2;", description: "" });
      assert.equal(updated.description, "Echo the value back.", "empty string keeps the current value");
      assert.match(await fs.readFile(file, "utf8"), /return 2;/);
      assert.equal(registry.read("echo", { includeSource: true }).executeSource, "return 2;");

      await registry.update({ name: "echo", enabled: false });
      assert.deepEqual(registry.definitions(), []);

      await registry.delete("echo");
      await assert.rejects(fs.access(file));
      assert.deepEqual(
        registry.history("echo").map((v) => [v.operation, v.enabled]),
        [["delete", false], ["update", false], ["update", true], ["create", true]]
      );
    } finally {
      store.close();
    }
  }));

test("validation failures name what to fix and never touch the store", () =>
  withTempDir(async (dir) => {
    const { store, registry } = await setup(dir);
    try {
      const good = { description: "Echo the value back.", parameters: echoSchema, executeSource: "return 1;" };
      const cases = [
        [{ ...good, name: "1bad" }, "invalid_name"],
        [{ ...good, name: " echo" }, "invalid_name"],
        [{ ...good, name: "create_tool" }, "invalid_name"],
        [{ ...good, name: "ok", description: "short" }, "invalid_description"],
        [{ ...good, name: "ok", parameters: "{oops" }, "invalid_schema"],
        [{ ...good, name: "ok", executeSource: "return ;;; {" }, "invalid_source"],
        [{ ...good, name: "ok", executeSource: "} globalThis.escaped = 1; function f() {" }, "invalid_source"]
      ];
      for (const [input, code] of cases) {
        await assert.rejects(registry.create(input), (error) => error.code === code, JSON.stringify(input));
      }
      assert.equal(store.list().length, 0);
      await assert.rejects(registry.update({ name: "nope" }), (error) => error.code === "not_found");
      await assert.rejects(registry.delete("nope"), (error) => error.code === "not_found");
    } finally {
      store.close();
    }
  }));

test("init repairs the modules directory from the store", () =>
  withTempDir(async (dir) => {
    const { store, registry } = await setup(dir);
    try {
      await registry.create({ name: "keep", description: "Kept tool for sync test.", parameters: echoSchema, executeSource: "return 1;" });
      const modules = path.join(dir, "modules");
      await fs.rm(path.join(modules, "keep.mjs"));
      await fs.writeFile(path.join(modules, "stray.mjs"), "export const x = 1;");
      await registry.init();
      assert.deepEqual((await fs.readdir(modules)).sort(), ["keep.mjs"]);
    } finally {
      store.close();
    }
  }));
