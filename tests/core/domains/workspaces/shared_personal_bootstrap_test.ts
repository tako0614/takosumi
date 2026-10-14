import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import type { Workspace, WorkspaceMember } from "takosumi-contract/workspaces";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import { InMemoryOpenTofuControlStore, type OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { workerdD1Database, workerdD1Module } from "../../../helpers/deploy-control/workerd_d1.ts";

const time = "2026-10-15T00:00:00.000Z";

async function adapters() {
  const postgres = await PGliteSqlClient.create();
  const runtime = new Miniflare({
    compatibilityDate: "2026-07-17",
    modules: [workerdD1Module("shared-personal-bootstrap-d1.mjs")],
    d1Databases: { CONTROL: "shared-personal-bootstrap-native" },
  });
  const native = workerdD1Database(runtime);
  const memory = new InMemoryOpenTofuControlStore();
  const rows: readonly { label: string; first: OpenTofuControlStore; second: OpenTofuControlStore; removeMember(workspaceId: string, accountId: string): Promise<void> }[] = [
    {
      label: "memory", first: memory, second: memory,
      async removeMember(workspaceId, accountId) {
        // There is deliberately no public hard-delete member port. Simulate
        // a missing durable read without inventing a production delete API.
        const read = memory.getWorkspaceMember.bind(memory);
        memory.getWorkspaceMember = async (id, account) => id === workspaceId && account === accountId ? undefined : await read(id, account);
      },
    },
    {
      label: "postgres", first: new SqlOpenTofuControlStore({ client: postgres }), second: new SqlOpenTofuControlStore({ client: postgres }),
      async removeMember(workspaceId, accountId) { await postgres.query("delete from takosumi_workspace_members where workspace_id = $1 and account_id = $2", [workspaceId, accountId]); },
    },
    ...[{ label: "d1-workerd", database: native }].map(({ label, database }) => ({
      label, first: new CloudflareD1OpenTofuControlStore(database), second: new CloudflareD1OpenTofuControlStore(database),
      async removeMember(workspaceId: string, accountId: string) { await database.prepare("delete from workspace_members where workspace_id = ? and account_id = ?").bind(workspaceId, accountId).run(); },
    })),
  ];
  return { rows, close: async () => { await runtime.dispose(); await postgres.close(); } };
}

function service(store: OpenTofuControlStore, prefix: string, ensureDefaultProject?: (workspaceId: string) => Promise<unknown>) {
  let id = 0;
  return new WorkspacesService({ store, newId: (kind) => `${kind}_${prefix}_${++id}`, now: () => new Date(time), ensureDefaultProject });
}

test("shared bootstrap atomically converges first owner and Workspace across memory/Postgres/native D1 replicas without repairs", async () => {
  const f = await adapters();
  try {
    for (const adapter of f.rows) {
      await adapter.first.listWorkspaces();
      await adapter.second.listWorkspaces();
      let repairs = 0;
      for (const store of new Set([adapter.first, adapter.second])) {
        store.repairWorkspaceOwnerMember = async () => { repairs++; throw new Error("Shared login must not repair membership."); };
      }
      const first = service(adapter.first, `${adapter.label}-a`);
      const second = service(adapter.second, `${adapter.label}-b`);
      const account = `shared_first_${adapter.label}`;
      const result = await Promise.all([
        first.ensurePersonalWorkspaceForSharedAccount(account, "shared-presentation-a"),
        second.ensurePersonalWorkspaceForSharedAccount(account, "shared-presentation-b"),
        first.ensurePersonalWorkspaceForSharedAccount(account, "shared-presentation-c"),
        second.ensurePersonalWorkspaceForSharedAccount(account, "shared-presentation-d"),
      ]);
      expect(new Set(result.map((row) => row.id)).size, adapter.label).toBe(1);
      expect(await adapter.first.listWorkspacesByOwner(account), adapter.label).toHaveLength(1);
      expect(await adapter.first.getWorkspaceMember(result[0]!.id, account), adapter.label).toMatchObject({ status: "active", roles: ["owner"] });
      expect(repairs, adapter.label).toBe(0);

      // Creating/claiming this namespace did not adopt a caller-chosen Org or
      // another owner's squatted presentation handle.
      const foreign = await adapter.first.getWorkspace(result[0]!.id);
      const separate = await second.ensurePersonalWorkspaceForSharedAccount(`other_${account}`, "shared-presentation-a");
      expect(separate.id, adapter.label).not.toBe(foreign?.id);
    }
  } finally { await f.close(); }
}, 30_000);

test("shared existing/adopted bootstrap never restores suspended/demoted/missing owner rows or calls repair", async () => {
  const f = await adapters();
  try {
    for (const adapter of f.rows) {
      const seed = service(adapter.first, `${adapter.label}-seed`);
      const strict = service(adapter.second, `${adapter.label}-strict`);
      for (const state of ["suspended", "demoted", "missing"] as const) {
        // Ordinary create makes an existing personal row without a bootstrap
        // claim, so the strict path also exercises deterministic adoption.
        const account = `shared_rejected_${adapter.label}_${state}`;
        const existing = await seed.createWorkspace({ ownerUserId: account, type: "personal", handle: `retained-${adapter.label}-${state}`, displayName: "Retained resource context" });
        const owner = await adapter.first.getWorkspaceMember(existing.id, account);
        if (state === "missing") await adapter.removeMember(existing.id, account);
        else await adapter.first.putWorkspaceMember({ ...owner!, ...(state === "suspended" ? { status: "suspended" } : { roles: ["viewer"] }) });
        const before = await adapter.first.getWorkspaceMember(existing.id, account);
        let repairs = 0;
        const repair = adapter.second.repairWorkspaceOwnerMember.bind(adapter.second);
        adapter.second.repairWorkspaceOwnerMember = async (input) => { repairs++; return await repair(input); };
        await expect(strict.ensurePersonalWorkspaceForSharedAccount(account, "fresh-presentation")).rejects.toMatchObject({ code: "permission_denied" });
        expect(await adapter.first.getWorkspaceMember(existing.id, account), `${adapter.label}:${state}`).toEqual(before);
        expect(await adapter.first.getWorkspace(existing.id), `${adapter.label}:${state}`).toEqual(existing);
        expect(await adapter.first.listWorkspacesByOwner(account), `${adapter.label}:${state}`).toHaveLength(1);
        expect(repairs, `${adapter.label}:${state}`).toBe(0);
        adapter.second.repairWorkspaceOwnerMember = repair;
      }
    }
  } finally { await f.close(); }
}, 30_000);

test("revocation during shared claim/default preparation fails without owner reactivation across durable adapters", async () => {
  const f = await adapters();
  try {
    for (const adapter of f.rows) {
      const account = `shared_race_${adapter.label}`;
      const seed = service(adapter.first, `${adapter.label}-race-seed`);
      const existing = await seed.ensurePersonalWorkspaceForSharedAccount(account, "race-existing");
      const claim = adapter.second.claimPersonalWorkspaceBootstrap.bind(adapter.second);
      adapter.second.claimPersonalWorkspaceBootstrap = async (...args) => {
        const result = await claim(...args);
        const current = await adapter.first.getWorkspaceMember(existing.id, account);
        await adapter.first.putWorkspaceMember({ ...current!, status: "suspended" });
        return result;
      };
      const strict = service(adapter.second, `${adapter.label}-race-strict`);
      await expect(strict.ensurePersonalWorkspaceForSharedAccount(account, "race-presentation")).rejects.toMatchObject({ code: "permission_denied" });
      expect(await adapter.first.getWorkspaceMember(existing.id, account), adapter.label).toMatchObject({ status: "suspended" });
      adapter.second.claimPersonalWorkspaceBootstrap = claim;

      const current = await adapter.first.getWorkspaceMember(existing.id, account);
      await adapter.first.putWorkspaceMember({ ...current!, status: "active" });
      const duringDefault = service(adapter.second, `${adapter.label}-race-default`, async () => {
        const member = await adapter.first.getWorkspaceMember(existing.id, account);
        await adapter.first.putWorkspaceMember({ ...member!, status: "suspended" });
      });
      await expect(duringDefault.ensurePersonalWorkspaceForSharedAccount(account, "race-presentation")).rejects.toMatchObject({ code: "permission_denied" });
      expect(await adapter.first.getWorkspaceMember(existing.id, account), adapter.label).toMatchObject({ status: "suspended" });
    }
  } finally { await f.close(); }
}, 30_000);

test("initial owner insert failure rolls back a fresh memory/PostgreSQL/native D1 claim without creating an ownerless Workspace", async () => {
  const f = await adapters();
  try {
    for (const adapter of f.rows) {
      const seed = service(adapter.first, `${adapter.label}-rollback-seed`);
      const existing = await seed.ensurePersonalWorkspaceForSharedAccount(`existing_${adapter.label}`, "rollback-existing");
      const owner = await adapter.first.getWorkspaceMember(existing.id, existing.ownerUserId);
      const account = `failing_${adapter.label}`;
      const candidate: Workspace = { id: `ws_failing_${adapter.label}`, handle: `rollback-${adapter.label}`, displayName: "Never published", type: "personal", ownerUserId: account, createdAt: time, updatedAt: time };
      const initial: WorkspaceMember = { id: owner!.id, workspaceId: candidate.id, accountId: account, status: "active", roles: ["owner"], createdAt: time, updatedAt: time };
      await expect(adapter.second.claimPersonalWorkspaceBootstrap(account, candidate, initial)).rejects.toBeDefined();
      expect(await adapter.first.getWorkspace(candidate.id), adapter.label).toBeUndefined();
      expect(await adapter.first.getWorkspaceMember(existing.id, existing.ownerUserId), adapter.label).toEqual(owner);
    }
  } finally { await f.close(); }
}, 30_000);
