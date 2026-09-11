// OpenAI Chat Completions API. Run: OPENAI_API_KEY=... node examples/openai-chat.ts "your question"
import OpenAI from "openai";
import { createToolHost, toOpenAIChat } from "toolhost";
import { DEFAULT_PROMPT, runToolCall } from "./_loop.ts";

const host = await createToolHost({ dir: ".toolhost", workspace: process.cwd() });
const client = new OpenAI();
const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "user", content: process.argv[2] ?? DEFAULT_PROMPT }];

try {
  for (;;) {
    const completion = await client.chat.completions.create({ model: "gpt-5", tools: toOpenAIChat(host.tools()), messages });
    const message = completion.choices[0]!.message;
    messages.push(message);
    if (!message.tool_calls?.length) break;

    for (const call of message.tool_calls) {
      if (call.type !== "function") continue;
      const { text } = await runToolCall(host, call.function.name, JSON.parse(call.function.arguments));
      messages.push({ role: "tool", tool_call_id: call.id, content: text });
    }
  }
  console.log(messages.at(-1)!.content);
} finally {
  await host.stop();
}
