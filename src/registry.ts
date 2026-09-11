import { ToolError } from "./errors.ts";
import { removeModule, syncModules, writeModule } from "./storage/files.ts";
import type { StoredToolInput, ToolStore } from "./storage/store.ts";
import type { JsonSchema, SavedTool, Tool, ToolDefinition, ToolOperation, ToolVersion } from "./types.ts";
import { assertUserToolName } from "./validate/names.ts";
import { normalizeToolSchema } from "./validate/schema.ts";
import { assertModuleSource, buildModuleSource, unwrapExecuteSource } from "./validate/source.ts";

/** Shorter than this and the model cannot tell when to call the tool. */
const MIN_DESCRIPTION_LENGTH = 12;
/** Larger than this and it is not a tool, it is a data file; every version is kept forever. */
export const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024;

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

export interface HistoryOptions {
  limit?: number;
  before?: number;
}

/**
 * Create, read, update, restore and delete tools. Every write is validated before it touches
 * the store: name, schema and source are each checked, and the assembled module is parsed.
 * Nothing here executes model-written code; that only happens in the worker.
 */
export class ToolRegistry {
  readonly store: ToolStore;
  readonly modulesDir: string;
  maxSourceBytes: number;

  constructor({ store, modulesDir, maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES }: { store: ToolStore; modulesDir: string; maxSourceBytes?: number }) {
    this.store = store;
    this.modulesDir = modulesDir;
    this.maxSourceBytes = maxSourceBytes;
  }

  /** Make the module directory match the store. Call once before the worker starts. */
  async init(): Promise<void> {
    await syncModules(this.store, this.modulesDir);
  }

  list({ includeDisabled = true, includeSource = false }: { includeDisabled?: boolean; includeSource?: boolean } = {}): Tool[] {
    return this.store.list({ enabledOnly: !includeDisabled, includeSource });
  }

  /** Enabled tools in the provider-neutral `{ name, description, parameters }` shape. */
  definitions(): ToolDefinition[] {
    return this.store.list({ enabledOnly: true }).map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  read(name: string, { includeSource = false }: { includeSource?: boolean } = {}): Tool {
    const tool = this.store.get(assertUserToolName(name), { includeSource });
    if (!tool) throw new ToolError("not_found", `Tool "${name}" does not exist.`);
    return tool;
  }

  /** Previous versions, newest first, including deletions. */
  history(name: string, options: HistoryOptions = {}): ToolVersion[] {
    return this.store.history(assertUserToolName(name), options);
  }

  historyCount(name: string): number {
    return this.store.historyCount(assertUserToolName(name));
  }

  async create(input: Partial<CreateToolInput> | null | undefined): Promise<SavedTool> {
    const name = assertUserToolName(input?.name);
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

  /** Fields left undefined (or, for strings, empty) keep their current value. */
  async update(input: Partial<UpdateToolInput> | null | undefined): Promise<SavedTool> {
    const name = assertUserToolName(input?.name);
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

  /** Make a previous version current again. Works for deleted tools too. */
  async restore(name: string, versionId: number): Promise<SavedTool> {
    const validName = assertUserToolName(name);
    const version = Number.isInteger(versionId) ? this.store.getVersion(validName, versionId) : null;
    if (!version) {
      throw new ToolError(
        "not_found",
        `Tool "${validName}" has no version ${versionId}. Use read_tool with include_history to list versions.`
      );
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

  async delete(name: string): Promise<{ name: string; versionId: number }> {
    const removed = this.store.remove(assertUserToolName(name));
    if (!removed) throw new ToolError("not_found", `Tool "${name}" does not exist.`);
    await removeModule(this.modulesDir, removed.name);
    return { name: removed.name, versionId: removed.versionId };
  }

  async #persist(tool: StoredToolInput, operation: Exclude<ToolOperation, "delete">): Promise<SavedTool> {
    const saved = this.store.save(tool, operation);
    await writeModule(this.modulesDir, tool);
    return saved;
  }

  #assemble({
    name,
    description,
    parameters,
    executeSource,
    enabled
  }: {
    name: string;
    description: unknown;
    parameters: unknown;
    executeSource: unknown;
    enabled: boolean;
  }): StoredToolInput {
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

function nonEmpty<T>(value: T | null | undefined): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  return value;
}
