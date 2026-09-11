# Everything wrong with the MCP, in plain English

38 issues total: **32 bugs** (numbered `#1`-`#32`, full detail in `AUDIT.md`) and
**6 structural problems** (numbered `A1`-`A6`, full detail in `ARCHITECTURE-REVIEW.md`).

> ## Status: all fixed
> **36 fixed outright, 1 partial, 1 withdrawn as a false positive.** Verified by 83
> unit tests that run with no Studio, no port and no plugin (`npm test`), plus CI on
> Node 20 and 22. Before/after for every one:
> https://claude.ai/code/artifact/a666b176-8a6d-4482-a083-62a8c9151173
>
> **`#12` was withdrawn, not fixed.** The `\uXXXX` escape it flagged is always
> preceded by a doubled backslash, which Lua reads as a literal backslash — leaving
> valid JSON for `JSONDecode`. The original code round-tripped correctly. Neither
> the audit nor the verification pass checked the doubling. `luaJson` was rewritten
> anyway (byte-exact `\ddd` escapes), but that is hardening, not a bug fix.
>
> **`A1` is partly fixed.** The `__MCP` contract now has a single declaration
> (`src/tools/mcp-api.ts`) and a test that fails on drift, which closes the failure
> A1 actually described. Full extraction of the 33 templates into real `.luau` files
> with a parser in CI is still open.
>
> **One change needs the plugin updated.** The bridge now requires a bearer token
> (protocol 2). A plugin that does not send one gets 401. `CUBES_MCP_ALLOW_UNAUTHENTICATED=1`
> is an explicit, loudly-warned escape hatch until the plugin catches up.

This file is the readable index. Same numbers as the other two docs, so you can jump
between them. It is a record of what was wrong, not a to-do list.

**For what to build next, read `PLAN.md`.**

Grouped by what actually goes wrong, not by severity label. Severity is still marked on
each line so you know what to care about.

---

## Group 0 — Found while implementing PLAN.md

**`#33` · HIGH · `script_edit` overwrote script source with writes OFF** *(fixed)*
The fix for `#13` rewrote `script_edit` so its find/replace happens in TypeScript, which
made it a "local" tool — and local tools aren't write-class, so the *Allow writes* toggle
stopped applying to it. It read the script, patched it, and wrote it back with the toggle
off. Proven end to end, not inferred.

Two fixes, both wanted. The channel now describes where the *effect* lands, not where the
computation happens (`pipelineTool`), so the tool is write-class again. And the gate moved
to the entrance of the mutate pipeline itself, so any future caller on any channel is
covered. `test/unit/write-gate.test.mjs` now asserts the invariant by behaviour: with
writes off, no tool by any route can get a write command to Studio.

---

## Group 1 — Anyone can control your Studio

This is the worst group. The bridge on port 44820 has no lock on it at all. It never checks
who is talking to it.

**`#1` · CRITICAL · The bridge has no lock**
Any program running on your PC can POST to `/rpc` and drive Studio. No password, no check of
who's asking. A website you visit might be able to do it too (browsers block some of this,
which is why this is "any program" first and "any website" second).
`src/bridge.ts:263-311`

**`#27` · HIGH · Someone can flip your "Allow writes" switch ON**
One fake message to `/poll` turns write mode on. You never touch the panel, the plugin still
says it's off, and the attacker gets write access for ~25 seconds. Repeatable forever.
This is why "just leave writes off" is not actually protection.
`src/bridge.ts:192`

**`#28` · HIGH · Commands can be stolen and results faked**
The server can't tell your real plugin apart from any other program. So something else can
grab the commands meant for Studio (including your script source), or send back fake results.
The agent would believe a change happened that never did.
`src/bridge.ts:173-232, 350-377`

**`#29` · MEDIUM · The command queue has no limit**
Flood it with 3000 commands and your next real command waits behind all of them, then times
out. The plugin works through the attacker's list first.
`src/bridge.ts:153`

**`#4` · MEDIUM · No limit on how big a request can be**
One 64MB POST took the server from 89MB to 538MB of RAM. A few of those at once and it dies.
`src/bridge.ts:380-395`

**`#6` · MEDIUM · One bad message freezes everything for 25 seconds**
Send garbage to `/poll` and every command fails until your plugin's next poll clears it.
Keep sending it once a second and the MCP stays dead.
`src/bridge.ts:119-128, 176-191`

**`#32` · LOW · Two endpoints crash ugly on bad input**
`/result` handles a malformed body cleanly. `/poll` and `/rpc` don't, and leak the raw parser
error in a 500.
`src/bridge.ts:173-196, 263-311`

---

## Group 2 — The safety switches don't actually work

You built guards. Most of them have a way around them.

**`#2` · HIGH · Six tools ignore "Allow writes" entirely**
Tools default to `write: false` unless someone remembers to type otherwise. So
`wait_until`, `debug_highlight`, `debug_clear`, `test_run`, `step_frames` and `selection_set`
all reach Studio with writes turned off. Worst one is `wait_until` — it runs whatever Luau
you hand it, and it's labelled as a non-writing tool.
`src/registry.ts:186`, `src/seed.ts:1958`

**`#3` · HIGH · The screenshot tool can run any Windows command**
`insets` is declared as a number in the schema, but nothing checks it. Pass text instead and
it gets pasted straight into the PowerShell script and runs. Nothing anywhere in the server
validates tool arguments against their schema.
`src/vision.ts:46-79`, `src/server.ts:380`

**`#13` · MEDIUM · `script_edit` skips the confirm prompt**
Overwriting a script through `mutate` asks you to confirm first. Doing the exact same thing
through `script_edit` doesn't ask at all, and doesn't get linted either.
`src/seed.ts:419`

**`#10` · MEDIUM · Reading a resource skips the write check**
`studio://overview` and `studio://selection` send `eval` to Studio without going through the
write gate at all. The Luau is fixed so it's not dangerous, but the gate doesn't cover what
you think it covers.
`src/server.ts:351, 366`

**`#16` · LOW · Unknown operations are treated as safe**
If an op isn't `create`, `set` or `delete`, it's classified as harmless and skips confirmation.
Should be the opposite — unknown means dangerous.
`src/safety.ts:37-50`

**`#17` · LOW · The "deleting a service" warning misses most cases**
`Workspace` triggers the big warning. `game.Workspace`, `workspace`, or a ref like `p3` all
get the mild one. They all still ask you to confirm, but the message understates what's about
to happen.
`src/safety.ts:46`

**`#30` · MEDIUM · Your README says the write gate doesn't exist**
`README.md:172` says "Writes are always-on in this build." `CLAUDE.md:46` and the actual code
say the opposite. Somebody has to decide which is true — it changes how bad `#1`, `#2` and
`#27` actually are.
`README.md:172`

---

## Group 3 — It lies to you

These don't crash. They quietly report something that isn't true, which is worse, because you
trust it.

**`#8` · MEDIUM · `search_tools` reports tools it then deletes**
Ask for 12 tools, it says "Unlocked 12, they are now in your tool list." Only 8 are. And the
4 it throws away are the 4 best matches, because of how the eviction sort works. It even
suggests calling one of the tools it just removed.
`src/server.ts:502-526, 485`

**`#9` · MEDIUM · Failed tool calls are reported as successes**
MCP has a flag for "this call failed" (`isError`). You never set it. So every error — bad
args, unknown tool, Studio not connected — looks like a clean success to the client.
`src/server.ts:497`

**`#11` · LOW · Profile saves overwrite each other**
Ran 10 profile updates at once, 1 survived. The comment in the code specifically claims they
serialize safely. They don't. Also, the function with that comment is dead code — nothing
calls it.
`src/profile.ts:108-121`

**`#19` · LOW · The snapshot follow-up suggestion is empty**
After a snapshot it suggests `diff` with no arguments, because it reads a key the handler
never returns.
`src/suggest.ts:176`

**`#20` · LOW · The docs describe a folder that was never in the repo**
`CLAUDE.md` explains how to build `roblox/src/Transport.luau`. That folder has never been in
git, not once. The README also lists `lighting_configure` and `script_create` as tools — neither
exists. And `CLAUDE.md` says four core tools while the code has five.
`CLAUDE.md`, `README.md`

---

## Group 4 — Just broken or dead

**`#7` · MEDIUM · Your Luau linter has never run. Not once.**
It tries to launch selene from a folder (`roblox/`) that isn't in the repo and never was. The
launch fails on the folder before it even looks for selene, so installing selene wouldn't help.
Every `mutate` that writes a script silently reports "lint unavailable."
`src/lint.ts:19, 91`

**`#5` · MEDIUM · If Studio crashes mid-poll, one command vanishes**
The server hands the command to a dead connection, it disappears, and the caller waits the
full 30 seconds for nothing. Reconnecting doesn't recover it.
`src/bridge.ts:318-348`

**`#15` · MEDIUM · Screenshot has three separate problems**
No size limit, so a 1440p capture is ~1.4-4MB of base64 in one message. Temp PNGs are only
deleted when it fails, so every successful screenshot leaves a file behind forever. And the
default captures your whole monitor — every other window you have open goes to the model.
Also it's Windows-only, but it's a core tool and the README documents macOS setup.
`src/vision.ts:109-213`

**`#12` · LOW · Weird characters break the generated Luau**
If an argument contains an invisible control character, the generated Luau won't compile and
you get an unhelpful `compile_error` instead of "bad input."
`src/registry.ts:225-230`

**`#14` · LOW · `instance_duplicate` has no limit**
`count: 1000000` goes straight through and hangs Studio. Its sibling `parts_grid` caps at
50x50 with a comment explaining why, so this looks like an oversight.
`src/seed.ts:62`

**`#18` · LOW · Slow memory leak in the bridge**
An internal array grows with every command timeout and never drains.
`src/bridge.ts:350-361`

**`#22` · LOW · Slow tools block everything else**
`wait_until` and `logs_wait_for` can hold things for 25 seconds against a 30-second timeout.
Anything queued behind them is cutting it close.
`src/seed.ts`

**`#23` · LOW · Server errors after startup disappear**
The error handler only works during startup. After that, errors are silently swallowed.
`src/bridge.ts:109`

**`#24` · LOW · The write flag never resets when the plugin disconnects**
A reconnecting plugin can inherit the last session's setting.
`src/bridge.ts:192`

**`#25` · LOW · Every response is serialized three times**
Twice for the token estimate, once for the wire. Worst on big reads, which is exactly where it
hurts most.
`src/server.ts:448, 497, 787`

**`#26` · LOW · Call history keeps entire script files in memory**
Capped at 200 entries by count, not by size. Each one can hold a whole script's source.
`src/server.ts:457`, `src/memory.ts:44`

**`#21` · LOW · No tests that run without Studio, no CI**
There's no `test` script and no `.github/` folder. All 7 test files need a live Studio with the
plugin connected. Meanwhile `safety.ts`, `snapshot-diff.ts`, `luaJson` and the tool set could
all be unit tested today with zero Roblox involved.
`package.json`

**`#31` · LOW · Some tools may leave undo broken** *(not confirmed — needs a real Studio)*
`constraint_add` and `sky_configure` open an undo recording then do unguarded writes. If one
errors, the recording never closes, and later changes might stop being undoable.
`src/pro.ts:531-574, 630-689`

---

## Group 5 — Why future changes will hurt

These aren't bugs. Nothing is broken today. They're the reasons the next six months get
expensive.

**`A1` · Your Luau is built from strings, against rules written down nowhere**
`__MCP` is used 83 times across your templates and defined 0 times in this repo. Change one
helper and you're grepping 33 templates with nothing to catch a miss — it fails at runtime,
inside Studio, only for that one tool. It's already drifted: `run_code` advertises 10 helpers
to the model, your templates use 6.

**`A2` · "Can this tool write?" is answered in 4 places that disagree**
The default, the `mutateTool` override, `isWriteTool`, and the `/rpc` allowlist. Plus 58
hand-typed flags. Six are already wrong (that's `#2`). The real answer isn't the tool's *name*,
it's which *channel* it uses — which the code already knows.

**`A3` · Nothing can be tested without Studio**
All 58 tool handlers are typed against the concrete HTTP bridge class. Proof: to test anything
for this audit I had to open a real port and write a fake plugin. One small interface fixes it
and unlocks unit tests for everything.

**`A4` · Four different bits of code fight over the visible tool list**
Three unlock paths plus eviction, all writing the same set, nobody in charge. That's the cause
of `#8`. Same file, separate problem: `placeContext` is cached once and never refreshed, so
switching places in Studio without restarting sends every profile write to the old place ID.

**`A5` · The version check forces the two halves to upgrade in lockstep**
It's an exact-equality check. But the plugin ships separately from this repo, so you can't
guarantee lockstep. `CLAUDE.md` literally says the halves are "decoupled by design" — they
aren't, they're pinned to the same integer. Every future release becomes a flag day.

**`A6` · Tools live in files named by *when* they were written, not *what* they do**
`seed.ts` is 2,101 lines holding 10 different categories. `pro.ts` calls itself "second wave."
So when you add the first UI tool, there's no way to know which file it belongs in. You already
have a 14-value category list that names the files for you.

---

## What to actually do first (historical)

This was the order the fixes were done in. Kept so the commits make sense.

1. **`A3`** — the transport interface. About an hour, and it lets you test everything else.
   Do this before any other refactor so you have a safety net.
2. **`#1`, `#27`, `#28`** — lock the bridge, both directions. Nothing about it is trustworthy
   until commands and results are authenticated. This is the whole ballgame.
3. **`A2` + `#2` + `#3`** — work out capability from the channel, and validate tool arguments.
   Kills three security bugs at the root instead of one at a time.
4. **`#30`** — decide whether writes are gated or always-on, then make README, CLAUDE.md and
   the code agree. One-line answer, but it changes how you grade the rest.
5. **`#7`, `#8`, `#9`, `#11`** — the ones where the code says one thing and does another.
   Each is small and independent.
6. **`#21`** — unit tests for the four pure modules, so `#8`, `#12`, `#16` and `#17` can't
   come back.

**Leave alone for now:** `A6` (moving files around) is pure churn until something else sends
you into those files anyway. And don't add a plugin system or another layer over the registry —
at 58 tools and one dev, the interface in `A3` is all the indirection this earns.
