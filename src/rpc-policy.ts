/**
 * Which commands `/rpc` may run without write mode.
 *
 * Derived from `capabilities()`, never hand-listed. The bridge used to carry a
 * hardcoded Set of eight names, which drifted exactly the way CLAUDE.md says
 * hand-maintained capability labels always do: sixteen tools that
 * `capabilities()` calls read-only were refused, including every documentation
 * lookup, and two of the eight named commands that are not tools at all.
 *
 * This lives above the transport, not inside it. `StudioBridge` takes the set as
 * a constructor argument so it keeps depending on nothing above the seam; the
 * composition root and the tests both call this, so there is one definition.
 */

import { capabilities } from "./registry.js";
import { ALL_TOOLS } from "./tools/index.js";

/**
 * `read` is a core tool rather than a registry entry, so it is named here. It is
 * the universal read verb and is read-only by construction.
 */
const CORE_READ_TOOLS = ["read"] as const;

export function rpcReadOnlyCommands(): string[] {
  return [...CORE_READ_TOOLS, ...ALL_TOOLS.filter((t) => !capabilities(t).write).map((t) => t.name)];
}
