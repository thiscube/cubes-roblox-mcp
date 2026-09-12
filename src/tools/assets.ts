import { type ToolEntry, evalTool, localTool, luaJson } from "../registry.js";
import { objectResult } from "../output-schema.js";
import {
  ASSET_TYPES,
  assetDetails,
  assetThumbnails,
  openCloudKey,
  searchAssets,
  uploadAsset,
} from "../assets.js";
import { beginUndo, cancelUndo, endUndo } from "./_luau-helpers.js";

/**
 * Creator Store assets (PLAN.md #7).
 *
 * "Put a tree here" used to be impossible unless the agent already knew an asset
 * id, and it never does. Search and details are public endpoints and need no
 * credentials; only uploading needs an Open Cloud key.
 *
 * One file per Category value — the registry's own taxonomy names the file,
 * so there is never a question of where a new tool goes (A6).
 */

const TYPE_NAMES = Object.keys(ASSET_TYPES);

function assetError(err: unknown): Record<string, unknown> {
  const message = err instanceof Error ? err.message : String(err);
  return {
    error: "asset_lookup_failed",
    message,
    hint: message.includes("OFFLINE")
      ? "CUBES_MCP_OFFLINE=1 blocks asset lookup. Unset it, or insert by id if you know one."
      : "Roblox's asset endpoints are public but rate-limited. Retry, or narrow the query.",
  };
}

export const ASSETS_TOOLS: ToolEntry[] = [
  localTool(
    {
      name: "asset_search",
      category: "assets",
      subcategories: ["marketplace", "library", "find"],
      keywords: ["asset", "search", "find", "model", "tree", "marketplace", "toolbox", "library", "free", "store"],
      description:
        "Search the Creator Store for models, decals, audio and meshes. Returns id, creator, triangle count, votes and whether it ships scripts, so you can pick before inserting. No API key needed.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for, e.g. 'oak tree'." },
          assetType: { type: "string", enum: TYPE_NAMES, description: "Default 'model'." },
          limit: { type: "number", description: "Results (default 10, max 30)." },
          cursor: { type: "string", description: "Next-page cursor from a prior search." },
        },
        required: ["query"],
      },
      outputSchema: objectResult({
        assets: { type: "array" },
        total: { type: "number" },
        cursor: { type: "string" },
      }),
    },
    async (args) => {
      try {
        const res = await searchAssets({
          query: String(args.query ?? ""),
          assetType: args.assetType,
          limit: args.limit,
          cursor: args.cursor,
        });
        return {
          ...res,
          ...(res.assets.length > 0
            ? { hint: "Insert one with asset_insert({ assetId }). Scripts are stripped on the way in." }
            : { hint: "Nothing matched. Try fewer words, or a different assetType." }),
        };
      } catch (err) {
        return assetError(err);
      }
    },
  ),

  localTool(
    {
      name: "asset_details",
      category: "assets",
      subcategories: ["marketplace", "inspect"],
      keywords: ["asset", "details", "info", "thumbnail", "preview", "creator", "triangles", "scripts", "check"],
      description:
        "Look up known asset ids: name, creator, triangle count, vote ratio, and whether the asset contains scripts. Optionally returns thumbnail URLs. Use before inserting something you did not search for.",
      inputSchema: {
        type: "object",
        properties: {
          assetIds: {
            type: "array",
            items: { type: "number" },
            description: "Asset ids to look up.",
          },
          thumbnails: { type: "boolean", description: "Also return thumbnail URLs." },
        },
        required: ["assetIds"],
      },
      outputSchema: objectResult({ assets: { type: "array" }, thumbnails: { type: "array" } }),
    },
    async (args) => {
      const ids = (Array.isArray(args.assetIds) ? args.assetIds : [])
        .map((n: unknown) => Number(n))
        .filter((n: number) => Number.isFinite(n) && n > 0)
        .slice(0, 50);
      if (ids.length === 0) return { error: "bad_args", hint: "assetIds must be a non-empty array of numbers." };
      try {
        const assets = await assetDetails(ids);
        const missing = ids.filter((id: number) => !assets.some((a) => a.id === id));
        return {
          assets,
          ...(args.thumbnails === true ? { thumbnails: await assetThumbnails(ids) } : {}),
          ...(missing.length > 0 ? { not_found: missing } : {}),
        };
      } catch (err) {
        return assetError(err);
      }
    },
  ),

  evalTool(
    {
      name: "asset_insert",
      category: "assets",
      subcategories: ["marketplace", "build", "place"],
      keywords: ["asset", "insert", "load", "place", "spawn", "add", "model", "import", "tree", "prop"],
      description:
        "Insert a Creator Store asset into the place by id. Scripts and PackageLinks are stripped BEFORE it is parented, and the strip is verified; a failure destroys the model rather than parenting it. One undo waypoint.",
      inputSchema: {
        type: "object",
        properties: {
          assetId: { type: "number", description: "Asset id, e.g. from asset_search." },
          parent: { type: "string", description: "Ref or path to parent under. Default Workspace." },
          position: {
            type: "array",
            items: { type: "number" },
            description: "World [x,y,z] to pivot to. Default: leave where it loads.",
          },
          name: { type: "string", description: "Rename the inserted instance." },
        },
        required: ["assetId"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local id = tonumber(a.assetId)
if not id or id <= 0 then return { error = "bad_args", hint = "assetId must be a positive number" } end

local parent = workspace
if a.parent then
  local resolved = __MCP.resolve(a.parent)
  if not resolved then return { error = "not_found", target = a.parent } end
  parent = resolved
end

local okLoad, container = pcall(function()
  return game:GetService("InsertService"):LoadAsset(id)
end)
if not okLoad or not container then
  return { error = "load_failed", assetId = id, message = tostring(container), hint = "The asset may be private, deleted, or not a model." }
end

-- Strip BEFORE parenting. An asset's scripts must never be live in the place,
-- not even for the moment between parenting and cleanup.
local stripped = {}
for _, d in ipairs(container:GetDescendants()) do
  if d:IsA("LuaSourceContainer") or d:IsA("PackageLink") then
    table.insert(stripped, d.ClassName .. " " .. d.Name)
    pcall(function() d:Destroy() end)
  end
end

-- Verify. A pcall'd Destroy that silently failed would otherwise ship a live
-- script into the place under a "stripped" label.
for _, d in ipairs(container:GetDescendants()) do
  if d:IsA("LuaSourceContainer") or d:IsA("PackageLink") then
    pcall(function() container:Destroy() end)
    return { error = "strip_failed", assetId = id, survived = d.ClassName .. " " .. d.Name, hint = "Nothing was inserted." }
  end
end

local children = container:GetChildren()
if #children == 0 then
  pcall(function() container:Destroy() end)
  return { error = "empty_asset", assetId = id }
end

${beginUndo("Cubes MCP: asset_insert")}
local inserted, err = nil, nil
local ok = pcall(function()
  for _, child in ipairs(children) do
    child.Parent = parent
    inserted = inserted or child
  end
  if inserted and a.name then inserted.Name = a.name end
  if inserted and type(a.position) == "table" and inserted:IsA("PVInstance") then
    local p = a.position
    inserted:PivotTo(CFrame.new(p[1] or 0, p[2] or 0, p[3] or 0))
  end
end)
if not ok then ${cancelUndo} pcall(function() container:Destroy() end) return { error = "insert_failed", message = tostring(err) } end
${endUndo}
pcall(function() container:Destroy() end)

return {
  ok = true,
  assetId = id,
  inserted = inserted and __MCP.refFor(inserted) or nil,
  path = inserted and inserted:GetFullName() or nil,
  count = #children,
  stripped = stripped,
}
`,
  ),

  localTool(
    {
      name: "asset_upload",
      category: "assets",
      subcategories: ["marketplace", "publish"],
      keywords: ["asset", "upload", "publish", "opencloud", "create", "share"],
      description:
        "Publish a local file to the user's Roblox account via Open Cloud. Needs CUBES_MCP_OPEN_CLOUD_KEY and confirm: true — this leaves the machine and cannot be undone, so it is gated separately from the Studio write toggle.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Local file to upload." },
          assetType: { type: "string", enum: ["Model", "Decal", "Audio"], description: "Asset type." },
          name: { type: "string", description: "Display name." },
          description: { type: "string", description: "Asset description." },
          userId: { type: "string", description: "Owning user id. One of userId or groupId." },
          groupId: { type: "string", description: "Owning group id." },
          confirm: { type: "boolean", description: "Required. Uploading is public and permanent." },
        },
        required: ["filePath", "assetType", "name"],
      },
      outputSchema: objectResult({ operationId: { type: "string" }, path: { type: "string" } }),
    },
    async (args, ctx) => {
      if (!openCloudKey()) {
        return {
          error: "no_open_cloud_key",
          hint: "Set CUBES_MCP_OPEN_CLOUD_KEY to an Open Cloud API key with asset write scope.",
        };
      }
      // The Studio write toggle is about the open place. This publishes to the
      // user's Roblox account, where nothing can be undone, so it gets its own
      // gate — and asks the human directly when the client can be asked.
      if (args.confirm !== true) {
        const approved = await ctx.confirmWithUser?.(
          `Upload "${args.name}" to Roblox as a ${args.assetType}?`,
          [
            `File: ${args.filePath}`,
            "This publishes to the Roblox account behind your Open Cloud key.",
            "It is public and cannot be deleted by this tool.",
          ],
        );
        if (approved !== true) {
          return {
            error: approved === false ? "declined_by_user" : "needs_confirmation",
            hint: "Uploading is permanent and public. Retry with confirm: true once the user has agreed.",
            retry_with: { ...args, confirm: true },
          };
        }
      }
      try {
        const result = await uploadAsset({
          filePath: String(args.filePath),
          assetType: args.assetType,
          name: String(args.name),
          description: String(args.description ?? ""),
          userId: args.userId,
          groupId: args.groupId,
        });
        return { ok: true, ...result };
      } catch (err) {
        return { error: "upload_failed", message: err instanceof Error ? err.message : String(err) };
      }
    },
  ),
];
