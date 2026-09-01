import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import {
  D1_ACCOUNTS_STORE_INIT_SQL,
  type D1Database,
} from "../../../accounts/service/src/d1-store.ts";
import { listD1AccountsMigrations } from "../../../cli/src/cli-accounts-db.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const migrationsDir = new URL(
  "../../../accounts/service/migrations/",
  import.meta.url,
);

async function readMigration(name: string): Promise<string> {
  return await readFile(new URL(name, migrationsDir), "utf8");
}

test("Takosumi Accounts migrations keep a unique numeric order", async () => {
  const names = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const prefixes = names.map((name) => Number(name.slice(0, 3)));
  expect(new Set(prefixes).size).toBe(prefixes.length);
  expect(prefixes).toEqual(prefixes.map((_, index) => index + 1));
});

test("Takosumi Accounts migrations preserve checksums accepted by existing databases", async () => {
  const fixture = (await Bun.file(
    new URL("./fixtures/valid-applied-catalog-v28.json", import.meta.url),
  ).json()) as AppliedCatalogFixture;
  const names = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .slice(0, fixture.migrations.length);

  expect(fixture.schemaVersion).toBe(1);
  expect(names).toEqual(fixture.migrations.map((migration) => migration.name));
  for (const migration of fixture.migrations) {
    const sql = await readMigration(migration.name);
    expect({
      version: Number(migration.name.slice(0, 3)),
      checksum: `sha256:${createHash("sha256").update(sql).digest("hex")}`,
    }).toEqual({
      version: migration.version,
      checksum: migration.checksum,
    });
  }
});

test("projection-ledger retirement moves OIDC registration to the Accounts schema", async () => {
  const migration = await readMigration(
    "032_retire_accounts_capsule_projection_ledger.sql",
  );
  expect(migration).toContain(
    "CREATE TABLE IF NOT EXISTS accounts_v1.oidc_clients",
  );
  expect(migration).toContain("capsule_id text NOT NULL UNIQUE");
  expect(migration).toContain("namespace_path text NOT NULL");
  expect(migration).toContain("FROM installation_v1.oidc_clients");
});

test("projection-ledger retirement canonicalizes Capsule and Workspace references", async () => {
  const migration = await readMigration(
    "032_retire_accounts_capsule_projection_ledger.sql",
  );
  expect(migration).toContain("RENAME COLUMN installation_id TO capsule_id");
  expect(migration).toContain("RENAME COLUMN space_id TO workspace_id");
  expect(migration).toContain("DROP COLUMN app_id");
  expect(migration).toContain("personal_access_tokens_workspace_idx");
  expect(migration).toContain("billing_usage_records_capsule_idempotency_idx");
  expect(migration).toContain("billing_usage_records_capsule_reported_at_idx");
});

test("projection-ledger retirement removes the pre-v1 projection ledger", async () => {
  const migration = await readMigration(
    "032_retire_accounts_capsule_projection_ledger.sql",
  );
  expect(migration).toContain("DROP SCHEMA installation_v1 CASCADE");
  expect(
    migration.trimEnd().endsWith("DROP SCHEMA installation_v1 CASCADE;"),
  ).toBe(true);
});

test("historical billing storage migration removed provider-specific identifiers", async () => {
  const migration = await readMigration(
    "033_generalize_billing_provider_storage.sql",
  );
  expect(migration).toContain(
    "ALTER COLUMN provider TYPE text USING provider::text",
  );
  expect(migration).toContain(
    "RENAME COLUMN stripe_customer_id TO provider_customer_id",
  );
  expect(migration).toContain(
    "RENAME COLUMN stripe_subscription_id TO provider_subscription_id",
  );
  expect(migration).toContain(
    "RENAME COLUMN stripe_price_id TO provider_price_id",
  );
  expect(migration).toContain(
    "RENAME COLUMN stripe_default_payment_method_id TO provider_default_payment_method_id",
  );
  expect(migration).toContain(
    "DROP TYPE IF EXISTS accounts_v1.billing_provider_v1",
  );
});

test("current Accounts schema removes commercial billing persistence", async () => {
  const migration = await readMigration(
    "034_remove_commercial_billing_persistence.sql",
  );
  expect(migration).toContain(
    "DROP TABLE IF EXISTS accounts_v1.billing_usage_records",
  );
  expect(migration).toContain(
    "DROP TABLE IF EXISTS accounts_v1.billing_webhook_events",
  );
  expect(migration).toContain(
    "DROP TABLE IF EXISTS accounts_v1.billing_accounts",
  );
  expect(migration).toContain(
    "DROP TYPE IF EXISTS accounts_v1.billing_account_status_v1",
  );
});

test("current Accounts schema persists the optional UserInfo picture", async () => {
  const migration = await readMigration("035_account_picture.sql");
  expect(migration).toContain("ADD COLUMN IF NOT EXISTS picture text");
});

test("refresh-chain retention has timestamp and primary-key covering indexes", async () => {
  const migration = await readMigration(
    "036_refresh_chain_retention_indexes.sql",
  );
  expect(migration).toContain(
    "refresh_chain_links(created_at, parent_token_hash)",
  );
  expect(migration).toContain(
    "refresh_chain_access_tokens(\n    created_at,\n    root_token_hash,\n    access_token_hash",
  );
  expect(migration).toContain(
    "revoked_refresh_roots(revoked_at, root_token_hash)",
  );
  expect(migration).toContain(
    "consumed_authorization_codes(consumed_at, code_hash)",
  );
  expect(migration).toContain(
    "auth_code_token_links(\n    created_at,\n    code_hash,\n    access_token_hash,\n    refresh_root_hash",
  );
});

test("authorization-code lifecycle migration is protected additive expand", async () => {
  const migration = await readMigration(
    "037_authorization_code_redemptions.sql",
  );
  expect(migration).toContain(
    "CREATE TABLE IF NOT EXISTS accounts_v1.authorization_code_redemptions",
  );
  expect(migration).toContain(
    "state text NOT NULL CHECK (state IN ('active', 'issuing', 'issued', 'replayed'))",
  );
  expect(migration).toContain("record_version text NOT NULL");
  expect(migration).toContain("claim_id text");
  expect(migration).toContain("access_token_hash text");
  expect(migration).toContain("refresh_token_hash text");
  expect(migration).toContain(
    "authorization_code_redemptions_terminal_retention_idx",
  );
  expect(migration).toContain("FROM accounts_v1.authorization_codes");
  expect(migration).toContain(
    "FROM accounts_v1.consumed_authorization_codes AS consumed",
  );
  expect(migration).not.toMatch(
    /(?:DROP|ALTER) TABLE (?:IF EXISTS )?accounts_v1\.(?:authorization_codes|consumed_authorization_codes|auth_code_token_links)/,
  );
});

test("Postgres authorization-code lifecycle backfill is idempotent and consumed evidence wins", async () => {
  const db = new PGlite();
  const activeHash = `sha256:${"a".repeat(64)}`;
  const consumedHash = `sha256:${"b".repeat(64)}`;
  const accessHash = `sha256:${"c".repeat(64)}`;
  const refreshHash = `sha256:${"d".repeat(64)}`;
  const secondAccessHash = `sha256:${"e".repeat(64)}`;
  const secondRefreshHash = `sha256:${"0".repeat(64)}`;
  try {
    await db.exec(`
      CREATE SCHEMA accounts_v1;
      CREATE TABLE accounts_v1.authorization_codes (
        code_hash text PRIMARY KEY,
        client_id text NOT NULL,
        redirect_uri text NOT NULL,
        scope text NOT NULL,
        subject text NOT NULL,
        takosumi_subject text,
        capsule_id text,
        workspace_id text,
        role text,
        nonce text,
        code_challenge text,
        code_challenge_method text,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL
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
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const consumedAt = new Date("2026-01-01T00:01:00.000Z");
    for (const codeHash of [activeHash, consumedHash]) {
      await db.query(
        `INSERT INTO accounts_v1.authorization_codes (
           code_hash, client_id, redirect_uri, scope, subject,
           code_challenge, code_challenge_method, expires_at, created_at
         ) VALUES ($1, 'client', 'https://client.example.test/callback',
                   'openid', 'subject', 'challenge', 'S256', $2, $3)`,
        [codeHash, new Date("2026-01-01T00:05:00.000Z"), createdAt],
      );
    }
    await db.query(
      `INSERT INTO accounts_v1.consumed_authorization_codes VALUES ($1, $2)`,
      [consumedHash, consumedAt],
    );
    await db.query(
      `INSERT INTO accounts_v1.auth_code_token_links VALUES ($1, $2, $3, $4)`,
      [consumedHash, accessHash, refreshHash, consumedAt],
    );
    await db.query(
      `INSERT INTO accounts_v1.auth_code_token_links VALUES ($1, $2, $3, $4)`,
      [consumedHash, secondAccessHash, secondRefreshHash, consumedAt],
    );

    const migration = await readMigration(
      "037_authorization_code_redemptions.sql",
    );
    await db.exec(migration);
    await db.exec(migration);

    const rows = (
      await db.query<{
        code_hash: string;
        state: string;
        record_version: string;
        claim_id: string | null;
        access_token_hash: string | null;
        refresh_token_hash: string | null;
      }>(
        `SELECT code_hash, state, record_version, claim_id,
                access_token_hash, refresh_token_hash
           FROM accounts_v1.authorization_code_redemptions
          ORDER BY code_hash`,
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      code_hash: activeHash,
      state: "active",
      claim_id: null,
      access_token_hash: null,
      refresh_token_hash: null,
    });
    expect(rows[0]!.record_version).toStartWith("legacy-active:");
    expect(rows[1]).toMatchObject({
      code_hash: consumedHash,
      state: "issued",
      access_token_hash: accessHash,
      refresh_token_hash: refreshHash,
    });
    expect(rows[1]!.record_version).toStartWith("legacy-issued:");
    expect(rows[1]!.claim_id).toStartWith("legacy-claim:");
    expect(
      (
        await db.query<{ count: number }>(
          `SELECT count(*)::int AS count
             FROM accounts_v1.authorization_codes`,
        )
      ).rows[0]?.count,
    ).toBe(2);
    expect(
      (
        await db.query<{ count: number }>(
          `SELECT count(*)::int AS count
             FROM accounts_v1.consumed_authorization_codes`,
        )
      ).rows[0]?.count,
    ).toBe(1);
  } finally {
    await db.close();
  }
});

test("D1 authorization-code lifecycle backfill is idempotent and consumed evidence wins", async () => {
  const db = new SqliteFakeD1();
  await db.exec(D1_ACCOUNTS_STORE_INIT_SQL);
  const activeHash = `sha256:${"e".repeat(64)}`;
  const consumedHash = `sha256:${"f".repeat(64)}`;
  const accessHash = `sha256:${"1".repeat(64)}`;
  const refreshHash = `sha256:${"2".repeat(64)}`;
  const secondAccessHash = `sha256:${"3".repeat(64)}`;
  const secondRefreshHash = `sha256:${"0".repeat(64)}`;
  const record = {
    clientId: "client",
    redirectUri: "https://client.example.test/callback",
    scope: "openid",
    subject: "subject",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
    expiresAt: 10_000,
  };
  await Promise.all([
    insertD1Document(db, "authorization_codes", activeHash, record, 100),
    insertD1Document(db, "authorization_codes", consumedHash, record, 100),
    insertD1Document(
      db,
      "consumed_authorization_codes",
      consumedHash,
      { codeHash: consumedHash, consumedAt: 200 },
      200,
    ),
    insertD1Document(
      db,
      "auth_code_token_links",
      `${consumedHash}\n${accessHash}\n${refreshHash}`,
      {
        codeHash: consumedHash,
        accessTokenHash: accessHash,
        refreshRootHash: refreshHash,
        createdAt: 200,
      },
      200,
    ),
    insertD1Document(
      db,
      "auth_code_token_links",
      `${consumedHash}\n${secondAccessHash}\n${secondRefreshHash}`,
      {
        codeHash: consumedHash,
        accessTokenHash: secondAccessHash,
        refreshRootHash: secondRefreshHash,
        createdAt: 200,
      },
      200,
    ),
  ]);
  const migration = listD1AccountsMigrations().find(
    (candidate) => candidate.name === "authorization_code_redemptions",
  );
  expect(migration).toBeDefined();
  await db.exec(migration!.sql);
  await db.exec(migration!.sql);

  const result = await db
    .prepare(
      `SELECT key, document
         FROM takosumi_accounts_documents
        WHERE bucket = 'authorization_code_redemptions'
        ORDER BY key`,
    )
    .all<{ key: string; document: string }>();
  const rows = result.results!.map((row) => ({
    key: row.key,
    document: JSON.parse(row.document) as Record<string, unknown>,
  }));
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    key: activeHash,
    document: { state: "active", record },
  });
  expect(rows[1]).toMatchObject({
    key: consumedHash,
    document: {
      state: "issued",
      record,
      accessTokenHash: accessHash,
      refreshTokenHash: refreshHash,
    },
  });
  expect(String(rows[0]!.document.recordVersion)).toStartWith("legacy-active:");
  expect(String(rows[1]!.document.recordVersion)).toStartWith("legacy-issued:");
  expect(String(rows[1]!.document.claimId)).toStartWith("legacy-claim:");
  const legacy = await db
    .prepare(
      `SELECT bucket, count(*) AS count
         FROM takosumi_accounts_documents
        WHERE bucket IN (
          'authorization_codes',
          'consumed_authorization_codes',
          'auth_code_token_links'
        )
        GROUP BY bucket
        ORDER BY bucket`,
    )
    .all<{ bucket: string; count: number }>();
  expect(legacy.results).toEqual([
    { bucket: "auth_code_token_links", count: 2 },
    { bucket: "authorization_codes", count: 2 },
    { bucket: "consumed_authorization_codes", count: 1 },
  ]);
});

async function insertD1Document(
  db: D1Database,
  bucket: string,
  key: string,
  document: unknown,
  updatedAt: number,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES (?, ?, ?, ?)",
    )
    .bind(bucket, key, JSON.stringify(document), updatedAt)
    .run();
}

interface AppliedCatalogFixture {
  readonly schemaVersion: number;
  readonly migrations: readonly {
    readonly version: number;
    readonly name: string;
    readonly checksum: string;
  }[];
}
