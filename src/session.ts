/**
 * Per-process session state. The server has memory so the agent doesn't have to.
 *
 * Note: reference tokens (p3, f12, ...) live on the *plugin* side — they map to live
 * Luau Instance pointers, so they survive renames/reparents. This object only tracks
 * what's needed Node-side: which specialist tools are unlocked, recency, and a little
 * sticky context to bias search.
 */

export const CORE_TOOLS = ["search_tools", "read", "screenshot", "mutate", "run_code"] as const;
const CORE_SET: ReadonlySet<string> = new Set(CORE_TOOLS);

export interface UnlockResult {
  /** Everything in tools/list after the unlock, core first. */
  visible: string[];
  /** Names that were not already visible and have now been added. */
  unlocked: string[];
  /** True if the visible set grew and tools/list_changed should fire. */
  changed: boolean;
}

/**
 * Owns the visible tool set. Grow-only: a tool that has been surfaced never
 * leaves.
 *
 * It used to evict — idle tools aged out after 10 turns and the set was capped
 * at 8 specialists. That was wrong for two separate reasons.
 *
 * The first is correctness. Three call sites mutated the same Set with nobody
 * arbitrating, so `search_tools` could report twelve tools while `tools/list`
 * carried eight, and the tools it dropped were the highest-ranked ones
 * (AUDIT.md #8, ARCHITECTURE-REVIEW.md A4).
 *
 * The second is cost, and it is the reason eviction is gone rather than fixed.
 * `tools` renders first in the prompt-cache prefix, so any change to the tool
 * list invalidates the cache for that turn. Eviction guarantees the list keeps
 * changing: measured over a 60-turn session (`test/bench/tool-churn.mjs`), 33%
 * of turns changed the list and it stayed at 33% in the second half, because
 * churn is the steady state. Grow-only lands at 17% overall and 10% late, since
 * once a tool has been seen it never leaves and the list converges.
 *
 * Anthropic's own fix is `defer_loading` plus `tool_addition`/`tool_removal`,
 * which keep the list literally constant. Those are Messages API parameters and
 * the MCP client builds that request, not this server — they do not exist in
 * `@modelcontextprotocol/sdk`. Grow-only is the closest reachable approximation.
 *
 * Worst case the list ends at every tool in the registry, which is what other
 * Roblox MCP servers ship on turn one anyway.
 */
export class ToolSet {
  private readonly active = new Set<string>(CORE_TOOLS);
  /** tool name -> turn of last use. Kept for ranking and diagnostics only. */
  private readonly lastTurn = new Map<string, number>();

  isCore(tool: string): boolean {
    return CORE_SET.has(tool);
  }

  has(tool: string): boolean {
    return this.active.has(tool);
  }

  /** Everything currently in tools/list, core first. */
  visible(): string[] {
    return [...CORE_TOOLS, ...this.specialists()];
  }

  specialists(): string[] {
    return [...this.active].filter((t) => !this.isCore(t));
  }

  /** Turn a tool was last used, or 0. */
  lastUsedTurn(tool: string): number {
    return this.lastTurn.get(tool) ?? 0;
  }

  /** Mark a tool as used now. Core tools are tracked too, harmlessly. */
  touch(tool: string, turn: number): void {
    this.lastTurn.set(tool, turn);
  }

  /**
   * Make `names` visible. Nothing is ever dropped, so everything asked for is
   * unlocked and callers can report the result verbatim.
   */
  unlock(names: string[], turn: number): UnlockResult {
    const unlocked: string[] = [];
    for (const name of names) {
      if (!this.active.has(name)) {
        this.active.add(name);
        unlocked.push(name);
      }
      this.touch(name, turn);
    }
    return { visible: this.visible(), unlocked, changed: unlocked.length > 0 };
  }
}


/**
 * Identity of the place currently open in Studio.
 *
 * This used to be cached on first use and never refreshed, so opening a different
 * place without restarting the server sent every profile write to the old PlaceId
 * for the rest of the session (ARCHITECTURE-REVIEW.md A4). It now expires, and the
 * server invalidates it whenever the plugin reconnects.
 */
export class PlaceContextCache {
  private value: { placeId: number; placeName: string } | null = null;
  private fetchedAt = 0;
  private inFlight: Promise<{ placeId: number; placeName: string }> | null = null;

  constructor(private readonly ttlMs = 15_000) {}

  peek(): { placeId: number; placeName: string } | null {
    if (!this.value) return null;
    if (Date.now() - this.fetchedAt > this.ttlMs) return null;
    return this.value;
  }

  invalidate(): void {
    this.value = null;
    this.fetchedAt = 0;
  }

  /** Resolve through `load`, de-duplicating concurrent callers. */
  async resolve(
    load: () => Promise<{ placeId: number; placeName: string }>,
  ): Promise<{ placeId: number; placeName: string }> {
    const fresh = this.peek();
    if (fresh) return fresh;
    if (this.inFlight) return this.inFlight;
    this.inFlight = load()
      .then((v) => {
        this.value = v;
        this.fetchedAt = Date.now();
        return v;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

export class Session {
  readonly id: string;
  turn = 0;

  readonly tools = new ToolSet();
  readonly place = new PlaceContextCache();

  /** Biases search ranking and (later) prefetch. */
  sticky: { recentClasses: string[]; recentIntent: string } = {
    recentClasses: [],
    recentIntent: "",
  };

  constructor(id: string) {
    this.id = id;
  }

  isCore(tool: string): boolean {
    return this.tools.isCore(tool);
  }

  noteClass(className: string): void {
    if (!className) return;
    this.sticky.recentClasses = [
      className,
      ...this.sticky.recentClasses.filter((c) => c !== className),
    ].slice(0, 6);
  }
}
