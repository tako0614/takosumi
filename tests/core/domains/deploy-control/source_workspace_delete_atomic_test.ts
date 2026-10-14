import { expect, test } from "bun:test";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

type StoreFixture = {
  store: OpenTofuControlStore;
  close: () => Promise<void>;
};
const adapters: ReadonlyArray<{
  name: string;
  create: () => Promise<StoreFixture>;
}> = [
  { name: "memory", create: async () => ({ store: new InMemoryOpenTofuControlStore(), close: async () => {} }) },
  { name: "D1", create: async () => ({ store: new CloudflareD1OpenTofuControlStore(new SqliteFakeD1()), close: async () => {} }) },
  { name: "Postgres", create: async () => {
    const client = await PGliteSqlClient.create();
    return { store: new SqlOpenTofuControlStore({ client }), close: () => client.close() };
  } },
];

const TS = "2026-10-14T00:00:00.000Z";

async function seedEmptyWorkspace(store: OpenTofuControlStore, id: string) {
  const workspace = {
    id, handle: id, displayName: id,
    type: "personal" as const, ownerUserId: `owner_${id}`,
    createdAt: TS, updatedAt: TS,
  };
  await store.putWorkspace(workspace);
  return workspace;
}

async function seedSource(store: OpenTofuControlStore, workspaceId: string, sourceId: string) {
  const sources = new SourcesService({ store });
  const created = await sources.createSource({
    workspaceId, name: sourceId, url: "https://github.com/example/atomic.git", autoSync: false,
  });
  return { sources, created };
}

for (const adapter of adapters) {
  test(`${adapter.name}: Workspace DELETE refuses a retained backup with backup_exists`, async () => {
    const { store, close } = await adapter.create();
    try {
      const workspace = await seedEmptyWorkspace(store, "ws_atomic_backup");
      await store.putBackupRecord({
        id: "bkp_atomic_1",
        workspaceId: workspace.id,
        ref: "workspaces/ws_atomic_backup/backups/bkp_atomic_1/control.json.zst.enc",
        digest: "sha256:abc",
        sizeBytes: 10,
        createdAt: TS,
      });
      const workspaces = new WorkspacesService({ store });
      await expect(
        workspaces.deleteWorkspaceForAccount(workspace.id, workspace.ownerUserId),
      ).rejects.toMatchObject({
        code: "failed_precondition",
        details: { reason: "workspace_not_empty", blockers: expect.arrayContaining(["backup_exists"]) },
      });
      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
    } finally { await close(); }
  }, 30_000);

  test(`${adapter.name}: Workspace DELETE refuses a capsule-scoped pre-destroy export`, async () => {
    const { store, close } = await adapter.create();
    try {
      const workspace = await seedEmptyWorkspace(store, "ws_atomic_predestroy");
      await store.putBackupRecord({
        id: "bkp_atomic_pre",
        workspaceId: workspace.id,
        capsuleId: "cap_gone",
        environment: "prod",
        ref: "workspaces/ws_atomic_predestroy/backups/bkp_atomic_pre/control.json.zst.enc",
        digest: "sha256:def",
        sizeBytes: 12,
        createdAt: TS,
      });
      const workspaces = new WorkspacesService({ store });
      await expect(
        workspaces.deleteWorkspaceForAccount(workspace.id, workspace.ownerUserId),
      ).rejects.toMatchObject({
        details: { blockers: expect.arrayContaining(["backup_exists"]) },
      });
    } finally { await close(); }
  }, 30_000);

  test(`${adapter.name}: Workspace empty-check and delete share one atomic boundary`, async () => {
    const { store, close } = await adapter.create();
    try {
      const workspace = await seedEmptyWorkspace(store, "ws_atomic_race");
      const workspaces = new WorkspacesService({ store });
      const originalList = store.listCapsules.bind(store);
      let raced = false;
      (store as unknown as { listCapsules: typeof store.listCapsules }).listCapsules = (async (
        ...args: Parameters<typeof store.listCapsules>
      ) => {
        const result = await originalList(...args);
        if (!raced) {
          raced = true;
          await store.putCapsule({
            id: "cap_race",
            workspaceId: workspace.id,
            projectId: "proj_race",
            name: "race",
            slug: "race",
            environment: "prod",
            sourceId: undefined,
            installConfigId: "cfg_race",
            status: "active",
            currentStateGeneration: 0,
            createdAt: TS,
            updatedAt: TS,
          } as never);
        }
        return result;
      }) as typeof store.listCapsules;
      await expect(
        workspaces.deleteWorkspaceForAccount(workspace.id, workspace.ownerUserId),
      ).rejects.toMatchObject({
        details: { reason: "workspace_not_empty", blockers: expect.arrayContaining(["capsule_exists"]) },
      });
      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
    } finally { await close(); }
  }, 30_000);

  test(`${adapter.name}: Source delete writes source.deleted in the same boundary and races are blocked`, async () => {
    const { store, close } = await adapter.create();
    try {
      const workspace = await seedEmptyWorkspace(store, "ws_atomic_src");
      const { sources, created } = await seedSource(store, workspace.id, "src_atomic");
      const originalList = store.listCapsules.bind(store);
      let raced = false;
      (store as unknown as { listCapsules: typeof store.listCapsules }).listCapsules = (async (
        ...args: Parameters<typeof store.listCapsules>
      ) => {
        const result = await originalList(...args);
        if (!raced) {
          raced = true;
          await store.putCapsule({
            id: "cap_src_race",
            workspaceId: workspace.id,
            projectId: "proj_src_race",
            name: "src-race",
            slug: "src-race",
            environment: "prod",
            sourceId: created.source.id,
            installConfigId: "cfg_src_race",
            status: "active",
            currentStateGeneration: 0,
            createdAt: TS,
            updatedAt: TS,
          } as never);
        }
        return result;
      }) as typeof store.listCapsules;
      await expect(sources.deleteSource(created.source.id, workspace.ownerUserId)).rejects.toMatchObject({
        details: { reason: "source_referenced_by_capsule" },
      });
      expect(await store.getSource(created.source.id)).toBeDefined();
      expect(await store.listActivityEvents(workspace.id)).toHaveLength(0);
    } finally { await close(); }
  }, 30_000);

  test(`${adapter.name}: Source delete success records one value-free activity atomically`, async () => {
    const { store, close } = await adapter.create();
    try {
      const workspace = await seedEmptyWorkspace(store, "ws_atomic_src_ok");
      const sources = new SourcesService({ store });
      const created = await sources.createSource({
        workspaceId: workspace.id, name: "ok", url: "https://github.com/example/atomic.git", autoSync: false,
      });
      await sources.deleteSource(created.source.id, workspace.ownerUserId);
      expect(await store.getSource(created.source.id)).toBeUndefined();
      const events = await store.listActivityEvents(workspace.id);
      const deleted = events.filter((e) => e.action === "source.deleted");
      expect(deleted).toHaveLength(1);
      expect(deleted[0]).toMatchObject({
        workspaceId: workspace.id,
        targetType: "source",
        targetId: created.source.id,
        metadata: {},
      });
    } finally { await close(); }
  }, 30_000);

  test(`${adapter.name}: Workspace delete removes member rows`, async () => {
    const { store, close } = await adapter.create();
    try {
      const workspace = await seedEmptyWorkspace(store, "ws_atomic_members");
      await store.putWorkspaceMember({
        id: "wsm_atomic_owner",
        workspaceId: workspace.id,
        accountId: workspace.ownerUserId,
        roles: ["owner"],
        status: "active",
        createdAt: TS,
        updatedAt: TS,
      });
      await store.putWorkspaceMember({
        id: "wsm_atomic_member",
        workspaceId: workspace.id,
        accountId: "user_pii",
        roles: ["member"],
        status: "active",
        createdAt: TS,
        updatedAt: TS,
      });
      const workspaces = new WorkspacesService({ store });
      await workspaces.deleteWorkspaceForAccount(workspace.id, workspace.ownerUserId);
      expect(await store.listWorkspaceMembers(workspace.id)).toHaveLength(0);
      expect(await store.getWorkspaceMember(workspace.id, "user_pii")).toBeUndefined();
      expect(await store.getWorkspaceMember(workspace.id, workspace.ownerUserId)).toBeUndefined();
    } finally { await close(); }
  }, 30_000);
}
