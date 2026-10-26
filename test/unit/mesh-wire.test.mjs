/**
 * mesh_bake's compact wire form (`encoding: "f32b64"`): base64 float32/uint32
 * little-endian strings in place of JSON number arrays. The server must accept
 * both, because an older plugin ignores the request arg and sends arrays.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeMeshWire, encodeMeshField, MESH_WIRE_ENCODING } from "../../dist/mesh.js";

// Values already rounded to 4 decimals, as the plugin rounds them.
const mesh = {
  positions: [0, 0, 0, 1.5, -2.25, 0.1, 1023.9999, -512.0001, 3.1416],
  normals: [0, 1, 0, 0.7071, 0.7071, 0, -1, 0, 0],
  colors: [1, 1, 1, 0.5, 0.2, 0.0039, 0, 0, 0],
  indices: [0, 1, 2, 2, 1, 0, 4_000_000_000, 0, 1],
};

test("f32b64 round-trips to the exact 4-decimal values of the array path", () => {
  const wire = {
    name: "M",
    encoding: MESH_WIRE_ENCODING,
    positions: encodeMeshField(mesh.positions, "f32"),
    normals: encodeMeshField(mesh.normals, "f32"),
    colors: encodeMeshField(mesh.colors, "f32"),
    indices: encodeMeshField(mesh.indices, "u32"),
    center: [1, 2, 3],
  };
  const out = decodeMeshWire(wire);
  assert.deepEqual(out.positions, mesh.positions);
  assert.deepEqual(out.normals, mesh.normals);
  assert.deepEqual(out.colors, mesh.colors);
  assert.deepEqual(out.indices, mesh.indices);
  assert.equal(out.encoding, undefined);
  assert.deepEqual(out.center, [1, 2, 3], "other fields are left alone");
});

test("an old plugin's arrays pass through untouched", () => {
  const out = decodeMeshWire({ ...structuredClone(mesh) });
  assert.deepEqual(out.positions, mesh.positions);
  assert.deepEqual(out.indices, mesh.indices);
});

test("the plugin's Luau encoder output decodes (known bytes)", () => {
  // Produced by MeshTools.luau's base64Lua for {1.5, -2.25, 0.1, 1023.9999}.
  const out = decodeMeshWire({ positions: "AADAPwAAEMDNzMw9/v9/RA==", indices: encodeMeshField([0, 1, 2], "u32") });
  assert.deepEqual(out.positions, [1.5, -2.25, 0.1, 1023.9999]);
});

test("a truncated or mistyped field is an error, not garbage", () => {
  assert.throws(() => decodeMeshWire({ positions: "AAA=", indices: [] }), /multiple of 4/);
  assert.throws(() => decodeMeshWire({ positions: 5, indices: [] }), /neither an array/);
});

test("compact form is smaller than the JSON", () => {
  const n = 3000;
  const f = Array.from({ length: n * 3 }, (_, i) => Math.round(Math.sin(i) * 500 * 10000) / 10000);
  const idx = Array.from({ length: n * 1.5 }, (_, i) => i % n);
  const json = JSON.stringify({ positions: f, normals: f, colors: f, indices: idx }).length;
  const compact = JSON.stringify({
    positions: encodeMeshField(f, "f32"), normals: encodeMeshField(f, "f32"),
    colors: encodeMeshField(f, "f32"), indices: encodeMeshField(idx, "u32"),
  }).length;
  assert.ok(compact < json * 0.8, `${compact} vs ${json}`);
});
