import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import type { Capsule } from "takosumi-contract/install-configs";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { D1AppOwnershipStore } from "../../../../core/domains/app-ownership/store.ts";
import { DEFAULT_CAPSULE_INSTALL_CONFIG_ID } from "../../../../core/domains/capsules/default_install_config.ts";
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
import { defaultProjectId } from "../../../../core/domains/projects/mod.ts";
import {
  createCloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(120_000);

const OWNER = "user_name_conflict";
const SESSION = "sess_name_conflict";
const BACKENDS = ["memory", "postgres", "d1"] as const;
type Backend = (typeof BACKENDS)[number];

const clients: PGliteSqlClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

// Git execution is the external boundary. Coordinator, Source, Capsule and
// ledger operations use their production implementations on each backend.
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
    // Pair the Git store with the control store so a freeze observes it.
    const gitInstallPlanStore = new InMemoryGitInstallPlanStore(memory);
    memory.attachGitInstallPlanStore(gitInstallPlanStore);
    deployStore = memory;
    ({ operations } = await createTakosumiService({
      ...common,
      opentofuControlStore: memory,
      gitInstallPlanStore,
    }));
  } else if (backend === "postgres") {
    const client = await PGliteSqlClient.create();
    clients.push(client);
    deployStore = new SqlOpenTofuControlStore({ client });
    ({ operations } = await createTakosumiService({
      ...common,
      sqlClient: client,
      opentofuControlStore: deployStore,
      interfaceStores: createSqlInterfaceStores(client),
    }));
  } else {
    const db = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(db);
    deployStore = createCloudflareD1OpenTofuControlStore(db);
    ({ operations } = await createTakosumiService({
      ...common,
      opentofuControlStore: deployStore,
      appOwnershipStore: new D1AppOwnershipStore(db, deployStore),
      gitInstallPlanStore: new D1GitInstallPlanStore(db),
      interfaceStores: createD1InterfaceStores(db),
    }));
  }
  const workspace = await operations.workspaces.createWorkspace({
    handle: `name-conflict-${backend}`,
    displayName: "Name conflict",
    type: "personal",
    ownerUserId: OWNER,
  });
  const accountStore = new InMemoryAccountsStore();
  const now = Date.now();
  accountStore.saveAccount({
    subject: OWNER,
    email: "installer@example.test",
    displayName: "Installer",
    createdAt: now,
    updatedAt: now,
  });
  accountStore.saveAccountSession({
    sessionId: SESSION,
    subject: OWNER,
    createdAt: now,
    expiresAt: now + 10 * 60_000,
  });

  async function route(method: string, path: string, body?: unknown, key?: string) {
    const url = new URL(`https://app.takosumi.test${path}`);
    const response = await handleControlRoute({
      request: new Request(url, {
        method,
        headers: {
          cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${SESSION}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      url,
      store: accountStore,
      operations,
    });
    expect(response).toBeDefined();
    return response!;
  }

  /** A normal install plan (no `mode`), exactly as the legacy route takes it. */
  async function createNormalInstall(name: string, key: string): Promise<string> {
    const created = await route("POST", `/api/v1/workspaces/${workspace.id}/install-plans`, {
      source: { name, url: "https://github.com/takos/example.git", ref: "main", path: "." },
      capsule: { name, environment: "production" },
      options: { modulePath: ".", providerBindings: [] },
    }, key);
    expect(created.status).toBe(201);
    const plan = (await created.json()).installPlan;
    expect(plan.mode).toBeUndefined();
    return plan.id as string;
  }

  /** Reconciles until the plan stops at `phase` or is terminal; records every status. */
  async function reconcileUntil(planId: string, phase: string, limit = 10) {
    const statuses: number[] = [];
    // deno-lint-ignore no-explicit-any
    let plan: any;
    for (let step = 0; step < limit; step += 1) {
      const response = await route("POST", `/api/v1/install-plans/${planId}/reconcile`);
      statuses.push(response.status);
      plan = (await response.json()).installPlan;
      if (plan.phase === phase || plan.phase === "failed") break;
    }
    return { plan, statuses };
  }

  /** A live app of this name, committed by another install. */
  async function putLiveApp(name: string): Promise<Capsule> {
    const at = new Date().toISOString();
    const capsule: Capsule = {
      id: `cap_live_${backend}_${name.replace(/[^a-z0-9]/gu, "")}`,
      workspaceId: workspace.id,
      projectId: defaultProjectId(workspace.id),
      name,
      slug: name,
      environment: "production",
      sourceId: `src_live_${backend}`,
      installConfigId: DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
      installingPrincipalId: OWNER,
      currentStateGeneration: 1,
      status: "active",
      createdAt: at,
      updatedAt: at,
    };
    await deployStore.putCapsule(capsule);
    return capsule;
  }

  return {
    backend,
    deployStore,
    operations,
    workspaceId: workspace.id,
    route,
    createNormalInstall,
    reconcileUntil,
    putLiveApp,
  };
}

function deterministicCapsuleId(planId: string): string {
  return `cap_${planId.replace(/[^A-Za-z0-9]/gu, "").slice(-16)}`;
}

async function capsuleExists(
  operations: ControlPlaneOperations,
  capsuleId: string,
): Promise<boolean> {
  try {
    await operations.capsules.getCapsule(capsuleId);
    return true;
  } catch {
    return false;
  }
}

for (const backend of BACKENDS) {
  test(`[${backend}] a normal install whose name a live app uses ends failed with capsule_name_conflict instead of retrying`, async () => {
    const fixture = await compose(backend);
    const live = await fixture.putLiveApp("example");
    const planId = await fixture.createNormalInstall("example", "normal-name-conflict");

    const { plan, statuses } = await fixture.reconcileUntil(planId, "planning");
    expect(plan).toMatchObject({
      phase: "failed",
      diagnostic: { code: "capsule_name_conflict" },
    });
    expect(plan.capsuleId).toBeUndefined();
    // Never a retryable 202 loop: every step is a definite answer.
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(await capsuleExists(fixture.operations, deterministicCapsuleId(planId))).toBe(false);
    expect((await fixture.operations.capsules.getCapsule(live.id)).updatedAt).toBe(live.updatedAt);
    expect(await fixture.operations.gitInstallPlans.hasWorkspaceManagementBlockers(fixture.workspaceId))
      .toBe(false);

    // A terminal plan is not reconciled again.
    const again = await fixture.route("POST", `/api/v1/install-plans/${planId}/reconcile`);
    expect(again.status).toBe(200);
    expect((await again.json()).installPlan).toMatchObject({
      phase: "failed",
      generation: plan.generation,
    });
  });

  test(`[${backend}] a name committed after the pre-check is settled from the store conflict, not retried`, async () => {
    const fixture = await compose(backend);
    const live = await fixture.putLiveApp("raced");
    const planId = await fixture.createNormalInstall("raced", "raced-name-conflict");
    expect((await fixture.reconcileUntil(planId, "creating_capsule")).plan.phase)
      .toBe("creating_capsule");

    // The other app commits between the live name pre-check and the
    // create-only commit: the first listing does not see it yet.
    const capsules = fixture.operations.capsules;
    const listCapsules = capsules.listCapsules.bind(capsules);
    let hidden = 0;
    capsules.listCapsules = async (workspaceId: string) => {
      const listed = await listCapsules(workspaceId);
      if (hidden > 0) return listed;
      hidden += 1;
      return listed.filter((capsule) => capsule.id !== live.id);
    };
    try {
      const settled = await fixture.route("POST", `/api/v1/install-plans/${planId}/reconcile`);
      expect(settled.status).toBe(200);
      expect((await settled.json()).installPlan).toMatchObject({
        phase: "failed",
        diagnostic: { code: "capsule_name_conflict" },
      });
    } finally {
      capsules.listCapsules = listCapsules;
    }
    expect(hidden).toBe(1);
    expect(await capsuleExists(fixture.operations, deterministicCapsuleId(planId))).toBe(false);
  });

  test(`[${backend}] any other initial-authority conflict ends failed and names the precondition`, async () => {
    const fixture = await compose(backend);
    const live = await fixture.putLiveApp("hidden");
    const planId = await fixture.createNormalInstall("hidden", "hidden-name-conflict");
    expect((await fixture.reconcileUntil(planId, "creating_capsule")).plan.phase)
      .toBe("creating_capsule");

    // No visible name explains the store's conflict.
    const capsules = fixture.operations.capsules;
    const listCapsules = capsules.listCapsules.bind(capsules);
    capsules.listCapsules = async (workspaceId: string) =>
      (await listCapsules(workspaceId)).filter((capsule) => capsule.id !== live.id);
    try {
      const settled = await fixture.route("POST", `/api/v1/install-plans/${planId}/reconcile`);
      expect(settled.status).toBe(200);
      expect((await settled.json()).installPlan).toMatchObject({
        phase: "failed",
        diagnostic: {
          code: "capsule_initial_authority_conflict",
          controllerCode: "failed_precondition",
          reason: "capsule_initial_authority_conflict",
        },
      });
    } finally {
      capsules.listCapsules = listCapsules;
    }
  });

  test(`[${backend}] a lost acknowledgement of the plan's own commit is adopted, not failed`, async () => {
    const fixture = await compose(backend);
    const planId = await fixture.createNormalInstall("adopted", "lost-ack-adoption");
    expect((await fixture.reconcileUntil(planId, "creating_capsule")).plan.phase)
      .toBe("creating_capsule");

    // The first commit lands with different bytes (here: an auto-update
    // marker), then its acknowledgement is lost. The exact retry can no longer
    // replay it, so the store answers conflict.
    const capsules = fixture.operations.capsules;
    const create = capsules.createCapsuleInitialAuthority.bind(capsules);
    capsules.createCapsuleInitialAuthority = async (request) => {
      await create({ ...request, autoUpdate: true } as typeof request);
      throw new Error("acknowledgement lost after commit");
    };
    let lost;
    try {
      lost = await fixture.route("POST", `/api/v1/install-plans/${planId}/reconcile`);
    } finally {
      capsules.createCapsuleInitialAuthority = create;
    }
    expect(lost.status).toBe(202);
    expect((await lost.json()).installPlan).toMatchObject({
      phase: "creating_capsule",
      diagnostic: { code: "install_plan_reconcile_retryable" },
    });
    const capsuleId = deterministicCapsuleId(planId);
    const committed = await fixture.operations.capsules.getCapsule(capsuleId);

    const adopted = await fixture.route("POST", `/api/v1/install-plans/${planId}/reconcile`);
    expect(adopted.status).toBe(200);
    expect((await adopted.json()).installPlan).toMatchObject({
      phase: "planning",
      capsuleId,
      installConfigId: committed.installConfigId,
    });
  });

  test(`[${backend}] a stuck normal install is listed, discarded by its creator, and stops blocking a drain`, async () => {
    const fixture = await compose(backend);
    const planId = await fixture.createNormalInstall("stuck", "stuck-normal-install");
    expect((await fixture.reconcileUntil(planId, "creating_capsule")).plan.phase)
      .toBe("creating_capsule");

    // An unknown failure that never commits keeps the plan retrying.
    const capsules = fixture.operations.capsules;
    const create = capsules.createCapsuleInitialAuthority.bind(capsules);
    capsules.createCapsuleInitialAuthority = async () => {
      throw new Error("store unavailable");
    };
    try {
      for (let step = 0; step < 3; step += 1) {
        const retried = await fixture.route("POST", `/api/v1/install-plans/${planId}/reconcile`);
        expect(retried.status).toBe(202);
      }
    } finally {
      capsules.createCapsuleInitialAuthority = create;
    }
    const stuck = (await fixture.operations.gitInstallPlans.get(planId))!;
    expect(stuck).toMatchObject({
      phase: "creating_capsule",
      diagnostic: { code: "install_plan_reconcile_retryable" },
    });
    expect(stuck.capsuleId).toBeUndefined();
    expect(await fixture.operations.gitInstallPlans.hasWorkspaceManagementBlockers(fixture.workspaceId))
      .toBe(true);

    // It is listed where unfinished installs are, so its creator can see it.
    const listed = await fixture.route(
      "GET",
      `/api/v1/workspaces/${fixture.workspaceId}/install-plans?open=1`,
    );
    expect(listed.status).toBe(200);
    expect(((await listed.json()).installPlans as { installPlan: { id: string } }[])
      .map((entry) => entry.installPlan.id)).toEqual([planId]);

    // A drain cannot freeze the Workspace while it stays non-terminal.
    const draining = await fixture.deployStore.beginWorkspaceDraining(fixture.workspaceId, {
      workspaceId: fixture.workspaceId,
      managementState: "active",
      managementEpoch: 1,
    });
    expect(draining.status).toBe("started");
    const expectation = {
      workspaceId: fixture.workspaceId,
      managementState: "draining" as const,
      managementEpoch: 2,
    };
    expect((await fixture.deployStore.freezeWorkspaceManagementIfQuiescent(expectation)).status)
      .toBe("blocked");
    // The drain itself settles only never-claimed plans.
    expect((await fixture.operations.gitInstallPlans.failUnclaimedDuringDrain({
      id: planId,
      expectedWorkspaceManagement: expectation,
      completedAt: new Date().toISOString(),
    })).status).toBe("conflict");

    // Its creator discards it: no lease is held and no Capsule exists.
    const discarded = await fixture.route(
      "DELETE",
      `/api/v1/install-plans/${planId}`,
      { expectedGeneration: stuck.generation },
    );
    expect(discarded.status).toBe(200);
    expect((await discarded.json()).installPlan).toMatchObject({
      phase: "discarded",
      generation: stuck.generation + 2,
      diagnostic: { code: "install_plan_discarded" },
    });
    expect(await capsuleExists(fixture.operations, deterministicCapsuleId(planId))).toBe(false);
    expect(await fixture.operations.gitInstallPlans.hasWorkspaceManagementBlockers(fixture.workspaceId))
      .toBe(false);
    expect((await fixture.deployStore.freezeWorkspaceManagementIfQuiescent(expectation)).status)
      .toBe("frozen");
  });
}
