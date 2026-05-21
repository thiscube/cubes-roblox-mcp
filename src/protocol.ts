/**
 * Wire-protocol version for the MCP server <-> Studio plugin handshake.
 *
 * The plugin includes this in every /poll body; the server rejects mismatches
 * with HTTP 426 so a stale plugin surfaces as "rebuild the plugin" rather than
 * silent tool-call timeouts.
 *
 * Bump when the plugin and server can no longer understand each other safely:
 * any breaking change to the wire format of /poll, /result, BridgeCommand, or
 * to the shape of read / mutate / eval / diagnostics / viewport args + results.
 * Pure additive fields (a new optional key in a response) do NOT need a bump.
 *
 * Keep this constant in lockstep with roblox/src/Config.luau PROTOCOL_VERSION.
 */
export const PROTOCOL_VERSION = 1;
