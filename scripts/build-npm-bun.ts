import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "npm");
const ESM_OUT = join(OUT, "esm");

interface SourcePackage {
  readonly name: string;
  readonly version: string;
  readonly license?: string;
  readonly exports: Record<string, string | { readonly import?: string }>;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

interface TsConfig {
  readonly compilerOptions?: {
    readonly paths?: Record<string, readonly string[]>;
  };
}

const sourcePackage = await Bun.file(join(ROOT, "package.json"))
  .json() as SourcePackage;
const tsconfig = await Bun.file(join(ROOT, "tsconfig.json")).json() as TsConfig;
const transpiler = new Bun.Transpiler({ loader: "ts", target: "node" });

function exportTarget(value: string | { readonly import?: string }): string {
  if (typeof value === "string") return value;
  if (typeof value.import === "string") return value.import;
  throw new Error("package.json export entries must expose an import target");
}

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

function jsRel(path: string): string {
  return path.replace(/\.(ts|tsx)$/, ".js");
}

function outputSpecifier(fromRel: string, targetRel: string): string {
  const fromDir = dirname(join(ESM_OUT, jsRel(fromRel)));
  const target = join(ESM_OUT, jsRel(targetRel.replace(/^\.\//, "")));
  let spec = toPosix(relative(fromDir, target));
  if (!spec.startsWith(".")) spec = `./${spec}`;
  return spec;
}

const pathEntries = Object.entries(tsconfig.compilerOptions?.paths ?? {});

function aliasTarget(specifier: string): string | undefined {
  for (const [pattern, targets] of pathEntries) {
    const first = targets[0];
    if (!first) continue;
    if (!pattern.includes("*")) {
      if (specifier === pattern) return first;
      continue;
    }
    const [prefix, suffix] = pattern.split("*");
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const captured = specifier.slice(
      prefix.length,
      specifier.length - suffix.length,
    );
    return first.replace("*", captured);
  }
  return undefined;
}

function rewriteSpecifier(fromRel: string, specifier: string): string {
  if (specifier.startsWith(".") && specifier.match(/\.(ts|tsx)$/)) {
    return jsRel(specifier);
  }
  const target = aliasTarget(specifier);
  if (target?.startsWith("./")) {
    return outputSpecifier(fromRel, target);
  }
  return specifier;
}

function rewriteImports(fromRel: string, code: string): string {
  return code
    .replace(
      /(from\s*["'])([^"']+)(["'])/g,
      (_match, before: string, specifier: string, after: string) =>
        `${before}${rewriteSpecifier(fromRel, specifier)}${after}`,
    )
    .replace(
      /(import\s*\(\s*["'])([^"']+)(["']\s*\))/g,
      (_match, before: string, specifier: string, after: string) =>
        `${before}${rewriteSpecifier(fromRel, specifier)}${after}`,
    );
}

function shouldBuild(rel: string): boolean {
  if (!rel.endsWith(".ts")) return false;
  if (rel.endsWith("_test.ts")) return false;
  if (rel.startsWith("src/cli/tests/")) return false;
  if (rel.startsWith("src/kernel/scripts/")) return false;
  return true;
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(ROOT, dir, prefix))) {
    const rel = join(dir, prefix, entry);
    const info = await stat(join(ROOT, rel));
    if (info.isDirectory()) {
      out.push(...await listFiles(dir, join(prefix, entry)));
    } else {
      out.push(toPosix(rel));
    }
  }
  return out;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(ESM_OUT, { recursive: true });

const files = [
  ...await listFiles("src"),
  ...await listFiles("shims"),
].filter(shouldBuild);

for (const rel of files) {
  const source = await Bun.file(join(ROOT, rel)).text();
  const transpiled = transpiler.transformSync(source);
  const rewritten = rewriteImports(rel, transpiled);
  const outPath = join(ESM_OUT, jsRel(rel));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, rewritten);
}

const cliPath = join(ESM_OUT, "src/cli/main.js");
const cliBody = await Bun.file(cliPath).text();
await writeFile(cliPath, `#!/usr/bin/env node\n${cliBody}`);

const exports = Object.fromEntries(
  Object.entries(sourcePackage.exports).map(([name, target]) => {
    const rel = exportTarget(target).replace(/^\.\//, "");
    return [name, `./esm/${jsRel(rel)}`];
  }),
);

const npmPackage = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  description:
    "Takosumi core contract, kernel, installer, CLI, and runtime-agent.",
  license: sourcePackage.license ?? "MIT",
  type: "module",
  module: "./esm/src/all/mod.js",
  exports,
  bin: {
    takosumi: "esm/src/cli/main.js",
  },
  dependencies: sourcePackage.dependencies ?? {},
  peerDependencies: sourcePackage.peerDependencies ?? {},
};

await writeFile(
  join(OUT, "package.json"),
  `${JSON.stringify(npmPackage, null, 2)}\n`,
);

for (const file of ["README.md", "LICENSE"]) {
  const source = join(ROOT, file);
  try {
    await cp(source, join(OUT, file));
  } catch {
    // optional repository files
  }
}

console.log(`[build-npm] built ${files.length} modules -> ${OUT}`);
