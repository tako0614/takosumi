/**
 * Durable records of the devices that receive this instance's own
 * notifications (Takosumi Mobile pushers), in the three Accounts stores.
 *
 * A pusher is identified by (account, app_id, pushkey). Its id is derived
 * from that triple, so every store gets the uniqueness from its primary key
 * and a repeated registration updates the same row.
 */

import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { D1Database, D1Result } from "./d1-store.ts";
import { base64UrlEncodeBytes } from "./encoding.ts";

/** At most this many pushers per account. */
export const NOTIFICATION_PUSHERS_PER_ACCOUNT = 20;

export interface NotificationPusherRecord {
  readonly pusherId: string;
  readonly subject: TakosumiSubject;
  readonly kind: "webpush";
  readonly appId: string;
  /** The subscription's `p256dh`, base64url. */
  readonly pushkey: string;
  /** The push endpoint (`data.url`) on an allowed relay origin. */
  readonly endpoint: string;
  /** The subscription's `auth` secret (`data.auth`), base64url. */
  readonly auth: string;
  readonly deviceDisplayName: string;
  readonly lang: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastSuccessAt?: number;
  readonly lastFailureAt?: number;
  /** HTTP status of the last failure; absent for a timeout or network error. */
  readonly lastFailureStatus?: number;
}

export type NotificationPusherSaveResult =
  | {
      readonly status: "created" | "updated";
      readonly record: NotificationPusherRecord;
    }
  | { readonly status: "limit_reached" };

export interface NotificationPusherOutcome {
  readonly pusherId: string;
  readonly at: number;
  readonly outcome: "delivered" | "failed";
  /** For a failure: the HTTP status, or absent for a timeout/network error. */
  readonly status?: number;
}

/** The Accounts store methods for pushers (optional on `AccountsStore`). */
export interface NotificationPusherStore {
  /**
   * Create or update the pusher with `record.pusherId`. An update keeps the
   * original `createdAt`, and keeps the delivery health only while the
   * endpoint and `auth` are unchanged. Creating fails with `limit_reached`
   * once the account has {@link NOTIFICATION_PUSHERS_PER_ACCOUNT} pushers.
   */
  saveNotificationPusher(
    record: NotificationPusherRecord,
  ): Promise<NotificationPusherSaveResult>;
  /** The account's pushers, oldest first. */
  listNotificationPushersForSubject(
    subject: TakosumiSubject,
  ): Promise<readonly NotificationPusherRecord[]>;
  findNotificationPusher(
    pusherId: string,
  ): Promise<NotificationPusherRecord | undefined>;
  /** Delete the account's own pusher; false when it is not theirs or absent. */
  deleteNotificationPusher(input: {
    readonly subject: TakosumiSubject;
    readonly pusherId: string;
  }): Promise<boolean>;
  /** Delete a pusher whose subscription the relay reported gone (404/410). */
  removeNotificationPusher(pusherId: string): Promise<void>;
  recordNotificationPusherOutcome(
    input: NotificationPusherOutcome,
  ): Promise<void>;
}

const PUSHER_ID_PREFIX = "npsh_";
export const NOTIFICATION_PUSHER_ID_PATTERN = /^npsh_[A-Za-z0-9_-]{32}$/;

/** `npsh_` + 32 base64url characters of SHA-256 over the identity triple. */
export async function notificationPusherId(input: {
  readonly subject: TakosumiSubject;
  readonly appId: string;
  readonly pushkey: string;
}): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([
          "takosumi.notification-pusher@v1",
          input.subject,
          input.appId,
          input.pushkey,
        ]),
      ),
    ),
  );
  return `${PUSHER_ID_PREFIX}${base64UrlEncodeBytes(digest.subarray(0, 24))}`;
}

/**
 * The record to store when `incoming` replaces `existing`: the original
 * creation time, and the delivery health only for the same destination.
 */
export function mergeNotificationPusher(
  existing: NotificationPusherRecord | undefined,
  incoming: NotificationPusherRecord,
): NotificationPusherRecord {
  if (!existing) return withoutHealth(incoming);
  const sameDestination =
    existing.endpoint === incoming.endpoint && existing.auth === incoming.auth;
  return {
    ...withoutHealth(incoming),
    createdAt: existing.createdAt,
    ...(sameDestination ? healthOf(existing) : {}),
  };
}

export function applyNotificationPusherOutcome(
  record: NotificationPusherRecord,
  input: NotificationPusherOutcome,
): NotificationPusherRecord {
  if (input.outcome === "delivered") {
    return { ...record, lastSuccessAt: input.at };
  }
  const { lastFailureStatus: _previous, ...rest } = record;
  return {
    ...rest,
    lastFailureAt: input.at,
    ...(input.status !== undefined ? { lastFailureStatus: input.status } : {}),
  };
}

function withoutHealth(
  record: NotificationPusherRecord,
): NotificationPusherRecord {
  const {
    lastSuccessAt: _success,
    lastFailureAt: _failure,
    lastFailureStatus: _status,
    ...rest
  } = record;
  return rest;
}

function healthOf(
  record: NotificationPusherRecord,
): Partial<NotificationPusherRecord> {
  return {
    ...(record.lastSuccessAt !== undefined
      ? { lastSuccessAt: record.lastSuccessAt }
      : {}),
    ...(record.lastFailureAt !== undefined
      ? { lastFailureAt: record.lastFailureAt }
      : {}),
    ...(record.lastFailureStatus !== undefined
      ? { lastFailureStatus: record.lastFailureStatus }
      : {}),
  };
}

function byCreation(
  left: NotificationPusherRecord,
  right: NotificationPusherRecord,
): number {
  return (
    left.createdAt - right.createdAt ||
    (left.pusherId < right.pusherId ? -1 : left.pusherId > right.pusherId ? 1 : 0)
  );
}

/** In-memory reference adapter. */
export class MemoryNotificationPusherRecords implements NotificationPusherStore {
  readonly #records = new Map<string, NotificationPusherRecord>();

  saveNotificationPusher(
    record: NotificationPusherRecord,
  ): Promise<NotificationPusherSaveResult> {
    const existing = this.#records.get(record.pusherId);
    if (existing && existing.subject !== record.subject) {
      throw new TypeError("notification pusher id belongs to another account");
    }
    if (!existing) {
      let count = 0;
      for (const value of this.#records.values()) {
        if (value.subject === record.subject) count += 1;
      }
      if (count >= NOTIFICATION_PUSHERS_PER_ACCOUNT) {
        return Promise.resolve({ status: "limit_reached" });
      }
    }
    const stored = mergeNotificationPusher(existing, record);
    this.#records.set(record.pusherId, structuredClone(stored));
    return Promise.resolve({
      status: existing ? "updated" : "created",
      record: structuredClone(stored),
    });
  }

  listNotificationPushersForSubject(
    subject: TakosumiSubject,
  ): Promise<readonly NotificationPusherRecord[]> {
    return Promise.resolve(
      [...this.#records.values()]
        .filter((record) => record.subject === subject)
        .sort(byCreation)
        .map((record) => structuredClone(record)),
    );
  }

  findNotificationPusher(
    pusherId: string,
  ): Promise<NotificationPusherRecord | undefined> {
    const record = this.#records.get(pusherId);
    return Promise.resolve(record ? structuredClone(record) : undefined);
  }

  deleteNotificationPusher(input: {
    readonly subject: TakosumiSubject;
    readonly pusherId: string;
  }): Promise<boolean> {
    const record = this.#records.get(input.pusherId);
    if (!record || record.subject !== input.subject) {
      return Promise.resolve(false);
    }
    this.#records.delete(input.pusherId);
    return Promise.resolve(true);
  }

  removeNotificationPusher(pusherId: string): Promise<void> {
    this.#records.delete(pusherId);
    return Promise.resolve();
  }

  recordNotificationPusherOutcome(
    input: NotificationPusherOutcome,
  ): Promise<void> {
    const record = this.#records.get(input.pusherId);
    if (record) {
      this.#records.set(
        input.pusherId,
        applyNotificationPusherOutcome(record, input),
      );
    }
    return Promise.resolve();
  }
}

const D1_PUSHERS_BUCKET = "notification_pushers";
const D1_PUSHERS_BY_SUBJECT = "notification_pushers_by_subject";

/**
 * Cloudflare D1 adapter over the Accounts document and index tables. It
 * needs no schema change: a new bucket and index name in the existing
 * `takosumi_accounts_documents` / `takosumi_accounts_indexes` tables.
 */
export class D1NotificationPusherRecords implements NotificationPusherStore {
  readonly #db: D1Database;
  readonly #ready: () => Promise<void>;

  constructor(db: D1Database, ready: () => Promise<void>) {
    this.#db = db;
    this.#ready = ready;
  }

  async saveNotificationPusher(
    record: NotificationPusherRecord,
  ): Promise<NotificationPusherSaveResult> {
    const existing = await this.findNotificationPusher(record.pusherId);
    if (existing && existing.subject !== record.subject) {
      throw new TypeError("notification pusher id belongs to another account");
    }
    const stored = mergeNotificationPusher(existing, record);
    const document = JSON.stringify(stored);
    // One batch is one transaction. The document is written only while the
    // pusher already exists or the account is under the limit; the index row
    // follows only when the document is present.
    const results = await this.#db.batch([
      this.#db
        .prepare(
          "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) " +
            "SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM takosumi_accounts_documents WHERE bucket = ? AND key = ?) " +
            "OR (SELECT COUNT(*) FROM takosumi_accounts_indexes WHERE index_name = ? AND index_key = ?) < ? " +
            "ON CONFLICT (bucket, key) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at",
        )
        .bind(
          D1_PUSHERS_BUCKET,
          stored.pusherId,
          document,
          stored.updatedAt,
          D1_PUSHERS_BUCKET,
          stored.pusherId,
          D1_PUSHERS_BY_SUBJECT,
          stored.subject,
          NOTIFICATION_PUSHERS_PER_ACCOUNT,
        ),
      this.#db
        .prepare(
          "INSERT OR REPLACE INTO takosumi_accounts_indexes (index_name, index_key, bucket, document_key, sort_key) " +
            "SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM takosumi_accounts_documents WHERE bucket = ? AND key = ? AND document = ?)",
        )
        .bind(
          D1_PUSHERS_BY_SUBJECT,
          stored.subject,
          D1_PUSHERS_BUCKET,
          stored.pusherId,
          stored.createdAt,
          D1_PUSHERS_BUCKET,
          stored.pusherId,
          document,
        ),
    ]);
    if (results.length !== 2 || results.some((result) => !result.success)) {
      throw new Error("D1 Accounts notification pusher write failed");
    }
    const changes = changeCount(results[0]!);
    const written =
      changes !== undefined
        ? changes > 0
        : (await this.findNotificationPusher(stored.pusherId)) !== undefined;
    if (!written) return { status: "limit_reached" };
    return { status: existing ? "updated" : "created", record: stored };
  }

  async listNotificationPushersForSubject(
    subject: TakosumiSubject,
  ): Promise<readonly NotificationPusherRecord[]> {
    await this.#ready();
    const rows = await this.#db
      .prepare(
        "SELECT d.document AS document FROM takosumi_accounts_indexes i " +
          "JOIN takosumi_accounts_documents d ON d.bucket = i.bucket AND d.key = i.document_key " +
          "WHERE i.index_name = ? AND i.index_key = ? ORDER BY i.sort_key, i.document_key",
      )
      .bind(D1_PUSHERS_BY_SUBJECT, subject)
      .all<{ document: string }>();
    return (rows.results ?? [])
      .map((row) => JSON.parse(row.document) as NotificationPusherRecord)
      .sort(byCreation);
  }

  async findNotificationPusher(
    pusherId: string,
  ): Promise<NotificationPusherRecord | undefined> {
    await this.#ready();
    const row = await this.#db
      .prepare(
        "SELECT document FROM takosumi_accounts_documents WHERE bucket = ? AND key = ?",
      )
      .bind(D1_PUSHERS_BUCKET, pusherId)
      .first<{ document: string }>();
    return row ? (JSON.parse(row.document) as NotificationPusherRecord) : undefined;
  }

  async deleteNotificationPusher(input: {
    readonly subject: TakosumiSubject;
    readonly pusherId: string;
  }): Promise<boolean> {
    await this.#ready();
    const results = await this.#db.batch([
      this.#db
        .prepare(
          "DELETE FROM takosumi_accounts_documents WHERE bucket = ? AND key = ? AND json_extract(document, '$.subject') = ?",
        )
        .bind(D1_PUSHERS_BUCKET, input.pusherId, input.subject),
      this.#db
        .prepare(
          "DELETE FROM takosumi_accounts_indexes WHERE bucket = ? AND document_key = ? AND index_key = ?",
        )
        .bind(D1_PUSHERS_BUCKET, input.pusherId, input.subject),
    ]);
    if (results.length !== 2 || results.some((result) => !result.success)) {
      throw new Error("D1 Accounts notification pusher delete failed");
    }
    return (changeCount(results[0]!) ?? 0) > 0;
  }

  async removeNotificationPusher(pusherId: string): Promise<void> {
    await this.#ready();
    const results = await this.#db.batch([
      this.#db
        .prepare(
          "DELETE FROM takosumi_accounts_documents WHERE bucket = ? AND key = ?",
        )
        .bind(D1_PUSHERS_BUCKET, pusherId),
      this.#db
        .prepare(
          "DELETE FROM takosumi_accounts_indexes WHERE bucket = ? AND document_key = ?",
        )
        .bind(D1_PUSHERS_BUCKET, pusherId),
    ]);
    if (results.length !== 2 || results.some((result) => !result.success)) {
      throw new Error("D1 Accounts notification pusher delete failed");
    }
  }

  async recordNotificationPusherOutcome(
    input: NotificationPusherOutcome,
  ): Promise<void> {
    await this.#ready();
    const statement =
      input.outcome === "delivered"
        ? this.#db
            .prepare(
              "UPDATE takosumi_accounts_documents SET document = json_set(document, '$.lastSuccessAt', ?) WHERE bucket = ? AND key = ?",
            )
            .bind(input.at, D1_PUSHERS_BUCKET, input.pusherId)
        : input.status === undefined
          ? this.#db
              .prepare(
                "UPDATE takosumi_accounts_documents SET document = json_remove(json_set(document, '$.lastFailureAt', ?), '$.lastFailureStatus') WHERE bucket = ? AND key = ?",
              )
              .bind(input.at, D1_PUSHERS_BUCKET, input.pusherId)
          : this.#db
              .prepare(
                "UPDATE takosumi_accounts_documents SET document = json_set(document, '$.lastFailureAt', ?, '$.lastFailureStatus', ?) WHERE bucket = ? AND key = ?",
              )
              .bind(input.at, input.status, D1_PUSHERS_BUCKET, input.pusherId);
    await statement.run();
  }
}

function changeCount(result: D1Result): number | undefined {
  const changes = result.meta?.changes;
  return typeof changes === "number" ? changes : undefined;
}
