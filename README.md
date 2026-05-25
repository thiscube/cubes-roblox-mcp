# Cubes Roblox MCP

**A next-gen [MCP](https://modelcontextprotocol.io) server for Roblox Studio — cheap calls, smart server, full Studio surface.**

Most Roblox MCP servers make the same mistakes: every tool's schema is reloaded
every turn, reads dump full property tables, and writes are dumb one-shot RPC.
Cubes Roblox MCP treats the server as a *collaborator with memory* — five core
tools done well, a search-loaded registry of specialists, persistent per-place
memory, and progressive discovery that scales to dozens of tools without
inflating per-turn cost.

This repo contains the **TypeScript MCP server** only. The Studio plugin that
pairs with it (the other half of the architecture below) is distributed
separately.

---

## Highlights

- **Progressive tool loading** — the opening surface is five tools; specialists stay hidden until `search_tools` surfaces them OR context auto-unlocks them. Per-turn schema cost stays flat no matter how many tools exist.
- **Reference tokens & snapshot reads** — instances get short opaque IDs (`p3`, `f12`); re-reads pass a snapshot tag back and get `{ unchanged: true }` almost for free.
- **Atomic mutate batches** — submit a DAG of `create` / `set` / `delete` ops with `@id` references; the whole batch runs in one undo waypoint, with rollback on failure.
- **Inline lint** — every script write is Selene-linted server-side; diagnostics come back in the response so issues are caught before playtest.
- **Vision** — `screenshot` is a core tool that returns a PNG inline (full screen, Studio window, or cropped viewport) so the model can SEE its work, not just imagine it from bbox coordinates.
- **Per-place persistent memory** — `studio://project/profile` is a per-PlaceId JSON file that stores detected genre, style decisions, naming conventions, decisions log, and prior-session summaries. The cold-start problem dies: session N opens with the agent already knowing the project.
- **Tool catalog as a resource** — one read of `studio://tools/catalog` returns the entire specialist index by category, killing blind `search_tools` queries.
- **Context-aware auto-unlock** — touching a Part auto-surfaces `instance_duplicate`/`parts_grid`; doing a viewport read auto-surfaces `debug_highlight`; starting a playtest auto-surfaces `tune`/`playtest_stop`. No round-trip needed.
- **Smarter `next_likely`** — every response carries up to 3 ranked follow-up suggestions with `args` pre-filled (verify the write, screenshot the visual change, snapshot for cheap rollback, diff against the snapshot you just took).
- **Session memory** — tool-call history, macros, snapshots, and cost accounting, all exposed as `studio://` resources.
- **Roblox surface** — structured error/playtest stream, vision-grounded viewport capture, snapshot/diff for place-level version control, live playtest tuning, a TestEZ runner, and Rojo source-map annotation.

### Why it's cheap

Rough numbers for a 30-turn session doing real work:

| | Typical Roblox MCP | Cubes Roblox MCP |
|---|---:|---:|
| Tool schemas / request | ~15k tokens | ~1.2k tokens |
| Average read response | ~3k tokens | ~400 tokens |
| Re-reads (snapshot hits) | full cost | ~50 tokens each |

The biggest wins are progressive tool loading, snapshot reads, and the catalog
resource that lets the model see everything available in one shot.

---

## Architecture

Roblox Studio plugins can't open sockets — but they *can* make outbound HTTP
requests to localhost. So the plugin is a long-polling **client** of the
server's HTTP bridge. The server has two faces: stdio (the MCP protocol, to the
model's client) and a localhost HTTP server (the bridge, to the Studio plugin).

```
  Claude / MCP client          cubes-roblox-mcp                 Roblox Studio
  ┌──────────────────┐         ┌──────────────────┐             ┌──────────────────┐
  │  the model picks │  stdio  │   MCP layer      │ HTTP long-  │  CubesMCP plugin │
  │  & calls tools   │◄───────►│   + HTTP bridge  │ poll :44820 │  (separate)      │
  │                  │ JSON-RPC│                  │◄───────────►│  reads / writes  │
  └──────────────────┘         └──────────────────┘             │  the DataModel   │
                                                                └──────────────────┘
```

Each turn: the model calls a tool → the MCP server queues a command → the
plugin's next long-poll picks it up, runs it in Studio, and posts the result
back → the server resolves the tool call. Specialists run through this same
path; the server just generates the Luau or mutate batch.

---

## The opening surface

On connect, the agent sees exactly **five core tools**:

| Tool | Purpose |
|---|---|
| `search_tools` | Discover specialist tools by plain-language intent. Matches are unlocked into the live tool list. |
| `read` | Universal read — by ref, path, or selector query. Property projection, response shapes, pagination, snapshots, vision-grounded viewport mode. |
| `screenshot` | Capture a PNG of the screen / Studio window / cropped viewport, returned inline as an image block. The model literally sees what's on screen. |
| `mutate` | Universal write — an ordered DAG of `create` / `set` / `delete` ops, atomic, with a diff response and inline lint. |
| `run_code` | Code-mode escape hatch — arbitrary Luau in plugin context with a preloaded `__MCP` helper table. Prefer this over many `mutate` calls when you need 3+ ops in a row. |

Plus **eight resources** the agent can read without spending a tool call:

| Resource | What's inside |
|---|---|
| `studio://overview` | PlaceId, place name, service child counts, current selection, recent error count — read first to orient. |
| `studio://tools/catalog` | Full specialist tool index by category. One read = knowing everything available. |
| `studio://project/profile` | Per-place persistent memory: genre, style decisions, naming conventions, decisions log, known issues, prior-session summaries. |
| `studio://session/history` | Tool-call history (this session). |
| `studio://session/macros` | Saved macros, replayable. |
| `studio://session/snapshots` | DataModel snapshots captured this session. |
| `studio://selection` | What's selected in Studio right now. |
| `studio://errors/recent` | Recent script errors / playtest output, from the plugin's ring buffer. |

Everything else — `lighting_configure`, `instance_duplicate`, `script_create`,
`macro_save`, `snapshot`, `diff`, `profile_update`, `test_run`, `tune`, … —
lives in a search-loaded registry. Many are also auto-unlocked when context
implies they're the next step (touching a Part unlocks `instance_duplicate`,
starting a playtest unlocks `tune`, etc.).

---

## Setup

### Prerequisites

- **Node.js 18+**
- **Roblox Studio**
- **The CubesMCP Studio plugin** — the other half of the architecture diagram
  above. The plugin is distributed separately from this repo. Drop the built
  `.rbxm` into your local Studio plugins folder
  (`%LOCALAPPDATA%\Roblox\Plugins` on Windows,
  `~/Documents/Roblox/Plugins` on macOS) and restart Studio.

### 1 — Install + build the MCP server

```bash
git clone https://github.com/cubebented/cubes-roblox-mcp.git
cd cubes-roblox-mcp
npm install
npm run build
```

### 2 — Register the server with an MCP client

For Claude Desktop, add to `claude_desktop_config.json`:

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

For Claude Code:

```bash
claude mcp add cubes-roblox -- node "C:/path/to/cubes-roblox-mcp/dist/index.js"
```

Then open a place in Studio, ensure the CubesMCP plugin is loaded (a "Cubes MCP"
toolbar button appears), and you're connected. The plugin auto-connects to the
bridge on `127.0.0.1:44820`.

#### Custom port

Both halves default to `127.0.0.1:44820`. Override on the server with
`CUBES_MCP_PORT=44821 node dist/index.js`, and on the plugin via the port input
in the status panel — both sides have to agree.

#### Optional: Rojo source map

Set `CUBES_MCP_SOURCEMAP=/path/to/sourcemap.json` (or leave unset and the
server autodetects `sourcemap.json` next to your `default.project.json`). When
loaded, the server annotates script `read` results with their on-disk
`source_file`, so the agent can correlate Studio scripts with their Rojo
source.

---

## Usage

The **Studio status panel** (the toolbar button) shows connection state, the
host it's polling, commands handled, recent activity, a **Visual debug** toggle
(turn on the live-activity HUD), and pause / connect / disconnect controls.

**Writes are always-on** in this build. Destructive batches — deleting
instances, overwriting script source — still need an explicit `confirm: true`.
Without it `mutate` returns a `needs_confirmation` error carrying the exact
retry payload.

---

## Testing

```bash
npm run test:e2e     # scripted end-to-end suite — run with Studio open
npm run test:repl    # interactive prompt for poking individual calls
```

The harness spawns the server (so the Studio plugin connects to *it*),
completes the MCP handshake, then walks reads, writes, inline lint, search,
resources, and viewport grounding — printing PASS / FAIL while the place
changes in Studio.

---

## Project layout

```
src/                    the MCP server (TypeScript / Node)
  index.ts              entry — wires the stdio transport + HTTP bridge
  bridge.ts             HTTP long-poll bridge to the Studio plugin
  protocol.ts           wire-protocol version (server <-> plugin handshake)
  server.ts             MCP server + core tool handlers + resource handlers
  registry.ts           specialist tool registry + BM25 search
  seed.ts               seed specialist tools
  pro.ts                second-wave specialist tools — terrain, audio, physics
  vision.ts             screenshot + viewport-capture tools
  session.ts            active tool set, sticky context, turn-based eviction
  memory.ts             tool-call history log + macro + snapshot store
  profile.ts            per-place persistent profile (~/.cubesmcp/profiles/)
  snapshot-diff.ts      delta engine behind the diff specialist
  lint.ts               Selene lint of script writes
  safety.ts             destructiveness classification
  suggest.ts            suggested-next-call ranker
  sourcemap.ts          Rojo source-map lookup

test/                   end-to-end harness + scripted build probes
DESIGN.md               the full design doc this is built to
```

The Studio plugin (the Luau half) is distributed separately and is not part
of this repo.

---

## Roadmap

All five phases of [DESIGN.md](DESIGN.md) are implemented, plus the
post-design memory + discovery wave:

| Phase | Delivered |
|---|---|
| **1 — the bones** | reference tokens, ETag reads, progressive tool loading, atomic undo waypoints, the HTTP bridge |
| **2 — read/write quality** | inline Selene lint on script writes, relevance-ranked pagination, a richer selector query language |
| **3 — session memory** | `studio://` resources, tool-call history, macros, snapshots, per-response cost accounting |
| **4 — safety + intelligence** | confirm-before-destructive levels, suggested-next-call, predictive prefetch |
| **5 — Roblox surface** | structured error/playtest stream, vision-grounded viewport capture + inline screenshot, TestEZ runner, Rojo source map, snapshot/diff for place version control, live playtest tuning |
| **6 — memory + discovery** | per-place project profile, `studio://tools/catalog`, context-aware auto-unlock, screenshot as core tool, smarter pre-filled `next_likely` |

Open territory: full MCP **Elicitation** (server asks the user mid-tool-call)
and **Sampling** (server invokes the client LLM as a sub-agent), an
`studio://api-dump` resource, server-pushed error/progress notifications, and
genre auto-detection on session start. See [DESIGN.md](DESIGN.md) for the full
design rationale, the layered architecture, and prior art.
