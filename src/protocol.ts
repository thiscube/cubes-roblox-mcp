/**
 * Wire-protocol versioning for the MCP server <-> Studio plugin handshake.
 *
 * The two halves ship separately — the plugin is distributed outside this repo —
 * so they CANNOT be assumed to upgrade in lockstep. An exact-equality check made
 * every release a flag day: bump the constant and every user on the previous
 * plugin is locked out until they rebuild (ARCHITECTURE-REVIEW.md A5).
 *
 * Instead the server accepts a RANGE. A plugin is compatible if it reports a
 * protocol between MIN_PROTOCOL_VERSION and MAX_PROTOCOL_VERSION inclusive.
 *
 * When to change what:
 *   - Additive change (a new optional field, a new plugin tool): bump
 *     MAX_PROTOCOL_VERSION, leave MIN alone. Old plugins keep working.
 *   - Breaking change (the shape of /poll, /result, read, mutate or eval changes
 *     incompatibly): raise MIN_PROTOCOL_VERSION to the first good version. Only
 *     then are older plugins refused, and the 426 tells them to rebuild.
 *
 * Keep MAX_PROTOCOL_VERSION in lockstep with the plugin's Config PROTOCOL_VERSION.
 *
 * History:
 *   1 - initial wire format.
 *   2 - bearer token required on /poll, /result and /rpc. Breaking: a v1 plugin
 *       sends no token, so MIN is 2 unless CUBES_MCP_ALLOW_UNAUTHENTICATED=1.
 *   3 - additive: a `capture` command, answered with { png, width, height } from
 *       StudioCaptureService. A v2 plugin has no such handler; `screenshot`
 *       treats any failure as "use the OS path", so MIN stays 2.
 *   4 - additive: a WebSocket transport at /ws, as an alternative to long-poll.
 *       A plugin that does not open one keeps polling and nothing changes, so
 *       MIN stays 2.
 *   5 - additive: `instanceId`, `placeId`, `placeName` and `role` on /poll and
 *       on the WebSocket `hello`, so several Studio windows can share one
 *       server. A plugin that sends none is filed under a single default id and
 *       behaves exactly as before, so MIN stays 2.
 */

/** Newest protocol this server speaks. Advertised in /health. */
export const MAX_PROTOCOL_VERSION = 5;

/** Oldest protocol this server still accepts. */
export const MIN_PROTOCOL_VERSION = 2;

/**
 * Back-compat alias. Older code imported a single PROTOCOL_VERSION; it maps to
 * the newest supported version so existing call sites keep meaning "current".
 */
export const PROTOCOL_VERSION = MAX_PROTOCOL_VERSION;

export function protocolSupported(version: number): boolean {
  return (
    Number.isInteger(version) &&
    version >= MIN_PROTOCOL_VERSION &&
    version <= MAX_PROTOCOL_VERSION
  );
}
