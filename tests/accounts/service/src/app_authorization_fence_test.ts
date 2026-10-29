import { expect, test } from "bun:test";
import type { AppAction } from "takosumi-contract/app-access";
import type { Capsule } from "takosumi-contract/capsules";
import type { Workspace, WorkspaceMember } from "takosumi-contract/workspaces";
import { requireAppAccess, type AppAuthorizationResult } from "../../../../accounts/service/src/control/app-authorization.ts";
import type { ControlSession } from "../../../../accounts/service/src/control/shared.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import type { RequestPhaseObserver } from "../../../../accounts/service/src/request-phase-diagnostics.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import {
  D1AppOwnershipStore,
  SqlAppOwnershipStore,
  type AppOwnershipStore,
} from "../../../../core/domains/app-ownership/store.ts";
import type { OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { acquireControlD1MaintenanceFence, releaseControlD1MaintenanceFence } from "../../../../worker/src/d1_schema_maintenance.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const NOW = "2026-10-29T00:00:00.000Z";
const workspace: Workspace = {
  id: "ws_fence", handle: "fence", displayName: "Fence", type: "organization",
  ownerUserId: "ws_owner", createdAt: NOW, updatedAt: NOW,
};
const capsule: Capsule = {
  id: "cap_fence", workspaceId: workspace.id, projectId: "prj_fence", name: "Fence app", slug: "fence-app",
  sourceId: "src_fence", installConfigId: "cfg_fence", environment: "production",
  currentStateGeneration: 1, status: "active", createdAt: NOW, updatedAt: NOW,
};
const unowned: Capsule = { ...capsule, id: "cap_fence_unowned", name: "Unowned", slug: "unowned" };

function member(accountId: string, role: WorkspaceMember["roles"][number]): WorkspaceMember {
  return { id: `wsm_${accountId}`, workspaceId: workspace.id, accountId, roles: [role], status: "active", createdAt: NOW, updatedAt: NOW };
}
const workspaceMembers = [member("ws_admin", "admin"), member("ws_member", "member"), member("dual", "admin")];

/** Narrow Control facade over the real stores under test. */
function operationsFor(store: AppOwnershipStore, control: Pick<OpenTofuControlStore, "getCapsule">): ControlPlaneOperations {
  return {
    appOwnership: store,
    appAccess: store,
    workspaces: { getWorkspace: async (id: string) => { expect(id).toBe(workspace.id); return workspace; } },
    members: { getMember: async (_id: string, accountId: string) => workspaceMembers.find((row) => row.accountId === accountId) },
    capsules: { getCapsule: async (id: string) => (await control.getCapsule(id))! },
  } as unknown as ControlPlaneOperations;
}

async function decide(
  operations: ControlPlaneOperations,
  subject: string,
  action: AppAction,
  options: { readonly capsuleId?: string; readonly session?: Partial<ControlSession>; readonly diagnostics?: RequestPhaseObserver } = {},
): Promise<AppAuthorizationResult> {
  return await requireAppAccess({
    operations,
    store: new InMemoryAccountsStore(),
    session: { subject, credential: "session", requiredAccess: action === "view" ? "read" : "write", ...options.session },
    capsuleId: options.capsuleId ?? capsule.id,
    workspaceId: workspace.id,
    action,
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
  });
}

async function outcome(result: AppAuthorizationResult): Promise<string> {
  if (result.ok) return result.authority === "app" ? `app:${result.access.role}` : `workspace:${result.fallbackReason}`;
  return `${result.response.status}:${((await result.response.json()) as { error: { code: string } }).error.code}`;
}

function recordingDiagnostics(reasons: string[]): RequestPhaseObserver {
  return {
    async measure<T>(_phase: unknown, operation: () => T | Promise<T>) { return await operation(); },
    observeAppAuthorizationFallback(input) { reasons.push(JSON.stringify(input)); },
  };
}

async function expectPerAppDecisions(operations: ControlPlaneOperations): Promise<void> {
  expect(await outcome(await decide(operations, "app_owner", "uninstall"))).toBe("app:owner");
  expect(await outcome(await decide(operations, "app_member", "change_settings"))).toBe("app:member");
  expect(await outcome(await decide(operations, "dual", "change_settings"))).toBe("app:member");
  expect(await outcome(await decide(operations, "app_member", "uninstall"))).toBe("403:app_owner_only");
  expect(await outcome(await decide(operations, "dual", "transfer_ownership"))).toBe("403:app_owner_only");
  for (const subject of ["ws_owner", "ws_admin", "ws_member", "stranger"]) {
    expect(await outcome(await decide(operations, subject, "view"))).toBe("403:app_access_denied");
  }
  // Workspace-bound credentials keep their Workspace fence before any role.
  expect(await outcome(await decide(operations, "app_owner", "view", { session: { workspaceId: "ws_other" } })))
    .toBe("403:app_access_denied");
  expect(await outcome(await decide(operations, "app_owner", "view", { session: { credential: "personal-access-token", appIds: ["cap_other"] } })))
    .toBe("403:app_access_denied");
  // An installed app's own token is the intersection with its Workspace limit.
  expect(await outcome(await decide(operations, "app_owner", "view", {
    session: { credential: "oauth-access-token", appIds: [capsule.id], workspaceId: workspace.id },
  }))).toBe("403:app_access_denied");
  expect(await outcome(await decide(operations, "dual", "change_settings", {
    session: { credential: "oauth-access-token", appIds: [capsule.id], workspaceId: workspace.id },
  }))).toBe("app:member");
  // A Capsule the backfill has not reached keeps the Workspace decision.
  const reasons: string[] = [];
  expect(await outcome(await decide(operations, "ws_admin", "change_settings", {
    capsuleId: unowned.id, diagnostics: recordingDiagnostics(reasons),
  }))).toBe("workspace:capsule_not_backfilled");
  expect(await outcome(await decide(operations, "app_member", "view", { capsuleId: unowned.id }))).toBe("403:forbidden");
  expect(reasons).toEqual([JSON.stringify({ reason: "capsule_not_backfilled" })]);
}

async function expectWorkspaceFallback(operations: ControlPlaneOperations): Promise<void> {
  const reasons: string[] = [];
  const diagnostics = recordingDiagnostics(reasons);
  expect(await outcome(await decide(operations, "ws_owner", "uninstall", { diagnostics }))).toBe("workspace:ownership_schema_unavailable");
  expect(await outcome(await decide(operations, "ws_admin", "change_settings", { diagnostics }))).toBe("workspace:ownership_schema_unavailable");
  expect(await outcome(await decide(operations, "ws_member", "view", { diagnostics }))).toBe("workspace:ownership_schema_unavailable");
  expect(await outcome(await decide(operations, "ws_member", "change_settings", { diagnostics }))).toBe("403:forbidden");
  expect(await outcome(await decide(operations, "stranger", "view", { diagnostics }))).toBe("403:forbidden");
  expect(new Set(reasons)).toEqual(new Set([JSON.stringify({ reason: "ownership_schema_unavailable" })]));
}

test("D1 v75 (pre-ownership schema) keeps the Workspace decision", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 75 });
  const fence = await acquireControlD1MaintenanceFence(db, {
    sourceCommit: "a".repeat(40), manifestDigest: `sha256:${"b".repeat(64)}`,
    environment: "test", databaseRole: "in_place", releasePolicy: "in_place",
  }, NOW);
  await releaseControlD1MaintenanceFence(db, fence, "2026-10-29T00:00:01.000Z");
  const control = new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" });
  const store = new D1AppOwnershipStore(db, control);
  expect(await store.readOwnershipFence(capsule.id)).toEqual({ schemaAvailable: false });
  await expectWorkspaceFallback(operationsFor(store, control));
}, 180_000);

test("D1 with ownership rows decides per app only", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const control = new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" });
  await control.putWorkspace(workspace);
  await control.putCapsule(capsule);
  await control.putCapsule(unowned);
  const store = new D1AppOwnershipStore(db, control);
  expect(await store.initializeOwnershipIfMissing({
    capsuleId: capsule.id, ownerAccountId: "app_owner", ownershipEpoch: 0,
    managementState: "active", managementEpoch: 0, storageRoot: `apps/${capsule.id}`,
  })).toBe(true);
  for (const accountId of ["app_member", "dual"]) {
    expect(await store.putMember({ capsuleId: capsule.id, accountId, status: "active", createdAt: NOW, updatedAt: NOW })).toBe(true);
  }
  await expectPerAppDecisions(operationsFor(store, control));
}, 180_000);

test("Postgres before v123 keeps the Workspace decision", async () => {
  const client = await PGliteSqlClient.createThroughMigrationVersion(122);
  try {
    const control = { getCapsule: async () => capsule } as unknown as OpenTofuControlStore;
    const store = new SqlAppOwnershipStore(client, control);
    expect(await store.readOwnershipFence(capsule.id)).toEqual({ schemaAvailable: false });
    await expectWorkspaceFallback(operationsFor(store, control));
  } finally {
    await client.close();
  }
}, 180_000);

test("Postgres with ownership rows decides per app only", async () => {
  const client = await PGliteSqlClient.create();
  try {
    for (const row of [capsule, unowned]) {
      await client.query(`insert into takosumi_capsules (
        id,space_id,project_id,name,environment,source_id,install_config_id,
        current_state_version_id,status,installation_json,created_at,updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`, [
        row.id, row.workspaceId, row.projectId, row.name, row.environment, row.sourceId, row.installConfigId,
        null, row.status, JSON.stringify(row), NOW, NOW,
      ]);
    }
    const capsules = new Map([[capsule.id, capsule], [unowned.id, unowned]]);
    const control = { getCapsule: async (id: string) => capsules.get(id) } as unknown as OpenTofuControlStore;
    const store = new SqlAppOwnershipStore(client, control);
    expect(await store.initializeOwnershipIfMissing({
      capsuleId: capsule.id, ownerAccountId: "app_owner", ownershipEpoch: 0,
      managementState: "active", managementEpoch: 0, storageRoot: `apps/${capsule.id}`,
    })).toBe(true);
    for (const accountId of ["app_member", "dual"]) {
      expect(await store.putMember({ capsuleId: capsule.id, accountId, status: "active", createdAt: NOW, updatedAt: NOW })).toBe(true);
    }
    await expectPerAppDecisions(operationsFor(store, control));
  } finally {
    await client.close();
  }
}, 180_000);

test("a missing ownership port is a reported fallback, never a per-app grant", async () => {
  const reasons: string[] = [];
  const operations = {
    workspaces: { getWorkspace: async () => workspace },
    members: { getMember: async (_id: string, accountId: string) => workspaceMembers.find((row) => row.accountId === accountId) },
  } as unknown as ControlPlaneOperations;
  expect(await outcome(await decide(operations, "ws_admin", "change_settings", { diagnostics: recordingDiagnostics(reasons) })))
    .toBe("workspace:ownership_store_unavailable");
  expect(reasons).toEqual([JSON.stringify({ reason: "ownership_store_unavailable" })]);
});

test("ownership changing between the fence read and the role read fails closed", async () => {
  let reads = 0;
  const store = {
    readOwnershipFence: async () => ({ schemaAvailable: true, ownership: {
      capsuleId: capsule.id, ownerAccountId: "app_owner", ownershipEpoch: 0,
      managementState: "active", managementEpoch: 0, storageRoot: "apps/cap_fence",
    } }),
    resolveAppAccess: async () => ({ capsuleId: capsule.id, role: "owner", ownerAccountId: ++reads ? "new_owner" : "app_owner", ownershipEpoch: 1 }),
  } as unknown as AppOwnershipStore;
  expect(await outcome(await decide(operationsFor(store, { getCapsule: async () => capsule }), "app_owner", "view"))).toBe("409:conflict");
});

test("destroyed apps stay readable to their retained owner and members only", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const control = new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" });
  await control.putWorkspace(workspace);
  await control.putCapsule({ ...capsule, status: "destroyed" });
  const store = new D1AppOwnershipStore(db, control);
  await store.initializeOwnershipIfMissing({
    capsuleId: capsule.id, ownerAccountId: "app_owner", ownershipEpoch: 0,
    managementState: "active", managementEpoch: 0, storageRoot: `apps/${capsule.id}`,
  });
  await store.putMember({ capsuleId: capsule.id, accountId: "app_member", status: "active", createdAt: NOW, updatedAt: NOW });
  expect(await store.resolveAppAccess("app_owner", capsule.id)).toBeUndefined();
  const operations = operationsFor(store, control);
  expect(await outcome(await decide(operations, "app_owner", "view"))).toBe("app:owner");
  expect(await outcome(await decide(operations, "app_member", "view"))).toBe("app:member");
  expect(await outcome(await decide(operations, "ws_owner", "view"))).toBe("403:app_access_denied");
}, 180_000);

/** Counting D1 double, adapted from the review probe. */
function countingD1(columns: string[], options: { readonly failPragma?: string; readonly failSelect?: string } = {}) {
  const log: string[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        bind() { return statement; },
        async all() {
          log.push(sql);
          if (sql.startsWith("pragma") && options.failPragma) throw new Error(options.failPragma);
          return { results: sql.startsWith("pragma table_info(capsules)") ? columns.map((name) => ({ name })) : [] };
        },
        async first() {
          log.push(sql);
          if (options.failSelect) throw new Error(options.failSelect);
          return { owner_account_id: "acct", ownership_epoch: 0, management_state: "active", management_epoch: 0, storage_root: "x" };
        },
      };
      return statement;
    },
  };
  return { db, log, pragmas: () => log.filter((query) => query.startsWith("pragma")).length };
}

test("a pre-v77 D1 probes the ownership schema at most once per TTL for the fence", async () => {
  let now = 1_000;
  const d1 = countingD1(["id", "space_id"]);
  const store = new D1AppOwnershipStore(d1.db as never, {} as never, () => now);
  for (let index = 0; index < 5; index++) expect(await store.readOwnershipFence("cap")).toEqual({ schemaAvailable: false });
  expect(d1.pragmas()).toBe(1);
  now += 60_001;
  expect(await store.readOwnershipFence("cap")).toEqual({ schemaAvailable: false });
  expect(d1.pragmas()).toBe(2);
});

test("a v77 D1 keeps the positive probe cached and reads one row per fence", async () => {
  const d1 = countingD1(["id", "owner_account_id"]);
  const store = new D1AppOwnershipStore(d1.db as never, {} as never);
  for (let index = 0; index < 5; index++) await store.readOwnershipFence("cap");
  expect(d1.pragmas()).toBe(1);
  expect(d1.log.length).toBe(6);
});

test("transient D1 failures are errors, never a schema-absent fallback", async () => {
  await expect(new D1AppOwnershipStore(countingD1(["id"], { failPragma: "D1_ERROR: Network connection lost." }).db as never, {} as never)
    .readOwnershipFence("cap")).rejects.toThrow("Network connection lost");
  await expect(new D1AppOwnershipStore(countingD1(["owner_account_id"], { failSelect: "D1_ERROR: Overloaded" }).db as never, {} as never)
    .readOwnershipFence("cap")).rejects.toThrow("Overloaded");
});
