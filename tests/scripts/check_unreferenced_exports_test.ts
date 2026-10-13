import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findUnreferencedExports } from "../../scripts/check-unreferenced-exports.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

test("test-only imports do not count as production callers", async () => {
  const root = await fixtureRoot();
  await write(root, "helpers.ts", "export function onlyInTests() {}\n");
  await write(root, "tests/helper_test.ts", `import { onlyInTests } from "../helpers";\nonlyInTests();\n`);

  const report = findUnreferencedExports({
    root,
    target: "helpers.ts",
  });
  expect(report.unreferenced).toEqual(["onlyInTests"]);
});

test("comments, bare imports, and unused named imports do not count", async () => {
  const root = await fixtureRoot();
  await write(
    root,
    "helpers.ts",
    "export function bareImportOnly() {}\nexport function commentOnly() {}\nexport function unusedImport() {}\n",
  );
  await write(
    root,
    "consumer.ts",
    `import "./helpers";\nimport { unusedImport } from "./helpers";\n// commentOnly(); bareImportOnly(); unusedImport();\n`,
  );

  const report = findUnreferencedExports({
    root,
    target: "helpers.ts",
  });
  expect(report.unreferenced).toEqual([
    "bareImportOnly",
    "commentOnly",
    "unusedImport",
  ]);
});

test("renamed imports used through multiple barrels count as callers", async () => {
  const root = await fixtureRoot();
  await write(
    root,
    "helpers.ts",
    "export function usedThroughBarrel() {}\nexport function reexportOnly() {}\n",
  );
  await write(
    root,
    "barrel.ts",
    `export { usedThroughBarrel as renamed } from "./helpers";\nexport { reexportOnly } from "./helpers";\n`,
  );
  await write(
    root,
    "outer-barrel.ts",
    `export { renamed as publicName } from "./barrel";\n`,
  );
  await write(
    root,
    "consumer.ts",
    `import { publicName as localAlias } from "./outer-barrel";\nlocalAlias();\n`,
  );

  const report = findUnreferencedExports({
    root,
    target: "helpers.ts",
  });
  expect(report.unreferenced).toEqual(["reexportOnly"]);
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takosumi-unreferenced-exports-"));
  temporaryRoots.push(root);
  return root;
}

async function write(root: string, relativePath: string, source: string): Promise<void> {
  const destination = join(root, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, source, "utf8");
}
