import { describe, expect, test } from "bun:test";
import {
  currentUtcMonthPeriod,
  friendlyResourceFamilyName,
  mergeCloudResourceUsageRows,
  summarizeCloudResourceUsageEvents,
  type ProviderCompatCloudflareWorkersInventory,
} from "../../../../dashboard/src/lib/cloud-resources.ts";
import type { UsageEvent } from "../../../../dashboard/src/lib/control-api.ts";

const period = {
  startIso: "2026-07-01T00:00:00.000Z",
  endIso: "2026-08-01T00:00:00.000Z",
};

describe("dashboard cloud resource usage rollup", () => {
  test("uses UTC calendar months", () => {
    expect(currentUtcMonthPeriod(new Date("2026-07-08T12:00:00.000Z"))).toEqual(
      period,
    );
  });

  test("groups current-month usage by resourceFamily and sums cost by kind", () => {
    const snapshot = summarizeCloudResourceUsageEvents(
      [
        usage("u1", {
          resourceFamily: "cloudflare.kv",
          kind: "operation",
          quantity: 2,
          usdMicros: 100_000,
          createdAt: "2026-07-08T10:00:00.000Z",
        }),
        usage("u2", {
          resourceFamily: "cloudflare.kv",
          kind: "gateway_storage_gb_hour",
          quantity: 3.5,
          usdMicros: 250_000,
          createdAt: "2026-07-09T10:00:00.000Z",
        }),
        usage("old", {
          resourceFamily: "cloudflare.kv",
          quantity: 999,
          usdMicros: 999_000,
          createdAt: "2026-06-30T23:59:59.999Z",
        }),
      ],
      period,
    );

    expect(snapshot.totalUsdMicros).toBe(350_000);
    expect(snapshot.eventCount).toBe(2);
    expect(snapshot.rows).toEqual([
      {
        key: "cloudflare.kv",
        quantities: [
          { kind: "gateway_storage_gb_hour", quantity: 3.5 },
          { kind: "operation", quantity: 2 },
        ],
        usdMicros: 350_000,
        eventCount: 2,
        lastUsedAt: "2026-07-09T10:00:00.000Z",
      },
    ]);
  });

  test("falls back from resourceFamily to meterId and hides internal backend names", () => {
    const snapshot = summarizeCloudResourceUsageEvents(
      [
        usage("meter", {
          meterId: "takosumi.object_store",
          quantity: 4,
        }),
        usage("internal", {
          resourceFamily: "workers_for_platforms.dispatch_namespace",
          meterId: "wfp_meter",
          kind: "operation",
          quantity: 1,
        }),
      ],
      period,
    );

    expect(snapshot.rows.map((row) => row.key)).toEqual([
      "operation",
      "takosumi.object_store",
    ]);
  });

  test("adds inventory-only resource families with zero current-month usage", () => {
    const snapshot = summarizeCloudResourceUsageEvents(
      [
        usage("d1", {
          resourceFamily: "cloudflare.d1",
          quantity: 10,
          usdMicros: 10_000,
        }),
      ],
      period,
    );
    const rows = mergeCloudResourceUsageRows(snapshot, inventory());

    expect(rows.find((row) => row.key === "cloudflare.d1")).toMatchObject({
      resourceCount: 1,
      usdMicros: 10_000,
    });
    expect(rows.find((row) => row.key === "cloudflare.r2")).toMatchObject({
      resourceCount: 1,
      usdMicros: 0,
      eventCount: 0,
    });
  });

  test("renders unknown resource families as readable names", () => {
    expect(friendlyResourceFamilyName("custom.ai_vector-db")).toBe(
      "Custom AI Vector DB",
    );
  });
});

function usage(id: string, extra: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id,
    workspaceId: "space_test",
    kind: "operation",
    quantity: 1,
    credits: 0,
    source: "resource_meter",
    idempotencyKey: id,
    createdAt: "2026-07-08T00:00:00.000Z",
    ...extra,
  };
}

function inventory(): ProviderCompatCloudflareWorkersInventory {
  return {
    accounts: { ok: true, data: [{ id: "acc_1" }] },
    selectedAccountId: "acc_1",
    kvNamespaces: { ok: true, data: [] },
    r2Buckets: { ok: true, data: [{ name: "assets" }] },
    d1Databases: { ok: true, data: [{ uuid: "db_1", name: "main" }] },
    queues: { ok: true, data: [] },
    workflows: { ok: true, data: [] },
    workerScripts: { ok: true, data: [] },
  };
}
