// OAuth access/refresh tokens, authorization codes, and personal access
// tokens. Free-function module: the canonical Postgres operations live here
// and `PostgresAccountsStore` delegates to them. Behaviour preserved verbatim.

import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";
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
  capsuleId: text("installation_id"),
  appId: text("app_id"),
  workspaceId: text("space_id"),
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
  scope: text("scope").notNull(),
  subject: text("subject").notNull(),
  takosumiSubject: text("takosumi_subject"),
  capsuleId: text("installation_id"),
  appId: text("app_id"),
  workspaceId: text("space_id"),
  role: text("role"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

const oauthRefreshTokens = accountsV1.table("oauth_refresh_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  clientId: text("client_id").notNull(),
  scope: text("scope").notNull(),
  subject: text("subject").notNull(),
  takosumiSubject: text("takosumi_subject"),
  capsuleId: text("installation_id"),
  appId: text("app_id"),
  workspaceId: text("space_id"),
  role: text("role"),
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
    installation_id: authorizationCodes.capsuleId,
    app_id: authorizationCodes.appId,
    space_id: authorizationCodes.workspaceId,
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
    scope: table.scope,
    subject: table.subject,
    takosumi_subject: table.takosumiSubject,
    installation_id: table.capsuleId,
    app_id: table.appId,
    space_id: table.workspaceId,
    role: table.role,
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
    created_at: personalAccessTokens.createdAt,
    expires_at: personalAccessTokens.expiresAt,
    revoked_at: personalAccessTokens.revokedAt,
    last_used_at: personalAccessTokens.lastUsedAt,
  };
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
    appId: record.appId ?? null,
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
          appId: values.appId,
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
    scope: record.scope,
    subject: record.subject,
    takosumiSubject: record.takosumiSubject ?? null,
    capsuleId: record.capsuleId ?? null,
    appId: record.appId ?? null,
    workspaceId: record.workspaceId ?? null,
    role: record.role ?? null,
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
          scope: values.scope,
          subject: values.subject,
          takosumiSubject: values.takosumiSubject,
          capsuleId: values.capsuleId,
          appId: values.appId,
          workspaceId: values.workspaceId,
          role: values.role,
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
