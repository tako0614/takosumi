import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import type { Workspace, WorkspaceMember } from "takosumi-contract/workspaces";
import { InMemoryOpenTofuControlStore, type OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { workerdD1Database, workerdD1Module } from "../../../helpers/deploy-control/workerd_d1.ts";

const time = "2026-10-15T00:00:00.000Z";
const strict = { requireCurrentMembership: true };

async function adapters() {
  const postgres = await PGliteSqlClient.create();
  const runtime = new Miniflare({ compatibilityDate: "2026-07-17", modules: [workerdD1Module("shared-mutations.mjs")], d1Databases: { CONTROL: "shared-mutations-native" } });
  const native = workerdD1Database(runtime);
  const memory = new InMemoryOpenTofuControlStore();
  const rows = [
    { label: "memory", first: memory, second: memory },
    { label: "postgres", first: new SqlOpenTofuControlStore({ client: postgres }), second: new SqlOpenTofuControlStore({ client: postgres }) },
    { label: "d1", first: new CloudflareD1OpenTofuControlStore(native), second: new CloudflareD1OpenTofuControlStore(native) },
  ];
  return { rows, async close() { await runtime.dispose(); await postgres.close(); } };
}

function service(store: OpenTofuControlStore, name: string) {
  let id = 0;
  return new WorkspacesService({ store, newId: (prefix) => `${prefix}_${name}_${++id}`, now: () => new Date(time) });
}

function candidate(name: string): Workspace {
  return { id: `ws_${name}`, handle: name, displayName: "Retained Workspace", type: "organization", ownerUserId: `account_${name}`, createdAt: time, updatedAt: time };
}

function owner(workspace: Workspace): WorkspaceMember {
  return { id: `member_${workspace.id}`, workspaceId: workspace.id, accountId: workspace.ownerUserId, roles: ["owner"], status: "active", createdAt: time, updatedAt: time };
}

test("shared organization creation atomically publishes one Workspace and first owner across concurrent actual stores", async () => {
  const f = await adapters();
  try {
    for (const adapter of f.rows) {
      await adapter.first.listWorkspaces();
      await adapter.second.listWorkspaces();
      const first = service(adapter.first, `${adapter.label}_first`);
      const second = service(adapter.second, `${adapter.label}_second`);
      const request = { handle: `concurrent-${adapter.label}`, displayName: "One purpose", type: "organization" as const, ownerUserId: `actor_${adapter.label}` };
      let repairs = 0;
      for (const store of new Set([adapter.first, adapter.second])) store.repairWorkspaceOwnerMember = async () => { repairs++; throw new Error("Strict creation cannot repair"); };
      const result = await Promise.all([first.createWorkspaceForSharedAccount(request), second.createWorkspaceForSharedAccount(request), first.createWorkspaceForSharedAccount(request)]);
      expect(new Set(result.map((row) => row.id)).size, adapter.label).toBe(1);
      expect(await adapter.first.listWorkspacesByOwner(request.ownerUserId), adapter.label).toHaveLength(1);
      expect(await adapter.first.listWorkspaceMembers(result[0]!.id), adapter.label).toHaveLength(1);
      expect(await adapter.first.getWorkspaceMember(result[0]!.id, request.ownerUserId), adapter.label).toMatchObject({ roles: ["owner"], status: "active" });
      expect(repairs, adapter.label).toBe(0);
      await expect(second.createWorkspaceForSharedAccount({ ...request, displayName: "Conflicting purpose" })).rejects.toMatchObject({ code: "failed_precondition" });
      expect(await adapter.first.getWorkspace(result[0]!.id), adapter.label).toEqual(result[0]);
    }
  } finally { await f.close(); }
}, 30_000);

test("existing shared organization creation cannot reactivate, promote, or recreate a missing owner", async () => {
  const f = await adapters();
  try {
    for (const adapter of f.rows) {
      for (const state of ["suspended", "admin", "viewer", "missing"] as const) {
        const workspace = candidate(`existing-${adapter.label}-${state}`);
        await adapter.first.putWorkspace(workspace);
        if (state !== "missing") await adapter.first.putWorkspaceMember({ ...owner(workspace), ...(state === "suspended" ? { status: "suspended" } : { roles: [state] }) });
        const before = await adapter.first.getWorkspaceMember(workspace.id, workspace.ownerUserId);
        await expect(service(adapter.second, `${adapter.label}_${state}`).createWorkspaceForSharedAccount(workspace)).rejects.toMatchObject({ code: "permission_denied" });
        expect(await adapter.first.getWorkspaceMember(workspace.id, workspace.ownerUserId), `${adapter.label}:${state}`).toEqual(before);
        expect(await adapter.first.getWorkspace(workspace.id), `${adapter.label}:${state}`).toEqual(workspace);
      }
    }
  } finally { await f.close(); }
}, 30_000);

test("fresh shared owner insert failure rolls back the entire creation in memory, PostgreSQL and native D1", async () => {
  const f = await adapters();
  try {
    for (const adapter of f.rows) {
      const existing = candidate(`existing-${adapter.label}`);
      const previousOwner = owner(existing);
      await adapter.first.createWorkspaceWithInitialOwner(existing, previousOwner);
      const fresh = candidate(`failed-${adapter.label}`);
      await expect(adapter.second.createWorkspaceWithInitialOwner(fresh, { ...owner(fresh), id: previousOwner.id })).rejects.toBeDefined();
      expect(await adapter.first.getWorkspace(fresh.id), adapter.label).toBeUndefined();
      expect(await adapter.first.getWorkspaceMember(existing.id, existing.ownerUserId), adapter.label).toEqual(previousOwner);
      const orphanCandidate = candidate(`orphan-${adapter.label}`);
      const orphan = { ...owner(orphanCandidate), status: "suspended" as const };
      await adapter.first.putWorkspaceMember(orphan);
      await expect(adapter.second.createWorkspaceWithInitialOwner(orphanCandidate, { ...owner(orphanCandidate), id: `${orphan.id}_new` })).rejects.toBeDefined();
      expect(await adapter.first.getWorkspace(orphanCandidate.id), adapter.label).toBeUndefined();
      expect(await adapter.first.getWorkspaceMember(orphanCandidate.id, orphan.accountId), adapter.label).toEqual(orphan);
    }
  } finally { await f.close(); }
}, 30_000);

test("strict creation cannot bypass the personal singleton and an active owner can atomically delete its empty organization", async () => {
  const f = await adapters();
  try {
    for (const adapter of f.rows) {
      const domain = service(adapter.first, `singleton_${adapter.label}`);
      const personal = await domain.ensurePersonalWorkspaceForSharedAccount(`personal_${adapter.label}`, `personal-${adapter.label}`);
      await expect(domain.createWorkspaceForSharedAccount({ handle: `second-${adapter.label}`, displayName: "Second personal", type: "personal", ownerUserId: personal.ownerUserId })).rejects.toMatchObject({ code: "invalid_argument" });
      expect(await adapter.first.listWorkspacesByOwner(personal.ownerUserId), adapter.label).toEqual([personal]);
      const workspace = candidate(`delete-${adapter.label}`);
      await adapter.first.createWorkspaceWithInitialOwner(workspace, owner(workspace));
      await adapter.first.putWorkspaceMember({ ...owner(workspace), id: `extra_${workspace.id}`, accountId: "extra", roles: ["viewer"] });
      expect(await domain.deleteWorkspaceForAccount(workspace.id, workspace.ownerUserId, undefined, strict), adapter.label).toEqual(workspace);
      expect(await adapter.first.getWorkspace(workspace.id), adapter.label).toBeUndefined();
      expect(await adapter.first.listWorkspaceMembers(workspace.id), adapter.label).toEqual([]);
      expect(await adapter.first.getWorkspaceManagement(workspace.id), adapter.label).toBeUndefined();
      expect(await adapter.first.getWorkspace(personal.id), adapter.label).toEqual(personal);
    }
  } finally { await f.close(); }
}, 30_000);

test("strict metadata, deletion and member commands fence actor suspension or demotion inside all actual store boundaries", async () => {
  const f = await adapters();
  try {
    for (const adapter of f.rows) {
      for (const operation of ["update", "delete", "member"] as const) {
        for (const change of ["suspend", "demote"] as const) {
          const workspace = candidate(`race-${adapter.label}-${operation}-${change}`);
          await adapter.first.createWorkspaceWithInitialOwner(workspace, owner(workspace));
          const target: WorkspaceMember = { ...owner(workspace), id: `target_${workspace.id}`, accountId: "target", roles: ["member"] };
          await adapter.first.putWorkspaceMember(target);
          const authority = await service(adapter.first, "capture").captureManagementAuthority(workspace.id);
          const revoke = async () => { const current = await adapter.first.getWorkspaceMember(workspace.id, workspace.ownerUserId); await adapter.first.putWorkspaceMember({ ...current!, ...(change === "suspend" ? { status: "suspended" } : { roles: ["admin"] }) }); };
          const domain = service(adapter.second, `mutate_${workspace.id}`);
          let invoke: () => Promise<unknown>;
          let restore: () => void;
          if (operation === "update") {
            const commit = adapter.second.replaceWorkspaceForAccount.bind(adapter.second);
            adapter.second.replaceWorkspaceForAccount = async (input) => { await revoke(); return await commit(input); };
            restore = () => { adapter.second.replaceWorkspaceForAccount = commit; };
            invoke = () => domain.updateWorkspaceForAccount(workspace.id, { displayName: "Must not commit" }, workspace.ownerUserId, authority, strict);
          } else if (operation === "delete") {
            const commit = adapter.second.deleteWorkspaceExclusive.bind(adapter.second);
            adapter.second.deleteWorkspaceExclusive = async (input) => { await revoke(); return await commit(input); };
            restore = () => { adapter.second.deleteWorkspaceExclusive = commit; };
            invoke = () => domain.deleteWorkspaceForAccount(workspace.id, workspace.ownerUserId, authority, strict);
          } else {
            const commit = adapter.second.mutateWorkspaceMember.bind(adapter.second);
            adapter.second.mutateWorkspaceMember = async (input) => { await revoke(); return await commit(input); };
            restore = () => { adapter.second.mutateWorkspaceMember = commit; };
            invoke = () => domain.upsertWorkspaceMember({ workspaceId: workspace.id, accountId: "target", roles: ["viewer"], actorAccountId: workspace.ownerUserId, requiredActorRole: "owner", expectedWorkspaceManagementAuthority: authority, ...strict });
          }
          try { await expect(invoke()).rejects.toMatchObject({ code: "failed_precondition" }); } finally { restore(); }
          expect(await adapter.first.getWorkspace(workspace.id), `${adapter.label}:${operation}:${change}`).toEqual(workspace);
          expect(await adapter.first.getWorkspaceManagement(workspace.id), `${adapter.label}:${operation}:${change}`).toEqual(authority);
          expect(await adapter.first.getWorkspaceMember(workspace.id, "target"), `${adapter.label}:${operation}:${change}`).toEqual(target);
          expect(await adapter.first.getWorkspaceMember(workspace.id, workspace.ownerUserId), `${adapter.label}:${operation}:${change}`).toMatchObject(change === "suspend" ? { status: "suspended" } : { roles: ["admin"] });
        }
      }
    }
  } finally { await f.close(); }
}, 30_000);

test("strict actor roles remain current without repairing another suspended namespace owner", async () => {
  const f = await adapters();
  try {
    for (const adapter of f.rows) {
      const workspace = candidate(`roles-${adapter.label}`);
      await adapter.first.createWorkspaceWithInitialOwner(workspace, owner(workspace));
      const suspended = { ...owner(workspace), status: "suspended" as const };
      await adapter.first.putWorkspaceMember(suspended);
      const admin: WorkspaceMember = { ...owner(workspace), id: `admin_${workspace.id}`, accountId: "admin", roles: ["admin"] };
      await adapter.first.putWorkspaceMember(admin);
      const domain = service(adapter.second, `roles_${adapter.label}`);
      await expect(domain.deleteWorkspaceForAccount(workspace.id, workspace.ownerUserId, undefined, strict)).rejects.toMatchObject({ code: "permission_denied" });
      await expect(domain.updateWorkspaceForAccount(workspace.id, { displayName: "Denied" }, workspace.ownerUserId, undefined, strict)).rejects.toMatchObject({ code: "permission_denied" });
      await expect(domain.upsertWorkspaceMember({ workspaceId: workspace.id, accountId: "target", actorAccountId: workspace.ownerUserId, ...strict })).rejects.toMatchObject({ code: "permission_denied" });
      const member = await domain.upsertWorkspaceMember({ workspaceId: workspace.id, accountId: "target", actorAccountId: "admin", ...strict });
      expect(member.roles, adapter.label).toEqual(["member"]);
      expect(await adapter.first.getWorkspaceMember(workspace.id, workspace.ownerUserId), adapter.label).toEqual(suspended);
      await expect(domain.deleteWorkspaceForAccount(workspace.id, "admin", undefined, strict)).rejects.toMatchObject({ code: "permission_denied" });
      await expect(domain.upsertWorkspaceMember({ workspaceId: workspace.id, accountId: "target", actorAccountId: "admin", requiredActorRole: "owner", roles: ["viewer"], ...strict })).rejects.toMatchObject({ code: "permission_denied" });
      expect((await domain.updateWorkspaceForAccount(workspace.id, { displayName: "Allowed admin metadata" }, "admin", undefined, strict)).displayName, adapter.label).toBe("Allowed admin metadata");
    }
  } finally { await f.close(); }
}, 30_000);
