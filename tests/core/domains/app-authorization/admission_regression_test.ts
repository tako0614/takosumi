import { expect, test } from "bun:test";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { deterministicInitialCapsuleId, deterministicInstallSourceId } from "../../../../core/domains/install-plans/source-reservation.ts";
import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import type { SourceSyncRun } from "takosumi-contract/sources";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqlAppAuthorizationStore, D1AppAuthorizationStore } from "../../../../core/domains/app-authorization/store.ts";
import { SqlAppOwnershipStore, D1AppOwnershipStore } from "../../../../core/domains/app-ownership/store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const at = "2026-10-29T00:00:00.000Z";
const access = { resolveAppAccess: async () => undefined, listAccessibleApps: async () => ({ apps: [] }) };

test("revoked members cannot enqueue Source sync after the cancellation transaction", async () => {
  const pg = await PGliteSqlClient.create();
  try {
    const db = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(db);
    const pgControl = new SqlOpenTofuControlStore({ client: pg });
    const d1Control = new CloudflareD1OpenTofuControlStore(db);
    const cases = [
      { control: pgControl, mutations: new SqlAppAuthorizationStore(pg, access),
        ownership: new SqlAppOwnershipStore(pg, pgControl) },
      { control: d1Control, mutations: new D1AppAuthorizationStore(db, access),
        ownership: new D1AppOwnershipStore(db, d1Control) },
    ];
    for (const { control, mutations, ownership } of cases) {
      await control.putWorkspace({ id: "ws_admit", handle: "admit", type: "personal", ownerUserId: "owner", displayName: "Owner", createdAt: at, updatedAt: at });
      await control.putSource({ id: "src_admit", workspaceId: "ws_admit", name: "repo", url: "https://example.test/repo", status: "active", autoSync: true, ownerCapsuleId: "cap_admit", createdByInstallPlanId: "gip_admit", hookSecretHash: "hash", createdAt: at, updatedAt: at });
      await control.putCapsule({ id: "cap_admit", workspaceId: "ws_admit", projectId: "project", sourceId: "src_admit", installConfigId: "config", name: "app", slug: "app", environment: "production", status: "active", currentStateGeneration: 0, createdAt: at, updatedAt: at });
      expect(await ownership.initializeOwnershipIfMissing({ capsuleId: "cap_admit", ownerAccountId: "owner",
        ownershipEpoch: 0, managementState: "active", managementEpoch: 0, storageRoot: "apps/cap_admit" })).toBe(true);
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


test("initial install Source reservations sync before Capsule creation without admitting orphan owners", async () => {
  const pg = await PGliteSqlClient.create();
  try {
    const db = new SqliteFakeD1();
    const stores = [new InMemoryOpenTofuControlStore(), new SqlOpenTofuControlStore({ client: pg }),
      new CloudflareD1OpenTofuControlStore(db)];
    for (const control of stores) {
      await control.putWorkspace({ id: "ws_reserved", handle: "reserved", type: "personal", ownerUserId: "owner",
        displayName: "Owner", createdAt: at, updatedAt: at });
      const authority = { workspaceId: "ws_reserved", managementState: "active" as const, managementEpoch: 1 };
      const sources = new SourcesService({ store: control });
      const sourceId = deterministicInstallSourceId("gip_reserved");
      const capsuleId = deterministicInitialCapsuleId("gip_reserved");
      await sources.ensureOwnedSource({ id: sourceId, workspaceId: "ws_reserved", name: "reserved",
        ownerCapsuleId: capsuleId, createdByInstallPlanId: "gip_reserved",
        url: "https://example.test/repo.git", ref: "main", path: ".", createdAt: at }, authority);
      const run: SourceSyncRun = { id: "sync_reserved", kind: "source_sync", workspaceId: "ws_reserved",
        sourceId, url: "https://example.test/repo.git", ref: "main", path: ".",
        archiveRef: "archive", status: "queued", createdAt: at, updatedAt: at };
      expect((await control.beginSourceSyncRun(run, authority)).status).toBe("created");
      const reserved = (await control.getSource(sourceId))!;
      await control.putSource({ ...reserved, id: "src_orphan", ownerCapsuleId: "cap_orphan", createdByInstallPlanId: "gip_reserved" });
      expect((await control.beginSourceSyncRun({ ...run, id: "sync_orphan", sourceId: "src_orphan" }, authority)).status).toBe("conflict");
    }
  } finally { await pg.close(); }
});
