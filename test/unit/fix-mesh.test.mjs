import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGlb, resolveMeshWritePath, resolveMeshReadPath } from "../../dist/mesh.js";

function glb(json, bin) {
  let j = Buffer.from(JSON.stringify(json));
  while (j.length % 4) j = Buffer.concat([j, Buffer.from(" ")]);
  const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4);
  const jc = Buffer.alloc(8); jc.writeUInt32LE(j.length, 0); jc.writeUInt32LE(0x4e4f534a, 4);
  const bc = Buffer.alloc(8); bc.writeUInt32LE(bin.length, 0); bc.writeUInt32LE(0x004e4942, 4);
  const out = Buffer.concat([h, jc, j, bc, bin]); out.writeUInt32LE(out.length, 8); return out;
}
const bin = Buffer.alloc(36);
const base = () => ({
  buffers: [{ byteLength: 36 }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
  accessors: [{ bufferView: 0, componentType: 5126, type: "VEC3", count: 3 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
});

test("a plain triangle still parses", () => {
  assert.equal(parseGlb(glb(base(), bin)).positions.length, 9);
});

test("byteStride 0 with a huge count is refused before allocating", () => {
  const a = base(); a.bufferViews[0].byteStride = 0; a.accessors[0].count = 3_000_000;
  assert.throws(() => parseGlb(glb(a, bin)));
});

test("a count that runs past the buffer is refused", () => {
  const a = base(); a.accessors[0].count = 4;
  assert.throws(() => parseGlb(glb(a, bin)), /past the end/);
});

test("node fan-out is capped", () => {
  const b = base(); b.nodes = [];
  for (let d = 0; d < 4; d++) b.nodes.push({ children: Array(30).fill(d + 1) });
  b.nodes.push({ mesh: 0 }); b.scenes = [{ nodes: [0] }];
  assert.throws(() => parseGlb(glb(b, bin)), /too large/);
});

test("a node cycle is refused", () => {
  const b = base(); b.nodes = [{ children: [1] }, { children: [0], mesh: 0 }]; b.scenes = [{ nodes: [0] }];
  assert.throws(() => parseGlb(glb(b, bin)), /cycle/);
});

test("NTFS alternate data streams are refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "fix-mesh-"));
  await assert.rejects(resolveMeshWritePath("x.txt:s.glb", { root }), /alternate data stream/);
  await assert.rejects(resolveMeshReadPath("x.txt:s.glb", { root }), /alternate data stream/);
});

test("resolving a write path creates no directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "fix-mesh-"));
  await resolveMeshWritePath("deep/dir/m.glb", { root });
  await assert.rejects(stat(join(root, "deep")));
});
