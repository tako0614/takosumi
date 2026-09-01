// Persistent OIDC refresh-token rotation-chain operations and bounded
// retention for both legacy code evidence and the current redemption
// lifecycle. Free-function module that PostgresAccountsStore delegates to.
//
// All token / code values are hashed (sha256:base64url) before they
// reach the database so a read-only leak yields no raw tokens or codes.
// See migrations/019_refresh_chain.sql for the table shapes.
//
// Design note: the chain tables store hashes, so store-side cascade revoke
// performs OAuth-table DELETEs internally. Authorization-code replay is owned
// atomically by postgres/tokens.ts; the historical evidence tables remain
// here only as expand-window retention phases.

import { eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import {
  hashSecret,
  type PostgresQueryClient,
  runQuery,
  toDate,
} from "./internal.ts";
import type { RefreshChainPruneResult } from "../store.ts";
import {
  emptyRefreshChainPruneResult,
  isRefreshChainRetentionPhase,
  MAX_REFRESH_CHAIN_RETENTION_ROWS,
  nextRefreshChainRetentionPhase,
  type RefreshChainRetentionPageInput,
  type RefreshChainRetentionPageResult,
  type RefreshChainRetentionPhase,
} from "../refresh-chain-retention.ts";

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
  if (!client.transaction) {
    throw new Error(
      "Postgres refresh-root replay fence requires a pinned transaction",
    );
  }
  return await client.transaction(async (transaction) => {
    const rootHash = await resolveRootHash(transaction, presentedHash);
    // Authorization-code replay locks its lifecycle row before it writes the
    // revoked marker and deletes descendants. Lock the same row before the
    // refresh route's final marker check. Under PostgreSQL READ COMMITTED this
    // makes an in-flight replay commit (or roll back) before we decide whether
    // late rotation writes may be returned; a plain marker SELECT cannot see
    // an uncommitted replay and is therefore not a sufficient fence.
    const lifecycleRows = (
      await runQuery<{ readonly state: string }>(
        transaction,
        `SELECT redemption.state
           FROM accounts_v1.authorization_code_redemptions AS redemption
          WHERE redemption.refresh_token_hash = $1
             OR EXISTS (
               SELECT 1
                 FROM accounts_v1.auth_code_token_links AS link
                WHERE link.code_hash = redemption.code_hash
                  AND NULLIF(link.refresh_root_hash, '') = $1
             )
          ORDER BY redemption.code_hash
          FOR UPDATE`,
        [rootHash],
      )
    ).rows;
    if (lifecycleRows.some((row) => row.state === "replayed")) return true;
    const revoked = await runDrizzleFirst<{ root_token_hash: string }>(
      transaction,
      db
        .select({ root_token_hash: revokedRefreshRoots.rootTokenHash })
        .from(revokedRefreshRoots)
        .where(eq(revokedRefreshRoots.rootTokenHash, rootHash)),
    );
    return revoked !== undefined;
  });
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

interface RetentionKeyRow {
  readonly retention_at: Date | string | number;
  readonly key_a: string;
  readonly key_b?: string;
  readonly key_c?: string;
  readonly record_version?: string;
}

/**
 * Bounded Postgres retention page. Candidate selection and every delete use
 * primary-key order; no DELETE RETURNING statement can materialize more than
 * input.limit rows.
 */
export async function pruneRefreshChainPage(
  client: PostgresQueryClient,
  input: RefreshChainRetentionPageInput,
): Promise<RefreshChainRetentionPageResult> {
  assertRefreshChainRetentionPageInput(input);
  const phase = input.cursor?.phase ?? "chain_links";
  if (!isRefreshChainRetentionPhase(phase)) {
    throw new TypeError("invalid refresh-chain retention cursor phase");
  }
  const after = decodePostgresRetentionCursor(input.cursor?.after);
  const cutoff =
    phase === "consumed_codes"
      ? toDate(input.consumedCodeBefore)
      : toDate(input.chainBefore);
  const rows = await selectRetentionCandidates(
    client,
    phase,
    cutoff,
    after,
    input.limit,
  );
  const counts = emptyRefreshChainPruneResult();
  for (const row of rows) {
    const deleted = await deleteRetentionCandidate(client, phase, row, cutoff);
    if (deleted) incrementRetentionCount(counts, phase);
  }
  const last = rows.at(-1);
  if (rows.length === input.limit && last) {
    return {
      ...counts,
      scanned: rows.length,
      done: false,
      cursor: {
        phase,
        after: encodePostgresRetentionCursor(last),
      },
    };
  }
  const nextPhase = nextRefreshChainRetentionPhase(phase);
  return {
    ...counts,
    scanned: rows.length,
    done: nextPhase === undefined,
    ...(nextPhase ? { cursor: { phase: nextPhase } } : {}),
  };
}

async function selectRetentionCandidates(
  client: PostgresQueryClient,
  phase: RefreshChainRetentionPhase,
  cutoff: Date,
  after: { readonly at: Date; readonly keys: readonly string[] },
  limit: number,
): Promise<RetentionKeyRow[]> {
  if (phase === "chain_links") {
    return (
      await runQuery<RetentionKeyRow>(
        client,
        `SELECT created_at AS retention_at, parent_token_hash AS key_a
           FROM accounts_v1.refresh_chain_links
          WHERE created_at <= $1
            AND (created_at, parent_token_hash) > ($2, $3)
          ORDER BY created_at, parent_token_hash
          LIMIT $4`,
        [cutoff, after.at, after.keys[0] ?? "", limit],
      )
    ).rows;
  }
  if (phase === "chain_access_tokens") {
    return (
      await runQuery<RetentionKeyRow>(
        client,
        `SELECT created_at AS retention_at, root_token_hash AS key_a,
                access_token_hash AS key_b
           FROM accounts_v1.refresh_chain_access_tokens
          WHERE created_at <= $1
            AND (created_at, root_token_hash, access_token_hash) >
                ($2, $3, $4)
          ORDER BY created_at, root_token_hash, access_token_hash
          LIMIT $5`,
        [cutoff, after.at, after.keys[0] ?? "", after.keys[1] ?? "", limit],
      )
    ).rows;
  }
  if (phase === "revoked_roots") {
    return (
      await runQuery<RetentionKeyRow>(
        client,
        `SELECT revoked_at AS retention_at, root_token_hash AS key_a
           FROM accounts_v1.revoked_refresh_roots
          WHERE revoked_at <= $1
            AND (revoked_at, root_token_hash) > ($2, $3)
          ORDER BY revoked_at, root_token_hash
          LIMIT $4`,
        [cutoff, after.at, after.keys[0] ?? "", limit],
      )
    ).rows;
  }
  if (phase === "consumed_codes") {
    return (
      await runQuery<RetentionKeyRow>(
        client,
        `SELECT consumed.consumed_at AS retention_at,
                consumed.code_hash AS key_a
           FROM accounts_v1.consumed_authorization_codes AS consumed
          WHERE consumed.consumed_at <= $1
            AND NOT EXISTS (
              SELECT 1
                FROM accounts_v1.authorization_code_redemptions AS redemption
               WHERE redemption.code_hash = consumed.code_hash
            )
            AND (consumed.consumed_at, consumed.code_hash) > ($2, $3)
          ORDER BY consumed.consumed_at, consumed.code_hash
          LIMIT $4`,
        [cutoff, after.at, after.keys[0] ?? "", limit],
      )
    ).rows;
  }
  if (phase === "auth_code_token_links") {
    return (
      await runQuery<RetentionKeyRow>(
        client,
        `SELECT auth_link.created_at AS retention_at,
                auth_link.code_hash AS key_a,
                auth_link.access_token_hash AS key_b,
                auth_link.refresh_root_hash AS key_c
           FROM accounts_v1.auth_code_token_links AS auth_link
          WHERE auth_link.created_at <= $1
            AND NOT EXISTS (
              SELECT 1
                FROM accounts_v1.authorization_code_redemptions AS redemption
               WHERE redemption.code_hash = auth_link.code_hash
            )
            AND (auth_link.created_at, auth_link.code_hash,
                 auth_link.access_token_hash, auth_link.refresh_root_hash) >
                ($2, $3, $4, $5)
          ORDER BY auth_link.created_at, auth_link.code_hash,
                   auth_link.access_token_hash, auth_link.refresh_root_hash
          LIMIT $6`,
        [
          cutoff,
          after.at,
          after.keys[0] ?? "",
          after.keys[1] ?? "",
          after.keys[2] ?? "",
          limit,
        ],
      )
    ).rows;
  }
  return (
    await runQuery<RetentionKeyRow>(
      client,
      `SELECT COALESCE(replayed_at, issued_at) AS retention_at,
              code_hash AS key_a, record_version
         FROM accounts_v1.authorization_code_redemptions AS redemption
        WHERE redemption.state IN ('issued', 'replayed')
          AND COALESCE(redemption.replayed_at, redemption.issued_at) <= $1
          AND NOT EXISTS (
            SELECT 1
             FROM accounts_v1.refresh_chain_links AS chain
             WHERE chain.created_at > $1
               AND (
                 chain.root_token_hash = redemption.refresh_token_hash
                 OR EXISTS (
                   SELECT 1
                     FROM accounts_v1.auth_code_token_links AS auth_link
                    WHERE auth_link.code_hash = redemption.code_hash
                      AND NULLIF(auth_link.refresh_root_hash, '') =
                          chain.root_token_hash
                 )
               )
          )
          AND (COALESCE(redemption.replayed_at, redemption.issued_at),
               redemption.code_hash) > ($2, $3)
        ORDER BY COALESCE(redemption.replayed_at, redemption.issued_at),
                 redemption.code_hash
        LIMIT $4`,
      [cutoff, after.at, after.keys[0] ?? "", limit],
    )
  ).rows;
}

async function deleteRetentionCandidate(
  client: PostgresQueryClient,
  phase: RefreshChainRetentionPhase,
  row: RetentionKeyRow,
  cutoff: Date,
): Promise<boolean> {
  let result;
  if (phase === "chain_links") {
    result = await runQuery(
      client,
      `DELETE FROM accounts_v1.refresh_chain_links
        WHERE parent_token_hash = $1 RETURNING parent_token_hash`,
      [row.key_a],
    );
  } else if (phase === "chain_access_tokens") {
    result = await runQuery(
      client,
      `DELETE FROM accounts_v1.refresh_chain_access_tokens
        WHERE root_token_hash = $1 AND access_token_hash = $2
        RETURNING root_token_hash`,
      [row.key_a, requiredRetentionKey(row.key_b)],
    );
  } else if (phase === "revoked_roots") {
    result = await runQuery(
      client,
      `DELETE FROM accounts_v1.revoked_refresh_roots
        WHERE root_token_hash = $1 AND revoked_at = $2
        RETURNING root_token_hash`,
      [row.key_a, toDate(retentionTimestamp(row.retention_at))],
    );
  } else if (phase === "consumed_codes") {
    result = await runQuery(
      client,
      `DELETE FROM accounts_v1.consumed_authorization_codes
        WHERE code_hash = $1 AND consumed_at = $2
          AND NOT EXISTS (
            SELECT 1
              FROM accounts_v1.authorization_code_redemptions AS redemption
             WHERE redemption.code_hash = $1
          )
        RETURNING code_hash`,
      [row.key_a, toDate(retentionTimestamp(row.retention_at))],
    );
  } else if (phase === "auth_code_token_links") {
    result = await runQuery(
      client,
      `DELETE FROM accounts_v1.auth_code_token_links
        WHERE code_hash = $1 AND access_token_hash = $2
          AND refresh_root_hash = $3
          AND NOT EXISTS (
            SELECT 1
              FROM accounts_v1.authorization_code_redemptions AS redemption
             WHERE redemption.code_hash = $1
          )
        RETURNING code_hash`,
      [
        row.key_a,
        requiredRetentionKey(row.key_b),
        requiredRetentionKey(row.key_c),
      ],
    );
  } else {
    result = await runQuery(
      client,
      `DELETE FROM accounts_v1.authorization_code_redemptions
        WHERE code_hash = $1 AND record_version = $2
          AND state IN ('issued', 'replayed')
          AND COALESCE(replayed_at, issued_at) <= $3
          AND NOT EXISTS (
            SELECT 1
             FROM accounts_v1.refresh_chain_links AS chain
             WHERE chain.created_at > $3
               AND (
                 chain.root_token_hash = (
                   SELECT current.refresh_token_hash
                     FROM accounts_v1.authorization_code_redemptions AS current
                    WHERE current.code_hash = $1
                 )
                 OR EXISTS (
                   SELECT 1
                     FROM accounts_v1.auth_code_token_links AS auth_link
                    WHERE auth_link.code_hash = $1
                      AND NULLIF(auth_link.refresh_root_hash, '') =
                          chain.root_token_hash
                 )
               )
          )
        RETURNING code_hash`,
      [row.key_a, requiredRetentionKey(row.record_version), cutoff],
    );
  }
  return result.rows.length > 0;
}

function incrementRetentionCount(
  counts: RefreshChainPruneResult,
  phase: RefreshChainRetentionPhase,
): void {
  if (phase === "chain_links") counts.chainLinks += 1;
  else if (phase === "chain_access_tokens") counts.chainAccessTokens += 1;
  else if (phase === "revoked_roots") counts.revokedRoots += 1;
  else if (phase === "consumed_codes") counts.consumedCodes += 1;
  else if (phase === "auth_code_token_links") counts.authCodeTokenLinks += 1;
  else counts.authorizationCodeRedemptions += 1;
}

function encodePostgresRetentionCursor(row: RetentionKeyRow): string {
  const values: Array<number | string> = [
    retentionTimestamp(row.retention_at),
    row.key_a,
  ];
  if (row.key_b !== undefined) values.push(row.key_b);
  if (row.key_c !== undefined) values.push(row.key_c);
  return JSON.stringify(values);
}

function decodePostgresRetentionCursor(value: string | undefined): {
  readonly at: Date;
  readonly keys: readonly string[];
} {
  if (value === undefined) return { at: new Date(0), keys: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("invalid Postgres refresh-chain retention cursor");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 2 ||
    parsed.length > 4 ||
    !Number.isFinite(parsed[0]) ||
    parsed.slice(1).some((entry) => typeof entry !== "string")
  ) {
    throw new TypeError("invalid Postgres refresh-chain retention cursor");
  }
  return {
    at: new Date(Number(parsed[0])),
    keys: parsed.slice(1) as string[],
  };
}

function retentionTimestamp(value: Date | string | number): number {
  const at =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  if (!Number.isFinite(at)) {
    throw new TypeError("invalid Postgres refresh-chain retention timestamp");
  }
  return at;
}

function requiredRetentionKey(value: string | undefined): string {
  if (value === undefined) {
    throw new TypeError("incomplete Postgres refresh-chain retention key");
  }
  return value;
}

function assertRefreshChainRetentionPageInput(
  input: RefreshChainRetentionPageInput,
): void {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0 ||
    input.limit > MAX_REFRESH_CHAIN_RETENTION_ROWS
  ) {
    throw new TypeError(
      `refresh-chain retention limit must be between 1 and ${MAX_REFRESH_CHAIN_RETENTION_ROWS}`,
    );
  }
  if (
    !Number.isFinite(input.chainBefore) ||
    !Number.isFinite(input.consumedCodeBefore)
  ) {
    throw new TypeError("refresh-chain retention cutoffs must be finite");
  }
}
