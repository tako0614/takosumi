import { test, expect } from "bun:test";

import {
  TAKOSUMI_API_VERSION,
  type ResolutionLock,
  type ResolverInput,
  type ResourceObject,
  type SpacePolicy,
  type TargetCapabilityMatrix,
  type TargetPool,
  type TargetPoolEntry,
} from "takosumi-contract";
import {
  DEFAULT_RESOURCE_SHAPE_CAPABILITIES,
  OBJECT_STORE_TARGET_IMPLEMENTATION,
  SHAPE_INTERFACE_REQUIREMENTS,
  resolve,
} from "../../../../core/domains/resource-shape/resolver.ts";

// --- fixtures ----------------------------------------------------------------

function objectStoreResource(
  name = "assets",
  interfaces: readonly string[] = ["s3_api", "signed_url"],
): ResourceObject {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "ObjectStore",
    metadata: { name, space: "prod", managedBy: "api" },
    spec: { name, interfaces: [...interfaces] },
  };
}

function httpServiceResource(name = "api"): ResourceObject {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "HttpService",
    metadata: { name, space: "prod", managedBy: "api" },
    spec: {
      name,
      runtime: { interface: "web_fetch", profiles: ["workers_bindings"] },
      exposure: { publicHttp: true },
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
    resource: objectStoreResource(),
    interfaces: ["s3_api", "signed_url"],
    targetPool: targetPool([
      { name: "cf-main", type: "cloudflare", ref: "acct-cf", priority: 10 },
      { name: "aws-main", type: "aws", region: "us-east-1", priority: 5 },
    ]),
    ...over,
  };
}

function expectOk(outcome: ReturnType<typeof resolve>) {
  if (!outcome.ok) throw new Error(`expected ok, got error: ${outcome.error.code}`);
  return outcome.output;
}

// --- mapping / table sanity --------------------------------------------------

test("target type maps to the expected ObjectStore implementation", () => {
  expect(OBJECT_STORE_TARGET_IMPLEMENTATION.cloudflare).toBe("cloudflare_r2");
  expect(OBJECT_STORE_TARGET_IMPLEMENTATION.aws).toBe("aws_s3");
  expect(OBJECT_STORE_TARGET_IMPLEMENTATION.takosumi_native).toBe(
    "takosumi_object_store",
  );
  expect(OBJECT_STORE_TARGET_IMPLEMENTATION.kubernetes).toBe("minio");
});

test("ObjectStore requires s3_api", () => {
  expect(SHAPE_INTERFACE_REQUIREMENTS.ObjectStore?.required).toContain("s3_api");
});

// --- selection ---------------------------------------------------------------

test("resolve picks the highest-priority eligible target", () => {
  const out = expectOk(resolve(input()));
  expect(out.selectedTarget).toBe("cf-main");
  expect(out.selectedImplementation).toBe("cloudflare_r2");
});

test("resolve tie-breaks equal priority by name ascending", () => {
  const out = expectOk(
    resolve(
      input({
        targetPool: targetPool([
          { name: "zeta", type: "aws", region: "us-east-1", priority: 7 },
          { name: "alpha", type: "aws", region: "us-east-1", priority: 7 },
        ]),
      }),
    ),
  );
  expect(out.selectedTarget).toBe("alpha");
});

test("denied target (by name) is excluded", () => {
  const out = expectOk(
    resolve(input({ spacePolicy: spacePolicy({ deniedTargets: ["cf-main"] }) })),
  );
  expect(out.selectedTarget).toBe("aws-main");
});

test("denied target (by type) is excluded", () => {
  const out = expectOk(
    resolve(input({ spacePolicy: spacePolicy({ deniedTargets: ["cloudflare"] }) })),
  );
  expect(out.selectedTarget).toBe("aws-main");
});

test("allowedTargets keeps only allowed entries (matched by type or name)", () => {
  const out = expectOk(
    resolve(input({ spacePolicy: spacePolicy({ allowedTargets: ["aws"] }) })),
  );
  expect(out.selectedTarget).toBe("aws-main");
});

test("a target whose implementation lacks required s3_api is excluded", () => {
  // Custom matrix: cloudflare_r2 cannot serve s3_api, so the lower-priority aws
  // target must win even though cloudflare has the higher priority.
  const matrix: TargetCapabilityMatrix = [
    {
      implementation: "cloudflare_r2",
      targetType: "cloudflare",
      shape: "ObjectStore",
      interfaces: { s3_api: "unsupported", signed_url: "native" },
    },
    {
      implementation: "aws_s3",
      targetType: "aws",
      shape: "ObjectStore",
      interfaces: { s3_api: "native", signed_url: "native", object_events: "native" },
    },
  ];
  const out = expectOk(resolve(input({ targetCapabilities: matrix })));
  expect(out.selectedTarget).toBe("aws-main");
  expect(out.selectedImplementation).toBe("aws_s3");
});

test("a target whose implementation lacks a requested interface is excluded", () => {
  const matrix: TargetCapabilityMatrix = [
    {
      implementation: "cloudflare_r2",
      targetType: "cloudflare",
      shape: "ObjectStore",
      interfaces: { s3_api: "native", signed_url: "unsupported" },
    },
  ];
  const outcome = resolve(
    input({
      targetPool: targetPool([
        { name: "cf-main", type: "cloudflare", ref: "acct-cf", priority: 10 },
      ]),
      targetCapabilities: matrix,
      interfaces: ["s3_api", "signed_url"],
    }),
  );
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error.code).toBe("no_eligible_target");
});

test("no eligible target returns a no_eligible_target error", () => {
  const outcome = resolve(
    input({
      targetPool: targetPool([
        // gcp has no ObjectStore implementation mapping in Phase 2.
        { name: "gcp-main", type: "gcp", priority: 9 },
      ]),
    }),
  );
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error.code).toBe("no_eligible_target");
});

test("resolve maps HttpService to cloudflare_workers on a Cloudflare target", () => {
  const out = expectOk(
    resolve(
      input({
        resource: httpServiceResource(),
        interfaces: ["web_fetch", "public_http", "workers_bindings"],
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

// --- native plan / lock fields ----------------------------------------------

test("cloudflare_r2 plans a cloudflare.r2_bucket native resource", () => {
  const out = expectOk(resolve(input()));
  expect(out.nativeResourcePlan).toEqual([
    { type: "cloudflare.r2_bucket", id: "assets" },
  ]);
});

test("aws_s3 plans an aws.s3_bucket native resource", () => {
  const out = expectOk(
    resolve(input({ spacePolicy: spacePolicy({ allowedTargets: ["aws"] }) })),
  );
  expect(out.nativeResourcePlan).toEqual([{ type: "aws.s3_bucket", id: "assets" }]);
});

test("resolutionLock carries resourceId and does NOT stamp lockedAt", () => {
  const out = expectOk(
    resolve(input({ spacePolicy: spacePolicy({ resolution: { lockAfterCreate: true } }) })),
  );
  expect(out.resolutionLock.resourceId).toBe("tkrn:prod:ObjectStore:assets");
  expect(out.resolutionLock.locked).toBe(true);
  expect(out.resolutionLock.lockedAt).toBeUndefined();
  expect(out.resolutionLock.reason.length).toBeGreaterThan(0);
});

test("locked defaults to false when policy does not lock after create", () => {
  const out = expectOk(resolve(input()));
  expect(out.resolutionLock.locked).toBe(false);
});

// --- portability -------------------------------------------------------------

test("portability is portable when every interface is native", () => {
  const out = expectOk(
    resolve(
      input({
        interfaces: ["s3_api", "signed_url", "object_events"],
        spacePolicy: spacePolicy({ allowedTargets: ["aws"] }),
      }),
    ),
  );
  expect(out.portability).toBe("portable");
});

test("portability is mostly_portable when an interface is a shim", () => {
  const out = expectOk(
    resolve(
      input({
        interfaces: ["s3_api", "object_events"], // object_events is shim on R2
        spacePolicy: spacePolicy({ allowedTargets: ["cloudflare"] }),
      }),
    ),
  );
  expect(out.portability).toBe("mostly_portable");
  expect(out.riskNotes.some((n) => n.includes("object_events"))).toBe(true);
});

test("portability is partial when an interface is emulated", () => {
  const out = expectOk(
    resolve(
      input({
        interfaces: ["s3_api", "object_events"], // object_events is emulated on minio
        targetPool: targetPool([
          { name: "k8s-main", type: "kubernetes", ref: "cluster-1", priority: 3 },
        ]),
      }),
    ),
  );
  expect(out.selectedImplementation).toBe("minio");
  expect(out.portability).toBe("partial");
});

// --- locked resolution (§3.5) ------------------------------------------------

function existingAwsLock(): ResolutionLock {
  return {
    resourceId: "tkrn:prod:ObjectStore:assets",
    selectedImplementation: "aws_s3",
    target: "aws-main",
    locked: true,
    reason: ["initial resolution"],
    portability: "portable",
    nativeResources: [{ type: "aws.s3_bucket", id: "assets" }],
    lockedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("a locked resolution is returned unchanged and is NOT re-targeted", () => {
  const lock = existingAwsLock();
  const out = expectOk(
    resolve(
      input({
        existingLock: lock,
        // Fresh selection would prefer cf-main (priority 10) over aws-main.
        spacePolicy: spacePolicy({ resolution: { allowAutoMigration: false } }),
      }),
    ),
  );
  expect(out.selectedTarget).toBe("aws-main");
  expect(out.selectedImplementation).toBe("aws_s3");
  expect(out.resolutionLock).toBe(lock); // returned verbatim, lockedAt preserved
  expect(out.resolutionLock.lockedAt).toBe("2026-01-01T00:00:00.000Z");
  // divergence recorded as a risk note, but the decision is kept.
  expect(out.riskNotes.some((n) => n.includes("cf-main"))).toBe(true);
});

test("allowAutoMigration lets the resolver re-target a locked resolution", () => {
  const out = expectOk(
    resolve(
      input({
        existingLock: existingAwsLock(),
        spacePolicy: spacePolicy({ resolution: { allowAutoMigration: true } }),
      }),
    ),
  );
  expect(out.selectedTarget).toBe("cf-main");
  expect(out.selectedImplementation).toBe("cloudflare_r2");
});

test("resolve is deterministic across repeated calls", () => {
  const a = JSON.stringify(resolve(input()));
  const b = JSON.stringify(resolve(input()));
  expect(a).toBe(b);
});

test("DEFAULT_RESOURCE_SHAPE_CAPABILITIES covers ObjectStore implementations", () => {
  const impls = DEFAULT_RESOURCE_SHAPE_CAPABILITIES
    .filter((c) => c.shape === "ObjectStore")
    .map((c) => c.implementation)
    .sort();
  expect(impls).toEqual(["aws_s3", "cloudflare_r2", "minio", "takosumi_object_store"]);
});

test("DEFAULT_RESOURCE_SHAPE_CAPABILITIES does not advertise half-materialized shapes", () => {
  expect(DEFAULT_RESOURCE_SHAPE_CAPABILITIES.some((c) => c.shape === "Queue")).toBe(
    false,
  );
});
