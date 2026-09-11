import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createToolHost, toAnthropic, toOpenAIChat, toOpenAIResponses } from "../src/index.js";
import { echoSchema, withTempDir } from "./helpers.js";

const create = (host, name, executeSource, parameters = echoSchema) =>
  host.call("create_tool", {
    name,
    description: `Test tool ${name} for the host suite.`,
    parameters_json: JSON.stringify(parameters),
    execute_source: executeSource
  });

test("a tool created through the model-facing API is callable on the next call", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir });
    try {
      assert.deepEqual(host.tools().map((t) => t.name), ["create_tool", "list_tools", "read_tool", "update_tool", "delete_tool"]);

      const created = await create(host, "shout", "return { shouted: args.value.toUpperCase() };");
      assert.equal(created.tool.name, "shout");
      assert.deepEqual(await host.call("shout", { value: "hi" }), { shouted: "HI" });
      assert.equal(host.tools().at(-1).name, "shout");

      await host.call("update_tool", { name: "shout", execute_source: "return { shouted: args.value + '!' };" });
      assert.deepEqual(await host.call("shout", { value: "hi" }), { shouted: "hi!" });

      const listed = await host.call("list_tools", { include_disabled: false });
      assert.equal(listed.tools.length, 1);
      const read = await host.call("read_tool", { name: "shout", include_source: true });
      assert.match(read.tool.execute_source, /shouted/);
      assert.equal("moduleSource" in read.tool, false);

      await host.call("delete_tool", { name: "shout" });
      await assert.rejects(host.call("shout", { value: "x" }), (error) => error.code === "not_found");
    } finally {
      await host.stop();
    }
  }));

test("tools persist across host restarts", () =>
  withTempDir(async (dir) => {
    const options = { dir: path.join(dir, "host"), workspace: dir };
    let host = await createToolHost(options);
    await create(host, "persisted", "return 42;");
    await host.stop();

    host = await createToolHost(options);
    try {
      assert.equal(await host.call("persisted", { value: "" }), 42);
    } finally {
      await host.stop();
    }
  }));

test("a tool that throws reports its message and code without killing the worker", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir });
    try {
      await create(host, "boom", "throw new Error('kaboom ' + args.value);");
      await create(host, "fine", "return 'ok';");
      await assert.rejects(host.call("boom", { value: "1" }), (error) => error.code === "call_failed" && /kaboom 1/.test(error.message));
      assert.equal(await host.call("fine", { value: "" }), "ok");
      assert.equal(host.status().worker.ready, true);
    } finally {
      await host.stop();
    }
  }));

test("a hung tool times out and a crashed worker fails every in-flight call", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, callTimeoutMs: 200 });
    try {
      await create(host, "hang", "await new Promise(() => {});");
      await assert.rejects(host.call("hang", { value: "" }), (error) => error.code === "timeout");

      await create(host, "die", "setTimeout(() => process.exit(3), 10); await new Promise(() => {});");
      const exited = new Promise((resolve) => host.worker.once("exit", resolve));
      await assert.rejects(host.call("die", { value: "" }), (error) => error.code === "worker_unavailable");
      assert.equal((await exited).code, 3);
      await assert.rejects(host.call("hang", { value: "" }), (error) => error.code === "worker_unavailable");

      await host.worker.restart("recover");
      assert.equal(host.status().worker.ready, true);
    } finally {
      await host.stop();
    }
  }));

test("ctx confines files to the workspace, blocks recursion, and disables exec by default", () =>
  withTempDir(async (dir) => {
    const workspace = path.join(dir, "ws");
    await fs.mkdir(workspace);
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace });
    try {
      await create(host, "writer", "return ctx.writeText(args.value, 'hello');");
      assert.deepEqual(await host.call("writer", { value: "notes/a.txt" }), { path: path.join("notes", "a.txt") });
      assert.equal(await fs.readFile(path.join(workspace, "notes", "a.txt"), "utf8"), "hello");
      await assert.rejects(host.call("writer", { value: "../escape.txt" }), (error) => error.code === "path_outside_workspace");
      await assert.rejects(host.call("writer", { value: "/etc/passwd" }), (error) => error.code === "path_outside_workspace");

      await create(host, "ping", "return ctx.callTool('pong', args);");
      await create(host, "pong", "return ctx.callTool('ping', args);");
      await assert.rejects(host.call("ping", { value: "" }), (error) => error.code === "recursive_call" && /ping -> pong -> ping/.test(error.message));

      await create(host, "sh", "return ctx.exec('echo hi');");
      await assert.rejects(host.call("sh", { value: "" }), (error) => error.code === "capability_disabled");
    } finally {
      await host.stop();
    }
  }));

test("exec runs with a minimal environment when enabled", () =>
  withTempDir(async (dir) => {
    process.env.TOOLHOST_TEST_SECRET = "leak";
    const host = await createToolHost({
      dir: path.join(dir, "host"),
      workspace: dir,
      capabilities: { exec: true, execEnv: { GREETING: "hello" } }
    });
    try {
      await create(host, "sh", "return ctx.exec('printf \"%s|%s\" \"$GREETING\" \"$TOOLHOST_TEST_SECRET\"');");
      const result = await host.call("sh", { value: "" });
      assert.equal(result.ok, true);
      assert.equal(result.stdout, "hello|", "host-configured env is present; the parent's env is not");
    } finally {
      delete process.env.TOOLHOST_TEST_SECRET;
      await host.stop();
    }
  }));

test("provider adapters produce each API's shape", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir });
    try {
      const [first] = host.tools();
      assert.deepEqual(Object.keys(toAnthropic([first])[0]), ["name", "description", "input_schema"]);
      assert.deepEqual(Object.keys(toOpenAIResponses([first])[0]), ["type", "name", "description", "parameters"]);
      assert.deepEqual(Object.keys(toOpenAIChat([first])[0].function), ["name", "description", "parameters"]);
    } finally {
      await host.stop();
    }
  }));
