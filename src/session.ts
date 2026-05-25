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

export class Session {
  readonly id: string;
  turn = 0;

  /** Tools currently exposed in tools/list. Core tools are always present. */
  readonly active = new Set<string>(CORE_TOOLS);
  /** tool name -> turn it was last used. */
  readonly lastUsed = new Map<string, number>();

  /** Biases search ranking and (later) prefetch. */
  sticky: { recentClasses: string[]; recentIntent: string } = {
    recentClasses: [],
    recentIntent: "",
  };

  /**
   * Cached identity of the place currently open in Studio. Populated lazily on
   * the first resource read or tool call that needs it (profile lookup, etc.).
   * `placeId = 0` is the "unsaved place" sentinel; we still write profiles for
   * it so quick experiments aren't memory-less.
   */
  placeContext: { placeId: number; placeName: string } | null = null;

  constructor(id: string) {
    this.id = id;
  }

  isCore(tool: string): boolean {
    return CORE_SET.has(tool);
  }

  /** Mark a tool as used this turn. */
  touch(tool: string): void {
    this.lastUsed.set(tool, this.turn);
  }

  /** Unlock a specialist tool. Returns true if it wasn't already active. */
  unlock(tool: string): boolean {
    if (this.active.has(tool)) {
      this.touch(tool);
      return false;
    }
    this.active.add(tool);
    this.touch(tool);
    return true;
  }

  noteClass(className: string): void {
    if (!className) return;
    this.sticky.recentClasses = [
      className,
      ...this.sticky.recentClasses.filter((c) => c !== className),
    ].slice(0, 6);
  }

  /**
   * Drop specialist tools that have gone idle or push the active set over its cap.
   * Returns true if anything was evicted (caller should fire tools/list_changed).
   */
  evict(idleTurns = 10, cap = 8): boolean {
    let changed = false;

    for (const tool of [...this.active]) {
      if (this.isCore(tool)) continue;
      const last = this.lastUsed.get(tool) ?? this.turn;
      if (this.turn - last > idleTurns) {
        this.active.delete(tool);
        this.lastUsed.delete(tool);
        changed = true;
      }
    }

    const specialists = [...this.active].filter((t) => !this.isCore(t));
    if (specialists.length > cap) {
      specialists
        .sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0))
        .slice(0, specialists.length - cap)
        .forEach((t) => {
          this.active.delete(t);
          this.lastUsed.delete(t);
          changed = true;
        });
    }

    return changed;
  }
}
