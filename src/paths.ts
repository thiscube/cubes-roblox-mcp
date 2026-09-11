/**
 * Where this server keeps its state on disk.
 *
 * One place, resolved lazily, so tests can point it somewhere disposable and a
 * user can relocate it off a roaming profile or a synced home directory.
 *
 * Lazy matters: these used to be module-level constants computed from
 * `homedir()` at import time, which made the location unchangeable once the
 * module loaded and let a test that had already fetched the real API dump leak
 * that cache into a test that was meant to be running offline.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Root for everything this server persists. Override with CUBES_MCP_HOME. */
export function stateDir(): string {
  const override = process.env.CUBES_MCP_HOME;
  return override && override.trim() ? override : join(homedir(), ".cubesmcp");
}

/** Per-place project profiles. */
export function profileDir(): string {
  return join(stateDir(), "profiles");
}

/** Cached Roblox API dump. */
export function apiDumpFile(): string {
  return join(stateDir(), "api-dump.json");
}
