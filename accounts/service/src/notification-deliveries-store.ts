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
  NotificationParkedEvent,
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

const MAX_CLAIM_DELIVERY_IDS = 50;

function boundedDeliveryIds(ids: readonly string[]): readonly string[] {
  if (ids.length > MAX_CLAIM_DELIVERY_IDS) {
    throw new RangeError(`at most ${MAX_CLAIM_DELIVERY_IDS} delivery ids per claim`);
  }
  return ids;
}

function cursorRecord(
  generation: number,
  input: { readonly createdAt: string; readonly id: string; readonly parked?: readonly NotificationParkedEvent[] },
): NotificationDispatchCursor {
  return {
    generation,
    createdAt: input.createdAt,
    id: input.id,
    parked: (input.parked ?? []).map((entry) => ({
      eventId: entry.eventId,
      createdAt: entry.createdAt,
      attempts: entry.attempts,
    })),
  };
}

/** In-memory reference adapter. */
export class MemoryNotificationDeliveryRecords implements NotificationDeliveryStore {
  #cursor: NotificationDispatchCursor | undefined;
  readonly #deliveries = new Map<string, NotificationDeliveryRecord>();
  readonly #byEventPusher = new Set<string>();

  getNotificationDispatchCursor(): Promise<NotificationDispatchCursor | undefined> {
    return Promise.resolve(this.#cursor ? structuredClone(this.#cursor) : undefined);
  }

  compareAndSetNotificationDispatchCursor(input: {
    readonly expectedGeneration: number | undefined;
    readonly createdAt: string;
    readonly id: string;
    readonly parked?: readonly NotificationParkedEvent[];
  }): Promise<boolean> {
    if (input.expectedGeneration === undefined) {
      if (this.#cursor) return Promise.resolve(false);
      this.#cursor = cursorRecord(0, input);
      return Promise.resolve(true);
    }
    if (this.#cursor?.generation !== input.expectedGeneration) {
      return Promise.resolve(false);
    }
    this.#cursor = cursorRecord(input.expectedGeneration + 1, input);
    return Promise.resolve(true);
  }

  enqueueNotificationDeliveries(
    records: readonly NotificationDeliveryRecord[],
  ): Promise<number> {
    let added = 0;
    for (const record of records) {
      const pair = `${record.eventId}\n${record.pusherId}`;
      if (this.#deliveries.has(record.deliveryId) || this.#byEventPusher.has(pair)) continue;
      this.#deliveries.set(record.deliveryId, structuredClone(record));
      this.#byEventPusher.add(pair);
      added += 1;
    }
    return Promise.resolve(added);
  }

  claimNotificationDeliveries(input: {
    readonly now: number;
    readonly limit: number;
    readonly leaseToken: string;
    readonly leaseExpiresAt: number;
    readonly deliveryIds?: readonly string[];
  }): Promise<readonly NotificationDeliveryRecord[]> {
    const only = input.deliveryIds ? new Set(boundedDeliveryIds(input.deliveryIds)) : undefined;
    const claimed = [...this.#deliveries.values()]
      .filter((record) => isDue(record, input.now) && (!only || only.has(record.deliveryId)))
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
/**
 * Present only while a row is pending. Its sort key is when the row may be
 * claimed next: `nextAttemptAt`, or the lease expiry while leased.
 */
const D1_DUE_INDEX = "notification_deliveries_due";
/** Every row, sorted by `expiresAt`, for pruning. */
const D1_EXPIRY_INDEX = "notification_deliveries_expiry";
const D1_INDEX_KEY = "all";
const D1_ENQUEUE_CHUNK = 30;

/**
 * Cloudflare D1 adapter over the Accounts document and index tables, with no
 * schema change. Claims and pruning go through the generic index table's
 * `(index_name, index_key, sort_key)` lookup index, so they read only due or
 * expired rows, never every delivered row.
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
    return row ? cursorRecord(Number((JSON.parse(row.document) as NotificationDispatchCursor).generation), JSON.parse(row.document) as NotificationDispatchCursor) : undefined;
  }

  async compareAndSetNotificationDispatchCursor(input: {
    readonly expectedGeneration: number | undefined;
    readonly createdAt: string;
    readonly id: string;
    readonly parked?: readonly NotificationParkedEvent[];
  }): Promise<boolean> {
    await this.#ready();
    const now = Date.now();
    if (input.expectedGeneration === undefined) {
      const document = JSON.stringify(cursorRecord(0, input));
      const result = await this.#db
        .prepare(
          "INSERT OR IGNORE INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(D1_CURSOR_BUCKET, D1_CURSOR_KEY, document, now)
        .run();
      return (changeCount(result) ?? 0) > 0;
    }
    const document = JSON.stringify(cursorRecord(input.expectedGeneration + 1, input));
    const result = await this.#db
      .prepare(
        "UPDATE takosumi_accounts_documents SET document = ?, updated_at = ? WHERE bucket = ? AND key = ? " +
          "AND CAST(json_extract(document, '$.generation') AS INTEGER) = ?",
      )
      .bind(document, now, D1_CURSOR_BUCKET, D1_CURSOR_KEY, input.expectedGeneration)
      .run();
    return (changeCount(result) ?? 0) > 0;
  }

  async enqueueNotificationDeliveries(
    records: readonly NotificationDeliveryRecord[],
  ): Promise<number> {
    if (records.length === 0) return 0;
    await this.#ready();
    const now = Date.now();
    let added = 0;
    for (let index = 0; index < records.length; index += D1_ENQUEUE_CHUNK) {
      const chunk = records.slice(index, index + D1_ENQUEUE_CHUNK);
      // Per row: the document if new; the due entry only while the stored row
      // is pending (a settled duplicate must not become due again); the
      // expiry entry always (idempotent).
      const statements = chunk.flatMap((record) => [
        this.#db
          .prepare(
            "INSERT OR IGNORE INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES (?, ?, ?, ?)",
          )
          .bind(D1_DELIVERIES_BUCKET, record.deliveryId, JSON.stringify(record), now),
        this.#db
          .prepare(
            "INSERT OR IGNORE INTO takosumi_accounts_indexes (index_name, index_key, bucket, document_key, sort_key) " +
              "SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM takosumi_accounts_documents " +
              "WHERE bucket = ? AND key = ? AND json_extract(document, '$.state') = 'pending' " +
              "AND json_extract(document, '$.attempts') = 0 AND json_extract(document, '$.leaseToken') IS NULL)",
          )
          .bind(
            D1_DUE_INDEX, D1_INDEX_KEY, D1_DELIVERIES_BUCKET, record.deliveryId, record.nextAttemptAt,
            D1_DELIVERIES_BUCKET, record.deliveryId,
          ),
        this.#db
          .prepare(
            "INSERT OR IGNORE INTO takosumi_accounts_indexes (index_name, index_key, bucket, document_key, sort_key) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(D1_EXPIRY_INDEX, D1_INDEX_KEY, D1_DELIVERIES_BUCKET, record.deliveryId, record.expiresAt),
      ]);
      const results = await this.#db.batch(statements);
      if (results.length !== statements.length || results.some((result) => !result.success)) {
        throw new Error("D1 Accounts notification delivery enqueue failed");
      }
      for (let row = 0; row < chunk.length; row += 1) {
        added += (changeCount(results[row * 3]!) ?? 0) > 0 ? 1 : 0;
      }
    }
    return added;
  }

  async claimNotificationDeliveries(input: {
    readonly now: number;
    readonly limit: number;
    readonly leaseToken: string;
    readonly leaseExpiresAt: number;
    readonly deliveryIds?: readonly string[];
  }): Promise<readonly NotificationDeliveryRecord[]> {
    await this.#ready();
    const only = input.deliveryIds ? boundedDeliveryIds(input.deliveryIds) : undefined;
    if (only && only.length === 0) return [];
    const due =
      "SELECT document_key FROM takosumi_accounts_indexes WHERE index_name = ? AND index_key = ? AND sort_key <= ? " +
      (only ? `AND document_key IN (${only.map(() => "?").join(", ")}) ` : "") +
      "ORDER BY sort_key, document_key LIMIT ?";
    const dueParams = [D1_DUE_INDEX, D1_INDEX_KEY, input.now, ...(only ?? []), input.limit] as const;
    // One transaction: lease the due documents, then push their due entries to
    // the lease expiry. Both statements select the same due set because the
    // first one does not change the index table.
    const results = await this.#db.batch([
      this.#db
        .prepare(
          "UPDATE takosumi_accounts_documents SET document = json_set(document, '$.leaseToken', ?, '$.leaseExpiresAt', ?), updated_at = ? " +
            `WHERE bucket = ? AND key IN (${due})`,
        )
        .bind(input.leaseToken, input.leaseExpiresAt, input.now, D1_DELIVERIES_BUCKET, ...dueParams),
      this.#db
        .prepare(
          "UPDATE takosumi_accounts_indexes SET sort_key = ? WHERE index_name = ? AND index_key = ? AND bucket = ? " +
            `AND document_key IN (${due})`,
        )
        .bind(input.leaseExpiresAt, D1_DUE_INDEX, D1_INDEX_KEY, D1_DELIVERIES_BUCKET, ...dueParams),
    ]);
    if (results.length !== 2 || results.some((result) => !result.success)) {
      throw new Error("D1 Accounts notification delivery claim failed");
    }
    if ((changeCount(results[0]!) ?? 1) === 0) return [];
    // Read back exactly this lease: due entries now sorted at the lease
    // expiry, whose documents carry this lease token.
    const leased = await this.#db
      .prepare(
        "SELECT d.document AS document FROM takosumi_accounts_indexes i " +
          "JOIN takosumi_accounts_documents d ON d.bucket = i.bucket AND d.key = i.document_key " +
          "WHERE i.index_name = ? AND i.index_key = ? AND i.sort_key = ? AND i.bucket = ? " +
          "AND json_extract(d.document, '$.leaseToken') = ?",
      )
      .bind(D1_DUE_INDEX, D1_INDEX_KEY, input.leaseExpiresAt, D1_DELIVERIES_BUCKET, input.leaseToken)
      .all<{ document: string }>();
    return (leased.results ?? [])
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
    // The index change applies only when this lease holder's document write
    // did: afterwards the document carries no lease and this attempt count.
    const settledHere =
      "EXISTS (SELECT 1 FROM takosumi_accounts_documents WHERE bucket = ? AND key = ? " +
      "AND json_extract(document, '$.leaseToken') IS NULL AND json_extract(document, '$.attempts') = ? " +
      (settlement.kind === "retry"
        ? "AND json_extract(document, '$.state') = 'pending')"
        : "AND json_extract(document, '$.state') = 'settled')");
    const results = await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE takosumi_accounts_documents SET document = json_remove(${withStatus.sql}, '$.leaseToken', '$.leaseExpiresAt'${withStatus.remove}), updated_at = ? ` +
            "WHERE bucket = ? AND key = ? AND json_extract(document, '$.leaseToken') = ?",
        )
        .bind(...withStatus.params, input.at, D1_DELIVERIES_BUCKET, input.deliveryId, input.leaseToken),
      settlement.kind === "retry"
        ? this.#db
          .prepare(
            "UPDATE takosumi_accounts_indexes SET sort_key = ? WHERE index_name = ? AND index_key = ? AND bucket = ? AND document_key = ? " +
              `AND ${settledHere}`,
          )
          .bind(
            settlement.nextAttemptAt, D1_DUE_INDEX, D1_INDEX_KEY, D1_DELIVERIES_BUCKET, input.deliveryId,
            D1_DELIVERIES_BUCKET, input.deliveryId, settlement.attempts,
          )
        : this.#db
          .prepare(
            "DELETE FROM takosumi_accounts_indexes WHERE index_name = ? AND index_key = ? AND bucket = ? AND document_key = ? " +
              `AND ${settledHere}`,
          )
          .bind(
            D1_DUE_INDEX, D1_INDEX_KEY, D1_DELIVERIES_BUCKET, input.deliveryId,
            D1_DELIVERIES_BUCKET, input.deliveryId, settlement.attempts,
          ),
    ]);
    if (results.length !== 2 || results.some((result) => !result.success)) {
      throw new Error("D1 Accounts notification delivery settle failed");
    }
    return (changeCount(results[0]!) ?? 0) > 0;
  }

  async pruneNotificationDeliveries(input: {
    readonly expiredBefore: number;
    readonly limit: number;
  }): Promise<number> {
    await this.#ready();
    const expired =
      "SELECT document_key FROM takosumi_accounts_indexes WHERE index_name = ? AND index_key = ? AND sort_key < ? " +
      "ORDER BY sort_key, document_key LIMIT ?";
    const params = [D1_EXPIRY_INDEX, D1_INDEX_KEY, input.expiredBefore, input.limit] as const;
    // The expiry entries are deleted last, so all three statements select the
    // same expired set.
    const results = await this.#db.batch([
      this.#db
        .prepare(
          `DELETE FROM takosumi_accounts_indexes WHERE index_name = ? AND bucket = ? AND document_key IN (${expired})`,
        )
        .bind(D1_DUE_INDEX, D1_DELIVERIES_BUCKET, ...params),
      this.#db
        .prepare(`DELETE FROM takosumi_accounts_documents WHERE bucket = ? AND key IN (${expired})`)
        .bind(D1_DELIVERIES_BUCKET, ...params),
      this.#db
        .prepare(
          `DELETE FROM takosumi_accounts_indexes WHERE index_name = ? AND bucket = ? AND document_key IN (${expired})`,
        )
        .bind(D1_EXPIRY_INDEX, D1_DELIVERIES_BUCKET, ...params),
    ]);
    if (results.length !== 3 || results.some((result) => !result.success)) {
      throw new Error("D1 Accounts notification delivery prune failed");
    }
    return changeCount(results[1]!) ?? 0;
  }
}

function changeCount(result: D1Result): number | undefined {
  const changes = result.meta?.changes;
  return typeof changes === "number" ? changes : undefined;
}
