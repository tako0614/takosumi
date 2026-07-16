import { expect, test } from "bun:test";
import {
  TAKOSUMI_API_VERSION,
  type ResolutionLock,
  type ResolverInput,
  type ResourceObject,
  type SpacePolicy,
  type TargetImplementationDescriptor,
  type TargetPool,
  type TargetPoolEntry,
} from "takosumi-contract";
import { resolve } from "../../../../core/domains/resource-shape/resolver.ts";
import {
  LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
  parseResourceSpec as parseCoreResourceSpec,
} from "../../../../core/domains/resource-shape/planner.ts";

const parseResourceSpec: typeof parseCoreResourceSpec = (
  kind,
  spec,
  registry = LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
) => parseCoreResourceSpec(kind, spec, registry);

const CONTAINER_DESCRIPTOR: TargetImplementationDescriptor = {
  shape: "ContainerService",
  implementation: "operator.container.v2",
  nativeResourceType: "operator.container",
  plugin: "operator-container-plugin",
  moduleOutputs: [{ name: "service_name", type: "string" }],
  interfaces: {
    oci_container: "native",
    public_http: "shim",
    env_projection: "native",
  },
  options: { runtimeClass: "edge" },
};

function resource(name = "agent"): ResourceObject {
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

function pool(targets: readonly TargetPoolEntry[]): TargetPool {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "TargetPool",
    metadata: { name: "default", space: "prod" },
    spec: { targets },
  };
}

function policy(spec: SpacePolicy["spec"]): SpacePolicy {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "SpacePolicy",
    metadata: { name: "default" },
    spec,
  };
}

function input(overrides: Partial<ResolverInput> = {}): ResolverInput {
  return {
    resource: resource(),
    interfaces: ["oci_container", "public_http"],
    targetPool: pool([
      {
        name: "operator-primary",
        type: "operator.example/runtime.v3",
        ref: "pool-a",
        priority: 100,
        implementations: [CONTAINER_DESCRIPTOR],
      },
    ]),
    ...overrides,
  };
}

function expectOk(outcome: ReturnType<typeof resolve>) {
  if (!outcome.ok) throw new Error(outcome.error.message);
  return outcome.output;
}

test("Resolver selects only an explicit implementation descriptor", () => {
  const output = expectOk(resolve(input()));
  expect(output.selectedTarget).toBe("operator-primary");
  expect(output.selectedImplementationDescriptor).toEqual(CONTAINER_DESCRIPTOR);
  expect(output.nativeResourcePlan).toEqual([
    { type: "operator.container", id: "agent", ownership: "planned" },
  ]);
  expect(output.resolutionLock.implementationSnapshot).toEqual(
    CONTAINER_DESCRIPTOR,
  );
  expect(output.resolutionLock.targetSnapshot?.implementations).toEqual([
    CONTAINER_DESCRIPTOR,
  ]);
});

test("Target type never implies a descriptor", () => {
  const outcome = resolve(
    input({
      targetPool: pool([
        {
          name: "looks-like-cloudflare",
          type: "cloudflare",
          priority: 100,
        },
      ]),
    }),
  );
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error.code).toBe("capability_missing");
});

test("an unregistered shape cannot resolve without an exact descriptor", () => {
  const unknownResource = {
    ...resource("cache"),
    kind: "CacheCluster",
    spec: { name: "cache" },
  } as unknown as ResourceObject;
  const outcome = resolve(input({ resource: unknownResource }));
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error.code).toBe("capability_missing");
});

test("non-UTC Schedule fails closed without explicit resolver capability", () => {
  const schedule = {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "Schedule",
    metadata: { name: "morning", space: "prod", managedBy: "api" },
    spec: {
      name: "morning",
      cron: "0 9 * * *",
      timezone: "Asia/Tokyo",
      connections: {
        target: {
          resource: "DurableWorkflow/digest",
          permissions: ["invoke"],
          projection: "schedule_trigger",
        },
      },
    },
  } as const satisfies ResourceObject;
  const parsed = parseResourceSpec(schedule.kind, schedule.spec);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.parsed.interfaces).toContain("non_utc_timezone");

  const descriptor: TargetImplementationDescriptor = {
    shape: "Schedule",
    implementation: "operator.schedule.v1",
    plugin: "operator-schedule-plugin",
    interfaces: {
      schedule: "native",
      cron: "native",
      invoke: "native",
      resource_connection: "native",
      schedule_trigger: "native",
      grant_invoke: "native",
    },
  };
  const resolverInput: ResolverInput = {
    resource: schedule,
    interfaces: parsed.parsed.interfaces,
    targetPool: pool([
      {
        name: "utc-only",
        type: "operator.example/scheduler.v1",
        priority: 10,
        implementations: [descriptor],
      },
    ]),
  };
  const missing = resolve(resolverInput);
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error.code).toBe("capability_missing");

  const supported = resolve({
    ...resolverInput,
    targetPool: pool([
      {
        name: "timezone-aware",
        type: "operator.example/scheduler.v1",
        priority: 10,
        implementations: [
          {
            ...descriptor,
            interfaces: {
              ...descriptor.interfaces,
              non_utc_timezone: "native",
            },
          },
        ],
      },
    ]),
  });
  expect(supported.ok).toBe(true);
});

test("Resolver ranks eligible descriptors by target priority then name", () => {
  const lower = {
    ...CONTAINER_DESCRIPTOR,
    implementation: "lower",
  };
  const output = expectOk(
    resolve(
      input({
        targetPool: pool([
          {
            name: "lower",
            type: "opaque-a",
            priority: 10,
            implementations: [lower],
          },
          {
            name: "higher",
            type: "opaque-b",
            priority: 20,
            implementations: [CONTAINER_DESCRIPTOR],
          },
        ]),
      }),
    ),
  );
  expect(output.selectedTarget).toBe("higher");
});

test("SpacePolicy filters target type and name without vendor knowledge", () => {
  const denied = resolve(
    input({
      spacePolicy: policy({ deniedTargets: ["operator.example/runtime.v3"] }),
    }),
  );
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.error.code).toBe("policy_denied");
});

test("ResolutionLock pins the complete target and descriptor snapshots", () => {
  const first = expectOk(resolve(input()));
  const changedDescriptor: TargetImplementationDescriptor = {
    ...CONTAINER_DESCRIPTOR,
    implementation: "operator.changed",
    plugin: "changed-plugin",
    options: { runtimeClass: "changed" },
  };
  const reapplied = expectOk(
    resolve(
      input({
        existingLock: first.resolutionLock,
        targetPool: pool([
          {
            name: "operator-primary",
            type: "operator.changed/runtime",
            ref: "pool-b",
            priority: 999,
            implementations: [changedDescriptor],
          },
        ]),
      }),
    ),
  );
  expect(reapplied.selectedImplementationDescriptor).toEqual(
    CONTAINER_DESCRIPTOR,
  );
  expect(reapplied.resolutionLock.targetSnapshot?.ref).toBe("pool-a");
  expect(reapplied.resolutionLock.implementationFingerprint).toBe(
    first.resolutionLock.implementationFingerprint,
  );
});

test("legacy locks without any recoverable descriptor fail closed", () => {
  const legacy: ResolutionLock = {
    resourceId: "tkrn:prod:ContainerService:agent",
    selectedImplementation: "removed",
    targetPool: "default",
    target: "missing",
    locked: true,
    reason: ["legacy"],
    portability: "partial",
    nativeResources: [],
  };
  const outcome = resolve(input({ existingLock: legacy }));
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.error.code).toBe("resolution_descriptor_missing");
  }
});

test("resolve is deterministic", () => {
  expect(JSON.stringify(resolve(input()))).toBe(
    JSON.stringify(resolve(input())),
  );
});
