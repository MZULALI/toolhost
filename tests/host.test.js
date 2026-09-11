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

      const read = await host.call("read_tool", { name: "v", include_source: true, include_history: true });
      assert.deepEqual(read.history.map((v) => [v.operation, v.execute_source]), [["update", "return 3;"], ["update", "return 2;"], ["create", "return 1;"]]);
      assert.equal(read.history_truncated, false);
      const noSource = await host.call("read_tool", { name: "v", include_source: false, include_history: true });
      assert.equal("execute_source" in noSource.history[0], false, "history source is opt-in");
      assert.deepEqual(host.history("v").map((v) => v.executeSource), ["return 3;", "return 2;", "return 1;"]);

      const first = read.history.at(-1).version;
      await host.call("update_tool", { name: "v", restore_version: first });
      assert.equal(await host.call("v", { value: "" }), 1);

      const deleted = await host.call("delete_tool", { name: "v" });
      await assert.rejects(host.call("read_tool", { name: "v", include_source: false }), (error) => error.code === "not_found");
      await assert.rejects(host.call("update_tool", { name: "v", execute_source: "return 9;" }), (error) => error.code === "not_found");
      const afterDelete = await host.call("read_tool", { name: "v", include_source: false, include_history: true });
      assert.equal(afterDelete.tool, null, "a deleted tool has no current version");
      assert.equal(afterDelete.history[0].operation, "delete");
      assert.equal(afterDelete.history[0].version, deleted.restore_version, "delete_tool hands back the id needed to undo it");
      await host.call("update_tool", { name: "v", restore_version: afterDelete.history[0].version });
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

test("concurrent updates of one tool all succeed and every error is a ToolError", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet });
    try {
      await create(host, "same", "return 0;");
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => host.call("update_tool", { name: "same", execute_source: `return ${i + 1};` }))
      );
      const failures = results.filter((r) => r.status === "rejected");
      assert.deepEqual(failures.map((r) => r.reason.name), [], failures.map((r) => r.reason.message).join("|"));
      const value = await host.call("same", {});
      assert.ok(Number.isInteger(value) && value >= 1 && value <= 8, "the worker runs one of the written versions");
      assert.equal(host.history("same").length, 9);
    } finally {
      await host.stop();
    }
  }));

test("call() never rejects with anything but a ToolError, and never hangs on bad input", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, callTimeoutMs: 5_000, ...quiet });
    try {
      const started = Date.now();
      for (const bad of [null, undefined, 42, {}]) {
        await assert.rejects(host.call(bad, {}), (error) => error.name === "ToolError" && error.code === "invalid_name", String(bad));
      }
      assert.ok(Date.now() - started < 1000, "rejected immediately, not after the call timeout");
      await assert.rejects(host.call("create_tool", "not an object"), (error) => error.name === "ToolError");
      await assert.rejects(host.call("read_tool", { name: 7 }), (error) => error.name === "ToolError" && error.code === "invalid_name");
      await assert.rejects(host.call("update_tool", { name: "x", restore_version: "3" }), (error) => error.code === "invalid_argument");
      await assert.rejects(host.call("update_tool", { name: "x", restore_version: 1.5 }), (error) => error.code === "invalid_argument");
      const cyclic = { type: "object", properties: {} };
      cyclic.properties.self = cyclic;
      await assert.rejects(host.registry.create({ name: "c", description: "Cyclic schema tool.", parameters: cyclic, executeSource: "return 1;" }), (error) => error.code === "invalid_schema");
    } finally {
      await host.stop();
    }
  }));

test("a change whose restart fails is rolled back for create, update and delete", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet });
    try {
      await create(host, "stable", "return 'v1';");
      host.worker.readyTimeoutMs = 1;
      await assert.rejects(create(host, "doomed", "return 1;"), (error) => error.code === "worker_unavailable" && /rolled back/.test(error.message));
      await assert.rejects(host.call("update_tool", { name: "stable", execute_source: "return 'v2';" }), (error) => /rolled back/.test(error.message));
      await assert.rejects(host.call("delete_tool", { name: "stable" }), (error) => /rolled back/.test(error.message));
      host.worker.readyTimeoutMs = 5_000;
      await host.worker.restart("recover");
      assert.deepEqual(host.tools().slice(5).map((t) => t.name), ["stable"]);
      assert.equal(await host.call("stable", {}), "v1");
      assert.deepEqual((await fs.readdir(path.join(dir, "host", "modules"))).sort(), ["stable.mjs"]);
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

test("ctx.workspace is the real path, so a symlinked workspace works with the file helpers", () =>
  withTempDir(async (dir) => {
    const real = path.join(dir, "real");
    const link = path.join(dir, "link");
    await fs.mkdir(real);
    await fs.symlink(real, link);
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: link, ...quiet });
    try {
      await create(host, "w", "await ctx.writeText(ctx.workspace + '/note.txt', 'x'); return ctx.readText('note.txt');");
      assert.equal(await host.call("w", {}), "x");
    } finally {
      await host.stop();
    }
  }));

test("maxResultBytes is an inclusive limit", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, maxResultBytes: 12, ...quiet });
    try {
      await create(host, "sized", "return 'x'.repeat(Number(args.value));");
      assert.equal(await host.call("sized", { value: "10" }), "x".repeat(10), "10 chars + 2 quotes = 12 bytes");
      await assert.rejects(host.call("sized", { value: "11" }), (error) => error.code === "result_too_large");
    } finally {
      await host.stop();
    }
  }));

test("fetchJson has a timeout, a size cap, model-readable errors, and can be disabled", () =>
  withTempDir(async (dir) => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      if (req.url === "/json") return res.end(JSON.stringify({ hello: "world" }));
      if (req.url === "/text") return res.end("plain");
      if (req.url === "/big") return res.end("x".repeat(5000));
      if (req.url === "/slow") return setTimeout(() => res.end("late"), 2000);
      res.statusCode = 404;
      res.end("nope");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, maxResultBytes: 4000, ...quiet });
    try {
      await create(host, "get", "return ctx.fetchJson(args.value, { timeoutMs: 300 });");
      assert.deepEqual((await host.call("get", { value: `${base}/json` })).body, { hello: "world" });
      const text = await host.call("get", { value: `${base}/text` });
      assert.equal(text.body, "plain");
      assert.equal(text.ok, true);
      assert.equal((await host.call("get", { value: `${base}/missing` })).status, 404);
      await assert.rejects(host.call("get", { value: `${base}/big` }), (error) => error.code === "fetch_too_large");
      await assert.rejects(host.call("get", { value: `${base}/slow` }), (error) => error.code === "fetch_timeout");
      await assert.rejects(host.call("get", { value: "not a url" }), (error) => error.code === "fetch_failed" && /not a url/.test(error.message));
      await assert.rejects(host.call("get", { value: "http://127.0.0.1:1/" }), (error) => error.code === "fetch_failed");
    } finally {
      await host.stop();
      server.close();
    }
    const offline = await createToolHost({ dir: path.join(dir, "host2"), workspace: dir, capabilities: { network: false }, ...quiet });
    try {
      await create(offline, "get", "return ctx.fetchJson(args.value);");
      await assert.rejects(offline.call("get", { value: `${base}/json` }), (error) => error.code === "capability_disabled");
    } finally {
      await offline.stop();
    }
  }));

test("stopping the worker also stops processes a tool spawned", { skip: process.platform === "win32" }, () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet });
    let grandchild;
    try {
      await create(host, "spawn", "const { spawn } = await import('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); return c.pid;");
      grandchild = await host.call("spawn", {});
      assert.ok(Number.isInteger(grandchild));
      process.kill(grandchild, 0);
      await host.worker.restart("test");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.throws(() => process.kill(grandchild, 0), /ESRCH/, "the grandchild died with the worker's process group");
    } finally {
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {
        // already gone, which is the point
      }
      await host.stop();
    }
  }));

test("a live foreign pid in the lock file is respected", () =>
  withTempDir(async (dir) => {
    const { spawn } = await import("node:child_process");
    const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    try {
      await fs.mkdir(path.join(dir, "host"));
      await fs.writeFile(path.join(dir, "host", ".lock"), String(other.pid));
      await assert.rejects(createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet }), (error) => error.code === "dir_in_use");
    } finally {
      other.kill("SIGKILL");
    }
  }));

test("a source larger than maxSourceBytes is refused before it is stored", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, maxSourceBytes: 200, ...quiet });
    try {
      await assert.rejects(create(host, "fat", `const s = "${"x".repeat(300)}"; return s.length;`), (error) => error.code === "invalid_source" && /limit is 200/.test(error.message));
      assert.equal(host.history("fat").length, 0);
    } finally {
      await host.stop();
    }
  }));

test("history pages past 20 versions and nothing is unreachable", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet });
    try {
      await create(host, "many", "return 0;");
      for (let i = 1; i <= 25; i += 1) await host.call("update_tool", { name: "many", execute_source: `return ${i};` });
      const first = await host.call("read_tool", { name: "many", include_source: false, include_history: true });
      assert.equal(first.history.length, 20);
      assert.equal(first.history_truncated, true);
      const second = await host.call("read_tool", { name: "many", include_source: true, include_history: true, history_before: first.history_next_before });
      assert.equal(second.history.length, 6);
      assert.equal(second.history_truncated, false);
      assert.equal(second.history.at(-1).operation, "create");
      assert.equal(second.history.at(-1).execute_source, "return 0;");
      await host.call("update_tool", { name: "many", restore_version: second.history.at(-1).version });
      assert.equal(await host.call("many", {}), 0, "the oldest version is restorable through the model-facing API");
      assert.equal(host.history("many", { limit: 100 }).length, 27);
    } finally {
      await host.stop();
    }
  }));

test("a tool cannot forge error codes; foreign codes arrive as call_failed", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet });
    try {
      await create(host, "forge", "throw Object.assign(new Error('gone'), { code: args.value });");
      for (const forged of ["host_stopped", "dir_in_use", "ENOENT", "PAYMENT_REQUIRED"]) {
        await assert.rejects(host.call("forge", { value: forged }), (error) => error.code === "call_failed" && error.details.remoteCode === forged, forged);
      }
      await assert.rejects(host.call("forge", { value: "not_found" }), (error) => error.code === "not_found", "codes the worker legitimately raises pass through");
      await create(host, "ownfs", "const fs = await import('node:fs/promises'); return fs.readFile('/definitely/not/here');");
      await assert.rejects(host.call("ownfs", {}), (error) => error.code === "call_failed" && error.details.remoteCode === "ENOENT");
    } finally {
      await host.stop();
    }
  }));

test("appendText and listFiles behave and are confined; exec cwd confinement throws", () =>
  withTempDir(async (dir) => {
    const workspace = path.join(dir, "ws");
    await fs.mkdir(path.join(workspace, "sub"), { recursive: true });
    await fs.writeFile(path.join(workspace, "sub", "f.txt"), "1");
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace, capabilities: { exec: true }, ...quiet });
    try {
      await create(host, "app", "return ctx.appendText(args.value, 'x');");
      await create(host, "ls", "return ctx.listFiles(args.value);");
      await create(host, "cwd", "return ctx.exec('pwd', { cwd: args.value });");
      assert.deepEqual(await host.call("app", { value: "log.txt" }), { path: "log.txt" });
      await host.call("app", { value: "log.txt" });
      assert.equal(await fs.readFile(path.join(workspace, "log.txt"), "utf8"), "xx");
      await assert.rejects(host.call("app", { value: "../evil.txt" }), (error) => error.code === "path_outside_workspace");
      assert.deepEqual(await host.call("ls", { value: "sub" }), [{ name: "f.txt", type: "file" }]);
      assert.deepEqual((await host.call("ls", { value: "." })).map((e) => e.name).sort(), ["log.txt", "sub"]);
      await assert.rejects(host.call("ls", { value: "sub/f.txt" }), (error) => error.code === "file_error");
      await assert.rejects(host.call("ls", { value: "nope" }), (error) => error.code === "file_not_found");
      const pwd = await host.call("cwd", { value: "sub" });
      assert.equal(pwd.stdout.trim(), await fs.realpath(path.join(workspace, "sub")));
      await assert.rejects(host.call("cwd", { value: ".." }), (error) => error.code === "path_outside_workspace", "confinement is thrown, not returned as a failed command");
    } finally {
      await host.stop();
    }
  }));

test("toolhost's own dir is off limits to tools even when it sits inside the workspace", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, ".toolhost"), workspace: dir, ...quiet });
    try {
      await create(host, "peek", "return ctx.listFiles(args.value);");
      await create(host, "clobber", "return ctx.writeText(args.value, 'CORRUPT');");
      assert.ok((await host.call("peek", { value: "." })).some((e) => e.name === ".toolhost"), "it is visible in a listing");
      await assert.rejects(host.call("peek", { value: ".toolhost" }), (error) => error.code === "path_outside_workspace");
      await assert.rejects(host.call("peek", { value: ".toolhost/modules" }), (error) => error.code === "path_outside_workspace");
      await assert.rejects(host.call("clobber", { value: ".toolhost/tools.sqlite" }), (error) => error.code === "path_outside_workspace");
      assert.equal(await host.call("peek", { value: "." }).then((l) => l.length), 1);
    } finally {
      await host.stop();
    }
  }));

test("start() failures are ToolErrors; options are validated", () =>
  withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "file"), "x");
    await assert.rejects(createToolHost({ dir: path.join(dir, "file"), workspace: dir, ...quiet }), (error) => error.code === "start_failed" && error.name === "ToolError");
    await assert.rejects(createToolHost({ dir: path.join(dir, "h"), workspace: path.join(dir, "missing"), ...quiet }), (error) => error.code === "invalid_argument");
    await fs.mkdir(path.join(dir, "h2"));
    await fs.mkdir(path.join(dir, "h2", "tools.sqlite"));
    await assert.rejects(createToolHost({ dir: path.join(dir, "h2"), workspace: dir, ...quiet }), (error) => error.code === "start_failed");
    assert.equal(await fs.access(path.join(dir, "h2", ".lock")).then(() => true, () => false), false, "lock released after a failed start");
    for (const bad of [{ maxResultBytes: 0 }, { callTimeoutMs: -1 }, { readyTimeoutMs: 1.5 }, { maxCrashRestarts: -1 }, { maxSourceBytes: "big" }]) {
      assert.throws(() => new ToolHost({ dir: path.join(dir, "h3"), workspace: dir, ...bad }), (error) => error.code === "invalid_argument", JSON.stringify(bad));
    }
  }));

test("a removed workspace yields workspace_unavailable, and fetchJson keeps its timeout with a caller signal", () =>
  withTempDir(async (dir) => {
    const workspace = path.join(dir, "ws");
    await fs.mkdir(workspace);
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace, ...quiet });
    try {
      await create(host, "r", "return ctx.readText('x.txt');");
      await create(host, "f", "const c = new AbortController(); return ctx.fetchJson(args.value, { timeoutMs: 100, signal: c.signal });");
      await fs.rm(workspace, { recursive: true });
      await assert.rejects(host.call("r", {}), (error) => error.code === "workspace_unavailable" && !error.message.includes(dir));
      const { createServer } = await import("node:http");
      const server = createServer(() => {});
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const started = Date.now();
        await assert.rejects(host.call("f", { value: `http://127.0.0.1:${server.address().port}/` }), (error) => error.code === "fetch_timeout");
        assert.ok(Date.now() - started < 1000);
      } finally {
        server.close();
      }
    } finally {
      await host.stop();
    }
  }));

test("stop() waits for in-flight calls", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet });
    await create(host, "slow", "await new Promise((r) => setTimeout(r, 200)); return 'done';");
    const inflight = host.call("slow", {});
    await host.stop();
    assert.equal(await inflight, "done");
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
