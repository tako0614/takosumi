import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
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
import {
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  fixtureExecutionEvidence,
} from "../../../helpers/deploy-control/model_fixture.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(180_000);

// An app installed at an exact commit owns its Source (TASK-0118). Its Source
// syncs carry the account that asked for them, so a version change must too.
const OWNER = "user_owned_revision";
const SESSION = "sess_owned_revision";
const PINNED = "a17e4f883cb90a1b2c3d4e5f60718293a4b5c6d7";
const MAIN_HEAD = "0123456789abcdef0123456789abcdef01234567";
const MOVED_HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const PLAN_DIGEST = `sha256:${"1".repeat(64)}`;
const LOCK_DIGEST = `sha256:${"2".repeat(64)}`;
const STATE_DIGEST = `sha256:${"3".repeat(64)}`;
const BACKENDS = ["memory", "postgres", "d1"] as const;
type Backend = (typeof BACKENDS)[number];

const clients: PGliteSqlClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function compose(backend: Backend, runner: OpenTofuRunner): Promise<{
  readonly deployStore: OpenTofuControlStore;
  readonly operations: ControlPlaneOperations;
}> {
  const common = {
    role: "takosumi-api" as const,
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuRunner: runner,
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
  };
  if (backend === "memory") {
    const memory = new InMemoryOpenTofuControlStore();
    const gitInstallPlanStore = new InMemoryGitInstallPlanStore(memory);
    memory.attachGitInstallPlanStore(gitInstallPlanStore);
    const { operations } = await createTakosumiService({
      ...common,
      opentofuControlStore: memory,
      gitInstallPlanStore,
    });
    return { deployStore: memory, operations };
  }
  if (backend === "postgres") {
    const client = await PGliteSqlClient.create();
    clients.push(client);
    const deployStore = new SqlOpenTofuControlStore({ client });
    const { operations } = await createTakosumiService({
      ...common,
      sqlClient: client,
      opentofuControlStore: deployStore,
      interfaceStores: createSqlInterfaceStores(client),
    });
    return { deployStore, operations };
  }
  // The production Control D1 composition.
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const deployStore = createCloudflareD1OpenTofuControlStore(db);
  const { operations } = await createTakosumiService({
    ...common,
    opentofuControlStore: deployStore,
    appOwnershipStore: new D1AppOwnershipStore(db, deployStore),
    gitInstallPlanStore: new D1GitInstallPlanStore(db),
    interfaceStores: createD1InterfaceStores(db),
  });
  return { deployStore, operations };
}

async function ownedAppFixture(kind: Backend, installRef: string) {
  const branchHeads = new Map<string, string>([["main", MAIN_HEAD]]);
  const syncedRefs: string[] = [];
  // Git and OpenTofu execution are the external boundary. Coordinators,
  // Sources, Capsules, ownership and the ledger are production services.
  const runner: OpenTofuRunner = {
    sourceSync: async (job) => {
      syncedRefs.push(job.source.ref);
      const resolvedCommit = /^[0-9a-f]{40}$/u.test(job.source.ref)
        ? job.source.ref
        : branchHeads.get(job.source.ref);
      if (!resolvedCommit) throw new Error(`unknown ref ${job.source.ref}`);
      return {
        resolvedCommit,
        archiveDigest: `sha256:${resolvedCommit.slice(0, 16).padEnd(64, "0")}`,
        archiveSizeBytes: 64,
        repositoryInstallMetadata: { status: "absent" },
        repositoryManifest: { status: "absent" },
        repositoryModules: {
          status: "ready",
          scopePath: ".",
          modules: [{ path: ".", providerPackages: [], rootProviderRequirements: [] }],
        },
      };
    },
    cleanupUnusedSourceArchive: async () => {},
    readCapsuleSourceFiles: async () => [{
      path: "main.tf",
      text: "output \"ready\" { value = \"yes\" }\n",
    }],
    plan: async () => ({
      planDigest: PLAN_DIGEST,
      planArtifact: {
        kind: "runner-local",
        ref: "runner-local://plan/tfplan",
        digest: PLAN_DIGEST,
        contentType: "application/vnd.opentofu.plan",
      },
      providerLockDigest: LOCK_DIGEST,
      requiredProviders: [],
      providerInstallation: [],
      planResourceChanges: [],
    }),
    apply: async (job) => ({
      outputs: {} as never,
      stateDigest: STATE_DIGEST,
      rawOutputRef: job.rawOutputRef,
      providerInstallation: [],
      executionEvidence: fixtureExecutionEvidence(job, "apply"),
    }),
  };
  const { deployStore, operations } = await compose(kind, runner);
  const workspace = await operations.workspaces.createWorkspace({
    handle: `owned-revision-${kind}`,
    displayName: "Owned revision",
    type: "personal",
    ownerUserId: OWNER,
  });
  const accountStore = new InMemoryAccountsStore();
  const now = Date.now();
  accountStore.saveAccount({
    subject: OWNER,
    email: "owner@example.test",
    displayName: "Owner",
    createdAt: now,
    updatedAt: now,
  });
  accountStore.saveAccountSession({
    sessionId: SESSION,
    subject: OWNER,
    createdAt: now,
    expiresAt: now + 600_000,
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

  async function applyPlanRun(planRunId: string) {
    const applied = await route("POST", `/api/v1/runs/${planRunId}/apply`);
    if (applied.status !== 201) {
      throw new Error(`apply ${applied.status}: ${await applied.text()}`);
    }
    return await applied.json();
  }

  // Install through the composed install coordinator, then apply.
  const created = await route(
    "POST",
    `/api/v1/workspaces/${workspace.id}/install-plans`,
    {
      source: { name: "yurucommu", url: "https://github.com/takos/yurucommu.git", ref: installRef, path: "." },
      capsule: { name: "yurucommu", environment: "production" },
      options: { modulePath: ".", providerBindings: [] },
    },
    `install-${kind}`,
  );
  if (created.status !== 201) throw new Error(`install ${created.status}: ${await created.text()}`);
  const installPlanId = (await created.json()).installPlan.id as string;
  let installPlan: { phase: string; planRunId?: string; capsuleId?: string; sourceId?: string } = {
    phase: "syncing_source",
  };
  for (let step = 0; step < 10 && !installPlan.planRunId; step += 1) {
    const advanced = await route("POST", `/api/v1/install-plans/${installPlanId}/reconcile`);
    expect(advanced.status).toBe(200);
    installPlan = (await advanced.json()).installPlan;
  }
  expect(installPlan.planRunId).toBeString();
  await applyPlanRun(installPlan.planRunId!);
  const capsuleId = installPlan.capsuleId!;
  const sourceId = installPlan.sourceId!;
  const capsule = await deployStore.getCapsule(capsuleId);
  expect(capsule).toMatchObject({ status: "active", currentStateGeneration: 1 });
  expect((await operations.appOwnership.getOwnership(capsuleId))?.ownerAccountId).toBe(OWNER);
  expect(await deployStore.getSource(sourceId)).toMatchObject({
    ownerCapsuleId: capsuleId,
    defaultRef: installRef,
    status: "active",
  });
  syncedRefs.length = 0;

  async function sourceSyncRuns() {
    return (await operations.listRuns(workspace.id)).filter((run) =>
      run.type === "source_sync"
    );
  }

  return {
    operations,
    deployStore,
    workspace,
    capsuleId,
    sourceId,
    syncedRefs,
    branchHeads,
    route,
    applyPlanRun,
    sourceSyncRuns,
    async createRevision(ref: string, key: string) {
      const response = await route("POST", `/api/v1/capsules/${capsuleId}/revision-plans`, { ref }, key);
      expect(response.status).toBe(201);
      return (await response.json()).revisionPlan.id as string;
    },
    async reconcile(planId: string) {
      const response = await route("POST", `/api/v1/revision-plans/${planId}/reconcile`);
      return { status: response.status, body: await response.json() };
    },
    async appView() {
      const response = await route("GET", `/api/v1/capsules/${capsuleId}/app`);
      expect(response.status).toBe(200);
      return await response.json();
    },
  };
}

for (const kind of BACKENDS) {
  test(`[${kind}] a version check the previous release left claimed in syncing_source ends in one reconcile`, async () => {
    const fixture = await ownedAppFixture(kind, PINNED);
    const planId = await fixture.createRevision(PINNED, "stuck-check");
    const stored = (await fixture.operations.gitInstallPlans.get(planId))!;
    // The client's two-minute deadline cut the last request off after it had
    // claimed the row: the lease stays recorded until someone takes it over.
    const abandonedAt = Date.now() - 3 * 60_000;
    const abandoned = await fixture.operations.gitInstallPlans.claimReconcile({
      id: planId,
      expectedGeneration: stored.generation,
      leaseToken: "grpl_abandoned_client",
      claimedAt: new Date(abandonedAt).toISOString(),
      leaseExpiresAt: new Date(abandonedAt + 30_000).toISOString(),
      expectedWorkspaceManagementAuthority: stored.workspaceManagementAuthority!,
    });
    expect(abandoned.status).toBe("claimed");
    expect(await fixture.operations.gitInstallPlans.hasWorkspaceManagementBlockers(fixture.workspace.id))
      .toBe(true);

    const settled = await fixture.reconcile(planId);
    expect(settled.status).toBe(200);
    expect(settled.body.revisionPlan).toMatchObject({
      phase: "failed",
      diagnostic: { code: "revision_already_current" },
    });
    expect(fixture.syncedRefs).toEqual([]);
    expect(await fixture.operations.gitInstallPlans.hasWorkspaceManagementBlockers(fixture.workspace.id))
      .toBe(false);
  });

  test(`[${kind}] checking a commit-pinned owned app for a new version ends as already current, without a Source sync`, async () => {
    const fixture = await ownedAppFixture(kind, PINNED);
    const syncsBefore = (await fixture.sourceSyncRuns()).length;
    const planId = await fixture.createRevision(PINNED, "check-pinned");

    const settled = await fixture.reconcile(planId);
    expect(settled.status).toBe(200);
    expect(settled.body).toMatchObject({
      revisionPlan: {
        phase: "failed",
        diagnostic: { code: "revision_already_current" },
      },
      nextAction: "none",
    });
    expect(settled.body.revisionPlan.sourceSyncRunId).toBeUndefined();
    expect(fixture.syncedRefs).toEqual([]);
    expect((await fixture.sourceSyncRuns()).length).toBe(syncsBefore);
    // A settled check never holds the app, so a branch can be chosen next.
    const view = await fixture.appView();
    expect(view.app?.progress?.revisionPreparing ?? view.progress?.revisionPreparing).toBe(false);
    const next = await fixture.route(
      "POST",
      `/api/v1/capsules/${fixture.capsuleId}/revision-plans`,
      { ref: "main" },
      "pin-main-after-check",
    );
    expect(next.status).toBe(201);
  });

  test(`[${kind}] a commit-pinned owned app switches to a branch through a revision plan`, async () => {
    const fixture = await ownedAppFixture(kind, PINNED);
    const planId = await fixture.createRevision("main", "pin-main");

    let response = await fixture.reconcile(planId);
    expect(response.status).toBe(200);
    expect(response.body.revisionPlan).toMatchObject({ phase: "syncing_source" });
    const syncRunId = response.body.revisionPlan.sourceSyncRunId as string;
    expect(syncRunId).toMatch(/^ssr_[0-9a-f]{16}$/u);
    // The deterministic sync carries the account that asked for the change.
    expect(await fixture.deployStore.getSourceSyncRun(syncRunId)).toMatchObject({
      ref: "main",
      path: ".",
      intent: "manual_plan",
      actorAccountId: OWNER,
      ownershipEpoch: 0,
    });
    expect(fixture.syncedRefs).toEqual(["main"]);

    for (let step = 0; step < 6 && response.body.revisionPlan.phase !== "reviewable"; step += 1) {
      response = await fixture.reconcile(planId);
      expect(response.status).toBe(200);
    }
    const planRunId = response.body.revisionPlan.planRunId as string;
    expect(planRunId).toMatch(/^plan_/u);
    expect(response.body).toMatchObject({
      revisionPlan: { phase: "reviewable" },
      nextAction: "review_run",
    });
    await fixture.applyPlanRun(planRunId);
    // The app now follows the branch: its owned lane converged on apply.
    expect(await fixture.deployStore.getSource(fixture.sourceId)).toMatchObject({
      ownerCapsuleId: fixture.capsuleId,
      defaultRef: "main",
    });
  });

  test(`[${kind}] a branch-tracking owned app is already current until its branch moves`, async () => {
    const fixture = await ownedAppFixture(kind, "main");
    const unchanged = await fixture.createRevision("main", "check-main");
    let response = await fixture.reconcile(unchanged);
    expect(response.status).toBe(200);
    for (let step = 0; step < 3 && response.body.revisionPlan.phase === "syncing_source"; step += 1) {
      response = await fixture.reconcile(unchanged);
      expect(response.status).toBe(200);
    }
    expect(response.body.revisionPlan).toMatchObject({
      phase: "failed",
      diagnostic: { code: "revision_already_current" },
    });
    expect(fixture.syncedRefs).toEqual(["main"]);

    fixture.branchHeads.set("main", MOVED_HEAD);
    const moved = await fixture.createRevision("main", "check-main-moved");
    response = await fixture.reconcile(moved);
    for (let step = 0; step < 6 && response.body.revisionPlan.phase !== "reviewable"; step += 1) {
      expect(response.status).toBe(200);
      response = await fixture.reconcile(moved);
    }
    expect(response.body.revisionPlan).toMatchObject({
      phase: "reviewable",
      planRunId: expect.stringMatching(/^plan_/u),
    });
  });
}
