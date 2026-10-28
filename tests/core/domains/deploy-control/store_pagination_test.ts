/**
 * Keyset-pagination symmetry for the deferred §30 list reads that were bounded
 * after the stage-3 cohort: usage events (newest-first / descending) and control
 * backups (newest-first / descending). Each asserts
 * the default cap (≤100), a complete gap-free / dup-free cursor traversal across
 * the keyset boundary, and an explicit `?limit=`. The in-memory twin and the
 * D1-shaped store must behave identically.
 */
import { expect, test } from "bun:test";

import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import type { OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import type { UsageEvent } from "takosumi-contract/billing";
import type { BackupRecord } from "takosumi-contract/backups";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { Workspace } from "takosumi-contract/workspaces";

const STORES: ReadonlyArray<[string, () => OpenTofuControlStore]> = [
  ["in-memory", () => new InMemoryOpenTofuControlStore()],
  ["d1", () => new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
];

function usageEvent(i: number, workspaceId = "workspace_1"): UsageEvent {
  const seq = String(i).padStart(4, "0");
  return {
    id: `usage_${"0".repeat(11)}${seq}`,
    workspaceId,
    kind: "operation",
    quantity: 1,
    usdMicros: 0,
    ratingStatus: "unrated",
    source: "runner",
    idempotencyKey: `apply_${seq}:operation`,
    createdAt: `2026-06-06T00:00:00.${seq}Z`,
  };
}

function backupRecord(i: number, workspaceId = "workspace_1"): BackupRecord {
  const seq = String(i).padStart(4, "0");
  return {
    id: `bkp_${"0".repeat(13)}${seq}`,
    workspaceId,
    ref: `opaque-backup-${workspaceId}-${seq}`,
    digest: "sha256:" + "b".repeat(64),
    sizeBytes: 2048,
    createdAt: `2026-06-06T00:00:00.${seq}Z`,
  };
}

function activityEvent(
  i: number,
  over: Partial<ActivityEvent> = {},
): ActivityEvent {
  const seq = String(i).padStart(4, "0");
  return {
    id: `act_${"0".repeat(13)}${seq}`,
    workspaceId: "workspace_1",
    action: "resource.observe.succeeded",
    targetType: "resource",
    targetId: "tkrn:workspace_1:ObjectBucket:assets",
    metadata: { generation: i },
    createdAt: `2026-06-06T00:00:00.${seq}Z`,
    ...over,
  };
}

function workspace(i: number): Workspace {
  const seq = String(i).padStart(4, "0");
  return {
    id: `ws_${"0".repeat(14)}${seq}`,
    handle: `workspace-${seq}`,
    displayName: `Workspace ${seq}`,
    type: "organization",
    ownerUserId: "owner_1",
    createdAt: `2026-06-06T00:00:00.${seq}Z`,
    updatedAt: `2026-06-06T00:00:00.${seq}Z`,
  };
}

for (const [name, make] of STORES) {
  test(`${name}: scheduler Workspace pages are bounded and gap-free`, async () => {
    const store = make();
    for (let i = 0; i < 5; i += 1) {
      await store.putWorkspace(workspace(i));
    }

    const first = await store.listWorkspacesPage({ limit: 2 });
    const second = await store.listWorkspacesPage({
      limit: 2,
      cursor: first.nextCursor,
    });
    const third = await store.listWorkspacesPage({
      limit: 2,
      cursor: second.nextCursor,
    });

    expect([
      ...first.items,
      ...second.items,
      ...third.items,
    ].map((row) => row.id)).toEqual(
      Array.from(
        { length: 5 },
        (_, i) => `ws_${"0".repeat(14)}${String(i).padStart(4, "0")}`,
      ),
    );
    expect(first.nextCursor).toBeDefined();
    expect(second.nextCursor).toBeDefined();
    expect(third.nextCursor).toBeUndefined();
  });

  test(`${name}: target Activity pages are bounded, isolated, and newest-first`, async () => {
    const store = make();
    const total = 250;
    for (let i = 0; i < total; i += 1) {
      await store.putActivityEvent(activityEvent(i));
    }
    await store.putActivityEvent(
      activityEvent(9998, {
        id: "act_other_target_9998",
        targetId: "tkrn:workspace_1:KVStore:cache",
      }),
    );
    await store.putActivityEvent(
      activityEvent(9999, {
        id: "act_other_space_9999",
        workspaceId: "workspace_2",
      }),
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      pages += 1;
      const page = await store.listActivityEventsForTargetPage(
        "workspace_1",
        "resource",
        "tkrn:workspace_1:ObjectBucket:assets",
        cursor === undefined ? {} : { cursor },
      );
      expect(page.items.length).toBeLessThanOrEqual(100);
      seen.push(...page.items.map((event) => event.id));
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
      if (pages > 10) throw new Error("cursor never terminated");
    }
    expect(pages).toBe(3);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen).toEqual(
      Array.from(
        { length: total },
        (_, i) =>
          `act_${"0".repeat(13)}${String(total - 1 - i).padStart(4, "0")}`,
      ),
    );

    const limited = await store.listActivityEventsForTargetPage(
      "workspace_1",
      "resource",
      "tkrn:workspace_1:ObjectBucket:assets",
      { limit: 3 },
    );
    expect(limited.items).toHaveLength(3);
    expect(limited.nextCursor).toBeDefined();
  });

  test(`${name}: usage events page caps at 100 and round-trips newest-first (desc)`, async () => {
    const store = make();
    const total = 250;
    for (let i = 0; i < total; i += 1) await store.putUsageEvent(usageEvent(i));
    // Another Workspace's events must never leak (distinct id to avoid collision).
    await store.putUsageEvent({
      ...usageEvent(0, "workspace_2"),
      id: "usage_other00000000",
      idempotencyKey: "other:operation",
    });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      pages += 1;
      const page = await store.listUsageEventsPage(
        "workspace_1",
        cursor === undefined ? {} : { cursor },
      );
      expect(page.items.length).toBeLessThanOrEqual(100);
      seen.push(...page.items.map((e) => e.id));
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
      if (pages > 10) throw new Error("cursor never terminated");
    }
    expect(pages).toBe(3);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    const expected = Array.from(
      { length: total },
      (_, i) =>
        `usage_${"0".repeat(11)}${String(total - 1 - i).padStart(4, "0")}`,
    );
    expect(seen).toEqual(expected);

    const limited = await store.listUsageEventsPage("workspace_1", {
      limit: 3,
    });
    expect(limited.items).toHaveLength(3);
    expect(limited.nextCursor).toBeDefined();
  });

  test(`${name}: backup records page caps at 100 and round-trips newest-first (desc)`, async () => {
    const store = make();
    const total = 250;
    for (let i = 0; i < total; i += 1) {
      await store.putBackupRecord(backupRecord(i));
    }
    // Distinct id so the other-Workspace row cannot overwrite a Workspace row.
    await store.putBackupRecord({
      ...backupRecord(0, "workspace_2"),
      id: "bkp_other0000000000",
    });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      pages += 1;
      const page = await store.listBackupRecordsPage(
        "workspace_1",
        cursor === undefined ? {} : { cursor },
      );
      expect(page.items.length).toBeLessThanOrEqual(100);
      seen.push(...page.items.map((b) => b.id));
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
      if (pages > 10) throw new Error("cursor never terminated");
    }
    expect(pages).toBe(3);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    // Newest-first: createdAt desc, id desc — the reverse of insertion order.
    const expected = Array.from(
      { length: total },
      (_, i) =>
        `bkp_${"0".repeat(13)}${String(total - 1 - i).padStart(4, "0")}`,
    );
    expect(seen).toEqual(expected);

    const limited = await store.listBackupRecordsPage("workspace_1", {
      limit: 3,
    });
    expect(limited.items).toHaveLength(3);
    expect(limited.nextCursor).toBeDefined();
  });

}
