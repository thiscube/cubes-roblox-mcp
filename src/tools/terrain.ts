import { type ToolEntry, evalTool, luaJson } from "../registry.js";
import { beginUndo, cancelUndo, endUndo } from "./_luau-helpers.js";

/**
 * Terrain sculpting.
 *
 * One file per Category value — the registry's own taxonomy names the file,
 * so there is never a question of where a new tool goes (A6).
 */

export const TERRAIN_TOOLS: ToolEntry[] = [
  evalTool(
    {
      name: "terrain_fill",
      category: "terrain",
      subcategories: ["voxel", "sculpt", "build"],
      keywords: ["terrain", "fill", "voxel", "sculpt", "hill", "lake", "dig", "carve", "material"],
      description:
        "Fill a Terrain region with a material. Shapes: block (size [x,y,z]), ball (radius), cylinder (radius + height). Material is any Enum.Material name; use 'Air' to dig caves. One ChangeHistory waypoint per call.",
      inputSchema: {
        type: "object",
        properties: {
          shape: { type: "string", enum: ["block", "ball", "cylinder"], description: "Region shape." },
          material: { type: "string", description: "Enum.Material name. 'Air' carves." },
          center: { type: "array", items: { type: "number" }, description: "World [x,y,z] center of the region." },
          size: { type: "array", items: { type: "number" }, description: "[x,y,z] size — required for block." },
          radius: { type: "number", description: "Radius for ball / cylinder (default 8)." },
          height: { type: "number", description: "Height for cylinder (default 4)." },
        },
        required: ["shape", "material", "center"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local Terrain = workspace.Terrain
local okMat, mat = pcall(function() return Enum.Material[a.material] end)
if not okMat or not mat then return { error = "bad_material", material = a.material, hint = "Use a valid Enum.Material name (Grass, Sand, Rock, Water, Air, ...)" } end
local c = a.center
if type(c) ~= "table" then return { error = "bad_args", hint = "center [x,y,z] is required" } end
local center = Vector3.new(c[1] or 0, c[2] or 0, c[3] or 0)
${beginUndo("Cubes MCP: terrain_fill")}
local ok, err = pcall(function()
  if a.shape == "block" then
    if type(a.size) ~= "table" then error("size [x,y,z] required for block") end
    local size = Vector3.new(a.size[1] or 4, a.size[2] or 4, a.size[3] or 4)
    Terrain:FillBlock(CFrame.new(center), size, mat)
  elseif a.shape == "ball" then
    Terrain:FillBall(center, tonumber(a.radius) or 8, mat)
  elseif a.shape == "cylinder" then
    Terrain:FillCylinder(CFrame.new(center), tonumber(a.height) or 4, tonumber(a.radius) or 8, mat)
  else
    error("unknown shape: " .. tostring(a.shape))
  end
end)
if not ok then ${cancelUndo} return { error = "fill_failed", message = tostring(err) } end
${endUndo}
return { ok = true, shape = a.shape, material = a.material, center = { center.X, center.Y, center.Z } }
`,
  ),
  evalTool(
    {
      name: "terrain_clear",
      category: "terrain",
      subcategories: ["voxel", "wipe"],
      keywords: ["terrain", "clear", "wipe", "delete", "reset", "void"],
      description: "Clear all terrain voxels. Single undo waypoint.",
      inputSchema: { type: "object", properties: {} },
    },
    () => `
${beginUndo("Cubes MCP: terrain_clear")}
workspace.Terrain:Clear()
${endUndo}
return { cleared = true }
`,
  ),
];
