import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

/**
 * Rojo source map.
 *
 * When the open place is a Rojo project, `rojo sourcemap` produces a sourcemap.json
 * mapping the instance tree to files on disk. If one is available, the server
 * annotates every script it reads with its `source_file` — critical for any
 * workflow editing files outside Studio.
 *
 * Opt-in: point CUBES_MCP_SOURCEMAP at the file, or drop a sourcemap.json in the
 * working directory. If none is found this is inert — reads just won't carry a
 * source_file.
 */

interface SourcemapNode {
  name: string;
  className: string;
  filePaths?: string[];
  children?: SourcemapNode[];
}

export class SourceMap {
  private readonly pathToFile = new Map<string, string>();
  readonly loaded: boolean;
  readonly sourcePath?: string;

  constructor(explicitPath?: string) {
    const file = explicitPath ?? SourceMap.autodetect();
    if (file && existsSync(file)) {
      try {
        const root = JSON.parse(readFileSync(file, "utf8")) as SourcemapNode;
        const baseDir = dirname(file);
        // The root node is the DataModel; its children are services. Instance
        // paths from the plugin (inst:GetFullName()) start at the service name.
        for (const child of root.children ?? []) {
          this.walk(child, child.name, baseDir);
        }
        this.loaded = this.pathToFile.size > 0;
        this.sourcePath = file;
        return;
      } catch {
        // malformed sourcemap — fall through to inert
      }
    }
    this.loaded = false;
  }

  private walk(node: SourcemapNode, path: string, baseDir: string): void {
    if (node.filePaths && node.filePaths.length > 0) {
      // prefer a real source file over a .meta.json sidecar
      const file = node.filePaths.find((p) => !p.endsWith(".meta.json")) ?? node.filePaths[0];
      this.pathToFile.set(path, resolve(baseDir, file));
    }
    for (const child of node.children ?? []) {
      this.walk(child, `${path}.${child.name}`, baseDir);
    }
  }

  /** The on-disk source file for an instance path, or undefined. */
  lookup(instancePath: string): string | undefined {
    return this.pathToFile.get(instancePath);
  }

  private static autodetect(): string | undefined {
    const candidates = [
      process.env.CUBES_MCP_SOURCEMAP,
      join(process.cwd(), "sourcemap.json"),
      join(process.cwd(), "..", "sourcemap.json"),
    ].filter((p): p is string => Boolean(p));
    return candidates.find((p) => existsSync(p));
  }
}
