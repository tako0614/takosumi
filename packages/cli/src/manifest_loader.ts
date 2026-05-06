import { parse as parseYaml } from "@std/yaml";
import { extname } from "@std/path";

export interface LoadedManifest {
  readonly path: string;
  readonly format: "yaml" | "json";
  readonly value: unknown;
}

export interface LoadManifestOptions {
  readonly cwd?: string;
}

/**
 * Picks the manifest path from a positional argument and/or `--manifest` flag.
 *
 * Returns `undefined` when neither is set; callers must surface a clear "path
 * required" error rather than auto-discovering one. Project-layout discovery
 * (`.takosumi/manifest.yml` etc.) used to live here but has moved to the
 * `takosumi-git` sibling product, so the kernel-side CLI now stays a pure
 * manifest engine that only acts on an explicit path.
 */
export function selectManifestPath(input: {
  readonly argument?: string;
  readonly flag?: string;
}): string | undefined {
  if (input.argument && input.flag && input.argument !== input.flag) {
    throw new Error(
      "pass the manifest either as an argument or with --manifest, not both",
    );
  }
  return input.flag ?? input.argument;
}

const MANIFEST_PATH_REQUIRED =
  "manifest path is required; pass <manifest> or --manifest <path>. " +
  "Project-layout discovery (.takosumi/manifest.yml) is provided by " +
  "takosumi-git (sibling product), not this CLI.";

export function resolveManifestPath(
  path?: string,
  _options: LoadManifestOptions = {},
): Promise<string> {
  if (!path) {
    return Promise.reject(new Error(MANIFEST_PATH_REQUIRED));
  }
  return Promise.resolve(path);
}

export async function loadManifest(
  path?: string,
  options: LoadManifestOptions = {},
): Promise<LoadedManifest> {
  const resolvedPath = await resolveManifestPath(path, options);
  const text = await Deno.readTextFile(resolvedPath);
  const ext = extname(resolvedPath).toLowerCase();
  if (ext === ".json") {
    return { path: resolvedPath, format: "json", value: JSON.parse(text) };
  }
  if (ext === ".yml" || ext === ".yaml") {
    return { path: resolvedPath, format: "yaml", value: parseYaml(text) };
  }
  try {
    return { path: resolvedPath, format: "json", value: JSON.parse(text) };
  } catch {
    return { path: resolvedPath, format: "yaml", value: parseYaml(text) };
  }
}
