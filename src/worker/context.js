import { exec as execCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ToolError } from "../errors.js";

const execAsync = promisify(execCallback);

/** Environment variables a shell needs to function. Nothing else reaches `ctx.exec`. */
const BASE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM"];

/**
 * Build the `ctx` object handed to a tool's `execute(args, ctx)`.
 *
 * File helpers are confined to `workspace` by real path, so symlinks cannot lead out.
 * `exec` is off unless the host turned it on, and runs with a minimal environment. None of
 * this is a sandbox: a tool runs with the worker process's OS permissions and can do
 * anything Node can do.
 *
 * @param {{
 *   toolName: string,
 *   workspace: string,
 *   denied?: string[],
 *   capabilities: import("../capabilities.js").DEFAULT_CAPABILITIES,
 *   maxResultBytes: number,
 *   callTool: (name: string, args: unknown, stack: string[]) => Promise<unknown>,
 *   stack?: string[]
 * }} options
 */
export function createContext({ toolName, workspace, denied = [], capabilities, maxResultBytes, callTool, stack = [] }) {
  const inside = (inputPath) => resolveInside(workspace, inputPath, { denied });
  const requireCapability = (name, member) => {
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
      return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
    },

    /**
     * `fetch` with a timeout, a response size cap, and errors the model can act on.
     * @param {string} url
     * @param {RequestInit & { timeoutMs?: number, maxBytes?: number }} [init]
     */
    async fetchJson(url, { timeoutMs = 30_000, maxBytes = maxResultBytes, ...init } = {}) {
      requireCapability("network", "fetchJson");
      if (init.signal !== undefined && !(init.signal instanceof AbortSignal)) {
        throw new ToolError("invalid_argument", "fetchJson: signal must be an AbortSignal.");
      }
      if (!(Number.isInteger(timeoutMs) && timeoutMs > 0) || !(Number.isInteger(maxBytes) && maxBytes > 0)) {
        throw new ToolError("invalid_argument", "fetchJson: timeoutMs and maxBytes must be positive integers.");
      }
      const signals = [AbortSignal.timeout(timeoutMs), init.signal].filter(Boolean);
      let response;
      try {
        response = await fetch(url, { ...init, signal: AbortSignal.any(signals) });
      } catch (error) {
        const cause = error.cause?.message ?? error.message;
        const code = error.name === "TimeoutError" ? "fetch_timeout" : "fetch_failed";
        throw new ToolError(code, `fetchJson(${url}) failed: ${cause}`, { url });
      }
      const text = await readBody(response, url, maxBytes);
      let body = text;
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

    async exec(command, options = {}) {
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
        return {
          ok: false,
          code: typeof error.code === "number" ? error.code : null,
          signal: error.signal ?? null,
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? "",
          message: error.message,
          durationMs: Date.now() - startedAt
        };
      }
    }
  };
}

/**
 * Resolve `inputPath` against `root` and refuse anything that leaves it, following
 * symlinks. The check is on the real path of the deepest existing ancestor, so a symlink
 * inside the workspace that points outside is rejected whether or not its target exists.
 *
 * @param {string} root  The workspace; may itself be a symlink.
 * @param {unknown} inputPath
 * @param {{ denied?: string[] }} [options]  Directories inside the workspace that are off limits (toolhost's own `dir`).
 * @returns {Promise<string>} The real absolute path.
 */
export async function resolveInside(root, inputPath, { denied = [] } = {}) {
  if (typeof inputPath !== "string" || inputPath.includes("\0")) {
    throw new ToolError("invalid_path", "Path must be a string without NUL bytes.");
  }
  let rootReal;
  try {
    rootReal = await fs.realpath(root);
  } catch (error) {
    throw new ToolError("workspace_unavailable", `The workspace is no longer accessible (${error.code ?? "error"}).`);
  }
  const lexical = path.resolve(rootReal, inputPath);
  if (!isWithin(rootReal, lexical)) throw outside(inputPath);

  // Walk up to the deepest ancestor that exists, resolve its real path, and re-attach the rest.
  let existing = lexical;
  const missing = [];
  for (;;) {
    let real;
    try {
      real = await fs.realpath(existing);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw fileError(inputPath, error);
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

async function isSymlink(target) {
  try {
    return (await fs.lstat(target)).isSymbolicLink();
  } catch {
    return false;
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function outside(inputPath) {
  return new ToolError("path_outside_workspace", `Path is outside the workspace: ${inputPath}`);
}

/** Map a raw fs failure to a ToolError that names the path the model used, not the host's. */
function fileError(inputPath, error) {
  if (error instanceof ToolError) return error;
  if (error.code === "ENOENT") return new ToolError("file_not_found", `No such file or directory: ${inputPath}`);
  if (error.code === "EISDIR") return new ToolError("file_error", `Is a directory: ${inputPath}`);
  if (error.code === "ENOTDIR") return new ToolError("file_error", `Not a directory: ${inputPath}`);
  return new ToolError("file_error", `${error.code ?? "Error"} on ${inputPath}`);
}

async function fileOp(inputPath, run) {
  try {
    return await run();
  } catch (error) {
    throw fileError(inputPath, error);
  }
}

/** Read a response body as text, stopping as soon as it exceeds `maxBytes`. */
async function readBody(response, url, maxBytes) {
  if (!response.body) return "";
  const chunks = [];
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

function pick(source, keys) {
  const out = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}
