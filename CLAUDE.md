# Cubes Roblox MCP — orientation for AI agents

A Model Context Protocol server that lets Claude (or any MCP client) drive Roblox Studio.
GitHub: https://github.com/cubebented/cubes-roblox-mcp

## What this repo is

Two halves that only talk over `http://localhost:44820`:

- `src/` — Node/TypeScript MCP server. Stdio to the MCP client, HTTP bridge to the plugin.
- `roblox/` — Rojo project for the Studio plugin (Luau). Long-polls the bridge.

Don't conflate them: when you edit `src/`, rebuild the server; when you edit `roblox/src/`, rebuild the plugin. They're decoupled by design.

## How to run it

**MCP server** (rebuild after any `src/` change):
```
npm run build
```
The server is invoked by the MCP client over stdio — don't run `node dist/index.js` manually unless you hold stdin open (`node dist/index.js < <(sleep 86400)`).

**Studio plugin** (rebuild after any `roblox/src/` change):
```
cd roblox
rojo build plugin.project.json -o "$env:LOCALAPPDATA/Roblox/Plugins/CubesMCP.rbxm"   # PowerShell
rojo build plugin.project.json -o "C:/Users/<you>/AppData/Local/Roblox/Plugins/CubesMCP.rbxm"   # Bash
```
Keep exactly one `CubesMCP.*` file in the plugins folder. Two will fight over port 44820.

**The two-restart gotcha after either rebuild:**
1. Restart Roblox Studio (plugins are cached at launch).
2. Restart the Claude Code / MCP client session (tool schemas are loaded at session start).

## Talking to a running bridge without MCP

When the MCP tools aren't loaded in the current session (e.g. you're in a worktree), use the bridge's debug `/rpc` endpoint directly:

```bash
curl -s http://127.0.0.1:44820/health
curl -s -X POST http://127.0.0.1:44820/rpc \
  -H "Content-Type: application/json" \
  -d '{"tool":"read","args":{"path":"Workspace","children":true}}'
```

Write-class tools (`mutate`, `eval`) require the user's *Allow writes* toggle in the panel, OR `CUBES_MCP_RPC_TOKEN` env var + `?token=` query param.

## Where to look

- `README.md` — human-facing overview, full setup, project layout, architecture diagram.
- `DESIGN.md` — the design doc this is built to. Five-phase plan, all five implemented.
- `src/seed.ts` — every specialist tool (search-loaded, hidden until `search_tools` surfaces them).
- `src/server.ts` — the four always-visible core tools (`search_tools`, `read`, `mutate`, `run_code`).
- `roblox/src/Transport.luau` — plugin dispatch table; native plugin tools live here.
- `roblox/src/StatusUi.luau` — the Studio panel UI.

## Things that bite

- Editing `src/` in a worktree builds to the worktree's `dist/`, but the MCP client points to the main project's `dist/`. Either edit in the main project, or rebuild there after merging.
- Refs (`p3`, `f12`, `s7`) are session-scoped. If the plugin reloads, old refs die — fall back to dotted paths (`Workspace.Foo.Bar`).
- The plugin auto-connects on load and persists the *Allow writes* toggle, custom port, and panel visibility across reloads.
- Port can be customized from the panel; the server must run with matching `CUBES_MCP_PORT` env var.
