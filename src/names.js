import { ToolError } from "./errors.js";

/** Letters, digits and underscores, starting with a letter. Doubles as a safe file name. */
export const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Validate a name exactly as given. Nothing is trimmed or normalised: the model must call
 * the tool by the name it sent, so silently changing it would break the next call.
 * @param {unknown} name
 * @returns {string}
 */
export function assertToolName(name) {
  if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
    throw new ToolError(
      "invalid_name",
      "Tool name must start with a letter and contain only letters, digits and underscores (max 64), with no surrounding whitespace.",
      { name }
    );
  }
  return name;
}
