/**
 * Mesh files for `mesh_export` and `mesh_import`: OBJ and GLB, both ways.
 *
 * The plugin speaks one neutral shape (`MeshData`): flat per-vertex arrays and
 * 0-based triangle indices, counter-clockwise front faces, Roblox's axes (Y up,
 * studs). Everything format-specific lives here, in TypeScript, where it can be
 * unit tested without Studio.
 *
 * Why both formats: OBJ is the one every tool opens and a person can read, and
 * GLB is the one Roblox's Open Cloud upload accepts, so `mesh_export` to .glb then
 * `asset_upload` is how an in-session mesh becomes a permanent asset.
 *
 * Colours: OBJ carries them as the common `v x y z r g b` extension, in the same
 * sRGB values Roblox uses. glTF defines COLOR_0 as linear, so GLB converts on the
 * way out and back, which is what makes Blender show the right colours.
 */

import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { uploadRoot } from "./assets.js";

export interface MeshData {
  /** x, y, z per vertex. */
  positions: number[];
  /** x, y, z per vertex; optional. */
  normals?: number[];
  /** r, g, b per vertex in 0..1 sRGB; optional. */
  colors?: number[];
  /** Three 0-based vertex indices per triangle, counter-clockwise from the front. */
  indices: number[];
}

/**
 * Compact wire encoding for mesh_bake replies (`encoding: "f32b64"`): positions,
 * normals and colours as float32 little-endian, indices as uint32 little-endian,
 * each base64-encoded into one string: a flat 16 bytes per vertex per attribute
 * (48 for all three) against ~63 as 4-decimal JSON arrays, and ~22% smaller
 * overall on a 60k-vertex bake. The server asks for it with an arg; an old
 * plugin ignores the arg and replies with arrays, so both forms are accepted.
 */
export const MESH_WIRE_ENCODING = "f32b64";

/** Encode one field as the plugin does (used by tests and size measurements). */
export function encodeMeshField(values: ArrayLike<number>, kind: "f32" | "u32"): string {
  const buf = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    if (kind === "f32") buf.writeFloatLE(values[i], i * 4);
    else buf.writeUInt32LE(values[i], i * 4);
  }
  return buf.toString("base64");
}

/**
 * One wire field back to number[]. Arrays pass through. Floats are re-rounded to
 * 4 decimals, the plugin's JSON rounding, so values match the array path exactly
 * for |x| < 1024 (float32's half-ulp is under 0.00005 there); beyond that the
 * error is float32's own. readFloatLE avoids the alignment trap of a Float32Array
 * view over a pooled Buffer whose byteOffset is not a multiple of 4.
 */
function decodeMeshField(v: unknown, kind: "f32" | "u32", field: string): number[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v as number[];
  if (typeof v !== "string") throw new Error(`mesh field ${field} is neither an array nor a base64 string.`);
  const buf = Buffer.from(v, "base64");
  if (buf.length % 4) throw new Error(`mesh field ${field} is ${buf.length} bytes, not a multiple of 4.`);
  const n = buf.length / 4;
  const out = new Array<number>(n);
  if (kind === "u32") for (let i = 0; i < n; i++) out[i] = buf.readUInt32LE(i * 4);
  else for (let i = 0; i < n; i++) out[i] = Math.round(buf.readFloatLE(i * 4) * 10000) / 10000;
  return out;
}

/** Normalise a mesh_bake reply, in either wire form, to MeshData arrays in place. */
export function decodeMeshWire<T extends Record<string, unknown>>(raw: T): T & MeshData {
  const r = raw as Record<string, unknown>;
  r.positions = decodeMeshField(r.positions, "f32", "positions");
  r.indices = decodeMeshField(r.indices, "u32", "indices");
  for (const f of ["normals", "colors"]) {
    const d = decodeMeshField(r[f], "f32", f);
    if (d) r[f] = d; else delete r[f];
  }
  delete r.encoding;
  return raw as T & MeshData;
}

export type MeshFormat = "obj" | "glb";

export const MESH_FORMATS: readonly MeshFormat[] = ["obj", "glb"];

/** Largest mesh file mesh_import will read. */
export const MAX_MESH_FILE_BYTES = 64 * 1024 * 1024;
/** Parse-time caps, checked before allocating, so a tiny GLB can't expand to gigabytes. */
const MAX_PARSE_VERTICES = 1_000_000;
const MAX_PARSE_INDICES = 3_000_000;
const MAX_NODE_VISITS = 10_000;
const MAX_NODE_DEPTH = 64;

export function meshFormatOf(path: string): MeshFormat | null {
  const ext = extname(path).toLowerCase();
  return ext === ".obj" ? "obj" : ext === ".glb" ? "glb" : null;
}

// ---------------------------------------------------------------------------
// Paths: mesh files live under the same root asset_upload reads from.
// ---------------------------------------------------------------------------

function within(real: string, realBase: string): boolean {
  return real === realBase || real.startsWith(realBase + sep);
}

async function realBaseOf(root?: string): Promise<string> {
  const base = root ? resolve(root) : uploadRoot();
  try {
    return await realpath(base);
  } catch {
    return base;
  }
}

/**
 * Where mesh_export may write. Same root as asset_upload (CUBES_MCP_UPLOAD_ROOT,
 * else the working directory), resolved through the nearest existing parent so
 * a symlinked directory cannot carry the write outside it. Refuses to replace
 * an existing file unless `overwrite`, and never writes through a symlink.
 * Creates no directories; writeMeshFile does, once there is something to write.
 */
export async function resolveMeshWritePath(filePath: string, opts: { overwrite?: boolean; root?: string } = {}): Promise<string> {
  const requested = String(filePath ?? "");
  if (requested.includes("\0")) throw new Error("Refusing a path containing a null byte.");
  if (/:/.test(requested.replace(/^[A-Za-z]:/, ""))) throw new Error("Refusing a path with ':' after the drive (NTFS alternate data stream).");
  if (!meshFormatOf(requested)) throw new Error(`Export to .obj or .glb, not ${extname(requested) || "a file with no extension"}.`);
  const realBase = await realBaseOf(opts.root);
  const full = resolve(realBase, requested);

  let existing = dirname(full);
  for (;;) {
    try {
      await stat(existing);
      break;
    } catch {
      const up = dirname(existing);
      if (up === existing) break;
      existing = up;
    }
  }
  const realParent = await realpath(existing).catch(() => existing);
  const target = resolve(realParent, full.slice(existing.length).replace(/^[\\/]+/, ""));
  if (!within(target, realBase)) {
    throw new Error(`Refusing to write ${target}: mesh files must stay under ${realBase}.`);
  }

  const info = await lstat(target).catch(() => null);
  if (info?.isSymbolicLink()) throw new Error(`Refusing to write through the symlink ${target}.`);
  if (info && !opts.overwrite) throw new Error(`${target} already exists. Pass overwrite: true to replace it.`);
  return target;
}

/** Where mesh_import may read: an existing .obj or .glb under the root. */
export async function resolveMeshReadPath(filePath: string, opts: { root?: string } = {}): Promise<string> {
  const requested = String(filePath ?? "");
  if (requested.includes("\0")) throw new Error("Refusing a path containing a null byte.");
  if (/:/.test(requested.replace(/^[A-Za-z]:/, ""))) throw new Error("Refusing a path with ':' after the drive (NTFS alternate data stream).");
  const realBase = await realBaseOf(opts.root);
  let real: string;
  try {
    real = await realpath(resolve(realBase, requested));
  } catch {
    throw new Error(`No such file: ${resolve(realBase, requested)}`);
  }
  if (!within(real, realBase)) {
    throw new Error(`Refusing to read ${real}: mesh files must be under ${realBase}. Copy it into the project first.`);
  }
  if (!meshFormatOf(real)) throw new Error(`Import a .obj or .glb, not ${extname(real) || "a file with no extension"}.`);
  const size = (await stat(real)).size;
  if (size > MAX_MESH_FILE_BYTES) throw new Error(`${real} is ${size} bytes; the limit is ${MAX_MESH_FILE_BYTES}.`);
  return real;
}

export async function writeMeshFile(path: string, mesh: MeshData, name: string): Promise<number> {
  const data = meshFormatOf(path) === "glb" ? toGlb(mesh, name) : Buffer.from(toObj(mesh, name), "utf8");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  return data.byteLength;
}

export async function readMeshFile(path: string): Promise<MeshData> {
  const buf = await readFile(path);
  return meshFormatOf(path) === "glb" ? parseGlb(buf) : parseObj(buf.toString("utf8"));
}

// ---------------------------------------------------------------------------
// OBJ
// ---------------------------------------------------------------------------

const f4 = (n: number) => {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? "0" : String(r);
};

export function toObj(mesh: MeshData, name: string): string {
  // Lines are joined in blocks so the working set is a few thousand small
  // strings at a time, not one per line for the whole mesh.
  const blocks: string[] = [];
  let lines: string[] = [`# exported by cubes-roblox-mcp`, `o ${name.replace(/\s+/g, "_") || "mesh"}`];
  const push = (line: string) => {
    lines.push(line);
    if (lines.length >= 4096) {
      blocks.push(lines.join("\n"));
      lines = [];
    }
  };
  const p = mesh.positions;
  const col = mesh.colors;
  const nor = mesh.normals;
  const n = p.length / 3;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    let line = `v ${f4(p[o])} ${f4(p[o + 1])} ${f4(p[o + 2])}`;
    if (col) line += ` ${f4(col[o])} ${f4(col[o + 1])} ${f4(col[o + 2])}`;
    push(line);
  }
  if (nor) {
    for (let i = 0; i < n; i++) push(`vn ${f4(nor[i * 3])} ${f4(nor[i * 3 + 1])} ${f4(nor[i * 3 + 2])}`);
  }
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] + 1, b = idx[t + 1] + 1, c = idx[t + 2] + 1;
    push(nor ? `f ${a}//${a} ${b}//${b} ${c}//${c}` : `f ${a} ${b} ${c}`);
  }
  if (lines.length) blocks.push(lines.join("\n"));
  return blocks.join("\n") + "\n";
}

export function parseObj(text: string): MeshData {
  // Flat arrays, three numbers per entry: no per-vertex objects to allocate or collect.
  const v: number[] = [];
  const vc: number[] = []; // NaN in the first slot means "no colour on this v line"
  const vn: number[] = [];
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  // Corner dedup. Almost every OBJ pairs each position with one normal, so the
  // first pairing per position lives in two flat arrays; only a position that
  // turns up with a second normal falls back to the string-keyed map.
  const firstNormal: number[] = [];
  const firstId: number[] = [];
  const seen = new Map<string, number>();
  let anyColor = false;
  const cp: number[] = [];
  const cn: number[] = [];
  const ids: number[] = [];

  const index = (raw: string, count: number) => {
    const i = parseInt(raw, 10);
    return i < 0 ? count + i : i - 1;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const kind = parts[0];
    if (kind === "v") {
      v.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
      const r = Number(parts[4]), g = Number(parts[5]), b = Number(parts[6]);
      if (parts.length >= 7 && Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        vc.push(r, g, b);
        anyColor = true;
      } else {
        vc.push(NaN, 0, 0);
      }
    } else if (kind === "vn") {
      vn.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (kind === "f") {
      const vCount = v.length / 3;
      const nCount = vn.length / 3;
      cp.length = 0;
      cn.length = 0;
      let bad = false;
      for (let k = 1; k < parts.length; k++) {
        const tok = parts[k];
        const s1 = tok.indexOf("/");
        const pi = index(s1 < 0 ? tok : tok.slice(0, s1), vCount);
        let ni = -1;
        if (s1 >= 0) {
          const s2 = tok.indexOf("/", s1 + 1);
          if (s2 >= 0) {
            const s3 = tok.indexOf("/", s2 + 1);
            const nraw = tok.slice(s2 + 1, s3 < 0 ? undefined : s3);
            if (nraw) ni = index(nraw, nCount);
          }
        }
        if (!(pi >= 0 && pi < vCount)) bad = true;
        cp.push(pi);
        cn.push(ni);
      }
      if (cp.length < 3 || bad) continue;
      const a = cp[0] * 3, b = cp[1] * 3, c = cp[2] * 3;
      const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
      const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
      const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
      const len = Math.hypot(fx, fy, fz) || 1;
      ids.length = 0;
      for (let k = 0; k < cp.length; k++) {
        const pIdx = cp[k], nIdx = cn[k];
        const hasNormal = nIdx >= 0 && nIdx < nCount;
        // Corners without a normal get the face's flat one, so they cannot be shared.
        let id: number | undefined;
        let key: string | null = null;
        if (hasNormal) {
          if (firstNormal[pIdx] === nIdx) id = firstId[pIdx];
          else if (firstNormal[pIdx] !== undefined) id = seen.get((key = `${pIdx}/${nIdx}`));
        }
        if (id === undefined) {
          id = positions.length / 3;
          if (hasNormal) {
            if (key === null) {
              firstNormal[pIdx] = nIdx;
              firstId[pIdx] = id;
            } else seen.set(key, id);
          }
          const o = pIdx * 3;
          positions.push(v[o], v[o + 1], v[o + 2]);
          if (hasNormal) normals.push(vn[nIdx * 3], vn[nIdx * 3 + 1], vn[nIdx * 3 + 2]);
          else normals.push(fx / len, fy / len, fz / len);
          if (Number.isNaN(vc[o])) colors.push(1, 1, 1);
          else colors.push(vc[o], vc[o + 1], vc[o + 2]);
        }
        ids.push(id);
      }
      for (let k = 1; k < ids.length - 1; k++) indices.push(ids[0], ids[k], ids[k + 1]);
    }
  }
  if (indices.length === 0) throw new Error("The OBJ has no faces.");
  return { positions, normals, colors: anyColor ? colors : undefined, indices };
}

// ---------------------------------------------------------------------------
// GLB (binary glTF 2.0)
// ---------------------------------------------------------------------------

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const clamp01 = (c: number) => Math.min(1, Math.max(0, c));

const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

export function toGlb(mesh: MeshData, name: string): Buffer {
  const count = mesh.positions.length / 3;
  const chunks: Buffer[] = [];
  const bufferViews: any[] = [];
  const accessors: any[] = [];
  let offset = 0;

  const add = (data: Buffer, target: number, accessor: Record<string, unknown>) => {
    const pad = (4 - (data.byteLength % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength, target });
    accessors.push({ bufferView: bufferViews.length - 1, ...accessor });
    chunks.push(data, Buffer.alloc(pad));
    offset += data.byteLength + pad;
    return accessors.length - 1;
  };
  const floats = (arr: number[]) => Buffer.from(new Float32Array(arr).buffer);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      const x = Math.fround(mesh.positions[i * 3 + k]);
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  }

  const attributes: Record<string, number> = {};
  attributes.POSITION = add(floats(mesh.positions), ARRAY_BUFFER, { componentType: FLOAT, count, type: "VEC3", min, max });
  if (mesh.normals) attributes.NORMAL = add(floats(mesh.normals), ARRAY_BUFFER, { componentType: FLOAT, count, type: "VEC3" });
  if (mesh.colors) {
    const lin = new Float32Array(mesh.colors.length);
    for (let i = 0; i < lin.length; i++) lin[i] = toLinear(clamp01(mesh.colors[i]));
    attributes.COLOR_0 = add(Buffer.from(lin.buffer), ARRAY_BUFFER, {
      componentType: FLOAT,
      count,
      type: "VEC3",
    });
  }
  const indices = add(Buffer.from(new Uint32Array(mesh.indices).buffer), ELEMENT_ARRAY_BUFFER, {
    componentType: UNSIGNED_INT,
    count: mesh.indices.length,
    type: "SCALAR",
  });

  const json = {
    asset: { version: "2.0", generator: "cubes-roblox-mcp" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: [{ attributes, indices, material: 0, mode: 4 }] }],
    materials: [{ name, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };

  let jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.byteLength % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  const total = 12 + 8 + jsonBuf.byteLength + 8 + offset;
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(jsonBuf.byteLength, 0);
  jsonHead.writeUInt32LE(0x4e4f534a, 4);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(offset, 0);
  binHead.writeUInt32LE(0x004e4942, 4);
  // One copy straight into the output, not a BIN chunk built and then copied again.
  return Buffer.concat([header, jsonHead, jsonBuf, binHead, ...chunks], total);
}

type Mat4 = number[];
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major 4x4 multiply, as glTF stores matrices. */
function mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

function nodeMatrix(node: any): Mat4 {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const r = [
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw), 0,
    2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw), 0,
    2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy), 0,
    0, 0, 0, 1,
  ];
  const s = [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1];
  const t = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1];
  return mul(t, mul(r, s));
}

export function parseGlb(buf: Buffer): MeshData {
  if (buf.byteLength < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error("Not a GLB file (bad magic).");
  let json: any = null;
  let bin: Buffer | null = null;
  for (let at = 12; at + 8 <= buf.byteLength; ) {
    const len = buf.readUInt32LE(at);
    const type = buf.readUInt32LE(at + 4);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString("utf8"));
    else if (type === 0x004e4942) bin = body;
    at += 8 + len;
  }
  if (!json) throw new Error("The GLB has no JSON chunk.");

  const readAccessor = (i: number): { data: Float64Array; size: number } => {
    const acc = json.accessors[i];
    const view = json.bufferViews[acc.bufferView];
    if (!bin || view.buffer !== 0) throw new Error("Only self-contained GLB files are supported (no external buffers).");
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type as string] ?? 1;
    const bytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType as number];
    if (!bytes) throw new Error(`Unsupported accessor component type ${acc.componentType}.`);
    const elem = size * bytes;
    const stride = view.byteStride ?? elem;
    if (!Number.isInteger(stride) || stride < elem) throw new Error(`Accessor ${i} has byteStride ${view.byteStride}, smaller than its element (${elem} bytes).`);
    const count = acc.count;
    if (!Number.isInteger(count) || count < 0) throw new Error(`Accessor ${i} has an invalid count.`);
    const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const viewEnd = (view.byteOffset ?? 0) + (view.byteLength ?? bin.byteLength);
    if (count > 0 && (start < 0 || viewEnd > bin.byteLength || start + (count - 1) * stride + elem > viewEnd)) {
      throw new Error(`Accessor ${i} (${count} x ${stride} bytes) runs past the end of its buffer.`);
    }
    const norm = acc.normalized === true;
    const data = new Float64Array(count * size);
    let w = 0;
    for (let e = 0; e < count; e++) {
      for (let k = 0; k < size; k++) {
        const o = start + e * stride + k * bytes;
        let x: number;
        switch (acc.componentType) {
          case 5126: x = bin.readFloatLE(o); break;
          case 5125: x = bin.readUInt32LE(o); break;
          case 5123: x = bin.readUInt16LE(o); if (norm) x /= 65535; break;
          case 5122: x = bin.readInt16LE(o); if (norm) x = Math.max(x / 32767, -1); break;
          case 5121: x = bin.readUInt8(o); if (norm) x /= 255; break;
          default: x = bin.readInt8(o); if (norm) x = Math.max(x / 127, -1);
        }
        data[w++] = x;
      }
    }
    return { data, size };
  };

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let anyColor = false;

  const emit = (meshIndex: number, m: Mat4) => {
    const mesh = json.meshes?.[meshIndex];
    for (const prim of mesh?.primitives ?? []) {
      if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
      const base = positions.length / 3;
      const posCount = json.accessors[prim.attributes.POSITION]?.count ?? 0;
      if (base + posCount > MAX_PARSE_VERTICES) throw new Error(`The GLB has more than ${MAX_PARSE_VERTICES} vertices.`);
      const idxCount = prim.indices !== undefined ? json.accessors[prim.indices]?.count ?? 0 : posCount;
      if (indices.length + idxCount > MAX_PARSE_INDICES) throw new Error(`The GLB has more than ${MAX_PARSE_INDICES / 3} triangles.`);
      const pos = readAccessor(prim.attributes.POSITION).data;
      const count = pos.length / 3;
      const nor = prim.attributes.NORMAL !== undefined ? readAccessor(prim.attributes.NORMAL).data : null;
      const col = prim.attributes.COLOR_0 !== undefined ? readAccessor(prim.attributes.COLOR_0) : null;
      const factor = json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorFactor;
      const srgb = (c: number) => clamp01(toSrgb(clamp01(c)));
      // A material factor is the same for every vertex: convert it once.
      const fr = Array.isArray(factor) ? srgb(factor[0]) : 1;
      const fg = Array.isArray(factor) ? srgb(factor[1]) : 1;
      const fb = Array.isArray(factor) ? srgb(factor[2]) : 1;
      if (count > 0 && (col || Array.isArray(factor))) anyColor = true;
      for (let i = 0; i < count; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        positions.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
        if (nor) {
          const a = nor[i * 3], b = nor[i * 3 + 1], c = nor[i * 3 + 2];
          const wx = m[0] * a + m[4] * b + m[8] * c, wy = m[1] * a + m[5] * b + m[9] * c, wz = m[2] * a + m[6] * b + m[10] * c;
          const len = Math.hypot(wx, wy, wz) || 1;
          normals.push(wx / len, wy / len, wz / len);
        } else {
          normals.push(0, 1, 0);
        }
        if (col) {
          const o = i * col.size;
          colors.push(srgb(col.data[o]), srgb(col.data[o + 1]), srgb(col.data[o + 2]));
        } else {
          colors.push(fr, fg, fb);
        }
      }
      const idx: ArrayLike<number> = prim.indices !== undefined ? readAccessor(prim.indices).data : Array.from({ length: count }, (_, i) => i);
      for (let t = 0; t < idx.length; t++) indices.push(base + idx[t]);
      if (!nor) {
        // No normals in the file: flat ones from each triangle (shared corners take the last).
        for (let t = 0; t < idx.length; t += 3) {
          const a = (base + idx[t]) * 3, b = (base + idx[t + 1]) * 3, c = (base + idx[t + 2]) * 3;
          const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
          const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
          const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
          const len = Math.hypot(cx, cy, cz) || 1;
          for (const k of [a, b, c]) {
            if (!(k >= 0 && k + 2 < normals.length)) continue; // a bad index must not grow the array
            normals[k] = cx / len;
            normals[k + 1] = cy / len;
            normals[k + 2] = cz / len;
          }
        }
      }
    }
  };

  let visits = 0;
  const onPath = new Set<number>();
  const visit = (nodeIndex: number, parent: Mat4, depth: number) => {
    const node = json.nodes?.[nodeIndex];
    if (!node) return;
    if (onPath.has(nodeIndex)) throw new Error(`The GLB node graph has a cycle at node ${nodeIndex}.`);
    if (++visits > MAX_NODE_VISITS || depth > MAX_NODE_DEPTH) throw new Error(`The GLB node graph is too large (over ${MAX_NODE_VISITS} visits or ${MAX_NODE_DEPTH} deep).`);
    onPath.add(nodeIndex);
    const m = mul(parent, nodeMatrix(node));
    if (node.mesh !== undefined) emit(node.mesh, m);
    for (const child of node.children ?? []) visit(child, m, depth + 1);
    onPath.delete(nodeIndex);
  };

  const scene = json.scenes?.[json.scene ?? 0];
  if (scene?.nodes?.length) for (const n of scene.nodes) visit(n, IDENTITY, 0);
  else for (let i = 0; i < (json.meshes?.length ?? 0); i++) emit(i, IDENTITY);

  if (indices.length === 0) throw new Error("The GLB has no triangle meshes.");
  return { positions, normals, colors: anyColor ? colors : undefined, indices };
}

/** Bounding box of a mesh, for reporting and placement. */
export function meshBounds(mesh: MeshData): { min: number[]; max: number[]; size: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], mesh.positions[i + k]);
      max[k] = Math.max(max[k], mesh.positions[i + k]);
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}
