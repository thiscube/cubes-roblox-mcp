import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

import { StudioBridge, BridgeError } from "./bridge.js";
import { Session, CORE_TOOLS } from "./session.js";
import { ToolRegistry } from "./registry.js";
import { SEED_TOOLS } from "./seed.js";
import { lintLuau } from "./lint.js";
import { SessionMemory } from "./memory.js";
import { assessDestructiveness } from "./safety.js";
import { suggestNext } from "./suggest.js";
import { SourceMap } from "./sourcemap.js";

/**
 * The MCP server. The opening surface is exactly four tools:
 *   search_tools  - discover specialist tools
 *   read          - universal read
 *   mutate        - universal write
 *   run_code      - Luau escape hatch
 * Everything else is hidden in the registry until search_tools surfaces it.
 */

// --------------------------------------------------------------------------
// Core tool schemas (hand-written JSON Schema; always present in tools/list).
// --------------------------------------------------------------------------

const CORE_TOOL_DEFS: Record<string, Tool> = {
  search_tools: {
    name: "search_tools",
    description:
      "Discover specialist Roblox tools by plain-language intent. Matching tools are unlocked into the active tool set (you will receive a tools/list_changed notification). Reach for this before falling back to run_code on a specialized task.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to do, in plain language." },
        intent: {
          type: "string",
          enum: ["building", "debugging", "polishing"],
          description: "Optional bias toward a category cluster.",
        },
        limit: { type: "number", description: "Max tools to unlock (default 5)." },
      },
      required: ["query"],
    },
  },

  read: {
    name: "read",
    description:
      "Universal read. Target by ref, path, or selector query. Returns relevance-ranked items + short ref tokens + a snapshot tag for cheap re-reads via `since`.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "A ref token from a prior read, e.g. 'p3'." },
        path: { type: "string", description: "Dotted path, e.g. 'Workspace.Lobby.SpawnPart'." },
        query: {
          type: "string",
          description:
            "Selector across the tree, e.g. 'Workspace/**[ClassName=Part][Anchored=true]' or 'ServerScriptService/**[ClassName=Script][Source~=DataStore]'. Supports * (children), ** (descendants), and one or more [Key OP Value] filters per segment (AND-ed). Operators: = equals (ClassName also matches via IsA), ~= contains, != not-equals.",
        },
        select: {
          description: "Property names to include, or '*' for a best-effort full dump. Default is a small per-class set.",
          oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }],
        },
        format: {
          type: "string",
          enum: ["names_only", "summary", "full"],
          description: "Response fidelity. Default 'summary'.",
        },
        children: { type: "boolean", description: "List the children of the target instead of the target itself." },
        limit: { type: "number", description: "Max instances returned (default 20)." },
        cursor: { type: "string", description: "Pagination cursor from a prior read." },
        since: {
          type: "string",
          description: "A snapshot tag from a prior read. Returns { unchanged: true } if nothing changed.",
        },
        viewport: {
          type: "boolean",
          description:
            "Ignore the other targeting fields and return a vision-grounded scene instead: the camera state plus the instances currently on screen, each with a projected 2D bounding box [x1,y1,x2,y2] and depth (closest first).",
        },
        prefetch: {
          type: "boolean",
          description:
            "Predictive prefetch (default true). For small focused reads the response bundles likely follow-ups under `prefetched` — a script's source + recent errors, or a child script's source. Set false to skip.",
        },
      },
    },
  },

  mutate: {
    name: "mutate",
    description:
      "Universal write. Atomic batch of create/set/delete ops in one undo waypoint. Use @id to reference prior ops in the same batch. Destructive batches need confirm: true.",
    inputSchema: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          description: "Ordered operations.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Local id; later ops can reference this op's result as @id." },
              op: { type: "string", enum: ["create", "set", "delete"] },
              class: { type: "string", description: "create: the ClassName to instantiate." },
              parent: { type: "string", description: "create: ref / path / @id of the parent (default Workspace)." },
              name: { type: "string", description: "create: name for the new instance." },
              target: { type: "string", description: "set/delete: ref / path / @id of the instance." },
              props: {
                type: "object",
                description:
                  "create/set: property map. Values are coerced to Roblox types from the property's current type (e.g. [255,0,0] -> Color3, 'r, g, b' -> Color3, [4,1,2] -> Vector3, 'Wood' -> EnumItem).",
              },
              attrs: {
                type: "object",
                additionalProperties: true,
                description:
                  "Custom attributes to set (name -> JSON value). Supports primitives and typed envelopes like { __t: 'Vector3', value: [x,y,z] }.",
              },
              tags: {
                type: "array",
                items: { type: "string" },
                description: "CollectionService tags to add.",
              },
              remove_tags: {
                type: "array",
                items: { type: "string" },
                description: "CollectionService tags to remove (set op only).",
              },
              remove_attrs: {
                type: "array",
                items: { type: "string" },
                description: "Attribute names to remove (set op only).",
              },
            },
            required: ["op"],
          },
        },
        confirm: {
          type: "boolean",
          description: "Required for non-soft mutates; set to true to acknowledge destructiveness.",
        },
      },
      required: ["ops"],
    },
  },

  run_code: {
    name: "run_code",
    description:
      "Escape hatch. Run arbitrary Luau inside Studio (plugin context — elevated permissions). A preloaded `__MCP` helper table is in scope: refFor(inst), resolve(refOrPath), query(selector), read(args), mutate(args), decode(json), serialize(value), diagnostics(n), viewport(limit), waypoint(name, fn). Use `return <value>` to get data back as JSON. Requires write mode (the user enables it in the Studio panel).",
    inputSchema: {
      type: "object",
      properties: {
        luau: { type: "string", description: "Luau source. Use 'return <value>' to return data." },
      },
      required: ["luau"],
    },
  },
};

/** Luau for the studio://selection resource. */
const SELECTION_LUAU = `
local sel = game:GetService("Selection"):Get()
local out = {}
for _, inst in ipairs(sel) do
  out[#out + 1] = { ref = __MCP.refFor(inst), path = inst:GetFullName(), class = inst.ClassName }
end
return { selection = out, count = #out }
`;

/**
 * Luau for the studio://overview resource. The "where am I" snapshot — meant to
 * be the first thing a client auto-loads so the agent has a map of the place
 * (PlaceId, service shape, current selection, recent error count) without
 * burning a tools/call to discover it.
 */
const OVERVIEW_LUAU = `
local Selection = game:GetService("Selection")
local function count(svc)
  local ok, s = pcall(function() return game:GetService(svc) end)
  if not ok or not s then return 0 end
  return #s:GetChildren()
end
local sel = {}
for _, inst in ipairs(Selection:Get()) do
  sel[#sel + 1] = { ref = __MCP.refFor(inst), path = inst:GetFullName(), class = inst.ClassName }
end
local diag = __MCP.diagnostics(0)
local recentErrors = 0
if type(diag) == "table" then
  recentErrors = tonumber(diag.totalCaptured) or 0
end
return {
  placeId = game.PlaceId,
  placeName = game.Name,
  services = {
    Workspace = count("Workspace"),
    ServerScriptService = count("ServerScriptService"),
    ServerStorage = count("ServerStorage"),
    ReplicatedStorage = count("ReplicatedStorage"),
    ReplicatedFirst = count("ReplicatedFirst"),
    StarterGui = count("StarterGui"),
    StarterPack = count("StarterPack"),
    StarterPlayer = count("StarterPlayer"),
    Lighting = count("Lighting"),
    SoundService = count("SoundService"),
    Players = count("Players"),
    Teams = count("Teams"),
    TestService = count("TestService"),
  },
  selection = sel,
  selectionCount = #sel,
  recentErrors = recentErrors,
  hint = "Drill in with read({ path = '<ServiceName>', children = true }). Selectors: 'ServerScriptService/**[ClassName=Script]' or '<Service>/**[Tag=X]'.",
}
`;

/** Resources the agent can read directly, without spending a tool call. */
const RESOURCES = [
  {
    uri: "studio://overview",
    name: "Place overview",
    description:
      "PlaceId, place name, top-level service child counts, current selection, recent error count. Read this first to orient yourself — replaces a manual exploration phase.",
    mimeType: "application/json",
  },
  {
    uri: "studio://session/history",
    name: "Tool-call history",
    description: "Log of recent tool calls this session (tool, result summary, timing).",
    mimeType: "application/json",
  },
  {
    uri: "studio://session/macros",
    name: "Saved macros",
    description: "Macros saved this session, replayable with the macro_run tool.",
    mimeType: "application/json",
  },
  {
    uri: "studio://selection",
    name: "Studio selection",
    description: "The instances currently selected in Roblox Studio, as refs.",
    mimeType: "application/json",
  },
  {
    uri: "studio://errors/recent",
    name: "Recent errors",
    description: "Recent error/warning output captured by the Studio plugin.",
    mimeType: "application/json",
  },
];

// --------------------------------------------------------------------------
// Server wiring.
// --------------------------------------------------------------------------

export function createMcpServer(bridge: StudioBridge): Server {
  const session = new Session(randomUUID().slice(0, 8));
  const registry = new ToolRegistry(SEED_TOOLS);
  const memory = new SessionMemory();
  const sourcemap = new SourceMap();
  if (sourcemap.loaded) {
    console.error(`[cubes-mcp] Rojo sourcemap loaded from ${sourcemap.sourcePath}`);
  }

  const server = new Server(
    { name: "cubes-roblox-mcp", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true }, resources: {} } },
  );

  const notifyListChanged = async () => {
    try {
      await server.sendToolListChanged();
    } catch {
      // client may not support listChanged; harmless to skip.
    }
  };

  // ---- tools/list: core tools + currently-active specialists --------------
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = CORE_TOOLS.map((name) => CORE_TOOL_DEFS[name]);
    for (const name of session.active) {
      if (session.isCore(name)) continue;
      const entry = registry.get(name);
      if (entry) {
        tools.push({
          name: entry.name,
          description: `[${entry.category}] ${entry.description}`,
          inputSchema: entry.inputSchema as Tool["inputSchema"],
        });
      }
    }
    return { tools };
  });

  // ---- resources/list + resources/read -----------------------------------
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const json = (data: unknown) => ({
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
    });
    try {
      switch (uri) {
        case "studio://overview":
          return json(await bridge.send("eval", { luau: OVERVIEW_LUAU }));
        case "studio://session/history":
          return json({ turn: session.turn, history: memory.historyView(60) });
        case "studio://session/macros":
          return json({ macros: memory.listMacros() });
        case "studio://selection":
          return json(await bridge.send("eval", { luau: SELECTION_LUAU }));
        case "studio://errors/recent":
          return json(await bridge.send("diagnostics", { n: 25 }));
        default:
          return json({ error: "unknown_resource", uri });
      }
    } catch (err) {
      return json(errorPayload(err));
    }
  });

  // ---- tools/call --------------------------------------------------------
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    session.turn += 1;
    const startedAt = Date.now();

    let payload: unknown;
    try {
      // Read/write split: write tools are gated behind the user's "Allow writes"
      // toggle in the Studio panel. If the plugin isn't connected at all we fall
      // through so the agent gets the more actionable studio_not_connected error.
      if (isWriteTool(name, registry) && bridge.connected && !bridge.writeEnabled) {
        payload = {
          error: "write_mode_disabled",
          tool: name,
          hint: "Writes are off. Open the Cubes MCP panel in Roblox Studio and enable 'Allow writes', then retry.",
        };
      } else {
        switch (name) {
          case "search_tools":
            payload = await handleSearchTools(args);
            break;
          case "read":
            payload = await handleRead(args);
            break;
          case "mutate":
            payload = await handleMutate(args);
            break;
          case "run_code":
            payload = await handleRunCode(args);
            break;
          default: {
            const entry = registry.get(name);
            if (!entry) {
              payload = {
                error: "unknown_tool",
                name,
                hint: "Call search_tools to discover specialist tools, or use run_code.",
              };
              break;
            }
            // Safety net: agent remembered a tool name from earlier — just unlock it.
            if (session.unlock(name)) await notifyListChanged();
            else session.touch(name);
            payload = await entry.handler(args, { bridge, memory, handleMutate });
          }
        }
      }
    } catch (err) {
      payload = errorPayload(err);
    }

    const elapsedMs = Date.now() - startedAt;

    if (payload && typeof payload === "object") {
      const obj = payload as Record<string, unknown>;
      // Suggested next call: non-binding hints toward sensible follow-ups.
      // Skip on no-op replies (unchanged snapshot) and cap to a single suggestion.
      if (obj.unchanged !== true) {
        const next = suggestNext(name, args, payload);
        if (next.length > 0) obj.next_likely = next.slice(0, 1);
      }
      // Cost accounting: only attach when the caller asks for it, or when there's
      // a real signal worth surfacing (snapshot hit, savings, or a slow call).
      const wantsMeta = args.meta === true;
      const meta = buildMeta(name, args, payload, elapsedMs);
      const hasSignal =
        meta.snapshot_hit === true ||
        (typeof meta.tokens_saved === "number" && meta.tokens_saved > 0) ||
        meta.elapsed_ms > 250;
      if (wantsMeta || hasSignal) obj.meta = meta;
    }

    // Record the call in session memory (drives studio://session/history + macros).
    memory.record({
      turn: session.turn,
      tool: name,
      args,
      ok: !(payload && typeof payload === "object" && "error" in payload),
      summary: summarize(name, payload),
      elapsedMs,
      at: new Date().toISOString(),
    });

    // Auto-eviction pass after every call. Only notify when the visible set
    // actually shrank — evict can only remove, so a size delta is sufficient.
    // Avoids firing tools/list_changed (and prompting a tools/list re-fetch)
    // when the change was a no-op against what the client sees.
    const sizeBefore = session.active.size;
    if (session.evict() && session.active.size !== sizeBefore) {
      await notifyListChanged();
    }

    // Multi-block escape hatch: a handler can return `{ __mcpContent: [...] }`
    // to send arbitrary MCP content blocks (image, audio, etc.) instead of the
    // default `[{ type: "text", text: JSON.stringify(payload) }]` wrapper.
    // Used by `screenshot` which needs to ship a PNG inline.
    if (payload && typeof payload === "object" && Array.isArray((payload as any).__mcpContent)) {
      return { content: (payload as any).__mcpContent };
    }

    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  });

  // ---- core tool handlers ------------------------------------------------

  async function handleSearchTools(args: Record<string, unknown>) {
    const query = String(args.query ?? "").trim();
    if (!query) return { error: "bad_args", hint: "search_tools requires a 'query' string." };

    const intent = typeof args.intent === "string" ? args.intent : undefined;
    const limit = typeof args.limit === "number" ? args.limit : 5;
    if (intent) session.sticky.recentIntent = intent;

    const matches = registry.search(query, intent, limit);
    const unlocked: Array<{ name: string; category: string; description: string }> = [];
    let changed = false;
    for (const entry of matches) {
      if (session.unlock(entry.name)) changed = true;
      unlocked.push({ name: entry.name, category: entry.category, description: entry.description });
    }
    if (changed) await notifyListChanged();

    return {
      unlocked,
      message:
        unlocked.length > 0
          ? `Unlocked ${unlocked.length} tool(s): ${unlocked.map((u) => u.name).join(", ")}. They are now in your tool list.`
          : "No specialist tools matched. Use run_code, or try a broader query.",
    };
  }

  async function handleRead(args: Record<string, unknown>) {
    // Pass the sticky context down so the plugin can rank the page by relevance:
    // classes the agent has been working with float toward the top.
    const enriched = { ...args, stickyClasses: session.sticky.recentClasses };
    const result = (await bridge.send("read", enriched)) as Record<string, unknown> | undefined;
    const items =
      (result?.items as Array<{ class?: string; path?: string; source_file?: string }> | undefined) ??
      [];
    for (const it of items) {
      // Light sticky-context update: remember classes the agent just looked at.
      if (it.class) session.noteClass(it.class);
      // Rojo source map: annotate scripts with their on-disk file when available.
      if (sourcemap.loaded && it.path && it.class && /Script$/.test(it.class)) {
        const file = sourcemap.lookup(it.path);
        if (file) it.source_file = file;
      }
    }
    return result;
  }

  async function handleMutate(args: Record<string, unknown>) {
    if (!Array.isArray(args.ops)) {
      return { error: "bad_args", hint: "mutate requires an 'ops' array." };
    }
    // Confirm-before-destructive: hard / nuclear batches need an explicit
    // confirm: true. The structured error hands back the exact retry.
    const assessment = assessDestructiveness(args.ops);
    if ((assessment.level === "hard" || assessment.level === "nuclear") && args.confirm !== true) {
      return {
        error: "needs_confirmation",
        level: assessment.level,
        summary: assessment.summary,
        detail: assessment.detail,
        hint:
          assessment.level === "nuclear"
            ? "This batch deletes a service or top-level node — extremely destructive. Confirm with the user, then retry with confirm: true."
            : "This batch is destructive (deletes instances and/or overwrites script source). Confirm with the user, then retry with confirm: true.",
        retry_with: { ...args, confirm: true },
      };
    }
    const result = (await bridge.send("mutate", args)) as Record<string, unknown>;
    // Plugin-side failures (e.g. mutate_failed + rolled_back, no_undo_available)
    // come back as { error, ... }. Don't dress a rolled-back failure up with
    // lint/appliedLevel — that makes a hard failure look partially applied.
    if (result && typeof result === "object" && "error" in result) {
      return result;
    }
    // Inline lint: any op that writes script source gets selene'd server-side,
    // so the agent can fix issues now instead of discovering them at playtest.
    const lint = await lintScriptOps(args.ops);
    if (lint.length > 0) result.lint = lint;
    result.appliedLevel = assessment.level;
    return result;
  }

  /** Lint the source of every op that writes a script's Source property. */
  async function lintScriptOps(ops: unknown[]) {
    const scriptOps: Array<{ op: any; index: number }> = [];
    ops.forEach((op, index) => {
      if (op && typeof op === "object" && typeof (op as any).props?.Source === "string") {
        scriptOps.push({ op, index });
      }
    });
    // Selene spawns a process per call — cap concurrency so a 50-script macro
    // doesn't fork 50 processes + tmpfiles in parallel.
    const CONCURRENCY = 4;
    const results: Array<{ target: string } & Awaited<ReturnType<typeof lintLuau>>> = new Array(scriptOps.length);
    let cursor = 0;
    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= scriptOps.length) return;
        const { op, index } = scriptOps[i];
        const target =
          (typeof op.id === "string" && op.id) ||
          (typeof op.name === "string" && op.name) ||
          `op#${index}`;
        results[i] = { target, ...(await lintLuau(op.props.Source as string)) };
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, scriptOps.length) }, worker),
    );
    return results;
  }

  async function handleRunCode(args: Record<string, unknown>) {
    const luau = args.luau;
    if (typeof luau !== "string" || luau.trim() === "") {
      return { error: "bad_args", hint: "run_code requires a non-empty 'luau' string." };
    }
    const result = await bridge.send("eval", { luau });
    return { result };
  }

  return server;
}

function errorPayload(err: unknown) {
  if (err instanceof BridgeError) {
    return { error: err.code, message: err.message, detail: err.detail ?? undefined };
  }
  return {
    error: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  };
}

/** Whether a tool can modify the DataModel — gated behind the write-mode toggle. */
function isWriteTool(name: string, registry: ToolRegistry): boolean {
  if (name === "mutate" || name === "run_code") return true;
  if (name === "read" || name === "search_tools") return false;
  return registry.get(name)?.write === true;
}

// --------------------------------------------------------------------------
// Cost accounting + history helpers.
// --------------------------------------------------------------------------

/** Rough token estimate — ~4 chars per token. Good enough to compare shapes. */
function estTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  return Math.ceil(JSON.stringify(value).length / 4);
}

interface CostMeta {
  elapsed_ms: number;
  tokens_in: number;
  tokens_out: number;
  tokens_saved?: number;
  snapshot_hit?: true;
}

function buildMeta(tool: string, args: unknown, payload: unknown, elapsedMs: number): CostMeta {
  const meta: CostMeta = {
    elapsed_ms: elapsedMs,
    tokens_in: estTokens(args),
    tokens_out: estTokens(payload),
  };
  // read-specific savings: pagination (items not returned) and snapshot hits.
  if (tool === "read" && payload && typeof payload === "object") {
    const p = payload as { unchanged?: boolean; total?: number; count?: number };
    if (p.unchanged) {
      meta.snapshot_hit = true;
    } else if (typeof p.total === "number" && typeof p.count === "number" && p.total > p.count) {
      const perItem = meta.tokens_out / Math.max(p.count, 1);
      meta.tokens_saved = Math.round(perItem * (p.total - p.count));
    }
  }
  return meta;
}

/** A short, human-readable result summary for the history log. */
function summarize(tool: string, payload: unknown): string {
  if (!payload || typeof payload !== "object") return "ok";
  const p = payload as Record<string, any>;
  if (p.error) return `error: ${p.error}`;
  switch (tool) {
    case "read":
      return p.unchanged ? "unchanged (snapshot hit)" : `${p.count ?? 0}/${p.total ?? 0} items`;
    case "mutate":
      return p.applied ? `${p.changes?.length ?? 0} change(s)` : "no changes";
    case "search_tools":
      return `unlocked ${p.unlocked?.length ?? 0}`;
    case "run_code":
      return "ran";
    case "macro_save":
      return p.saved ? `saved "${p.saved}" (${p.opCount} ops)` : "ok";
    case "macro_run":
      return p.ran ? `ran "${p.ran}" (${p.opCount} ops)` : "ok";
    default:
      return "ok";
  }
}
