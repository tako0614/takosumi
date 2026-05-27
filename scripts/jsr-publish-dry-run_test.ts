import assert from "node:assert/strict";
import {
  checkJsrTargetPublication,
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
      "packages/installer",
      "packages/runtime-agent",
      "packages/kind-gateway",
      "packages/kind-kv-store",
      "packages/kind-message-queue",
      "packages/kind-object-store",
      "packages/kind-postgres",
      "packages/kind-sqlite",
      "packages/kind-vector-store",
      "packages/kind-web-service",
      "packages/kind-worker",
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

Deno.test("checkJsrTargetPublication skips already published target versions", async () => {
  const result = await checkJsrTargetPublication(
    {
      name: "@takos/example",
      version: "1.2.0",
      directory: "packages/example",
    },
    {
      registryBaseUrl: "https://jsr.test",
      fetch: fakeFetch({
        "https://jsr.test/@takos/example/meta.json": {
          versions: {
            "1.0.0": {},
            "1.2.0": {},
          },
        },
      }),
    },
  );

  assert.deepEqual(result, {
    name: "@takos/example",
    targetVersion: "1.2.0",
    status: "published",
  });
});

Deno.test("checkJsrTargetPublication publishes missing packages and missing target versions", async () => {
  const fetchImpl = fakeFetch({
    "https://jsr.test/@takos/example-old/meta.json": {
      versions: {
        "1.0.0": {},
      },
    },
  });

  assert.equal(
    (await checkJsrTargetPublication(
      {
        name: "@takos/example-old",
        version: "1.2.0",
        directory: "packages/example-old",
      },
      { registryBaseUrl: "https://jsr.test", fetch: fetchImpl },
    )).status,
    "publish-needed",
  );
  assert.equal(
    (await checkJsrTargetPublication(
      {
        name: "@takos/example-missing",
        version: "0.1.0",
        directory: "packages/example-missing",
      },
      { registryBaseUrl: "https://jsr.test", fetch: fetchImpl },
    )).status,
    "publish-needed",
  );
});

Deno.test("parseMode accepts explicit modes and rejects unknown args", () => {
  assert.equal(parseMode([]), "dry-run");
  assert.equal(parseMode(["--dry-run"]), "dry-run");
  assert.equal(parseMode(["--publish"]), "publish");
  assert.equal(parseMode(["--publish", "--dry-run"]), null);
  assert.equal(parseMode(["--unknown"]), null);
});

function fakeFetch(fixtures: Readonly<Record<string, unknown>>): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    if (!(url in fixtures)) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.resolve(Response.json(fixtures[url]));
  }) as typeof fetch;
}
