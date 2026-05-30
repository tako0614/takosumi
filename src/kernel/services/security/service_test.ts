import assert from "node:assert/strict";
import {
  InMemoryRuntimeNetworkPolicyStore,
  InMemoryServiceGrantStore,
  InMemoryWorkloadIdentityStore,
} from "../../domains/network/mod.ts";
import { DomainError } from "../../shared/errors.ts";
import { WorkerAuthzService, type WorkerAuthzStores } from "./mod.ts";

Deno.test("WorkerAuthzService rejects internal calls without identity", async () => {
  const { service } = createService();

  await assert.rejects(
    () =>
      service.authorizeInternalServiceCall({
        targetService: "takosumi-runtime-agent",
        permission: "runtime.invoke",
      }),
    (error) => isPermissionDenied(error, "Workload identity is required"),
  );
});

Deno.test("WorkerAuthzService rejects identity without matching service grant", async () => {
  const { service, stores } = createService();
  await putIdentity(stores);

  await assert.rejects(
    () =>
      service.authorizeInternalServiceCall({
        sourceIdentityId: "wi_worker",
        targetService: "takosumi-runtime-agent",
        permission: "runtime.invoke",
      }),
    (error) => isPermissionDenied(error, "Service grant is required"),
  );
});

Deno.test("WorkerAuthzService allows matching workload identity service grant", async () => {
  const { service, stores } = createService();
  await putIdentity(stores);
  await stores.serviceGrants.put({
    id: "grant_runtime",
    spaceId: "space_a",
    groupId: "group_a",
    fromIdentityId: "wi_worker",
    toService: "takosumi-runtime-agent",
    permissions: ["runtime.invoke"],
    createdAt: "2026-04-27T00:00:00.000Z",
  });

  const result = await service.authorizeInternalServiceCall({
    sourceIdentityId: "wi_worker",
    targetService: "takosumi-runtime-agent",
    permission: "runtime.invoke",
    spaceId: "space_a",
    groupId: "group_a",
  });

  assert.equal(result.allowed, true);
  assert.equal(result.identity.id, "wi_worker");
  assert.equal(result.grant.id, "grant_runtime");
});

Deno.test("WorkerAuthzService denies private egress when runtime network policy blocks", async () => {
  const { service, stores } = createService();
  await putIdentity(stores);
  await stores.runtimeNetworkPolicies.put({
    id: "policy_web",
    spaceId: "space_a",
    groupId: "group_a",
    name: "deny-private-by-default",
    selector: { componentNames: ["web"] },
    ingress: [],
    egress: [],
    defaultEgress: "denied",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
  });

  const decision = await service.decideRuntimeEgress({
    sourceIdentityId: "wi_worker",
    spaceId: "space_a",
    groupId: "group_a",
    destinationCidr: "10.0.0.5/32",
    port: 5432,
    protocol: "tcp",
  });

  assert.equal(decision.decision, "denied");
  assert.equal(
    decision.reason,
    "private egress blocked by runtime network policy",
  );
  assert.equal(decision.policy?.id, "policy_web");
});

Deno.test("WorkerAuthzService reports advisory egress denial as unknown instead of enforced deny", async () => {
  const { service, stores } = createService();
  await putIdentity(stores);
  await stores.runtimeNetworkPolicies.put({
    id: "policy_advisory",
    spaceId: "space_a",
    groupId: "group_a",
    name: "advisory-deny",
    selector: { componentNames: ["web"] },
    ingress: [],
    egress: [],
    defaultEgress: "denied",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
  });

  const decision = await service.decideRuntimeEgress({
    sourceIdentityId: "wi_worker",
    spaceId: "space_a",
    groupId: "group_a",
    destinationCidr: "10.0.0.5/32",
    port: 5432,
    protocol: "tcp",
    enforcement: "advisory",
  });

  assert.equal(decision.decision, "unknown");
  assert.equal(
    decision.reason,
    "advisory egress policy would deny; provider enforcement not required",
  );
});

Deno.test("WorkerAuthzService keeps candidate-scoped egress policy activation-local", async () => {
  const { service, stores } = createService();
  await putIdentity(stores, { activationId: "activation_primary" });
  await stores.runtimeNetworkPolicies.put({
    id: "policy_candidate",
    spaceId: "space_a",
    groupId: "group_a",
    activationId: "activation_candidate",
    name: "candidate-only-egress",
    selector: { componentNames: ["web"] },
    ingress: [],
    egress: [{
      peers: [{ host: "api.example.test" }],
      ports: [443],
      protocol: "https",
    }],
    defaultEgress: "denied",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
  });

  const primary = await service.decideRuntimeEgress({
    sourceIdentityId: "wi_worker",
    spaceId: "space_a",
    groupId: "group_a",
    activationId: "activation_primary",
    destinationHost: "api.example.test",
    port: 443,
    protocol: "https",
  });
  assert.equal(primary.decision, "unknown");

  await stores.workloadIdentities.put({
    id: "wi_candidate",
    spaceId: "space_a",
    groupId: "group_a",
    activationId: "activation_candidate",
    componentName: "web",
    subject: "worker:web:candidate",
    claims: { aud: "takos-internal" },
    issuedAt: "2026-04-27T00:00:00.000Z",
  });
  const candidate = await service.decideRuntimeEgress({
    sourceIdentityId: "wi_candidate",
    spaceId: "space_a",
    groupId: "group_a",
    activationId: "activation_candidate",
    destinationHost: "api.example.test",
    port: 443,
    protocol: "https",
  });
  assert.equal(candidate.decision, "allowed");
  assert.equal(candidate.policy?.id, "policy_candidate");
});

function createService(): {
  readonly service: WorkerAuthzService;
  readonly stores: WorkerAuthzStores;
} {
  const stores: WorkerAuthzStores = {
    workloadIdentities: new InMemoryWorkloadIdentityStore(),
    serviceGrants: new InMemoryServiceGrantStore(),
    runtimeNetworkPolicies: new InMemoryRuntimeNetworkPolicyStore(),
  };
  return {
    service: new WorkerAuthzService({
      stores,
      clock: () => new Date("2026-04-27T00:00:00.000Z"),
    }),
    stores,
  };
}

async function putIdentity(
  stores: WorkerAuthzStores,
  overrides: Partial<
    Awaited<ReturnType<WorkerAuthzStores["workloadIdentities"]["put"]>>
  > = {},
): Promise<void> {
  await stores.workloadIdentities.put({
    id: "wi_worker",
    spaceId: "space_a",
    groupId: "group_a",
    componentName: "web",
    subject: "worker:web",
    claims: { aud: "takos-internal" },
    issuedAt: "2026-04-27T00:00:00.000Z",
    ...overrides,
  });
}

function isPermissionDenied(error: unknown, message: string): boolean {
  return error instanceof DomainError && error.code === "permission_denied" &&
    error.message === message;
}
