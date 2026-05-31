// dnt build script: produce the @takosjp/takosumi npm package from the Deno
// source. deno.json is the single source of truth — its `exports` become the
// dnt entry points and its `imports` map is fed straight to dnt (no duplicated
// ENTRY_TABLE / npm-import-map.json). Inlines the internal bare-specifier graph
// into ONE npm package.
//
// Usage: deno run -A scripts/build-npm.ts
//   --typecheck=both|single|none   (default: single)
//   --no-typecheck                 (alias for none)
//   --entry=.,./contract,...       (restrict to a comma list of npm exports)
//
// DO NOT npm publish from here; this only builds + lets you `npm pack`.

import { build, emptyDir } from "jsr:@deno/dnt@0.42.3";

const HERE = new URL(".", import.meta.url);
const ROOT = new URL("../", HERE);
const fromRoot = (p: string) => new URL(p, ROOT).pathname;

// The subprocess/serve primitives are runtime-detecting single modules: they
// use a local `declare const Deno` type (so the dnt typecheck surface never
// touches Deno.*) and branch on `globalThis.Deno` at call time, running
// `Deno.Command` / `Deno.serve` on Deno and `node:child_process` / `node:http`
// on Node. The npm build therefore needs no module mappings.

// deno.json is the single source of truth — version, the npm `exports` (which
// become the dnt entry points), and the internal `imports` map (fed straight to
// dnt). No duplicated ENTRY_TABLE / npm-import-map.json.
const umbrella = JSON.parse(
  await Deno.readTextFile(fromRoot("deno.json")),
) as { version: string; exports: Record<string, string> };

// npm export name -> source file, derived from deno.json `exports`.
const ENTRY_TABLE: Record<string, string> = Object.fromEntries(
  Object.entries(umbrella.exports).map(
    ([name, rel]) => [name, rel.replace(/^\.\//, "")],
  ),
);

function parseArgs() {
  let typeCheck: "both" | "single" | undefined = "single";
  let entries: string[] | undefined;
  for (const arg of Deno.args) {
    if (arg === "--no-typecheck" || arg === "--typecheck=none") {
      typeCheck = undefined;
    } else if (arg.startsWith("--typecheck=")) {
      const v = arg.slice("--typecheck=".length);
      if (v === "both" || v === "single") typeCheck = v;
      else if (v === "none") typeCheck = undefined;
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
  `[build-npm] @takosjp/takosumi@${umbrella.version} ` +
    `typeCheck=${typeCheck ?? "none"} entries=${selected.length}`,
);

await build({
  entryPoints,
  outDir,
  importMap: fromRoot("deno.json"),
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
    // Workspace deno.json uses lib ["deno.window","dom","dom.iterable"].
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
    version: umbrella.version,
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

console.log(`[build-npm] done -> ${outDir}`);
