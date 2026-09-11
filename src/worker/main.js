/**
 * Worker entry point. Forked by `ToolWorkerClient`; never run directly.
 *
 * Loads every enabled tool module from disk, announces readiness, then answers `call`
 * messages until it is killed. A tool change restarts the whole worker rather than
 * reloading a module, so there is never a stale module in memory.
 */
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { DEFAULT_CAPABILITIES } from "../capabilities.js";
import { modulePath, syncModules } from "../files.js";
import { CALL, CONFIG_ENV, READY, RESULT, STARTUP_ERROR, WARNING, isCall, serializeError } from "../protocol.js";
import { ToolStore } from "../store.js";
import { ToolError } from "../errors.js";
import { createContext } from "./context.js";

const config = JSON.parse(process.env[CONFIG_ENV] ?? "{}");
const capabilities = { ...DEFAULT_CAPABILITIES, ...(config.capabilities ?? {}) };
const maxResultBytes = config.maxResultBytes ?? 1_000_000;
/** Resolved once so `ctx.workspace` and the confinement check agree even when the workspace is a symlink. */
let workspace = config.workspace;
/** toolhost's own directory, real path. Tools may not read or write it even if it sits inside the workspace. */
let denied = [];

/** @type {Map<string, { execute: Function }>} */
const tools = new Map();

async function loadTools() {
  workspace = await fs.realpath(config.workspace);
  denied = [await fs.realpath(config.dir)];
  const store = new ToolStore(config.dbPath);
  try {
    await syncModules(store, config.modulesDir);
    for (const tool of store.list({ enabledOnly: true })) {
      const imported = await import(pathToFileURL(modulePath(config.modulesDir, tool.name)).href);
      if (typeof imported.execute !== "function") {
        throw new ToolError("invalid_source", `Tool "${tool.name}" does not export execute().`);
      }
      tools.set(tool.name, { execute: imported.execute });
    }
  } finally {
    store.close();
  }
}

async function runTool(name, args, stack = []) {
  const tool = tools.get(name);
  if (!tool) throw new ToolError("not_found", `Unknown tool: ${name}`);
  const ctx = createContext({ toolName: name, workspace, denied, capabilities, maxResultBytes, callTool: runTool, stack });
  return tool.execute(args ?? {}, ctx);
}

/** Serialise here so size and serialisability are checked before anything crosses IPC. */
function toResultJson(name, value) {
  let json;
  try {
    json = JSON.stringify(value === undefined ? null : value);
  } catch (error) {
    throw new ToolError("unserializable_result", `Tool "${name}" returned a value that cannot be JSON-serialised: ${error.message}`);
  }
  if (json === undefined) json = "null"; // a bare function or symbol
  const bytes = Buffer.byteLength(json);
  if (bytes > maxResultBytes) {
    throw new ToolError(
      "result_too_large",
      `Tool "${name}" returned ${bytes} bytes; the limit is ${maxResultBytes}. Return a summary or write the data to a file.`
    );
  }
  return json;
}

process.on("message", async (message) => {
  if (!message || typeof message !== "object" || message.type !== CALL) return;
  const id = typeof message.id === "string" ? message.id : null;
  if (!id) return; // nothing to reply to
  try {
    if (!isCall(message)) throw new ToolError("invalid_name", "Tool name must be a string.");
    const result = await runTool(message.name, message.args);
    process.send({ type: RESULT, id, ok: true, resultJson: toResultJson(message.name, result) });
  } catch (error) {
    process.send({ type: RESULT, id, ok: false, error: serializeError(error) });
  }
});

// A floating promise or a throw inside a timer is the most common bug in model-written
// code. Report it and stay up rather than taking every tool down with it.
process.on("unhandledRejection", (reason) => {
  process.send({ type: WARNING, kind: "unhandledRejection", error: serializeError(reason) });
});
process.on("uncaughtException", (error) => {
  process.send({ type: WARNING, kind: "uncaughtException", error: serializeError(error) });
});

// The parent closed the channel; there is nothing left to do.
process.on("disconnect", () => process.exit(0));

try {
  await loadTools();
  process.send({ type: READY, tools: [...tools.keys()] });
} catch (error) {
  process.send({ type: STARTUP_ERROR, error: serializeError(error) });
  process.exitCode = 1;
}
