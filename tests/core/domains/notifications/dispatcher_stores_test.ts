import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { ActivityEvent } from "takosumi-contract/activity";

import {
  D1AccountsStore,
  InMemoryAccountsStore,
  PostgresAccountsStore,
  type PostgresQueryClient,
  type PostgresQueryResult,
} from "../../../../accounts/service/src/mod.ts";
import { notificationPusherId } from "../../../../accounts/service/src/notification-pushers-store.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import type { NotificationDispatchStore } from "../../../../core/domains/notifications/dispatch_store.ts";
import { OwnNotificationDispatcher } from "../../../../core/domains/notifications/dispatcher.ts";
import { base64UrlEncode } from "../../../../core/domains/notifications/web_push/bytes.ts";
import { deriveWebPushTopicKey } from "../../../../core/domains/notifications/web_push/topic.ts";
import { deriveVapidKeyPair } from "../../../../core/domains/notifications/web_push/vapid.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { createTestUserAgent } from "../../../helpers/web_push_receiver.ts";

// The immediate path and a catch-up run racing for the same delivery rows on
// the real Accounts stores: every device gets each notification exactly once.

const PASSPHRASE = "fixture-only-secret-store-passphrase-0123456789";
const ORIGIN = "https://takosumi.example.test";
const RELAY = "https://relay.example.test";
const OWNER = "tsub_owner";
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
  open(): Promise<{ readonly store: InMemoryAccountsStore; close(): Promise<void> }>;
}> = [
  { name: "memory", open: async () => ({ store: new InMemoryAccountsStore(), close: async () => {} }) },
  {
    name: "D1 (SQLite)",
    open: async () => {
      const store = new D1AccountsStore(new SqliteFakeD1());
      await store.initialize();
      return { store: store as unknown as InMemoryAccountsStore, close: async () => {} };
    },
  },
  {
    name: "Postgres (PGlite, migrations 047-048)",
    open: async () => {
      const db = new PGlite();
      await db.exec(`create schema accounts_v1;
        create table accounts_v1.accounts (subject text primary key);
        insert into accounts_v1.accounts(subject) values ('${OWNER}');`);
      for (const file of ["047_notification_pushers.sql", "048_notification_deliveries.sql"]) {
        await db.exec(await Bun.file(new URL(`../../../../accounts/service/migrations/${file}`, import.meta.url)).text());
      }
      return {
        store: new PostgresAccountsStore(new PgliteClient(db)) as unknown as InMemoryAccountsStore,
        close: async () => { await db.close(); },
      };
    },
  },
];

async function harness(store: InMemoryAccountsStore) {
  const ledger = new InMemoryOpenTofuControlStore();
  const clock = { now: T0 };
  const sent: string[] = [];
  const vapid = await deriveVapidKeyPair(new TextEncoder().encode(PASSPHRASE));
  const topicKey = await deriveWebPushTopicKey(new TextEncoder().encode(PASSPHRASE));
  const dispatcher = new OwnNotificationDispatcher({
    events: {
      listAfter: (input) => ledger.listActivityEventsAfter(input),
      get: (id) => ledger.getActivityEvent(id),
    },
    directory: {
      appOwner: async () => OWNER,
      runStartedBy: async () => OWNER,
      appName: async () => "yurucommu",
    },
    store: store as unknown as NotificationDispatchStore,
    vapid: async () => vapid,
    topicKey: async () => topicKey,
    instanceOrigin: ORIGIN,
    relayOrigins: [RELAY],
    fetch: (async (input: RequestInfo | URL) => {
      // Let the competing path interleave while a push is in flight.
      await new Promise((resolve) => setTimeout(resolve, 5));
      sent.push(new URL(String(input instanceof Request ? input.url : input)).pathname.split("/").at(-1)!);
      return new Response(null, { status: 201 });
    }) as typeof fetch,
    now: () => clock.now,
    random: () => 0,
  });
  const pushers: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const agent = await createTestUserAgent();
    const pushkey = base64UrlEncode(agent.p256dh);
    const pusherId = await notificationPusherId({ subject: OWNER, appId: "com.takosumi", pushkey });
    await store.saveNotificationPusher({
      pusherId, subject: OWNER, kind: "webpush", appId: "com.takosumi", pushkey,
      endpoint: `${RELAY}/push/${pusherId}`, auth: base64UrlEncode(agent.auth),
      deviceDisplayName: `Device ${index}`, lang: "en", createdAt: T0, updatedAt: T0,
    });
    pushers.push(pusherId);
  }
  await store.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: new Date(T0 - 1_000).toISOString(), id: "" });
  const record = async (id: string): Promise<ActivityEvent> => {
    const event: ActivityEvent = {
      id, workspaceId: "ws", action: "run.approval_required", targetType: "run", targetId: `run_${id}`, runId: `run_${id}`,
      metadata: { capsuleId: "cap_1", operation: "update" }, createdAt: new Date(clock.now).toISOString(),
    };
    await ledger.putActivityEvent(event);
    return event;
  };
  return { dispatcher, clock, sent, pushers, record };
}

for (const storeCase of STORES) {
  describe(`immediate and catch-up delivery on ${storeCase.name}`, () => {
    test("racing for the same rows, every device gets each event once", async () => {
      const { store, close } = await storeCase.open();
      try {
        const h = await harness(store);
        const first = await h.record("act_race_1");
        const [immediate, catchUp] = await Promise.all([h.dispatcher.deliverEvent(first), h.dispatcher.run()]);
        expect(immediate.delivered + catchUp.delivered).toBe(3);
        expect(immediate.enqueued + catchUp.enqueued).toBe(3);
        expect([...h.sent].sort()).toEqual([...h.pushers].sort());

        // The other order, with a second event.
        h.clock.now += 1_000;
        const second = await h.record("act_race_2");
        const [catchUp2, immediate2] = await Promise.all([h.dispatcher.run(), h.dispatcher.deliverEvent(second)]);
        expect(immediate2.delivered + catchUp2.delivered).toBe(3);
        expect(h.sent).toHaveLength(6);

        // Later runs, past every lease, find nothing left to send.
        h.clock.now += 5 * 60_000;
        expect(await h.dispatcher.run()).toMatchObject({ enqueued: 0, delivered: 0, retried: 0 });
        expect(await h.dispatcher.deliverEvent(first)).toMatchObject({ enqueued: 0, delivered: 0 });
        expect(h.sent).toHaveLength(6);
      } finally {
        await close();
      }
    });
  });
}
