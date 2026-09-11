import { ToolError } from "./errors.js";

/**
 * Normalise a JSON Schema for tool parameters into the strict shape function-calling
 * APIs prefer: every object node gets `properties`, a `required` list that only names
 * real properties, and `additionalProperties: false`.
 *
 * @param {unknown} input  A schema object or a JSON string containing one.
 * @returns {Record<string, unknown>}
 */
export function normalizeToolSchema(input) {
  let schema = input;
  if (typeof schema === "string") {
    try {
      schema = JSON.parse(schema);
    } catch (error) {
      throw new ToolError("invalid_schema", `parameters is not valid JSON: ${error.message}`);
    }
  }
  if (!isPlainObject(schema)) {
    throw new ToolError("invalid_schema", "parameters must be a JSON Schema object.");
  }
  assertBounded(schema);
  let cloned;
  try {
    cloned = structuredClone(schema);
  } catch (error) {
    throw new ToolError("invalid_schema", `parameters must be plain JSON: ${error.message}`);
  }
  if (!isObjectSchema(cloned)) {
    throw new ToolError("invalid_schema", 'The top-level parameters schema must have type "object".');
  }
  normalizeNode(cloned, 0);
  return cloned;
}

/** Deeper than any real schema; stops cycles and stack overflows. */
const MAX_DEPTH = 64;

/** Iterative walk, so a hostile input cannot overflow the stack before it is judged. */
function assertBounded(root) {
  const stack = [[root, 0]];
  const seen = new Set();
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (seen.has(node)) throw new ToolError("invalid_schema", "parameters schema contains a cycle.");
    if (depth > MAX_DEPTH) {
      throw new ToolError("invalid_schema", `parameters schema is nested more than ${MAX_DEPTH} levels deep.`);
    }
    seen.add(node);
    for (const child of Object.values(node)) stack.push([child, depth + 1]);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isObjectSchema(node) {
  if (!isPlainObject(node)) return false;
  if (node.type === "object") return true;
  return Array.isArray(node.type) && node.type.includes("object");
}

function normalizeNode(node, depth) {
  if (!isPlainObject(node)) return;
  if (depth > MAX_DEPTH) {
    throw new ToolError("invalid_schema", `parameters schema is nested more than ${MAX_DEPTH} levels deep (or contains a cycle).`);
  }

  if (isObjectSchema(node)) {
    if (!isPlainObject(node.properties)) node.properties = {};
    node.required = Array.isArray(node.required)
      ? node.required.filter((key) => Object.hasOwn(node.properties, key))
      : [];
    node.additionalProperties = false;
    for (const child of Object.values(node.properties)) normalizeNode(child, depth + 1);
  }

  for (const key of ["items", "prefixItems", "anyOf", "oneOf", "allOf"]) {
    const value = node[key];
    if (Array.isArray(value)) value.forEach((child) => normalizeNode(child, depth + 1));
    else if (value) normalizeNode(value, depth + 1);
  }
}
