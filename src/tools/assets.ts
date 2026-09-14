import { type ToolEntry, commandTool, evalTool, localTool, luaJson, readTool } from "../registry.js";
import { objectResult } from "../output-schema.js";
import {
  ASSET_TYPES,
  UPLOAD_ASSET_TYPES,
  type UploadAssetType,
  assetDetails,
  assetThumbnails,
  openCloudKey,
  resolveUploadPath,
  searchAssets,
  uploadAsset,
} from "../assets.js";
import { beginUndo, cancelUndo, endUndo } from "./_luau-helpers.js";
import {
  type MeshData,
  meshBounds,
  meshFormatOf,
  readMeshFile,
  resolveMeshReadPath,
  resolveMeshWritePath,
  writeMeshFile,
} from "../mesh.js";

/** EditableMesh refuses meshes much past this; say so before sending megabytes. */
const MAX_IMPORT_VERTICES = 60000;

function pathError(err: unknown, hint: string): Record<string, unknown> {
  return { error: "path_not_allowed", message: err instanceof Error ? err.message : String(err), hint };
}

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
      effects: { network: "read" },
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
      effects: { network: "read" },
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
local inserted = nil
local positionedCount = 0
-- "local ok = pcall(...)" discarded the error, so every insert_failed reported
-- message = "nil" — the one field that exists to explain the failure.
local ok, err = pcall(function()
  for _, child in ipairs(children) do
    child.Parent = parent
    inserted = inserted or child
  end
  if inserted and a.name then inserted.Name = a.name end
  -- Position EVERY child, not just the first. A multi-child asset used to land
  -- with one piece where you asked for it and the rest wherever they loaded,
  -- while the count cheerfully reported them all as inserted.
  if type(a.position) == "table" then
    local p = a.position
    local target = CFrame.new(p[1] or 0, p[2] or 0, p[3] or 0)
    local anchor = nil
    for _, child in ipairs(children) do
      if child:IsA("PVInstance") then
        positionedCount += 1
        if not anchor then
          anchor = child:GetPivot()
          child:PivotTo(target)
        else
          -- Keep the asset's internal layout: move each piece by the same
          -- offset the first one moved, rather than stacking them all on one point.
          child:PivotTo(target * anchor:ToObjectSpace(child:GetPivot()))
        end
      end
    end
  end
end)
if not ok then ${cancelUndo} pcall(function() container:Destroy() end) return { error = "insert_failed", message = tostring(err) } end
${endUndo}
pcall(function() container:Destroy() end)

-- "inserted" is the first child of any class; "positioned" counts the ones that
-- could actually be moved. With a Folder+Part asset those differ, and
-- reporting only the first made the response read as if they were the same.
return {
  ok = true,
  assetId = id,
  inserted = inserted and __MCP.refFor(inserted) or nil,
  path = inserted and inserted:GetFullName() or nil,
  positioned = positionedCount,
  count = #children,
  stripped = stripped,
}
`,
  ),

  localTool(
    {
      name: "asset_upload",
      // The one tool that sends the user's bytes somewhere they cannot be
      // recalled. That is what keeps it out of the read-only build; being
      // "local" never said anything about where the effect lands.
      effects: { network: "write" },
      category: "assets",
      subcategories: ["marketplace", "publish"],
      keywords: ["asset", "upload", "publish", "opencloud", "create", "share"],
      description:
        "Publish a project file to the user's Roblox account via Open Cloud. Models take .fbx/.glb, so a Blender export goes straight up. Needs CUBES_MCP_OPEN_CLOUD_KEY. Files outside the project are refused; the user is asked. Cannot be undone.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "File to upload. Must be inside the project directory." },
          assetType: {
            type: "string",
            enum: UPLOAD_ASSET_TYPES,
            description:
              "Model (.fbx .gltf .glb .rbxm), Decal/Image (.png .jpg .bmp .tga), Audio (.mp3 .ogg .wav .flac), Animation (.rbxm).",
          },
          name: { type: "string", description: "Display name." },
          description: { type: "string", description: "Asset description." },
          userId: { type: "string", description: "Owning user id. One of userId or groupId." },
          groupId: { type: "string", description: "Owning group id." },
          confirm: { type: "boolean", description: "Only honoured when the client cannot show a prompt." },
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
      // Confine the path BEFORE asking anyone anything, so a refusal names the
      // real problem instead of prompting the human about a file that was never
      // going to be allowed.
      let resolved: string;
      try {
        resolved = resolveUploadPath(
          String(args.filePath ?? ""),
          undefined,
          args.assetType as UploadAssetType | undefined,
        );
      } catch (err) {
        return {
          error: "path_not_allowed",
          message: err instanceof Error ? err.message : String(err),
          hint: "Only files inside the project directory can be uploaded.",
        };
      }

      // Ask the human EVERY time the client can be asked. `confirm: true` does
      // not skip it: the model supplies that field, so treating it as consent
      // makes the gate a suggestion to an LLM — the exact thing this project
      // criticises the competition for. It is honoured only as the fallback for
      // a client that cannot show a prompt at all.
      const approved = await ctx.confirmWithUser?.(
        `Upload "${args.name}" to Roblox as a ${args.assetType}?`,
        [
          `File: ${resolved}`,
          "This publishes to the Roblox account behind your Open Cloud key.",
          "It is public and cannot be deleted by this tool.",
        ],
      );
      if (approved === false) {
        return {
          error: "declined_by_user",
          hint: "The user declined this upload. Do not retry it without new instructions.",
        };
      }
      if (approved !== true && args.confirm !== true) {
        return {
          error: "needs_confirmation",
          hint: "This client cannot show a prompt. Confirm with the user yourself, then retry with confirm: true.",
          file: resolved,
          retry_with: { ...args, confirm: true },
        };
      }

      try {
        const result = await uploadAsset({
          filePath: resolved,
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

  readTool(
    {
      name: "mesh_export",
      // Reads Studio only, but writes a file: a disk write keeps it out of the
      // read-only build even though the place is never touched.
      effects: { state: true },
      category: "assets",
      subcategories: ["mesh", "export", "file"],
      keywords: ["mesh", "export", "obj", "glb", "gltf", "blender", "bake", "model", "file", "save"],
      description:
        "Bake a Model or parts into one .obj or .glb in the project, colours kept. Unions and unreadable meshes are skipped and listed.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Ref/path of a Model, Folder or part." },
          path: { type: "string", description: "Project-relative .obj or .glb." },
          overwrite: { type: "boolean" },
        },
        required: ["target", "path"],
      },
      outputSchema: objectResult(),
    },
    "mesh_bake",
    async (args, ctx) => {
      let out: string;
      try {
        out = await resolveMeshWritePath(String(args.path ?? ""), { overwrite: args.overwrite === true });
      } catch (err) {
        return pathError(err, "Write to a .obj or .glb under the project directory; pass overwrite: true to replace.");
      }
      const baked = (await ctx.bridge.send("mesh_bake", { target: args.target }, 90_000)) as MeshData & {
        name?: string;
        vertexCount?: number;
        triangleCount?: number;
        partsConverted?: number;
        skipped?: unknown[];
        center?: number[];
        size?: number[];
      };
      if (!baked?.positions?.length || !baked?.indices?.length) {
        return { error: "nothing_to_export", message: "Nothing in the target could be turned into triangles.", skipped: baked?.skipped ?? [] };
      }
      const bytes = await writeMeshFile(out, baked, String(baked.name ?? "mesh"));
      return {
        path: out,
        format: meshFormatOf(out),
        vertices: baked.positions.length / 3,
        triangles: baked.indices.length / 3,
        bytes,
        partsConverted: baked.partsConverted,
        skipped: baked.skipped ?? [],
        // Where the mesh's centre was, so mesh_import can put it back exactly there.
        center: baked.center,
        size: baked.size,
      };
    },
  ),

  commandTool(
    {
      name: "mesh_import",
      category: "assets",
      subcategories: ["mesh", "import", "file"],
      keywords: ["mesh", "import", "obj", "glb", "gltf", "blender", "load", "meshpart", "file"],
      description:
        "Load a project .obj or .glb into Studio as one MeshPart, colours kept. Session-only: to keep it, asset_upload the .glb.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative .obj or .glb." },
          name: { type: "string" },
          parent: { type: "string", description: "Ref/path (default Workspace)." },
          position: { type: "array", items: { type: "number" }, description: "World [x,y,z] (default: ahead of camera)." },
          scale: { type: "number", description: "Vertex multiplier (default 1)." },
        },
        required: ["path"],
      },
      outputSchema: objectResult(),
    },
    "mesh_build",
    async (args, ctx) => {
      let file: string;
      try {
        file = await resolveMeshReadPath(String(args.path ?? ""));
      } catch (err) {
        return pathError(err, "Import a .obj or .glb that is inside the project directory.");
      }
      let mesh: MeshData;
      try {
        mesh = await readMeshFile(file);
      } catch (err) {
        return { error: "mesh_unreadable", message: err instanceof Error ? err.message : String(err), file };
      }
      const vertices = mesh.positions.length / 3;
      if (vertices > MAX_IMPORT_VERTICES) {
        return {
          error: "mesh_too_large",
          vertices,
          limit: MAX_IMPORT_VERTICES,
          hint: "Decimate it first (Blender: Decimate modifier), or upload the .glb with asset_upload and insert the asset.",
        };
      }
      const scale = typeof args.scale === "number" && Number.isFinite(args.scale) && args.scale > 0 ? args.scale : 1;
      // Centre the geometry: a MeshPart's origin is its bounding-box centre.
      const { min, max } = meshBounds(mesh);
      const mid = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      const positions = mesh.positions.map((x, i) => Math.round((x - mid[i % 3]) * scale * 10000) / 10000);
      const name = typeof args.name === "string" && args.name ? args.name : (file.split(/[\\/]/).pop() ?? "mesh").replace(/\.[^.]+$/, "");
      const built = (await ctx.bridge.send(
        "mesh_build",
        {
          positions,
          normals: mesh.normals,
          colors: mesh.colors,
          indices: mesh.indices,
          name,
          parent: args.parent,
          position: args.position,
        },
        90_000,
      )) as Record<string, unknown>;
      return {
        ...built,
        file,
        note: "This MeshPart is not saved with the place. To keep it, export or reuse a .glb, upload it with asset_upload, then insert the asset.",
      };
    },
  ),
];
