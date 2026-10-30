/**
 * The notification dispatcher's durable state in the Accounts store: the
 * Activity cursor and one delivery row per (event, pusher). Types and rules
 * are defined by `core/domains/notifications/dispatch_store.ts`.
 */

import type {
  NotificationDeliveryRecord,
  NotificationDeliverySettlement,
  NotificationDispatchCursor,
  NotificationDispatchStore,
} from "../../../core/domains/notifications/dispatch_store.ts";
import type { D1Database, D1Result } from "./d1-store.ts";

export type NotificationDeliveryStore = Pick<
  NotificationDispatchStore,
  | "getNotificationDispatchCursor"
  | "compareAndSetNotificationDispatchCursor"
  | "enqueueNotificationDeliveries"
  | "claimNotificationDeliveries"
  | "settleNotificationDelivery"
  | "pruneNotificationDeliveries"
>;

export function applyNotificationDeliverySettlement(
  record: NotificationDeliveryRecord,
  at: number,
  settlement: NotificationDeliverySettlement,
): NotificationDeliveryRecord {
  const {
    leaseToken: _token,
    leaseExpiresAt: _expires,
    lastStatus: _status,
    ...rest
  } = record;
  const lastStatus = settlement.lastStatus !== undefined
    ? { lastStatus: settlement.lastStatus }
    : {};
  return settlement.kind === "retry"
    ? { ...rest, attempts: settlement.attempts, nextAttemptAt: settlement.nextAttemptAt, ...lastStatus }
    : {
        ...rest,
        state: "settled",
        attempts: settlement.attempts,
        outcome: settlement.outcome,
        settledAt: at,
        ...lastStatus,
      };
}

function isDue(record: NotificationDeliveryRecord, now: number): boolean {
  return record.state === "pending" &&
    record.nextAttemptAt <= now &&
    (record.leaseExpiresAt === undefined || record.leaseExpiresAt <= now);
}

function byDue(left: NotificationDeliveryRecord, right: NotificationDeliveryRecord): number {
  return left.nextAttemptAt - right.nextAttemptAt ||
    (left.deliveryId < right.deliveryId ? -1 : left.deliveryId > right.deliveryId ? 1 : 0);
}

/** In-memory reference adapter. */
export class MemoryNotificationDeliveryRecords implements NotificationDeliveryStore {
  #cursor: NotificationDispatchCursor | undefined;
  readonly #deliveries = new Map<string, NotificationDeliveryRecord>();
  readonly #byEventPusher = new Set<string>();

  getNotificationDispatchCursor(): Promise<NotificationDispatchCursor | undefined> {
    return Promise.resolve(this.#cursor ? { ...this.#cursor } : undefined);
  }

  compareAndSetNotificationDispatchCursor(input: {
    readonly expectedGeneration: number | undefined;
    readonly createdAt: string;
    readonly id: string;
  }): Promise<boolean> {
    if (input.expectedGeneration === undefined) {
      if (this.#cursor) return Promise.resolve(false);
      this.#cursor = { generation: 0, createdAt: input.createdAt, id: input.id };
      return Promise.resolve(true);
    }
    if (this.#cursor?.generation !== input.expectedGeneration) {
      return Promise.resolve(false);
    }
    this.#cursor = {
      generation: input.expectedGeneration + 1,
      createdAt: input.createdAt,
      id: input.id,
    };
    return Promise.resolve(true);
  }

  enqueueNotificationDeliveries(
    records: readonly NotificationDeliveryRecord[],
  ): Promise<void> {
    for (const record of records) {
      const pair = `${record.eventId}\n${record.pusherId}`;
      if (this.#deliveries.has(record.deliveryId) || this.#byEventPusher.has(pair)) continue;
      this.#deliveries.set(record.deliveryId, structuredClone(record));
      this.#byEventPusher.add(pair);
    }
    return Promise.resolve();
  }

  claimNotificationDeliveries(input: {
    readonly now: number;
    readonly limit: number;
    readonly leaseToken: string;
    readonly leaseExpiresAt: number;
  }): Promise<readonly NotificationDeliveryRecord[]> {
    const claimed = [...this.#deliveries.values()]
      .filter((record) => isDue(record, input.now))
      .sort(byDue)
      .slice(0, input.limit)
      .map((record) => {
        const leased = { ...record, leaseToken: input.leaseToken, leaseExpiresAt: input.leaseExpiresAt };
        this.#deliveries.set(record.deliveryId, leased);
        return structuredClone(leased);
      });
    return Promise.resolve(claimed);
  }

  settleNotificationDelivery(input: {
    readonly deliveryId: string;
    readonly leaseToken: string;
    readonly at: number;
    readonly settlement: NotificationDeliverySettlement;
  }): Promise<boolean> {
    const record = this.#deliveries.get(input.deliveryId);
    if (!record || record.leaseToken !== input.leaseToken) return Promise.resolve(false);
    this.#deliveries.set(
      input.deliveryId,
      applyNotificationDeliverySettlement(record, input.at, input.settlement),
    );
    return Promise.resolve(true);
  }

  pruneNotificationDeliveries(input: {
    readonly expiredBefore: number;
    readonly limit: number;
  }): Promise<number> {
    let pruned = 0;
    for (const record of [...this.#deliveries.values()].sort((a, b) => a.expiresAt - b.expiresAt)) {
      if (pruned >= input.limit || record.expiresAt >= input.expiredBefore) break;
      this.#deliveries.delete(record.deliveryId);
      this.#byEventPusher.delete(`${record.eventId}\n${record.pusherId}`);
      pruned += 1;
    }
    return Promise.resolve(pruned);
  }
}

const D1_CURSOR_BUCKET = "notification_dispatch_cursors";
const D1_CURSOR_KEY = "activity";
const D1_DELIVERIES_BUCKET = "notification_deliveries";
const D1_ENQUEUE_CHUNK = 50;
const NUMBER = (path: string) => `CAST(json_extract(document, '${path}') AS INTEGER)`;

/**
 * Cloudflare D1 adapter over the Accounts document table: two new buckets
 * and no schema change. Every claim, settle and prune is one statement.
 */
export class D1NotificationDeliveryRecords implements NotificationDeliveryStore {
  readonly #db: D1Database;
  readonly #ready: () => Promise<void>;

  constructor(db: D1Database, ready: () => Promise<void>) {
    this.#db = db;
    this.#ready = ready;
  }

  async getNotificationDispatchCursor(): Promise<NotificationDispatchCursor | undefined> {
    await this.#ready();
    const row = await this.#db
      .prepare("SELECT document FROM takosumi_accounts_documents WHERE bucket = ? AND key = ?")
      .bind(D1_CURSOR_BUCKET, D1_CURSOR_KEY)
      .first<{ document: string }>();
    return row ? (JSON.parse(row.document) as NotificationDispatchCursor) : undefined;
  }

  async compareAndSetNotificationDispatchCursor(input: {
    readonly expectedGeneration: number | undefined;
    readonly createdAt: string;
    readonly id: string;
  }): Promise<boolean> {
    await this.#ready();
    const now = Date.now();
    if (input.expectedGeneration === undefined) {
      const document = JSON.stringify({ generation: 0, createdAt: input.createdAt, id: input.id });
      const result = await this.#db
        .prepare(
          "INSERT OR IGNORE INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(D1_CURSOR_BUCKET, D1_CURSOR_KEY, document, now)
        .run();
      return (changeCount(result) ?? 0) > 0;
    }
    const document = JSON.stringify({
      generation: input.expectedGeneration + 1,
      createdAt: input.createdAt,
      id: input.id,
    });
    const result = await this.#db
      .prepare(
        `UPDATE takosumi_accounts_documents SET document = ?, updated_at = ? WHERE bucket = ? AND key = ? AND ${NUMBER("$.generation")} = ?`,
      )
      .bind(document, now, D1_CURSOR_BUCKET, D1_CURSOR_KEY, input.expectedGeneration)
      .run();
    return (changeCount(result) ?? 0) > 0;
  }

  async enqueueNotificationDeliveries(
    records: readonly NotificationDeliveryRecord[],
  ): Promise<void> {
    if (records.length === 0) return;
    await this.#ready();
    const now = Date.now();
    for (let index = 0; index < records.length; index += D1_ENQUEUE_CHUNK) {
      const chunk = records.slice(index, index + D1_ENQUEUE_CHUNK);
      const results = await this.#db.batch(chunk.map((record) =>
        this.#db
          .prepare(
            "INSERT OR IGNORE INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES (?, ?, ?, ?)",
          )
          .bind(D1_DELIVERIES_BUCKET, record.deliveryId, JSON.stringify(record), now)
      ));
      if (results.length !== chunk.length || results.some((result) => !result.success)) {
        throw new Error("D1 Accounts notification delivery enqueue failed");
      }
    }
  }

  async claimNotificationDeliveries(input: {
    readonly now: number;
    readonly limit: number;
    readonly leaseToken: string;
    readonly leaseExpiresAt: number;
  }): Promise<readonly NotificationDeliveryRecord[]> {
    await this.#ready();
    const rows = await this.#db
      .prepare(
        "UPDATE takosumi_accounts_documents SET document = json_set(document, '$.leaseToken', ?, '$.leaseExpiresAt', ?), updated_at = ? " +
          "WHERE bucket = ? AND key IN (SELECT key FROM takosumi_accounts_documents WHERE bucket = ? " +
          "AND json_extract(document, '$.state') = 'pending' " +
          `AND ${NUMBER("$.nextAttemptAt")} <= ? ` +
          `AND (json_extract(document, '$.leaseExpiresAt') IS NULL OR ${NUMBER("$.leaseExpiresAt")} <= ?) ` +
          `ORDER BY ${NUMBER("$.nextAttemptAt")}, key LIMIT ?) RETURNING document`,
      )
      .bind(
        input.leaseToken,
        input.leaseExpiresAt,
        input.now,
        D1_DELIVERIES_BUCKET,
        D1_DELIVERIES_BUCKET,
        input.now,
        input.now,
        input.limit,
      )
      .all<{ document: string }>();
    return (rows.results ?? [])
      .map((row) => JSON.parse(row.document) as NotificationDeliveryRecord)
      .sort(byDue);
  }

  async settleNotificationDelivery(input: {
    readonly deliveryId: string;
    readonly leaseToken: string;
    readonly at: number;
    readonly settlement: NotificationDeliverySettlement;
  }): Promise<boolean> {
    await this.#ready();
    const { settlement } = input;
    const status = settlement.lastStatus;
    const set = settlement.kind === "retry"
      ? { sql: "json_set(document, '$.attempts', ?, '$.nextAttemptAt', ?", params: [settlement.attempts, settlement.nextAttemptAt] as (string | number)[] }
      : { sql: "json_set(document, '$.state', 'settled', '$.attempts', ?, '$.outcome', ?, '$.settledAt', ?", params: [settlement.attempts, settlement.outcome, input.at] as (string | number)[] };
    const withStatus = status !== undefined
      ? { sql: `${set.sql}, '$.lastStatus', ?)`, params: [...set.params, status], remove: "" }
      : { sql: `${set.sql})`, params: set.params, remove: ", '$.lastStatus'" };
    const result = await this.#db
      .prepare(
        `UPDATE takosumi_accounts_documents SET document = json_remove(${withStatus.sql}, '$.leaseToken', '$.leaseExpiresAt'${withStatus.remove}), updated_at = ? ` +
          "WHERE bucket = ? AND key = ? AND json_extract(document, '$.leaseToken') = ?",
      )
      .bind(...withStatus.params, input.at, D1_DELIVERIES_BUCKET, input.deliveryId, input.leaseToken)
      .run();
    return (changeCount(result) ?? 0) > 0;
  }

  async pruneNotificationDeliveries(input: {
    readonly expiredBefore: number;
    readonly limit: number;
  }): Promise<number> {
    await this.#ready();
    const result = await this.#db
      .prepare(
        "DELETE FROM takosumi_accounts_documents WHERE bucket = ? AND key IN (" +
          `SELECT key FROM takosumi_accounts_documents WHERE bucket = ? AND ${NUMBER("$.expiresAt")} < ? ` +
          `ORDER BY ${NUMBER("$.expiresAt")}, key LIMIT ?)`,
      )
      .bind(D1_DELIVERIES_BUCKET, D1_DELIVERIES_BUCKET, input.expiredBefore, input.limit)
      .run();
    return changeCount(result) ?? 0;
  }
}

function changeCount(result: D1Result): number | undefined {
  const changes = result.meta?.changes;
  return typeof changes === "number" ? changes : undefined;
}
