#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StudioBridge } from "./bridge.js";
import { createMcpServer } from "./server.js";
import { lintAvailable } from "./lint.js";

/**
 * Entry point. Two faces:
 *   - stdio  : the MCP transport, talks to Claude.
 *   - HTTP   : the localhost bridge, talks to the Roblox Studio plugin.
 *
 * IMPORTANT: stdout is reserved for the MCP protocol. All logging goes to stderr.
 */

const PORT = Number(process.env.CUBES_MCP_PORT ?? 44820);

async function main(): Promise<void> {
  const bridge = new StudioBridge(PORT);
  await bridge.start();

  const server = createMcpServer(bridge);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `[cubes-mcp] ready — MCP on stdio, Studio bridge on http://127.0.0.1:${PORT}`,
  );
  if (bridge.tokenGenerated) {
    console.error(
      `[cubes-mcp] bridge token: ${bridge.token}\n` +
        `[cubes-mcp] the Studio plugin must send this as 'Authorization: Bearer <token>'.\n` +
        `[cubes-mcp] set CUBES_MCP_TOKEN to pin it across restarts.`,
    );
  } else {
    console.error("[cubes-mcp] bridge token loaded from CUBES_MCP_TOKEN.");
  }
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
