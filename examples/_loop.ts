// Shared by the provider examples: run a tool call the model asked for and turn the outcome
// into the string the model reads next. Validation messages are written for the model, so an
// error is fed back verbatim and it fixes the tool itself.
import { ToolError, type ToolHost } from "toolhost";

export async function runToolCall(host: ToolHost, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  try {
    return { text: JSON.stringify(await host.call(name, args)), isError: false };
  } catch (error) {
    const text = error instanceof ToolError ? `${error.code}: ${error.message}` : String(error);
    return { text, isError: true };
  }
}

export const DEFAULT_PROMPT = "What's the SHA-256 of the string 'toolhost'? If you have no hashing tool, make one.";
