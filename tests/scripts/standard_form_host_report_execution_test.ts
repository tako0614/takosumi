import { expect, test } from "bun:test";
import type { JsonObject } from "takosumi-contract";

import type { ResourceShapeSchemaParser } from "../../core/domains/resource-shape/mod.ts";
import { executeCurrentHostReports } from "../../scripts/standard-form-host-report.ts";

const LIFECYCLE = [
  "create",
  "read",
  "update",
  "delete",
  "import",
  "observe",
  "refresh",
  "drift",
] as const;

test("current host report executes the EdgeWorker v3 lifecycle", async () => {
  const desired: JsonObject = {
    entrypoint: "worker.mjs",
    name: "edge-worker",
    source: {
      artifactMediaType: "application/vnd.takoform.edge-worker+tar",
      artifactSha256: "0".repeat(64),
      artifactUrl: "https://artifacts.example.test/edge-worker.tar",
    },
  };
  const invalidDesired: JsonObject = {
    entrypoint: "worker.mjs",
    source: desired.source,
  };
  const schemaParser: ResourceShapeSchemaParser = (spec) =>
    isRecord(spec) &&
    typeof spec.name === "string" &&
    typeof spec.entrypoint === "string" &&
    isRecord(spec.source)
      ? {
          ok: true,
          value: { spec: spec as JsonObject, interfaces: [] },
        }
      : {
          ok: false,
          error: {
            code: "invalid_argument",
            message: "EdgeWorker desired state is invalid",
          },
        };
  const schemaDigest = `sha256:${"1".repeat(64)}`;
  const packageDigest = `sha256:${"2".repeat(64)}`;
  const fixtureDigest = `sha256:${"3".repeat(64)}`;
  const negativeDigest = `sha256:${"4".repeat(64)}`;
  const identity = {
    type: "edge_worker",
    version: "3.0.0",
    schemaDigest,
    packageDigest,
  };

  const reports = await executeCurrentHostReports([
    {
      package: {
        kind: "EdgeWorker",
        slug: "edge-worker",
        sourcePath: "forms/releases/edge-worker/2.0.0",
        formRef: {
          apiVersion: "forms.takoform.com/v1alpha1",
          kind: "EdgeWorker",
          definitionVersion: "3.0.0",
          schemaDigest,
        },
        packageDigest,
      },
      candidate: { kind: "EdgeWorker", slug: "edge-worker", identity },
      definition: {
        apiVersion: "forms.takoform.com/v1alpha1",
        kind: "EdgeWorker",
        definitionVersion: "3.0.0",
        desiredSchema: {},
        immutableFields: ["/name", "/source"],
        lifecycleCapabilities: LIFECYCLE,
        conformanceFixtures: [
          { name: "canonical", desiredPath: "fixtures/desired.json" },
        ],
        negativeConformanceFixtures: [
          {
            name: "reject-missing-name",
            stage: "desired",
            inputPath: "fixtures/negative-missing-name.json",
            expectedFailure: "schema_validation_failed",
          },
        ],
      },
      packageRoot: "/unused",
      desired,
      updatedDesired: {
        ...desired,
        configuration: { LOG_LEVEL: "debug" },
      },
      positiveName: "canonical",
      positivePackageDigest: fixtureDigest,
      negativeFixtures: [
        {
          name: "reject-missing-name",
          stage: "desired",
          input: invalidDesired,
          expectedErrorCode: "invalid_argument",
        },
      ],
      negativePackageDigests: {
        "reject-missing-name": negativeDigest,
      },
      schemaParser,
    },
  ]);

  expect(reports).toHaveLength(1);
  expect(reports[0]?.execution.status).toBe("passed");
  expect(reports[0]?.execution.checks).toContain("update");
  expect(reports[0]?.execution.checks).toContain("negative-fixtures");
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
