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

import {
  hashSecret,
  type PostgresQueryClient,
  runFirst,
  runQuery,
  runRows,
  toDate,
} from "./internal.ts";
import type { RefreshChainPruneResult } from "../store.ts";

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
  const existing = await runFirst<{ root_token_hash: string }>(
    client,
    `SELECT root_token_hash
       FROM accounts_v1.refresh_chain_links
       WHERE child_token_hash = $1`,
    [parentHash],
  );
  const rootHash = existing?.root_token_hash ?? parentHash;
  // G6 fix: this is the ATOMIC rotation claim. `parent_token_hash` is the
  // PRIMARY KEY, so `ON CONFLICT DO NOTHING RETURNING` inserts at most one
  // link per parent and returns a row ONLY when this statement performed
  // the insert. A missing row means a link already existed — the parent
  // token was already rotated (e.g. a concurrent presentation of the same
  // valid refresh token), so the caller must treat it as reuse rather than
  // minting a second child family. The previous `DO UPDATE` overwrote the
  // child link, which let two concurrent rotations both "succeed" and
  // double-spend the parent.
  const inserted = await runFirst<{ parent_token_hash: string }>(
    client,
    `INSERT INTO accounts_v1.refresh_chain_links (
        parent_token_hash, child_token_hash, root_token_hash, created_at
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (parent_token_hash) DO NOTHING
      RETURNING parent_token_hash`,
    [parentHash, childHash, rootHash, toDate(Date.now())],
  );
  return inserted !== undefined;
}

export async function getRefreshChainChild(
  client: PostgresQueryClient,
  token: string,
): Promise<string | undefined> {
  const hash = await hashSecret(token);
  const row = await runFirst<{ child_token_hash: string }>(
    client,
    `SELECT child_token_hash
       FROM accounts_v1.refresh_chain_links
       WHERE parent_token_hash = $1`,
    [hash],
  );
  // Return the child hash. The caller uses this as a presence signal
  // only — it does NOT present the hash back to the token endpoint.
  return row?.child_token_hash;
}

async function resolveRootHash(
  client: PostgresQueryClient,
  presentedHash: string,
): Promise<string> {
  const rootRow = await runFirst<{ root_token_hash: string }>(
    client,
    `SELECT root_token_hash
       FROM accounts_v1.refresh_chain_links
       WHERE parent_token_hash = $1 OR child_token_hash = $1
       LIMIT 1`,
    [presentedHash],
  );
  return rootRow?.root_token_hash ?? presentedHash;
}

async function chainRefreshHashes(
  client: PostgresQueryClient,
  rootHash: string,
): Promise<readonly string[]> {
  const rows = await runRows<{
    parent_token_hash: string;
    child_token_hash: string;
  }>(
    client,
    `SELECT parent_token_hash, child_token_hash
       FROM accounts_v1.refresh_chain_links
       WHERE root_token_hash = $1`,
    [rootHash],
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
  await runQuery(
    client,
    `INSERT INTO accounts_v1.revoked_refresh_roots (root_token_hash, revoked_at)
        VALUES ($1, $2)
        ON CONFLICT (root_token_hash) DO NOTHING`,
    [rootHash, toDate(Date.now())],
  );
  const hashes = await chainRefreshHashes(client, rootHash);
  const all = new Set(hashes);
  all.add(presentedHash);
  for (const hash of all) {
    await runQuery(
      client,
      `DELETE FROM accounts_v1.oauth_refresh_tokens WHERE token_hash = $1`,
      [hash],
    );
  }
  // Cascade-delete every access token minted by any rotation in the
  // chain. Symmetric to the in-process behavior of the legacy
  // implementation.
  await cascadeRevokeChainAccessTokens(client, rootHash);
  return [...all];
}

async function cascadeRevokeChainAccessTokens(
  client: PostgresQueryClient,
  rootHash: string,
): Promise<void> {
  const rows = await runRows<{ access_token_hash: string }>(
    client,
    `SELECT access_token_hash
       FROM accounts_v1.refresh_chain_access_tokens
       WHERE root_token_hash = $1`,
    [rootHash],
  );
  for (const row of rows) {
    await runQuery(
      client,
      `DELETE FROM accounts_v1.oauth_access_tokens WHERE token_hash = $1`,
      [row.access_token_hash],
    );
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
  await runQuery(
    client,
    `INSERT INTO accounts_v1.refresh_chain_access_tokens (
        root_token_hash, access_token_hash, created_at
      ) VALUES ($1, $2, $3)
      ON CONFLICT (root_token_hash, access_token_hash) DO NOTHING`,
    [rootHash, accessHash, toDate(Date.now())],
  );
}

export async function isRefreshRootRevoked(
  client: PostgresQueryClient,
  token: string,
): Promise<boolean> {
  const presentedHash = await hashSecret(token);
  const rootHash = await resolveRootHash(client, presentedHash);
  const revoked = await runFirst<{ root_token_hash: string }>(
    client,
    `SELECT root_token_hash
       FROM accounts_v1.revoked_refresh_roots
       WHERE root_token_hash = $1`,
    [rootHash],
  );
  return revoked !== undefined;
}

export async function markAuthorizationCodeConsumed(
  client: PostgresQueryClient,
  code: string,
): Promise<void> {
  const codeHash = await hashSecret(code);
  await runQuery(
    client,
    `INSERT INTO accounts_v1.consumed_authorization_codes (code_hash, consumed_at)
        VALUES ($1, $2)
        ON CONFLICT (code_hash) DO NOTHING`,
    [codeHash, toDate(Date.now())],
  );
}

export async function isAuthorizationCodeConsumed(
  client: PostgresQueryClient,
  code: string,
): Promise<boolean> {
  const codeHash = await hashSecret(code);
  const row = await runFirst<{ code_hash: string }>(
    client,
    `SELECT code_hash
       FROM accounts_v1.consumed_authorization_codes
       WHERE code_hash = $1`,
    [codeHash],
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
  // forbids NULL in any PK column, so the no-offline_access case (no
  // refresh-token root) must use the same '' sentinel the D1 store uses
  // (`${refreshRootHash ?? ""}`). Keeping both reference distributions on one
  // sentinel scheme is required so the no-offline_access exchange is
  // representable on Postgres at all.
  const refreshRootHash = refreshTokenRoot === undefined
    ? ""
    : await hashSecret(refreshTokenRoot);
  await runQuery(
    client,
    `INSERT INTO accounts_v1.auth_code_token_links (
        code_hash, access_token_hash, refresh_root_hash, created_at
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (code_hash, access_token_hash, refresh_root_hash) DO NOTHING`,
    [codeHash, accessHash, refreshRootHash, toDate(Date.now())],
  );
}

export async function revokeTokensIssuedFromCode(
  client: PostgresQueryClient,
  code: string,
): Promise<{ access: readonly string[]; refresh: readonly string[] }> {
  const codeHash = await hashSecret(code);
  const rows = await runRows<{
    access_token_hash: string;
    refresh_root_hash: string;
  }>(
    client,
    `SELECT access_token_hash, refresh_root_hash
       FROM accounts_v1.auth_code_token_links
       WHERE code_hash = $1`,
    [codeHash],
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
  // Delete the access tokens by hash directly. The refresh root tokens
  // are NOT deleted here — the caller (route layer) walks each root and
  // calls `revokeRefreshChain` against the raw token. But the link rows
  // store hashes; the route layer can call the convenience helper
  // `revokeRefreshChainByRootHash` which already operates on hashes.
  for (const hash of accessHashes) {
    await runQuery(
      client,
      `DELETE FROM accounts_v1.oauth_access_tokens WHERE token_hash = $1`,
      [hash],
    );
  }
  // For each linked refresh root hash, also cascade-revoke the chain
  // and the access tokens it issued so the caller does not need to do
  // it. Since we already have the hash, we use the hash-keyed variant.
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
  await runQuery(
    client,
    `INSERT INTO accounts_v1.revoked_refresh_roots (root_token_hash, revoked_at)
        VALUES ($1, $2)
        ON CONFLICT (root_token_hash) DO NOTHING`,
    [rootHash, toDate(Date.now())],
  );
  const hashes = await chainRefreshHashes(client, rootHash);
  for (const hash of hashes) {
    await runQuery(
      client,
      `DELETE FROM accounts_v1.oauth_refresh_tokens WHERE token_hash = $1`,
      [hash],
    );
  }
  await cascadeRevokeChainAccessTokens(client, rootHash);
}

async function deleteCountBefore(
  client: PostgresQueryClient,
  table: string,
  timeColumn: string,
  before: number,
): Promise<number> {
  // DELETE ... RETURNING 1 so we can count rows removed without relying on a
  // driver-specific rowCount. `table` / `timeColumn` are internal literals
  // (never caller-supplied), so there is no injection surface.
  const rows = await runRows<{ one: number }>(
    client,
    `DELETE FROM ${table} WHERE ${timeColumn} <= $1 RETURNING 1 AS one`,
    [toDate(before)],
  );
  return rows.length;
}

/**
 * Retention cleanup for the refresh-chain / authorization-code tracking
 * tables. Deletes rows older than the supplied cutoffs. This is retention
 * only: token/code reuse detection is unaffected because rows are removed
 * only after their token/code lifetime has elapsed. See the operator cleanup
 * task documented in migrations/019_refresh_chain.sql.
 */
export async function pruneRefreshChain(
  client: PostgresQueryClient,
  input: { chainBefore: number; consumedCodeBefore: number },
): Promise<RefreshChainPruneResult> {
  const chainLinks = await deleteCountBefore(
    client,
    "accounts_v1.refresh_chain_links",
    "created_at",
    input.chainBefore,
  );
  const chainAccessTokens = await deleteCountBefore(
    client,
    "accounts_v1.refresh_chain_access_tokens",
    "created_at",
    input.chainBefore,
  );
  const revokedRoots = await deleteCountBefore(
    client,
    "accounts_v1.revoked_refresh_roots",
    "revoked_at",
    input.chainBefore,
  );
  const consumedCodes = await deleteCountBefore(
    client,
    "accounts_v1.consumed_authorization_codes",
    "consumed_at",
    input.consumedCodeBefore,
  );
  const authCodeTokenLinks = await deleteCountBefore(
    client,
    "accounts_v1.auth_code_token_links",
    "created_at",
    input.consumedCodeBefore,
  );
  return {
    chainLinks,
    chainAccessTokens,
    revokedRoots,
    consumedCodes,
    authCodeTokenLinks,
  };
}
