import { test, expect } from "bun:test";

import {
  TAKOSUMI_API_VERSION,
  type ResolutionLock,
  type ResolverInput,
  type ResourceObject,
  type SpacePolicy,
  type TargetPool,
  type TargetPoolEntry,
} from "takosumi-contract";
import {
  DEFAULT_RESOURCE_SHAPE_CAPABILITIES,
  SHAPE_INTERFACE_REQUIREMENTS,
  resolve,
} from "../../../../core/domains/resource-shape/resolver.ts";

function edgeWorkerResource(name = "api"): ResourceObject {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "EdgeWorker",
    metadata: { name, space: "prod", managedBy: "api" },
    spec: {
      name,
      source: { artifactPath: "/work/dist/worker.js" },
      profiles: ["workers_bindings"],
    },
  };
}

function containerResource(name = "agent"): ResourceObject {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "ContainerService",
    metadata: { name, space: "prod", managedBy: "api" },
    spec: {
      name,
      image: "ghcr.io/example/agent:1.0.0",
      publicHttp: true,
    },
  };
}

function targetPool(targets: readonly TargetPoolEntry[]): TargetPool {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "TargetPool",
    metadata: { name: "default", space: "prod" },
    spec: { targets: [...targets] },
  };
}

function spacePolicy(
  spec: Partial<SpacePolicy["spec"]> & {
    resolution?: Partial<SpacePolicy["spec"]["resolution"]>;
  } = {},
): SpacePolicy {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "SpacePolicy",
    metadata: { name: "prod" },
    spec: {
      ...spec,
      resolution: {
        lockAfterCreate: spec.resolution?.lockAfterCreate ?? false,
        allowAutoMigration: spec.resolution?.allowAutoMigration ?? false,
      },
    },
  };
}

function input(over: Partial<ResolverInput> = {}): ResolverInput {
  return {
    resource: containerResource(),
    interfaces: ["oci_container", "public_http"],
    targetPool: targetPool([
      {
        name: "k8s-main",
        type: "kubernetes",
        ref: "cluster-prod",
        priority: 20,
      },
      {
        name: "cf-containers",
        type: "cloudflare",
        ref: "cf-acct",
        priority: 10,
      },
    ]),
    ...over,
  };
}

function expectOk(outcome: ReturnType<typeof resolve>) {
  if (!outcome.ok)
    throw new Error(`expected ok, got error: ${outcome.error.code}`);
  return outcome.output;
}

test("current public shapes carry shape-specific interface requirements", () => {
  expect(SHAPE_INTERFACE_REQUIREMENTS.EdgeWorker?.required).toEqual([
    "worker_fetch",
  ]);
  expect(SHAPE_INTERFACE_REQUIREMENTS.ObjectBucket?.required).toEqual([
    "object_store",
  ]);
  expect(SHAPE_INTERFACE_REQUIREMENTS.KVStore?.required).toEqual(["kv_store"]);
  expect(SHAPE_INTERFACE_REQUIREMENTS.Queue?.required).toEqual(["queue"]);
  expect(SHAPE_INTERFACE_REQUIREMENTS.SQLDatabase?.required).toEqual(["sql"]);
  expect(SHAPE_INTERFACE_REQUIREMENTS.ContainerService?.required).toEqual([
    "oci_container",
  ]);
});

test("resolve maps EdgeWorker to cloudflare_workers on a Cloudflare target", () => {
  const out = expectOk(
    resolve(
      input({
        resource: edgeWorkerResource(),
        interfaces: ["worker_fetch", "workers_bindings"],
        targetPool: targetPool([
          { name: "cf-main", type: "cloudflare", ref: "acct-cf", priority: 10 },
        ]),
      }),
    ),
  );
  expect(out.selectedImplementation).toBe("cloudflare_workers");
  expect(out.nativeResourcePlan).toEqual([
    { type: "cloudflare.workers_script", id: "api" },
  ]);
});

test("resolve picks the highest-priority eligible container target", () => {
  const out = expectOk(resolve(input()));
  expect(out.selectedImplementation).toBe("kubernetes_deployment");
  expect(out.selectedTarget).toBe("k8s-main");
  expect(out.nativeResourcePlan).toEqual([
    { type: "kubernetes.deployment", id: "agent" },
  ]);
});

test("resolve tie-breaks equal priority by name ascending", () => {
  const out = expectOk(
    resolve(
      input({
        targetPool: targetPool([
          { name: "zeta", type: "cloudflare", ref: "z", priority: 7 },
          { name: "alpha", type: "cloudflare", ref: "a", priority: 7 },
        ]),
      }),
    ),
  );
  expect(out.selectedTarget).toBe("alpha");
});

test("denied target type is excluded", () => {
  const out = expectOk(
    resolve(
      input({ spacePolicy: spacePolicy({ deniedTargets: ["kubernetes"] }) }),
    ),
  );
  expect(out.selectedTarget).toBe("cf-containers");
  expect(out.selectedImplementation).toBe("cloudflare_container");
});

test("allowedTargets keeps only allowed entries", () => {
  const out = expectOk(
    resolve(
      input({ spacePolicy: spacePolicy({ allowedTargets: ["cloudflare"] }) }),
    ),
  );
  expect(out.selectedTarget).toBe("cf-containers");
});

test("a target whose implementation lacks a requested interface is excluded", () => {
  const out = expectOk(
    resolve(
      input({
        interfaces: ["oci_container", "public_http", "env_projection"],
        targetPool: targetPool([
          {
            name: "custom-main",
            type: "kubernetes",
            ref: "cluster-prod",
            priority: 20,
            implementations: [
              {
                shape: "ContainerService",
                implementation: "custom_container",
                nativeResourceType: "custom.container",
                interfaces: {
                  oci_container: "native",
                  public_http: "native",
                  env_projection: "unsupported",
                },
              },
            ],
          },
          {
            name: "cf-containers",
            type: "cloudflare",
            ref: "cf-acct",
            priority: 10,
          },
        ]),
      }),
    ),
  );
  expect(out.selectedTarget).toBe("cf-containers");
});

test("no eligible target returns a no_eligible_target error", () => {
  const outcome = resolve(
    input({
      targetPool: targetPool([{ name: "aws-main", type: "aws", priority: 9 }]),
    }),
  );
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error.code).toBe("no_eligible_target");
});

test("resolve uses admin-declared implementation capabilities from TargetPool", () => {
  const out = expectOk(
    resolve(
      input({
        interfaces: ["oci_container", "custom.mesh"],
        targetPool: targetPool([
          {
            name: "custom-main",
            type: "kubernetes",
            ref: "cluster-prod",
            priority: 20,
            implementations: [
              {
                shape: "ContainerService",
                implementation: "custom_container_runtime",
                nativeResourceType: "custom.container_service",
                interfaces: {
                  oci_container: "native",
                  "custom.mesh": "native",
                  public_http: "shim",
                },
              },
            ],
          },
        ]),
      }),
    ),
  );
  expect(out.selectedImplementation).toBe("custom_container_runtime");
  expect(out.selectedTarget).toBe("custom-main");
  expect(out.nativeResourcePlan).toEqual([
    { type: "custom.container_service", id: "agent" },
  ]);
});

test("resolve preserves operator implementation plugin metadata", () => {
  const out = expectOk(
    resolve(
      input({
        interfaces: ["oci_container"],
        targetPool: targetPool([
          {
            name: "custom-main",
            type: "kubernetes",
            ref: "cluster-prod",
            priority: 20,
            implementations: [
              {
                shape: "ContainerService",
                implementation: "custom_container_runtime",
                nativeResourceType: "custom.container_service",
                plugin: "takosumi-container-plugin",
                options: { runtimeClass: "edge", timeoutMs: 30000 },
                interfaces: {
                  oci_container: "native",
                },
              },
            ],
          },
        ]),
      }),
    ),
  );
  expect(out.selectedImplementation).toBe("custom_container_runtime");
  expect(out.selectedImplementationPlugin).toBe("takosumi-container-plugin");
  expect(out.selectedImplementationOptions).toEqual({
    runtimeClass: "edge",
    timeoutMs: 30000,
  });
});

test("resolutionLock carries resourceId and does NOT stamp lockedAt", () => {
  const out = expectOk(
    resolve(
      input({
        spacePolicy: spacePolicy({ resolution: { lockAfterCreate: true } }),
      }),
    ),
  );
  expect(out.resolutionLock.resourceId).toBe(
    "tkrn:prod:ContainerService:agent",
  );
  expect(out.resolutionLock.locked).toBe(true);
  expect(out.resolutionLock.lockedAt).toBeUndefined();
  expect(out.resolutionLock.reason.length).toBeGreaterThan(0);
});

test("locked defaults to false when policy does not lock after create", () => {
  const out = expectOk(resolve(input()));
  expect(out.resolutionLock.locked).toBe(false);
});

test("portability is mostly_portable when an interface is a shim", () => {
  const out = expectOk(
    resolve(
      input({
        spacePolicy: spacePolicy({ allowedTargets: ["kubernetes"] }),
      }),
    ),
  );
  expect(out.portability).toBe("mostly_portable");
  expect(out.riskNotes.some((n) => n.includes("public_http"))).toBe(true);
});

function existingCloudflareLock(): ResolutionLock {
  return {
    resourceId: "tkrn:prod:ContainerService:agent",
    selectedImplementation: "cloudflare_container",
    target: "cf-containers",
    locked: true,
    reason: ["initial resolution"],
    portability: "mostly_portable",
    nativeResources: [{ type: "cloudflare.container", id: "agent" }],
    lockedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("a locked resolution is returned unchanged and is NOT re-targeted", () => {
  const lock = existingCloudflareLock();
  const out = expectOk(
    resolve(
      input({
        existingLock: lock,
        spacePolicy: spacePolicy({ resolution: { allowAutoMigration: false } }),
      }),
    ),
  );
  expect(out.selectedTarget).toBe("cf-containers");
  expect(out.selectedImplementation).toBe("cloudflare_container");
  expect(out.resolutionLock).toBe(lock);
  expect(out.resolutionLock.lockedAt).toBe("2026-01-01T00:00:00.000Z");
  expect(out.riskNotes.some((n) => n.includes("k8s-main"))).toBe(true);
});

test("allowAutoMigration lets the resolver re-target a locked resolution", () => {
  const out = expectOk(
    resolve(
      input({
        existingLock: existingCloudflareLock(),
        spacePolicy: spacePolicy({ resolution: { allowAutoMigration: true } }),
      }),
    ),
  );
  expect(out.selectedTarget).toBe("k8s-main");
  expect(out.selectedImplementation).toBe("kubernetes_deployment");
});

test("resolve is deterministic across repeated calls", () => {
  const a = JSON.stringify(resolve(input()));
  const b = JSON.stringify(resolve(input()));
  expect(a).toBe(b);
});

test("DEFAULT_RESOURCE_SHAPE_CAPABILITIES advertises the current public shapes", () => {
  expect(
    [
      ...new Set(DEFAULT_RESOURCE_SHAPE_CAPABILITIES.map((c) => c.shape)),
    ].sort(),
  ).toEqual([
    "ContainerService",
    "EdgeWorker",
    "KVStore",
    "ObjectBucket",
    "Queue",
    "SQLDatabase",
  ]);
});
