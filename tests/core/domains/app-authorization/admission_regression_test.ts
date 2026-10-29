import { expect, test } from "bun:test";
import type { SourceSyncRun } from "takosumi-contract/sources";
import type { ProviderConnection } from "takosumi-contract/connections";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqlAppAuthorizationStore, D1AppAuthorizationStore } from "../../../../core/domains/app-authorization/store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const at = "2026-10-29T00:00:00.000Z";
const access = { resolveAppAccess: async () => undefined, listAccessibleApps: async () => ({ apps: [] }) };

test("revoked members cannot enqueue Source sync after the cancellation transaction", async () => {
  const pg = await PGliteSqlClient.create();
  try {
    const db = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(db);
    const cases = [
      { control: new SqlOpenTofuControlStore({ client: pg }), mutations: new SqlAppAuthorizationStore(pg, access) },
      { control: new CloudflareD1OpenTofuControlStore(db), mutations: new D1AppAuthorizationStore(db, access) },
    ];
    for (const { control, mutations } of cases) {
      await control.putWorkspace({ id: "ws_admit", handle: "admit", type: "personal", ownerUserId: "owner", displayName: "Owner", createdAt: at, updatedAt: at });
      await control.putSource({ id: "src_admit", workspaceId: "ws_admit", name: "repo", url: "https://example.test/repo", status: "active", autoSync: true, ownerCapsuleId: "cap_admit", hookSecretHash: "hash", createdAt: at, updatedAt: at });
      await control.putCapsule({ id: "cap_admit", workspaceId: "ws_admit", projectId: "project", sourceId: "src_admit", installConfigId: "config", name: "app", slug: "app", environment: "production", status: "active", ownerAccountId: "owner", ownershipEpoch: 0, managementState: "active", managementEpoch: 0, currentStateGeneration: 0, createdAt: at, updatedAt: at });
      await mutations.addMember({ capsuleId: "cap_admit", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 0, consent: "connections_and_code" });
      const run: SourceSyncRun = { id: "sync_before", kind: "source_sync", workspaceId: "ws_admit", sourceId: "src_admit", actorAccountId: "member", url: "https://example.test/repo", ref: "main", path: ".", archiveRef: "archive", status: "queued", createdAt: at, updatedAt: at };
      const authority = { workspaceId: "ws_admit", managementState: "active" as const, managementEpoch: 1 };
      expect((await control.beginSourceSyncRun(run, authority)).status).toBe("created");
      await mutations.removeMember({ capsuleId: "cap_admit", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 0 });
      expect((await control.getSourceSyncRun(run.id))?.status).toBe("failed");
      expect((await control.beginSourceSyncRun({ ...run, id: "sync_revoked" }, authority)).status).toBe("conflict");
      expect(await control.getSourceSyncRun("sync_revoked")).toBeUndefined();
      expect((await control.beginSourceSyncRun({ ...run, id: "sync_owner", actorAccountId: "owner" }, authority)).status).toBe("created");
    }
  } finally { await pg.close(); }
});

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
