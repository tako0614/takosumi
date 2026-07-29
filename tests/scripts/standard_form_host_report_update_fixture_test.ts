import { expect, test } from "bun:test";
import type { JsonObject } from "takosumi-contract";

import type { ResourceShapeSchemaParser } from "../../core/domains/resource-shape/mod.ts";
import { buildCurrentHostReportUpdateFixture } from "../../scripts/standard-form-host-report.ts";

test("current host report updates EdgeWorker through mutable portable configuration", () => {
  const desired: JsonObject = {
    name: "edge-worker",
    configuration: { LOG_LEVEL: "info" },
    source: {
      artifactMediaType: "application/vnd.takoform.edge-worker+tar",
      artifactSha256: "0".repeat(64),
      artifactUrl: "https://artifacts.example.test/edge-worker.tar",
    },
  };
  const parser: ResourceShapeSchemaParser = (spec) => ({
    ok: true,
    value: { spec: spec as JsonObject, interfaces: [] },
  });

  const updated = buildCurrentHostReportUpdateFixture(
    "EdgeWorker",
    desired,
    ["/name", "/source"],
    parser,
  );

  expect(updated).toEqual({
    ...desired,
    configuration: { LOG_LEVEL: "debug" },
  });
  expect(desired.configuration).toEqual({ LOG_LEVEL: "info" });
});

test("current host report updates ModelEndpoint through max concurrency", () => {
  const desired: JsonObject = {
    maxConcurrency: 8,
    name: "model-endpoint",
    source: {
      artifactMediaType: "application/vnd.safetensors",
      artifactSha256: "f".repeat(64),
      artifactUrl: "https://artifacts.example.test/model.safetensors",
    },
    task: "embedding",
  };
  const parser: ResourceShapeSchemaParser = (spec) =>
    typeof spec === "object" &&
    spec !== null &&
    !Array.isArray(spec) &&
    !("model" in spec) &&
    spec.maxConcurrency === 9
      ? {
          ok: true,
          value: { spec: spec as JsonObject, interfaces: [] },
        }
      : {
          ok: false,
          error: {
            code: "invalid_argument",
            message: "expected a schema-valid maxConcurrency update",
          },
        };

  const updated = buildCurrentHostReportUpdateFixture(
    "ModelEndpoint",
    desired,
    ["/name"],
    parser,
  );

  expect(updated).toEqual({ ...desired, maxConcurrency: 9 });
});
