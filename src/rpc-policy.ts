/**
 * Which commands `/rpc` may run without write mode.
 *
 * Derived from `capabilities()`, never hand-listed. The bridge used to carry a
 * hardcoded Set of eight names, which drifted exactly the way CLAUDE.md says
 * hand-maintained capability labels always do.
 *
 * THE NAMESPACE IS THE WHOLE POINT
 * --------------------------------
 * `/rpc` queues a command straight to the plugin, so it speaks the PLUGIN
 * COMMAND namespace, not the MCP tool namespace. The first version of this
 * derived tool NAMES, which meant 14 of its 23 entries could never match
 * anything: an `eval` tool's command is `eval`, and a `local` tool never reaches
 * the bridge at all. Meanwhile `capture` — the command `screenshot` dispatches —
 * was missing, so a read-only build could not take a screenshot over `/rpc`.
 *
 * So: read-class `dispatch` tools contribute their `pluginCommand`, and the rest
 * contribute nothing, because they have no command of their own.
 *
 * This lives above the transport, not inside it. `StudioBridge` takes the set as
 * a constructor argument so it keeps depending on nothing above the seam; the
 * composition root and the tests both call this, so there is one definition.
 */

import { capabilities } from "./registry.js";
import { ALL_TOOLS } from "./tools/index.js";
import { screenshotTool } from "./vision.js";

/**
 * Commands the server itself dispatches, which therefore have no registry entry
 * to derive from.
 *
 *   read        the universal read verb, a core tool
 *   diagnostics  behind the studio://errors/recent resource
 *   viewport     behind read({ viewport: true })
 *   capture      what `screenshot` sends before falling back to the OS
 *
 * All four are read-only by construction. `capture` is derived from
 * `screenshotTool` rather than typed out; the other three have no tool entry at
 * all, so they are the only names here written by hand — and they are the whole
 * hand-maintained surface.
 */
const CORE_READ_COMMANDS = ["read", "diagnostics", "viewport"] as const;

export function rpcReadOnlyCommands(): string[] {
  const fromTools = ALL_TOOLS.filter((t) => !capabilities(t).write)
    .map((t) => t.pluginCommand)
    .filter((cmd): cmd is string => typeof cmd === "string");

  // screenshot is a core tool, so it is not in ALL_TOOLS, but it dispatches a
  // real command and is read-class. Derived the same way rather than typed out.
  const fromCore = capabilities(screenshotTool).write ? [] : [screenshotTool.pluginCommand];

  return [...new Set([...CORE_READ_COMMANDS, ...fromTools, ...fromCore.filter(Boolean)])] as string[];
}
