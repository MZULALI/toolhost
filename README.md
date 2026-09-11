# toolhost

Let an LLM write its own tools at runtime.

The model calls `create_tool` with a name, a JSON Schema, and a JavaScript function body. toolhost parses the source, proves it cannot escape its function, saves it to SQLite with full version history, writes it to disk as an ES module, and restarts an isolated worker process. On the model's next turn the tool is in its list and callable.

```
model ──create_tool──▶ registry ──▶ SQLite (versioned) ──▶ modules/*.mjs
                                                              │
model ──my_tool───────▶ host ──IPC──▶ worker process ─import──┘
```

**What it is not:** a sandbox. Generated code runs with your OS user's permissions. The worker gives you fault isolation, not containment. See [Security](#security) before you deploy it anywhere untrusted.

- **Any provider.** Tools are plain `{ name, description, parameters }`. Adapters give the exact shape for Anthropic, OpenAI Responses, and OpenAI Chat Completions.
- **Real parser, not regex.** Model output is unwrapped and validated with [acorn](https://github.com/acornjs/acorn). Errors carry a line number and are worded for the model, so it fixes its own mistakes. Source is stored verbatim, never reformatted.
- **Nothing hangs, nothing bricks.** A hung tool times out. A crashed worker fails in-flight calls with a typed error and is re-forked with backoff. A floating promise in model code is reported, not fatal. Tool changes wait for running calls to finish before the worker is replaced.
- **Nothing is lost.** Every create, update and delete is appended to history. The model can read it and roll back, including a tool it deleted.
- **Every failure is a `ToolError`** with a stable code and a message written for the model. No raw stacks, no host paths.
- **One dependency** (acorn), Node 22.13+, built-in `node:sqlite`.

## Install

```sh
npm install toolhost
```

## Quickstart

```js
import { createToolHost, toAnthropic } from "toolhost";

const host = await createToolHost({ dir: ".toolhost", workspace: process.cwd() });

// 1. Give the model the tool list: five built-in tools plus anything it has made.
const tools = toAnthropic(host.tools());

// 2. When the model calls a tool, hand it to the host.
await host.call("create_tool", {
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

A complete agent loop with the Anthropic SDK is in [`examples/anthropic.mjs`](examples/anthropic.mjs). Most of it is the SDK.

## What the model gets

Five built-in tools, exported as `coreTools`:

| Tool | What it does |
|---|---|
| `create_tool` | Save a new tool. Callable after the worker restarts, about 30 ms. |
| `update_tool` | Change any field, disable and re-enable, or `restore_version` from history. Omitted fields keep their value. |
| `delete_tool` | Remove a tool. Returns the `restore_version` that undoes it. |
| `list_tools` | List generated tools. |
| `read_tool` | Read a tool's schema and, optionally, its source and version history. Works on deleted tools with `include_history`. |

The implementation the model writes is the body of `async function execute(args, ctx)`. If it sends the whole function, an exported one, or `const execute = async () => {}`, toolhost unwraps it. Inside, `ctx` offers:

| `ctx` member | Notes |
|---|---|
| `workspace` | Absolute path of the workspace root. |
| `readText`, `writeText`, `appendText`, `listFiles` | Confined to the workspace by real path, so symlinks cannot lead out. Errors name the path the model used, not the host's. |
| `fetchJson(url, init)` | Returns `{ ok, status, headers, body }`. Body is parsed JSON, or text if it is not JSON. 30 s timeout and a response cap of `maxResultBytes`, both overridable per call with `timeoutMs` and `maxBytes`. |
| `callTool(name, args)` | Call another generated tool. Cycles throw `recursive_call` naming the chain. |
| `exec(command, options)` | **Off by default.** Runs a shell with a minimal environment. See Security. |

Results must be JSON. Anything else is rejected with `unserializable_result`, and anything over `maxResultBytes` (1 MB) with `result_too_large`, both with a message telling the model what to do instead. Sources over `maxSourceBytes` (256 KB) are refused before they are stored.

A tool's `console.log` and any unhandled rejection inside it go to the `onLog` option. Nothing is printed unless you pass one.

## Security

**toolhost is not a sandbox.** Generated code runs in a child Node process with the same OS user, permissions, and network access as the parent. The worker gives you fault isolation: a tool that crashes, leaks memory, or spins forever cannot take your process down. It gives you nothing against a tool that decides to `import("node:fs")` and read your home directory, or to `import("node:child_process")` and run whatever it likes. If the model talks to untrusted users, put the whole process in a container or VM. The `dir` and `workspace` you pass are the only paths it needs.

What toolhost does do, and what it does not:

- `ctx.exec` is disabled unless you pass `capabilities: { exec: true }`. When enabled, the shell sees only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `TERM`, plus whatever you put in `capabilities.execEnv`. Your process's environment, including API keys, is not inherited. This limits accidents through the documented helper only; a tool can still spawn a process itself.
- File helpers resolve the real path of the deepest existing ancestor and reject anything outside `workspace`, so a symlink inside the workspace that points outside is refused for reads and writes. Again, this applies to the helpers, not to `node:fs`.
- Model-written source is parsed before it is saved. A body that closes the function early and adds top-level code is rejected, so the module on disk has exactly two exports and runs no code at import time.
- Names are restricted to `[A-Za-z][A-Za-z0-9_]{0,63}` and are unique ignoring case, so a name is always a safe, unambiguous file name.
- Arguments are **not** validated against the tool's schema. The provider does that; toolhost passes them through.
- One host per `dir`, enforced with a lock file. A second host on the same directory would advertise tools its own worker has not loaded.
- The worker runs in its own process group on Unix, so stopping or restarting it also kills processes a tool spawned. A tool that double-forks and detaches can still outlive it. On Windows only the worker itself is signalled.
- `fetchJson` has a timeout and a size cap; `exec` has a timeout and an output cap. A tool that opens its own sockets or spawns its own processes is bound by neither.

## API

### `createToolHost(options) → Promise<ToolHost>`

Creates a host and starts its worker. Options:

| Option | Default | Meaning |
|---|---|---|
| `dir` | required | Where the SQLite database, module files and lock live. One host per dir. |
| `workspace` | `process.cwd()` | Root for `ctx` file helpers. |
| `capabilities` | `{ files: true, network: true, exec: false }` | What `ctx` allows. Also `shell` and `execEnv`. |
| `callTimeoutMs` | `30000` | Per-call timeout for generated tools. |
| `readyTimeoutMs` | `5000` | How long to wait for the worker to load. |
| `killGraceMs` | `1000` | SIGTERM to SIGKILL escalation. |
| `drainTimeoutMs` | `5000` | How long a tool change waits for running calls before replacing the worker. |
| `autoRestart` | `true` | Re-fork the worker after an unexpected exit, with backoff. |
| `maxCrashRestarts` | `5` | Consecutive crashes before the worker emits `unhealthy` and stays down. |
| `maxResultBytes` | `1000000` | Largest result a tool may return; also the default `fetchJson` cap. |
| `maxSourceBytes` | `262144` | Largest `execute_source` accepted. |
| `onLog` | discard | Receives the worker's stdout, stderr, and warnings. |

### `ToolHost`

- `tools()` returns built-in plus enabled generated tools in the neutral shape.
- `call(name, args)` runs a tool. Built-in tools update the registry and restart the worker. If the restart fails the change is rolled back, so the tool list never advertises something the worker cannot run.
- `history(name)` returns previous versions, newest first.
- `status()` returns `{ open, dir, workspace, capabilities, worker }`, where `worker` has the pid, readiness, tool names, restart and crash counts, and last exit.
- `start()` and `stop()` are idempotent, and a stopped host can be started again.
- `registry`, `store`, `worker` are exposed for direct use.

### `ToolError`

Every failure is a `ToolError` with a stable `code` and a `message` written for the model. Codes:

| Code | When |
|---|---|
| `invalid_name`, `invalid_description`, `invalid_schema`, `invalid_source` | Validation. `invalid_source` carries `details.line` and `details.column`. |
| `exists`, `not_found` | Registry state. |
| `recursive_call`, `path_outside_workspace`, `file_not_found`, `file_error`, `invalid_path`, `fetch_failed`, `fetch_timeout`, `fetch_too_large`, `capability_disabled`, `invalid_argument` | Raised inside `ctx`. |
| `call_failed`, `unserializable_result`, `result_too_large`, `timeout` | The tool ran and something went wrong. `call_failed` wraps whatever the tool threw and carries `details.remoteStack`. |
| `worker_unavailable`, `startup_failed`, `host_stopped`, `dir_in_use` | Lifecycle. |
| `internal_error` | A bug in toolhost. Please report it. |

### Worker events

`host.worker` is an `EventEmitter`: `ready`, `exit`, `log`, `warning` (an unhandled rejection or uncaught exception inside a tool), `restarting` (after a crash, with the backoff delay), `unhealthy` (after `maxCrashRestarts` consecutive crashes; call `restart()` to try again).

### Adapters

`toAnthropic(tools)`, `toOpenAIResponses(tools)`, `toOpenAIChat(tools)`. Pure functions over the neutral shape.

### Lower level

`ToolRegistry` (validation and CRUD), `ToolStore` (SQLite), `ToolWorkerClient` (process lifecycle and IPC), `unwrapExecuteSource`, `assertModuleSource`, `normalizeToolSchema`, `assertToolName`, `resolveInside`. Each is small and independently tested; see [`index.d.ts`](index.d.ts), which is typechecked in CI against a consumer that uses every export.

## How a tool change works

1. `registry.create` validates the name, normalises the schema (`additionalProperties: false`, `required` filtered to real properties), unwraps the source with acorn, assembles the module, and parses that too.
2. The store writes the current row and appends a history row.
3. The module file is written atomically to `dir/modules/<name>.mjs`.
4. The worker client waits for in-flight calls to drain, sends SIGTERM (SIGKILL after `killGraceMs`), forks a fresh worker, and waits for `ready`. Concurrent changes share one restart; calls that arrive during it wait rather than fail.
5. If the worker cannot start, the change is rolled back and the model is told why.

## Development

```sh
npm test          # node --test, 49 tests, loopback only, a few seconds
npm run check     # syntax check
npm run typecheck # tsc --strict over a consumer of every export
```

## License

MIT
