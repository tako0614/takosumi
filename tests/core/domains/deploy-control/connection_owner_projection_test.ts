import { expect, test } from "bun:test";
import type { ProviderConnection } from "takosumi-contract/connections";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
const at = "2026-10-29T00:00:00.000Z";

test("connection owner projection retains a JSON owner until its physical backfill", async () => {
  const pg = await PGliteSqlClient.create();
  try {
    const db = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(db);
    const connection: ProviderConnection = { id: "conn_json_owner", scope: "personal", ownerAccountId: "json-owner", provider: "example", providerSource: "example.test/provider", status: "verified", materialization: "env", envNames: [], createdAt: at, updatedAt: at };
    const postgres = new SqlOpenTofuControlStore({ client: pg });
    const d1 = new CloudflareD1OpenTofuControlStore(db);
    await postgres.putConnection(connection);
    await d1.putConnection(connection);
    await pg.query("update takosumi_connections set owner_account_id=null where id=$1", [connection.id]);
    await db.prepare("update connections set owner_account_id=null where id=?").bind(connection.id).run();
    expect((await postgres.getConnection(connection.id))?.ownerAccountId).toBe("json-owner");
    expect((await d1.getConnection(connection.id))?.ownerAccountId).toBe("json-owner");
    expect(await postgres.replaceConnectionIfUnchanged(connection, { ...connection, displayName: "Updated" })).toBe(true);
    expect(await d1.replaceConnectionIfUnchanged(connection, { ...connection, displayName: "Updated" })).toBe(true);
    await pg.query("update takosumi_connections set owner_account_id='physical-owner' where id=$1", [connection.id]);
    await db.prepare("update connections set owner_account_id='physical-owner' where id=?").bind(connection.id).run();
    expect((await postgres.getConnection(connection.id))?.ownerAccountId).toBe("physical-owner");
    expect((await d1.getConnection(connection.id))?.ownerAccountId).toBe("physical-owner");
  } finally { await pg.close(); }
});
