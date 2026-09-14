/**
 * Installing the Studio plugin (PLAN.md #3).
 *
 * `npm run setup` ends here. It puts the plugin model that ships in this repo,
 * `plugin/CubesMCP.rbxmx` (built from `plugin/src` with Rojo), into Studio's
 * plugins folder, and in doing so:
 *
 *   - removes every older CubesMCP plugin file first. Two copies both poll port
 *     44820 and fight over it, and "Save as Local Plugin" leaves a differently
 *     named file behind, so overwriting by name is not enough.
 *   - bakes the bridge token into the installed copy, so nobody pastes it. The
 *     plugin cannot read files and the protocol has no token handoff, which used
 *     to make the human the courier. The installed file lives in the same user's
 *     profile as the token file itself, so this moves the secret nowhere new.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the built plugin model lives in this repo and in a published package. */
export const BUNDLED_PLUGIN_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "CubesMCP.rbxmx",
);

export const PLUGIN_FILENAME = "CubesMCP.rbxmx";

/** The literal the plugin's Config ships with; the installer swaps the token in. */
export const TOKEN_PLACEHOLDER = "__CUBES_MCP_BAKED_TOKEN__";

/** Any file in the plugins folder that is a copy of this plugin, old or new. */
const OLD_PLUGIN_FILE = /^CubesMCP([ ._-].*)?\.(rbxmx?|lua|luau)$/i;

/** A token is only baked if it cannot break out of the Luau string or the XML. */
const SAFE_TOKEN = /^[A-Za-z0-9._~-]{16,256}$/;

export interface InstallResult {
  ok: boolean;
  /** Where it was installed, when ok. */
  installedTo?: string;
  /** Older plugin files that were deleted to make room. */
  removed?: string[];
  /** Whether the bridge token was written into the installed plugin. */
  tokenBaked?: boolean;
  /** Machine-readable reason, when not ok. */
  code?: "no_bundled_plugin" | "unsupported_platform" | "copy_failed";
  message: string;
}

/**
 * Studio's local plugins directory for this platform.
 *
 * Returns null where Studio does not run. Linux is deliberately not guessed at:
 * Studio has no native Linux build, and people running it under Wine or Proton
 * have a prefix path this code cannot know. Telling them where to put the file
 * is more useful than copying it somewhere wrong.
 */
export function pluginsDir(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    return local ? join(local, "Roblox", "Plugins") : join(homedir(), "AppData", "Local", "Roblox", "Plugins");
  }
  if (platform === "darwin") {
    return join(homedir(), "Documents", "Roblox", "Plugins");
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every copy of this plugin in `dir`, old or new. Empty when the folder is missing. */
export async function installedPluginFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => OLD_PLUGIN_FILE.test(name));
  } catch {
    return [];
  }
}

/**
 * Install the plugin into Studio's plugins directory.
 *
 * `source` is overridable so a contributor can install a model they built
 * themselves. `token`, when given and safe, is baked into the installed copy.
 */
export async function installPlugin(
  opts: { source?: string; platform?: NodeJS.Platform; targetDir?: string; token?: string } = {},
): Promise<InstallResult> {
  const source = opts.source ?? BUNDLED_PLUGIN_PATH;
  const dir = opts.targetDir ?? pluginsDir(opts.platform);

  if (!dir) {
    return {
      ok: false,
      code: "unsupported_platform",
      message:
        `Roblox Studio has no build for ${opts.platform ?? process.platform}, so there is no plugins ` +
        `directory to install into. If you run Studio under Wine or Proton, copy ${PLUGIN_FILENAME} ` +
        `into that prefix's Roblox/Plugins folder yourself, or pass --plugins-dir.`,
    };
  }

  if (!(await exists(source))) {
    return {
      ok: false,
      code: "no_bundled_plugin",
      message:
        `No plugin model at ${source}. It ships in this repo as plugin/${PLUGIN_FILENAME}; if it is ` +
        `missing, rebuild it with \`rojo build plugin/plugin.project.json -o plugin/${PLUGIN_FILENAME}\`, ` +
        `or pass another model with --plugin <path>. Studio must be restarted afterwards: plugins ` +
        `are cached at launch.`,
    };
  }

  try {
    let model = await readFile(source, "utf8");
    const tokenBaked = typeof opts.token === "string" && SAFE_TOKEN.test(opts.token) && model.includes(TOKEN_PLACEHOLDER);
    if (tokenBaked) model = model.split(TOKEN_PLACEHOLDER).join(opts.token as string);

    await mkdir(dir, { recursive: true });
    const removed: string[] = [];
    for (const name of await readdir(dir)) {
      if (OLD_PLUGIN_FILE.test(name)) {
        await rm(join(dir, name), { force: true });
        removed.push(name);
      }
    }

    const target = join(dir, PLUGIN_FILENAME);
    await writeFile(target, model, "utf8");
    return {
      ok: true,
      installedTo: target,
      removed,
      tokenBaked,
      message:
        `Installed ${PLUGIN_FILENAME} to ${target}. Restart Roblox Studio: plugins are cached ` +
        `at launch, so a running Studio will not pick this up.`,
    };
  } catch (err) {
    return {
      ok: false,
      code: "copy_failed",
      message: `Could not write into ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
