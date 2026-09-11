// Claude writes its own tools. Run: ANTHROPIC_API_KEY=... node examples/anthropic.ts "your question"
import Anthropic from "@anthropic-ai/sdk";
import { createToolHost, toAnthropic } from "toolhost";
import { DEFAULT_PROMPT, runToolCall } from "./_loop.ts";

const host = await createToolHost({ dir: ".toolhost", workspace: process.cwd() });
const client = new Anthropic();
const messages: Anthropic.MessageParam[] = [{ role: "user", content: process.argv[2] ?? DEFAULT_PROMPT }];

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

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const { text, isError } = await runToolCall(host, block.name, block.input as Record<string, unknown>);
      results.push({ type: "tool_result", tool_use_id: block.id, content: text, is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }
  const last = messages.at(-1)!.content;
  console.log(typeof last === "string" ? last : last.find((b) => b.type === "text")?.text);
} finally {
  await host.stop();
}
