# Cubes Roblox MCP — structural review

Not a bug hunt. `AUDIT.md` covers the 32 defects. This is about the shape of the system:
what will be expensive to change in six months, what is welded to one assumption, and what
was built cleverer than it needed to be.

**System:** an MCP server that drives Roblox Studio by generating Luau and shipping it over a
localhost long-poll bridge to a Studio plugin.

**Scope:** all 16 modules of `src/` (5,988 lines) at commit `2533818`, plus `DESIGN.md`,
`README.md`, `CLAUDE.md`, `package.json`, `.gitignore`, and the seven scripts in `test/`.

**What I could not see:** the entire Luau half. `.gitignore:29` excludes `roblox/`, and git
history shows zero files were ever tracked under it, so the plugin, `Transport.luau`,
`StatusUi.luau`, the `__MCP` runtime and `selene.toml` are all outside this review. That is
roughly half the system. Flaw 1 in particular is graded from the TypeScript side only — the
plugin may well be disciplined in ways I cannot observe. There is also no CI config and no
deployment story to look at, because neither exists.

**Verdict: Will hurt soon.** The core idea (progressive tool disclosure over a thin bridge)
is right and worth keeping. But the two things this project does most — generate Luau, and
decide what a tool is allowed to do — are both implemented as untyped, unvalidated,
hand-maintained lists that are already inconsistent at 58 tools. Both get linearly worse per
tool added. Nothing here needs a rewrite; three of the six fixes are mechanical.

---

## Flaws

### 1. The Luau half is string-templated against a contract that exists nowhere in this repo
**Hardlocked**

**Where:** 33 `evalTool` templates across `src/seed.ts` (21) and `src/pro.ts` (12);
`luaJson` at `src/registry.ts:225-230`; the `__MCP` table used 83 times and defined 0 times.

**What happens:** change the contract of any `__MCP` helper — `decode` takes a second
argument, `resolve` starts returning nil instead of erroring, `waypoint` changes its
signature — and you are grepping 33 template literals across 2,794 lines of TypeScript with
nothing to catch a miss. It fails at runtime, inside Studio, only when that one tool is
invoked, as an opaque `compile_error`. There is no compile step, no parser, no test.

The contract drift is already visible. `run_code`'s description advertises ten helpers:

```
refFor  resolve  query  read  mutate  decode  serialize  diagnostics  viewport  waypoint
```

The server's own 33 templates exercise six of them:

```
29x __MCP.decode   25x __MCP.resolve   21x __MCP.refFor
 5x __MCP.diagnostics   2x __MCP.waypoint   1x __MCP.query
```

`read`, `mutate`, `serialize` and `viewport` are advertised to the model and never touched by
anything in this repository. Nothing here can tell you whether they still exist.

**Cost now:** extract the templates to real `.luau` files loaded at build time, write one
contract file for `__MCP`, add a parse step to CI. A day, maybe two.

**Cost later:** every new `evalTool` is another unverified string. At 100 tools this is a
migration, not a refactor.

**Fix:** `src/luau/<tool>.luau` as real files with a tiny `{{args}}` substitution; a single
`src/luau/mcp-api.d.luau` declaring the helper surface, kept in lockstep with the plugin;
`luau-analyze` over the directory in CI. That also kills `luaJson`'s escaping bug class
(`AUDIT.md` finding 12) by construction, because arguments stop being spliced into source text.

---

### 2. "Can this tool write?" is answered in four places that already disagree
**Future proof**

**Where:** `src/registry.ts:186` and `:202` (default `false`), `src/registry.ts:211`
(`mutateTool` forces `true`), `src/server.ts:776-782` (`isWriteTool` special-cases four names),
`src/bridge.ts:273` (`/rpc` allowlists two literal strings), plus 58 hand-written `write:`
flags in `seed.ts` and `pro.ts`.

**What happens:** add any second axis of permission and you edit four classifier sites plus 58
declarations. The obvious next ones are all close: a read-only session mode for sharing, a
"this touches the filesystem" flag for `profile_update`, a transport-level confirm for
destructive ops. Each is a four-site change today.

The deeper problem is that all four sites classify by **tool name** when the real property is
**which channel the tool uses**. A tool built by `evalTool` ships arbitrary Luau down the eval
path; that is a fact about its construction, not a label someone remembers to write. The audit
found six tools whose label is wrong, and `bridge.ts:273` is a two-name allowlist on an
endpoint that forwards any name at all.

`mutateTool` at `registry.ts:211` is the one place that gets it right — it hardcodes
`write: true` because every mutate batch writes, by construction. That pattern should be the
whole design.

**Cost now:** one function. Tag each constructor with its channel, derive capability from the
channel, delete the name lists.

**Cost later:** the label and the truth drift further apart with every tool, and the gate is
security-relevant.

**Fix:** add `channel: "eval" | "mutate" | "dispatch" | "local"` to `ToolEntry`, set it in the
three constructors, and replace `isWriteTool` and the `/rpc` allowlist with one
`capabilities(entry)` in `registry.ts` that both call.

---

### 3. No transport seam — all 58 handlers are typed against the concrete HTTP class
**Hardlocked**

**Where:** `src/registry.ts:29` (`ToolContext.bridge: StudioBridge`), `src/server.ts:299`
(`createMcpServer(bridge: StudioBridge)`), `src/server.ts:707`.

**What happens:** `DESIGN.md` already names the change — "Open Cloud is one transport; the main
path is the in-Studio plugin." Adding it means every handler signature is already welded to an
HTTP long-poll class that owns a port, a queue, a heartbeat and a protocol handshake.

The sharper cost is testing, and I can prove it: to exercise **any** part of this server for
the audit I had to bind a real port and write a fake plugin that speaks the long-poll protocol.
There is no way to call a tool handler with a stub. That is why `package.json` has no `test`
script and all seven files in `test/` need a live Studio.

**Cost now:** about an hour. The interface is three members.

**Cost later:** grows with the handler count, and blocks every unit test anyone might write.

**Fix:**

```ts
export interface StudioTransport {
  send(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  readonly connected: boolean;
  readonly writeEnabled: boolean;
}
```

`StudioBridge implements StudioTransport`; `ToolContext.bridge` and `createMcpServer` take the
interface. Nothing else changes, and all 58 tools become unit-testable against a fake.

---

### 4. Four writers mutate the visible tool set with no owner, and session state never invalidates
**Organization / over-engineering**

**Where:** `src/server.ts:423`, `:514`, `:693` (three independent `session.unlock` paths),
`src/server.ts:485` (`evict`), writing `session.active` in `src/session.ts:55/79/91`.
Separately, `src/server.ts:710` caches `placeContext` with no invalidation path.

**What happens:** three unlock paths and an eviction pass all write the same `Set` with no
arbitration. That is not a hypothetical — it is precisely why `search_tools` reports tools that
eviction removes in the same turn, and drops the highest-ranked matches first (`AUDIT.md`
finding 8). The next obvious features both require unpicking all four: "keep `tools/list`
stable so the client can cache it," and "let me pin a tool so it stops being evicted."

The `placeContext` half is worse and simpler. `if (session.placeContext) return
session.placeContext;` is the only read, and nothing ever clears it. Open a different place in
Studio without restarting the MCP server and every profile write for the rest of the session
goes to the first place's `placeId`. The system assumes one place per process; Studio does not.

**This is also the over-engineering flag.** `evict` + `applyAutoUnlock` + `sticky.recentClasses`
+ `searchCache` + `suggestNext` + `prefetch` + `buildMeta` cost accounting is a lot of
independent machinery serving one goal (token thrift), and the audit found a defect in four of
those seven. Some of it is earning its keep; the eviction cap is not, and `suggestNext` shipped
a follow-up with empty args for a year.

**Cost now:** a ~60-line `ToolSetManager` that owns `active` and does evict-then-report in one
place. Re-key `placeContext` off the `placeId` the plugin already reports.

**Cost later:** every new heuristic that wants to touch the tool set adds a fifth writer.

**Fix:** one owner for `active`, with unlock and evict resolved before the response is built.
Then delete the eviction cap until you have evidence a real client needs it — the simplest
version of this system has `search_tools` unlock and nothing ever evict.

---

### 5. Exact-equality protocol version between two halves that ship separately
**Future proof**

**Where:** `src/protocol.ts:15` (`PROTOCOL_VERSION = 1`), `src/bridge.ts:177`
(`if (got !== PROTOCOL_VERSION)`).

**What happens:** every future release is a flag day. Ship any additive server change, bump the
constant, and every user running the previous plugin gets a hard 426 until they rebuild. The
architecture explicitly forbids the lockstep it depends on: `.gitignore:29` and the README both
say the plugin is distributed separately from this repo, and `CLAUDE.md:13` says the two halves
are "decoupled by design." They are not decoupled; they are pinned to the same integer by
equality.

The comment above the constant even distinguishes breaking from additive changes ("Pure
additive fields do NOT need a bump") — the code has no way to express that distinction.

**Cost now:** a min/max range and a capability list on the handshake. An afternoon.

**Cost later:** proportional to how many people are running the plugin when you first need to
ship a breaking change.

**Fix:** the plugin sends `{ protocol, supports: [...] }`; the server accepts
`MIN_PROTOCOL <= got <= PROTOCOL_VERSION` and feature-detects the rest. Reserve the hard reject
for genuinely incompatible majors.

---

### 6. Tools live in two files named by wave, not by domain
**Organization**

**Where:** `src/seed.ts` (2,101 lines, 46 tools, 10 categories), `src/pro.ts` (693 lines, 12
tools, self-described at line 2 as "second wave of coverage"), against the 14-value `Category`
union at `src/registry.ts:11-25`.

**What happens:** the `ui` and `assets` categories are declared and hold zero tools. When you
add the first UI tool, does it go in `seed.ts` or `pro.ts`? `pro.ts` is named chronologically,
so it cannot answer. A new contributor cannot tell in ten seconds, and neither could I.

`seed.ts` is the dumping ground every project has: it carries instances, scripts, debug,
session memory, playtest, and vision tools in one 2,101-line file, and `src/vision.ts` exists
separately for one tool that used to live there.

**Cost now:** mechanical. One file per `Category` value, no logic changes.

**Cost later:** still mechanical, just bigger. This is the cheapest flaw on the list and the
least urgent.

**Fix:** `src/tools/instances.ts`, `src/tools/playtest.ts`, and so on — the `Category` union
already names the files for you. `SEED_TOOLS` becomes a concat of the 14 arrays.

---

## What's already good

Progressive tool disclosure is the right core bet, and the `ToolEntry` + `Category` +
MiniSearch spine is a clean way to express it — the file layout just fails to use it.

`mutateTool` routing through `ctx.handleMutate` rather than `bridge.send` (`registry.ts:211-217`,
with a comment explaining exactly why) is the one place in the codebase where a capability is
derived structurally instead of labelled by hand. It is the pattern flaw 2 should copy.

`snapshot-diff.ts` is genuinely well-factored: pure functions, no I/O, no bridge dependency,
unit-testable as-is. It is the only module in `src/` you can test today without a fake plugin.

---

## Fix order

1. **Flaw 3, the transport interface.** An hour, and it unblocks testing everything else. Do
   this before any other refactor so the rest has a safety net.
2. **Flaw 2, capability from channel.** Small, and it is security-relevant — `AUDIT.md`
   findings 2 and 27 are both downstream of it.
3. **Flaw 4, one owner for the tool set**, plus the `placeContext` invalidation. Fixes a
   user-visible correctness bug, not just structure.
4. **Flaw 5, protocol range.** Cheap, and the cost of skipping it only shows up once you have
   users — which is the worst time to discover it.
5. **Flaw 1, Luau extraction.** The biggest job. Worth doing before the tool count grows, but
   not before the four above.

**Leave alone for now:** flaw 6 (file split) — it is pure churn until one of the above forces
you into those files anyway; do it opportunistically. Also leave `memory.ts` alone: macro and
snapshot persistence is flagged as a deliberate open question in `DESIGN.md`, not an oversight.
And do not add a DI container, a plugin system, or a second abstraction layer over the
registry. At 58 tools and one developer, the interface in flaw 3 is all the indirection this
earns.

---

## What would make it genuinely top tier

The flaws above are about not rotting. This section is about the ceiling. Ranked by leverage.

### Elicitation — the single highest-value thing missing

The SDK in `node_modules` is 1.29.0 and ships `ElicitRequest`. The server declares
`{ tools: { listChanged: true }, resources: {} }` at `server.ts:310` and uses none of it.

Right now `mutate` returns `needs_confirmation` and *hopes* the model relays the question to a
human. That is not a safety gate, it is a suggestion to an LLM — and an LLM that wants to
finish the task is the worst possible arbiter of whether the task should finish. Elicitation
lets the server ask the user directly, mid-call, through the client UI.

It also fixes the write-mode flow. Instead of "writes are off, go flip a switch in Studio and
retry," the server asks, the user answers, the call proceeds. That closes the ugliest usability
seam in the product and the weakest structural point in the security model at the same time.

### A `studio://api-dump` resource

The agent guesses Roblox property names, types and enum values constantly, gets them wrong, and
produces a failed `mutate` — this is the single largest source of wasted turns in normal use.
Roblox publishes a machine-readable API dump. One resource, cached per Studio version, and a
whole error class disappears. Cheapest large win available; an afternoon of work.

It also makes the property coercion in `mutate` honest. Today the coercer guesses from the
property's *current* value; with a dump it can know the declared type.

### Tool annotations

`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` are standard MCP `Tool`
fields. Zero uses across the entire codebase. This is the same information as flaw 2's `write`
flag, except it renders in the client and the user sees it before approving. Do this as part of
flaw 2's fix — derive both from the channel, emit one to the client and enforce the other
server-side.

### Fill the two empty categories

`ui` and `assets` are declared with zero tools, and they are not arbitrary gaps — they are the
two things Roblox developers do constantly that this server cannot help with.

**UI** is the painful one. Building a `ScreenGui` through raw `mutate` means hand-rolling
`UDim2`, anchor points, `UIListLayout` and scaling for every element. A handful of specialists
(`ui_frame`, `ui_text`, `ui_layout`, `ui_scale_check`) would cover most of it.

**Assets** means there is no `insert_model`, no marketplace search, no `InsertService:LoadAsset`.
"Put a tree here" is table stakes and is currently impossible unless the agent already happens
to know an asset ID.

### Server-pushed notifications

A runtime error during a playtest cannot reach the agent until it thinks to call `logs_tail`.
Declaring the `logging` capability and pushing `notifications/message` turns the existing
diagnostics ring buffer into a live stream. Same mechanism gives `notifications/progress` for
long mutate batches. Add `resources: { subscribe: true }` and a client can watch
`studio://errors/recent` directly.

This is the difference between an agent that asks "did it work?" and one that gets told.

### Skip for now

**Sampling** (`CreateMessageRequest`, server invokes the client's model as a sub-agent). It is
in `DESIGN.md` as an open question and it is the most speculative item here. Revisit once
elicitation is in and you have a feel for how much the client round-trip actually costs.

**Embedding search** for `search_tools`. `DESIGN.md:775` already says to test keyword search on
50 real queries first. That is still the right call — and given flaw 4, the ranking is not
currently the bottleneck, the eviction is.
