import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { createToolHost, ToolHost, toAnthropic, toOpenAIChat, toOpenAIResponses } from "../src/index.js";
import { echoSchema, withTempDir } from "./helpers.js";

const quiet = { onLog: () => {} };

const create = (host, name, executeSource, parameters = echoSchema) =>
  host.call("create_tool", {
    name,
    description: `Test tool ${name} for the host suite.`,
    parameters_json: JSON.stringify(parameters),
    execute_source: executeSource
  });

test("a tool created through the model-facing API is callable on the next call", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet });
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

test("history is readable and any version, including a deleted one, can be restored", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet });
    try {
      await create(host, "v", "return 1;");
      await host.call("update_tool", { name: "v", execute_source: "return 2;" });
      await host.call("update_tool", { name: "v", execute_source: "return 3;" });
      assert.equal(await host.call("v", { value: "" }), 3);

      const read = await host.call("read_tool", { name: "v", include_source: false, include_history: true });
      assert.deepEqual(read.history.map((v) => [v.operation, v.execute_source]), [["update", "return 3;"], ["update", "return 2;"], ["create", "return 1;"]]);
      assert.deepEqual(host.history("v").map((v) => v.executeSource), ["return 3;", "return 2;", "return 1;"]);

      const first = read.history.at(-1).version;
      await host.call("update_tool", { name: "v", restore_version: first });
      assert.equal(await host.call("v", { value: "" }), 1);

      await host.call("delete_tool", { name: "v" });
      await assert.rejects(host.call("read_tool", { name: "v", include_source: false }), (error) => error.code === "not_found");
      await assert.rejects(host.call("update_tool", { name: "v", execute_source: "return 9;" }), (error) => error.code === "not_found");
      const deletion = host.history("v")[0];
      assert.equal(deletion.operation, "delete");
      await host.call("update_tool", { name: "v", restore_version: deletion.id });
      assert.equal(await host.call("v", { value: "" }), 1, "a deleted tool comes back through update_tool.restore_version");

      await assert.rejects(host.call("update_tool", { name: "v", restore_version: 99999 }), (error) => error.code === "not_found");
      assert.equal(await host.call("v", { value: "" }), 1, "a failed restore changes nothing");
    } finally {
      await host.stop();
    }
  }));

test("tools persist across host restarts, and start/stop are idempotent and reversible", () =>
  withTempDir(async (dir) => {
    const host = new ToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet });
    await host.start();
    await host.start();
    await create(host, "persisted", "return 42;");
    await host.stop();
    await host.stop();
    assert.throws(() => host.tools(), (error) => error.code === "host_stopped");
    await assert.rejects(host.call("persisted", {}), (error) => error.code === "host_stopped");

    await host.start();
    try {
      assert.equal(await host.call("persisted", { value: "" }), 42);
    } finally {
      await host.stop();
    }
  }));

test("one host per dir: a second host is refused while the first is running", () =>
  withTempDir(async (dir) => {
    const options = { dir: path.join(dir, "host"), workspace: dir, ...quiet };
    const first = await createToolHost(options);
    try {
      await assert.rejects(createToolHost(options), (error) => error.code === "dir_in_use");
    } finally {
      await first.stop();
    }
    const second = await createToolHost(options);
    await second.stop();
    await fs.writeFile(path.join(dir, "host", ".lock"), "999999999");
    const third = await createToolHost(options);
    await third.stop();
  }));

test("a tool that throws reports its message and code without killing the worker", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet });
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

test("results must be JSON and under the size limit; odd values are handled", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, maxResultBytes: 1000, ...quiet });
    try {
      await create(host, "big", "return 'x'.repeat(2000);");
      await create(host, "bigint", "return 10n;");
      await create(host, "circular", "const a = {}; a.self = a; return a;");
      await create(host, "nothing", "return undefined;");
      await create(host, "fn", "return () => 1;");
      await create(host, "map", "return { m: new Map([[1, 2]]), u: undefined, d: new Date(0) };");
      await assert.rejects(host.call("big", {}), (error) => error.code === "result_too_large");
      await assert.rejects(host.call("bigint", {}), (error) => error.code === "unserializable_result");
      await assert.rejects(host.call("circular", {}), (error) => error.code === "unserializable_result");
      assert.equal(await host.call("nothing", {}), null);
      assert.equal(await host.call("fn", {}), null);
      assert.deepEqual(await host.call("map", {}), { m: {}, d: "1970-01-01T00:00:00.000Z" });
    } finally {
      await host.stop();
    }
  }));

test("a hung tool times out; a crashed worker fails in-flight calls and restarts itself", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, callTimeoutMs: 200, ...quiet });
    try {
      await create(host, "hang", "await new Promise(() => {});");
      await create(host, "die", "setTimeout(() => process.exit(3), 10); await new Promise(() => {});");
      await create(host, "fine", "return 'ok';");
      await assert.rejects(host.call("hang", {}), (error) => error.code === "timeout");

      const restarting = once(host.worker, "restarting");
      await assert.rejects(host.call("die", {}), (error) => error.code === "worker_unavailable" && /unexpectedly/.test(error.message));
      assert.equal(host.status().worker.lastExit.code, 3);
      const [{ attempt }] = await restarting;
      assert.equal(attempt, 1);

      assert.equal(await host.call("fine", {}), "ok", "the call waits for the automatic restart");
      assert.equal(host.status().worker.crashCount, 1);
    } finally {
      await host.stop();
    }
  }));

test("an unhandled rejection or a throw in a timer is reported, not fatal", () =>
  withTempDir(async (dir) => {
    const warnings = [];
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, onLog: (e) => warnings.push(e.text) });
    try {
      await create(host, "floating", "Promise.reject(new Error('floating')); return 'returned';");
      await create(host, "timer", "setTimeout(() => { throw new Error('in timer'); }, 1); return 'returned';");
      await create(host, "logger", "console.log('hello from tool'); return 1;");
      assert.equal(await host.call("floating", {}), "returned");
      assert.equal(await host.call("timer", {}), "returned");
      await host.call("logger", {});
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(host.status().worker.ready, true);
      assert.equal(host.status().worker.crashCount, 0);
      assert.ok(warnings.some((t) => /unhandledRejection: floating/.test(t)), warnings.join("|"));
      assert.ok(warnings.some((t) => /uncaughtException: in timer/.test(t)), warnings.join("|"));
      assert.ok(warnings.some((t) => /hello from tool/.test(t)), "console.log from a tool reaches onLog");
    } finally {
      await host.stop();
    }
  }));

test("after too many crashes the worker stops restarting and reports unhealthy", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet });
    host.worker.maxCrashRestarts = 1;
    try {
      await create(host, "die", "setTimeout(() => process.exit(1), 5); await new Promise(() => {});");
      const unhealthy = once(host.worker, "unhealthy");
      await assert.rejects(host.call("die", {}));
      await once(host.worker, "ready");
      await assert.rejects(host.call("die", {}));
      const [report] = await unhealthy;
      assert.equal(report.crashes, 2);
      await assert.rejects(host.call("die", {}), (error) => error.code === "worker_unavailable");
      await host.worker.restart("manual");
      assert.equal(host.status().worker.ready, true);
    } finally {
      await host.stop();
    }
  }));

test("concurrent creates all succeed and in-flight calls survive a restart", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet });
    try {
      await create(host, "slow", "await new Promise((r) => setTimeout(r, 150)); return 'slow-done';");
      const inflight = host.call("slow", {});
      const results = await Promise.allSettled([0, 1, 2, 3, 4].map((i) => create(host, `par${i}`, `return ${i};`)));
      assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
      assert.equal(await inflight, "slow-done", "the call that was running when tools changed completed");
      for (const i of [0, 1, 2, 3, 4]) assert.equal(await host.call(`par${i}`, {}), i);
      assert.deepEqual(host.tools().slice(5).map((t) => t.name), ["par0", "par1", "par2", "par3", "par4", "slow"]);
    } finally {
      await host.stop();
    }
  }));

test("names are exact and case-insensitively unique; core names are reserved", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet });
    try {
      await create(host, "Echo", "return 'upper';");
      await assert.rejects(create(host, "echo", "return 'lower';"), (error) => error.code === "exists" && /"Echo" exists/.test(error.message));
      await assert.rejects(host.call("echo", {}), (error) => error.code === "not_found", "calls are exact");
      await assert.rejects(create(host, " spaced ", "return 1;"), (error) => error.code === "invalid_name");
      await assert.rejects(create(host, "CREATE_TOOL", "return 1;"), (error) => error.code === "invalid_name");
      assert.deepEqual((await fs.readdir(path.join(dir, "host", "modules"))).sort(), ["Echo.mjs"]);
    } finally {
      await host.stop();
    }
  }));

test("ctx confines files by real path, blocks recursion, and disables exec by default", () =>
  withTempDir(async (dir) => {
    const workspace = path.join(dir, "ws");
    const outside = path.join(dir, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(workspace, "link"));
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace, ...quiet });
    try {
      await create(host, "writer", "return ctx.writeText(args.value, 'hello');");
      await create(host, "reader", "return ctx.readText(args.value);");
      assert.deepEqual(await host.call("writer", { value: "notes/a.txt" }), { path: path.join("notes", "a.txt") });
      assert.equal(await fs.readFile(path.join(workspace, "notes", "a.txt"), "utf8"), "hello");
      for (const bad of ["../escape.txt", "/etc/passwd", "link/planted.txt"]) {
        await assert.rejects(host.call("writer", { value: bad }), (error) => error.code === "path_outside_workspace", bad);
      }
      await assert.rejects(host.call("reader", { value: "missing.txt" }), (error) => error.code === "file_not_found" && !error.message.includes(dir));
      assert.deepEqual(await fs.readdir(outside), [], "nothing was written outside");

      await create(host, "ping", "return ctx.callTool('pong', args);");
      await create(host, "pong", "return ctx.callTool('ping', args);");
      await assert.rejects(host.call("ping", {}), (error) => error.code === "recursive_call" && /ping -> pong -> ping/.test(error.message));

      await create(host, "sh", "return ctx.exec('echo hi');");
      await assert.rejects(host.call("sh", {}), (error) => error.code === "capability_disabled");
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
      capabilities: { exec: true, execEnv: { GREETING: "hello" } },
      ...quiet
    });
    try {
      await create(host, "sh", "return ctx.exec('printf \"%s|%s\" \"$GREETING\" \"$TOOLHOST_TEST_SECRET\"');");
      const result = await host.call("sh", {});
      assert.equal(result.ok, true);
      assert.equal(result.stdout, "hello|", "host-configured env is present; the parent's env is not");
      await create(host, "fail", "return ctx.exec('exit 7');");
      const failed = await host.call("fail", {});
      assert.equal(failed.ok, false);
      assert.equal(failed.code, 7);
    } finally {
      delete process.env.TOOLHOST_TEST_SECRET;
      await host.stop();
    }
  }));

test("provider adapters produce each API's shape with the values intact", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet });
    try {
      await create(host, "extra", "return 1;");
      const tools = host.tools();
      assert.equal(tools.length, 6);
      const anthropic = toAnthropic(tools);
      assert.deepEqual(anthropic.at(-1), { name: "extra", description: tools.at(-1).description, input_schema: tools.at(-1).parameters });
      const responses = toOpenAIResponses(tools);
      assert.deepEqual(responses[0], { type: "function", name: "create_tool", description: tools[0].description, parameters: tools[0].parameters });
      const chat = toOpenAIChat(tools);
      assert.deepEqual(chat.at(-1), { type: "function", function: { name: "extra", description: tools.at(-1).description, parameters: tools.at(-1).parameters } });
      assert.equal(chat.length, 6);
    } finally {
      await host.stop();
    }
  }));
