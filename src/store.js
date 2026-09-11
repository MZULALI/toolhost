import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ToolError } from "./errors.js";

/**
 * SQLite persistence for tools. Every save appends to `tool_versions`, so nothing a
 * model writes is ever lost; `tools` holds the current version of each name. History rows
 * keep what the model authored (description, schema, source); the assembled module is
 * derived, so it is stored only for the current version.
 *
 * Names are unique case-insensitively, because a name is also a file name and the file
 * system may not distinguish `Echo` from `echo`.
 *
 * Synchronous on purpose: `node:sqlite` is synchronous, calls are sub-millisecond, and it
 * keeps the registry free of interleaving bugs.
 */
export class ToolStore {
  /** @param {string} dbPath */
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS tools (
        name            TEXT PRIMARY KEY,
        description     TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        execute_source  TEXT NOT NULL,
        module_source   TEXT NOT NULL,
        enabled         INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_name_nocase ON tools(name COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS tool_versions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name       TEXT NOT NULL,
        operation       TEXT NOT NULL,
        description     TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        execute_source  TEXT NOT NULL,
        enabled         INTEGER NOT NULL,
        created_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tool_versions_name ON tool_versions(tool_name, id);
    `);
  }

  /** @param {{ enabledOnly?: boolean, includeSource?: boolean }} [options] */
  list({ enabledOnly = false, includeSource = false } = {}) {
    const sql = enabledOnly
      ? "SELECT * FROM tools WHERE enabled = 1 ORDER BY name"
      : "SELECT * FROM tools ORDER BY name";
    return this.db.prepare(sql).all().map((row) => toTool(row, includeSource));
  }

  /** Exact-name lookup. @param {string} name @param {{ includeSource?: boolean }} [options] */
  get(name, { includeSource = false } = {}) {
    const row = this.db.prepare("SELECT * FROM tools WHERE name = ?").get(name);
    return row ? toTool(row, includeSource) : null;
  }

  /**
   * The stored name that collides with `name` ignoring case, or null.
   * @param {string} name
   */
  findCollision(name) {
    const row = this.db.prepare("SELECT name FROM tools WHERE name = ? COLLATE NOCASE").get(name);
    return row ? row.name : null;
  }

  /**
   * Insert or replace the current version and append it to history.
   * @param {{ name: string, description: string, parameters: object, executeSource: string, moduleSource: string, enabled: boolean }} tool
   * @param {"create" | "update" | "restore"} operation
   */
  save(tool, operation) {
    const now = new Date().toISOString();
    const parametersJson = JSON.stringify(tool.parameters);
    const collision = this.findCollision(tool.name);
    if (collision && collision !== tool.name) {
      throw new ToolError("exists", `Tool "${collision}" already exists (names are case-insensitive).`);
    }
    if (collision) {
      this.db
        .prepare(
          `UPDATE tools SET description = ?, parameters_json = ?, execute_source = ?, module_source = ?, enabled = ?, updated_at = ?
           WHERE name = ?`
        )
        .run(tool.description, parametersJson, tool.executeSource, tool.moduleSource, tool.enabled ? 1 : 0, now, tool.name);
    } else {
      this.db
        .prepare(
          `INSERT INTO tools (name, description, parameters_json, execute_source, module_source, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(tool.name, tool.description, parametersJson, tool.executeSource, tool.moduleSource, tool.enabled ? 1 : 0, now, now);
    }
    const versionId = this.#appendVersion({ ...tool, parametersJson }, operation, now);
    return { ...this.get(tool.name), versionId };
  }

  /**
   * Delete the current version. The history row records the deletion and its content.
   * @param {string} name
   * @returns {(ReturnType<ToolStore["get"]> & { versionId: number }) | null} The tool as it was, or null.
   */
  remove(name) {
    const previous = this.get(name, { includeSource: true });
    if (!previous) return null;
    this.db.prepare("DELETE FROM tools WHERE name = ?").run(name);
    const versionId = this.#appendVersion(
      { ...previous, parametersJson: JSON.stringify(previous.parameters) },
      "delete",
      new Date().toISOString()
    );
    return { ...previous, versionId };
  }

  /** Newest first. @param {string} name @param {{ limit?: number }} [options] */
  history(name, { limit = 20 } = {}) {
    return this.db
      .prepare("SELECT * FROM tool_versions WHERE tool_name = ? ORDER BY id DESC LIMIT ?")
      .all(name, limit)
      .map(toVersion);
  }

  /** One history row, or null. @param {string} name @param {number} versionId */
  getVersion(name, versionId) {
    const row = this.db.prepare("SELECT * FROM tool_versions WHERE tool_name = ? AND id = ?").get(name, versionId);
    return row ? toVersion(row) : null;
  }

  close() {
    this.db.close();
  }

  #appendVersion(tool, operation, at) {
    const result = this.db
      .prepare(
        `INSERT INTO tool_versions (tool_name, operation, description, parameters_json, execute_source, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(tool.name, operation, tool.description, tool.parametersJson, tool.executeSource, tool.enabled ? 1 : 0, at);
    return Number(result.lastInsertRowid);
  }
}

function toTool(row, includeSource) {
  const tool = {
    name: row.name,
    description: row.description,
    parameters: JSON.parse(row.parameters_json),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (includeSource) {
    tool.executeSource = row.execute_source;
    tool.moduleSource = row.module_source;
  }
  return tool;
}

function toVersion(row) {
  return {
    id: row.id,
    operation: row.operation,
    description: row.description,
    parameters: JSON.parse(row.parameters_json),
    executeSource: row.execute_source,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at
  };
}
