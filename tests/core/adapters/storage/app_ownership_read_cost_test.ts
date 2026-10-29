import { expect, test } from "bun:test";
import type { ProviderConnection } from "takosumi-contract/connections";
import type { SqlClient } from "../../../../core/adapters/storage/sql.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";

const connection = (id: string): ProviderConnection => ({
  id, ownerAccountId: "personal-owner", scope: "workspace",
  provider: "registry.opentofu.org/example/service", providerSource: "registry.opentofu.org/example/service",
  status: "pending", materialization: "secret", envNames: [],
  createdAt: "2026-10-29T00:00:00.000Z", updatedAt: "2026-10-29T00:00:00.000Z",
});

for (const dialect of ["D1", "Postgres"] as const) {
  test(`${dialect}: personal owners persist without a Workspace and list projection is batched`, async () => {
    const queries: string[] = [];
    const pg = dialect === "Postgres" ? await PGliteSqlClient.create() : undefined;
    const d1 = new SqliteFakeD1();
    const client: SqlClient | undefined = pg ? {
      query: (sql, params) => { queries.push(sql); return pg.query(sql, params); },
      transaction: (run) => pg.transaction(run),
    } : undefined;
    const store = client ? new SqlOpenTofuControlStore({ client }) : new CloudflareD1OpenTofuControlStore({
      prepare(sql) { queries.push(sql); return d1.prepare(sql); },
      batch(statements) { return d1.batch(statements); },
    });
    try {
      await store.putConnection(connection("personal"));
      expect(await store.getConnection("personal")).toEqual(connection("personal"));
      await store.putWorkspace({ id: "ws_projection", handle: "projection", displayName: "Projection", type: "personal",
        ownerUserId: "personal-owner", createdAt: "now", updatedAt: "now" });
      for (let index = 0; index < 105; index++) await store.putConnection({ ...connection(`personal_${index}`), workspaceId: "ws_projection" });
      queries.length = 0;
      const first = await store.listConnections("ws_projection");
      expect(first).toHaveLength(105);
      expect(first.every(row => row.ownerAccountId === "personal-owner" && row.workspaceId === "ws_projection")).toBe(true);
      expect(queries.length).toBeLessThan(12);
      queries.length = 0;
      expect(await store.listConnections("ws_projection")).toHaveLength(105);
      expect(queries.length).toBeLessThan(12);
      expect(queries.some(sql => /pragma table_info|information_schema\.columns/iu.test(sql))).toBe(false);
    } finally { await pg?.close(); }
  });
}

for (const version of [75, 76]) {
  test(`D1 v${version}: legacy upsert preserves execution epoch and an existing instance sees v77`, async () => {
    const db = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: version });
    const store = new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" });
    const { capsule } = await seedCapsuleModel(store);
    await db.prepare("update capsules set execution_authority_epoch=7 where id=?").bind(capsule.id).run();
    const supplied = { ...capsule, ownerAccountId: "owner", storageRoot: `apps/${capsule.id}`,
      ownershipEpoch: 1, managementState: "active" as const, managementEpoch: 0 };
    const stored = await store.putCapsule(supplied);
    expect(stored.ownerAccountId).toBeUndefined();
    expect(stored.storageRoot).toBeUndefined();
    expect(await store.getCapsuleExecutionAuthorityEpoch(capsule.id)).toBe(7);
    expect(await store.getCapsuleStorageRoot(capsule.id)).toBe(`workspaces/${capsule.workspaceId}/capsules/${capsule.id}`);
    await ensureD1OpenTofuLedgerSchema(db);
    await store.putCapsule(supplied);
    expect(await store.getCapsuleStorageRoot(capsule.id)).toBe(supplied.storageRoot);
    expect(await store.getCapsuleExecutionAuthorityEpoch(capsule.id)).toBe(7);
  });
}
