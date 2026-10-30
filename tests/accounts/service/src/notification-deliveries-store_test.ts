import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

import {
  D1AccountsStore,
  InMemoryAccountsStore,
  PostgresAccountsStore,
  type PostgresQueryClient,
  type PostgresQueryResult,
} from "../../../../accounts/service/src/mod.ts";
import type { NotificationDeliveryStore } from "../../../../accounts/service/src/notification-deliveries-store.ts";
import {
  type NotificationDeliveryRecord,
  notificationDeliveryId,
} from "../../../../core/domains/notifications/dispatch_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);

class PgliteClient implements PostgresQueryClient {
  constructor(readonly db: PGlite) {}

  async queryObject<T>(sql: string, args: readonly unknown[] = []): Promise<PostgresQueryResult<T>> {
    const result = await this.db.query<T>(sql, [...args]);
    return { rows: [...result.rows] };
  }
}

const STORES: ReadonlyArray<{
  readonly name: string;
  open(): Promise<{ readonly store: NotificationDeliveryStore; close(): Promise<void> }>;
}> = [
  {
    name: "memory",
    open: async () => ({ store: new InMemoryAccountsStore() as unknown as NotificationDeliveryStore, close: async () => {} }),
  },
  {
    name: "D1 (SQLite)",
    open: async () => {
      const store = new D1AccountsStore(new SqliteFakeD1());
      await store.initialize();
      return { store: store as unknown as NotificationDeliveryStore, close: async () => {} };
    },
  },
  {
    name: "Postgres (PGlite, migrations 047-048)",
    open: async () => {
      const db = new PGlite();
      await db.exec("create schema accounts_v1; create table accounts_v1.accounts (subject text primary key);");
      for (const file of ["047_notification_pushers.sql", "048_notification_deliveries.sql"]) {
        await db.exec(await Bun.file(new URL(`../../../../accounts/service/migrations/${file}`, import.meta.url)).text());
      }
      return {
        store: new PostgresAccountsStore(new PgliteClient(db)) as unknown as NotificationDeliveryStore,
        close: async () => { await db.close(); },
      };
    },
  },
];

async function delivery(
  eventId: string,
  pusherId: string,
  overrides: Partial<NotificationDeliveryRecord> = {},
): Promise<NotificationDeliveryRecord> {
  return {
    deliveryId: await notificationDeliveryId(eventId, pusherId),
    eventId,
    pusherId,
    subject: "tsub_owner",
    payload: "{\"web_push\":8030,\"notification\":{\"title\":\"t\",\"navigate\":\"https://x.example/\"}}",
    urgency: "normal",
    topic: "topic_abc",
    enqueuedAt: T0,
    expiresAt: T0 + 86_400_000,
    attempts: 0,
    nextAttemptAt: T0,
    state: "pending",
    ...overrides,
  };
}

for (const storeCase of STORES) {
  describe(`notification dispatch state in ${storeCase.name}`, () => {
    test("the cursor is created once and then moves only by compare-and-set", async () => {
      const { store, close } = await storeCase.open();
      try {
        expect(await store.getNotificationDispatchCursor()).toBeUndefined();
        expect(await store.compareAndSetNotificationDispatchCursor({ expectedGeneration: 3, createdAt: "a", id: "x" })).toBe(false);
        expect(await store.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: "2026-10-30T00:00:00.000Z", id: "" })).toBe(true);
        expect(await store.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: "2026-10-30T00:00:09.000Z", id: "" })).toBe(false);
        expect(await store.getNotificationDispatchCursor()).toEqual({ generation: 0, createdAt: "2026-10-30T00:00:00.000Z", id: "" });
        expect(await store.compareAndSetNotificationDispatchCursor({ expectedGeneration: 0, createdAt: "2026-10-30T00:00:01.000Z", id: "act_1" })).toBe(true);
        expect(await store.compareAndSetNotificationDispatchCursor({ expectedGeneration: 0, createdAt: "2026-10-30T00:00:02.000Z", id: "act_2" })).toBe(false);
        expect(await store.getNotificationDispatchCursor()).toEqual({ generation: 1, createdAt: "2026-10-30T00:00:01.000Z", id: "act_1" });
      } finally {
        await close();
      }
    });

    test("deliveries are enqueued once, leased when due, and settled by the lease holder", async () => {
      const { store, close } = await storeCase.open();
      try {
        const first = await delivery("act_1", "npsh_a");
        const second = await delivery("act_1", "npsh_b", { nextAttemptAt: T0 + 5_000, urgency: "high" });
        const later = await delivery("act_2", "npsh_a", { nextAttemptAt: T0 + 60_000 });
        expect(await store.enqueueNotificationDeliveries([first, second, later])).toBe(3);
        // The same (event, pusher) again changes nothing, even with new content.
        expect(await store.enqueueNotificationDeliveries([{ ...first, payload: "{}", attempts: 9 }])).toBe(0);

        const claimed = await store.claimNotificationDeliveries({ now: T0 + 5_000, limit: 10, leaseToken: "lease_1", leaseExpiresAt: T0 + 125_000 });
        expect(claimed).toEqual([
          { ...first, leaseToken: "lease_1", leaseExpiresAt: T0 + 125_000 },
          { ...second, leaseToken: "lease_1", leaseExpiresAt: T0 + 125_000 },
        ]);
        // Leased rows are not handed out again until the lease expires.
        expect(await store.claimNotificationDeliveries({ now: T0 + 6_000, limit: 10, leaseToken: "lease_2", leaseExpiresAt: T0 + 126_000 })).toEqual([]);

        expect(await store.settleNotificationDelivery({
          deliveryId: first.deliveryId, leaseToken: "lease_other", at: T0 + 7_000,
          settlement: { kind: "settled", attempts: 1, outcome: "delivered", lastStatus: 201 },
        })).toBe(false);
        expect(await store.settleNotificationDelivery({
          deliveryId: first.deliveryId, leaseToken: "lease_1", at: T0 + 7_000,
          settlement: { kind: "settled", attempts: 1, outcome: "delivered", lastStatus: 201 },
        })).toBe(true);
        expect(await store.settleNotificationDelivery({
          deliveryId: second.deliveryId, leaseToken: "lease_1", at: T0 + 7_000,
          settlement: { kind: "retry", attempts: 1, nextAttemptAt: T0 + 37_000, lastStatus: 503 },
        })).toBe(true);

        expect(await store.claimNotificationDeliveries({ now: T0 + 36_000, limit: 10, leaseToken: "lease_3", leaseExpiresAt: T0 + 156_000 })).toEqual([]);
        const retried = await store.claimNotificationDeliveries({ now: T0 + 60_000, limit: 1, leaseToken: "lease_4", leaseExpiresAt: T0 + 180_000 });
        expect(retried).toEqual([{ ...second, attempts: 1, nextAttemptAt: T0 + 37_000, lastStatus: 503, leaseToken: "lease_4", leaseExpiresAt: T0 + 180_000 }]);
        expect(await store.settleNotificationDelivery({
          deliveryId: second.deliveryId, leaseToken: "lease_4", at: T0 + 61_000,
          settlement: { kind: "settled", attempts: 2, outcome: "expired" },
        })).toBe(true);
        // Re-reading the event enqueues the settled rows again: nothing
        // becomes due a second time.
        expect(await store.enqueueNotificationDeliveries([first, second])).toBe(0);
        expect((await store.claimNotificationDeliveries({ now: T0 + 59_000, limit: 10, leaseToken: "lease_x", leaseExpiresAt: T0 + 59_500 })))
          .toEqual([]);
        // An expired lease is reclaimed by another runner.
        const reclaimed = await store.claimNotificationDeliveries({ now: T0 + 60_000, limit: 10, leaseToken: "lease_5", leaseExpiresAt: T0 + 61_000 });
        expect(reclaimed.map((row) => row.deliveryId)).toEqual([later.deliveryId]);
        expect((await store.claimNotificationDeliveries({ now: T0 + 62_000, limit: 10, leaseToken: "lease_6", leaseExpiresAt: T0 + 182_000 })).map((row) => [row.deliveryId, row.leaseToken]))
          .toEqual([[later.deliveryId, "lease_6"]]);
        // A settled row's old lease can no longer write.
        expect(await store.settleNotificationDelivery({
          deliveryId: later.deliveryId, leaseToken: "lease_5", at: T0 + 63_000,
          settlement: { kind: "settled", attempts: 1, outcome: "failed", lastStatus: 403 },
        })).toBe(false);
      } finally {
        await close();
      }
    });

    test("rows are pruned only after their expiry", async () => {
      const { store, close } = await storeCase.open();
      try {
        const old = await delivery("act_old", "npsh_a", { expiresAt: T0 - 1, state: "settled", outcome: "delivered", settledAt: T0 - 100 });
        const fresh = await delivery("act_new", "npsh_a");
        expect(await store.enqueueNotificationDeliveries([old, fresh])).toBe(2);
        expect(await store.pruneNotificationDeliveries({ expiredBefore: T0, limit: 10 })).toBe(1);
        expect(await store.pruneNotificationDeliveries({ expiredBefore: T0, limit: 10 })).toBe(0);
        const claimed = await store.claimNotificationDeliveries({ now: T0, limit: 10, leaseToken: "l", leaseExpiresAt: T0 + 1 });
        expect(claimed.map((row) => row.deliveryId)).toEqual([fresh.deliveryId]);
        // The pruned pair can be enqueued again (a cursor never goes back that far).
        await store.enqueueNotificationDeliveries([{ ...old, expiresAt: T0 + 1_000, state: "pending" }]);
        expect(await store.pruneNotificationDeliveries({ expiredBefore: T0 + 2_000, limit: 1 })).toBe(1);
      } finally {
        await close();
      }
    });
  });
}
