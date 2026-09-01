// OAuth access/refresh tokens, authorization codes, and personal access
// tokens. Free-function module: the canonical Postgres operations live here
// and `PostgresAccountsStore` delegates to them. Behaviour preserved verbatim.

import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { bigint, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import type {
  AuthorizationCodeRedemptionCandidate,
  AuthorizationCodeRecord,
  ClaimValidatedAuthorizationCodeResult,
  FinalizeAuthorizationCodeRedemptionInput,
  FinalizeAuthorizationCodeRedemptionResult,
  OpenAuthorizationCodeRedemptionResult,
  PersonalAccessTokenInventoryPage,
  PersonalAccessTokenInventoryPageInput,
  PersonalAccessTokenRecord,
  TokenRecord,
} from "../store.ts";
import { assertPersonalAccessTokenInventoryPageInput } from "../store.ts";
import {
  authorizationCodeFromRow,
  type AuthorizationCodeRow,
  hashSecret,
  optional,
  personalAccessTokenFromRow,
  type PersonalAccessTokenRow,
  type PostgresQueryClient,
  runQuery,
  toDate,
  tokenFromRow,
  type TokenRow,
} from "./internal.ts";

type OAuthTokenTable = "oauth_access_tokens" | "oauth_refresh_tokens";
type DrizzleQuery = {
  toSQL(): { readonly sql: string; readonly params: readonly unknown[] };
};

const accountsV1 = pgSchema("accounts_v1");

const authorizationCodes = accountsV1.table("authorization_codes", {
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  scope: text("scope").notNull(),
  subject: text("subject").notNull(),
  takosumiSubject: text("takosumi_subject"),
  capsuleId: text("capsule_id"),
  workspaceId: text("workspace_id"),
  role: text("role"),
  nonce: text("nonce"),
  codeChallenge: text("code_challenge"),
  codeChallengeMethod: text("code_challenge_method"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

const oauthAccessTokens = accountsV1.table("oauth_access_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  clientId: text("client_id").notNull(),
  audience: text("audience"),
  scope: text("scope").notNull(),
  subject: text("subject").notNull(),
  takosumiSubject: text("takosumi_subject"),
  capsuleId: text("capsule_id"),
  workspaceId: text("workspace_id"),
  role: text("role"),
  interfaceId: text("interface_id"),
  interfaceBindingId: text("interface_binding_id"),
  interfaceResolvedRevision: bigint("interface_resolved_revision", {
    mode: "number",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

const oauthRefreshTokens = accountsV1.table("oauth_refresh_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  clientId: text("client_id").notNull(),
  audience: text("audience"),
  scope: text("scope").notNull(),
  subject: text("subject").notNull(),
  takosumiSubject: text("takosumi_subject"),
  capsuleId: text("capsule_id"),
  workspaceId: text("workspace_id"),
  role: text("role"),
  interfaceId: text("interface_id"),
  interfaceBindingId: text("interface_binding_id"),
  interfaceResolvedRevision: bigint("interface_resolved_revision", {
    mode: "number",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

const personalAccessTokens = accountsV1.table("personal_access_tokens", {
  tokenId: text("token_id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  tokenPrefix: text("token_prefix").notNull(),
  subject: text("subject").notNull(),
  name: text("name").notNull(),
  scopes: text("scopes").array().notNull(),
  workspaceId: text("workspace_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

const db = drizzle(async () => ({ rows: [] }), {
  schema: {
    authorizationCodes,
    oauthAccessTokens,
    oauthRefreshTokens,
    personalAccessTokens,
  },
});

function oauthTokenTable(table: OAuthTokenTable) {
  return table === "oauth_access_tokens"
    ? oauthAccessTokens
    : oauthRefreshTokens;
}

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

function tokenSelection(table: ReturnType<typeof oauthTokenTable>) {
  return {
    client_id: table.clientId,
    audience: table.audience,
    scope: table.scope,
    subject: table.subject,
    takosumi_subject: table.takosumiSubject,
    capsule_id: table.capsuleId,
    workspace_id: table.workspaceId,
    role: table.role,
    interface_id: table.interfaceId,
    interface_binding_id: table.interfaceBindingId,
    interface_resolved_revision: table.interfaceResolvedRevision,
    expires_at: table.expiresAt,
  };
}

function personalAccessTokenSelection() {
  return {
    token_id: personalAccessTokens.tokenId,
    token_prefix: personalAccessTokens.tokenPrefix,
    subject: personalAccessTokens.subject,
    name: personalAccessTokens.name,
    scopes: personalAccessTokens.scopes,
    workspace_id: personalAccessTokens.workspaceId,
    created_at: personalAccessTokens.createdAt,
    expires_at: personalAccessTokens.expiresAt,
    revoked_at: personalAccessTokens.revokedAt,
    last_used_at: personalAccessTokens.lastUsedAt,
  };
}

const PERSONAL_ACCESS_TOKEN_INVENTORY_PAGE_SQL = `with
  subject_tokens as (
    select token_id, token_prefix, subject, name, scopes, workspace_id,
           created_at, expires_at, revoked_at, last_used_at,
           date_trunc('milliseconds', created_at) as cursor_created_at
      from accounts_v1.personal_access_tokens
     where subject = $1
  ),
  cursor_anchor as (
    select cursor_created_at, token_id
      from subject_tokens
     where $2::boolean
       and token_id = $4
       and cursor_created_at = $3::timestamptz
  ),
  cursor_state as (
    select case when not $2::boolean then 0::bigint else (
      select count(*)::bigint from cursor_anchor
    ) end as anchor_count
  ),
  page as (
    select * from subject_tokens
     where not $2::boolean
        or cursor_created_at > coalesce(
          (select cursor_created_at from cursor_anchor),
          $3::timestamptz
        )
        or (
          cursor_created_at = coalesce(
            (select cursor_created_at from cursor_anchor),
            $3::timestamptz
          )
          and token_id > coalesce(
            (select token_id from cursor_anchor),
            $4
          )
        )
     order by cursor_created_at asc, token_id asc
     limit $5
  )
select 0 as row_kind,
       (select count(*)::bigint from subject_tokens) as total,
       cursor_state.anchor_count,
       null::text as token_id,
       null::text as token_prefix,
       null::text as subject,
       null::text as name,
       null::text[] as scopes,
       null::text as workspace_id,
       null::timestamptz as created_at,
       null::timestamptz as expires_at,
       null::timestamptz as revoked_at,
       null::timestamptz as last_used_at
  from cursor_state
union all
select 1 as row_kind,
       null::bigint as total,
       null::bigint as anchor_count,
       page.token_id,
       page.token_prefix,
       page.subject,
       page.name,
       page.scopes,
       page.workspace_id,
       page.cursor_created_at as created_at,
       page.expires_at,
       page.revoked_at,
       page.last_used_at
  from page
order by row_kind asc, created_at asc, token_id asc`;

interface PersonalAccessTokenInventoryPostgresRow extends PersonalAccessTokenRow {
  readonly row_kind: number;
  readonly total: number | string | null;
  readonly anchor_count: number | string | null;
}

interface AuthorizationCodeRedemptionRow extends AuthorizationCodeRow {
  readonly code_hash: string;
  readonly record_version: string;
  readonly state: "active" | "issuing" | "issued" | "replayed";
  readonly claim_id: string | null;
  readonly access_token_hash: string | null;
  readonly refresh_token_hash: string | null;
  readonly created_at: Date | string | number;
  readonly updated_at: Date | string | number;
  readonly claimed_at: Date | string | number | null;
  readonly issued_at: Date | string | number | null;
  readonly replayed_at: Date | string | number | null;
}

const AUTHORIZATION_CODE_REDEMPTION_SELECTION_SQL = `
  code_hash, record_version, state, claim_id,
  client_id, redirect_uri, scope, subject, takosumi_subject,
  capsule_id, workspace_id, role, nonce, code_challenge,
  code_challenge_method, expires_at, access_token_hash,
  refresh_token_hash, created_at, updated_at, claimed_at, issued_at,
  replayed_at`;

function authorizationCodeCandidate(
  row: AuthorizationCodeRedemptionRow,
): AuthorizationCodeRedemptionCandidate {
  return {
    redemptionId: row.code_hash,
    recordVersion: row.record_version,
    record: authorizationCodeFromRow(row),
  };
}

function requireAuthorizationCodeTransaction<T>(
  client: PostgresQueryClient,
  run: (transaction: PostgresQueryClient) => Promise<T>,
): Promise<T> {
  if (!client.transaction) {
    throw new Error(
      "Postgres authorization-code lifecycle requires a pinned transaction",
    );
  }
  return client.transaction(run);
}

export async function saveAuthorizationCode(
  client: PostgresQueryClient,
  code: string,
  record: AuthorizationCodeRecord,
): Promise<void> {
  const codeHash = await hashSecret(code);
  const recordVersion = crypto.randomUUID();
  const now = toDate(Date.now());
  await requireAuthorizationCodeTransaction(client, async (transaction) => {
    const existing = (
      await runQuery<AuthorizationCodeRedemptionRow>(
        transaction,
        `SELECT ${AUTHORIZATION_CODE_REDEMPTION_SELECTION_SQL}
           FROM accounts_v1.authorization_code_redemptions
          WHERE code_hash = $1
          FOR UPDATE`,
        [codeHash],
      )
    ).rows[0];
    if (existing && existing.state !== "active") {
      await replayAuthorizationCodeLocked(transaction, existing, now);
    }
    const values = [
      codeHash,
      record.clientId,
      record.redirectUri,
      record.scope,
      record.subject,
      record.takosumiSubject ?? null,
      record.capsuleId ?? null,
      record.workspaceId ?? null,
      record.role ?? null,
      record.nonce ?? null,
      record.codeChallenge ?? null,
      record.codeChallengeMethod ?? null,
      now,
      toDate(record.expiresAt),
    ] as const;
    await runQuery(
      transaction,
      `INSERT INTO accounts_v1.authorization_codes (
         code_hash, client_id, redirect_uri, scope, subject,
         takosumi_subject, capsule_id, workspace_id, role, nonce,
         code_challenge, code_challenge_method, created_at, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
       ) ON CONFLICT (code_hash) DO UPDATE SET
         client_id = EXCLUDED.client_id,
         redirect_uri = EXCLUDED.redirect_uri,
         scope = EXCLUDED.scope,
         subject = EXCLUDED.subject,
         takosumi_subject = EXCLUDED.takosumi_subject,
         capsule_id = EXCLUDED.capsule_id,
         workspace_id = EXCLUDED.workspace_id,
         role = EXCLUDED.role,
         nonce = EXCLUDED.nonce,
         code_challenge = EXCLUDED.code_challenge,
         code_challenge_method = EXCLUDED.code_challenge_method,
         created_at = EXCLUDED.created_at,
         expires_at = EXCLUDED.expires_at`,
      values,
    );
    await runQuery(
      transaction,
      `INSERT INTO accounts_v1.authorization_code_redemptions (
         code_hash, record_version, state, claim_id, client_id, redirect_uri,
         scope, subject, takosumi_subject, capsule_id, workspace_id, role,
         nonce, code_challenge, code_challenge_method, access_token_hash,
         refresh_token_hash, created_at, updated_at, expires_at, claimed_at,
         issued_at, replayed_at
       ) VALUES (
         $1, $15, 'active', NULL, $2, $3, $4, $5, $6, $7, $8, $9,
         $10, $11, $12, NULL, NULL, $13, $13, $14, NULL, NULL, NULL
       ) ON CONFLICT (code_hash) DO UPDATE SET
         record_version = EXCLUDED.record_version,
         state = 'active',
         claim_id = NULL,
         client_id = EXCLUDED.client_id,
         redirect_uri = EXCLUDED.redirect_uri,
         scope = EXCLUDED.scope,
         subject = EXCLUDED.subject,
         takosumi_subject = EXCLUDED.takosumi_subject,
         capsule_id = EXCLUDED.capsule_id,
         workspace_id = EXCLUDED.workspace_id,
         role = EXCLUDED.role,
         nonce = EXCLUDED.nonce,
         code_challenge = EXCLUDED.code_challenge,
         code_challenge_method = EXCLUDED.code_challenge_method,
         access_token_hash = NULL,
         refresh_token_hash = NULL,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at,
         expires_at = EXCLUDED.expires_at,
         claimed_at = NULL,
         issued_at = NULL,
         replayed_at = NULL`,
      [...values, recordVersion],
    );
  });
}

export async function openAuthorizationCodeRedemption(
  client: PostgresQueryClient,
  code: string,
): Promise<OpenAuthorizationCodeRedemptionResult> {
  const codeHash = await hashSecret(code);
  return await requireAuthorizationCodeTransaction(
    client,
    async (transaction) => {
      const row = (
        await runQuery<AuthorizationCodeRedemptionRow>(
          transaction,
          `SELECT ${AUTHORIZATION_CODE_REDEMPTION_SELECTION_SQL}
             FROM accounts_v1.authorization_code_redemptions
            WHERE code_hash = $1
            FOR UPDATE`,
          [codeHash],
        )
      ).rows[0];
      if (!row) return { status: "unknown" };
      if (row.state === "active") {
        return { status: "active", candidate: authorizationCodeCandidate(row) };
      }
      await replayAuthorizationCodeLocked(transaction, row, toDate(Date.now()));
      return { status: "replayed" };
    },
  );
}

export async function claimValidatedAuthorizationCode(
  client: PostgresQueryClient,
  candidate: AuthorizationCodeRedemptionCandidate,
): Promise<ClaimValidatedAuthorizationCodeResult> {
  const claimId = crypto.randomUUID();
  return await requireAuthorizationCodeTransaction(
    client,
    async (transaction) => {
      const row = (
        await runQuery<AuthorizationCodeRedemptionRow>(
          transaction,
          `SELECT ${AUTHORIZATION_CODE_REDEMPTION_SELECTION_SQL}
             FROM accounts_v1.authorization_code_redemptions
            WHERE code_hash = $1
            FOR UPDATE`,
          [candidate.redemptionId],
        )
      ).rows[0];
      if (!row) return { status: "lost" };
      if (row.record_version !== candidate.recordVersion) {
        return { status: "stale" };
      }
      if (row.state !== "active") {
        await replayAuthorizationCodeLocked(
          transaction,
          row,
          toDate(Date.now()),
        );
        return { status: "replayed" };
      }
      const claimedAt = toDate(Date.now());
      await runQuery(
        transaction,
        `UPDATE accounts_v1.authorization_code_redemptions
            SET state = 'issuing', claim_id = $3, claimed_at = $4,
                updated_at = $4
          WHERE code_hash = $1 AND record_version = $2 AND state = 'active'`,
        [candidate.redemptionId, candidate.recordVersion, claimId, claimedAt],
      );
      await runQuery(
        transaction,
        `DELETE FROM accounts_v1.authorization_codes WHERE code_hash = $1`,
        [candidate.redemptionId],
      );
      return { status: "claimed", claimId };
    },
  );
}

export async function finalizeAuthorizationCodeRedemption(
  client: PostgresQueryClient,
  input: FinalizeAuthorizationCodeRedemptionInput,
): Promise<FinalizeAuthorizationCodeRedemptionResult> {
  if (
    (input.refreshToken === undefined) !==
    (input.refreshRecord === undefined)
  ) {
    throw new TypeError(
      "authorization-code refresh token and record must be provided together",
    );
  }
  const [codeHash, accessTokenHash, refreshTokenHash] = await Promise.all([
    hashSecret(input.code),
    hashSecret(input.accessToken),
    input.refreshToken ? hashSecret(input.refreshToken) : undefined,
  ]);
  return await requireAuthorizationCodeTransaction(
    client,
    async (transaction) => {
      const row = (
        await runQuery<AuthorizationCodeRedemptionRow>(
          transaction,
          `SELECT ${AUTHORIZATION_CODE_REDEMPTION_SELECTION_SQL}
             FROM accounts_v1.authorization_code_redemptions
            WHERE code_hash = $1
            FOR UPDATE`,
          [codeHash],
        )
      ).rows[0];
      if (!row) return { status: "lost" };
      if (row.state === "replayed") return { status: "replayed" };
      if (row.state !== "issuing" || row.claim_id !== input.claimId) {
        return { status: "lost" };
      }
      const now = toDate(Date.now());
      await insertOAuthTokenHash(
        transaction,
        "oauth_access_tokens",
        accessTokenHash,
        input.accessRecord,
        now,
      );
      if (refreshTokenHash && input.refreshRecord) {
        await insertOAuthTokenHash(
          transaction,
          "oauth_refresh_tokens",
          refreshTokenHash,
          input.refreshRecord,
          now,
        );
        await runQuery(
          transaction,
          `INSERT INTO accounts_v1.refresh_chain_access_tokens (
             root_token_hash, access_token_hash, created_at
           ) VALUES ($1, $2, $3)
           ON CONFLICT (root_token_hash, access_token_hash) DO NOTHING`,
          [refreshTokenHash, accessTokenHash, now],
        );
      }
      await runQuery(
        transaction,
        `INSERT INTO accounts_v1.consumed_authorization_codes (
           code_hash, consumed_at
         ) VALUES ($1, $2)
         ON CONFLICT (code_hash) DO NOTHING`,
        [codeHash, now],
      );
      await runQuery(
        transaction,
        `INSERT INTO accounts_v1.auth_code_token_links (
           code_hash, access_token_hash, refresh_root_hash, created_at
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (code_hash, access_token_hash, refresh_root_hash)
         DO NOTHING`,
        [codeHash, accessTokenHash, refreshTokenHash ?? "", now],
      );
      await runQuery(
        transaction,
        `UPDATE accounts_v1.authorization_code_redemptions
            SET state = 'issued', access_token_hash = $3,
                refresh_token_hash = $4, issued_at = $5, updated_at = $5
          WHERE code_hash = $1 AND state = 'issuing' AND claim_id = $2`,
        [
          codeHash,
          input.claimId,
          accessTokenHash,
          refreshTokenHash ?? null,
          now,
        ],
      );
      return { status: "issued" };
    },
  );
}

async function insertOAuthTokenHash(
  client: PostgresQueryClient,
  table: OAuthTokenTable,
  tokenHash: string,
  record: TokenRecord,
  createdAt: Date,
): Promise<void> {
  await runQuery(
    client,
    `INSERT INTO accounts_v1.${table} (
       token_hash, client_id, audience, scope, subject, takosumi_subject,
       capsule_id, workspace_id, role, interface_id, interface_binding_id,
       interface_resolved_revision, created_at, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
     )`,
    [
      tokenHash,
      record.clientId,
      record.audience ?? null,
      record.scope,
      record.subject,
      record.takosumiSubject ?? null,
      record.capsuleId ?? null,
      record.workspaceId ?? null,
      record.role ?? null,
      record.interfaceId ?? null,
      record.interfaceBindingId ?? null,
      record.interfaceResolvedRevision ?? null,
      createdAt,
      toDate(record.expiresAt),
    ],
  );
}

async function replayAuthorizationCodeLocked(
  client: PostgresQueryClient,
  row: AuthorizationCodeRedemptionRow,
  replayedAt: Date,
): Promise<void> {
  const refreshRootHash = optional(row.refresh_token_hash);
  await runQuery(
    client,
    `WITH refresh_roots(root_token_hash) AS (
       SELECT $2::text WHERE $2::text IS NOT NULL
       UNION
       SELECT NULLIF(refresh_root_hash, '')
         FROM accounts_v1.auth_code_token_links
        WHERE code_hash = $1
     )
     INSERT INTO accounts_v1.revoked_refresh_roots (
       root_token_hash, revoked_at
     )
     SELECT root_token_hash, $3
       FROM refresh_roots
      WHERE root_token_hash IS NOT NULL
     ON CONFLICT (root_token_hash) DO UPDATE SET
       revoked_at = GREATEST(
         accounts_v1.revoked_refresh_roots.revoked_at,
         EXCLUDED.revoked_at
       )`,
    [row.code_hash, refreshRootHash ?? null, replayedAt],
  );
  await runQuery(
    client,
    `WITH refresh_roots(root_token_hash) AS (
       SELECT $3::text WHERE $3::text IS NOT NULL
       UNION
       SELECT NULLIF(refresh_root_hash, '')
         FROM accounts_v1.auth_code_token_links
        WHERE code_hash = $1
     )
     DELETE FROM accounts_v1.oauth_access_tokens
      WHERE token_hash = $2
         OR token_hash IN (
           SELECT NULLIF(access_token_hash, '')
             FROM accounts_v1.auth_code_token_links
            WHERE code_hash = $1
         )
         OR token_hash IN (
           SELECT access_token_hash
             FROM accounts_v1.refresh_chain_access_tokens
            WHERE root_token_hash IN (
              SELECT root_token_hash FROM refresh_roots
            )
         )`,
    [row.code_hash, row.access_token_hash, refreshRootHash ?? null],
  );
  await runQuery(
    client,
    `WITH refresh_roots(root_token_hash) AS (
       SELECT $2::text WHERE $2::text IS NOT NULL
       UNION
       SELECT NULLIF(refresh_root_hash, '')
         FROM accounts_v1.auth_code_token_links
        WHERE code_hash = $1
     )
     DELETE FROM accounts_v1.oauth_refresh_tokens
      WHERE token_hash IN (
            SELECT root_token_hash FROM refresh_roots
         )
         OR token_hash IN (
           SELECT parent_token_hash
             FROM accounts_v1.refresh_chain_links
            WHERE root_token_hash IN (
              SELECT root_token_hash FROM refresh_roots
            )
           UNION
           SELECT child_token_hash
             FROM accounts_v1.refresh_chain_links
            WHERE root_token_hash IN (
              SELECT root_token_hash FROM refresh_roots
            )
         )`,
    [row.code_hash, refreshRootHash ?? null],
  );
  await runQuery(
    client,
    `INSERT INTO accounts_v1.consumed_authorization_codes (
       code_hash, consumed_at
     ) VALUES ($1, $2)
     ON CONFLICT (code_hash) DO NOTHING`,
    [row.code_hash, replayedAt],
  );
  await runQuery(
    client,
    `UPDATE accounts_v1.authorization_code_redemptions
        SET state = 'replayed', replayed_at = COALESCE(replayed_at, $2),
            updated_at = $2
      WHERE code_hash = $1`,
    [row.code_hash, replayedAt],
  );
}

export async function saveOAuthToken(
  client: PostgresQueryClient,
  table: OAuthTokenTable,
  token: string,
  record: TokenRecord,
): Promise<void> {
  const tokenTable = oauthTokenTable(table);
  const values = {
    tokenHash: await hashSecret(token),
    clientId: record.clientId,
    audience: record.audience ?? null,
    scope: record.scope,
    subject: record.subject,
    takosumiSubject: record.takosumiSubject ?? null,
    capsuleId: record.capsuleId ?? null,
    workspaceId: record.workspaceId ?? null,
    role: record.role ?? null,
    interfaceId: record.interfaceId ?? null,
    interfaceBindingId: record.interfaceBindingId ?? null,
    interfaceResolvedRevision: record.interfaceResolvedRevision ?? null,
    createdAt: toDate(Date.now()),
    expiresAt: toDate(record.expiresAt),
  };
  await runDrizzle(
    client,
    db
      .insert(tokenTable)
      .values(values)
      .onConflictDoUpdate({
        target: tokenTable.tokenHash,
        set: {
          clientId: values.clientId,
          audience: values.audience,
          scope: values.scope,
          subject: values.subject,
          takosumiSubject: values.takosumiSubject,
          capsuleId: values.capsuleId,
          workspaceId: values.workspaceId,
          role: values.role,
          interfaceId: values.interfaceId,
          interfaceBindingId: values.interfaceBindingId,
          interfaceResolvedRevision: values.interfaceResolvedRevision,
          expiresAt: values.expiresAt,
        },
      }),
  );
}

export async function findOAuthToken(
  client: PostgresQueryClient,
  table: OAuthTokenTable,
  token: string,
): Promise<TokenRecord | undefined> {
  const tokenTable = oauthTokenTable(table);
  const row = await runDrizzleFirst<TokenRow>(
    client,
    db
      .select(tokenSelection(tokenTable))
      .from(tokenTable)
      .where(eq(tokenTable.tokenHash, await hashSecret(token))),
  );
  return row ? tokenFromRow(row) : undefined;
}

export async function deleteOAuthToken(
  client: PostgresQueryClient,
  token: string,
): Promise<void> {
  const tokenHash = await hashSecret(token);
  await runDrizzle(
    client,
    db
      .delete(oauthAccessTokens)
      .where(eq(oauthAccessTokens.tokenHash, tokenHash)),
  );
  await runDrizzle(
    client,
    db
      .delete(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.tokenHash, tokenHash)),
  );
}

export async function savePersonalAccessToken(
  client: PostgresQueryClient,
  token: string,
  record: PersonalAccessTokenRecord,
): Promise<void> {
  const values = {
    tokenId: record.tokenId,
    tokenHash: await hashSecret(token),
    tokenPrefix: record.tokenPrefix,
    subject: record.subject,
    name: record.name,
    scopes: [...record.scopes],
    workspaceId: record.workspaceId ?? null,
    createdAt: toDate(record.createdAt),
    expiresAt: record.expiresAt === undefined ? null : toDate(record.expiresAt),
    revokedAt: record.revokedAt === undefined ? null : toDate(record.revokedAt),
    lastUsedAt:
      record.lastUsedAt === undefined ? null : toDate(record.lastUsedAt),
  };
  await runDrizzle(
    client,
    db
      .insert(personalAccessTokens)
      .values(values)
      .onConflictDoUpdate({
        target: personalAccessTokens.tokenId,
        set: {
          tokenHash: values.tokenHash,
          tokenPrefix: values.tokenPrefix,
          subject: values.subject,
          name: values.name,
          scopes: values.scopes,
          workspaceId: values.workspaceId,
          expiresAt: values.expiresAt,
          revokedAt: values.revokedAt,
          lastUsedAt: values.lastUsedAt,
        },
      }),
  );
}

export async function findPersonalAccessToken(
  client: PostgresQueryClient,
  token: string,
): Promise<PersonalAccessTokenRecord | undefined> {
  const row = await runDrizzleFirst<PersonalAccessTokenRow>(
    client,
    db
      .select(personalAccessTokenSelection())
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.tokenHash, await hashSecret(token))),
  );
  return row ? personalAccessTokenFromRow(row) : undefined;
}

export async function listPersonalAccessTokensForSubject(
  client: PostgresQueryClient,
  subject: TakosumiSubject,
): Promise<readonly PersonalAccessTokenRecord[]> {
  const rows = await runDrizzleRows<PersonalAccessTokenRow>(
    client,
    db
      .select(personalAccessTokenSelection())
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.subject, subject))
      .orderBy(
        asc(personalAccessTokens.createdAt),
        asc(personalAccessTokens.tokenId),
      ),
  );
  return rows.map(personalAccessTokenFromRow);
}

export async function listPersonalAccessTokenInventoryPage(
  client: PostgresQueryClient,
  input: PersonalAccessTokenInventoryPageInput,
): Promise<PersonalAccessTokenInventoryPage> {
  assertPersonalAccessTokenInventoryPageInput(input);
  const hasCursor = input.cursor !== undefined;
  const rows = (
    await runQuery<PersonalAccessTokenInventoryPostgresRow>(
      client,
      PERSONAL_ACCESS_TOKEN_INVENTORY_PAGE_SQL,
      [
        input.subject,
        hasCursor,
        toDate(input.cursor?.createdAt ?? 0),
        input.cursor?.tokenId ?? "",
        input.limit + 1,
      ],
    )
  ).rows;
  const [meta, ...pageRows] = rows;
  const total = meta ? safeCount(meta.total) : undefined;
  const anchorCount = meta ? safeCount(meta.anchor_count) : undefined;
  if (
    !meta ||
    meta.row_kind !== 0 ||
    total === undefined ||
    anchorCount === undefined ||
    anchorCount > 1 ||
    (!hasCursor && anchorCount !== 0) ||
    pageRows.length > input.limit + 1 ||
    pageRows.some(
      (row) =>
        row.row_kind !== 1 ||
        row.subject !== input.subject ||
        typeof row.token_id !== "string",
    )
  ) {
    throw new Error("Postgres PAT inventory result is malformed");
  }
  const items = pageRows.map(personalAccessTokenFromRow);
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1]!;
    const current = items[index]!;
    if (
      current.createdAt < previous.createdAt ||
      (current.createdAt === previous.createdAt &&
        current.tokenId <= previous.tokenId)
    ) {
      throw new Error("Postgres PAT inventory order is malformed");
    }
  }
  return {
    items,
    total,
    cursorValid: !hasCursor || anchorCount === 1,
  };
}

function safeCount(value: number | string | null): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isSafeInteger(parsed) && (parsed as number) >= 0
    ? (parsed as number)
    : undefined;
}

export async function revokePersonalAccessToken(
  client: PostgresQueryClient,
  input: {
    subject: TakosumiSubject;
    tokenId: string;
    revokedAt: number;
  },
): Promise<PersonalAccessTokenRecord | undefined> {
  const row = await runDrizzleFirst<PersonalAccessTokenRow>(
    client,
    db
      .update(personalAccessTokens)
      .set({ revokedAt: toDate(input.revokedAt) })
      .where(
        and(
          eq(personalAccessTokens.subject, input.subject),
          eq(personalAccessTokens.tokenId, input.tokenId),
        ),
      )
      .returning(personalAccessTokenSelection()),
  );
  return row ? personalAccessTokenFromRow(row) : undefined;
}

export async function recordPersonalAccessTokenUsed(
  client: PostgresQueryClient,
  tokenId: string,
  lastUsedAt: number,
): Promise<void> {
  await runDrizzle(
    client,
    db
      .update(personalAccessTokens)
      .set({ lastUsedAt: toDate(lastUsedAt) })
      .where(eq(personalAccessTokens.tokenId, tokenId)),
  );
}
