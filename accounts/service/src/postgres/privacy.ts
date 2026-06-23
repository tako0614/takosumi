import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { asc, eq } from "drizzle-orm";
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import type { PrivacyRequestRecord } from "../store.ts";
import {
  postgresDrizzle,
  type PostgresQueryClient,
  privacyRequestFromRow,
  type PrivacyRequestRow,
  toDate,
} from "./internal.ts";

const accounts = pgSchema("accounts_v1");

const privacyRequests = accounts.table("privacy_requests", {
  requestId: text("request_id").primaryKey(),
  subject: text("subject").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  retentionRecordId: text("retention_record_id").notNull(),
  policyRef: text("policy_ref").notNull(),
  requestSummary: text("request_summary"),
  exportRef: text("export_ref"),
  completedAt: timestamp("completed_at", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
});

const privacySchema = {
  privacyRequests,
};

export async function savePrivacyRequest(
  client: PostgresQueryClient,
  record: PrivacyRequestRecord,
): Promise<void> {
  const existing = await findPrivacyRequest(client, record.requestId);
  if (existing && existing.subject !== record.subject) {
    throw new TypeError(
      "privacy request id is already owned by another subject",
    );
  }
  const values = privacyRequestValues(record);
  await postgresDrizzle(client, privacySchema)
    .insert(privacyRequests)
    .values(values)
    .onConflictDoUpdate({
      target: privacyRequests.requestId,
      set: {
        kind: values.kind,
        status: values.status,
        retentionRecordId: values.retentionRecordId,
        policyRef: values.policyRef,
        requestSummary: values.requestSummary,
        exportRef: values.exportRef,
        completedAt: values.completedAt,
        updatedAt: values.updatedAt,
      },
    });
}

export async function findPrivacyRequest(
  client: PostgresQueryClient,
  requestId: string,
): Promise<PrivacyRequestRecord | undefined> {
  const row = await postgresDrizzle(client, privacySchema)
    .select(privacyRequestColumns)
    .from(privacyRequests)
    .where(eq(privacyRequests.requestId, requestId))
    .limit(1)
    .then((rows) => rows[0] as PrivacyRequestRow | undefined);
  return row ? privacyRequestFromRow(row) : undefined;
}

export async function listPrivacyRequestsForSubject(
  client: PostgresQueryClient,
  subject: TakosumiSubject,
): Promise<readonly PrivacyRequestRecord[]> {
  const rows = (await postgresDrizzle(client, privacySchema)
    .select(privacyRequestColumns)
    .from(privacyRequests)
    .where(eq(privacyRequests.subject, subject))
    .orderBy(
      asc(privacyRequests.createdAt),
      asc(privacyRequests.requestId),
    )) as PrivacyRequestRow[];
  return rows.map(privacyRequestFromRow).sort(privacyRequestOrder);
}

const privacyRequestColumns = {
  request_id: privacyRequests.requestId,
  subject: privacyRequests.subject,
  kind: privacyRequests.kind,
  status: privacyRequests.status,
  retention_record_id: privacyRequests.retentionRecordId,
  policy_ref: privacyRequests.policyRef,
  request_summary: privacyRequests.requestSummary,
  export_ref: privacyRequests.exportRef,
  completed_at: privacyRequests.completedAt,
  created_at: privacyRequests.createdAt,
  updated_at: privacyRequests.updatedAt,
};

function privacyRequestValues(record: PrivacyRequestRecord) {
  return {
    requestId: record.requestId,
    subject: record.subject,
    kind: record.kind,
    status: record.status,
    retentionRecordId: record.retentionRecordId,
    policyRef: record.policyRef,
    requestSummary: record.requestSummary ?? null,
    exportRef: record.exportRef ?? null,
    completedAt:
      record.completedAt === undefined ? null : toDate(record.completedAt),
    createdAt: toDate(record.createdAt),
    updatedAt: toDate(record.updatedAt),
  };
}

function privacyRequestOrder(
  a: PrivacyRequestRecord,
  b: PrivacyRequestRecord,
): number {
  return b.createdAt - a.createdAt || a.requestId.localeCompare(b.requestId);
}
