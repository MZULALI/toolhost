import { ToolError } from "./errors.js";
import { removeModule, syncModules, writeModule } from "./files.js";
import { assertToolName } from "./names.js";
import { normalizeToolSchema } from "./schema.js";
import { assertModuleSource, buildModuleSource, unwrapExecuteSource } from "./source.js";
import { isCoreTool } from "./definitions.js";

/** Shorter than this and the model cannot tell when to call the tool. */
const MIN_DESCRIPTION_LENGTH = 12;

/**
 * Create, read, update and delete tools. Every write is validated before it touches the
 * store: name, schema, and source are each checked, and the assembled module is parsed.
 * Nothing here executes model-written code; that only happens in the worker.
 */
export class ToolRegistry {
  /** @param {{ store: import("./store.js").ToolStore, modulesDir: string }} options */
  constructor({ store, modulesDir }) {
    this.store = store;
    this.modulesDir = modulesDir;
  }

  /** Make the module directory match the store. Call once before the worker starts. */
  async init() {
    await syncModules(this.store, this.modulesDir);
  }

  /** @param {{ includeDisabled?: boolean, includeSource?: boolean }} [options] */
  list({ includeDisabled = true, includeSource = false } = {}) {
    return this.store.list({ enabledOnly: !includeDisabled, includeSource });
  }

  /** Enabled tools in the provider-neutral `{ name, description, parameters }` shape. */
  definitions() {
    return this.store
      .list({ enabledOnly: true })
      .map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  /** @param {string} name @param {{ includeSource?: boolean }} [options] */
  read(name, { includeSource = false } = {}) {
    const tool = this.store.get(assertName(name), { includeSource });
    if (!tool) throw new ToolError("not_found", `Tool "${name}" does not exist.`);
    return tool;
  }

  /** @param {string} name */
  history(name) {
    return this.store.history(assertName(name));
  }

  /**
   * @param {{ name: string, description: string, parameters: object | string, executeSource: string }} input
   */
  async create(input) {
    const name = assertName(input?.name);
    if (this.store.has(name)) {
      throw new ToolError("exists", `Tool "${name}" already exists. Use update_tool to change it.`);
    }
    const tool = assembleTool({
      name,
      description: input?.description,
      parameters: input?.parameters,
      executeSource: input?.executeSource,
      enabled: true
    });
    return this.#persist(tool, "create");
  }

  /**
   * Fields left undefined (or, for strings, empty) keep their current value.
   * @param {{ name: string, description?: string, parameters?: object | string, executeSource?: string, enabled?: boolean }} input
   */
  async update(input) {
    const name = assertName(input?.name);
    const current = this.store.get(name, { includeSource: true });
    if (!current) throw new ToolError("not_found", `Tool "${name}" does not exist. Use create_tool first.`);

    const tool = assembleTool({
      name,
      description: nonEmpty(input?.description) ?? current.description,
      parameters: nonEmpty(input?.parameters) ?? current.parameters,
      executeSource: nonEmpty(input?.executeSource) ?? current.executeSource,
      enabled: typeof input?.enabled === "boolean" ? input.enabled : current.enabled
    });
    return this.#persist(tool, "update");
  }

  /** @param {string} name */
  async delete(name) {
    const removed = this.store.remove(assertName(name));
    if (!removed) throw new ToolError("not_found", `Tool "${name}" does not exist.`);
    await removeModule(this.modulesDir, removed.name);
    return { name: removed.name };
  }

  /** Delete every tool. History is kept. */
  async reset() {
    const names = this.store.clear();
    await Promise.all(names.map((name) => removeModule(this.modulesDir, name)));
    return { deleted: names };
  }

  async #persist(tool, operation) {
    const saved = this.store.save(tool, operation);
    await writeModule(this.modulesDir, tool);
    return saved;
  }
}

function assertName(name) {
  const value = assertToolName(name);
  if (isCoreTool(value)) {
    throw new ToolError("invalid_name", `"${value}" is a built-in tool and cannot be created or changed.`);
  }
  return value;
}

function nonEmpty(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  return value;
}

function assembleTool({ name, description, parameters, executeSource, enabled }) {
  const cleanDescription = typeof description === "string" ? description.trim() : "";
  if (cleanDescription.length < MIN_DESCRIPTION_LENGTH) {
    throw new ToolError(
      "invalid_description",
      `description must be at least ${MIN_DESCRIPTION_LENGTH} characters so the model knows when to call the tool.`
    );
  }
  const schema = normalizeToolSchema(parameters);
  const body = unwrapExecuteSource(executeSource);
  const moduleSource = buildModuleSource({ name, description: cleanDescription, parameters: schema, executeSource: body });
  assertModuleSource(moduleSource);
  return { name, description: cleanDescription, parameters: schema, executeSource: body, moduleSource, enabled };
}
