// Passkey (WebAuthn) credential storage. Free-function module that
// preserves the upsert and per-subject ordering of the original
// PostgresAccountsStore.

import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { PasskeyCredentialRecord } from "../store.ts";
import {
  json,
  millis,
  passkeyCredentialFromRow,
  type PasskeyCredentialRow,
  type PostgresQueryClient,
  runFirst,
  runQuery,
  runRows,
  type TimeValue,
  toDate,
} from "./internal.ts";

export async function savePasskeyCredential(
  client: PostgresQueryClient,
  record: PasskeyCredentialRecord,
): Promise<void> {
  await runQuery(
    client,
    `INSERT INTO accounts_v1.passkey_credentials (
        credential_id, subject, public_key_jwk, sign_count, transports, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (credential_id) DO UPDATE SET
        subject = EXCLUDED.subject,
        public_key_jwk = EXCLUDED.public_key_jwk,
        sign_count = EXCLUDED.sign_count,
        transports = EXCLUDED.transports,
        updated_at = EXCLUDED.updated_at`,
    [
      record.credentialId,
      record.subject,
      json(record.publicKeyJwk),
      record.signCount,
      [...(record.transports ?? [])],
      toDate(record.createdAt),
      toDate(record.updatedAt),
    ],
  );
}

export async function findPasskeyCredential(
  client: PostgresQueryClient,
  credentialId: string,
): Promise<PasskeyCredentialRecord | undefined> {
  const row = await runFirst<PasskeyCredentialRow>(
    client,
    `SELECT credential_id, subject, public_key_jwk, sign_count, transports, created_at, updated_at
       FROM accounts_v1.passkey_credentials
       WHERE credential_id = $1`,
    [credentialId],
  );
  return row ? passkeyCredentialFromRow(row) : undefined;
}

export async function listPasskeyCredentialsForSubject(
  client: PostgresQueryClient,
  subject: TakosumiSubject,
): Promise<readonly PasskeyCredentialRecord[]> {
  const rows = await runRows<PasskeyCredentialRow>(
    client,
    `SELECT credential_id, subject, public_key_jwk, sign_count, transports, created_at, updated_at
       FROM accounts_v1.passkey_credentials
       WHERE subject = $1
       ORDER BY created_at, credential_id`,
    [subject],
  );
  return rows.map(passkeyCredentialFromRow);
}

export async function savePasskeyChallenge(
  client: PostgresQueryClient,
  key: string,
  challenge: string,
  expiresAt: number,
): Promise<void> {
  await runQuery(
    client,
    `INSERT INTO accounts_v1.passkey_challenges (challenge_key, challenge, expires_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (challenge_key) DO UPDATE SET
          challenge = EXCLUDED.challenge,
          expires_at = EXCLUDED.expires_at`,
    [key, challenge, toDate(expiresAt)],
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
  const row = await runFirst<{ challenge: string; expires_at: TimeValue }>(
    client,
    `DELETE FROM accounts_v1.passkey_challenges
       WHERE challenge_key = $1
       RETURNING challenge, expires_at`,
    [key],
  );
  if (row === undefined) return undefined;
  if (millis(row.expires_at) <= now) return undefined;
  return row.challenge;
}
