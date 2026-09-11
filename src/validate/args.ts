import type { JsonSchema } from "../types.ts";

/**
 * Check a tool's arguments against its (normalised) JSON Schema before the call reaches the
 * worker. Covers the subset models actually emit: type, enum, const, object properties with
 * required and additionalProperties, arrays with items and length bounds, string length and
 * pattern, numeric bounds, and anyOf/oneOf. Anything else in the schema is ignored, not
 * rejected.
 *
 * @returns Problems as sentences the model can act on, empty when the arguments are valid.
 */
export function validateArgs(schema: JsonSchema, value: unknown, path = "args"): string[] {
  const problems: string[] = [];
  check(schema, value, path, problems);
  return problems;
}

const MAX_PROBLEMS = 8;

function check(schema: unknown, value: unknown, path: string, problems: string[]): void {
  if (problems.length >= MAX_PROBLEMS || !isObject(schema)) return;

  if ("const" in schema && !sameJson(schema.const, value)) {
    problems.push(`${path} must be ${JSON.stringify(schema.const)}, got ${describe(value)}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameJson(option, value))) {
    problems.push(`${path} must be one of ${schema.enum.map((o) => JSON.stringify(o)).join(", ")}, got ${describe(value)}`);
    return;
  }

  const types = typeList(schema.type);
  if (types.length && !types.some((type) => hasType(type, value))) {
    problems.push(`${path} must be ${types.join(" or ")}, got ${describe(value)}`);
    return;
  }

  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const passing = branches.filter((branch) => validateArgs(branch as JsonSchema, value, path).length === 0).length;
    if (passing === 0 || (key === "oneOf" && passing > 1)) {
      problems.push(`${path} does not match ${key === "anyOf" ? "any" : "exactly one"} of the allowed shapes`);
      return;
    }
  }

  if (isObject(value)) checkObject(schema, value, path, problems);
  if (Array.isArray(value)) checkArray(schema, value, path, problems);
  if (typeof value === "string") checkString(schema, value, path, problems);
  if (typeof value === "number") checkNumber(schema, value, path, problems);
}

function checkObject(schema: JsonSchema, value: Record<string, unknown>, path: string, problems: string[]): void {
  const properties = isObject(schema.properties) ? schema.properties : {};
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key === "string" && !(key in value)) problems.push(`${path}.${key} is required`);
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) problems.push(`${path}.${key} is not a known property`);
    }
  }
  for (const [key, subschema] of Object.entries(properties)) {
    if (key in value) check(subschema, value[key], `${path}.${key}`, problems);
  }
}

function checkArray(schema: JsonSchema, value: unknown[], path: string, problems: string[]): void {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    problems.push(`${path} must have at least ${schema.minItems} items, got ${value.length}`);
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    problems.push(`${path} must have at most ${schema.maxItems} items, got ${value.length}`);
  }
  const tuple = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(schema.items) ? schema.items : null;
  value.forEach((item, index) => {
    const subschema = tuple ? tuple[index] : schema.items;
    if (subschema !== undefined) check(subschema, item, `${path}[${index}]`, problems);
  });
}

function checkString(schema: JsonSchema, value: string, path: string, problems: string[]): void {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    problems.push(`${path} must be at least ${schema.minLength} characters`);
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    problems.push(`${path} must be at most ${schema.maxLength} characters`);
  }
  if (typeof schema.pattern === "string") {
    try {
      if (!new RegExp(schema.pattern, "u").test(value)) problems.push(`${path} must match /${schema.pattern}/`);
    } catch {
      // An invalid pattern in the schema is the tool author's problem, not the caller's.
    }
  }
}

function checkNumber(schema: JsonSchema, value: number, path: string, problems: string[]): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) problems.push(`${path} must be >= ${schema.minimum}`);
  if (typeof schema.maximum === "number" && value > schema.maximum) problems.push(`${path} must be <= ${schema.maximum}`);
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
    problems.push(`${path} must be > ${schema.exclusiveMinimum}`);
  }
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
    problems.push(`${path} must be < ${schema.exclusiveMaximum}`);
  }
}

function typeList(type: unknown): string[] {
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string");
  return [];
}

function hasType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    default:
      return true; // unknown type keyword: do not reject
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return `a string (${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)})`;
  return `${typeof value} ${String(value)}`;
}
