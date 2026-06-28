/**
 * Keyset-pagination symmetry for the deferred §30 list reads that were bounded
 * after the stage-3 cohort: usage events (ascending), control backups
 * (newest-first / descending), and the OutputShare from+to union. Each asserts
 * the default cap (≤100), a complete gap-free / dup-free cursor traversal across
 * the keyset boundary, and an explicit `?limit=`. The in-memory twin and the
 * D1-shaped store must behave identically.
 */
import { expect, test } from "bun:test";

import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import { CloudflareD1OpenTofuDeploymentStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { OutputSharesService } from "../../../../core/domains/output-shares/mod.ts";
import type { OpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import type { UsageEvent } from "takosumi-contract/billing";
import type { BackupRecord } from "takosumi-contract/backups";
import type { OutputShare } from "takosumi-contract/outputs";

const STORES: ReadonlyArray<[string, () => OpenTofuDeploymentStore]> = [
  ["in-memory", () => new InMemoryOpenTofuDeploymentStore()],
  ["d1", () => new CloudflareD1OpenTofuDeploymentStore(new SqliteFakeD1())],
];

function usageEvent(i: number, spaceId = "space_1"): UsageEvent {
  const seq = String(i).padStart(4, "0");
  return {
    id: `usage_${"0".repeat(11)}${seq}`,
    spaceId,
    kind: "operation",
    quantity: 1,
    credits: 1,
    source: "runner",
    idempotencyKey: `apply_${seq}:operation`,
    createdAt: `2026-06-06T00:00:00.${seq}Z`,
  };
}

function backupRecord(i: number, spaceId = "space_1"): BackupRecord {
  const seq = String(i).padStart(4, "0");
  return {
    id: `bkp_${"0".repeat(13)}${seq}`,
    spaceId,
    objectKey: `spaces/${spaceId}/backups/bkp_${seq}/control.json.zst.enc`,
    digest: "sha256:" + "b".repeat(64),
    sizeBytes: 2048,
    createdAt: `2026-06-06T00:00:00.${seq}Z`,
  };
}

function outputShare(i: number, over: Partial<OutputShare> = {}): OutputShare {
  const seq = String(i).padStart(4, "0");
  return {
    id: `oshare_${"0".repeat(9)}${seq}`,
    fromSpaceId: "space_1",
    toSpaceId: "space_2",
    producerInstallationId: "inst_producer",
    outputs: [{ name: "bucket", alias: "bucket", sensitive: false }],
    status: "active",
    createdAt: `2026-06-06T00:00:00.${seq}Z`,
    ...over,
  };
}

for (const [name, make] of STORES) {
  test(`${name}: usage events page caps at 100 and round-trips the cursor (asc)`, async () => {
    const store = make();
    const total = 250;
    for (let i = 0; i < total; i += 1) await store.putUsageEvent(usageEvent(i));
    // Another Space's events must never leak (distinct id to avoid collision).
    await store.putUsageEvent({
      ...usageEvent(0, "space_2"),
      id: "usage_other00000000",
      idempotencyKey: "other:operation",
    });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      pages += 1;
      const page = await store.listUsageEventsPage(
        "space_1",
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
      (_, i) => `usage_${"0".repeat(11)}${String(i).padStart(4, "0")}`,
    );
    expect(seen).toEqual(expected);

    const limited = await store.listUsageEventsPage("space_1", { limit: 3 });
    expect(limited.items).toHaveLength(3);
    expect(limited.nextCursor).toBeDefined();
  });

  test(`${name}: backup records page caps at 100 and round-trips newest-first (desc)`, async () => {
    const store = make();
    const total = 250;
    for (let i = 0; i < total; i += 1) {
      await store.putBackupRecord(backupRecord(i));
    }
    // Distinct id so the other-Space row cannot overwrite a space_1 record.
    await store.putBackupRecord({
      ...backupRecord(0, "space_2"),
      id: "bkp_other0000000000",
    });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      pages += 1;
      const page = await store.listBackupRecordsPage(
        "space_1",
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
      (_, i) => `bkp_${"0".repeat(13)}${String(total - 1 - i).padStart(4, "0")}`,
    );
    expect(seen).toEqual(expected);

    const limited = await store.listBackupRecordsPage("space_1", { limit: 3 });
    expect(limited.items).toHaveLength(3);
    expect(limited.nextCursor).toBeDefined();
  });

  test(`${name}: OutputShare from+to union pages with no gaps/dupes across the boundary`, async () => {
    const store = make();
    const service = new OutputSharesService({ store });
    // 130 granted (from space_1) + 130 received (to space_1), interleaved
    // createdAt so the merge-sort genuinely interleaves the two source sets.
    const total = 260;
    for (let i = 0; i < total; i += 1) {
      const granted = i % 2 === 0;
      await store.putOutputShare(
        outputShare(i, {
          fromSpaceId: granted ? "space_1" : "space_9",
          toSpaceId: granted ? "space_8" : "space_1",
        }),
      );
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      pages += 1;
      const page = await service.listForSpacePage(
        "space_1",
        cursor === undefined ? {} : { cursor },
      );
      expect(page.items.length).toBeLessThanOrEqual(100);
      seen.push(...page.items.map((s) => s.id));
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
      if (pages > 10) throw new Error("cursor never terminated");
    }
    expect(pages).toBe(3); // 100 + 100 + 60
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    // Ordered by (createdAt, id) across the merged union.
    const expected = Array.from(
      { length: total },
      (_, i) => `oshare_${"0".repeat(9)}${String(i).padStart(4, "0")}`,
    );
    expect(seen).toEqual(expected);
  });
}
