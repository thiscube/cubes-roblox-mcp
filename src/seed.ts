import { type ToolEntry, evalTool, mutateTool, luaJson } from "./registry.js";

/**
 * Seed specialist tools. These are deliberately a small starter set — enough to
 * prove progressive loading (search_tools) works across categories. Add more here
 * as needed; each one stays hidden until search surfaces it, so the list can grow
 * without inflating per-turn token cost.
 *
 * Most tools route through the plugin's `mutate` path (atomic + undo waypoint for
 * free) or its `eval` path (for anything that needs a loop or custom logic).
 */

export const SEED_TOOLS: ToolEntry[] = [
  // ---- lighting -----------------------------------------------------------
  mutateTool(
    {
      name: "lighting_configure",
      category: "lighting",
      subcategories: ["environment", "time-of-day"],
      keywords: ["brightness", "dark", "darken", "night", "day", "fog", "ambient", "shadows", "mood"],
      description:
        "Configure the Lighting service: brightness, time of day, ambient color, fog, and global shadows. Use for setting overall scene mood.",
      inputSchema: {
        type: "object",
        properties: {
          brightness: { type: "number", description: "Lighting.Brightness (0-10ish)." },
          clockTime: { type: "number", description: "24h time of day, e.g. 14.5." },
          ambient: { type: "string", description: "Ambient color 'r, g, b' (0-255)." },
          outdoorAmbient: { type: "string", description: "OutdoorAmbient color 'r, g, b' (0-255)." },
          fogEnd: { type: "number", description: "FogEnd distance." },
          fogColor: { type: "string", description: "FogColor 'r, g, b' (0-255)." },
          globalShadows: { type: "boolean", description: "Enable GlobalShadows." },
        },
      },
    },
    (args) => {
      const props: Record<string, unknown> = {};
      if (args.brightness !== undefined) props.Brightness = args.brightness;
      if (args.clockTime !== undefined) props.ClockTime = args.clockTime;
      if (args.ambient !== undefined) props.Ambient = args.ambient;
      if (args.outdoorAmbient !== undefined) props.OutdoorAmbient = args.outdoorAmbient;
      if (args.fogEnd !== undefined) props.FogEnd = args.fogEnd;
      if (args.fogColor !== undefined) props.FogColor = args.fogColor;
      if (args.globalShadows !== undefined) props.GlobalShadows = args.globalShadows;
      return [{ op: "set", target: "Lighting", props }];
    },
  ),

  mutateTool(
    {
      name: "pointlight_add",
      category: "lighting",
      subcategories: ["light", "emitter"],
      keywords: ["lamp", "glow", "torch", "fire", "bulb", "illuminate", "pointlight"],
      description: "Add a PointLight to an instance (a Part, Attachment, etc.) with brightness, range, and color.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Ref or path of the parent instance." },
          brightness: { type: "number", description: "PointLight.Brightness (default 1)." },
          range: { type: "number", description: "PointLight.Range (default 16)." },
          color: { type: "string", description: "Color 'r, g, b' (0-255)." },
        },
        required: ["target"],
      },
    },
    (args) => {
      const props: Record<string, unknown> = {
        Brightness: args.brightness ?? 1,
        Range: args.range ?? 16,
      };
      if (args.color !== undefined) props.Color = args.color;
      return [{ op: "create", class: "PointLight", parent: args.target, name: "PointLight", props }];
    },
  ),

  // ---- instances ----------------------------------------------------------
  evalTool(
    {
      name: "instance_duplicate",
      category: "instances",
      subcategories: ["clone", "copy"],
      keywords: ["duplicate", "copy", "clone", "repeat", "array", "spread"],
      write: true,
      description:
        "Clone an instance N times into its own parent, optionally offsetting each copy's Position. Returns refs of the new copies. Runs in one undo waypoint.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Ref or path of the instance to clone." },
          count: { type: "number", description: "How many copies (default 1)." },
          offset: {
            type: "array",
            items: { type: "number" },
            description: "Per-copy [x, y, z] position offset (BaseParts only).",
          },
        },
        required: ["target"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local src = __MCP.resolve(a.target)
if not src then return { error = "not_found", target = a.target } end
local CHS = game:GetService("ChangeHistoryService")
local rec = CHS:TryBeginRecording("Cubes MCP: instance_duplicate")
local out = {}
for i = 1, (a.count or 1) do
  local c = src:Clone()
  c.Parent = src.Parent
  if a.offset and c:IsA("BasePart") then
    c.Position = c.Position + Vector3.new((a.offset[1] or 0) * i, (a.offset[2] or 0) * i, (a.offset[3] or 0) * i)
  end
  out[#out + 1] = { ref = __MCP.refFor(c), path = c:GetFullName() }
end
if rec then CHS:FinishRecording(rec, Enum.FinishRecordingOperation.Commit) end
return { created = out }
`,
  ),

  mutateTool(
    {
      name: "parts_grid",
      category: "instances",
      subcategories: ["generate", "layout"],
      keywords: ["grid", "tiles", "floor", "rows", "columns", "spawn", "many", "pattern"],
      description:
        "Create a rectangular grid of anchored Parts under a parent. Good for floors, tile layouts, or placeholder geometry.",
      inputSchema: {
        type: "object",
        properties: {
          parent: { type: "string", description: "Ref or path of the parent (default Workspace)." },
          rows: { type: "number", description: "Number of rows (default 4)." },
          cols: { type: "number", description: "Number of columns (default 4)." },
          spacing: { type: "number", description: "World units between part centers (default 6)." },
          size: {
            type: "array",
            items: { type: "number" },
            description: "Part size [x, y, z] (default [4, 1, 4]).",
          },
          origin: {
            type: "array",
            items: { type: "number" },
            description: "World origin [x, y, z] of the grid (default [0, 0, 0]).",
          },
        },
      },
    },
    (args) => {
      const rows = Math.max(1, args.rows ?? 4);
      const cols = Math.max(1, args.cols ?? 4);
      const spacing = args.spacing ?? 6;
      const size = args.size ?? [4, 1, 4];
      const origin = args.origin ?? [0, 0, 0];
      const parent = args.parent ?? "Workspace";
      const ops: unknown[] = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          ops.push({
            op: "create",
            class: "Part",
            parent,
            name: `Tile_${r}_${c}`,
            props: {
              Anchored: true,
              Size: size,
              Position: [origin[0] + c * spacing, origin[1], origin[2] + r * spacing],
            },
          });
        }
      }
      return ops;
    },
  ),

  evalTool(
    {
      name: "selection_get",
      category: "instances",
      subcategories: ["studio", "selection"],
      keywords: ["selected", "selection", "highlighted", "what is selected", "current"],
      description: "Return the instances currently selected in Studio as refs (with path and class).",
      inputSchema: { type: "object", properties: {} },
    },
    () => `
local sel = game:GetService("Selection"):Get()
local out = {}
for _, inst in ipairs(sel) do
  out[#out + 1] = { ref = __MCP.refFor(inst), path = inst:GetFullName(), class = inst.ClassName }
end
return { selection = out, count = #out }
`,
  ),

  evalTool(
    {
      name: "selection_set",
      category: "instances",
      subcategories: ["studio", "selection"],
      keywords: ["select", "highlight", "focus", "pick"],
      description: "Set the Studio selection to a list of refs or paths.",
      inputSchema: {
        type: "object",
        properties: {
          targets: {
            type: "array",
            items: { type: "string" },
            description: "Refs or paths to select.",
          },
        },
        required: ["targets"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local picked = {}
for _, t in ipairs(a.targets or {}) do
  local inst = __MCP.resolve(t)
  if inst then picked[#picked + 1] = inst end
end
game:GetService("Selection"):Set(picked)
return { selected = #picked }
`,
  ),

  evalTool(
    {
      name: "material_paint",
      category: "instances",
      subcategories: ["appearance", "material"],
      keywords: ["material", "color", "paint", "texture", "recolor", "wood", "metal", "neon"],
      write: true,
      description: "Set Material and/or Color on one or more BaseParts (by refs, paths, or a query).",
      inputSchema: {
        type: "object",
        properties: {
          targets: { type: "array", items: { type: "string" }, description: "Refs or paths." },
          query: { type: "string", description: "Alternative to targets: a read-style selector." },
          material: { type: "string", description: "Material name, e.g. 'Wood', 'Neon', 'Metal'." },
          color: { type: "string", description: "Color 'r, g, b' (0-255)." },
        },
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local list = {}
if a.query then
  for _, inst in ipairs(__MCP.query(a.query)) do list[#list + 1] = inst end
end
for _, t in ipairs(a.targets or {}) do
  local inst = __MCP.resolve(t)
  if inst then list[#list + 1] = inst end
end
local CHS = game:GetService("ChangeHistoryService")
local rec = CHS:TryBeginRecording("Cubes MCP: material_paint")
local touched = 0
for _, inst in ipairs(list) do
  if inst:IsA("BasePart") then
    if a.material then
      local ok, m = pcall(function() return Enum.Material[a.material] end)
      if ok then inst.Material = m end
    end
    if a.color then
      local r, g, b = string.match(a.color, "(%d+)%D+(%d+)%D+(%d+)")
      if r then inst.Color = Color3.fromRGB(tonumber(r), tonumber(g), tonumber(b)) end
    end
    touched += 1
  end
end
if rec then CHS:FinishRecording(rec, Enum.FinishRecordingOperation.Commit) end
return { painted = touched }
`,
  ),

  evalTool(
    {
      name: "tag_apply",
      category: "instances",
      subcategories: ["collectionservice", "metadata"],
      keywords: ["tag", "collectionservice", "label", "group", "mark"],
      write: true,
      description: "Add or remove a CollectionService tag on a set of instances.",
      inputSchema: {
        type: "object",
        properties: {
          targets: { type: "array", items: { type: "string" }, description: "Refs or paths." },
          tag: { type: "string", description: "Tag name." },
          remove: { type: "boolean", description: "Remove instead of add (default false)." },
        },
        required: ["targets", "tag"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local CS = game:GetService("CollectionService")
local n = 0
for _, t in ipairs(a.targets or {}) do
  local inst = __MCP.resolve(t)
  if inst then
    if a.remove then CS:RemoveTag(inst, a.tag) else CS:AddTag(inst, a.tag) end
    n += 1
  end
end
return { tag = a.tag, affected = n, removed = a.remove == true }
`,
  ),

  // ---- scripts ------------------------------------------------------------
  mutateTool(
    {
      name: "script_create",
      category: "scripts",
      subcategories: ["code", "author"],
      keywords: ["script", "code", "luau", "module", "localscript", "serverscript", "behavior"],
      description:
        "Create a Script, LocalScript, or ModuleScript with initial source code under a parent. Runs in one undo waypoint.",
      inputSchema: {
        type: "object",
        properties: {
          parent: { type: "string", description: "Ref or path of the parent." },
          name: { type: "string", description: "Script name." },
          kind: {
            type: "string",
            enum: ["Script", "LocalScript", "ModuleScript"],
            description: "Script class (default Script).",
          },
          source: { type: "string", description: "Initial Luau source." },
        },
        required: ["parent", "name"],
      },
    },
    (args) => [
      {
        op: "create",
        class: args.kind ?? "Script",
        parent: args.parent,
        name: args.name,
        props: args.source ? { Source: args.source } : {},
      },
    ],
  ),

  // ---- debug --------------------------------------------------------------
  evalTool(
    {
      name: "place_info",
      category: "debug",
      subcategories: ["studio", "metadata"],
      keywords: ["place", "game", "info", "stats", "counts", "overview", "where am i"],
      description:
        "Quick overview of the open place: PlaceId, name, and instance counts for the major services.",
      inputSchema: { type: "object", properties: {} },
    },
    () => `
local function count(svc)
  local ok, s = pcall(function() return game:GetService(svc) end)
  if not ok or not s then return 0 end
  return #s:GetDescendants()
end
return {
  placeId = game.PlaceId,
  name = game.Name,
  workspace = count("Workspace"),
  serverScriptService = count("ServerScriptService"),
  serverStorage = count("ServerStorage"),
  replicatedStorage = count("ReplicatedStorage"),
  starterGui = count("StarterGui"),
  lighting = count("Lighting"),
}
`,
  ),

  // ---- session memory -----------------------------------------------------
  {
    name: "macro_save",
    category: "session",
    subcategories: ["macro", "record"],
    keywords: ["macro", "record", "save", "sequence", "replay", "reuse", "automate", "memory"],
    write: false,
    description:
      "Save a reusable macro. Either captures the mutate ops from the last N history entries (from_last) or takes an explicit ops array. Replay with macro_run. Note: only direct `mutate` ops are captured, not specialist-tool calls.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Macro name." },
        from_last: {
          type: "number",
          description: "Capture mutate ops from the last N history entries (default 10).",
        },
        ops: {
          type: "array",
          items: { type: "object" },
          description: "Explicit ops to save (alternative to from_last).",
        },
      },
      required: ["name"],
    },
    handler: async (args, ctx) => {
      const name = String(args.name ?? "").trim();
      if (!name) return { error: "bad_args", hint: "macro_save needs a 'name'." };
      const ops = Array.isArray(args.ops)
        ? (args.ops as unknown[])
        : ctx.memory.opsFromHistory(typeof args.from_last === "number" ? args.from_last : 10);
      if (ops.length === 0) {
        return {
          error: "empty_macro",
          hint: "No mutate ops to save — pass `ops` explicitly, or run some mutate calls first then use from_last.",
        };
      }
      const macro = ctx.memory.saveMacro(name, ops);
      return { saved: macro.name, opCount: macro.opCount, hint: `Replay with macro_run({ name: "${name}" }).` };
    },
  },
  {
    name: "macro_run",
    category: "session",
    subcategories: ["macro", "replay"],
    keywords: ["macro", "run", "replay", "execute", "repeat", "reuse", "memory"],
    write: true,
    description:
      "Replay a saved macro — re-submits its ops as one atomic mutate batch (single undo waypoint). Lint results come back under the nested mutate result, same as a normal mutate.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Macro name to run." } },
      required: ["name"],
    },
    handler: async (args, ctx) => {
      const name = String(args.name ?? "").trim();
      const macro = ctx.memory.getMacro(name);
      if (!macro) {
        return {
          error: "macro_not_found",
          name,
          hint: "Check macro_list or the studio://session/macros resource.",
        };
      }
      const result = await ctx.bridge.send("mutate", { ops: macro.ops });
      return { ran: name, opCount: macro.opCount, result };
    },
  },
  {
    name: "macro_list",
    category: "session",
    subcategories: ["macro"],
    keywords: ["macro", "list", "saved", "macros", "memory"],
    write: false,
    description:
      "List saved macros (name, op count, created time). Also available as the studio://session/macros resource.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => ({ macros: ctx.memory.listMacros() }),
  },

  // ---- playtest -----------------------------------------------------------
  evalTool(
    {
      name: "test_run",
      category: "playtest",
      subcategories: ["testez", "tests", "verify"],
      keywords: ["test", "testez", "unit test", "spec", "suite", "run tests", "verify", "regression"],
      write: false,
      description:
        "Run a TestEZ suite and return structured pass/fail counts + failures. Finds TestEZ automatically (ReplicatedStorage / ServerScriptService / ServerStorage) or takes an explicit testezPath. Closes the loop on 'did my change break anything'.",
      inputSchema: {
        type: "object",
        properties: {
          suite: {
            type: "string",
            description: "Ref or path of the test root (a folder/instance containing *.spec ModuleScripts).",
          },
          testezPath: {
            type: "string",
            description: "Optional ref/path of the TestEZ ModuleScript, if it isn't auto-found.",
          },
        },
        required: ["suite"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local testez
if a.testezPath then
  testez = __MCP.resolve(a.testezPath)
else
  for _, svcName in ipairs({ "ReplicatedStorage", "ServerScriptService", "ServerStorage" }) do
    local ok, svc = pcall(game.GetService, game, svcName)
    if ok and svc then
      local found = svc:FindFirstChild("TestEZ", true)
      if found and found:IsA("ModuleScript") then testez = found break end
    end
  end
end
if not testez then
  return { error = "testez_not_found", hint = "Install TestEZ as a ModuleScript (e.g. in ReplicatedStorage) or pass testezPath." }
end
local suite = __MCP.resolve(a.suite)
if not suite then return { error = "not_found", suite = a.suite } end
local okReq, TestEZ = pcall(require, testez)
if not okReq then return { error = "testez_require_failed", message = tostring(TestEZ) } end
local results
local okRun, err = pcall(function()
  results = TestEZ.TestBootstrap:run({ suite }, TestEZ.Reporters and TestEZ.Reporters.TextReporter or nil)
end)
if not okRun then return { error = "test_run_failed", message = tostring(err) } end
return {
  ran = true,
  suite = suite:GetFullName(),
  successCount = results and results.successCount or nil,
  failureCount = results and results.failureCount or nil,
  skippedCount = results and results.skippedCount or nil,
  errors = results and results.errors or nil,
}
`,
  ),
];
