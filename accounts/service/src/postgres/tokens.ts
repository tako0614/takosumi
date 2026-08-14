// OAuth access/refresh tokens, authorization codes, and personal access
// tokens. Free-function module: the canonical Postgres operations live here
// and `PostgresAccountsStore` delegates to them. Behaviour preserved verbatim.

import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { bigint, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import type {
  AuthorizationCodeRecord,
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

function authorizationCodeSelection() {
  return {
    client_id: authorizationCodes.clientId,
    redirect_uri: authorizationCodes.redirectUri,
    scope: authorizationCodes.scope,
    subject: authorizationCodes.subject,
    takosumi_subject: authorizationCodes.takosumiSubject,
    capsule_id: authorizationCodes.capsuleId,
    workspace_id: authorizationCodes.workspaceId,
    role: authorizationCodes.role,
    nonce: authorizationCodes.nonce,
    code_challenge: authorizationCodes.codeChallenge,
    code_challenge_method: authorizationCodes.codeChallengeMethod,
    expires_at: authorizationCodes.expiresAt,
  };
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
           created_at, expires_at, revoked_at, last_used_at
      from accounts_v1.personal_access_tokens
     where subject = $1
  ),
  cursor_anchor as (
    select created_at, token_id
      from subject_tokens
     where $2::boolean
       and token_id = $4
       and date_trunc('milliseconds', created_at) = $3::timestamptz
  ),
  cursor_state as (
    select case when not $2::boolean then 0::bigint else (
      select count(*)::bigint from cursor_anchor
    ) end as anchor_count
  ),
  page as (
    select * from subject_tokens
     where not $2::boolean
        or created_at > coalesce(
          (select created_at from cursor_anchor),
          $3::timestamptz
        )
        or (
          created_at = coalesce(
            (select created_at from cursor_anchor),
            $3::timestamptz
          )
          and token_id > coalesce(
            (select token_id from cursor_anchor),
            $4
          )
        )
     order by created_at asc, token_id asc
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
       page.created_at,
       page.expires_at,
       page.revoked_at,
       page.last_used_at
  from page
order by row_kind asc, created_at asc, token_id asc`;

interface PersonalAccessTokenInventoryPostgresRow
  extends PersonalAccessTokenRow {
  readonly row_kind: number;
  readonly total: number | string | null;
  readonly anchor_count: number | string | null;
}

export async function saveAuthorizationCode(
  client: PostgresQueryClient,
  code: string,
  record: AuthorizationCodeRecord,
): Promise<void> {
  const values = {
    codeHash: await hashSecret(code),
    clientId: record.clientId,
    redirectUri: record.redirectUri,
    scope: record.scope,
    subject: record.subject,
    takosumiSubject: record.takosumiSubject ?? null,
    capsuleId: record.capsuleId ?? null,
    workspaceId: record.workspaceId ?? null,
    role: record.role ?? null,
    nonce: record.nonce ?? null,
    codeChallenge: record.codeChallenge ?? null,
    codeChallengeMethod: record.codeChallengeMethod ?? null,
    createdAt: toDate(Date.now()),
    expiresAt: toDate(record.expiresAt),
  };
  await runDrizzle(
    client,
    db
      .insert(authorizationCodes)
      .values(values)
      .onConflictDoUpdate({
        target: authorizationCodes.codeHash,
        set: {
          clientId: values.clientId,
          redirectUri: values.redirectUri,
          scope: values.scope,
          subject: values.subject,
          takosumiSubject: values.takosumiSubject,
          capsuleId: values.capsuleId,
          workspaceId: values.workspaceId,
          role: values.role,
          nonce: values.nonce,
          codeChallenge: values.codeChallenge,
          codeChallengeMethod: values.codeChallengeMethod,
          expiresAt: values.expiresAt,
        },
      }),
  );
}

export async function consumeAuthorizationCode(
  client: PostgresQueryClient,
  code: string,
): Promise<AuthorizationCodeRecord | undefined> {
  const row = await runDrizzleFirst<AuthorizationCodeRow>(
    client,
    db
      .delete(authorizationCodes)
      .where(eq(authorizationCodes.codeHash, await hashSecret(code)))
      .returning(authorizationCodeSelection()),
  );
  return row ? authorizationCodeFromRow(row) : undefined;
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
