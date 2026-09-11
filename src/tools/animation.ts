import { type ToolEntry, evalTool, luaJson } from "../registry.js";

/**
 * Animation playback and tweening.
 *
 * One file per Category value — the registry's own taxonomy names the file,
 * so there is never a question of where a new tool goes (A6).
 */

export const ANIMATION_TOOLS: ToolEntry[] = [
  evalTool(
    {
      name: "animation_play",
      category: "animation",
      subcategories: ["humanoid", "playback"],
      keywords: ["animate", "animation", "play", "humanoid", "track", "walk", "run", "idle", "dance"],
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
  evalTool(
    {
      name: "tween_run",
      category: "animation",
      subcategories: ["tween", "interpolate", "animate"],
      keywords: ["tween", "interpolate", "lerp", "animate", "ease", "transition", "smooth"],
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
];
