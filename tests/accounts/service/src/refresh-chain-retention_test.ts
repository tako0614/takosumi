import { expect, spyOn, test } from "bun:test";
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
import { listD1AccountsMigrations } from "../../../../cli/src/cli-accounts-db.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

interface DrainResult {
  readonly chainLinks: number;
  readonly chainAccessTokens: number;
  readonly revokedRoots: number;
  readonly consumedCodes: number;
  readonly authCodeTokenLinks: number;
  readonly authorizationCodeRedemptions: number;
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
    authorizationCodeRedemptions: 0,
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
    totals.authorizationCodeRedemptions += result.authorizationCodeRedemptions;
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
  store.saveAuthorizationCode("code", {
    clientId: "client",
    redirectUri: "https://client.example.test/callback",
    scope: "openid offline_access",
    subject: "subject",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
    expiresAt: Date.now() + 60_000,
  });
  const opened = store.openAuthorizationCodeRedemption("code");
  expect(opened.status).toBe("active");
  if (opened.status !== "active") return;
  const claimed = store.claimValidatedAuthorizationCode(opened.candidate);
  expect(claimed.status).toBe("claimed");
  if (claimed.status !== "claimed") return;
  expect(
    store.finalizeAuthorizationCodeRedemption({
      code: "code",
      claimId: claimed.claimId,
      accessToken: "access-a",
      accessRecord: {
        clientId: "client",
        scope: "openid offline_access",
        subject: "subject",
        expiresAt: Date.now() + 60_000,
      },
      refreshToken: "root",
      refreshRecord: {
        clientId: "client",
        scope: "openid offline_access",
        subject: "subject",
        expiresAt: Date.now() + 60_000,
      },
    }),
  ).toEqual({ status: "issued" });
  store.revokeRefreshChain("root");

  expect(await drainOneRowAtATime(store, Date.now() + 10)).toEqual({
    chainLinks: 2,
    chainAccessTokens: 2,
    revokedRoots: 1,
    consumedCodes: 0,
    authCodeTokenLinks: 0,
    authorizationCodeRedemptions: 1,
  });
  expect(await drainOneRowAtATime(store, Date.now() + 10)).toEqual({
    chainLinks: 0,
    chainAccessTokens: 0,
    revokedRoots: 0,
    consumedCodes: 1,
    authCodeTokenLinks: 1,
    authorizationCodeRedemptions: 0,
  });
});

test("authorization-code lineage evidence follows the refresh-chain cutoff", async () => {
  const store = new InMemoryAccountsStore();
  const code = "retention-lineage-code";
  await store.saveAuthorizationCode(code, {
    clientId: "client",
    redirectUri: "https://client.example.test/callback",
    scope: "openid offline_access",
    subject: "subject",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
    expiresAt: Date.now() + 60_000,
  });
  const opened = await store.openAuthorizationCodeRedemption(code);
  if (opened.status !== "active") throw new Error("expected active code");
  const claimed = await store.claimValidatedAuthorizationCode(opened.candidate);
  if (claimed.status !== "claimed") throw new Error("expected claim winner");
  expect(
    await store.finalizeAuthorizationCodeRedemption({
      code,
      claimId: claimed.claimId,
      accessToken: "retention-lineage-access",
      accessRecord: {
        clientId: "client",
        scope: "openid offline_access",
        subject: "subject",
        expiresAt: Date.now() + 60_000,
      },
      refreshToken: "retention-lineage-refresh",
      refreshRecord: {
        clientId: "client",
        scope: "openid offline_access",
        subject: "subject",
        expiresAt: Date.now() + 60_000,
      },
    }),
  ).toEqual({ status: "issued" });

  const authCodeOnlyCutoff = {
    chainBefore: 0,
    consumedCodeBefore: Date.now() + 60_000,
    limit: 10,
  };
  expect(
    await store.pruneRefreshChainPage({
      ...authCodeOnlyCutoff,
      cursor: { phase: "consumed_codes" },
    }),
  ).toMatchObject({ consumedCodes: 0, scanned: 0 });
  expect(
    await store.pruneRefreshChainPage({
      ...authCodeOnlyCutoff,
      cursor: { phase: "auth_code_token_links" },
    }),
  ).toMatchObject({ authCodeTokenLinks: 0, scanned: 0 });
  expect(
    await store.pruneRefreshChainPage({
      ...authCodeOnlyCutoff,
      cursor: { phase: "authorization_code_redemptions" },
    }),
  ).toMatchObject({ authorizationCodeRedemptions: 0, scanned: 0 });

  const refreshChainCutoff = Date.now() + 60_000;
  expect(
    await store.pruneRefreshChainPage({
      ...authCodeOnlyCutoff,
      chainBefore: refreshChainCutoff,
      cursor: { phase: "consumed_codes" },
    }),
  ).toMatchObject({ consumedCodes: 0, scanned: 0 });
  expect(
    await store.pruneRefreshChainPage({
      ...authCodeOnlyCutoff,
      chainBefore: refreshChainCutoff,
      cursor: { phase: "auth_code_token_links" },
    }),
  ).toMatchObject({ authCodeTokenLinks: 0, scanned: 0 });
  expect(
    await store.pruneRefreshChainPage({
      ...authCodeOnlyCutoff,
      chainBefore: refreshChainCutoff,
      cursor: { phase: "authorization_code_redemptions" },
    }),
  ).toMatchObject({ authorizationCodeRedemptions: 1, scanned: 1 });
  expect(
    await store.pruneRefreshChainPage({
      ...authCodeOnlyCutoff,
      chainBefore: refreshChainCutoff,
      cursor: { phase: "consumed_codes" },
    }),
  ).toMatchObject({ consumedCodes: 1, scanned: 1 });
  expect(
    await store.pruneRefreshChainPage({
      ...authCodeOnlyCutoff,
      chainBefore: refreshChainCutoff,
      cursor: { phase: "auth_code_token_links" },
    }),
  ).toMatchObject({ authCodeTokenLinks: 1, scanned: 1 });
});

test("guarded expand-window evidence does not starve bounded lifecycle retention", async () => {
  let now = 100;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const store = new InMemoryAccountsStore();
    for (let index = 0; index < 101; index += 1) {
      const code = `retention-saturation-code-${index}`;
      await store.saveAuthorizationCode(code, {
        clientId: "client",
        redirectUri: "https://client.example.test/callback",
        scope: "openid",
        subject: "subject",
        codeChallenge: "challenge",
        codeChallengeMethod: "S256",
        expiresAt: 10_000,
      });
      const opened = await store.openAuthorizationCodeRedemption(code);
      if (opened.status !== "active") throw new Error("expected active code");
      const claimed = await store.claimValidatedAuthorizationCode(
        opened.candidate,
      );
      if (claimed.status !== "claimed") throw new Error("expected claim");
      expect(
        await store.finalizeAuthorizationCodeRedemption({
          code,
          claimId: claimed.claimId,
          accessToken: `retention-saturation-access-${index}`,
          accessRecord: {
            clientId: "client",
            scope: "openid",
            subject: "subject",
            expiresAt: 10_000,
          },
        }),
      ).toEqual({ status: "issued" });
    }

    now = 1_000;
    const result = await runRefreshChainRetention(store, {
      now,
      refreshTokenTtlMs: 1,
      authorizationCodeTtlMs: 1,
      maxRows: 100,
      pageSize: 100,
      cursor: { phase: "consumed_codes" },
    });
    expect(result).toMatchObject({
      scanned: 100,
      authCodeTokenLinks: 0,
      authorizationCodeRedemptions: 100,
      done: false,
      cursor: { phase: "authorization_code_redemptions" },
    });
  } finally {
    clock.mockRestore();
  }
});

test("terminal lifecycle retention follows the latest refresh-family activity", async () => {
  let now = 100;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const store = new InMemoryAccountsStore();
    const code = "retention-rolling-family-code";
    await store.saveAuthorizationCode(code, {
      clientId: "client",
      redirectUri: "https://client.example.test/callback",
      scope: "openid offline_access",
      subject: "subject",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      expiresAt: 10_000,
    });
    const opened = await store.openAuthorizationCodeRedemption(code);
    if (opened.status !== "active") throw new Error("expected active code");
    const claimed = await store.claimValidatedAuthorizationCode(
      opened.candidate,
    );
    if (claimed.status !== "claimed") throw new Error("expected claim");
    expect(
      await store.finalizeAuthorizationCodeRedemption({
        code,
        claimId: claimed.claimId,
        accessToken: "retention-rolling-family-access",
        accessRecord: {
          clientId: "client",
          scope: "openid offline_access",
          subject: "subject",
          expiresAt: 10_000,
        },
        refreshToken: "retention-rolling-family-root",
        refreshRecord: {
          clientId: "client",
          scope: "openid offline_access",
          subject: "subject",
          expiresAt: 10_000,
        },
      }),
    ).toEqual({ status: "issued" });
    now = 200;
    expect(
      store.addRefreshChainLink(
        "retention-rolling-family-root",
        "retention-rolling-family-child",
      ),
    ).toBe(true);

    expect(
      await store.pruneRefreshChainPage({
        chainBefore: 150,
        consumedCodeBefore: 150,
        limit: 10,
        cursor: { phase: "authorization_code_redemptions" },
      }),
    ).toMatchObject({ authorizationCodeRedemptions: 0, scanned: 1 });
    expect(await store.openAuthorizationCodeRedemption(code)).toEqual({
      status: "replayed",
    });
  } finally {
    clock.mockRestore();
  }
});

test("D1 refresh-chain retention uses timestamp+key indexes and does not skip equal timestamps", async () => {
  const db = new SqliteFakeD1();
  await db.exec(D1_ACCOUNTS_STORE_INIT_SQL);
  const retentionMigration = listD1AccountsMigrations().find(
    (migration) => migration.name === "refresh_chain_retention_indexes",
  );
  expect(retentionMigration).toBeDefined();
  await db.exec(retentionMigration!.sql);
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
  const lifecycleMigration = listD1AccountsMigrations().find(
    (migration) => migration.name === "authorization_code_redemptions",
  );
  expect(lifecycleMigration).toBeDefined();
  await db.exec(lifecycleMigration!.sql);

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
  const retentionNow = Date.now() + 1_000;
  expect(await drainOneRowAtATime(store, retentionNow)).toEqual({
    chainLinks: 3,
    chainAccessTokens: 1,
    revokedRoots: 1,
    consumedCodes: 0,
    authCodeTokenLinks: 0,
    authorizationCodeRedemptions: 1,
  });
  expect(await drainOneRowAtATime(store, retentionNow)).toEqual({
    chainLinks: 0,
    chainAccessTokens: 0,
    revokedRoots: 0,
    consumedCodes: 1,
    authCodeTokenLinks: 1,
    authorizationCodeRedemptions: 0,
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
      CREATE TABLE accounts_v1.authorization_code_redemptions (
        code_hash text PRIMARY KEY,
        record_version text NOT NULL,
        state text NOT NULL,
        refresh_token_hash text,
        issued_at timestamptz,
        replayed_at timestamptz
      );
      CREATE INDEX authorization_code_redemptions_terminal_retention_idx
        ON accounts_v1.authorization_code_redemptions (
          COALESCE(replayed_at, issued_at), code_hash
        )
        WHERE state IN ('issued', 'replayed');
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
    await db.query(
      `INSERT INTO accounts_v1.authorization_code_redemptions (
         code_hash, record_version, state, issued_at, replayed_at
       ) VALUES ($1, 'terminal-version', 'issued', $2, NULL),
                ($3, 'active-version', 'active', NULL, NULL)`,
      ["code", new Date(105), "active-code"],
    );

    const store = new PostgresAccountsStore(pgliteClient(db));
    expect(await drainOneRowAtATime(store, 1_000)).toEqual({
      chainLinks: 3,
      chainAccessTokens: 1,
      revokedRoots: 1,
      consumedCodes: 0,
      authCodeTokenLinks: 0,
      authorizationCodeRedemptions: 1,
    });
    expect(await drainOneRowAtATime(store, 1_000)).toEqual({
      chainLinks: 0,
      chainAccessTokens: 0,
      revokedRoots: 0,
      consumedCodes: 1,
      authCodeTokenLinks: 1,
      authorizationCodeRedemptions: 0,
    });
    expect(
      (
        await db.query<{ code_hash: string }>(
          `SELECT code_hash
             FROM accounts_v1.authorization_code_redemptions
            ORDER BY code_hash`,
        )
      ).rows,
    ).toEqual([{ code_hash: "active-code" }]);
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
