// No API key needed. Plays the model's part by hand to show the repair loop end to end:
// a broken tool is rejected with a line number, fixed, called, then rolled back from history.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createToolHost, ToolError } from "toolhost";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolhost-example-"));
const host = await createToolHost({ dir, workspace: process.cwd() });
const schema = JSON.stringify({ type: "object", properties: { text: { type: "string" } }, required: ["text"] });

try {
  // 1. A first attempt with a syntax error. The error names the line, as the model would see it.
  try {
    await host.call("create_tool", {
      name: "word_count",
      description: "Count the words in a piece of text.",
      parameters_json: schema,
      execute_source: "const words = args.text.trim().split(/\\s+/);\nreturn { words: words.length"
    });
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    console.log(`rejected -> ${error.code}: ${error.message}`);
  }

  // 2. The corrected version is accepted and live immediately.
  await host.call("create_tool", {
    name: "word_count",
    description: "Count the words in a piece of text.",
    parameters_json: schema,
    execute_source: "const words = args.text.trim().split(/\\s+/);\nreturn { words: words.length };"
  });
  console.log("word_count ->", await host.call("word_count", { text: "one two three" }));

  // 3. A bad update is caught the same way; a wrong-but-valid update is undone from history.
  await host.call("update_tool", { name: "word_count", execute_source: "return { words: -1 };" });
  console.log("after bad update ->", await host.call("word_count", { text: "one two three" }));
  const read = (await host.call("read_tool", { name: "word_count", include_source: false, include_history: true })) as {
    history: Array<{ version: number; operation: string }>;
  };
  const original = read.history.find((v) => v.operation === "create")!;
  await host.call("update_tool", { name: "word_count", restore_version: original.version });
  console.log("after restore ->", await host.call("word_count", { text: "one two three" }));

  // 4. The tool list the model would see next turn.
  console.log("tools ->", host.tools().map((t) => t.name).join(", "));
} finally {
  await host.stop();
  await fs.rm(dir, { recursive: true, force: true });
}
