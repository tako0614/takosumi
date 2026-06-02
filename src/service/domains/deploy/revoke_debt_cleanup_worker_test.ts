import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type ApplyResult,
  type PlatformContext,
  type ProviderPlugin,
  registerProvider,
  type ResourceHandle,
  unregisterProvider,
} from "takosumi-contract/internal/provider-plugin";
import type {
  PlatformOperationContext,
} from "takosumi-contract/reference/runtime-agent-lifecycle";
import type { JsonObject } from "takosumi-contract/reference/types";
import {
  InMemoryRevokeDebtStore,
  type RevokeDebtRecord,
} from "./revoke_debt_store.ts";
import {
  InMemoryTakosumiDeploymentRecordStore,
} from "./takosumi_deployment_record_store.ts";
import { RevokeDebtCleanupWorker } from "./revoke_debt_cleanup_worker.ts";

const PROVIDER_COMPENSATE = "test-revoke-debt-compensate";
const PROVIDER_DESTROY = "test-revoke-debt-destroy";
const SHAPE = "test-revoke-debt-shape";
const context = {} as PlatformContext;

function provider(input: {
  readonly id: string;
  readonly compensate?: (
    handle: ResourceHandle,
    ctx: PlatformContext,
  ) => Promise<{ ok: boolean; revokeDebtRequired?: boolean; note?: string }>;
  readonly destroy?: (
    handle: ResourceHandle,
    ctx: PlatformContext,
  ) => Promise<void>;
}): ProviderPlugin {
  return {
    id: input.id,
    version: "0.0.1",
    implements: { id: SHAPE, version: "v1" },
    capabilities: ["test"],
    apply(): Promise<ApplyResult> {
      return Promise.resolve({ handle: "unused", outputs: {} });
    },
    destroy(handle, ctx): Promise<void> {
      return input.destroy?.(handle, ctx) ?? Promise.resolve();
    },
    ...(input.compensate ? { compensate: input.compensate } : {}),
    status() {
      return Promise.resolve({
        kind: "ready" as const,
        observedAt: new Date(0).toISOString(),
      });
    },
  };
}

async function seedDebt(input: {
  readonly store: InMemoryRevokeDebtStore;
  readonly providerId: string;
  readonly retryPolicy?: JsonObject;
  readonly detail?: JsonObject;
}): Promise<RevokeDebtRecord> {
  return await input.store.enqueue({
    generatedObjectId: "generated:takosumi-public-deploy/app/cache",
    reason: "activation-rollback",
    ownerSpaceId: "space:cleanup",
    deploymentName: "app",
    operationPlanDigest:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    journalEntryId: "operation:cleanup",
    operationId: "operation:cleanup",
    resourceName: "cache",
    providerId: input.providerId,
    retryPolicy: input.retryPolicy,
    detail: input.detail,
    now: "2026-05-02T00:00:00.000Z",
  });
}

async function seedDeployment(
  store: InMemoryTakosumiDeploymentRecordStore,
  providerId: string,
): Promise<void> {
  await store.upsert({
    tenantId: "space:cleanup",
    name: "app",
    manifest: {
      apiVersion: "1.0",
      kind: "Manifest",
      metadata: { name: "app" },
      resources: [],
    },
    appliedResources: [{
      resourceName: "cache",
      shape: `${SHAPE}@v1`,
      providerId,
      handle: "handle:cache",
      outputs: {},
      appliedAt: "2026-05-02T00:00:00.000Z",
    }],
    status: "failed",
    now: "2026-05-02T00:00:00.000Z",
  });
}

test("RevokeDebtCleanupWorker clears debt through provider compensate", async () => {
  const revokeDebtStore = new InMemoryRevokeDebtStore({
    idFactory: () => "revoke-debt:cleanup-one",
  });
  const deploymentStore = new InMemoryTakosumiDeploymentRecordStore();
  const seen: {
    handle?: string;
    operation?: PlatformOperationContext;
  } = {};
  registerProvider(provider({
    id: PROVIDER_COMPENSATE,
    compensate(handle, ctx) {
      seen.handle = handle;
      seen.operation = ctx.operation;
      return Promise.resolve({ ok: true });
    },
  }));
  try {
    const debt = await seedDebt({
      store: revokeDebtStore,
      providerId: PROVIDER_COMPENSATE,
    });
    await seedDeployment(deploymentStore, PROVIDER_COMPENSATE);
    const worker = new RevokeDebtCleanupWorker({
      revokeDebtStore,
      deploymentRecordStore: deploymentStore,
      context,
      clock: () => new Date("2026-05-02T00:00:01.000Z"),
    });

    const result = await worker.processOwnerSpace({
      ownerSpaceId: "space:cleanup",
    });

    assert.equal(result.attempted, 1);
    assert.equal(result.cleared, 1);
    assert.equal(seen.handle, "handle:cache");
    assert.equal(seen.operation?.phase, "compensate");
    assert.equal(seen.operation?.resourceName, "cache");
    assert.match(
      seen.operation?.idempotencyKeyString ?? "",
      /^space:cleanup:sha256:a{64}:revoke-debt:revoke-debt:cleanup-one$/,
    );
    const [stored] = await revokeDebtStore.listByOwnerSpace(
      debt.ownerSpaceId,
    );
    assert.equal(stored?.status, "cleared");
    assert.equal(stored?.clearedAt, "2026-05-02T00:00:01.000Z");
  } finally {
    unregisterProvider(PROVIDER_COMPENSATE);
  }
});

test("RevokeDebtCleanupWorker falls back to destroy when compensate is absent", async () => {
  const revokeDebtStore = new InMemoryRevokeDebtStore({
    idFactory: () => "revoke-debt:cleanup-destroy",
  });
  const deploymentStore = new InMemoryTakosumiDeploymentRecordStore();
  let destroyed = "";
  registerProvider(provider({
    id: PROVIDER_DESTROY,
    destroy(handle) {
      destroyed = handle;
      return Promise.resolve();
    },
  }));
  try {
    await seedDebt({ store: revokeDebtStore, providerId: PROVIDER_DESTROY });
    await seedDeployment(deploymentStore, PROVIDER_DESTROY);
    const worker = new RevokeDebtCleanupWorker({
      revokeDebtStore,
      deploymentRecordStore: deploymentStore,
      context,
      clock: () => new Date("2026-05-02T00:00:01.000Z"),
    });

    const result = await worker.processOwnerSpace({
      ownerSpaceId: "space:cleanup",
    });

    assert.equal(result.cleared, 1);
    assert.equal(destroyed, "handle:cache");
  } finally {
    unregisterProvider(PROVIDER_DESTROY);
  }
});

test("RevokeDebtCleanupWorker records retryable compensation failure", async () => {
  const revokeDebtStore = new InMemoryRevokeDebtStore({
    idFactory: () => "revoke-debt:cleanup-retry",
  });
  const deploymentStore = new InMemoryTakosumiDeploymentRecordStore();
  registerProvider(
    provider({
      id: PROVIDER_COMPENSATE,
      compensate() {
        return Promise.resolve({
          ok: false,
          note: "remote still deleting",
        });
      },
    }),
    { allowOverride: true },
  );
  try {
    await seedDebt({
      store: revokeDebtStore,
      providerId: PROVIDER_COMPENSATE,
      retryPolicy: {
        kind: "operator-managed",
        backoffMs: 5000,
        maxAttempts: 2,
      },
    });
    await seedDeployment(deploymentStore, PROVIDER_COMPENSATE);
    const worker = new RevokeDebtCleanupWorker({
      revokeDebtStore,
      deploymentRecordStore: deploymentStore,
      context,
      clock: () => new Date("2026-05-02T00:00:01.000Z"),
    });

    const result = await worker.processOwnerSpace({
      ownerSpaceId: "space:cleanup",
    });

    assert.equal(result.retrying, 1);
    const [stored] = await revokeDebtStore.listByOwnerSpace("space:cleanup");
    assert.equal(stored?.status, "open");
    assert.equal(stored?.retryAttempts, 1);
    assert.equal(stored?.nextRetryAt, "2026-05-02T00:00:06.000Z");
    assert.equal(stored?.lastRetryError?.code, "compensate_failed");
  } finally {
    unregisterProvider(PROVIDER_COMPENSATE);
  }
});

test("RevokeDebtCleanupWorker does not let not-due debts starve a due debt against the per-tick limit", async () => {
  const revokeDebtStore = new InMemoryRevokeDebtStore();
  const deploymentStore = new InMemoryTakosumiDeploymentRecordStore();
  registerProvider(
    provider({
      id: PROVIDER_COMPENSATE,
      compensate() {
        return Promise.resolve({ ok: true });
      },
    }),
    { allowOverride: true },
  );
  try {
    // Seed three leading debts created BEFORE the due one (so they sort
    // ahead by createdAt) whose nextRetryAt is far in the future = not due.
    const notDueIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const debt = await revokeDebtStore.enqueue({
        generatedObjectId: `generated:takosumi-public-deploy/app/not-due-${i}`,
        reason: "activation-rollback",
        ownerSpaceId: "space:cleanup",
        deploymentName: "app",
        journalEntryId: `operation:not-due-${i}`,
        operationId: `operation:not-due-${i}`,
        resourceName: "cache",
        providerId: PROVIDER_COMPENSATE,
        retryPolicy: { kind: "operator-managed", backoffSeconds: 3600 },
        now: "2026-05-02T00:00:00.000Z",
      });
      // Push nextRetryAt one hour into the future so it is not due at tick.
      await revokeDebtStore.recordRetryAttempt({
        id: debt.id,
        ownerSpaceId: "space:cleanup",
        result: "retryable-failure",
        now: "2026-05-02T00:00:00.000Z",
      });
      notDueIds.push(debt.id);
    }

    // One due debt created LATER (sorts after the not-due ones) so the old
    // implementation would spend the per-tick limit on the leading skips.
    const dueDebt = await revokeDebtStore.enqueue({
      generatedObjectId: "generated:takosumi-public-deploy/app/due",
      reason: "activation-rollback",
      ownerSpaceId: "space:cleanup",
      deploymentName: "app",
      journalEntryId: "operation:due",
      operationId: "operation:due",
      resourceName: "cache",
      providerId: PROVIDER_COMPENSATE,
      now: "2026-05-02T00:01:00.000Z",
    });
    await seedDeployment(deploymentStore, PROVIDER_COMPENSATE);

    const worker = new RevokeDebtCleanupWorker({
      revokeDebtStore,
      deploymentRecordStore: deploymentStore,
      context,
      clock: () => new Date("2026-05-02T00:02:00.000Z"),
    });

    // limit:1 — the only due debt must be processed, never starved behind
    // the 3 leading not-due debts.
    const result = await worker.processOwnerSpace({
      ownerSpaceId: "space:cleanup",
      limit: 1,
    });

    assert.equal(result.attempted, 1);
    assert.equal(result.cleared, 1);
    assert.equal(result.skipped, 0);
    const [cleared] = result.attempts;
    assert.equal(cleared?.debtId, dueDebt.id);
    const stored = await revokeDebtStore.listByOwnerSpace("space:cleanup");
    const dueStored = stored.find((row) => row.id === dueDebt.id);
    assert.equal(dueStored?.status, "cleared");
    // The not-due debts are untouched (still open).
    for (const id of notDueIds) {
      const row = stored.find((entry) => entry.id === id);
      assert.equal(row?.status, "open");
    }
  } finally {
    unregisterProvider(PROVIDER_COMPENSATE);
  }
});

test("RevokeDebtCleanupWorker blocks debt when cleanup handle is unresolved", async () => {
  const revokeDebtStore = new InMemoryRevokeDebtStore({
    idFactory: () => "revoke-debt:cleanup-missing",
  });
  const deploymentStore = new InMemoryTakosumiDeploymentRecordStore();
  registerProvider(provider({ id: PROVIDER_COMPENSATE }), {
    allowOverride: true,
  });
  try {
    await seedDebt({
      store: revokeDebtStore,
      providerId: PROVIDER_COMPENSATE,
    });
    const worker = new RevokeDebtCleanupWorker({
      revokeDebtStore,
      deploymentRecordStore: deploymentStore,
      context,
      clock: () => new Date("2026-05-02T00:00:01.000Z"),
    });

    const result = await worker.processOwnerSpace({
      ownerSpaceId: "space:cleanup",
    });

    assert.equal(result.operatorActionRequired, 1);
    const [stored] = await revokeDebtStore.listByOwnerSpace("space:cleanup");
    assert.equal(stored?.status, "operator-action-required");
    assert.equal(stored?.lastRetryError?.code, "cleanup_target_missing");
  } finally {
    unregisterProvider(PROVIDER_COMPENSATE);
  }
});
