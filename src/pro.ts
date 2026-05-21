/**
 * "Pro" specialist tools — second wave of coverage filling the biggest gaps
 * the agent hits when building actual games: terrain sculpting, animation
 * playback, audio, effects (tween/particles/beam), physics primitives
 * (collision groups, constraints), and world-level settings (gravity,
 * skybox, clouds).
 *
 * Every tool here goes through the plugin's eval path so the work is
 * undoable (each tool wraps a single ChangeHistoryService recording) and
 * lives in one composable response. Tool surface is intentionally narrow —
 * the inputSchema documents the few knobs that actually matter.
 */

import { type ToolEntry, evalTool, luaJson } from "./registry.js";

// Shared preamble snippet that opens a CHS recording, returns it so the
// caller can FinishRecording on success. Avoids re-typing the boilerplate
// in every tool. The CHS wrapper makes every tool here a clean undo point.
const beginUndo = (label: string) => `
local CHS = game:GetService("ChangeHistoryService")
local __rec = CHS:TryBeginRecording(${luaJson(label)})
`;

const endUndo = `
if __rec then CHS:FinishRecording(__rec, Enum.FinishRecordingOperation.Commit) end
`;

const cancelUndo = `
if __rec then CHS:FinishRecording(__rec, Enum.FinishRecordingOperation.Cancel) end
`;

// Helper to parse "r,g,b" or "r, g, b" into Color3. Used by tools that take
// colors as strings (consistent with the rest of the seed tools).
const parseColorLua = `
local function __parseColor(s)
  if type(s) ~= "string" then return nil end
  local r, g, b = string.match(s, "(%-?[%d%.]+)%D+(%-?[%d%.]+)%D+(%-?[%d%.]+)")
  if not r then return nil end
  local rn, gn, bn = tonumber(r), tonumber(g), tonumber(b)
  if not rn or not gn or not bn then return nil end
  if math.max(rn, gn, bn) > 1 then return Color3.fromRGB(rn, gn, bn) end
  return Color3.new(rn, gn, bn)
end
`;

export const PRO_TOOLS: ToolEntry[] = [
  // ====== TERRAIN ==========================================================
  evalTool(
    {
      name: "terrain_fill",
      category: "terrain",
      subcategories: ["voxel", "sculpt", "build"],
      keywords: ["terrain", "fill", "voxel", "sculpt", "hill", "lake", "dig", "carve", "material"],
      write: true,
      description:
        "Fill a region of Terrain with a material. Shapes: block (size [x,y,z]), ball (radius), cylinder (radius + height). Material is any Enum.Material name — Grass, Sand, Rock, Snow, Ground, Asphalt, Concrete, Wood, Plastic, Water, etc. Use 'Air' to dig (carve caves). One ChangeHistory waypoint per call.",
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
      write: true,
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

  // ====== ANIMATION ========================================================
  evalTool(
    {
      name: "animation_play",
      category: "animation",
      subcategories: ["humanoid", "playback"],
      keywords: ["animate", "animation", "play", "humanoid", "track", "walk", "run", "idle", "dance"],
      write: true,
      description:
        "Load an Animation asset onto a Humanoid's Animator and play it. Returns the AnimationTrack-equivalent ref so the caller can stop/adjust it. Target can be a Humanoid, a character Model containing one, or a player ref.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Ref/path: Humanoid, character Model, or Player." },
          animationId: { type: "string", description: "Asset ID, e.g. 'rbxassetid://123' or just the number." },
          looped: { type: "boolean", description: "Loop on end (default false)." },
          priority: { type: "string", enum: ["Idle", "Movement", "Action", "Action2", "Action3", "Action4", "Core"], description: "AnimationPriority (default Action)." },
          fadeTime: { type: "number", description: "Fade-in seconds (default 0.1)." },
          weight: { type: "number", description: "Track weight (default 1)." },
          speed: { type: "number", description: "Playback speed (default 1)." },
        },
        required: ["target", "animationId"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local inst = __MCP.resolve(a.target)
if not inst then return { error = "not_found", target = a.target } end
local hum
if inst:IsA("Humanoid") then hum = inst
elseif inst:IsA("Model") then hum = inst:FindFirstChildOfClass("Humanoid")
elseif inst:IsA("Player") then
  local char = inst.Character
  if char then hum = char:FindFirstChildOfClass("Humanoid") end
end
if not hum then return { error = "no_humanoid", target = a.target } end
local animator = hum:FindFirstChildOfClass("Animator")
if not animator then animator = Instance.new("Animator"); animator.Parent = hum end

local animId = tostring(a.animationId or "")
if not string.find(animId, "://") then animId = "rbxassetid://" .. animId end

local anim = Instance.new("Animation")
anim.AnimationId = animId
anim.Parent = animator
local okLoad, track = pcall(function() return animator:LoadAnimation(anim) end)
if not okLoad then return { error = "load_failed", message = tostring(track) } end
track.Looped = a.looped == true
local prio = a.priority and Enum.AnimationPriority[a.priority]
if prio then track.Priority = prio end
track:Play(tonumber(a.fadeTime) or 0.1, tonumber(a.weight) or 1, tonumber(a.speed) or 1)
return { ref = __MCP.refFor(anim), playing = true, length = track.Length, looped = track.Looped }
`,
  ),

  evalTool(
    {
      name: "animation_stop",
      category: "animation",
      subcategories: ["humanoid", "playback"],
      keywords: ["animation", "stop", "cancel", "halt", "freeze"],
      write: true,
      description:
        "Stop all playing animation tracks on a Humanoid's Animator. fadeTime smooths out the stop.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Ref/path: Humanoid, character Model, or Player." },
          fadeTime: { type: "number", description: "Fade-out seconds (default 0.1)." },
        },
        required: ["target"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local inst = __MCP.resolve(a.target)
if not inst then return { error = "not_found" } end
local hum
if inst:IsA("Humanoid") then hum = inst
elseif inst:IsA("Model") then hum = inst:FindFirstChildOfClass("Humanoid")
elseif inst:IsA("Player") then
  local char = inst.Character
  if char then hum = char:FindFirstChildOfClass("Humanoid") end
end
if not hum then return { error = "no_humanoid" } end
local animator = hum:FindFirstChildOfClass("Animator")
if not animator then return { stopped = 0 } end
local fade = tonumber(a.fadeTime) or 0.1
local count = 0
for _, track in ipairs(animator:GetPlayingAnimationTracks()) do
  track:Stop(fade)
  count += 1
end
return { stopped = count }
`,
  ),

  // ====== AUDIO ============================================================
  evalTool(
    {
      name: "sound_play",
      category: "audio",
      subcategories: ["sound", "music", "sfx"],
      keywords: ["sound", "audio", "play", "music", "sfx", "noise", "song"],
      write: true,
      description:
        "Create and play a Sound. Parent to a BasePart for 3D positional audio (auto rolloff), or omit target for ambient (parented to SoundService). One-shot sounds auto-destroy on Ended; set looped=true to keep them around.",
      inputSchema: {
        type: "object",
        properties: {
          soundId: { type: "string", description: "Asset ID, e.g. 'rbxassetid://123' or just the number." },
          target: { type: "string", description: "Optional ref/path of a BasePart/Attachment to parent the Sound to. Default: SoundService (ambient)." },
          volume: { type: "number", description: "0..10 (default 1)." },
          looped: { type: "boolean", description: "Loop forever (default false; one-shot)." },
          pitch: { type: "number", description: "PlaybackSpeed (default 1)." },
          rollOffMin: { type: "number", description: "RollOffMinDistance for 3D sounds (default 10)." },
          rollOffMax: { type: "number", description: "RollOffMaxDistance for 3D sounds (default 50)." },
        },
        required: ["soundId"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
${beginUndo("Cubes MCP: sound_play")}
local sound = Instance.new("Sound")
local id = tostring(a.soundId or "")
if not string.find(id, "://") then id = "rbxassetid://" .. id end
sound.SoundId = id
sound.Volume = tonumber(a.volume) or 1
sound.Looped = a.looped == true
sound.PlaybackSpeed = tonumber(a.pitch) or 1
sound.RollOffMinDistance = tonumber(a.rollOffMin) or 10
sound.RollOffMaxDistance = tonumber(a.rollOffMax) or 50
local parent
if a.target then parent = __MCP.resolve(a.target) end
if not parent then parent = game:GetService("SoundService") end
sound.Parent = parent
if not sound.Looped then
  sound.Ended:Connect(function() sound:Destroy() end)
end
sound:Play()
${endUndo}
return { ref = __MCP.refFor(sound), parent = parent:GetFullName(), playing = true, soundId = id }
`,
  ),

  // ====== EFFECTS ==========================================================
  evalTool(
    {
      name: "tween_run",
      category: "animation",
      subcategories: ["tween", "interpolate", "animate"],
      keywords: ["tween", "interpolate", "lerp", "animate", "ease", "transition", "smooth"],
      write: true,
      description:
        "TweenService:Create + :Play. Fire-and-forget — tween runs to completion in-engine. Number-array values get coerced to Vector3/Color3/UDim2 by the target prop's existing type.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Ref/path of the instance to tween." },
          props: { type: "object", description: "Property → target value. Numbers stay numbers; arrays auto-coerce to the prop's type." },
          duration: { type: "number", description: "Seconds (default 0.5)." },
          easingStyle: { type: "string", enum: ["Linear", "Sine", "Back", "Quad", "Quart", "Quint", "Bounce", "Elastic", "Exponential", "Circular", "Cubic"], description: "EasingStyle (default Quad)." },
          easingDirection: { type: "string", enum: ["In", "Out", "InOut"], description: "EasingDirection (default Out)." },
          repeatCount: { type: "number", description: "Negative = infinite. Default 0." },
          reverses: { type: "boolean", description: "Reverse after each cycle (default false)." },
          delayTime: { type: "number", description: "Delay before tween starts (default 0)." },
        },
        required: ["target", "props"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local inst = __MCP.resolve(a.target)
if not inst then return { error = "not_found", target = a.target } end
local TweenService = game:GetService("TweenService")
local style = a.easingStyle and Enum.EasingStyle[a.easingStyle] or Enum.EasingStyle.Quad
local dir = a.easingDirection and Enum.EasingDirection[a.easingDirection] or Enum.EasingDirection.Out
local info = TweenInfo.new(
  tonumber(a.duration) or 0.5, style, dir,
  tonumber(a.repeatCount) or 0,
  a.reverses == true,
  tonumber(a.delayTime) or 0
)
-- Coerce table values into the appropriate type based on the property's
-- current type. Catches the common cases without the agent needing to wrap
-- values in explicit type tags.
local function coerce(propName, val)
  local ok, current = pcall(function() return inst[propName] end)
  if not ok then return val end
  local t = typeof(current)
  if type(val) == "table" then
    if t == "Vector3" and #val == 3 then
      return Vector3.new(val[1], val[2], val[3])
    elseif t == "Color3" and #val == 3 then
      if math.max(val[1], val[2], val[3]) > 1 then return Color3.fromRGB(val[1], val[2], val[3]) end
      return Color3.new(val[1], val[2], val[3])
    elseif t == "UDim2" and #val == 4 then
      return UDim2.new(val[1], val[2], val[3], val[4])
    elseif t == "UDim" and #val == 2 then
      return UDim.new(val[1], val[2])
    end
  end
  return val
end
local goal = {}
for k, v in pairs(a.props or {}) do goal[k] = coerce(k, v) end
local ok, tween = pcall(function() return TweenService:Create(inst, info, goal) end)
if not ok then return { error = "tween_create_failed", message = tostring(tween) } end
tween:Play()
return { ref = __MCP.refFor(tween), duration = info.Time, properties = (function() local n = {} for k in pairs(goal) do n[#n+1] = k end return n end)() }
`,
  ),

  evalTool(
    {
      name: "particle_emitter_add",
      category: "instances",
      subcategories: ["effects", "particles", "vfx"],
      keywords: ["particle", "particles", "emitter", "vfx", "effect", "sparkle", "smoke", "fire", "magic"],
      write: true,
      description:
        "Add a ParticleEmitter to a BasePart or Attachment. Tune rate/lifetime/speed/size/color/texture; for most effects a couple of params are enough. Returns the emitter ref so you can later set Enabled=false or destroy.",
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
          texture: { type: "string", description: "Texture asset ID (optional — default white sparkle)." },
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
      write: true,
      description:
        "Connect two BaseParts with a Beam. Creates Attachments on each part (with optional local offsets) and a Beam between them. Set width, color, transparency, segments, and an optional scrolling texture.",
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

  // ====== PHYSICS ==========================================================
  evalTool(
    {
      name: "collision_group_setup",
      category: "physics",
      subcategories: ["collision", "groups", "rules"],
      keywords: ["collision", "collide", "group", "physicsservice", "pet", "projectile", "ignore"],
      write: true,
      description:
        "Define collision groups and assign parts to them. Use to make pets not push the player, projectiles not collide with the shooter, etc. `groups` registers new groups + their collide-with rules; `assignments` puts parts/models into a group.",
      inputSchema: {
        type: "object",
        properties: {
          groups: {
            type: "array",
            description: "Groups to register (idempotent). Each entry can specify which other groups it collides with or not.",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                collidesWith: { type: "array", items: { type: "string" }, description: "Group names this one DOES collide with." },
                notCollidesWith: { type: "array", items: { type: "string" }, description: "Group names this one does NOT collide with." },
              },
              required: ["name"],
            },
          },
          assignments: {
            type: "array",
            description: "Assign instances to groups. For Models, all descendant BaseParts are assigned.",
            items: {
              type: "object",
              properties: {
                target: { type: "string", description: "Ref/path." },
                group: { type: "string", description: "Group name." },
              },
              required: ["target", "group"],
            },
          },
        },
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local PS = game:GetService("PhysicsService")
${beginUndo("Cubes MCP: collision_group_setup")}
local registered, ruleCount, assigned = {}, 0, 0
for _, g in ipairs(a.groups or {}) do
  pcall(function() PS:RegisterCollisionGroup(g.name) end)
  registered[#registered + 1] = g.name
  if g.collidesWith then
    for _, other in ipairs(g.collidesWith) do
      pcall(function() PS:CollisionGroupSetCollidable(g.name, other, true); ruleCount += 1 end)
    end
  end
  if g.notCollidesWith then
    for _, other in ipairs(g.notCollidesWith) do
      pcall(function() PS:CollisionGroupSetCollidable(g.name, other, false); ruleCount += 1 end)
    end
  end
end
for _, x in ipairs(a.assignments or {}) do
  local inst = __MCP.resolve(x.target)
  if inst then
    if inst:IsA("BasePart") then
      inst.CollisionGroup = x.group
      assigned += 1
    elseif inst:IsA("Model") then
      for _, d in ipairs(inst:GetDescendants()) do
        if d:IsA("BasePart") then d.CollisionGroup = x.group; assigned += 1 end
      end
    end
  end
end
${endUndo}
return { registered = registered, rules = ruleCount, partsAssigned = assigned }
`,
  ),

  evalTool(
    {
      name: "constraint_add",
      category: "physics",
      subcategories: ["constraint", "joints", "rigging"],
      keywords: ["constraint", "hinge", "spring", "rope", "align", "weld", "joint", "physics"],
      write: true,
      description:
        "Add a Constraint between two BaseParts. Type is any constraint class: HingeConstraint, SpringConstraint, RopeConstraint, AlignPosition, AlignOrientation, RodConstraint, etc. Creates the Attachments and sets Attachment0/1 automatically. Extra props pass through to the constraint.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "Constraint class name (HingeConstraint, SpringConstraint, AlignPosition, AlignOrientation, RopeConstraint, RodConstraint)." },
          part0: { type: "string", description: "Ref/path of part0 (Attachment0 host)." },
          part1: { type: "string", description: "Ref/path of part1 (Attachment1 host). Optional for one-sided constraints like AlignPosition with a world target." },
          offset0: { type: "array", items: { type: "number" }, description: "Local [x,y,z] offset of Attachment0." },
          offset1: { type: "array", items: { type: "number" }, description: "Local [x,y,z] offset of Attachment1." },
          props: { type: "object", description: "Extra props to set on the constraint (Stiffness, Damping, Length, Restitution, MaxForce, ...)." },
        },
        required: ["type", "part0"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local p0 = __MCP.resolve(a.part0)
if not p0 or not p0:IsA("BasePart") then return { error = "not_found", target = a.part0 } end
local p1 = a.part1 and __MCP.resolve(a.part1) or nil
${beginUndo("Cubes MCP: constraint_add")}
local at0 = Instance.new("Attachment")
if type(a.offset0) == "table" then at0.Position = Vector3.new(a.offset0[1] or 0, a.offset0[2] or 0, a.offset0[3] or 0) end
at0.Parent = p0
local at1
if p1 and p1:IsA("BasePart") then
  at1 = Instance.new("Attachment")
  if type(a.offset1) == "table" then at1.Position = Vector3.new(a.offset1[1] or 0, a.offset1[2] or 0, a.offset1[3] or 0) end
  at1.Parent = p1
end
local okCreate, c = pcall(function() return Instance.new(a.type) end)
if not okCreate or not c then ${cancelUndo} return { error = "bad_type", type = a.type } end
c.Attachment0 = at0
if at1 then c.Attachment1 = at1 end
if a.props then
  for k, v in pairs(a.props) do pcall(function() c[k] = v end) end
end
c.Parent = p0
${endUndo}
return { ref = __MCP.refFor(c), type = a.type, attachments = at1 and { __MCP.refFor(at0), __MCP.refFor(at1) } or { __MCP.refFor(at0) } }
`,
  ),

  // ====== WORLD / GAME =====================================================
  evalTool(
    {
      name: "workspace_configure",
      category: "instances",
      subcategories: ["world", "game", "settings"],
      keywords: ["workspace", "gravity", "fall", "settings", "walkspeed", "jumppower", "zoom", "streaming"],
      write: true,
      description:
        "Configure world-level game settings: Workspace.Gravity, FallenPartsDestroyHeight, StreamingEnabled, plus StarterPlayer defaults (WalkSpeed, JumpPower, JumpHeight, MaxZoomDistance). Set only the fields you want to change.",
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

  evalTool(
    {
      name: "sky_configure",
      category: "lighting",
      subcategories: ["sky", "atmosphere", "environment"],
      keywords: ["sky", "skybox", "clouds", "atmosphere", "sun", "moon", "stars", "weather"],
      write: true,
      description:
        "Configure the sky and clouds: skybox face textures, sun/moon size, star count, cloud cover + density + color. Creates Lighting.Sky and workspace.Terrain.Clouds if missing. Pass only the fields you want to change.",
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
  local terrain = workspace.Terrain
  local clouds = terrain:FindFirstChildOfClass("Clouds")
  if not clouds then clouds = Instance.new("Clouds"); clouds.Parent = terrain end
  if a.clouds.cover then clouds.Cover = a.clouds.cover; applied[#applied + 1] = "Clouds.Cover" end
  if a.clouds.density then clouds.Density = a.clouds.density; applied[#applied + 1] = "Clouds.Density" end
  local cc = __parseColor(a.clouds.color)
  if cc then clouds.Color = cc; applied[#applied + 1] = "Clouds.Color" end
end
${endUndo}
return { applied = applied }
`,
  ),
];
