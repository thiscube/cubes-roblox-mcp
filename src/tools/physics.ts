import { type ToolEntry, evalTool, luaJson } from "../registry.js";
import { beginUndo, cancelUndo, endUndo } from "./_luau-helpers.js";

/**
 * Collision groups and constraints.
 *
 * One file per Category value — the registry's own taxonomy names the file,
 * so there is never a question of where a new tool goes (A6).
 */

export const PHYSICS_TOOLS: ToolEntry[] = [
  evalTool(
    {
      name: "collision_group_setup",
      category: "physics",
      subcategories: ["collision", "groups", "rules"],
      keywords: ["collision", "collide", "group", "physicsservice", "pet", "projectile", "ignore"],
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
      description:
        "Add a Constraint between two BaseParts. Type is any constraint class (HingeConstraint, SpringConstraint, AlignPosition, RodConstraint...). Creates the Attachments and wires Attachment0/1. Extra props pass through.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "Any constraint class: HingeConstraint, SpringConstraint, RopeConstraint, RodConstraint, AlignPosition, AlignOrientation." },
          part0: { type: "string", description: "Ref/path of part0 (Attachment0 host)." },
          part1: { type: "string", description: "Ref/path of part1. Optional for one-sided constraints with a world target." },
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
local okWire, wireErr = pcall(function()
  c.Attachment0 = at0
  if at1 then c.Attachment1 = at1 end
  if a.props then
    for k, v in pairs(a.props) do pcall(function() c[k] = v end) end
  end
  c.Parent = p0
end)
if not okWire then
  pcall(function() c:Destroy() end)
  ${cancelUndo}
  return { error = "constraint_wire_failed", type = a.type, message = tostring(wireErr) }
end
${endUndo}
return { ref = __MCP.refFor(c), type = a.type, attachments = at1 and { __MCP.refFor(at0), __MCP.refFor(at1) } or { __MCP.refFor(at0) } }
`,
  ),
];
