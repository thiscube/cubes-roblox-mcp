/**
 * Session memory — the server's recall.
 *
 * Holds the tool-call history log and saved macros for the life of the process.
 * Surfaced to the agent through studio:// resources and the macro_* tools, so
 * the agent can avoid re-doing work it (or the server) already did.
 */

export interface HistoryEntry {
  turn: number;
  tool: string;
  args: unknown; // kept in full so macros can recover mutate ops
  ok: boolean;
  summary: string;
  elapsedMs: number;
  at: string; // ISO timestamp
}

export interface Macro {
  name: string;
  ops: unknown[];
  opCount: number;
  createdAt: string;
}

/** One captured instance inside a snapshot — see the `snapshot` specialist tool. */
export interface SnapshotInstance {
  path: string;
  className: string;
  /** Projected property map; values are JSON-safe envelopes from the plugin's Serialize. */
  props: Record<string, unknown>;
}

/** A stored capture of a DataModel subtree, keyed by name in SessionMemory. */
export interface Snapshot {
  name: string;
  path: string;
  instances: SnapshotInstance[];
  instanceCount: number;
  truncated: boolean;
  capturedAt: string;
}

const HISTORY_CAP = 200;
const HISTORY_TRIM_BATCH = Math.floor(HISTORY_CAP * 0.25);
const HISTORY_HIGH_WATER = HISTORY_CAP + HISTORY_TRIM_BATCH;

/**
 * Max snapshots kept in memory at once. Each capture can hold up to a couple
 * thousand instance records, so the store is bounded — saving past the cap
 * evicts the oldest, mirroring how the macro store would behave under pressure.
 */
const SNAPSHOT_CAP = 16;

export class SessionMemory {
  private readonly history: HistoryEntry[] = [];
  private readonly macros = new Map<string, Macro>();
  private readonly snapshots = new Map<string, Snapshot>();

  record(entry: HistoryEntry): void {
    this.history.push(entry);
    if (this.history.length > HISTORY_HIGH_WATER) {
      this.history.splice(0, HISTORY_TRIM_BATCH);
    }
  }

  recentHistory(n = 25): HistoryEntry[] {
    return this.history.slice(-Math.max(0, n));
  }

  /** History view for the studio://session/history resource — drops raw args. */
  historyView(n = 50): Array<Omit<HistoryEntry, "args">> {
    return this.recentHistory(n).map(({ args: _args, ...rest }) => rest);
  }

  /** Flatten the mutate ops from the last N history entries (for macro capture). */
  opsFromHistory(n: number): unknown[] {
    const ops: unknown[] = [];
    for (const entry of this.history.slice(-Math.max(0, n))) {
      if (entry.tool !== "mutate") continue;
      const a = entry.args as { ops?: unknown } | null;
      if (a && Array.isArray(a.ops)) ops.push(...a.ops);
    }
    return ops;
  }

  saveMacro(name: string, ops: unknown[]): Macro {
    const macro: Macro = {
      name,
      ops,
      opCount: ops.length,
      createdAt: new Date().toISOString(),
    };
    this.macros.set(name, macro);
    return macro;
  }

  getMacro(name: string): Macro | undefined {
    return this.macros.get(name);
  }

  listMacros(): Array<Omit<Macro, "ops">> {
    return [...this.macros.values()].map(({ name, opCount, createdAt }) => ({
      name,
      opCount,
      createdAt,
    }));
  }

  /**
   * Store a captured subtree under `name`. Bounded: a re-save replaces in place,
   * and overflowing SNAPSHOT_CAP evicts the oldest entry (Map iteration order is
   * insertion order, so the first key is the oldest).
   */
  saveSnapshot(
    name: string,
    capture: { path: string; instances: SnapshotInstance[]; truncated: boolean },
  ): Snapshot {
    const snapshot: Snapshot = {
      name,
      path: capture.path,
      instances: capture.instances,
      instanceCount: capture.instances.length,
      truncated: capture.truncated,
      capturedAt: new Date().toISOString(),
    };
    // Delete first so a re-save moves the key to the most-recent slot — keeps
    // the eviction order honest (a refreshed snapshot is not "old").
    this.snapshots.delete(name);
    this.snapshots.set(name, snapshot);
    while (this.snapshots.size > SNAPSHOT_CAP) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
    return snapshot;
  }

  getSnapshot(name: string): Snapshot | undefined {
    return this.snapshots.get(name);
  }

  /** Snapshot listing without the (potentially large) captured instance arrays. */
  listSnapshots(): Array<Omit<Snapshot, "instances">> {
    return [...this.snapshots.values()].map(({ instances: _instances, ...rest }) => rest);
  }
}
