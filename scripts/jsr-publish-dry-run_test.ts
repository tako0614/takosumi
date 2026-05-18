import assert from "node:assert/strict";
import {
  JSR_PUBLISH_PACKAGES,
  parseDenoPublishWarnings,
  parseDenoWarningCodes,
  parseMode,
  validateDryRunDiagnostics,
} from "./jsr-publish-dry-run.ts";

Deno.test("JSR publish dry-run package list includes only publishable packages", () => {
  assert.deepEqual(
    JSR_PUBLISH_PACKAGES.map((packageInfo) => packageInfo.directory),
    [
      "packages/contract",
      "packages/runtime-agent",
      "packages/plugins",
      "packages/kernel",
      "packages/cli",
      "packages/all",
    ],
  );
});

Deno.test("JSR publish package list matches package metadata", async () => {
  for (const packageInfo of JSR_PUBLISH_PACKAGES) {
    const metadataPath = new URL(
      `../${packageInfo.directory}/deno.json`,
      import.meta.url,
    );
    const metadata = JSON.parse(await Deno.readTextFile(metadataPath)) as {
      name?: string;
      version?: string;
    };
    assert.equal(metadata.name, packageInfo.name);
    assert.equal(metadata.version, packageInfo.version);
  }
});

Deno.test("parseDenoPublishWarnings extracts warning codes and source locations", () => {
  const warnings = parseDenoPublishWarnings(`
warning[unanalyzable-dynamic-import]: unable to analyze dynamic import
  --> /workspace/packages/kernel/src/plugins/loader.ts:26:33

warning[slow-types]: exported function has slow types
  --> /workspace/packages/kernel/src/index.ts:1:1
`);

  assert.deepEqual(warnings, [
    {
      code: "unanalyzable-dynamic-import",
      location: "/workspace/packages/kernel/src/plugins/loader.ts",
    },
    {
      code: "slow-types",
      location: "/workspace/packages/kernel/src/index.ts",
    },
  ]);
  assert.deepEqual(parseDenoWarningCodes("warning[example]: text"), [
    "example",
  ]);
});

Deno.test("validateDryRunDiagnostics rejects dynamic imports from the kernel package after marketplace deletion", () => {
  const kernel = JSR_PUBLISH_PACKAGES.find((packageInfo) =>
    packageInfo.name === "@takos/takosumi-kernel"
  );
  assert.ok(kernel);

  // Wave 9 Phase C deleted the plugin marketplace + dynamic loader paths.
  // The kernel package no longer accepts any dynamic-import warnings; if a
  // future change reintroduces one it must explicitly add the path back to
  // `acceptedWarnings` in the publish spec.
  const diagnostics = validateDryRunDiagnostics(
    kernel,
    `
warning[unanalyzable-dynamic-import]: unable to analyze dynamic import
  --> /workspace/packages/kernel/src/plugins/loader.ts:26:33
`,
  );

  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.errors.length, 1);
});

Deno.test("validateDryRunDiagnostics rejects unexpected publish warnings", () => {
  const contract = JSR_PUBLISH_PACKAGES[0];
  const diagnostics = validateDryRunDiagnostics(
    contract,
    `
warning[unanalyzable-dynamic-import]: unable to analyze dynamic import
  --> /workspace/packages/contract/src/mod.ts:1:1
`,
  );

  assert.equal(diagnostics.ok, false);
  assert.deepEqual(diagnostics.errors, [
    "@takos/takosumi-contract emitted unexpected warning[unanalyzable-dynamic-import] at /workspace/packages/contract/src/mod.ts",
  ]);
});

Deno.test("parseMode accepts explicit modes and rejects unknown args", () => {
  assert.equal(parseMode([]), "dry-run");
  assert.equal(parseMode(["--dry-run"]), "dry-run");
  assert.equal(parseMode(["--publish"]), "publish");
  assert.equal(parseMode(["--publish", "--dry-run"]), null);
  assert.equal(parseMode(["--unknown"]), null);
});
