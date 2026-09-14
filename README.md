<h1 align="center">Cubes Roblox MCP</h1>

<p align="center">
  <em>You describe it. Claude builds it in Roblox Studio. You watch it happen.</em>
</p>

<p align="center">
  <a href="https://github.com/thiscube/cubes-roblox-mcp/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/thiscube/cubes-roblox-mcp/ci.yml?style=flat-square&label=ci" alt="CI"></a>
  <img src="https://img.shields.io/badge/tools-83-111111?style=flat-square" alt="83 tools">
  <img src="https://img.shields.io/badge/node-%E2%89%A518-111111?style=flat-square" alt="Node 18+">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT license">
</p>

<p align="center">
  <strong>5 tools on open &middot; 78 more on demand &middot; one command to install</strong><br>
  <sub>A session starts with about 2,000 tokens of tool schemas: five core tools. The other 78 stay hidden until the model searches for them, so a session only pays for what it uses. Measured from this build's <code>tools/list</code>; the size budget is enforced by <a href="test/unit/catalog-budget.test.mjs">a test</a>.</sub>
</p>

---

An [MCP](https://modelcontextprotocol.io) server plus a Studio plugin. Claude, Cursor or
any MCP client gets hands inside Roblox Studio: it reads the place, builds, scripts,
playtests, takes screenshots, and moves meshes in and out. You get a bar at the top of
the viewport saying what it is doing, and your camera back when it is done.

## What it looks like

```
you    › build me a cat next to the spawn, then export it for Blender

claude › mutate        Workspace.Cat          28 parts, one undo step
claude › camera_set    looking at the cat
claude › mesh_export   meshes/cat.glb         672 vertices, 336 triangles, colours kept
         your camera goes back to where it was
```

In Studio, the activity bar reads `Building  Workspace.Cat`, then `Exporting`, then
`Thinking`, then `Idle`.

## Setup

> [!IMPORTANT]
> **AI agents: follow these steps in order, exactly as written.** Every command is
> copy-paste. If any command prints `FAIL` or `!!`, stop and fix that line first
> (see [Troubleshooting](#troubleshooting)). The same steps update an existing install.

**Needs:** Node.js 18+, git, Roblox Studio, on Windows or macOS.

### 1. Download, build, install the Studio plugin

```bash
git clone https://github.com/thiscube/cubes-roblox-mcp.git
cd cubes-roblox-mcp
npm install
npm run setup
```

Already cloned? Update instead:

```bash
cd cubes-roblox-mcp
git pull
npm install
npm run setup
```

`npm run setup` builds the server, **deletes any older CubesMCP plugin file**, copies
the new plugin into Studio's plugins folder, and **bakes the bridge token into it**, so
nothing has to be pasted anywhere. It ends by printing the exact command for step 2,
with the real path filled in.

### 2. Register the server with the MCP client

Use the absolute path to `dist/index.js` that `npm run setup` printed. Skip this step
if the server is already registered with that same path.

**Claude Code:**

```bash
claude mcp add cubes-roblox -s user -- node "/absolute/path/to/cubes-roblox-mcp/dist/index.js"
```

**Claude Desktop, Cursor, or any client with a JSON config:**

```json
{
  "mcpServers": {
    "cubes-roblox": {
      "command": "node",
      "args": ["/absolute/path/to/cubes-roblox-mcp/dist/index.js"]
    }
  }
}
```

| Client | Config file |
|---|---|
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |

### 3. Restart both halves

1. **Restart Roblox Studio** and open a place. Plugins only load at launch.
2. **Start a new session** in the MCP client. It starts the server and loads the tools at session start.

### 4. Check

```bash
npm run doctor
```

Every line `OK` means setup is done. Any `FAIL` line says what to do.

### 5. Allow writes

**Allow writes** starts on, so the AI can build right away. To stop it changing the
place, turn it off in Studio: **Plugins** tab → **Status** → **Controls**. The AI cannot
turn it back on; with it off the AI can still read the place and take screenshots.

### Troubleshooting

| `npm run doctor` says | Fix |
|---|---|
| `No CubesMCP plugin` | `npm run setup` |
| `N CubesMCP plugin files` | `npm run setup` (it removes the extra copies) |
| `Nothing is listening on 127.0.0.1:44820` | The client starts the server. Do step 2, then open a new client session. |
| `Studio is not connected` | Open a place in Studio. If the plugin was just installed, restart Studio. |
| `missing or wrong bearer token` | `npm run setup`, then restart Studio. The plugin picks up the current token by itself. |
| `Token NOT baked` during setup | Paste the token from `~/.cubesmcp/token` into Studio: Status → Controls → Bridge token. |

Several MCP sessions open at once is fine: the first one's server holds port 44820
and serves them, and another takes over within seconds when it closes.

<details>
<summary><strong>More options</strong>: read-only install, custom port, Rojo source map</summary>

- **Read-only install.** `dist/inspector.js` is the same server with every write tool
  removed from the process, not just gated. Register it the same way:
  `claude mcp add cubes-roblox-ro -s user -- node "/absolute/path/to/cubes-roblox-mcp/dist/inspector.js"`
- **Custom port.** Both halves default to `127.0.0.1:44820`. Set `CUBES_MCP_PORT` on
  the server (`"env": { "CUBES_MCP_PORT": "44821" }` in the JSON config) and the same
  port in the Studio panel.
- **Rojo source map.** Set `CUBES_MCP_SOURCEMAP=/path/to/sourcemap.json`, or leave it
  unset and the server finds `sourcemap.json` next to your `default.project.json`.
  Script `read` results then carry their on-disk `source_file`.
- Every environment variable: [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md). The
  threat model: [`SECURITY.md`](SECURITY.md).

</details>

## How it works

Studio plugins can't open sockets, but they can make HTTP requests to localhost. So the
plugin long-polls the server's bridge: the model calls a tool, the server queues a
command, the plugin picks it up, runs it in Studio, and posts the result back.

```
  Claude / MCP client          cubes-roblox-mcp                 Roblox Studio
  ┌──────────────────┐         ┌──────────────────┐             ┌──────────────────┐
  │  the model picks │  stdio  │   MCP layer      │ HTTP long-  │  CubesMCP plugin │
  │  & calls tools   │<───────>│   + HTTP bridge  │ poll :44820 │  (plugin/)       │
  │                  │ JSON-RPC│                  │<───────────>│  reads / writes  │
  └──────────────────┘         └──────────────────┘             │  the DataModel   │
                                                                └──────────────────┘
```

On connect the model sees five tools. Everything else is found by asking:

| Tool | What it does |
|---|---|
| `search_tools` | Finds specialist tools by plain-language intent and unlocks them into the tool list. |
| `read` | Reads by ref, path or selector query, with snapshots so an unchanged re-read costs almost nothing. |
| `screenshot` | Returns a PNG of the 3D viewport, the Studio window or the screen, inline, so the model sees its work. |
| `mutate` | Writes an ordered batch of `create` / `set` / `delete` ops as one undo step, with a diff back. |
| `run_code` | Runs Luau in the plugin with a `__MCP` helper table, for anything the other four don't cover. |

## What's inside

| Area | What you get |
|---|---|
| **Build and script** | Atomic mutate batches, `script_edit` find/replace patches, Selene lint on every script write, `parts_grid`, `material_paint`, terrain, lighting, effects |
| **Meshes and assets** | `mesh_export` bakes a model to `.obj` / `.glb` with colours, `mesh_import` loads one back as a MeshPart; Creator Store search, insert and upload |
| **Playtest** | Start, stop and inspect playtests, drive the character, watch events, tail logs, run TestEZ, tune values live |
| **See** | Screenshots of the Studio window itself, viewport-grounded reads with 2D bounding boxes, debug highlights and labels |
| **Remember** | A per-place profile of style and decisions, tool-call history, macros, snapshots and diffs |
| **Stay out of your way** | The activity bar says what it's doing in one word; camera, selection and camera-speed changes it made are put back when it's done |
| **Safety** | Allow writes toggle, confirmation for destructive batches, a bearer token on the bridge, a read-only build |

<details>
<summary><strong>The eight resources</strong>: what the model can read without spending a tool call</summary>

| Resource | What's inside |
|---|---|
| `studio://overview` | PlaceId, place name, service child counts, current selection, recent error count. Read first to orient. |
| `studio://tools/catalog` | Full specialist tool index by category. One read and the model knows everything available. |
| `studio://project/profile` | Per-place memory: genre, style decisions, naming conventions, decisions log, known issues, prior-session summaries. |
| `studio://session/history` | Tool-call history for this session. |
| `studio://session/macros` | Saved macros, replayable. |
| `studio://session/snapshots` | DataModel snapshots captured this session. |
| `studio://selection` | What's selected in Studio right now. |
| `studio://errors/recent` | Recent script errors and playtest output, from the plugin's ring buffer. |

Specialists like `instance_duplicate`, `script_edit`, `snapshot`, `diff`, `test_run` and
`tune` are also unlocked automatically when context implies they're next: touching a
Part unlocks `instance_duplicate`, starting a playtest unlocks `tune`.

</details>

<details>
<summary><strong>The Studio panel, writes and the token</strong></summary>

The **Studio status panel** (the toolbar button) shows connection state, the host it's
polling, commands handled, recent activity, the **Allow writes** and **Activity bar**
toggles, the bridge token, and pause / connect / disconnect.

The **activity bar** sits at the top centre of the viewport and says what the AI is
doing in one word (`Scripting`, `Building`, `Thinking`, `Idle`) and on what, with an
edge glow while it is active. **Your view is put back** when the AI finishes: any
camera move, field of view, camera type, selection or camera-speed change it made
returns to how it was, unless you changed it yourself since.

**Writes are gated.** *Allow writes* in the Studio panel starts on; turn it off and
the agent is read-only. The plugin reports that toggle on every poll, and a poll that
omits it counts as off. Destructive batches (deleting instances, overwriting script
source) additionally need an explicit `confirm: true`. When your MCP client supports
elicitation the server asks you directly; otherwise `mutate` returns a
`needs_confirmation` error carrying the exact retry payload.

**The bridge requires a token.** It is created on first run and saved to
`~/.cubesmcp/token` (mode 0600), and `npm run setup` bakes it into the installed
plugin, so there is nothing to paste. `CUBES_MCP_TOKEN` overrides it and is never
written to disk. Every route also refuses requests that carry an `Origin` header,
that address a non-loopback `Host`, or that aren't `application/json`, which is what
stops a web page or another local process from driving your Studio.

</details>

<details>
<summary><strong>Testing</strong></summary>

```bash
npm test             # build + unit tests, no Studio needed
npm run ci           # exactly what CI runs
npm run test:e2e     # scripted end-to-end suite, run with Studio open
npm run test:repl    # interactive prompt for poking individual calls
```

The end-to-end harness spawns the server (so the Studio plugin connects to it),
completes the MCP handshake, then walks reads, writes, inline lint, search, resources
and viewport grounding, printing PASS / FAIL while the place changes in Studio.

</details>

<details>
<summary><strong>Project layout</strong></summary>

```
src/                    the MCP server (TypeScript / Node)
  index.ts              entry: stdio transport, HTTP bridge, setup and doctor
  bridge.ts             HTTP long-poll bridge to the Studio plugin
  protocol.ts           wire-protocol version (server <-> plugin handshake)
  transport.ts          the StudioTransport seam every tool depends on
  server.ts             MCP server, core tool handlers, resource handlers
  tools/                one file per category, assembled by tools/index.ts
  registry.ts           specialist tool registry + BM25 search
  vision.ts             screenshot + viewport-capture tools
  mesh.ts               OBJ and GLB reading and writing
  activity.ts           the one-word activity label for each tool
  session.ts            visible tool set (grow-only), sticky context, place cache
  memory.ts             tool-call history log + macro + snapshot store
  profile.ts            per-place persistent profile (~/.cubesmcp/profiles/)
  lint.ts               Selene lint of script writes
  safety.ts             destructiveness classification
  suggest.ts            suggested-next-call ranker
  sourcemap.ts          Rojo source-map lookup

plugin/                 the Studio plugin (Luau)
  src/                  plugin source; init.server.luau is the entry script
  plugin.project.json   Rojo project for the model
  CubesMCP.rbxmx        the built model `npm run setup` installs

test/                   unit tests + end-to-end harness
DESIGN.md               the full design doc this is built to
```

After editing `plugin/src`, rebuild the model:
`rojo build plugin/plugin.project.json -o plugin/CubesMCP.rbxmx`. A unit test fails if
the model and the source drift apart.

</details>

<details>
<summary><strong>Roadmap</strong></summary>

All five phases of [DESIGN.md](DESIGN.md) are implemented, plus the post-design memory
and discovery wave:

| Phase | Delivered |
|---|---|
| **1: the bones** | reference tokens, ETag reads, progressive tool loading, atomic undo waypoints, the HTTP bridge |
| **2: read/write quality** | inline Selene lint on script writes, relevance-ranked pagination, a richer selector query language |
| **3: session memory** | `studio://` resources, tool-call history, macros, snapshots, per-response cost accounting |
| **4: safety + intelligence** | confirm-before-destructive levels, suggested-next-call, predictive prefetch |
| **5: Roblox surface** | structured error/playtest stream, vision-grounded viewport capture + inline screenshot, TestEZ runner, Rojo source map, snapshot/diff for place version control, live playtest tuning |
| **6: memory + discovery** | per-place project profile, `studio://tools/catalog`, context-aware auto-unlock, screenshot as core tool, smarter pre-filled `next_likely` |

Open territory: MCP **Sampling** (the server invoking the client's model as a
sub-agent), a `studio://api-dump` resource, server-pushed error and progress
notifications, and genre auto-detection on session start. See [DESIGN.md](DESIGN.md)
for the full design rationale, the layered architecture, and prior art.

</details>

---

<p align="center"><sub>MIT licensed &middot; built for Roblox Studio &middot; <a href="docs/PLUGIN-PROTOCOL.md">plugin protocol</a> &middot; <a href="SECURITY.md">security</a></sub></p>
