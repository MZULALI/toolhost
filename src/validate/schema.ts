import { ToolError, errorMessage } from "../errors.ts";
import type { JsonSchema } from "../types.ts";

/** Deeper than any real schema; stops cycles and stack overflows. */
const MAX_DEPTH = 64;

/**
 * Normalise a JSON Schema for tool parameters into the strict shape function-calling APIs
 * prefer: every object node gets `properties`, a `required` list that only names real
 * properties, and `additionalProperties: false`.
 *
 * @param input  A schema object or a JSON string containing one.
 */
export function normalizeToolSchema(input: unknown): JsonSchema {
  let schema: unknown = input;
  if (typeof schema === "string") {
    try {
      schema = JSON.parse(schema);
    } catch (error) {
      throw new ToolError("invalid_schema", `parameters is not valid JSON: ${errorMessage(error)}`);
    }
  }
  if (!isPlainObject(schema)) {
    throw new ToolError("invalid_schema", "parameters must be a JSON Schema object.");
  }
  assertBounded(schema);
  let cloned: JsonSchema;
  try {
    cloned = structuredClone(schema);
  } catch (error) {
    throw new ToolError("invalid_schema", `parameters must be plain JSON: ${errorMessage(error)}`);
  }
  if (!isObjectSchema(cloned)) {
    throw new ToolError("invalid_schema", 'The top-level parameters schema must have type "object".');
  }
  normalizeNode(cloned, 0, new Set());
  return cloned;
}

function isPlainObject(value: unknown): value is JsonSchema {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isObjectSchema(node: unknown): node is JsonSchema {
  if (!isPlainObject(node)) return false;
  if (node.type === "object") return true;
  return Array.isArray(node.type) && node.type.includes("object");
}

/**
 * Iterative three-colour DFS, so a hostile input cannot overflow the stack before it is
 * judged. A node on the current path (grey) is a cycle; a finished node (black) is a shared
 * subschema and is skipped, which keeps the walk linear.
 */
function assertBounded(root: object): void {
  const grey = new Set<object>();
  const black = new Set<object>();
  const stack: Array<{ node: unknown; depth: number; entered: boolean }> = [{ node: root, depth: 0, entered: false }];
  while (stack.length) {
    const frame = stack.at(-1)!;
    const { node, depth } = frame;
    if (!node || typeof node !== "object" || black.has(node)) {
      stack.pop();
      continue;
    }
    if (frame.entered) {
      grey.delete(node);
      black.add(node);
      stack.pop();
      continue;
    }
    if (grey.has(node)) throw new ToolError("invalid_schema", "parameters schema contains a cycle.");
    // Each schema level is two object levels (`properties` wrapper plus the property).
    if (depth > MAX_DEPTH * 2) {
      throw new ToolError("invalid_schema", `parameters schema is nested more than ${MAX_DEPTH} schema levels deep.`);
    }
    frame.entered = true;
    grey.add(node);
    for (const child of Object.values(node)) stack.push({ node: child, depth: depth + 1, entered: false });
  }
}

function normalizeNode(node: unknown, depth: number, done: Set<object>): void {
  if (!isPlainObject(node) || done.has(node)) return;
  done.add(node);
  if (depth > MAX_DEPTH) {
    throw new ToolError("invalid_schema", `parameters schema is nested more than ${MAX_DEPTH} schema levels deep.`);
  }

  if (isObjectSchema(node)) {
    if (!isPlainObject(node.properties)) node.properties = {};
    const properties = node.properties as JsonSchema;
    node.required = Array.isArray(node.required)
      ? node.required.filter((key) => typeof key === "string" && Object.hasOwn(properties, key))
      : [];
    node.additionalProperties = false;
    for (const child of Object.values(properties)) normalizeNode(child, depth + 1, done);
  }

  for (const key of ["items", "prefixItems", "anyOf", "oneOf", "allOf"]) {
    const value = node[key];
    if (Array.isArray(value)) value.forEach((child) => normalizeNode(child, depth + 1, done));
    else if (value) normalizeNode(value, depth + 1, done);
  }
}
