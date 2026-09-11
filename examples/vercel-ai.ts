// Vercel AI SDK. Run: OPENAI_API_KEY=... node examples/vercel-ai.ts "your question"
//
// The AI SDK wants a tool map with an `execute` per tool, fixed for the whole call. Tools the
// model creates must be callable on the next step, so run one step per generateText call and
// rebuild the map from host.tools() in between.
import { openai } from "@ai-sdk/openai";
import { generateText, jsonSchema, tool, type ModelMessage } from "ai";
import { createToolHost } from "toolhost";
import { DEFAULT_PROMPT, runToolCall } from "./_loop.ts";

const host = await createToolHost({ dir: ".toolhost", workspace: process.cwd() });

function currentTools() {
  return Object.fromEntries(
    host.tools().map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema<Record<string, unknown>>(definition.parameters),
        execute: async (args) => (await runToolCall(host, definition.name, args)).text
      })
    ])
  );
}

const messages: ModelMessage[] = [{ role: "user", content: process.argv[2] ?? DEFAULT_PROMPT }];

try {
  for (let step = 0; step < 10; step += 1) {
    const result = await generateText({ model: openai("gpt-5"), messages, tools: currentTools() });
    messages.push(...result.response.messages);
    if (result.finishReason !== "tool-calls") {
      console.log(result.text);
      break;
    }
  }
} finally {
  await host.stop();
}
