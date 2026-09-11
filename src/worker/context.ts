import { exec as execCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ToolError, errorCode, errorMessage } from "../errors.ts";
import type { Capabilities, ExecResult, FetchJsonResult, ToolContext } from "../types.ts";

const execAsync = promisify(execCallback);

/** Environment variables a shell needs to function. Nothing else reaches `ctx.exec`. */
const BASE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM"];

export interface ContextOptions {
  toolName: string;
  /** Real path of the workspace. */
  workspace: string;
  /** Directories inside the workspace that tools may not touch (toolhost's own `dir`). */
  denied?: string[];
  capabilities: Capabilities;
  maxResultBytes: number;
  callTool: (name: string, args: unknown, stack: string[]) => Promise<unknown>;
  stack?: string[];
}

/**
 * Build the `ctx` object handed to a tool's `execute(args, ctx)`.
 *
 * File helpers are confined to `workspace` by real path, so symlinks cannot lead out. `exec`
 * is off unless the host turned it on, and runs with a minimal environment. None of this is a
 * sandbox: a tool runs with the worker process's OS permissions and can do anything Node can.
 */
export function createContext({ toolName, workspace, denied = [], capabilities, maxResultBytes, callTool, stack = [] }: ContextOptions): ToolContext {
  const inside = (inputPath: unknown) => resolveInside(workspace, inputPath, { denied });
  const requireCapability = (name: keyof Capabilities, member: string) => {
    if (!capabilities[name]) {
      throw new ToolError("capability_disabled", `ctx.${member} is disabled by the host.`);
    }
  };

  return {
    toolName,
    workspace,

    async callTool(name, args = {}) {
      const chain = [...stack, toolName];
      if (chain.includes(name)) {
        throw new ToolError("recursive_call", `Recursive tool call blocked: ${[...chain, name].join(" -> ")}`);
      }
      return callTool(name, args, chain);
    },

    async readText(filePath) {
      requireCapability("files", "readText");
      return fileOp(filePath, async () => fs.readFile(await inside(filePath), "utf8"));
    },

    async writeText(filePath, content) {
      requireCapability("files", "writeText");
      return fileOp(filePath, async () => {
        const target = await inside(filePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, String(content), "utf8");
        return { path: path.relative(workspace, target) };
      });
    },

    async appendText(filePath, content) {
      requireCapability("files", "appendText");
      return fileOp(filePath, async () => {
        const target = await inside(filePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.appendFile(target, String(content), "utf8");
        return { path: path.relative(workspace, target) };
      });
    },

    async listFiles(dirPath = ".") {
      requireCapability("files", "listFiles");
      const entries = await fileOp(dirPath, async () => fs.readdir(await inside(dirPath), { withFileTypes: true }));
      return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? ("directory" as const) : ("file" as const) }));
    },

    /** `fetch` with a timeout, a response size cap, and errors the model can act on. */
    async fetchJson(url, { timeoutMs = 30_000, maxBytes = maxResultBytes, ...init } = {}): Promise<FetchJsonResult> {
      requireCapability("network", "fetchJson");
      if (init.signal !== undefined && init.signal !== null && !(init.signal instanceof AbortSignal)) {
        throw new ToolError("invalid_argument", "fetchJson: signal must be an AbortSignal.");
      }
      if (!(Number.isInteger(timeoutMs) && timeoutMs > 0) || !(Number.isInteger(maxBytes) && maxBytes > 0)) {
        throw new ToolError("invalid_argument", "fetchJson: timeoutMs and maxBytes must be positive integers.");
      }
      const signals = [AbortSignal.timeout(timeoutMs), init.signal].filter((s): s is AbortSignal => Boolean(s));
      let response: Response;
      try {
        response = await fetch(url, { ...init, signal: AbortSignal.any(signals) });
      } catch (error) {
        const cause = errorMessage((error as { cause?: unknown }).cause ?? error);
        const code = (error as Error).name === "TimeoutError" ? "fetch_timeout" : "fetch_failed";
        throw new ToolError(code, `fetchJson(${url}) failed: ${cause}`, { url });
      }
      const text = await readBody(response, url, maxBytes);
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON; hand back the text.
      }
      return {
        ok: response.ok,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body
      };
    },

    async exec(command, options = {}): Promise<ExecResult> {
      requireCapability("exec", "exec");
      if (typeof command !== "string" || !command.trim()) {
        throw new ToolError("invalid_argument", "ctx.exec requires a non-empty command string.");
      }
      const startedAt = Date.now();
      const env = {
        ...pick(process.env, BASE_ENV_KEYS),
        ...capabilities.execEnv,
        ...(options.env ?? {})
      };
      // Resolved outside the try: a confinement failure is thrown, like every other helper,
      // not returned as a failed command.
      const cwd = options.cwd ? await fileOp(options.cwd, () => inside(options.cwd)) : workspace;
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout: options.timeoutMs ?? 30_000,
          maxBuffer: options.maxBuffer ?? 1024 * 1024,
          shell: capabilities.shell,
          env
        });
        return { ok: true, code: 0, signal: null, stdout, stderr, durationMs: Date.now() - startedAt };
      } catch (error) {
        const failure = error as { code?: unknown; signal?: string | null; stdout?: string; stderr?: string; message: string };
        return {
          ok: false,
          code: typeof failure.code === "number" ? failure.code : null,
          signal: failure.signal ?? null,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
          message: failure.message,
          durationMs: Date.now() - startedAt
        };
      }
    }
  };
}

/**
 * Resolve `inputPath` against `root` and refuse anything that leaves it, following symlinks.
 * The check is on the real path of the deepest existing ancestor, so a symlink inside the
 * workspace that points outside is rejected whether or not its target exists.
 *
 * @param root  The workspace; may itself be a symlink.
 * @param options.denied  Directories inside the workspace that are off limits (toolhost's own `dir`).
 * @returns The real absolute path.
 */
export async function resolveInside(root: string, inputPath: unknown, { denied = [] }: { denied?: string[] } = {}): Promise<string> {
  if (typeof inputPath !== "string" || inputPath.includes("\0")) {
    throw new ToolError("invalid_path", "Path must be a string without NUL bytes.");
  }
  let rootReal: string;
  try {
    rootReal = await fs.realpath(root);
  } catch (error) {
    throw new ToolError("workspace_unavailable", `The workspace is no longer accessible (${errorCode(error) ?? "error"}).`);
  }
  const lexical = path.resolve(rootReal, inputPath);
  if (!isWithin(rootReal, lexical)) throw outside(inputPath);

  // Walk up to the deepest ancestor that exists, resolve its real path, and re-attach the rest.
  let existing = lexical;
  const missing: string[] = [];
  for (;;) {
    let real: string;
    try {
      real = await fs.realpath(existing);
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw fileError(inputPath, error);
      // A symlink whose target does not exist also fails realpath. It is not "a file that
      // does not exist yet": writing to it would create the target, wherever that is.
      if (await isSymlink(existing)) throw outside(inputPath);
      missing.unshift(path.basename(existing));
      const parent = path.dirname(existing);
      if (parent === existing) throw outside(inputPath);
      existing = parent;
      continue;
    }
    const resolved = path.join(real, ...missing);
    if (!isWithin(rootReal, resolved)) throw outside(inputPath);
    for (const dir of denied) {
      if (isWithin(dir, resolved)) {
        throw new ToolError("path_outside_workspace", `Path is inside toolhost's own directory and off limits: ${inputPath}`);
      }
    }
    return resolved;
  }
}

async function isSymlink(target: string): Promise<boolean> {
  try {
    return (await fs.lstat(target)).isSymbolicLink();
  } catch {
    return false;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function outside(inputPath: string): ToolError {
  return new ToolError("path_outside_workspace", `Path is outside the workspace: ${inputPath}`);
}

/** Map a raw fs failure to a ToolError that names the path the model used, not the host's. */
function fileError(inputPath: unknown, error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  const code = errorCode(error);
  if (code === "ENOENT") return new ToolError("file_not_found", `No such file or directory: ${inputPath}`);
  if (code === "EISDIR") return new ToolError("file_error", `Is a directory: ${inputPath}`);
  if (code === "ENOTDIR") return new ToolError("file_error", `Not a directory: ${inputPath}`);
  return new ToolError("file_error", `${code ?? "Error"} on ${inputPath}`);
}

async function fileOp<T>(inputPath: unknown, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw fileError(inputPath, error);
  }
}

/** Read a response body as text, stopping as soon as it exceeds `maxBytes`. */
async function readBody(response: Response, url: string, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.byteLength;
    if (received > maxBytes) {
      throw new ToolError("fetch_too_large", `fetchJson(${url}) response exceeded ${maxBytes} bytes. Request less or stream to a file.`, { url });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function pick(source: NodeJS.ProcessEnv, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
