// No API key needed. Plays the model's part by hand to show the repair loop end to end:
// a broken tool is rejected with a line number, fixed, called, broken again by an update,
// then restored from history. docs/demo.svg is generated from this program's output.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createToolHost, ToolError, type ToolHost } from "toolhost";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolhost-example-"));
const host = await createToolHost({ dir, workspace: process.cwd() });
const schema = JSON.stringify({ type: "object", properties: { text: { type: "string" } }, required: ["text"] });

/** Print a call the way a transcript would show it, then its outcome. */
async function show(target: ToolHost, name: string, args: Record<string, unknown>, label: string) {
  console.log(`${name.padEnd(12)} ${label}`);
  try {
    const result = await target.call(name, args);
    console.log(`  -> ${format(result)}`);
    return result;
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    const [headline, ...rest] = error.message.split(": ");
    console.log(`  x ${error.code}: ${headline}`);
    if (rest.length) console.log(`    ${rest.join(": ")}`);
    return undefined;
  }
}

function format(value: unknown): string {
  const record = value as { tool?: { name: string }; history?: Array<{ version: number; operation: string }> } | null;
  if (record?.history) return `history: [ ${record.history.map((v) => `${v.operation} #${v.version}`).join(", ")} ]`;
  if (record?.tool) return `saved ${record.tool.name}, worker restarted`;
  return JSON.stringify(value);
}

try {
  console.log("$ node examples/offline.ts\n");

  // 1. A first attempt with a missing brace. The error names the line, as the model would see it.
  await show(host, "create_tool", {
    name: "word_count",
    description: "Count the words in a piece of text.",
    parameters_json: schema,
    execute_source: "const words = args.text.trim().split(/\\s+/);\nreturn { words: words.length"
  }, 'word_count   execute_source: "...return { words: words.length"');

  // 2. The corrected version is accepted and live immediately.
  console.log();
  await show(host, "create_tool", {
    name: "word_count",
    description: "Count the words in a piece of text.",
    parameters_json: schema,
    execute_source: "const words = args.text.trim().split(/\\s+/);\nreturn { words: words.length };"
  }, 'word_count   execute_source: "...return { words: words.length };"');
  await show(host, "word_count", { text: "one two three" }, '{ text: "one two three" }');

  // 3. A wrong-but-valid update goes live too, and is undone from history.
  console.log();
  await show(host, "update_tool", { name: "word_count", execute_source: "return { words: -1 };" }, 'word_count   execute_source: "return { words: -1 };"');
  await show(host, "word_count", { text: "one two three" }, '{ text: "one two three" }');
  const read = (await show(host, "read_tool", { name: "word_count", include_source: false, include_history: true }, "word_count   include_history: true")) as {
    history: Array<{ version: number; operation: string }>;
  };
  const original = read.history.find((v) => v.operation === "create")!;
  await show(host, "update_tool", { name: "word_count", restore_version: original.version }, `word_count   restore_version: ${original.version}`);
  await show(host, "word_count", { text: "one two three" }, '{ text: "one two three" }');
} finally {
  await host.stop();
  await fs.rm(dir, { recursive: true, force: true });
}
