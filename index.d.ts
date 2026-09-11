import type { EventEmitter } from "node:events";

/** JSON Schema object describing a tool's arguments. */
export type JsonSchema = Record<string, unknown>;

/** Provider-neutral tool definition. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** A stored tool. Source fields are present only when requested. */
export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  executeSource?: string;
  moduleSource?: string;
}

/** One row of a tool's history. Deletions are recorded with the content that was deleted. */
export interface ToolVersion {
  id: number;
  operation: "create" | "update" | "restore" | "delete";
  description: string;
  parameters: JsonSchema;
  executeSource: string;
  enabled: boolean;
  createdAt: string;
}

/** What a tool may do from `ctx`. None of this is a sandbox. */
export interface Capabilities {
  /** `ctx.readText` / `writeText` / `appendText` / `listFiles`, confined to the workspace by real path. Default true. */
  files: boolean;
  /** `ctx.fetchJson`. Default true. */
  network: boolean;
  /** `ctx.exec`. Default false. */
  exec: boolean;
  /** Shell used by `ctx.exec`. Default "/bin/sh". */
  shell: string;
  /** Extra environment variables for `ctx.exec`. The parent's environment is not inherited. */
  execEnv: Record<string, string>;
}

export const DEFAULT_CAPABILITIES: Readonly<Capabilities>;

export type ToolErrorCode =
  | "invalid_name"
  | "invalid_description"
  | "invalid_schema"
  | "invalid_source"
  | "invalid_argument"
  | "invalid_path"
  | "internal_error"
  | "exists"
  | "not_found"
  | "recursive_call"
  | "path_outside_workspace"
  | "file_not_found"
  | "file_error"
  | "capability_disabled"
  | "call_failed"
  | "fetch_failed"
  | "fetch_timeout"
  | "fetch_too_large"
  | "unserializable_result"
  | "result_too_large"
  | "timeout"
  | "worker_unavailable"
  | "startup_failed"
  | "host_stopped"
  | "dir_in_use"
  | (string & {});

export class ToolError extends Error {
  name: "ToolError";
  code: ToolErrorCode;
  details: Record<string, unknown>;
  constructor(code: ToolErrorCode, message: string, details?: Record<string, unknown>);
}

export interface LogEntry {
  stream: "stdout" | "stderr";
  text: string;
}

export interface ToolHostOptions {
  /** Directory for the SQLite database, generated module files, and the lock. One host per dir. */
  dir: string;
  /** Root that `ctx` file helpers are confined to. Default `process.cwd()`. */
  workspace?: string;
  capabilities?: Partial<Capabilities>;
  /** Per-call timeout for generated tools. Default 30000. */
  callTimeoutMs?: number;
  /** How long to wait for the worker to load tools. Default 5000. */
  readyTimeoutMs?: number;
  /** How long a worker gets to exit on SIGTERM before SIGKILL. Default 1000. */
  killGraceMs?: number;
  /** How long a tool change waits for in-flight calls before replacing the worker. Default 5000. */
  drainTimeoutMs?: number;
  /** Re-fork the worker after an unexpected exit. Default true. */
  autoRestart?: boolean;
  /** Consecutive crashes before the worker emits "unhealthy" and stays down. Default 5. */
  maxCrashRestarts?: number;
  /** Largest JSON result a tool may return, in bytes. Also the default cap for `ctx.fetchJson`. Default 1_000_000. */
  maxResultBytes?: number;
  /** Largest `execute_source` accepted, in bytes. Default 262_144. */
  maxSourceBytes?: number;
  /** Receives the worker's stdout, stderr, and warnings (unhandled rejections in tools). Default: discard. */
  onLog?: (entry: LogEntry) => void;
}

export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** "crash" for an unexpected exit; otherwise the reason passed to stop() or restart(). */
  reason: string;
  at: string;
}

export interface WorkerStatus {
  pid: number | null;
  ready: boolean;
  tools: string[];
  restartCount: number;
  /** Consecutive unexpected exits. Resets after the worker stays up for 30 s. */
  crashCount: number;
  lastExit: WorkerExit | null;
}

export interface HostStatus {
  open: boolean;
  dir: string;
  workspace: string;
  capabilities: Capabilities;
  worker: WorkerStatus;
}

export class ToolHost {
  constructor(options: ToolHostOptions);
  readonly dir: string;
  readonly workspace: string;
  readonly capabilities: Capabilities;
  readonly callTimeoutMs: number;
  /** Available between start() and stop(). */
  registry: ToolRegistry | null;
  /** Available between start() and stop(). */
  store: ToolStore | null;
  readonly worker: ToolWorkerClient;
  /** Lock the dir, open the store, sync modules, start the worker. Idempotent. */
  start(): Promise<this>;
  /** Stop the worker, close the database, release the dir. Idempotent; start() reopens. */
  stop(): Promise<void>;
  /** Built-in tools plus every enabled generated tool. Throws `host_stopped` before start(). */
  tools(): ToolDefinition[];
  /** Run a tool the model chose. Rejects with `ToolError`. */
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Previous versions of a tool, newest first. */
  history(name: string): ToolVersion[];
  status(): HostStatus;
}

export function createToolHost(options: ToolHostOptions): Promise<ToolHost>;

export interface CreateToolInput {
  name: string;
  description: string;
  parameters: JsonSchema | string;
  executeSource: string;
}

export interface UpdateToolInput {
  name: string;
  description?: string;
  parameters?: JsonSchema | string;
  executeSource?: string;
  enabled?: boolean;
}

export class ToolRegistry {
  constructor(options: { store: ToolStore; modulesDir: string; maxSourceBytes?: number });
  readonly store: ToolStore;
  readonly modulesDir: string;
  maxSourceBytes: number;
  init(): Promise<void>;
  list(options?: { includeDisabled?: boolean; includeSource?: boolean }): Tool[];
  definitions(): ToolDefinition[];
  read(name: string, options?: { includeSource?: boolean }): Tool;
  history(name: string): ToolVersion[];
  create(input: CreateToolInput): Promise<Tool & { versionId: number }>;
  update(input: UpdateToolInput): Promise<Tool & { versionId: number }>;
  /** Make a previous version current again. Works for deleted tools. */
  restore(name: string, versionId: number): Promise<Tool & { versionId: number }>;
  delete(name: string): Promise<{ name: string; versionId: number }>;
}

export interface StoredToolInput {
  name: string;
  description: string;
  parameters: JsonSchema;
  executeSource: string;
  moduleSource: string;
  enabled: boolean;
}

export class ToolStore {
  constructor(dbPath: string);
  list(options?: { enabledOnly?: boolean; includeSource?: boolean }): Tool[];
  /** Exact-name lookup. */
  get(name: string, options?: { includeSource?: boolean }): Tool | null;
  /** The stored name that collides with `name` ignoring case, or null. */
  findCollision(name: string): string | null;
  save(tool: StoredToolInput, operation: "create" | "update" | "restore"): Tool & { versionId: number };
  remove(name: string): (Tool & { versionId: number }) | null;
  history(name: string, options?: { limit?: number }): ToolVersion[];
  getVersion(name: string, versionId: number): ToolVersion | null;
  close(): void;
}

export interface WorkerConfig {
  dbPath: string;
  modulesDir: string;
  workspace: string;
  capabilities?: Partial<Capabilities>;
  maxResultBytes?: number;
}

export interface ToolWorkerClientOptions {
  config: WorkerConfig;
  readyTimeoutMs?: number;
  killGraceMs?: number;
  /** How long restart() waits for in-flight calls before replacing the worker. Default 5000. */
  drainTimeoutMs?: number;
  /** Re-fork after an unexpected exit. Default true. */
  autoRestart?: boolean;
  /** Consecutive crashes before giving up and emitting "unhealthy". Default 5. */
  maxCrashRestarts?: number;
}

export interface ToolWorkerClientEvents {
  ready: [status: WorkerStatus];
  exit: [exit: WorkerExit];
  log: [entry: LogEntry];
  warning: [warning: { kind: "unhandledRejection" | "uncaughtException"; error: { message: string; code?: string; stack?: string } }];
  startup_error: [error: { message: string; code?: string; stack?: string }];
  restarting: [info: { attempt: number; delayMs: number }];
  unhealthy: [report: { crashes: number; lastExit: WorkerExit | null; error?: unknown }];
}

export class ToolWorkerClient extends EventEmitter<ToolWorkerClientEvents> {
  constructor(options: ToolWorkerClientOptions);
  readonly config: WorkerConfig;
  readyTimeoutMs: number;
  killGraceMs: number;
  drainTimeoutMs: number;
  autoRestart: boolean;
  maxCrashRestarts: number;
  status(): WorkerStatus;
  /** Serialised and coalesced; waits for in-flight calls to drain first. */
  restart(reason?: string): Promise<WorkerStatus>;
  stop(reason?: string): Promise<void>;
  /** Waits for any restart in progress, then runs the tool in the worker. */
  callTool(name: string, args: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
}

/** The five built-in tools the model uses to manage its own tools. */
export const coreTools: readonly ToolDefinition[];
/** Their names, reserved case-insensitively. */
export const RESERVED_NAMES: readonly string[];
/** Case-insensitive. */
export function isCoreTool(name: unknown): boolean;

export function toAnthropic(tools: ToolDefinition[]): Array<{ name: string; description: string; input_schema: JsonSchema }>;
export function toOpenAIResponses(tools: ToolDefinition[]): Array<{ type: "function"; name: string; description: string; parameters: JsonSchema }>;
export function toOpenAIChat(tools: ToolDefinition[]): Array<{ type: "function"; function: { name: string; description: string; parameters: JsonSchema } }>;

/** Unwrap a function/arrow/exported form to its body and prove the body cannot escape the function. */
export function unwrapExecuteSource(source: unknown): string;
export function buildModuleSource(tool: ToolDefinition & { executeSource: string }): string;
/** Throws unless the module has exactly the `definition` and `execute` exports. */
export function assertModuleSource(moduleSource: string): void;
export function normalizeToolSchema(input: unknown): JsonSchema;
export const TOOL_NAME_PATTERN: RegExp;
/** Throws `invalid_name` unless `name` matches TOOL_NAME_PATTERN exactly. */
export function assertToolName(name: unknown): string;
/** As `assertToolName`, and also rejects the built-in tool names. */
export function assertUserToolName(name: unknown): string;
/** Resolve a path inside `root` by real path; rejects lexical escapes, symlinks that lead out, and dangling symlinks. */
export function resolveInside(root: string, inputPath: unknown): Promise<string>;
