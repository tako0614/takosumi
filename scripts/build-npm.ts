// dnt build script: produce the @takosjp/takosumi npm package from the
// Deno workspace umbrella (packages/all). Inlines the whole internal graph
// (@takos/takosumi-* / bare takosumi-* specifiers) into ONE npm package via
// scripts/npm-import-map.json.
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

// version comes from the single-package root deno.json
const umbrella = JSON.parse(
  await Deno.readTextFile(fromRoot("deno.json")),
) as { version: string };

// npm export name -> umbrella source file (src/all/*.ts)
const ENTRY_TABLE: Record<string, string> = {
  ".": "src/all/mod.ts",
  "./contract": "src/contract/mod.ts",
  "./installer": "src/installer/mod.ts",
  "./kernel": "src/all/kernel.ts",
  "./cli": "src/all/cli.ts",
  "./runtime-agent": "src/runtime-agent/server.ts",
  "./kinds": "src/all/kinds.ts",
  "./server": "src/all/server.ts",
  "./kind/gateway": "src/kinds/gateway/mod.ts",
  "./kind/kv-store": "src/kinds/kv-store/mod.ts",
  "./kind/message-queue": "src/kinds/message-queue/mod.ts",
  "./kind/object-store": "src/kinds/object-store/mod.ts",
  "./kind/postgres": "src/kinds/postgres/mod.ts",
  "./kind/sqlite": "src/kinds/sqlite/mod.ts",
  "./kind/vector-store": "src/kinds/vector-store/mod.ts",
  "./kind/web-service": "src/kinds/web-service/mod.ts",
  "./kind/worker": "src/kinds/worker/mod.ts",
};

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
const entryPoints = selected.map((name) => {
  const rel = ENTRY_TABLE[name];
  if (!rel) throw new Error(`unknown npm export name: ${name}`);
  return name === "."
    ? { name: ".", path: fromRoot(rel) }
    : { name, path: fromRoot(rel) };
});

const outDir = fromRoot("npm");
await emptyDir(outDir);

console.log(
  `[build-npm] @takosjp/takosumi@${umbrella.version} ` +
    `typeCheck=${typeCheck ?? "none"} entries=${selected.length}`,
);

await build({
  entryPoints,
  outDir,
  importMap: fromRoot("scripts/npm-import-map.json"),
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
      "Takosumi core contract / kernel / installer / cli / runtime-agent / portable kind packages (npm build).",
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
  },
});

console.log(`[build-npm] done -> ${outDir}`);
