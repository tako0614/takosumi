import assert from "node:assert/strict";
import type { PublicDeployManifest } from "../domains/deploy/mod.ts";
import {
  InMemoryRuntimeNetworkPolicyStore,
  InMemoryServiceGrantStore,
  InMemoryWorkloadIdentityStore,
} from "../domains/network/mod.ts";
import {
  InMemoryBindingSetRevisionStore,
  InMemoryMigrationLedgerStore,
  InMemoryResourceBindingStore,
  InMemoryResourceInstanceStore,
} from "../domains/resources/mod.ts";
import { buildEventSubscriptionSwitchPreview } from "../services/event-planner/mod.ts";
import {
  ResourceOperationService,
  type ResourceOperationStores,
} from "../services/resources/mod.ts";
import {
  WorkerAuthzService,
  type WorkerAuthzStores,
} from "../services/security/mod.ts";
import { DomainError } from "../shared/errors.ts";

Deno.test("acceptance P3: internal service call without WorkloadIdentity is rejected", async () => {
  const { security } = createRuntimeSecurityAcceptanceHarness();

  await assert.rejects(
    () =>
      security.authorizeInternalServiceCall({
        targetService: "takosumi-runtime-agent",
        permission: "runtime.invoke",
        spaceId: "space_security",
        groupId: "worker",
      }),
    (error) => isPermissionDenied(error, "Workload identity is required"),
  );
});

Deno.test("acceptance P3: ServiceGrant is required before runtime internal service calls", async () => {
  const { security, securityStores } = createRuntimeSecurityAcceptanceHarness();
  await putWorkerIdentity(securityStores);

  await assert.rejects(
    () =>
      security.authorizeInternalServiceCall({
        sourceIdentityId: "wi_worker_primary",
        targetService: "takosumi-runtime-agent",
        permission: "runtime.invoke",
        spaceId: "space_security",
        groupId: "worker",
      }),
    (error) => isPermissionDenied(error, "Service grant is required"),
  );

  await securityStores.serviceGrants.put({
    id: "grant_runtime_invoke",
    spaceId: "space_security",
    groupId: "worker",
    fromIdentityId: "wi_worker_primary",
    toService: "takosumi-runtime-agent",
    permissions: ["runtime.invoke"],
    createdAt: "2026-04-27T00:00:00.000Z",
  });

  const result = await security.authorizeInternalServiceCall({
    sourceIdentityId: "wi_worker_primary",
    targetService: "takosumi-runtime-agent",
    permission: "runtime.invoke",
    spaceId: "space_security",
    groupId: "worker",
  });

  assert.equal(result.allowed, true);
  assert.equal(result.identity.id, "wi_worker_primary");
  assert.equal(result.grant.id, "grant_runtime_invoke");
});

Deno.test("acceptance P3: private resource egress is denied when runtime policy requires it", async () => {
  const { security, securityStores, resources, resourceStores } =
    createRuntimeSecurityAcceptanceHarness({
      ids: ["resource_private_db", "binding_private_db", "revision_private_db"],
    });
  await putWorkerIdentity(securityStores);
  const database = await resources.createResource({
    spaceId: "space_security",
    groupId: "worker",
    contract: "postgres.v1",
    providerResourceId: "postgres://10.0.0.5:5432/app",
    properties: { privateCidr: "10.0.0.5/32" },
  });
  const bound = await resources.bindResource({
    spaceId: "space_security",
    groupId: "worker",
    claimAddress: "claims.db",
    instanceId: database.id,
  });
  await securityStores.runtimeNetworkPolicies.put({
    id: "policy_worker_deny_private",
    spaceId: "space_security",
    groupId: "worker",
    activationId: "activation_primary",
    name: "deny-private-by-default",
    selector: { componentNames: ["handler"] },
    ingress: [],
    egress: [],
    defaultEgress: "denied",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
  });

  const decision = await security.decideRuntimeEgress({
    sourceIdentityId: "wi_worker_primary",
    spaceId: "space_security",
    groupId: "worker",
    activationId: "activation_primary",
    destinationCidr: "10.0.0.5/32",
    port: 5432,
    protocol: "tcp",
  });

  assert.equal(bound.binding.claimAddress, "claims.db");
  assert.equal(
    (await resourceStores.bindings.findByClaim("worker", "claims.db"))?.id,
    "binding_private_db",
  );
  assert.equal(decision.decision, "denied");
  assert.equal(
    decision.reason,
    "private egress blocked by runtime network policy",
  );
  assert.equal(decision.identity?.id, "wi_worker_primary");
  assert.equal(decision.policy?.id, "policy_worker_deny_private");
});

Deno.test("acceptance P3: schedule and queue event targets stay primary during canary", () => {
  const preview = buildEventSubscriptionSwitchPreview({
    spaceId: "space_security",
    groupId: "worker",
    manifest: workerManifest(),
    primaryAppReleaseId: "release_primary",
    candidateAppReleaseId: "release_canary",
  });

  const queue = preview.subscriptions.find((subscription) =>
    subscription.subscriptionId === "jobs"
  );
  const schedule = preview.subscriptions.find((subscription) =>
    subscription.subscriptionId === "nightly"
  );

  assert.equal(preview.policy.canaryHttpAutoSwitchesQueueConsumers, false);
  assert.equal(
    preview.policy.scheduleEventsTargetAppReleaseId,
    "release_primary",
  );
  assert.equal(preview.status, "switch-plan-required");
  assert.equal(queue?.previewTargetAppReleaseId, "release_primary");
  assert.equal(queue?.requiresExplicitSwitchPlan, true);
  assert.equal(queue?.reason, "queue-consumer-pinned-during-http-canary");
  assert.equal(schedule?.previewTargetAppReleaseId, "release_primary");
  assert.equal(schedule?.requiresExplicitSwitchPlan, false);
  assert.equal(schedule?.reason, "schedule-event-targets-primary-release");
});

function createRuntimeSecurityAcceptanceHarness(options?: {
  readonly ids?: readonly string[];
}): {
  readonly security: WorkerAuthzService;
  readonly securityStores: WorkerAuthzStores;
  readonly resources: ResourceOperationService;
  readonly resourceStores: ResourceOperationStores;
} {
  const securityStores: WorkerAuthzStores = {
    workloadIdentities: new InMemoryWorkloadIdentityStore(),
    serviceGrants: new InMemoryServiceGrantStore(),
    runtimeNetworkPolicies: new InMemoryRuntimeNetworkPolicyStore(),
  };
  const resourceStores: ResourceOperationStores = {
    instances: new InMemoryResourceInstanceStore(),
    bindings: new InMemoryResourceBindingStore(),
    bindingSetRevisions: new InMemoryBindingSetRevisionStore(),
    migrationLedger: new InMemoryMigrationLedgerStore(),
  };
  const clock = fixedClock("2026-04-27T00:00:00.000Z");
  return {
    security: new WorkerAuthzService({ stores: securityStores, clock }),
    securityStores,
    resources: new ResourceOperationService({
      stores: resourceStores,
      idFactory: sequenceIds(options?.ids ?? []),
      clock,
    }),
    resourceStores,
  };
}

async function putWorkerIdentity(stores: WorkerAuthzStores): Promise<void> {
  await stores.workloadIdentities.put({
    id: "wi_worker_primary",
    spaceId: "space_security",
    groupId: "worker",
    activationId: "activation_primary",
    componentName: "handler",
    subject: "worker:handler:activation_primary",
    claims: { aud: "takos-internal", release: "primary" },
    issuedAt: "2026-04-27T00:00:00.000Z",
  });
}

function workerManifest(): PublicDeployManifest {
  return {
    name: "worker",
    version: "1.0.0",
    compute: {
      handler: {
        type: "container",
        image:
          "registry.example.test/worker@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        port: 8080,
      },
    },
    routes: {
      web: {
        target: "handler",
        protocol: "https",
        host: "worker.example.test",
        path: "/",
      },
      jobs: { target: "handler", protocol: "queue", source: "jobs" },
      nightly: { target: "handler", protocol: "schedule", source: "nightly" },
    },
  };
}

function isPermissionDenied(error: unknown, message: string): boolean {
  return error instanceof DomainError && error.code === "permission_denied" &&
    error.message === message;
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function sequenceIds(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (!value) throw new Error("test id sequence exhausted");
    index += 1;
    return value;
  };
}
