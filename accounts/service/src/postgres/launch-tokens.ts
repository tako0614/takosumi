// Launch tokens (single-use installation launch credentials) and the
// associated consumption ledger. Behaviour-preserving free-function module.

import { and, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import type {
  LaunchTokenConsumeResult,
  LaunchTokenConsumptionRecord,
  LaunchTokenPruneResult,
  LaunchTokenRecord,
} from "../store.ts";
import {
  launchTokenFromRow,
  type LaunchTokenRow,
  type PostgresQueryClient,
  runQuery,
  toDate,
} from "./internal.ts";

type DrizzleQuery = {
  toSQL(): { readonly sql: string; readonly params: readonly unknown[] };
};

const installationV1 = pgSchema("installation_v1");

const launchTokenConsumptions = installationV1.table(
  "launch_token_consumptions",
  {
    jti: text("jti").primaryKey(),
    capsuleId: text("installation_id").notNull(),
    subject: text("subject").notNull(),
    audience: text("audience").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }).notNull(),
  },
);

const launchTokens = installationV1.table("launch_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  jti: text("jti").notNull(),
  capsuleId: text("installation_id").notNull(),
  accountId: text("account_id").notNull(),
  workspaceId: text("space_id").notNull(),
  appId: text("app_id").notNull(),
  subject: text("subject").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  scopes: text("scopes").array().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

const db = drizzle(async () => ({ rows: [] }), {
  schema: { launchTokenConsumptions, launchTokens },
});

async function runDrizzle<T = Record<string, unknown>>(
  client: PostgresQueryClient,
  query: DrizzleQuery,
) {
  const built = query.toSQL();
  return await runQuery<T>(client, built.sql, built.params);
}

async function runDrizzleRows<T>(
  client: PostgresQueryClient,
  query: DrizzleQuery,
): Promise<T[]> {
  return (await runDrizzle<T>(client, query)).rows;
}

async function runDrizzleFirst<T>(
  client: PostgresQueryClient,
  query: DrizzleQuery,
): Promise<T | undefined> {
  return (await runDrizzleRows<T>(client, query))[0];
}

function launchTokenSelection() {
  return {
    token_hash: launchTokens.tokenHash,
    jti: launchTokens.jti,
    installation_id: launchTokens.capsuleId,
    account_id: launchTokens.accountId,
    space_id: launchTokens.workspaceId,
    app_id: launchTokens.appId,
    subject: launchTokens.subject,
    redirect_uri: launchTokens.redirectUri,
    scopes: launchTokens.scopes,
    expires_at: launchTokens.expiresAt,
    created_at: launchTokens.createdAt,
    used_at: launchTokens.usedAt,
  };
}

export async function consumeLaunchTokenJti(
  client: PostgresQueryClient,
  record: LaunchTokenConsumptionRecord,
): Promise<boolean> {
  const result = await runDrizzle<{ jti: string }>(
    client,
    db
      .insert(launchTokenConsumptions)
      .values({
        jti: record.jti,
        capsuleId: record.capsuleId,
        subject: record.subject,
        audience: record.audience,
        expiresAt: toDate(record.expiresAt),
        consumedAt: toDate(record.consumedAt),
      })
      .onConflictDoNothing({ target: launchTokenConsumptions.jti })
      .returning({ jti: launchTokenConsumptions.jti }),
  );
  return result.rows.length > 0;
}

export async function saveLaunchToken(
  client: PostgresQueryClient,
  record: LaunchTokenRecord,
): Promise<void> {
  await runDrizzle(
    client,
    db
      .update(launchTokens)
      .set({ usedAt: toDate(record.createdAt) })
      .where(
        and(
          eq(launchTokens.capsuleId, record.capsuleId),
          isNull(launchTokens.usedAt),
          gt(launchTokens.expiresAt, toDate(record.createdAt)),
        ),
      ),
  );
  const values = {
    tokenHash: record.tokenHash,
    jti: record.jti,
    capsuleId: record.capsuleId,
    accountId: record.accountId,
    workspaceId: record.workspaceId,
    appId: record.appId,
    subject: record.subject,
    redirectUri: record.redirectUri,
    scopes: [...record.scope],
    expiresAt: toDate(record.expiresAt),
    createdAt: toDate(record.createdAt),
    usedAt: record.usedAt === undefined ? null : toDate(record.usedAt),
  };
  await runDrizzle(
    client,
    db
      .insert(launchTokens)
      .values(values)
      .onConflictDoUpdate({
        target: launchTokens.tokenHash,
        set: {
          jti: values.jti,
          capsuleId: values.capsuleId,
          accountId: values.accountId,
          workspaceId: values.workspaceId,
          appId: values.appId,
          subject: values.subject,
          redirectUri: values.redirectUri,
          scopes: values.scopes,
          expiresAt: values.expiresAt,
          createdAt: values.createdAt,
          usedAt: values.usedAt,
        },
      }),
  );
}

export async function consumeLaunchToken(
  client: PostgresQueryClient,
  input: {
    tokenHash: string;
    capsuleId: string;
    redirectUri: string;
    consumedAt: number;
  },
): Promise<LaunchTokenConsumeResult> {
  const row = await runDrizzleFirst<LaunchTokenRow>(
    client,
    db
      .select(launchTokenSelection())
      .from(launchTokens)
      .where(
        and(
          eq(launchTokens.tokenHash, input.tokenHash),
          eq(launchTokens.capsuleId, input.capsuleId),
        ),
      ),
  );
  if (!row) return { ok: false, reason: "not_found" };
  const record = launchTokenFromRow(row);
  if (record.redirectUri !== input.redirectUri) {
    return { ok: false, reason: "redirect_mismatch" };
  }
  if (record.expiresAt <= input.consumedAt) {
    return { ok: false, reason: "expired" };
  }
  if (record.usedAt !== undefined) {
    return { ok: false, reason: "used" };
  }
  const result = await runDrizzle<{ token_hash: string }>(
    client,
    db
      .update(launchTokens)
      .set({ usedAt: toDate(input.consumedAt) })
      .where(
        and(
          eq(launchTokens.tokenHash, input.tokenHash),
          eq(launchTokens.capsuleId, input.capsuleId),
          isNull(launchTokens.usedAt),
        ),
      )
      .returning({ token_hash: launchTokens.tokenHash }),
  );
  if (result.rows.length === 0) return { ok: false, reason: "used" };
  return {
    ok: true,
    record: { ...record, usedAt: input.consumedAt },
  };
}

export async function pruneLaunchTokens(
  client: PostgresQueryClient,
  input: {
    expiredBefore: number;
    usedBefore: number;
  },
): Promise<LaunchTokenPruneResult> {
  const expiredBefore = toDate(input.expiredBefore);
  const usedBefore = toDate(input.usedBefore);
  const rows = await runDrizzleRows<{ reason: "expired" | "used" }>(
    client,
    db
      .delete(launchTokens)
      .where(
        or(
          lte(launchTokens.expiresAt, expiredBefore),
          and(
            isNotNull(launchTokens.usedAt),
            lte(launchTokens.usedAt, usedBefore),
          ),
        ),
      )
      .returning({
        reason: sql<"expired" | "used">`
          CASE
            WHEN ${launchTokens.usedAt} IS NOT NULL
             AND ${launchTokens.usedAt} <= ${usedBefore} THEN 'used'
            ELSE 'expired'
          END
        `,
      }),
  );
  const used = rows.filter((row) => row.reason === "used").length;
  const expired = rows.length - used;
  return {
    deleted: rows.length,
    expired,
    used,
  };
}
