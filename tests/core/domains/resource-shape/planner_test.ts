import { expect, test } from "bun:test";
import type { TargetImplementationDescriptor } from "takosumi-contract";
import {
  parseContainerServiceSpec,
  parseDurableWorkflowSpec,
  parseEdgeWorkerSpec,
  parseKVStoreSpec,
  parseObjectBucketSpec,
  parseQueueSpec,
  parseResourceSpec as parseCoreResourceSpec,
  parseScheduleSpec,
  parseSQLDatabaseSpec,
  parseStatefulActorNamespaceSpec,
  parseVectorIndexSpec,
  planResourceShape,
  MapResourceShapeSchemaRegistry,
  LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
} from "../../../../core/domains/resource-shape/planner.ts";
import { TEST_RESOURCE_SHAPE_MODULE_REGISTRY } from "../../../helpers/resource-shape/operator-module-registry.ts";

const parseResourceSpec: typeof parseCoreResourceSpec = (
  kind,
  spec,
  registry = LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
) => parseCoreResourceSpec(kind, spec, registry);

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
    storageClass: {
      source: "spec",
      path: "/storageClass",
      required: true,
    },
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

test("bundled parsers keep ten typed Resource Shape schemas", () => {
  expect(
    parseEdgeWorkerSpec({
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
      compatibilityFlags: ["nodejs_compat"],
    }).ok,
  ).toBe(true);
  const bucket = parseObjectBucketSpec({
    name: "assets",
    storageClass: "infrequent_access",
    interfaces: ["s3_api"],
  });
  expect(bucket.ok).toBe(true);
  if (bucket.ok) {
    expect(bucket.spec.storageClass).toBe("infrequent_access");
  }
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
  expect(
    parseVectorIndexSpec({ name: "embeddings", dimensions: 1536 }).ok,
  ).toBe(true);
  expect(
    parseDurableWorkflowSpec({
      name: "ingest",
      source: { artifactPath: "/work/dist/workflow.js" },
      entrypoint: "IngestWorkflow",
    }).ok,
  ).toBe(true);
  expect(
    parseStatefulActorNamespaceSpec({
      name: "rooms",
      className: "RoomActor",
    }).ok,
  ).toBe(true);
  expect(
    parseScheduleSpec({
      name: "nightly",
      cron: "0 0 * * *",
      connections: {
        workflow: {
          resource: "DurableWorkflow/ingest",
          permissions: ["invoke"],
          projection: "schedule_trigger",
        },
      },
    }).ok,
  ).toBe(true);
});

test("Core parser has zero implicit Resource Shape compatibility schemas", () => {
  const desired = {
    name: "api",
    source: { artifactPath: "/work/dist/worker.js" },
  };
  const absent = parseCoreResourceSpec("EdgeWorker", desired);
  expect(absent.ok).toBe(false);
  if (!absent.ok) {
    expect(absent.error.code).toBe("unsupported_shape");
    expect(absent.error.message).toContain("is not installed");
  }

  const explicitlyInstalled = parseResourceSpec("EdgeWorker", desired);
  expect(explicitlyInstalled.ok).toBe(true);
});

test("ObjectBucket defaults storageClass and rejects non-portable values", () => {
  const legacy = parseObjectBucketSpec({ name: "legacy-assets" });
  expect(legacy.ok).toBe(true);
  if (legacy.ok) expect(legacy.spec.storageClass).toBe("standard");

  const invalid = parseObjectBucketSpec({
    name: "assets",
    storageClass: "provider-cold-tier",
  });
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.error.code).toBe("invalid_storage_class");

  const infrequent = parseResourceSpec("ObjectBucket", {
    name: "archive",
    storageClass: "infrequent_access",
  });
  expect(infrequent.ok).toBe(true);
  if (infrequent.ok) {
    expect(infrequent.parsed.interfaces).toContain(
      "storage_class_infrequent_access",
    );
  }
});

test("new service shapes enforce shape-specific portable validation", () => {
  expect(parseVectorIndexSpec({ name: "bad", dimensions: 0 }).ok).toBe(false);
  expect(
    parseVectorIndexSpec({ name: "bad", dimensions: 384, metric: "bad metric" })
      .ok,
  ).toBe(false);

  const workflow = parseDurableWorkflowSpec({
    name: "ingest",
    source: { artifactUrl: "https://example.test/workflow.js" },
    entrypoint: "IngestWorkflow",
  });
  expect(workflow.ok).toBe(false);
  if (!workflow.ok) expect(workflow.error.message).toContain("artifactSha256");
  expect(
    parseDurableWorkflowSpec({
      name: "ingest",
      source: {
        artifactUrl: "https://example.test/workflow.js",
        artifactSha256: "not-a-digest",
      },
      entrypoint: "IngestWorkflow",
    }).ok,
  ).toBe(false);
  expect(
    parseDurableWorkflowSpec({
      name: "ingest",
      source: { artifactPath: "/work/workflow.js" },
      entrypoint: "IngestWorkflow",
      retry: { maxAttempts: 0 },
    }).ok,
  ).toBe(false);

  expect(
    parseStatefulActorNamespaceSpec({
      name: "rooms",
      className: "Room Actor",
    }).ok,
  ).toBe(false);
  expect(
    parseScheduleSpec({
      name: "quartz-only",
      cron: "0 0 0 * * *",
      connections: {},
    }).ok,
  ).toBe(false);
  expect(
    parseScheduleSpec({
      name: "out-of-range",
      cron: "60 0 * * *",
      connections: {
        workflow: {
          resource: "DurableWorkflow/ingest",
          permissions: ["invoke"],
          projection: "schedule_trigger",
        },
      },
    }).ok,
  ).toBe(false);
});

test("StatefulActorNamespace owns namespaces, never actor instances", () => {
  const namespace = parseResourceSpec("StatefulActorNamespace", {
    name: "rooms",
    className: "RoomActor",
    actorInstanceId: "room-123",
  });
  expect(namespace.ok).toBe(true);
  if (!namespace.ok) return;
  expect("actorInstanceId" in namespace.parsed.spec).toBe(false);
  expect(
    parseResourceSpec("StatefulActor", {
      name: "room-123",
      namespace: "rooms",
    }).ok,
  ).toBe(false);
});

test("new typed shapes preserve descriptor public outputs", () => {
  const parsed = parseResourceSpec("VectorIndex", {
    name: "embeddings",
    dimensions: 1536,
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const descriptor: TargetImplementationDescriptor = {
    shape: "VectorIndex",
    implementation: "operator.vector.v1",
    interfaces: {
      vector_index: "native",
      vector_query: "native",
      runtime_binding: "native",
      cosine: "native",
    },
    plugin: "operator-vector-plugin",
    moduleOutputs: [
      { name: "index_id", type: "string" },
      { name: "endpoint", type: "url" },
    ],
  };
  const plan = planResourceShape(descriptor, parsed.parsed, target);
  expect(plan.publicOutputs).toEqual(descriptor.moduleOutputs);
  expect(plan.validatedSpec).toEqual({
    name: "embeddings",
    dimensions: 1536,
  });
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

  const ambiguousRef = parseEdgeWorkerSpec({
    name: "api",
    source: {
      artifactUrl: "https://example.test/api.js",
      artifactRef: "cloud-edge-worker-artifact:v1:abc",
      artifactSha256: "1".repeat(64),
    },
  });
  expect(ambiguousRef.ok).toBe(false);

  const missingRefDigest = parseEdgeWorkerSpec({
    name: "api",
    source: { artifactRef: "cloud-edge-worker-artifact:v1:abc" },
  });
  expect(missingRefDigest.ok).toBe(false);
  if (!missingRefDigest.ok) {
    expect(missingRefDigest.error.message).toContain("artifactSha256");
  }
});

test("EdgeWorker parser accepts an immutable host artifact reference", () => {
  const parsed = parseEdgeWorkerSpec({
    name: "api",
    source: {
      artifactRef: `cloud-edge-worker-artifact:v1:${"a".repeat(64)}`,
      artifactSha256: `sha256:${"a".repeat(64)}`,
    },
  });
  expect(parsed).toEqual({
    ok: true,
    spec: {
      name: "api",
      source: {
        artifactRef: `cloud-edge-worker-artifact:v1:${"a".repeat(64)}`,
        artifactSha256: `sha256:${"a".repeat(64)}`,
      },
    },
  });
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
    storageClass: "infrequent_access",
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
    storageClass: "infrequent_access",
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
