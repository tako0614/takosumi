// Takosumi Mobile pusher storage (migrations/047_notification_pushers.sql).

import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import {
  NOTIFICATION_PUSHERS_PER_ACCOUNT,
  type NotificationPusherOutcome,
  type NotificationPusherRecord,
  type NotificationPusherSaveResult,
} from "../notification-pushers-store.ts";
import {
  millis,
  type PostgresQueryClient,
  runFirst,
  runQuery,
  runRows,
  type TimeValue,
  toDate,
} from "./internal.ts";

interface NotificationPusherRow {
  pusher_id: string;
  subject: TakosumiSubject;
  kind: string;
  app_id: string;
  pushkey: string;
  endpoint: string;
  auth: string;
  device_display_name: string;
  lang: string;
  created_at: TimeValue;
  updated_at: TimeValue;
  last_success_at: TimeValue | null;
  last_failure_at: TimeValue | null;
  last_failure_status: number | null;
}

const COLUMNS =
  "pusher_id, subject, kind, app_id, pushkey, endpoint, auth, device_display_name, lang, " +
  "created_at, updated_at, last_success_at, last_failure_at, last_failure_status";

/**
 * One statement: insert while the account is under the limit, or update the
 * existing row. An update keeps `created_at`, and keeps the delivery health
 * only when the endpoint and auth secret are unchanged. Concurrent first
 * registrations from one account can each see the same count under READ
 * COMMITTED, so the bound can be exceeded by the number of such concurrent
 * requests; the route's rate limit keeps that small.
 */
export async function saveNotificationPusher(
  client: PostgresQueryClient,
  record: NotificationPusherRecord,
): Promise<NotificationPusherSaveResult> {
  const row = await runFirst<NotificationPusherRow & { inserted: boolean }>(
    client,
    `INSERT INTO accounts_v1.notification_pushers AS p (${COLUMNS})
     SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text,
       $7::text, $8::text, $9::text, $10::timestamptz, $11::timestamptz,
       NULL::timestamptz, NULL::timestamptz, NULL::integer
     WHERE (
       SELECT count(*) FROM accounts_v1.notification_pushers
       WHERE subject = $2::text AND pusher_id <> $1::text
     ) < $12::bigint
     ON CONFLICT (pusher_id) DO UPDATE SET
       endpoint = EXCLUDED.endpoint,
       auth = EXCLUDED.auth,
       device_display_name = EXCLUDED.device_display_name,
       lang = EXCLUDED.lang,
       updated_at = EXCLUDED.updated_at,
       last_success_at = CASE WHEN p.endpoint = EXCLUDED.endpoint AND p.auth = EXCLUDED.auth THEN p.last_success_at END,
       last_failure_at = CASE WHEN p.endpoint = EXCLUDED.endpoint AND p.auth = EXCLUDED.auth THEN p.last_failure_at END,
       last_failure_status = CASE WHEN p.endpoint = EXCLUDED.endpoint AND p.auth = EXCLUDED.auth THEN p.last_failure_status END
     WHERE p.subject = EXCLUDED.subject
     RETURNING ${COLUMNS}, (xmax = 0) AS inserted`,
    [
      record.pusherId,
      record.subject,
      record.kind,
      record.appId,
      record.pushkey,
      record.endpoint,
      record.auth,
      record.deviceDisplayName,
      record.lang,
      toDate(record.createdAt),
      toDate(record.updatedAt),
      NOTIFICATION_PUSHERS_PER_ACCOUNT,
    ],
  );
  if (!row) {
    // No row: either the account is at its limit, or (impossible for derived
    // ids) the id belongs to another account.
    const owner = await runFirst<{ subject: TakosumiSubject }>(
      client,
      "SELECT subject FROM accounts_v1.notification_pushers WHERE pusher_id = $1",
      [record.pusherId],
    );
    if (owner && owner.subject !== record.subject) {
      throw new TypeError("notification pusher id belongs to another account");
    }
    return { status: "limit_reached" };
  }
  return {
    status: row.inserted ? "created" : "updated",
    record: fromRow(row),
  };
}

export async function listNotificationPushersForSubject(
  client: PostgresQueryClient,
  subject: TakosumiSubject,
): Promise<readonly NotificationPusherRecord[]> {
  const rows = await runRows<NotificationPusherRow>(
    client,
    `SELECT ${COLUMNS} FROM accounts_v1.notification_pushers
     WHERE subject = $1 ORDER BY created_at, pusher_id`,
    [subject],
  );
  return rows.map(fromRow);
}

export async function findNotificationPusher(
  client: PostgresQueryClient,
  pusherId: string,
): Promise<NotificationPusherRecord | undefined> {
  const row = await runFirst<NotificationPusherRow>(
    client,
    `SELECT ${COLUMNS} FROM accounts_v1.notification_pushers WHERE pusher_id = $1`,
    [pusherId],
  );
  return row ? fromRow(row) : undefined;
}

export async function deleteNotificationPusher(
  client: PostgresQueryClient,
  input: { readonly subject: TakosumiSubject; readonly pusherId: string },
): Promise<boolean> {
  const rows = await runRows<{ pusher_id: string }>(
    client,
    `DELETE FROM accounts_v1.notification_pushers
     WHERE pusher_id = $1 AND subject = $2 RETURNING pusher_id`,
    [input.pusherId, input.subject],
  );
  return rows.length > 0;
}

export async function removeNotificationPusher(
  client: PostgresQueryClient,
  pusherId: string,
): Promise<void> {
  await runQuery(
    client,
    "DELETE FROM accounts_v1.notification_pushers WHERE pusher_id = $1",
    [pusherId],
  );
}

export async function recordNotificationPusherOutcome(
  client: PostgresQueryClient,
  input: NotificationPusherOutcome,
): Promise<void> {
  if (input.outcome === "delivered") {
    await runQuery(
      client,
      "UPDATE accounts_v1.notification_pushers SET last_success_at = $2 WHERE pusher_id = $1",
      [input.pusherId, toDate(input.at)],
    );
    return;
  }
  await runQuery(
    client,
    `UPDATE accounts_v1.notification_pushers
     SET last_failure_at = $2, last_failure_status = $3 WHERE pusher_id = $1`,
    [input.pusherId, toDate(input.at), input.status ?? null],
  );
}

function fromRow(row: NotificationPusherRow): NotificationPusherRecord {
  const lastSuccessAt = optionalMillis(row.last_success_at);
  const lastFailureAt = optionalMillis(row.last_failure_at);
  return {
    pusherId: row.pusher_id,
    subject: row.subject,
    kind: "webpush",
    appId: row.app_id,
    pushkey: row.pushkey,
    endpoint: row.endpoint,
    auth: row.auth,
    deviceDisplayName: row.device_display_name,
    lang: row.lang,
    createdAt: millis(row.created_at),
    updatedAt: millis(row.updated_at),
    ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
    ...(lastFailureAt !== undefined ? { lastFailureAt } : {}),
    ...(row.last_failure_status !== null && row.last_failure_status !== undefined
      ? { lastFailureStatus: Number(row.last_failure_status) }
      : {}),
  };
}

function optionalMillis(value: TimeValue | null): number | undefined {
  return value === null || value === undefined ? undefined : millis(value);
}
