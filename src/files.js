import fs from "node:fs/promises";
import path from "node:path";

/**
 * Module files on disk mirror the store. They exist so the worker can `import()` them and
 * so a human can open them; the store wins whenever the two disagree.
 */

/** @param {string} modulesDir @param {string} name */
export function modulePath(modulesDir, name) {
  return path.join(modulesDir, `${name}.mjs`);
}

/** @param {string} modulesDir @param {{ name: string, moduleSource: string }} tool */
export async function writeModule(modulesDir, tool) {
  await fs.mkdir(modulesDir, { recursive: true });
  const target = modulePath(modulesDir, tool.name);
  await fs.writeFile(target, tool.moduleSource, "utf8");
  return target;
}

/** @param {string} modulesDir @param {string} name */
export async function removeModule(modulesDir, name) {
  await fs.rm(modulePath(modulesDir, name), { force: true });
}

/**
 * Write every stored tool's module and delete any `.mjs` the store does not know about.
 * @param {import("./store.js").ToolStore} store
 * @param {string} modulesDir
 */
export async function syncModules(store, modulesDir) {
  await fs.mkdir(modulesDir, { recursive: true });
  const tools = store.list({ includeSource: true });
  const expected = new Set(tools.map((tool) => path.basename(modulePath(modulesDir, tool.name))));
  await Promise.all(tools.map((tool) => writeModule(modulesDir, tool)));

  const entries = await fs.readdir(modulesDir, { withFileTypes: true });
  const stale = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".mjs") && !expected.has(entry.name));
  await Promise.all(stale.map((entry) => fs.rm(path.join(modulesDir, entry.name), { force: true })));
}
