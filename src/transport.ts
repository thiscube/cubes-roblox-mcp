/**
 * The seam between the MCP server and whatever is driving Roblox Studio.
 *
 * Everything above this line (the 58 specialist tools, the core handlers, the
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

export interface StudioTransport {
  /** Queue a command for Studio and await its result. Rejects with BridgeError. */
  send(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** True if something is currently polling us. */
  readonly connected: boolean;
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
