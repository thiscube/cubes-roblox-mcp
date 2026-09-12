/**
 * Packaging and the plugin installer (PLAN.md #3).
 *
 * Getting set up is the step that loses people: clone, install, build, then go
 * and find a plugin that is not in this repository. The mechanism for that last
 * step is here and tested; the plugin artifact itself is not in this checkout
 * and never has been, so the honest behaviour is to say so precisely rather than
 * to pretend.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installPlugin, pluginsDir, PLUGIN_FILENAME, BUNDLED_PLUGIN_PATH } from "../../dist/install-plugin.js";
import "./_fixtures.mjs";

const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

describe("npm package metadata", () => {
  test("it is publishable at all", () => {
    assert.equal(pkg.private, undefined, "`private: true` blocks publishing outright");
    assert.ok(pkg.license, "npm warns on every install without one");
    assert.equal(pkg.repository?.url?.includes("github.com/thiscube/cubes-roblox-mcp"), true);
  });

  test("both binaries are declared and exist after a build", async () => {
    assert.deepEqual(Object.keys(pkg.bin).sort(), [
      "cubes-roblox-mcp",
      "cubes-roblox-mcp-inspector",
    ]);
    for (const rel of Object.values(pkg.bin)) {
      const built = new URL(`../../${rel}`, import.meta.url);
      const text = await readFile(built, "utf8");
      assert.match(text.split("\n")[0], /^#!\/usr\/bin\/env node/, `${rel} needs a shebang`);
    }
  });

  test("the inspector binary forces read-only and cannot be talked out of it", async () => {
    const text = await readFile(new URL("../../dist/inspector.js", import.meta.url), "utf8");
    assert.match(text, /CUBES_MCP_READ_ONLY.*=.*"1"/);
    assert.doesNotMatch(text, /--write|readOnly:\s*false/);
  });

  test("the published tarball ships the build and the docs, not the sources", () => {
    for (const wanted of ["dist", "README.md", "SECURITY.md"]) {
      assert.ok(pkg.files.includes(wanted), `${wanted} must be published`);
    }
    for (const unwanted of ["src", "test", "node_modules"]) {
      assert.ok(!pkg.files.includes(unwanted), `${unwanted} should not be published`);
    }
  });

  test("publishing runs the build and the tests first", () => {
    assert.match(pkg.scripts.prepublishOnly, /build/);
    assert.match(pkg.scripts.prepublishOnly, /--test/);
  });
});

describe("plugin installer", () => {
  test("it knows where Studio keeps plugins on each platform", () => {
    assert.match(pluginsDir("win32"), /Roblox[\\/]Plugins$/);
    assert.match(pluginsDir("darwin"), /Documents[\\/]Roblox[\\/]Plugins$/);
    // Studio has no native Linux build, and a Wine prefix path cannot be
    // guessed. Saying so beats copying the file somewhere wrong.
    assert.equal(pluginsDir("linux"), null);
  });

  test("an unsupported platform explains what to do instead", async () => {
    const res = await installPlugin({ platform: "linux" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "unsupported_platform");
    assert.match(res.message, /Wine or Proton/);
    assert.match(res.message, /--plugins-dir/);
  });

  test("a missing plugin artifact says exactly that, and where to put one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cubes-plugins-"));
    const res = await installPlugin({ source: join(dir, "nope.rbxm"), targetDir: dir });
    assert.equal(res.ok, false);
    assert.equal(res.code, "no_bundled_plugin");
    assert.match(res.message, /distributed separately/);
    assert.match(res.message, /--plugin <path>/);
    assert.match(res.message, /restarted/, "Studio caches plugins at launch");
  });

  test("it installs a real file and names the restart requirement", async () => {
    const src = await mkdtemp(join(tmpdir(), "cubes-src-"));
    const dest = await mkdtemp(join(tmpdir(), "cubes-dest-"));
    const model = join(src, "built.rbxm");
    await writeFile(model, "<roblox!/>");

    const res = await installPlugin({ source: model, targetDir: dest });
    assert.equal(res.ok, true, res.message);
    assert.equal(res.installedTo, join(dest, PLUGIN_FILENAME));
    assert.equal((await readFile(res.installedTo, "utf8")), "<roblox!/>");
    assert.match(res.message, /Restart Roblox Studio/);
  });

  test("it creates the plugins directory when Studio has never made one", async () => {
    const src = await mkdtemp(join(tmpdir(), "cubes-src-"));
    const model = join(src, "built.rbxm");
    await writeFile(model, "x");
    const dest = join(await mkdtemp(join(tmpdir(), "cubes-dest-")), "deep", "Plugins");

    const res = await installPlugin({ source: model, targetDir: dest });
    assert.equal(res.ok, true, res.message);
    assert.ok((await stat(res.installedTo)).isFile());
  });

  test("an unwritable destination fails with the reason, not a stack trace", async () => {
    const src = await mkdtemp(join(tmpdir(), "cubes-src-"));
    const model = join(src, "built.rbxm");
    await writeFile(model, "x");
    const dest = await mkdtemp(join(tmpdir(), "cubes-ro-"));
    await chmod(dest, 0o500);
    try {
      const res = await installPlugin({ source: model, targetDir: dest });
      // Running as root defeats the permission bit; skip rather than assert a
      // falsehood about this environment.
      if (res.ok) return;
      assert.equal(res.code, "copy_failed");
      assert.match(res.message, /Could not write into/);
    } finally {
      await chmod(dest, 0o700);
    }
  });

  test("the bundled path is where a vendored plugin would go", () => {
    assert.match(BUNDLED_PLUGIN_PATH, /plugin[\\/]CubesMCP\.rbxm$/);
    assert.ok(pkg.files.includes("plugin"), "the tarball must carry it once it exists");
  });
});
