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

export interface ToolVersion {
  id: number;
  operation: "create" | "update" | "delete";
  description: string;
  parameters: JsonSchema;
  executeSource: string;
  enabled: boolean;
  createdAt: string;
}

/** What a tool may do from `ctx`. None of this is a sandbox. */
export interface Capabilities {
  /** `ctx.readText` / `writeText` / `appendText` / `listFiles`, confined to the workspace. Default true. */
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
  | "exists"
  | "not_found"
  | "recursive_call"
  | "path_outside_workspace"
  | "capability_disabled"
  | "call_failed"
  | "timeout"
  | "worker_unavailable"
  | "startup_failed"
  | (string & {});

export class ToolError extends Error {
  code: ToolErrorCode;
  details: Record<string, unknown>;
  constructor(code: ToolErrorCode, message: string, details?: Record<string, unknown>);
}

export interface ToolHostOptions {
  /** Directory for the SQLite database and generated module files. */
  dir: string;
  /** Root that `ctx` file helpers are confined to. Default `process.cwd()`. */
  workspace?: string;
  capabilities?: Partial<Capabilities>;
  /** Per-call timeout for generated tools. Default 30000. */
  callTimeoutMs?: number;
  /** How long to wait for the worker to load tools. Default 5000. */
  readyTimeoutMs?: number;
}

export interface WorkerStatus {
  pid: number | null;
  ready: boolean;
  tools: string[];
  restartCount: number;
  lastExit: { code: number | null; signal: string | null; reason: string; at: string } | null;
}

export class ToolHost {
  constructor(options: ToolHostOptions);
  readonly dir: string;
  readonly workspace: string;
  readonly capabilities: Capabilities;
  readonly registry: ToolRegistry;
  readonly store: ToolStore;
  readonly worker: ToolWorkerClient;
  start(): Promise<this>;
  stop(): Promise<void>;
  /** Built-in tools plus every enabled generated tool. */
  tools(): ToolDefinition[];
  isCoreTool(name: string): boolean;
  /** Run a tool the model chose. Rejects with `ToolError`. */
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
  status(): { dir: string; workspace: string; capabilities: Capabilities; worker: WorkerStatus };
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
  constructor(options: { store: ToolStore; modulesDir: string });
  init(): Promise<void>;
  list(options?: { includeDisabled?: boolean; includeSource?: boolean }): Tool[];
  definitions(): ToolDefinition[];
  read(name: string, options?: { includeSource?: boolean }): Tool;
  history(name: string): ToolVersion[];
  create(input: CreateToolInput): Promise<Tool>;
  update(input: UpdateToolInput): Promise<Tool>;
  delete(name: string): Promise<{ name: string }>;
  reset(): Promise<{ deleted: string[] }>;
}

export class ToolStore {
  constructor(dbPath: string);
  list(options?: { enabledOnly?: boolean; includeSource?: boolean }): Tool[];
  get(name: string, options?: { includeSource?: boolean }): Tool | null;
  has(name: string): boolean;
  save(tool: Omit<Tool, "createdAt" | "updatedAt"> & { executeSource: string; moduleSource: string }, operation: "create" | "update"): Tool;
  remove(name: string): Tool | null;
  clear(): string[];
  history(name: string, options?: { limit?: number }): ToolVersion[];
  close(): void;
}

export interface WorkerConfig {
  dbPath: string;
  modulesDir: string;
  workspace: string;
  capabilities?: Partial<Capabilities>;
}

export class ToolWorkerClient {
  constructor(options: { config: WorkerConfig; readyTimeoutMs?: number; killGraceMs?: number });
  status(): WorkerStatus;
  restart(reason?: string): Promise<WorkerStatus>;
  stop(reason?: string): Promise<void>;
  callTool(name: string, args: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  on(event: "ready", listener: (status: WorkerStatus) => void): this;
  on(event: "exit", listener: (exit: NonNullable<WorkerStatus["lastExit"]>) => void): this;
  on(event: "log", listener: (entry: { stream: "stdout" | "stderr"; text: string }) => void): this;
  once(event: "ready" | "exit" | "log", listener: (...args: any[]) => void): this;
  off(event: "ready" | "exit" | "log", listener: (...args: any[]) => void): this;
}

/** The five built-in tools the model uses to manage its own tools. */
export const coreTools: readonly ToolDefinition[];
export function isCoreTool(name: string): boolean;

export function toAnthropic(tools: ToolDefinition[]): Array<{ name: string; description: string; input_schema: JsonSchema }>;
export function toOpenAIResponses(tools: ToolDefinition[]): Array<{ type: "function"; name: string; description: string; parameters: JsonSchema }>;
export function toOpenAIChat(tools: ToolDefinition[]): Array<{ type: "function"; function: { name: string; description: string; parameters: JsonSchema } }>;

export function unwrapExecuteSource(source: unknown): string;
export function buildModuleSource(tool: ToolDefinition & { executeSource: string }): string;
export function normalizeToolSchema(input: unknown): JsonSchema;
