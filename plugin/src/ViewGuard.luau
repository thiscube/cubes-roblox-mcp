--!nonstrict
-- Your view is yours: whatever the MCP does to it is put back when Claude is done.
--
-- "View" is everything about how you look at and move around the place, never
-- the place itself: the camera (position, focus, field of view, type, subject,
-- which camera is current), the selection, Studio's camera control settings,
-- and the mouse lock. Edits to instances are Claude's work and stay.
--
-- Two jobs:
--
-- 1. Straight after every command, undo anything that would leave the edit
--    camera unusable: a changed CameraType (usually Scriptable, which Studio's
--    navigation gives way to), CameraSubject or CurrentCamera, or a NaN CFrame
--    or Focus. Until this existed the only fix was deleting Workspace.Camera.
--    placement() also refuses a camera_set that would do that before it runs.
--
-- 2. Remember what each command changed, and when Claude finishes (no command
--    for Config.IDLE_AFTER seconds, the moment the bar says Idle) or the bridge
--    disconnects, put every changed thing back as it was before the first
--    change. Anything you have changed yourself since is left alone: only a
--    value still exactly as the MCP left it is reverted.

local Workspace = game:GetService("Workspace")
local RunService = game:GetService("RunService")
local Selection = game:GetService("Selection")
local UserInputService = game:GetService("UserInputService")
local TweenService = game:GetService("TweenService")

local ViewGuard = {}

-- ---- numbers -------------------------------------------------------------

local function finiteNumber(n)
	return type(n) == "number" and n == n and n ~= math.huge and n ~= -math.huge
end

function ViewGuard.finite(cf)
	for _, n in { cf:GetComponents() } do
		if not finiteNumber(n) then return false end
	end
	return true
end

-- A Vector3 from a JSON {x, y, z}, or nil when any part is not a finite number.
function ViewGuard.vec(t)
	if type(t) ~= "table" then return nil end
	local x, y, z = tonumber(t[1] or 0), tonumber(t[2] or 0), tonumber(t[3] or 0)
	if not (finiteNumber(x) and finiteNumber(y) and finiteNumber(z)) then return nil end
	return Vector3.new(x, y, z)
end

-- ---- camera_set validation -------------------------------------------------

-- The CFrame camera_set should apply.
-- Returns (goal, appliedNames) on success, (nil, {}) when the args move nothing,
-- and (nil, nil, reason) when applying them would break the camera.
function ViewGuard.placement(camera, args)
	local cf = camera.CFrame

	if type(args.cframe) == "table" and #args.cframe >= 12 then
		local c = {}
		for i = 1, 12 do
			local n = tonumber(args.cframe[i])
			if not finiteNumber(n) then return nil, nil, "cframe needs 12 finite numbers" end
			c[i] = n
		end
		local goal = CFrame.new(table.unpack(c)):Orthonormalize()
		if not ViewGuard.finite(goal) then return nil, nil, "cframe has no valid rotation" end
		return goal, { "cframe" }
	end

	local p = args.position ~= nil and ViewGuard.vec(args.position) or nil
	local l = args.lookAt ~= nil and ViewGuard.vec(args.lookAt) or nil
	if args.position ~= nil and not p then return nil, nil, "position needs 3 finite numbers" end
	if args.lookAt ~= nil and not l then return nil, nil, "lookAt needs 3 finite numbers" end

	if l then
		local from = p or cf.Position
		if (l - from).Magnitude < 1e-3 then
			return nil, nil, "lookAt is the point the camera stands on, so there is no direction to look"
		end
		local goal = CFrame.lookAt(from, l)
		if not ViewGuard.finite(goal) then return nil, nil, "position and lookAt give no valid rotation" end
		return goal, p and { "position", "lookAt" } or { "lookAt" }
	end
	if p then
		return CFrame.new(p) * (cf - cf.Position), { "position" }
	end
	return nil, {}
end

-- ---- the view, as a list of fields -------------------------------------------

-- Captured values are boxed as { v = value }, because nil and false are real
-- values here (CameraSubject is usually nil, a setting can be false). A field
-- that could not be read at all is NONE.
local NONE = table.freeze({})

local function cam()
	return Workspace.CurrentCamera
end

-- Tolerances, not ==: Studio's camera rotation is not exactly orthonormal, so
-- a unit-vector dot product of the camera with itself comes out near 0.99996.
local function nearCFrame(a, b)
	if typeof(a) ~= "CFrame" or typeof(b) ~= "CFrame" then return a == b end
	return (a.Position - b.Position).Magnitude < 1e-3
		and (a.LookVector - b.LookVector).Magnitude < 1e-3
		and (a.UpVector - b.UpVector).Magnitude < 1e-3
end

local function nearNumber(a, b)
	if type(a) ~= "number" or type(b) ~= "number" then return a == b end
	return math.abs(a - b) < 1e-4
end

local function sameSelection(a, b)
	if type(a) ~= "table" or type(b) ~= "table" then return a == b end
	if #a ~= #b then return false end
	local set = {}
	for _, inst in a do set[inst] = true end
	for _, inst in b do
		if not set[inst] then return false end
	end
	return true
end

local STUDIO_SETTINGS = {
	"Camera Speed",
	"Camera Shift Speed",
	"Camera Mouse Wheel Speed",
	"Camera Zoom to Mouse Position",
}

-- Restored in this order, so the right camera is current before its
-- properties are put back.
local FIELDS = {
	{
		name = "CurrentCamera",
		get = function() return cam() end,
		set = function(v)
			if v and v.Parent then Workspace.CurrentCamera = v end
		end,
	},
	{
		name = "CameraType",
		get = function() return cam().CameraType end,
		set = function(v) cam().CameraType = v end,
	},
	{
		name = "CameraSubject",
		get = function() return cam().CameraSubject end,
		set = function(v)
			if v == nil or v.Parent then cam().CameraSubject = v end
		end,
	},
	{
		name = "CFrame",
		get = function() return cam().CFrame end,
		set = "tween",
		eq = nearCFrame,
	},
	{
		name = "Focus",
		get = function() return cam().Focus end,
		set = function(v) cam().Focus = v end,
		eq = nearCFrame,
	},
	{
		name = "FieldOfView",
		get = function() return cam().FieldOfView end,
		set = "tween",
		eq = nearNumber,
	},
	{
		name = "FieldOfViewMode",
		get = function() return cam().FieldOfViewMode end,
		set = function(v) cam().FieldOfViewMode = v end,
	},
	{
		name = "Selection",
		get = function() return Selection:Get() end,
		set = function(v)
			local alive = {}
			for _, inst in v do
				if inst.Parent then alive[#alive + 1] = inst end
			end
			Selection:Set(alive)
		end,
		eq = sameSelection,
	},
	{
		name = "MouseBehavior",
		get = function() return UserInputService.MouseBehavior end,
		set = function(v) UserInputService.MouseBehavior = v end,
	},
	{
		name = "MouseIconEnabled",
		get = function() return UserInputService.MouseIconEnabled end,
		set = function(v) UserInputService.MouseIconEnabled = v end,
	},
}

for _, setting in STUDIO_SETTINGS do
	table.insert(FIELDS, {
		name = setting,
		get = function() return settings().Studio[setting] end,
		set = function(v) settings().Studio[setting] = v end,
		eq = nearNumber,
	})
end

local function same(field, a, b)
	if a == NONE or b == NONE then return a == b end
	return (field.eq or rawequal)(a.v, b.v)
end

function ViewGuard.capture()
	local out = {}
	for _, field in FIELDS do
		local ok, value = pcall(field.get)
		out[field.name] = ok and { v = value } or NONE
	end
	return out
end

-- (known, value) for one field of a capture.
local function read(snapshot, name)
	local box = snapshot[name]
	if box == nil or box == NONE then return false, nil end
	return true, box.v
end

-- ---- job 1: never leave the camera stuck ----------------------------------------

local function stuckFixes(before)
	local fixed = {}
	local current = cam()
	local hasCamera, beforeCamera = read(before, "CurrentCamera")
	if hasCamera and beforeCamera and current ~= beforeCamera and beforeCamera.Parent then
		Workspace.CurrentCamera = beforeCamera
		current = beforeCamera
		fixed[#fixed + 1] = "CurrentCamera"
	end
	if not current then return fixed end
	local hasType, beforeType = read(before, "CameraType")
	if hasType and current.CameraType ~= beforeType then
		current.CameraType = beforeType
		fixed[#fixed + 1] = "CameraType"
	end
	local hasSubject, beforeSubject = read(before, "CameraSubject")
	if hasSubject and current.CameraSubject ~= beforeSubject then
		current.CameraSubject = beforeSubject
		fixed[#fixed + 1] = "CameraSubject"
	end
	local hasCFrame, beforeCFrame = read(before, "CFrame")
	if hasCFrame and not ViewGuard.finite(current.CFrame) and ViewGuard.finite(beforeCFrame) then
		current.CFrame = beforeCFrame
		fixed[#fixed + 1] = "CFrame"
	end
	local hasFocus, beforeFocus = read(before, "Focus")
	if hasFocus and not ViewGuard.finite(current.Focus) and ViewGuard.finite(beforeFocus) then
		current.Focus = beforeFocus
		fixed[#fixed + 1] = "Focus"
	end
	return fixed
end

-- ---- job 2: put the view back when Claude is done ---------------------------------

-- name -> { original = box before the first change, left = box the MCP left }
local touched = {}

-- Call with the view captured just before a command. Fixes a stuck camera at
-- once, and records what the command changed for revert(). Returns the names
-- of what had to be fixed immediately, or nil. Skipped during a playtest, where
-- game code owns the camera and the session's own camera is thrown away anyway.
function ViewGuard.afterCommand(before)
	if not before or RunService:IsRunning() then return nil end
	local fixed = stuckFixes(before)
	local after = ViewGuard.capture()
	for _, field in FIELDS do
		local b, a = before[field.name], after[field.name]
		if b ~= NONE and a ~= NONE and not same(field, b, a) then
			local entry = touched[field.name]
			if entry then
				entry.left = a
			else
				touched[field.name] = { original = b, left = a }
			end
		end
	end
	return #fixed > 0 and fixed or nil
end

function ViewGuard.hasChanges()
	return next(touched) ~= nil
end

local RETURN = TweenInfo.new(0.55, Enum.EasingStyle.Quint, Enum.EasingDirection.Out)

-- Put back everything the MCP changed that is still as it left it. Returns the
-- names of what was put back.
function ViewGuard.revert()
	if RunService:IsRunning() then return {} end
	local now = ViewGuard.capture()
	local reverted = {}
	local tweenGoals = {}
	for _, field in FIELDS do
		local entry = touched[field.name]
		if entry and same(field, now[field.name], entry.left) then
			if field.set == "tween" then
				tweenGoals[field.name] = entry.original.v
			else
				pcall(field.set, entry.original.v)
			end
			reverted[#reverted + 1] = field.name
		end
	end
	touched = {}
	local current = cam()
	if current and next(tweenGoals) then
		-- A smooth return rather than a jump, since it lands while you may be looking.
		pcall(function()
			TweenService:Create(current, RETURN, tweenGoals):Play()
		end)
	end
	return reverted
end

-- On plugin load: un-stick a camera that is already broken, so reloading the
-- plugin fixes it without deleting Workspace.Camera.
function ViewGuard.heal()
	if RunService:IsRunning() then return nil end
	local current = cam()
	if not current then return nil end
	local fixed = {}
	if current.CameraType == Enum.CameraType.Scriptable then
		current.CameraType = Enum.CameraType.Fixed
		fixed[#fixed + 1] = "CameraType"
	end
	if not ViewGuard.finite(current.CFrame) then
		current.CFrame = CFrame.lookAt(Vector3.new(0, 20, 30), Vector3.zero)
		fixed[#fixed + 1] = "CFrame"
	end
	if not ViewGuard.finite(current.Focus) then
		current.Focus = CFrame.new(Vector3.zero)
		fixed[#fixed + 1] = "Focus"
	end
	return #fixed > 0 and fixed or nil
end

return ViewGuard
