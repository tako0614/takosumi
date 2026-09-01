import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(20_000);

const NOW = "2026-08-22T00:00:00.000Z";
const LATER = "2026-08-22T01:00:00.000Z";
const pgClients: PGliteSqlClient[] = [];

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client: pgClient })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

function isoPlus(base: string, deltaMs: number): string {
  return new Date(Date.parse(base) + deltaMs).toISOString();
}

test("work items: enqueue, claim, complete round-trips on every backend", async () => {
  for (const [label, store] of await stores()) {
    const item = await store.enqueueWorkItem({
      id: "wi_destroy_cap_a",
      kind: "capsule.deferred_destroy",
      dedupeKey: "cap_a",
      workspaceId: "ws_a",
      capsuleId: "cap_a",
      dueAt: NOW,
      payload: { reason: "uninstall" },
      now: NOW,
    });
    expect(item.status, label).toBe("pending");
    expect(item.attempts, label).toBe(0);

    const claimed = await store.claimDueWorkItems({
      now: NOW,
      limit: 10,
      lockedBy: "cron:one",
      leaseMs: 60_000,
    });
    expect(claimed.map((row) => row.id), label).toEqual(["wi_destroy_cap_a"]);
    expect(claimed[0]?.status, label).toBe("leased");
    expect(claimed[0]?.attempts, label).toBe(1);
    expect(claimed[0]?.lockedBy, label).toBe("cron:one");
    expect(claimed[0]?.payload, label).toEqual({ reason: "uninstall" });

    // A second claimer sees nothing while the lease is live.
    expect(
      await store.claimDueWorkItems({
        now: NOW,
        limit: 10,
        lockedBy: "cron:two",
        leaseMs: 60_000,
      }),
      label,
    ).toEqual([]);

    await store.completeWorkItem("wi_destroy_cap_a", {
      lockedBy: "cron:one",
      now: NOW,
    });
    expect(
      await store.claimDueWorkItems({
        now: LATER,
        limit: 10,
        lockedBy: "cron:three",
        leaseMs: 60_000,
      }),
      label,
    ).toEqual([]);
    expect(await store.countWorkItemBacklog(LATER), label).toEqual({});
  }
});

test("work items: a live (kind, dedupeKey) enqueue returns the existing intent", async () => {
  for (const [label, store] of await stores()) {
    const first = await store.enqueueWorkItem({
      id: "wi_first",
      kind: "capsule.deferred_destroy",
      dedupeKey: "cap_dup",
      dueAt: NOW,
      now: NOW,
    });
    const duplicate = await store.enqueueWorkItem({
      id: "wi_second",
      kind: "capsule.deferred_destroy",
      dedupeKey: "cap_dup",
      dueAt: LATER,
      now: NOW,
    });
    expect(duplicate.id, label).toBe(first.id);

    // A different kind with the same dedupe key is an independent intent.
    const otherKind = await store.enqueueWorkItem({
      id: "wi_other_kind",
      kind: "capsule.auto_replan",
      dedupeKey: "cap_dup",
      dueAt: NOW,
      now: NOW,
    });
    expect(otherKind.id, label).toBe("wi_other_kind");

    // Once the live intent completes, the same dedupe key can be re-enqueued.
    const [claimed] = await store.claimDueWorkItems({
      now: NOW,
      limit: 1,
      kinds: ["capsule.deferred_destroy"],
      lockedBy: "cron:one",
      leaseMs: 60_000,
    });
    expect(claimed?.id, label).toBe("wi_first");
    await store.completeWorkItem("wi_first", { lockedBy: "cron:one", now: NOW });
    const reEnqueued = await store.enqueueWorkItem({
      id: "wi_third",
      kind: "capsule.deferred_destroy",
      dedupeKey: "cap_dup",
      dueAt: LATER,
      now: LATER,
    });
    expect(reEnqueued.id, label).toBe("wi_third");
  }
});

test("work items: claims respect due time, kind filter, and priority order", async () => {
  for (const [label, store] of await stores()) {
    await store.enqueueWorkItem({
      id: "wi_future",
      kind: "capsule.deferred_destroy",
      dueAt: LATER,
      now: NOW,
    });
    await store.enqueueWorkItem({
      id: "wi_low",
      kind: "capsule.deferred_destroy",
      dueAt: NOW,
      priority: 0,
      now: NOW,
    });
    await store.enqueueWorkItem({
      id: "wi_high",
      kind: "capsule.deferred_destroy",
      dueAt: NOW,
      priority: 5,
      now: NOW,
    });
    await store.enqueueWorkItem({
      id: "wi_other",
      kind: "capsule.auto_replan",
      dueAt: NOW,
      now: NOW,
    });

    const claimed = await store.claimDueWorkItems({
      now: NOW,
      limit: 10,
      kinds: ["capsule.deferred_destroy"],
      lockedBy: "cron:one",
      leaseMs: 60_000,
    });
    expect(claimed.map((row) => row.id), label).toEqual(["wi_high", "wi_low"]);
    expect(await store.countWorkItemBacklog(NOW), label).toEqual({
      "capsule.auto_replan": 1,
    });
  }
});

test("work items: an expired lease is reclaimed and attempts dead-letter at the cap", async () => {
  for (const [label, store] of await stores()) {
    await store.enqueueWorkItem({
      id: "wi_flaky",
      kind: "capsule.deferred_destroy",
      dueAt: NOW,
      maxAttempts: 2,
      now: NOW,
    });

    // Claim 1 crashes without complete/fail; the lease expires.
    const [first] = await store.claimDueWorkItems({
      now: NOW,
      limit: 1,
      lockedBy: "cron:crash",
      leaseMs: 1_000,
    });
    expect(first?.attempts, label).toBe(1);

    // Claim 2 reclaims the expired lease.
    const [second] = await store.claimDueWorkItems({
      now: isoPlus(NOW, 5_000),
      limit: 1,
      lockedBy: "cron:retry",
      leaseMs: 1_000,
    });
    expect(second?.id, label).toBe("wi_flaky");
    expect(second?.attempts, label).toBe(2);
    expect(second?.lockedBy, label).toBe("cron:retry");

    // Claim 3 would exceed maxAttempts: the row parks dead, nothing returns.
    expect(
      await store.claimDueWorkItems({
        now: isoPlus(NOW, 10_000),
        limit: 1,
        lockedBy: "cron:final",
        leaseMs: 1_000,
      }),
      label,
    ).toEqual([]);
    expect(await store.countWorkItemBacklog(isoPlus(NOW, 10_000)), label)
      .toEqual({});
  }
});

test("work items: failWorkItem reschedules with delay until attempts exhaust", async () => {
  for (const [label, store] of await stores()) {
    await store.enqueueWorkItem({
      id: "wi_retry",
      kind: "capsule.auto_replan",
      dueAt: NOW,
      maxAttempts: 2,
      now: NOW,
    });
    const [claimed] = await store.claimDueWorkItems({
      now: NOW,
      limit: 1,
      lockedBy: "cron:one",
      leaseMs: 60_000,
    });
    expect(claimed?.attempts, label).toBe(1);

    // A foreign locker's fail is a fenced no-op.
    await store.failWorkItem("wi_retry", {
      lockedBy: "cron:imposter",
      error: "not mine",
      now: NOW,
      retryDelayMs: 1_000,
    });
    await store.failWorkItem("wi_retry", {
      lockedBy: "cron:one",
      error: "transient backend outage",
      now: NOW,
      retryDelayMs: 60_000,
    });

    // Not due again until the retry delay elapses.
    expect(
      await store.claimDueWorkItems({
        now: isoPlus(NOW, 1_000),
        limit: 1,
        lockedBy: "cron:two",
        leaseMs: 60_000,
      }),
      label,
    ).toEqual([]);
    const [retried] = await store.claimDueWorkItems({
      now: isoPlus(NOW, 120_000),
      limit: 1,
      lockedBy: "cron:two",
      leaseMs: 60_000,
    });
    expect(retried?.id, label).toBe("wi_retry");
    expect(retried?.attempts, label).toBe(2);
    expect(retried?.lastError, label).toBe("transient backend outage");

    // Second failure hits maxAttempts: dead, never claimable again.
    await store.failWorkItem("wi_retry", {
      lockedBy: "cron:two",
      error: "still broken",
      now: isoPlus(NOW, 120_000),
      retryDelayMs: 1_000,
    });
    expect(
      await store.claimDueWorkItems({
        now: isoPlus(NOW, 240_000),
        limit: 1,
        lockedBy: "cron:three",
        leaseMs: 60_000,
      }),
      label,
    ).toEqual([]);
  }
});

test("sweep cursors: put, read back, and clear on every backend", async () => {
  for (const [label, store] of await stores()) {
    expect(await store.getSweepCursor("run_repair"), label).toBeUndefined();
    await store.putSweepCursor("run_repair", "1750000000000~run_x");
    expect(await store.getSweepCursor("run_repair"), label).toBe(
      "1750000000000~run_x",
    );
    await store.putSweepCursor("run_repair", "1750000001000~run_y");
    expect(await store.getSweepCursor("run_repair"), label).toBe(
      "1750000001000~run_y",
    );
    // A wrapped scan clears the cursor so the next tick restarts on top.
    await store.putSweepCursor("run_repair", undefined);
    expect(await store.getSweepCursor("run_repair"), label).toBeUndefined();
  }
});
