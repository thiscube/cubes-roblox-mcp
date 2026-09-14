import { type ToolEntry, evalTool, mutateTool, luaJson } from "../registry.js";
import { beginUndo, endUndo, parseColorLua } from "./_luau-helpers.js";

/**
 * Creating, cloning, painting and arranging instances.
 *
 * One file per Category value — the registry's own taxonomy names the file,
 * so there is never a question of where a new tool goes (A6).
 */

export const INSTANCES_TOOLS: ToolEntry[] = [
  evalTool(
    {
      name: "tags_find",
      category: "instances",
      subcategories: ["tags", "query", "introspect"],
      keywords: ["tag", "tags", "collectionservice", "tagged", "find", "group", "label"],
      readOnly: true,
      description:
        "CollectionService tags. Give `tag` to list every instance carrying it, or `target` to list one instance's tags. How most places mark doors, spawners and interactables.",
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Find every instance carrying this tag." },
          target: { type: "string", description: "Ref or path whose own tags to list. Use instead of `tag`." },
          limit: { type: "number", minimum: 1, maximum: 500, description: "Max instances returned (default 100)." },
        },
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local CS = game:GetService("CollectionService")
if a.target ~= nil and a.target ~= "" then
  local inst = __MCP.resolve(a.target)
  if not inst then return { error = "not_found", target = a.target } end
  return { target = inst:GetFullName(), tags = CS:GetTags(inst) }
end
if a.tag == nil or a.tag == "" then
  return { error = "bad_args", hint = "Pass a tag to search for, or a target whose tags you want." }
end
local limit = math.clamp(math.floor(tonumber(a.limit) or 100), 1, 500)
local out, n = {}, 0
-- Count every match but only carry \`limit\` of them back, so the caller learns
-- a tag has 4000 instances without being sent 4000 rows to find that out.
for _, inst in ipairs(CS:GetTagged(a.tag)) do
  n = n + 1
  if n <= limit then
    out[#out + 1] = { ref = __MCP.refFor(inst), path = inst:GetFullName(), class = inst.ClassName }
  end
end
return { tag = a.tag, total = n, truncated = n > limit, instances = out }
`,
  ),
  evalTool(
    {
      name: "tags_set",
      category: "instances",
      subcategories: ["tags", "edit"],
      keywords: ["tag", "untag", "addtag", "removetag", "collectionservice", "mark"],
      description:
        "Add or remove CollectionService tags on one instance. Returns the resulting tag list. One undo waypoint.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Ref or path of the instance to tag." },
          add: { type: "array", items: { type: "string" }, description: "Tags to add." },
          remove: { type: "array", items: { type: "string" }, description: "Tags to remove." },
        },
        required: ["target"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local CS = game:GetService("CollectionService")
local inst = __MCP.resolve(a.target)
if not inst then return { error = "not_found", target = a.target } end
${beginUndo("Cubes MCP: tags_set")}
local ok, err = pcall(function()
  for _, t in ipairs(a.add or {}) do CS:AddTag(inst, tostring(t)) end
  for _, t in ipairs(a.remove or {}) do CS:RemoveTag(inst, tostring(t)) end
end)
if __rec then
  CHS:FinishRecording(__rec, ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel)
end
if not ok then return { error = "tag_failed", message = tostring(err) } end
return { target = inst:GetFullName(), tags = CS:GetTags(inst) }
`,
  ),
  evalTool(
    {
      name: "instance_duplicate",
      category: "instances",
      subcategories: ["clone", "copy"],
      keywords: ["duplicate", "copy", "clone", "repeat", "array", "spread"],
      description:
        "Clone an instance N times into its own parent, optionally offsetting each copy's Position. Returns refs of the new copies. Runs in one undo waypoint.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Ref or path of the instance to clone." },
          count: { type: "number", minimum: 1, maximum: 250, description: "How many copies (default 1, max 250)." },
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
-- Guard: services live directly under \`game\` and \`Clone()\` errors on them.
-- Surface the issue with a structured error instead of letting it fall
-- through as a generic \`runtime_error\`.
if src.Parent == game then
  return { error = "cannot_clone_service", target = a.target, hint = "Clone a child of the service, not the service itself." }
end
local CHS = game:GetService("ChangeHistoryService")
local rec = CHS:TryBeginRecording("Cubes MCP: instance_duplicate")
local out = {}
local ok, err = pcall(function()
  for i = 1, math.clamp(math.floor(tonumber(a.count) or 1), 1, 250) do
    local c = src:Clone()
    c.Parent = src.Parent
    if a.offset and c:IsA("BasePart") then
      c.Position = c.Position + Vector3.new((a.offset[1] or 0) * i, (a.offset[2] or 0) * i, (a.offset[3] or 0) * i)
    end
    out[#out + 1] = { ref = __MCP.refFor(c), path = c:GetFullName() }
  end
end)
if rec then CHS:FinishRecording(rec, ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel) end
if not ok then return { error = "clone_failed", message = tostring(err) } end
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
      // Cap at 50×50 = 2500 parts per batch. Past this point the mutate
      // payload is enormous and the lint/replication cost explodes —
      // splitting into multiple calls is cheaper.
      const MAX_DIM = 50;
      const rows = Math.min(MAX_DIM, Math.max(1, args.rows ?? 4));
      const cols = Math.min(MAX_DIM, Math.max(1, args.cols ?? 4));
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
      local r, g, b = string.match(a.color, "(-?[%d%.]+)%D*[%s,]+(-?[%d%.]+)%D*[%s,]+(-?[%d%.]+)")
      if r then
        local rn, gn, bn = tonumber(r), tonumber(g), tonumber(b)
        if rn and gn and bn then
          local maxC = math.max(rn, gn, bn)
          if maxC > 1 then
            inst.Color = Color3.fromRGB(rn, gn, bn)
          else
            inst.Color = Color3.new(rn, gn, bn)
          end
        end
      end
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
      name: "particle_emitter_add",
      category: "instances",
      subcategories: ["effects", "particles", "vfx"],
      keywords: ["particle", "particles", "emitter", "vfx", "effect", "sparkle", "smoke", "fire", "magic"],
      description:
        "Add a ParticleEmitter to a BasePart or Attachment; a couple of params are usually enough. Returns the emitter ref.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Ref/path of a BasePart or Attachment." },
          rate: { type: "number", description: "Particles per second (default 20)." },
          lifetimeMin: { type: "number", description: "Min lifetime (default 1)." },
          lifetimeMax: { type: "number", description: "Max lifetime (default 1)." },
          speedMin: { type: "number", description: "Min speed (default 0)." },
          speedMax: { type: "number", description: "Max speed (default 5)." },
          size: { type: "number", description: "Particle size (default 1)." },
          color: { type: "string", description: "Color 'r,g,b' (0-255)." },
          texture: { type: "string", description: "Texture id (default sparkle)." },
          rotationSpeedMin: { type: "number", description: "Rotation speed min (default 0)." },
          rotationSpeedMax: { type: "number", description: "Rotation speed max (default 0)." },
          enabled: { type: "boolean", description: "Initially enabled (default true)." },
        },
        required: ["target"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local inst = __MCP.resolve(a.target)
if not inst then return { error = "not_found" } end
if not inst:IsA("BasePart") and not inst:IsA("Attachment") then
  return { error = "bad_target", hint = "ParticleEmitter must be parented to a BasePart or Attachment.", class = inst.ClassName }
end
${parseColorLua}
${beginUndo("Cubes MCP: particle_emitter_add")}
local e = Instance.new("ParticleEmitter")
e.Rate = tonumber(a.rate) or 20
e.Lifetime = NumberRange.new(tonumber(a.lifetimeMin) or 1, tonumber(a.lifetimeMax) or 1)
e.Speed = NumberRange.new(tonumber(a.speedMin) or 0, tonumber(a.speedMax) or 5)
e.Size = NumberSequence.new(tonumber(a.size) or 1)
e.RotSpeed = NumberRange.new(tonumber(a.rotationSpeedMin) or 0, tonumber(a.rotationSpeedMax) or 0)
local col = __parseColor(a.color)
if col then e.Color = ColorSequence.new(col) end
if a.texture then
  local t = tostring(a.texture)
  if not string.find(t, "://") then t = "rbxassetid://" .. t end
  e.Texture = t
end
e.Enabled = a.enabled ~= false
e.Parent = inst
${endUndo}
return { ref = __MCP.refFor(e), parent = inst:GetFullName(), enabled = e.Enabled }
`,
  ),
  evalTool(
    {
      name: "beam_add",
      category: "instances",
      subcategories: ["effects", "beam", "vfx"],
      keywords: ["beam", "laser", "ray", "line", "connection", "magic", "lightning"],
      description:
        "Connect two BaseParts with a Beam, creating the Attachments (optional offsets). Width, color, transparency, segments, scrolling texture.",
      inputSchema: {
        type: "object",
        properties: {
          part0: { type: "string", description: "Ref/path of the first BasePart." },
          part1: { type: "string", description: "Ref/path of the second BasePart." },
          offset0: { type: "array", items: { type: "number" }, description: "Local [x,y,z] offset of Attachment0 (default origin)." },
          offset1: { type: "array", items: { type: "number" }, description: "Local [x,y,z] offset of Attachment1." },
          width: { type: "number", description: "Beam Width0 + Width1 (default 0.5)." },
          color: { type: "string", description: "Color 'r,g,b'." },
          transparency: { type: "number", description: "0..1 (default 0)." },
          segments: { type: "number", description: "Number of segments (default 10)." },
          texture: { type: "string", description: "Texture asset ID for a scrolling beam (optional)." },
          textureSpeed: { type: "number", description: "Texture scroll speed when texture is set (default 1)." },
        },
        required: ["part0", "part1"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local p0 = __MCP.resolve(a.part0)
local p1 = __MCP.resolve(a.part1)
if not p0 or not p1 then return { error = "not_found" } end
if not p0:IsA("BasePart") or not p1:IsA("BasePart") then return { error = "bad_target", hint = "Both targets must be BaseParts." } end
${parseColorLua}
${beginUndo("Cubes MCP: beam_add")}
local function mkAttach(part, off)
  local at = Instance.new("Attachment")
  if type(off) == "table" then at.Position = Vector3.new(off[1] or 0, off[2] or 0, off[3] or 0) end
  at.Parent = part
  return at
end
local at0 = mkAttach(p0, a.offset0)
local at1 = mkAttach(p1, a.offset1)
local beam = Instance.new("Beam")
beam.Attachment0 = at0
beam.Attachment1 = at1
local w = tonumber(a.width) or 0.5
beam.Width0 = w
beam.Width1 = w
beam.Transparency = NumberSequence.new(tonumber(a.transparency) or 0)
beam.Segments = tonumber(a.segments) or 10
local col = __parseColor(a.color)
if col then beam.Color = ColorSequence.new(col) end
if a.texture then
  local t = tostring(a.texture)
  if not string.find(t, "://") then t = "rbxassetid://" .. t end
  beam.Texture = t
  beam.TextureSpeed = tonumber(a.textureSpeed) or 1
end
beam.Parent = p0
${endUndo}
return { ref = __MCP.refFor(beam), attachments = { __MCP.refFor(at0), __MCP.refFor(at1) } }
`,
  ),
  evalTool(
    {
      name: "workspace_configure",
      category: "instances",
      subcategories: ["world", "game", "settings"],
      keywords: ["workspace", "gravity", "fall", "settings", "walkspeed", "jumppower", "zoom", "streaming"],
      description:
        "Set world settings: Gravity, FallenPartsDestroyHeight, StreamingEnabled, and StarterPlayer WalkSpeed/JumpPower/JumpHeight/MaxZoomDistance. Only what you pass changes.",
      inputSchema: {
        type: "object",
        properties: {
          gravity: { type: "number", description: "Workspace.Gravity (default 196.2)." },
          fallenPartsDestroyHeight: { type: "number", description: "Y below which parts are destroyed." },
          streamingEnabled: { type: "boolean", description: "Workspace.StreamingEnabled." },
          walkSpeed: { type: "number", description: "StarterPlayer.CharacterWalkSpeed (default 16)." },
          jumpPower: { type: "number", description: "StarterPlayer.CharacterJumpPower." },
          jumpHeight: { type: "number", description: "StarterPlayer.CharacterJumpHeight." },
          maxHealth: { type: "number", description: "StarterPlayer.CharacterMaxHealth." },
          maxZoomDistance: { type: "number", description: "StarterPlayer.CameraMaxZoomDistance." },
          minZoomDistance: { type: "number", description: "StarterPlayer.CameraMinZoomDistance." },
        },
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
${beginUndo("Cubes MCP: workspace_configure")}
local applied = {}
local function set(parent, prop, val)
  if val == nil then return end
  local ok = pcall(function() parent[prop] = val end)
  if ok then applied[#applied + 1] = parent.Name .. "." .. prop end
end
set(workspace, "Gravity", tonumber(a.gravity))
set(workspace, "FallenPartsDestroyHeight", tonumber(a.fallenPartsDestroyHeight))
if a.streamingEnabled ~= nil then set(workspace, "StreamingEnabled", a.streamingEnabled == true) end
local sp = game:GetService("StarterPlayer")
set(sp, "CharacterWalkSpeed", tonumber(a.walkSpeed))
set(sp, "CharacterJumpPower", tonumber(a.jumpPower))
set(sp, "CharacterJumpHeight", tonumber(a.jumpHeight))
set(sp, "CharacterMaxHealth", tonumber(a.maxHealth))
set(sp, "CameraMaxZoomDistance", tonumber(a.maxZoomDistance))
set(sp, "CameraMinZoomDistance", tonumber(a.minZoomDistance))
${endUndo}
return { applied = applied }
`,
  ),
];
