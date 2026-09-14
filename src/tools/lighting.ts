import { type ToolEntry, evalTool, luaJson } from "../registry.js";
import { beginUndo, cancelUndo, endUndo, parseColorLua } from "./_luau-helpers.js";

/**
 * Sky, clouds and lighting configuration.
 *
 * One file per Category value — the registry's own taxonomy names the file,
 * so there is never a question of where a new tool goes (A6).
 */

export const LIGHTING_TOOLS: ToolEntry[] = [
  evalTool(
    {
      name: "sky_configure",
      category: "lighting",
      subcategories: ["sky", "atmosphere", "environment"],
      keywords: ["sky", "skybox", "clouds", "atmosphere", "sun", "moon", "stars", "weather"],
      description:
        "Configure sky and clouds: skybox faces, sun/moon size, stars, cloud cover/density/color. Creates Sky and Clouds if missing; pass only what changes.",
      inputSchema: {
        type: "object",
        properties: {
          skyboxUp: { type: "string", description: "Top face texture asset ID." },
          skyboxDn: { type: "string", description: "Bottom face texture." },
          skyboxLf: { type: "string", description: "Left face texture." },
          skyboxRt: { type: "string", description: "Right face texture." },
          skyboxFt: { type: "string", description: "Front face texture." },
          skyboxBk: { type: "string", description: "Back face texture." },
          starCount: { type: "number", description: "Number of stars (default 3000)." },
          sunAngularSize: { type: "number", description: "Degrees (default 21)." },
          moonAngularSize: { type: "number", description: "Degrees (default 11)." },
          clouds: {
            type: "object",
            description: "Cloud settings.",
            properties: {
              cover: { type: "number", description: "0..1 (default 0.55)." },
              density: { type: "number", description: "0..1 (default 0.55)." },
              color: { type: "string", description: "'r,g,b' (0-255)." },
            },
          },
        },
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local Lighting = game:GetService("Lighting")
${parseColorLua}
${beginUndo("Cubes MCP: sky_configure")}
local sky = Lighting:FindFirstChildOfClass("Sky")
if not sky then sky = Instance.new("Sky"); sky.Parent = Lighting end
local applied = {}
local function set(prop, val) if val ~= nil then sky[prop] = val; applied[#applied + 1] = "Sky." .. prop end end
local function id(s) if not s then return nil end local t = tostring(s); if not string.find(t, "://") then t = "rbxassetid://" .. t end return t end
set("SkyboxUp", id(a.skyboxUp))
set("SkyboxDn", id(a.skyboxDn))
set("SkyboxLf", id(a.skyboxLf))
set("SkyboxRt", id(a.skyboxRt))
set("SkyboxFt", id(a.skyboxFt))
set("SkyboxBk", id(a.skyboxBk))
set("StarCount", tonumber(a.starCount))
set("SunAngularSize", tonumber(a.sunAngularSize))
set("MoonAngularSize", tonumber(a.moonAngularSize))
if a.clouds then
  local okClouds, cloudsErr = pcall(function()
    local terrain = workspace.Terrain
    local clouds = terrain:FindFirstChildOfClass("Clouds")
    if not clouds then clouds = Instance.new("Clouds"); clouds.Parent = terrain end
    if a.clouds.cover then clouds.Cover = tonumber(a.clouds.cover); applied[#applied + 1] = "Clouds.Cover" end
    if a.clouds.density then clouds.Density = tonumber(a.clouds.density); applied[#applied + 1] = "Clouds.Density" end
    local cc = __parseColor(a.clouds.color)
    if cc then clouds.Color = cc; applied[#applied + 1] = "Clouds.Color" end
  end)
  if not okClouds then
    ${cancelUndo}
    return { error = "clouds_failed", message = tostring(cloudsErr) }
  end
end
${endUndo}
return { applied = applied }
`,
  ),
];
