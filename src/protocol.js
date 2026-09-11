/**
 * Messages between the parent and the worker, over Node's IPC channel.
 *
 * worker -> parent:  { type: "ready", tools: string[] }
 *                    { type: "startup_error", error: SerializedError }
 *                    { type: "result", id, ok: true, result }
 *                    { type: "result", id, ok: false, error: SerializedError }
 * parent -> worker:  { type: "call", id, name, args }
 */

export const READY = "ready";
export const STARTUP_ERROR = "startup_error";
export const CALL = "call";
export const RESULT = "result";

/** Name of the environment variable that carries the worker's JSON config. */
export const CONFIG_ENV = "TOOLHOST_WORKER_CONFIG";

/** @param {unknown} error */
export function serializeError(error) {
  if (error && typeof error === "object") {
    return {
      message: String(error.message ?? error),
      code: typeof error.code === "string" ? error.code : undefined,
      stack: typeof error.stack === "string" ? error.stack : undefined
    };
  }
  return { message: String(error) };
}

/** @param {unknown} message */
export function isCall(message) {
  return (
    Boolean(message) &&
    typeof message === "object" &&
    message.type === CALL &&
    typeof message.id === "string" &&
    typeof message.name === "string"
  );
}
