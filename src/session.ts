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

/** How many specialists stay visible at once, on top of the core tools. */
export const SPECIALIST_CAP = 8;
/** Turns of disuse before a specialist is dropped. */
const IDLE_TURNS = 10;

export interface SettleResult {
  /** Specialists visible after unlock + eviction resolved. */
  visible: string[];
  /** Requested unlocks that survived eviction — safe to report to the agent. */
  unlocked: string[];
  /** Requested unlocks that were immediately evicted (should be empty in practice). */
  rejected: string[];
  /** True if the visible set changed and tools/list_changed should fire. */
  changed: boolean;
}

/**
 * Owns the visible tool set.
 *
 * Previously three call sites called `unlock` and a fourth called `evict`, all
 * writing the same Set with nobody arbitrating — which is why `search_tools` could
 * report twelve tools while `tools/list` carried eight, and why the tools it dropped
 * were the highest-ranked ones (AUDIT.md #8, ARCHITECTURE-REVIEW.md A4).
 *
 * Now every mutation goes through here, eviction is resolved BEFORE the caller
 * builds its response, and recency is a strictly increasing sequence number so
 * same-turn unlocks never tie and LRU is exact.
 */
export class ToolSet {
  private readonly active = new Set<string>(CORE_TOOLS);
  /** tool name -> monotonic sequence number of last use. */
  private readonly lastUsed = new Map<string, number>();
  /** tool name -> turn of last use, for idle eviction. */
  private readonly lastTurn = new Map<string, number>();
  private seq = 0;

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

  /** Mark a tool as used now. Core tools are tracked too, harmlessly. */
  touch(tool: string, turn: number): void {
    this.seq += 1;
    this.lastUsed.set(tool, this.seq);
    this.lastTurn.set(tool, turn);
  }

  /**
   * Unlock names, then immediately resolve eviction, and report what actually
   * survived. Callers must report `unlocked` from the result rather than what
   * they asked for.
   */
  unlockAndSettle(names: string[], turn: number): SettleResult {
    const before = new Set(this.active);
    for (const name of names) this.active.add(name);
    // `names` arrives in RANK order, best first. Recency is assigned in reverse
    // so the best match ends up most-recently-used — otherwise strict LRU evicts
    // exactly the top hits, which is the bug this class exists to fix
    // (AUDIT.md #8).
    for (let i = names.length - 1; i >= 0; i -= 1) this.touch(names[i], turn);
    this.evict(turn);

    const visible = this.specialists();
    const survived = new Set(visible);
    const unlocked = names.filter((n) => survived.has(n) && !before.has(n));
    const rejected = names.filter((n) => !survived.has(n));
    const changed =
      before.size !== this.active.size || [...this.active].some((t) => !before.has(t));
    return { visible: this.visible(), unlocked, rejected, changed };
  }

  /** Resolve eviction only (after a tool call that didn't unlock anything). */
  settle(turn: number): boolean {
    const before = this.active.size;
    const beforeSet = new Set(this.active);
    this.evict(turn);
    return before !== this.active.size || [...this.active].some((t) => !beforeSet.has(t));
  }

  /**
   * Drop specialists that have gone idle or push the set over its cap.
   * Eviction is strict LRU on a monotonic sequence, so the tools unlocked most
   * recently are the ones kept.
   */
  private evict(turn: number, idleTurns = IDLE_TURNS, cap = SPECIALIST_CAP): void {
    for (const tool of [...this.active]) {
      if (this.isCore(tool)) continue;
      const last = this.lastTurn.get(tool) ?? turn;
      if (turn - last > idleTurns) this.drop(tool);
    }

    const specialists = this.specialists();
    if (specialists.length > cap) {
      specialists
        .sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0))
        .slice(0, specialists.length - cap)
        .forEach((t) => this.drop(t));
    }
  }

  private drop(tool: string): void {
    this.active.delete(tool);
    this.lastUsed.delete(tool);
    this.lastTurn.delete(tool);
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
