/**
 * Worker entry point. Forked by `ToolWorkerClient`; never run directly.
 *
 * Loads every enabled tool module from disk, announces readiness, then answers `call`
 * messages until it is killed. A tool change restarts the whole worker rather than
 * reloading a module, so there is never a stale module in memory.
 */
import { pathToFileURL } from "node:url";
import { modulePath, syncModules } from "../files.js";
import { CONFIG_ENV, READY, RESULT, STARTUP_ERROR, isCall, serializeError } from "../protocol.js";
import { ToolStore } from "../store.js";
import { ToolError } from "../errors.js";
import { DEFAULT_CAPABILITIES, createContext } from "./context.js";

const config = JSON.parse(process.env[CONFIG_ENV] ?? "{}");
const capabilities = { ...DEFAULT_CAPABILITIES, ...(config.capabilities ?? {}) };

/** @type {Map<string, { execute: Function }>} */
const tools = new Map();

async function loadTools() {
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
  const ctx = createContext({ toolName: name, workspace: config.workspace, capabilities, callTool: runTool, stack });
  return tool.execute(args ?? {}, ctx);
}

process.on("message", async (message) => {
  if (!isCall(message)) return;
  try {
    const result = await runTool(message.name, message.args);
    process.send({ type: RESULT, id: message.id, ok: true, result });
  } catch (error) {
    process.send({ type: RESULT, id: message.id, ok: false, error: serializeError(error) });
  }
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
