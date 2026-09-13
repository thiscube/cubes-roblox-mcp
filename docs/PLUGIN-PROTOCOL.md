# What the Studio plugin has to implement

The plugin is not in this repository (see `CLAUDE.md`), so this file is the
contract the server expects. Everything here is what the server sends and what
it does with the answer, taken from the code rather than from memory.

Protocol version is a **range**: the server accepts
`MIN_PROTOCOL_VERSION`..`MAX_PROTOCOL_VERSION` (`src/protocol.ts`). Report your
version on every `/poll`. Additive commands never raise MIN, so an older plugin
keeps working and simply misses the new features.

## Transport

```
POST /poll     -> { protocol, writeEnabled }   long-poll, held up to 25s
POST /result   -> { id, ok, result | error }
POST /rpc      -> out-of-band tool call, deny-by-default
POST /health
```

Every route needs `Authorization: Bearer <token>`, no `Origin` header, a
loopback `Host`, and `Content-Type: application/json`.

**`writeEnabled` is load-bearing.** A `/poll` that omits it means OFF. It is the
user's "Allow writes" toggle and the server gates every write-class tool on it.

## What the plugin half must honour

None of this is enforceable from the server, and all of it is load-bearing.
Sources are Roblox staff posts and reproduced community reports; the numbers are
theirs, not guesses.

**A plugin gets 5 concurrent HTTP requests, and the budget is GLOBAL.** Not per
plugin — five across every plugin the user has installed. Rojo, an LSP companion,
a Discord presence plugin and this bridge all draw from the same pool. Roblox
staff, 2024-06-11: *"We now allow up to 5 parallel requests for plugins and 8 for
user scripts in Studio."*

That has three consequences:

- A parked long-poll holds one of the five for as long as it is open. Two Studio
  windows hold two.
- An abandoned poll — the user hit Disconnect, the server restarted, the place
  closed — keeps its slot until the request times out, and **the plugin cannot
  cancel it**. This is Rojo's most reported bug, and the original report notes
  *"the only way to clear this queue is to restart Roblox Studio."*
- So: never open a second poll while one is outstanding, and let the server's
  25s hold (`POLL_HOLD_MS`) bound the damage rather than inventing a longer one.

**Guard the poll loop on `RunService:IsEdit()`.** Entering play mode instantiates
a *separate copy of the whole plugin per DataModel* — edit, play-server and
play-client all run your code independently. The play-client copy cannot make
HTTP requests at all: it fails with `Http requests can only be executed by game
server`. Without the guard, every playtest spawns extra pollers that burn the
5-slot budget and one of them errors confusingly. A competing MCP has this bug
filed: their event stream dies after 1–5 play cycles, and a four-hour automated
run needed 36 Studio restarts.

**The rate ceiling drops when Play starts.** Measured: 2000 requests/min for a
plugin in edit mode, 500/min once a playtest is running, 0 on the client. The
drop applies to the edit-context plugin too, not only the new copies.

**Do not tell users to enable *Allow HTTP Requests*.** It has been irrelevant to
plugins since March 2020 — *"All previously existing Studio plugins will now use
the new model and ignore the game's Allow HTTP Requests setting"*. What replaced
it is a per-domain permission prompt on first request, which locally-installed
plugins bypass. Several Roblox MCP READMEs still carry the old instruction as a
required setup step; it is pure friction and this one does not repeat it.

**Consider `WebStreamClient` over long-polling.** Roblox shipped SSE (Aug 2025)
and WebSockets (Oct 2025) in Studio explicitly to retire it — staff: *"we wanted
to ensure that not all of them are blocked by long running streaming requests."*
The `/ws` transport below is protocol 4 for this reason. The catch is a separate
global budget of 4 stream clients, also shared with every other plugin.

## Commands

| command | protocol | answer |
|---|---|---|
| `eval` | 1 | whatever the Luau returned, JSON-safe |
| `mutate` | 1 | `{ applied, changes: [{ ref, added, modified, removed }] }` |
| `read` | 1 | `{ instances \| children, cursor?, snapshot? }` |
| `snapshot` | 1 | `{ instances: [{ path, className, props }] }` |
| `diagnostics` | 1 | recent errors/warnings, run mode, totals |
| `viewport` | 1 | camera state plus on-screen instances with 2D bounds |
| `tune` | 1 | eval, but in the running playtest's server DataModel |
| playtest lifecycle | 1 | see `src/tools/playtest.ts` |
| **`capture`** | **3** | **`{ png, width, height }`** |

Protocol 4 adds the WebSocket transport below; it carries the same commands.

Every command sent while an MCP tool call is running also carries `via`, the
call it serves: `{ "tool": "script_edit", "category": "scripts", "activity": "Scripting" }`.
`activity` is a one-word label from `src/activity.ts`, ready to display.
`category` is absent for core tools (`read`, `mutate`, `run_code`, `screenshot`), and
`via` itself is absent for commands the server sends on its own. It exists so a
panel can show what the agent is doing rather than guessing from `tool`, which
is `mutate` for a script patch and a part grid alike. Optional to read; a plugin
that ignores it loses nothing.

## `capture` (protocol 3)

Sent as `{ region, maxEdge }`. `region` is `"viewport"` or `"studio"`; `maxEdge`
is the longest edge the server wants, currently 1400.

Answer with `{ png: "<base64>", width, height }`. The field may be called
`base64` instead; the server accepts either.

Implement it with `StudioCaptureService:CaptureScreenshot()`, which returns the
framebuffer directly. That is the point of the command: the server's fallback
shells out to the host OS and captures whatever pixels happen to be inside
Studio's window rect, so a window on top of Studio ends up in the shot.

Two things the server already handles, so do not work around them:

- **No handler is fine.** Any failure (unknown command, timeout, a structured
  `{ error }`) makes the server fall back to the OS path and remember, for a
  minute, not to ask again. It never fails the screenshot because of this.
- **Keep it under ~1.4 MB of base64.** Larger answers are refused rather than
  inlined, because the payload goes into the model's context. Honour `maxEdge`.

`StudioCaptureService` is FFlag-gated and missing from some Studio builds, so
check `CanCaptureScreenshot` first and answer with a structured error when it is
unavailable — the OS path picks it up from there.

## WebSocket (protocol 4, optional)

Long-poll still works and is still the default. A plugin may instead open a
socket to `ws://127.0.0.1:<port>/ws`.

Auth is the same four checks minus content-type. The token goes in
`Authorization: Bearer <token>`, or in `?token=` on the URL if your client cannot
set headers — that second form is accepted **only** on the upgrade, never on the
HTTP routes.

**Send no Origin header.** A WebSocket is not subject to CORS, so any web page
can open one to 127.0.0.1 and the browser will not stop it. What the browser
always does is attach an Origin, and the plugin never does, so the bridge refuses
any upgrade that carries one. If your client adds an Origin automatically, you
cannot use this transport.

Messages are JSON text frames.

Plugin to server:

```
{ "type": "hello",  "protocol": 4, "writeEnabled": true }
{ "type": "state",  "writeEnabled": false }
{ "type": "result", "id": "...", "ok": true,  "result": { ... } }
{ "type": "result", "id": "...", "ok": false, "error": { "code": "...", "message": "..." } }
{ "type": "ping" }
```

Server to plugin:

```
{ "type": "welcome", "protocol": 4 }
{ "type": "command", "id": "...", "tool": "read", "args": { ... } }
{ "type": "error",   "error": "protocol_mismatch", "supported": [2, 4], "got": 1 }
{ "type": "pong" }
```

Four things to get right:

- **`hello` first.** Commands queued before it are drained the moment it arrives.
- **`writeEnabled` is still load-bearing**, and a `state` message without the
  field means OFF. Closing the socket also turns writes off immediately: write
  permission must not outlive the plugin that granted it.
- **One socket.** A second connection replaces the first, which is closed with
  `replaced_by_new_connection`.
- **Unknown message types are ignored, not fatal.** That is what keeps the
  protocol additive in this direction too.

Do not expect this to be faster in any way you can feel. Measured on loopback
(`test/bench/poll-latency.mjs`): long-poll p50 1.4ms, socket p50 0.06ms. Both are
noise next to Studio doing the work. The reason to implement it is that the
plugin can push when nothing was asked of it, which long-poll cannot do.

## Several Studio windows (protocol 5, optional)

Add `instanceId`, and optionally `placeId`, `placeName` and `role`, to `/poll`
and to the WebSocket `hello`:

```json
{ "protocol": 5, "writeEnabled": true,
  "instanceId": "a-stable-id-for-this-window",
  "placeId": 4242, "placeName": "Lobby", "role": "edit" }
```

`instanceId` must be stable for the life of that Studio window and different
between windows. `role` is free text; `edit`, `server` and `client-N` are what
the server's own output assumes.

A plugin that sends none of this is filed under a single default id and behaves
exactly as it always has — that is what makes protocol 5 additive.

Routing, once ids are in play:

- A command **addressed** to a window is only ever handed to that window. If it
  is not connected, the command waits in the queue and eventually times out. It
  is never diverted to a different window.
- A command with **no** address goes to whoever polls first, which is what every
  command did before this existed.

## The `__MCP` sandbox

Generated Luau calls into a `__MCP` table the plugin injects. The declaration is
`src/tools/mcp-api.ts` and a test fails the build when a template calls something
undeclared. Keep the two in lockstep and bump the protocol when the surface
changes.
