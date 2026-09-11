import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolStore } from "./store.ts";

/**
 * Module files on disk mirror the store. They exist so the worker can `import()` them and
 * so a human can open them; the store wins whenever the two disagree.
 */

export function modulePath(modulesDir: string, name: string): string {
  return path.join(modulesDir, `${name}.mjs`);
}

/**
 * Write atomically (temp file + rename) so a worker starting mid-write never imports a
 * half-written module.
 */
export async function writeModule(modulesDir: string, tool: { name: string; moduleSource: string }): Promise<string> {
  await fs.mkdir(modulesDir, { recursive: true });
  const target = modulePath(modulesDir, tool.name);
  const temp = `${target}.${randomUUID()}.tmp`; // unique even for same-tool writes in one tick
  await fs.writeFile(temp, tool.moduleSource, "utf8");
  await fs.rename(temp, target);
  return target;
}

export async function removeModule(modulesDir: string, name: string): Promise<void> {
  await fs.rm(modulePath(modulesDir, name), { force: true });
}

/** Write every stored tool's module and delete any `.mjs` the store does not know about. */
export async function syncModules(store: ToolStore, modulesDir: string): Promise<void> {
  await fs.mkdir(modulesDir, { recursive: true });
  const tools = store.list({ includeSource: true });
  const expected = new Set(tools.map((tool) => path.basename(modulePath(modulesDir, tool.name))));
  await Promise.all(tools.map((tool) => writeModule(modulesDir, { name: tool.name, moduleSource: tool.moduleSource! })));

  const entries = await fs.readdir(modulesDir, { withFileTypes: true });
  const stale = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".mjs") && !expected.has(entry.name));
  await Promise.all(stale.map((entry) => fs.rm(path.join(modulesDir, entry.name), { force: true })));
}
