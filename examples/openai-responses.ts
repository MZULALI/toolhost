// OpenAI Responses API. Run: OPENAI_API_KEY=... node examples/openai-responses.ts "your question"
import OpenAI from "openai";
import { createToolHost, toOpenAIResponses } from "toolhost";
import { DEFAULT_PROMPT, runToolCall } from "./_loop.ts";

const host = await createToolHost({ dir: ".toolhost", workspace: process.cwd() });
const client = new OpenAI();
const input: OpenAI.Responses.ResponseInput = [{ role: "user", content: process.argv[2] ?? DEFAULT_PROMPT }];

try {
  for (;;) {
    const response = await client.responses.create({ model: "gpt-5", tools: toOpenAIResponses(host.tools()), input });
    input.push(...(response.output as OpenAI.Responses.ResponseInputItem[]));
    const calls = response.output.filter((item) => item.type === "function_call");
    if (calls.length === 0) break;

    for (const call of calls) {
      const { text } = await runToolCall(host, call.name, JSON.parse(call.arguments));
      input.push({ type: "function_call_output", call_id: call.call_id, output: text });
    }
  }
  console.log(input.findLast((item) => "role" in item && item.role === "assistant"));
} finally {
  await host.stop();
}
