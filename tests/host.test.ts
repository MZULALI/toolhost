import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { createToolHost, ToolHost, toAnthropic, toOpenAIChat, toOpenAIResponses } from "../src/index.ts";
import { echoSchema, withTempDir } from "./helpers.ts";

/** Most tests exercise the worker without Node's permission model; the permissions test turns it on explicitly. */
const quiet = { onLog: () => {}, permissions: false };

/** `host.call` returns `unknown`; tests read into results, so widen once here. */
const call = (host: ToolHost, name: string, args: Record<string, unknown> = {}): Promise<any> => host.call(name, args);

const create = (host: ToolHost, name: string, executeSource: string, parameters: Record<string, unknown> = echoSchema): Promise<any> =>
  call(host, "create_tool", {
    name,
    description: `Test tool ${name} for the host suite.`,
    parameters_json: JSON.stringify(parameters),
    execute_source: executeSource
  });

test("a tool created through the model-facing API is callable on the next call", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet });
    try {
      assert.deepEqual(host.tools().map((t: any) => t.name), ["create_tool", "list_tools", "read_tool", "update_tool", "delete_tool"]);

      const created = await create(host, "shout", "return { shouted: args.value.toUpperCase() };");
      assert.equal(created.tool.name, "shout");
      assert.deepEqual(await call(host, "shout", { value: "hi" }), { shouted: "HI" });
      assert.equal(host.tools().at(-1)!.name, "shout");

      await call(host, "update_tool", { name: "shout", execute_source: "return { shouted: args.value + '!' };" });
      assert.deepEqual(await call(host, "shout", { value: "hi" }), { shouted: "hi!" });

      const listed = await call(host, "list_tools", { include_disabled: false });
      assert.equal(listed.tools.length, 1);
      const read = await call(host, "read_tool", { name: "shout", include_source: true });
      assert.match(read.tool.execute_source, /shouted/);
      assert.equal("moduleSource" in read.tool, false);

      await call(host, "delete_tool", { name: "shout" });
      await assert.rejects(call(host, "shout", { value: "x" }), (error: any) => error.code === "not_found");
    } finally {
      await host.stop();
    }
  }));

test("history is readable and any version, including a deleted one, can be restored", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet });
    try {
      await create(host, "v", "return 1;");
      await call(host, "update_tool", { name: "v", execute_source: "return 2;" });
      await call(host, "update_tool", { name: "v", execute_source: "return 3;" });
      assert.equal(await call(host, "v", { value: "" }), 3);

      const read = await call(host, "read_tool", { name: "v", include_source: true, include_history: true });
      assert.deepEqual(read.history.map((v: any) => [v.operation, v.execute_source]), [["update", "return 3;"], ["update", "return 2;"], ["create", "return 1;"]]);
      assert.equal(read.history_truncated, false);
      const noSource = await call(host, "read_tool", { name: "v", include_source: false, include_history: true });
      assert.equal("execute_source" in noSource.history[0], false, "history source is opt-in");
      assert.deepEqual(host.history("v").map((v: any) => v.executeSource), ["return 3;", "return 2;", "return 1;"]);

      const first = read.history.at(-1).version;
      await call(host, "update_tool", { name: "v", restore_version: first });
      assert.equal(await call(host, "v", { value: "" }), 1);

      const deleted = await call(host, "delete_tool", { name: "v" });
      await assert.rejects(call(host, "read_tool", { name: "v", include_source: false }), (error: any) => error.code === "not_found");
      await assert.rejects(call(host, "update_tool", { name: "v", execute_source: "return 9;" }), (error: any) => error.code === "not_found");
      const afterDelete = await call(host, "read_tool", { name: "v", include_source: false, include_history: true });
      assert.equal(afterDelete.tool, null, "a deleted tool has no current version");
      assert.equal(afterDelete.history[0].operation, "delete");
      assert.equal(afterDelete.history[0].version, deleted.restore_version, "delete_tool hands back the id needed to undo it");
      await call(host, "update_tool", { name: "v", restore_version: afterDelete.history[0].version });
      assert.equal(await call(host, "v", { value: "" }), 1, "a deleted tool comes back through update_tool.restore_version");

      await assert.rejects(call(host, "update_tool", { name: "v", restore_version: 99999 }), (error: any) => error.code === "not_found");
      assert.equal(await call(host, "v", { value: "" }), 1, "a failed restore changes nothing");
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
    assert.throws(() => host.tools(), (error: any) => error.code === "host_stopped");
    await assert.rejects(call(host, "persisted", {}), (error: any) => error.code === "host_stopped");

    await host.start();
    try {
      assert.equal(await call(host, "persisted", { value: "" }), 42);
    } finally {
      await host.stop();
    }
  }));

test("one host per dir: a second host is refused while the first is running", () =>
  withTempDir(async (dir) => {
    const options = { dir: path.join(dir, "host"), workspace: dir, ...quiet };
    const first = await createToolHost(options);
    try {
      await assert.rejects(createToolHost(options), (error: any) => error.code === "dir_in_use");
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
      await assert.rejects(call(host, "boom", { value: "1" }), (error: any) => error.code === "call_failed" && /kaboom 1/.test(error.message));
      assert.equal(await call(host, "fine", { value: "" }), "ok");
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
      await assert.rejects(call(host, "big", {}), (error: any) => error.code === "result_too_large");
      await assert.rejects(call(host, "bigint", {}), (error: any) => error.code === "unserializable_result");
      await assert.rejects(call(host, "circular", {}), (error: any) => error.code === "unserializable_result");
      assert.equal(await call(host, "nothing", {}), null);
      assert.equal(await call(host, "fn", {}), null);
      assert.deepEqual(await call(host, "map", {}), { m: {}, d: "1970-01-01T00:00:00.000Z" });
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
      await assert.rejects(call(host, "hang", {}), (error: any) => error.code === "timeout");

      const restarting = once(host.worker, "restarting");
      await assert.rejects(call(host, "die", {}), (error: any) => error.code === "worker_unavailable" && /unexpectedly/.test(error.message));
      assert.equal(host.status().worker.lastExit.code, 3);
      const [{ attempt }] = await restarting;
      assert.equal(attempt, 1);

      assert.equal(await call(host, "fine", {}), "ok", "the call waits for the automatic restart");
      assert.equal(host.status().worker.crashCount, 1);
    } finally {
      await host.stop();
    }
  }));

test("an unhandled rejection or a throw in a timer is reported, not fatal", () =>
  withTempDir(async (dir) => {
    const warnings: string[] = [];
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, onLog: (e: any) => warnings.push(e.text) });
    try {
      await create(host, "floating", "Promise.reject(new Error('floating')); return 'returned';");
      await create(host, "timer", "setTimeout(() => { throw new Error('in timer'); }, 1); return 'returned';");
      await create(host, "logger", "console.log('hello from tool'); return 1;");
      assert.equal(await call(host, "floating", {}), "returned");
      assert.equal(await call(host, "timer", {}), "returned");
      await call(host, "logger", {});
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(host.status().worker.ready, true);
      assert.equal(host.status().worker.crashCount, 0);
      assert.ok(warnings.some((t: any) => /unhandledRejection: floating/.test(t)), warnings.join("|"));
      assert.ok(warnings.some((t: any) => /uncaughtException: in timer/.test(t)), warnings.join("|"));
      assert.ok(warnings.some((t: any) => /hello from tool/.test(t)), "console.log from a tool reaches onLog");
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
      await assert.rejects(call(host, "die", {}));
      await once(host.worker, "ready");
      await assert.rejects(call(host, "die", {}));
      const [report] = await unhealthy;
      assert.equal(report.crashes, 2);
      await assert.rejects(call(host, "die", {}), (error: any) => error.code === "worker_unavailable");
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
      await create(host, "slow", "await new Promise((r) => setTimeout(r,150)); return 'slow-done';");
      const inflight = call(host, "slow", {});
      const results = await Promise.allSettled([0, 1, 2, 3, 4].map((i) => create(host, `par${i}`, `return ${i};`)));
      assert.deepEqual(results.map((r: any) => r.status), ["fulfilled", "fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
      assert.equal(await inflight, "slow-done", "the call that was running when tools changed completed");
      for (const i of [0, 1, 2, 3, 4]) assert.equal(await call(host, `par${i}`, {}), i);
      assert.deepEqual(host.tools().slice(5).map((t: any) => t.name), ["par0", "par1", "par2", "par3", "par4", "slow"]);
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
        Array.from({ length: 8 }, (_, i) => call(host, "update_tool", { name: "same", execute_source: `return ${i + 1};` }))
      );
      const failures = results.filter((r: any) => r.status === "rejected");
      assert.deepEqual(failures.map((r: any) => r.reason.name), [], failures.map((r: any) => r.reason.message).join("|"));
      const value = await call(host, "same", {});
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
        await assert.rejects(host.call(bad as any, {}), (error: any) => error.name === "ToolError" && error.code === "invalid_name", String(bad));
      }
      assert.ok(Date.now() - started < 1000, "rejected immediately, not after the call timeout");
      await assert.rejects(host.call("create_tool", "not an object" as any), (error: any) => error.name === "ToolError");
      await assert.rejects(call(host, "read_tool", { name: 7 }), (error: any) => error.name === "ToolError" && error.code === "invalid_name");
      await assert.rejects(call(host, "update_tool", { name: "x", restore_version: "3" }), (error: any) => error.code === "invalid_argument");
      await assert.rejects(call(host, "update_tool", { name: "x", restore_version: 1.5 }), (error: any) => error.code === "invalid_argument");
      const cyclic: any = { type: "object", properties: {} };
      cyclic.properties.self = cyclic;
      await assert.rejects(host.registry!.create({ name: "c", description: "Cyclic schema tool.", parameters: cyclic, executeSource: "return 1;" }), (error: any) => error.code === "invalid_schema");
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
      await assert.rejects(create(host, "doomed", "return 1;"), (error: any) => error.code === "worker_unavailable" && /rolled back/.test(error.message));
      await assert.rejects(call(host, "update_tool", { name: "stable", execute_source: "return 'v2';" }), (error: any) => /rolled back/.test(error.message));
      await assert.rejects(call(host, "delete_tool", { name: "stable" }), (error: any) => /rolled back/.test(error.message));
      host.worker.readyTimeoutMs = 5_000;
      await host.worker.restart("recover");
      assert.deepEqual(host.tools().slice(5).map((t: any) => t.name), ["stable"]);
      assert.equal(await call(host, "stable", {}), "v1");
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
      await assert.rejects(create(host, "echo", "return 'lower';"), (error: any) => error.code === "exists" && /"Echo" exists/.test(error.message));
      await assert.rejects(call(host, "echo", {}), (error: any) => error.code === "not_found", "calls are exact");
      await assert.rejects(create(host, " spaced ", "return 1;"), (error: any) => error.code === "invalid_name");
      await assert.rejects(create(host, "CREATE_TOOL", "return 1;"), (error: any) => error.code === "invalid_name");
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
      assert.deepEqual(await call(host, "writer", { value: "notes/a.txt" }), { path: path.join("notes", "a.txt") });
      assert.equal(await fs.readFile(path.join(workspace, "notes", "a.txt"), "utf8"), "hello");
      for (const bad of ["../escape.txt", "/etc/passwd", "link/planted.txt"]) {
        await assert.rejects(call(host, "writer", { value: bad }), (error: any) => error.code === "path_outside_workspace", bad);
      }
      await assert.rejects(call(host, "reader", { value: "missing.txt" }), (error: any) => error.code === "file_not_found" && !error.message.includes(dir));
      assert.deepEqual(await fs.readdir(outside), [], "nothing was written outside");

      await create(host, "ping", "return ctx.callTool('pong', args);");
      await create(host, "pong", "return ctx.callTool('ping', args);");
      await assert.rejects(call(host, "ping", {}), (error: any) => error.code === "recursive_call" && /ping -> pong -> ping/.test(error.message));

      await create(host, "sh", "return ctx.exec('echo hi');");
      await assert.rejects(call(host, "sh", {}), (error: any) => error.code === "capability_disabled");
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
      assert.equal(await call(host, "w", {}), "x");
    } finally {
      await host.stop();
    }
  }));

test("maxResultBytes is an inclusive limit", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, maxResultBytes: 12, ...quiet });
    try {
      await create(host, "sized", "return 'x'.repeat(Number(args.value));");
      assert.equal(await call(host, "sized", { value: "10" }), "x".repeat(10), "10 chars + 2 quotes = 12 bytes");
      await assert.rejects(call(host, "sized", { value: "11" }), (error: any) => error.code === "result_too_large");
    } finally {
      await host.stop();
    }
  }));

test("fetchJson has a timeout, a size cap, model-readable errors, and can be disabled", () =>
  withTempDir(async (dir) => {
    const { createServer } = await import("node:http");
    const server = createServer((req: any, res: any) => {
      if (req.url === "/json") return res.end(JSON.stringify({ hello: "world" }));
      if (req.url === "/text") return res.end("plain");
      if (req.url === "/big") return res.end("x".repeat(5000));
      if (req.url === "/slow") return setTimeout(() => res.end("late"), 2000);
      res.statusCode = 404;
      res.end("nope");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, maxResultBytes: 4000, ...quiet });
    try {
      await create(host, "get", "return ctx.fetchJson(args.value, { timeoutMs: 300 });");
      assert.deepEqual((await call(host, "get", { value: `${base}/json` })).body, { hello: "world" });
      const text = await call(host, "get", { value: `${base}/text` });
      assert.equal(text.body, "plain");
      assert.equal(text.ok, true);
      assert.equal((await call(host, "get", { value: `${base}/missing` })).status, 404);
      await assert.rejects(call(host, "get", { value: `${base}/big` }), (error: any) => error.code === "fetch_too_large");
      await assert.rejects(call(host, "get", { value: `${base}/slow` }), (error: any) => error.code === "fetch_timeout");
      await assert.rejects(call(host, "get", { value: "not a url" }), (error: any) => error.code === "fetch_failed" && /not a url/.test(error.message));
      await assert.rejects(call(host, "get", { value: "http://127.0.0.1:1/" }), (error: any) => error.code === "fetch_failed");
    } finally {
      await host.stop();
      server.close();
    }
    const offline = await createToolHost({ dir: path.join(dir, "host2"), workspace: dir, capabilities: { network: false }, ...quiet });
    try {
      await create(offline, "get", "return ctx.fetchJson(args.value);");
      await assert.rejects(call(offline, "get", { value: `${base}/json` }), (error: any) => error.code === "capability_disabled");
    } finally {
      await offline.stop();
    }
  }));

test("stopping the worker also stops processes a tool spawned", { skip: process.platform === "win32" }, () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet });
    let grandchild: number | undefined;
    try {
      await create(host, "spawn", "const { spawn } = await import('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); return c.pid;");
      grandchild = await call(host, "spawn", {});
      assert.ok(Number.isInteger(grandchild));
      process.kill(grandchild!, 0);
      await host.worker.restart("test");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.throws(() => process.kill(grandchild!, 0), /ESRCH/, "the grandchild died with the worker's process group");
    } finally {
      try {
        process.kill(grandchild!, "SIGKILL");
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
      await assert.rejects(createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet }), (error: any) => error.code === "dir_in_use");
    } finally {
      other.kill("SIGKILL");
    }
  }));

test("a source larger than maxSourceBytes is refused before it is stored", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, maxSourceBytes: 200, ...quiet });
    try {
      await assert.rejects(create(host, "fat", `const s = "${"x".repeat(300)}"; return s.length;`), (error: any) => error.code === "invalid_source" && /limit is 200/.test(error.message));
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
      for (let i = 1; i <= 25; i += 1) await call(host, "update_tool", { name: "many", execute_source: `return ${i};` });
      const first = await call(host, "read_tool", { name: "many", include_source: false, include_history: true });
      assert.equal(first.history.length, 20);
      assert.equal(first.history_truncated, true);
      const second = await call(host, "read_tool", { name: "many", include_source: true, include_history: true, history_before: first.history_next_before });
      assert.equal(second.history.length, 6);
      assert.equal(second.history_truncated, false);
      assert.equal(second.history.at(-1).operation, "create");
      assert.equal(second.history.at(-1).execute_source, "return 0;");
      await call(host, "update_tool", { name: "many", restore_version: second.history.at(-1).version });
      assert.equal(await call(host, "many", {}), 0, "the oldest version is restorable through the model-facing API");
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
        await assert.rejects(call(host, "forge", { value: forged }), (error: any) => error.code === "call_failed" && error.details.remoteCode === forged, forged);
      }
      await assert.rejects(call(host, "forge", { value: "not_found" }), (error: any) => error.code === "not_found", "codes the worker legitimately raises pass through");
      await create(host, "ownfs", "const fs = await import('node:fs/promises'); return fs.readFile('/definitely/not/here');");
      await assert.rejects(call(host, "ownfs", {}), (error: any) => error.code === "call_failed" && error.details.remoteCode === "ENOENT");
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
      assert.deepEqual(await call(host, "app", { value: "log.txt" }), { path: "log.txt" });
      await call(host, "app", { value: "log.txt" });
      assert.equal(await fs.readFile(path.join(workspace, "log.txt"), "utf8"), "xx");
      await assert.rejects(call(host, "app", { value: "../evil.txt" }), (error: any) => error.code === "path_outside_workspace");
      assert.deepEqual(await call(host, "ls", { value: "sub" }), [{ name: "f.txt", type: "file" }]);
      assert.deepEqual((await call(host, "ls", { value: "." })).map((e: any) => e.name).sort(), ["log.txt", "sub"]);
      await assert.rejects(call(host, "ls", { value: "sub/f.txt" }), (error: any) => error.code === "file_error");
      await assert.rejects(call(host, "ls", { value: "nope" }), (error: any) => error.code === "file_not_found");
      const pwd = await call(host, "cwd", { value: "sub" });
      assert.equal(pwd.stdout.trim(), await fs.realpath(path.join(workspace, "sub")));
      await assert.rejects(call(host, "cwd", { value: ".." }), (error: any) => error.code === "path_outside_workspace", "confinement is thrown, not returned as a failed command");
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
      assert.ok((await call(host, "peek", { value: "." })).some((e: any) => e.name === ".toolhost"), "it is visible in a listing");
      await assert.rejects(call(host, "peek", { value: ".toolhost" }), (error: any) => error.code === "path_outside_workspace");
      await assert.rejects(call(host, "peek", { value: ".toolhost/modules" }), (error: any) => error.code === "path_outside_workspace");
      await assert.rejects(call(host, "clobber", { value: ".toolhost/tools.sqlite" }), (error: any) => error.code === "path_outside_workspace");
      assert.equal(await call(host, "peek", { value: "." }).then((l: any) => l.length), 1);
    } finally {
      await host.stop();
    }
  }));

test("start() failures are ToolErrors; options are validated", () =>
  withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "file"), "x");
    await assert.rejects(createToolHost({ dir: path.join(dir, "file"), workspace: dir, ...quiet }), (error: any) => error.code === "start_failed" && error.name === "ToolError");
    await assert.rejects(createToolHost({ dir: path.join(dir, "h"), workspace: path.join(dir, "missing"), ...quiet }), (error: any) => error.code === "invalid_argument");
    await fs.mkdir(path.join(dir, "h2"));
    await fs.mkdir(path.join(dir, "h2", "tools.sqlite"));
    await assert.rejects(createToolHost({ dir: path.join(dir, "h2"), workspace: dir, ...quiet }), (error: any) => error.code === "start_failed");
    assert.equal(await fs.access(path.join(dir, "h2", ".lock")).then(() => true, () => false), false, "lock released after a failed start");
    for (const bad of [{ maxResultBytes: 0 }, { callTimeoutMs: -1 }, { readyTimeoutMs: 1.5 }, { maxCrashRestarts: -1 }, { maxSourceBytes: "big" }]) {
      assert.throws(() => new ToolHost({ dir: path.join(dir, "h3"), workspace: dir, ...(bad as any) }), (error: any) => error.code === "invalid_argument", JSON.stringify(bad));
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
      await assert.rejects(call(host, "r", {}), (error: any) => error.code === "workspace_unavailable" && !error.message.includes(dir));
      const { createServer } = await import("node:http");
      const server = createServer(() => {});
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const started = Date.now();
        await assert.rejects(call(host, "f", { value: `http://127.0.0.1:${(server.address() as any).port}/` }), (error: any) => error.code === "fetch_timeout");
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
    await create(host, "slow", "await new Promise((r) => setTimeout(r,200)); return 'done';");
    const inflight = call(host, "slow", {});
    await host.stop();
    assert.equal(await inflight, "done");
  }));

test("the worker does not inherit the parent's environment; workerEnv adds what a tool needs", () =>
  withTempDir(async (dir) => {
    process.env.TOOLHOST_TEST_SECRET = "leak";
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, workerEnv: { GIVEN: "yes" }, ...quiet });
    try {
      await create(host, "env", "return { secret: process.env.TOOLHOST_TEST_SECRET ?? null, given: process.env.GIVEN ?? null, path: typeof process.env.PATH };");
      assert.deepEqual(await call(host, "env", {}), { secret: null, given: "yes", path: "string" });
    } finally {
      delete process.env.TOOLHOST_TEST_SECRET;
      await host.stop();
    }
  }));

test("with permissions on, a tool cannot read outside the workspace or spawn, even via node:fs", () =>
  withTempDir(async (dir) => {
    const workspace = path.join(dir, "ws");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "in.txt"), "inside");
    await fs.writeFile(path.join(dir, "out.txt"), "outside");
    assert.equal(new ToolHost({ dir: path.join(dir, "probe"), workspace }).worker.permissions, true, "the permission model is on by default");
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace, ...quiet, permissions: true });
    try {
      await create(host, "rawread", "const fs = await import('node:fs/promises'); return fs.readFile(args.value, 'utf8');");
      await create(host, "spawn", "const { execSync } = await import('node:child_process'); return String(execSync('echo hi'));");
      // Node's permission model matches paths as given, so a tool must use the real workspace path (ctx.workspace).
      assert.equal(await call(host, "rawread", { value: path.join(await fs.realpath(workspace), "in.txt") }), "inside");
      await assert.rejects(call(host, "rawread", { value: path.join(await fs.realpath(dir), "out.txt") }), (error: any) => error.code === "call_failed" && error.details.remoteCode === "ERR_ACCESS_DENIED");
      await assert.rejects(call(host, "spawn", {}), (error: any) => error.code === "call_failed" && error.details.remoteCode === "ERR_ACCESS_DENIED");
      await create(host, "viactx", "return ctx.readText('in.txt');");
      assert.equal(await call(host, "viactx", {}), "inside", "the helpers still work under the permission model");
      assert.ok(host.worker.execArgv().includes("--permission"));
    } finally {
      await host.stop();
    }
    const withExec = await createToolHost({ dir: path.join(dir, "host2"), workspace, capabilities: { exec: true }, ...quiet, permissions: true });
    try {
      await create(withExec, "sh", "return ctx.exec('echo hi');");
      assert.equal((await call(withExec, "sh", {})).stdout.trim(), "hi", "exec is allowed when the capability is on");
    } finally {
      await withExec.stop();
    }
  }));

test("arguments are validated against the tool's schema before the call reaches the worker", () =>
  withTempDir(async (dir) => {
    const host = await createToolHost({ dir: path.join(dir, "host"), workspace: dir, ...quiet });
    try {
      await create(host, "typed", "return args.value.toUpperCase();", { type: "object", properties: { value: { type: "string" } }, required: ["value"] });
      assert.equal(await call(host, "typed", { value: "ok" }), "OK");
      await assert.rejects(call(host, "typed", { value: 5 }), (error: any) => error.code === "invalid_arguments" && /args.value must be string, got number 5/.test(error.message));
      await assert.rejects(call(host, "typed", {}), (error: any) => error.code === "invalid_arguments" && /args.value is required/.test(error.message));
      await assert.rejects(call(host, "typed", { value: "ok", extra: 1 }), (error: any) => error.code === "invalid_arguments" && error.details.problems.length === 1);
      await assert.rejects(call(host, "unknown_tool", { value: 5 }), (error: any) => error.code === "not_found", "unknown tools are still reported by the worker");
    } finally {
      await host.stop();
    }
    const loose = await createToolHost({ dir: path.join(dir, "host2"), workspace: dir, validateArgs: false, ...quiet });
    try {
      await create(loose, "typed", "return typeof args.value;", { type: "object", properties: { value: { type: "string" } }, required: ["value"] });
      assert.equal(await call(loose, "typed", { value: 5 }), "number");
    } finally {
      await loose.stop();
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
      const result = await call(host, "sh", {});
      assert.equal(result.ok, true);
      assert.equal(result.stdout, "hello|", "host-configured env is present; the parent's env is not");
      await create(host, "fail", "return ctx.exec('exit 7');");
      const failed = await call(host, "fail", {});
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
      assert.deepEqual(anthropic.at(-1), { name: "extra", description: tools.at(-1).description, input_schema: { ...tools.at(-1).parameters, type: "object" } });
      const responses = toOpenAIResponses(tools);
      assert.deepEqual(responses[0], { type: "function", name: "create_tool", description: tools[0].description, parameters: tools[0].parameters, strict: false });
      const chat = toOpenAIChat(tools);
      assert.deepEqual(chat.at(-1), { type: "function", function: { name: "extra", description: tools.at(-1).description, parameters: tools.at(-1).parameters } });
      assert.equal(chat.length, 6);
    } finally {
      await host.stop();
    }
  }));

test("stop() racing a built-in tool call leaves no worker behind", () =>
  withTempDir(async (dir) => {
    for (const op of ["create", "update", "delete"]) {
      const host = await createToolHost({ dir: path.join(dir, `host-${op}`), workspace: dir, ...quiet });
      if (op !== "create") await create(host, "t", "return 1;");
      const racing =
        op === "create"
          ? create(host, "t", "return 1;")
          : op === "update"
            ? call(host, "update_tool", { name: "t", execute_source: "return 2;" })
            : call(host, "delete_tool", { name: "t" });
      await host.stop();
      const outcome = await racing.then(() => "ok", (error: any) => error.code);
      assert.ok(outcome === "ok" || outcome === "worker_unavailable", `${op}: ${outcome}`);
      assert.equal(host.status().worker.pid, null, `${op}: no worker after stop`);
      assert.equal(host.status().open, false);
      const again = await createToolHost({ dir: path.join(dir, `host-${op}`), workspace: dir, ...quiet });
      await again.stop();
    }
  }));

test("option validation covers non-numeric options; history() validates and stays typed", () =>
  withTempDir(async (dir) => {
    for (const bad of [{ onLog: "x" }, { onLog: null }, { workspace: 42 }, { capabilities: null }, { autoRestart: "yes" }]) {
      assert.throws(() => new ToolHost({ dir: path.join(dir, "h"), workspace: dir, ...(bad as any) }), (error: any) => error.code === "invalid_argument", JSON.stringify(bad));
    }
    const host = await createToolHost({ dir: path.join(dir, "h"), workspace: dir, ...quiet });
    try {
      assert.throws(() => host.history("x", { limit: "x" as any }), (error: any) => error.code === "invalid_argument");
      assert.throws(() => host.history("x", { limit: -1 }), (error: any) => error.code === "invalid_argument");
      assert.throws(() => host.history("x", { before: 1.5 }), (error: any) => error.code === "invalid_argument");
      assert.deepEqual(host.history("x"), []);
      await assert.rejects(call(host, "read_tool", { name: "nosuch", include_source: false, include_history: true, history_before: 5 }), (error: any) => error.code === "not_found");
      await create(host, "f", "return ctx.fetchJson('http://127.0.0.1:1/', { signal: 'x' });");
      await assert.rejects(call(host, "f", {}), (error: any) => error.code === "invalid_argument");
    } finally {
      await host.stop();
    }
  }));
