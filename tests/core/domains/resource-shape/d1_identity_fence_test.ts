import { beforeEach, describe, expect, test } from "bun:test";

import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import type { D1PreparedStatement } from "../../../../worker/src/bindings.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import {
  createD1ResourceShapeStores,
  type D1Like,
} from "../../../../core/domains/resource-shape/d1_stores.ts";
import type {
  ResolutionLockRecord,
  ResourceIdentityFenceRecord,
  ResourceShapeRecord,
} from "../../../../core/domains/resource-shape/records.ts";
import {
  type ResourceApplyBeginResult,
  type ResourceShapeStores,
} from "../../../../core/domains/resource-shape/stores.ts";
import { formatResourceShapeId } from "../../../../core/domains/resource-shape/records.ts";
import type { SpaceId } from "../../../../core/shared/ids.ts";
import type { IsoTimestamp } from "../../../../core/shared/time.ts";

const SPACE = "sp_identity_fence" as SpaceId;
const RESOURCE_ID = formatResourceShapeId(SPACE, "EdgeWorker", "api");
const T0 = "2026-07-01T00:00:00.000Z" as IsoTimestamp;
const T1 = "2026-07-01T01:00:00.000Z" as IsoTimestamp;

function applyingRecord(
  generation = 1,
  updatedAt: IsoTimestamp = T1,
  revision = 0,
  claimantRunId?: string,
): ResourceShapeRecord {
  return {
    id: RESOURCE_ID,
    revision,
    spaceId: SPACE,
    kind: "EdgeWorker",
    name: "api",
    managedBy: "api",
    spec: {},
    phase: "Applying",
    generation,
    observedGeneration: generation - 1,
    createdAt: T0,
    updatedAt,
    ...(claimantRunId
      ? {
          pendingOperation: {
            runId: claimantRunId,
            operation: "apply" as const,
            operationKey: `apply:${claimantRunId}`,
            authority: "resource_claim" as const,
          },
        }
      : {}),
  };
}

function pendingRecord(
  generation = 1,
  updatedAt: IsoTimestamp = T0,
  revision = 0,
): ResourceShapeRecord {
  return {
    ...applyingRecord(generation, updatedAt, revision),
    phase: "Pending",
  };
}

function lock(updatedAt: IsoTimestamp = T0): ResolutionLockRecord {
  return {
    resourceId: RESOURCE_ID,
    selectedImplementation: "cloudflare_workers",
    target: "target",
    locked: true,
    reason: ["test"],
    lockedAt: T0,
    updatedAt,
  };
}

async function setup(): Promise<{
  readonly db: SqliteFakeD1;
  readonly stores: ResourceShapeStores;
}> {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  return { db, stores: createD1ResourceShapeStores(db) };
}

class CommitThenThrowD1 implements D1Like {
  constructor(
    private readonly delegate: SqliteFakeD1,
    private readonly afterCommit?: () => Promise<void>,
  ) {}

  prepare(query: string): D1PreparedStatement {
    return this.delegate.prepare(query);
  }

  async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly { readonly meta?: { readonly changes?: number } }[]> {
    await this.delegate.batch<T>(statements);
    await this.afterCommit?.();
    throw new Error("simulated D1 acknowledgement loss");
  }
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}

class GatedBatchD1 implements D1Like {
  constructor(
    private readonly delegate: SqliteFakeD1,
    private readonly entered: () => void,
    private readonly release: Promise<void>,
  ) {}

  prepare(query: string): D1PreparedStatement {
    return this.delegate.prepare(query);
  }

  async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly { readonly meta?: { readonly changes?: number } }[]> {
    this.entered();
    await this.release;
    return this.delegate.batch<T>(statements);
  }
}

function expectBegun(
  result: ResourceApplyBeginResult,
): Extract<ResourceApplyBeginResult, { readonly status: "begun" }> {
  expect(result.status).toBe("begun");
  if (result.status !== "begun") throw new Error("expected begun result");
  return result;
}

describe("D1 Resource identity fences", () => {
  let db: SqliteFakeD1;
  let stores: ResourceShapeStores;

  beforeEach(async () => {
    ({ db, stores } = await setup());
  });

  test("consumes an absent fence atomically and reports stale CAS", async () => {
    const first = expectBegun(
      await stores.beginApply({
        applyingRecord: applyingRecord(),
        plannedLock: lock(),
        expectedIdentityFence: null,
      }),
    );
    const consumed: ResourceIdentityFenceRecord = {
      resourceId: RESOURCE_ID,
      lastGeneration: 1,
      fenceRevision: 1,
    };
    expect(await stores.getResourceIdentityFence(RESOURCE_ID)).toEqual(
      consumed,
    );

    const stale = await stores.beginApply({
      applyingRecord: applyingRecord(),
      plannedLock: lock(),
      expectedIdentityFence: null,
    });
    expect(stale).toEqual({
      status: "identity_fence_conflict",
      fence: consumed,
    });
    expect(await stores.resources.get(RESOURCE_ID)).toEqual(first.record);
    expect(await stores.locks.get(RESOURCE_ID)).toEqual(first.lock);
  });

  test("re-reads a committed apply after D1 acknowledgement loss", async () => {
    const inner = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(inner);
    const db = new CommitThenThrowD1(inner);
    const durableStores = createD1ResourceShapeStores(db);
    const applying = applyingRecord(1, T1, 0, "ack-loss-winner");
    const plannedLock = lock();

    const result = await durableStores.beginApply({
      applyingRecord: applying,
      plannedLock,
      expectedIdentityFence: null,
    });
    expect(result).toEqual({
      status: "begun",
      record: applying,
      lock: plannedLock,
    });
    expect(await durableStores.getResourceIdentityFence(RESOURCE_ID)).toEqual({
      resourceId: RESOURCE_ID,
      lastGeneration: 1,
      fenceRevision: 1,
    });
  });

  test("only the exact claimant wins after two callers preflight the same fence", async () => {
    const inner = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(inner);
    const firstEntered = deferred();
    const secondEntered = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const firstStores = createD1ResourceShapeStores(
      new GatedBatchD1(inner, firstEntered.resolve, releaseFirst.promise),
    );
    const secondStores = createD1ResourceShapeStores(
      new GatedBatchD1(inner, secondEntered.resolve, releaseSecond.promise),
    );
    const firstRecord = applyingRecord(1, T1, 0, "claim-a");
    const secondRecord = applyingRecord(1, T1, 0, "claim-b");

    const first = firstStores.beginApply({
      applyingRecord: firstRecord,
      plannedLock: lock(),
      expectedIdentityFence: null,
    });
    await firstEntered.promise;
    const second = secondStores.beginApply({
      applyingRecord: secondRecord,
      plannedLock: lock(),
      expectedIdentityFence: null,
    });
    await secondEntered.promise;

    releaseFirst.resolve();
    expect(await first).toEqual({
      status: "begun",
      record: firstRecord,
      lock: lock(),
    });
    releaseSecond.resolve();
    expect(await second).toEqual({
      status: "identity_fence_conflict",
      fence: {
        resourceId: RESOURCE_ID,
        lastGeneration: 1,
        fenceRevision: 1,
      },
    });
    expect(await firstStores.resources.get(RESOURCE_ID)).toEqual(firstRecord);
  });

  test("keeps a competing fence winner fail-closed after acknowledgement loss", async () => {
    const inner = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(inner);
    const db = new CommitThenThrowD1(inner, async () => {
      await inner
        .prepare(
          `update resource_identity_fences
           set fence_revision = fence_revision + 1
           where resource_id = ?`,
        )
        .bind(RESOURCE_ID)
        .run();
    });
    const durableStores = createD1ResourceShapeStores(db);
    const applying = applyingRecord();
    const plannedLock = lock();

    const result = await durableStores.beginApply({
      applyingRecord: applying,
      plannedLock,
      expectedIdentityFence: null,
    });
    expect(result).toEqual({
      status: "identity_fence_conflict",
      fence: {
        resourceId: RESOURCE_ID,
        lastGeneration: 1,
        fenceRevision: 2,
      },
    });
    expect(await durableStores.resources.get(RESOURCE_ID)).toEqual(applying);
    expect(await durableStores.locks.get(RESOURCE_ID)).toEqual(plannedLock);
  });

  test("remove retires a tombstone and allows only the next generation", async () => {
    const begun = expectBegun(
      await stores.beginApply({
        applyingRecord: applyingRecord(),
        plannedLock: lock(),
        expectedIdentityFence: null,
      }),
    );
    expect(
      await stores.removeResource({
        resourceId: RESOURCE_ID,
        expected: {
          generation: begun.record.generation,
          phase: begun.record.phase,
          updatedAt: begun.record.updatedAt,
          revision: begun.record.revision,
        },
        expectedLock: begun.lock,
      }),
    ).toEqual({ status: "removed" });
    const tombstone: ResourceIdentityFenceRecord = {
      resourceId: RESOURCE_ID,
      lastGeneration: 1,
      fenceRevision: 2,
    };
    expect(await stores.resources.get(RESOURCE_ID)).toBeUndefined();
    expect(await stores.locks.get(RESOURCE_ID)).toBeUndefined();
    expect(await stores.getResourceIdentityFence(RESOURCE_ID)).toEqual(
      tombstone,
    );

    const stale = await stores.beginApply({
      applyingRecord: applyingRecord(2),
      plannedLock: lock(),
      expectedIdentityFence: { ...tombstone, fenceRevision: 1 },
    });
    expect(stale).toEqual({
      status: "identity_fence_conflict",
      fence: tombstone,
    });

    const next = expectBegun(
      await stores.beginApply({
        applyingRecord: applyingRecord(2),
        plannedLock: lock(T1),
        expectedIdentityFence: tombstone,
      }),
    );
    expect(next.record.generation).toBe(2);
    expect(await stores.getResourceIdentityFence(RESOURCE_ID)).toEqual({
      resourceId: RESOURCE_ID,
      lastGeneration: 2,
      fenceRevision: 3,
    });
  });

  test("retains the retired owner receipt and clears it for the next incarnation", async () => {
    const owner = {
      kind: "Capsule" as const,
      id: "cap_identity_fence",
      workspaceId: SPACE,
      installingPrincipalId: "acct_identity_fence",
    };
    const begun = expectBegun(
      await stores.beginApply({
        applyingRecord: { ...applyingRecord(), owner },
        plannedLock: lock(),
        expectedIdentityFence: null,
      }),
    );
    expect(
      await stores.removeResource({
        resourceId: RESOURCE_ID,
        expected: {
          generation: begun.record.generation,
          phase: begun.record.phase,
          updatedAt: begun.record.updatedAt,
          revision: begun.record.revision,
        },
        expectedLock: begun.lock,
      }),
    ).toEqual({ status: "removed" });
    const retired = await stores.getResourceIdentityFence(RESOURCE_ID);
    expect(retired).toEqual({
      resourceId: RESOURCE_ID,
      lastGeneration: 1,
      fenceRevision: 2,
      retiredOwner: owner,
    });

    expectBegun(
      await stores.beginApply({
        applyingRecord: applyingRecord(2, T1),
        plannedLock: lock(T1),
        expectedIdentityFence: retired!,
      }),
    );
    expect(await stores.getResourceIdentityFence(RESOURCE_ID)).toEqual({
      resourceId: RESOURCE_ID,
      lastGeneration: 2,
      fenceRevision: 3,
    });
  });

  test("abort rolls back the consumed fence with Resource and ResolutionLock", async () => {
    const begun = expectBegun(
      await stores.beginApply({
        applyingRecord: applyingRecord(),
        plannedLock: lock(),
        expectedIdentityFence: null,
      }),
    );
    const consumed = await stores.getResourceIdentityFence(RESOURCE_ID);
    expect(consumed).not.toBeUndefined();
    expect(
      await stores.abortApply({
        resourceId: RESOURCE_ID,
        expectedApplying: {
          generation: begun.record.generation,
          phase: "Applying",
          updatedAt: begun.record.updatedAt,
          revision: begun.record.revision,
        },
        expectedPlannedLock: begun.lock,
        replacement: null,
        identityFenceRollback: {
          expected: consumed!,
          replacement: null,
        },
      }),
    ).toEqual({ status: "rolled_back" });
    expect(await stores.resources.get(RESOURCE_ID)).toBeUndefined();
    expect(await stores.locks.get(RESOURCE_ID)).toBeUndefined();
    expect(await stores.getResourceIdentityFence(RESOURCE_ID)).toBeUndefined();
  });

  test("recovers a create-only rollback after D1 acknowledgement loss", async () => {
    const inner = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(inner);
    const reliableStores = createD1ResourceShapeStores(inner);
    const begun = expectBegun(
      await reliableStores.beginApply({
        applyingRecord: applyingRecord(1, T1, 0, "rollback-create"),
        plannedLock: lock(),
        expectedIdentityFence: null,
      }),
    );
    const consumed = await reliableStores.getResourceIdentityFence(RESOURCE_ID);
    expect(consumed).not.toBeUndefined();
    const unreliableStores = createD1ResourceShapeStores(
      new CommitThenThrowD1(inner),
    );

    expect(
      await unreliableStores.abortApply({
        resourceId: RESOURCE_ID,
        expectedApplying: {
          generation: begun.record.generation,
          phase: "Applying",
          updatedAt: begun.record.updatedAt,
          revision: begun.record.revision,
        },
        expectedPlannedLock: begun.lock,
        replacement: null,
        identityFenceRollback: {
          expected: consumed!,
          replacement: null,
        },
      }),
    ).toEqual({ status: "rolled_back" });
    expect(await reliableStores.resources.get(RESOURCE_ID)).toBeUndefined();
    expect(await reliableStores.locks.get(RESOURCE_ID)).toBeUndefined();
    expect(
      await reliableStores.getResourceIdentityFence(RESOURCE_ID),
    ).toBeUndefined();
  });

  test("recovers an exact replacement rollback after D1 acknowledgement loss", async () => {
    const inner = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(inner);
    const reliableStores = createD1ResourceShapeStores(inner);
    const prior = pendingRecord();
    const priorLock = lock();
    await reliableStores.resources.upsert(prior);
    await reliableStores.locks.put(priorLock);
    const begun = expectBegun(
      await reliableStores.beginApply({
        applyingRecord: applyingRecord(1, T1, 0, "rollback-replacement"),
        plannedLock: lock(T1),
        expected: {
          generation: prior.generation,
          phase: prior.phase,
          updatedAt: prior.updatedAt,
          revision: prior.revision,
        },
        expectedIdentityFence: null,
      }),
    );
    const consumed = await reliableStores.getResourceIdentityFence(RESOURCE_ID);
    expect(consumed).not.toBeUndefined();
    const unreliableStores = createD1ResourceShapeStores(
      new CommitThenThrowD1(inner),
    );

    expect(
      await unreliableStores.abortApply({
        resourceId: RESOURCE_ID,
        expectedApplying: {
          generation: begun.record.generation,
          phase: "Applying",
          updatedAt: begun.record.updatedAt,
          revision: begun.record.revision,
        },
        expectedPlannedLock: begun.lock,
        replacement: { record: prior, lock: priorLock },
        identityFenceRollback: {
          expected: consumed!,
          replacement: null,
        },
      }),
    ).toEqual({ status: "rolled_back" });
    expect(await reliableStores.resources.get(RESOURCE_ID)).toEqual({
      ...prior,
      revision: 2,
    });
    expect(await reliableStores.locks.get(RESOURCE_ID)).toEqual(priorLock);
    expect(
      await reliableStores.getResourceIdentityFence(RESOURCE_ID),
    ).toBeUndefined();
  });

  test("lazily creates the fence for a legacy Resource without one", async () => {
    await stores.resources.upsert(pendingRecord());
    await stores.locks.put(lock());
    const begun = expectBegun(
      await stores.beginApply({
        applyingRecord: applyingRecord(),
        plannedLock: lock(T1),
        expected: {
          generation: 1,
          phase: "Pending",
          updatedAt: T0,
          revision: 0,
        },
        expectedIdentityFence: null,
      }),
    );
    expect(begun.record.revision).toBe(1);
    expect(await stores.getResourceIdentityFence(RESOURCE_ID)).toEqual({
      resourceId: RESOURCE_ID,
      lastGeneration: 1,
      fenceRevision: 1,
    });
    expect(
      await db
        .prepare("select count(*) as count from resource_identity_fences")
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });
});
