import type { ToolErrorCode } from "./types.ts";

/**
 * One error type for everything a caller can get wrong.
 *
 * `code` is stable and meant for programs; `message` is meant to be shown to the model that
 * made the mistake, so it says what to change.
 */
export class ToolError extends Error {
  override readonly name = "ToolError";
  readonly code: ToolErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ToolErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Narrow an unknown catch value to something with a string `code`. */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(error);
}
