import { exec as execCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ToolError } from "../errors.js";

const execAsync = promisify(execCallback);

/** Environment variables a shell needs to function. Nothing else reaches `ctx.exec`. */
const BASE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM"];

export const DEFAULT_CAPABILITIES = Object.freeze({
  files: true,
  network: true,
  exec: false,
  shell: "/bin/sh",
  execEnv: {}
});

/**
 * Build the `ctx` object handed to a tool's `execute(args, ctx)`.
 *
 * File helpers are confined to `workspace` by real path, so symlinks cannot lead out.
 * `exec` is off unless the host turned it on, and runs with a minimal environment. None of
 * this is a sandbox: a tool runs with the worker process's OS permissions and can do
 * anything Node can do.
 *
 * @param {{ toolName: string, workspace: string, capabilities: typeof DEFAULT_CAPABILITIES, callTool: (name: string, args: unknown, stack: string[]) => Promise<unknown>, stack?: string[] }} options
 */
export function createContext({ toolName, workspace, capabilities, callTool, stack = [] }) {
  const inside = (inputPath) => resolveInside(workspace, inputPath);
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
      const target = await inside(filePath);
      return fileOp(filePath, () => fs.readFile(target, "utf8"));
    },

    async writeText(filePath, content) {
      requireCapability("files", "writeText");
      const target = await inside(filePath);
      await fileOp(filePath, async () => {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, String(content), "utf8");
      });
      return { path: await relativeToWorkspace(workspace, target) };
    },

    async appendText(filePath, content) {
      requireCapability("files", "appendText");
      const target = await inside(filePath);
      await fileOp(filePath, async () => {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.appendFile(target, String(content), "utf8");
      });
      return { path: await relativeToWorkspace(workspace, target) };
    },

    async listFiles(dirPath = ".") {
      requireCapability("files", "listFiles");
      const target = await inside(dirPath);
      const entries = await fileOp(dirPath, () => fs.readdir(target, { withFileTypes: true }));
      return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
    },

    async fetchJson(url, init = {}) {
      requireCapability("network", "fetchJson");
      const response = await fetch(url, init);
      const text = await response.text();
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
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: options.cwd ? await inside(options.cwd) : workspace,
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
 * inside the workspace that points outside is rejected, whether the target exists yet or not.
 *
 * @param {string} root @param {unknown} inputPath
 * @returns {Promise<string>} The real absolute path.
 */
export async function resolveInside(root, inputPath) {
  if (typeof inputPath !== "string" || inputPath.includes("\0")) {
    throw new ToolError("invalid_path", "Path must be a string without NUL bytes.");
  }
  const rootReal = await fs.realpath(root);
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
      missing.unshift(path.basename(existing));
      const parent = path.dirname(existing);
      if (parent === existing) throw outside(inputPath);
      existing = parent;
      continue;
    }
    const resolved = path.join(real, ...missing);
    if (!isWithin(rootReal, resolved)) throw outside(inputPath);
    return resolved;
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

async function relativeToWorkspace(workspace, target) {
  return path.relative(await fs.realpath(workspace), target);
}

function pick(source, keys) {
  const out = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}
