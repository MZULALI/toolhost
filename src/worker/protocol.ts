import type { SerializedError } from "../types.ts";

/**
 * Messages between the parent and the worker, over Node's IPC channel.
 *
 * worker -> parent:  { type: "ready", tools: string[] }
 *                    { type: "startup_error", error: SerializedError }
 *                    { type: "result", id, ok: true, resultJson: string }
 *                    { type: "result", id, ok: false, error: SerializedError }
 *                    { type: "warning", kind: string, error: SerializedError }
 * parent -> worker:  { type: "call", id, name, args }
 *
 * Results travel as a JSON string so the worker can measure and reject oversized or
 * unserialisable values before they cross the channel.
 */

export const READY = "ready";
export const STARTUP_ERROR = "startup_error";
export const CALL = "call";
export const RESULT = "result";
export const WARNING = "warning";

/** Name of the environment variable that carries the worker's JSON config. */
export const CONFIG_ENV = "TOOLHOST_WORKER_CONFIG";

export interface CallMessage {
  type: typeof CALL;
  id: string;
  name: string;
  args: unknown;
}

export type WorkerMessage =
  | { type: typeof READY; tools: string[] }
  | { type: typeof STARTUP_ERROR; error: SerializedError }
  | { type: typeof RESULT; id: string; ok: true; resultJson: string }
  | { type: typeof RESULT; id: string; ok: false; error: SerializedError }
  | { type: typeof WARNING; kind: "unhandledRejection" | "uncaughtException"; error: SerializedError };

export function serializeError(error: unknown): SerializedError {
  if (error && typeof error === "object") {
    const { message, code, stack } = error as { message?: unknown; code?: unknown; stack?: unknown };
    return {
      message: String(message ?? error),
      code: typeof code === "string" ? code : undefined,
      stack: typeof stack === "string" ? stack : undefined
    };
  }
  return { message: String(error) };
}

export function isCall(message: unknown): message is CallMessage {
  const m = message as Partial<CallMessage> | null;
  return Boolean(m) && typeof m === "object" && m!.type === CALL && typeof m!.id === "string" && typeof m!.name === "string";
}
