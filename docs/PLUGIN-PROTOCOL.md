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

## Commands

| command | protocol | answer |
|---|---|---|
| `eval` | 1 | whatever the Luau returned, JSON-safe |
| `mutate` | 1 | `{ applied, results }` |
| `read` | 1 | `{ instances \| children, cursor?, snapshot? }` |
| `snapshot` | 1 | `{ instances: [{ path, className, props }] }` |
| `diagnostics` | 1 | recent errors/warnings, run mode, totals |
| `viewport` | 1 | camera state plus on-screen instances with 2D bounds |
| `tune` | 1 | eval, but in the running playtest's server DataModel |
| playtest lifecycle | 1 | see `src/tools/playtest.ts` |
| **`capture`** | **3** | **`{ png, width, height }`** |

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

## The `__MCP` sandbox

Generated Luau calls into a `__MCP` table the plugin injects. The declaration is
`src/tools/mcp-api.ts` and a test fails the build when a template calls something
undeclared. Keep the two in lockstep and bump the protocol when the surface
changes.
