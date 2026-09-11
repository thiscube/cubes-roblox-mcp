# Cubes Roblox MCP — orientation for AI agents

A Model Context Protocol server that lets Claude (or any MCP client) drive Roblox Studio.
GitHub: https://github.com/thiscube/cubes-roblox-mcp

## What this repo is

**This repo is the MCP server only.** The Studio plugin (Luau) is the other half of the
system and is distributed separately — `.gitignore` excludes `roblox/`, and it has never
been tracked here. Don't go looking for `roblox/src/Transport.luau`; it isn't in this
checkout and never was.

- `src/` — Node/TypeScript MCP server. Stdio to the MCP client, HTTP bridge to the plugin.
- `src/tools/` — one file per tool category, matching the `Category` union in `registry.ts`.
- `test/unit/` — the tests that run without Studio. Start here.

```
npm install
npm run build      # tsc
npm test           # build + unit tests (no Studio needed)
npm run test:unit  # unit tests against the existing dist/
```

The server is invoked by the MCP client over stdio — don't run `node dist/index.js`
manually unless you hold stdin open (`node dist/index.js < <(sleep 86400)`).

## Architecture in one paragraph

`index.ts` starts a `StudioBridge` (HTTP long-poll on 127.0.0.1:44820) and an MCP server
over stdio. The bridge implements `StudioTransport` (`src/transport.ts`); everything above
that line — the 58 specialist tools, the core handlers, the resource handlers — depends only
on the interface, which is why the tools are unit-testable against a fake and why a second
transport (Open Cloud) would not touch a single tool handler.

## The two rules that matter most

**1. Capability is derived, never labelled.** A tool's `channel` (set by its constructor —
`evalTool`, `mutateTool`, `dispatchTool`, `localTool`) determines whether it's write-class.
`capabilities()` in `registry.ts` is the single source of truth, used by the write gate, the
`/rpc` gate and the MCP tool annotations. A tool on a Studio channel is write-class **by
default**; opt out with `readOnly: true`, and only when the generated Luau provably only
reads. Never add a hand-maintained write flag back.

**2. The bridge authenticates in both directions.** Every route requires a bearer token,
refuses any request carrying an `Origin`, requires a loopback `Host`, and requires
`application/json`. The token is generated per run and printed to stderr; pin it with
`CUBES_MCP_TOKEN`. `CUBES_MCP_ALLOW_UNAUTHENTICATED=1` exists for older plugins and is
unsafe — it re-opens write-toggle forgery.

## Write mode

Write-class tools are **gated** behind the user's *Allow writes* toggle in the Studio panel.
The plugin reports the toggle on every poll; a poll that omits the field means OFF.
Destructive batches (deleting instances, overwriting script source) additionally need
`confirm: true` — and when the client supports MCP elicitation the server asks the user
directly instead of returning `needs_confirmation` and hoping the model relays it.

## Talking to a running bridge without MCP

```bash
TOKEN=...   # printed to stderr at startup, or whatever you set CUBES_MCP_TOKEN to
curl -s -H "Authorization: Bearer $TOKEN" -X POST http://127.0.0.1:44820/health
curl -s -X POST http://127.0.0.1:44820/rpc \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool":"read","args":{"path":"Workspace","children":true}}'
```

`/rpc` classifies deny-by-default: anything not on the read-only allowlist needs write mode.

## Where to look

- `PLAN.md` — what to build next, and why. Start here for new work.
- `ISSUES.md` — every known defect in plain language. Read before changing behaviour.
- `AUDIT.md` / `ARCHITECTURE-REVIEW.md` — the detailed findings behind it.
- `src/transport.ts` — the seam. Depend on this, not on `StudioBridge`.
- `src/registry.ts` — `capabilities()`, the tool constructors, `luaJson`.
- `src/server.ts` — the five always-visible core tools (`search_tools`, `read`, `screenshot`,
  `mutate`, `run_code`) plus the resource handlers.
- `src/tools/index.ts` — assembles every category into `ALL_TOOLS`.

## Things that bite

- Refs (`p3`, `f12`, `s7`) are session-scoped. If the plugin reloads, old refs die — fall
  back to dotted paths (`Workspace.Foo.Bar`).
- Protocol is a **range** (`MIN_PROTOCOL_VERSION`..`MAX_PROTOCOL_VERSION`), not an equality
  check. Bump MAX for additive changes; only raise MIN for genuinely breaking ones.
- Rebuilding the plugin needs a Studio restart (plugins are cached at launch) and a new MCP
  client session (tool schemas load at session start).
- Port is configurable from the panel; the server must run with a matching `CUBES_MCP_PORT`.
