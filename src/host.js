import path from "node:path";
import { coreTools, isCoreTool } from "./definitions.js";
import { ToolError } from "./errors.js";
import { ToolRegistry } from "./registry.js";
import { ToolStore } from "./store.js";
import { DEFAULT_CAPABILITIES } from "./worker/context.js";
import { ToolWorkerClient } from "./worker/client.js";

/**
 * The one object an application talks to.
 *
 * `tools()` gives the model its tool list. `call(name, args)` runs whatever it picked:
 * a built-in tool changes the registry and restarts the worker; anything else is executed
 * in the worker.
 */
export class ToolHost {
  /**
   * @param {{
   *   dir: string,
   *   workspace?: string,
   *   capabilities?: Partial<typeof DEFAULT_CAPABILITIES>,
   *   callTimeoutMs?: number,
   *   readyTimeoutMs?: number
   * }} options
   */
  constructor({ dir, workspace = process.cwd(), capabilities = {}, callTimeoutMs = 30_000, readyTimeoutMs }) {
    if (!dir) throw new ToolError("invalid_argument", "ToolHost requires a `dir` to store its database and modules.");
    this.dir = path.resolve(dir);
    this.workspace = path.resolve(workspace);
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...capabilities };
    this.callTimeoutMs = callTimeoutMs;

    const dbPath = path.join(this.dir, "tools.sqlite");
    const modulesDir = path.join(this.dir, "modules");
    this.store = new ToolStore(dbPath);
    this.registry = new ToolRegistry({ store: this.store, modulesDir });
    this.worker = new ToolWorkerClient({
      config: { dbPath, modulesDir, workspace: this.workspace, capabilities: this.capabilities },
      readyTimeoutMs
    });
  }

  /** Sync modules to disk and start the worker. */
  async start() {
    await this.registry.init();
    await this.worker.restart("start");
    return this;
  }

  /** Stop the worker and close the database. */
  async stop() {
    await this.worker.stop("stop");
    this.store.close();
  }

  /**
   * Built-in tools plus every enabled generated tool, as `{ name, description, parameters }`.
   * Pass through `toAnthropic` / `toOpenAIResponses` / `toOpenAIChat` for a provider's shape.
   */
  tools() {
    return [...coreTools, ...this.registry.definitions()];
  }

  /** @param {string} name */
  isCoreTool(name) {
    return isCoreTool(name);
  }

  /**
   * Run a tool the model chose. Throws `ToolError`; the message is written for the model.
   * @param {string} name @param {Record<string, unknown>} [args]
   */
  async call(name, args = {}) {
    if (isCoreTool(name)) return this.#callCore(name, args ?? {});
    return this.worker.callTool(name, args, { timeoutMs: this.callTimeoutMs });
  }

  status() {
    return { dir: this.dir, workspace: this.workspace, capabilities: this.capabilities, worker: this.worker.status() };
  }

  async #callCore(name, args) {
    switch (name) {
      case "create_tool": {
        const tool = await this.registry.create({
          name: args.name,
          description: args.description,
          parameters: args.parameters_json,
          executeSource: args.execute_source
        });
        await this.worker.restart(`create:${tool.name}`);
        return { ok: true, tool: publicTool(tool) };
      }
      case "update_tool": {
        const tool = await this.registry.update({
          name: args.name,
          description: args.description,
          parameters: args.parameters_json,
          executeSource: args.execute_source,
          enabled: args.enabled
        });
        await this.worker.restart(`update:${tool.name}`);
        return { ok: true, tool: publicTool(tool) };
      }
      case "delete_tool": {
        const deleted = await this.registry.delete(args.name);
        await this.worker.restart(`delete:${deleted.name}`);
        return { ok: true, deleted: deleted.name };
      }
      case "list_tools": {
        const tools = this.registry.list({ includeDisabled: Boolean(args.include_disabled) });
        return { ok: true, tools: tools.map(publicTool) };
      }
      case "read_tool": {
        const includeSource = Boolean(args.include_source);
        const tool = this.registry.read(args.name, { includeSource });
        return { ok: true, tool: publicTool(tool, includeSource) };
      }
      default:
        throw new ToolError("not_found", `Unknown built-in tool: ${name}`);
    }
  }
}

/** Shape returned to the model: never the assembled module, only what it authored. */
function publicTool(tool, includeSource = false) {
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

/**
 * Create and start a host in one call.
 * @param {ConstructorParameters<typeof ToolHost>[0]} options
 */
export async function createToolHost(options) {
  return new ToolHost(options).start();
}
