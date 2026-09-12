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

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
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

/**
 * The real network, with the offline guard on IT rather than on the caller.
 *
 * The guard used to sit in `getJson`, above the seam, which meant a test that
 * had installed a stub still got refused — so the whole asset suite failed under
 * the `CUBES_MCP_OFFLINE=1` that CI sets. Offline is about not reaching the real
 * network; a stub is not the network.
 */
const realFetch: FetchLike = (url, init) => {
  if (process.env.CUBES_MCP_OFFLINE === "1") {
    return Promise.reject(new Error("CUBES_MCP_OFFLINE=1: refusing to reach Roblox for asset data."));
  }
  return fetch(url, init);
};

let fetchImpl: FetchLike = realFetch;

export function __setAssetFetchForTest(impl: FetchLike | null): void {
  fetchImpl = impl ?? realFetch;
}

async function getJson(url: string, init: RequestInit = {}): Promise<any> {
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
 * What Open Cloud accepts, per asset type.
 *
 * Sourced from the "supported asset types and limits" table in Roblox's Assets
 * API guide, not from guesswork. Two types on that table are deliberately absent
 * here:
 *
 * - **Mesh.** There is no file to send. Roblox accepts mesh content only from
 *   its own asset delivery API, so a mesh reaches a place inside a Model upload
 *   (.fbx / .glb), which the engine splits into MeshParts. "Upload a mesh" is
 *   "upload a Model" and there is nothing else to expose.
 * - **Video.** Roblox allows 3.75 GB, and this code path reads the whole file
 *   into memory before posting it. Supporting that would mean streaming uploads
 *   for the one asset type almost nobody publishes from an agent, so the cap
 *   below is the honest boundary rather than a silent 20 MB failure.
 *
 * The per-type byte caps are ours, not Roblox's: a model can legitimately be
 * tens of megabytes, an image or a sound effect cannot, and the cap is the last
 * thing standing between `readFile` and whatever the model decided to point at.
 */
export const UPLOAD_FORMATS = {
  Model: { exts: [".fbx", ".gltf", ".glb", ".rbxm", ".rbxmx"], maxBytes: 100 * 1024 * 1024 },
  Animation: { exts: [".rbxm", ".rbxmx"], maxBytes: 20 * 1024 * 1024 },
  Decal: { exts: [".png", ".jpg", ".jpeg", ".bmp", ".tga"], maxBytes: 20 * 1024 * 1024 },
  Image: { exts: [".png", ".jpg", ".jpeg", ".bmp", ".tga"], maxBytes: 20 * 1024 * 1024 },
  Audio: { exts: [".mp3", ".ogg", ".wav", ".flac"], maxBytes: 20 * 1024 * 1024 },
} as const satisfies Record<string, { exts: readonly string[]; maxBytes: number }>;

export type UploadAssetType = keyof typeof UPLOAD_FORMATS;

export const UPLOAD_ASSET_TYPES = Object.keys(UPLOAD_FORMATS) as UploadAssetType[];

/**
 * The media type Open Cloud expects in the form part. Sending the bytes without
 * one worked for .rbxm by luck and is not something to rely on for .fbx or .glb.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".fbx": "model/fbx",
  ".gltf": "model/gltf+json",
  ".glb": "model/gltf-binary",
  ".rbxm": "model/x-rbxm",
  ".rbxmx": "model/x-rbxm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".bmp": "image/bmp",
  ".tga": "image/tga",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
};

/** Every extension any type accepts. The floor when no type is declared. */
const UPLOAD_EXTENSIONS = new Set<string>(Object.values(UPLOAD_FORMATS).flatMap((f) => [...f.exts]));

/**
 * Biggest file we will read for a type we were not told about. Types that
 * legitimately run larger raise it through `UPLOAD_FORMATS`.
 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Where an upload may read from. `CUBES_MCP_UPLOAD_ROOT`, else the working
 * directory.
 *
 * The working directory is chosen by whoever launched the server, not by this
 * code, so it is a default rather than a guarantee. A root of `/`, or a bare
 * home directory, confines nothing — those are refused outright rather than
 * providing the appearance of a boundary.
 */
export function uploadRoot(): string {
  const configured = process.env.CUBES_MCP_UPLOAD_ROOT;
  const base = resolve(configured && configured.trim() ? configured : process.cwd());
  const parts = base.split(sep).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(
      "The upload root is the filesystem root, which confines nothing. " +
        "Set CUBES_MCP_UPLOAD_ROOT to your project directory.",
    );
  }
  if (base === homedir()) {
    throw new Error(
      `The upload root is your home directory (${base}), which confines nothing. ` +
        "Set CUBES_MCP_UPLOAD_ROOT to the project you are working in.",
    );
  }
  return base;
}

/**
 * Confine an upload to that root.
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
 *
 * The path is resolved through `realpathSync` first. `resolve()` alone collapses
 * `..` but knows nothing about symlinks, so a `model.rbxm` inside the project
 * pointing at `/etc/passwd` would have walked straight through.
 */
export function resolveUploadPath(filePath: string, root?: string, assetType?: UploadAssetType): string {
  const base = root ? resolve(root) : uploadRoot();
  const requested = String(filePath ?? "");
  if (requested.includes("\0")) throw new Error("Refusing a path containing a null byte.");

  const full = resolve(base, requested);
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    throw new Error(`Refusing to upload ${full}: no such file.`);
  }
  // Resolve the root too: on macOS the working directory is often reached
  // through /tmp -> /private/tmp, and comparing one resolved path against one
  // unresolved one rejects perfectly legitimate files.
  let realBase: string;
  try {
    realBase = realpathSync(base);
  } catch {
    realBase = base;
  }

  if (real !== realBase && !real.startsWith(realBase + sep)) {
    throw new Error(
      `Refusing to upload ${real}: only files under ${realBase} can be uploaded. ` +
        `Copy it into the project first if that is really what you meant.`,
    );
  }
  // When the caller declared a type, the allowlist is that type's, not the union.
  // A .png sent as a Model is refused here rather than by Roblox after the bytes
  // have already left the machine, and it keeps the widened type list from
  // widening what any single upload will read.
  const allowed: ReadonlySet<string> = assetType
    ? new Set<string>(UPLOAD_FORMATS[assetType].exts)
    : UPLOAD_EXTENSIONS;
  const ext = extname(real).toLowerCase();
  if (!allowed.has(ext)) {
    throw new Error(
      `Refusing to upload ${ext || "a file with no extension"}` +
        `${assetType ? ` as a ${assetType}` : ""}: expected one of ${[...allowed].join(", ")}.`,
    );
  }
  return real;
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
  assetType: UploadAssetType;
  name: string;
  description: string;
  userId?: string;
  groupId?: string;
}): Promise<any> {
  const key = openCloudKey();
  if (!key) throw new Error("CUBES_MCP_OPEN_CLOUD_KEY is not set; uploading needs an Open Cloud API key.");
  if (!opts.userId && !opts.groupId) throw new Error("Uploading needs a userId or a groupId to own the asset.");

  const format = UPLOAD_FORMATS[opts.assetType];
  if (!format) {
    throw new Error(`Unsupported assetType ${opts.assetType}: expected one of ${UPLOAD_ASSET_TYPES.join(", ")}.`);
  }

  const { readFile, stat } = await import("node:fs/promises");
  const full = resolveUploadPath(opts.filePath, undefined, opts.assetType);
  const info = await stat(full);
  if (!info.isFile()) throw new Error(`${full} is not a file.`);
  // Checked against the file on disk before the read, so an oversized file is
  // never pulled into memory just to be rejected afterwards.
  const limit = format.maxBytes ?? MAX_UPLOAD_BYTES;
  if (info.size > limit) {
    throw new Error(`${full} is ${info.size} bytes; the limit for a ${opts.assetType} is ${limit}.`);
  }
  const contentType = CONTENT_TYPES[extname(full).toLowerCase()];
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
  form.append("fileContent", new Blob([new Uint8Array(bytes)], { type: contentType }), opts.name);

  return getJson(`${OPEN_CLOUD_ASSETS}/assets`, {
    method: "POST",
    headers: { "x-api-key": key },
    body: form,
  });
}
