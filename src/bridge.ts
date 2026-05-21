import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION } from "./protocol.js";

/**
 * The bridge between the MCP server (this process) and the Roblox Studio plugin.
 *
 * Studio plugins cannot open sockets, but they CAN make outbound HTTP requests to
 * localhost. So the plugin is a long-polling client: it asks "any command for me?",
 * we hold the request open until a command is queued (or it times out), the plugin
 * runs the command in Studio, then POSTs the result back.
 *
 *   Claude <--stdio--> MCP server <--HTTP long-poll--> Studio plugin --> DataModel
 */

export interface BridgeCommand {
  id: string;
  // Bridge tool name — "eval" | "read" | "mutate" | "diagnostics" or one of the
  // native plugin tools dispatched from Transport.luau (playtest_*, event_*).
  tool: string;
  args: Record<string, unknown>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * How long we hold a /poll request open before sending an empty 204 ("re-poll").
 * Must stay safely under Studio's HttpService:RequestAsync internal timeout
 * (which Roblox documents loosely as ~30s but varies under Studio load). 25s
 * keeps a 5s margin under the 30s ceiling — comfortable, and ~25% fewer idle
 * round-trips than the previous 20s.
 */
const POLL_HOLD_MS = 25_000;
/**
 * Plugin is considered connected if it polled within this window. MUST be
 * larger than POLL_HOLD_MS — otherwise /health.connected oscillates true/false
 * during normal idle long-polling, since lastSeen only updates when a poll
 * arrives.
 */
const HEARTBEAT_WINDOW_MS = 30_000;

export class BridgeError extends Error {
  code: string;
  detail: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export class StudioBridge {
  private readonly port: number;
  private readonly queue: BridgeCommand[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly waiters: Array<(cmd: BridgeCommand | null) => void> = [];
  /**
   * IDs of commands the server has given up on (timed out) but which may still
   * be in flight in Studio. When /result comes back for one, we discard it
   * rather than logging a "no pending entry" miss or letting a stale promise
   * resolution slip through. Bounded FIFO to prevent unbounded growth.
   *
   * Stored as a Set for O(1) membership tests on /result; a parallel array
   * preserves FIFO order so eviction stays cheap and deterministic.
   */
  private readonly cancelled = new Set<string>();
  private readonly cancelledOrder: string[] = [];
  private static readonly CANCELLED_MAX = 1000;
  private lastSeen = 0;
  private _writeEnabled = false;
  private _protocolMismatch: { expected: number; got: number | null } | null = null;
  private httpServer?: Server;

  constructor(port: number) {
    this.port = port;
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

  /** Most recent protocol-mismatch info, or null if the plugin handshake is clean. */
  get protocolMismatch(): { expected: number; got: number | null } | null {
    return this._protocolMismatch;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          if (!res.headersSent) res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        });
      });
      this.httpServer.on("error", reject);
      this.httpServer.listen(this.port, "127.0.0.1", () => resolve());
    });
  }

  /**
   * Queue a command for the Studio plugin and await its result.
   * Rejects fast with a structured BridgeError if the plugin isn't connected.
   */
  send(tool: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (this._protocolMismatch) {
      const { expected, got } = this._protocolMismatch;
      return Promise.reject(
        new BridgeError(
          "plugin_version_mismatch",
          `Studio plugin protocol version ${got ?? "missing"} does not match server protocol ${expected}. Rebuild and reinstall the plugin from roblox/plugin.project.json, then restart Studio.`,
          this._protocolMismatch,
        ),
      );
    }
    if (!this.connected) {
      return Promise.reject(
        new BridgeError(
          "studio_not_connected",
          "The Roblox Studio plugin is not polling. Open Studio with a place loaded, install the Cubes MCP plugin, and make sure its toolbar button is active.",
        ),
      );
    }
    const cmd: BridgeCommand = { id: randomUUID(), tool, args };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmd.id);
        // Drop from queue if Studio never picked it up.
        const qIdx = this.queue.findIndex((c) => c.id === cmd.id);
        if (qIdx >= 0) this.queue.splice(qIdx, 1);
        // Otherwise it's already in flight in Studio: remember the id so a
        // late /result is discarded cleanly rather than dropped silently.
        else this.markCancelled(cmd.id);
        reject(new BridgeError("studio_timeout", `Studio did not respond within ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(cmd.id, { resolve, reject, timer });

      const waiter = this.waiters.shift();
      if (waiter) waiter(cmd);
      else this.queue.push(cmd);
    });
  }

  private markCancelled(id: string): void {
    if (this.cancelled.has(id)) return;
    this.cancelled.add(id);
    this.cancelledOrder.push(id);
    // Bound is on live entries (those still in the Set); stale entries in the
    // FIFO are skipped without counting toward the cap.
    while (this.cancelled.size > StudioBridge.CANCELLED_MAX) {
      const evicted = this.cancelledOrder.shift();
      if (evicted === undefined) break;
      this.cancelled.delete(evicted);
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? "/").split("?")[0];

    if (req.method === "POST" && url === "/poll") {
      // The plugin reports its "Allow writes" toggle state with every poll.
      const body = await readJson(req);
      const got: number | null = typeof body?.protocol === "number" ? body.protocol : null;
      if (got !== PROTOCOL_VERSION) {
        this._protocolMismatch = { expected: PROTOCOL_VERSION, got };
        res.statusCode = 426;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: "protocol_mismatch",
            expected: PROTOCOL_VERSION,
            got,
            message: `Cubes MCP plugin protocol ${got ?? "missing"} ≠ server ${PROTOCOL_VERSION}. Rebuild the plugin from roblox/plugin.project.json and restart Studio.`,
          }),
        );
        return;
      }
      this._protocolMismatch = null;
      if (typeof body?.writeEnabled === "boolean") this._writeEnabled = body.writeEnabled;
      this.lastSeen = Date.now();
      await this.handlePoll(res);
      return;
    }

    if (req.method === "POST" && url === "/result") {
      this.lastSeen = Date.now();
      let body: any;
      try {
        body = await readJson(req);
      } catch (err) {
        // Malformed JSON would otherwise propagate to the outer catch in
        // start() as a 500 and the pending entry would sit until its 30s
        // timer fires as `studio_timeout`. Try to recover the id from URL
        // query or headers so we can reject the matching pending now.
        process.stderr.write(`[cubes-mcp] /result malformed JSON: ${String(err)}\n`);
        const qs = (req.url ?? "").split("?")[1] ?? "";
        const params = new URLSearchParams(qs);
        const headerId = req.headers["x-id"];
        const recoveredId =
          params.get("id") ||
          (typeof headerId === "string" ? headerId : Array.isArray(headerId) ? headerId[0] : "") ||
          "";
        if (recoveredId) {
          this.handleResult({
            id: recoveredId,
            ok: false,
            error: { code: "result_decode_failed", message: String(err) },
          });
        }
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "result_decode_failed", message: String(err) }));
        return;
      }
      this.handleResult(body);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          connected: this.connected,
          queued: this.queue.length,
          protocol: PROTOCOL_VERSION,
          protocolMismatch: this._protocolMismatch,
        }),
      );
      return;
    }

    // Direct command injection — localhost only, for debugging / scripted ops.
    // POST /rpc { tool, args } → runs the command and returns the result.
    //
    // Write-mode gate: write-class tools ("eval", "mutate") honor the user's
    // "Allow writes" toggle in the Studio panel, mirroring the MCP CallTool
    // handler in server.ts. Read-class tools ("read", "diagnostics") are
    // always allowed.
    //
    // Bypass: /rpc exists as a debugging escape hatch for when the MCP tools
    // aren't loaded in the calling session. To keep it useful for scripted
    // ops without weakening the default-safe posture, the env var
    // CUBES_MCP_RPC_TOKEN sets a shared secret: when set, callers that
    // present a matching ?token=<value> query param OR X-Token header skip
    // the write-mode check. When the env var is UNSET (the default), no
    // bypass is available and the write-mode toggle is always enforced.
    if (req.method === "POST" && url === "/rpc") {
      const body = await readJson(req);
      const tool = body?.tool;
      const args = body?.args ?? {};
      if (typeof tool !== "string") {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "missing_tool" }));
        return;
      }
      const isWrite = tool === "eval" || tool === "mutate";
      if (isWrite) {
        const expectedToken = process.env.CUBES_MCP_RPC_TOKEN;
        let bypass = false;
        if (expectedToken) {
          const qs = (req.url ?? "").split("?")[1] ?? "";
          const params = new URLSearchParams(qs);
          const queryToken = params.get("token");
          const headerToken = req.headers["x-token"];
          const presented =
            (typeof queryToken === "string" && queryToken) ||
            (typeof headerToken === "string" && headerToken) ||
            (Array.isArray(headerToken) && headerToken[0]) ||
            "";
          if (presented && presented === expectedToken) bypass = true;
        }
        if (!bypass && !this.writeEnabled) {
          res.statusCode = 403;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: "write_mode_disabled",
              hint: "Open the Cubes MCP panel in Roblox Studio and enable 'Allow writes', then retry.",
            }),
          );
          return;
        }
      }
      try {
        const result = await this.send(tool, args);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result }));
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: false, error: err?.code ?? "error", message: err?.message ?? String(err), detail: err?.detail }));
      }
      return;
    }

    res.statusCode = 404;
    res.end();
  }

  /** Long-poll: hand over a queued command immediately, or hold until one arrives. */
  private handlePoll(res: ServerResponse): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const send = (cmd: BridgeCommand | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (cmd) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(cmd));
        } else {
          res.statusCode = 204;
          res.end();
        }
        resolve();
      };

      const queued = this.queue.shift();
      if (queued) {
        send(queued);
        return;
      }

      this.waiters.push(send);
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(send);
        if (idx >= 0) this.waiters.splice(idx, 1);
        send(null);
      }, POLL_HOLD_MS);
    });
  }

  private handleResult(body: any): void {
    const { id, ok, result, error } = body ?? {};
    if (!id) return;
    // If the server already gave up on this command, drop the late result.
    // This stops a stale promise from being resolved and prevents a buggy or
    // hostile poster from steering state for a command we no longer track.
    if (this.cancelled.has(id)) {
      this.cancelled.delete(id);
      // Lazy cleanup of the FIFO array — leave the slot, it'll be evicted on
      // overflow. Keeps the hot /result path O(1).
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
      // Accept either shape so a useful code/message reaches the caller instead of
      // the generic "Studio operation failed." fallback.
      const errStr = typeof error?.error === "string" ? error.error : undefined;
      const code = error?.code ?? errStr ?? "studio_error";
      const message = error?.message ?? errStr ?? "Studio operation failed.";
      pending.reject(new BridgeError(code, message, error));
    }
  }
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
