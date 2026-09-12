# What to build next

Everything in `ISSUES.md` is fixed. This file is the forward plan.

Two parts:

1. **Stop changing the tool list mid-session.** Cheap, affects every single turn.
2. **Close the 15 gaps** where `Chrrxs/robloxstudio-mcp` does something better than us.

Each item says what is wrong now, what to do, how big it is, and how you know it is done.

Sizes: **S** = an afternoon. **M** = a day or two. **L** = a week or more.

---

> ## Status: done, except what the engine and the missing plugin forbid
>
> **Part 1 and 12 of the 15 gaps are closed.** 303 tests, 51 suites, all running
> with no Studio, no port, no plugin and no network.
>
> | | |
> |---|---|
> | Landed whole | 3 npm packaging · 4 docs tools · 5 output schemas · 6 catalog budget · 7 assets · 13 read-only build · 14 WebSocket · 15 SECURITY + config |
> | Landed server-side, plugin half documented | 1 Studio screenshot · 8 perf and scene analysis · 9 non-pausing breakpoints · 11 multi-instance |
> | Blocked, with evidence | 2 plugin source (not in this repo, and not obtainable from it) |
> | Reopened and partly built | 10 input and movement — `character_goto` landed; real input needs the PlayClient relay, which needs the plugin |
> | Ongoing by design | 12 test depth |
>
> **Two of the plan's own instructions turned out to be wrong**, and both are
> corrected in place rather than quietly dropped. Item 2 was not "un-gitignore it",
> because the source has never been in this checkout. Item 10 was wrong twice: first
> as "needs a plugin handler", then as "unreachable at any security a plugin has" —
> `VirtualInputManager` is indeed closed, but `UserInputService:CreateVirtualInput()`
> is not, and it drives the real input pipeline. Item 10 is open work, not a dead end.
>
> **A third correction, and the one that explains the other two.** Every "X is not in
> the API dump, therefore X does not exist" claim this document made was an artefact of
> reading a *frozen* dump: 682 classes where the live Studio build has 916, missing
> `StudioTestService`, `PluginConnectionService`, `VirtualInput` and
> `StudioCaptureService`. A thin dump does not fail — it answers "no such class", which
> reads like an answer. Fixed in `b46c6f2`; see item 4.
>
> **Five rounds of independent verification found 38 defects**, every one
> reproduced before it was fixed. The two worth naming are opposites: a
> pre-existing bug this work uncovered (`script_edit` writing to Studio with the
> *Allow writes* toggle off) and one it introduced (`asset_upload` reading any
> file on the machine and posting it to Roblox — from the read-only build).
>
> Both came from the same mistaken idea, that a tool which does its work in
> TypeScript is harmless. The channel now has to describe where the *effect*
> lands, and `effects` names all three of the other ways out: disk, network, and
> spawning a binary.

---

## Part 1 — The tool list should only ever grow

### The problem

Every turn, the whole tool list gets sent to the model again. The model provider caches
that request, but the cache only covers the part from the very start up to the first
thing that changed. The tool list sits at the very start. So the moment the list
changes, the cache for that turn is gone and the whole thing gets re-read at full price.

Right now we hide 58 specialist tools, surface them when `search_tools` finds them, and
drop them again when they go idle or push past the cap of 8. That means the list keeps
changing. Forever.

Measured against the real `ToolSet` over a 60-turn session
(`test/bench/tool-churn.mjs`):

| | turns that changed the list | second half | last change | mean prefix |
|---|---|---|---|---|
| evicting | 20 / 60 (33%) | 33% | turn 58 | ~11,900 chars |
| grow-only | 10 / 60 (17%) | 10% | turn 43 | ~20,600 chars |

The number that matters is the second column. With eviction, a third of turns pay full
price and it never settles down. Grow-only front-loads the churn and then goes quiet,
because once a tool has been seen it never leaves.

**The last column is the catch, and it has to be said out loud.** Grow-only changes the
list less often but makes the cached prefix permanently bigger, so the cheap cache-read
turns cost more. Priced together at the usual cache rates (write 1.25x, read 0.1x), the
two break even at roughly 3k tokens of non-tool context. Every real session clears that
on turn one, so grow-only wins — but it wins by less as the catalog grows, which is
exactly what the catalog budget in item 6 exists to hold.

One premise here is not provable from this repo: that the tool list sits at the very
front of the cache prefix. That is how the Anthropic API orders a request, but the MCP
client builds it, not us.

### What the people who researched this actually do

Anthropic's answer is "never change the list." You declare every tool up front with
`defer_loading: true`, so the list is fixed and cacheable, and only the ones you need get
their full definitions pulled in. Two flavours:

- **Tool Search Tool** (`tool_search_tool_regex_20251119`): the model searches for tools itself.
- **Mid-conversation tool changes** (`tool_addition` / `tool_removal`): the app decides. This is
  the one that matches how we already work.

**We cannot use either.** Both are Messages API parameters. The MCP client builds that
request, not us. `defer_loading`, `tool_addition` and `tool_removal` do not exist anywhere
in `@modelcontextprotocol/sdk` (grepped, v1.29.0). An MCP server only gets to answer
`tools/list` and fire `tools/list_changed`.

So grow-only is the closest thing we can actually reach from here.

### The change — DONE

**Size: S.** Landed in `15dc2d3`.

- Delete `evict`, `IDLE_TURNS` and `SPECIALIST_CAP` from `src/session.ts`.
- `unlockAndSettle` becomes "add these names, report what is new." Nothing is ever dropped.
- `settle` stops existing. Callers that only called it to trigger eviction lose the call.
- Keep `search_tools`. Keep `lastUsed` if you want it for ranking, drop it if you do not.
- Keep the reverse-rank `touch` ordering out of it entirely, since it only existed to
  survive eviction.

Worst case the list ends at 63 tools. For scale, the competitor ships 48 on turn one, so
the grow-only ceiling is about a third larger than what they carry from the start.

**Done when:** the unit tests still pass, `test/bench/tool-churn.mjs` reports grow-only numbers
against the real class, and a real session shows `tools/list_changed` firing only when a
genuinely new tool appears. All three hold.

**Still open: measure it for real.** Run a normal build session through an actual client
and read the cache-read vs cache-write token counts before and after. The simulation says
33% to 17% on change count and a 1.7x bigger prefix. Confirm both with real numbers before
claiming the win anywhere it matters.

---

## Part 2 — The 15 things they do better

Ordered by what unblocks the most. Not by size.

### Tier 1: things that block everything else

#### 1. Screenshots should come from inside Studio (**L**)

**Now:** PowerShell `CopyFromScreen` against Studio's window rect. It grabs whatever
pixels happen to be on screen there, so another window on top means you screenshot that
window instead. macOS and Linux shell out to the OS capture tool. (It does *not* raise
Studio to the front — `src/vision.ts` only calls `GetWindowRect`. Occlusion is the real
complaint; window-stealing was mine and it was wrong.)

**They:** `StudioCaptureService:CaptureScreenshot()`. Studio-only, PluginSecurity, hands
back the framebuffer directly. Base64 it in Luau, send it over the bridge. Falls back to
`CaptureService` plus `EditableImage.ReadPixelsBuffer` tiled when the fast path is off.

**Do:** add a `capture` handler to the plugin using `StudioCaptureService`, route
`screenshot` through the bridge first, keep the OS path as the fallback only.
See `studio-plugin/src/modules/handlers/CaptureHandlers.ts` in their repo for the shape.

**Caveat worth knowing before relying on it:** their own code comments say
`StudioCaptureService` is FFlag-gated and missing from `@rbxts/types`. It is not a
guaranteed API, so the OS fallback is not optional.

**Done when:** a capture taken with another window covering Studio still shows Studio.

#### 2. The plugin needs to live in this repo — BLOCKED, and not by a decision

**Now:** `roblox/` is gitignored and has never been tracked. Distributed separately.
Nobody can audit it, fork it, or check that it matches the server version. The whole
audit had to leave every plugin-side finding unverified.

**They:** `studio-plugin/` is in the repo. roblox-ts source, handler modules, UI, client.

**"Un-gitignore it and commit it" assumes the source is here. It is not.**
`git log --all -- roblox/` is empty, the repository has exactly two branches and
no releases, and nothing on GitHub carries the plugin. You cannot commit files
you do not have. The real item is "get the plugin source from wherever it is
distributed", which is outside this repository entirely.

**What has been done instead**, so that nothing is waiting on it that does not
have to be:

- `docs/PLUGIN-PROTOCOL.md` writes down the whole contract — every command, the
  auth rules, the WebSocket frames, the instance identity — taken from the code.
- `--install-plugin` is built and tested; it looks for `plugin/CubesMCP.rbxm`.
  Drop the built model there and it works with no other change.
- Everything that could be done on the server side of items 1, 8, 9, 11 and 14
  is done, with `FakeTransport` tests on the exact command shape sent.

**Done when:** `git clone` plus one build command produces both halves.

#### 3. Installing should be one command (**M**)

**Now:** clone, `npm install`, `npm run build`, then go find a plugin that is not in the
repo. Nothing is published.

**They:** `claude mcp add ... npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin`.
On npm, plugin auto-installed and version-matched.

**Do:** publish to npm, add a `--auto-install-plugin` flag that drops the `.rbxm` into the
local plugins folder, and fail loudly when plugin and server protocol versions disagree.

**Done when:** a stranger with no context gets a working setup from one command.

### Tier 2: things that stop the agent wasting turns

#### 4. An engine API reference tool (**M**)

**Now:** nothing. The agent guesses property names, types and enum values, gets them
wrong, and burns a turn on a failed `mutate`.

**They:** `get_roblox_docs` fetches the *rendered Markdown* from
`create.roblox.com/docs/reference/engine` with a 24h cache and a 50k-char cap (not the
API dump). `get_roblox_skills` lists Roblox-authored skills, plus `robloxdocs://`
resource templates.

**Do:** pull the Roblox API dump (a public JSON file), cache it locally, expose
`docs_class` and `docs_member`. Does not need the plugin at all.

**One thing the dump cannot give you.** Its member records carry
`Name, MemberType, ValueType, Category, Security, Tags, ThreadSafety, Parameters,
ReturnType, Serialization` and nothing else. **There is no default-value field.** So
defaults come from a live `Instance.new(Class)[prop]` read over `eval`, not from the dump.

**Done when:** the agent can ask "what properties does a PointLight have" and get real
names, types, and read/write security — with defaults available through a separate live
read, clearly labelled as such.

**Reopened: the feed is the wrong file.** `setup.rbxcdn.com/{version}-API-Dump.json` is a
*filtered* dump — **682 classes** against the full dump's **921**. It has `Plugin`,
`StudioService` and `ChangeHistoryService`, so it is a Studio dump, but it is missing
`StudioTestService`, `PluginConnectionService`, `PluginConnection`, `VirtualInput` and
`StudioCaptureService` — the exact surface this MCP is built on. Both of the false claims
this document has made about what "does not exist" traced back to reading it. Measured
2026-09-12 against `MaximumADHD/Roblox-Client-Tracker@roblox:Full-API-Dump.json`.
Swap the feed, keep the current URL as a fallback, and make `docs_class` say which one
answered.

#### 5. Structured output schemas (**M**)

**Now:** every tool returns a JSON blob inside a text block. The model has to parse prose.

**They:** `outputSchema` is optional in their tool type, and a regression test pins 47 of
48 as having one. Nearly-every, not every.

**Do:** add `outputSchema` per tool, starting with the five core ones, and a test that
fails when a tool ships without one.

**Done when:** clients can read tool results structurally instead of string-matching.

#### 6. A budget on tool descriptions (**S**)

**Now:** progressive disclosure keeps the per-turn cost low, but nothing stops a single
description from being enormous.

**They:** a test caps the public catalog at 44,000 characters (their own token-efficiency
doc says 43,000 and is stale relative to their test), tool descriptions at 120, argument
descriptions at 64, and the read-only catalog at 20,000. The 120 is also enforced at build
time by truncating the description, not only by failing the test.

**Do:** copy the idea. One test, several limits. This matters more once the tool set is
grow-only, because then everything is visible eventually.

**Done when:** `npm test` fails if someone writes a 400-character tool description.

### Tier 3: real features we simply do not have

#### 7. An asset pipeline (**L**)

**Now:** none. "Put a tree here" is impossible unless the agent already knows an asset id.

**They:** `search_assets`, `get_asset_details`, `preview_asset`, `insert_asset` (strips
scripts and package links, verifies, then parents), `upload_asset`,
`get_asset_thumbnail`. Backed by an Open Cloud client.

**Do:** add an Open Cloud client behind the existing `StudioTransport` seam, then the
tools. `insert_asset` must strip scripts before parenting, same as theirs.

**Done when:** the agent can find and place a tree it has never seen before.

#### 8. Performance and memory analysis — PARTLY DONE

**They:** `capture_micro_profiler` (bundles LibMP), `capture_script_profiler`,
`get_memory_breakdown`, `get_scene_analysis`.

**Done:** `perf_stats` and `scene_analysis`. Every counter they need is
`Security: None` in the API dump, so both are generated Luau with no plugin
change. Checked against the dump rather than assumed.

**Still open:** the two profilers. `capture_micro_profiler` bundles LibMP into
the plugin, and there is no `ScriptProfiler` class in the dump at all. Both are
plugin-side work.

#### 9. Real debugging — PARTLY DONE

**They:** `breakpoints` records each hit without pausing the playtest.
`eval_client_runtime` and `eval_server_runtime` run in live contexts sharing the game's
`require` cache.

**Done:** `breakpoint_set` and `breakpoint_list`. Every member of `ScriptDebugger`
and `DebuggerBreakpoint` is `Security: None` in the dump, and
`DebuggerManager:AddDebugger` is too, so this needed no plugin change.
`ContinueExecution` is the important part: a breakpoint that pauses the VM during
a playtest also stops the plugin answering, so the next tool call times out.

**Still open:** `eval_client_runtime`. It needs a client-context peer, which
needs item 11 and the plugin half.

#### 10. Input, movement, and the DataModel the client lives in

**Now:** `character_walk`, `character_jump`, `character_teleport`. `character_walk` is
`Humanoid:Move(direction)` for N seconds, blocking, capped at 10. It puppeteers the
humanoid, so it bypasses the entire control stack — which is precisely the code a
playtest exists to exercise. Custom controllers, sprint keybinds, double jump, mobile
controls: none of them fire, so none of their bugs show up.

**They:** `simulate_mouse_input`, `simulate_keyboard_input`, `set_device_simulator`,
`set_network_profile`, `capture_device_matrix`.

**Two corrections to earlier versions of this item.**

An earlier version said input simulation was blocked by the engine, because every method
on `VirtualInputManager` is `RobloxScriptSecurity`. That part is true. The conclusion was
not: `UserInputService:CreateVirtualInput()` is a separate route and it is `Security: None`.

The version after that said `CreateVirtualInput` is absent from the API dump and that there
is no way to move the mouse. Both are wrong, and the reason for the first one turns out to
matter more than the feature itself — see the dump note below.

```lua
local vi = game:GetService("UserInputService"):CreateVirtualInput()
vi:SendKey(true, Enum.KeyCode.W, false)                              -- hold W
vi:SendMouseButton(pos, Enum.UserInputType.MouseButton1, true, 0)    -- press
vi:SendMouseDelta(Vector2.new(dx, dy))                               -- turn the camera
vi:SendMousePosition(Vector2.new(x, y))
vi:SendTextInput("hello")
vi:SendPointerAction(pos, action)
```

Six methods, all `Security: None`, verified against `Full-API-Dump.json`. `SendMouseDelta`
and `SendMousePosition` mean camera turning **is** possible. There is genuinely no
`SendMouseWheel` and no touch method.

**The dump note, which is its own bug.** `docs.ts` fetches
`setup.rbxcdn.com/{version}-API-Dump.json`. That file has **682 classes** and contains
none of `VirtualInput`, `PluginConnection`, `PluginConnectionService`, `StudioTestService`
or `StudioCaptureService`. The full dump has **921**. So every claim of the form "X is not
in the dump, so X does not exist" that this document has made was an artefact of reading a
filtered file — and the `docs_*` tools are blind to exactly the Studio surface an agent
driving Studio needs most. Fix the feed before trusting the dump again.

**The real blocker was never security. It is which DataModel you are in.** A Studio
playtest runs up to four DataModels — Standalone, Edit, PlayServer, PlayClient — and
Studio clones the plugin into each. They are isolated: no Bindables, no Remotes, no shared
`_G`. `UserInputService` only exists in PlayClient, so `CreateVirtualInput` has to be
called there. And the plugin copy in PlayClient **cannot make HTTP requests at all**, so it
cannot reach our bridge. That is why walking is puppeted today: the only copy that can talk
to us is on the wrong side of the wall.

**`PluginConnectionService` is the wall's door**, added v0.715 (2026-04-01) and public:

```lua
local svc = game:GetService("PluginConnectionService")
svc:CanHaveConnectionType(Enum.PluginConnectionTargetType.Test)   -- am I Edit?
svc:GetPluginConnectionsOfType(Enum.PluginConnectionTargetType.Edit)
svc.Connected:Connect(function(conn) ... end)
conn:SendMessage(json)          -- string or buffer
conn:BindToMessage(function(payload) ... end)
conn.Type / conn.TargetId / conn.Connected
```

The shape that follows: **the edit-mode copy stays the sole external bridge**, and the
PlayServer/PlayClient copies never poll us — they answer over `PluginConnection` and the
edit copy relays. Detect which copy you are by connection direction, not by
`plugin.HostDataModelType`, which reports `Edit` from a Run-mode clone.

**Do:**
- Relay first. Without it, nothing else in this item is reachable.
- One `VirtualInput` cached per PlayClient VM so `press` and `release` span calls.
- Refuse rather than lie when the window is not rendering, and when `SendKey` throws
  because CoreGui holds keyboard focus.
- `ui_inspect` in PlayClient: walk `PlayerGui` + `CoreGui`, return `AbsolutePosition`,
  `AbsoluteSize`, `Text` and effective visibility. Click coordinates then come from the
  UI tree rather than from guessing at a screenshot.
- `character_goto(target)` — **DONE** (`9bdeeaf`). `PathfindingService`, follows the
  waypoints, jumps on jump actions, returns `arrived` / `blocked` / `timeout` with the
  distance remaining. Needed no new plumbing, because `tune` already runs Luau in the live
  play server. Still `Humanoid:MoveTo` underneath, so it buys intent, not fidelity: the
  game's own control scripts do not run until the relay above exists.

**Done when:** holding a key walks the character through the game's own control scripts,
a click lands on a button located by name rather than by pixel, and `character_goto`
crosses a map with obstacles and says whether it arrived.

#### 11. Multiple Studio windows (**L**)

**Now:** one bridge, one plugin, one place. Place identity is cached with a TTL, which is
better than the old permanent cache, but still single-target.

**They:** `get_connected_instances`, role-suffixed instance ids, `multiplayerGroups`, and
`manage_instance` to open and close Studio windows including older place revisions.

**Done, server half.** Protocol 5 carries `instanceId`, `placeId`, `placeName`
and `role` on `/poll` and on the WebSocket `hello`; the bridge tracks each window
and the command queue is keyed by it. A command addressed to a window only ever
goes to that window — if it is absent the command waits and times out rather than
being diverted. `studio_instances` lists them, `/health` reports them.

**Still open, and this is the part that matters:** the routing works and is
unreachable. `StudioTransport.send` takes a `target`, the bridge honours it, and
no tool passes one — so with two windows open every call still goes to whoever
answers first. Exposing it means either a reserved argument on every tool schema
or a session-level "current window", and that is a design decision, not a typo.
Also still open: the plugin has to send a distinct `instanceId` per window, and
`manage_instance` is plugin-side.

### Tier 4: polish that makes it look finished

#### 12. Test depth — ONGOING, and the count is the least interesting part

**Now:** 258 tests across 33 suites, all runnable with no Studio, no port, no
plugin and no network.

**They:** 487 test cases across 36 files.

**What got added, and why it was the right thing rather than more of the same.**
Thirteen tool files had no test at all. A bespoke suite per file would have taken
a long time and still missed the bugs that actually appear, so instead
`tools-conformance.test.mjs` generates arguments from each tool's own inputSchema
and runs all 77 through the real server: none throws, none is rejected by its own
schema, every one is findable by searching its own name, and every write-class
tool whose Luau changes the DataModel takes an undo waypoint or declares
`undo: "none"` with a reason. That last check found two real bugs on its first
run — `animation_play` was leaking an Animation instance under the Animator on
every single play, and creating an Animator with no waypoint.

**The count is not the goal, and chasing 487 would be the wrong instinct.** The
suite's job is to be the thing that catches the next bug, and it has twice been
the thing that encoded a premise instead. Both times the fixture was the oracle:
the fake plugin returned `{applied, results}`, the schemas were written from the
fixture, and the protocol doc was written from the schemas — while DESIGN.md has
said `{applied, changes}` all along, which is what the server's own code reads.
Test against the contract, not against the fake.

#### 13. A read-only edition (**M**)

**Now:** one build. Read-only is a runtime toggle in the panel, not something you can
install instead.

**They:** a separate `-inspector` npm package with 25 Studio-safe inspection tools (every
tool whose declared `category` is `read`) and no DataModel or script edits at all. The
installers remove the other variant.

**Do:** `capabilities()` already knows which tools are write-class, so this is mostly a
build flag that filters the registry. The point is that a read-only install cannot be
talked into writing, because the write tools are not there.

#### 14. WebSocket instead of long-poll (**M**)

**Now:** HTTP long-poll on a 25-second hold. Simple and firewall-proof, but a command can
sit until the next poll cycle picks it up.

**They:** WebSocket, with reconnect and generation tracking.

**Do:** add a WebSocket route, keep long-poll as the fallback, let the plugin pick.
Protocol is already a range, so this is an additive bump.

**The plugin side is possible.** Theirs uses
`HttpService:CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, ...)` with
generation guards and 0.5s-to-5s reconnect backoff. So a Luau WebSocket client is not a
blocker, only work.

#### 15. Written documentation (**S**)

**Now:** README, CLAUDE.md, and three audit documents. Accurate, but no SECURITY.md and
no configuration guide.

**They:** six focused guides (configuration, building from source, token efficiency,
large inputs, creator store assets, deprecated API) plus SECURITY.md.

**Do:** SECURITY.md first, because the bridge auth story deserves one. Then a
configuration guide covering `CUBES_MCP_TOKEN`, `CUBES_MCP_PORT` and
`CUBES_MCP_ALLOW_UNAUTHENTICATED`.

---

## What CI here can and cannot prove

The Studio plugin is not in this repository and never has been, so nothing below the
bridge can be exercised in CI. For every item that needs the plugin (1, 8, 9, 10, 11, 14)
the deliverable from this side is: the server half, the protocol, and a test that asserts
the exact command shape sent over `FakeTransport`. The Studio-side behaviour is a manual
check, and any "done when" phrased as observable Studio behaviour has to say so.

Item 2 is worse than it reads. "Un-gitignore it and commit" assumes the source is here.
It is not, and `git log --all -- roblox/` is empty, so it never was. The real item is
"get the plugin source into this repo from wherever it is distributed," and items 1, 8, 9,
10, 11 and 14 all depend on it transitively.

---

## Do not break these while doing the above

We already win these rows. They are easy to lose in a refactor.

- **Write-class is derived from the tool's channel, not a label.** Theirs is a mandatory
  hand-written `category: 'read' | 'write'` field on each tool (plus four name sets that
  only refine the MCP annotation hints). A hand-written label can be wrong; a tool that
  ships Luau is write-class here because of how it was constructed.
- **Every bridge route requires the bearer token, both directions.** Their `/studio`
  WebSocket upgrade *does* check `X-Studio-Token`. But `/ready` is unauthenticated and is
  what *mints* that token, and `/disconnect` takes an arbitrary peer id with no auth — so
  a local process can still register a fake peer and answer on the plugin's behalf.
- **`confirm: true` on destructive batches**, with a four-level classifier and elicitation
  when the client supports it. They have no runtime gate at all.
- **Per-place profiles, macros and sticky context** at `~/.cubesmcp/profiles/{placeId}.json`.
- **`snapshot` and `diff`.** They have no place-state diffing.
- **selene over every written `Source`.**
- **Rojo sourcemap annotation.**
- **Protocol is a range, not an equality check.** They compare protocol versions for
  equality, so any additive change breaks every un-updated plugin. We bump MAX for
  additive changes and only raise MIN for genuinely breaking ones.
- **6,817 lines of TypeScript versus 29,544 (46,482 with their tests).** About 4x, not the
  34x a whole-repo line count suggests — their 203k is mostly a lockfile. Still: one
  person can hold this whole repo in their head. Every item above costs some of that.
  Spend it on purpose.

---

## Suggested order

1. ~~Part 1 (grow-only tool list)~~ — done, `15dc2d3`.
2. Plugin into the repo (#2), then npm publish (#3). Everything else is easier after.
3. ~~Description budget (#6)~~ — done, `b7173df`. ~~Output schemas (#5)~~ — done,
   `30a8c43`. Docs tool (#4) next: cheap and immediately useful.
4. Studio-side screenshot (#1).
5. SECURITY.md and config guide (#15).
6. Assets (#7).
7. Everything else, by whatever you actually need that week.
