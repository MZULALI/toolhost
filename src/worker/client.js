import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { ToolError } from "../errors.js";
import { CONFIG_ENV, READY, RESULT, STARTUP_ERROR } from "../protocol.js";

const WORKER_PATH = fileURLToPath(new URL("./main.js", import.meta.url));

/**
 * Owns the worker child process: starts it, restarts it after a tool change, routes calls
 * to it, and fails every in-flight call the moment it dies so nothing hangs.
 *
 * Events: "ready" (status), "exit" ({ code, signal, reason }), "log" ({ stream, text }).
 */
export class ToolWorkerClient extends EventEmitter {
  /**
   * @param {{ config: { dbPath: string, modulesDir: string, workspace: string, capabilities?: object }, readyTimeoutMs?: number, killGraceMs?: number }} options
   */
  constructor({ config, readyTimeoutMs = 5_000, killGraceMs = 1_000 }) {
    super();
    this.config = config;
    this.readyTimeoutMs = readyTimeoutMs;
    this.killGraceMs = killGraceMs;
    this.child = null;
    this.ready = false;
    this.tools = [];
    this.pending = new Map();
    this.restartCount = 0;
    this.lastExit = null;
  }

  status() {
    return {
      pid: this.child?.pid ?? null,
      ready: this.ready,
      tools: [...this.tools],
      restartCount: this.restartCount,
      lastExit: this.lastExit
    };
  }

  /** Stop the current worker (if any) and start a fresh one. Resolves once it is ready. */
  async restart(reason = "manual") {
    await this.stop(`restart:${reason}`);
    this.restartCount += 1;

    const child = fork(WORKER_PATH, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: ["--disable-warning=ExperimentalWarning"],
      env: { ...process.env, [CONFIG_ENV]: JSON.stringify(this.config) }
    });
    this.child = child;
    this.#stopReasons.set(child, reason);

    child.stdout.on("data", (chunk) => this.emit("log", { stream: "stdout", text: String(chunk) }));
    child.stderr.on("data", (chunk) => this.emit("log", { stream: "stderr", text: String(chunk) }));
    child.on("message", (message) => this.#onMessage(message));
    child.on("error", (error) => this.#failAll(new ToolError("worker_unavailable", `Worker error: ${error.message}`)));
    child.on("exit", (code, signal) => {
      this.lastExit = { code, signal, reason: this.#stopReasons.get(child) ?? reason, at: new Date().toISOString() };
      if (this.child === child) {
        this.child = null;
        this.ready = false;
      }
      this.#failAll(new ToolError("worker_unavailable", `Worker exited (${signal ?? code}) before the call completed.`));
      this.emit("exit", this.lastExit);
    });

    await this.#waitUntilReady(child);
    return this.status();
  }

  /** Terminate the worker. Waits for exit, escalating to SIGKILL after `killGraceMs`. */
  async stop(reason = "stop") {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.ready = false;
    this.tools = [];
    this.#stopReasons.set(child, reason);

    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => child.kill("SIGKILL"), this.killGraceMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  /**
   * @param {string} name @param {unknown} args @param {{ timeoutMs?: number }} [options]
   */
  callTool(name, args, { timeoutMs = 30_000 } = {}) {
    const child = this.child;
    if (!child || !this.ready) {
      return Promise.reject(new ToolError("worker_unavailable", "Worker is not running. Call start() or restart() first."));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolError("timeout", `Tool "${name}" did not finish within ${timeoutMs} ms.`, { name, timeoutMs }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.send({ type: "call", id, name, args }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ToolError("worker_unavailable", `Could not send to worker: ${error.message}`));
      });
    });
  }

  /** Why each child was stopped, reported in its "exit" event. */
  #stopReasons = new WeakMap();

  #onMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === READY) {
      this.ready = true;
      this.tools = Array.isArray(message.tools) ? message.tools : [];
      this.emit("ready", this.status());
      return;
    }
    if (message.type === STARTUP_ERROR) {
      this.emit("startup_error", message.error);
      return;
    }
    if (message.type !== RESULT || !this.pending.has(message.id)) return;
    const { resolve, reject, timer } = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(timer);
    if (message.ok) resolve(message.result);
    else reject(new ToolError(message.error?.code ?? "call_failed", message.error?.message ?? "Tool call failed.", { remoteStack: message.error?.stack }));
  }

  #failAll(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  #waitUntilReady(child) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.stop("ready-timeout").then(() =>
          reject(new ToolError("worker_unavailable", `Worker did not become ready within ${this.readyTimeoutMs} ms.`))
        );
      }, this.readyTimeoutMs);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onStartupError = (error) => {
        cleanup();
        this.stop("startup-error").then(() =>
          reject(new ToolError(error?.code ?? "startup_failed", `Worker failed to start: ${error?.message ?? "unknown error"}`))
        );
      };
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
}
