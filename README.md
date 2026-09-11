# toolhost

Let an LLM write its own tools at runtime.

The model calls `create_tool` with a name, a JSON Schema, and a JavaScript function body. toolhost parses the source, proves it cannot escape its function, saves it to SQLite with full version history, writes it to disk as an ES module, and restarts an isolated worker process. On the model's next turn, the tool is in its tool list and callable.

```
model ──create_tool──▶ registry ──▶ SQLite (versioned) ──▶ modules/*.mjs
                                                              │
model ──my_tool───────▶ host ──IPC──▶ worker process ─import──┘
```

- **Any provider.** Tools are plain `{ name, description, parameters }`. Adapters give you the exact shape for Anthropic, OpenAI Responses, and OpenAI Chat Completions.
- **Real parser, not regex.** Model output is unwrapped and validated with [acorn](https://github.com/acornjs/acorn). Errors carry a line number and are worded for the model, so it fixes its own mistakes.
- **Nothing hangs.** A crashed or hung worker fails every in-flight call with a typed error. Tool changes restart the worker, so there is never a stale module in memory.
- **Nothing is lost.** Every create, update and delete is appended to a history table.
- **One dependency** (acorn), Node 22.13+, uses the built-in `node:sqlite`.

## Install

```sh
npm install toolhost
```

## Quickstart

```js
import { createToolHost, toAnthropic } from "toolhost";

const host = await createToolHost({ dir: ".toolhost", workspace: process.cwd() });

// 1. Give the model the tool list. It contains the five built-in tools plus anything it has made.
const tools = toAnthropic(host.tools());

// 2. When the model calls a tool, hand it to the host.
const result = await host.call("create_tool", {
  name: "word_count",
  description: "Count the words in a piece of text.",
  parameters_json: JSON.stringify({
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"]
  }),
  execute_source: "return { words: args.text.trim().split(/\\s+/).length };"
});

// 3. The new tool is live.
await host.call("word_count", { text: "one two three" }); // { words: 3 }

await host.stop();
```

A complete agent loop with the Anthropic SDK is in [`examples/anthropic.mjs`](examples/anthropic.mjs). It is 40 lines, and most of them are the SDK.

## What the model gets

Five built-in tools, exported as `coreTools`:

| Tool | What it does |
|---|---|
| `create_tool` | Save a new tool. Becomes callable after the worker restarts (about 100 ms). |
| `update_tool` | Change any field, or disable and re-enable. Omitted fields keep their value. |
| `delete_tool` | Remove a tool. History is kept. |
| `list_tools` | List generated tools. |
| `read_tool` | Read one tool's schema and, optionally, its source. |

The implementation the model writes is the body of `async function execute(args, ctx)`. If it sends the whole function, an exported one, or `const execute = async () => {}`, toolhost unwraps it. Inside, `ctx` offers:

| `ctx` member | Notes |
|---|---|
| `workspace` | Absolute path of the workspace root. |
| `readText`, `writeText`, `appendText`, `listFiles` | Confined to the workspace. Paths that resolve outside it throw `path_outside_workspace`. |
| `fetchJson(url, init)` | Returns `{ ok, status, headers, body }`. Body is parsed JSON, or text if it is not JSON. |
| `callTool(name, args)` | Call another generated tool. Cycles throw `recursive_call` naming the chain. |
| `exec(command, options)` | **Off by default.** Runs a shell with a minimal environment. See Security. |

## Security

**toolhost is not a sandbox.** Generated code runs in a child Node process with the same OS user, permissions, and network access as the parent. The worker gives you fault isolation: a tool that crashes, leaks memory, or spins forever cannot take your process down, and `restart()` puts everything back. It gives you nothing against a tool that decides to `import("node:fs")` and read your home directory.

What toolhost does do:

- `ctx.exec` is disabled unless you pass `capabilities: { exec: true }`. When enabled, the shell sees only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `TERM`, plus whatever you put in `capabilities.execEnv`. Your process's environment, including API keys, is not inherited.
- File helpers are confined to `workspace`. `..` and absolute paths outside it are rejected.
- Model-written source is parsed before it is saved. A body that tries to close the function early and add top-level code is rejected, so the module on disk has exactly two exports and runs no code at import time.
- Names are restricted to `[A-Za-z][A-Za-z0-9_]{0,63}`, so a name is always a safe filename.

If the model is talking to untrusted users, put the whole process in a container or VM. The `dir` and `workspace` you pass are the only paths it needs.

## API

### `createToolHost(options) → Promise<ToolHost>`

Creates a host and starts its worker. Options:

| Option | Default | Meaning |
|---|---|---|
| `dir` | required | Where the SQLite database and module files live. |
| `workspace` | `process.cwd()` | Root for `ctx` file helpers. |
| `capabilities` | `{ files: true, network: true, exec: false }` | What `ctx` allows. Also `shell` and `execEnv`. |
| `callTimeoutMs` | `30000` | Per-call timeout for generated tools. |
| `readyTimeoutMs` | `5000` | How long to wait for the worker to load. |

### `ToolHost`

- `tools()` returns built-in plus enabled generated tools in the neutral shape.
- `call(name, args)` runs a tool. Built-in tools update the registry and restart the worker. Rejects with `ToolError`.
- `status()` reports the worker's pid, readiness, tool names, restart count, and last exit.
- `stop()` kills the worker and closes the database.
- `registry`, `store`, `worker` are exposed for direct use.

### `ToolError`

Every failure is a `ToolError` with a stable `code` and a `message` written for the model. Codes: `invalid_name`, `invalid_description`, `invalid_schema`, `invalid_source`, `exists`, `not_found`, `recursive_call`, `path_outside_workspace`, `capability_disabled`, `call_failed`, `timeout`, `worker_unavailable`.

### Adapters

`toAnthropic(tools)`, `toOpenAIResponses(tools)`, `toOpenAIChat(tools)`. Pure functions over the neutral shape.

### Lower level

`ToolRegistry` (validation and CRUD), `ToolStore` (SQLite), `ToolWorkerClient` (process lifecycle and IPC), `unwrapExecuteSource`, `buildModuleSource`, `normalizeToolSchema`. Each is small and independently testable; see [`index.d.ts`](index.d.ts).

## How a tool change works

1. `registry.create` validates the name, normalises the schema (`additionalProperties: false`, `required` filtered to real properties), unwraps the source with acorn, assembles the module, and parses that too.
2. The store writes the current row and appends a history row in the same synchronous call.
3. The module file is written to `dir/modules/<name>.mjs`.
4. The worker is sent SIGTERM, then SIGKILL after one second, and a fresh one is forked. It syncs modules from the store, imports each enabled one, and sends `ready`.
5. Any call that was in flight when the old worker died has already been rejected with `worker_unavailable`.

## Development

```sh
npm test      # node --test, 23 tests, no network
npm run check # syntax check
```

## License

MIT
