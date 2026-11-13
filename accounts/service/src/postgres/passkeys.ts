// Passkey (WebAuthn) credential storage. Free-function module that
// preserves the upsert and per-subject ordering of the original
// PostgresAccountsStore.

import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { bigint, jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import type { PasskeyCredentialRecord } from "../store.ts";
import {
  passkeyChallengeAdmissionPolicy,
  passkeyChallengeSweepLimit,
  passkeyChallengeWindowStart,
  type PasskeyChallengeAdmissionInput,
  type PasskeyChallengeSweepInput,
  type PasskeyChallengeSweepResult,
} from "../passkey-challenge-policy.ts";
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

/** The permanent private row fences old windows before any quota GC/save. */
function windowBarrier(parameter: number): string {
  return `observed_window AS (
    INSERT INTO accounts_v1.passkey_challenges(challenge_key, challenge, expires_at)
    VALUES ('passkey:window:v1', $${parameter}::text, 'infinity')
    ON CONFLICT(challenge_key) DO UPDATE SET challenge = excluded.challenge
      WHERE CASE WHEN accounts_v1.passkey_challenges.challenge ~ '^[0-9]{1,16}$'
        THEN accounts_v1.passkey_challenges.challenge::bigint <= $${parameter}::bigint
        ELSE false END
    RETURNING challenge_key
  )`;
}

export async function admitPasskeyChallenge(
  client: PostgresQueryClient,
  input: PasskeyChallengeAdmissionInput,
): Promise<boolean> {
  const policy = passkeyChallengeAdmissionPolicy(input);
  // The quota's unique row serializes increments across pooled connections.
  // The dependent INSERT and quota increment are one atomic statement; a
  // failed challenge insert cannot spend quota without saving the challenge.
  const result = await runQuery(client, `
    WITH ${windowBarrier(8)}, expired AS (
      DELETE FROM accounts_v1.passkey_challenges WHERE challenge_key IN (
        SELECT challenge_key FROM accounts_v1.passkey_challenges
        WHERE EXISTS (SELECT 1 FROM observed_window) AND expires_at <= $7
        ORDER BY expires_at, challenge_key
        LIMIT 64 FOR UPDATE SKIP LOCKED
      ) AND expires_at <= $7 RETURNING challenge_key
    ), admitted AS (
      INSERT INTO accounts_v1.passkey_challenges
        (challenge_key, challenge, expires_at)
      SELECT $1, '1', $2 FROM observed_window, (SELECT COUNT(*) FROM expired) AS sweep
      ON CONFLICT (challenge_key) DO UPDATE
        SET challenge = (accounts_v1.passkey_challenges.challenge::integer + 1)::text
        WHERE accounts_v1.passkey_challenges.expires_at = $2
          AND CASE
            WHEN accounts_v1.passkey_challenges.challenge ~ '^[0-9]{1,3}$'
            THEN accounts_v1.passkey_challenges.challenge::integer >= 1
              AND accounts_v1.passkey_challenges.challenge::integer < $3
            ELSE false
          END
      RETURNING challenge_key
    )
    INSERT INTO accounts_v1.passkey_challenges
      (challenge_key, challenge, expires_at)
    SELECT $4, $5, $6 FROM admitted
    RETURNING challenge_key
  `, [policy.key, toDate(policy.expiresAt), policy.limit,
    input.key, input.challenge, toDate(input.expiresAt), toDate(input.now), String(policy.windowStart)]);
  if (result.rows.length > 1) throw new Error("invalid passkey admission result");
  return result.rows.length === 1;
}

export async function prunePasskeyChallenges(
  client: PostgresQueryClient,
  input: PasskeyChallengeSweepInput,
): Promise<PasskeyChallengeSweepResult> {
  const limit = passkeyChallengeSweepLimit(input);
  const result = await runQuery<{ scanned: number; deleted: number }>(client, `
    WITH ${windowBarrier(3)}, candidates AS MATERIALIZED (
      SELECT challenge_key FROM accounts_v1.passkey_challenges
      WHERE EXISTS (SELECT 1 FROM observed_window) AND expires_at <= $1
      ORDER BY expires_at, challenge_key LIMIT $2
    ), removed AS (
      DELETE FROM accounts_v1.passkey_challenges
      WHERE challenge_key IN (SELECT challenge_key FROM candidates)
        AND expires_at <= $1 RETURNING challenge_key
    )
    SELECT (SELECT COUNT(*)::integer FROM candidates) AS scanned,
      (SELECT COUNT(*)::integer FROM removed) AS deleted
  `, [toDate(input.now), limit, String(passkeyChallengeWindowStart(input.now))]);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row || !Number.isInteger(row.scanned) ||
    !Number.isInteger(row.deleted) || row.deleted < 0 || row.deleted > row.scanned ||
    row.scanned > limit) throw new Error("invalid passkey sweep result");
  return { scanned: row.scanned, deleted: row.deleted };
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
  const expiry = millis(row.expires_at);
  if (!Number.isFinite(expiry) || !Number.isFinite(now) || expiry <= now) return undefined;
  return row.challenge;
}
