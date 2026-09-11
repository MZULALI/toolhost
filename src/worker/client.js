import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ToolError } from "../errors.js";
import { CONFIG_ENV, READY, RESULT, STARTUP_ERROR, WARNING } from "../protocol.js";

const WORKER_PATH = fileURLToPath(new URL("./main.js", import.meta.url));

/** A worker that stays ready this long has recovered; the crash counter resets. */
const HEALTHY_AFTER_MS = 30_000;

/**
 * Owns the worker child process.
 *
 * - `restart()` calls are serialised and coalesced, and each waits for in-flight calls to
 *   drain before replacing the worker, so a tool change never kills a running call.
 * - Calls made while a restart is in progress wait for it instead of failing.
 * - If the worker dies unexpectedly, every in-flight call is rejected and a new worker is
 *   forked with exponential backoff. After `maxCrashRestarts` consecutive crashes it
 *   gives up and emits "unhealthy".
 *
 * Events: "ready" (status), "exit" ({ code, signal, reason, at }), "log" ({ stream, text }),
 * "warning" ({ kind, error }), "restarting" ({ attempt, delayMs }), "unhealthy" ({ crashes, lastExit }).
 */
export class ToolWorkerClient extends EventEmitter {
  #child = null;
  #ready = false;
  #tools = [];
  #pending = new Map();
  #restartCount = 0;
  #crashes = 0;
  #lastExit = null;
  #stopped = true;
  #queue = Promise.resolve();
  #scheduled = null;
  #crashTimer = null;
  #crashWait = null;
  #healthyTimer = null;
  #stopReasons = new WeakMap();
  /** The child whose startup restart() is currently awaiting; its death is reported by restart(), not supervised. */
  #starting = null;

  /**
   * @param {{
   *   config: { dbPath: string, modulesDir: string, workspace: string, capabilities?: object, maxResultBytes?: number },
   *   readyTimeoutMs?: number,
   *   killGraceMs?: number,
   *   drainTimeoutMs?: number,
   *   autoRestart?: boolean,
   *   maxCrashRestarts?: number
   * }} options
   */
  constructor({
    config,
    readyTimeoutMs = 5_000,
    killGraceMs = 1_000,
    drainTimeoutMs = 5_000,
    autoRestart = true,
    maxCrashRestarts = 5
  }) {
    super();
    this.config = config;
    this.readyTimeoutMs = readyTimeoutMs;
    this.killGraceMs = killGraceMs;
    this.drainTimeoutMs = drainTimeoutMs;
    this.autoRestart = autoRestart;
    this.maxCrashRestarts = maxCrashRestarts;
  }

  status() {
    return {
      pid: this.#child?.pid ?? null,
      ready: this.#ready,
      tools: [...this.#tools],
      restartCount: this.#restartCount,
      crashCount: this.#crashes,
      lastExit: this.#lastExit
    };
  }

  /**
   * Replace the worker with a fresh one. Concurrent callers share one restart; a caller that
   * arrives after a restart has begun gets the next one. Resolves once the new worker is ready.
   */
  restart(reason = "manual") {
    if (this.#scheduled) return this.#scheduled;
    const task = this.#queue.then(() => {
      this.#scheduled = null;
      return this.#restartNow(reason);
    });
    this.#scheduled = task;
    this.#queue = task.then(noop, noop);
    return task;
  }

  /** Terminate the worker and stop supervising it. `restart()` starts it again. */
  async stop(reason = "stop") {
    this.#stopped = true;
    this.#cancelCrashRestart();
    await this.#queue;
    await this.#stopChild(reason);
  }

  /**
   * @param {string} name @param {unknown} args @param {{ timeoutMs?: number }} [options]
   */
  async callTool(name, args, { timeoutMs = 30_000 } = {}) {
    await this.#crashWait?.promise; // a restart after a crash is scheduled: wait for it
    await this.#queue; // wait out any restart in progress
    const child = this.#child;
    if (!child || !this.#ready) {
      throw new ToolError("worker_unavailable", "Worker is not running. Call restart() to start it.");
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ToolError("timeout", `Tool "${name}" did not finish within ${timeoutMs} ms.`, { name, timeoutMs }));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      child.send({ type: "call", id, name, args }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new ToolError("worker_unavailable", `Could not send to worker: ${error.message}`));
      });
    });
  }

  // -- lifecycle -------------------------------------------------------------------------

  async #restartNow(reason) {
    this.#stopped = false;
    await this.#drain();
    await this.#stopChild(`restart:${reason}`);
    this.#restartCount += 1;

    const child = fork(WORKER_PATH, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: ["--disable-warning=ExperimentalWarning"],
      env: { ...process.env, [CONFIG_ENV]: JSON.stringify(this.config) },
      // Own process group, so stopping the worker also stops anything a tool spawned.
      detached: USE_PROCESS_GROUPS
    });
    this.#child = child;
    this.#starting = child;

    child.stdout.on("data", (chunk) => this.emit("log", { stream: "stdout", text: String(chunk) }));
    child.stderr.on("data", (chunk) => this.emit("log", { stream: "stderr", text: String(chunk) }));
    child.on("message", (message) => {
      if (this.#child === child) this.#onMessage(message);
    });
    child.on("error", (error) => {
      if (this.#child === child) this.#failAll(new ToolError("worker_unavailable", `Worker error: ${error.message}`));
    });
    child.on("exit", (code, signal) => this.#onExit(child, code, signal));

    try {
      await this.#waitUntilReady(child);
    } finally {
      if (this.#starting === child) this.#starting = null;
    }
    return this.status();
  }

  #onExit(child, code, signal) {
    const deliberate = this.#stopReasons.has(child);
    const exit = {
      code,
      signal,
      reason: this.#stopReasons.get(child) ?? "crash",
      at: new Date().toISOString()
    };
    this.#lastExit = exit;
    this.emit("exit", exit);
    if (deliberate || this.#child !== child || this.#starting === child) return;

    // Unexpected death of the current worker.
    this.#child = null;
    this.#ready = false;
    this.#tools = [];
    clearTimeout(this.#healthyTimer);
    this.#failAll(
      new ToolError("worker_unavailable", `Worker exited unexpectedly (${signal ?? `code ${code}`}) before the call completed.`)
    );
    this.#supervise();
  }

  #supervise() {
    if (!this.autoRestart || this.#stopped) return;
    this.#crashes += 1;
    if (this.#crashes > this.maxCrashRestarts) {
      this.emit("unhealthy", { crashes: this.#crashes, lastExit: this.#lastExit });
      return;
    }
    const delayMs = Math.min(100 * 2 ** (this.#crashes - 1), 5_000);
    this.emit("restarting", { attempt: this.#crashes, delayMs });
    let release;
    this.#crashWait = { promise: new Promise((resolve) => (release = resolve)), release };
    // Not unref'd: a scheduled restart is real work and must keep the process alive.
    this.#crashTimer = setTimeout(() => {
      this.restart("crash")
        .catch((error) => this.emit("unhealthy", { crashes: this.#crashes, lastExit: this.#lastExit, error }))
        .finally(() => this.#cancelCrashRestart());
    }, delayMs);
  }

  #cancelCrashRestart() {
    clearTimeout(this.#crashTimer);
    this.#crashTimer = null;
    this.#crashWait?.release();
    this.#crashWait = null;
  }

  async #stopChild(reason) {
    const child = this.#child;
    if (!child) return;
    this.#child = null;
    this.#ready = false;
    this.#tools = [];
    clearTimeout(this.#healthyTimer);
    this.#stopReasons.set(child, reason);

    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => signal(child, "SIGKILL"), this.killGraceMs);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        signal(child, "SIGTERM");
      });
    }
    this.#failAll(new ToolError("worker_unavailable", `Worker was stopped (${reason}) before the call completed.`));
  }

  /** Wait for in-flight calls to finish, up to `drainTimeoutMs`. */
  async #drain() {
    const deadline = Date.now() + this.drainTimeoutMs;
    while (this.#pending.size > 0 && Date.now() < deadline) await sleep(10);
  }

  #waitUntilReady(child) {
    return new Promise((resolve, reject) => {
      const fail = (reason, error) => {
        cleanup();
        this.#stopChild(reason).then(() => reject(error));
      };
      const timer = setTimeout(
        () => fail("ready-timeout", new ToolError("worker_unavailable", `Worker did not become ready within ${this.readyTimeoutMs} ms.`)),
        this.readyTimeoutMs
      );
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onStartupError = (error) =>
        fail("startup-error", new ToolError(error?.code ?? "startup_failed", `Worker failed to start: ${error?.message ?? "unknown error"}`));
      const onExit = () => {
        cleanup();
        reject(new ToolError("worker_unavailable", "Worker exited during startup."));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("ready", onReady);
        this.off("startup_error", onStartupError);
        child.off("exit", onExit);
      };
      this.once("ready", onReady);
      this.once("startup_error", onStartupError);
      child.once("exit", onExit);
    });
  }

  // -- messages --------------------------------------------------------------------------

  #onMessage(message) {
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case READY:
        this.#ready = true;
        this.#tools = Array.isArray(message.tools) ? message.tools : [];
        this.#healthyTimer = setTimeout(() => {
          this.#crashes = 0;
        }, HEALTHY_AFTER_MS);
        this.#healthyTimer.unref();
        this.emit("ready", this.status());
        return;
      case STARTUP_ERROR:
        this.emit("startup_error", message.error);
        return;
      case WARNING:
        this.emit("warning", { kind: message.kind, error: message.error });
        return;
      case RESULT: {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(JSON.parse(message.resultJson));
        else {
          pending.reject(
            new ToolError(message.error?.code ?? "call_failed", message.error?.message ?? "Tool call failed.", {
              remoteStack: message.error?.stack
            })
          );
        }
        return;
      }
      default:
    }
  }

  #failAll(error) {
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
  }
}

function noop() {}

const USE_PROCESS_GROUPS = process.platform !== "win32";

/** Signal the worker's whole process group where supported, else just the worker. */
function signal(child, name) {
  if (USE_PROCESS_GROUPS) {
    try {
      process.kill(-child.pid, name);
      return;
    } catch {
      // Group already gone or not ours; fall through to the single process.
    }
  }
  child.kill(name);
}
