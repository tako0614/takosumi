// Passkey (WebAuthn) credential storage. Free-function module that
// preserves the upsert and per-subject ordering of the original
// PostgresAccountsStore.

import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { bigint, jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import type { PasskeyCredentialRecord } from "../store.ts";
import {
  millis,
  passkeyCredentialFromRow,
  type PasskeyCredentialRow,
  type PostgresQueryClient,
  runQuery,
  type TimeValue,
  toDate,
} from "./internal.ts";

type DrizzleQuery = {
  toSQL(): { readonly sql: string; readonly params: readonly unknown[] };
};

const accountsV1 = pgSchema("accounts_v1");

const passkeyCredentials = accountsV1.table("passkey_credentials", {
  credentialId: text("credential_id").primaryKey(),
  subject: text("subject").notNull().$type<TakosumiSubject>(),
  publicKeyJwk: jsonb("public_key_jwk")
    .$type<Record<string, unknown>>()
    .notNull(),
  signCount: bigint("sign_count", { mode: "number" }).notNull(),
  transports: text("transports").array().notNull(),
  createdAt: timestamp("created_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
  updatedAt: timestamp("updated_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
});

const passkeyChallenges = accountsV1.table("passkey_challenges", {
  challengeKey: text("challenge_key").primaryKey(),
  challenge: text("challenge").notNull(),
  expiresAt: timestamp("expires_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
});

const db = drizzle(async () => ({ rows: [] }), {
  schema: { passkeyCredentials, passkeyChallenges },
});

async function runDrizzle<T = Record<string, unknown>>(
  client: PostgresQueryClient,
  query: DrizzleQuery,
) {
  const built = query.toSQL();
  return await runQuery<T>(client, built.sql, built.params);
}

async function rowsDrizzle<T>(
  client: PostgresQueryClient,
  query: DrizzleQuery,
) {
  return (await runDrizzle<T>(client, query)).rows;
}

async function firstDrizzle<T>(
  client: PostgresQueryClient,
  query: DrizzleQuery,
) {
  return (await rowsDrizzle<T>(client, query))[0];
}

export async function savePasskeyCredential(
  client: PostgresQueryClient,
  record: PasskeyCredentialRecord,
): Promise<void> {
  await runDrizzle(
    client,
    db
      .insert(passkeyCredentials)
      .values({
        credentialId: record.credentialId,
        subject: record.subject,
        publicKeyJwk: record.publicKeyJwk as Record<string, unknown>,
        signCount: record.signCount,
        transports: [...(record.transports ?? [])],
        createdAt: toDate(record.createdAt),
        updatedAt: toDate(record.updatedAt),
      })
      .onConflictDoUpdate({
        target: passkeyCredentials.credentialId,
        set: {
          subject: sql`excluded.subject`,
          publicKeyJwk: sql`excluded.public_key_jwk`,
          signCount: sql`excluded.sign_count`,
          transports: sql`excluded.transports`,
          updatedAt: sql`excluded.updated_at`,
        },
      }),
  );
}

export async function findPasskeyCredential(
  client: PostgresQueryClient,
  credentialId: string,
): Promise<PasskeyCredentialRecord | undefined> {
  const row = await firstDrizzle<PasskeyCredentialRow>(
    client,
    db
      .select({
        credential_id: passkeyCredentials.credentialId,
        subject: passkeyCredentials.subject,
        public_key_jwk: passkeyCredentials.publicKeyJwk,
        sign_count: passkeyCredentials.signCount,
        transports: passkeyCredentials.transports,
        created_at: passkeyCredentials.createdAt,
        updated_at: passkeyCredentials.updatedAt,
      })
      .from(passkeyCredentials)
      .where(eq(passkeyCredentials.credentialId, credentialId)),
  );
  return row ? passkeyCredentialFromRow(row) : undefined;
}

export async function listPasskeyCredentialsForSubject(
  client: PostgresQueryClient,
  subject: TakosumiSubject,
): Promise<readonly PasskeyCredentialRecord[]> {
  const rows = await rowsDrizzle<PasskeyCredentialRow>(
    client,
    db
      .select({
        credential_id: passkeyCredentials.credentialId,
        subject: passkeyCredentials.subject,
        public_key_jwk: passkeyCredentials.publicKeyJwk,
        sign_count: passkeyCredentials.signCount,
        transports: passkeyCredentials.transports,
        created_at: passkeyCredentials.createdAt,
        updated_at: passkeyCredentials.updatedAt,
      })
      .from(passkeyCredentials)
      .where(eq(passkeyCredentials.subject, subject))
      .orderBy(
        asc(passkeyCredentials.createdAt),
        asc(passkeyCredentials.credentialId),
      ),
  );
  return rows.map(passkeyCredentialFromRow);
}

export async function savePasskeyChallenge(
  client: PostgresQueryClient,
  key: string,
  challenge: string,
  expiresAt: number,
): Promise<void> {
  await runDrizzle(
    client,
    db
      .insert(passkeyChallenges)
      .values({ challengeKey: key, challenge, expiresAt: toDate(expiresAt) })
      .onConflictDoUpdate({
        target: passkeyChallenges.challengeKey,
        set: {
          challenge: sql`excluded.challenge`,
          expiresAt: sql`excluded.expires_at`,
        },
      }),
  );
}

export async function consumePasskeyChallenge(
  client: PostgresQueryClient,
  key: string,
  now: number,
): Promise<string | undefined> {
  // Single-shot delete-on-read: the DELETE ... RETURNING is atomic, so two
  // concurrent /complete requests (possibly on different replicas) cannot
  // both consume the same challenge — only the statement that removed the row
  // gets it back. An expired row is also deleted (and reported as absent).
  const row = await firstDrizzle<{ challenge: string; expires_at: TimeValue }>(
    client,
    db
      .delete(passkeyChallenges)
      .where(eq(passkeyChallenges.challengeKey, key))
      .returning({
        challenge: passkeyChallenges.challenge,
        expires_at: passkeyChallenges.expiresAt,
      }),
  );
  if (row === undefined) return undefined;
  if (millis(row.expires_at) <= now) return undefined;
  return row.challenge;
}
