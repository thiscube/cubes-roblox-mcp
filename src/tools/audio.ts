import { type ToolEntry, evalTool, luaJson } from "../registry.js";
import { beginUndo, endUndo } from "./_luau-helpers.js";

/**
 * Sound playback.
 *
 * One file per Category value — the registry's own taxonomy names the file,
 * so there is never a question of where a new tool goes (A6).
 */

export const AUDIO_TOOLS: ToolEntry[] = [
  evalTool(
    {
      name: "sound_play",
      category: "audio",
      subcategories: ["sound", "music", "sfx"],
      keywords: ["sound", "audio", "play", "music", "sfx", "noise", "song"],
      description:
        "Create and play a Sound: on a BasePart for 3D audio, or without target for ambient. One-shots destroy themselves when done; looped=true keeps them.",
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
];
