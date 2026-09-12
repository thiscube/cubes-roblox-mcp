import MiniSearch from "minisearch";
import type { Channel, StudioTransport } from "./transport.js";
import {
  EVAL_RESULT,
  MUTATE_RESULT,
  OPAQUE_RESULT,
  type JsonSchema,
} from "./output-schema.js";
import type { SessionMemory } from "./memory.js";

/**
 * The specialist tool registry. Everything except the core tools lives here,
 * hidden until search_tools surfaces it. Keeps the per-turn tool schema cost ~flat
 * no matter how many specialists exist.
 *
 * CAPABILITY IS DERIVED, NOT LABELLED
 * -----------------------------------
 * Whether a tool can modify Studio is a fact about HOW it reaches Studio, not a
 * boolean someone remembers to type. `evalTool` ships generated Luau down the same
 * channel `run_code` uses, so it can do anything `run_code` can — regardless of what
 * its author wrote in the metadata. The old `write: meta.write ?? false` default was
 * wrong on six tools (AUDIT.md #2).
 *
 * So: every constructor stamps a `channel`, and `capabilities()` derives the rest.
 * The default is deny — a tool is write-class unless it explicitly opts out with
 * `readOnly: true`, and that opt-out is only honest for tools whose generated Luau
 * genuinely only reads.
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
  | "viewport"
  | "debug"
  | "docs"
  | "session";

/** Everything a tool handler needs from the server. */
export interface ToolContext {
  /**
   * The Studio transport. Typed as the interface, not the concrete HTTP bridge,
   * so every tool is unit-testable against a fake (ARCHITECTURE-REVIEW.md A3).
   */
  bridge: StudioTransport;
  memory: SessionMemory;
  /**
   * Routes a mutate batch through the same safety pipeline as the core `mutate`
   * tool (destructiveness gate + script source lint). Specialist tools that
   * replay or compose mutate batches (e.g. macro_run) must call this instead of
   * `bridge.send("mutate", ...)` so they don't bypass confirm-before-destructive.
   */
  handleMutate: (args: Record<string, unknown>) => Promise<unknown>;
  /**
   * Returns the current place's identity (PlaceId + Name). Re-resolved when the
   * user opens a different place, so profile writes follow the open place.
   */
  getPlaceContext: () => Promise<{ placeId: number; placeName: string }>;
  /**
   * Ask the human a question mid-call, when the client supports MCP elicitation.
   * Resolves to null when the client can't elicit — callers must handle that and
   * fall back to refusing rather than assuming consent.
   */
  confirmWithUser?: (question: string, detail?: string[]) => Promise<boolean | null>;
}

export interface ToolEntry {
  name: string;
  category: Category;
  subcategories: string[];
  keywords: string[];
  description: string;
  inputSchema: Record<string, unknown>;
  /** How this tool reaches Studio. Set by the constructor, never by hand. */
  channel: Channel;
  /**
   * The plugin command a `dispatch` tool sends. Set by `dispatchTool`.
   *
   * `/rpc` speaks the PLUGIN COMMAND namespace, not the MCP tool namespace, so
   * anything deriving an `/rpc` policy has to read this rather than `name`.
   */
  pluginCommand?: string;
  /**
   * True when the tool writes persistent state under CUBES_MCP_HOME. Only
   * meaningful for `local` tools; a Studio-channel tool is already write-class.
   */
  writesDisk?: true;
  /**
   * Explicit opt-out of write-class. Two honest levels, and no third:
   *
   *   true          the generated Luau provably only reads.
   *   "transient"   it constructs an object that is never parented and destroys
   *                 it again, so it cannot change the place. Read-class for
   *                 every gate, but not a pure read, and the annotations say so.
   *
   * The second level exists because `docs_defaults` has to do
   * `Instance.new(Class)` to read a default value. Under a boolean it came out
   * write-class, which meant a documentation lookup shipped
   * `destructiveHint: true` to the client and vanished from the read-only build
   * — the build whose entire purpose is inspection. The binary was the bug, not
   * the classification.
   *
   * Deny-by-default is unchanged, and it is now enforced rather than implied:
 * `capabilities()` treats ONLY these two values as an opt-out, so an unexpected
 * one (`false`, a typo, null) stays write-class instead of failing open.
   */
  readOnly?: true | "transient";
  /**
   * Declared result shape. Optional here because most tools take the default for
   * their channel; read it through `outputSchemaFor`, never directly, so the
   * default is never accidentally skipped.
   */
  outputSchema?: JsonSchema;
  /**
   * How long this tool may block Studio, in ms, given its arguments. Yielding
   * tools (wait_until, logs_wait_for, step_frames) can legitimately hold the
   * bridge for ~25s against a 30s default, leaving almost no headroom for the
   * round trip (AUDIT.md #22). Declaring the budget lets the caller's timeout
   * scale instead of racing it.
   */
  yieldBudgetMs?: (args: any) => number;
  /** Runs the tool. Returns a JSON-serializable payload; throws on failure. */
  handler: (args: any, ctx: ToolContext) => Promise<unknown>;
}

/** Wall-clock allowance on top of a tool's declared yield budget. */
const TRANSPORT_HEADROOM_MS = 10_000;

/** Effective bridge timeout for a tool call. */
export function timeoutFor(entry: Pick<ToolEntry, "yieldBudgetMs">, args: unknown): number {
  const budget = entry.yieldBudgetMs?.(args ?? {});
  if (typeof budget !== "number" || !Number.isFinite(budget)) return 30_000;
  return Math.min(120_000, Math.max(30_000, Math.ceil(budget) + TRANSPORT_HEADROOM_MS));
}

/** Derived capability for a tool. The single source of truth for every gate. */
export interface Capability {
  /** Gated behind the user's "Allow writes" toggle. */
  write: boolean;
  /** Touches the DataModel at all (false for server-local tools). */
  touchesStudio: boolean;
  /**
   * Writes persistent state under CUBES_MCP_HOME.
   *
   * "Local" was being read as "harmless", and it is not the same thing:
   * `profile_update` is a local tool that writes a file in the user's home, and
   * it survived the read-only build's filter because the filter only asked about
   * Studio. A read-only install should not be writing anything.
   */
  writesDisk: boolean;
  /**
   * Constructs something in Studio but never parents it, so it changes nothing.
   * Read-class, but not a pure read — worth saying separately so annotations can
   * be accurate instead of merely safe.
   */
  transient: boolean;
}

export function capabilities(
  entry: Pick<ToolEntry, "channel" | "readOnly" | "writesDisk">,
): Capability {
  const writesDisk = entry.writesDisk === true;
  const touchesStudio = entry.channel !== "local";
  if (!touchesStudio) return { write: false, touchesStudio: false, transient: false, writesDisk };
  // Deny by default: anything on a Studio channel is write-class unless it has
  // explicitly, and provably, opted out. Both opt-out levels are read-class.
  // Fail closed on anything unexpected. `entry.readOnly === undefined` read
  // nicely but made `readOnly: false` — which means "not read-only" to any human
  // — produce a read-class tool. TypeScript rejects that value, but this
  // function is exported, documented as the single source of truth for every
  // gate, and takes a structural Pick<>. Only the two known opt-outs count.
  const optedOut = entry.readOnly === true || entry.readOnly === "transient";
  return {
    write: !optedOut,
    touchesStudio: true,
    transient: entry.readOnly === "transient",
    writesDisk,
  };
}

/**
 * The result shape a tool declares in `tools/list`.
 *
 * Derived from the channel for the same reason capability is: the channel
 * decides how much of the shape this server actually owns. An `eval` tool's
 * answer is produced inside Studio, so only the `{ result }` wrapper is known
 * here; a `local` tool runs in this process, so its shape is knowable and worth
 * declaring exactly. An explicit `outputSchema` always wins.
 */
export function outputSchemaFor(entry: Pick<ToolEntry, "channel" | "outputSchema">): JsonSchema {
  if (entry.outputSchema) return entry.outputSchema;
  switch (entry.channel) {
    case "eval":
      return EVAL_RESULT;
    case "mutate":
      return MUTATE_RESULT;
    default:
      return OPAQUE_RESULT;
  }
}

/** intent hint -> category clusters it biases toward. */
const INTENT_CATEGORIES: Record<string, Category[]> = {
  building: ["instances", "physics", "terrain", "ui", "docs"],
  debugging: ["scripts", "playtest", "debug", "docs"],
  polishing: ["ui", "lighting", "audio", "animation"],
  reference: ["docs"],
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
  private readonly searchCache = new Map<string, ToolEntry[]>();
  private static readonly SEARCH_CACHE_MAX = 64;

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

  /** Derived capability for a registered tool, or undefined if unknown. */
  capability(name: string): Capability | undefined {
    const entry = this.entries.get(name);
    return entry ? capabilities(entry) : undefined;
  }

  /**
   * Keyword (BM25) search + verbatim category boost + optional intent boost +
   * a recency boost for tools this session has used (`recent`, newest first).
   * Semantic/embedding search is intentionally deferred (see design doc Layer 2).
   */
  search(query: string, intent?: string, limit = 5, recent: readonly string[] = []): ToolEntry[] {
    const cacheKey = `${query}|${intent ?? ""}|${limit ?? 5}|${recent.join(",")}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached !== undefined) {
      this.searchCache.delete(cacheKey);
      this.searchCache.set(cacheKey, cached);
      return cached;
    }

    const lowerQuery = query.toLowerCase();
    const intentCats = intent ? INTENT_CATEGORIES[intent] ?? [] : [];
    const recentSet = new Set(recent);

    const results = this.index.search(query, {
      boostDocument: (id: string) => {
        const entry = this.entries.get(id);
        if (!entry) return 1;
        let boost = 1;
        if (new RegExp(`\\b${entry.category}\\b`, "i").test(lowerQuery)) boost *= 2;
        if (intentCats.includes(entry.category)) boost *= 1.5;
        // What the session just used is a strong hint at what it means now.
        if (recentSet.has(entry.name)) boost *= 1.4;
        return boost;
      },
    });

    const out = results
      .slice(0, Math.max(1, limit))
      .map((r) => this.entries.get(r.id))
      .filter((e): e is ToolEntry => Boolean(e));

    this.searchCache.set(cacheKey, out);
    if (this.searchCache.size > ToolRegistry.SEARCH_CACHE_MAX) {
      const firstKey = this.searchCache.keys().next().value;
      if (firstKey !== undefined) this.searchCache.delete(firstKey);
    }
    return out;
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
  /**
   * Set ONLY when the tool cannot modify the place. `true` for a pure read,
   * `"transient"` when it constructs something it never parents. Everything on a
   * Studio channel is write-class by default — see the capability note at the top.
   */
  readOnly?: true | "transient";
  /** See ToolEntry.yieldBudgetMs. */
  yieldBudgetMs?: (args: any) => number;
  /** Declared result shape. Defaults to the channel's shape when omitted. */
  outputSchema?: JsonSchema;
  /** See ToolEntry.writesDisk. Declare it on any local tool that persists anything. */
  writesDisk?: true;
}

/**
 * A specialist that ships generated Luau to the plugin's eval path.
 *
 * `buildLuau` may be async: `docs_defaults` has to read the API dump before it
 * knows which properties to ask for. It stays an eval tool rather than becoming
 * a local one that calls the bridge, because its effect really is in Studio and
 * the channel is what decides capability.
 */
export function evalTool(
  meta: ToolMeta,
  buildLuau: (args: any) => string | Promise<string>,
): ToolEntry {
  return {
    ...meta,
    channel: "eval",
    handler: async (args, ctx) => {
      const result = await ctx.bridge.send(
        "eval",
        { luau: await buildLuau(args ?? {}) },
        timeoutFor(meta, args),
      );
      return { result };
    },
  };
}

/**
 * A specialist that dispatches directly to a native plugin tool handler.
 * Use when the plugin owns the implementation (e.g. playtest lifecycle methods
 * that need plugin-level security context and would silently no-op via eval).
 */
export function dispatchTool(meta: ToolMeta, pluginTool: string): ToolEntry {
  return {
    ...meta,
    channel: "dispatch",
    pluginCommand: pluginTool,
    handler: async (args, ctx) =>
      ctx.bridge.send(pluginTool, (args ?? {}) as Record<string, unknown>, timeoutFor(meta, args)),
  };
}

/** A specialist that builds a mutate batch and runs it through the plugin's mutate path. */
export function mutateTool(meta: Omit<ToolMeta, "readOnly">, buildOps: (args: any) => unknown[]): ToolEntry {
  return {
    ...meta,
    channel: "mutate",
    // Route through handleMutate so specialist-built batches go through the same
    // destructiveness gate + script-source lint as a direct `mutate` call.
    handler: async (args, ctx) => ctx.handleMutate({ ops: buildOps(args ?? {}) }),
  };
}

/**
 * A specialist whose handler runs server-side but whose EFFECT lands in Studio
 * through `ctx.handleMutate`.
 *
 * This exists because `script_edit` was written as a `localTool` — its
 * find/replace really does happen in TypeScript — and that made it read as
 * non-write-class, so it overwrote script source with the "Allow writes" toggle
 * off. Where the computation happens is an implementation detail; the channel
 * has to describe where the effect lands, or the whole derivation is worthless.
 *
 * `handleMutate` now re-checks the write gate itself, so this is belt and
 * braces. Both are wanted: the gate stops the damage, the channel stops the
 * tool from advertising itself to the model as safe.
 */
export function pipelineTool(
  meta: Omit<ToolMeta, "readOnly">,
  handler: (args: any, ctx: ToolContext) => Promise<unknown>,
): ToolEntry {
  return { ...meta, channel: "mutate", handler };
}

/**
 * A specialist that dispatches a plugin command but needs its own handler around
 * the call — to page a result, to compare two of them, to add server state.
 *
 * `dispatchTool` forwards arguments verbatim and returns the reply verbatim,
 * which is not enough for `snapshot` and `diff`. Writing those as raw object
 * literals meant setting `channel` by hand, which is exactly what
 * `ToolEntry.channel` says never to do — and it is how `pluginCommand` came to
 * be missing from both, which in turn left them out of the `/rpc` policy.
 */
export function commandTool(
  meta: Omit<ToolMeta, "readOnly">,
  pluginCommand: string,
  handler: (args: any, ctx: ToolContext) => Promise<unknown>,
): ToolEntry {
  return { ...meta, channel: "dispatch", pluginCommand, handler };
}

/** `commandTool`, for a command that provably only reads. */
export function readTool(
  meta: Omit<ToolMeta, "readOnly">,
  pluginCommand: string,
  handler: (args: any, ctx: ToolContext) => Promise<unknown>,
): ToolEntry {
  return { ...commandTool(meta, pluginCommand, handler), readOnly: true };
}

/**
 * A specialist implemented entirely server-side (session memory, profile files).
 * Its own effect is local, so the Studio write toggle does not gate it.
 *
 * If the handler reaches Studio at all, this is the wrong constructor: use
 * `pipelineTool` when the effect is a mutate, or `dispatchTool` with
 * `readOnly: true` when it only reads.
 */
export function localTool(
  meta: Omit<ToolMeta, "readOnly">,
  handler: (args: any, ctx: ToolContext) => Promise<unknown>,
): ToolEntry {
  return { ...meta, channel: "local", handler };
}

/**
 * Embed an arbitrary JS value as a Lua string literal the plugin can
 * HttpService:JSONDecode back into a table.
 *
 * Do NOT use JSON.stringify twice for this. JSON escapes control characters as
 * `\uXXXX`, which Luau rejects — it wants `\u{XXXX}` — so a single stray control
 * byte anywhere in a tool argument produced Luau that would not compile, surfacing
 * as an opaque `compile_error` (AUDIT.md #12).
 *
 * Instead we emit a byte-exact Lua literal: printable ASCII verbatim, everything
 * else as a zero-padded `\ddd` decimal escape. Lua strings are byte strings, so
 * UTF-8 survives exactly, and three-digit padding stops the lexer from swallowing
 * a following digit.
 */
export function luaJson(value: unknown): string {
  return luaStringLiteral(JSON.stringify(value ?? null));
}

/** Encode any JS string as a Luau double-quoted literal, byte for byte. */
export function luaStringLiteral(s: string): string {
  const bytes = Buffer.from(s, "utf8");
  let out = '"';
  for (const b of bytes) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5c) out += "\\\\";
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += "\\" + b.toString(10).padStart(3, "0");
  }
  return out + '"';
}
