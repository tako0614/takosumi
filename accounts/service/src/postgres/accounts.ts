// Takosumi accounts and upstream identity links. Free-function module
// preserving the SQL upserts from the original PostgresAccountsStore.

import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { boolean, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import type {
  TakosumiAccountRecord,
  UpstreamIdentityRecord,
} from "../store.ts";
import {
  accountFromRow,
  type AccountRow,
  type PostgresQueryClient,
  runQuery,
  toDate,
  upstreamIdentityFromRow,
  type UpstreamIdentityRow,
} from "./internal.ts";

type DrizzleQuery = {
  toSQL(): { readonly sql: string; readonly params: readonly unknown[] };
};

const accountsV1 = pgSchema("accounts_v1");

const accounts = accountsV1.table("accounts", {
  subject: text("subject").primaryKey().$type<TakosumiSubject>(),
  email: text("email"),
  emailVerified: boolean("email_verified"),
  displayName: text("display_name"),
  termsVersion: text("terms_version"),
  termsAcceptedAt: timestamp("terms_accepted_at", {
    mode: "date",
    withTimezone: true,
  }),
  termsAcceptedSource: text("terms_accepted_source"),
  createdAt: timestamp("created_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
  updatedAt: timestamp("updated_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
});

const upstreamIdentities = accountsV1.table("upstream_identities", {
  providerId: text("provider_id").notNull(),
  upstreamIssuer: text("upstream_issuer").notNull(),
  upstreamSubject: text("upstream_subject").notNull(),
  subject: text("subject").notNull().$type<TakosumiSubject>(),
  createdAt: timestamp("created_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
  updatedAt: timestamp("updated_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
});

const db = drizzle(async () => ({ rows: [] }), {
  schema: { accounts, upstreamIdentities },
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

export async function saveAccount(
  client: PostgresQueryClient,
  record: TakosumiAccountRecord,
): Promise<void> {
  await runDrizzle(
    client,
    db
      .insert(accounts)
      .values({
        subject: record.subject,
        email: record.email ?? null,
        // Tri-state: persist NULL when genuinely unknown so a re-read returns
        // `undefined`, never a coerced `false`. The COALESCE on update keeps a
        // previously-asserted value when a later save omits the claim.
        emailVerified: record.emailVerified ?? null,
        displayName: record.displayName ?? null,
        termsVersion: record.termsVersion ?? null,
        termsAcceptedAt: record.termsAcceptedAt
          ? toDate(record.termsAcceptedAt)
          : null,
        termsAcceptedSource: record.termsAcceptedSource ?? null,
        createdAt: toDate(record.createdAt),
        updatedAt: toDate(record.updatedAt),
      })
      .onConflictDoUpdate({
        target: accounts.subject,
        set: {
          email: sql`excluded.email`,
          emailVerified: sql`coalesce(excluded.email_verified, ${accounts.emailVerified})`,
          displayName: sql`excluded.display_name`,
          termsVersion: sql`coalesce(excluded.terms_version, ${accounts.termsVersion})`,
          termsAcceptedAt: sql`coalesce(excluded.terms_accepted_at, ${accounts.termsAcceptedAt})`,
          termsAcceptedSource: sql`coalesce(excluded.terms_accepted_source, ${accounts.termsAcceptedSource})`,
          updatedAt: sql`excluded.updated_at`,
        },
      }),
  );
}

export async function findAccount(
  client: PostgresQueryClient,
  subject: TakosumiSubject,
): Promise<TakosumiAccountRecord | undefined> {
  const row = await firstDrizzle<AccountRow>(
    client,
    db
      .select({
        subject: accounts.subject,
        email: accounts.email,
        email_verified: accounts.emailVerified,
        display_name: accounts.displayName,
        terms_version: accounts.termsVersion,
        terms_accepted_at: accounts.termsAcceptedAt,
        terms_accepted_source: accounts.termsAcceptedSource,
        created_at: accounts.createdAt,
        updated_at: accounts.updatedAt,
      })
      .from(accounts)
      .where(eq(accounts.subject, subject)),
  );
  return row ? accountFromRow(row) : undefined;
}

export async function findAccountByVerifiedEmail(
  client: PostgresQueryClient,
  email: string,
): Promise<TakosumiAccountRecord | undefined> {
  const normalized = normalizeAccountEmail(email);
  if (!normalized) return undefined;
  const row = await firstDrizzle<AccountRow>(
    client,
    db
      .select({
        subject: accounts.subject,
        email: accounts.email,
        email_verified: accounts.emailVerified,
        display_name: accounts.displayName,
        terms_version: accounts.termsVersion,
        terms_accepted_at: accounts.termsAcceptedAt,
        terms_accepted_source: accounts.termsAcceptedSource,
        created_at: accounts.createdAt,
        updated_at: accounts.updatedAt,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.emailVerified, true),
          sql`lower(${accounts.email}) = ${normalized}`,
        ),
      ),
  );
  return row ? accountFromRow(row) : undefined;
}

export async function linkUpstreamIdentity(
  client: PostgresQueryClient,
  record: UpstreamIdentityRecord,
): Promise<void> {
  await runDrizzle(
    client,
    db
      .insert(upstreamIdentities)
      .values({
        providerId: record.providerId,
        upstreamIssuer: record.upstreamIssuer,
        upstreamSubject: record.upstreamSubject,
        subject: record.subject,
        createdAt: toDate(record.createdAt),
        updatedAt: toDate(record.updatedAt),
      })
      .onConflictDoUpdate({
        target: [
          upstreamIdentities.providerId,
          upstreamIdentities.upstreamIssuer,
          upstreamIdentities.upstreamSubject,
        ],
        set: {
          subject: sql`excluded.subject`,
          updatedAt: sql`excluded.updated_at`,
        },
      }),
  );
}

export async function findUpstreamIdentity(
  client: PostgresQueryClient,
  input: {
    providerId: string;
    upstreamIssuer: string;
    upstreamSubject: string;
  },
): Promise<UpstreamIdentityRecord | undefined> {
  const row = await firstDrizzle<UpstreamIdentityRow>(
    client,
    db
      .select({
        provider_id: upstreamIdentities.providerId,
        upstream_issuer: upstreamIdentities.upstreamIssuer,
        upstream_subject: upstreamIdentities.upstreamSubject,
        subject: upstreamIdentities.subject,
        created_at: upstreamIdentities.createdAt,
        updated_at: upstreamIdentities.updatedAt,
      })
      .from(upstreamIdentities)
      .where(
        and(
          eq(upstreamIdentities.providerId, input.providerId),
          eq(upstreamIdentities.upstreamIssuer, input.upstreamIssuer),
          eq(upstreamIdentities.upstreamSubject, input.upstreamSubject),
        ),
      ),
  );
  return row ? upstreamIdentityFromRow(row) : undefined;
}

function normalizeAccountEmail(email: string | undefined): string | undefined {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}
