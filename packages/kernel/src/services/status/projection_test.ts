import assert from "node:assert/strict";
import { DefaultGroupSummaryStatusProjector } from "./mod.ts";
import type { GroupSummaryStatusProjectionInput } from "./mod.ts";

const baseInput: GroupSummaryStatusProjectionInput = {
  spaceId: "space_a",
  groupId: "group_a",
  activationPointer: {
    spaceId: "space_a",
    groupId: "group_a",
    activationId: "activation_1",
    advancedAt: "2026-04-27T00:00:00.000Z",
  },
  activation: {
    id: "activation_1",
    status: "succeeded",
  },
  runtimeMaterialization: {
    materializationId: "materialization_1",
    activationId: "activation_1",
    desiredStateId: "desired_1",
    status: "materialized",
    materializedAt: "2026-04-27T00:00:01.000Z",
    providerObservation: {
      materializationId: "materialization_1",
      observedState: "present",
      observedAt: "2026-04-27T00:00:01.500Z",
    },
    providerMaterializations: [{
      id: "materialization_1:router-config",
      role: "router",
      desiredObjectRef: "router-config:activation_1",
      providerTarget: "test-provider",
      objectAddress: "router-config:activation_1",
      createdByOperationId: "provider-op-router",
    }, {
      id: "materialization_1:runtime-network-policy",
      role: "runtime",
      desiredObjectRef: "runtime-network-policy:activation_1",
      providerTarget: "test-provider",
      objectAddress: "runtime-network-policy:activation_1",
      createdByOperationId: "provider-op-network",
    }, {
      id: "materialization_1:activation",
      role: "runtime",
      desiredObjectRef: "desired_1",
      providerTarget: "test-provider",
      objectAddress: "activation:activation_1",
      createdByOperationId: "provider-op-runtime",
    }],
    providerObservations: [{
      materializationId: "materialization_1:router-config",
      observedState: "present",
      observedAt: "2026-04-27T00:00:01.500Z",
    }, {
      materializationId: "materialization_1:runtime-network-policy",
      observedState: "present",
      observedAt: "2026-04-27T00:00:01.500Z",
    }, {
      materializationId: "materialization_1:activation",
      observedState: "present",
      observedAt: "2026-04-27T00:00:01.500Z",
    }],
  },
  runtimeObserved: {
    activationId: "activation_1",
    desiredStateId: "desired_1",
    observedAt: "2026-04-27T00:00:02.000Z",
    workloads: [{ workloadId: "workload_web", phase: "running" }],
    resources: [{ resourceId: "resource_db", phase: "ready" }],
    routes: [{ routeId: "route_web", ready: true }],
  },
  resourceConditions: [{ type: "ResourcesReady", status: "true" }],
  outputConditions: [{ type: "OutputsReady", status: "true" }],
  securityConditions: [{ type: "SecurityPolicySatisfied", status: "true" }],
};

Deno.test(
  "status projection marks committed activation active after serving converges",
  () => {
    const projector = new DefaultGroupSummaryStatusProjector({
      clock: () => new Date("2026-04-27T00:00:03.000Z"),
    });

    const projection = projector.project(baseInput);

    assert.equal(projection.status, "active");
    assert.equal(projection.activationId, "activation_1");
    assert.equal(projection.projectedAt, "2026-04-27T00:00:03.000Z");
    assert.equal(projection.desired.status, "committed");
    assert.equal(projection.serving.status, "converged");
    assert.equal(projection.dependencies.status, "ready");
    assert.equal(projection.security.status, "trusted");
    assert.ok(
      projection.conditions.some((condition) =>
        condition.type === "ActivationCommitted" &&
        condition.status === "true"
      ),
    );
    assert.ok(
      projection.conditions.some((condition) =>
        condition.type === "ServingConverged" && condition.status === "true" &&
        condition.reason === "ServingConverged"
      ),
    );
  },
);

Deno.test(
  "status projection degrades committed activation when serving is degraded",
  () => {
    const projector = new DefaultGroupSummaryStatusProjector({
      clock: () => new Date("2026-04-27T00:00:03.000Z"),
    });

    const projection = projector.project({
      ...baseInput,
      runtimeObserved: {
        ...baseInput.runtimeObserved!,
        workloads: [{
          workloadId: "workload_web",
          phase: "degraded",
          message: "readiness probe failed",
        }],
      },
    });

    assert.equal(projection.status, "degraded");
    assert.equal(projection.desired.status, "committed");
    assert.equal(projection.serving.status, "degraded");
    assert.equal(projection.dependencies.status, "ready");
    assert.equal(projection.security.status, "trusted");
    assert.ok(
      projection.conditions.some((condition) =>
        condition.type === "ServingConverged" &&
        condition.status === "false" && condition.reason === "RuntimeNotReady"
      ),
    );
  },
);

Deno.test(
  "status projection degrades committed activation when security is blocked",
  () => {
    const projector = new DefaultGroupSummaryStatusProjector({
      clock: () => new Date("2026-04-27T00:00:03.000Z"),
    });

    const projection = projector.project({
      ...baseInput,
      securityConditions: [{
        type: "RegistryTrustActive",
        status: "false",
        reason: "DescriptorUntrusted",
        message: "Trust record has been revoked",
      }],
    });

    assert.equal(projection.status, "degraded");
    assert.equal(projection.desired.status, "committed");
    assert.equal(projection.serving.status, "converged");
    assert.equal(projection.dependencies.status, "ready");
    assert.equal(projection.security.status, "blocked");
  },
);

Deno.test(
  "status projection requires current provider observation before serving converges",
  () => {
    const projector = new DefaultGroupSummaryStatusProjector({
      clock: () => new Date("2026-04-27T00:00:03.000Z"),
    });

    const projection = projector.project({
      ...baseInput,
      runtimeMaterialization: {
        ...baseInput.runtimeMaterialization!,
        providerObservation: null,
        providerObservations: [],
      },
    });

    assert.equal(projection.status, "applying");
    assert.equal(projection.serving.status, "converging");
    assert.ok(
      projection.conditions.some((condition) =>
        condition.type === "ServingConverged" &&
        condition.status === "false" &&
        condition.reason === "ServingConvergenceUnknown"
      ),
    );
  },
);

Deno.test(
  "status projection requires role-scoped provider materializations before serving converges",
  () => {
    const projector = new DefaultGroupSummaryStatusProjector({
      clock: () => new Date("2026-04-27T00:00:03.000Z"),
    });

    const projection = projector.project({
      ...baseInput,
      runtimeMaterialization: {
        ...baseInput.runtimeMaterialization!,
        providerMaterializations: baseInput.runtimeMaterialization!
          .providerMaterializations!.filter((materialization) =>
            !materialization.objectAddress.includes("router-config")
          ),
      },
    });

    assert.equal(projection.status, "applying");
    assert.equal(projection.serving.status, "converging");
    assert.ok(
      projection.conditions.some((condition) =>
        condition.type === "ServingConverged" &&
        condition.status === "false" &&
        condition.reason === "ServingConvergenceUnknown"
      ),
    );
  },
);

Deno.test(
  "status projection maps provider drift to catalog condition reasons",
  () => {
    const projector = new DefaultGroupSummaryStatusProjector({
      clock: () => new Date("2026-04-27T00:00:03.000Z"),
    });

    const projection = projector.project({
      ...baseInput,
      runtimeMaterialization: {
        ...baseInput.runtimeMaterialization!,
        providerObservation: {
          materializationId: "materialization_1",
          observedState: "drifted",
          driftReason: "security-drift",
          observedAt: "2026-04-27T00:00:02.500Z",
        },
      },
    });

    assert.equal(projection.status, "degraded");
    assert.equal(projection.serving.status, "degraded");
    assert.ok(
      projection.conditions.some((condition) =>
        condition.type === "ServingConverged" &&
        condition.status === "false" &&
        condition.reason === "ProviderSecurityDrift"
      ),
    );
  },
);

// =============================================================================
// Phase 18.2: per-provider status layer + optional providers
// =============================================================================

const multiCloudInput: GroupSummaryStatusProjectionInput = {
  ...baseInput,
  runtimeMaterialization: {
    materializationId: "materialization_1",
    activationId: "activation_1",
    desiredStateId: "desired_1",
    status: "materialized",
    materializedAt: "2026-04-27T00:00:01.000Z",
    providerObservation: null,
    providerMaterializations: [
      {
        id: "materialization_1:router-config",
        role: "router",
        desiredObjectRef: "router-config:activation_1",
        providerTarget: "cloudflare",
        providerId: "cloudflare",
        objectAddress: "router-config:activation_1",
        createdByOperationId: "op-router",
        optional: false,
      },
      {
        id: "materialization_1:runtime-network-policy",
        role: "runtime",
        desiredObjectRef: "runtime-network-policy:activation_1",
        providerTarget: "aws",
        providerId: "aws",
        objectAddress: "runtime-network-policy:activation_1",
        createdByOperationId: "op-network",
        optional: false,
      },
      {
        id: "materialization_1:activation",
        role: "runtime",
        desiredObjectRef: "desired_1",
        providerTarget: "aws",
        providerId: "aws",
        objectAddress: "activation:activation_1",
        createdByOperationId: "op-runtime",
        optional: false,
        dependsOnProviderIds: ["cloudflare"],
      },
      {
        id: "materialization_1:cdn-edge",
        role: "router",
        desiredObjectRef: "cdn-edge:activation_1",
        providerTarget: "cloudflare-cdn",
        providerId: "cloudflare-cdn",
        objectAddress: "cdn-edge:activation_1",
        createdByOperationId: "op-cdn",
        optional: true,
        dependsOnProviderIds: ["cloudflare"],
      },
    ],
    providerObservations: [
      {
        materializationId: "materialization_1:router-config",
        observedState: "present",
        observedAt: "2026-04-27T00:00:01.500Z",
        providerId: "cloudflare",
      },
      {
        materializationId: "materialization_1:runtime-network-policy",
        observedState: "present",
        observedAt: "2026-04-27T00:00:01.500Z",
        providerId: "aws",
      },
      {
        materializationId: "materialization_1:activation",
        observedState: "present",
        observedAt: "2026-04-27T00:00:01.500Z",
        providerId: "aws",
      },
      {
        materializationId: "materialization_1:cdn-edge",
        observedState: "present",
        observedAt: "2026-04-27T00:00:01.500Z",
        providerId: "cloudflare-cdn",
        optional: true,
      },
    ],
  },
};

Deno.test(
  "phase 18.2: per-provider projections cover every provider id with status=serving when all observations are present",
  () => {
    const projector = new DefaultGroupSummaryStatusProjector({
      clock: () => new Date("2026-04-27T00:00:03.000Z"),
    });

    const projection = projector.project(multiCloudInput);

    assert.equal(projection.providers.length, 3);
    const ids = projection.providers.map((p) => p.providerId).sort();
    assert.deepEqual(ids, ["aws", "cloudflare", "cloudflare-cdn"]);
    for (const provider of projection.providers) {
      assert.equal(provider.status, "serving");
    }
    // All providers serving -> serving layer falls through to converged.
    assert.equal(projection.serving.status, "converged");
    assert.equal(projection.status, "active");
  },
);

Deno.test(
  "phase 18.2: critical-path provider missing escalates serving to outage",
  () => {
    const projector = new DefaultGroupSummaryStatusProjector({
      clock: () => new Date("2026-04-27T00:00:03.000Z"),
    });

    const projection = projector.project({
      ...multiCloudInput,
      runtimeMaterialization: {
        ...multiCloudInput.runtimeMaterialization!,
        providerObservations: multiCloudInput.runtimeMaterialization!
          .providerObservations!.map((observation) =>
            observation.providerId === "aws"
              ? { ...observation, observedState: "missing" as const }
              : observation
          ),
      },
    });

    const aws = projection.providers.find((p) => p.providerId === "aws");
    assert.ok(aws);
    assert.equal(aws.status, "outage");
    assert.equal(aws.optional, false);
    // Cloudflare itself is healthy but downstream of aws? No: aws depends on
    // cloudflare. Cloudflare stays serving; the cdn-edge stays serving.
    const cloudflare = projection.providers.find((p) =>
      p.providerId === "cloudflare"
    );
    assert.equal(cloudflare?.status, "serving");
    // The serving layer escalates to `outage` since aws is critical.
    assert.equal(projection.serving.status, "outage");
    assert.equal(projection.status, "outage");
  },
);

Deno.test(
  "phase 18.2: optional provider outage degrades but never escalates to outage",
  () => {
    const projector = new DefaultGroupSummaryStatusProjector({
      clock: () => new Date("2026-04-27T00:00:03.000Z"),
    });

    const projection = projector.project({
      ...multiCloudInput,
      runtimeMaterialization: {
        ...multiCloudInput.runtimeMaterialization!,
        providerObservations: multiCloudInput.runtimeMaterialization!
          .providerObservations!.map((observation) =>
            observation.providerId === "cloudflare-cdn"
              ? { ...observation, observedState: "missing" as const }
              : observation
          ),
      },
    });

    const cdn = projection.providers.find((p) =>
      p.providerId === "cloudflare-cdn"
    );
    assert.ok(cdn);
    assert.equal(cdn.optional, true);
    assert.equal(cdn.status, "degraded");
    // Critical providers stay serving.
    assert.equal(
      projection.providers.find((p) => p.providerId === "aws")?.status,
      "serving",
    );
    // The cross-provider rollup degrades but does NOT escalate to outage.
    assert.equal(projection.serving.status, "degraded");
    assert.notEqual(projection.status, "outage");
    assert.equal(projection.status, "degraded");
    // The optional provider's condition uses ServingDegraded reason, not
    // ProviderObjectMissing, so dashboards do not page on a CDN-tier blip.
    const cdnCondition = projection.conditions.find((c) =>
      c.type === "Provider:cloudflare-cdn"
    );
    assert.ok(cdnCondition);
    assert.equal(cdnCondition.reason, "ServingDegraded");
  },
);

Deno.test(
  "phase 18.2: dependent provider is degraded when its critical upstream is outage",
  () => {
    const projector = new DefaultGroupSummaryStatusProjector({
      clock: () => new Date("2026-04-27T00:00:03.000Z"),
    });

    // Cloudflare (critical) goes down. `aws` depends on `cloudflare`, so the
    // projector marks aws degraded via the dependency walk even though aws's
    // own observations are all `present`.
    const projection = projector.project({
      ...multiCloudInput,
      runtimeMaterialization: {
        ...multiCloudInput.runtimeMaterialization!,
        providerObservations: multiCloudInput.runtimeMaterialization!
          .providerObservations!.map((observation) =>
            observation.providerId === "cloudflare"
              ? { ...observation, observedState: "missing" as const }
              : observation
          ),
      },
    });

    const cloudflare = projection.providers.find((p) =>
      p.providerId === "cloudflare"
    );
    assert.equal(cloudflare?.status, "outage");
    const aws = projection.providers.find((p) => p.providerId === "aws");
    // aws depends on cloudflare and cloudflare is non-optional + outage,
    // so aws walks to degraded.
    assert.equal(aws?.status, "degraded");
    // cdn depends on cloudflare too (and is optional, but the propagation
    // rule degrades regardless).
    const cdn = projection.providers.find((p) =>
      p.providerId === "cloudflare-cdn"
    );
    assert.equal(cdn?.status, "degraded");
    // Critical outage on cloudflare wins the rollup.
    assert.equal(projection.serving.status, "outage");
    assert.equal(projection.status, "outage");
  },
);

Deno.test(
  "phase 18.2: drift on critical provider degrades layer without outage",
  () => {
    const projector = new DefaultGroupSummaryStatusProjector({
      clock: () => new Date("2026-04-27T00:00:03.000Z"),
    });

    const projection = projector.project({
      ...multiCloudInput,
      runtimeMaterialization: {
        ...multiCloudInput.runtimeMaterialization!,
        providerObservations: multiCloudInput.runtimeMaterialization!
          .providerObservations!.map((observation) =>
            observation.providerId === "aws"
              ? {
                ...observation,
                observedState: "drifted" as const,
                driftReason: "config-drift" as const,
              }
              : observation
          ),
      },
    });

    const aws = projection.providers.find((p) => p.providerId === "aws");
    assert.equal(aws?.status, "degraded");
    // Drift -> degraded layer, not outage.
    assert.equal(projection.serving.status, "degraded");
    assert.equal(projection.status, "degraded");
  },
);

Deno.test(
  "phase 18.2: unknown observation on critical provider rolls up to recovering",
  () => {
    const projector = new DefaultGroupSummaryStatusProjector({
      clock: () => new Date("2026-04-27T00:00:03.000Z"),
    });

    const projection = projector.project({
      ...multiCloudInput,
      runtimeMaterialization: {
        ...multiCloudInput.runtimeMaterialization!,
        providerObservations: multiCloudInput.runtimeMaterialization!
          .providerObservations!.map((observation) =>
            observation.providerId === "aws"
              ? { ...observation, observedState: "unknown" as const }
              : observation
          ),
      },
    });

    const aws = projection.providers.find((p) => p.providerId === "aws");
    assert.equal(aws?.status, "recovering");
    assert.equal(projection.serving.status, "recovering");
    assert.equal(projection.status, "recovering");
  },
);

Deno.test(
  "status projection replaces non-catalog dependency and security reasons",
  () => {
    const projector = new DefaultGroupSummaryStatusProjector({
      clock: () => new Date("2026-04-27T00:00:03.000Z"),
    });

    const projection = projector.project({
      ...baseInput,
      resourceConditions: [
        {
          type: "ResourcesReady",
          status: "false",
          reason: "resource-not-ready",
        } as unknown as NonNullable<
          GroupSummaryStatusProjectionInput["resourceConditions"]
        >[number],
      ],
      securityConditions: [
        {
          type: "SecurityPolicySatisfied",
          status: "false",
          reason: "policy-denied",
        } as unknown as NonNullable<
          GroupSummaryStatusProjectionInput["securityConditions"]
        >[number],
      ],
    });

    assert.equal(projection.status, "failed");
    assert.ok(
      projection.conditions.some((condition) =>
        condition.type === "ResourcesReady" &&
        condition.reason === "ResourceCompatibilityFailed"
      ),
    );
    assert.ok(
      projection.conditions.some((condition) =>
        condition.type === "SecurityPolicySatisfied" &&
        condition.reason === "PolicyDenied"
      ),
    );
  },
);

Deno.test(
  "status projection marks managed projection health failures as degraded",
  () => {
    const projector = new DefaultGroupSummaryStatusProjector({
      clock: () => new Date("2026-04-27T00:00:03.000Z"),
    });

    const projection = projector.project({
      ...baseInput,
      runtimeMaterialization: {
        ...baseInput.runtimeMaterialization!,
        providerMaterializations: [
          ...baseInput.runtimeMaterialization!.providerMaterializations!,
          {
            id: "materialization_1:managed-status-projection",
            role: "runtime",
            desiredObjectRef: "managed-status-projection:activation_1",
            providerTarget: "test-provider",
            objectAddress: "managed-projection:activation_1",
            createdByOperationId: "provider-op-projection",
          },
        ],
        providerObservations: baseInput.runtimeMaterialization!
          .providerObservations!,
      },
    });

    assert.equal(projection.status, "degraded");
    assert.equal(projection.serving.status, "degraded");
    assert.ok(
      projection.conditions.some((condition) =>
        condition.type === "ManagedProjectionHealthy" &&
        condition.status === "false" &&
        condition.reason === "OutputProjectionFailed"
      ),
    );
  },
);
