import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  D1_ACCOUNTS_STORE_INIT_SQL,
  D1AccountsStore,
  type D1Database,
} from "../../../../accounts/service/src/d1-store.ts";
import { PostgresAccountsStore } from "../../../../accounts/service/src/postgres-store.ts";
import type {
  PostgresQueryClient,
  PostgresQueryResult,
} from "../../../../accounts/service/src/postgres/internal.ts";
import {
  runRefreshChainRetention,
  type RefreshChainRetentionCursor,
  type RefreshChainRetentionPageStore,
} from "../../../../accounts/service/src/refresh-chain-retention.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { loadD1AccountsMigrationCatalog } from "../../../../accounts/service/src/d1-migrations.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

interface DrainResult {
  readonly chainLinks: number;
  readonly chainAccessTokens: number;
  readonly revokedRoots: number;
  readonly consumedCodes: number;
  readonly authCodeTokenLinks: number;
}

async function drainOneRowAtATime(
  store: RefreshChainRetentionPageStore,
  now: number,
): Promise<DrainResult> {
  const totals: DrainResult = {
    chainLinks: 0,
    chainAccessTokens: 0,
    revokedRoots: 0,
    consumedCodes: 0,
    authCodeTokenLinks: 0,
  };
  let cursor: RefreshChainRetentionCursor | undefined;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const result = await runRefreshChainRetention(store, {
      now,
      refreshTokenTtlMs: 1,
      authorizationCodeTtlMs: 1,
      maxRows: 1,
      pageSize: 1,
      ...(cursor ? { cursor } : {}),
    });
    expect(result.scanned).toBeLessThanOrEqual(1);
    totals.chainLinks += result.chainLinks;
    totals.chainAccessTokens += result.chainAccessTokens;
    totals.revokedRoots += result.revokedRoots;
    totals.consumedCodes += result.consumedCodes;
    totals.authCodeTokenLinks += result.authCodeTokenLinks;
    if (result.done) return totals;
    cursor = result.cursor;
  }
  throw new Error("refresh-chain retention did not converge");
}

test("in-memory refresh-chain retention matches the bounded page contract", async () => {
  const store = new InMemoryAccountsStore();
  expect(store.addRefreshChainLink("root", "child")).toBe(true);
  expect(store.addRefreshChainLink("child", "grandchild")).toBe(true);
  store.linkAccessTokenToRefreshChain("root", "access-a");
  store.linkAccessTokenToRefreshChain("root", "access-b");
  store.markAuthorizationCodeConsumed("code");
  store.linkAccessTokenToAuthCode("code", "access-a", "root");
  store.revokeRefreshChain("root");

  expect(await drainOneRowAtATime(store, Date.now() + 10)).toEqual({
    chainLinks: 2,
    chainAccessTokens: 2,
    revokedRoots: 1,
    consumedCodes: 1,
    authCodeTokenLinks: 1,
  });
});

test("D1 refresh-chain retention uses timestamp+key indexes and does not skip equal timestamps", async () => {
  const db = new SqliteFakeD1();
  await db.exec(D1_ACCOUNTS_STORE_INIT_SQL);
  const retentionMigration = (await loadD1AccountsMigrationCatalog()).migrations.find(
    (migration) => migration.name === "refresh_chain_retention_indexes",
  );
  expect(retentionMigration).toBeDefined();
  for (const statement of retentionMigration!.body) {
    await db.prepare(statement.sql).bind(...statement.params).run();
  }
  await Promise.all([
    insertD1Document(db, "refresh_chain_links", "a", {
      parentHash: "a",
      childHash: "a-child",
      rootHash: "a",
      createdAt: 100,
    }),
    insertD1Document(db, "refresh_chain_links", "b", {
      parentHash: "b",
      childHash: "b-child",
      rootHash: "b",
      createdAt: 100,
    }),
    insertD1Document(db, "refresh_chain_links", "c", {
      parentHash: "c",
      childHash: "c-child",
      rootHash: "c",
      createdAt: 100,
    }),
    insertD1Document(db, "refresh_chain_access_tokens", "root\naccess", {
      rootHash: "root",
      accessTokenHash: "access",
      createdAt: 101,
    }),
    insertD1Document(db, "revoked_refresh_roots", "root", {
      rootHash: "root",
      revokedAt: 102,
    }),
    insertD1Document(db, "consumed_authorization_codes", "code", {
      codeHash: "code",
      consumedAt: 103,
    }),
    insertD1Document(db, "auth_code_token_links", "code\naccess\nroot", {
      codeHash: "code",
      accessTokenHash: "access",
      refreshRootHash: "root",
      createdAt: 104,
    }),
  ]);

  const plan = await db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT key,
              CAST(json_extract(document, '$.createdAt') AS INTEGER)
         FROM takosumi_accounts_documents
              INDEXED BY takosumi_accounts_refresh_chain_links_retention
        WHERE bucket = 'refresh_chain_links'
          AND CAST(json_extract(document, '$.createdAt') AS INTEGER) <= ?
          AND (CAST(json_extract(document, '$.createdAt') AS INTEGER), key) >
              (?, ?)
        ORDER BY CAST(json_extract(document, '$.createdAt') AS INTEGER), key
        LIMIT ?`,
    )
    .bind(1_000, -1, "", 1)
    .all<{ detail: string }>();
  expect(plan.results?.map((row) => row.detail).join("\n")).toContain(
    "takosumi_accounts_refresh_chain_links_retention",
  );

  const store = new D1AccountsStore(db);
  expect(await drainOneRowAtATime(store, 1_000)).toEqual({
    chainLinks: 3,
    chainAccessTokens: 1,
    revokedRoots: 1,
    consumedCodes: 1,
    authCodeTokenLinks: 1,
  });
});

test("Postgres refresh-chain retention follows the same timestamp+key cursor contract", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA accounts_v1;
      CREATE TABLE accounts_v1.refresh_chain_links (
        parent_token_hash text PRIMARY KEY,
        child_token_hash text NOT NULL,
        root_token_hash text NOT NULL,
        created_at timestamptz NOT NULL
      );
      CREATE TABLE accounts_v1.refresh_chain_access_tokens (
        root_token_hash text NOT NULL,
        access_token_hash text NOT NULL,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (root_token_hash, access_token_hash)
      );
      CREATE TABLE accounts_v1.revoked_refresh_roots (
        root_token_hash text PRIMARY KEY,
        revoked_at timestamptz NOT NULL
      );
      CREATE TABLE accounts_v1.consumed_authorization_codes (
        code_hash text PRIMARY KEY,
        consumed_at timestamptz NOT NULL
      );
      CREATE TABLE accounts_v1.auth_code_token_links (
        code_hash text NOT NULL,
        access_token_hash text NOT NULL,
        refresh_root_hash text NOT NULL,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (code_hash, access_token_hash, refresh_root_hash)
      );
    `);
    const migration = await Bun.file(
      new URL(
        "../../../../accounts/service/migrations/036_refresh_chain_retention_indexes.sql",
        import.meta.url,
      ),
    ).text();
    await db.exec(migration);
    const at = new Date(100);
    await db.query(
      `INSERT INTO accounts_v1.refresh_chain_links
       VALUES ($1, $2, $3, $4), ($5, $6, $7, $8), ($9, $10, $11, $12)`,
      [
        "a",
        "a-child",
        "a",
        at,
        "b",
        "b-child",
        "b",
        at,
        "c",
        "c-child",
        "c",
        at,
      ],
    );
    await db.query(
      `INSERT INTO accounts_v1.refresh_chain_access_tokens
       VALUES ($1, $2, $3)`,
      ["root", "access", new Date(101)],
    );
    await db.query(
      `INSERT INTO accounts_v1.revoked_refresh_roots VALUES ($1, $2)`,
      ["root", new Date(102)],
    );
    await db.query(
      `INSERT INTO accounts_v1.consumed_authorization_codes VALUES ($1, $2)`,
      ["code", new Date(103)],
    );
    await db.query(
      `INSERT INTO accounts_v1.auth_code_token_links
       VALUES ($1, $2, $3, $4)`,
      ["code", "access", "root", new Date(104)],
    );

    const store = new PostgresAccountsStore(pgliteClient(db));
    expect(await drainOneRowAtATime(store, 1_000)).toEqual({
      chainLinks: 3,
      chainAccessTokens: 1,
      revokedRoots: 1,
      consumedCodes: 1,
      authCodeTokenLinks: 1,
    });
  } finally {
    await db.close();
  }
});

async function insertD1Document(
  db: D1Database,
  bucket: string,
  key: string,
  document: unknown,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES (?, ?, ?, ?)",
    )
    .bind(bucket, key, JSON.stringify(document), 1)
    .run();
}

function pgliteClient(db: PGlite): PostgresQueryClient {
  return {
    async queryObject<T>(
      sql: string,
      args: readonly unknown[] = [],
    ): Promise<PostgresQueryResult<T>> {
      const result = await db.query(sql, [...args]);
      return { rows: result.rows as T[] };
    },
  };
}
