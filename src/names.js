import { ToolError } from "./errors.js";

/** Letters, digits and underscores, starting with a letter. Doubles as a safe file name. */
export const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * @param {unknown} name
 * @returns {string}
 */
export function assertToolName(name) {
  const value = typeof name === "string" ? name.trim() : "";
  if (!TOOL_NAME_PATTERN.test(value)) {
    throw new ToolError(
      "invalid_name",
      "Tool name must start with a letter and contain only letters, digits and underscores (max 64).",
      { name }
    );
  }
  return value;
}
