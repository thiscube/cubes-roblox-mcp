/**
 * Roblox asset lookup (PLAN.md #7).
 *
 * Without this, "put a tree here" is impossible unless the agent already knows
 * an asset id — and it never does. Everything here is read-only HTTP against
 * Roblox's own endpoints, the same ones Studio's Toolbox uses.
 *
 * WHAT NEEDS A KEY AND WHAT DOES NOT
 * ----------------------------------
 * Search, details and thumbnails are public and need no credentials at all.
 * Only uploading does, and that takes an Open Cloud API key from
 * `CUBES_MCP_OPEN_CLOUD_KEY`. Keeping the read path key-free matters: the
 * feature people actually want works the moment they install the server.
 *
 * WHY TWO REQUESTS PER SEARCH
 * ---------------------------
 * The marketplace endpoint returns bare ids — no name, no creator, nothing to
 * choose between them. The details endpoint turns ids into something a model can
 * judge: name, creator, triangle count, and `hasScripts`, which is the one that
 * decides whether inserting it is safe.
 */

import { extname, resolve, sep } from "node:path";

const TOOLBOX = "https://apis.roblox.com/toolbox-service/v1";
const THUMBNAILS = "https://thumbnails.roblox.com/v1";
const OPEN_CLOUD_ASSETS = "https://apis.roblox.com/assets/v1";
const TIMEOUT_MS = 20_000;

/** Asset types worth searching for, by the name a person would use. */
export const ASSET_TYPES: Record<string, number> = {
  model: 10,
  decal: 13,
  audio: 3,
  mesh: 40,
  image: 1,
  video: 62,
  font: 73,
  plugin: 38,
};

export interface AssetSummary {
  id: number;
  name: string;
  type: string;
  creator?: string;
  verifiedCreator?: boolean;
  description?: string;
  /** True when the asset ships scripts. `asset_insert` strips them either way. */
  hasScripts?: boolean;
  triangles?: number;
  upVotePercent?: number;
  voteCount?: number;
  endorsed?: boolean;
  createdUtc?: string;
}

export interface SearchResult {
  assets: AssetSummary[];
  total?: number;
  cursor?: string;
}

/** Test seam: swap the network out without a global mock. */
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (url, init) => fetch(url, init);

export function __setAssetFetchForTest(impl: FetchLike | null): void {
  fetchImpl = impl ?? ((url, init) => fetch(url, init));
}

async function getJson(url: string, init: RequestInit = {}): Promise<any> {
  if (process.env.CUBES_MCP_OFFLINE === "1") {
    throw new Error("CUBES_MCP_OFFLINE=1: refusing to reach Roblox for asset data.");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${new URL(url).host} -> HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const typeName = (id: number): string =>
  Object.entries(ASSET_TYPES).find(([, v]) => v === id)?.[0] ?? String(id);

/** Turn the details endpoint's deep shape into something worth spending tokens on. */
function summarize(entry: any): AssetSummary | null {
  const a = entry?.asset;
  if (!a?.id) return null;
  const tris = a.modelTechnicalDetails?.objectMeshSummary?.triangles;
  return {
    id: a.id,
    name: a.name ?? "",
    type: typeName(a.typeId),
    ...(entry.creator?.name ? { creator: entry.creator.name } : {}),
    ...(entry.creator?.isVerifiedCreator ? { verifiedCreator: true } : {}),
    ...(a.description ? { description: String(a.description).slice(0, 160) } : {}),
    ...(typeof a.hasScripts === "boolean" ? { hasScripts: a.hasScripts } : {}),
    ...(typeof tris === "number" ? { triangles: tris } : {}),
    ...(typeof entry.voting?.upVotePercent === "number"
      ? { upVotePercent: entry.voting.upVotePercent, voteCount: entry.voting.voteCount }
      : {}),
    ...(a.isEndorsed ? { endorsed: true } : {}),
    ...(a.createdUtc ? { createdUtc: a.createdUtc } : {}),
  };
}

/** Details for specific asset ids. */
export async function assetDetails(ids: number[]): Promise<AssetSummary[]> {
  if (ids.length === 0) return [];
  const url = `${TOOLBOX}/items/details?assetIds=${ids.join(",")}`;
  const body = await getJson(url);
  return (body?.data ?? []).map(summarize).filter((a: AssetSummary | null): a is AssetSummary => a !== null);
}

/** Search the Creator Store the way Studio's own Toolbox does. */
export async function searchAssets(opts: {
  query: string;
  assetType?: string;
  limit?: number;
  cursor?: string;
}): Promise<SearchResult> {
  const typeId = ASSET_TYPES[opts.assetType ?? "model"] ?? ASSET_TYPES.model;
  const limit = Math.min(30, Math.max(1, Math.trunc(opts.limit ?? 10)));
  const params = new URLSearchParams({ limit: String(limit), keyword: opts.query });
  if (opts.cursor) params.set("cursor", opts.cursor);

  const page = await getJson(`${TOOLBOX}/marketplace/${typeId}?${params}`);
  const ids = (page?.data ?? []).map((d: any) => d.id).filter((id: unknown) => typeof id === "number");
  if (ids.length === 0) return { assets: [], total: page?.totalResults };

  return {
    assets: await assetDetails(ids),
    total: page?.totalResults,
    ...(page?.nextPageCursor ? { cursor: page.nextPageCursor } : {}),
  };
}

/** Thumbnail URLs for asset ids. Public endpoint, no key. */
export async function assetThumbnails(
  ids: number[],
  size: "150x150" | "420x420" | "700x700" = "420x420",
): Promise<{ id: number; url?: string; state?: string }[]> {
  if (ids.length === 0) return [];
  const url = `${THUMBNAILS}/assets?assetIds=${ids.join(",")}&size=${size}&format=Png`;
  const body = await getJson(url);
  return (body?.data ?? []).map((d: any) => ({
    id: d.targetId,
    ...(d.imageUrl ? { url: d.imageUrl } : {}),
    ...(d.state && d.state !== "Completed" ? { state: d.state } : {}),
  }));
}

/**
 * Biggest file we will read to upload. A model or a decal is kilobytes; a
 * multi-megabyte read is a sign something other than an asset is being sent.
 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Extensions an asset upload can plausibly be. */
const UPLOAD_EXTENSIONS = new Set([".rbxm", ".rbxmx", ".png", ".jpg", ".jpeg", ".bmp", ".tga", ".mp3", ".ogg", ".wav"]);

/**
 * Confine an upload to the working directory.
 *
 * Without this, `asset_upload` is an arbitrary file read plus an exfiltration
 * channel: `filePath` went straight to `readFile` with no validation, so an
 * absolute path to an SSH key was uploaded to Roblox as a "Model" and the tool
 * reported success. Found in verification, reproduced end to end, and reachable
 * from the read-only build, which is the build whose entire promise is that it
 * cannot touch anything.
 *
 * Confinement is the hard boundary here, because every other check in this tool
 * is something the model itself supplies.
 */
export function resolveUploadPath(filePath: string, root = process.cwd()): string {
  const base = resolve(root);
  const full = resolve(base, filePath);
  const inside = full === base || full.startsWith(base + sep);
  if (!inside) {
    throw new Error(
      `Refusing to upload ${full}: only files under ${base} can be uploaded. ` +
        `Copy it into the project first if that is really what you meant.`,
    );
  }
  const ext = extname(full).toLowerCase();
  if (!UPLOAD_EXTENSIONS.has(ext)) {
    throw new Error(
      `Refusing to upload ${ext || "a file with no extension"}: expected one of ${[...UPLOAD_EXTENSIONS].join(", ")}.`,
    );
  }
  return full;
}

export function openCloudKey(): string | undefined {
  const key = process.env.CUBES_MCP_OPEN_CLOUD_KEY;
  return key && key.trim() ? key.trim() : undefined;
}

/**
 * Publish a file to the user's Roblox account through Open Cloud.
 *
 * The one thing here that leaves a mark on the outside world, which is why the
 * tool that calls it has its own confirmation gate rather than riding the Studio
 * write toggle: that toggle is about the open place, and this is about the
 * user's account.
 */
export async function uploadAsset(opts: {
  filePath: string;
  assetType: "Model" | "Decal" | "Audio";
  name: string;
  description: string;
  userId?: string;
  groupId?: string;
}): Promise<any> {
  const key = openCloudKey();
  if (!key) throw new Error("CUBES_MCP_OPEN_CLOUD_KEY is not set; uploading needs an Open Cloud API key.");
  if (!opts.userId && !opts.groupId) throw new Error("Uploading needs a userId or a groupId to own the asset.");

  const { readFile, stat } = await import("node:fs/promises");
  const full = resolveUploadPath(opts.filePath);
  const info = await stat(full);
  if (!info.isFile()) throw new Error(`${full} is not a file.`);
  if (info.size > MAX_UPLOAD_BYTES) {
    throw new Error(`${full} is ${info.size} bytes; the upload limit is ${MAX_UPLOAD_BYTES}.`);
  }
  const bytes = await readFile(full);
  const form = new FormData();
  form.append(
    "request",
    JSON.stringify({
      assetType: opts.assetType,
      displayName: opts.name,
      description: opts.description,
      creationContext: {
        creator: opts.groupId ? { groupId: opts.groupId } : { userId: opts.userId },
      },
    }),
  );
  form.append("fileContent", new Blob([new Uint8Array(bytes)]), opts.name);

  return getJson(`${OPEN_CLOUD_ASSETS}/assets`, {
    method: "POST",
    headers: { "x-api-key": key },
    body: form,
  });
}
