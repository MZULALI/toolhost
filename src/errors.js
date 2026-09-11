/**
 * One error type for everything a caller can get wrong.
 *
 * `code` is stable and meant for programs; `message` is meant to be shown to the
 * model that made the mistake, so it says what to change.
 */
export class ToolError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}
