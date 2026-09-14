/**
 * Packaging and the plugin installer (PLAN.md #3).
 *
 * Getting set up is the step that loses people. `npm run setup` installs the
 * plugin model that ships in plugin/, removes older copies, and bakes the bridge
 * token in, so the only thing left for a person is the Allow writes toggle.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installPlugin,
  installedPluginFiles,
  pluginsDir,
  PLUGIN_FILENAME,
  PLUGIN_SIGNATURE,
  BUNDLED_PLUGIN_PATH,
  TOKEN_PLACEHOLDER,
} from "../../dist/install-plugin.js";
import { MIN_PROTOCOL_VERSION, MAX_PROTOCOL_VERSION } from "../../dist/protocol.js";
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

  test("setup and doctor are one command each", () => {
    assert.match(pkg.scripts.setup, /build/);
    assert.match(pkg.scripts.setup, /--install-plugin/);
    assert.match(pkg.scripts.doctor, /--doctor/);
  });

  test("publishing runs the build and the tests first", () => {
    assert.match(pkg.scripts.prepublishOnly, /build/);
    assert.match(pkg.scripts.prepublishOnly, /test\/run\.mjs/);
  });

  test("every script that runs tests goes through the portable runner", () => {
    // `node --test "test/unit/*.test.mjs"` is expanded by Node 22 and not by
    // Node 20, so CI's Node 20 job failed on every push while `npm test` was
    // green locally. Unquoting it would fix Linux and break Windows, where npm
    // runs scripts through cmd.
    for (const name of ["test", "test:unit", "ci", "prepublishOnly"]) {
      assert.match(pkg.scripts[name], /test\/run\.mjs/, `${name} must use the runner`);
      assert.doesNotMatch(pkg.scripts[name], /\*\.test\.mjs/, `${name} still passes a glob to node`);
    }
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
    assert.match(res.message, /rojo build/);
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

  test("older copies of the plugin are removed, other plugins are not", async () => {
    const src = await mkdtemp(join(tmpdir(), "cubes-src-"));
    const model = join(src, "built.rbxmx");
    await writeFile(model, "<roblox/>");
    const dest = await mkdtemp(join(tmpdir(), "cubes-dest-"));
    for (const name of ["CubesMCP.rbxm", "CubesMCP.rbxmx", "CubesMCP (1).rbxmx", "RoAnim.rbxmx", "NotCubesMCP.rbxmx"]) {
      await writeFile(join(dest, name), "old");
    }

    const res = await installPlugin({ source: model, targetDir: dest });
    assert.equal(res.ok, true, res.message);
    assert.deepEqual(res.removed.sort(), ["CubesMCP (1).rbxmx", "CubesMCP.rbxm", "CubesMCP.rbxmx"]);
    assert.deepEqual((await readdir(dest)).sort(), ["CubesMCP.rbxmx", "NotCubesMCP.rbxmx", "RoAnim.rbxmx"]);
  });

  test("a copy saved under another name is found by its contents and removed", async () => {
    const src = await mkdtemp(join(tmpdir(), "cubes-src-"));
    const model = join(src, "built.rbxmx");
    await writeFile(model, "<roblox/>");
    const dest = await mkdtemp(join(tmpdir(), "cubes-dest-"));
    await writeFile(join(dest, "My Plugin (2).rbxmx"), `<roblox><string>${PLUGIN_SIGNATURE}</string></roblox>`);
    await writeFile(join(dest, "SomethingElse.rbxmx"), "<roblox><string>OtherPlugin_Status</string></roblox>");

    assert.deepEqual((await installedPluginFiles(dest)).sort(), ["My Plugin (2).rbxmx"]);
    const res = await installPlugin({ source: model, targetDir: dest });
    assert.deepEqual(res.removed, ["My Plugin (2).rbxmx"]);
    assert.deepEqual((await readdir(dest)).sort(), ["CubesMCP.rbxmx", "SomethingElse.rbxmx"]);
  });

  test("the shipped model carries the signature a renamed copy is found by", async () => {
    assert.ok((await readFile(BUNDLED_PLUGIN_PATH, "utf8")).includes(PLUGIN_SIGNATURE));
  });

  test("the bridge token is baked into the installed copy, not the shipped one", async () => {
    const src = await mkdtemp(join(tmpdir(), "cubes-src-"));
    const model = join(src, "built.rbxmx");
    await writeFile(model, `Config.BAKED_TOKEN = "${TOKEN_PLACEHOLDER}"`);
    const dest = await mkdtemp(join(tmpdir(), "cubes-dest-"));
    const token = "0123456789abcdef0123456789abcdef";

    const res = await installPlugin({ source: model, targetDir: dest, token });
    assert.equal(res.tokenBaked, true);
    assert.equal(await readFile(res.installedTo, "utf8"), `Config.BAKED_TOKEN = "${token}"`);
    assert.match(await readFile(model, "utf8"), new RegExp(TOKEN_PLACEHOLDER), "the source must keep its placeholder");
  });

  test("a token that could break out of the Luau string is not baked", async () => {
    const src = await mkdtemp(join(tmpdir(), "cubes-src-"));
    const model = join(src, "built.rbxmx");
    await writeFile(model, `"${TOKEN_PLACEHOLDER}"`);
    const dest = await mkdtemp(join(tmpdir(), "cubes-dest-"));

    const res = await installPlugin({ source: model, targetDir: dest, token: 'abcdefghijklmnop" .. evil() .. "' });
    assert.equal(res.ok, true);
    assert.equal(res.tokenBaked, false);
    assert.equal(await readFile(res.installedTo, "utf8"), `"${TOKEN_PLACEHOLDER}"`);
  });

  test("the bundled model ships in the repo and in the tarball", async () => {
    assert.match(BUNDLED_PLUGIN_PATH, /plugin[\\/]CubesMCP\.rbxmx$/);
    assert.ok((await stat(BUNDLED_PLUGIN_PATH)).isFile(), "plugin/CubesMCP.rbxmx is missing: rojo build plugin/plugin.project.json -o plugin/CubesMCP.rbxmx");
    assert.ok(pkg.files.includes("plugin/CubesMCP.rbxmx"), "the tarball must carry the model");
  });
});

/**
 * The shipped model is built from plugin/src by Rojo. Nothing else keeps the two
 * in step, so a source edit without a rebuild would install a stale plugin.
 */
describe("the shipped plugin model matches its source", () => {
  const lf = (s) => s.replace(/\r\n/g, "\n");
  const srcDir = new URL("../../plugin/src/", import.meta.url);

  test("every source file is in the model, verbatim", async () => {
    const model = lf(await readFile(BUNDLED_PLUGIN_PATH, "utf8"));
    const files = (await readdir(srcDir)).filter((f) => f.endsWith(".luau"));
    assert.ok(files.includes("init.server.luau"), "the entry script is missing");
    const stale = [];
    for (const file of files) {
      const text = lf(await readFile(new URL(file, srcDir), "utf8"));
      if (!model.includes(text)) stale.push(file);
    }
    assert.deepEqual(stale, [], `rebuild the model, these changed: ${stale.join(", ")}`);
    const modules = (model.match(/<Item class="ModuleScript"/g) ?? []).length;
    assert.equal(modules, files.length - 1, "one ModuleScript per file besides the entry script");
    assert.equal((model.match(/<Item class="Script"/g) ?? []).length, 1);
  });

  test("the model still carries the token placeholder, exactly once", async () => {
    const model = await readFile(BUNDLED_PLUGIN_PATH, "utf8");
    assert.equal(model.split(TOKEN_PLACEHOLDER).length - 1, 1);
  });

  test("the plugin speaks a protocol this server accepts", async () => {
    const config = await readFile(new URL("Config.luau", srcDir), "utf8");
    const version = Number(config.match(/Config\.PROTOCOL_VERSION\s*=\s*(\d+)/)?.[1]);
    assert.ok(version >= MIN_PROTOCOL_VERSION && version <= MAX_PROTOCOL_VERSION, `plugin protocol ${version}`);
  });
});
