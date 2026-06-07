// Account session lifecycle (login session records). Free-function module
// preserving the upsert + delete semantics of the original
// PostgresAccountsStore.
//
// SECURITY (Agent 6 item 9): the `session_id` column is persisted as the
// SHA-256 hash (with a per-deployment salt) of the raw session_id. The raw
// session_id only exists in the HttpOnly cookie / Authorization header
// presented by the client and is hashed on every read/write. This means a
// read-only leak of the Postgres rows cannot be replayed against the API.
//
// MIGRATION NOTE FOR OPERATORS:
//   Existing deployments with un-hashed `account_sessions.session_id` rows
//   must run a one-time migration before upgrading:
//
//     UPDATE accounts_v1.account_sessions
//        SET session_id = 'sha256:' || encode(
//          digest(<deployment_salt> || ':' || session_id, 'sha256'), 'hex')
//      WHERE session_id NOT LIKE 'sha256:%';
//
//   Or simpler: truncate the table and force users to re-sign-in. The
//   hashed column has no semantic change beyond opacity — callers still
//   address sessions by the raw session_id, this module just hashes
//   before persisting / looking up.

import type { AccountSessionRecord } from "../store.ts";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";
// hashSessionId is the single shared session-at-rest hasher (salt + SHA-256
// -> `sha256:<base64url>`) used by both the Postgres and D1 stores so they
// provably hash identically. Re-exported here because callers import it from
// this module.
import { hashSessionId } from "../session-hash-salt.ts";
import {
  accountSessionFromRow,
  type AccountSessionRow,
  type PostgresQueryClient,
  runQuery,
  toDate,
} from "./internal.ts";

export { hashSessionId };

type DrizzleQuery = {
  toSQL(): { readonly sql: string; readonly params: readonly unknown[] };
};

const accountsV1 = pgSchema("accounts_v1");

const accountSessions = accountsV1.table("account_sessions", {
  sessionId: text("session_id").primaryKey(),
  subject: text("subject").notNull(),
  createdAt: timestamp("created_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
  expiresAt: timestamp("expires_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
});

const db = drizzle(async () => ({ rows: [] }), {
  schema: { accountSessions },
});

async function runDrizzle<T = Record<string, unknown>>(
  client: PostgresQueryClient,
  query: DrizzleQuery,
) {
  const built = query.toSQL();
  return await runQuery<T>(client, built.sql, built.params);
}

async function firstDrizzle<T>(
  client: PostgresQueryClient,
  query: DrizzleQuery,
) {
  return (await runDrizzle<T>(client, query)).rows[0];
}

export async function saveAccountSession(
  client: PostgresQueryClient,
  record: AccountSessionRecord,
): Promise<void> {
  const sessionHash = await hashSessionId(record.sessionId);
  await runDrizzle(
    client,
    db
      .insert(accountSessions)
      .values({
        sessionId: sessionHash,
        subject: record.subject,
        createdAt: toDate(record.createdAt),
        expiresAt: toDate(record.expiresAt),
      })
      .onConflictDoUpdate({
        target: accountSessions.sessionId,
        set: {
          subject: sql`excluded.subject`,
          expiresAt: sql`excluded.expires_at`,
        },
      }),
  );
}

export async function findAccountSession(
  client: PostgresQueryClient,
  sessionId: string,
): Promise<AccountSessionRecord | undefined> {
  const sessionHash = await hashSessionId(sessionId);
  const row = await firstDrizzle<AccountSessionRow>(
    client,
    db
      .select({
        session_id: accountSessions.sessionId,
        subject: accountSessions.subject,
        created_at: accountSessions.createdAt,
        expires_at: accountSessions.expiresAt,
      })
      .from(accountSessions)
      .where(eq(accountSessions.sessionId, sessionHash)),
  );
  if (!row) return undefined;
  // The row's session_id column holds the hash; the caller addressed us
  // by the raw session_id, so re-attach it on the returned record so
  // logging / debugging keeps the raw value identity-preserving.
  const decoded = accountSessionFromRow(row);
  return { ...decoded, sessionId };
}

export async function deleteAccountSession(
  client: PostgresQueryClient,
  sessionId: string,
): Promise<void> {
  const sessionHash = await hashSessionId(sessionId);
  await runDrizzle(
    client,
    db
      .delete(accountSessions)
      .where(eq(accountSessions.sessionId, sessionHash)),
  );
}
