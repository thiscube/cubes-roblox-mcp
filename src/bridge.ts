import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { MAX_PROTOCOL_VERSION, MIN_PROTOCOL_VERSION, protocolSupported } from "./protocol.js";
import { BridgeError, type StudioTransport } from "./transport.js";

/**
 * The bridge between the MCP server (this process) and the Roblox Studio plugin.
 *
 * Studio plugins cannot open sockets, but they CAN make outbound HTTP requests to
 * localhost. So the plugin is a long-polling client: it asks "any command for me?",
 * we hold the request open until a command is queued (or it times out), the plugin
 * runs the command in Studio, then POSTs the result back.
 *
 *   Claude <--stdio--> MCP server <--HTTP long-poll--> Studio plugin --> DataModel
 *
 * SECURITY MODEL
 * --------------
 * Binding to 127.0.0.1 stops remote attackers but NOT other local processes, and
 * not a browser page the user happens to open. So every route is defended by four
 * independent checks (see `guard`):
 *
 *   1. Bearer token       - proves the caller is the plugin we handed the token to.
 *   2. No `Origin` header - a browser always sends one cross-origin; the plugin never does.
 *   3. Loopback `Host`    - defeats DNS rebinding, which resolves an attacker domain to 127.0.0.1.
 *   4. JSON content-type  - blocks the CORS "simple request" form/text-plain trick.
 *
 * The token is mandatory by default. `CUBES_MCP_ALLOW_UNAUTHENTICATED=1` disables
 * check 1 only (2-4 still apply) for users running an older plugin; it logs a loud
 * warning because it re-opens the write-toggle forgery described in AUDIT.md #27.
 */

export { BridgeError };

export interface BridgeCommand {
  id: string;
  // Bridge tool name — "eval" | "read" | "mutate" | "diagnostics" or one of the
  // native plugin tools dispatched from the plugin's Transport (playtest_*, event_*).
  tool: string;
  args: Record<string, unknown>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Returns true if it actually handed the command to a live socket. */
type Waiter = (cmd: BridgeCommand | null) => boolean;

/**
 * How long we hold a /poll request open before sending an empty 204 ("re-poll").
 * Must stay safely under Studio's HttpService:RequestAsync internal timeout
 * (which Roblox documents loosely as ~30s but varies under Studio load). 25s
 * keeps a 5s margin under the 30s ceiling.
 */
const POLL_HOLD_MS = 25_000;
/**
 * Plugin is considered connected if it polled within this window. MUST be
 * larger than POLL_HOLD_MS — otherwise /health.connected oscillates true/false
 * during normal idle long-polling, since lastSeen only updates when a poll arrives.
 */
const HEARTBEAT_WINDOW_MS = 30_000;
/** Max bytes accepted on any request body (AUDIT.md #4). */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Max commands allowed to sit in the queue before we shed load (AUDIT.md #29). */
const MAX_QUEUE = 256;
/** Bound on remembered timed-out command ids (AUDIT.md #18). */
const CANCELLED_MAX = 1000;

/** Build the bearer token for this process. Explicit env wins; otherwise random per run. */
function resolveToken(): { token: string; generated: boolean } {
  const fromEnv = process.env.CUBES_MCP_TOKEN ?? process.env.CUBES_MCP_RPC_TOKEN;
  if (fromEnv && fromEnv.length > 0) return { token: fromEnv, generated: false };
  return { token: randomBytes(24).toString("hex"), generated: true };
}

/** Constant-time compare that does not leak length through early return. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface GuardFailure {
  status: number;
  code: string;
  message: string;
}

export class StudioBridge implements StudioTransport {
  private readonly port: number;
  private readonly queue: BridgeCommand[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly waiters: Waiter[] = [];
  /**
   * Ids of commands we gave up on (timed out) but which may still be in flight in
   * Studio. A late /result for one is discarded rather than resolving a stale
   * promise. A Map (not Set + parallel array) so deletion also drops the entry
   * from insertion order and the structure genuinely drains — AUDIT.md #18.
   */
  private readonly cancelled = new Map<string, true>();
  private lastSeen = 0;
  private _writeEnabled = false;
  private lastHandshake: { protocol: number | null; ok: boolean; at: number } | null = null;
  private httpServer?: Server;
  readonly token: string;
  readonly tokenGenerated: boolean;
  private readonly allowUnauthenticated: boolean;

  /**
   * Read-only build (PLAN.md #13): `/rpc` refuses every write, whatever the
   * Studio panel's toggle says. The MCP surface has no write tools in this mode,
   * and `/rpc` is a second door into the same plugin — leaving it open would
   * make the guarantee meaningless.
   */
  readonly readOnly: boolean;

  /**
   * Command names `/rpc` will run without write mode.
   *
   * Passed in by the composition root, derived from `capabilities()`, because
   * the bridge sits BELOW the tool layer and must not import it. It used to be a
   * hardcoded Set here, which drifted: sixteen tools that `capabilities()` calls
   * read-only were refused by `/rpc`, including every docs lookup, and two
   * entries named commands that are not tools at all. CLAUDE.md says capability
   * is derived and never labelled; this was the last hand-maintained label.
   */
  private readonly readOnlyCommands: ReadonlySet<string>;

  constructor(
    port: number,
    opts: { readOnly?: boolean; readOnlyCommands?: Iterable<string> } = {},
  ) {
    this.port = port;
    this.readOnly = opts.readOnly ?? false;
    // Default to the plugin-native names only. Fails closed: a bridge built
    // without the derived set refuses more than it needs to, never less.
    this.readOnlyCommands = new Set([
      ...PLUGIN_NATIVE_READ_COMMANDS,
      ...(opts.readOnlyCommands ?? []),
    ]);
    const { token, generated } = resolveToken();
    this.token = token;
    this.tokenGenerated = generated;
    this.allowUnauthenticated = process.env.CUBES_MCP_ALLOW_UNAUTHENTICATED === "1";
    if (this.allowUnauthenticated) {
      process.stderr.write(
        "[cubes-mcp] WARNING: CUBES_MCP_ALLOW_UNAUTHENTICATED=1 — the bridge will accept " +
          "unauthenticated local requests. Any process on this machine can drive Studio and " +
          "can forge the 'Allow writes' toggle. Unset it as soon as your plugin supports tokens.\n",
      );
    }
  }

  /** True if the Studio plugin has polled us recently. */
  get connected(): boolean {
    return Date.now() - this.lastSeen < HEARTBEAT_WINDOW_MS;
  }

  /**
   * True only if the plugin is connected AND the user has flipped on "Allow
   * writes" in the Studio panel. The read/write split: the agent is read-only
   * until the user opts in through the client UI.
   */
  get writeEnabled(): boolean {
    return this.connected && this._writeEnabled;
  }

  /**
   * The most recent handshake, or null if nobody has polled. Informational only:
   * unlike the old sticky `protocolMismatch`, a bad handshake from some other
   * poster can no longer block `send()` while a good plugin is connected
   * (AUDIT.md #6).
   */
  get handshake(): { protocol: number | null; ok: boolean; at: number } | null {
    return this.lastHandshake;
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  /**
   * The port actually bound, after `start()`.
   *
   * Differs from the requested port only when 0 was requested, which is how
   * tests ask the OS for a free one. Fixed test ports collided intermittently
   * because `node --test` runs files in parallel.
   */
  get boundPort(): number {
    const addr = this.httpServer?.address();
    return typeof addr === "object" && addr ? addr.port : this.port;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          process.stderr.write(`[cubes-mcp] request failed: ${String(err)}\n`);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
          }
          if (!res.writableEnded) res.end(JSON.stringify({ error: "internal_error" }));
        });
      });
      // Reject only the startup attempt; later errors must be logged, not
      // swallowed by a settled promise (AUDIT.md #23).
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.port, "127.0.0.1", () => {
        this.httpServer?.removeListener("error", reject);
        this.httpServer?.on("error", (err) => {
          process.stderr.write(`[cubes-mcp] bridge server error: ${String(err)}\n`);
        });
        resolve();
      });
    });
  }

  /** Shut the HTTP listener down. Used by tests and by clean exit paths. */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new BridgeError("bridge_stopped", "The Studio bridge was shut down."));
      }
      this.pending.clear();
      if (!this.httpServer) return resolve();
      this.httpServer.close(() => resolve());
      this.httpServer.closeAllConnections?.();
    });
  }

  /**
   * Queue a command for the Studio plugin and await its result.
   * Rejects fast with a structured BridgeError if the plugin isn't connected.
   */
  send(tool: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (!this.connected) {
      const hs = this.lastHandshake;
      if (hs && !hs.ok) {
        return Promise.reject(
          new BridgeError(
            "plugin_version_mismatch",
            `Studio plugin protocol ${hs.protocol ?? "missing"} is outside the supported range ` +
              `${MIN_PROTOCOL_VERSION}-${MAX_PROTOCOL_VERSION}. Rebuild and reinstall the Cubes MCP plugin, then restart Studio.`,
            hs,
          ),
        );
      }
      return Promise.reject(
        new BridgeError(
          "studio_not_connected",
          "The Roblox Studio plugin is not polling. Open Studio with a place loaded, install the Cubes MCP plugin, and make sure its toolbar button is active.",
        ),
      );
    }
    if (this.queue.length >= MAX_QUEUE) {
      return Promise.reject(
        new BridgeError(
          "bridge_busy",
          `The command queue is full (${MAX_QUEUE}). Studio is not keeping up, or something is flooding the bridge.`,
        ),
      );
    }

    const cmd: BridgeCommand = { id: randomUUID(), tool, args };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmd.id);
        const qIdx = this.queue.findIndex((c) => c.id === cmd.id);
        if (qIdx >= 0) this.queue.splice(qIdx, 1);
        // Otherwise it's already in flight in Studio: remember the id so a late
        // /result is discarded cleanly rather than resolving a stale promise.
        else this.markCancelled(cmd.id);
        reject(new BridgeError("studio_timeout", `Studio did not respond within ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(cmd.id, { resolve, reject, timer });
      this.dispatch(cmd);
    });
  }

  /**
   * Hand a command to a live waiter, or queue it. Waiters whose socket died are
   * skipped rather than silently swallowing the command (AUDIT.md #5).
   */
  private dispatch(cmd: BridgeCommand): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter && waiter(cmd)) return;
    }
    this.queue.push(cmd);
  }

  private markCancelled(id: string): void {
    this.cancelled.set(id, true);
    while (this.cancelled.size > CANCELLED_MAX) {
      const oldest = this.cancelled.keys().next().value;
      if (oldest === undefined) break;
      this.cancelled.delete(oldest);
    }
  }

  // ------------------------------------------------------------------------
  // Request guard
  // ------------------------------------------------------------------------

  /**
   * The four checks every route runs before doing any work. Returns null when the
   * request is allowed, or the failure to send back.
   */
  private guard(req: IncomingMessage, opts: { requireJson: boolean }): GuardFailure | null {
    // A browser attaches Origin to every cross-origin request. The plugin never
    // sends one, so its presence alone is disqualifying.
    if (req.headers.origin !== undefined) {
      return { status: 403, code: "origin_not_allowed", message: "Cross-origin requests are not accepted." };
    }

    // DNS rebinding gives an attacker page a same-origin path to 127.0.0.1, but
    // the Host header still carries their domain.
    const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
    if (!loopback) {
      return { status: 403, code: "host_not_allowed", message: "Host must be loopback." };
    }

    // text/plain and form encodings are CORS-"simple" and can be sent without a
    // preflight. Requiring JSON forces a preflight that we never answer.
    if (opts.requireJson) {
      const ct = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (ct !== "application/json") {
        return { status: 415, code: "unsupported_media_type", message: "Content-Type must be application/json." };
      }
    }

    if (!this.allowUnauthenticated) {
      const presented = this.presentedToken(req);
      if (!presented || !tokenMatches(presented, this.token)) {
        return { status: 401, code: "unauthorized", message: "Missing or invalid bridge token." };
      }
    }
    return null;
  }

  private presentedToken(req: IncomingMessage): string {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
      return auth.slice(7).trim();
    }
    const header = req.headers["x-cubes-token"];
    if (typeof header === "string") return header;
    if (Array.isArray(header) && header[0]) return header[0];
    return "";
  }

  private static deny(res: ServerResponse, failure: GuardFailure): void {
    res.statusCode = failure.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: failure.code, message: failure.message }));
  }

  // ------------------------------------------------------------------------
  // Routing
  // ------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? "/").split("?")[0];

    // /health is the one unauthenticated route: it reveals nothing but liveness
    // and still refuses browsers and non-loopback hosts.
    if (url === "/health") {
      const failure = this.guard(req, { requireJson: false });
      if (failure && failure.code !== "unauthorized") return StudioBridge.deny(res, failure);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          connected: this.connected,
          queued: this.queue.length,
          protocol: MAX_PROTOCOL_VERSION,
          protocolRange: [MIN_PROTOCOL_VERSION, MAX_PROTOCOL_VERSION],
          handshake: this.lastHandshake,
          authRequired: !this.allowUnauthenticated,
        }),
      );
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 404;
      res.end();
      return;
    }

    const failure = this.guard(req, { requireJson: true });
    if (failure) return StudioBridge.deny(res, failure);

    if (url === "/poll") return this.routePoll(req, res);
    if (url === "/result") return this.routeResult(req, res);
    if (url === "/rpc") return this.routeRpc(req, res);

    res.statusCode = 404;
    res.end();
  }

  private async routePoll(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (!body.ok) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: body.code, message: body.message }));
      return;
    }
    const got: number | null = typeof body.value?.protocol === "number" ? body.value.protocol : null;
    const ok = got !== null && protocolSupported(got);
    this.lastHandshake = { protocol: got, ok, at: Date.now() };
    if (!ok) {
      res.statusCode = 426;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: "protocol_mismatch",
          supported: [MIN_PROTOCOL_VERSION, MAX_PROTOCOL_VERSION],
          got,
          message:
            `Cubes MCP plugin protocol ${got ?? "missing"} is outside the supported range ` +
            `${MIN_PROTOCOL_VERSION}-${MAX_PROTOCOL_VERSION}. Rebuild the plugin and restart Studio.`,
        }),
      );
      return;
    }
    // A missing field means "off", never "unchanged" — a reconnecting plugin must
    // not inherit the previous session's toggle (AUDIT.md #24).
    this._writeEnabled = body.value?.writeEnabled === true;
    this.lastSeen = Date.now();
    await this.holdPoll(res);
  }

  private async routeResult(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (!body.ok) {
      // Try to recover the id so the matching pending call fails now rather than
      // sitting until its 30s timer.
      const qs = (req.url ?? "").split("?")[1] ?? "";
      const recoveredId = new URLSearchParams(qs).get("id") ?? headerString(req, "x-id");
      if (recoveredId) {
        this.handleResult({
          id: recoveredId,
          ok: false,
          error: { code: body.code, message: body.message },
        });
      }
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: body.code, message: body.message }));
      return;
    }
    this.lastSeen = Date.now();
    this.handleResult(body.value);
    res.statusCode = 204;
    res.end();
  }

  /**
   * Direct command injection — authenticated, loopback only, for debugging and
   * scripted ops when the MCP tools aren't loaded in the calling session.
   *
   * Write-class tools honour the user's "Allow writes" toggle. Classification is
   * deny-by-default against an explicit read-only list, so a tool name nobody
   * anticipated (`tune`, `character_teleport`, ...) is treated as a write rather
   * than waved through — AUDIT.md #1.
   */
  private async routeRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (!body.ok) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: body.code, message: body.message }));
      return;
    }
    const tool = body.value?.tool;
    const args = body.value?.args ?? {};
    if (typeof tool !== "string") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "missing_tool" }));
      return;
    }
    if (!this.readOnlyCommands.has(tool) && (this.readOnly || !this.writeEnabled)) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: this.readOnly ? "read_only_build" : "write_mode_disabled",
          tool,
          hint: this.readOnly
            ? "This server was started read-only. Restart without CUBES_MCP_READ_ONLY to write."
            : "Open the Cubes MCP panel in Roblox Studio and enable 'Allow writes', then retry.",
        }),
      );
      return;
    }
    try {
      const result = await this.send(tool, args as Record<string, unknown>);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err: any) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: false,
          error: err?.code ?? "error",
          message: err?.message ?? String(err),
          detail: err?.detail,
        }),
      );
    }
  }

  /** Long-poll: hand over a queued command immediately, or hold until one arrives. */
  private holdPoll(res: ServerResponse): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      // Declared up front: the queued-command path below calls `waiter` (and so
      // `finish`) BEFORE the long-poll timer is ever armed, and a `const` here
      // would be in its temporal dead zone at that moment.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        settled = true;
        if (timer) clearTimeout(timer);
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve();
      };

      const waiter: Waiter = (cmd) => {
        if (settled) return false;
        // The socket may have died while parked. Report failure so the caller
        // re-dispatches instead of dropping the command (AUDIT.md #5).
        if (res.destroyed || res.writableEnded) {
          finish();
          return false;
        }
        finish();
        if (cmd) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(cmd));
        } else {
          res.statusCode = 204;
          res.end();
        }
        return cmd !== null;
      };

      const queued = this.queue.shift();
      if (queued) {
        if (!waiter(queued)) this.queue.unshift(queued);
        return;
      }

      this.waiters.push(waiter);
      // Studio going away must free the waiter immediately, not 25s later.
      res.on("close", () => {
        if (!settled) finish();
      });
      timer = setTimeout(() => waiter(null), POLL_HOLD_MS);
    });
  }

  private handleResult(body: any): void {
    const { id, ok, result, error } = body ?? {};
    if (!id) return;
    // If the server already gave up on this command, drop the late result.
    if (this.cancelled.has(id)) {
      this.cancelled.delete(id);
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (ok) {
      pending.resolve(result);
    } else {
      // Plugin handlers historically used either { code, message } or { error: "..." }.
      const errStr = typeof error?.error === "string" ? error.error : undefined;
      const code = error?.code ?? errStr ?? "studio_error";
      const message = error?.message ?? errStr ?? "Studio operation failed.";
      pending.reject(new BridgeError(code, message, error));
    }
  }
}

/**
 * Plugin commands with no MCP tool of their own.
 *
 * `/rpc` classifies by NAME, and most names are tool names that `capabilities()`
 * already classifies — the composition root passes that derived set in. These
 * two are plugin-native commands a human might call over `/rpc` directly, so
 * they have no tool entry to derive from and are listed explicitly.
 *
 * This is the whole hand-maintained surface, and it is read-only by
 * construction. Everything else — including plugin commands this server has
 * never heard of — is treated as a write.
 */
const PLUGIN_NATIVE_READ_COMMANDS: ReadonlySet<string> = new Set(["diagnostics", "viewport"]);

type JsonBody =
  | { ok: true; value: any }
  | { ok: false; code: string; message: string };

function headerString(req: IncomingMessage, name: string): string {
  const v = req.headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v[0]) return v[0];
  return "";
}

/**
 * Read and parse a JSON body with a hard byte cap. Oversized bodies are refused
 * before they are buffered and the socket is destroyed, so a single large POST
 * can no longer take the process from 89MB to 538MB (AUDIT.md #4). Every route
 * shares this, so malformed input is a structured 400 everywhere rather than a
 * raw parser error in a 500 (AUDIT.md #32).
 */
function readJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<JsonBody> {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"] ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.destroy();
      return resolve({ ok: false, code: "payload_too_large", message: `Body exceeds ${maxBytes} bytes.` });
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const settle = (v: JsonBody) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    req.on("data", (c: Buffer) => {
      if (done) return;
      total += c.length;
      if (total > maxBytes) {
        req.destroy();
        return settle({ ok: false, code: "payload_too_large", message: `Body exceeds ${maxBytes} bytes.` });
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return settle({ ok: true, value: {} });
      try {
        settle({ ok: true, value: JSON.parse(raw) });
      } catch (err) {
        settle({ ok: false, code: "bad_json", message: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => settle({ ok: false, code: "request_error", message: String(err) }));
    req.on("aborted", () => settle({ ok: false, code: "request_aborted", message: "Client aborted the request." }));
  });
}
