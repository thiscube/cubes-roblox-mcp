# Cubes Roblox MCP

**A next-gen [MCP](https://modelcontextprotocol.io) server for Roblox Studio — cheap calls, smart server, full Studio surface.**

Most Roblox MCP servers make the same mistakes: every tool's schema is reloaded
every turn, reads dump full property tables, and writes are dumb one-shot RPC.
Cubes Roblox MCP treats the server as a *collaborator with memory* — two core
tools done well, a search-loaded registry of specialists, a session that
remembers, and a permission model that scopes everything.

Built end-to-end to the design in **[DESIGN.md](DESIGN.md)** — all five phases.

---

## Highlights

- **Progressive tool loading** — the opening surface is just four tools; specialist tools stay hidden until `search_tools` surfaces them, so per-turn schema cost stays flat no matter how many exist.
- **Reference tokens & snapshot reads** — instances get short opaque IDs (`p3`, `f12`); re-reads pass a snapshot tag back and get `{ unchanged: true }` almost for free.
- **Atomic mutate batches** — submit a DAG of `create` / `set` / `delete` ops with `@id` references; the whole batch runs in one undo waypoint, with rollback on failure.
- **Inline lint** — every script write is Selene-linted server-side; diagnostics come back in the response so issues are caught before playtest.
- **Relevance-ranked reads** — results are ordered recently-modified › selected-in-Studio › sticky-class › name, so the first page is the useful page.
- **Session memory** — tool-call history, macros, and cost accounting, all exposed as `studio://` resources.
- **Safety** — read-only by default; writes are gated behind a toggle in the Studio panel, and destructive batches need explicit confirmation.
- **Roblox surface** — structured error/playtest stream, vision-grounded viewport capture, a TestEZ runner, and Rojo source-map annotation.

### Why it's cheap

Rough numbers for a 30-turn session doing real work:

| | Typical Roblox MCP | Cubes Roblox MCP |
|---|---:|---:|
| Tool schemas / request | ~15k tokens | ~1k tokens |
| Average read response | ~3k tokens | ~400 tokens |
| Re-reads (snapshot hits) | full cost | ~50 tokens each |

The biggest wins are progressive tool loading and snapshot reads; everything else compounds on top.

---

## Architecture

Roblox Studio plugins can't open sockets — but they *can* make outbound HTTP
requests to localhost. So the plugin is a long-polling **client** of the
server's HTTP bridge. The server has two faces: stdio (the MCP protocol, to the
model's client) and a localhost HTTP server (the bridge, to the Studio plugin).

```
  Claude / MCP client          cube's mcp server              Roblox Studio
  ┌──────────────────┐         ┌──────────────────┐           ┌──────────────────┐
  │  the model picks │  stdio  │   MCP layer      │ HTTP long- │  CubesMCP plugin │
  │  & calls tools   │◄───────►│   + HTTP bridge  │ poll :44820│  (Luau)          │
  │                  │ JSON-RPC│                  │◄──────────►│  reads / writes  │
  └──────────────────┘         └──────────────────┘            │  the DataModel   │
                                                               └──────────────────┘
```

Each turn: the model calls a tool → the MCP server queues a command → the
plugin's next long-poll picks it up, runs it in Studio, and posts the result
back → the server resolves the tool call.

---

## The opening surface

On connect, the agent sees exactly four tools:

| Tool | Purpose |
|---|---|
| `search_tools` | Discover specialist tools by plain-language intent. Matches are unlocked into the live tool list. |
| `read` | Universal read — by ref, path, or selector query. Property projection, response shapes, pagination, snapshots. |
| `mutate` | Universal write — an ordered DAG of `create` / `set` / `delete` ops, atomic, with a diff response and inline lint. |
| `run_code` | Escape hatch — arbitrary Luau in plugin context, with a preloaded `__MCP` helper table in scope. |

Plus four resources the agent can read without spending a tool call:
`studio://session/history`, `studio://session/macros`, `studio://selection`,
`studio://errors/recent`.

Everything else — `lighting_configure`, `instance_duplicate`, `script_create`,
`macro_save`, `test_run`, … — lives in a search-loaded registry.

---

## Setup

### Prerequisites

- **Node.js 18+**
- **Roblox Studio**
- **Rojo 7.x** — to build the Studio plugin. This repo pins it (and `selene`) via
  [rokit](https://github.com/rojo-rbx/rokit) in `roblox/rokit.toml`. Install rokit
  once, or use your own Rojo install.

### 1 — The MCP server

```bash
git clone https://github.com/cubebented/cubes-roblox-mcp.git
cd cubes-roblox-mcp
npm install
npm run build
```

### 2 — The Studio plugin

The plugin lives in `roblox/` as a self-contained Rojo project. Build it straight
into your local Studio plugins folder:

```powershell
cd roblox
rokit install   # downloads the pinned Rojo + Selene
rojo build plugin.project.json -o "$env:LOCALAPPDATA\Roblox\Plugins\CubesMCP.rbxm"
```

On macOS the plugins folder is `~/Documents/Roblox/Plugins`. Restart Studio — a
**Cubes MCP** button appears in the Plugins tab; click it for the status panel.

> For live plugin development instead of a one-off build:
> `rojo build plugin.project.json -o "<plugins folder>/CubesMCP.rbxm" --watch`
> rebuilds on every save, or `rojo serve` syncs the source into Studio.

### 3 — Connect an MCP client

Register the server with your MCP client. For Claude Desktop, add to
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cubes-roblox": {
      "command": "node",
      "args": ["C:/path/to/cubes-roblox-mcp/dist/index.js"]
    }
  }
}
```

Then open a place in Studio, open the Cubes MCP panel, and you're connected.

---

## Usage

The **status panel** (the toolbar button) shows the connection state, the host
it's polling, commands handled, recent activity, and an **Allow writes** toggle.

- The server is **read-only by default** — `mutate`, `run_code`, and any write
  specialist are rejected with `write_mode_disabled` until you flip *Allow writes*
  on in the panel. This is the read/write split: enabling writes is a deliberate
  act in the client UI.
- **Destructive batches** — deleting instances, overwriting script source — need
  an explicit `confirm: true`. Without it `mutate` returns a `needs_confirmation`
  error carrying the exact retry.

---

## Testing

```bash
npm run test:e2e     # scripted end-to-end suite — run with Studio open
npm run test:repl    # interactive prompt for poking individual calls
```

The harness spawns the server (so the Studio plugin connects to *it*), completes
the MCP handshake, then walks reads, writes, inline lint, search, resources, and
viewport grounding — printing PASS / FAIL while the place changes in Studio. Flip
*Allow writes* on first, or the write checks skip themselves.

---

## Project layout

```
src/                     the MCP server (TypeScript / Node)
  index.ts               entry — wires the stdio transport + HTTP bridge
  bridge.ts              HTTP long-poll bridge to the Studio plugin
  server.ts              MCP server + the four core tool handlers
  registry.ts            specialist tool registry + BM25 search
  seed.ts                seed specialist tools
  session.ts             active tool set, sticky context, turn-based eviction
  memory.ts              tool-call history log + macro store
  lint.ts                Selene lint of script writes
  safety.ts              destructiveness classification
  suggest.ts             suggested-next-call
  sourcemap.ts           Rojo source-map lookup

roblox/                  a SEPARATE Rojo project — the Studio plugin (Luau)
  src/                   12 modules: Transport, Read, Mutate, Query, Refs,
                         Serialize, SessionState, Diagnostics, Viewport, …
  plugin.project.json    build target — the publishable .rbxm
  default.project.json   rojo serve target
  rokit.toml             pins Rojo + Selene

test/harness.mjs         the end-to-end test harness
DESIGN.md                the full design doc this is built to
```

The two halves — `src/` (the Node server) and `roblox/` (the Luau plugin) —
intentionally don't reference each other. They only ever talk over the HTTP
bridge on `127.0.0.1:44820`.

---

## Roadmap

All five phases of [DESIGN.md](DESIGN.md) are implemented:

| Phase | Delivered |
|---|---|
| **1 — the bones** | reference tokens, ETag reads, progressive tool loading, atomic undo waypoints, the HTTP bridge + Studio plugin |
| **2 — read/write quality** | inline Selene lint on script writes, relevance-ranked pagination, a richer selector query language |
| **3 — session memory** | `studio://` resources, tool-call history, macros, per-response cost accounting |
| **4 — safety + intelligence** | read/write split, confirm-before-destructive levels, suggested-next-call, predictive prefetch |
| **5 — Roblox surface** | structured error/playtest stream, vision-grounded viewport capture, TestEZ runner, Rojo source map |

Deferred (the design doc treats Phase 5 as ongoing): raw screenshot pixel capture,
the Open Cloud asset pipeline, sub-agent dispatch, response streaming, hot reload,
and per-path permission scopes.

See [DESIGN.md](DESIGN.md) for the full design rationale, the layered architecture,
and prior art.
