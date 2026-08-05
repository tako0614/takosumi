import { afterEach, describe, expect, test } from "bun:test";

import { createSqlResourceShapeStores } from "../../../../core/domains/resource-shape/sql_stores.ts";
import type { ResourceShapeStores } from "../../../../core/domains/resource-shape/stores.ts";
import { formatResourceShapeId } from "../../../../core/domains/resource-shape/records.ts";
import type {
  ResolutionLockRecord,
  ResourceShapeRecord,
  ResourceIdentityFenceRecord,
} from "../../../../core/domains/resource-shape/records.ts";
import type { SpaceId } from "../../../../core/shared/ids.ts";
import type { IsoTimestamp } from "../../../../core/shared/time.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";

const SPACE = "sp_identity_fence" as SpaceId;
const T0 = "2026-08-01T00:00:00.000Z" as IsoTimestamp;
const T1 = "2026-08-01T01:00:00.000Z" as IsoTimestamp;

let stores: ResourceShapeStores | undefined;
let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  stores = undefined;
  close = undefined;
});

async function setupStores(): Promise<ResourceShapeStores> {
  const client = await PGliteSqlClient.create();
  stores = createSqlResourceShapeStores(client);
  close = () => client.close();
  return stores;
}

function applyingRecord(
  name: string,
  generation: number,
  updatedAt: IsoTimestamp = T0,
): ResourceShapeRecord {
  return {
    id: formatResourceShapeId(SPACE, "EdgeWorker", name),
    revision: 0,
    spaceId: SPACE,
    kind: "EdgeWorker",
    name,
    managedBy: "api",
    spec: { generation },
    phase: "Applying",
    generation,
    observedGeneration: generation - 1,
    createdAt: T0,
    updatedAt,
  };
}

function lock(
  resourceId: string,
  updatedAt: IsoTimestamp = T0,
): ResolutionLockRecord {
  return {
    resourceId,
    selectedImplementation: "workers_script",
    target: "local",
    locked: true,
    reason: [],
    lockedAt: T0,
    updatedAt,
  };
}

function version(record: ResourceShapeRecord) {
  return {
    generation: record.generation,
    phase: record.phase,
    updatedAt: record.updatedAt,
  } as const;
}

describe("Postgres Resource identity fence store", () => {
  test("lazily consumes a missing fence and rejects a stale expected absence", async () => {
    const durable = await setupStores();
    const first = applyingRecord("lazy", 1);
    const firstLock = lock(first.id);

    expect(await durable.getResourceIdentityFence(first.id)).toBeUndefined();
    expect(
      await durable.beginApply({
        applyingRecord: first,
        plannedLock: firstLock,
        expectedIdentityFence: null,
      }),
    ).toMatchObject({ status: "begun", record: first, lock: firstLock });

    const fence: ResourceIdentityFenceRecord = {
      resourceId: first.id,
      lastGeneration: 1,
      fenceRevision: 1,
    };
    expect(await durable.getResourceIdentityFence(first.id)).toEqual(fence);

    const next = applyingRecord("lazy", 2, T1);
    const stale = await durable.beginApply({
      applyingRecord: next,
      plannedLock: lock(first.id, T1),
      expected: version(first),
      expectedIdentityFence: null,
    });
    expect(stale).toEqual({ status: "identity_fence_conflict", fence });
    expect(await durable.resources.get(first.id)).toEqual(first);
    expect(await durable.locks.get(first.id)).toEqual(firstLock);
    expect(await durable.getResourceIdentityFence(first.id)).toEqual(fence);
  });

  test("abort rolls back the consumed fence with the Applying pair", async () => {
    const durable = await setupStores();
    const applying = applyingRecord("abort", 1);
    const plannedLock = lock(applying.id);
    const begun = await durable.beginApply({
      applyingRecord: applying,
      plannedLock,
      expectedIdentityFence: null,
    });
    expect(begun.status).toBe("begun");

    const consumed: ResourceIdentityFenceRecord = {
      resourceId: applying.id,
      lastGeneration: 1,
      fenceRevision: 1,
    };
    expect(
      await durable.abortApply({
        resourceId: applying.id,
        expectedApplying: version(applying),
        expectedPlannedLock: plannedLock,
        replacement: null,
        identityFenceRollback: {
          expected: consumed,
          replacement: null,
        },
      }),
    ).toEqual({ status: "rolled_back" });
    expect(await durable.resources.get(applying.id)).toBeUndefined();
    expect(await durable.locks.get(applying.id)).toBeUndefined();
    expect(await durable.getResourceIdentityFence(applying.id)).toBeUndefined();
  });

  test("remove retires a lazy legacy Resource and the next incarnation advances it", async () => {
    const durable = await setupStores();
    const live = {
      ...applyingRecord("retire", 1),
      phase: "Ready" as const,
      observedGeneration: 1,
    };
    const liveLock = lock(live.id);
    await durable.resources.upsert(live);
    await durable.locks.put(liveLock);

    expect(
      await durable.removeResource({
        resourceId: live.id,
        expected: version(live),
        expectedLock: liveLock,
      }),
    ).toEqual({ status: "removed" });
    const retired: ResourceIdentityFenceRecord = {
      resourceId: live.id,
      lastGeneration: 1,
      fenceRevision: 1,
    };
    expect(await durable.getResourceIdentityFence(live.id)).toEqual(retired);

    const next = applyingRecord("retire", 2, T1);
    const nextLock = lock(next.id, T1);
    expect(
      await durable.beginApply({
        applyingRecord: next,
        plannedLock: nextLock,
        expectedIdentityFence: retired,
      }),
    ).toMatchObject({ status: "begun", record: next, lock: nextLock });
    expect(await durable.getResourceIdentityFence(next.id)).toEqual({
      resourceId: next.id,
      lastGeneration: 2,
      fenceRevision: 2,
    });
  });

  test("retains the retired owner receipt and clears it for the next incarnation", async () => {
    const durable = await setupStores();
    const owner = {
      kind: "Capsule" as const,
      id: "cap_identity_fence",
      workspaceId: SPACE,
      installingPrincipalId: "acct_identity_fence",
    };
    const live = {
      ...applyingRecord("owner-receipt", 1),
      owner,
      phase: "Ready" as const,
      observedGeneration: 1,
    };
    const liveLock = lock(live.id);
    await durable.resources.upsert(live);
    await durable.locks.put(liveLock);

    expect(
      await durable.removeResource({
        resourceId: live.id,
        expected: version(live),
        expectedLock: liveLock,
      }),
    ).toEqual({ status: "removed" });
    const retired = await durable.getResourceIdentityFence(live.id);
    expect(retired).toEqual({
      resourceId: live.id,
      lastGeneration: 1,
      fenceRevision: 1,
      retiredOwner: owner,
    });

    const next = applyingRecord("owner-receipt", 2, T1);
    expect(
      await durable.beginApply({
        applyingRecord: next,
        plannedLock: lock(next.id, T1),
        expectedIdentityFence: retired!,
      }),
    ).toMatchObject({ status: "begun", record: next });
    expect(await durable.getResourceIdentityFence(live.id)).toEqual({
      resourceId: live.id,
      lastGeneration: 2,
      fenceRevision: 2,
    });
  });
});
