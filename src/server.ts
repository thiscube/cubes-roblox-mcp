import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

import { BridgeError, type StudioTransport } from "./transport.js";
import { Session, CORE_TOOLS } from "./session.js";
import { ToolRegistry, capabilities, outputSchemaFor, type ToolEntry } from "./registry.js";
import { CORE_OUTPUT_SCHEMAS, RESULT_ENVELOPE } from "./core-output.js";
import { ALL_TOOLS } from "./tools/index.js";
import { lintLuau } from "./lint.js";
import { SessionMemory } from "./memory.js";
import { assessDestructiveness } from "./safety.js";
import { suggestNext } from "./suggest.js";
import { SourceMap } from "./sourcemap.js";
import { screenshotTool } from "./vision.js";
import { loadProfile } from "./profile.js";
import { validateArgs, invalidArgsPayload } from "./validate.js";

/**
 * The MCP server. The opening surface is exactly five tools:
 *   search_tools  - discover specialist tools
 *   read          - universal read
 *   screenshot    - see the screen
 *   mutate        - universal write
 *   run_code      - Luau escape hatch
 * Everything else is hidden in the registry until search_tools surfaces it.
 *
 * The list lives in CORE_TOOLS (session.ts) — keep this comment in step with it.
 */

// --------------------------------------------------------------------------
// Core tool schemas (hand-written JSON Schema; always present in tools/list).
// --------------------------------------------------------------------------

/**
 * Most matches one `search_tools` call will surface at once. Not a cap on how
 * many tools can be visible — nothing is evicted any more — just a guard so one
 * broad query doesn't pull the whole registry into the tool list in a single turn.
 */
const MAX_SEARCH_RESULTS = 12;

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
      "Escape hatch + code-mode workflow runner. Run arbitrary Luau inside Studio (plugin context, elevated permissions). PREFER this over many `mutate` calls when you need 3+ ops in a row — one round-trip beats N, and intermediate results stay in the Studio sandbox instead of round-tripping through the LLM context window. A preloaded `__MCP` helper table is in scope: refFor(inst), resolve(refOrPath), query(selector), read(args), mutate(args), decode(json), serialize(value), diagnostics(n), viewport(limit), waypoint(name, fn). Wrap multi-step work in `__MCP.waypoint('your-label', function() ... end)` for one atomic undo step. Use `return <value>` to get JSON back. Example multi-step build: `return __MCP.waypoint('build cat', function() local m = Instance.new('Model'); m.Parent = workspace; for i=1,5 do local p = Instance.new('Part'); p.Parent = m end; return { ref = __MCP.refFor(m), count = #m:GetChildren() } end)`.",
    inputSchema: {
      type: "object",
      properties: {
        luau: { type: "string", description: "Luau source. Use 'return <value>' to return data." },
      },
      required: ["luau"],
    },
  },

  // Screenshot is core because vision is fundamental — having to search_tools
  // for "see the screen" every session adds friction and the agent often
  // forgets it exists. Lives next to `read` in the conceptual model: same
  // observation role, just visual instead of structured.
  screenshot: {
    name: "screenshot",
    description: screenshotTool.description,
    inputSchema: screenshotTool.inputSchema as Tool["inputSchema"],
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
    uri: "studio://tools/catalog",
    name: "Tool catalog",
    description:
      "The full specialist tool index, grouped by category. Each entry: name, description, write-flag, keywords. Read once at session start so you know everything that exists — eliminates blind search_tools queries.",
    mimeType: "application/json",
  },
  {
    uri: "studio://project/profile",
    name: "Project profile",
    description:
      "Per-place persistent memory: detected genre, style decisions, naming conventions, decisions log, known issues, prior-session summaries. Loaded from ~/.cubesmcp/profiles/{placeId}.json. Update via the `profile_update` specialist tool.",
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
    uri: "studio://session/snapshots",
    name: "Saved snapshots",
    description:
      "DataModel subtree snapshots captured this session (name, path, instance count, timestamp). Compare them with the diff tool.",
    mimeType: "application/json",
  },
  {
    uri: "cubes://schema/result",
    name: "Result envelope",
    description:
      "Fields the server can add to ANY tool result: error, hint, message, next_likely, auto_unlocked, unchanged. Declared once here instead of being repeated into all 63 per-tool outputSchemas.",
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

export function createMcpServer(bridge: StudioTransport): Server {
  const session = new Session(randomUUID().slice(0, 8));
  const registry = new ToolRegistry(ALL_TOOLS);
  const memory = new SessionMemory();
  const sourcemap = new SourceMap();
  if (sourcemap.loaded) {
    console.error(`[cubes-mcp] Rojo sourcemap loaded from ${sourcemap.sourcePath}`);
  }

  const server = new Server(
    { name: "cubes-roblox-mcp", version: "0.2.0" },
    {
      capabilities: {
        tools: { listChanged: true },
        // subscribe lets a client watch studio://errors/recent instead of polling
        // logs_tail; logging carries pushed diagnostics.
        resources: { subscribe: false, listChanged: false },
        logging: {},
      },
    },
  );

  /**
   * Ask the human a yes/no question mid-tool-call, when the client supports
   * elicitation. Returns null when it doesn't, so callers can tell "declined"
   * apart from "couldn't ask" — an LLM relaying its own confirmation prompt is
   * not a safety gate.
   */
  async function confirmWithUser(question: string, detail: string[] = []): Promise<boolean | null> {
    const caps = server.getClientCapabilities();
    if (!caps?.elicitation) return null;
    try {
      const res: any = await server.elicitInput({
        message: detail.length ? `${question}\n\n${detail.join("\n")}` : question,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: {
              type: "boolean",
              description: "Yes, go ahead with this destructive change.",
            },
          },
          required: ["confirm"],
        },
      });
      if (res?.action !== "accept") return false;
      return res?.content?.confirm === true;
    } catch {
      return null;
    }
  }

  const notifyListChanged = async () => {
    try {
      await server.sendToolListChanged();
    } catch {
      // client may not support listChanged; harmless to skip.
    }
  };

  const getPlaceContext = () => ensurePlaceContext(bridge, session);

  /**
   * MCP tool annotations, derived from the same capability the gate uses.
   * The client surfaces these to the user before they approve a call, so the
   * hint and the enforcement can never drift apart (ARCHITECTURE-REVIEW.md A2).
   */
  function annotationsFor(entry: Pick<ToolEntry, "channel" | "readOnly">): Tool["annotations"] {
    const cap = capabilities(entry);
    return {
      readOnlyHint: !cap.write,
      destructiveHint: cap.write,
      idempotentHint: false,
      openWorldHint: cap.touchesStudio,
    };
  }

  const CORE_ANNOTATIONS: Record<string, Tool["annotations"]> = {
    search_tools: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    read: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    screenshot: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    mutate: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    run_code: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  };

  // ---- tools/list: core tools + currently-active specialists --------------
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = CORE_TOOLS.map((name) => ({
      ...CORE_TOOL_DEFS[name],
      annotations: CORE_ANNOTATIONS[name],
      outputSchema: CORE_OUTPUT_SCHEMAS[name] as Tool["outputSchema"],
    }));
    for (const name of session.tools.specialists()) {
      const entry = registry.get(name);
      if (entry) {
        tools.push({
          name: entry.name,
          description: `[${entry.category}] ${entry.description}`,
          inputSchema: entry.inputSchema as Tool["inputSchema"],
          annotations: annotationsFor(entry),
          outputSchema: outputSchemaFor(entry) as Tool["outputSchema"],
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
    /**
     * Resources reach Studio through the same `eval` channel the write gate
     * covers, and used to skip it entirely (AUDIT.md #10). These payloads are
     * fixed server-authored constants that only read, so they are allowed while
     * writes are off — but they go through one audited helper rather than each
     * call site reaching for the bridge directly.
     */
    const readOnlyEval = (luau: string) => bridge.send("eval", { luau });

    try {
      switch (uri) {
        case "studio://overview":
          return json(await readOnlyEval(OVERVIEW_LUAU));
        case "studio://tools/catalog":
          return json(buildToolCatalog(registry));
        case "studio://project/profile": {
          const ctx = await ensurePlaceContext(bridge, session);
          const profile = await loadProfile(ctx.placeId, ctx.placeName);
          return json(profile);
        }
        case "studio://session/history":
          return json({ turn: session.turn, history: memory.historyView(60) });
        case "studio://session/macros":
          return json({ macros: memory.listMacros() });
        case "studio://session/snapshots":
          return json({ snapshots: memory.listSnapshots() });
        case "cubes://schema/result":
          return json({
            envelope: RESULT_ENVELOPE,
            note:
              "Every tool's declared outputSchema covers only the fields specific to that tool. " +
              "These envelope fields can appear on top of any of them, which is why no per-tool " +
              "schema marks a field required: a handler may return the error envelope instead of " +
              "its success shape.",
          });
        case "studio://selection":
          return json(await readOnlyEval(SELECTION_LUAU));
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

    const toolCtx = { bridge, memory, handleMutate, getPlaceContext, confirmWithUser };

    let payload: unknown;
    try {
      // Safety net: the agent called a specialist by name that it remembered from
      // earlier. Unlock it BEFORE validating, so that if the call is rejected for
      // bad arguments or because writes are off, the schema it needs is already in
      // tools/list and the retry is informed. Only registry-known names unlock, so
      // a hallucinated name still comes back as unknown_tool.
      if (!session.isCore(name) && registry.has(name)) {
        if (session.tools.unlock([name], session.turn).changed) await notifyListChanged();
      }

      // Arguments are validated against the tool's own inputSchema before any
      // handler sees them. The MCP SDK does not do this, and every handler used
      // to cast blindly (AUDIT.md #3, #14).
      const schema = schemaFor(name, registry);
      const problems = schema ? validateArgs(args, schema) : [];
      if (problems.length > 0) {
        payload = invalidArgsPayload(name, problems);
      } else if (isWriteTool(name, registry) && bridge.connected && !bridge.writeEnabled) {
        // Read/write split: write tools are gated behind the user's "Allow writes"
        // toggle in the Studio panel. If the plugin isn't connected at all we fall
        // through so the agent gets the more actionable studio_not_connected error.
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
          case "screenshot":
            payload = await screenshotTool.handler(args, toolCtx);
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
            payload = await entry.handler(args, toolCtx);
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
      // Skip on no-op replies (unchanged snapshot). Cap at 3 so the agent gets
      // a meaningful menu (e.g. "verify the write, screenshot it, snapshot for
      // rollback") without the response bloating into a planning document.
      if (obj.unchanged !== true) {
        const next = suggestNext(name, args, payload);
        if (next.length > 0) obj.next_likely = next.slice(0, 3);
      }
      // Cost accounting: only attach when the caller asks for it, or when there's
      // a real signal worth surfacing (snapshot hit, savings, or a slow call).
      // The payload is serialized here and the length reused, rather than
      // stringified again inside estTokens (AUDIT.md #25).
      const wantsMeta = args.meta === true;
      let payloadChars = 0;
      try {
        payloadChars = (JSON.stringify(payload) ?? "").length;
      } catch {
        payloadChars = 0;
      }
      const meta = buildMeta(name, args, payload, elapsedMs, payloadChars);
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

    // Context-aware auto-unlock: surface specialists the agent obviously needs
    // next without forcing a search_tools round-trip. Rules are intentionally
    // narrow (only fire on strong context signals) so the active set doesn't
    // bloat. Newly-unlocked tools are reported back via `auto_unlocked` so the
    // agent knows what just appeared without re-reading tools/list.
    const autoUnlocked = applyAutoUnlock(name, args, payload, session, registry);
    if (autoUnlocked.length > 0) {
      if (payload && typeof payload === "object" && !("error" in payload)) {
        (payload as Record<string, unknown>).auto_unlocked = autoUnlocked;
      }
      await notifyListChanged();
    }

    const failed = payload !== null && typeof payload === "object" && "error" in (payload as object);

    // Multi-block escape hatch: a handler can return `{ __mcpContent: [...] }`
    // to send arbitrary MCP content blocks (image, audio, etc.) instead of the
    // default text wrapper. Used by `screenshot` which ships a PNG inline. It may
    // also set `__structured` so the call still satisfies its declared
    // outputSchema — an image result is not an excuse to skip the contract.
    if (payload && typeof payload === "object" && Array.isArray((payload as any).__mcpContent)) {
      const structured = (payload as any).__structured;
      return {
        content: (payload as any).__mcpContent,
        ...(structured && typeof structured === "object" ? { structuredContent: structured } : {}),
      };
    }

    // Serialize exactly once — buildMeta above reuses this string rather than
    // stringifying the payload a second time (AUDIT.md #25). A payload that
    // cannot be serialized becomes a structured error instead of throwing out
    // of the request handler.
    let text: string;
    try {
      text = JSON.stringify(payload) ?? "null";
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "unserializable_result",
              tool: name,
              message: err instanceof Error ? err.message : String(err),
            }),
          },
        ],
        isError: true,
      };
    }

    // Every tool declares an outputSchema, so every result carries
    // structuredContent (PLAN.md #5). The text block stays alongside it: MCP
    // wants both, and clients that predate structured output still work.
    // Only an object can be structuredContent — a handler returning a scalar or
    // an array ships as text alone rather than as an invalid structured result.
    const structured =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : undefined;

    // MCP signals tool failure with isError. Without it every failure — bad args,
    // unknown tool, Studio not connected — reads as a clean success to the
    // client (AUDIT.md #9).
    return {
      content: [{ type: "text", text }],
      ...(structured ? { structuredContent: structured } : {}),
      ...(failed ? { isError: true } : {}),
    };
  });

  // ---- core tool handlers ------------------------------------------------

  async function handleSearchTools(args: Record<string, unknown>) {
    const query = String(args.query ?? "").trim();
    if (!query) return { error: "bad_args", hint: "search_tools requires a 'query' string." };

    const intent = typeof args.intent === "string" ? args.intent : undefined;
    // A results cap, not a visibility cap. Nothing is evicted any more, so every
    // match survives; this only stops one broad query dumping the whole registry
    // into the tool list at once.
    const requested = typeof args.limit === "number" ? args.limit : 5;
    const limit = Math.min(Math.max(1, Math.trunc(requested)), MAX_SEARCH_RESULTS);
    if (intent) session.sticky.recentIntent = intent;

    const matches = registry.search(query, intent, limit, session.tools.recentlyUsed());
    // Every match survives, so the response can never disagree with tools/list.
    const settled = session.tools.unlock(
      matches.map((m) => m.name),
      session.turn,
    );
    if (settled.changed) await notifyListChanged();

    const unlocked = matches.map((m) => ({
      name: m.name,
      category: m.category,
      description: m.description,
    }));

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
    // The write gate lives HERE, at the entrance to the pipeline, not only on
    // the `mutate` tool name. `script_edit` reached this function from a tool
    // the name-based check had already waved through, and overwrote script
    // source with the toggle off. Any future caller is covered now, whatever
    // channel it claims.
    if (bridge.connected && !bridge.writeEnabled) {
      return {
        error: "write_mode_disabled",
        tool: "mutate",
        hint: "Writes are off. Open the Cubes MCP panel in Roblox Studio and enable 'Allow writes', then retry.",
      };
    }
    // Confirm-before-destructive: hard / nuclear batches need an explicit
    // confirm: true. The structured error hands back the exact retry.
    const assessment = assessDestructiveness(args.ops);
    if ((assessment.level === "hard" || assessment.level === "nuclear") && args.confirm !== true) {
      // Prefer asking the human directly. Returning `needs_confirmation` and
      // hoping the model relays it is a suggestion to an LLM, not a gate — and a
      // model that wants to finish the task is the worst possible arbiter of
      // whether it should. Falls back to the structured refusal when the client
      // cannot elicit.
      const approved = await confirmWithUser(
        assessment.level === "nuclear"
          ? `This batch deletes a service or top-level node. Continue? (${assessment.summary})`
          : `This batch is destructive. Continue? (${assessment.summary})`,
        assessment.detail,
      );
      if (approved === true) {
        args = { ...args, confirm: true };
      } else if (approved === false) {
        return {
          error: "declined_by_user",
          level: assessment.level,
          summary: assessment.summary,
          hint: "The user declined this destructive batch. Do not retry it without new instructions.",
        };
      } else {
        return {
          error: "needs_confirmation",
          level: assessment.level,
          summary: assessment.summary,
          detail: assessment.detail,
          uncertain: assessment.uncertain,
          hint:
            assessment.level === "nuclear"
              ? "This batch deletes a service or top-level node — extremely destructive. Confirm with the user, then retry with confirm: true."
              : "This batch is destructive (deletes instances and/or overwrites script source). Confirm with the user, then retry with confirm: true.",
          retry_with: { ...args, confirm: true },
        };
      }
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
    const lint = await lintScriptOps(Array.isArray(args.ops) ? args.ops : []);
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

/**
 * Context-aware tool auto-unlock. Inspects the tool name + payload shape and
 * unlocks specialists that are obviously the next step. Rules are kept narrow
 * (high precision, low recall) so the active tool set stays focused — the
 * agent should still use `search_tools` for broader discovery.
 *
 * Returns the list of newly-unlocked specialist names so the server can both
 * fire tools/list_changed AND echo the names in the tool response (so the
 * agent doesn't have to re-fetch tools/list to find out what's new).
 */
function applyAutoUnlock(
  toolName: string,
  _args: unknown,
  payload: unknown,
  session: Session,
  registry: ToolRegistry,
): string[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as Record<string, any>;
  if (p.error) return [];

  const candidates = new Set<string>();

  // Read → viewport / debug helpers. If the response includes camera + 2D
  // bboxes, the agent has just done vision-grounding; the natural follow-ups
  // are `debug_highlight` (to draw on what they care about) and a `screenshot`
  // (but screenshot is already core).
  if (toolName === "read" && p.camera && Array.isArray(p.instances)) {
    candidates.add("debug_highlight");
  }

  // Mutate creating BaseParts → duplication / array helpers. Most "build many"
  // workflows start with one part and benefit from `instance_duplicate` or
  // `parts_grid` next.
  if (toolName === "mutate") {
    const changes: Array<{ op?: string; class?: string }> = Array.isArray(p.changes)
      ? p.changes
      : [];
    const createdBasePart = changes.some(
      (c) => c.op === "create" && c.class && /Part$/.test(c.class),
    );
    if (createdBasePart) {
      candidates.add("instance_duplicate");
      candidates.add("parts_grid");
    }
  }

  // run_code returned a ref/path → likely created/touched a visual instance.
  // Make `debug_highlight` available so a follow-up can spotlight it.
  if (toolName === "run_code") {
    const r = p.result;
    if (r && typeof r === "object" && (r.ref || r.path)) {
      candidates.add("debug_highlight");
    }
  }

  // Playtest started → its lifecycle siblings (tune, stop, result) are almost
  // always wanted in the same turn-chain.
  if (toolName === "playtest_play" || toolName === "playtest_run_mode") {
    candidates.add("tune");
    candidates.add("playtest_stop");
    candidates.add("playtest_result");
  }

  // Filter to ones the registry knows AND that aren't already visible.
  const wanted = [...candidates].filter((n) => registry.has(n) && !session.tools.has(n));
  if (wanted.length === 0) return [];
  return session.tools.unlock(wanted, session.turn).unlocked;
}

/**
 * Fetch + cache the current place's (PlaceId, Name). Used by the profile
 * resource and the profile_update tool. Falls back to placeId=0 if the
 * bridge isn't connected — the profile system still works, it just keys
 * every offline session into the same "unsaved place" bucket.
 */
async function ensurePlaceContext(
  bridge: StudioTransport,
  session: Session,
): Promise<{ placeId: number; placeName: string }> {
  // Cached with a TTL rather than forever. The old version resolved once and
  // never refreshed, so opening a different place without restarting the server
  // sent every profile write to the first place's PlaceId for the rest of the
  // session (ARCHITECTURE-REVIEW.md A4).
  return session.place.resolve(async () => {
    if (!bridge.connected) return { placeId: 0, placeName: "(plugin not connected)" };
    try {
      const raw = (await bridge.send("eval", {
        luau: "return { placeId = game.PlaceId, placeName = game.Name }",
      })) as { placeId?: unknown; placeName?: unknown } | undefined;
      return {
        placeId: Number(raw?.placeId ?? 0) || 0,
        placeName: String(raw?.placeName ?? ""),
      };
    } catch {
      return { placeId: 0, placeName: "" };
    }
  });
}

/**
 * Build the studio://tools/catalog payload — a category-grouped index of every
 * specialist tool. Cheap: just enumerates the registry, no I/O. Read once per
 * session at most, so the agent can see the whole menu without firing repeated
 * search_tools calls.
 */
function buildToolCatalog(registry: ToolRegistry) {
  const tools: Array<{
    name: string;
    description: string;
    write: boolean;
    keywords: string[];
  }> = [];
  const byCategory: Record<string, Array<(typeof tools)[number]>> = {};
  for (const entry of registry.all()) {
    const cap = capabilities(entry);
    const item = {
      name: entry.name,
      description: entry.description,
      write: cap.write,
      channel: entry.channel,
      keywords: entry.keywords,
    };
    tools.push(item);
    (byCategory[entry.category] ??= []).push(item);
  }
  return {
    note: "Specialist tools, hidden until you call them or search_tools surfaces them. Core tools (always visible, no unlock needed): search_tools, read, screenshot, mutate, run_code.",
    counts: {
      total: tools.length,
      byCategory: Object.fromEntries(
        Object.entries(byCategory).map(([k, v]) => [k, v.length]),
      ),
    },
    categories: byCategory,
  };
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

/**
 * Whether a tool can modify Studio — gated behind the write-mode toggle.
 *
 * Derived from the tool's channel rather than a hardcoded list of names. The old
 * version special-cased four names and then trusted a hand-typed `write` flag that
 * was wrong on six tools (AUDIT.md #2, ARCHITECTURE-REVIEW.md A2).
 */
function isWriteTool(name: string, registry: ToolRegistry): boolean {
  if (name === "mutate" || name === "run_code") return true;
  if (name === "read" || name === "search_tools" || name === "screenshot") return false;
  const cap = registry.capability(name);
  // An unknown tool name is treated as a write: deny by default.
  return cap ? cap.write : true;
}

/** The declared inputSchema for any tool, core or specialist. */
function schemaFor(name: string, registry: ToolRegistry): unknown {
  if (name === "screenshot") return screenshotTool.inputSchema;
  if (CORE_TOOL_DEFS[name]) return CORE_TOOL_DEFS[name].inputSchema;
  return registry.get(name)?.inputSchema;
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

function buildMeta(
  tool: string,
  args: unknown,
  payload: unknown,
  elapsedMs: number,
  payloadChars: number,
): CostMeta {
  const meta: CostMeta = {
    elapsed_ms: elapsedMs,
    tokens_in: estTokens(args),
    tokens_out: Math.ceil(payloadChars / 4),
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
