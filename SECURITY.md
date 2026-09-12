# Security

This server opens a listening socket on your machine and hands whatever connects
to it the ability to drive Roblox Studio. That is the entire threat model, and
everything below follows from it.

## Reporting a problem

Open an issue at https://github.com/thiscube/cubes-roblox-mcp/issues. If it is
something that should not be public first, say so in the issue without the
details and we will find somewhere better to talk.

There is no bounty and no SLA. This is one person's project.

## What the bridge is

`127.0.0.1:44820`, HTTP, plus an optional WebSocket on `/ws`. It exists because
a Roblox Studio plugin cannot listen on a socket but can make outbound requests
to localhost. The plugin connects **to** this server; this server never connects
out to Studio.

It binds loopback only. It is not reachable from your network.

## The four checks

Every route runs all four before doing any work (`src/bridge.ts`, `guard()`):

1. **No `Origin` header.** A browser attaches one to every cross-origin request.
   The plugin never sends one, so its presence alone is disqualifying.
2. **Loopback `Host`.** DNS rebinding gives an attacker's page a same-origin path
   to 127.0.0.1, but the `Host` header still carries their domain.
3. **`Content-Type: application/json`.** `text/plain` and the form encodings are
   CORS-"simple" and can be sent without a preflight. Requiring JSON forces a
   preflight that this server never answers.
4. **A bearer token.** Generated per run, printed to stderr at startup. Compared
   with `timingSafeEqual`.

Check 1 is the one carrying the most weight on the WebSocket, because **a
WebSocket is not subject to CORS at all**. Any page on any site can open one to
127.0.0.1 and the browser will not stop it. Refusing every upgrade that carries
an `Origin` is the whole defence there.

`/health` is the single exception: it skips the token, because liveness is not a
secret. It still runs checks 1 and 2.

## What this does not protect against

**Any other program running as you.** A local process can read the token from
this server's stderr, or from `CUBES_MCP_TOKEN` in your environment, and then do
anything the plugin can do. Loopback plus a token stops web pages and other
users; it does not stop code you have already chosen to run.

**A malicious Studio plugin.** The plugin half is the trusted half. It reports
your *Allow writes* toggle and this server believes it.

**Your model.** The write gate and the confirm gate exist because a model that
wants to finish a task is the worst possible arbiter of whether it should. They
are not a defence against a model that has been told to do damage by someone who
can already type into your session.

## Write mode

Write-class tools are gated behind the *Allow writes* toggle in the Studio panel.
The plugin reports it on every poll, and a poll that omits the field means OFF —
a reconnecting plugin never inherits the previous session's toggle.

Whether a tool is write-class is **derived from how it reaches Studio**, not from
a label someone remembered to type. See CLAUDE.md. This matters here because the
one time it was labelled rather than derived, `script_edit` overwrote script
source with the toggle off.

Destructive batches — deleting instances, overwriting script source — need
`confirm: true` on top of the toggle. When the client supports MCP elicitation
the server asks you directly rather than returning a refusal and hoping the model
relays it.

## Running it read-only

`--read-only`, or `CUBES_MCP_READ_ONLY=1`. Every write-class tool is removed from
the process: `mutate`, `run_code` and 41 specialists are not registered, cannot
be called by name, cannot be found by `search_tools`. `/rpc` refuses writes
whatever the Studio panel says.

This is stronger than the toggle. There is no gate to get wrong and nothing for a
determined model to argue its way past, because the tools are not there.

## `CUBES_MCP_ALLOW_UNAUTHENTICATED=1`

Do not use this.

It exists for a plugin too old to send a token. It disables check 4 on every
route, which means any local process can drive Studio **and can forge the *Allow
writes* toggle** by posting a fake `/poll` — so "just leave writes off" stops
being protection. The server prints a warning to stderr for as long as it is set.

## The token

Generated per run with `randomBytes` and printed to stderr. Pin it across
restarts with `CUBES_MCP_TOKEN` if your plugin stores it.

On the WebSocket upgrade only, it may also travel as `?token=` in the URL,
because Roblox's WebSocket client cannot be relied on to set custom headers. That
is a real downgrade — query strings end up in logs — and it is why the HTTP
routes refuse it.

## Data that leaves your machine

Two things, both on purpose and both to Roblox:

- **The API dump** (`setup.rbxcdn.com`), fetched for the `docs_*` tools and
  cached for 24 hours. Nothing about your place is sent. `CUBES_MCP_OFFLINE=1`
  stops it entirely.
- **Nothing else.** No telemetry. Profiles, macros and snapshots are files under
  `~/.cubesmcp` and never leave.

Screenshots and place contents go to your MCP client, which is the point, and
from there wherever that client sends them.
