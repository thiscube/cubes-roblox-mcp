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
4. **A bearer token.** Persisted at `$CUBES_MCP_HOME/token` (0600), created on
   first run and printed to stderr that once. Compared
   with `timingSafeEqual`.

Check 1 is the one carrying the most weight on the WebSocket, because **a
WebSocket is not subject to CORS at all**. Any page on any site can open one to
127.0.0.1 and the browser will not stop it. Refusing every upgrade that carries
an `Origin` is the whole defence there.

`/health` is the single exception, and it is **two-tier**.

Liveness is public: it reveals nothing a port scan does not, and the plugin
probes it. Checks 1 and 2 still apply.

The diagnosis is not public. `authRejections` would tell an unauthenticated
caller that its own probes are landing, and `msSinceLastPoll` is a running
account of when the user is at their desk, so both sit behind the token; the
public tier just says they are there. Neither tier carries token material — not
the value, not a prefix, not a length — and there is deliberately no breakdown of
*why* a token was rejected, because a counter that separated "wrong length" from
"wrong value" would undo the constant-time compare at the observability layer.

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
the process: `mutate`, `run_code` and 48 specialists are not registered, cannot
be called by name, cannot be found by `search_tools`. `/rpc` refuses writes
whatever the Studio panel says, and `send()` refuses them at the transport too.

**Everything that reaches outside the process is filtered, not just Studio
writes.** A tool can affect the world in four ways — the DataModel, the disk,
the network, and spawning a binary — and the filter asks about all four. That
was not always true, and the holes were real: `profile_update` shipped in this
build and wrote a file in your home directory, and then `asset_upload` shipped
in it too, a tool that read any file on the machine and posted it to Roblox.

Two things it still does, both deliberate and both named in the code rather than
implied by an omission:

- **`screenshot` is exempt**, because seeing the place is what an inspector is
  for. Its Studio path spawns nothing; the OS fallback spawns your platform's
  capture tool. The exemption is one named constant (`INSPECTOR_EXEMPTIONS`) and
  a test asserts nothing else is on it.
- **The `docs_*` tools fetch the Roblox API dump and cache it.** That is an
  outbound request and a 1.4 MB disk write, declared as both. It stays because a
  cache of a public file is the server's own infrastructure, not your data, and
  an inspector without documentation is not worth shipping. `CUBES_MCP_OFFLINE=1`
  stops it.

`asset_search` also sends its query terms to Roblox. Nothing about your place
goes with them, but a search is still something you typed.

`asset_upload` is now confined to the project directory, checks the extension,
caps the size, and asks you directly every time the client can ask — `confirm:
true` does not skip that prompt, because the model is what supplies `confirm`.

This is stronger than the toggle. There is no gate to get wrong and nothing for a
determined model to argue its way past, because the tools are not there.

## `CUBES_MCP_ALLOW_UNAUTHENTICATED=1`

Do not use this.

It exists for a plugin too old to send a token. It disables check 4 on every
route, so any local process can drive Studio.

It used to be worse: an unauthenticated `/poll` could carry `writeEnabled: true`
and **forge the *Allow writes* toggle**, so "just leave writes off" stopped being
protection. That is closed. In this mode the toggle is not believed at all —
`writeEnabled` is forced false, and write-class commands are refused however the
panel is set. The hatch buys reads. Reproduced before and after: an
unauthenticated `/poll`, an authenticated `/poll` and a `/ws` hello all now leave
`writeEnabled` false, and `/rpc mutate` returns 403.

The server warns on stderr for as long as it is set, and `/health` reports
`unauthenticatedMode` and `writesForcedOff` on its **public** tier — an operator
checking whether their bridge is exposed should not need the credential this mode
disabled.

## The token

`randomBytes(24)`, created on first run and written to `$CUBES_MCP_HOME/token`
at mode 0600, so it survives a restart. `CUBES_MCP_TOKEN` still wins and is
never written to disk.

It used to be generated per run, which was not a security property — the
protocol has no token handoff and a Roblox plugin cannot read files, so a
token that changed on every start just meant the user re-copied it from stderr
every time, and got a 401 when they did not.

The file is a secret at rest, so it is read through `lstat` rather than `stat`
(a planted symlink would otherwise be followed on write, turning this into an
arbitrary file write), and a group- or world-readable file is refused outright
rather than repaired — by the time we notice, whatever could read it already
has. If it cannot be written safely the token stays in memory for that run and
startup says so.

On the WebSocket upgrade only, it may also travel as `?token=` in the URL,
because Roblox's WebSocket client cannot be relied on to set custom headers. That
is a real downgrade — query strings end up in logs — and it is why the HTTP
routes refuse it.

## Data that leaves your machine

Two things, both on purpose and both to Roblox:

- **The API dump** (`setup.rbxcdn.com`), fetched for the `docs_*` tools and
  cached for 24 hours. Nothing about your place is sent. `CUBES_MCP_OFFLINE=1`
  stops it entirely.
- **Asset lookups** (`apis.roblox.com`, `thumbnails.roblox.com`), when you use a
  `asset_*` tool. The search terms go out; nothing about your place does.
- **Nothing else.** No telemetry. Profiles, macros and snapshots are files under
  `~/.cubesmcp` and never leave.

`asset_upload` is the one tool that publishes outward, and it is gated
separately from the Studio write toggle — that toggle is about the open place,
this is about your Roblox account. It needs `CUBES_MCP_OPEN_CLOUD_KEY` and
either `confirm: true` or your answer to an elicitation prompt.

`asset_insert` brings a stranger's model into your place. Scripts and
PackageLinks are destroyed **before** anything is parented, and the strip is
verified afterwards; if anything survived, the model is destroyed rather than
inserted.

Screenshots and place contents go to your MCP client, which is the point, and
from there wherever that client sends them.
