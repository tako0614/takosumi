import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  findAuthoritativeDocViolations,
  type AuthoritativeDocSource,
} from "./lib/authoritative-doc-boundaries";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DOC_ROOTS = ["docs", "app-docs"] as const;
const IGNORED_DIRS = new Set([".vitepress", "dist", "node_modules"]);

const sources: AuthoritativeDocSource[] = [];
for (const root of DOC_ROOTS) {
  await walk(join(ROOT, root), sources);
}

const violations = findAuthoritativeDocViolations(sources);
if (violations.length > 0) {
  console.error("Authoritative documentation boundary check failed:");
  for (const violation of violations) {
    console.error(
      `- ${violation.path}:${violation.line} [${violation.ruleId}] ${violation.message}`,
    );
    console.error(`    ${violation.excerpt}`);
  }
  process.exit(1);
}

console.log(
  `Authoritative documentation boundary check passed (${sources.length} Markdown files scanned).`,
);

async function walk(
  dir: string,
  output: AuthoritativeDocSource[],
): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), output);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const absolutePath = join(dir, entry.name);
    output.push({
      path: relative(ROOT, absolutePath).split(sep).join("/"),
      content: await readFile(absolutePath, "utf8"),
    });
  }
}
