import { expect, test } from "bun:test";
import type { TargetImplementationDescriptor } from "takosumi-contract";
import {
  parseContainerServiceSpec,
  parseEdgeWorkerSpec,
  parseKVStoreSpec,
  parseObjectBucketSpec,
  parseQueueSpec,
  parseResourceSpec,
  parseSQLDatabaseSpec,
  planResourceShape,
  MapResourceShapeSchemaRegistry,
} from "../../../../core/domains/resource-shape/planner.ts";
import { TEST_RESOURCE_SHAPE_MODULE_REGISTRY } from "../../../helpers/resource-shape/operator-module-registry.ts";

const target = {
  name: "operator-primary",
  type: "operator.example/runtime.v3",
  ref: "target-account",
  region: "region-a",
  priority: 10,
} as const;

const bucketDescriptor: TargetImplementationDescriptor = {
  shape: "ObjectBucket",
  implementation: "operator.bucket.module.v2",
  interfaces: { object_store: "native", s3_api: "native" },
  nativeResourceType: "operator.bucket",
  providerSource: "registry.example.test/acme/object-store",
  moduleTemplate: "cloudflare-r2-bucket",
  moduleInputMappings: {
    bucketName: { source: "spec", path: "/name", required: true },
    accountId: { source: "target", path: "/ref", required: true },
    region: { source: "target", path: "/region", default: "default" },
    immutableMode: { source: "literal", value: true },
    optional: { source: "spec", path: "/missing" },
  },
  moduleOutputs: [
    { name: "bucket_name", type: "string" },
    { name: "s3_endpoint", type: "url" },
  ],
};

test("bundled parsers keep six typed Resource Shape schemas", () => {
  expect(
    parseEdgeWorkerSpec({
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
      compatibilityFlags: ["nodejs_compat"],
    }).ok,
  ).toBe(true);
  expect(
    parseObjectBucketSpec({ name: "assets", interfaces: ["s3_api"] }).ok,
  ).toBe(true);
  expect(parseKVStoreSpec({ name: "cache", consistency: "eventual" }).ok).toBe(
    true,
  );
  expect(
    parseQueueSpec({ name: "events", delivery: { maxRetries: 3 } }).ok,
  ).toBe(true);
  expect(parseSQLDatabaseSpec({ name: "main", engine: "sqlite" }).ok).toBe(
    true,
  );
  expect(
    parseSQLDatabaseSpec({ name: "analytics", engine: "cockroachdb.v24" }).ok,
  ).toBe(true);
  expect(
    parseContainerServiceSpec({
      name: "agent",
      image: "ghcr.io/example/agent:1.0.0",
      publicHttp: true,
    }).ok,
  ).toBe(true);
});

test("EdgeWorker parser rejects ambiguous and unverifiable artifacts", () => {
  const ambiguous = parseEdgeWorkerSpec({
    name: "api",
    source: {
      artifactPath: "/work/api.js",
      artifactUrl: "https://example.test/api.js",
      artifactSha256: "1".repeat(64),
    },
  });
  expect(ambiguous.ok).toBe(false);

  const missingDigest = parseEdgeWorkerSpec({
    name: "api",
    source: { artifactUrl: "https://example.test/api.js" },
  });
  expect(missingDigest.ok).toBe(false);
  if (!missingDigest.ok) {
    expect(missingDigest.error.message).toContain("artifactSha256");
  }
});

test("typed parser accepts only non-secret Resource references in connections", () => {
  const parsed = parseEdgeWorkerSpec({
    name: "api",
    source: { artifactPath: "/work/api.js" },
    connections: {
      API_TOKEN: {
        resource: "ObjectBucket/assets",
        permissions: ["object.read", "retention:inspect"],
        projection: "sdk_client.v2",
      },
    },
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.spec.connections?.API_TOKEN?.resource).toBe(
    "ObjectBucket/assets",
  );
  expect(parsed.spec.connections?.API_TOKEN?.permissions).toEqual([
    "object.read",
    "retention:inspect",
  ]);
  expect(parsed.spec.connections?.API_TOKEN?.projection).toBe("sdk_client.v2");
});

test("unknown shapes fail closed instead of accepting opaque JSON", () => {
  const parsed = parseResourceSpec("CacheCluster", {
    name: "cache",
    replicas: 3,
  });
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.error.code).toBe("unsupported_shape");
});

test("operator-defined shape schemas are explicit, validated, and plannable", () => {
  const schemas = new MapResourceShapeSchemaRegistry({
    CacheCluster: (raw) => {
      if (
        typeof raw !== "object" ||
        raw === null ||
        Array.isArray(raw) ||
        typeof (raw as Record<string, unknown>).name !== "string"
      ) {
        return {
          ok: false as const,
          error: { code: "invalid_name", message: "name is required" },
        };
      }
      return {
        ok: true as const,
        value: {
          spec: JSON.parse(JSON.stringify(raw)) as {
            name: string;
            replicas?: number;
          },
          interfaces: ["cache.protocol.v1"],
        },
      };
    },
  });
  const parsed = parseResourceSpec(
    "CacheCluster",
    { name: "sessions", replicas: 3 },
    schemas,
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.parsed.schema).toBe("registered");
  expect(parsed.parsed.interfaces).toEqual(["cache.protocol.v1"]);

  const plan = planResourceShape(
    {
      shape: "CacheCluster",
      implementation: "operator.cache.v1",
      interfaces: { "cache.protocol.v1": "native" },
      nativeResourceType: "operator.cache_cluster",
      plugin: "operator-cache-plugin",
      moduleOutputs: [{ name: "endpoint", type: "url" }],
    },
    parsed.parsed,
    target,
  );
  expect(plan.shape).toBe("CacheCluster");
  expect(plan.executionId).toBe("adapter-plugin:operator-cache-plugin");

  const secret = parseResourceSpec(
    "CacheCluster",
    { name: "sessions", apiToken: "sk-secret-shaped-value" },
    schemas,
  );
  expect(secret.ok).toBe(false);
  if (!secret.ok) expect(secret.error.code).toBe("invalid_spec");
});

test("registered schemas cannot shadow bundled typed shapes", () => {
  expect(
    () =>
      new MapResourceShapeSchemaRegistry({
        EdgeWorker: () => ({
          ok: true as const,
          value: { spec: {}, interfaces: [] },
        }),
      }),
  ).toThrow("must not shadow bundled kind EdgeWorker");
});

test("planner projects only explicit descriptor mappings", () => {
  const parsed = parseResourceSpec("ObjectBucket", {
    name: "assets",
    interfaces: ["s3_api"],
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;

  const plan = planResourceShape(
    bucketDescriptor,
    parsed.parsed,
    target,
    TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  );
  expect(plan.moduleTemplate).toBe("cloudflare-r2-bucket");
  expect(plan.inputs).toEqual({
    bucketName: "assets",
    accountId: "target-account",
    region: "region-a",
    immutableMode: true,
  });
  expect(plan.publicOutputs).toEqual(bucketDescriptor.moduleOutputs);
  expect(plan.operatorModule?.files.length).toBeGreaterThan(0);
});

test("plugin descriptor selects only the explicit plugin execution path", () => {
  const parsed = parseResourceSpec("ObjectBucket", { name: "assets" });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const plugin: TargetImplementationDescriptor = {
    shape: "ObjectBucket",
    implementation: "operator.bucket.plugin",
    interfaces: { object_store: "native" },
    plugin: "operator-bucket-plugin",
    moduleOutputs: [{ name: "endpoint", type: "url" }],
  };
  const plan = planResourceShape(plugin, parsed.parsed, target);
  expect(plan.executionId).toBe("adapter-plugin:operator-bucket-plugin");
  expect(plan.operatorModule).toBeUndefined();
  expect(plan.inputs).toEqual({});
  expect(plan.requiresAdapterPlugin).toBe(true);
});

test("planner rejects descriptor/shape mismatch and missing execution path", () => {
  const parsed = parseResourceSpec("ObjectBucket", { name: "assets" });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(() =>
    planResourceShape(
      { ...bucketDescriptor, shape: "KVStore" },
      parsed.parsed,
      target,
    ),
  ).toThrow("does not match");
  expect(() =>
    planResourceShape(
      {
        ...bucketDescriptor,
        providerSource: undefined,
        moduleTemplate: undefined,
      },
      parsed.parsed,
      target,
    ),
  ).toThrow("providerSource + moduleTemplate");
  expect(() =>
    planResourceShape(bucketDescriptor, parsed.parsed, target),
  ).toThrow("operator module registry has no entry");
});
