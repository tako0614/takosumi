import { expect, test } from "bun:test";
import {
  InMemoryOpenTofuControlStore,
  WorkspaceManagementAdmissionConflictError,
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

async function seed(store: OpenTofuControlStore) {
  const workspace = {
    id: "ws_delete_fence", handle: "delete-fence", displayName: "Delete fence",
    type: "personal" as const, ownerUserId: "owner_delete_fence",
    createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:00.000Z",
  };
  await store.putWorkspace(workspace);
  const sources = new SourcesService({ store });
  const created = await sources.createSource({
    workspaceId: workspace.id, name: "fence", url: "https://github.com/example/fence.git", autoSync: false,
  });
  const authority = { workspaceId: workspace.id, managementState: "active" as const, managementEpoch: 1 };
  return { workspace, sources, created, authority };
}

for (const adapter of adapters) {
  test(`${adapter.name}: guarded deletes reject stale epochs and allow the original active epoch`, async () => {
    const { store, close } = await adapter.create();
    try {
      const { workspace, created, authority } = await seed(store);
      const stale = { ...authority, managementEpoch: 2 };
      await expect(store.deleteSource(created.source.id, stale)).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      await expect(store.deleteWorkspace(workspace.id, stale)).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      expect(await store.getSource(created.source.id)).toBeDefined();
      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
      expect(await store.deleteSource(created.source.id, authority)).toBe(true);
      expect(await store.deleteWorkspace(workspace.id, authority)).toBe(true);
      expect(await store.getSource(created.source.id)).toBeUndefined();
      expect(await store.getWorkspace(workspace.id)).toBeUndefined();
      expect(await store.getWorkspaceManagement(workspace.id)).toBeUndefined();
    } finally { await close(); }
  }, 30_000);

  test(`${adapter.name}: Source DELETE loses a concurrent drain without deleting or invalidating the webhook`, async () => {
    const { store, close } = await adapter.create();
    try {
      const { sources, created, authority } = await seed(store);
      const before = await store.getSource(created.source.id);
      const original = store.deleteSource.bind(store);
      store.deleteSource = async (...args) => {
        expect(args[1]).toEqual(authority);
        expect((await store.beginWorkspaceDraining(authority.workspaceId, authority)).status).toBe("started");
        return await original(...args);
      };
      await expect(sources.deleteSource(created.source.id, "owner_delete_fence")).rejects.toMatchObject({
        code: "failed_precondition", details: { reason: "workspace_management_admission_conflict" },
      });
      expect(await store.getSource(created.source.id)).toEqual(before);
      expect(await sources.verifyHookSecret(created.source.id, created.hookSecret)).toBe(true);
      expect(await store.listActivityEvents(authority.workspaceId)).toHaveLength(0);
    } finally { await close(); }
  }, 30_000);

  test(`${adapter.name}: Workspace DELETE loses a concurrent drain without deleting its management state`, async () => {
    const { store, close } = await adapter.create();
    try {
      const { workspace, created, authority } = await seed(store);
      await store.deleteSource(created.source.id);
      const workspaces = new WorkspacesService({ store });
      const original = store.deleteWorkspace.bind(store);
      store.deleteWorkspace = async (...args) => {
        expect(args[1]).toEqual(authority);
        expect((await store.beginWorkspaceDraining(workspace.id, authority)).status).toBe("started");
        return await original(...args);
      };
      await expect(workspaces.deleteWorkspaceForAccount(workspace.id, workspace.ownerUserId, authority)).rejects.toMatchObject({
        code: "failed_precondition", details: { reason: "workspace_management_admission_conflict" },
      });
      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
      expect(await store.getWorkspaceManagement(workspace.id)).toMatchObject({ managementState: "draining", managementEpoch: 2 });
    } finally { await close(); }
  }, 30_000);
}
