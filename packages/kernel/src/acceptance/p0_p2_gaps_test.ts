// Phase 4 (core simplification) acceptance tests for P0/P1/P2.
//
// The deploy domain exposes the canonical Deployment record. These acceptance
// assertions cover committed Deployment immutability, registry trust
// projection, route projection, and signed internal-call boundaries.

import assert from "node:assert/strict";
import {
  TAKOS_INTERNAL_ACTOR_HEADER,
  TAKOS_PAAS_INTERNAL_PATHS,
  type TakosActorContext,
} from "takosumi-contract";
import { encodeActorContext } from "takosumi-contract/internal-rpc";
import { createApiApp } from "../api/app.ts";
import {
  InMemoryPackageDescriptorStore,
  InMemoryPackageResolutionStore,
  InMemoryTrustRecordStore,
  type PackageDescriptor,
  type PackageResolution,
  type TrustRecord,
} from "../domains/registry/mod.ts";
import {
  DefaultGroupSummaryStatusProjector,
  type StatusConditionDto,
} from "../services/status/mod.ts";

// Phase 17D — re-enabled now that ProviderObservation drift stream is
// wired through the InMemoryDeploymentStore. A drifted provider records
// onto the observation stream while the committed Deployment.status stays
// `applied` (provider observation is observed-side, never canonical).
Deno.test("acceptance P0: provider failure does not mutate committed deployment", async () => {
  const { DeploymentService, InMemoryDeploymentStore } = await import(
    "../domains/deploy/deployment_service.ts"
  );
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_p0_drift_1",
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_acceptance",
    manifest: {
      name: "drift-app",
      compute: {
        web: {
          type: "container",
          image:
            "registry.example.test/demo@sha256:1111111111111111111111111111111111111111111111111111111111111111",
          port: 8080,
        },
      },
    },
  });
  const applied = await service.applyDeployment({
    deploymentId: resolved.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });
  assert.equal(applied.status, "applied");

  // Simulate the provider observation stream emitting a drift signal *after*
  // the Deployment was committed. The observation lives on a separate
  // record; the Deployment record is unchanged.
  await store.recordObservation({
    id: "observation_drift_1",
    deployment_id: applied.id,
    provider_id: "provider.cloudflare.workers",
    object_address: "component:web",
    observed_state: "drifted",
    drift_status: "config-drift",
    observed_at: "2026-04-27T00:02:00.000Z",
  });

  const observations = await store.listObservations({
    deploymentId: applied.id,
  });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].drift_status, "config-drift");

  // The Deployment status is *not* mutated by the observation — provider
  // observation is observed-side, never canonical (Core spec § 14).
  const reread = await store.getDeployment(applied.id);
  assert.equal(reread?.status, "applied");
  assert.equal(reread?.applied_at, "2026-04-27T00:01:00.000Z");
});

Deno.test("acceptance P1: revoked registry trust reports blocked security", async () => {
  const descriptors = new InMemoryPackageDescriptorStore();
  const resolutions = new InMemoryPackageResolutionStore();
  const trustRecords = new InMemoryTrustRecordStore();
  const descriptor: PackageDescriptor = {
    kind: "provider-package",
    ref: "providers/noop",
    digest: "sha256:revoked",
    publisher: "takos",
    version: "1.0.0",
    body: { provider: "noop" },
    publishedAt: "2026-04-27T00:00:00.000Z",
  };
  const resolution: PackageResolution = {
    kind: descriptor.kind,
    ref: descriptor.ref,
    digest: descriptor.digest,
    registry: "acceptance",
    trustRecordId: "trust_revoked",
    resolvedAt: "2026-04-27T00:00:01.000Z",
  };
  const revoked: TrustRecord = {
    id: "trust_revoked",
    packageKind: descriptor.kind,
    packageRef: descriptor.ref,
    packageDigest: descriptor.digest,
    trustLevel: "official",
    status: "revoked",
    conformanceTier: "tested",
    verifiedBy: "takos",
    verifiedAt: "2026-04-27T00:00:02.000Z",
    revokedAt: "2026-04-27T00:00:03.000Z",
    reason: "key compromise",
  };
  await descriptors.put(descriptor);
  await resolutions.record(resolution);
  await trustRecords.put(revoked);

  const securityCondition = trustCondition(
    await trustRecords.findForPackage(
      "provider-package",
      "providers/noop",
      "sha256:revoked",
    ),
  );
  const projection = new DefaultGroupSummaryStatusProjector({
    clock: fixedClock("2026-04-27T00:05:00.000Z"),
  }).project({
    spaceId: "space_acceptance",
    groupId: "app",
    activationPointer: {
      spaceId: "space_acceptance",
      groupId: "app",
      activationId: "activation_trust",
      advancedAt: "2026-04-27T00:01:00.000Z",
    },
    activation: { id: "activation_trust", status: "succeeded" },
    runtimeMaterialization: {
      activationId: "activation_trust",
      desiredStateId: "desired_trust",
      status: "materialized",
      materializedAt: "2026-04-27T00:02:00.000Z",
    },
    runtimeObserved: {
      activationId: "activation_trust",
      desiredStateId: "desired_trust",
      observedAt: "2026-04-27T00:03:00.000Z",
      workloads: [{ workloadId: "web", phase: "running" }],
      resources: [],
      routes: [],
    },
    resourceConditions: [{ type: "ResourcesReady", status: "true" }],
    publicationConditions: [{ type: "PublicationsReady", status: "true" }],
    securityConditions: [securityCondition],
  });

  assert.equal(projection.security.status, "blocked");
  assert.equal(projection.status, "failed");
  assert.ok(
    projection.conditions.some((condition) =>
      condition.type === "RegistryTrustActive" &&
      condition.status === "false" &&
      condition.reason === "DescriptorUntrusted"
    ),
  );
});

// Phase 17D — re-enabled. `Deployment.desired.routes` is the canonical
// route projection keyed off the committed Deployment id. Verify the
// projection chain (route id, exposure-target projection, route assignment
// permille weight) is derived from the committed Deployment record.
Deno.test("acceptance P1: route projection is derived from committed deployment", async () => {
  const { DeploymentService, InMemoryDeploymentStore } = await import(
    "../domains/deploy/deployment_service.ts"
  );
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_p1_route_1",
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_acceptance",
    manifest: {
      name: "route-app",
      compute: {
        web: {
          type: "container",
          image:
            "registry.example.test/demo@sha256:1111111111111111111111111111111111111111111111111111111111111111",
          port: 8080,
        },
      },
      routes: { web: { target: "web", path: "/" } },
    },
  });
  const applied = await service.applyDeployment({
    deploymentId: resolved.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });
  assert.equal(applied.status, "applied");

  // Route projection keyed off the committed Deployment id.
  assert.equal(applied.desired.routes.length, 1);
  assert.equal(applied.desired.routes[0].id, "web");
  // Activation envelope carries the matching route assignment.
  const routeAssignment = applied.desired.activation_envelope
    .route_assignments?.find((r) => r.routeId === "web");
  assert.ok(routeAssignment);
  assert.equal(routeAssignment.assignments.length, 1);
  assert.equal(routeAssignment.assignments[0].weightPermille, 1000);
  // The exposure-target projection lives on the resolved graph and is
  // derived from the committed Deployment.
  const exposureTargets = applied.resolution.resolved_graph.projections
    .filter((p) => p.projectionType === "exposure-target");
  assert.ok(exposureTargets.length >= 1);
});

Deno.test("acceptance P2: app factory rejects unsigned internal routes", async () => {
  const app = await createApiApp({
    getInternalServiceSecret: () => "acceptance-secret",
    registerPublicRoutes: false,
  });
  const actor = actorContext("acct_acceptance", "req_unsigned");

  const response = await app.request(TAKOS_PAAS_INTERNAL_PATHS.spaces, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TAKOS_INTERNAL_ACTOR_HEADER]: encodeActorContext(actor),
    },
    body: JSON.stringify({ spaceId: "space_unsigned", name: "Unsigned" }),
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: {
      code: "unauthenticated",
      message: "invalid internal signature",
    },
  });
});

function trustCondition(record: TrustRecord | undefined): StatusConditionDto {
  if (!record) {
    return {
      type: "RegistryTrustActive",
      status: "false",
      reason: "DescriptorUntrusted",
    };
  }
  if (record.status !== "active") {
    return {
      type: "RegistryTrustActive",
      status: "false",
      reason: "DescriptorUntrusted",
      message: record.reason,
      lastTransitionAt: record.revokedAt,
    };
  }
  return { type: "RegistryTrustActive", status: "true" };
}

function actorContext(
  actorAccountId: string,
  requestId: string,
): TakosActorContext {
  return {
    actorAccountId,
    requestId,
    roles: ["owner"],
    principalKind: "account",
  };
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}
