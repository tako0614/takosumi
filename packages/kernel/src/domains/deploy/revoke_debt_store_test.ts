import assert from "node:assert/strict";
import {
  InMemoryRevokeDebtStore,
  summarizeRevokeDebt,
} from "./revoke_debt_store.ts";

Deno.test("InMemoryRevokeDebtStore enqueues one open debt per source tuple", async () => {
  const store = new InMemoryRevokeDebtStore({
    idFactory: () => "revoke-debt:one",
  });
  const input = {
    generatedObjectId: "generated:takosumi-public-deploy/app/logs",
    reason: "activation-rollback" as const,
    ownerSpaceId: "space:one",
    deploymentName: "app",
    operationPlanDigest:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111" as const,
    journalEntryId: "operation:one",
    operationId: "operation:one",
    resourceName: "logs",
    providerId: "@takos/selfhost-filesystem",
    now: "2026-05-02T00:00:00.000Z",
  };

  const first = await store.enqueue(input);
  const second = await store.enqueue({
    ...input,
    now: "2026-05-02T00:01:00.000Z",
  });

  assert.equal(first.id, "revoke-debt:one");
  assert.equal(second.id, first.id);
  assert.equal(first.status, "open");
  assert.equal(first.retryAttempts, 0);
  assert.equal(first.nextRetryAt, "2026-05-02T00:00:00.000Z");
  assert.equal(first.statusUpdatedAt, "2026-05-02T00:00:00.000Z");
  assert.equal(first.originatingSpaceId, "space:one");
  assert.equal(first.reason, "activation-rollback");
  assert.equal(first.resourceName, "logs");
  assert.equal(first.providerId, "@takos/selfhost-filesystem");

  const byDeployment = await store.listByDeployment("space:one", "app");
  assert.equal(byDeployment.length, 1);
  assert.deepEqual(summarizeRevokeDebt(byDeployment), {
    total: 1,
    open: 1,
    operatorActionRequired: 0,
    cleared: 0,
  });
  assert.deepEqual(await store.listOpenOwnerSpaces(), ["space:one"]);
});

Deno.test("InMemoryRevokeDebtStore records retry, aging, reopen, and clearance transitions", async () => {
  const store = new InMemoryRevokeDebtStore({
    idFactory: () => "revoke-debt:lifecycle",
  });
  const debt = await store.enqueue({
    generatedObjectId: "generated:takosumi-public-deploy/app/cache",
    reason: "activation-rollback",
    ownerSpaceId: "space:lifecycle",
    deploymentName: "app",
    retryPolicy: {
      kind: "operator-managed",
      maxAttempts: 2,
      backoffMs: 5000,
      agingWindowMs: 60000,
    },
    now: "2026-05-02T00:00:00.000Z",
  });

  const retry = await store.recordRetryAttempt({
    id: debt.id,
    ownerSpaceId: "space:lifecycle",
    result: "retryable-failure",
    error: { category: "provider_unavailable" },
    now: "2026-05-02T00:00:10.000Z",
  });
  assert.equal(retry?.status, "open");
  assert.equal(retry?.retryAttempts, 1);
  assert.equal(retry?.lastRetryAt, "2026-05-02T00:00:10.000Z");
  assert.equal(retry?.nextRetryAt, "2026-05-02T00:00:15.000Z");
  assert.deepEqual(retry?.lastRetryError, {
    category: "provider_unavailable",
  });

  const exhausted = await store.recordRetryAttempt({
    id: debt.id,
    ownerSpaceId: "space:lifecycle",
    result: "retryable-failure",
    error: { category: "provider_rejected" },
    now: "2026-05-02T00:00:20.000Z",
  });
  assert.equal(exhausted?.status, "operator-action-required");
  assert.equal(exhausted?.retryAttempts, 2);
  assert.equal(exhausted?.agedAt, "2026-05-02T00:00:20.000Z");
  assert.equal(exhausted?.nextRetryAt, undefined);

  const reopened = await store.reopen({
    id: debt.id,
    ownerSpaceId: "space:lifecycle",
    now: "2026-05-02T00:01:00.000Z",
  });
  assert.equal(reopened?.status, "open");
  assert.equal(reopened?.nextRetryAt, "2026-05-02T00:01:00.000Z");
  assert.equal(reopened?.statusUpdatedAt, "2026-05-02T00:01:00.000Z");

  const earlyAged = await store.ageOpenDebts({
    ownerSpaceId: "space:lifecycle",
    now: "2026-05-02T00:01:30.000Z",
  });
  assert.equal(earlyAged.length, 0);

  const aged = await store.ageOpenDebts({
    ownerSpaceId: "space:lifecycle",
    now: "2026-05-02T00:02:00.000Z",
  });
  assert.equal(aged.length, 1);
  assert.equal(aged[0]?.status, "operator-action-required");
  assert.equal(aged[0]?.agedAt, "2026-05-02T00:00:20.000Z");

  const cleared = await store.clear({
    id: debt.id,
    ownerSpaceId: "space:lifecycle",
    now: "2026-05-02T00:03:00.000Z",
  });
  assert.equal(cleared?.status, "cleared");
  assert.equal(cleared?.clearedAt, "2026-05-02T00:03:00.000Z");
  assert.deepEqual(await store.listOpenOwnerSpaces(), []);

  const reopenedCleared = await store.reopen({
    id: debt.id,
    ownerSpaceId: "space:lifecycle",
    now: "2026-05-02T00:04:00.000Z",
  });
  assert.equal(reopenedCleared?.status, "cleared");
});
