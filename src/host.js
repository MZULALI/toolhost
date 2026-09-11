import fs from "node:fs";
import path from "node:path";
import { coreTools, isCoreTool } from "./definitions.js";
import { ToolError } from "./errors.js";
import { assertToolName } from "./names.js";
import { ToolRegistry } from "./registry.js";
import { ToolStore } from "./store.js";
import { DEFAULT_CAPABILITIES } from "./worker/context.js";
import { ToolWorkerClient } from "./worker/client.js";

/**
 * The one object an application talks to.
 *
 * `tools()` gives the model its tool list. `call(name, args)` runs whatever it picked: a
 * built-in tool changes the registry and restarts the worker; anything else runs in the
 * worker. If the worker cannot restart after a change, the change is rolled back and the
 * call fails, so the tool list the model sees always matches what the worker can run.
 */
export class ToolHost {
  #open = false;
  #lockPath;
  #dbPath;
  #modulesDir;
  #onLog;

  /**
   * @param {{
   *   dir: string,
   *   workspace?: string,
   *   capabilities?: Partial<typeof DEFAULT_CAPABILITIES>,
   *   callTimeoutMs?: number,
   *   readyTimeoutMs?: number,
   *   killGraceMs?: number,
   *   maxResultBytes?: number,
   *   onLog?: (entry: { stream: string, text: string }) => void
   * }} options
   */
  constructor({
    dir,
    workspace = process.cwd(),
    capabilities = {},
    callTimeoutMs = 30_000,
    readyTimeoutMs,
    killGraceMs,
    maxResultBytes = 1_000_000,
    onLog = defaultLog
  }) {
    if (!dir) throw new ToolError("invalid_argument", "ToolHost requires a `dir` to store its database and modules.");
    this.dir = path.resolve(dir);
    this.workspace = path.resolve(workspace);
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...capabilities };
    this.callTimeoutMs = callTimeoutMs;
    this.#dbPath = path.join(this.dir, "tools.sqlite");
    this.#modulesDir = path.join(this.dir, "modules");
    this.#lockPath = path.join(this.dir, ".lock");
    this.#onLog = onLog;

    /** @type {ToolStore | null} */
    this.store = null;
    /** @type {ToolRegistry | null} */
    this.registry = null;
    this.worker = new ToolWorkerClient({
      config: { dbPath: this.#dbPath, modulesDir: this.#modulesDir, workspace: this.workspace, capabilities: this.capabilities, maxResultBytes },
      readyTimeoutMs,
      killGraceMs
    });
    this.worker.on("log", (entry) => this.#onLog(entry));
    this.worker.on("warning", ({ kind, error }) => this.#onLog({ stream: "stderr", text: `${kind}: ${error?.message}\n` }));
  }

  /** Lock the directory, open the store, sync modules, start the worker. Idempotent. */
  async start() {
    if (this.#open) return this;
    fs.mkdirSync(this.dir, { recursive: true });
    acquireLock(this.#lockPath);
    try {
      this.store = new ToolStore(this.#dbPath);
      this.registry = new ToolRegistry({ store: this.store, modulesDir: this.#modulesDir });
      await this.registry.init();
      await this.worker.restart("start");
    } catch (error) {
      this.store?.close();
      this.store = null;
      this.registry = null;
      releaseLock(this.#lockPath);
      throw error;
    }
    this.#open = true;
    return this;
  }

  /** Stop the worker, close the database, release the directory. Idempotent; `start()` reopens. */
  async stop() {
    if (!this.#open) return;
    this.#open = false;
    await this.worker.stop("stop");
    this.store.close();
    this.store = null;
    this.registry = null;
    releaseLock(this.#lockPath);
  }

  /**
   * Built-in tools plus every enabled generated tool, as `{ name, description, parameters }`.
   * Pass through `toAnthropic` / `toOpenAIResponses` / `toOpenAIChat` for a provider's shape.
   */
  tools() {
    this.#assertOpen();
    return [...coreTools, ...this.registry.definitions()];
  }

  /**
   * Run a tool the model chose. Rejects with `ToolError`; the message is written for the model.
   * @param {string} name @param {Record<string, unknown>} [args]
   */
  async call(name, args = {}) {
    this.#assertOpen();
    if (isCoreTool(name)) return this.#callCore(name.toLowerCase(), args ?? {});
    return this.worker.callTool(name, args, { timeoutMs: this.callTimeoutMs });
  }

  /** Previous versions of a tool, newest first. @param {string} name */
  history(name) {
    this.#assertOpen();
    return this.registry.history(name);
  }

  status() {
    return {
      open: this.#open,
      dir: this.dir,
      workspace: this.workspace,
      capabilities: this.capabilities,
      worker: this.worker.status()
    };
  }

  #assertOpen() {
    if (!this.#open) throw new ToolError("host_stopped", "ToolHost is not started. Call start() first.");
  }

  async #callCore(name, args) {
    switch (name) {
      case "create_tool": {
        const tool = await this.#applyThenRestart(
          `create:${args.name}`,
          () =>
            this.registry.create({
              name: args.name,
              description: args.description,
              parameters: args.parameters_json,
              executeSource: args.execute_source
            }),
          (created) => this.registry.delete(created.name)
        );
        return { ok: true, tool: publicTool(tool) };
      }
      case "update_tool": {
        const before = this.store.get(assertNameArg(args.name));
        const beforeVersion = before ? this.registry.history(before.name)[0] : null;
        if (!before && !Number.isInteger(args.restore_version)) {
          throw new ToolError("not_found", `Tool "${args.name}" does not exist. Use create_tool, or restore_version to bring back a deleted version.`);
        }
        const tool = await this.#applyThenRestart(
          `update:${args.name}`,
          () =>
            Number.isInteger(args.restore_version)
              ? this.registry.restore(args.name, args.restore_version)
              : this.registry.update({
                  name: args.name,
                  description: args.description,
                  parameters: args.parameters_json,
                  executeSource: args.execute_source,
                  enabled: args.enabled
                }),
          () => (before ? this.registry.restore(before.name, beforeVersion.id) : this.registry.delete(args.name))
        );
        return { ok: true, tool: publicTool(tool) };
      }
      case "delete_tool": {
        const deleted = await this.#applyThenRestart(
          `delete:${args.name}`,
          () => this.registry.delete(args.name),
          (result) => this.registry.restore(result.name, result.versionId)
        );
        return { ok: true, deleted: deleted.name };
      }
      case "list_tools": {
        const tools = this.registry.list({ includeDisabled: Boolean(args.include_disabled) });
        return { ok: true, tools: tools.map((tool) => publicTool(tool)) };
      }
      case "read_tool": {
        const includeSource = Boolean(args.include_source);
        const tool = this.registry.read(args.name, { includeSource });
        const result = { ok: true, tool: publicTool(tool, includeSource) };
        if (args.include_history) {
          result.history = this.registry.history(tool.name).map((version) => ({
            version: version.id,
            operation: version.operation,
            createdAt: version.createdAt,
            enabled: version.enabled,
            description: version.description,
            execute_source: version.executeSource
          }));
        }
        return result;
      }
      default:
        throw new ToolError("not_found", `Unknown built-in tool: ${name}`);
    }
  }

  /**
   * Apply a registry change, then restart the worker so it takes effect. If the restart
   * fails, undo the change and restart again, so the registry never advertises a tool the
   * worker cannot run.
   */
  async #applyThenRestart(reason, apply, rollback) {
    const value = await apply();
    try {
      await this.worker.restart(reason);
    } catch (error) {
      await rollback(value).catch(noop);
      await this.worker.restart(`rollback:${reason}`).catch(noop);
      throw new ToolError(
        "worker_unavailable",
        `The change was rolled back because the worker could not restart: ${error.message}`,
        { cause: error.code }
      );
    }
    return value;
  }
}

function assertNameArg(name) {
  const value = assertToolName(name);
  if (isCoreTool(value)) throw new ToolError("invalid_name", `"${value}" is a built-in tool and cannot be changed.`);
  return value;
}

/** Shape returned to the model: never the assembled module, only what it authored. */
function publicTool(tool, includeSource = false) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    enabled: tool.enabled,
    createdAt: tool.createdAt,
    updatedAt: tool.updatedAt,
    ...(includeSource ? { execute_source: tool.executeSource } : {})
  };
}

/**
 * One host per directory. A second host sharing the store would advertise tools its own
 * worker has not loaded. The lock is a file holding the owner's pid; a stale lock from a
 * dead process is reclaimed.
 */
function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = Number(fs.readFileSync(lockPath, "utf8"));
      if (owner === process.pid || isAlive(owner)) {
        throw new ToolError("dir_in_use", `Another ToolHost (pid ${owner}) is using ${path.dirname(lockPath)}. Use one host per dir.`);
      }
      fs.rmSync(lockPath, { force: true }); // stale; retry once
    }
  }
  throw new ToolError("dir_in_use", `Could not lock ${path.dirname(lockPath)}.`);
}

function releaseLock(lockPath) {
  try {
    if (Number(fs.readFileSync(lockPath, "utf8")) === process.pid) fs.rmSync(lockPath, { force: true });
  } catch {
    // Already gone.
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function defaultLog({ stream, text }) {
  if (process.env.NODE_ENV === "production") return;
  (stream === "stdout" ? process.stdout : process.stderr).write(`[toolhost:worker] ${text}`);
}

function noop() {}

/**
 * Create and start a host in one call.
 * @param {ConstructorParameters<typeof ToolHost>[0]} options
 */
export async function createToolHost(options) {
  return new ToolHost(options).start();
}
