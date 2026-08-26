import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { expect, test } from "bun:test";

import {
  buildControlD1ReleaseCapability,
  CONTROL_D1_RELEASE_CAPABILITY_KIND,
} from "../../../deploy/platform/control_d1_release_capability.ts";
import { runControlD1SchemaCli } from "../../../deploy/platform/control_d1_schema_cli.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const SOURCE_COMMIT = "a".repeat(40);

test("control D1 release capability proves bounded REST transport without provider credentials", async () => {
  const capability = await buildControlD1ReleaseCapability({
    root: ROOT,
    sourceCommit: SOURCE_COMMIT,
    toolVersion: "1.3.14-test",
    packageVersion: "1.0.0-test",
  });

  expect(capability).toMatchObject({
    kind: CONTROL_D1_RELEASE_CAPABILITY_KIND,
    status: "ready",
    version: 1,
    capabilityVersion: 1,
    sourceCommit: SOURCE_COMMIT,
    tool: {
      name: "bun",
      version: "1.3.14-test",
      packageVersion: "1.0.0-test",
      command: "bun scripts/control-d1-schema.ts release-capability",
    },
    transport: {
      query: {
        endpoint:
          "/client/v4/accounts/:accountId/d1/database/:databaseId/query",
        limitBytes: 100_000,
      },
      statementLimit: {
        limitBytes: 100_000,
        conservativeImportFileBound: true,
        allObservedTransportUnitsWithinLimit: true,
        oversizedImportStatementProbeRejected: true,
      },
      schemaRelease: {
        status: "ready",
        maintenanceStatus: "released",
        verification: { status: "ready" },
        imports: {
          dropTriggerQueryRequestCount: 0,
        },
        zeroQueryDropTriggerRequests: true,
      },
      dropTriggerBatch: {
        queryRequestCount: 0,
        routedToAtomicSqlFileImport: true,
        syntheticLocalRollbackProbe: true,
      },
      importPoll: {
        carriesEveryReturnedAtBookmark: true,
        returnedAtBookmarkCount:
          capability.transport.importPoll.returnedAtBookmarkCount,
        requestedCurrentBookmarkCount:
          capability.transport.importPoll.requestedCurrentBookmarkCount,
      },
    },
  });
  expect(capability.transport.query.maxActualStatementBytes).toBeLessThan(
    capability.transport.query.limitBytes,
  );
  expect(
    capability.transport.statementLimit.maxObservedTransportUnitBytes,
  ).toBeLessThanOrEqual(capability.transport.statementLimit.limitBytes);
  expect(capability.transport.statementLimit.maxImportFileBytes).toBeLessThanOrEqual(
    capability.transport.statementLimit.limitBytes,
  );
  expect(
    capability.transport.schemaRelease.verification.latestMigrationVersion,
  ).toBe(capability.transport.schemaRelease.plan.expectedLatestMigrationVersion);
  expect(
    capability.transport.schemaRelease.verification.migrationCount,
  ).toBe(capability.transport.schemaRelease.plan.expectedMigrationCount);
  expect(
    capability.transport.schemaRelease.imports.dropTriggerStatementCount,
  ).toBeGreaterThan(0);
  expect(
    capability.transport.schemaRelease.imports.dropTriggerImportCount,
  ).toBeGreaterThan(0);
  expect(
    capability.transport.schemaRelease.imports.dropTriggerImportDigest,
  ).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(
    capability.transport.schemaRelease.imports.importPayloadShapeDigest,
  ).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(capability.transport.schemaRelease.digest).toMatch(
    /^sha256:[0-9a-f]{64}$/u,
  );
  expect(capability.transport.importPoll.returnedAtBookmarkCount).toBe(
    capability.transport.importPoll.requestedCurrentBookmarkCount,
  );
  expect(capability.transport.importPoll.bookmarkSequenceDigest).toMatch(
    /^sha256:[0-9a-f]{64}$/u,
  );
  expect(capability.transport.dropTriggerBatch.uploadedSqlDigest).toMatch(
    /^sha256:[0-9a-f]{64}$/u,
  );
  expect(capability.transport.query.maxStatementDigest).toMatch(
    /^sha256:[0-9a-f]{64}$/u,
  );
  expect(capability.source.files.map((file) => file.path)).toEqual([
    "deploy/platform/control_d1_schema_rest.ts",
    "deploy/cloudflare/d1-rest-transport.ts",
    "deploy/platform/control_d1_schema.ts",
    "deploy/platform/control_d1_release_capability.ts",
    "tests/deploy/platform/control_d1_schema_test.ts",
    "tests/deploy/platform/control_d1_release_capability_test.ts",
  ]);
  expect(capability.test.sha256).toBe(capability.test.digest);
  expect(capability.source.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);

  const body = { ...capability } as Record<string, unknown>;
  delete body.digest;
  const canonical = canonicalJson(body);
  expect(capability.digest).toBe(
    `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
  );

  const repeated = await buildControlD1ReleaseCapability({
    root: ROOT,
    sourceCommit: SOURCE_COMMIT,
    toolVersion: "1.3.14-test",
    packageVersion: "1.0.0-test",
  });
  expect(repeated.digest).toBe(capability.digest);
});

test("control D1 release-capability CLI is provider-free and machine-readable", async () => {
  const output: string[] = [];
  const code = await runControlD1SchemaCli(
    ["release-capability"],
    {},
    (value) => output.push(value),
    {
      sourceCommit: SOURCE_COMMIT,
      inspectSourceCheckout: async () => ({
        head: SOURCE_COMMIT,
        clean: true,
      }),
      buildReleaseCapability: async ({ sourceCommit }) =>
        await buildControlD1ReleaseCapability({
          root: ROOT,
          sourceCommit,
          toolVersion: "1.3.14-test",
          packageVersion: "1.0.0-test",
        }),
    },
  );

  expect(code).toBe(0);
  expect(output).toHaveLength(1);
  const transcript = JSON.parse(output[0] ?? "{}") as {
    kind?: string;
    status?: string;
    sourceCommit?: string;
    tool?: { readonly command?: string };
  };
  expect(transcript).toMatchObject({
    kind: CONTROL_D1_RELEASE_CAPABILITY_KIND,
    status: "ready",
    sourceCommit: SOURCE_COMMIT,
    tool: { command: "bun scripts/control-d1-schema.ts release-capability" },
  });
  expect(output.join("\n")).not.toContain("apiToken");
  expect(output.join("\n")).not.toContain("self-test-token");
});

test("release-capability rejects provider or environment arguments", async () => {
  const output: string[] = [];
  const code = await runControlD1SchemaCli(
    ["release-capability", "--environment", "staging"],
    {},
    (value) => output.push(value),
  );

  expect(code).toBe(1);
  expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
    kind: CONTROL_D1_RELEASE_CAPABILITY_KIND,
    status: "failed",
    failureCode: "arguments_invalid",
  });
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
