# Cubes Roblox MCP — orientation for AI agents

A Model Context Protocol server that lets Claude (or any MCP client) drive Roblox Studio.
GitHub: https://github.com/thiscube/cubes-roblox-mcp

## What this repo is

**Both halves live here.** The MCP server is `src/`; the Studio plugin (Luau) is
`plugin/src`, built by Rojo into `plugin/CubesMCP.rbxmx`, which `npm run setup` installs
into Studio with the bridge token baked in. (`roblox/` in `.gitignore` is an old path
and holds nothing.)

- `src/` — Node/TypeScript MCP server. Stdio to the MCP client, HTTP bridge to the plugin.
- `plugin/src/` — the plugin. `init.server.luau` is the entry, `Transport.luau` the command
  dispatch, `StatusUi.luau` the panel, `HudOverlay.luau` the activity bar, `ViewGuard.luau`
  the camera/view revert. After editing, rebuild the model:
  `rojo build plugin/plugin.project.json -o plugin/CubesMCP.rbxmx` (a unit test catches drift).
- `src/tools/` — one file per tool category, matching the `Category` union in `registry.ts`.
- `test/unit/` — the tests that run without Studio. Start here.

```
npm install
npm run build      # tsc
npm test           # build + unit tests (no Studio needed)
npm run test:unit  # unit tests against the existing dist/
npm run ci         # exactly what CI runs: typecheck + build + tests, offline
npm run bench      # tool-list churn and transport latency
```

Run `npm run ci` before pushing. `npm test` alone once passed while CI failed,
because CI sets `CUBES_MCP_OFFLINE=1` and a guard was in the wrong place.

The server is invoked by the MCP client over stdio — don't run `node dist/index.js`
manually unless you hold stdin open (`node dist/index.js < <(sleep 86400)`).

## Architecture in one paragraph

`index.ts` starts a `StudioBridge` (HTTP long-poll on 127.0.0.1:44820) and an MCP server
over stdio. The bridge implements `StudioTransport` (`src/transport.ts`); everything above
that line — the specialist tools, the core handlers, the resource handlers — depends only
on the interface, which is why the tools are unit-testable against a fake and why a second
transport (Open Cloud) would not touch a single tool handler.

## The two rules that matter most

**1. Capability is derived, never labelled.** A tool's `channel` (set by its constructor —
`evalTool`, `mutateTool`, `dispatchTool`, `pipelineTool`, `localTool`) determines whether
it's write-class. `capabilities()` in `registry.ts` is the single source of truth, used by
the write gate, the `/rpc` gate (via `rpc-policy.ts`) and the MCP tool annotations.

The channel must describe **where the effect lands**, not where the computation happens.
`script_edit` does its find/replace in TypeScript and was therefore written as a
`localTool` — and it then overwrote script source with the *Allow writes* toggle off. Use
`pipelineTool` when a server-side handler's effect reaches Studio through `handleMutate`.

A tool on a Studio channel is write-class **by default**. Two explicit opt-outs, both
read-class: `readOnly: true` when the generated Luau provably only reads, and
`readOnly: "transient"` when it constructs something it never parents (`docs_defaults`).
Anything else — `false`, a typo — stays write-class; the function fails closed.

**"Local" is not the same as "harmless."** A `local` tool that persists anything must
declare `writesDisk: true`, or the read-only build will ship it and it will write to the
user's home. And never set `channel` by hand: use `evalTool`, `mutateTool`, `dispatchTool`,
`commandTool`, `readTool`, `pipelineTool` or `localTool`. Tests enforce both.

Never add a hand-maintained write flag back — the `/rpc` allowlist was the last one and it
had drifted by sixteen tools. Note that `/rpc` speaks the **plugin command** namespace, not
the tool namespace: `src/rpc-policy.ts` derives it from each tool's `pluginCommand`.

**2. The bridge authenticates in both directions.** Every route refuses a request
carrying an `Origin`, requires a loopback `Host`, requires `application/json`, and
requires a bearer token — with one deliberate exception: `/health` is two-tier, and
serves liveness without a token while keeping the connection diagnosis behind it.

The token is **persisted** at `$CUBES_MCP_HOME/token` (0600), created on first run
and printed to stderr that once, so the value the user pastes into the Studio panel
survives a restart. It used to be regenerated per run, which was not a security
property: the protocol has no token handoff and a plugin cannot read files, so the
human was the courier and a 401 was the reward for missing a step.
`CUBES_MCP_TOKEN` overrides it and is never written to disk.

`CUBES_MCP_ALLOW_UNAUTHENTICATED=1` exists for older plugins. It **forces writes
off**: without a token the *Allow writes* toggle can be forged by anything that can
post to `/poll`, so in that mode the toggle is not believed at all and write-class
commands are refused however the panel is set. The hatch buys reads. (The forgery
itself is closed — this note used to say it was re-opened, which stopped being true
when the mode started forcing writes off.)

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
- `src/registry.ts` — `capabilities()`, `outputSchemaFor()`, the tool constructors, `luaJson`.
- `src/docs.ts` — the cached Roblox API dump behind the `docs_*` tools.
- `src/paths.ts` — every on-disk location, resolved lazily (`CUBES_MCP_HOME`).
- `docs/PLUGIN-PROTOCOL.md` — what the Studio half has to implement, since it isn't here.
- `docs/CONFIGURATION.md` — every environment variable. `SECURITY.md` — the threat model.
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
- The visible tool set is **grow-only**. Nothing is ever evicted, because every change to
  `tools/list` invalidates the prompt cache for that turn. Don't add eviction back; see
  `PLAN.md` Part 1 and `test/bench/tool-churn.mjs`.
- The tool catalog is on a **budget** (`test/unit/catalog-budget.test.mjs`). A new tool has
  to fit the mean, so adding one usually means trimming another's description.
- Unit tests never touch the network. The `docs_*` tools read a fixture
  (`test/unit/_fixtures.mjs`); CI sets `CUBES_MCP_OFFLINE=1` so a stray fetch fails the build.
