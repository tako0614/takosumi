import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateGeneratedAssetScriptWiring } from "./lib/generated-asset-wiring";

interface PackageJson {
  readonly scripts?: Readonly<Record<string, string>>;
}

const root = resolve(new URL("..", import.meta.url).pathname);
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
) as PackageJson;
const errors = validateGeneratedAssetScriptWiring(packageJson.scripts ?? {});

if (errors.length > 0) {
  console.error("Generated asset script wiring check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Generated asset script wiring check passed.");
