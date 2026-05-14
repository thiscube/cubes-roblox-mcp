#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StudioBridge } from "./bridge.js";
import { createMcpServer } from "./server.js";

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
    `[cubes-mcp] ready — MCP on stdio, Studio bridge on http://127.0.0.1:${PORT} ` +
      `(install the plugin and it will start polling)`,
  );

  // The HTTP bridge keeps the event loop alive, so we must exit explicitly when
  // the MCP client disconnects (stdin EOF) or the process is asked to stop.
  const shutdown = () => process.exit(0);
  transport.onclose = shutdown;
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[cubes-mcp] fatal:", err);
  process.exit(1);
});
