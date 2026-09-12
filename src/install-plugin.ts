/**
 * Installing the Studio plugin (PLAN.md #3).
 *
 * Getting set up is currently: clone, install, build, then go and find a plugin
 * that is not in this repository. That last step is the one that loses people.
 *
 * WHAT IS AND IS NOT HERE
 * -----------------------
 * The mechanism is here and works: find Studio's plugins directory for this
 * platform, copy the model file in, report where it went. The plugin `.rbxm`
 * itself is NOT in this repository and never has been — `.gitignore` excludes
 * `roblox/` and `git log --all -- roblox/` is empty. So this looks for a bundled
 * artifact and, when there isn't one, says exactly that instead of pretending.
 *
 * When the plugin source does land in this repo, drop the built model at
 * `plugin/CubesMCP.rbxm` and this starts working with no other change.
 */

import { copyFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the built plugin model lives in a published package. */
export const BUNDLED_PLUGIN_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "CubesMCP.rbxm",
);

export const PLUGIN_FILENAME = "CubesMCP.rbxm";

export interface InstallResult {
  ok: boolean;
  /** Where it was installed, when ok. */
  installedTo?: string;
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

/**
 * Copy the bundled plugin into Studio's plugins directory.
 *
 * `source` is overridable so a contributor can install a plugin they built
 * themselves without waiting for it to be vendored here.
 */
export async function installPlugin(
  opts: { source?: string; platform?: NodeJS.Platform; targetDir?: string } = {},
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
        `No plugin model at ${source}. The Studio plugin is distributed separately from this ` +
        `repository and is not bundled here yet (see CLAUDE.md). Build or download ` +
        `${PLUGIN_FILENAME} and pass it with --plugin <path>, or copy it into ${dir} yourself. ` +
        `Studio must be restarted afterwards: plugins are cached at launch.`,
    };
  }

  try {
    await mkdir(dir, { recursive: true });
    const target = join(dir, PLUGIN_FILENAME);
    await copyFile(source, target);
    return {
      ok: true,
      installedTo: target,
      message:
        `Installed ${PLUGIN_FILENAME} to ${target}. Restart Roblox Studio — plugins are cached ` +
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
