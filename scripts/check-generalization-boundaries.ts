import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  findGeneralizationBoundaryViolations,
  type GeneralizationBoundarySource,
  type GeneralizationBoundaryViolation,
} from "./lib/generalization-boundaries";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SCAN_ROOTS = [
  "accounts",
  "cli",
  "contract",
  "core",
  "dashboard/src",
  "deploy",
  "docs/en/reference",
  "docs/operations",
  "docs/reference",
  "provider",
  "providers",
  "runner",
  "worker",
] as const;
const SCAN_FILES = [
  "package.json",
  "tsconfig.json",
  "dashboard/package.json",
  "dashboard/tsconfig.json",
  "scripts/validate-production-hardening-evidence.ts",
] as const;
const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".go",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".tf",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const IGNORED_DIRS = new Set([
  ".git",
  ".vitepress",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);
const RETIRED_PATHS = [
  "accounts/platform-services",
  "accounts/service/src/control/projection.ts",
  "accounts/service/src/runtime-projection-material-resolver.ts",
  "contract/deployments.ts",
  "contract/installations.ts",
  "contract/output-projection.ts",
  "contract/output-sync.ts",
  "contract/runtime-agent.ts",
  "core/domains/deploy-records",
  "core/domains/deploy-control/service_grant_broker.ts",
  "core/domains/runtime",
  "core/domains/output-projection",
  "core/domains/output-sync",
  "core/domains/network",
  "core/domains/security",
  "core/domains/service-endpoints",
  "core/domains/templates",
  "core/runtime-agent",
  "core/workers/registry_sync_worker.ts",
] as const;

const sources: GeneralizationBoundarySource[] = [];
for (const root of SCAN_ROOTS) {
  const absRoot = join(ROOT, root);
  if (existsSync(absRoot)) await walk(absRoot, sources);
}
for (const path of SCAN_FILES) {
  const absPath = join(ROOT, path);
  if (!existsSync(absPath)) continue;
  sources.push({ path, content: await readFile(absPath, "utf8") });
}

const violations: GeneralizationBoundaryViolation[] = [
  ...findGeneralizationBoundaryViolations(sources),
];
for (const path of RETIRED_PATHS) {
  if (
    !sources.some(
      (source) => source.path === path || source.path.startsWith(`${path}/`),
    )
  ) {
    continue;
  }
  violations.push({
    ruleId: "retired-path",
    path,
    line: 1,
    message: "retired implementation path must not exist in the current tree",
    excerpt: path,
  });
}

if (violations.length > 0) {
  console.error("Generalization boundary check failed:");
  for (const violation of violations) {
    console.error(
      `- ${violation.path}:${violation.line} [${violation.ruleId}] ${violation.message}`,
    );
    if (violation.excerpt) console.error(`    ${violation.excerpt}`);
  }
  process.exit(1);
}

console.log(
  `Generalization boundary check passed (${sources.length} current files scanned).`,
);

async function walk(
  dir: string,
  output: GeneralizationBoundarySource[],
): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), output);
      continue;
    }
    if (!entry.isFile() || !hasSourceExtension(entry.name)) continue;
    const absPath = join(dir, entry.name);
    output.push({
      path: relative(ROOT, absPath).split(sep).join("/"),
      content: await readFile(absPath, "utf8"),
    });
  }
}

function hasSourceExtension(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && SOURCE_EXTENSIONS.has(name.slice(dot));
}
