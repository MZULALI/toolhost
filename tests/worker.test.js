import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { ToolWorkerClient } from "../src/worker/client.js";
import { withTempDir } from "./helpers.js";

test("a worker that fails to load reports startup_failed and is not supervised", () =>
  withTempDir(async (dir) => {
    const modulesDir = path.join(dir, "modules");
    await fs.writeFile(modulesDir, "not a directory");
    const client = new ToolWorkerClient({ config: { dbPath: path.join(dir, "t.sqlite"), modulesDir, workspace: dir } });
    const restarting = [];
    client.on("restarting", (info) => restarting.push(info));
    await assert.rejects(client.restart("test"), (error) => /Worker failed to start/.test(error.message));
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(client.status().pid, null);
    assert.equal(client.status().restartCount, 1, "no supervised re-fork after a startup failure");
    assert.deepEqual(restarting, []);
    await client.stop();
  }));

test("callTool before start rejects immediately, not after a timeout", () =>
  withTempDir(async (dir) => {
    const client = new ToolWorkerClient({ config: { dbPath: path.join(dir, "t.sqlite"), modulesDir: path.join(dir, "m"), workspace: dir } });
    const started = Date.now();
    await assert.rejects(client.callTool("x", {}), (error) => error.code === "worker_unavailable");
    assert.ok(Date.now() - started < 500);
  }));

test("a raw errno during worker startup arrives as startup_failed without the host path", () =>
  withTempDir(async (dir) => {
    const modulesDir = path.join(dir, "modules");
    await fs.writeFile(modulesDir, "not a directory");
    const client = new ToolWorkerClient({ config: { dir, dbPath: path.join(dir, "t.sqlite"), modulesDir, workspace: dir } });
    await assert.rejects(
      client.restart("test"),
      (error) => error.code === "startup_failed" && !error.message.includes(dir) && typeof error.details.remoteCode === "string"
    );
    await client.stop();
  }));
