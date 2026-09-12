import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { MAX_PROTOCOL_VERSION, MIN_PROTOCOL_VERSION, protocolSupported } from "./protocol.js";
import { BridgeError, type StudioInstance, type StudioTransport } from "./transport.js";

/**
 * The bridge between the MCP server (this process) and the Roblox Studio plugin.
 *
 * Studio plugins cannot listen on sockets, but they CAN make outbound HTTP requests
 * to localhost. So the plugin is a long-polling client: it asks "any command for
 * me?", we hold the request open until a command is queued (or it times out), the
 * plugin runs the command in Studio, then POSTs the result back.
 *
 * A newer plugin can open a WebSocket to /ws instead (protocol 4). Long-poll stays
 * the default and the fallback, and the reason is worth writing down because it is
 * not the one people expect: latency is NOT the problem. A parked poll is handed a
 * command the moment one is queued, so a sequential command costs about 1.5ms at
 * p50 on loopback (test/bench/poll-latency.mjs), which is noise next to Studio
 * doing the work. What the socket buys is the direction long-poll cannot do at
 * all: the plugin can push when nothing has been asked of it, and the server can
 * dispatch without a poll in flight.
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
  /**
   * Which Studio window this is for (PLAN.md #11). Undefined means "whoever
   * asks first", which is what every command was before instances existed and
   * what every command still is when only one plugin is connected.
   */
  target?: string;
}

/**
 * A plugin that sends no instance id. Everything before protocol 5 is this, and
 * so is every single-window session, so it is a real id rather than a special
 * case threaded through the queue.
 */
const DEFAULT_INSTANCE = "studio";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Returns true if it actually handed the command to a live socket. */
type Waiter = ((cmd: BridgeCommand | null) => boolean) & { instance: string };

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
  /**
   * Connected Studio windows, by id (PLAN.md #11).
   *
   * One entry for a normal session. The plugin half that reports distinct ids
   * per window is not in this repo, so a plugin that sends none is recorded
   * under a single default id and behaves exactly as it always has.
   */
  private readonly instances = new Map<string, StudioInstance>();
  /** The plugin's WebSocket, when it chose that transport. */
  private socket: WebSocket | null = null;
  /** Which Studio window the socket belongs to. */
  private socketInstance = DEFAULT_INSTANCE;
  private wss?: WebSocketServer;
  private _writeEnabled = false;
  private lastHandshake: { protocol: number | null; ok: boolean; at: number } | null = null;
  /** Last protocol we complained about, so a polling plugin doesn't spam stderr. */
  private warnedProtocol: number | null | undefined;
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
    // Empty by default. Fails closed: a bridge built without the derived set
    // (src/rpc-policy.ts) refuses every /rpc call rather than guessing.
    this.readOnlyCommands = new Set(opts.readOnlyCommands ?? []);
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

  /** True if the Studio plugin holds a socket, or has polled us recently. */
  get connected(): boolean {
    if (this.socketOpen) return true;
    return Date.now() - this.lastSeen < HEARTBEAT_WINDOW_MS;
  }

  private get socketOpen(): boolean {
    return this.socket !== null && this.socket.readyState === 1; // OPEN
  }

  /** Which transport the plugin is using. Informational, reported by /health. */
  get transportKind(): "websocket" | "long-poll" | "none" {
    if (this.socketOpen) return "websocket";
    return Date.now() - this.lastSeen < HEARTBEAT_WINDOW_MS ? "long-poll" : "none";
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

  /** Every Studio window currently connected, most recently seen first. */
  listInstances(): StudioInstance[] {
    const alive = [...this.instances.values()].filter(
      (i) => Date.now() - i.lastSeen < HEARTBEAT_WINDOW_MS || i.transport === "websocket",
    );
    return alive.sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** Record or refresh a connection. Returns the id it was filed under. */
  private noteInstance(info: {
    id?: unknown;
    placeId?: unknown;
    placeName?: unknown;
    role?: unknown;
    transport: "websocket" | "long-poll";
    protocol: number | null;
    writeEnabled: boolean;
  }): string {
    const id = typeof info.id === "string" && info.id.trim() ? info.id.trim().slice(0, 64) : DEFAULT_INSTANCE;
    this.instances.set(id, {
      id,
      ...(typeof info.placeId === "number" ? { placeId: info.placeId } : {}),
      ...(typeof info.placeName === "string" ? { placeName: info.placeName } : {}),
      ...(typeof info.role === "string" ? { role: info.role } : {}),
      transport: info.transport,
      writeEnabled: info.writeEnabled,
      lastSeen: Date.now(),
      protocol: info.protocol,
    });
    return id;
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
      // The WebSocket endpoint shares the HTTP listener. `noServer` means every
      // upgrade goes through our own guard first — ws never sees a request we
      // have not authenticated.
      this.wss = new WebSocketServer({ noServer: true });
      this.httpServer.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));

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
      this.socket?.close(1001, "bridge_stopped");
      this.socket = null;
      this.wss?.close();
      this.wss = undefined;
      if (!this.httpServer) return resolve();
      this.httpServer.close(() => resolve());
      this.httpServer.closeAllConnections?.();
    });
  }

  /**
   * Queue a command for the Studio plugin and await its result.
   * Rejects fast with a structured BridgeError if the plugin isn't connected.
   */
  send(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs = 30_000,
    target?: string,
  ): Promise<unknown> {
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
    // Defence in depth. Until now the write gate lived only in callers, and
    // `send()` — the one function that actually talks to Studio — enforced
    // nothing. `handleMutate`'s guard is `connected && !writeEnabled`, so with
    // the plugin disconnected a mutate falls through it into here; if the plugin
    // reconnects before the queue drains, the command lands with the user's
    // toggle off. Small window, needs a reconnect to hit, free to close. Same
    // policy the /rpc door uses, so there is one rule and two doors.
    if (!this.readOnlyCommands.has(tool) && (this.readOnly || !this.writeEnabled)) {
      return Promise.reject(
        new BridgeError(
          this.readOnly ? "read_only_build" : "write_mode_disabled",
          this.readOnly
            ? `This server was started read-only; '${tool}' is a write command.`
            : "Writes are off. Open the Cubes MCP panel in Roblox Studio and enable 'Allow writes', then retry.",
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

    const cmd: BridgeCommand = { id: randomUUID(), tool, args, ...(target ? { target } : {}) };
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
    // A live socket takes it immediately: no queue, no waiting for a poll.
    if (this.socketOpen && (!cmd.target || cmd.target === this.socketInstance)) {
      try {
        this.socket?.send(
          JSON.stringify({ type: "command", id: cmd.id, tool: cmd.tool, args: cmd.args }),
        );
        return;
      } catch {
        // The socket died between the readyState check and the write. Fall
        // through to the queue rather than dropping the command.
      }
    }
    // Only hand it to a window it is addressed to. An untargeted command goes to
    // whoever is parked, which is what every command did before instances.
    for (let i = 0; i < this.waiters.length; i += 1) {
      const waiter = this.waiters[i];
      if (cmd.target && waiter.instance !== cmd.target) continue;
      this.waiters.splice(i, 1);
      if (waiter(cmd)) return;
      i -= 1;
    }
    this.queue.push(cmd);
  }

  /**
   * Say it out loud, once per distinct version.
   *
   * A mismatched plugin polls every few seconds, so this cannot log every time —
   * but it also cannot stay silent. Without it the only symptom is every tool
   * call failing with `studio_not_connected`, which sends people looking at
   * ports and firewalls instead of at the plugin they need to rebuild.
   */
  private noteHandshake(got: number | null, ok: boolean): void {
    this.lastHandshake = { protocol: got, ok, at: Date.now() };
    if (ok) {
      this.warnedProtocol = undefined;
      return;
    }
    if (this.warnedProtocol === got) return;
    this.warnedProtocol = got;
    process.stderr.write(
      `[cubes-mcp] PROTOCOL MISMATCH: the Studio plugin reports protocol ${got ?? "none"}, ` +
        `this server speaks ${MIN_PROTOCOL_VERSION}-${MAX_PROTOCOL_VERSION}. ` +
        `Every tool call will fail until the plugin is rebuilt and Studio restarted.\n`,
    );
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
  // WebSocket transport (protocol 4)
  // ------------------------------------------------------------------------

  /**
   * Authenticate an upgrade before ws ever sees it.
   *
   * The Origin check matters more here than anywhere else in this file. A
   * WebSocket is NOT subject to CORS: a page on any site can open one to
   * 127.0.0.1 and the browser will not stop it. What the browser always does is
   * attach an Origin header, and the plugin never sends one — so refusing any
   * upgrade that carries an Origin is the whole defence, and it is not optional.
   */
  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/ws") return StudioBridge.denySocket(socket, 404, "not_found");

    // Same four checks as every HTTP route, minus content-type, which an upgrade
    // does not carry.
    const failure = this.guard(req, { requireJson: false, allowQueryToken: true });
    if (failure) return StudioBridge.denySocket(socket, failure.status, failure.code);

    this.wss?.handleUpgrade(req, socket, head, (ws) => this.adoptSocket(ws));
  }

  private adoptSocket(ws: WebSocket): void {
    // One plugin, one place. A second connection replaces the first rather than
    // racing it for results — the same rule the rest of the bridge assumes.
    if (this.socket && this.socket !== ws) {
      try {
        this.socket.close(1000, "replaced_by_new_connection");
      } catch {
        /* already gone */
      }
    }
    this.socket = ws;
    this.lastSeen = Date.now();

    ws.on("message", (raw) => this.handleSocketMessage(ws, raw.toString()));
    ws.on("close", () => {
      if (this.socket === ws) {
        this.socket = null;
        this.instances.delete(this.socketInstance);
        this.socketInstance = DEFAULT_INSTANCE;
        // Writes must never outlive the plugin that authorised them. Same rule
        // as a /poll that omits the field (AUDIT.md #24).
        this._writeEnabled = false;
      }
    });
    ws.on("error", () => {
      if (this.socket === ws) this.socket = null;
    });
  }

  private handleSocketMessage(ws: WebSocket, raw: string): void {
    if (raw.length > MAX_BODY_BYTES) {
      ws.close(1009, "payload_too_large");
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.close(1003, "bad_json");
      return;
    }
    this.lastSeen = Date.now();

    switch (msg?.type) {
      case "hello": {
        const got: number | null = typeof msg.protocol === "number" ? msg.protocol : null;
        const ok = got !== null && protocolSupported(got);
        this.noteHandshake(got, ok);
        if (!ok) {
          // Same answer as the 426 on /poll: rebuild the plugin.
          ws.send(
            JSON.stringify({
              type: "error",
              error: "protocol_mismatch",
              supported: [MIN_PROTOCOL_VERSION, MAX_PROTOCOL_VERSION],
              got,
            }),
          );
          ws.close(1008, "protocol_mismatch");
          if (this.socket === ws) this.socket = null;
          return;
        }
        this._writeEnabled = msg.writeEnabled === true;
        this.socketInstance = this.noteInstance({
          id: msg.instanceId,
          placeId: msg.placeId,
          placeName: msg.placeName,
          role: msg.role,
          transport: "websocket",
          protocol: got,
          writeEnabled: this._writeEnabled,
        });
        ws.send(
          JSON.stringify({
            type: "welcome",
            protocol: MAX_PROTOCOL_VERSION,
            instanceId: this.socketInstance,
          }),
        );
        // A socket that connects while commands are already queued should drain
        // them rather than wait for something new to happen.
        this.drainQueueToSocket();
        return;
      }
      case "state":
        // A missing field means off, never unchanged.
        this._writeEnabled = msg.writeEnabled === true;
        return;
      case "result":
        this.handleResult(msg);
        return;
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      default:
        // Unknown message types are ignored, not fatal: that is what makes the
        // protocol range additive in this direction too.
        return;
    }
  }

  private drainQueueToSocket(): void {
    while (this.socketOpen && this.queue.length > 0) {
      const idx = this.queue.findIndex((c) => !c.target || c.target === this.socketInstance);
      if (idx < 0) break;
      const [cmd] = this.queue.splice(idx, 1);
      if (!cmd) break;
      this.socket?.send(
        JSON.stringify({ type: "command", id: cmd.id, tool: cmd.tool, args: cmd.args }),
      );
    }
  }

  private static denySocket(socket: Duplex, status: number, code: string): void {
    const reason =
      status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Bad Request";
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nX-Cubes-Error: ${code}\r\n\r\n`);
    socket.destroy();
  }

  // ------------------------------------------------------------------------
  // Request guard
  // ------------------------------------------------------------------------

  /**
   * The four checks every route runs before doing any work. Returns null when the
   * request is allowed, or the failure to send back.
   */
  private guard(
    req: IncomingMessage,
    opts: { requireJson: boolean; allowQueryToken?: boolean },
  ): GuardFailure | null {
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
      const presented = this.presentedToken(req, opts.allowQueryToken === true);
      if (!presented || !tokenMatches(presented, this.token)) {
        return { status: 401, code: "unauthorized", message: "Missing or invalid bridge token." };
      }
    }
    return null;
  }

  private presentedToken(req: IncomingMessage, allowQuery = false): string {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
      return auth.slice(7).trim();
    }
    const header = req.headers["x-cubes-token"];
    if (typeof header === "string") return header;
    if (Array.isArray(header) && header[0]) return header[0];
    // Upgrades only. Roblox's WebSocket client cannot be relied on to set custom
    // headers, so `/ws?token=` is accepted there and nowhere else. It is a real
    // downgrade — query strings land in logs and referrers — but the listener is
    // loopback-only and the token is per-run, so the exposure is a local log
    // file. Never widen this to the HTTP routes, which have no such excuse.
    if (allowQuery) {
      const q = (req.url ?? "").split("?")[1];
      if (q) {
        const value = new URLSearchParams(q).get("token");
        if (value) return value;
      }
    }
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
          transport: this.transportKind,
          instances: this.listInstances(),
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
    this.noteHandshake(got, ok);
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
    const instance = this.noteInstance({
      id: body.value?.instanceId,
      placeId: body.value?.placeId,
      placeName: body.value?.placeName,
      role: body.value?.role,
      transport: "long-poll",
      protocol: got,
      writeEnabled: this._writeEnabled,
    });
    await this.holdPoll(res, instance);
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
  private holdPoll(res: ServerResponse, instance: string): Promise<void> {
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

      const waiter = ((cmd: BridgeCommand | null) => {
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
      }) as Waiter;
      waiter.instance = instance;

      // Take the first queued command this window may run: its own, or one that
      // never named a window. Anything addressed elsewhere stays put.
      const idx = this.queue.findIndex((c) => !c.target || c.target === instance);
      if (idx >= 0) {
        const [queued] = this.queue.splice(idx, 1);
        if (!waiter(queued)) this.queue.splice(idx, 0, queued);
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
