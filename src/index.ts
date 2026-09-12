#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StudioBridge } from "./bridge.js";
import { createMcpServer, readOnlyFromEnv } from "./server.js";
import { rpcReadOnlyCommands } from "./rpc-policy.js";
import { lintAvailable } from "./lint.js";
import { installPlugin, pluginsDir, PLUGIN_FILENAME } from "./install-plugin.js";
import { MAX_PROTOCOL_VERSION, MIN_PROTOCOL_VERSION } from "./protocol.js";
import { tokenFile } from "./paths.js";

/**
 * Entry point. Two faces:
 *   - stdio  : the MCP transport, talks to Claude.
 *   - HTTP   : the localhost bridge, talks to the Roblox Studio plugin.
 *
 * IMPORTANT: stdout is reserved for the MCP protocol. All logging goes to stderr.
 */

const VERSION = "0.2.0";

const HELP = `cubes-roblox-mcp ${VERSION} — an MCP server for Roblox Studio

  cubes-roblox-mcp [options]

The server talks MCP over stdio, so it is normally launched by your MCP client
rather than by hand. stdout is reserved for the protocol; logs go to stderr.

  --read-only            Remove every write tool from the process. Stronger than
                         the Studio panel's toggle: there is nothing to flip.
  --install-plugin       Copy the Studio plugin into Studio's plugins folder and
                         exit. Restart Studio afterwards; plugins are cached at
                         launch.
  --plugin <path>        Install from this .rbxm instead of the bundled one.
  --plugins-dir <path>   Install into this directory instead of the default.
  --version              Print the version and exit.
  --help                 This.

Environment: CUBES_MCP_PORT, CUBES_MCP_TOKEN, CUBES_MCP_READ_ONLY,
CUBES_MCP_HOME, CUBES_MCP_OFFLINE, CUBES_MCP_SOURCEMAP, CUBES_MCP_LINT_CWD.
See docs/CONFIGURATION.md.
`;

/** Read `--flag value`, or undefined. */
function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const PORT = Number(process.env.CUBES_MCP_PORT ?? 44820);
/**
 * Read-only build: no write tools exist in the process at all, and `/rpc`
 * refuses writes regardless of the Studio panel's toggle. `--read-only` on the
 * command line or CUBES_MCP_READ_ONLY=1 in the environment.
 */
const READ_ONLY = process.argv.includes("--read-only") || readOnlyFromEnv();

/**
 * One-shot subcommands, handled before anything is started.
 *
 * These write to stdout on purpose — they are a person at a terminal, not an MCP
 * client, and the stdout-is-the-protocol rule only applies once the server runs.
 */
async function runSubcommand(): Promise<boolean> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(HELP);
    return true;
  }
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return true;
  }
  if (process.argv.includes("--install-plugin") || process.argv.includes("--auto-install-plugin")) {
    const result = await installPlugin({
      source: flagValue("--plugin"),
      targetDir: flagValue("--plugins-dir"),
    });
    process.stdout.write(`${result.message}\n`);
    if (!result.ok) {
      const dir = pluginsDir();
      if (dir) process.stdout.write(`Studio reads plugins from: ${dir}\n`);
      process.stdout.write(`Expected file name: ${PLUGIN_FILENAME}\n`);
      process.exitCode = 1;
    }
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  if (await runSubcommand()) return;

  const bridge = new StudioBridge(PORT, {
    readOnly: READ_ONLY,
    readOnlyCommands: rpcReadOnlyCommands(),
  });
  // The bridge failing must NEVER stop the MCP server from starting.
  //
  // This used to be `await bridge.start()` before `server.connect`, so a port
  // already in use -- a second copy of this server, a leftover process -- took
  // the whole thing down: the client saw a dead server with no tools at all and
  // no way to find out why. blender-mcp hit the same shape and a user described
  // it as breaking "the entire host client and prevents all my other MCP servers
  // from loading". Tools stay listed; the ones that need Studio say what is wrong.
  //
  // Note what this deliberately does NOT do: scan for a free port. Auto-discovery
  // was tried in this ecosystem and removed again, because it produces a plugin
  // panel that reports "connected" while pointing at a port nothing is serving.
  // A named failure beats a silent mismatch.
  let bridgeStarted = true;
  try {
    await bridge.start();
  } catch (err) {
    bridgeStarted = false;
    console.error(
      `[cubes-mcp] the Studio bridge could not start: ${err instanceof Error ? err.message : String(err)}\n` +
        `[cubes-mcp] MCP is still up and every tool is still listed; the ones that need\n` +
        `[cubes-mcp] Studio will explain this instead of hanging. Fix the port and restart.`,
    );
  }

  const server = createMcpServer(bridge, { readOnly: READ_ONLY });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    bridgeStarted
      ? `[cubes-mcp] ready — MCP on stdio, Studio bridge on http://127.0.0.1:${PORT}`
      : `[cubes-mcp] ready — MCP on stdio, Studio bridge DOWN (port ${PORT} unavailable)`,
  );
  if (READ_ONLY) {
    console.error(
      "[cubes-mcp] READ-ONLY build: mutate, run_code and every write specialist are " +
        "absent from this process, and /rpc refuses writes whatever the Studio panel says.",
    );
  }
  if (bridge.tokenWarning) {
    console.error(`[cubes-mcp] ${bridge.tokenWarning}`);
  }
  if (bridge.tokenPersisted) {
    // Printed once, on the run that created it. On later runs the value is
    // unchanged, so re-echoing a live secret into the client's log every start
    // buys nothing -- the panel already has it.
    console.error(
      bridge.tokenGenerated
        ? `[cubes-mcp] bridge token: ${bridge.token}\n` +
            `[cubes-mcp] paste this into the Cubes MCP panel in Studio. It is saved to\n` +
            `[cubes-mcp] ${tokenFile()} and will not change on restart.`
        : `[cubes-mcp] bridge token loaded from ${tokenFile()} (unchanged since first run).`,
    );
  } else if (bridge.tokenGenerated) {
    console.error(
      `[cubes-mcp] bridge token (this run only): ${bridge.token}\n` +
        `[cubes-mcp] it could not be saved, so it changes every restart. Set CUBES_MCP_TOKEN to pin it.`,
    );
  } else {
    console.error("[cubes-mcp] bridge token loaded from CUBES_MCP_TOKEN.");
  }
  console.error(
    `[cubes-mcp] protocol ${MIN_PROTOCOL_VERSION}-${MAX_PROTOCOL_VERSION}; ` +
      `the plugin must report a version in that range or every call fails.`,
  );
  const lint = await lintAvailable();
  if (!lint.ok) {
    console.error(`[cubes-mcp] inline Luau lint is OFF (${lint.reason}). Set CUBES_MCP_LINT_CWD if your selene.toml lives elsewhere.`);
  }

  // The HTTP bridge keeps the event loop alive, so we must exit explicitly when
  // the MCP client disconnects (stdin EOF) or the process is asked to stop.
  const shutdown = () => {
    void bridge.stop().finally(() => process.exit(0));
  };
  transport.onclose = shutdown;
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[cubes-mcp] fatal:", err);
  process.exit(1);
});
