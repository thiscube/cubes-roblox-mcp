import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";

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
  tool: string; // "eval" | "read" | "mutate"
  args: Record<string, unknown>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** How long we hold a /poll request open before telling the plugin to re-poll. */
const POLL_HOLD_MS = 25_000;
/** Plugin is considered connected if it polled within this window. */
const HEARTBEAT_WINDOW_MS = 15_000;

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
  private lastSeen = 0;
  private _writeEnabled = false;
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
        reject(new BridgeError("studio_timeout", `Studio did not respond within ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(cmd.id, { resolve, reject, timer });

      const waiter = this.waiters.shift();
      if (waiter) waiter(cmd);
      else this.queue.push(cmd);
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? "/").split("?")[0];

    if (req.method === "POST" && url === "/poll") {
      this.lastSeen = Date.now();
      // The plugin reports its "Allow writes" toggle state with every poll.
      const body = await readJson(req);
      if (typeof body?.writeEnabled === "boolean") this._writeEnabled = body.writeEnabled;
      await this.handlePoll(res);
      return;
    }

    if (req.method === "POST" && url === "/result") {
      this.lastSeen = Date.now();
      const body = await readJson(req);
      this.handleResult(body);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, connected: this.connected, queued: this.queue.length }));
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
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (ok) {
      pending.resolve(result);
    } else {
      pending.reject(
        new BridgeError(error?.code ?? "studio_error", error?.message ?? "Studio operation failed.", error),
      );
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
