import { exec as execCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ToolError } from "../errors.js";

const execAsync = promisify(execCallback);

/** Environment variables a shell needs to function. Nothing else leaks into `ctx.exec`. */
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
 * File helpers are confined to `workspace`. `exec` is off unless the host turned it on, and
 * runs with a minimal environment. None of this is a sandbox: a tool runs with the worker
 * process's OS permissions and can do anything Node can do.
 *
 * @param {{ toolName: string, workspace: string, capabilities: typeof DEFAULT_CAPABILITIES, callTool: (name: string, args: unknown, stack: string[]) => Promise<unknown>, stack?: string[] }} options
 */
export function createContext({ toolName, workspace, capabilities, callTool, stack = [] }) {
  const inside = (inputPath = ".") => resolveInside(workspace, inputPath);
  const requireCapability = (name) => {
    if (!capabilities[name]) {
      throw new ToolError("capability_disabled", `ctx.${name === "files" ? "readText/writeText" : name} is disabled by the host.`);
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
      requireCapability("files");
      return fs.readFile(inside(filePath), "utf8");
    },

    async writeText(filePath, content) {
      requireCapability("files");
      const target = inside(filePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, String(content), "utf8");
      return { path: path.relative(workspace, target) };
    },

    async appendText(filePath, content) {
      requireCapability("files");
      const target = inside(filePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.appendFile(target, String(content), "utf8");
      return { path: path.relative(workspace, target) };
    },

    async listFiles(dirPath = ".") {
      requireCapability("files");
      const entries = await fs.readdir(inside(dirPath), { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
    },

    async fetchJson(url, init = {}) {
      requireCapability("network");
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
      requireCapability("exec");
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
          cwd: options.cwd ? inside(options.cwd) : workspace,
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
 * Resolve `inputPath` against `root` and refuse anything that escapes it.
 * @param {string} root @param {string} inputPath
 */
export function resolveInside(root, inputPath) {
  const resolved = path.resolve(root, String(inputPath));
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ToolError("path_outside_workspace", `Path is outside the workspace: ${inputPath}`);
  }
  return resolved;
}

function pick(source, keys) {
  const out = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}
