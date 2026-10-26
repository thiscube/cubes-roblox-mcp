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
-- mesh_bake can instead reply with base64 float32/uint32 strings (see packF32).

local AssetService = game:GetService("AssetService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local Refs = require(script.Parent.Refs)
local Serialize = require(script.Parent.Serialize)

local MeshTools = {}

-- Past this the JSON reply would press the bridge's body limit.
local MAX_VERTICES = 150000
local BALL_RINGS, BALL_SEGMENTS = 10, 16
local CYLINDER_SEGMENTS = 20

local function round(n)
	return math.round(n * 10000) / 10000
end

-- Compact wire encoding (args.encoding == "f32b64"): each array becomes one
-- base64 string of float32 (uint32 for indices) little-endian values: a flat
-- 5.33 bytes per value, about 22% smaller than the JSON on a real bake. The 4-decimal rounding still happens first; the
-- server re-rounds after widening, so values match the JSON path exactly for
-- |x| < 1024 (float32's half-ulp is below 0.00005 there).
local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local B64_BYTES = table.create(64)
for i = 1, 64 do
	B64_BYTES[i - 1] = string.byte(B64, i)
end

-- Encoded straight into an output buffer: no per-chunk strings to concat.
local function base64Lua(src: buffer): string
	local len = buffer.len(src)
	local out = buffer.create(((len + 2) // 3) * 4)
	local o = 0
	local full = len - len % 3
	for i = 0, full - 1, 3 do
		local n = bit32.bor(bit32.lshift(buffer.readu8(src, i), 16), bit32.lshift(buffer.readu8(src, i + 1), 8), buffer.readu8(src, i + 2))
		buffer.writeu8(out, o, B64_BYTES[bit32.rshift(n, 18)])
		buffer.writeu8(out, o + 1, B64_BYTES[bit32.band(bit32.rshift(n, 12), 63)])
		buffer.writeu8(out, o + 2, B64_BYTES[bit32.band(bit32.rshift(n, 6), 63)])
		buffer.writeu8(out, o + 3, B64_BYTES[bit32.band(n, 63)])
		o += 4
	end
	local rest = len - full
	if rest > 0 then
		local n = bit32.lshift(buffer.readu8(src, full), 16)
		if rest == 2 then n = bit32.bor(n, bit32.lshift(buffer.readu8(src, full + 1), 8)) end
		buffer.writeu8(out, o, B64_BYTES[bit32.rshift(n, 18)])
		buffer.writeu8(out, o + 1, B64_BYTES[bit32.band(bit32.rshift(n, 12), 63)])
		buffer.writeu8(out, o + 2, if rest == 2 then B64_BYTES[bit32.band(bit32.rshift(n, 6), 63)] else 61)
		buffer.writeu8(out, o + 3, 61)
	end
	return buffer.tostring(out)
end

-- EncodingService:Base64Encode (buffer -> buffer) when this Studio has it.
local function base64(src: buffer): string
	local ok, res = pcall(function()
		return buffer.tostring(game:GetService("EncodingService"):Base64Encode(src))
	end)
	if ok and type(res) == "string" then return res end
	return base64Lua(src)
end

local function packF32(list): string
	local b = buffer.create(#list * 4)
	for i, v in list do
		buffer.writef32(b, (i - 1) * 4, v)
	end
	return base64(b)
end

local function packU32(list): string
	local b = buffer.create(#list * 4)
	for i, v in list do
		buffer.writeu32(b, (i - 1) * 4, v)
	end
	return base64(b)
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
	-- Direct index writes: the arrays reach ~1.35M entries each, and every
	-- table.insert is a call. Colour is per call, so it is rounded once.
	function sink.vertices(points, normals, color)
		local P, N, C = sink.positions, sink.normals, sink.colors
		local cr, cg, cb = round(color.R), round(color.G), round(color.B)
		for i, p in points do
			local m = origin:PointToObjectSpace(p)
			local n = origin:VectorToObjectSpace(normals[i])
			local k = sink.count * 3
			P[k + 1] = round(m.X); P[k + 2] = round(m.Y); P[k + 3] = round(m.Z)
			N[k + 1] = round(n.X); N[k + 2] = round(n.Y); N[k + 3] = round(n.Z)
			C[k + 1] = cr; C[k + 2] = cg; C[k + 3] = cb
			sink.count += 1
		end
	end

	function sink.triangle(i0, i1, i2)
		local I = sink.indices
		local k = #I
		I[k + 1] = i0; I[k + 2] = i1; I[k + 3] = i2
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
	-- pcall the bake so em:Destroy() runs on every path, error or not.
	local okBake, bakeErr = pcall(function()
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
	end)
	em:Destroy()
	if not okBake then
		error(bakeErr, 0)
	end
	return nil
end

local SHAPES = {
	[Enum.PartType.Block] = addBox,
	[Enum.PartType.Ball] = addBall,
	[Enum.PartType.Cylinder] = addCylinder,
	[Enum.PartType.Wedge] = addWedge,
	[Enum.PartType.CornerWedge] = addCornerWedge,
}

-- plugin command mesh_bake: { target, encoding? } -> (true, mesh) | (false, error)
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

	-- The bridge rejects bodies over 8 MB, and finding that out costs a full
	-- encode plus upload. Deliberately a low estimate (position ~8 bytes with
	-- its comma, normal ~7, colour ~6, index ~7) so it only refuses what is
	-- surely over; anything borderline still goes through the 413 path.
	-- The compact form is exact: 4 bytes per value, times 4/3 for base64.
	local compact = args.encoding == "f32b64"
	local estimate = if compact
		then (sink.count * 9 + #sink.indices) * 4 * 4 // 3
		else sink.count * (3 * 8 + 3 * 7 + 3 * 6) + #sink.indices * 7
	if estimate > 8 * 1024 * 1024 then
		return false, {
			code = "result_too_large",
			message = "About " .. math.floor(estimate / 1048576) .. " MB of mesh data (" .. sink.count .. " vertices); the limit is 8 MB. Export a smaller part of it.",
		}
	end

	-- Every field is numbers/strings already: skip Serialize.deep's copy.
	return true, Serialize.jsonSafe({
		name = root.Name,
		encoding = if compact then "f32b64" else nil,
		positions = if compact then packF32(sink.positions) else sink.positions,
		normals = if compact then packF32(sink.normals) else sink.normals,
		colors = if compact then packF32(sink.colors) else sink.colors,
		indices = if compact then packU32(sink.indices) else sink.indices,
		vertexCount = sink.count,
		triangleCount = #sink.indices // 3,
		partsConverted = converted,
		skipped = skipped,
		center = { round(center.X), round(center.Y), round(center.Z) },
		size = { round(extents.X), round(extents.Y), round(extents.Z) },
	})
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
			-- Numeric key at 1e-3 steps for in-range colours (no string per
			-- vertex); anything outside 0..1 keeps the old string key.
			local key
			if r >= 0 and r <= 1 and g >= 0 and g <= 1 and b >= 0 and b <= 1 then
				key = (math.round(r * 1000) * 1001 + math.round(g * 1000)) * 1001 + math.round(b * 1000)
			else
				key = string.format("%.3f,%.3f,%.3f", r, g, b)
			end
			if not colorIds[key] then colorIds[key] = em:AddColor(Color3.new(r, g, b), 1) end
			cids[i + 1] = colorIds[key]
		end
	end

	local triangles = 0
	local addTriangle = em.AddTriangle
	for t = 0, #indices // 3 - 1 do
		local a, b, c = indices[t * 3 + 1] + 1, indices[t * 3 + 2] + 1, indices[t * 3 + 3] + 1
		if vids[a] and vids[b] and vids[c] and a ~= b and b ~= c and a ~= c then
			local okFace, face = pcall(addTriangle, em, vids[a], vids[b], vids[c])
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
	if not recording then
		meshPart:Destroy()
		return false, {
			code = "no_undo_available",
			message = "ChangeHistoryService recording could not start; refusing to add an undoable change without undo",
		}
	end
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
	ChangeHistoryService:FinishRecording(recording, okParent and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel)
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
