// dnt build script: produce the @takosjp/takosumi npm package from the
// Bun-first source tree. package.json is the single source of truth for npm
// subpath exports; tsconfig.json supplies workspace-local source aliases.
//
// Usage: bun run build:npm
//   --typecheck=both|single|none   (default: single)
//   --no-typecheck                 (alias for none)
//   --entry=.,./contract,...       (restrict to a comma list of npm exports)
//
// DO NOT npm publish from here; this only builds + lets you `npm pack`.

import { build, emptyDir } from "jsr:@deno/dnt@0.42.3";

const HERE = new URL(".", import.meta.url);
const ROOT = new URL("../", HERE);
const fromRoot = (p: string) => new URL(p, ROOT).pathname;

interface SourcePackage {
  readonly version: string;
  readonly exports: Record<string, string | { readonly import?: string }>;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

interface TsConfig {
  readonly compilerOptions?: {
    readonly paths?: Record<string, readonly string[]>;
  };
}

// The subprocess/serve primitives are runtime-detecting single modules: they
// use a local `declare const Deno` type (so the dnt typecheck surface never
// touches Deno.*) and branch on `globalThis.Deno` at call time, running
// `Deno.Command` / `Deno.serve` on Deno and `node:child_process` / `node:http`
// on Node. The npm build therefore needs no module mappings.

const sourcePackage = JSON.parse(
  await Deno.readTextFile(fromRoot("package.json")),
) as SourcePackage;
const tsconfig = JSON.parse(
  await Deno.readTextFile(fromRoot("tsconfig.json")),
) as TsConfig;

function exportTarget(value: string | { readonly import?: string }): string {
  if (typeof value === "string") return value;
  if (typeof value.import === "string") return value.import;
  throw new Error("package.json export entries must expose an import target");
}

// npm export name -> source file, derived from package.json `exports`.
const ENTRY_TABLE: Record<string, string> = Object.fromEntries(
  Object.entries(sourcePackage.exports).map(
    ([name, rel]) => [name, exportTarget(rel).replace(/^\.\//, "")],
  ),
);

async function writeDntImportMap(): Promise<{ path: string; cleanup(): Promise<void> }> {
  const dir = await Deno.makeTempDir({ prefix: "takosumi-dnt-" });
  const imports: Record<string, string> = {};

  for (const [name, range] of Object.entries(sourcePackage.dependencies ?? {})) {
    if (name.startsWith("@types/")) continue;
    imports[name] = `npm:${name}@${range}`;
    imports[`${name}/`] = `npm:${name}@${range}/`;
  }
  for (const [specifier, targets] of Object.entries(
    tsconfig.compilerOptions?.paths ?? {},
  )) {
    if (specifier.includes("*")) continue;
    const first = targets[0];
    if (!first) continue;
    imports[specifier] = /^[a-z][a-z0-9+.-]*:/i.test(first)
      ? first
      : new URL(first, ROOT).href;
  }

  const path = `${dir}/import_map.json`;
  await Deno.writeTextFile(path, JSON.stringify({ imports }, null, 2) + "\n");
  return {
    path,
    cleanup: () => Deno.remove(dir, { recursive: true }),
  };
}

function parseArgs() {
  let typeCheck: "both" | "single" | false = "single";
  let entries: string[] | undefined;
  for (const arg of Deno.args) {
    if (arg === "--no-typecheck" || arg === "--typecheck=none") {
      typeCheck = false;
    } else if (arg.startsWith("--typecheck=")) {
      const v = arg.slice("--typecheck=".length);
      if (v === "both" || v === "single") typeCheck = v;
      else if (v === "none") typeCheck = false;
    } else if (arg.startsWith("--entry=")) {
      entries = arg.slice("--entry=".length).split(",").map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return { typeCheck, entries };
}

const { typeCheck, entries } = parseArgs();

const selected = entries ?? Object.keys(ENTRY_TABLE);
const entryPoints: Array<
  { name: string; path: string } | { kind: "bin"; name: string; path: string }
> = selected.map((name) => {
  const rel = ENTRY_TABLE[name];
  if (!rel) throw new Error(`unknown npm export name: ${name}`);
  return name === "."
    ? { name: ".", path: fromRoot(rel) }
    : { name, path: fromRoot(rel) };
});

// Ship the runnable CLI as a npm bin (`npx @takosjp/takosumi`,
// `deno run -A npm:@takosjp/takosumi/bin`). The `./cli` subpath stays the
// library export; the bin wraps src/cli/main.ts (import.meta.main).
if (!entries) {
  entryPoints.push({
    kind: "bin",
    name: "takosumi",
    path: fromRoot("src/cli/main.ts"),
  });
}

const outDir = fromRoot("npm");
await emptyDir(outDir);

console.log(
  `[build-npm] @takosjp/takosumi@${sourcePackage.version} ` +
    `typeCheck=${typeCheck ?? "none"} entries=${selected.length}`,
);

const importMap = await writeDntImportMap();

try {
  await build({
  entryPoints,
  outDir,
  importMap: importMap.path,
  shims: { deno: true },
  test: false,
  typeCheck,
  // Only ignore the dnt-GENERATED import.meta polyfill's self-typing false
  // positive (_dnt.polyfills.ts:195, `pathToFileURL(... .resolve(x))` widened
  // to `unknown` once a web-platform lib is in scope). We deliberately do NOT
  // filter diagnostics in our own source so genuine Deno-isms stay visible.
  filterDiagnostic(diagnostic) {
    const file = diagnostic.file?.fileName ?? "";
    if (file.endsWith("_dnt.polyfills.ts")) return false;
    return true;
  },
  compilerOptions: {
    // The kernel/contract assume Web Platform types (CryptoKey, BodyInit,
    // BufferSource, HeadersInit, BlobPart) and @cliffy needs ES2022's
    // ErrorOptions/`cause`. Mirror those into the dnt tsc lib set.
    lib: ["ES2021", "ES2022.Error", "WebWorker", "WebWorker.ImportScripts"],
  },
  // Skipping declaration emit can sidestep some no-slow-types style issues,
  // but we WANT .d.ts for a real package; keep default ("inline").
  scriptModule: false, // ESM-only output (the kernel/runtime is ESM/Deno-first)
  package: {
    name: "@takosjp/takosumi",
    version: sourcePackage.version,
    description:
      "Takosumi core contract / kernel / installer / cli / runtime-agent (kind-agnostic framework; official kind catalog is published JSON-LD at takosumi.com/kinds/v1) (npm build).",
    license: "MIT",
    type: "module",
  },
  async postBuild() {
    // best-effort: copy a LICENSE/README if present
    for (const f of ["LICENSE", "README.md"]) {
      try {
        await Deno.copyFile(fromRoot(f), `${outDir}/${f}`);
      } catch {
        // ignore
      }
    }
    // dnt emits bin paths as "./esm/cli/main.js"; npm's bin validator rejects
    // the leading "./" and drops the bin. Strip it so `npx @takosjp/takosumi`
    // and `deno run -A npm:@takosjp/takosumi` resolve the CLI.
    const pkgPath = `${outDir}/package.json`;
    const pkg = JSON.parse(await Deno.readTextFile(pkgPath));
    if (pkg.bin && typeof pkg.bin === "object") {
      for (const [name, target] of Object.entries(pkg.bin)) {
        if (typeof target === "string" && target.startsWith("./")) {
          pkg.bin[name] = target.slice(2);
        }
      }
      await Deno.writeTextFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    }
  },
  });
} finally {
  await importMap.cleanup();
}

console.log(`[build-npm] done -> ${outDir}`);
