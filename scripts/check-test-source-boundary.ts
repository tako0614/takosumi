import { readdir, readFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;
const TEST_FILE_RE = /(?:_test|\.test|\.spec)\.tsx?$/;
const STRICT_TEST_FILE_RE = /_test\.tsx?$/;
const IMPORT_RE =
  /\b(?:import|export)\s+(?:[^'"]*?\s+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

const IGNORED_DIRS = new Set([
  ".git",
  ".turbo",
  ".vitepress",
  ".vinxi",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

interface SourceFile {
  readonly absPath: string;
  readonly relPath: string;
  readonly testOnly: boolean;
}

const files = await listSourceFiles(ROOT);
const filesByAbsPath = new Set(files.map((file) => file.absPath));
const errors: string[] = [];

for (const file of files) {
  if (TEST_FILE_RE.test(file.relPath) && !file.relPath.startsWith("tests/")) {
    errors.push(
      `${file.relPath}: test files must live under tests/`,
    );
  }
  if (file.relPath.includes("/__tests__/") && !file.relPath.startsWith("tests/")) {
    errors.push(
      `${file.relPath}: __tests__ directories must live under tests/`,
    );
  }
  if (file.relPath.startsWith("test/")) {
    errors.push(
      `${file.relPath}: use tests/ for test-only code; test/ is retired`,
    );
  }
  if (TEST_FILE_RE.test(file.relPath) && !STRICT_TEST_FILE_RE.test(file.relPath)) {
    errors.push(
      `${file.relPath}: Takosumi test files should use *_test.ts(x); reserve other test naming for migrations only`,
    );
  }

  const text = await readFile(file.absPath, "utf8");
  if (!file.testOnly && importsBunTest(text)) {
    errors.push(`${file.relPath}: production source must not import bun:test`);
  }
  if (file.testOnly) continue;

  for (const specifier of importSpecifiers(text)) {
    if (isClearlyTestOnlySpecifier(specifier)) {
      errors.push(
        `${file.relPath}: production import points at test-only path '${specifier}'`,
      );
      continue;
    }
    const resolved = resolveLocalImport(file.absPath, specifier, filesByAbsPath);
    if (resolved && isTestOnlyPath(toRelPath(resolved))) {
      errors.push(
        `${file.relPath}: production import resolves to test-only file ${toRelPath(
          resolved,
        )}`,
      );
    }
  }
}

await assertTsconfigExcludes();

if (errors.length > 0) {
  console.error("Test/source boundary check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Test/source boundary check passed (${files.length} TypeScript source files scanned).`,
);

async function listSourceFiles(root: string): Promise<readonly SourceFile[]> {
  const output: SourceFile[] = [];
  await walk(root, output);
  return output.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

async function walk(dir: string, output: SourceFile[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), output);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      continue;
    }
    if (entry.name.endsWith(".d.ts")) continue;
    const absPath = join(dir, entry.name);
    const relPath = toRelPath(absPath);
    output.push({ absPath, relPath, testOnly: isTestOnlyPath(relPath) });
  }
}

function isTestOnlyPath(relPath: string): boolean {
  return relPath.startsWith("tests/");
}

function importsBunTest(text: string): boolean {
  return /(?:from\s*["']bun:test["']|import\s*\(\s*["']bun:test["']\s*\))/.test(
    text,
  );
}

function importSpecifiers(text: string): readonly string[] {
  const specifiers: string[] = [];
  for (const match of text.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function isClearlyTestOnlySpecifier(specifier: string): boolean {
  return (
    /(?:_test|\.test|\.spec)\.tsx?$/.test(specifier) ||
    specifier.includes("/__tests__/") ||
    specifier === "test" ||
    specifier.startsWith("test/") ||
    specifier.includes("/test/") ||
    specifier === "tests" ||
    specifier.startsWith("tests/") ||
    specifier.includes("/tests/")
  );
}

function resolveLocalImport(
  importerAbsPath: string,
  specifier: string,
  filesByAbsPath: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(importerAbsPath), specifier);
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ].map((candidate) => normalize(candidate));
  return candidates.find((candidate) => filesByAbsPath.has(candidate));
}

function toRelPath(absPath: string): string {
  return relative(ROOT, absPath).split(sep).join("/");
}

async function assertTsconfigExcludes(): Promise<void> {
  const checks: readonly {
    readonly path: string;
    readonly requiredExcludes: readonly string[];
  }[] = [
    {
      path: "tsconfig.json",
      requiredExcludes: [
        "**/*_test.ts",
        "**/*_test.tsx",
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.spec.ts",
        "**/*.spec.tsx",
        "**/__tests__/**",
        "test/**",
        "tests/**",
      ],
    },
    {
      path: "tsconfig.worker.json",
      requiredExcludes: [
        "**/*_test.ts",
        "**/*_test.tsx",
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.spec.ts",
        "**/*.spec.tsx",
        "**/__tests__/**",
        "test/**",
        "tests/**",
      ],
    },
    {
      path: "dashboard/tsconfig.json",
      requiredExcludes: [
        "src/**/*_test.ts",
        "src/**/*_test.tsx",
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/**/*.spec.ts",
        "src/**/*.spec.tsx",
        "src/**/__tests__/**",
        "../tests/dashboard/**",
      ],
    },
  ];
  for (const { path, requiredExcludes } of checks) {
    const text = await readFile(join(ROOT, path), "utf8");
    for (const required of requiredExcludes) {
      if (!text.includes(`"${required}"`)) {
        errors.push(`${path}: missing test-source exclude '${required}'`);
      }
    }
  }
}
