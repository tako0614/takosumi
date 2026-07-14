import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";
import { splitSqlStatements } from "../../../helpers/deploy-control/pglite_sql_client.ts";

test("Connection secret-partition migration confines legacy provider inference to data migration", async () => {
  const migration = postgresStorageMigrationStatements.find(
    (entry) => entry.id === "deploy.connection_secret_partition.backfill",
  );
  expect(migration).toBeDefined();
  const db = new PGlite();
  try {
    await db.exec(`create table takosumi_connections (
      id text primary key,
      provider text not null,
      connection_json jsonb not null
    );
    create table takosumi_connection_secret_blobs (
      connection_id text primary key,
      kind text not null,
      blob_json jsonb not null
    );
    insert into takosumi_connections values
      ('conn_git', 'source_git_https_token', '{"id":"conn_git","provider":"source_git_https_token","kind":"source_git_https_token"}'),
      ('conn_cf', 'cloudflare', '{"id":"conn_cf","provider":"cloudflare","providerSource":"registry.opentofu.org/cloudflare/cloudflare"}'),
      ('conn_custom', 'example/example', '{"id":"conn_custom","provider":"example/example"}'),
      ('conn_explicit', 'example/example', '{"id":"conn_explicit","provider":"example/example","secretPartition":"operator:selected"}');
    insert into takosumi_connection_secret_blobs values
      ('conn_git', 'source_https_token', '{"kind":"source_https_token"}'),
      ('conn_cf', 'cloudflare_api_token', '{"kind":"cloudflare_api_token"}'),
      ('conn_custom', 'static_secret', '{"kind":"static_secret"}'),
      ('conn_explicit', 'static_secret', '{"kind":"static_secret"}');`);

    for (const statement of splitSqlStatements(migration!.sql)) {
      await db.exec(statement);
    }

    const connections = await db.query<{
      id: string;
      partition: string;
    }>(
      `select id, connection_json->>'secretPartition' as partition
       from takosumi_connections order by id`,
    );
    expect(connections.rows).toEqual([
      { id: "conn_cf", partition: "cloudflare" },
      { id: "conn_custom", partition: "local-adapters" },
      { id: "conn_explicit", partition: "operator:selected" },
      { id: "conn_git", partition: "source:git" },
    ]);
    const blobs = await db.query<{
      connection_id: string;
      kind: string;
      json_kind: string;
    }>(
      `select connection_id, kind, blob_json->>'kind' as json_kind
       from takosumi_connection_secret_blobs order by connection_id`,
    );
    expect(blobs.rows).toEqual([
      {
        connection_id: "conn_cf",
        kind: "cloudflare",
        json_kind: "cloudflare",
      },
      {
        connection_id: "conn_custom",
        kind: "local-adapters",
        json_kind: "local-adapters",
      },
      {
        connection_id: "conn_explicit",
        kind: "operator:selected",
        json_kind: "operator:selected",
      },
      {
        connection_id: "conn_git",
        kind: "source:git",
        json_kind: "source:git",
      },
    ]);
  } finally {
    await db.close();
  }
});
