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

export type MeshFormat = "obj" | "glb";

export const MESH_FORMATS: readonly MeshFormat[] = ["obj", "glb"];

/** Largest mesh file mesh_import will read. */
export const MAX_MESH_FILE_BYTES = 64 * 1024 * 1024;

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
 */
export async function resolveMeshWritePath(filePath: string, opts: { overwrite?: boolean; root?: string } = {}): Promise<string> {
  const requested = String(filePath ?? "");
  if (requested.includes("\0")) throw new Error("Refusing a path containing a null byte.");
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
  await mkdir(dirname(target), { recursive: true });
  return target;
}

/** Where mesh_import may read: an existing .obj or .glb under the root. */
export async function resolveMeshReadPath(filePath: string, opts: { root?: string } = {}): Promise<string> {
  const requested = String(filePath ?? "");
  if (requested.includes("\0")) throw new Error("Refusing a path containing a null byte.");
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
  const out: string[] = [`# exported by cubes-roblox-mcp`, `o ${name.replace(/\s+/g, "_") || "mesh"}`];
  const n = mesh.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const p = mesh.positions;
    let line = `v ${f4(p[i * 3])} ${f4(p[i * 3 + 1])} ${f4(p[i * 3 + 2])}`;
    if (mesh.colors) line += ` ${f4(mesh.colors[i * 3])} ${f4(mesh.colors[i * 3 + 1])} ${f4(mesh.colors[i * 3 + 2])}`;
    out.push(line);
  }
  if (mesh.normals) {
    for (let i = 0; i < n; i++) {
      out.push(`vn ${f4(mesh.normals[i * 3])} ${f4(mesh.normals[i * 3 + 1])} ${f4(mesh.normals[i * 3 + 2])}`);
    }
  }
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [mesh.indices[t] + 1, mesh.indices[t + 1] + 1, mesh.indices[t + 2] + 1];
    out.push(mesh.normals ? `f ${a}//${a} ${b}//${b} ${c}//${c}` : `f ${a} ${b} ${c}`);
  }
  return out.join("\n") + "\n";
}

export function parseObj(text: string): MeshData {
  const v: number[][] = [];
  const vc: (number[] | null)[] = [];
  const vn: number[][] = [];
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const seen = new Map<string, number>();
  let anyColor = false;

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
      const nums = parts.slice(1).map(Number);
      v.push([nums[0], nums[1], nums[2]]);
      if (nums.length >= 6 && nums.slice(3, 6).every(Number.isFinite)) {
        vc.push([nums[3], nums[4], nums[5]]);
        anyColor = true;
      } else {
        vc.push(null);
      }
    } else if (kind === "vn") {
      vn.push(parts.slice(1, 4).map(Number));
    } else if (kind === "f") {
      const corners = parts.slice(1).map((tok) => {
        const [pi, , ni] = tok.split("/");
        return { p: index(pi, v.length), n: ni ? index(ni, vn.length) : -1 };
      });
      if (corners.length < 3 || corners.some((c) => !v[c.p])) continue;
      const faceNormal = (() => {
        const [a, b, c] = [v[corners[0].p], v[corners[1].p], v[corners[2].p]];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const cr = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const len = Math.hypot(cr[0], cr[1], cr[2]) || 1;
        return cr.map((x) => x / len);
      })();
      const ids = corners.map((c, k) => {
        const hasNormal = c.n >= 0 && vn[c.n];
        // Corners without a normal get the face's flat one, so they cannot be shared.
        const key = hasNormal ? `${c.p}/${c.n}` : `${c.p}/f${indices.length}/${k}`;
        let id = seen.get(key);
        if (id === undefined) {
          id = positions.length / 3;
          seen.set(key, id);
          positions.push(...v[c.p]);
          normals.push(...(hasNormal ? vn[c.n] : faceNormal));
          colors.push(...(vc[c.p] ?? [1, 1, 1]));
        }
        return id;
      });
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
    attributes.COLOR_0 = add(floats(mesh.colors.map((c) => toLinear(clamp01(c)))), ARRAY_BUFFER, {
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
  const bin = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  const total = 12 + 8 + jsonBuf.byteLength + 8 + bin.byteLength;
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(jsonBuf.byteLength, 0);
  jsonHead.writeUInt32LE(0x4e4f534a, 4);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(bin.byteLength, 0);
  binHead.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHead, jsonBuf, binHead, bin]);
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

  const readAccessor = (i: number): { data: number[]; size: number } => {
    const acc = json.accessors[i];
    const view = json.bufferViews[acc.bufferView];
    if (!bin || view.buffer !== 0) throw new Error("Only self-contained GLB files are supported (no external buffers).");
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type as string] ?? 1;
    const bytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType as number];
    if (!bytes) throw new Error(`Unsupported accessor component type ${acc.componentType}.`);
    const stride = view.byteStride ?? size * bytes;
    const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const norm = acc.normalized === true;
    const data: number[] = [];
    for (let e = 0; e < acc.count; e++) {
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
        data.push(x);
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
      const pos = readAccessor(prim.attributes.POSITION).data;
      const count = pos.length / 3;
      const nor = prim.attributes.NORMAL !== undefined ? readAccessor(prim.attributes.NORMAL).data : null;
      const col = prim.attributes.COLOR_0 !== undefined ? readAccessor(prim.attributes.COLOR_0) : null;
      const factor = json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorFactor;
      for (let i = 0; i < count; i++) {
        const [x, y, z] = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
        positions.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
        if (nor) {
          const [a, b, c] = [nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2]];
          const w = [m[0] * a + m[4] * b + m[8] * c, m[1] * a + m[5] * b + m[9] * c, m[2] * a + m[6] * b + m[10] * c];
          const len = Math.hypot(w[0], w[1], w[2]) || 1;
          normals.push(w[0] / len, w[1] / len, w[2] / len);
        } else {
          normals.push(0, 1, 0);
        }
        let rgb = [1, 1, 1];
        if (col) {
          rgb = [col.data[i * col.size], col.data[i * col.size + 1], col.data[i * col.size + 2]];
          anyColor = true;
        } else if (Array.isArray(factor)) {
          rgb = [factor[0], factor[1], factor[2]];
          anyColor = true;
        }
        colors.push(...rgb.map((c) => clamp01(toSrgb(clamp01(c)))));
      }
      const idx = prim.indices !== undefined ? readAccessor(prim.indices).data : Array.from({ length: count }, (_, i) => i);
      for (const i of idx) indices.push(base + i);
      if (!nor) {
        // No normals in the file: flat ones from each triangle (shared corners take the last).
        for (let t = 0; t < idx.length; t += 3) {
          const [a, b, c] = [base + idx[t], base + idx[t + 1], base + idx[t + 2]];
          const p = (k: number) => [positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2]];
          const [pa, pb, pc] = [p(a), p(b), p(c)];
          const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
          const v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
          const cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
          const len = Math.hypot(cr[0], cr[1], cr[2]) || 1;
          for (const k of [a, b, c]) normals.splice(k * 3, 3, cr[0] / len, cr[1] / len, cr[2] / len);
        }
      }
    }
  };

  const visit = (nodeIndex: number, parent: Mat4) => {
    const node = json.nodes?.[nodeIndex];
    if (!node) return;
    const m = mul(parent, nodeMatrix(node));
    if (node.mesh !== undefined) emit(node.mesh, m);
    for (const child of node.children ?? []) visit(child, m);
  };

  const scene = json.scenes?.[json.scene ?? 0];
  if (scene?.nodes?.length) for (const n of scene.nodes) visit(n, IDENTITY);
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
