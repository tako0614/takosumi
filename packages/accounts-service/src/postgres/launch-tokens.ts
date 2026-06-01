// Launch tokens (single-use installation launch credentials) and the
// associated consumption ledger. Behaviour-preserving free-function module.

import type {
  LaunchTokenConsumeResult,
  LaunchTokenConsumptionRecord,
  LaunchTokenPruneResult,
  LaunchTokenRecord,
} from "../store.ts";
import {
  launchTokenFromRow,
  type LaunchTokenRow,
  launchTokenSelect,
  type PostgresQueryClient,
  runFirst,
  runQuery,
  toDate,
} from "./internal.ts";

export async function consumeLaunchTokenJti(
  client: PostgresQueryClient,
  record: LaunchTokenConsumptionRecord,
): Promise<boolean> {
  const result = await runQuery<{ jti: string }>(
    client,
    `INSERT INTO installation_v1.launch_token_consumptions (
        jti, installation_id, subject, audience, expires_at, consumed_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (jti) DO NOTHING
      RETURNING jti`,
    [
      record.jti,
      record.installationId,
      record.subject,
      record.audience,
      toDate(record.expiresAt),
      toDate(record.consumedAt),
    ],
  );
  return result.rows.length > 0;
}

export async function saveLaunchToken(
  client: PostgresQueryClient,
  record: LaunchTokenRecord,
): Promise<void> {
  await runQuery(
    client,
    `UPDATE installation_v1.launch_tokens
       SET used_at = $2
       WHERE installation_id = $1
         AND used_at IS NULL
         AND expires_at > $2`,
    [record.installationId, toDate(record.createdAt)],
  );
  await runQuery(
    client,
    `INSERT INTO installation_v1.launch_tokens (
        token_hash, jti, installation_id, account_id, space_id, app_id, subject,
        redirect_uri, scopes, expires_at, created_at, used_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (token_hash) DO UPDATE SET
        jti = EXCLUDED.jti,
        installation_id = EXCLUDED.installation_id,
        account_id = EXCLUDED.account_id,
        space_id = EXCLUDED.space_id,
        app_id = EXCLUDED.app_id,
        subject = EXCLUDED.subject,
        redirect_uri = EXCLUDED.redirect_uri,
        scopes = EXCLUDED.scopes,
        expires_at = EXCLUDED.expires_at,
        created_at = EXCLUDED.created_at,
        used_at = EXCLUDED.used_at`,
    [
      record.tokenHash,
      record.jti,
      record.installationId,
      record.accountId,
      record.spaceId,
      record.appId,
      record.subject,
      record.redirectUri,
      [...record.scope],
      toDate(record.expiresAt),
      toDate(record.createdAt),
      record.usedAt === undefined ? null : toDate(record.usedAt),
    ],
  );
}

export async function consumeLaunchToken(
  client: PostgresQueryClient,
  input: {
    tokenHash: string;
    installationId: string;
    redirectUri: string;
    consumedAt: number;
  },
): Promise<LaunchTokenConsumeResult> {
  const row = await runFirst<LaunchTokenRow>(
    client,
    launchTokenSelect("token_hash = $1 AND installation_id = $2"),
    [input.tokenHash, input.installationId],
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
  const result = await runQuery<{ token_hash: string }>(
    client,
    `UPDATE installation_v1.launch_tokens
       SET used_at = $3
       WHERE token_hash = $1
         AND installation_id = $2
         AND used_at IS NULL
       RETURNING token_hash`,
    [input.tokenHash, input.installationId, toDate(input.consumedAt)],
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
  const result = await runQuery<{
    deleted: number | string;
    expired: number | string;
    used: number | string;
  }>(
    client,
    `WITH deleted AS (
         DELETE FROM installation_v1.launch_tokens
         WHERE expires_at <= $1
            OR (used_at IS NOT NULL AND used_at <= $2)
         RETURNING CASE
           WHEN used_at IS NOT NULL AND used_at <= $2 THEN 'used'
           ELSE 'expired'
         END AS reason
       )
       SELECT
         count(*)::int AS deleted,
         count(*) FILTER (WHERE reason = 'expired')::int AS expired,
         count(*) FILTER (WHERE reason = 'used')::int AS used
       FROM deleted`,
    [toDate(input.expiredBefore), toDate(input.usedBefore)],
  );
  const row = result.rows[0] ?? { deleted: 0, expired: 0, used: 0 };
  return {
    deleted: Number(row.deleted),
    expired: Number(row.expired),
    used: Number(row.used),
  };
}
