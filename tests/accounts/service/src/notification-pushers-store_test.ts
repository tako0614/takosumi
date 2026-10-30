import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

import {
  D1AccountsStore,
  InMemoryAccountsStore,
  PostgresAccountsStore,
  type PostgresQueryClient,
  type PostgresQueryResult,
} from "../../../../accounts/service/src/mod.ts";
import {
  NOTIFICATION_PUSHERS_PER_ACCOUNT,
  notificationPusherId,
  type NotificationPusherRecord,
  type NotificationPusherStore,
} from "../../../../accounts/service/src/notification-pushers-store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const SUBJECT = "tsub_pusher_owner" as const;
const OTHER = "tsub_pusher_other" as const;
const ENDPOINT = "https://relay.example.test/push/one";

class PgliteClient implements PostgresQueryClient {
  constructor(readonly db: PGlite) {}

  async queryObject<T>(
    sql: string,
    args: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<T>> {
    const result = await this.db.query<T>(sql, [...args]);
    return { rows: [...result.rows] };
  }
}

interface StoreCase {
  readonly name: string;
  open(): Promise<{
    readonly store: NotificationPusherStore;
    close(): Promise<void>;
  }>;
}

const STORES: readonly StoreCase[] = [
  {
    name: "memory",
    open: async () => ({
      store: new InMemoryAccountsStore() as unknown as NotificationPusherStore,
      close: async () => {},
    }),
  },
  {
    name: "D1 (SQLite)",
    open: async () => {
      const store = new D1AccountsStore(new SqliteFakeD1());
      await store.initialize();
      return {
        store: store as unknown as NotificationPusherStore,
        close: async () => {},
      };
    },
  },
  {
    name: "Postgres (PGlite, migration 047)",
    open: async () => {
      const db = new PGlite();
      await db.exec(`
        create schema accounts_v1;
        create table accounts_v1.accounts (subject text primary key);
        insert into accounts_v1.accounts(subject) values ('${SUBJECT}'), ('${OTHER}');
      `);
      await db.exec(await Bun.file(new URL(
        "../../../../accounts/service/migrations/047_notification_pushers.sql",
        import.meta.url,
      )).text());
      return {
        store: new PostgresAccountsStore(new PgliteClient(db)) as unknown as NotificationPusherStore,
        close: async () => { await db.close(); },
      };
    },
  },
];

async function pusher(
  overrides: Partial<NotificationPusherRecord> & { readonly pushkey: string },
): Promise<NotificationPusherRecord> {
  const subject = overrides.subject ?? SUBJECT;
  const appId = overrides.appId ?? "com.takosumi";
  return {
    pusherId: await notificationPusherId({ subject, appId, pushkey: overrides.pushkey }),
    subject,
    kind: "webpush",
    appId,
    endpoint: ENDPOINT,
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
    deviceDisplayName: "Pixel 9",
    lang: "ja-JP",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

for (const storeCase of STORES) {
  describe(`notification pushers in ${storeCase.name}`, () => {
    test("create, update in place, list oldest first, and keep accounts apart", async () => {
      const { store, close } = await storeCase.open();
      try {
        const first = await pusher({ pushkey: "key-a", createdAt: 2_000, updatedAt: 2_000 });
        expect(await store.saveNotificationPusher(first)).toEqual({ status: "created", record: first });
        const older = await pusher({ pushkey: "key-b", createdAt: 1_500, updatedAt: 1_500 });
        expect((await store.saveNotificationPusher(older)).status).toBe("created");
        const others = await pusher({ subject: OTHER, pushkey: "key-a" });
        expect(others.pusherId).not.toBe(first.pusherId);
        expect((await store.saveNotificationPusher(others)).status).toBe("created");

        // The same (account, app_id, pushkey) updates the row and keeps createdAt.
        const renamed = { ...first, deviceDisplayName: "Pixel 10", lang: "en-US", createdAt: 9_000, updatedAt: 9_000 };
        expect(await store.saveNotificationPusher(renamed)).toEqual({
          status: "updated",
          record: { ...renamed, createdAt: 2_000 },
        });

        expect((await store.listNotificationPushersForSubject(SUBJECT)).map((record) => record.pushkey))
          .toEqual(["key-b", "key-a"]);
        expect(await store.listNotificationPushersForSubject(OTHER)).toEqual([others]);
        expect(await store.findNotificationPusher(first.pusherId))
          .toEqual({ ...renamed, createdAt: 2_000 });
        expect(await store.findNotificationPusher("npsh_missing")).toBeUndefined();
      } finally {
        await close();
      }
    });

    test("refuse a new pusher past the per-account limit but still update existing ones", async () => {
      const { store, close } = await storeCase.open();
      try {
        const records: NotificationPusherRecord[] = [];
        for (let index = 0; index < NOTIFICATION_PUSHERS_PER_ACCOUNT; index += 1) {
          const record = await pusher({ pushkey: `key-${index}`, createdAt: 1_000 + index, updatedAt: 1_000 + index });
          records.push(record);
          expect((await store.saveNotificationPusher(record)).status).toBe("created");
        }
        expect(await store.saveNotificationPusher(await pusher({ pushkey: "one-too-many" })))
          .toEqual({ status: "limit_reached" });
        expect((await store.saveNotificationPusher({ ...records[3]!, deviceDisplayName: "Renamed", updatedAt: 5_000 })).status)
          .toBe("updated");
        expect((await store.saveNotificationPusher(await pusher({ subject: OTHER, pushkey: "other-account" }))).status)
          .toBe("created");
        expect(await store.listNotificationPushersForSubject(SUBJECT)).toHaveLength(NOTIFICATION_PUSHERS_PER_ACCOUNT);
        expect(await store.deleteNotificationPusher({ subject: SUBJECT, pusherId: records[0]!.pusherId })).toBe(true);
        expect((await store.saveNotificationPusher(await pusher({ pushkey: "one-too-many" }))).status).toBe("created");
      } finally {
        await close();
      }
    });

    test("record delivery health, keep it for the same destination, reset it for a new one", async () => {
      const { store, close } = await storeCase.open();
      try {
        const record = await pusher({ pushkey: "key-health" });
        await store.saveNotificationPusher(record);
        const sent = { pusherId: record.pusherId, endpoint: record.endpoint, pushkey: record.pushkey };
        await store.recordNotificationPusherOutcome({ ...sent, at: 3_000, outcome: "delivered" });
        await store.recordNotificationPusherOutcome({ ...sent, at: 4_000, outcome: "failed", status: 403 });
        expect(await store.findNotificationPusher(record.pusherId)).toMatchObject({
          lastSuccessAt: 3_000,
          lastFailureAt: 4_000,
          lastFailureStatus: 403,
        });
        await store.recordNotificationPusherOutcome({ ...sent, at: 5_000, outcome: "failed" });
        const timedOut = await store.findNotificationPusher(record.pusherId);
        expect(timedOut).toMatchObject({ lastSuccessAt: 3_000, lastFailureAt: 5_000 });
        expect(timedOut?.lastFailureStatus).toBeUndefined();

        await store.saveNotificationPusher({ ...record, deviceDisplayName: "Same device", updatedAt: 6_000 });
        expect(await store.findNotificationPusher(record.pusherId)).toMatchObject({
          deviceDisplayName: "Same device",
          lastSuccessAt: 3_000,
          lastFailureAt: 5_000,
        });
        await store.saveNotificationPusher({ ...record, endpoint: `${ENDPOINT}-new`, updatedAt: 7_000 });
        const moved = await store.findNotificationPusher(record.pusherId);
        expect(moved).toMatchObject({ endpoint: `${ENDPOINT}-new`, createdAt: 1_000, updatedAt: 7_000 });
        expect(moved?.lastSuccessAt).toBeUndefined();
        expect(moved?.lastFailureAt).toBeUndefined();
        // A late answer about the old endpoint does not touch the re-registered pusher.
        await store.recordNotificationPusherOutcome({ ...sent, at: 8_000, outcome: "failed", status: 403 });
        expect((await store.findNotificationPusher(record.pusherId))?.lastFailureAt).toBeUndefined();
        await store.removeNotificationPusher(sent);
        expect(await store.findNotificationPusher(record.pusherId)).toMatchObject({ endpoint: `${ENDPOINT}-new` });
        // Outcomes for a pusher that is gone are ignored.
        await store.recordNotificationPusherOutcome({ pusherId: "npsh_missing", endpoint: ENDPOINT, pushkey: "x", at: 1, outcome: "delivered" });
      } finally {
        await close();
      }
    });

    test("delete only the account's own pusher; the dispatcher removes only the subscription it sent to", async () => {
      const { store, close } = await storeCase.open();
      try {
        const mine = await pusher({ pushkey: "key-mine" });
        const theirs = await pusher({ subject: OTHER, pushkey: "key-theirs" });
        await store.saveNotificationPusher(mine);
        await store.saveNotificationPusher(theirs);
        expect(await store.deleteNotificationPusher({ subject: SUBJECT, pusherId: theirs.pusherId })).toBe(false);
        expect(await store.findNotificationPusher(theirs.pusherId)).toEqual(theirs);
        expect(await store.deleteNotificationPusher({ subject: SUBJECT, pusherId: mine.pusherId })).toBe(true);
        expect(await store.deleteNotificationPusher({ subject: SUBJECT, pusherId: mine.pusherId })).toBe(false);
        expect(await store.listNotificationPushersForSubject(SUBJECT)).toEqual([]);
        await store.removeNotificationPusher({ pusherId: theirs.pusherId, endpoint: theirs.endpoint, pushkey: "another-key" });
        expect(await store.findNotificationPusher(theirs.pusherId)).toEqual(theirs);
        await store.removeNotificationPusher({ pusherId: theirs.pusherId, endpoint: theirs.endpoint, pushkey: theirs.pushkey });
        expect(await store.findNotificationPusher(theirs.pusherId)).toBeUndefined();
        expect(await store.listNotificationPushersForSubject(OTHER)).toEqual([]);
      } finally {
        await close();
      }
    });
  });
}

test("pusher ids are derived from the account, app id and pushkey", async () => {
  const id = await notificationPusherId({ subject: SUBJECT, appId: "com.takosumi", pushkey: "k" });
  expect(id).toMatch(/^npsh_[A-Za-z0-9_-]{32}$/);
  expect(await notificationPusherId({ subject: SUBJECT, appId: "com.takosumi", pushkey: "k" })).toBe(id);
  expect(await notificationPusherId({ subject: OTHER, appId: "com.takosumi", pushkey: "k" })).not.toBe(id);
  expect(await notificationPusherId({ subject: SUBJECT, appId: "com.takosumi.dev", pushkey: "k" })).not.toBe(id);
});

test("Postgres keeps (account, app_id, pushkey) unique and cascades account deletion", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create schema accounts_v1;
      create table accounts_v1.accounts (subject text primary key);
      insert into accounts_v1.accounts(subject) values ('${SUBJECT}');
    `);
    await db.exec(await Bun.file(new URL(
      "../../../../accounts/service/migrations/047_notification_pushers.sql",
      import.meta.url,
    )).text());
    const store = new PostgresAccountsStore(new PgliteClient(db));
    const record = await pusher({ pushkey: "key-unique" });
    await store.saveNotificationPusher(record);
    await expect(db.query(
      `insert into accounts_v1.notification_pushers
         (pusher_id, subject, kind, app_id, pushkey, endpoint, auth, device_display_name, lang, created_at, updated_at)
       values ('npsh_other', $1, 'webpush', 'com.takosumi', 'key-unique', 'https://x', 'a', 'd', 'ja', now(), now())`,
      [SUBJECT],
    )).rejects.toThrow();
    await expect(db.query(
      `insert into accounts_v1.notification_pushers
         (pusher_id, subject, kind, app_id, pushkey, endpoint, auth, device_display_name, lang, created_at, updated_at)
       values ('npsh_http', $1, 'http', 'com.takosumi', 'key-http', 'https://x', 'a', 'd', 'ja', now(), now())`,
      [SUBJECT],
    )).rejects.toThrow();
    await db.query("delete from accounts_v1.accounts where subject = $1", [SUBJECT]);
    expect(await store.listNotificationPushersForSubject(SUBJECT)).toEqual([]);
  } finally {
    await db.close();
  }
});

test("Postgres at the limit updates a pusher that a concurrent registration inserted first", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create schema accounts_v1;
      create table accounts_v1.accounts (subject text primary key);
      insert into accounts_v1.accounts(subject) values ('${SUBJECT}');
    `);
    await db.exec(await Bun.file(new URL(
      "../../../../accounts/service/migrations/047_notification_pushers.sql",
      import.meta.url,
    )).text());
    const plain = new PostgresAccountsStore(new PgliteClient(db));
    for (let index = 0; index < NOTIFICATION_PUSHERS_PER_ACCOUNT - 1; index += 1) {
      await plain.saveNotificationPusher(await pusher({ pushkey: `other-${index}`, createdAt: 1_000 + index, updatedAt: 1_000 + index }));
    }
    const contested = await pusher({ pushkey: "contested", createdAt: 5_000, updatedAt: 5_000 });
    // The other registration of the same pusher lands between this one's
    // update (no row yet) and its limited insert (now at the limit).
    let raced = false;
    const racing = new PostgresAccountsStore({
      async queryObject<T>(sql: string, args: readonly unknown[] = []) {
        const result = await db.query<T>(sql, [...args]);
        if (!raced && /^\s*UPDATE accounts_v1\.notification_pushers/.test(sql) && result.rows.length === 0) {
          raced = true;
          await plain.saveNotificationPusher({ ...contested, deviceDisplayName: "First writer" });
        }
        return { rows: [...result.rows] };
      },
    });
    const saved = await racing.saveNotificationPusher({ ...contested, deviceDisplayName: "Second writer", updatedAt: 6_000 });
    expect(raced).toBe(true);
    expect(saved).toMatchObject({ status: "updated", record: { deviceDisplayName: "Second writer", createdAt: 5_000 } });
    expect(await plain.listNotificationPushersForSubject(SUBJECT)).toHaveLength(NOTIFICATION_PUSHERS_PER_ACCOUNT);
    expect(await racing.saveNotificationPusher(await pusher({ pushkey: "new-one" }))).toEqual({ status: "limit_reached" });
  } finally {
    await db.close();
  }
});
