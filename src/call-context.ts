/**
 * Which MCP tool call a bridge command belongs to.
 *
 * The plugin only ever sees the low-level command (`eval`, `mutate`, `read`...),
 * so `script_edit` and `parts_grid` both arrive as a bare `mutate` and the Studio
 * panel had to guess what the agent was doing from that. Every tool call runs
 * inside `withCall`, and `send()` stamps the current call onto the command as
 * `via`, however many helpers deep the send happens.
 *
 * AsyncLocalStorage rather than a parameter: there are a dozen send sites and a
 * tool handler can reach the bridge through handleMutate, getPlaceContext or a
 * helper, and threading a name through all of them is exactly what drifts.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface CallInfo {
  /** The MCP tool the agent called, e.g. `script_edit`. */
  tool: string;
  /** The registry category, when the tool is a specialist. Core tools have none. */
  category?: string;
  /** One-word label for the Studio panel, from activity.ts. */
  activity?: string;
  /** What the call acts on, when it has one subject (activity.ts targetFor). */
  target?: string;
}

const storage = new AsyncLocalStorage<CallInfo>();

export function withCall<T>(call: CallInfo, fn: () => T): T {
  return storage.run(call, fn);
}

/** The tool call the current code is running under, if any. */
export function currentCall(): CallInfo | undefined {
  return storage.getStore();
}
