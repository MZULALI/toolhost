import { ToolError } from "./errors.js";
import { removeModule, syncModules, writeModule } from "./files.js";
import { assertUserToolName } from "./names.js";
import { normalizeToolSchema } from "./schema.js";
import { assertModuleSource, buildModuleSource, unwrapExecuteSource } from "./source.js";

/** Shorter than this and the model cannot tell when to call the tool. */
const MIN_DESCRIPTION_LENGTH = 12;
/** Larger than this and it is not a tool, it is a data file; every version is kept forever. */
export const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024;

/**
 * Create, read, update, restore and delete tools. Every write is validated before it
 * touches the store: name, schema and source are each checked, and the assembled module
 * is parsed. Nothing here executes model-written code; that only happens in the worker.
 */
export class ToolRegistry {
  /** @param {{ store: import("./store.js").ToolStore, modulesDir: string, maxSourceBytes?: number }} options */
  constructor({ store, modulesDir, maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES }) {
    this.store = store;
    this.modulesDir = modulesDir;
    this.maxSourceBytes = maxSourceBytes;
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

  /**
   * Previous versions, newest first, including deletions.
   * @param {string} name @param {{ limit?: number, before?: number }} [options]
   */
  history(name, options = {}) {
    return this.store.history(assertName(name), options);
  }

  /** @param {string} name */
  historyCount(name) {
    return this.store.historyCount(assertName(name));
  }

  /**
   * @param {{ name: string, description: string, parameters: object | string, executeSource: string }} input
   */
  async create(input) {
    const name = assertName(input?.name);
    const collision = this.store.findCollision(name);
    if (collision) {
      const hint = collision === name ? "" : ` (names are case-insensitive; "${collision}" exists)`;
      throw new ToolError("exists", `Tool "${name}" already exists${hint}. Use update_tool to change it.`);
    }
    const tool = this.#assemble({
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

    const tool = this.#assemble({
      name,
      description: nonEmpty(input?.description) ?? current.description,
      parameters: nonEmpty(input?.parameters) ?? current.parameters,
      executeSource: nonEmpty(input?.executeSource) ?? current.executeSource,
      enabled: typeof input?.enabled === "boolean" ? input.enabled : current.enabled
    });
    return this.#persist(tool, "update");
  }

  /**
   * Make a previous version current again. Works for deleted tools too.
   * @param {string} name @param {number} versionId
   */
  async restore(name, versionId) {
    const validName = assertName(name);
    const version = Number.isInteger(versionId) ? this.store.getVersion(validName, versionId) : null;
    if (!version) {
      throw new ToolError("not_found", `Tool "${validName}" has no version ${versionId}. Use read_tool with include_history to list versions.`);
    }
    const tool = this.#assemble({
      name: validName,
      description: version.description,
      parameters: version.parameters,
      executeSource: version.executeSource,
      enabled: version.enabled
    });
    return this.#persist(tool, "restore");
  }

  /** @param {string} name */
  async delete(name) {
    const removed = this.store.remove(assertName(name));
    if (!removed) throw new ToolError("not_found", `Tool "${name}" does not exist.`);
    await removeModule(this.modulesDir, removed.name);
    return { name: removed.name, versionId: removed.versionId };
  }

  async #persist(tool, operation) {
    const saved = this.store.save(tool, operation);
    await writeModule(this.modulesDir, tool);
    return saved;
  }

  #assemble({ name, description, parameters, executeSource, enabled }) {
    const cleanDescription = typeof description === "string" ? description.trim() : "";
    if (cleanDescription.length < MIN_DESCRIPTION_LENGTH) {
      throw new ToolError(
        "invalid_description",
        `description must be at least ${MIN_DESCRIPTION_LENGTH} characters so the model knows when to call the tool.`
      );
    }
    const schema = normalizeToolSchema(parameters);
    const body = unwrapExecuteSource(executeSource);
    const bytes = Buffer.byteLength(body);
    if (bytes > this.maxSourceBytes) {
      throw new ToolError(
        "invalid_source",
        `execute_source is ${bytes} bytes; the limit is ${this.maxSourceBytes}. Keep data out of the tool and read it from a file instead.`
      );
    }
    const moduleSource = buildModuleSource({ name, description: cleanDescription, parameters: schema, executeSource: body });
    assertModuleSource(moduleSource);
    return { name, description: cleanDescription, parameters: schema, executeSource: body, moduleSource, enabled };
  }
}

const assertName = assertUserToolName;

function nonEmpty(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  return value;
}
