/**
 * `contract/package.json` `files` is DERIVED from `exports`, not hand-listed.
 *
 * WHY. The two statements drifted, and the drift was invisible until someone
 * imported the package. `files` named 13 of 57 modules while the repository's
 * own consumers imported `runs`, `capsules`, `workspaces` and the
 * deploy-control API from `contract/` directly — so every wire type an external
 * consumer tracks was importable here and absent from the published bytes. That
 * is the same failure the broken `./client-api` export shipped elsewhere in the
 * ecosystem: a hand-listed `files` array is a second statement of what the
 * package contains, and nothing dereferenced it.
 *
 * The package is still CURATED on purpose: host-internal contracts
 * (`index.ts`, `internal-*.ts`, `interface-display.ts`, `reference/`) are
 * deliberately not published. Curation and derivation are compatible — the
 * curated thing is `exports`, and `files` is exactly what those exports need:
 * every export target plus everything it transitively imports.
 *
 * So this computes the closure by reading the real import graph and diffs it
 * against what is committed (regenerate-and-diff). Adding an export adds its
 * closure with no second edit; forgetting one is a gate failure, not a bug
 * report from a consumer.
 *
 * Run: `bun scripts/check-contract-package-files.ts --check`
 *      `bun scripts/check-contract-package-files.ts --write`
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import ts from "typescript";

const CONTRACT = resolve(import.meta.dir, "../contract");
const MANIFEST = join(CONTRACT, "package.json");

/** Files that are published because a human said so, not because code imports them. */
export const CONTRACT_PACKAGE_LITERALS = ["LICENSE", "README.md"] as const;

export interface ContractManifest {
  readonly files?: readonly string[];
  readonly exports?: Readonly<Record<string, string>>;
}

/** Every relative specifier a module imports or re-exports. */
export function relativeSpecifiers(source: string, path: string): readonly string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const specifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : undefined;
    if (specifier?.startsWith(".")) found.push(specifier);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The transitive closure of every export target, as package-relative paths. */
export function contractPackageFiles(
  manifest: ContractManifest,
  read: (relativePath: string) => string = (relativePath) =>
    readFileSync(join(CONTRACT, relativePath), "utf8"),
): readonly string[] {
  const targets = Object.values(manifest.exports ?? {});
  if (targets.length === 0) {
    throw new Error("contract/package.json declares no exports");
  }
  const seen = new Set<string>();
  const queue = targets.map((target) => target.replace(/^\.\//u, ""));
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const specifier of relativeSpecifiers(read(current), current)) {
      const resolved = relative(
        ".",
        join(dirname(current), specifier),
      ).replaceAll("\\", "/");
      if (resolved.startsWith("..")) {
        throw new Error(
          `${current} imports ${specifier}, which leaves the package directory`,
        );
      }
      queue.push(resolved);
    }
  }
  return [...seen, ...CONTRACT_PACKAGE_LITERALS].sort();
}

function readManifest(): ContractManifest & Record<string, unknown> {
  return JSON.parse(readFileSync(MANIFEST, "utf8")) as ContractManifest &
    Record<string, unknown>;
}

if (import.meta.main) {
  const manifest = readManifest();
  const derived = contractPackageFiles(manifest);
  for (const path of derived) {
    if (!existsSync(join(CONTRACT, path))) {
      process.stderr.write(`contract package file does not exist: ${path}\n`);
      process.exit(1);
    }
  }
  if (process.argv.includes("--write")) {
    writeFileSync(
      MANIFEST,
      `${JSON.stringify({ ...manifest, files: derived }, null, 2)}\n`,
    );
    process.stdout.write(
      `contract package files written: ${derived.length} entries\n`,
    );
  } else {
    const declared = [...(manifest.files ?? [])];
    const missing = derived.filter((path) => !declared.includes(path));
    const extra = declared.filter((path) => !derived.includes(path));
    if (missing.length > 0 || extra.length > 0) {
      process.stderr.write(
        "contract/package.json `files` does not match the export closure:\n",
      );
      for (const path of missing) process.stderr.write(`- missing ${path}\n`);
      for (const path of extra) process.stderr.write(`- unreachable ${path}\n`);
      process.stderr.write(
        "\nRun `bun scripts/check-contract-package-files.ts --write`. `files` is\n" +
          "every export target plus everything it transitively imports; an entry\n" +
          "nothing exported reaches is a file the package ships for no reason.\n",
      );
      process.exit(1);
    }
    process.stdout.write(
      `contract package files ok: ${derived.length} entries derived from ` +
        `${Object.keys(manifest.exports ?? {}).length} export subpaths\n`,
    );
  }
}
