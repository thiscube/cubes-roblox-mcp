--!nonstrict
-- Mesh baking and building, behind the mesh_export and mesh_import tools.
--
-- bake  (plugin command mesh_bake, read-only): turn an instance's parts into one
--       triangle mesh. Blocks, Wedges, CornerWedges, Balls, Cylinders and
--       readable MeshParts are converted; anything else is skipped and reported.
-- build (plugin command mesh_build, writes): turn a mesh back into one MeshPart
--       through EditableMesh, in a single undo waypoint.
--
-- The wire format is flat arrays, one entry per vertex: positions {x,y,z,...},
-- normals {x,y,z,...}, colors {r,g,b,...} in 0..1, and indices {a,b,c,...} (0-based)
-- with counter-clockwise front faces. The server turns that into OBJ or GLB.

local AssetService = game:GetService("AssetService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local Refs = require(script.Parent.Refs)

local MeshTools = {}

-- Past this the JSON reply would press the bridge's body limit.
local MAX_VERTICES = 150000
local BALL_RINGS, BALL_SEGMENTS = 10, 16
local CYLINDER_SEGMENTS = 20

local function round(n)
	return math.round(n * 10000) / 10000
end

-- Accumulates one mesh in a space given by `origin` (a CFrame).
local function newSink(origin)
	local sink = { positions = {}, normals = {}, colors = {}, indices = {}, count = 0, origin = origin }

	-- Add one convex polygon (world-space points). Winding is fixed so the face
	-- looks away from `inside`, a point known to be inside the solid.
	function sink.polygon(points, inside, color)
		local a, b, c = points[1], points[2], points[3]
		local normal = (b - a):Cross(c - a)
		local centroid = Vector3.zero
		for _, p in points do centroid += p end
		centroid /= #points
		if normal:Dot(centroid - inside) < 0 then
			local reversed = {}
			for i = #points, 1, -1 do reversed[#reversed + 1] = points[i] end
			points = reversed
			normal = -normal
		end
		if normal.Magnitude < 1e-9 then return end
		sink.vertices(points, table.create(#points, normal.Unit), color)
		local base = sink.count - #points
		for i = 2, #points - 1 do
			table.insert(sink.indices, base)
			table.insert(sink.indices, base + i - 1)
			table.insert(sink.indices, base + i)
		end
	end

	-- Raw world-space vertices with per-vertex world normals.
	function sink.vertices(points, normals, color)
		for i, p in points do
			local m = origin:PointToObjectSpace(p)
			local n = origin:VectorToObjectSpace(normals[i])
			table.insert(sink.positions, round(m.X)); table.insert(sink.positions, round(m.Y)); table.insert(sink.positions, round(m.Z))
			table.insert(sink.normals, round(n.X)); table.insert(sink.normals, round(n.Y)); table.insert(sink.normals, round(n.Z))
			table.insert(sink.colors, round(color.R)); table.insert(sink.colors, round(color.G)); table.insert(sink.colors, round(color.B))
			sink.count += 1
		end
	end

	function sink.triangle(i0, i1, i2)
		table.insert(sink.indices, i0); table.insert(sink.indices, i1); table.insert(sink.indices, i2)
	end

	return sink
end

-- ---- primitives, in part space, emitted in world space ---------------------------

local function corners(cf, h, list)
	local out = {}
	for i, v in list do
		out[i] = cf:PointToWorldSpace(Vector3.new(v[1] * h.X, v[2] * h.Y, v[3] * h.Z))
	end
	return out
end

local function addBox(sink, part)
	local cf, h, color = part.CFrame, part.Size / 2, part.Color
	local P = corners(cf, h, {
		{ -1, -1, -1 }, { 1, -1, -1 }, { 1, -1, 1 }, { -1, -1, 1 },
		{ -1, 1, -1 }, { 1, 1, -1 }, { 1, 1, 1 }, { -1, 1, 1 },
	})
	local c = cf.Position
	for _, f in { { 1, 2, 3, 4 }, { 5, 6, 7, 8 }, { 1, 2, 6, 5 }, { 4, 3, 7, 8 }, { 1, 4, 8, 5 }, { 2, 3, 7, 6 } } do
		sink.polygon({ P[f[1]], P[f[2]], P[f[3]], P[f[4]] }, c, color)
	end
end

-- Measured in Studio: the slope rises toward +Z; the tall face is at +Z.
local function addWedge(sink, part)
	local cf, h, color = part.CFrame, part.Size / 2, part.Color
	local P = corners(cf, h, {
		{ -1, -1, -1 }, { 1, -1, -1 }, { 1, -1, 1 }, { -1, -1, 1 }, { 1, 1, 1 }, { -1, 1, 1 },
	})
	local inside = cf:PointToWorldSpace(Vector3.new(0, -h.Y * 0.5, h.Z * 0.5))
	sink.polygon({ P[1], P[2], P[3], P[4] }, inside, color) -- bottom
	sink.polygon({ P[4], P[3], P[5], P[6] }, inside, color) -- back
	sink.polygon({ P[1], P[4], P[6] }, inside, color) -- left
	sink.polygon({ P[2], P[3], P[5] }, inside, color) -- right
	sink.polygon({ P[1], P[2], P[5], P[6] }, inside, color) -- slope
end

-- Measured in Studio: a pyramid whose apex is above the (+X, -Z) corner.
local function addCornerWedge(sink, part)
	local cf, h, color = part.CFrame, part.Size / 2, part.Color
	local P = corners(cf, h, {
		{ -1, -1, -1 }, { 1, -1, -1 }, { 1, -1, 1 }, { -1, -1, 1 }, { 1, 1, -1 },
	})
	local inside = cf:PointToWorldSpace(Vector3.new(h.X * 0.5, -h.Y * 0.5, -h.Z * 0.5))
	sink.polygon({ P[1], P[2], P[3], P[4] }, inside, color)
	sink.polygon({ P[2], P[3], P[5] }, inside, color)
	sink.polygon({ P[1], P[2], P[5] }, inside, color)
	sink.polygon({ P[1], P[4], P[5] }, inside, color)
	sink.polygon({ P[4], P[3], P[5] }, inside, color)
end

local function addBall(sink, part)
	local cf, color = part.CFrame, part.Color
	local r = math.min(part.Size.X, part.Size.Y, part.Size.Z) / 2
	local base = sink.count
	local points, normals = {}, {}
	for i = 0, BALL_RINGS do
		local theta = math.pi * i / BALL_RINGS
		for j = 0, BALL_SEGMENTS do
			local phi = 2 * math.pi * j / BALL_SEGMENTS
			local dir = Vector3.new(math.sin(theta) * math.cos(phi), math.cos(theta), math.sin(theta) * math.sin(phi))
			points[#points + 1] = cf:PointToWorldSpace(dir * r)
			normals[#normals + 1] = cf:VectorToWorldSpace(dir)
		end
	end
	sink.vertices(points, normals, color)
	local row = BALL_SEGMENTS + 1
	for i = 0, BALL_RINGS - 1 do
		for j = 0, BALL_SEGMENTS - 1 do
			local a, b = base + i * row + j, base + (i + 1) * row + j
			local c, d = a + 1, b + 1
			-- With theta down from the pole and phi around, (a, c, b) and (c, d, b) wind
			-- counter-clockwise from outside; the pole rows drop their degenerate half.
			if i > 0 then sink.triangle(a, c, b) end
			if i < BALL_RINGS - 1 then sink.triangle(c, d, b) end
		end
	end
end

-- Axis along X, like Roblox's cylinder.
local function addCylinder(sink, part)
	local cf, color = part.CFrame, part.Color
	local hx = part.Size.X / 2
	local r = math.min(part.Size.Y, part.Size.Z) / 2
	local ring = {}
	for j = 0, CYLINDER_SEGMENTS - 1 do
		local phi = 2 * math.pi * j / CYLINDER_SEGMENTS
		ring[j + 1] = Vector2.new(math.cos(phi), math.sin(phi))
	end
	local center = cf.Position
	-- Sides: one quad per segment, smooth normals shared along each edge line.
	for j = 1, CYLINDER_SEGMENTS do
		local k = j % CYLINDER_SEGMENTS + 1
		local pts = {
			cf:PointToWorldSpace(Vector3.new(-hx, ring[j].X * r, ring[j].Y * r)),
			cf:PointToWorldSpace(Vector3.new(hx, ring[j].X * r, ring[j].Y * r)),
			cf:PointToWorldSpace(Vector3.new(hx, ring[k].X * r, ring[k].Y * r)),
			cf:PointToWorldSpace(Vector3.new(-hx, ring[k].X * r, ring[k].Y * r)),
		}
		local nj = cf:VectorToWorldSpace(Vector3.new(0, ring[j].X, ring[j].Y))
		local nk = cf:VectorToWorldSpace(Vector3.new(0, ring[k].X, ring[k].Y))
		local base = sink.count
		sink.vertices(pts, { nj, nj, nk, nk }, color)
		-- Wind by the outward normal of the quad.
		local faceNormal = (pts[2] - pts[1]):Cross(pts[3] - pts[1])
		if faceNormal:Dot(nj + nk) >= 0 then
			sink.triangle(base, base + 1, base + 2)
			sink.triangle(base, base + 2, base + 3)
		else
			sink.triangle(base, base + 2, base + 1)
			sink.triangle(base, base + 3, base + 2)
		end
	end
	-- Caps.
	for _, side in { -1, 1 } do
		local pts = {}
		for j = 1, CYLINDER_SEGMENTS do
			pts[j] = cf:PointToWorldSpace(Vector3.new(side * hx, ring[j].X * r, ring[j].Y * r))
		end
		sink.polygon(pts, center, color)
	end
end

-- A MeshPart whose mesh this session may read (your own uploads, Roblox's).
local function addMeshPart(sink, part)
	local ok, em = pcall(function()
		return AssetService:CreateEditableMeshAsync(part.MeshContent)
	end)
	if not ok or not em then
		return "mesh is not readable here (only meshes you own or Roblox's can be opened)"
	end
	local faces = em:GetFaces()
	local lo, hi = Vector3.new(math.huge, math.huge, math.huge), Vector3.new(-math.huge, -math.huge, -math.huge)
	for _, v in em:GetVertices() do
		local p = em:GetPosition(v)
		lo = lo:Min(p); hi = hi:Max(p)
	end
	local meshCenter, meshSize = (lo + hi) / 2, hi - lo
	local scale = Vector3.new(
		meshSize.X > 1e-6 and part.Size.X / meshSize.X or 1,
		meshSize.Y > 1e-6 and part.Size.Y / meshSize.Y or 1,
		meshSize.Z > 1e-6 and part.Size.Z / meshSize.Z or 1
	)
	local cf, color = part.CFrame, part.Color
	for _, face in faces do
		local ids = em:GetFaceVertices(face)
		if #ids == 3 then
			local pts = {}
			for i, id in ids do
				pts[i] = cf:PointToWorldSpace((em:GetPosition(id) - meshCenter) * scale)
			end
			local flat = (pts[2] - pts[1]):Cross(pts[3] - pts[1])
			if flat.Magnitude > 1e-12 then
				local normalIds = em:GetFaceNormals(face)
				local ns = {}
				for i = 1, 3 do
					local n = normalIds[i] and em:GetNormal(normalIds[i])
					-- Non-uniform scale bends normals: n / scale, renormalised.
					ns[i] = n and cf:VectorToWorldSpace((n / scale).Unit) or flat.Unit
				end
				local base = sink.count
				sink.vertices(pts, ns, color)
				sink.triangle(base, base + 1, base + 2)
			end
		end
		if sink.count > MAX_VERTICES then break end
	end
	em:Destroy()
	return nil
end

local SHAPES = {
	[Enum.PartType.Block] = addBox,
	[Enum.PartType.Ball] = addBall,
	[Enum.PartType.Cylinder] = addCylinder,
	[Enum.PartType.Wedge] = addWedge,
	[Enum.PartType.CornerWedge] = addCornerWedge,
}

-- plugin command mesh_bake: { target } -> (true, mesh) | (false, error)
function MeshTools.bake(args)
	local root = Refs.resolve(args.target)
	if not root then
		return false, { code = "not_found", message = "No instance at " .. tostring(args.target) }
	end

	local parts = {}
	if root:IsA("BasePart") then table.insert(parts, root) end
	for _, d in root:GetDescendants() do
		if d:IsA("BasePart") then table.insert(parts, d) end
	end
	if #parts == 0 then
		return false, { code = "no_parts", message = root:GetFullName() .. " has no parts to export." }
	end

	-- Baked in world orientation around a rough origin, then re-centred on the
	-- axis-aligned bounds of the vertices themselves. GetBoundingBox is not used
	-- for this: it follows the model's pivot rotation, so one rotated part made
	-- the reported size wrong.
	local first = parts[1].Position
	local origin = CFrame.new(math.round(first.X), math.round(first.Y), math.round(first.Z))

	local sink = newSink(origin)
	local skipped, converted = {}, 0
	for _, part in parts do
		if part.Transparency >= 1 then
			table.insert(skipped, { path = part:GetFullName(), reason = "fully transparent" })
		elseif part:IsA("MeshPart") then
			local why = addMeshPart(sink, part)
			if why then
				table.insert(skipped, { path = part:GetFullName(), reason = why })
			else
				converted += 1
			end
		elseif part:IsA("WedgePart") then
			addWedge(sink, part); converted += 1
		elseif part:IsA("CornerWedgePart") then
			addCornerWedge(sink, part); converted += 1
		elseif part:IsA("Part") then
			local shape = SHAPES[part.Shape] or addBox
			shape(sink, part); converted += 1
		elseif part:IsA("TrussPart") or part:IsA("SpawnLocation") or part:IsA("Seat") or part:IsA("VehicleSeat") then
			addBox(sink, part); converted += 1
		else
			table.insert(skipped, { path = part:GetFullName(), reason = part.ClassName .. " geometry cannot be read (unions and similar)" })
		end
		if sink.count > MAX_VERTICES then
			return false, { code = "too_large", message = "Over " .. MAX_VERTICES .. " vertices; export a smaller part of it." }
		end
	end

	local lo, hi = Vector3.new(math.huge, math.huge, math.huge), Vector3.new(-math.huge, -math.huge, -math.huge)
	local P = sink.positions
	for i = 1, #P, 3 do
		local v = Vector3.new(P[i], P[i + 1], P[i + 2])
		lo = lo:Min(v); hi = hi:Max(v)
	end
	local mid = (lo + hi) / 2
	for i = 1, #P, 3 do
		P[i] = round(P[i] - mid.X); P[i + 1] = round(P[i + 1] - mid.Y); P[i + 2] = round(P[i + 2] - mid.Z)
	end
	local center = origin.Position + mid
	local extents = hi - lo

	return true, {
		name = root.Name,
		positions = sink.positions,
		normals = sink.normals,
		colors = sink.colors,
		indices = sink.indices,
		vertexCount = sink.count,
		triangleCount = #sink.indices // 3,
		partsConverted = converted,
		skipped = skipped,
		center = { round(center.X), round(center.Y), round(center.Z) },
		size = { round(extents.X), round(extents.Y), round(extents.Z) },
	}
end

-- plugin command mesh_build: { positions, normals?, colors?, indices, name?, parent?, position? }
function MeshTools.build(args)
	local positions, indices = args.positions, args.indices
	if type(positions) ~= "table" or type(indices) ~= "table" or #positions % 3 ~= 0 or #indices % 3 ~= 0 or #indices == 0 then
		return false, { code = "bad_args", message = "positions and indices must be non-empty flat arrays of triples." }
	end
	local vertexCount = #positions // 3
	local normals = type(args.normals) == "table" and #args.normals == #positions and args.normals or nil
	local colors = type(args.colors) == "table" and #args.colors == #positions and args.colors or nil
	local parent = args.parent and Refs.resolve(args.parent) or workspace
	if not parent then
		return false, { code = "not_found", message = "No parent at " .. tostring(args.parent) }
	end

	local okMesh, em = pcall(function() return AssetService:CreateEditableMesh() end)
	if not okMesh then
		return false, { code = "editable_mesh_unavailable", message = tostring(em) }
	end

	local vids, nids, cids, colorIds = table.create(vertexCount), {}, {}, {}
	for i = 0, vertexCount - 1 do
		vids[i + 1] = em:AddVertex(Vector3.new(positions[i * 3 + 1], positions[i * 3 + 2], positions[i * 3 + 3]))
		if normals then
			nids[i + 1] = em:AddNormal(Vector3.new(normals[i * 3 + 1], normals[i * 3 + 2], normals[i * 3 + 3]))
		end
		if colors then
			local r, g, b = colors[i * 3 + 1], colors[i * 3 + 2], colors[i * 3 + 3]
			local key = string.format("%.3f,%.3f,%.3f", r, g, b)
			if not colorIds[key] then colorIds[key] = em:AddColor(Color3.new(r, g, b), 1) end
			cids[i + 1] = colorIds[key]
		end
	end

	local triangles = 0
	for t = 0, #indices // 3 - 1 do
		local a, b, c = indices[t * 3 + 1] + 1, indices[t * 3 + 2] + 1, indices[t * 3 + 3] + 1
		if vids[a] and vids[b] and vids[c] and a ~= b and b ~= c and a ~= c then
			local okFace, face = pcall(function() return em:AddTriangle(vids[a], vids[b], vids[c]) end)
			if okFace then
				if normals then em:SetFaceNormals(face, { nids[a], nids[b], nids[c] }) end
				if colors then em:SetFaceColors(face, { cids[a], cids[b], cids[c] }) end
				triangles += 1
			end
		end
	end

	local okPart, meshPart = pcall(function()
		return AssetService:CreateMeshPartAsync(Content.fromObject(em), { CollisionFidelity = Enum.CollisionFidelity.Box })
	end)
	if not okPart then
		return false, { code = "mesh_part_failed", message = tostring(meshPart) }
	end

	local recording = ChangeHistoryService:TryBeginRecording("Cubes MCP mesh import")
	local okParent, err = pcall(function()
		meshPart.Name = type(args.name) == "string" and args.name ~= "" and args.name or "ImportedMesh"
		meshPart.Anchored = true
		meshPart.Material = Enum.Material.SmoothPlastic
		meshPart.Color = colors and Color3.new(1, 1, 1) or Color3.fromRGB(200, 200, 200)
		local p = args.position
		if type(p) == "table" and #p == 3 then
			meshPart.Position = Vector3.new(p[1], p[2], p[3])
		else
			local cam = workspace.CurrentCamera
			local ahead = cam and (cam.CFrame.Position + cam.CFrame.LookVector * 20) or Vector3.new(0, meshPart.Size.Y / 2, 0)
			meshPart.Position = ahead
		end
		meshPart.Parent = parent
	end)
	if recording then
		ChangeHistoryService:FinishRecording(recording, okParent and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel)
	end
	if not okParent then
		meshPart:Destroy()
		return false, { code = "mesh_part_failed", message = tostring(err) }
	end

	return true, {
		ref = Refs.refFor(meshPart),
		path = meshPart:GetFullName(),
		vertexCount = vertexCount,
		triangleCount = triangles,
		size = { round(meshPart.Size.X), round(meshPart.Size.Y), round(meshPart.Size.Z) },
		persists = false,
	}
end

return MeshTools
