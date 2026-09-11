import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CAPABILITIES } from "./capabilities.ts";
import { coreTools } from "./definitions.ts";
import { ToolError, errorCode, errorMessage } from "./errors.ts";
import { DEFAULT_MAX_SOURCE_BYTES, ToolRegistry, type HistoryOptions } from "./registry.ts";
import { ToolStore } from "./storage/store.ts";
import type { Capabilities, HostStatus, LogEntry, Tool, ToolDefinition, ToolHostOptions, ToolVersion } from "./types.ts";
import { assertUserToolName, isCoreTool } from "./validate/names.ts";
import { ToolWorkerClient } from "./worker/client.ts";

/** History rows per `read_tool` call. The model pages with `history_before`. */
const HISTORY_PAGE = 20;

type Args = Record<string, unknown>;

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
  readonly dir: string;
  readonly workspace: string;
  readonly capabilities: Capabilities;
  readonly callTimeoutMs: number;
  readonly worker: ToolWorkerClient;
  /** Available between start() and stop(). */
  store: ToolStore | null = null;
  /** Available between start() and stop(). */
  registry: ToolRegistry | null = null;

  #open = false;
  readonly #lockPath: string;
  readonly #dbPath: string;
  readonly #modulesDir: string;
  readonly #maxSourceBytes: number;
  readonly #onLog: (entry: LogEntry) => void;
  /** Built-in tool calls in progress; stop() waits for them so a late restart cannot outlive it. */
  readonly #coreCalls = new Set<Promise<unknown>>();

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
  }: ToolHostOptions) {
    if (!dir) throw new ToolError("invalid_argument", "ToolHost requires a `dir` to store its database and modules.");
    assertPositiveInteger({ callTimeoutMs, readyTimeoutMs, killGraceMs, drainTimeoutMs, maxResultBytes, maxSourceBytes });
    assertNonNegativeInteger({ maxCrashRestarts });
    if (typeof workspace !== "string" || typeof dir !== "string") {
      throw new ToolError("invalid_argument", "dir and workspace must be strings.");
    }
    if (typeof onLog !== "function") throw new ToolError("invalid_argument", "onLog must be a function.");
    if (!capabilities || typeof capabilities !== "object") throw new ToolError("invalid_argument", "capabilities must be an object.");
    if (autoRestart !== undefined && typeof autoRestart !== "boolean") {
      throw new ToolError("invalid_argument", "autoRestart must be a boolean.");
    }
    this.dir = path.resolve(dir);
    this.workspace = path.resolve(workspace);
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...capabilities };
    this.callTimeoutMs = callTimeoutMs;
    this.#dbPath = path.join(this.dir, "tools.sqlite");
    this.#modulesDir = path.join(this.dir, "modules");
    this.#lockPath = path.join(this.dir, ".lock");
    this.#maxSourceBytes = maxSourceBytes;
    this.#onLog = onLog;

    this.worker = new ToolWorkerClient({
      config: { dir: this.dir, dbPath: this.#dbPath, modulesDir: this.#modulesDir, workspace: this.workspace, capabilities: this.capabilities, maxResultBytes },
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
  async start(): Promise<this> {
    if (this.#open) return this;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!fs.existsSync(this.workspace)) {
        throw new ToolError("invalid_argument", `workspace does not exist: ${this.workspace}`);
      }
      acquireLock(this.#lockPath);
    } catch (error) {
      throw asStartError(error, this.dir);
    }
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
      throw asStartError(error, this.dir);
    }
    this.#open = true;
    return this;
  }

  /** Stop the worker, close the database, release the directory. Idempotent; `start()` reopens. */
  async stop(): Promise<void> {
    if (!this.#open) return;
    this.#open = false;
    await Promise.allSettled([...this.#coreCalls]);
    await this.worker.stop("stop");
    this.store?.close();
    this.store = null;
    this.registry = null;
    releaseLock(this.#lockPath);
  }

  /**
   * Built-in tools plus every enabled generated tool, as `{ name, description, parameters }`.
   * Pass through `toAnthropic` / `toOpenAIResponses` / `toOpenAIChat` for a provider's shape.
   */
  tools(): ToolDefinition[] {
    const registry = this.#assertOpen();
    return [...coreTools, ...registry.definitions()];
  }

  /** Run a tool the model chose. Rejects with `ToolError`; the message is written for the model. */
  async call(name: string, args: Args = {}): Promise<unknown> {
    try {
      this.#assertOpen();
      if (typeof name !== "string") throw new ToolError("invalid_name", "Tool name must be a string.");
      const input: Args = args && typeof args === "object" ? args : {};
      if (!isCoreTool(name)) return await this.worker.callTool(name, input, { timeoutMs: this.callTimeoutMs });
      const pending = this.#callCore(name.toLowerCase(), input);
      this.#coreCalls.add(pending);
      try {
        return await pending;
      } finally {
        this.#coreCalls.delete(pending);
      }
    } catch (error) {
      throw asToolError(error);
    }
  }

  /** Previous versions of a tool, newest first. Includes deleted tools. `before` pages further back. */
  history(name: string, { limit = 20, before }: HistoryOptions = {}): ToolVersion[] {
    try {
      const registry = this.#assertOpen();
      assertPositiveInteger({ limit });
      return registry.history(name, { limit, before: optionalVersionId(before) });
    } catch (error) {
      throw asToolError(error);
    }
  }

  status(): HostStatus {
    return {
      open: this.#open,
      dir: this.dir,
      workspace: this.workspace,
      capabilities: this.capabilities,
      worker: this.worker.status()
    };
  }

  #assertOpen(): ToolRegistry {
    if (!this.#open || !this.registry || !this.store) {
      throw new ToolError("host_stopped", "ToolHost is not started. Call start() first.");
    }
    return this.registry;
  }

  async #callCore(name: string, args: Args): Promise<unknown> {
    const registry = this.#assertOpen();
    const store = this.store!;
    switch (name) {
      case "create_tool": {
        const tool = await this.#applyThenRestart(
          `create:${String(args.name)}`,
          () =>
            registry.create({
              name: args.name as string,
              description: args.description as string,
              parameters: args.parameters_json as string,
              executeSource: args.execute_source as string
            }),
          (created) => registry.delete(created.name)
        );
        return { ok: true, tool: publicTool(tool) };
      }
      case "update_tool": {
        const toolName = assertUserToolName(args.name);
        const restoreVersion = optionalVersionId(args.restore_version);
        const before = store.get(toolName);
        const beforeVersion = before ? registry.history(toolName)[0] : null;
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
              ? registry.restore(toolName, restoreVersion)
              : registry.update({
                  name: toolName,
                  description: args.description as string | undefined,
                  parameters: args.parameters_json as string | undefined,
                  executeSource: args.execute_source as string | undefined,
                  enabled: args.enabled as boolean | undefined
                }),
          () => (before && beforeVersion ? registry.restore(toolName, beforeVersion.id) : registry.delete(toolName))
        );
        return { ok: true, tool: publicTool(tool) };
      }
      case "delete_tool": {
        const deleted = await this.#applyThenRestart(
          `delete:${String(args.name)}`,
          () => registry.delete(args.name as string),
          (result) => registry.restore(result.name, result.versionId)
        );
        return { ok: true, deleted: deleted.name, restore_version: deleted.versionId };
      }
      case "list_tools": {
        const tools = registry.list({ includeDisabled: Boolean(args.include_disabled) });
        return { ok: true, tools: tools.map((tool) => publicTool(tool)) };
      }
      case "read_tool": {
        const toolName = assertUserToolName(args.name);
        const includeSource = Boolean(args.include_source);
        const tool = store.get(toolName, { includeSource });
        const result: Args = { ok: true, tool: tool ? publicTool(tool, includeSource) : null };
        if (args.include_history) {
          const before = optionalVersionId(args.history_before);
          const page = registry.history(toolName, { limit: HISTORY_PAGE, before });
          result.history = page.map((version) => publicVersion(version, includeSource));
          const oldest = page.at(-1);
          const more = oldest ? registry.history(toolName, { limit: 1, before: oldest.id }).length > 0 : false;
          result.history_truncated = more;
          if (more && oldest) result.history_next_before = oldest.id;
          if (!tool && registry.historyCount(toolName) === 0) {
            throw new ToolError("not_found", `Tool "${toolName}" does not exist.`);
          }
        } else if (!tool) {
          throw new ToolError("not_found", `Tool "${toolName}" does not exist.`);
        }
        return result;
      }
      default:
        throw new ToolError("not_found", `Unknown built-in tool: ${name}`);
    }
  }

  /**
   * Apply a registry change, then restart the worker so it takes effect. If the restart fails,
   * undo the change and restart again, so the registry never advertises a tool the worker
   * cannot run.
   */
  async #applyThenRestart<T>(reason: string, apply: () => Promise<T>, rollback: (value: T) => Promise<unknown>): Promise<T> {
    const value = await apply();
    try {
      await this.worker.restart(reason);
    } catch (error) {
      await rollback(value).catch(noop);
      await this.worker.restart(`rollback:${reason}`).catch(noop);
      throw new ToolError("worker_unavailable", `The change was rolled back because the worker could not restart: ${errorMessage(error)}`, {
        cause: errorCode(error)
      });
    }
    return value;
  }
}

/** Create and start a host in one call. */
export async function createToolHost(options: ToolHostOptions): Promise<ToolHost> {
  return new ToolHost(options).start();
}

/** `undefined`/`null` mean "not given"; anything else must be a non-negative integer. */
function optionalVersionId(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (Number.isInteger(value) && (value as number) >= 0) return value as number;
  throw new ToolError("invalid_argument", `restore_version must be a version id (a non-negative integer), got ${JSON.stringify(value)}.`);
}

/** Shape returned to the model: never the assembled module, only what it authored. */
function publicTool(tool: Tool, includeSource = false) {
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

function publicVersion(version: ToolVersion, includeSource: boolean) {
  return {
    version: version.id,
    operation: version.operation,
    createdAt: version.createdAt,
    enabled: version.enabled,
    description: version.description,
    ...(includeSource ? { execute_source: version.executeSource } : {})
  };
}

function assertPositiveInteger(options: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && !(Number.isInteger(value) && (value as number) > 0)) {
      throw new ToolError("invalid_argument", `${key} must be a positive integer, got ${JSON.stringify(value)}.`);
    }
  }
}

function assertNonNegativeInteger(options: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && !(Number.isInteger(value) && (value as number) >= 0)) {
      throw new ToolError("invalid_argument", `${key} must be a non-negative integer, got ${JSON.stringify(value)}.`);
    }
  }
}

/** Every rejection from the public surface is a ToolError. */
function asToolError(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  if (errorCode(error) === "ERR_SQLITE_ERROR") {
    return new ToolError("store_error", `The tool store rejected the operation: ${errorMessage(error)}`, { cause: error });
  }
  return new ToolError("internal_error", `toolhost failed unexpectedly: ${errorMessage(error)}`, { cause: error });
}

/** Anything that is not already a ToolError becomes one, with the sentence a misconfiguration needs. */
function asStartError(error: unknown, dir: string): ToolError {
  if (error instanceof ToolError) return error;
  const code = errorCode(error);
  const detail = code ? `${code}: ${errorMessage(error)}` : errorMessage(error);
  return new ToolError("start_failed", `ToolHost could not start in ${dir}. ${detail}`, { cause: error });
}

/**
 * One host per directory. A second host sharing the store would advertise tools its own
 * worker has not loaded. The lock is a file holding the owner's pid; a stale lock from a dead
 * process is reclaimed.
 */
function acquireLock(lockPath: string): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const owner = Number(fs.readFileSync(lockPath, "utf8"));
      if (owner === process.pid || isAlive(owner)) {
        throw new ToolError("dir_in_use", `Another ToolHost (pid ${owner}) is using ${path.dirname(lockPath)}. Use one host per dir.`);
      }
      fs.rmSync(lockPath, { force: true }); // stale; retry once
    }
  }
  throw new ToolError("dir_in_use", `Could not lock ${path.dirname(lockPath)}.`);
}

function releaseLock(lockPath: string): void {
  try {
    if (Number(fs.readFileSync(lockPath, "utf8")) === process.pid) fs.rmSync(lockPath, { force: true });
  } catch {
    // Already gone.
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function noop(): void {}
