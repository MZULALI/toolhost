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
  const cloned = structuredClone(schema);
  if (!isObjectSchema(cloned)) {
    throw new ToolError("invalid_schema", 'The top-level parameters schema must have type "object".');
  }
  normalizeNode(cloned);
  return cloned;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isObjectSchema(node) {
  if (!isPlainObject(node)) return false;
  if (node.type === "object") return true;
  return Array.isArray(node.type) && node.type.includes("object");
}

function normalizeNode(node) {
  if (!isPlainObject(node)) return;

  if (isObjectSchema(node)) {
    if (!isPlainObject(node.properties)) node.properties = {};
    node.required = Array.isArray(node.required)
      ? node.required.filter((key) => Object.hasOwn(node.properties, key))
      : [];
    node.additionalProperties = false;
    for (const child of Object.values(node.properties)) normalizeNode(child);
  }

  for (const key of ["items", "prefixItems", "anyOf", "oneOf", "allOf"]) {
    const value = node[key];
    if (Array.isArray(value)) value.forEach(normalizeNode);
    else if (value) normalizeNode(value);
  }
}
