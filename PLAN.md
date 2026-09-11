# What to build next

Everything in `ISSUES.md` is fixed. This file is the forward plan.

Two parts:

1. **Stop changing the tool list mid-session.** Cheap, affects every single turn.
2. **Close the 15 gaps** where `Chrrxs/robloxstudio-mcp` does something better than us.

Each item says what is wrong now, what to do, how big it is, and how you know it is done.

Sizes: **S** = an afternoon. **M** = a day or two. **L** = a week or more.

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

| | turns that changed the list | second half of the session | last change |
|---|---|---|---|
| now (evicting) | 20 / 60 (33%) | 33% | turn 58 |
| grow-only | 10 / 60 (17%) | 10% | turn 43 |

The number that matters is the second column. With eviction, a third of turns pay full
price and it never settles down. Grow-only front-loads the churn and then goes quiet,
because once a tool has been seen it never leaves.

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

### The change

**Size: S.**

- Delete `evict`, `IDLE_TURNS` and `SPECIALIST_CAP` from `src/session.ts`.
- `unlockAndSettle` becomes "add these names, report what is new." Nothing is ever dropped.
- `settle` stops existing. Callers that only called it to trigger eviction lose the call.
- Keep `search_tools`. Keep `lastUsed` if you want it for ranking, drop it if you do not.
- Keep the reverse-rank `touch` ordering out of it entirely, since it only existed to
  survive eviction.

Worst case the list ends at 63 tools, which is what the other MCP ships on turn one anyway.

**Done when:** the unit tests still pass, `test/bench/tool-churn.mjs` reports grow-only numbers
against the real class, and a real session shows `tools/list_changed` firing only when a
genuinely new tool appears.

**Then measure for real.** Run a normal build session through an actual client and read
the cache-read vs cache-write token counts before and after. The simulation says 33% to
17%. Confirm it with real numbers before claiming it.

---

## Part 2 — The 15 things they do better

Ordered by what unblocks the most. Not by size.

### Tier 1: things that block everything else

#### 1. Screenshots should come from inside Studio (**L**)

**Now:** PowerShell `CopyFromScreen` against Studio's window rect. It grabs whatever
pixels happen to be on screen there, so another window on top means you screenshot that
window instead. It also yanks Studio to the front while you are working. macOS and Linux
shell out to the OS capture tool.

**They:** `StudioCaptureService:CaptureScreenshot()`. Studio-only, PluginSecurity, hands
back the framebuffer directly. Base64 it in Luau, send it over the bridge. Falls back to
`CaptureService` plus `EditableImage.ReadPixelsBuffer` tiled when the fast path is off.

**Do:** add a `capture` handler to the plugin using `StudioCaptureService`, route
`screenshot` through the bridge first, keep the PowerShell path as the fallback only.
See `studio-plugin/src/modules/handlers/CaptureHandlers.ts` in their repo for the shape.

**Done when:** screenshotting does not raise the Studio window and does not capture an
overlapping window.

#### 2. The plugin needs to live in this repo (**M**)

**Now:** `roblox/` is gitignored and has never been tracked. Distributed separately.
Nobody can audit it, fork it, or check that it matches the server version. The whole
audit had to leave every plugin-side finding unverified.

**They:** `studio-plugin/` is in the repo. roblox-ts source, handler modules, UI, client.

**Do:** un-gitignore it, commit it, add a build step, version it with the server.

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

**They:** `get_roblox_docs` returns official API docs as Markdown, `get_roblox_skills`
lists Roblox-authored skills, plus `robloxdocs://` resource templates.

**Do:** pull the Roblox API dump (it is a public JSON file), cache it locally, expose
`docs_class` and `docs_member`. Does not need the plugin at all.

**Done when:** the agent can ask "what properties does a PointLight have" and get the
real answer with types and defaults.

#### 5. Structured output schemas (**M**)

**Now:** every tool returns a JSON blob inside a text block. The model has to parse prose.

**They:** every tool has an `outputSchema`, enforced by a regression test.

**Do:** add `outputSchema` per tool, starting with the five core ones, and a test that
fails when a tool ships without one.

**Done when:** clients can read tool results structurally instead of string-matching.

#### 6. A budget on tool descriptions (**S**)

**Now:** progressive disclosure keeps the per-turn cost low, but nothing stops a single
description from being enormous.

**They:** a test caps the whole public catalog at 43,000 characters, tool descriptions at
120, argument descriptions at 64.

**Do:** copy the idea. One test, three limits. This gets more important once the tool set
is grow-only, because then everything is visible eventually.

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

#### 8. Performance and memory analysis (**L**)

**Now:** none.

**They:** `capture_micro_profiler` (bundles LibMP), `capture_script_profiler`,
`get_memory_breakdown`, `get_scene_analysis`.

**Do:** memory breakdown first, it is the cheapest and the most asked for. Profilers after.

#### 9. Real debugging (**L**)

**Now:** `tune` evaluates Luau in the running server DM, `debug_error` reads captured
errors with source context. No breakpoints, no client context.

**They:** `breakpoints` records each hit without pausing the playtest.
`eval_client_runtime` and `eval_server_runtime` run in live contexts sharing the game's
`require` cache.

**Do:** client-context eval first (smaller, and half the bugs are client-side anyway),
then non-pausing breakpoints.

#### 10. Input and device simulation (**M**)

**Now:** `character_walk`, `character_jump`, `character_teleport`. That puppeteers the
humanoid, so it never touches the input stack and never catches an input bug.

**They:** `simulate_mouse_input`, `simulate_keyboard_input`, `set_device_simulator`,
`set_network_profile`, `capture_device_matrix`.

**Do:** mouse and keyboard injection first, then the device simulator.

#### 11. Multiple Studio windows (**L**)

**Now:** one bridge, one plugin, one place. Place identity is cached with a TTL, which is
better than the old permanent cache, but still single-target.

**They:** `get_connected_instances`, role-suffixed instance ids, `multiplayerGroups`, and
`manage_instance` to open and close Studio windows including older place revisions.

**Do:** give each plugin connection an id, key the command queue by it, add an
`instances` tool. Touches the bridge, so do it after the bridge is stable.

### Tier 4: polish that makes it look finished

#### 12. Test depth (**L, ongoing**)

**Now:** 83 tests across 20 suites, all runnable without Studio. They cover the audit
findings specifically, but not the breadth of the surface.

**They:** 487 test cases across 36 files, including dedicated suites for HTTP security,
body limits, transport, response delivery, script-source safety and asset security.

**Do:** stop treating this as a milestone. Every new tool ships with a test. The number
goes up on its own.

#### 13. A read-only edition (**M**)

**Now:** one build. Read-only is a runtime toggle in the panel, not something you can
install instead.

**They:** a separate `-inspector` npm package with 24 Studio-safe inspection tools and no
DataModel or script edits at all. The installers remove the other variant.

**Do:** `capabilities()` already knows which tools are write-class, so this is mostly a
build flag that filters the registry. The point is that a read-only install cannot be
talked into writing, because the write tools are not there.

#### 14. WebSocket instead of long-poll (**M**)

**Now:** HTTP long-poll on a 25-second hold. Simple and firewall-proof, but a command can
sit until the next poll cycle picks it up.

**They:** WebSocket, with reconnect and generation tracking.

**Do:** add a WebSocket route, keep long-poll as the fallback, let the plugin pick.
Protocol is already a range, so this is an additive bump.

#### 15. Written documentation (**S**)

**Now:** README, CLAUDE.md, and three audit documents. Accurate, but no SECURITY.md and
no configuration guide.

**They:** six focused guides (configuration, building from source, token efficiency,
large inputs, creator store assets, deprecated API) plus SECURITY.md.

**Do:** SECURITY.md first, because the bridge auth story deserves one. Then a
configuration guide covering `CUBES_MCP_TOKEN`, `CUBES_MCP_PORT` and
`CUBES_MCP_ALLOW_UNAUTHENTICATED`.

---

## Do not break these while doing the above

We already win these rows. They are easy to lose in a refactor.

- **Write-class is derived from the tool's channel, not a label.** Their approach is four
  hardcoded name sets, and a new tool can be mislabelled. Ours cannot.
- **Every bridge route requires the bearer token, both directions.** Their `/ready`,
  `/events`, `/response` and `/disconnect` are deliberately tokenless, so a local process
  can answer on the plugin's behalf.
- **`confirm: true` on destructive batches**, with a four-level classifier and elicitation
  when the client supports it. They have no runtime gate at all.
- **Per-place profiles, macros and sticky context** at `~/.cubesmcp/profiles/{placeId}.json`.
- **`snapshot` and `diff`.** They have no place-state diffing.
- **selene over every written `Source`.**
- **Rojo sourcemap annotation.**
- **~6k lines of TypeScript versus ~203k.** One person can hold all of it in their head.
  Every item above costs some of that. Spend it on purpose.

---

## Suggested order

1. Part 1 (grow-only tool list). Half a day, helps every turn.
2. Plugin into the repo (#2), then npm publish (#3). Everything else is easier after.
3. Docs tool (#4) and description budget (#6). Both cheap, both immediately useful.
4. Studio-side screenshot (#1).
5. Output schemas (#5), SECURITY.md and config guide (#15).
6. Assets (#7).
7. Everything else, by whatever you actually need that week.
