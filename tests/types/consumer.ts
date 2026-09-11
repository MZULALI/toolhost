// Compiled by `npm run typecheck` (tsc --strict). Exercises every public export so drift
// between index.d.ts and the implementation's intended surface is caught in CI.
import {
  DEFAULT_CAPABILITIES,
  RESERVED_NAMES,
  TOOL_NAME_PATTERN,
  ToolError,
  ToolHost,
  ToolRegistry,
  ToolStore,
  ToolWorkerClient,
  assertModuleSource,
  assertToolName,
  assertUserToolName,
  buildModuleSource,
  coreTools,
  createToolHost,
  isCoreTool,
  normalizeToolSchema,
  resolveInside,
  toAnthropic,
  toOpenAIChat,
  toOpenAIResponses,
  unwrapExecuteSource,
  type Capabilities,
  type Tool,
  type ToolDefinition,
  type ToolVersion,
  type WorkerStatus
} from "toolhost";

async function main(): Promise<void> {
  const host: ToolHost = await createToolHost({
    dir: ".toolhost",
    workspace: process.cwd(),
    capabilities: { exec: true, execEnv: { A: "1" } },
    callTimeoutMs: 1000,
    readyTimeoutMs: 1000,
    killGraceMs: 100,
    drainTimeoutMs: 100,
    autoRestart: false,
    maxCrashRestarts: 2,
    maxResultBytes: 10,
    maxSourceBytes: 10,
    onLog: ({ stream, text }) => console.log(stream, text)
  });

  const tools: ToolDefinition[] = host.tools();
  const anthropic = toAnthropic(tools);
  const responses = toOpenAIResponses(tools);
  const chat = toOpenAIChat(tools);
  console.log(anthropic[0].input_schema, responses[0].parameters, chat[0].function.name);

  const result: unknown = await host.call("create_tool", { name: "x" });
  const versions: ToolVersion[] = host.history("x");
  const status = host.status();
  const worker: WorkerStatus = status.worker;
  console.log(result, versions[0]?.operation, worker.crashCount, status.open);

  host.worker.on("ready", (s) => console.log(s.tools));
  host.worker.on("exit", (e) => console.log(e.reason, e.signal));
  host.worker.on("log", (l) => console.log(l.stream));
  host.worker.on("warning", (w) => console.log(w.kind, w.error.message));
  host.worker.on("startup_error", (e) => console.log(e.message));
  host.worker.on("restarting", (r) => console.log(r.attempt, r.delayMs));
  host.worker.on("unhealthy", (u) => console.log(u.crashes));

  const registry: ToolRegistry | null = host.registry;
  const store: ToolStore | null = host.store;
  const client: ToolWorkerClient = host.worker;
  if (registry && store) {
    const tool: Tool & { versionId: number } = await registry.create({ name: "a", description: "d", parameters: {}, executeSource: "return 1;" });
    await registry.update({ name: "a", enabled: false });
    await registry.restore("a", tool.versionId);
    await registry.delete("a");
    store.findCollision("a");
    store.getVersion("a", 1);
    console.log(store.history("a", { before: 5, limit: 3 }).length, registry.historyCount("a"), host.history("a", { before: 1 }));
    console.log(registry.list({ includeSource: true })[0]?.executeSource);
  }
  await client.restart("x");
  await client.callTool("a", {}, { timeoutMs: 5 });
  await host.stop();

  const caps: Capabilities = { ...DEFAULT_CAPABILITIES, exec: true };
  const err = new ToolError("not_found", "m", { a: 1 });
  console.log(caps.shell, err.code, err.details, isCoreTool("x"), RESERVED_NAMES[0], TOOL_NAME_PATTERN.source);
  console.log(assertToolName("a"), assertUserToolName("a"), unwrapExecuteSource("return 1;"));
  assertModuleSource(buildModuleSource({ name: "a", description: "d", parameters: {}, executeSource: "return 1;" }));
  console.log(normalizeToolSchema({ type: "object" }), await resolveInside("/", "x", { denied: ["/tmp"] }), coreTools.length);
}

void main;
