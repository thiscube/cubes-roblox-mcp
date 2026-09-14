#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StudioBridge, resolveToken } from "./bridge.js";
import { createMcpServer, readOnlyFromEnv } from "./server.js";
import { rpcReadOnlyCommands } from "./rpc-policy.js";
import { lintAvailable } from "./lint.js";
import { installPlugin, installedPluginFiles, pluginsDir, PLUGIN_FILENAME } from "./install-plugin.js";
import { MAX_PROTOCOL_VERSION, MIN_PROTOCOL_VERSION } from "./protocol.js";
import { tokenFile } from "./paths.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  --install-plugin       Install the Studio plugin (removing any older copy, with
                         the bridge token baked in), print how to register this
                         server with an MCP client, and exit. (npm run setup)
  --doctor               Check the whole chain (plugin installed, server running,
                         Studio connected, writes) and exit. (npm run doctor)
  --plugin <path>        Install from this .rbxmx instead of the bundled one.
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
    // The token this server will use from now on. Only a token that will still be
    // the server's on the next run is baked in; a one-run fallback would not be.
    const tok = resolveToken();
    const bakeable = !tok.generated || tok.persisted;
    const result = await installPlugin({
      source: flagValue("--plugin"),
      targetDir: flagValue("--plugins-dir"),
      token: bakeable ? tok.token : undefined,
    });
    if (!result.ok) {
      process.stdout.write(`${result.message}\n`);
      const dir = pluginsDir();
      if (dir) process.stdout.write(`Studio reads plugins from: ${dir}\n`);
      process.stdout.write(`Expected file name: ${PLUGIN_FILENAME}\n`);
      process.exitCode = 1;
      return true;
    }
    process.stdout.write(setupReport(result, tok.warning));
    return true;
  }
  if (process.argv.includes("--doctor")) {
    process.exitCode = await doctor();
    return true;
  }
  return false;
}

/** What `npm run setup` prints after installing: what happened, then exactly what is left. */
function setupReport(result: Awaited<ReturnType<typeof installPlugin>>, tokenWarning?: string): string {
  const server = fileURLToPath(new URL("./index.js", import.meta.url)).replace(/\\/g, "/");
  const lines = [
    `OK  Studio plugin installed: ${result.installedTo}`,
    ...(result.removed && result.removed.length > 0 ? [`OK  Removed the old plugin file(s): ${result.removed.join(", ")}`] : []),
    result.tokenBaked
      ? `OK  Bridge token baked into the plugin, so there is nothing to paste.`
      : `!!  Token NOT baked${tokenWarning ? ` (${tokenWarning})` : ""}. Paste it into the Studio panel: Controls > Bridge token.`,
    ``,
    `Next steps:`,
    `  1. Register this server with your MCP client.`,
    `       Claude Code: check first with  claude mcp get cubes-roblox`,
    `         - not found:        claude mcp add cubes-roblox -s user -- node "${server}"`,
    `         - same path:        nothing to do`,
    `         - different path:   claude mcp remove cubes-roblox   then the add command above`,
    `       JSON config:  "cubes-roblox": { "command": "node", "args": ["${server}"] }`,
    `  2. Restart Roblox Studio (plugins load at launch), then start a new session in your MCP client.`,
    `  3. "Allow writes" starts on, so the AI can build right away. Turn it off in the Cubes MCP panel`,
    `     (Plugins tab > Status) when you want the AI to only look.`,
    `  4. Check everything: npm run doctor`,
    ``,
  ];
  return lines.join("\n");
}

/**
 * `npm run doctor`: walk the chain in order and stop at the first broken link,
 * naming the fix. Exit code 0 only when Studio is connected.
 */
async function doctor(): Promise<number> {
  const say = (s: string) => process.stdout.write(`${s}\n`);
  const dir = pluginsDir();
  if (dir) {
    const names = await installedPluginFiles(dir);
    if (names.length === 0) {
      say(`FAIL  No CubesMCP plugin in ${dir}. Run: npm run setup`);
      return 1;
    }
    say(
      names.length === 1
        ? `OK    Plugin installed: ${join(dir, names[0])}`
        : `WARN  ${names.length} copies of the Cubes MCP plugin in ${dir} (${names.join(", ")}). They fight over the port. Run: npm run setup (it removes the extras)`,
    );
  }

  const { token } = resolveToken();
  let health: any;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    health = await res.json();
  } catch {
    say(`FAIL  Nothing is listening on 127.0.0.1:${PORT}. The MCP client starts this server: register it (npm run setup prints the command) and open a new session.`);
    return 1;
  }
  say(`OK    Server running on port ${PORT} (plugin protocol ${health.protocolRange?.join("-") ?? "?"})`);
  if (!health.connected) {
    say(`FAIL  Studio is not connected. ${health.problem ?? health.detail ?? "Open a place in Roblox Studio."}`);
    return 1;
  }
  say(`OK    Studio connected`);
  say(health.writeEnabled ? `OK    Allow writes is ON` : `INFO  Allow writes is OFF: the AI can look but not change anything. Turn it on in the Studio panel when you want it to build.`);
  return 0;
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
    // Usually another Claude session's copy of this server. Keep trying, so this
    // one takes over when that session closes instead of staying down.
    bridge.retryListen();
    console.error(
      `[cubes-mcp] the Studio bridge could not start: ${err instanceof Error ? err.message : String(err)}\n` +
        `[cubes-mcp] MCP is still up and every tool is still listed; the ones that need\n` +
        `[cubes-mcp] Studio will explain this instead of hanging. Retrying the port every 3s.`,
    );
  }

  const server = createMcpServer(bridge, { readOnly: READ_ONLY });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    bridgeStarted
      ? `[cubes-mcp] ready — MCP on stdio, Studio bridge on http://127.0.0.1:${PORT}`
      : `[cubes-mcp] ready — MCP on stdio, Studio bridge waiting for port ${PORT} to free up`,
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
