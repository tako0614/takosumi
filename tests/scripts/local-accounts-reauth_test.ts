import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  applySql,
  assertLocalTarget,
  assertPlan,
  planSql,
  type ReauthPlan,
} from "../../scripts/local-accounts-reauth.ts";

const CONTAINER = "a".repeat(64);
const TARGET = {
  project: "takosumi-local",
  container: CONTAINER,
  volume: "takosumi-local_substrate-postgres-data",
};

function dockerFixture(overrides: Record<string, unknown> = {}) {
  const inspect = {
    Id: CONTAINER,
    State: { Running: true },
    Config: {
      Image: "postgres:16-alpine",
      Labels: {
        "com.docker.compose.project": TARGET.project,
        "com.docker.compose.service": "substrate-postgres",
        "com.docker.compose.oneoff": "False",
        "com.docker.compose.project.config_files":
          "/local/takosumi/deploy/local-substrate/compose.substrate.yml",
      },
    },
    Mounts: [
      {
        Type: "volume",
        Name: TARGET.volume,
        Destination: "/var/lib/postgresql/data",
      },
    ],
    HostConfig: { PortBindings: {} },
    NetworkSettings: {
      Networks: { "local-substrate_takos-local-internal": {} },
    },
    ...overrides,
  };
  return (_command: string, args: readonly string[]) =>
    args[0] === "inspect"
      ? JSON.stringify([inspect])
      : args[0] === "network"
        ? JSON.stringify([
            {
              Name: "local-substrate_takos-local-internal",
              Containers: { [CONTAINER]: {} },
            },
          ])
        : CONTAINER.slice(0, 12);
}

test("offline target rejects another project, changed volume, published port, or running peer", () => {
  expect(() => assertLocalTarget(dockerFixture(), TARGET)).not.toThrow();
  expect(() =>
    assertLocalTarget(
      dockerFixture({
        Config: { Labels: { "com.docker.compose.project": "wrong" } },
      }),
      TARGET,
    ),
  ).toThrow();
  expect(() =>
    assertLocalTarget(dockerFixture({ Mounts: [] }), TARGET),
  ).toThrow();
  expect(() =>
    assertLocalTarget(
      dockerFixture({
        HostConfig: { PortBindings: { "5432/tcp": [{ HostPort: "5432" }] } },
      }),
      TARGET,
    ),
  ).toThrow();
  expect(() =>
    assertLocalTarget(
      (_cmd, args) =>
        args[0] === "inspect" || args[0] === "network"
          ? dockerFixture()(_cmd, args)
          : `${CONTAINER.slice(0, 12)}\nbbbbbbbbbbbb`,
      TARGET,
    ),
  ).toThrow();
  expect(() =>
    assertLocalTarget(
      dockerFixture({ NetworkSettings: { Networks: { other: {} } } }),
      TARGET,
    ),
  ).toThrow();
  expect(() =>
    assertLocalTarget(
      (command, args) =>
        args[0] === "network"
          ? JSON.stringify([
              {
                Name: "local-substrate_takos-local-internal",
                Containers: { [CONTAINER]: {}, ["b".repeat(64)]: {} },
              },
            ])
          : dockerFixture()(command, args),
      TARGET,
    ),
  ).toThrow();
});

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create schema accounts_v1;
    create table accounts_v1.accounts (subject text primary key, display_name text);
    create table accounts_v1.account_sessions (session_id text primary key, subject text not null);
    create table accounts_v1.authorization_codes (code_hash text primary key, subject text not null);
    create table accounts_v1.oauth_access_tokens (token_hash text primary key, subject text not null);
    create table accounts_v1.oauth_refresh_tokens (token_hash text primary key, subject text not null);
    create table accounts_v1.personal_access_tokens (token_id text primary key, subject text not null, revoked_at timestamptz, created_at timestamptz not null);
    create table accounts_v1.refresh_chain_links (parent_token_hash text primary key, child_token_hash text not null);
    create table accounts_v1.oidc_clients (client_id text primary key);
    create table accounts_v1.upstream_identities (upstream_subject text primary key, subject text not null);
    create table accounts_v1.passkey_credentials (credential_id text primary key, subject text not null);
    insert into accounts_v1.accounts values ('tsub_fixture', 'Preserve me');
    insert into accounts_v1.account_sessions values ('sha256:session', 'tsub_fixture');
    insert into accounts_v1.authorization_codes values ('sha256:code', 'tsub_fixture');
    insert into accounts_v1.oauth_access_tokens values ('sha256:access', 'tsub_fixture');
    insert into accounts_v1.oauth_refresh_tokens values ('sha256:refresh', 'tsub_fixture');
    insert into accounts_v1.personal_access_tokens values ('pat_fixture', 'tsub_fixture', null, '2020-01-01');
    insert into accounts_v1.refresh_chain_links values ('sha256:refresh', 'sha256:next');
    insert into accounts_v1.oidc_clients values ('client_fixture');
    insert into accounts_v1.upstream_identities values ('upstream_fixture', 'tsub_fixture');
    insert into accounts_v1.passkey_credentials values ('passkey_fixture', 'tsub_fixture');
  `);
  const state = await db.query<{
    result: {
      database: string;
      databaseOid: string;
      systemIdentifier: string;
      generation: string;
      counts: ReauthPlan["counts"];
    };
  }>(`select (${planSql().slice(0, -1)}) as result`);
  const s = state.rows[0]!.result;
  const plan: ReauthPlan = {
    kind: "takosumi.local-accounts-reauth@v1",
    ...TARGET,
    database: "takosumi_accounts",
    databaseOid: s.databaseOid,
    systemIdentifier: s.systemIdentifier,
    generation: s.generation,
    counts: s.counts,
  };
  return { db, plan };
}

test("transaction removes only opaque auth and preserves subject/identity/deployment evidence", async () => {
  const { db, plan } = await fixture();
  try {
    assertPlan(plan);
    // PGlite's default database is postgres; production requires exact
    // takosumi_accounts. Substitute only that identity for isolated SQL proof.
    const sql = applySql(plan).replace("'takosumi_accounts'", "'postgres'");
    await db.exec(sql);
    for (const table of [
      "account_sessions",
      "authorization_codes",
      "oauth_access_tokens",
      "oauth_refresh_tokens",
    ]) {
      expect(
        (await db.query(`select count(*)::int as n from accounts_v1.${table}`))
          .rows[0],
      ).toEqual({ n: 0 });
    }
    expect(
      (
        await db.query(
          "select count(*)::int as n from accounts_v1.personal_access_tokens where revoked_at is null",
        )
      ).rows[0],
    ).toEqual({ n: 0 });
    for (const table of [
      "accounts",
      "refresh_chain_links",
      "oidc_clients",
      "upstream_identities",
      "passkey_credentials",
    ]) {
      expect(
        (await db.query(`select count(*)::int as n from accounts_v1.${table}`))
          .rows[0],
      ).toEqual({ n: 1 });
    }
  } finally {
    await db.close();
  }
});

test("stale generation aborts atomically and leaves every credential row unchanged", async () => {
  const { db, plan } = await fixture();
  try {
    await db.exec(
      "delete from accounts_v1.oauth_access_tokens where token_hash = 'sha256:access'",
    );
    await db.exec(
      "insert into accounts_v1.oauth_access_tokens values ('sha256:new', 'tsub_fixture')",
    );
    const sql = applySql(plan).replace("'takosumi_accounts'", "'postgres'");
    await expect(db.exec(sql)).rejects.toThrow(
      /stale or database identity changed/,
    );
    await db.exec("rollback");
    expect(
      (
        await db.query(
          "select count(*)::int as n from accounts_v1.oauth_access_tokens",
        )
      ).rows[0],
    ).toEqual({ n: 1 });
    expect(
      (await db.query("select token_hash from accounts_v1.oauth_access_tokens"))
        .rows[0],
    ).toEqual({ token_hash: "sha256:new" });
    expect(
      (
        await db.query(
          "select count(*)::int as n from accounts_v1.account_sessions",
        )
      ).rows[0],
    ).toEqual({ n: 1 });
  } finally {
    await db.close();
  }
});
