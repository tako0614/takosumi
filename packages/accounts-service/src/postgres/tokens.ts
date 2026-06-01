// OAuth access/refresh tokens, authorization codes, and personal access
// tokens. Free-function module: the canonical Postgres operations live here
// and `PostgresAccountsStore` delegates to them. Behaviour preserved verbatim.

import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type {
  AuthorizationCodeRecord,
  PersonalAccessTokenRecord,
  TokenRecord,
} from "../store.ts";
import {
  authorizationCodeFromRow,
  type AuthorizationCodeRow,
  hashSecret,
  personalAccessTokenFromRow,
  type PersonalAccessTokenRow,
  personalAccessTokenSelect,
  type PostgresQueryClient,
  runFirst,
  runQuery,
  runRows,
  toDate,
  tokenFromRow,
  type TokenRow,
} from "./internal.ts";

type OAuthTokenTable = "oauth_access_tokens" | "oauth_refresh_tokens";

export async function saveAuthorizationCode(
  client: PostgresQueryClient,
  code: string,
  record: AuthorizationCodeRecord,
): Promise<void> {
  await runQuery(
    client,
    `INSERT INTO accounts_v1.authorization_codes (
        code_hash, client_id, redirect_uri, scope, subject, takosumi_subject,
        installation_id, app_id, space_id, role, nonce, code_challenge,
        code_challenge_method, created_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (code_hash) DO UPDATE SET
        client_id = EXCLUDED.client_id,
        redirect_uri = EXCLUDED.redirect_uri,
        scope = EXCLUDED.scope,
        subject = EXCLUDED.subject,
       takosumi_subject = EXCLUDED.takosumi_subject,
        installation_id = EXCLUDED.installation_id,
        app_id = EXCLUDED.app_id,
        space_id = EXCLUDED.space_id,
        role = EXCLUDED.role,
        nonce = EXCLUDED.nonce,
        code_challenge = EXCLUDED.code_challenge,
        code_challenge_method = EXCLUDED.code_challenge_method,
        expires_at = EXCLUDED.expires_at`,
    [
      await hashSecret(code),
      record.clientId,
      record.redirectUri,
      record.scope,
      record.subject,
      record.takosumiSubject ?? null,
      record.installationId ?? null,
      record.appId ?? null,
      record.spaceId ?? null,
      record.role ?? null,
      record.nonce ?? null,
      record.codeChallenge ?? null,
      record.codeChallengeMethod ?? null,
      toDate(Date.now()),
      toDate(record.expiresAt),
    ],
  );
}

export async function consumeAuthorizationCode(
  client: PostgresQueryClient,
  code: string,
): Promise<AuthorizationCodeRecord | undefined> {
  const row = await runFirst<AuthorizationCodeRow>(
    client,
    `DELETE FROM accounts_v1.authorization_codes
       WHERE code_hash = $1
       RETURNING client_id, redirect_uri, scope, subject, takosumi_subject,
         installation_id, app_id, space_id, role, nonce, code_challenge,
         code_challenge_method, expires_at`,
    [await hashSecret(code)],
  );
  return row ? authorizationCodeFromRow(row) : undefined;
}

export async function saveOAuthToken(
  client: PostgresQueryClient,
  table: OAuthTokenTable,
  token: string,
  record: TokenRecord,
): Promise<void> {
  await runQuery(
    client,
    `INSERT INTO accounts_v1.${table} (
        token_hash, client_id, scope, subject, takosumi_subject, installation_id,
        app_id, space_id, role, created_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (token_hash) DO UPDATE SET
        client_id = EXCLUDED.client_id,
        scope = EXCLUDED.scope,
        subject = EXCLUDED.subject,
       takosumi_subject = EXCLUDED.takosumi_subject,
        installation_id = EXCLUDED.installation_id,
        app_id = EXCLUDED.app_id,
        space_id = EXCLUDED.space_id,
        role = EXCLUDED.role,
        expires_at = EXCLUDED.expires_at`,
    [
      await hashSecret(token),
      record.clientId,
      record.scope,
      record.subject,
      record.takosumiSubject ?? null,
      record.installationId ?? null,
      record.appId ?? null,
      record.spaceId ?? null,
      record.role ?? null,
      toDate(Date.now()),
      toDate(record.expiresAt),
    ],
  );
}

export async function findOAuthToken(
  client: PostgresQueryClient,
  table: OAuthTokenTable,
  token: string,
): Promise<TokenRecord | undefined> {
  const row = await runFirst<TokenRow>(
    client,
    `SELECT client_id, scope, subject, takosumi_subject, installation_id,
         app_id, space_id, role, expires_at
       FROM accounts_v1.${table}
       WHERE token_hash = $1`,
    [await hashSecret(token)],
  );
  return row ? tokenFromRow(row) : undefined;
}

export async function deleteOAuthToken(
  client: PostgresQueryClient,
  token: string,
): Promise<void> {
  const tokenHash = await hashSecret(token);
  await runQuery(
    client,
    `DELETE FROM accounts_v1.oauth_access_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  await runQuery(
    client,
    `DELETE FROM accounts_v1.oauth_refresh_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
}

export async function savePersonalAccessToken(
  client: PostgresQueryClient,
  token: string,
  record: PersonalAccessTokenRecord,
): Promise<void> {
  await runQuery(
    client,
    `INSERT INTO accounts_v1.personal_access_tokens (
        token_id, token_hash, token_prefix, subject, name, scopes, created_at,
        expires_at, revoked_at, last_used_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (token_id) DO UPDATE SET
        token_hash = EXCLUDED.token_hash,
        token_prefix = EXCLUDED.token_prefix,
        subject = EXCLUDED.subject,
        name = EXCLUDED.name,
        scopes = EXCLUDED.scopes,
        expires_at = EXCLUDED.expires_at,
        revoked_at = EXCLUDED.revoked_at,
        last_used_at = EXCLUDED.last_used_at`,
    [
      record.tokenId,
      await hashSecret(token),
      record.tokenPrefix,
      record.subject,
      record.name,
      [...record.scopes],
      toDate(record.createdAt),
      record.expiresAt === undefined ? null : toDate(record.expiresAt),
      record.revokedAt === undefined ? null : toDate(record.revokedAt),
      record.lastUsedAt === undefined ? null : toDate(record.lastUsedAt),
    ],
  );
}

export async function findPersonalAccessToken(
  client: PostgresQueryClient,
  token: string,
): Promise<PersonalAccessTokenRecord | undefined> {
  const row = await runFirst<PersonalAccessTokenRow>(
    client,
    personalAccessTokenSelect("token_hash = $1"),
    [await hashSecret(token)],
  );
  return row ? personalAccessTokenFromRow(row) : undefined;
}

export async function listPersonalAccessTokensForSubject(
  client: PostgresQueryClient,
  subject: TakosumiSubject,
): Promise<readonly PersonalAccessTokenRecord[]> {
  const rows = await runRows<PersonalAccessTokenRow>(
    client,
    `${
      personalAccessTokenSelect("subject = $1")
    } ORDER BY created_at, token_id`,
    [subject],
  );
  return rows.map(personalAccessTokenFromRow);
}

export async function revokePersonalAccessToken(
  client: PostgresQueryClient,
  input: {
    subject: TakosumiSubject;
    tokenId: string;
    revokedAt: number;
  },
): Promise<PersonalAccessTokenRecord | undefined> {
  const row = await runFirst<PersonalAccessTokenRow>(
    client,
    `UPDATE accounts_v1.personal_access_tokens
       SET revoked_at = $3
       WHERE subject = $1 AND token_id = $2
       RETURNING token_id, token_prefix, subject, name, scopes, created_at,
         expires_at, revoked_at, last_used_at`,
    [input.subject, input.tokenId, toDate(input.revokedAt)],
  );
  return row ? personalAccessTokenFromRow(row) : undefined;
}

export async function recordPersonalAccessTokenUsed(
  client: PostgresQueryClient,
  tokenId: string,
  lastUsedAt: number,
): Promise<void> {
  await runQuery(
    client,
    `UPDATE accounts_v1.personal_access_tokens
       SET last_used_at = $2
       WHERE token_id = $1`,
    [tokenId, toDate(lastUsedAt)],
  );
}
