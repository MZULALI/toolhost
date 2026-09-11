/** Public types. Everything here is re-exported from the package root. */

/** JSON Schema object describing a tool's arguments. */
export type JsonSchema = Record<string, unknown>;

/** Provider-neutral tool definition. Adapters turn this into each API's shape. */
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

/** A tool as returned by a write: the history row that write produced is `versionId`. */
export interface SavedTool extends Tool {
  versionId: number;
}

export type ToolOperation = "create" | "update" | "restore" | "delete";

/** One row of a tool's history. Deletions are recorded with the content that was deleted. */
export interface ToolVersion {
  id: number;
  operation: ToolOperation;
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

export interface LogEntry {
  stream: "stdout" | "stderr";
  text: string;
}

export interface SerializedError {
  message: string;
  code?: string;
  stack?: string;
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
  /** How long a tool change or stop() waits for in-flight calls. Default 5000. */
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

/** What the forked worker is told, via an environment variable. */
export interface WorkerConfig {
  /** toolhost's own directory; tools may not touch it even if it is inside the workspace. */
  dir: string;
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
  drainTimeoutMs?: number;
  autoRestart?: boolean;
  maxCrashRestarts?: number;
}

export interface ToolWorkerClientEvents {
  ready: [status: WorkerStatus];
  exit: [exit: WorkerExit];
  log: [entry: LogEntry];
  warning: [warning: { kind: "unhandledRejection" | "uncaughtException"; error: SerializedError }];
  startup_error: [error: SerializedError];
  restarting: [info: { attempt: number; delayMs: number }];
  unhealthy: [report: { crashes: number; lastExit: WorkerExit | null; error?: unknown }];
}

export interface ExecResult {
  ok: boolean;
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  message?: string;
}

export interface FetchJsonResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON, or the raw text when the body is not JSON. */
  body: unknown;
}

/** The `ctx` argument of a generated tool's `execute(args, ctx)`. */
export interface ToolContext {
  toolName: string;
  /** Real absolute path of the workspace. */
  workspace: string;
  callTool(name: string, args?: unknown): Promise<unknown>;
  readText(filePath: string): Promise<string>;
  writeText(filePath: string, content: unknown): Promise<{ path: string }>;
  appendText(filePath: string, content: unknown): Promise<{ path: string }>;
  listFiles(dirPath?: string): Promise<Array<{ name: string; type: "file" | "directory" }>>;
  fetchJson(url: string, init?: RequestInit & { timeoutMs?: number; maxBytes?: number }): Promise<FetchJsonResult>;
  exec(
    command: string,
    options?: { cwd?: string; timeoutMs?: number; maxBuffer?: number; env?: Record<string, string> }
  ): Promise<ExecResult>;
}

export type ToolErrorCode =
  | "invalid_name"
  | "invalid_description"
  | "invalid_schema"
  | "invalid_source"
  | "invalid_argument"
  | "invalid_path"
  | "exists"
  | "not_found"
  | "recursive_call"
  | "path_outside_workspace"
  | "workspace_unavailable"
  | "file_not_found"
  | "file_error"
  | "fetch_failed"
  | "fetch_timeout"
  | "fetch_too_large"
  | "capability_disabled"
  | "call_failed"
  | "unserializable_result"
  | "result_too_large"
  | "timeout"
  | "worker_unavailable"
  | "startup_failed"
  | "start_failed"
  | "host_stopped"
  | "dir_in_use"
  | "store_error"
  | "store_incompatible"
  | "internal_error"
  | (string & {});
