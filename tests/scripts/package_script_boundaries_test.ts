import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  findEscapingReferences,
  findPackageScriptBoundaryViolations,
} from "../../scripts/lib/package-script-boundaries";

const ROOT = new URL("../../", import.meta.url).pathname;

test("all package commands stay inside a standalone Takosumi clone", async () => {
  assert.deepEqual(await findPackageScriptBoundaryViolations(ROOT), []);
});

test("package command boundary detects a parent checkout dependency", () => {
  const violations = findEscapingReferences({
    root: "/checkout/takosumi",
    manifestDirectory: "/checkout/takosumi",
    manifestPath: "/checkout/takosumi/package.json",
    scriptName: "ga:status",
    command: "bun ../scripts/report-takosumi-completion-status.mjs",
  });

  assert.deepEqual(violations, [
    {
      manifestPath: "package.json",
      scriptName: "ga:status",
      reference: "../scripts/report-takosumi-completion-status.mjs",
      resolvedPath: "/checkout/scripts/report-takosumi-completion-status.mjs",
    },
  ]);
});

test("package command boundary allows traversal that remains inside the clone", () => {
  assert.deepEqual(
    findEscapingReferences({
      root: "/checkout/takosumi",
      manifestDirectory: "/checkout/takosumi",
      manifestPath: "/checkout/takosumi/package.json",
      scriptName: "app-docs:build",
      command: "cd app-docs && ../docs/node_modules/.bin/vitepress build",
    }),
    [],
  );
});
