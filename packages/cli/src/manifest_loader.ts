import { parse as parseYaml } from "@std/yaml";
import { extname, join } from "@std/path";

export const DEFAULT_MANIFEST_CANDIDATES = [
  ".takosumi/manifest.yml",
  ".takosumi/manifest.yaml",
  ".takosumi/manifest.json",
  "manifest.yml",
  "manifest.yaml",
  "manifest.json",
] as const;

export interface LoadedManifest {
  readonly path: string;
  readonly format: "yaml" | "json";
  readonly value: unknown;
}

export interface LoadManifestOptions {
  readonly cwd?: string;
}

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

export async function resolveManifestPath(
  path?: string,
  options: LoadManifestOptions = {},
): Promise<string> {
  if (path) return path;
  const cwd = options.cwd ?? Deno.cwd();
  for (const candidate of DEFAULT_MANIFEST_CANDIDATES) {
    const candidatePath = join(cwd, candidate);
    try {
      const stat = await Deno.stat(candidatePath);
      if (stat.isFile) return candidatePath;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
  }
  throw new Error(
    "manifest path is required; pass <manifest>, --manifest <path>, or add " +
      `${DEFAULT_MANIFEST_CANDIDATES[0]}`,
  );
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
