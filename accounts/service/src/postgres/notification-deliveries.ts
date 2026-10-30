// Notification dispatcher state (migrations/048_notification_deliveries.sql).

import type {
  NotificationDeliveryRecord,
  NotificationDeliverySettlement,
  NotificationDispatchCursor,
} from "../../../../core/domains/notifications/dispatch_store.ts";
import {
  millis,
  type PostgresQueryClient,
  runFirst,
  runRows,
  type TimeValue,
  toDate,
} from "./internal.ts";

const LANE = "activity";

interface DeliveryRow {
  delivery_id: string;
  event_id: string;
  pusher_id: string;
  subject: string;
  payload: string;
  urgency: "high" | "normal";
  topic: string | null;
  enqueued_at: TimeValue;
  expires_at: TimeValue;
  attempts: number;
  next_attempt_at: TimeValue;
  state: "pending" | "settled";
  lease_token: string | null;
  lease_expires_at: TimeValue | null;
  outcome: NotificationDeliveryRecord["outcome"] | null;
  last_status: number | null;
  settled_at: TimeValue | null;
}

export async function getNotificationDispatchCursor(
  client: PostgresQueryClient,
): Promise<NotificationDispatchCursor | undefined> {
  const row = await runFirst<{ generation: number | string; cursor_created_at: string; cursor_id: string }>(
    client,
    `SELECT generation, cursor_created_at, cursor_id
     FROM accounts_v1.notification_dispatch_cursors WHERE lane = $1`,
    [LANE],
  );
  return row
    ? { generation: Number(row.generation), createdAt: row.cursor_created_at, id: row.cursor_id }
    : undefined;
}

export async function compareAndSetNotificationDispatchCursor(
  client: PostgresQueryClient,
  input: {
    readonly expectedGeneration: number | undefined;
    readonly createdAt: string;
    readonly id: string;
  },
): Promise<boolean> {
  const rows = input.expectedGeneration === undefined
    ? await runRows<{ lane: string }>(
      client,
      `INSERT INTO accounts_v1.notification_dispatch_cursors
         (lane, generation, cursor_created_at, cursor_id)
       VALUES ($1, 0, $2, $3) ON CONFLICT (lane) DO NOTHING RETURNING lane`,
      [LANE, input.createdAt, input.id],
    )
    : await runRows<{ lane: string }>(
      client,
      `UPDATE accounts_v1.notification_dispatch_cursors
       SET generation = generation + 1, cursor_created_at = $2, cursor_id = $3
       WHERE lane = $1 AND generation = $4 RETURNING lane`,
      [LANE, input.createdAt, input.id, input.expectedGeneration],
    );
  return rows.length > 0;
}

export async function enqueueNotificationDeliveries(
  client: PostgresQueryClient,
  records: readonly NotificationDeliveryRecord[],
): Promise<void> {
  if (records.length === 0) return;
  await runRows(
    client,
    `INSERT INTO accounts_v1.notification_deliveries
       (delivery_id, event_id, pusher_id, subject, payload, urgency, topic,
        enqueued_at, expires_at, attempts, next_attempt_at, state)
     SELECT r.delivery_id, r.event_id, r.pusher_id, r.subject, r.payload, r.urgency, r.topic,
       r.enqueued_at, r.expires_at, r.attempts, r.next_attempt_at, r.state
     FROM jsonb_to_recordset($1::jsonb) AS r(
       delivery_id text, event_id text, pusher_id text, subject text, payload text,
       urgency text, topic text, enqueued_at timestamptz, expires_at timestamptz,
       attempts integer, next_attempt_at timestamptz, state text)
     ON CONFLICT DO NOTHING`,
    [JSON.stringify(records.map((record) => ({
      delivery_id: record.deliveryId,
      event_id: record.eventId,
      pusher_id: record.pusherId,
      subject: record.subject,
      payload: record.payload,
      urgency: record.urgency,
      topic: record.topic ?? null,
      enqueued_at: toDate(record.enqueuedAt).toISOString(),
      expires_at: toDate(record.expiresAt).toISOString(),
      attempts: record.attempts,
      next_attempt_at: toDate(record.nextAttemptAt).toISOString(),
      state: record.state,
    })))],
  );
}

export async function claimNotificationDeliveries(
  client: PostgresQueryClient,
  input: {
    readonly now: number;
    readonly limit: number;
    readonly leaseToken: string;
    readonly leaseExpiresAt: number;
  },
): Promise<readonly NotificationDeliveryRecord[]> {
  const rows = await runRows<DeliveryRow>(
    client,
    `UPDATE accounts_v1.notification_deliveries AS d
     SET lease_token = $1, lease_expires_at = $2
     WHERE d.delivery_id IN (
       SELECT delivery_id FROM accounts_v1.notification_deliveries
       WHERE state = 'pending' AND next_attempt_at <= $3
         AND (lease_expires_at IS NULL OR lease_expires_at <= $3)
       ORDER BY next_attempt_at, delivery_id
       LIMIT $4
       FOR UPDATE SKIP LOCKED)
     RETURNING d.*`,
    [input.leaseToken, toDate(input.leaseExpiresAt), toDate(input.now), input.limit],
  );
  return rows.map(fromRow).sort((left, right) =>
    left.nextAttemptAt - right.nextAttemptAt ||
    (left.deliveryId < right.deliveryId ? -1 : left.deliveryId > right.deliveryId ? 1 : 0)
  );
}

export async function settleNotificationDelivery(
  client: PostgresQueryClient,
  input: {
    readonly deliveryId: string;
    readonly leaseToken: string;
    readonly at: number;
    readonly settlement: NotificationDeliverySettlement;
  },
): Promise<boolean> {
  const { settlement } = input;
  const rows = settlement.kind === "retry"
    ? await runRows<{ delivery_id: string }>(
      client,
      `UPDATE accounts_v1.notification_deliveries
       SET attempts = $3, next_attempt_at = $4, last_status = $5,
         lease_token = NULL, lease_expires_at = NULL
       WHERE delivery_id = $1 AND lease_token = $2 RETURNING delivery_id`,
      [input.deliveryId, input.leaseToken, settlement.attempts, toDate(settlement.nextAttemptAt), settlement.lastStatus ?? null],
    )
    : await runRows<{ delivery_id: string }>(
      client,
      `UPDATE accounts_v1.notification_deliveries
       SET state = 'settled', attempts = $3, outcome = $4, last_status = $5, settled_at = $6,
         lease_token = NULL, lease_expires_at = NULL
       WHERE delivery_id = $1 AND lease_token = $2 RETURNING delivery_id`,
      [input.deliveryId, input.leaseToken, settlement.attempts, settlement.outcome, settlement.lastStatus ?? null, toDate(input.at)],
    );
  return rows.length > 0;
}

export async function pruneNotificationDeliveries(
  client: PostgresQueryClient,
  input: { readonly expiredBefore: number; readonly limit: number },
): Promise<number> {
  const rows = await runRows<{ delivery_id: string }>(
    client,
    `DELETE FROM accounts_v1.notification_deliveries
     WHERE delivery_id IN (
       SELECT delivery_id FROM accounts_v1.notification_deliveries
       WHERE expires_at < $1 ORDER BY expires_at, delivery_id LIMIT $2)
     RETURNING delivery_id`,
    [toDate(input.expiredBefore), input.limit],
  );
  return rows.length;
}

function fromRow(row: DeliveryRow): NotificationDeliveryRecord {
  return {
    deliveryId: row.delivery_id,
    eventId: row.event_id,
    pusherId: row.pusher_id,
    subject: row.subject,
    payload: row.payload,
    urgency: row.urgency,
    ...(row.topic !== null ? { topic: row.topic } : {}),
    enqueuedAt: millis(row.enqueued_at),
    expiresAt: millis(row.expires_at),
    attempts: Number(row.attempts),
    nextAttemptAt: millis(row.next_attempt_at),
    state: row.state,
    ...(row.lease_token !== null ? { leaseToken: row.lease_token } : {}),
    ...(row.lease_expires_at !== null ? { leaseExpiresAt: millis(row.lease_expires_at) } : {}),
    ...(row.outcome !== null && row.outcome !== undefined ? { outcome: row.outcome } : {}),
    ...(row.last_status !== null ? { lastStatus: Number(row.last_status) } : {}),
    ...(row.settled_at !== null ? { settledAt: millis(row.settled_at) } : {}),
  };
}
