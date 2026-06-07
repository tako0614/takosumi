// F30: persistent OIDC refresh-token rotation chain and authorization
// code consumption tracking. Free-function module that the
// PostgresAccountsStore delegates to; mirrors the layout of
// `postgres/tokens.ts` and friends.
//
// All token / code values are hashed (sha256:base64url) before they
// reach the database so a read-only leak yields no raw tokens or codes.
// See migrations/019_refresh_chain.sql for the table shapes.
//
// Design note: the chain tables store hashes, so the store-side cascade
// revoke methods perform the OAuth-table DELETE internally (against the
// recorded hashes) rather than returning raw tokens to the caller.
// The returned arrays carry token-hash identifiers and are intended
// for diagnostics / test assertions only.

import { eq, lte, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import {
  hashSecret,
  type PostgresQueryClient,
  runQuery,
  toDate,
} from "./internal.ts";
import type { RefreshChainPruneResult } from "../store.ts";

type DrizzleQuery = {
  toSQL(): { readonly sql: string; readonly params: readonly unknown[] };
};

const accountsV1 = pgSchema("accounts_v1");

const refreshChainLinks = accountsV1.table("refresh_chain_links", {
  parentTokenHash: text("parent_token_hash").primaryKey(),
  childTokenHash: text("child_token_hash").notNull(),
  rootTokenHash: text("root_token_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

const revokedRefreshRoots = accountsV1.table("revoked_refresh_roots", {
  rootTokenHash: text("root_token_hash").primaryKey(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull(),
});

const consumedAuthorizationCodes = accountsV1.table(
  "consumed_authorization_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }).notNull(),
  },
);

const authCodeTokenLinks = accountsV1.table("auth_code_token_links", {
  codeHash: text("code_hash").notNull(),
  accessTokenHash: text("access_token_hash").notNull(),
  refreshRootHash: text("refresh_root_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

const refreshChainAccessTokens = accountsV1.table(
  "refresh_chain_access_tokens",
  {
    rootTokenHash: text("root_token_hash").notNull(),
    accessTokenHash: text("access_token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
);

const oauthAccessTokens = accountsV1.table("oauth_access_tokens", {
  tokenHash: text("token_hash").primaryKey(),
});

const oauthRefreshTokens = accountsV1.table("oauth_refresh_tokens", {
  tokenHash: text("token_hash").primaryKey(),
});

const db = drizzle(async () => ({ rows: [] }), {
  schema: {
    refreshChainLinks,
    revokedRefreshRoots,
    consumedAuthorizationCodes,
    authCodeTokenLinks,
    refreshChainAccessTokens,
    oauthAccessTokens,
    oauthRefreshTokens,
  },
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

export async function addRefreshChainLink(
  client: PostgresQueryClient,
  parentToken: string,
  childToken: string,
): Promise<boolean> {
  const parentHash = await hashSecret(parentToken);
  const childHash = await hashSecret(childToken);
  // Resolve the root: if the parent token is itself a descendant of an
  // earlier root, copy that root into the child link so traversal stays
  // O(1) per lookup.
  const existing = await runDrizzleFirst<{ root_token_hash: string }>(
    client,
    db
      .select({ root_token_hash: refreshChainLinks.rootTokenHash })
      .from(refreshChainLinks)
      .where(eq(refreshChainLinks.childTokenHash, parentHash)),
  );
  const rootHash = existing?.root_token_hash ?? parentHash;
  // This is the ATOMIC rotation claim. `parent_token_hash` is the PRIMARY KEY,
  // so `ON CONFLICT DO NOTHING RETURNING` inserts at most one link per parent
  // and returns a row ONLY when this statement performed the insert.
  const inserted = await runDrizzleFirst<{ parent_token_hash: string }>(
    client,
    db
      .insert(refreshChainLinks)
      .values({
        parentTokenHash: parentHash,
        childTokenHash: childHash,
        rootTokenHash: rootHash,
        createdAt: toDate(Date.now()),
      })
      .onConflictDoNothing({ target: refreshChainLinks.parentTokenHash })
      .returning({ parent_token_hash: refreshChainLinks.parentTokenHash }),
  );
  return inserted !== undefined;
}

export async function getRefreshChainChild(
  client: PostgresQueryClient,
  token: string,
): Promise<string | undefined> {
  const hash = await hashSecret(token);
  const row = await runDrizzleFirst<{ child_token_hash: string }>(
    client,
    db
      .select({ child_token_hash: refreshChainLinks.childTokenHash })
      .from(refreshChainLinks)
      .where(eq(refreshChainLinks.parentTokenHash, hash)),
  );
  // Return the child hash. The caller uses this as a presence signal
  // only — it does NOT present the hash back to the token endpoint.
  return row?.child_token_hash;
}

async function resolveRootHash(
  client: PostgresQueryClient,
  presentedHash: string,
): Promise<string> {
  const rootRow = await runDrizzleFirst<{ root_token_hash: string }>(
    client,
    db
      .select({ root_token_hash: refreshChainLinks.rootTokenHash })
      .from(refreshChainLinks)
      .where(
        or(
          eq(refreshChainLinks.parentTokenHash, presentedHash),
          eq(refreshChainLinks.childTokenHash, presentedHash),
        ),
      )
      .limit(1),
  );
  return rootRow?.root_token_hash ?? presentedHash;
}

async function chainRefreshHashes(
  client: PostgresQueryClient,
  rootHash: string,
): Promise<readonly string[]> {
  const rows = await runDrizzleRows<{
    parent_token_hash: string;
    child_token_hash: string;
  }>(
    client,
    db
      .select({
        parent_token_hash: refreshChainLinks.parentTokenHash,
        child_token_hash: refreshChainLinks.childTokenHash,
      })
      .from(refreshChainLinks)
      .where(eq(refreshChainLinks.rootTokenHash, rootHash)),
  );
  const hashes = new Set<string>();
  hashes.add(rootHash);
  for (const row of rows) {
    hashes.add(row.parent_token_hash);
    hashes.add(row.child_token_hash);
  }
  return [...hashes];
}

export async function revokeRefreshChain(
  client: PostgresQueryClient,
  rootToken: string,
): Promise<readonly string[]> {
  const presentedHash = await hashSecret(rootToken);
  const rootHash = await resolveRootHash(client, presentedHash);
  await markRefreshRootRevoked(client, rootHash);
  const hashes = await chainRefreshHashes(client, rootHash);
  const all = new Set(hashes);
  all.add(presentedHash);
  for (const hash of all) {
    await deleteRefreshTokenHash(client, hash);
  }
  // Cascade-delete every access token minted by any rotation in the
  // chain. Symmetric to the in-process behavior of the implementation.
  await cascadeRevokeChainAccessTokens(client, rootHash);
  return [...all];
}

async function cascadeRevokeChainAccessTokens(
  client: PostgresQueryClient,
  rootHash: string,
): Promise<void> {
  const rows = await runDrizzleRows<{ access_token_hash: string }>(
    client,
    db
      .select({ access_token_hash: refreshChainAccessTokens.accessTokenHash })
      .from(refreshChainAccessTokens)
      .where(eq(refreshChainAccessTokens.rootTokenHash, rootHash)),
  );
  for (const row of rows) {
    await deleteAccessTokenHash(client, row.access_token_hash);
  }
}

export async function linkAccessTokenToRefreshChain(
  client: PostgresQueryClient,
  refreshTokenRoot: string,
  accessToken: string,
): Promise<void> {
  const presentedHash = await hashSecret(refreshTokenRoot);
  const rootHash = await resolveRootHash(client, presentedHash);
  const accessHash = await hashSecret(accessToken);
  await runDrizzle(
    client,
    db
      .insert(refreshChainAccessTokens)
      .values({
        rootTokenHash: rootHash,
        accessTokenHash: accessHash,
        createdAt: toDate(Date.now()),
      })
      .onConflictDoNothing({
        target: [
          refreshChainAccessTokens.rootTokenHash,
          refreshChainAccessTokens.accessTokenHash,
        ],
      }),
  );
}

export async function isRefreshRootRevoked(
  client: PostgresQueryClient,
  token: string,
): Promise<boolean> {
  const presentedHash = await hashSecret(token);
  const rootHash = await resolveRootHash(client, presentedHash);
  const revoked = await runDrizzleFirst<{ root_token_hash: string }>(
    client,
    db
      .select({ root_token_hash: revokedRefreshRoots.rootTokenHash })
      .from(revokedRefreshRoots)
      .where(eq(revokedRefreshRoots.rootTokenHash, rootHash)),
  );
  return revoked !== undefined;
}

export async function markAuthorizationCodeConsumed(
  client: PostgresQueryClient,
  code: string,
): Promise<void> {
  const codeHash = await hashSecret(code);
  await runDrizzle(
    client,
    db
      .insert(consumedAuthorizationCodes)
      .values({ codeHash, consumedAt: toDate(Date.now()) })
      .onConflictDoNothing({ target: consumedAuthorizationCodes.codeHash }),
  );
}

export async function isAuthorizationCodeConsumed(
  client: PostgresQueryClient,
  code: string,
): Promise<boolean> {
  const codeHash = await hashSecret(code);
  const row = await runDrizzleFirst<{ code_hash: string }>(
    client,
    db
      .select({ code_hash: consumedAuthorizationCodes.codeHash })
      .from(consumedAuthorizationCodes)
      .where(eq(consumedAuthorizationCodes.codeHash, codeHash)),
  );
  return row !== undefined;
}

export async function linkAccessTokenToAuthCode(
  client: PostgresQueryClient,
  code: string,
  accessToken: string,
  refreshTokenRoot?: string,
): Promise<void> {
  const codeHash = await hashSecret(code);
  const accessHash = await hashSecret(accessToken);
  // Absent refresh root is stored as the empty-string sentinel '', NOT NULL.
  // refresh_root_hash is part of the PRIMARY KEY (migration 021) and Postgres
  // forbids NULL in any PK column, so the no-offline_access case must use the
  // same '' sentinel the D1 store uses.
  const refreshRootHash =
    refreshTokenRoot === undefined ? "" : await hashSecret(refreshTokenRoot);
  await runDrizzle(
    client,
    db
      .insert(authCodeTokenLinks)
      .values({
        codeHash,
        accessTokenHash: accessHash,
        refreshRootHash,
        createdAt: toDate(Date.now()),
      })
      .onConflictDoNothing({
        target: [
          authCodeTokenLinks.codeHash,
          authCodeTokenLinks.accessTokenHash,
          authCodeTokenLinks.refreshRootHash,
        ],
      }),
  );
}

export async function revokeTokensIssuedFromCode(
  client: PostgresQueryClient,
  code: string,
): Promise<{ access: readonly string[]; refresh: readonly string[] }> {
  const codeHash = await hashSecret(code);
  const rows = await runDrizzleRows<{
    access_token_hash: string;
    refresh_root_hash: string;
  }>(
    client,
    db
      .select({
        access_token_hash: authCodeTokenLinks.accessTokenHash,
        refresh_root_hash: authCodeTokenLinks.refreshRootHash,
      })
      .from(authCodeTokenLinks)
      .where(eq(authCodeTokenLinks.codeHash, codeHash)),
  );
  const accessHashes = new Set<string>();
  const refreshRootHashes = new Set<string>();
  for (const row of rows) {
    // '' is the absent-value sentinel (migration 021), so a real hash is any
    // non-empty value. Skip the sentinel for both columns.
    if (row.access_token_hash !== "") accessHashes.add(row.access_token_hash);
    if (row.refresh_root_hash !== "") {
      refreshRootHashes.add(row.refresh_root_hash);
    }
  }
  for (const hash of accessHashes) {
    await deleteAccessTokenHash(client, hash);
  }
  for (const rootHash of refreshRootHashes) {
    await revokeRefreshChainByRootHash(client, rootHash);
  }
  return {
    access: [...accessHashes],
    refresh: [...refreshRootHashes],
  };
}

/**
 * Internal cascade-revoke helper for the case where the caller already
 * holds the root token's hash (e.g. derived from
 * `auth_code_token_links.refresh_root_hash`). Symmetric to
 * `revokeRefreshChain` but skips the input hashing step.
 */
async function revokeRefreshChainByRootHash(
  client: PostgresQueryClient,
  rootHash: string,
): Promise<void> {
  await markRefreshRootRevoked(client, rootHash);
  const hashes = await chainRefreshHashes(client, rootHash);
  for (const hash of hashes) {
    await deleteRefreshTokenHash(client, hash);
  }
  await cascadeRevokeChainAccessTokens(client, rootHash);
}

async function markRefreshRootRevoked(
  client: PostgresQueryClient,
  rootHash: string,
): Promise<void> {
  await runDrizzle(
    client,
    db
      .insert(revokedRefreshRoots)
      .values({ rootTokenHash: rootHash, revokedAt: toDate(Date.now()) })
      .onConflictDoNothing({ target: revokedRefreshRoots.rootTokenHash }),
  );
}

async function deleteAccessTokenHash(
  client: PostgresQueryClient,
  hash: string,
): Promise<void> {
  await runDrizzle(
    client,
    db.delete(oauthAccessTokens).where(eq(oauthAccessTokens.tokenHash, hash)),
  );
}

async function deleteRefreshTokenHash(
  client: PostgresQueryClient,
  hash: string,
): Promise<void> {
  await runDrizzle(
    client,
    db.delete(oauthRefreshTokens).where(eq(oauthRefreshTokens.tokenHash, hash)),
  );
}

async function deleteCountBefore(
  client: PostgresQueryClient,
  query: DrizzleQuery,
): Promise<number> {
  return (await runDrizzleRows<{ one: number }>(client, query)).length;
}

/**
 * Retention cleanup for the refresh-chain / authorization-code tracking
 * tables. Deletes rows older than the supplied cutoffs. This is retention
 * only: token/code reuse detection is unaffected because rows are removed
 * only after their token/code lifetime has elapsed.
 */
export async function pruneRefreshChain(
  client: PostgresQueryClient,
  input: { chainBefore: number; consumedCodeBefore: number },
): Promise<RefreshChainPruneResult> {
  const chainBefore = toDate(input.chainBefore);
  const consumedCodeBefore = toDate(input.consumedCodeBefore);
  const chainLinks = await deleteCountBefore(
    client,
    db
      .delete(refreshChainLinks)
      .where(lte(refreshChainLinks.createdAt, chainBefore))
      .returning({ one: refreshChainLinks.parentTokenHash }),
  );
  const chainAccessTokens = await deleteCountBefore(
    client,
    db
      .delete(refreshChainAccessTokens)
      .where(lte(refreshChainAccessTokens.createdAt, chainBefore))
      .returning({ one: refreshChainAccessTokens.rootTokenHash }),
  );
  const revokedRoots = await deleteCountBefore(
    client,
    db
      .delete(revokedRefreshRoots)
      .where(lte(revokedRefreshRoots.revokedAt, chainBefore))
      .returning({ one: revokedRefreshRoots.rootTokenHash }),
  );
  const consumedCodes = await deleteCountBefore(
    client,
    db
      .delete(consumedAuthorizationCodes)
      .where(lte(consumedAuthorizationCodes.consumedAt, consumedCodeBefore))
      .returning({ one: consumedAuthorizationCodes.codeHash }),
  );
  const authCodeTokenLinksDeleted = await deleteCountBefore(
    client,
    db
      .delete(authCodeTokenLinks)
      .where(lte(authCodeTokenLinks.createdAt, consumedCodeBefore))
      .returning({ one: authCodeTokenLinks.codeHash }),
  );
  return {
    chainLinks,
    chainAccessTokens,
    revokedRoots,
    consumedCodes,
    authCodeTokenLinks: authCodeTokenLinksDeleted,
  };
}
