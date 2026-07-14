import { expect, test } from "bun:test";
import {
  TAKOSUMI_API_VERSION,
  type ActorContext,
  type ResourceObject,
  type TargetImplementationDescriptor,
  type TargetPool,
  type TargetPoolEntry,
} from "takosumi-contract";
import {
  createInMemoryResourceShapeStores,
  ResourceShapeService,
  StubResourceShapeAdapter,
} from "../../../../core/domains/resource-shape/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { ActivityService } from "../../../../core/domains/activity/mod.ts";
import {
  parseResourceSpec,
  planResourceShape,
} from "../../../../core/domains/resource-shape/planner.ts";
import { resolve } from "../../../../core/domains/resource-shape/resolver.ts";
import { TEST_RESOURCE_SHAPE_MODULE_REGISTRY } from "../../../helpers/resource-shape/operator-module-registry.ts";

const actor: ActorContext = {
  actorAccountId: "acct_test",
  roles: ["owner"],
  requestId: "req_test",
};

function customResource(): ResourceObject {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "ObjectBucket",
    metadata: {
      name: "session-cache",
      space: "ws_test",
      managedBy: "operator.plugin.v2",
    },
    spec: { name: "session-cache", interfaces: ["s3_api"] },
  };
}

const pluginDescriptor: TargetImplementationDescriptor = {
  shape: "ObjectBucket",
  implementation: "operator.redis.compat.v2",
  interfaces: { object_store: "native", s3_api: "native" },
  nativeResourceType: "operator.cache_cluster",
  plugin: "operator-cache-plugin",
  moduleOutputs: [{ name: "endpoint", type: "hostname" }],
  options: { engine: "redis-compatible" },
};

function pool(entry: TargetPoolEntry): TargetPool {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "TargetPool",
    metadata: { name: "default", space: "ws_test" },
    spec: { targets: [entry] },
  };
}

test("Resolver accepts an opaque Target token only with an explicit typed-shape descriptor", () => {
  const target: TargetPoolEntry = {
    name: "operator-primary",
    type: "operator.example/runtime.v3",
    ref: "pool-a",
    priority: 100,
    implementations: [pluginDescriptor],
  };
  const outcome = resolve({
    resource: customResource(),
    interfaces: ["object_store", "s3_api"],
    targetPool: pool(target),
  });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.output.selectedImplementationDescriptor).toEqual(
    pluginDescriptor,
  );
  expect(outcome.output.resolutionLock.implementationSnapshot).toEqual(
    pluginDescriptor,
  );
  expect(outcome.output.resolutionLock.targetSnapshot?.implementations).toEqual(
    [pluginDescriptor],
  );

  const withoutDescriptor = resolve({
    resource: customResource(),
    interfaces: ["object_store", "s3_api"],
    targetPool: pool({ ...target, implementations: [] }),
  });
  expect(withoutDescriptor.ok).toBe(false);
  if (!withoutDescriptor.ok) {
    expect(withoutDescriptor.error.code).toBe("capability_missing");
  }
});

test("Resolver accepts an operator shape token only through an exact descriptor", () => {
  const unknown = {
    ...customResource(),
    kind: "CacheCluster",
    spec: { name: "session-cache", replicas: 3 },
  } as unknown as ResourceObject;
  const outcome = resolve({
    resource: unknown,
    interfaces: [],
    targetPool: pool({
      name: "operator-primary",
      type: "operator.example/runtime.v3",
      priority: 100,
      implementations: [{ ...pluginDescriptor, shape: "CacheCluster" }],
    }),
  });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.output.selectedImplementationDescriptor.shape).toBe(
    "CacheCluster",
  );
});

test("ResolutionLock reuses the complete descriptor snapshot after mutable pool drift", () => {
  const originalTarget: TargetPoolEntry = {
    name: "operator-primary",
    type: "opaque-target",
    priority: 10,
    implementations: [pluginDescriptor],
  };
  const first = resolve({
    resource: customResource(),
    interfaces: ["object_store", "s3_api"],
    targetPool: pool(originalTarget),
  });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const reapplied = resolve({
    resource: customResource(),
    interfaces: ["object_store", "s3_api"],
    targetPool: pool({
      ...originalTarget,
      priority: 999,
      implementations: [
        {
          ...pluginDescriptor,
          implementation: "operator.changed",
          plugin: "changed-plugin",
        },
      ],
    }),
    existingLock: first.output.resolutionLock,
  });
  expect(reapplied.ok).toBe(true);
  if (!reapplied.ok) return;
  expect(reapplied.output.selectedImplementationDescriptor).toEqual(
    pluginDescriptor,
  );
  expect(reapplied.output.resolutionLock.locked).toBe(true);
});

test("Planner projects module inputs only from explicit descriptor mappings", () => {
  const parsed = parseResourceSpec("ObjectBucket", {
    name: "assets",
    interfaces: ["s3_api"],
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const descriptor: TargetImplementationDescriptor = {
    shape: "ObjectBucket",
    implementation: "operator.bucket.module",
    interfaces: { object_store: "native", s3_api: "native" },
    providerSource: "example/object-store",
    moduleTemplate: "cloudflare-r2-bucket",
    moduleInputMappings: {
      bucketName: { source: "spec", path: "/name", required: true },
      accountId: { source: "target", path: "/ref", required: true },
      regionHint: { source: "literal", value: "operator-region" },
    },
    moduleOutputs: [{ name: "bucket_name", type: "string" }],
  };
  const plan = planResourceShape(
    descriptor,
    parsed.parsed,
    {
      name: "opaque",
      type: "not-a-vendor-enum",
      ref: "acct-explicit",
      priority: 1,
    },
    TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  );
  expect(plan.inputs).toEqual({
    bucketName: "assets",
    accountId: "acct-explicit",
    regionHint: "operator-region",
  });
  expect(plan.moduleTemplate).toBe("cloudflare-r2-bucket");
});

test("ResourceShapeService applies a typed shape through an operator plugin descriptor", async () => {
  const stores = createInMemoryResourceShapeStores();
  const operationRuns = new InMemoryOpenTofuControlStore();
  const service = new ResourceShapeService({
    stores,
    adapter: new StubResourceShapeAdapter(),
    operationRuns,
    activity: new ActivityService({
      store: operationRuns,
      now: () => new Date("2026-07-13T00:00:00.000Z"),
    }),
    now: () => "2026-07-13T00:00:00.000Z",
  });
  const configured = await service.putTargetPool("ws_test", "default", {
    targets: [
      {
        name: "operator-primary",
        type: "opaque-target",
        priority: 1,
        implementations: [pluginDescriptor],
      },
    ],
  });
  expect(configured.ok).toBe(true);

  const request = {
    actor,
    space: "ws_test",
    kind: "ObjectBucket",
    name: "session-cache",
    spec: { name: "session-cache", interfaces: ["s3_api"] },
  };
  const preview = await service.preview(request);
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;
  const applied = await service.apply(request, {
    planDigest: preview.value.planDigest,
  });
  expect(applied.ok).toBe(true);
  if (!applied.ok) return;
  expect(applied.value.status?.resolution?.selectedImplementation).toBe(
    "operator.redis.compat.v2",
  );
  expect(applied.value.status?.outputs?.endpoint).toContain("operator-primary");
});
