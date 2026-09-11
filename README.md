# toolhost

[![ci](https://github.com/MZULALI/toolhost/actions/workflows/ci.yml/badge.svg)](https://github.com/MZULALI/toolhost/actions/workflows/ci.yml)

Let an LLM write its own tools at runtime.

The model calls `create_tool` with a name, a JSON Schema, and a function body. toolhost parses the source, proves the body adds no top-level code, saves it to SQLite with full history, and restarts an isolated worker. On the next turn the tool is in the model's list and callable.

```
model ──create_tool──▶ registry ──▶ SQLite (versioned) ──▶ modules/*.mjs
                                                              │
model ──my_tool───────▶ host ──IPC──▶ worker process ─import──┘
```

**Not a sandbox.** Generated code runs with your OS user's permissions. The worker isolates faults, not intent. Read [Security](#security) before deploying anywhere untrusted.

- **Any provider.** Tools are `{ name, description, parameters }`. Adapters give the exact shape for Anthropic, OpenAI Responses, OpenAI Chat, and the Vercel AI SDK. [Examples](examples/) for each.
- **Real parser.** Model output is unwrapped and checked with [acorn](https://github.com/acornjs/acorn). Errors carry a line number and are worded for the model, so it fixes its own mistakes. Source is stored verbatim.
- **Nothing hangs, nothing bricks.** Hung tools time out. A crashed worker fails in-flight calls with a typed error and is re-forked with backoff. A floating promise in model code is reported, not fatal. Tool changes wait for running calls to finish.
- **Nothing is lost.** Every change is appended to history. The model can read it, page through it, and roll back, including a tool it deleted.
- **Every failure is a `ToolError`** with a stable code. A tool cannot forge codes or leak host paths.
- TypeScript, one dependency (acorn), Node 22.18+ with the built-in `node:sqlite`.

## Install

```sh
npm install github:MZULALI/toolhost
```

Builds from source on install. Needs Node 22.18 or newer.

## Quickstart

```ts
import { createToolHost, toAnthropic } from "toolhost";

const host = await createToolHost({ dir: ".toolhost", workspace: process.cwd() });

// 1. The model's tool list: five built-in tools plus anything it has made.
const tools = toAnthropic(host.tools());

// 2. Route every tool call the model makes to the host.
await host.call("create_tool", {
  name: "word_count",
  description: "Count the words in a piece of text.",
  parameters_json: JSON.stringify({ type: "object", properties: { text: { type: "string" } }, required: ["text"] }),
  execute_source: "return { words: args.text.trim().split(/\\s+/).length };"
});

// 3. The new tool is live.
await host.call("word_count", { text: "one two three" }); // { words: 3 }

await host.stop();
```

| Example | |
|---|---|
| [`offline.ts`](examples/offline.ts) | No API key. A broken tool is rejected with a line number, fixed, called, then rolled back from history. |
| [`anthropic.ts`](examples/anthropic.ts) | Claude via the Messages API. |
| [`openai-responses.ts`](examples/openai-responses.ts), [`openai-chat.ts`](examples/openai-chat.ts) | Both OpenAI APIs. |
| [`vercel-ai.ts`](examples/vercel-ai.ts) | Vercel AI SDK, one step per call so new tools are picked up. |

Run any of them with `node examples/<name>.ts` after `npm run build`.

## What the model gets

| Built-in tool | |
|---|---|
| `create_tool` | Save a new tool. Callable once the worker has restarted. |
| `update_tool` | Change any field, disable, re-enable, or `restore_version` from history. |
| `delete_tool` | Remove a tool. Returns the `restore_version` that undoes it. |
| `list_tools` | List generated tools. |
| `read_tool` | Schema, optional source, optional paged history. Works on deleted tools. |

The implementation is the body of `async function execute(args, ctx)`. A whole function, an exported one, or an arrow assigned to `execute` is unwrapped. `ctx` offers `readText`, `writeText`, `appendText`, `listFiles` (confined to the workspace), `fetchJson` (timeout and size cap), `callTool` (cycles rejected), and `exec` (off by default). Results must be JSON and under `maxResultBytes`.

## Security

Generated code runs in a child Node process with the same user, permissions, and network as the parent. A tool can `import("node:fs")` and read your home directory. If the model talks to untrusted users, run the whole process in a container or VM.

What the `ctx` helpers do enforce, and only for themselves:

- `exec` is disabled unless you pass `capabilities: { exec: true }`, and then sees only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `TERM` plus `capabilities.execEnv`. Your process's environment, including API keys, is not inherited.
- File helpers resolve real paths and refuse anything outside `workspace`, including symlinks that lead out, dangling symlinks, and toolhost's own `dir`.
- Source is parsed before it is saved; a body that closes its function early is rejected, so the module on disk runs no code at import time.
- The worker is its own process group, so stopping it also stops what a tool spawned. A double-forked daemon can still outlive it.
- Arguments are **not** validated against the tool's schema. Providers enforce schemas loosely at best (the OpenAI adapter sets `strict: false` because generated schemas may have optional fields), so a tool must check its own `args`.
- `call_failed` errors carry the worker's stack in `details.remoteStack`, with file paths. Feed the model `code` and `message`, as the examples do, not the whole error.
- One host per `dir`, enforced with a lock file.

## API

`createToolHost(options)` returns a started `ToolHost`. Options and defaults: `dir` (required), `workspace` (cwd), `capabilities` (`{ files, network, exec: false }`), `callTimeoutMs` (30 s), `readyTimeoutMs` (5 s), `killGraceMs` (1 s), `drainTimeoutMs` (5 s), `autoRestart` (true), `maxCrashRestarts` (5), `maxResultBytes` (1 MB), `maxSourceBytes` (256 KB), `onLog` (discard).

| `ToolHost` | |
|---|---|
| `tools()` | Built-in plus enabled generated tools, in the neutral shape. |
| `call(name, args)` | Run a tool. Built-ins update the registry and restart the worker; if the restart fails the change is rolled back. Rejects with `ToolError`. |
| `history(name, { limit, before })` | Previous versions, newest first. |
| `status()` | `{ open, dir, workspace, capabilities, worker }`. |
| `start()`, `stop()` | Idempotent. `stop()` drains running calls. A stopped host can be started again. |

`host.worker` is an `EventEmitter`: `ready`, `exit`, `log`, `warning`, `startup_error`, `restarting`, `unhealthy`. The lower layers `ToolRegistry`, `ToolStore`, `ToolWorkerClient`, `normalizeToolSchema`, `unwrapExecuteSource`, and `resolveInside` are exported and typed; see `src/types.ts`.

**Error codes.** Validation: `invalid_name`, `invalid_description`, `invalid_schema`, `invalid_source`, `invalid_argument`. Registry: `exists`, `not_found`. Inside `ctx`: `recursive_call`, `path_outside_workspace`, `workspace_unavailable`, `file_not_found`, `file_error`, `invalid_path`, `fetch_failed`, `fetch_timeout`, `fetch_too_large`, `capability_disabled`. Execution: `call_failed` (carries `details.remoteCode` and `details.remoteStack`), `unserializable_result`, `result_too_large`, `timeout`. Lifecycle: `worker_unavailable`, `startup_failed`, `start_failed`, `host_stopped`, `dir_in_use`, `store_error`, `store_incompatible`. `internal_error` is a bug in toolhost.

## Development

```sh
npm test          # node --test on the TypeScript sources, 61 tests, loopback only
npm run typecheck # tsc --strict over src, examples, and tests
npm run build     # dist/ with declarations
```

Node 22 prints `ExperimentalWarning: SQLite is an experimental feature` once per process. toolhost silences it in the worker; for your process use `node --disable-warning=ExperimentalWarning`. Node 24 does not warn.

## License

MIT
