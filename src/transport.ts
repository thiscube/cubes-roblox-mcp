/**
 * The seam between the MCP server and whatever is driving Roblox Studio.
 *
 * Everything above this line (the specialist tools, the core handlers, the
 * resource handlers) depends only on this interface. `StudioBridge` is one
 * implementation — an HTTP long-poll bridge to the Studio plugin — and
 * `FakeTransport` in the tests is another.
 *
 * Keeping tools typed against the interface rather than the concrete bridge is
 * what makes them unit-testable without binding a port, and what leaves room
 * for a second transport (Open Cloud) without touching a single tool handler.
 */

/** Which bridge channel a command travels down. Capability is derived from this. */
export type Channel = "eval" | "mutate" | "dispatch" | "local";

/**
 * One connected Studio window (PLAN.md #11).
 *
 * Declared on the seam rather than in `bridge.ts` so a tool can read it without
 * depending on the concrete HTTP bridge — the same reason everything else above
 * this line depends on the interface.
 */
export interface StudioInstance {
  /** Plugin-supplied, stable for the life of that Studio window. */
  id: string;
  placeId?: number;
  placeName?: string;
  /** What the plugin calls itself: "edit", "server", "client-1", ... */
  role?: string;
  transport: "websocket" | "long-poll";
  writeEnabled: boolean;
  lastSeen: number;
  protocol: number | null;
}

export interface StudioTransport {
  /** Queue a command for Studio and await its result. Rejects with BridgeError. */
  /**
   * `target` names one Studio window (see `listInstances`). The bridge honours
   * it; nothing above this line passes it yet, so with several windows open a
   * command still goes to whichever answers first. The gap is real and is
   * recorded in PLAN.md item 11 rather than papered over here.
   */
  send(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
    target?: string,
  ): Promise<unknown>;
  /** True if something is currently polling us. */
  readonly connected: boolean;
  /**
   * Connected Studio windows, when the transport tracks them.
   *
   * Optional because a fake in a test does not have to, and because a second
   * transport (Open Cloud) has no notion of a window at all.
   */
  listInstances?(): StudioInstance[];
  /** True only if connected AND the user has opted into writes. */
  readonly writeEnabled: boolean;
}

/**
 * Structured failure from the Studio side of the bridge. Carries a stable
 * `code` so callers can branch without string-matching the message.
 */
export class BridgeError extends Error {
  code: string;
  detail: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.detail = detail;
  }
}
