--!nonstrict
-- DataModel snapshot capture.
--
-- Walks a subtree and serializes, per instance, a stable identity (its full
-- dotted path), ClassName, and a projected set of meaningful properties. The
-- server stores the capture and later diffs two of them — see the `snapshot`
-- and `diff` specialist tools. Reuses Serialize so Roblox value types come back
-- in the same JSON-safe envelopes the read path already produces.

local CollectionService = game:GetService("CollectionService")

local Serialize = require(script.Parent.Serialize)

local Snapshot = {}

-- Hard ceiling on instances per capture. A snapshot is meant to cover a
-- subtree the agent actually cares about, not the whole place — past this the
-- capture payload balloons and the diff stops being token-thrifty. Hitting the
-- cap sets `truncated` so the caller knows the picture is partial.
local MAX_INSTANCES = 2000

-- Projected property set per class. Mirrors Read.luau's DEFAULT_PROPS so a
-- snapshot captures the same "meaningful" surface a `read` would show — enough
-- for a diff to be useful without serializing every hidden property.
local PROJECTED_PROPS = {
	BasePart = { "Position", "Size", "Color", "Material", "Anchored", "Transparency", "CanCollide", "Orientation" },
	MeshPart = { "Position", "Size", "Color", "Material", "Anchored", "MeshId", "TextureID" },
	Model = { "PrimaryPart" },
	Folder = {},
	Script = { "Enabled", "RunContext", "Source" },
	LocalScript = { "Enabled", "Source" },
	ModuleScript = { "Source" },
	Lighting = { "Brightness", "ClockTime", "Ambient", "OutdoorAmbient", "FogEnd", "FogStart", "GlobalShadows" },
	PointLight = { "Brightness", "Range", "Color", "Enabled" },
	SpotLight = { "Brightness", "Range", "Angle", "Color", "Enabled" },
	SurfaceLight = { "Brightness", "Range", "Angle", "Color", "Enabled" },
	ParticleEmitter = { "Rate", "Lifetime", "Speed", "Enabled", "Texture" },
	Decal = { "Texture", "Transparency", "Face", "Color3" },
	Texture = { "Texture", "Transparency", "Face" },
	Atmosphere = { "Density", "Offset", "Color", "Haze", "Glare" },
	Sound = { "SoundId", "Volume", "Playing", "Looped", "PlaybackSpeed" },
	BillboardGui = { "Size", "Enabled", "AlwaysOnTop" },
	SurfaceGui = { "Enabled", "Face", "LightInfluence" },
	Frame = { "Size", "Position", "BackgroundColor3", "BackgroundTransparency", "Visible" },
	TextLabel = { "Text", "TextColor3", "Size", "Position", "Visible", "Font" },
	TextButton = { "Text", "TextColor3", "Size", "Position", "Visible", "Font" },
	ImageLabel = { "Image", "Size", "Position", "Visible", "ImageColor3" },
	Humanoid = { "WalkSpeed", "JumpPower", "JumpHeight", "MaxHealth", "Health", "HipHeight" },
}
local GENERIC_PROPS = { "Name" }

local function projectedPropsFor(inst)
	local explicit = PROJECTED_PROPS[inst.ClassName]
	if explicit then
		return explicit
	end
	if inst:IsA("BasePart") then
		return PROJECTED_PROPS.BasePart
	end
	if inst:IsA("LuaSourceContainer") then
		return PROJECTED_PROPS.Script
	end
	if inst:IsA("GuiObject") then
		return PROJECTED_PROPS.Frame
	end
	return GENERIC_PROPS
end

-- Serialize one instance into a snapshot record. The `props` map carries the
-- projected properties, attributes (under `@attr:<name>`) and CollectionService
-- tags (under `@tags`) so the server-side diff can pick up changes to any of
-- them with one flat comparison loop.
local function captureInstance(inst)
	local props = {}
	for _, propName in ipairs(projectedPropsFor(inst)) do
		local value, ok = Serialize.getProp(inst, propName)
		if ok and value ~= nil then
			props[propName] = Serialize.value(value)
		end
	end

	local attrs = inst:GetAttributes()
	for k, v in pairs(attrs) do
		props["@attr:" .. tostring(k)] = Serialize.value(v)
	end

	local tags = CollectionService:GetTags(inst)
	if #tags > 0 then
		table.sort(tags)
		props["@tags"] = table.concat(tags, ",")
	end

	return {
		path = inst:GetFullName(),
		className = inst.ClassName,
		props = props,
	}
end

-- Capture the subtree rooted at `root` (inclusive). Returns a flat array of
-- records ordered root-first, plus a `truncated` flag if MAX_INSTANCES was hit.
function Snapshot.capture(root)
	local records = { captureInstance(root) }
	local truncated = false
	-- GetDescendants is depth-first and stable; the flat list is all the diff
	-- needs since instances are matched by their full dotted path, not order.
	for _, desc in ipairs(root:GetDescendants()) do
		if #records >= MAX_INSTANCES then
			truncated = true
			break
		end
		records[#records + 1] = captureInstance(desc)
	end
	return records, truncated
end

Snapshot.MAX_INSTANCES = MAX_INSTANCES

return Snapshot
