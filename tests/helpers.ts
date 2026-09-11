import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** A fresh temp directory per test, removed afterwards. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolhost-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export const echoSchema = {
  type: "object",
  properties: { value: { type: "string", description: "Value to echo." } },
  required: ["value"]
};
