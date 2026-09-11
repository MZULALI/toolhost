// A complete agent loop where Claude can write its own tools.
//
//   npm install @anthropic-ai/sdk
//   ANTHROPIC_API_KEY=... node examples/anthropic.mjs "What's the SHA-256 of the string 'toolhost'?"
//
// Claude has no hashing tool, so it writes one with create_tool, then calls it.
import Anthropic from "@anthropic-ai/sdk";
import { createToolHost, toAnthropic, ToolError } from "toolhost";

const host = await createToolHost({ dir: ".toolhost", workspace: process.cwd() });
const client = new Anthropic();
const messages = [{ role: "user", content: process.argv[2] ?? "What's the SHA-256 of the string 'toolhost'?" }];

try {
  for (;;) {
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 2048,
      tools: toAnthropic(host.tools()), // re-read every turn: the list grows as Claude creates tools
      messages
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") break;

    const results = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      try {
        const result = await host.call(block.name, block.input);
        results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
      } catch (error) {
        // Validation messages are written for the model: it reads them and fixes the tool.
        const message = error instanceof ToolError ? `${error.code}: ${error.message}` : String(error);
        results.push({ type: "tool_result", tool_use_id: block.id, content: message, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }

  const final = messages.at(-1).content.find((block) => block.type === "text");
  console.log(final?.text ?? "(no text)");
} finally {
  await host.stop();
}
