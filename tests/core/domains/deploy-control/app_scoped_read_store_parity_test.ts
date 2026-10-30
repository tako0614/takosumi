/**
 * Store parity for the Workspace-free replacement reads (TASK-0118 9.1):
 * the multi-partition Activity keyset page, the per-app backup page, and the
 * ActivityService merge across more partitions than one store batch. The
 * in-memory, Postgres (PGlite) and SQLite-D1 stores must page identically.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { BackupRecord } from "takosumi-contract/backups";
import { ActivityService } from "../../../../core/domains/activity/mod.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(60_000);

const pgClients: PGliteSqlClient[] = [];

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const client = await PGliteSqlClient.create();
  pgClients.push(client);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

function activity(index: number, workspaceId: string): ActivityEvent {
  const seq = String(index).padStart(4, "0");
  return {
    id: `act_${workspaceId}_${seq}`,
    workspaceId,
    action: "capsule.updated",
    targetType: "capsule",
    targetId: `cap_${workspaceId}`,
    metadata: {},
    createdAt: `2026-10-30T00:00:00.${seq.slice(1)}Z`,
  };
}

function backup(index: number, capsuleId: string | undefined, workspaceId = "ws_backups"): BackupRecord {
  const seq = String(index).padStart(4, "0");
  return {
    id: `bkp_${capsuleId ?? "wide"}_${seq}`,
    workspaceId,
    ...(capsuleId ? { capsuleId, environment: "production" } : {}),
    ref: `opaque-${seq}`,
    digest: `sha256:${"b".repeat(64)}`,
    sizeBytes: 1,
    createdAt: `2026-10-30T00:00:00.${seq.slice(1)}Z`,
  };
}

async function drain<T>(
  read: (cursor: string | undefined) => Promise<{ readonly items: readonly T[]; readonly nextCursor?: string }>,
): Promise<{ readonly items: T[]; readonly pages: number }> {
  const items: T[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    pages += 1;
    const page = await read(cursor);
    items.push(...page.items);
    if (!page.nextCursor) return { items, pages };
    cursor = page.nextCursor;
    if (pages > 100) throw new Error("cursor never terminated");
  }
}

test("multi-partition Activity pages are newest-first, gap-free and isolated", async () => {
  for (const [label, store] of await stores()) {
    for (let index = 0; index < 9; index++) {
      await store.putActivityEvent(activity(index, index % 2 === 0 ? "ws_a" : "ws_b"));
    }
    await store.putActivityEvent(activity(100, "ws_other"));
    const { items, pages } = await drain((cursor) =>
      store.listActivityEventsForWorkspacesPage(["ws_a", "ws_b"], { limit: 4, ...(cursor ? { cursor } : {}) })
    );
    expect(pages, label).toBe(3);
    expect(items.map((event) => event.id), label).toEqual(
      Array.from({ length: 9 }, (_, offset) => {
        const index = 8 - offset;
        return activity(index, index % 2 === 0 ? "ws_a" : "ws_b").id;
      }),
    );
    expect(await store.listActivityEventsForWorkspacesPage([], {}), label).toEqual({ items: [] });
    await expect(
      store.listActivityEventsForWorkspacesPage(Array.from({ length: 13 }, (_, i) => `ws_${i}`), {}),
      label,
    ).rejects.toThrow(RangeError);
  }
});

test("ActivityService merges more partitions than one store batch on one keyset", async () => {
  for (const [label, store] of await stores()) {
    const partitions = Array.from({ length: 30 }, (_, index) => `ws_part_${String(index).padStart(2, "0")}`);
    // One event per partition, interleaved in time across store batches.
    for (const [index, workspaceId] of partitions.entries()) {
      await store.putActivityEvent(activity(index, workspaceId));
    }
    const service = new ActivityService({ store });
    const { items } = await drain((cursor) =>
      service.listAcrossWorkspacesPage(partitions, { limit: 7, ...(cursor ? { cursor } : {}) })
    );
    expect(items.map((event) => event.workspaceId), label).toEqual([...partitions].reverse());
    expect(new Set(items.map((event) => event.id)).size, label).toBe(30);
    await expect(
      service.listAcrossWorkspacesPage(Array.from({ length: 97 }, (_, i) => `ws_${i}`), {}),
      label,
    ).rejects.toThrow(RangeError);
  }
});

test("per-app backup pages list only that app's backups across stores", async () => {
  for (const [label, store] of await stores()) {
    for (let index = 0; index < 5; index++) await store.putBackupRecord(backup(index, "cap_mine"));
    await store.putBackupRecord(backup(10, "cap_other"));
    await store.putBackupRecord(backup(11, undefined));
    await store.putBackupRecord(backup(12, "cap_mine_elsewhere", "ws_elsewhere"));
    const { items, pages } = await drain((cursor) =>
      store.listBackupRecordsPageForCapsule("cap_mine", { limit: 2, ...(cursor ? { cursor } : {}) })
    );
    expect(pages, label).toBe(3);
    expect(items.map((record) => record.id), label).toEqual(
      [4, 3, 2, 1, 0].map((index) => backup(index, "cap_mine").id),
    );
    expect((await store.listBackupRecordsPageForCapsule("cap_none", {})).items, label).toEqual([]);
  }
});
