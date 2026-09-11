import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * SQLite persistence for tools. Every save appends to `tool_versions`, so nothing a
 * model writes is ever lost; `tools` holds the current version of each name.
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

      CREATE TABLE IF NOT EXISTS tool_versions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name       TEXT NOT NULL,
        operation       TEXT NOT NULL,
        description     TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        execute_source  TEXT NOT NULL,
        module_source   TEXT NOT NULL,
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

  /** @param {string} name @param {{ includeSource?: boolean }} [options] */
  get(name, { includeSource = false } = {}) {
    const row = this.db.prepare("SELECT * FROM tools WHERE name = ?").get(name);
    return row ? toTool(row, includeSource) : null;
  }

  /** @param {string} name */
  has(name) {
    return Boolean(this.db.prepare("SELECT 1 FROM tools WHERE name = ?").get(name));
  }

  /**
   * Insert or replace the current version and append it to history.
   * @param {{ name: string, description: string, parameters: object, executeSource: string, moduleSource: string, enabled: boolean }} tool
   * @param {"create" | "update"} operation
   */
  save(tool, operation) {
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT created_at FROM tools WHERE name = ?").get(tool.name);
    const parametersJson = JSON.stringify(tool.parameters);

    this.db
      .prepare(
        `INSERT INTO tools (name, description, parameters_json, execute_source, module_source, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           description = excluded.description,
           parameters_json = excluded.parameters_json,
           execute_source = excluded.execute_source,
           module_source = excluded.module_source,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`
      )
      .run(
        tool.name,
        tool.description,
        parametersJson,
        tool.executeSource,
        tool.moduleSource,
        tool.enabled ? 1 : 0,
        existing?.created_at ?? now,
        now
      );
    this.#appendVersion({ ...tool, parametersJson }, operation, now);
    return this.get(tool.name);
  }

  /**
   * Delete the current version. The history row records the deletion.
   * @param {string} name
   * @returns {ReturnType<ToolStore["get"]>} The tool as it was, or null if it did not exist.
   */
  remove(name) {
    const previous = this.get(name, { includeSource: true });
    if (!previous) return null;
    this.db.prepare("DELETE FROM tools WHERE name = ?").run(name);
    this.#appendVersion(
      { ...previous, parametersJson: JSON.stringify(previous.parameters) },
      "delete",
      new Date().toISOString()
    );
    return previous;
  }

  /** Delete every current tool. History is kept. @returns {string[]} names removed */
  clear() {
    const names = this.list().map((tool) => tool.name);
    for (const name of names) this.remove(name);
    return names;
  }

  /** @param {string} name @param {{ limit?: number }} [options] */
  history(name, { limit = 20 } = {}) {
    return this.db
      .prepare("SELECT * FROM tool_versions WHERE tool_name = ? ORDER BY id DESC LIMIT ?")
      .all(name, limit)
      .map((row) => ({
        id: row.id,
        operation: row.operation,
        description: row.description,
        parameters: JSON.parse(row.parameters_json),
        executeSource: row.execute_source,
        enabled: Boolean(row.enabled),
        createdAt: row.created_at
      }));
  }

  close() {
    this.db.close();
  }

  #appendVersion(tool, operation, at) {
    this.db
      .prepare(
        `INSERT INTO tool_versions (tool_name, operation, description, parameters_json, execute_source, module_source, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        tool.name,
        operation,
        tool.description,
        tool.parametersJson,
        tool.executeSource,
        tool.moduleSource,
        tool.enabled ? 1 : 0,
        at
      );
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
