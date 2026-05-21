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

const HISTORY_CAP = 200;
const HISTORY_TRIM_BATCH = Math.floor(HISTORY_CAP * 0.25);
const HISTORY_HIGH_WATER = HISTORY_CAP + HISTORY_TRIM_BATCH;

export class SessionMemory {
  private readonly history: HistoryEntry[] = [];
  private readonly macros = new Map<string, Macro>();

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
}
