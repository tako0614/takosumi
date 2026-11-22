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
import { retryPlanForRun, type RetryPlanApi } from "../../../../dashboard/src/lib/run-retry.ts";

setDefaultTimeout(180_000);

// An app installed at an exact commit owns its Source (TASK-0118). Its Source
// syncs carry the account that asked for them, so a version change must too.
const OWNER = "tsub_owned_revision";
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
    authorizeInterfaceBearer: () => undefined,
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

async function ownedAppFixture(
  kind: Backend,
  installRef: string,
  options: { readonly sourceText?: string; readonly initialApplyFails?: boolean } = {},
) {
  const branchHeads = new Map<string, string>([["main", MAIN_HEAD]]);
  let applyFails = options.initialApplyFails ?? false;
  const syncedRefs: string[] = [];
  const planJobs: Parameters<OpenTofuRunner["plan"]>[0][] = [];
  const applyJobs: Parameters<OpenTofuRunner["apply"]>[0][] = [];
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
      text: options.sourceText ?? "output \"ready\" { value = \"yes\" }\n",
    }],
    plan: async (job) => {
      planJobs.push(job);
      return ({
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
    });
    },
    // A provider failure can persist state: the StateVersion advances while
    // the Capsule becomes `error`.
    apply: async (job) => {
      applyJobs.push(job);
      return applyFails
      ? {
          providerExecutionFailure: {
            kind: "provider_execution_failed" as const,
            statePersistence: "persisted" as const,
          },
          stateDigest: STATE_DIGEST,
          rawOutputRef: job.rawOutputRef,
          providerInstallation: [],
          executionEvidence: fixtureExecutionEvidence(job, "apply", {
            outcome: "provider_failed_state_persisted",
          }),
        }
      : {
          outputs: {} as never,
          stateDigest: STATE_DIGEST,
          rawOutputRef: job.rawOutputRef,
          providerInstallation: [],
          executionEvidence: fixtureExecutionEvidence(job, "apply"),
        };
    },
  };
  const { deployStore, operations } = await compose(kind, runner);
  const appOwnership = operations.appOwnership;
  const appAccess = operations.appAccess;
  if (!appOwnership || !appAccess) throw new Error("owned-app fixture requires the canonical ownership and access ports");
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

  async function route(method: string, path: string, body?: unknown, key?: string, sessionId = SESSION) {
    const url = new URL(`https://app.takosumi.test${path}`);
    const response = await handleControlRoute({
      request: new Request(url, {
        method,
        headers: {
          cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}`,
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

  async function reconcileRevision(planId: string) {
    const response = await route("POST", `/api/v1/revision-plans/${planId}/reconcile`);
    return { status: response.status, body: await response.json() };
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
  const initialApply = await applyPlanRun(installPlan.planRunId!);
  const capsuleId = installPlan.capsuleId!;
  const sourceId = installPlan.sourceId!;
  const capsule = await deployStore.getCapsule(capsuleId);
  expect(capsule).toMatchObject({
    status: options.initialApplyFails ? "error" : "active",
    currentStateGeneration: 1,
  });
  expect((await appOwnership.getOwnership(capsuleId))?.ownerAccountId).toBe(OWNER);
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
    accountStore,
    appOwnership,
    appAccess,
    planJobs,
    applyJobs,
    workspace,
    capsuleId,
    sourceId,
    initialApply,
    initialPlanRunId: installPlan.planRunId!,
    syncedRefs,
    branchHeads,
    route,
    applyPlanRun,
    setApplyFails(fails: boolean) {
      applyFails = fails;
    },
    /** Reconciles until the coordinator settles; returns the last response. */
    async settle(planId: string) {
      let response = await reconcileRevision(planId);
      for (let step = 0; step < 8 && response.body.nextAction === "reconcile"; step += 1) {
        expect(response.status).toBe(200);
        response = await reconcileRevision(planId);
      }
      return response;
    },
    sourceSyncRuns,
    async createRevision(ref: string, key: string) {
      const response = await route("POST", `/api/v1/capsules/${capsuleId}/revision-plans`, { ref }, key);
      expect(response.status).toBe(201);
      return (await response.json()).revisionPlan.id as string;
    },
    reconcile: reconcileRevision,
    async appView() {
      const response = await route("GET", `/api/v1/capsules/${capsuleId}/app`);
      expect(response.status).toBe(200);
      return await response.json();
    },
  };
}

test("[memory] Review again after an initial persisted Apply failure reviews the same snapshot and partial state before an explicit Apply", async () => {
  const fixture = await ownedAppFixture("memory", PINNED, { initialApplyFails: true });
  const failed = fixture.initialApply.run;
  const originalPlan = await fixture.deployStore.getPlanRun(fixture.initialPlanRunId);
  const failedLedger = await fixture.deployStore.getApplyRun(failed.id);
  const partial = await fixture.deployStore.getStateVersion(failedLedger!.stateVersionId!);
  expect(failed).toMatchObject({ type: "apply", status: "failed" });
  expect(failed.outputId).toBeUndefined();
  expect(partial).toMatchObject({
    capsuleId: fixture.capsuleId,
    generation: 1,
    digest: STATE_DIGEST,
    createdByRunId: failed.id,
  });
  expect(originalPlan).toMatchObject({ baseStateGeneration: 0, appliedApplyRunId: failed.id });
  expect(failedLedger!.outputId).toBeUndefined();
  const sourceBefore = await fixture.deployStore.getSource(fixture.sourceId);
  const bindingsBefore = await fixture.deployStore.getProviderBindingSetByCapsule(fixture.capsuleId, "production");
  expect(bindingsBefore).toBeDefined();
  const syncsBefore = await fixture.sourceSyncRuns();

  // Use the same owner-authenticated HTTP reads and rollback action as the
  // dashboard. Other retry routes are mistakes for this first partial state.
  const calls: string[] = [];
  const unexpected = async () => { throw new Error("partial initial Apply must review its current StateVersion"); };
  const api: RetryPlanApi = {
    getRun: async (id) => {
      calls.push(`read ${id}`);
      const response = await fixture.route("GET", `/api/v1/runs/${id}`);
      expect(response.status).toBe(200);
      return (await response.json()).run;
    },
    planRollback: async (stateVersionId) => {
      calls.push(`rollback ${stateVersionId}`);
      const response = await fixture.route("POST", `/api/v1/state-versions/${stateVersionId}/rollback-plan`);
      expect(response.status).toBe(201);
      return await response.json();
    },
    destroyPlanCapsule: unexpected,
    planCapsule: unexpected,
    planRevision: unexpected,
    planTracked: unexpected,
  };
  const freshCapsule = await fixture.route("GET", `/api/v1/capsules/${fixture.capsuleId}`);
  expect(freshCapsule.status).toBe(200);
  const capsule = (await freshCapsule.json()).capsule;
  expect(capsule).toMatchObject({ status: "error", currentStateGeneration: 1, currentStateVersionId: partial!.id });
  expect(capsule.currentOutputId).toBeUndefined();
  const retryPlanId = await retryPlanForRun(await api.getRun(failed.id), capsule, api);
  expect(calls).toEqual([`read ${failed.id}`, `read ${originalPlan!.id}`, `rollback ${partial!.id}`]);
  expect(retryPlanId).toBeString();
  expect(retryPlanId).not.toBe(originalPlan!.id);
  const retryPlan = await fixture.deployStore.getPlanRun(retryPlanId!);
  expect(retryPlan).toMatchObject({
    capsuleId: fixture.capsuleId,
    status: "succeeded",
    baseStateGeneration: 1,
    sourceSnapshotId: originalPlan!.sourceSnapshotId,
    capsuleCurrentStateVersionId: partial!.id,
    origin: { kind: "rollback", stateVersionId: partial!.id },
  });
  expect(retryPlan!.appliedApplyRunId).toBeUndefined();
  expect(fixture.planJobs).toHaveLength(2);
  expect(fixture.planJobs[0]!.stateScope?.priorState).toBeUndefined();
  expect(fixture.planJobs[1]!.stateScope?.priorState).toEqual({
    generation: 1,
    stateRef: partial!.stateRef,
    digest: partial!.digest,
    createdByRunId: failed.id,
  });
  expect(fixture.planJobs[0]!.sourceArchive).toBeDefined();
  expect(fixture.planJobs[1]!.sourceArchive).toEqual(fixture.planJobs[0]!.sourceArchive);
  expect(retryPlan!.resolvedProviderBindingsDigest).toBe(originalPlan!.resolvedProviderBindingsDigest);
  expect(fixture.applyJobs).toHaveLength(1);
  expect(await fixture.deployStore.getApplyRun(failed.id)).toEqual(failedLedger);
  expect(await fixture.deployStore.getPlanRun(originalPlan!.id)).toEqual(originalPlan);
  expect(await fixture.deployStore.getSource(fixture.sourceId)).toEqual(sourceBefore);
  expect(await fixture.deployStore.getProviderBindingSetByCapsule(fixture.capsuleId, "production")).toEqual(bindingsBefore);
  expect(await fixture.sourceSyncRuns()).toEqual(syncsBefore);
  expect((await fixture.appOwnership.getOwnership(fixture.capsuleId))?.ownerAccountId).toBe(OWNER);

  // Reviewing never dispatches Apply. The owner makes a separate explicit
  // Apply of the new Plan; the failed Plan and its partial state stay intact.
  fixture.setApplyFails(false);
  const repaired = await fixture.applyPlanRun(retryPlanId!);
  const repairedLedger = await fixture.deployStore.getApplyRun(repaired.run.id);
  expect(repaired.run).toMatchObject({ status: "succeeded", planRunId: retryPlanId });
  expect(fixture.applyJobs).toHaveLength(2);
  expect(await fixture.deployStore.getCapsule(fixture.capsuleId)).toMatchObject({
    id: fixture.capsuleId,
    status: "active",
    currentStateGeneration: 2,
    currentStateVersionId: repairedLedger!.stateVersionId,
  });
  expect(await fixture.deployStore.getStateVersion(repairedLedger!.stateVersionId!)).toMatchObject({
    capsuleId: fixture.capsuleId,
    generation: 2,
    createdByRunId: repaired.run.id,
  });
  expect(await fixture.deployStore.getStateVersion(partial!.id)).toEqual(partial);
  expect(await fixture.deployStore.getApplyRun(failed.id)).toEqual(failedLedger);
  expect(await fixture.deployStore.getPlanRun(originalPlan!.id)).toEqual(originalPlan);
  expect(await fixture.deployStore.getSource(fixture.sourceId)).toEqual(sourceBefore);
  expect(await fixture.deployStore.getProviderBindingSetByCapsule(fixture.capsuleId, "production")).toEqual(bindingsBefore);
});

for (const kind of BACKENDS) {
  test(`[${kind}] repeating a rollback start with the same key reviews one Plan`, async () => {
    const fixture = await ownedAppFixture(kind, PINNED);
    const capsule = (await fixture.deployStore.getCapsule(fixture.capsuleId))!;
    const stateVersionId = capsule.currentStateVersionId!;
    const path = `/api/v1/state-versions/${stateVersionId}/rollback-plan`;
    const start = (key = "rollback-response-lost") => fixture.route("POST", path, undefined, key);
    expect((await start("a".repeat(257))).status).toBe(400);

    const [first, retry] = await Promise.all([start(), start()]);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    const firstRun = (await first.json()).run;
    expect((await retry.json()).run.id).toBe(firstRun.id);
    expect(await fixture.deployStore.getPlanRun(firstRun.id)).toMatchObject({
      capsuleId: fixture.capsuleId,
      createdBy: OWNER,
      origin: { kind: "rollback", stateVersionId },
      capsuleCurrentStateVersionId: stateVersionId,
    });
    expect(fixture.planJobs).toHaveLength(2);
    expect(fixture.applyJobs).toHaveLength(1);
    expect(await fixture.deployStore.getCapsule(fixture.capsuleId)).toEqual(capsule);

    // Even after an explicit Apply has advanced the state, reusing the key
    // returns the old Plan. Only a new intentional start uses the new state.
    await fixture.applyPlanRun(firstRun.id);
    const current = (await fixture.deployStore.getCapsule(fixture.capsuleId))!;
    expect(current.currentStateGeneration).toBe(2);
    const replay = await start();
    expect(replay.status).toBe(201);
    expect((await replay.json()).run.id).toBe(firstRun.id);
    expect(fixture.planJobs).toHaveLength(2);
    const next = await start("new-rollback-intent");
    expect(next.status).toBe(201);
    const nextRun = (await next.json()).run;
    expect(nextRun.id).not.toBe(firstRun.id);
    expect(await fixture.deployStore.getPlanRun(nextRun.id)).toMatchObject({
      origin: { kind: "rollback", stateVersionId },
      capsuleCurrentStateVersionId: current.currentStateVersionId,
      baseStateGeneration: 2,
    });
    expect(fixture.planJobs).toHaveLength(3);
    expect(fixture.applyJobs).toHaveLength(2);
    expect(await fixture.deployStore.getCapsule(fixture.capsuleId)).toEqual(current);
  });

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

  test(`[${kind}] retrying an update whose Apply failed with persisted state plans again, then is current once repaired`, async () => {
    for (const [installRef, target, moveBranch] of [
      [PINNED, MAIN_HEAD, false],
      ["main", "main", true],
    ] as const) {
      const fixture = await ownedAppFixture(kind, installRef);
      if (moveBranch) fixture.branchHeads.set("main", MOVED_HEAD);
      const update = await fixture.settle(await fixture.createRevision(target, `update-${installRef}`));
      expect(update.body.revisionPlan.phase).toBe("reviewable");
      fixture.setApplyFails(true);
      const failed = await fixture.applyPlanRun(update.body.revisionPlan.planRunId as string);
      expect(failed.run.status).toBe("failed");
      const broken = await fixture.deployStore.getCapsule(fixture.capsuleId);
      expect(broken).toMatchObject({ status: "error", currentStateGeneration: 2 });
      // The failed Apply's state is now the adopted revision, at the target.
      expect((await fixture.operations.getCapsuleAdoptedSourceRevision(fixture.capsuleId))?.ref)
        .toBe(target);

      // The app page's "Review again" asks for the same ref again.
      const retry = await fixture.settle(await fixture.createRevision(target, `retry-${installRef}`));
      expect(retry.body.revisionPlan).toMatchObject({ phase: "reviewable" });
      expect(retry.body.revisionPlan.diagnostic).toBeUndefined();
      fixture.setApplyFails(false);
      const repaired = await fixture.applyPlanRun(retry.body.revisionPlan.planRunId as string);
      expect(repaired.run.status).toBe("succeeded");
      expect(await fixture.deployStore.getCapsule(fixture.capsuleId)).toMatchObject({ status: "active" });

      // Only now, with a successful Apply behind it, is the same ref current.
      const check = await fixture.settle(await fixture.createRevision(target, `check-${installRef}`));
      expect(check.body.revisionPlan).toMatchObject({
        phase: "failed",
        diagnostic: { code: "revision_already_current" },
      });
    }
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

// This portable cohort exercises current installed-app authority. Git/Runner
// effects and Accounts identity are synthetic; it is not native state/SSO proof.
test("normal two-app installation keeps configuration recovery scoped to live app access and account sessions", async () => {
  const fixture = await ownedAppFixture("postgres", PINNED, {
    sourceText: 'variable "public_url" {\n  type = string\n  default = "https://before.example.test"\n}\noutput "launch_url" { value = var.public_url }\n',
  });
  const { operations, deployStore, route, capsuleId: appA } = fixture;
  const installedB = await route("POST", `/api/v1/workspaces/${fixture.workspace.id}/install-plans`, {
    source: { name: "other", url: "https://github.com/takos/other-app.git", ref: PINNED, path: "." },
    capsule: { name: "other", environment: "production" },
    options: { modulePath: ".", providerBindings: [] },
  }, "normal-install-other-app");
  expect(installedB.status).toBe(201);
  const installBId = (await installedB.json()).installPlan.id as string;
  let installB: { planRunId?: string; capsuleId?: string } = {};
  for (let step = 0; step < 10 && !installB.planRunId; step += 1) {
    const next = await route("POST", `/api/v1/install-plans/${installBId}/reconcile`);
    expect(next.status).toBe(200);
    installB = (await next.json()).installPlan;
  }
  expect(installB.planRunId).toBeString();
  expect(await deployStore.getPlanRun(installB.planRunId!)).toMatchObject({ createdBy: OWNER, ownershipEpoch: 0 });
  expect(installB.capsuleId).toBeString();
  const appB = installB.capsuleId!;
  expect(appB).not.toBe(appA);
  await fixture.applyPlanRun(installB.planRunId!);
  const beforeA = (await deployStore.getCapsule(appA))!;
  const beforeB = (await deployStore.getCapsule(appB))!;
  expect(beforeB).toMatchObject({ status: "active", currentStateGeneration: 1 });
  expect(beforeB.sourceId).not.toBe(beforeA.sourceId);
  expect(beforeB.installConfigId).not.toBe(beforeA.installConfigId);
  for (const id of [appA, appB]) {
    expect(await fixture.appOwnership.getOwnership(id)).toMatchObject({
      capsuleId: id, ownerAccountId: OWNER, ownershipEpoch: 0,
    });
    expect(await fixture.appAccess.resolveAppAccess(OWNER, id)).toMatchObject({
      capsuleId: id, ownerAccountId: OWNER, role: "owner", ownershipEpoch: 0,
    });
  }

  const currentA = await route("GET", `/api/v1/capsules/${appA}`);
  const currentB = await route("GET", `/api/v1/capsules/${appB}`);
  expect(currentA.status).toBe(200);
  expect(currentB.status).toBe(200);
  const bodyA = await currentA.json();
  const bodyB = await currentB.json();
  const change = (authorityGuard: string) => ({
    variablePatch: { set: { public_url: "https://after.example.test" }, remove: [] },
    providerBindings: [], interfaceBlueprints: [], expected: { authorityGuard },
  });
  const oldRunIds = (await operations.listRuns(fixture.workspace.id)).map((r) => r.id).sort();
  const planCalls = fixture.planJobs.length;
  const applyCalls = fixture.applyJobs.length;
  const wrongTarget = await route("POST", `/api/v1/capsules/${appA}/configuration-plans`,
    change(bodyB.installConfigReAdoption.authorityGuard), "other-app-guard");
  expect(wrongTarget.status).toBe(409);
  expect((await wrongTarget.json()).error).toMatchObject({
    code: "failed_precondition", details: { reason: "capsule_install_config_rebind_conflict" },
  });
  expect(fixture.planJobs).toHaveLength(planCalls);
  expect(fixture.applyJobs).toHaveLength(applyCalls);
  expect((await operations.listRuns(fixture.workspace.id)).map((r) => r.id).sort()).toEqual(oldRunIds);
  expect(await deployStore.getCapsule(appA)).toEqual(beforeA);
  expect(await deployStore.getCapsule(appB)).toEqual(beforeB);

  const configured = await route("POST", `/api/v1/capsules/${appA}/configuration-plans`,
    change(bodyA.installConfigReAdoption.authorityGuard), "normal-owned-config-update");
  expect(configured.status).toBe(201);
  const configurationPlan = (await configured.json()).configurationPlan;
  const planRunId = configurationPlan.planRunId as string;
  const savedPlan = await deployStore.getPlanRun(planRunId);
  expect(savedPlan).toMatchObject({ capsuleId: appA, createdBy: OWNER, ownershipEpoch: 0 });
  expect(savedPlan?.capsuleExecutionAuthorityEpoch).toBeNumber();
  expect(fixture.planJobs).toHaveLength(planCalls + 1);
  expect(fixture.planJobs.at(-1)?.variables.public_url).toBe("https://after.example.test");
  expect(fixture.planJobs.at(-1)?.planRun.capsuleId).toBe(appA);
  const applied = await route("POST", `/api/v1/runs/${planRunId}/apply`);
  expect(applied.status).toBe(201);
  // Discard the successful Apply body. Recovery looks up the Plan's Apply
  // through the same authorized app Run list, then rereads that exact Run.
  const listQuery = new URLSearchParams({ planRunId, type: "apply" });
  const planApplies = `/api/v1/capsules/${appA}/runs?${listQuery}`;
  const listed = await route("GET", planApplies);
  expect(listed.status).toBe(200);
  const history = await listed.json();
  expect(history.runs).toHaveLength(1);
  expect(history.nextCursor).toBeUndefined();
  expect(history.runs[0]).toMatchObject({ type: "apply", capsuleId: appA, planRunId });
  const recoveredId = history.runs[0].id as string;
  expect(oldRunIds).not.toContain(recoveredId);
  const wrongApp = await route("GET", `/api/v1/capsules/${appB}/runs?${listQuery}`);
  expect(wrongApp.status).toBe(200);
  expect((await wrongApp.json()).runs).toEqual([]);
  expect((await route("GET", `${planApplies}&planRunId=other`)).status).toBe(400);
  const recovered = await route("GET", `/api/v1/runs/${recoveredId}`);
  expect(recovered.status).toBe(200);
  expect((await recovered.json()).run).toMatchObject({ id: recoveredId, capsuleId: appA, status: "succeeded" });
  expect(fixture.applyJobs).toHaveLength(applyCalls + 1);
  expect(fixture.applyJobs.at(-1)?.planRun.id).toBe(planRunId);
  expect(await deployStore.getApplyRun(recoveredId)).toMatchObject({
    planRunId, capsuleId: appA, createdBy: OWNER,
    expected: { planRunId, capsuleId: appA, capsuleExecutionAuthorityEpoch: savedPlan!.capsuleExecutionAuthorityEpoch },
  });
  const afterApplyA = (await deployStore.getCapsule(appA))!;
  expect(afterApplyA).toMatchObject({ id: appA, status: "active", currentStateGeneration: 2 });
  const afterApplyConfigId = afterApplyA.installConfigId;
  if (!afterApplyConfigId) throw new Error("successful Apply has no effective InstallConfig");
  const afterApplyConfigA = await operations.capsules.getInstallConfig(afterApplyConfigId);
  expect(afterApplyConfigA).toMatchObject({ id: afterApplyConfigId });
  const afterApplyRunIds = (await operations.listRuns(fixture.workspace.id)).map((r) => r.id).sort();
  expect(afterApplyRunIds).toContain(recoveredId);
  expect(await deployStore.getCapsule(appB)).toEqual(beforeB);

  const member = "tsub_owned_revision_member";
  const memberSession = "sess_owned_revision_member";
  const now = Date.now();
  fixture.accountStore.saveAccount({ subject: member, email: "member@example.test", emailVerified: true, createdAt: now, updatedAt: now });
  fixture.accountStore.saveAccountSession({ sessionId: memberSession, subject: member, createdAt: now, expiresAt: now + 60_000 });
  const admitted = await route("POST", `/api/v1/capsules/${appA}/members`, {
    email: "member@example.test", consent: "connections_and_code",
  });
  expect(admitted.status).toBe(202);
  expect(await fixture.appAccess.resolveAppAccess(member, appA)).toMatchObject({ capsuleId: appA, role: "member" });
  expect(await fixture.appAccess.resolveAppAccess(member, appB)).toBeUndefined();
  expect((await route("GET", `/api/v1/runs/${recoveredId}`, undefined, undefined, memberSession)).status).toBe(200);
  expect((await route("GET", `/api/v1/runs/${installB.planRunId}`, undefined, undefined, memberSession)).status).toBe(403);
  expect((await route("GET", planApplies, undefined, undefined, memberSession)).status).toBe(200);
  const removed = await route("DELETE", `/api/v1/capsules/${appA}/members/${member}`);
  expect(removed.status).toBe(204);
  expect(await fixture.appAccess.resolveAppAccess(member, appA)).toBeUndefined();
  expect((await route("GET", planApplies, undefined, undefined, memberSession)).status).toBe(403);
  expect((await route("GET", `/api/v1/runs/${recoveredId}`, undefined, undefined, memberSession)).status).toBe(403);
  expect((await route("POST", `/api/v1/runs/${planRunId}/apply`, undefined, undefined, memberSession)).status).toBe(403);
  expect((await route("POST", `/api/v1/capsules/${appA}/configuration-plans`,
    change(bodyA.installConfigReAdoption.authorityGuard), "removed-member-config", memberSession)).status).toBe(403);
  expect(fixture.planJobs).toHaveLength(planCalls + 1);
  expect(fixture.applyJobs).toHaveLength(applyCalls + 1);

  expect(await deployStore.getCapsule(appA)).toEqual(afterApplyA);
  expect(await operations.capsules.getInstallConfig(afterApplyConfigId)).toEqual(afterApplyConfigA);
  expect((await operations.listRuns(fixture.workspace.id)).map((r) => r.id).sort()).toEqual(afterApplyRunIds);

  await fixture.accountStore.deleteAccountSession(SESSION);
  expect((await route("GET", `/api/v1/runs/${recoveredId}`)).status).toBe(401);
  expect((await route("POST", `/api/v1/runs/${planRunId}/apply`)).status).toBe(401);
  expect((await route("POST", `/api/v1/capsules/${appB}/configuration-plans`,
    change(bodyB.installConfigReAdoption.authorityGuard), "revoked-session-config")).status).toBe(401);
  expect(fixture.planJobs).toHaveLength(planCalls + 1);
  expect(fixture.applyJobs).toHaveLength(applyCalls + 1);
  expect(await deployStore.getCapsule(appB)).toEqual(beforeB);
  expect(await deployStore.getCapsule(appA)).toEqual(afterApplyA);
  expect(await operations.capsules.getInstallConfig(afterApplyConfigId)).toEqual(afterApplyConfigA);
  expect((await operations.listRuns(fixture.workspace.id)).map((r) => r.id).sort()).toEqual(afterApplyRunIds);
});
