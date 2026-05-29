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
const fromRootUrl = (p: string) => new URL(p, ROOT).href;

// dnt module mappings: swap each Deno-runtime subprocess/serve primitive for
// its Node sibling in the npm output ONLY. The Deno source keeps using
// Deno.Command / Deno.serve unchanged (verified by `deno task check` and the
// package tests); these mappings make the emitted npm package both typeable
// (no Deno.* on the type surface dnt checks) and runnable on Node via
// node:child_process / node:http. The exported API of each pair is identical.
const SUBPROCESS_MAPPINGS: Record<string, string> = {
  [fromRootUrl("packages/installer/src/subprocess/git-runner.ts")]: fromRootUrl(
    "packages/installer/src/subprocess/git-runner.node.ts",
  ),
  [fromRootUrl("packages/installer/src/subprocess/tar-runner.ts")]: fromRootUrl(
    "packages/installer/src/subprocess/tar-runner.node.ts",
  ),
  [fromRootUrl("packages/runtime-agent/src/subprocess/tar-runner.ts")]:
    fromRootUrl(
      "packages/runtime-agent/src/subprocess/tar-runner.node.ts",
    ),
  [fromRootUrl("packages/runtime-agent/src/subprocess/serve.ts")]: fromRootUrl(
    "packages/runtime-agent/src/subprocess/serve.node.ts",
  ),
  [fromRootUrl("packages/cli/src/commands/migrate-runtime.ts")]: fromRootUrl(
    "packages/cli/src/commands/migrate-runtime.node.ts",
  ),
};

// version comes from packages/all/deno.json (umbrella)
const umbrella = JSON.parse(
  await Deno.readTextFile(fromRoot("packages/all/deno.json")),
) as { version: string };

// npm export name -> umbrella source file (packages/all/*.ts)
const ENTRY_TABLE: Record<string, string> = {
  ".": "packages/all/mod.ts",
  "./contract": "packages/all/contract.ts",
  "./installer": "packages/all/installer.ts",
  "./kernel": "packages/all/kernel.ts",
  "./cli": "packages/all/cli.ts",
  "./runtime-agent": "packages/all/runtime-agent.ts",
  "./kinds": "packages/all/kinds.ts",
  "./server": "packages/all/server.ts",
  "./kind/gateway": "packages/all/kind-gateway.ts",
  "./kind/kv-store": "packages/all/kind-kv-store.ts",
  "./kind/message-queue": "packages/all/kind-message-queue.ts",
  "./kind/object-store": "packages/all/kind-object-store.ts",
  "./kind/postgres": "packages/all/kind-postgres.ts",
  "./kind/sqlite": "packages/all/kind-sqlite.ts",
  "./kind/vector-store": "packages/all/kind-vector-store.ts",
  "./kind/web-service": "packages/all/kind-web-service.ts",
  "./kind/worker": "packages/all/kind-worker.ts",
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
  mappings: SUBPROCESS_MAPPINGS,
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
