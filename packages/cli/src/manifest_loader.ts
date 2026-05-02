import { parse as parseYaml } from "@std/yaml";
import { extname } from "@std/path";

export interface LoadedManifest {
  readonly path: string;
  readonly format: "yaml" | "json";
  readonly value: unknown;
}

export async function loadManifest(path: string): Promise<LoadedManifest> {
  const text = await Deno.readTextFile(path);
  const ext = extname(path).toLowerCase();
  if (ext === ".json") {
    return { path, format: "json", value: JSON.parse(text) };
  }
  if (ext === ".yml" || ext === ".yaml") {
    return { path, format: "yaml", value: parseYaml(text) };
  }
  try {
    return { path, format: "json", value: JSON.parse(text) };
  } catch {
    return { path, format: "yaml", value: parseYaml(text) };
  }
}
