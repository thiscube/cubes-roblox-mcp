/**
 * mesh_export / mesh_import file handling: OBJ and GLB both ways, and where the
 * files may live. The Studio half (baking, EditableMesh) is exercised in Studio;
 * everything here runs without it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  toObj,
  parseObj,
  toGlb,
  parseGlb,
  meshBounds,
  resolveMeshWritePath,
  resolveMeshReadPath,
  writeMeshFile,
  readMeshFile,
} from "../../dist/mesh.js";
import { ALL_TOOLS } from "../../dist/tools/index.js";
import { capabilities } from "../../dist/registry.js";
import { rpcReadOnlyCommands } from "../../dist/rpc-policy.js";
import "./_fixtures.mjs";

// A unit cube's +Y face and -Y face: two quads, four triangles, one colour each.
const QUADS = {
  positions: [
    -1, 1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1,
    -1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1,
  ],
  normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0],
  colors: [
    0.9, 0.55, 0.2, 0.9, 0.55, 0.2, 0.9, 0.55, 0.2, 0.9, 0.55, 0.2,
    0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1,
  ],
  indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7],
};

const near = (a, b, eps = 1e-4) => {
  assert.equal(a.length, b.length, "length");
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= eps, `index ${i}: ${a[i]} vs ${b[i]}`);
};

/** The triangles as position triples, so two meshes compare regardless of vertex order. */
const triangles = (m) => {
  const out = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    out.push([0, 1, 2].map((k) => {
      const i = m.indices[t + k];
      return [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]].map((x) => Math.round(x * 1000) / 1000).join(",");
    }).join(" "));
  }
  return out.sort();
};

describe("OBJ", () => {
  test("a mesh survives OBJ and back: triangles, winding, normals, colours", () => {
    const back = parseObj(toObj(QUADS, "cube faces"));
    assert.deepEqual(triangles(back), triangles(QUADS));
    near(back.colors, QUADS.colors);
    near(back.normals, QUADS.normals);
  });

  test("quads are fanned, negative indices and v/vt/vn all read", () => {
    const text = [
      "v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0",
      "vt 0 0", "vn 0 0 1",
      "f -4/1/1 -3/1/1 -2/1/1 -1/1/1",
    ].join("\n");
    const m = parseObj(text);
    assert.equal(m.indices.length, 6, "one quad is two triangles");
    assert.equal(m.colors, undefined, "no colours in the file, none invented");
    near(m.normals.slice(0, 3), [0, 0, 1]);
  });

  test("faces without normals get flat ones that point the way they wind", () => {
    const m = parseObj("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
    near(m.normals.slice(0, 3), [0, 0, 1]);
  });

  test("an OBJ with no faces is refused, not imported as nothing", () => {
    assert.throws(() => parseObj("v 0 0 0\n"), /no faces/);
  });
});

describe("GLB", () => {
  test("a mesh survives GLB and back, colours through linear space", () => {
    const back = parseGlb(toGlb(QUADS, "cube faces"));
    assert.deepEqual(triangles(back), triangles(QUADS));
    near(back.colors, QUADS.colors, 1e-3);
    near(back.normals, QUADS.normals);
  });

  test("the file is valid binary glTF 2.0 with POSITION bounds", () => {
    const glb = toGlb(QUADS, "x");
    assert.equal(glb.readUInt32LE(0), 0x46546c67, "magic");
    assert.equal(glb.readUInt32LE(4), 2, "version");
    assert.equal(glb.readUInt32LE(8), glb.byteLength, "declared length");
    const jsonLen = glb.readUInt32LE(12);
    const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString("utf8"));
    const pos = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
    assert.deepEqual(pos.min, [-1, -1, -1]);
    assert.deepEqual(pos.max, [1, 1, 1]);
    assert.equal(json.asset.version, "2.0");
  });

  test("node transforms are applied, the way Blender exports place meshes", () => {
    const glb = toGlb(QUADS, "x");
    const jsonLen = glb.readUInt32LE(12);
    const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString("utf8"));
    json.nodes[0].translation = [10, 0, 0];
    json.nodes[0].scale = [2, 2, 2];
    let jsonBuf = Buffer.from(JSON.stringify(json));
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.byteLength % 4)) % 4, 0x20)]);
    const rest = glb.subarray(20 + jsonLen);
    const head = Buffer.alloc(20);
    head.writeUInt32LE(0x46546c67, 0);
    head.writeUInt32LE(2, 4);
    head.writeUInt32LE(20 + jsonBuf.byteLength + rest.byteLength, 8);
    head.writeUInt32LE(jsonBuf.byteLength, 12);
    head.writeUInt32LE(0x4e4f534a, 16);
    const moved = parseGlb(Buffer.concat([head, jsonBuf, rest]));
    const b = meshBounds(moved);
    near(b.min, [8, -2, -2]);
    near(b.max, [12, 2, 2]);
  });

  test("something that is not a GLB says so", () => {
    assert.throws(() => parseGlb(Buffer.from("not a glb at all, really")), /GLB/);
  });
});

describe("mesh file paths", () => {
  test("exports stay inside the project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "cubes-mesh-"));
    const ok = await resolveMeshWritePath("out/cat.glb", { root });
    assert.ok(ok.startsWith(root) || ok.includes("cubes-mesh-"), ok);
    await assert.rejects(() => resolveMeshWritePath("../escape.obj", { root }), /must stay under/);
    await assert.rejects(() => resolveMeshWritePath("cat.fbx", { root }), /\.obj or \.glb/);
  });

  test("an existing file is only replaced when asked", async () => {
    const root = await mkdtemp(join(tmpdir(), "cubes-mesh-"));
    await writeFile(join(root, "cat.obj"), "old");
    await assert.rejects(() => resolveMeshWritePath("cat.obj", { root }), /already exists/);
    await resolveMeshWritePath("cat.obj", { root, overwrite: true });
  });

  test("imports must exist, be inside the root and be a mesh", async () => {
    const root = await mkdtemp(join(tmpdir(), "cubes-mesh-"));
    const outside = await mkdtemp(join(tmpdir(), "cubes-elsewhere-"));
    await writeFile(join(outside, "secret.obj"), "v 0 0 0");
    await writeFile(join(root, "notes.txt"), "hi");
    await assert.rejects(() => resolveMeshReadPath(join(outside, "secret.obj"), { root }), /must be under/);
    await assert.rejects(() => resolveMeshReadPath("missing.glb", { root }), /No such file/);
    await assert.rejects(() => resolveMeshReadPath("notes.txt", { root }), /\.obj or \.glb/);
  });

  test("write then read gives the same mesh, for both formats", async () => {
    const root = await mkdtemp(join(tmpdir(), "cubes-mesh-"));
    await mkdir(join(root, "meshes"));
    for (const name of ["meshes/a.obj", "meshes/a.glb"]) {
      const path = await resolveMeshWritePath(name, { root });
      const bytes = await writeMeshFile(path, QUADS, "a");
      assert.ok(bytes > 0);
      const back = await readMeshFile(await resolveMeshReadPath(name, { root }));
      assert.deepEqual(triangles(back), triangles(QUADS), name);
    }
    assert.match(await readFile(join(root, "meshes/a.obj"), "utf8"), /^v -1 1 -1 0\.9 0\.55 0\.2$/m);
  });
});

describe("mesh tools are classified by where their effect lands", () => {
  const tool = (name) => ALL_TOOLS.find((t) => t.name === name);

  test("export reads Studio but writes a file, so it is out of the read-only build", () => {
    const cap = capabilities(tool("mesh_export"));
    assert.equal(cap.write, false, "exporting never needs Allow writes");
    assert.equal(cap.writesDisk, true);
    assert.equal(cap.inspectorSafe, false);
    assert.ok(rpcReadOnlyCommands().includes("mesh_bake"), "its plugin command is a read");
  });

  test("import changes the place, so it is gated on Allow writes", () => {
    const cap = capabilities(tool("mesh_import"));
    assert.equal(cap.write, true);
    assert.ok(!rpcReadOnlyCommands().includes("mesh_build"));
  });
});
