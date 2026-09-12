import { type ToolEntry, evalTool, luaJson } from "../registry.js";
import { objectResult } from "../output-schema.js";

/**
 * Performance and memory (PLAN.md #8).
 *
 * Every `Stats` member these tools call is `Security: None` in the API dump, so
 * this is reachable from generated Luau with no plugin change — checked rather
 * than assumed, with `docs_class` against the dump the server already caches.
 * (The class as a whole is not all-open: `GetBrowserTrackerId` and
 * `GetPaginatedMemoryByTexture` are RobloxScriptSecurity. Neither is used.)
 *
 * The two profilers the competitor ships are NOT here. `capture_micro_profiler`
 * bundles LibMP into the plugin, and there is no `ScriptProfiler` class in the
 * dump at all. Both are plugin-side work; see PLAN.md.
 *
 * One file per Category value — the registry's own taxonomy names the file,
 * so there is never a question of where a new tool goes (A6).
 */

export const PERF_TOOLS: ToolEntry[] = [
  evalTool(
    {
      name: "perf_stats",
      category: "perf",
      subcategories: ["memory", "profile", "measure"],
      keywords: ["performance", "memory", "stats", "lag", "fps", "heartbeat", "physics", "usage", "profile", "slow"],
      description:
        "Read live engine counters: total memory and the per-category breakdown, instance and primitive counts, heartbeat and physics step time, network throughput. Use to find out WHAT is heavy before guessing at fixes.",
      inputSchema: {
        type: "object",
        properties: {
          categories: {
            type: "boolean",
            description: "Include the per-tag memory breakdown. Default true.",
          },
        },
      },
      readOnly: true,
      outputSchema: objectResult({ result: {} }),
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local Stats = game:GetService("Stats")

local function num(fn)
  local ok, v = pcall(fn)
  if ok and type(v) == "number" then return v end
  return nil
end

local out = {
  memoryMb = num(function() return Stats:GetTotalMemoryUsageMb() end),
  instanceCount = num(function() return Stats.InstanceCount end),
  primitiveCount = num(function() return Stats.PrimitivesCount end),
  movingPrimitiveCount = num(function() return Stats.MovingPrimitivesCount end),
  contactCount = num(function() return Stats.ContactsCount end),
  heartbeatMs = num(function() return Stats.HeartbeatTimeMs end),
  physicsStepMs = num(function() return Stats.PhysicsStepTimeMs end),
  dataSendKbps = num(function() return Stats.DataSendKbps end),
  dataReceiveKbps = num(function() return Stats.DataReceiveKbps end),
}

if a.categories ~= false then
  -- Enum.DeveloperMemoryTag is the engine's own breakdown. Reading it per tag is
  -- the only way to get it; there is no "give me all tags" call.
  local byTag = {}
  for _, tag in ipairs(Enum.DeveloperMemoryTag:GetEnumItems()) do
    local mb = num(function() return Stats:GetMemoryUsageMbForTag(tag) end)
    -- Skip the long tail of zeroes: most tags are empty in most places, and
    -- shipping forty of them buries the three that matter.
    if mb and mb >= 0.1 then byTag[tag.Name] = math.floor(mb * 10 + 0.5) / 10 end
  end
  out.memoryByCategoryMb = byTag
end

return out
`,
  ),

  evalTool(
    {
      name: "scene_analysis",
      category: "perf",
      subcategories: ["memory", "audit", "measure"],
      keywords: ["scene", "analysis", "census", "count", "heavy", "audit", "parts", "unanchored", "optimise", "lag"],
      description:
        "Census a subtree: instance counts by class, and the specific things that cost you — unanchored parts, CanCollide geometry, transparent parts, decals, scripts, and the heaviest containers. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Subtree root. Default Workspace." },
          topClasses: { type: "number", description: "How many classes to list (default 12)." },
        },
      },
      readOnly: true,
      outputSchema: objectResult({ result: {} }),
      // A big Workspace walk is the expensive part, so declare a real budget
      // rather than racing the default timeout.
      yieldBudgetMs: () => 20_000,
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local root = workspace
if a.path then
  local resolved = __MCP.resolve(a.path)
  if not resolved then return { error = "not_found", target = a.path } end
  root = resolved
end

local byClass, total = {}, 0
local unanchored, collidable, transparent, decals, scripts, meshes = 0, 0, 0, 0, 0, 0
local heavy = {}

-- Yield periodically. Declaring a 20s budget makes the TIMEOUT survivable; it
-- does nothing about Studio's main thread being held for the whole of it. A
-- 200k-instance Workspace would freeze the editor solid without this.
-- Guarded: this eval may run in a context that cannot yield (a BindableFunction
-- invocation, a property-changed handler), where task.wait() errors outright
-- with "attempt to yield across a C-call boundary". The plugin is not in this
-- repo, so the safe assumption is that it might.
local canYield = coroutine.isyieldable()
local since = 0
for _, d in ipairs(root:GetDescendants()) do
  since += 1
  if since >= 5000 then
    since = 0
    if canYield then task.wait() end
  end
  total += 1
  byClass[d.ClassName] = (byClass[d.ClassName] or 0) + 1
  if d:IsA("BasePart") then
    if not d.Anchored then unanchored += 1 end
    if d.CanCollide then collidable += 1 end
    if d.Transparency > 0 then transparent += 1 end
    if d:IsA("MeshPart") then meshes += 1 end
  elseif d:IsA("Decal") or d:IsA("Texture") then
    decals += 1
  elseif d:IsA("LuaSourceContainer") then
    scripts += 1
  end
  -- Which containers hold the most. Cheap: one count per direct child of root.
  if d.Parent == root then
    local n = #d:GetDescendants()
    if n > 0 then table.insert(heavy, { name = d.Name, class = d.ClassName, descendants = n }) end
  end
end

local classes = {}
for name, count in pairs(byClass) do table.insert(classes, { class = name, count = count }) end
table.sort(classes, function(x, y) return x.count > y.count end)
local topN = math.max(1, math.min(40, tonumber(a.topClasses) or 12))
local topClasses = {}
for i = 1, math.min(topN, #classes) do topClasses[i] = classes[i] end

table.sort(heavy, function(x, y) return x.descendants > y.descendants end)
local topHeavy = {}
for i = 1, math.min(10, #heavy) do topHeavy[i] = heavy[i] end

return {
  root = root:GetFullName(),
  total = total,
  byClass = topClasses,
  distinctClasses = #classes,
  parts = {
    unanchored = unanchored,
    collidable = collidable,
    transparent = transparent,
    meshParts = meshes,
  },
  decals = decals,
  scripts = scripts,
  heaviestChildren = topHeavy,
}
`,
  ),
];
