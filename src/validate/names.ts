import { ToolError } from "../errors.ts";

/** Letters, digits and underscores, starting with a letter. Doubles as a safe file name. */
export const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Names of the built-in tools. Reserved case-insensitively, matching the store's uniqueness rule. */
export const RESERVED_NAMES: readonly string[] = Object.freeze([
  "create_tool",
  "list_tools",
  "read_tool",
  "update_tool",
  "delete_tool"
]);
const reserved = new Set(RESERVED_NAMES);

export function isCoreTool(name: unknown): name is string {
  return typeof name === "string" && reserved.has(name.toLowerCase());
}

/**
 * Validate a name exactly as given. Nothing is trimmed or normalised: the model must call the
 * tool by the name it sent, so silently changing it would break the next call.
 */
export function assertToolName(name: unknown): string {
  if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
    throw new ToolError(
      "invalid_name",
      "Tool name must start with a letter and contain only letters, digits and underscores (max 64), with no surrounding whitespace.",
      { name }
    );
  }
  return name;
}

/** A valid name that is not one of the built-in tools. */
export function assertUserToolName(name: unknown): string {
  const value = assertToolName(name);
  if (isCoreTool(value)) {
    throw new ToolError("invalid_name", `"${value}" is a built-in tool and cannot be created or changed.`);
  }
  return value;
}
