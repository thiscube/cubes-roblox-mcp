import MiniSearch from "minisearch";
import type { StudioBridge } from "./bridge.js";
import type { SessionMemory } from "./memory.js";

/**
 * The specialist tool registry. Everything except the four core tools lives here,
 * hidden until search_tools surfaces it. Keeps the per-turn tool schema cost ~flat
 * no matter how many specialists exist.
 */

export type Category =
  | "instances"
  | "scripts"
  | "playtest"
  | "terrain"
  | "ui"
  | "animation"
  | "assets"
  | "physics"
  | "lighting"
  | "audio"
  | "camera"
  | "debug"
  | "session";

/** Everything a tool handler needs from the server. */
export interface ToolContext {
  bridge: StudioBridge;
  memory: SessionMemory;
}

export interface ToolEntry {
  name: string;
  category: Category;
  subcategories: string[];
  keywords: string[];
  description: string;
  inputSchema: Record<string, unknown>;
  /** True if the tool can modify the DataModel — gated behind write mode. */
  write?: boolean;
  /** Runs the tool. Returns a JSON-serializable payload; throws on failure. */
  handler: (args: any, ctx: ToolContext) => Promise<unknown>;
}

/** intent hint -> category clusters it biases toward. */
const INTENT_CATEGORIES: Record<string, Category[]> = {
  building: ["instances", "physics", "terrain"],
  debugging: ["scripts", "playtest", "debug"],
  polishing: ["ui", "lighting", "audio"],
};

interface IndexDoc {
  id: string;
  name: string;
  category: string;
  subcategories: string;
  keywords: string;
  description: string;
}

export class ToolRegistry {
  private readonly entries = new Map<string, ToolEntry>();
  private readonly index: MiniSearch<IndexDoc>;

  constructor(entries: ToolEntry[]) {
    for (const entry of entries) {
      if (this.entries.has(entry.name)) {
        throw new Error(`Duplicate tool registered: ${entry.name}`);
      }
      this.entries.set(entry.name, entry);
    }

    this.index = new MiniSearch<IndexDoc>({
      fields: ["name", "category", "subcategories", "keywords", "description"],
      storeFields: ["name"],
      searchOptions: {
        boost: { name: 3, keywords: 2, subcategories: 1.5 },
        fuzzy: 0.2,
        prefix: true,
        combineWith: "OR",
      },
    });

    this.index.addAll(
      entries.map((e) => ({
        id: e.name,
        name: e.name,
        category: e.category,
        subcategories: e.subcategories.join(" "),
        keywords: e.keywords.join(" "),
        description: e.description,
      })),
    );
  }

  get(name: string): ToolEntry | undefined {
    return this.entries.get(name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  all(): ToolEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Keyword (BM25) search + verbatim category boost + optional intent boost.
   * Semantic/embedding search is intentionally deferred (see design doc Layer 2).
   */
  search(query: string, intent?: string, limit = 5): ToolEntry[] {
    const lowerQuery = query.toLowerCase();
    const intentCats = intent ? INTENT_CATEGORIES[intent] ?? [] : [];

    const results = this.index.search(query, {
      boostDocument: (id: string) => {
        const entry = this.entries.get(id);
        if (!entry) return 1;
        let boost = 1;
        if (lowerQuery.includes(entry.category)) boost *= 2;
        if (intentCats.includes(entry.category)) boost *= 1.5;
        return boost;
      },
    });

    return results
      .slice(0, Math.max(1, limit))
      .map((r) => this.entries.get(r.id))
      .filter((e): e is ToolEntry => Boolean(e));
  }
}

// --------------------------------------------------------------------------
// Helpers for declaring specialist tools concisely.
// --------------------------------------------------------------------------

interface ToolMeta {
  name: string;
  category: Category;
  subcategories: string[];
  keywords: string[];
  description: string;
  inputSchema: Record<string, unknown>;
  /** True if the tool can modify the DataModel. evalTool defaults to false. */
  write?: boolean;
}

/** A specialist that ships generated Luau to the plugin's eval path. */
export function evalTool(meta: ToolMeta, buildLuau: (args: any) => string): ToolEntry {
  return {
    ...meta,
    write: meta.write ?? false,
    handler: async (args, ctx) => {
      const result = await ctx.bridge.send("eval", { luau: buildLuau(args ?? {}) });
      return { result };
    },
  };
}

/** A specialist that builds a mutate batch and runs it through the plugin's mutate path. */
export function mutateTool(meta: ToolMeta, buildOps: (args: any) => unknown[]): ToolEntry {
  return {
    ...meta,
    write: true, // every mutateTool modifies the DataModel
    handler: async (args, ctx) => ctx.bridge.send("mutate", { ops: buildOps(args ?? {}) }),
  };
}

/**
 * Embed an arbitrary JS value as a Lua string literal that the plugin can
 * HttpService:JSONDecode back into a table. Used by evalTool builders that need
 * structured args inside generated Luau.
 */
export function luaJson(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  return "'" + json.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}
