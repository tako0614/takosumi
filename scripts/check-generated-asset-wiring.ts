import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateGeneratedAssetScriptWiring } from "./lib/generated-asset-wiring";
import { PORTABLE_GATE_PHASES } from "./check-portable-gate";

interface PackageJson {
  readonly scripts?: Readonly<Record<string, string>>;
}

const root = resolve(new URL("..", import.meta.url).pathname);
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
) as PackageJson;
const scripts = packageJson.scripts ?? {};
const portableGateDependencies = PORTABLE_GATE_PHASES.flatMap(({ command }) =>
  command[0] === "bun" && command[1] === "run" && command[2]
    ? [command[2]]
    : [],
);
const errors = [
  ...(scripts.check === "bun scripts/check-portable-gate.ts"
    ? []
    : ["'check' must invoke the canonical portable gate"]),
  ...validateGeneratedAssetScriptWiring({
    ...scripts,
    // The canonical gate is an argv-based TypeScript runner now. Project its
    // direct package-script phases into the existing graph validator so asset
    // checks remain reachable and writer commands remain forbidden.
    check: portableGateDependencies
      .map((script) => `bun run ${script}`)
      .join(" && "),
  }),
];

if (errors.length > 0) {
  console.error("Generated asset script wiring check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Generated asset script wiring check passed.");
