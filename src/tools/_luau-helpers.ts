import { luaJson } from "../registry.js";

/**
 * Luau snippets shared by the generated tools: a ChangeHistoryService recording
 * wrapper and a colour parser. Extracted so every category file can reach them
 * without re-declaring the boilerplate (ARCHITECTURE-REVIEW.md A6).
 */

// Shared preamble snippet that opens a CHS recording, returns it so the
// caller can FinishRecording on success. Avoids re-typing the boilerplate
// in every tool. The CHS wrapper makes every tool here a clean undo point.
export const beginUndo = (label: string) => `
local CHS = game:GetService("ChangeHistoryService")
local __rec = CHS:TryBeginRecording(${luaJson(label)})
`;

export const endUndo = `
if __rec then CHS:FinishRecording(__rec, Enum.FinishRecordingOperation.Commit) end
`;

export const cancelUndo = `
if __rec then CHS:FinishRecording(__rec, Enum.FinishRecordingOperation.Cancel) end
`;

// Helper to parse "r,g,b" or "r, g, b" into Color3. Used by tools that take
// colors as strings (consistent with the rest of the seed tools).
export const parseColorLua = `
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
