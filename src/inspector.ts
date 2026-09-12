#!/usr/bin/env node
/**
 * The read-only entry point (PLAN.md #13, #3).
 *
 * `cubes-roblox-mcp-inspector` is the same server with `--read-only` forced on,
 * so a user can *install* the safe edition rather than remembering a flag. The
 * write tools are not in the process: no toggle to flip, no gate to get wrong.
 *
 * Forced, not defaulted. There is deliberately no way to turn writes back on
 * from this binary — if you want them, run `cubes-roblox-mcp`.
 */
process.env.CUBES_MCP_READ_ONLY = "1";
if (!process.argv.includes("--read-only")) process.argv.push("--read-only");

await import("./index.js");
