# Configuration

Everything is an environment variable, except one command-line flag. Nothing has
a config file, on purpose: the MCP client already owns the launch command, so a
second place to look is a second place to be wrong.

## Quick reference

| Variable | Default | What it does |
|---|---|---|
| `CUBES_MCP_PORT` | `44820` | Bridge listen port. Must match the Studio panel. |
| `CUBES_MCP_TOKEN` | `$CUBES_MCP_HOME/token` | Overrides the persisted bridge token. |
| `CUBES_MCP_RPC_TOKEN` | unset | Deprecated alias for the above. |
| `CUBES_MCP_READ_ONLY` | unset | `1` removes every write tool from the process. |
| `CUBES_MCP_HOME` | `~/.cubesmcp` | Where profiles and the API dump cache live. |
| `CUBES_MCP_OFFLINE` | unset | `1` forbids the API-dump download. |
| `CUBES_MCP_SOURCEMAP` | autodetect | Path to a Rojo `sourcemap.json`. |
| `CUBES_MCP_LINT_CWD` | repo root | Directory holding your `selene.toml`. |
| `CUBES_MCP_OPEN_CLOUD_KEY` | unset | Open Cloud API key. Only `asset_upload` needs it. |
| `CUBES_MCP_UPLOAD_ROOT` | working directory | The only directory `asset_upload` may read from. |
| `CUBES_MCP_ALLOW_UNAUTHENTICATED` | unset | `1` disables the bridge token. Unsafe. |

Plus `--read-only` on the command line, equivalent to `CUBES_MCP_READ_ONLY=1`.

## Wiring it into a client

```json
{
  "mcpServers": {
    "cubes-roblox": {
      "command": "node",
      "args": ["/path/to/cubes-roblox-mcp/dist/index.js"],
      "env": { "CUBES_MCP_TOKEN": "paste-a-long-random-string-here" }
    }
  }
}
```

The server talks MCP over stdio, so **stdout is reserved for the protocol**. All
logging goes to stderr. Don't run `node dist/index.js` by hand expecting output
unless you hold stdin open:

```bash
node dist/index.js < <(sleep 86400)
```

## `CUBES_MCP_PORT`

The port has to match on both sides: this server and the Studio panel. If the
panel is on 44820 and the server is on 44821, the plugin polls nothing forever
and every tool call comes back `studio_not_connected`.

Change it when something else already owns 44820, or when you want two places
open at once — one server, one port, one Studio each.

## `CUBES_MCP_TOKEN`

Without it, a token is created on first run, written to `$CUBES_MCP_HOME/token`
at mode 0600, and printed to stderr that once:

```
[cubes-mcp] bridge token: 9f2c…
[cubes-mcp] paste this into the Cubes MCP panel in Studio. It is saved to
[cubes-mcp] ~/.cubesmcp/token and will not change on restart.
```

Later runs load the same value and do not re-echo it. So you paste it into the
Studio panel once, not once per restart. Set the variable instead if you would
rather keep the token out of `$CUBES_MCP_HOME` entirely — an env token is never
written to disk. Any long random string works;
it is compared byte for byte.

See SECURITY.md for what the token does and does not protect.

`CUBES_MCP_RPC_TOKEN` is accepted as an alias, for configurations written before
the variable was renamed. Prefer `CUBES_MCP_TOKEN`; if both are set, that one
wins.

## `CUBES_MCP_READ_ONLY`

`1`, `true`, or the `--read-only` flag. The server reports itself as
`cubes-roblox-mcp-inspector` so the client can tell which build it got, and
`tools/list` is `search_tools`, `read`, `screenshot` plus 28 inspector-safe specialists.

Use it when you want a model looking at a place it must not touch.

## `CUBES_MCP_HOME`

Everything this server persists lives here: per-place profiles under
`profiles/`, and the cached Roblox API dump as `api-dump.json` (about 4 MB).

Point it somewhere local if your home directory roams or syncs — you do not want
a 4 MB cache file replicating to three machines.

## `CUBES_MCP_OFFLINE`

`1` forbids the API-dump download outright. The `docs_*` tools then serve the
cached copy however old it is, and fail loudly if there isn't one, rather than
reaching for the network.

Set it in CI, or on a machine that should not make outbound requests. The test
suite sets it so a stray fetch fails the build instead of passing on a connection
that a laptop might not have.

## `CUBES_MCP_SOURCEMAP`

Path to a Rojo `sourcemap.json`. When it loads, every script the server returns
is annotated with its on-disk `source_file`, so the model can edit the real file
instead of the DataModel copy.

Left unset, the server looks for `sourcemap.json` in the working directory. If
you set it to a path that does not exist, it says so on stderr and falls back to
the autodetect rather than silently doing nothing.

Generate one with:

```bash
rojo sourcemap default.project.json --output sourcemap.json
```

## `CUBES_MCP_LINT_CWD`

Every `mutate` that writes script `Source` is run through selene server-side and
the diagnostics come back in the response. selene needs a `selene.toml`, and this
points at the directory holding yours.

If selene is not installed, or no config is found, linting is off and the server
says so once at startup. Nothing else changes.

## `CUBES_MCP_OPEN_CLOUD_KEY`

Only `asset_upload` reads it. Searching the Creator Store, reading asset details
and fetching thumbnails all use public endpoints and need no credentials, which
is deliberate: the part people actually want works the moment they install.

Create a key at https://create.roblox.com/dashboard/credentials with the asset
write scope.

`asset_upload` asks you directly whenever the client can show a prompt. There is
no way for the model to skip that — `confirm: true` is only honoured by clients
that cannot prompt at all, because `confirm` is a field the model itself writes.

## `CUBES_MCP_UPLOAD_ROOT`

The only directory `asset_upload` may read from. Defaults to the working
directory, which is chosen by whoever launched the server rather than by this
code — so set it explicitly if you care.

Paths are resolved through their symlinks before the boundary is checked, so a
`.rbxm` inside the project pointing somewhere else is refused. A root of `/` or
a bare home directory is refused outright: a boundary check against those
confines nothing, and the appearance of a boundary is worse than none.

## `CUBES_MCP_ALLOW_UNAUTHENTICATED`

`1` turns off the bridge token. Read SECURITY.md before you do. The short version
is that it lets any local process forge your *Allow writes* toggle, so leaving
writes off stops protecting you.

It exists for plugins predating protocol 2. Unset it as soon as yours catches up.

## Checking it works

```bash
TOKEN=...   # from stderr, or whatever you pinned
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:44820/health
```

```json
{ "ok": true, "connected": true, "transport": "long-poll", "queued": 0,
  "protocol": 4, "protocolRange": [2, 4], "authRequired": true }
```

`connected: false` means the plugin is not polling: wrong port, plugin not
installed, or its toolbar button is off. `transport` says whether it is
long-polling or holding a WebSocket. A `handshake` with `ok: false` means the
plugin's protocol is outside `protocolRange` and it needs rebuilding.
