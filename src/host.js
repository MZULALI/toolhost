import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CAPABILITIES } from "./capabilities.js";
import { coreTools } from "./definitions.js";
import { ToolError } from "./errors.js";
import { assertUserToolName, isCoreTool } from "./names.js";
import { DEFAULT_MAX_SOURCE_BYTES, ToolRegistry } from "./registry.js";
import { ToolStore } from "./store.js";
import { ToolWorkerClient } from "./worker/client.js";

/**
 * The one object an application talks to.
 *
 * `tools()` gives the model its tool list. `call(name, args)` runs whatever it picked: a
 * built-in tool changes the registry and restarts the worker; anything else runs in the
 * worker. If the worker cannot restart after a change, the change is rolled back and the
 * call fails, so the tool list the model sees always matches what the worker can run.
 *
 * Every rejection from `call()` is a `ToolError`. Anything else that escapes is a bug and is
 * wrapped as `internal_error` rather than leaking a raw stack to the model.
 */
export class ToolHost {
  #open = false;
  #lockPath;
  #dbPath;
  #modulesDir;
  #maxSourceBytes;
  #onLog;

  /**
   * @param {{
   *   dir: string,
   *   workspace?: string,
   *   capabilities?: Partial<typeof DEFAULT_CAPABILITIES>,
   *   callTimeoutMs?: number,
   *   readyTimeoutMs?: number,
   *   killGraceMs?: number,
   *   drainTimeoutMs?: number,
   *   autoRestart?: boolean,
   *   maxCrashRestarts?: number,
   *   maxResultBytes?: number,
   *   maxSourceBytes?: number,
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
    drainTimeoutMs,
    autoRestart,
    maxCrashRestarts,
    maxResultBytes = 1_000_000,
    maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES,
    onLog = noop
  }) {
    if (!dir) throw new ToolError("invalid_argument", "ToolHost requires a `dir` to store its database and modules.");
    this.dir = path.resolve(dir);
    this.workspace = path.resolve(workspace);
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...capabilities };
    this.callTimeoutMs = callTimeoutMs;
    this.#dbPath = path.join(this.dir, "tools.sqlite");
    this.#modulesDir = path.join(this.dir, "modules");
    this.#lockPath = path.join(this.dir, ".lock");
    this.#maxSourceBytes = maxSourceBytes;
    this.#onLog = onLog;

    /** @type {ToolStore | null} */
    this.store = null;
    /** @type {ToolRegistry | null} */
    this.registry = null;
    this.worker = new ToolWorkerClient({
      config: { dbPath: this.#dbPath, modulesDir: this.#modulesDir, workspace: this.workspace, capabilities: this.capabilities, maxResultBytes },
      readyTimeoutMs,
      killGraceMs,
      drainTimeoutMs,
      autoRestart,
      maxCrashRestarts
    });
    this.worker.on("log", (entry) => this.#onLog(entry));
    this.worker.on("warning", ({ kind, error }) => this.#onLog({ stream: "stderr", text: `${kind}: ${error?.message}\n` }));
  }

  /** Lock the directory, open the store, sync modules, start the worker. Idempotent. */
  async start() {
    if (this.#open) return this;
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.workspace)) {
      throw new ToolError("invalid_argument", `workspace does not exist: ${this.workspace}`);
    }
    acquireLock(this.#lockPath);
    try {
      this.store = new ToolStore(this.#dbPath);
      this.registry = new ToolRegistry({ store: this.store, modulesDir: this.#modulesDir, maxSourceBytes: this.#maxSourceBytes });
      await this.registry.init();
      await this.worker.restart("start");
    } catch (error) {
      await this.worker.stop("start-failed").catch(noop);
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
    try {
      this.#assertOpen();
      if (typeof name !== "string") throw new ToolError("invalid_name", "Tool name must be a string.");
      const input = args && typeof args === "object" ? args : {};
      if (isCoreTool(name)) return await this.#callCore(name.toLowerCase(), input);
      return await this.worker.callTool(name, input, { timeoutMs: this.callTimeoutMs });
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("internal_error", `toolhost failed unexpectedly: ${error?.message ?? error}`, { cause: error });
    }
  }

  /** Previous versions of a tool, newest first. Includes deleted tools. @param {string} name */
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
        const toolName = assertUserToolName(args.name);
        const restoreVersion = optionalVersionId(args.restore_version);
        const before = this.store.get(toolName);
        const beforeVersion = before ? this.registry.history(toolName)[0] : null;
        if (!before && restoreVersion === undefined) {
          throw new ToolError(
            "not_found",
            `Tool "${toolName}" does not exist. Use create_tool, or read_tool with include_history and update_tool with restore_version to bring back a deleted version.`
          );
        }
        const tool = await this.#applyThenRestart(
          `update:${toolName}`,
          () =>
            restoreVersion !== undefined
              ? this.registry.restore(toolName, restoreVersion)
              : this.registry.update({
                  name: toolName,
                  description: args.description,
                  parameters: args.parameters_json,
                  executeSource: args.execute_source,
                  enabled: args.enabled
                }),
          () => (before ? this.registry.restore(toolName, beforeVersion.id) : this.registry.delete(toolName))
        );
        return { ok: true, tool: publicTool(tool) };
      }
      case "delete_tool": {
        const deleted = await this.#applyThenRestart(
          `delete:${args.name}`,
          () => this.registry.delete(args.name),
          (result) => this.registry.restore(result.name, result.versionId)
        );
        return { ok: true, deleted: deleted.name, restore_version: deleted.versionId };
      }
      case "list_tools": {
        const tools = this.registry.list({ includeDisabled: Boolean(args.include_disabled) });
        return { ok: true, tools: tools.map((tool) => publicTool(tool)) };
      }
      case "read_tool": {
        const toolName = assertUserToolName(args.name);
        const includeSource = Boolean(args.include_source);
        const tool = this.store.get(toolName, { includeSource });
        const history = args.include_history ? this.registry.history(toolName).map(publicVersion) : null;
        if (!tool && !history?.length) throw new ToolError("not_found", `Tool "${toolName}" does not exist.`);
        const result = { ok: true, tool: tool ? publicTool(tool, includeSource) : null };
        if (history) result.history = history;
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

/** `undefined`/`null` mean "not given"; anything else must be a non-negative integer. */
function optionalVersionId(value) {
  if (value === undefined || value === null) return undefined;
  if (Number.isInteger(value) && value >= 0) return value;
  throw new ToolError("invalid_argument", `restore_version must be a version id (a non-negative integer), got ${JSON.stringify(value)}.`);
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

function publicVersion(version) {
  return {
    version: version.id,
    operation: version.operation,
    createdAt: version.createdAt,
    enabled: version.enabled,
    description: version.description,
    execute_source: version.executeSource
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

function noop() {}

/**
 * Create and start a host in one call.
 * @param {ConstructorParameters<typeof ToolHost>[0]} options
 */
export async function createToolHost(options) {
  return new ToolHost(options).start();
}
