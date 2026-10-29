import { expect, test } from "bun:test";
import type { ProviderConnection } from "@takosumi/internal/deploy-control-api";
import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { PGliteSqlClient, splitSqlStatements } from "../../../helpers/deploy-control/pglite_sql_client.ts";

test("Postgres v114 expands Connection statuses without rewriting protected rows or blobs", async () => {
  const client = await PGliteSqlClient.createThroughMigrationVersion(113);
  const row = (status: ProviderConnection["status"]): ProviderConnection => ({
    id: `conn_status_${status}`, workspaceId: "workspace_status", scope: "workspace",
    provider: "registry.opentofu.org/example/example", providerSource: "registry.opentofu.org/example/example",
    status, materialization: "secret", envNames: ["EXAMPLE_TOKEN"],
    createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z",
    expiresAt: "2026-09-10T01:00:00.000Z",
  });
  try {
    // Historical fixtures use the historical schema; the current runtime starts
    // only after every migration has completed.
    for (const status of ["pending", "verified", "revoked"] as const) {
      const value = row(status);
      await client.query(`insert into takosumi_connections
        (id,space_id,provider,status,connection_json,created_at,updated_at)
        values($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [value.id,value.workspaceId,value.provider,value.status,JSON.stringify(value),value.createdAt,value.updatedAt]);
    }
    const blob = {
      id: "blob_status", connectionId: row("pending").id, workspaceId: "workspace_status",
      kind: "provider-credentials", ciphertext: "Y2lwaGVydGV4dA==", encryptedDek: "fixture-envelope",
      nonce: "aXZpdml2aXZpdg==", aad: "fixture-aad", keyVersion: 1, createdAt: "2026-09-10T00:00:00.000Z",
    };
    await client.query(`insert into takosumi_connection_secret_blobs
      (id,connection_id,space_id,kind,ciphertext,encrypted_dek,nonce,aad,key_version,created_at,blob_json)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [blob.id,blob.connectionId,blob.workspaceId,blob.kind,blob.ciphertext,blob.encryptedDek,
      blob.nonce,blob.aad,blob.keyVersion,blob.createdAt,JSON.stringify(blob)]);
    const beforeRows = await client.query("select * from takosumi_connections order by id");
    const beforeBlobs = await client.query("select * from takosumi_connection_secret_blobs order by id");
    const expireLegacy = () => client.query(
      "update takosumi_connections set status='expired' where id=$1", [row("pending").id]);
    // The protected predecessor genuinely cannot store the already-defined state.
    await expect(expireLegacy()).rejects.toMatchObject({ code: "23514", constraint: "takosumi_connections_status_check" });
    const migration = postgresStorageMigrationStatements.find((entry) => entry.version === 114);
    expect(migration?.id).toBe("deploy.connection_operational_statuses.expand");
    const statements = splitSqlStatements(migration!.sql);
    await expect(client.transaction(async (transaction) => {
      for (const statement of statements) await transaction.query(statement);
      throw new Error("fixture migration rollback");
    })).rejects.toThrow("fixture migration rollback");
    await expect(expireLegacy()).rejects.toMatchObject({ code: "23514", constraint: "takosumi_connections_status_check" });
    await client.transaction(async (transaction) => {
      for (const statement of statements) await transaction.query(statement);
    });
    expect((await client.query("select * from takosumi_connections order by id")).rows).toEqual(beforeRows.rows);
    expect((await client.query("select * from takosumi_connection_secret_blobs order by id")).rows).toEqual(beforeBlobs.rows);
    for (const entry of postgresStorageMigrationStatements.filter(entry => entry.version > 114)) {
      for (const statement of splitSqlStatements(entry.sql)) await client.query(statement);
    }
    const store = new SqlOpenTofuControlStore({ client });
    expect(await store.markConnectionExpiredIfUnchanged({
      expectedConnection: row("pending"), observedAt: "2026-09-10T02:00:00.000Z",
    })).toBe(true);
    expect(await store.getConnection(row("pending").id)).toEqual({
      ...row("pending"), status: "expired", updatedAt: "2026-09-10T02:00:00.000Z",
    });
    for (const status of ["pending", "verified", "revoked", "expired", "error"] as const) {
      await store.putConnection(row(status));
      expect(await store.getConnection(row(status).id)).toEqual(row(status));
    }
    await expect(client.query("update takosumi_connections set status = 'unknown' where id = $1", [row("pending").id]))
      .rejects.toMatchObject({ code: "23514" });
    expect((await client.query("select * from takosumi_connection_secret_blobs order by id")).rows).toEqual(beforeBlobs.rows);
  } finally {
    await client.close();
  }
});
