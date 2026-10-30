/**
 * TASK-0118 P9.1-c: an app's first owner is the person who installed it,
 * also when a legacy Workspace route is used by a Workspace admin who is not
 * the Workspace's owner (the shared-account setup). Before the app exists the
 * install attempt is its creator's; listing Workspaces never creates one.
 * Coordinator, Source, Capsule, ownership and ledger operations use their
 * production implementations on each backend.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { D1AppOwnershipStore } from "../../../../core/domains/app-ownership/store.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import type { OpenTofuRunner } from "../../../../core/domains/deploy-control/mod.ts";
import { D1GitInstallPlanStore } from "../../../../core/domains/install-plans/d1_store.ts";
import { InMemoryGitInstallPlanStore } from "../../../../core/domains/install-plans/store.ts";
import { createD1InterfaceStores } from "../../../../core/domains/interfaces/d1_stores.ts";
import { createSqlInterfaceStores } from "../../../../core/domains/interfaces/sql_stores.ts";
import {
  createCloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(120_000);

const WORKSPACE_OWNER = "tsub_shared_workspace_owner";
const ADMIN = "tsub_shared_workspace_admin";
const NEWCOMER = "tsub_without_workspace";
const BACKENDS = ["memory", "postgres", "d1"] as const;
type Backend = (typeof BACKENDS)[number];

const clients: PGliteSqlClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const runner: OpenTofuRunner = {
  plan: async () => { throw new Error("Plan execution is outside this test"); },
  apply: async () => { throw new Error("Apply execution is outside this test"); },
  sourceSync: async () => ({
    resolvedCommit: "a".repeat(40),
    archiveDigest: `sha256:${"b".repeat(64)}`,
    archiveSizeBytes: 64,
    repositoryInstallMetadata: { status: "absent" },
    repositoryManifest: { status: "absent" },
    repositoryModules: {
      status: "ready",
      scopePath: ".",
      modules: [{ path: ".", providerPackages: [], rootProviderRequirements: [] }],
    },
  }),
  readCapsuleSourceFiles: async () => [{
    path: "main.tf",
    text: "output \"ready\" { value = \"yes\" }\n",
  }],
};

async function compose(backend: Backend) {
  const common = {
    role: "takosumi-api" as const,
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuRunner: runner,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
  };
  let deployStore: OpenTofuControlStore;
  let operations: ControlPlaneOperations;
  if (backend === "memory") {
    const memory = new InMemoryOpenTofuControlStore();
    const gitInstallPlanStore = new InMemoryGitInstallPlanStore(memory);
    memory.attachGitInstallPlanStore(gitInstallPlanStore);
    deployStore = memory;
    operations = (await createTakosumiService({ ...common, opentofuControlStore: memory, gitInstallPlanStore }))
      .operations as unknown as ControlPlaneOperations;
  } else if (backend === "postgres") {
    const client = await PGliteSqlClient.create();
    clients.push(client);
    deployStore = new SqlOpenTofuControlStore({ client });
    operations = (await createTakosumiService({
      ...common, sqlClient: client, opentofuControlStore: deployStore, interfaceStores: createSqlInterfaceStores(client),
    })).operations as unknown as ControlPlaneOperations;
  } else {
    const db = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(db);
    deployStore = createCloudflareD1OpenTofuControlStore(db);
    operations = (await createTakosumiService({
      ...common,
      opentofuControlStore: deployStore,
      appOwnershipStore: new D1AppOwnershipStore(db, deployStore),
      gitInstallPlanStore: new D1GitInstallPlanStore(db),
      interfaceStores: createD1InterfaceStores(db),
    })).operations as unknown as ControlPlaneOperations;
  }
  // A shared Workspace: its owner and an admin who is not the owner.
  const workspace = await operations.workspaces.createWorkspace!({
    handle: `shared-install-${backend}`,
    displayName: "Shared install",
    type: "personal",
    ownerUserId: WORKSPACE_OWNER,
  });
  const at = new Date().toISOString();
  await deployStore.putWorkspaceMember({
    id: `wsm_shared_install_${backend}`, workspaceId: workspace.id, accountId: ADMIN, roles: ["admin"],
    status: "active", createdAt: at, updatedAt: at,
  });
  const accounts = new InMemoryAccountsStore();
  const now = Date.now();
  for (const subject of [WORKSPACE_OWNER, ADMIN, NEWCOMER]) {
    accounts.saveAccount({ subject: subject as never, email: `${subject}@example.test`, displayName: subject, createdAt: now, updatedAt: now });
    accounts.saveAccountSession({ sessionId: `sess_${backend}_${subject}`, subject: subject as never, createdAt: now, expiresAt: now + 10 * 60_000 });
  }
  async function route(subject: string, method: string, path: string, body?: unknown, key?: string) {
    const url = new URL(`https://app.takosumi.test${path}`);
    const response = await handleControlRoute({
      request: new Request(url, {
        method,
        headers: {
          cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=sess_${backend}_${subject}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      url,
      store: accounts,
      operations,
    });
    expect(response).toBeDefined();
    return response!;
  }
  async function reconcileUntil(subject: string, planId: string, phase: string) {
    // deno-lint-ignore no-explicit-any
    let plan: any;
    for (let step = 0; step < 10; step += 1) {
      const response = await route(subject, "POST", `/api/v1/install-plans/${planId}/reconcile`);
      expect(response.status).toBe(200);
      plan = (await response.json()).installPlan;
      if (plan.phase === phase || plan.phase === "failed") break;
    }
    return plan;
  }
  return { deployStore, operations, workspaceId: workspace.id, route, reconcileUntil };
}

const NORMAL_INSTALL = (name: string) => ({
  source: { name, url: "https://github.com/takos/example.git", ref: "main", path: "." },
  capsule: { name, environment: "production" },
  options: { modulePath: ".", providerBindings: [] },
});

for (const backend of BACKENDS) {
  test(`[${backend}] a Workspace admin's install is owned by the admin, not the Workspace owner`, async () => {
    const fixture = await compose(backend);
    const created = await fixture.route(ADMIN, "POST", `/api/v1/workspaces/${fixture.workspaceId}/install-plans`, NORMAL_INSTALL("admins-app"), "admin-install");
    expect(created.status).toBe(201);
    const planId = (await created.json()).installPlan.id as string;
    const plan = await fixture.reconcileUntil(ADMIN, planId, "planning");
    expect(plan.phase).toBe("planning");
    const capsule = await fixture.operations.capsules.getCapsule(plan.capsuleId);
    expect(capsule).toMatchObject({ workspaceId: fixture.workspaceId, installingPrincipalId: ADMIN });
    expect((await fixture.operations.appOwnership!.getOwnership(capsule.id))?.ownerAccountId).toBe(ADMIN);
    // Creation still seeds the Workspace's other owner/admin people as app
    // members (unchanged store behaviour, kept for shared Workspaces until
    // TASK-0118 9B): the Workspace owner is a member of the admin's app, not
    // its owner, so owner-only actions are refused.
    expect((await fixture.operations.appAccess!.resolveAppAccess(WORKSPACE_OWNER, capsule.id))?.role).toBe("member");
    expect((await fixture.route(WORKSPACE_OWNER, "GET", `/api/v1/capsules/${capsule.id}`)).status).toBe(200);
    const uninstall = await fixture.route(WORKSPACE_OWNER, "POST", `/api/v1/capsules/${capsule.id}/uninstall`, {});
    expect(uninstall.status).toBe(403);
    expect((await uninstall.json()).error.code).toBe("app_owner_only");
    expect((await fixture.operations.appAccess!.resolveAppAccess(ADMIN, capsule.id))?.role).toBe("owner");
    // Someone with no Workspace role gets nothing.
    expect((await fixture.route(NEWCOMER, "GET", `/api/v1/capsules/${capsule.id}`)).status).toBe(403);
  });

  test(`[${backend}] the Workspace owner's own install is still owned by the Workspace owner`, async () => {
    const fixture = await compose(backend);
    const created = await fixture.route(WORKSPACE_OWNER, "POST", `/api/v1/workspaces/${fixture.workspaceId}/install-plans`, NORMAL_INSTALL("owners-app"), "owner-install");
    expect(created.status).toBe(201);
    const plan = await fixture.reconcileUntil(WORKSPACE_OWNER, (await created.json()).installPlan.id, "planning");
    expect((await fixture.operations.appOwnership!.getOwnership(plan.capsuleId))?.ownerAccountId).toBe(WORKSPACE_OWNER);
  });

  test(`[${backend}] before its app exists an install is its creator's, without a Workspace decision`, async () => {
    const fixture = await compose(backend);
    const created = await fixture.route(ADMIN, "POST", `/api/v1/workspaces/${fixture.workspaceId}/install-plans`, NORMAL_INSTALL("creators-app"), "creator-install");
    expect(created.status).toBe(201);
    const planId = (await created.json()).installPlan.id as string;
    // The admin leaves the Workspace: their own capsule-less install continues.
    const member = await fixture.deployStore.getWorkspaceMember(fixture.workspaceId, ADMIN);
    await fixture.deployStore.putWorkspaceMember({ ...member!, status: "suspended", updatedAt: new Date().toISOString() });
    expect((await fixture.route(ADMIN, "GET", `/api/v1/install-plans/${planId}`)).status).toBe(200);
    const plan = await fixture.reconcileUntil(ADMIN, planId, "planning");
    expect((await fixture.operations.appOwnership!.getOwnership(plan.capsuleId))?.ownerAccountId).toBe(ADMIN);
    // Someone who neither created it nor holds a Workspace role is refused.
    const other = await fixture.route(NEWCOMER, "POST", `/api/v1/workspaces/${fixture.workspaceId}/install-plans`, NORMAL_INSTALL("x"), "x");
    expect(other.status).toBe(403);
  });

  test(`[${backend}] listing Workspaces never creates a personal Workspace`, async () => {
    const fixture = await compose(backend);
    const listed = await fixture.route(NEWCOMER, "GET", "/api/v1/workspaces");
    expect(listed.status).toBe(200);
    expect((await listed.json()).workspaces).toEqual([]);
    expect(await fixture.operations.workspaces.listWorkspacesByOwner(NEWCOMER)).toEqual([]);
    // A write that needs the namespace still fills it: a workspace-less install.
    const created = await fixture.route(NEWCOMER, "POST", "/api/v1/install-plans", {
      mode: "attempt", source: { url: "https://github.com/takos/example.git", ref: "main" },
    }, "newcomer-install");
    expect(created.status).toBe(201);
    const owned = await fixture.operations.workspaces.listWorkspacesByOwner(NEWCOMER);
    expect(owned).toHaveLength(1);
    expect((await created.json()).installPlan).toMatchObject({ workspaceId: owned[0]!.id, createdBy: NEWCOMER });
    // The existing namespace is shown by the list, not recreated.
    const relisted = await fixture.route(NEWCOMER, "GET", "/api/v1/workspaces");
    expect(((await relisted.json()).workspaces as { id: string }[]).map((row) => row.id)).toEqual([owned[0]!.id]);
  });

  test(`[${backend}] workspace-less install idempotency is per actor`, async () => {
    const fixture = await compose(backend);
    const body = { mode: "attempt", source: { url: "https://github.com/takos/example.git", ref: "main" } };
    const first = await fixture.route(NEWCOMER, "POST", "/api/v1/install-plans", body, "same-key");
    expect(first.status).toBe(201);
    const firstPlan = (await first.json()).installPlan;
    const replay = await fixture.route(NEWCOMER, "POST", "/api/v1/install-plans", body, "same-key");
    expect(replay.status).toBe(200);
    expect((await replay.json()).installPlan.id).toBe(firstPlan.id);
    expect((await fixture.route(NEWCOMER, "POST", "/api/v1/install-plans", { ...body, capsule: { name: "other" } }, "same-key")).status)
      .toBe(409);
    // Another account's identical key is its own install.
    const another = await fixture.route(ADMIN, "POST", "/api/v1/install-plans", body, "same-key");
    expect(another.status).toBe(201);
    const anotherPlan = (await another.json()).installPlan;
    expect(anotherPlan.id).not.toBe(firstPlan.id);
    expect(anotherPlan.createdBy).toBe(ADMIN);
    expect(anotherPlan.workspaceId).not.toBe(firstPlan.workspaceId);
  });
}
