import type { Capabilities } from "./types.ts";

/** What a tool may do from `ctx`. None of this is a sandbox; see README "Security". */
export const DEFAULT_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  files: true,
  network: true,
  exec: false,
  shell: "/bin/sh",
  execEnv: {}
});
