--!nonstrict
-- Vision-grounded scene.
--
-- Rather than ship raw pixels, this returns the camera state plus every BasePart
-- currently on screen with a projected 2D bounding box and depth. A vision model
-- can then say "the thing at (375, 250)" and the agent resolves it to a ref.

local Workspace = game:GetService("Workspace")

local Refs = require(script.Parent.Refs)

local Viewport = {}

local MAX_SCAN = 6000 -- cap projection work on huge places
local MAX_RESULTS = 40

-- the 8 corners of a unit box, scaled per-call
local CORNER_SIGNS = {
	{ 1, 1, 1 },
	{ 1, 1, -1 },
	{ 1, -1, 1 },
	{ 1, -1, -1 },
	{ -1, 1, 1 },
	{ -1, 1, -1 },
	{ -1, -1, 1 },
	{ -1, -1, -1 },
}

function Viewport.capture(limit)
	limit = tonumber(limit) or MAX_RESULTS
	local camera = Workspace.CurrentCamera
	if not camera then
		return { error = "no_camera", hint = "Workspace.CurrentCamera is nil." }
	end

	local viewportSize = camera.ViewportSize
	local cullX = viewportSize.X * 2
	local cullY = viewportSize.Y * 2
	local oversampleTarget = limit * 3
	local found = {}
	local scanned = 0

	for _, inst in ipairs(Workspace:GetDescendants()) do
		if inst:IsA("BasePart") then
			if scanned >= MAX_SCAN then
				break
			end
			scanned += 1
			-- Phase 1 (cheap): project center only; reject if behind camera or far off-screen.
			local center = camera:WorldToViewportPoint(inst.Position)
			if center.Z > 0 and math.abs(center.X) <= cullX and math.abs(center.Y) <= cullY then
				-- Phase 2 (full): project the 8 bounding-box corners for an accurate 2D bbox
				local cf, size = inst.CFrame, inst.Size
				local hx, hy, hz = size.X / 2, size.Y / 2, size.Z / 2
				local minX, minY = math.huge, math.huge
				local maxX, maxY = -math.huge, -math.huge
				for _, sign in ipairs(CORNER_SIGNS) do
					local world = cf:PointToWorldSpace(Vector3.new(sign[1] * hx, sign[2] * hy, sign[3] * hz))
					local sp = camera:WorldToViewportPoint(world)
					minX = math.min(minX, sp.X)
					maxX = math.max(maxX, sp.X)
					minY = math.min(minY, sp.Y)
					maxY = math.max(maxY, sp.Y)
				end
				found[#found + 1] = {
					ref = Refs.refFor(inst),
					path = inst:GetFullName(),
					class = inst.ClassName,
					depth = math.floor(center.Z * 10) / 10,
					bbox = { math.floor(minX), math.floor(minY), math.floor(maxX), math.floor(maxY) },
				}
				-- Phase 3 (early exit): comfortable oversample for sorting.
				if #found >= oversampleTarget then
					break
				end
			end
		end
	end

	table.sort(found, function(a, b)
		return a.depth < b.depth
	end)

	local instances = {}
	for i = 1, math.min(limit, #found) do
		instances[i] = found[i]
	end

	return {
		camera = {
			position = tostring(camera.CFrame.Position),
			lookVector = tostring(camera.CFrame.LookVector),
			fieldOfView = camera.FieldOfView,
			viewportSize = { math.floor(viewportSize.X), math.floor(viewportSize.Y) },
		},
		instances = instances,
		visibleCount = #found,
		scanned = scanned,
		note = "bbox is [x1,y1,x2,y2] in viewport pixels; instances are sorted closest-first by depth.",
	}
end

return Viewport
