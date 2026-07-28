import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  findImportBoundaryViolations,
  type ImportBoundarySource,
} from "./lib/import-boundaries.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SOURCE_ROOTS = [join(ROOT, "core"), join(ROOT, "lib")];
const sources: ImportBoundarySource[] = [];

for (const sourceRoot of SOURCE_ROOTS) await walk(sourceRoot);

const violations = findImportBoundaryViolations(sources);
if (violations.length > 0) {
  console.error("Import boundary check failed:");
  for (const violation of violations) {
    console.error(
      `- ${violation.path}:${violation.line} [${violation.ruleId}] ${violation.message}`,
    );
    console.error(`    ${violation.specifier}`);
  }
  process.exit(1);
}

console.log(
  `Import boundary check passed (${sources.length} Core/lib TypeScript files parsed).`,
);

async function walk(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await walk(join(dir, entry.name));
      continue;
    }
    if (
      !entry.isFile() ||
      (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx"))
    ) {
      continue;
    }
    const absolutePath = join(dir, entry.name);
    sources.push({
      path: relative(ROOT, absolutePath).split(sep).join("/"),
      content: await readFile(absolutePath, "utf8"),
    });
  }
}
