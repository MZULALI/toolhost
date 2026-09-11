/**
 * The five tools the model uses to manage its own tools, in a provider-neutral shape:
 * `{ name, description, parameters }` with `parameters` as JSON Schema.
 * Use `toAnthropic`, `toOpenAIResponses` or `toOpenAIChat` to get a provider's exact shape.
 */

function objectSchema(properties, required = Object.keys(properties)) {
  return { type: "object", properties, required, additionalProperties: false };
}

const CONTEXT_DOCS =
  "ctx provides: workspace (string), readText(path), writeText(path, text), appendText(path, text), " +
  "listFiles(dir), fetchJson(url, init), exec(command, { cwd, timeoutMs, env }) when the host enables it, " +
  "and callTool(name, args) to call another generated tool. " +
  "Return a plain JSON value (object, array, string, number, boolean or null); anything else is dropped or rejected.";

export const coreTools = Object.freeze([
  {
    name: "create_tool",
    description:
      "Create a new persistent tool. It is validated, saved, and becomes callable on your next turn. " +
      "The implementation is the body of `async function execute(args, ctx)`. " +
      CONTEXT_DOCS,
    parameters: objectSchema({
      name: {
        type: "string",
        description: "Start with a letter; letters, digits and underscores only. Names are case-insensitive."
      },
      description: {
        type: "string",
        description: "When to call the tool and what its result means."
      },
      parameters_json: {
        type: "string",
        description: "JSON Schema (as a string) for the tool's arguments. Must be an object schema."
      },
      execute_source: {
        type: "string",
        description:
          "JavaScript body of `async function execute(args, ctx)`. " +
          "If you include the outer function it is unwrapped. The source is stored exactly as sent."
      }
    })
  },
  {
    name: "list_tools",
    description: "List the persistent tools you have created, optionally including disabled ones.",
    parameters: objectSchema({
      include_disabled: {
        type: "boolean",
        description: "Include tools that are saved but not currently callable."
      }
    })
  },
  {
    name: "read_tool",
    description:
      "Read one tool's description, parameter schema, and optionally its source and version history. " +
      "Use the history to see what a tool looked like before a change broke it.",
    parameters: objectSchema(
      {
        name: { type: "string", description: "Tool name." },
        include_source: { type: "boolean", description: "Include execute_source." },
        include_history: { type: "boolean", description: "Include previous versions, newest first, with their source." }
      },
      ["name", "include_source"]
    )
  },
  {
    name: "update_tool",
    description:
      "Change an existing tool. Omit a field to keep its current value. " +
      "Use this to fix a tool that failed, extend it, disable and re-enable it, " +
      "or roll back with restore_version (a version id from read_tool's history).",
    parameters: objectSchema(
      {
        name: { type: "string", description: "Existing tool name." },
        description: { type: "string", description: "New description." },
        parameters_json: { type: "string", description: "New JSON Schema string." },
        execute_source: { type: "string", description: "New function body." },
        enabled: { type: "boolean", description: "Whether the tool is callable." },
        restore_version: {
          type: "integer",
          description: "Restore this version id from history. Other fields are ignored when set."
        }
      },
      ["name"]
    )
  },
  {
    name: "delete_tool",
    description: "Delete a tool. Its history is kept and it can be restored with update_tool.restore_version.",
    parameters: objectSchema({
      name: { type: "string", description: "Tool name." }
    })
  }
]);

const coreToolNames = new Set(coreTools.map((tool) => tool.name.toLowerCase()));

/** Case-insensitive, matching the store's uniqueness rule. @param {string} name */
export function isCoreTool(name) {
  return typeof name === "string" && coreToolNames.has(name.toLowerCase());
}

/** Anthropic Messages API: `{ name, description, input_schema }`. */
export function toAnthropic(tools) {
  return tools.map(({ name, description, parameters }) => ({ name, description, input_schema: parameters }));
}

/** OpenAI Responses API: `{ type: "function", name, description, parameters }`. */
export function toOpenAIResponses(tools) {
  return tools.map(({ name, description, parameters }) => ({ type: "function", name, description, parameters }));
}

/** OpenAI Chat Completions API: `{ type: "function", function: { name, description, parameters } }`. */
export function toOpenAIChat(tools) {
  return tools.map(({ name, description, parameters }) => ({
    type: "function",
    function: { name, description, parameters }
  }));
}
