# Roblox MCP — Design Notes

A next-gen MCP server for Roblox Studio. Built to make hundreds of tool calls cheap, keep the model smart, and cover Studio's full surface without ballooning the tool list.

This is a design document, not a tutorial. It assumes you've used MCP before and have read at least one existing Roblox MCP repo (boshyxd, WEPPY, the official Rust one).

---

## Thesis

Every shipping Roblox MCP makes the same mistakes:

1. Every tool's schema is loaded on every turn, so 50 tools = ~15k tokens of dead weight per request.
2. Reads dump full property tables, so a 500-instance scene burns the context window in one call.
3. Writes are one-shot RPC, no undo grouping, no validation, no learning.
4. The server is a dumb pipe — it never prefetches, summarizes, or suggests.

The fix isn't more tools. The fix is treating the server as a *collaborator with memory* and making the protocol between agent and Studio actually dense. Two tools done well beat fifty done shallow.

Three pillars guide every decision:

- **Cheap calls** — tokens are the constraint; design every response to be the smallest correct payload.
- **Smart server** — the server validates, prefetches, suggests, remembers. The agent does less work.
- **Full Studio surface** — exposed through a thin tool layer plus `run_code` as the universal escape hatch.

---

## Architecture in one sentence

Two primary tools (`read`, `mutate`), one escape hatch (`run_code`), a search-loaded registry of specialist tools, a session that remembers, and a permission model that scopes everything.

---

## Layer 1 — Addressing

Foundation. Every higher layer depends on this.

### Reference tokens

After first read, every instance gets a short opaque ID: `p3`, `f12`, `s7`. The agent never types full paths twice. Tokens survive renames and reparents.

```ts
type Ref = string; // "p3"

interface Resolved {
  ref: Ref;
  path: string;      // "Workspace.Lobby.SpawnPart"
  class_name: string;
  snapshot: string;  // see ETags below
}
```

Server keeps a per-session map of `ref → instance pointer`. On each tool call, resolve tokens to live instances. If the instance was destroyed, return a structured error: `{ error: "ref_dead", ref: "p3", last_seen_path: "..." }` — the agent learns what happened, doesn't crash.

### Snapshots / ETags

Every read returns a snapshot tag. Re-reads pass the tag back:

```ts
read({ ref: "p3" })                       // → { snapshot: "s_a91", data: {...} }
read({ ref: "p3", since: "s_a91" })       // → { snapshot: "s_a91", unchanged: true }
read({ ref: "p3", since: "s_a91" })       // → { snapshot: "s_a92", diff: { Color: ... } }
```

Snapshot = hash of the instance's serializable properties + child list. Cheap to compute, cheap to compare.

Iterative loops (read → mutate → re-read → check) become almost free.

### Resources with URIs

MCP has a "resources" concept almost nobody uses. Things the agent references constantly live at fixed URIs:

```
studio://selection             current Studio selection
studio://errors/recent         last N runtime errors
studio://api-dump              live API dump for current Studio version
studio://session/macros        macros saved this session
studio://session/history       tool call log
```

Resources are readable without a tool call — clients can fetch them directly. Cacheable on the client side. Use for anything the agent is going to want repeatedly.

---

## Layer 2 — Tool Discovery

Progressive loading. The agent only sees what it's asked for.

### The opening surface

On connect, the agent sees exactly these tools:

- `search_tools(query, intent?, limit?)`
- `read(...)` — universal read
- `mutate(...)` — universal write
- `run_code(luau)` — escape hatch

Everything else is hidden until searched.

### The registry

Every specialist tool registered with a uniform shape:

```ts
interface ToolEntry {
  name: string;                // "terrain_fill_region"
  category: Category;          // "terrain"
  subcategories: string[];     // ["fill", "voxel"]
  keywords: string[];          // ["hill", "mountain", "biome"]
  description: string;         // searchable prose
  schema: JSONSchema;
  handler: ToolHandler;
}
```

Categories (initial set):

```
instances     scripts        playtest      terrain
ui            animation      assets        physics
lighting      audio          camera        debug
```

### Search

Three layers, in order of how much to rely on them.

**Keyword (BM25).** Build a search blob per tool: `name + category + subcategories + keywords + description`. Score with a stock BM25 library (`minisearch` for Node, `tantivy` for Rust). Handles 80% of cases.

**Category boost.** If the query contains a category name verbatim, boost everything in that category by a fixed multiplier. "Make terrain hills" pulls all terrain tools up even if they don't mention "hills."

**Semantic (optional).** Embeddings as a tiebreaker. Skip in v1; revisit only after seeing real search misses.

### The intent hint

```ts
search_tools({
  query: "spawn enemies in a circle",
  intent: "building",  // optional
  limit: 5
})
```

`intent` biases scoring toward category clusters: `"building"` → instances + physics + terrain, `"debugging"` → scripts + playtest + debug, `"polishing"` → ui + lighting + audio. Two-line change in scoring, big quality jump.

### Activation flow

```
on search_tools(query):
    matches = score_catalog(query, intent, limit)
    for tool in matches:
        if tool.name not in session.active:
            session.active.add(tool.name)
            session.last_used[tool.name] = now
    notify_client("tools/list_changed")
    return {
      unlocked: matches.map(t => ({ name, description }))
    }
```

The agent gets a confirmation message naming what unlocked. Don't skip this — agents that don't see confirmation re-search.

### No auto-eviction

The original design evicted: idle for 10 turns, or over a cap of 8 specialists,
and the least-recently-used got dropped.

That is gone. `tools` renders first in the prompt-cache prefix, so every change
to the tool list invalidates the cache for that turn, and eviction guarantees the
list keeps changing forever. Measured over a 60-turn session
(`test/bench/tool-churn.mjs`): eviction changed the list on 33% of turns and was
still at 33% in the second half. Grow-only is 17% overall, 10% late, because once
a tool is visible it stays.

So the rule is one line: unlock, never drop. Fire `tools/list_changed` only when
the set actually grew.

### Safety net

If the agent calls a tool that's not in the active set (it remembered the name from earlier), auto-unlock it and proceed. Never reject for forgetting — it's strictly worse than just letting the call through.

---

## Layer 3 — Read Path

One tool, many shapes.

### Query language

CSS-selector or jq-style traversal in one call:

```ts
read({ query: "Workspace/**[ClassName=Part][BrickColor=Really red]" })
read({ query: "ServerScriptService/*[Source~=DataStore]" })
read({ ref: "f12", query: "*[ClassName=Script]" })
```

Replaces recursive `get_children` + filter loops. Server walks the tree once, returns matches.

### Property projection

```ts
read({ ref: "p3", select: ["Color", "Size", "Position"] })
```

Default is *small* — top ~5 most-relevant properties per class. Full dump requires explicit `select: "*"`. Saves tokens on the 99% case.

### Response shapes

Agent picks fidelity:

```ts
read({ ref: "f12", format: "names_only" })  // just child names
read({ ref: "f12", format: "summary" })     // names + class + 2 key props
read({ ref: "f12", format: "full" })        // everything
```

`names_only` for "what's in here?" — `summary` for picking targets — `full` for deep work.

### Pagination

Default limit: 20. Sorted by *relevance*:

1. Recently modified (this session)
2. Currently selected in Studio
3. Mentioned in recent agent messages (sticky context — see Layer 5)
4. Lexical order as fallback

Cursor returned for the rest. Agent rarely wants all 500 children of Workspace.

### Progressive output disclosure

Each instance in a read response:

```ts
{
  ref: "p3",
  path: "Workspace.Lobby.SpawnPart",
  class: "Part",
  props: { Color: "...", Size: "...", Position: "..." },
  expandable: ["physics:7", "appearance:4", "behavior:3"]
}
```

Agent calls `read({ ref: "p3", expand: "physics" })` to get the physics bucket. Average read shrinks ~10x.

### Predictive prefetch

When the agent reads, the server peeks at common follow-ups:

- Reading a script → bundle lint result + recent errors mentioning the script.
- Reading a UI element → bundle its layout container's properties.
- Reading a Part with a child Script → bundle the script's source.

Returned under a `prefetched` field. Agent uses it (free) or ignores it (cheap).

```ts
{
  data: {...},
  prefetched: {
    "lint:s7": [...],
    "errors:s7": [...]
  }
}
```

---

## Layer 4 — Write Path

One tool. Everything goes through it.

### Dependency-graph batches

Agent submits a DAG. Server orders and executes atomically.

```ts
mutate({
  ops: [
    { id: "a", op: "create", class: "Folder", parent: "@Workspace", name: "Lobby" },
    { id: "b", op: "create", class: "Part",   parent: "@a",         name: "Spawn" },
    { id: "c", op: "set",    target: "@b",    props: { Anchored: true } }
  ]
})
```

`@a` references the result of op `a`. Server topologically sorts, runs in order. If any op fails, the whole batch rolls back (Layer 4's undo waypoint covers this).

Beats flat `mass_create` which can't express "child of the thing I just made."

### Schema validation

Live API dump (from `studio://api-dump`) drives validation *before* commit:

```ts
mutate({ ops: [{ op: "set", target: "@b", props: { Color: [255, 0, 0] } }] })

// Server response:
{
  error: "schema_mismatch",
  op_id: "_",
  field: "Color",
  expected: "Color3",
  hint: "Try Color3.fromRGB(255, 0, 0)",
  suggested_op: { op: "set", target: "@b", props: { Color: "Color3.fromRGB(255,0,0)" } }
}
```

Catches type mistakes before they hit the DataModel. Suggested fix means the agent can retry without thinking.

### Atomic undo waypoints

Every `mutate` call wraps in a `ChangeHistoryService` waypoint:

```lua
ChangeHistoryService:SetWaypoint("AI: " .. session.id .. ":" .. turn)
-- run all ops
ChangeHistoryService:SetWaypoint("AI: " .. session.id .. ":" .. turn .. " end")
```

One Ctrl+Z undoes the whole turn. Optionally: one undo per *session* with `flatten_waypoints: true` in the session config.

This is the single biggest UX win. Ship it on day one.

### Inline lint + typecheck

Every script write returns Selene + Luau-LSP results in the response:

```ts
{
  applied: true,
  diff: {...},
  lint: {
    selene: [{ line: 12, code: "shadow", msg: "..." }],
    luau:   [{ line: 8,  code: "TypeMismatch", msg: "..." }]
  }
}
```

Agent fixes on next turn instead of waiting for playtest to discover the error.

### Diff response

Writes return what actually changed, not "ok":

```ts
{
  applied: true,
  changes: [
    { ref: "p3", added: ["BodyVelocity"], modified: ["Color"], removed: [] }
  ],
  waypoint: "AI:abc123:turn5"
}
```

Agent learns the actual outcome. Useful for "did my change have unintended ripples" checks.

---

## Layer 5 — Session State

The server has memory. The agent doesn't have to.

### Sticky context

Track what the agent is working on:

```ts
interface StickyContext {
  recent_folders: Ref[];        // weighted, decays over turns
  recent_classes: string[];     // ClassNames agent has touched
  recent_intent: string;        // last search's intent hint
}
```

Biases search ranking and prefetch. If you spent the last 5 turns in `Lobby`, terrain searches return *Lobby's* terrain first.

### Tool call history

Every call logged with inputs, outputs, timing:

```
studio://session/history       (resource)
```

Agent can read it to avoid re-doing work. Also drives macro extraction.

### Macros

Agent (or user) saves a sequence:

```ts
mutate({ macro_save: "npc_grid", from_history: { last_n: 12 } })
```

Replays with one call:

```ts
mutate({ macro_run: "npc_grid", args: { count: 50 } })
```

Macros stored per-session by default; opt-in to persist across sessions.

### Checkpoints

Named DataModel snapshots:

```ts
mutate({ checkpoint: "before_refactor" })
// ... aggressive changes ...
mutate({ revert_to: "before_refactor" })
```

Layered on top of `ChangeHistoryService` but named, so the agent doesn't have to count undos.

### Cost accounting

Every response includes:

```ts
{
  meta: {
    tokens_in:  142,
    tokens_out: 380,
    tokens_saved: 2310,  // from projection/pagination/diff
    elapsed_ms: 18
  }
}
```

Agent learns its own behavior. Over a session it should bias toward cheaper response shapes.

---

## Layer 6 — Safety + Scoping

Wraps every operation.

### Read/write split

Two MCP endpoints. Agent defaults to read-only:

```
studio-mcp://read         exposes read, search_tools, resources
studio-mcp://write        adds mutate, run_code
```

Promotion to write mode requires user action (click in client UI). Forces intentionality before destructive ops. Parallel read sessions are safe.

### Permission scopes

User config:

```yaml
scopes:
  - path: "Workspace/Shared/**"
    permissions: [read, write]
  - path: "ServerScriptService/**"
    permissions: [read]
  - path: "ServerStorage/Security/**"
    permissions: []
```

Every read/mutate checks scope. Out-of-scope returns a structured error with the offending path so the agent knows to ask the user.

### Confirm-before-destructive

`mutate` ops tagged with destructiveness levels:

```
none       create new things
soft       modify existing properties
hard       delete instances, overwrite scripts
nuclear    wipe services, clear DataStores
```

`hard` and `nuclear` raise a confirmation through the client UI before executing. Default deny if the client doesn't support confirmations.

---

## Layer 7 — Intelligence

Every response teaches the agent something.

### Suggested next call

On success:

```ts
{
  applied: true,
  next_likely: [
    { call: "read", args: { ref: "p3", select: ["Velocity"] }, reason: "verify physics applied" },
    { call: "run_code", args: { luau: "..." }, reason: "playtest the change" }
  ]
}
```

Not enforced — just suggestions. Agent's free to ignore.

### Confidence hints

On failure:

```ts
{
  error: "instance_locked",
  hint: "This instance is in a Package linked to AssetId 12345. Unlink before mutating, or use mutate({ unlink: true, ... })",
  retry_with: { unlink: true, ...originalArgs }
}
```

Failures are teachable moments. Bad MCPs return `{ error: "failed" }`. Good MCPs return next steps.

### Sub-agent dispatch

For repetitive grunt work, the server spawns a small model:

```ts
mutate({
  delegate: {
    task: "scan_for_deprecated_apis",
    targets: { query: "**/*[ClassName=Script]" },
    model: "haiku"
  }
})
// Returns summary to main agent
{
  scanned: 47,
  findings: [{ ref: "s12", issue: "uses wait()", line: 18 }, ...]
}
```

Main agent only sees the summary. Cheap model burns through the busywork.

### Prompts as templates

MCP's third primitive. User-invokable workflows:

```
/debug              load lint + recent errors + script under cursor
/refactor <ref>     load script + dependents + test files
/optimize           load microprofiler + perf-relevant tools
```

Each prompt template pre-loads relevant tools and seeds the agent's context.

### Streaming

Long ops stream progress:

```ts
mutate({ op: "terrain_generate", region: {...}, stream: true })

// Server streams:
{ progress: 0.1, status: "carving caves" }
{ progress: 0.4, status: "placing materials" }
{ progress: 1.0, result: {...} }
```

Agent can cancel mid-stream if it sees the result going wrong.

---

## Layer 8 — Roblox Surface

Thin tool layer + heavy lifting in the layers below.

### The core trio

- `read` — query + project + format + paginate
- `mutate` — DAG + validate + waypoint + diff
- `run_code` — Luau escape hatch with a pre-loaded helper library

### Pre-loaded Luau helpers

Inside Studio, a helper library is auto-required at session start:

```lua
-- studio-mcp-helpers/init.lua
local M = {}

function M.find(query)            -- query language in Luau
function M.batch(ops)             -- DAG executor
function M.snapshot(ref)          -- snapshot a subtree
function M.waypoint(name, fn)     -- wrap fn in a waypoint
function M.diff(snap_a, snap_b)   -- snapshot diff

return M
```

`run_code` calls don't have to reinvent these. Reduces Luau-side token waste massively.

### Vision-grounded screenshots

```ts
read({ screenshot: { camera: "viewport", annotate: true } })

// Returns:
{
  image: "data:image/png;base64,...",
  annotations: [
    { ref: "p3", bbox: [340, 220, 410, 290], class: "Part" },
    { ref: "p7", bbox: [500, 100, 580, 180], class: "Model" }
  ]
}
```

Vision model points at "the red thing at (375, 250)" and you resolve it server-side. Existing MCPs return raw images; this returns a grounded scene.

### Structured playtest stream

Subscribe to `LogService.MessageOut` and `ScriptContext.Error`, return structured events:

```ts
{
  type: "runtime_error",
  script: "ServerScriptService.GameLogic",
  line: 42,
  message: "attempt to index nil with 'Health'",
  stack: [...],
  ref: "s12"
}
```

Not console scraping. Structured from the source.

### MicroProfiler + PerformanceStats

Expose as a resource:

```
studio://playtest/perf
```

Returns frame-by-frame microprofile labels, memory by category, network usage. Agent can optimize for FPS, not just correctness.

### TestEZ integration

```ts
run_code({ test: { suite: "ServerScriptService.Tests" } })

// Returns:
{
  passed: 14,
  failed: 2,
  failures: [{ test: "PlayerJoin returns inventory", reason: "..." }]
}
```

Closes the loop on "did my change break anything."

### Hot reload during playtest

Edit a script while play mode is running, server reloads the module without restarting the test session. State preserved.

### Rojo source map

When the project is Rojo-synced, every script-related response includes the source file:

```ts
{
  ref: "s12",
  instance_path: "ServerScriptService.GameLogic",
  source_file: "src/server/GameLogic.luau"
}
```

Critical for any workflow that's editing files outside Studio.

### Asset pipeline

```ts
mutate({
  op: "asset_upload",
  kind: "image",
  data: "...base64...",
  use_as: { ref: "p3", property: "Decal.Texture" }
})
```

One call: upload via Open Cloud, get asset ID, apply to instance. Currently every MCP has separate upload + apply steps.

---

## A full turn, end to end

User: *"Make the lobby darker and add a flickering fire effect by the spawn."*

1. **Sticky context** (L5) already has `Lobby` weighted high from prior turns.
2. Agent calls `search_tools({ query: "darken lighting fire effect", intent: "polishing" })`.
3. Search (L2) returns `lighting_set`, `atmosphere_set`, `particle_create`, `pointlight_create`. Notified via `tools/list_changed`.
4. Agent calls `read({ query: "Lighting/*", format: "summary" })`.
5. **Pagination + projection** (L3) return only the 5 most relevant Lighting props with a snapshot tag.
6. **Prefetch** (L3) bundles current Atmosphere settings — agent didn't ask but the server guessed correctly.
7. Agent submits `mutate({ ops: [...] })` — a DAG that adjusts Lighting, creates a PointLight under the spawn, adds a ParticleEmitter, scripts a flicker via `run_code`.
8. **Schema validation** (L4) catches that `Color` was passed as `[255, 100, 50]` instead of `Color3` — returns suggested fix, agent retries.
9. Batch runs atomically inside one undo **waypoint** (L4).
10. **Lint** (L4) returns clean.
11. **Diff response** (L4) shows: `Lighting.Brightness 2 → 0.8`, `+ Workspace.Lobby.Spawn.PointLight`, `+ Workspace.Lobby.Spawn.Fire`.
12. **Suggested next call** (L7): `"run_code: playtest for 5s and capture LogService"`.
13. **Cost meta** (L5): 4.2k tokens saved vs naive full reads.
14. **Permission check** (L6) passed — `Workspace.Lobby` is in `write` scope.

One user request, one round trip of actual work, full undo, validated, logged, with the agent already cued for the next sensible action.

---

## Build order

Don't build all of this at once. Phased, with each phase usable on its own.

**Phase 1 — the bones (1-2 weeks)**

- Reference tokens (L1)
- ETag-based reads (L1)
- Progressive tool loading with `search_tools` (L2)
- Atomic undo waypoints on every mutate (L4)
- Schema validation from API dump (L4)

After Phase 1 you already have something better than anything shipping.

**Phase 2 — read/write quality (1-2 weeks)**

- Query language (L3)
- Property projection + response shapes (L3)
- Pagination with smart defaults (L3)
- Dependency-graph batches (L4)
- Inline lint + diff response (L4)

**Phase 3 — session memory (1 week)**

- Sticky context (L5)
- Tool call history as a resource (L5)
- Macros (L5)
- Cost accounting (L5)

**Phase 4 — safety + intelligence (1-2 weeks)**

- Read/write split + scopes (L6)
- Confirm-before-destructive (L6)
- Suggested next call + confidence hints (L7)
- Predictive prefetch (L3)

**Phase 5 — Roblox surface (ongoing)**

- Vision-annotated screenshots
- Structured playtest stream
- TestEZ runner
- Rojo source map
- Asset pipeline
- Pre-loaded Luau helpers
- Sub-agent dispatch
- Streaming
- Hot reload

Each Phase 5 item is independent. Ship them as you need them.

---

## Token math

Rough numbers for a 30-turn session doing real work.

| | Existing MCPs | This design |
|---|---:|---:|
| Tool schemas per request | ~15k | ~1k |
| Avg read response | ~3k | ~400 |
| Avg write response | ~500 | ~250 |
| Re-reads (snapshot hits) | full cost | ~50 each |
| **30-turn session total** | **~600k** | **~50k** |

Order of magnitude better, conservatively. The biggest wins are progressive tool loading and snapshot reads; everything else compounds on top.

---

## Open questions

Things genuinely unknown — flag these for prototyping.

- **Embedding search vs keyword.** Worth it for v2? Test on 50 real queries first.
- **Snapshot granularity.** Per-instance or per-subtree? Per-subtree is cheaper to compare but coarser to invalidate.
- **Macro persistence.** Per-session, per-project, or global? Probably opt-in.
- **Sub-agent model choice.** Haiku via API or a local small model? Local is cheaper and private but harder to set up.
- **Vision annotation cost.** Bounding boxes for every visible instance is expensive at high object counts. Probably needs LOD.
- **Hot reload semantics.** What state survives a script reload? `_G`? Instance refs? Coroutines? Document carefully.

---

## What this is not

To stay honest about scope:

- **Not a code generator.** This is a protocol design, not "AI that builds games." The agent still has to know what it's doing.
- **Not multiplayer-aware.** Team Create coordination is genuinely hard; out of scope for v1.
- **Not a Rojo replacement.** Pairs with Rojo, doesn't replace it.
- **Not Open Cloud only.** Open Cloud is one transport; the main path is the in-Studio plugin.

---

## Inspirations + prior art worth reading

- **Anthropic's code execution + MCP** — for the host-side programmatic tool calling pattern (relevant when designing the agent loop, not the server).
- **boshyxd/robloxstudio-mcp** — the most extensive existing tool surface; useful for understanding what specialist tools agents reach for.
- **WEPPY** — best existing example of action-based dispatch and screenshot diffing.
- **Roblox's official Studio MCP** — `run_code` as the universal lever is the right instinct; this design extends it instead of replacing it.
- **Language Server Protocol** — the spiritual ancestor of MCP; their handling of progressive disclosure and resources is mature and worth borrowing from.

---

End of design notes. Next step is a prototype of Phase 1 in TypeScript or Rust. If you want a starter skeleton, ask.
