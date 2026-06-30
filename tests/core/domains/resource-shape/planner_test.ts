import { test, expect } from "bun:test";

import type { TargetPoolEntry } from "takosumi-contract";
import {
  CONTAINER_SERVICE_GENERIC_TEMPLATE_ID,
  EDGE_WORKER_IMPLEMENTATION_TEMPLATE,
  parseContainerServiceSpec,
  parseEdgeWorkerSpec,
  parseKVStoreSpec,
  parseObjectBucketSpec,
  parseQueueSpec,
  parseSQLDatabaseSpec,
  planContainerService,
  planEdgeWorker,
  planKVStore,
  planObjectBucket,
  planQueue,
  planSQLDatabase,
} from "../../../../core/domains/resource-shape/planner.ts";
import { firstPartyModuleFilesByTemplateId } from "../../../../opentofu-modules/module-files.ts";

test("parseEdgeWorkerSpec accepts a Worker script artifact", () => {
  const r = parseEdgeWorkerSpec({
    name: "api",
    source: { artifactPath: "/work/dist/worker.js" },
    compatibilityDate: "2026-06-29",
    compatibilityFlags: ["nodejs_compat"],
    profiles: ["workers_bindings"],
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.spec.source.artifactPath).toBe("/work/dist/worker.js");
  expect(r.spec.compatibilityDate).toBe("2026-06-29");
  expect(r.spec.compatibilityFlags).toEqual(["nodejs_compat"]);
  expect(r.spec.profiles).toEqual(["workers_bindings"]);
});

test("parseEdgeWorkerSpec rejects an unknown profile", () => {
  const r = parseEdgeWorkerSpec({
    name: "api",
    source: { artifactPath: "/work/dist/worker.js" },
    profiles: ["lambda_handler"],
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_profile");
});

test("parseEdgeWorkerSpec requires an explicit artifactPath source", () => {
  const r = parseEdgeWorkerSpec({
    name: "api",
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_source");
});

test("parseEdgeWorkerSpec rejects source modes the planner cannot materialize", () => {
  const r = parseEdgeWorkerSpec({
    name: "api",
    source: { artifactRef: "artifact_123" },
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_source");
});

test("parseEdgeWorkerSpec rejects connections until grant/projection planning lands", () => {
  const r = parseEdgeWorkerSpec({
    name: "api",
    source: { artifactPath: "/work/dist/worker.js" },
    connections: {
      AI: {
        resource: "ObjectBucket/assets",
        permissions: ["connect"],
        projection: "env",
      },
    },
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_connections");
});

test("planEdgeWorker maps cloudflare_workers to cloudflare-worker-service", () => {
  const target: TargetPoolEntry = {
    name: "cf-main",
    type: "cloudflare",
    ref: "cf-account-123",
    priority: 10,
  };
  const plan = planEdgeWorker(
    "cloudflare_workers",
    {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
    },
    target,
  );

  expect(EDGE_WORKER_IMPLEMENTATION_TEMPLATE.cloudflare_workers).toBe(
    "cloudflare-worker-service",
  );
  expect(plan.shape).toBe("EdgeWorker");
  expect(plan.templateId).toBe("cloudflare-worker-service");
  expect(plan.inputs).toEqual({
    appName: "api",
    accountId: "cf-account-123",
    artifactPath: "/work/dist/worker.js",
  });
  expect(plan.publicOutputs).toEqual(["worker_name"]);
  expect(plan.moduleFiles).toBe(
    firstPartyModuleFilesByTemplateId["cloudflare-worker-service"],
  );
});

test("parseObjectBucketSpec accepts S3-compatible object storage interfaces", () => {
  const r = parseObjectBucketSpec({
    name: "assets",
    interfaces: ["s3_api", "signed_url"],
    lifecyclePolicy: { delete: "retain" },
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.spec.interfaces).toEqual(["s3_api", "signed_url"]);
  expect(r.spec.lifecyclePolicy?.delete).toBe("retain");
});

test("parseKVStoreSpec validates consistency preference", () => {
  const ok = parseKVStoreSpec({ name: "cache", consistency: "eventual" });
  expect(ok.ok).toBe(true);
  const bad = parseKVStoreSpec({ name: "cache", consistency: "linearizable" });
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.error.code).toBe("invalid_consistency");
});

test("parseQueueSpec accepts delivery preferences", () => {
  const r = parseQueueSpec({
    name: "delivery",
    delivery: { maxRetries: 5, maxBatchSize: 25 },
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.spec.delivery).toEqual({ maxRetries: 5, maxBatchSize: 25 });
});

test("parseQueueSpec rejects negative delivery values", () => {
  const r = parseQueueSpec({ name: "delivery", delivery: { maxRetries: -1 } });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_delivery");
});

test("parseSQLDatabaseSpec accepts sqlite and migrations path", () => {
  const r = parseSQLDatabaseSpec({
    name: "main",
    engine: "sqlite",
    migrationsPath: "migrations",
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.spec.engine).toBe("sqlite");
  expect(r.spec.migrationsPath).toBe("migrations");
});

test("parseContainerServiceSpec accepts an OCI image with ports and env", () => {
  const r = parseContainerServiceSpec({
    name: "agent",
    image: "ghcr.io/example/agent:1.0.0",
    ports: [8080],
    publicHttp: true,
    environment: { NODE_ENV: "production" },
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.spec.image).toBe("ghcr.io/example/agent:1.0.0");
  expect(r.spec.ports).toEqual([8080]);
});

test("service-shape planners map Cloudflare resources to focused modules", () => {
  const target: TargetPoolEntry = {
    name: "cf-main",
    type: "cloudflare",
    ref: "cf-account-123",
    priority: 90,
  };
  expect(
    planObjectBucket("cloudflare_r2_bucket", { name: "assets" }, target)
      .templateId,
  ).toBe("cloudflare-r2-bucket");
  expect(
    planKVStore("cloudflare_kv_namespace", { name: "cache" }, target)
      .templateId,
  ).toBe("cloudflare-kv-store");
  expect(
    planQueue("cloudflare_queue", { name: "delivery" }, target).templateId,
  ).toBe("cloudflare-queue");
  expect(
    planSQLDatabase("cloudflare_d1_database", { name: "main" }, target)
      .templateId,
  ).toBe("cloudflare-sql-database");
});

test("planContainerService uses the generic container module for operator implementations", () => {
  const target: TargetPoolEntry = {
    name: "k8s-main",
    type: "kubernetes",
    ref: "cluster-prod",
    priority: 90,
  };
  const plan = planContainerService(
    "kubernetes_deployment",
    {
      name: "agent",
      image: "ghcr.io/example/agent:1.0.0",
      ports: [8080],
      publicHttp: true,
      environment: { NODE_ENV: "production" },
    },
    target,
  );
  expect(plan.templateId).toBe(CONTAINER_SERVICE_GENERIC_TEMPLATE_ID);
  expect(plan.shape).toBe("ContainerService");
  expect(plan.inputs).toEqual({
    serviceName: "agent",
    implementation: "kubernetes_deployment",
    targetName: "k8s-main",
    targetType: "kubernetes",
    image: "ghcr.io/example/agent:1.0.0",
    ports: [8080],
    publicHttp: true,
    environment: { NODE_ENV: "production" },
  });
  expect(plan.publicOutputs).toEqual(["service_name", "url"]);
});
