import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

import {
  type AccountsStore,
  D1AccountsStore,
  InMemoryAccountsStore,
  PostgresAccountsStore,
  type PersonalAccessTokenInventoryCursor,
  type PersonalAccessTokenInventoryPage,
  type PostgresQueryClient,
  type PostgresQueryResult,
} from "../../../../accounts/service/src/mod.ts";
import type {
  D1Database,
  D1ExecResult,
  D1PreparedStatement,
  D1Result,
  D1Value,
} from "../../../../accounts/service/src/d1-store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const SUBJECT = "tsub_pat_inventory" as const;
const OTHER_SUBJECT = "tsub_pat_inventory_other" as const;
const TOKENS = [
  {
    secret: "takpat_inventory_secret_a",
    record: {
      tokenId: "pat_inventory_a",
      tokenPrefix: "takpat_inventor",
      subject: SUBJECT,
      name: "A",
      scopes: ["read"] as const,
      createdAt: 1_000,
    },
  },
  {
    secret: "takpat_inventory_secret_b",
    record: {
      tokenId: "pat_inventory_b",
      tokenPrefix: "takpat_inventor",
      subject: SUBJECT,
      name: "B",
      scopes: ["read", "write"] as const,
      workspaceId: "ws_inventory",
      createdAt: 1_000,
      revokedAt: 1_500,
    },
  },
  {
    secret: "takpat_inventory_secret_c",
    record: {
      tokenId: "pat_inventory_c",
      tokenPrefix: "takpat_inventor",
      subject: SUBJECT,
      name: "C",
      scopes: ["admin"] as const,
      createdAt: 2_000,
      expiresAt: 3_000,
      lastUsedAt: 2_500,
    },
  },
  {
    secret: "takpat_inventory_secret_other",
    record: {
      tokenId: "pat_inventory_other",
      tokenPrefix: "takpat_inventor",
      subject: OTHER_SUBJECT,
      name: "Other",
      scopes: ["read"] as const,
      createdAt: 500,
    },
  },
] as const;

test("in-memory PAT inventory binds total, keyset order, and stale cursor evidence", async () => {
  const store = new InMemoryAccountsStore();
  await seedTokens(store);
  await expectCanonicalInventoryPages(store);
});

test("D1 PAT inventory has memory parity in one read statement", async () => {
  const inner = new SqliteFakeD1();
  const db = new CountingD1(inner);
  const store = new D1AccountsStore(db);
  await store.initialize();
  await seedTokens(store);

  db.reset();
  await expectCanonicalInventoryPages(store);
  expect(db.prepareCalls).toBe(4);
  expect(db.allCalls).toBe(4);
  expect(db.runCalls).toBe(0);
  expect(db.batchCalls).toBe(0);
  expect(db.execCalls).toBe(0);
  expect(
    db.sql.every((sql) => sql.trimStart().toLowerCase().startsWith("with")),
  ).toBe(true);
});

test("Postgres PAT inventory has memory parity in one statement", async () => {
  const db = new PGlite();
  await db.exec(`
    create schema accounts_v1;
    create table accounts_v1.accounts (subject text primary key);
    create table accounts_v1.personal_access_tokens (
      token_id text primary key,
      token_hash text not null unique,
      token_prefix text not null,
      subject text not null references accounts_v1.accounts(subject),
      name text not null,
      scopes text[] not null,
      workspace_id text,
      created_at timestamptz not null,
      expires_at timestamptz,
      revoked_at timestamptz,
      last_used_at timestamptz
    );
    create index personal_access_tokens_subject_idx
      on accounts_v1.personal_access_tokens(subject, created_at, token_id);
    insert into accounts_v1.accounts(subject)
      values ('${SUBJECT}'), ('${OTHER_SUBJECT}');
  `);
  const client = new CountingPostgresClient(db);
  const store = new PostgresAccountsStore(client);
  await seedTokens(store);

  client.calls.length = 0;
  await expectCanonicalInventoryPages(store);
  expect(client.calls).toHaveLength(4);
  expect(client.calls.every((call) => call.sql.trimStart().startsWith("with")))
    .toBe(true);
  await db.close();
});

async function expectCanonicalInventoryPages(store: AccountsStore) {
  const first = await store.listPersonalAccessTokenInventoryPage({
    subject: SUBJECT,
    limit: 1,
  });
  expectInventoryPage(first, {
    ids: ["pat_inventory_a", "pat_inventory_b"],
    total: 3,
    cursorValid: true,
  });
  expect(JSON.stringify(first)).not.toContain("takpat_inventory_secret");

  const cursor: PersonalAccessTokenInventoryCursor = {
    createdAt: 1_000,
    tokenId: "pat_inventory_a",
  };
  const second = await store.listPersonalAccessTokenInventoryPage({
    subject: SUBJECT,
    limit: 1,
    cursor,
  });
  expectInventoryPage(second, {
    ids: ["pat_inventory_b", "pat_inventory_c"],
    total: 3,
    cursorValid: true,
  });

  const end = await store.listPersonalAccessTokenInventoryPage({
    subject: SUBJECT,
    limit: 2,
    cursor: { createdAt: 1_000, tokenId: "pat_inventory_b" },
  });
  expectInventoryPage(end, {
    ids: ["pat_inventory_c"],
    total: 3,
    cursorValid: true,
  });

  const stale = await store.listPersonalAccessTokenInventoryPage({
    subject: SUBJECT,
    limit: 2,
    cursor: { createdAt: 1_000, tokenId: "pat_inventory_missing" },
  });
  expectInventoryPage(stale, {
    ids: ["pat_inventory_c"],
    total: 3,
    cursorValid: false,
  });
}

function expectInventoryPage(
  actual: PersonalAccessTokenInventoryPage,
  expected: {
    readonly ids: readonly string[];
    readonly total: number;
    readonly cursorValid: boolean;
  },
) {
  expect(actual.items.map((token) => token.tokenId)).toEqual(expected.ids);
  expect(actual.total).toBe(expected.total);
  expect(actual.cursorValid).toBe(expected.cursorValid);
}

async function seedTokens(store: AccountsStore) {
  for (const token of TOKENS) {
    await store.savePersonalAccessToken(token.secret, token.record);
  }
}

class CountingD1 implements D1Database {
  readonly sql: string[] = [];
  prepareCalls = 0;
  allCalls = 0;
  runCalls = 0;
  batchCalls = 0;
  execCalls = 0;

  constructor(readonly inner: D1Database) {}

  prepare(sql: string): D1PreparedStatement {
    this.prepareCalls += 1;
    this.sql.push(sql);
    return new CountingD1Statement(this, this.inner.prepare(sql));
  }

  batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    this.batchCalls += 1;
    return this.inner.batch<T>(statements);
  }

  exec(sql: string): Promise<D1ExecResult> {
    this.execCalls += 1;
    return this.inner.exec(sql);
  }

  reset() {
    this.sql.length = 0;
    this.prepareCalls = 0;
    this.allCalls = 0;
    this.runCalls = 0;
    this.batchCalls = 0;
    this.execCalls = 0;
  }
}

class CountingD1Statement implements D1PreparedStatement {
  constructor(
    readonly owner: CountingD1,
    readonly inner: D1PreparedStatement,
  ) {}

  bind(...values: readonly D1Value[]): D1PreparedStatement {
    return new CountingD1Statement(this.owner, this.inner.bind(...values));
  }

  all<T = unknown>(): Promise<D1Result<T>> {
    this.owner.allCalls += 1;
    return this.inner.all<T>();
  }

  first<T = unknown>(column?: string): Promise<T | null> {
    return this.inner.first<T>(column);
  }

  run<T = unknown>(): Promise<D1Result<T>> {
    this.owner.runCalls += 1;
    return this.inner.run<T>();
  }
}

class CountingPostgresClient implements PostgresQueryClient {
  readonly calls: Array<{ sql: string; args: readonly unknown[] }> = [];

  constructor(readonly db: PGlite) {}

  async queryObject<T>(
    sql: string,
    args: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<T>> {
    this.calls.push({ sql, args });
    const result = await this.db.query<T>(sql, [...args]);
    return { rows: [...result.rows] };
  }
}
