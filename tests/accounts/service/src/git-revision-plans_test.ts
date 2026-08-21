import { expect, test } from "bun:test";

import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { handleAuthenticatedControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { defaultCapsuleInstallConfig } from "../../../../core/domains/capsules/default_install_config.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import { InMemoryGitInstallPlanStore } from "../../../../core/domains/install-plans/store.ts";
import type { CapsuleCompatibilityReport } from "../../../../contract/capsules.ts";
import type { Capsule, InstallConfig } from "../../../../contract/install-configs.ts";
import type { Run } from "../../../../contract/runs.ts";
import type {
  CreateSourceSyncRequest,
  Source,
  SourceSnapshot,
  SourceSyncRun,
} from "../../../../contract/sources.ts";

const WORKSPACE = {
  id: "ws_revision",
  handle: "revision",
  displayName: "Revision",
  type: "personal" as const,
  ownerUserId: "tsub_revision_owner",
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
};

test("Git revision plan reconciles an existing Capsule to one reviewable pinned Plan Run", async () => {
  const fixture = revisionFixture();
  const created = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
    { "idempotency-key": "upgrade-release-v2" },
  );
  expect(created.status).toBe(201);
  const creation = await created.json();
  expect(creation).toMatchObject({
    revisionPlan: {
      operation: "revision",
      workspaceId: WORKSPACE.id,
      capsuleId: "cap_revision",
      sourceId: "src_revision",
      phase: "syncing_source",
      generation: 0,
      revision: {
        targetRef: "release/v2",
        base: {
          capsuleStateGeneration: 3,
          capsuleStateVersionId: "sv_three",
          installConfigId: "cfg_revision",
        },
      },
    },
    nextAction: "reconcile",
    links: { reconcile: expect.stringContaining("/reconcile") },
  });
  const planId = creation.revisionPlan.id as string;
  expect(JSON.stringify(creation)).not.toContain("upgrade-release-v2");

  const replay = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
    { "idempotency-key": "upgrade-release-v2" },
  );
  expect(replay.status).toBe(200);
  expect((await replay.json()).revisionPlan.id).toBe(planId);

  const conflict = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v3" },
    { "idempotency-key": "upgrade-release-v2" },
  );
  expect(conflict.status).toBe(409);

  const mutationsBeforeRead = { ...fixture.counts };
  const readOnly = await fixture.request(`/api/v1/revision-plans/${planId}`);
  expect(readOnly.status).toBe(200);
  expect((await readOnly.json()).revisionPlan.generation).toBe(0);
  expect(fixture.counts).toEqual(mutationsBeforeRead);
  expect(
    (
      await fixture.request(`/api/v1/install-plans/${planId}`)
    ).status,
  ).toBe(404);

  let response = await fixture.reconcile(planId);
  expect((await response.json()).revisionPlan).toMatchObject({
    phase: "syncing_source",
    sourceSyncRunId: expect.stringMatching(/^ssr_[0-9a-f]{16}$/u),
  });
  expect(fixture.source).toMatchObject({
    defaultRef: "main",
    defaultPath: "deploy/app",
  });

  fixture.succeedSourceSync();
  response = await fixture.reconcile(planId);
  expect((await response.json()).revisionPlan).toMatchObject({
    phase: "analyzing_compatibility",
    sourceSnapshotId: expect.stringMatching(/^snap_[0-9a-f]{16}$/u),
    installConfigBaseId: "cfg_revision",
    installModulePath: "deploy/app",
    compatibilityCheckRunId: expect.stringMatching(/^ccr_[0-9a-f]{16}$/u),
    compatibilityReportId: expect.stringMatching(/^caprep_[0-9a-f]{16}$/u),
  });
  response = await fixture.reconcile(planId);
  expect((await response.json()).revisionPlan.phase).toBe("planning");
  response = await fixture.reconcile(planId);
  const reviewable = await response.json();
  expect(reviewable).toMatchObject({
    revisionPlan: {
      phase: "reviewable",
      planRunId: expect.stringMatching(/^plan_[A-Za-z0-9]{16}$/u),
    },
    nextAction: "review_run",
    links: {
      self: `/api/v1/revision-plans/${planId}`,
      run: expect.stringMatching(/^\/api\/v1\/runs\/plan_/u),
    },
  });
  expect(reviewable.links.reconcile).toBeUndefined();
  expect(fixture.counts).toEqual({ sync: 1, compatibility: 1, plan: 1 });
  expect(fixture.approvalCalls).toBe(0);
  expect(fixture.applyCalls).toBe(0);

  const denied = await fixture.request(
    `/api/v1/revision-plans/${planId}`,
    "GET",
    undefined,
    {},
    "tsub_foreign",
  );
  expect(denied.status).toBe(403);
});

test("Git revision plan follows the adopted Capsule path instead of Source.defaultPath", async () => {
  const fixture = revisionFixture({
    sourceDefaultPath: "deploy/default",
    adoptedPath: "deploy/app",
  });
  const created = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
    { "idempotency-key": "revision-adopted-path" },
  );
  expect(created.status).toBe(201);
  const planId = (await created.json()).revisionPlan.id as string;

  const syncing = await fixture.reconcile(planId);
  expect(syncing.status).toBe(200);
  expect(fixture.sourceSyncPaths).toEqual(["deploy/app"]);
});

test("Capsule GET projects the applied revision separately from the shared Source default", async () => {
  const fixture = revisionFixture();
  const response = await fixture.request("/api/v1/capsules/cap_revision");

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    capsule: {
      id: "cap_revision",
      adoptedSourceRevision: {
        sourceSnapshotId: "snap_adopted_revision",
        ref: "refs/heads/release/v1",
        path: "deploy/app",
        resolvedCommit: "1".repeat(40),
      },
    },
  });
  expect(fixture.source.defaultRef).toBe("main");
});

test("Workspace Capsule list projects the applied revision in its bounded page", async () => {
  const fixture = revisionFixture();
  const response = await fixture.request(
    `/api/v1/workspaces/${WORKSPACE.id}/capsules`,
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    capsules: [
      {
        id: "cap_revision",
        adoptedSourceRevision: {
          sourceSnapshotId: "snap_adopted_revision",
          ref: "refs/heads/release/v1",
          resolvedCommit: "1".repeat(40),
        },
      },
    ],
  });
});

test("Git revision plan recovers lost sync, compatibility, and Plan acknowledgements exactly once", async () => {
  const fixture = revisionFixture({
    loseAckOnce: ["sync", "compatibility", "plan"],
  });
  const created = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
    { "idempotency-key": "revision-lost-acks" },
  );
  const planId = (await created.json()).revisionPlan.id as string;

  let response = await fixture.reconcile(planId);
  expect(response.status).toBe(202);
  expect(fixture.counts.sync).toBe(1);
  response = await fixture.reconcile(planId);
  expect(fixture.counts.sync).toBe(1);

  fixture.succeedSourceSync();
  await fixture.reconcile(planId);
  response = await fixture.reconcile(planId);
  expect(response.status).toBe(202);
  expect(fixture.counts.compatibility).toBe(1);
  response = await fixture.reconcile(planId);
  expect(fixture.counts.compatibility).toBe(1);

  response = await fixture.reconcile(planId);
  expect(response.status).toBe(202);
  expect(fixture.counts.plan).toBe(1);
  response = await fixture.reconcile(planId);
  expect((await response.json()).revisionPlan.phase).toBe("reviewable");
  expect(fixture.counts).toEqual({ sync: 1, compatibility: 1, plan: 1 });
});

test("Git revision plan terminalizes deterministic evidence identity conflicts", async () => {
  for (const kind of ["sync", "compatibility"] as const) {
    const fixture = revisionFixture({ deterministicConflict: kind });
    const created = await fixture.request(
      "/api/v1/capsules/cap_revision/revision-plans",
      "POST",
      { ref: "release/v2" },
      { "idempotency-key": `revision-conflict-${kind}` },
    );
    const planId = (await created.json()).revisionPlan.id as string;

    if (kind === "compatibility") {
      await fixture.reconcile(planId);
      fixture.succeedSourceSync();
      await fixture.reconcile(planId);
    }
    const conflicted = await fixture.reconcile(planId);
    expect(conflicted.status).toBe(200);
    expect((await conflicted.json()).revisionPlan).toMatchObject({
      phase: "failed",
      diagnostic: {
        code:
          kind === "sync"
            ? "source_sync_identity_conflict"
            : "compatibility_evidence_identity_conflict",
      },
    });
  }
});

test("Git revision plan stops before Plan creation when compatibility is not runnable", async () => {
  const fixture = revisionFixture({ compatibilityLevel: "needs_patch" });
  const created = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
    { "idempotency-key": "revision-needs-patch" },
  );
  const planId = (await created.json()).revisionPlan.id as string;

  await fixture.reconcile(planId);
  fixture.succeedSourceSync();
  await fixture.reconcile(planId);
  const stopped = await fixture.reconcile(planId);

  expect((await stopped.json()).revisionPlan).toMatchObject({
    phase: "failed",
    diagnostic: { code: "revision_compatibility_not_runnable" },
  });
  expect(fixture.counts).toEqual({ sync: 1, compatibility: 1, plan: 0 });
});

test("Git revision plan does not publish a Run when InstallConfig races Plan creation", async () => {
  const fixture = revisionFixture({ mutateInstallConfigDuringPlan: true });
  const created = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
    { "idempotency-key": "revision-plan-config-race" },
  );
  const planId = (await created.json()).revisionPlan.id as string;

  await fixture.reconcile(planId);
  fixture.succeedSourceSync();
  await fixture.reconcile(planId);
  await fixture.reconcile(planId);
  const stopped = await fixture.reconcile(planId);

  const stoppedPlan = (await stopped.json()).revisionPlan;
  expect(stoppedPlan).toMatchObject({
    phase: "failed",
    diagnostic: { code: "revision_identity_changed" },
  });
  expect(stoppedPlan.planRunId).toBeUndefined();
  expect(fixture.counts.plan).toBe(1);
});

test("Git revision plan rejects secret-shaped bodies", async () => {
  const fixture = revisionFixture();
  const missingKey = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
  );
  expect(missingKey.status).toBe(400);
  expect(await missingKey.json()).toMatchObject({
    error: { code: "idempotency_key_required" },
  });

  for (const body of [
    { ref: "release/v2", vars: { password: "never-store" } },
    { ref: "release/v2", token: "never-store" },
    { ref: " release/v2" },
    { ref: "release/v2\nother" },
    { ref: "@" },
  ]) {
    const rejected = await fixture.request(
      "/api/v1/capsules/cap_revision/revision-plans",
      "POST",
      body,
      { "idempotency-key": crypto.randomUUID() },
    );
    expect(rejected.status).toBe(400);
    expect(JSON.stringify(await rejected.json())).not.toContain("never-store");
  }

});

test("Git revision plan fences Capsule state, Source identity, and InstallConfig exactly", async () => {
  const cases = [
    {
      name: "Capsule state generation",
      mutate: (fixture: ReturnType<typeof revisionFixture>) =>
        fixture.mutateCapsule({ currentStateGeneration: 4 }),
    },
    {
      name: "Source default ref",
      mutate: (fixture: ReturnType<typeof revisionFixture>) =>
        fixture.mutateSource({ defaultRef: "other" }),
    },
    {
      name: "InstallConfig content",
      mutate: (fixture: ReturnType<typeof revisionFixture>) =>
        fixture.replaceInstallConfig({
          ...fixture.installConfig,
          modulePath: "deploy/changed",
        }),
    },
  ] as const;

  for (const [index, scenario] of cases.entries()) {
    const fixture = revisionFixture();
    const created = await fixture.request(
      "/api/v1/capsules/cap_revision/revision-plans",
      "POST",
      { ref: "release/v2" },
      { "idempotency-key": `revision-fence-${index}` },
    );
    const planId = (await created.json()).revisionPlan.id as string;
    scenario.mutate(fixture);
    const failed = await fixture.reconcile(planId);
    expect(
      (await failed.json()).revisionPlan,
      scenario.name,
    ).toMatchObject({
      phase: "failed",
      diagnostic: { code: "revision_identity_changed" },
    });
    expect(fixture.counts).toEqual({ sync: 0, compatibility: 0, plan: 0 });
  }
});

type LostAckMutation = "sync" | "compatibility" | "plan";

function revisionFixture(
  options: {
    readonly loseAckOnce?: readonly LostAckMutation[];
    readonly deterministicConflict?: "sync" | "compatibility";
    readonly compatibilityLevel?: CapsuleCompatibilityReport["level"];
    readonly mutateInstallConfigDuringPlan?: boolean;
    readonly sourceDefaultPath?: string;
    readonly adoptedPath?: string;
  } = {},
) {
  const planStore = new InMemoryGitInstallPlanStore();
  const accountsStore = new InMemoryAccountsStore();
  const loseAck = new Set(options.loseAckOnce ?? []);
  const source: Source = {
    id: "src_revision",
    workspaceId: WORKSPACE.id,
    name: "revision-app",
    url: "https://github.com/takos/revision-app.git",
    defaultRef: "main",
    defaultPath: options.sourceDefaultPath ?? "deploy/app",
    status: "active",
    autoSync: false,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
  const capsule: Capsule = {
    id: "cap_revision",
    workspaceId: WORKSPACE.id,
    projectId: "prj_revision",
    name: "revision-app",
    environment: "production",
    sourceId: source.id,
    installConfigId: "cfg_revision",
    installingPrincipalId: WORKSPACE.ownerUserId,
    currentStateVersionId: "sv_three",
    currentStateGeneration: 3,
    status: "active",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
  let installConfig: InstallConfig = {
    ...defaultCapsuleInstallConfig(),
    id: "cfg_revision",
    workspaceId: WORKSPACE.id,
    modulePath: "deploy/app",
  };
  const syncRuns = new Map<string, SourceSyncRun>();
  const snapshots = new Map<string, SourceSnapshot>();
  const reports = new Map<string, CapsuleCompatibilityReport>();
  const runs = new Map<string, Run>();
  const counts = { sync: 0, compatibility: 0, plan: 0 };
  let approvalCalls = 0;
  let applyCalls = 0;

  const operations = {
    gitInstallPlans: planStore,
    workspaces: {
      getWorkspace: async (id: string) => {
        if (id !== WORKSPACE.id) throw new Error("workspace not found");
        return WORKSPACE;
      },
    },
    members: {
      getMember: async () => undefined,
      listMembers: async () => [],
    },
    getSource: async (id: string) => {
      if (id !== source.id) throw new OpenTofuControllerError("not_found", "missing");
      return { source };
    },
    createSourceSync: async (
      sourceId: string,
      request: CreateSourceSyncRequest,
    ) => {
      const identity = request.coordinator;
      if (!identity || sourceId !== source.id) throw new Error("coordinator identity missing");
      if (options.deterministicConflict === "sync") {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "deterministic sync identity conflict",
          { reason: "source_sync_identity_conflict" },
        );
      }
      const existing = syncRuns.get(identity.runId);
      if (existing) return { run: existing };
      counts.sync += 1;
      const run: SourceSyncRun = {
        id: identity.runId,
        kind: "source_sync",
        workspaceId: WORKSPACE.id,
        sourceId,
        url: source.url,
        ref: identity.ref,
        path: identity.path,
        archiveRef: `source-archive/${identity.snapshotId}`,
        intent: "manual_plan",
        status: "queued",
        snapshotId: identity.snapshotId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      syncRuns.set(run.id, run);
      lose("sync");
      return { run };
    },
    getSourceSyncRun: async (id: string) => {
      const run = syncRuns.get(id);
      if (!run) throw new OpenTofuControllerError("not_found", "missing");
      return run;
    },
    getSourceSnapshot: async (id: string) => {
      const snapshot = snapshots.get(id);
      if (!snapshot) throw new OpenTofuControllerError("not_found", "missing");
      return snapshot;
    },
    listSourceSnapshots: async () => ({ snapshots: [...snapshots.values()] }),
    listRuns: async () => [...runs.values()],
    createSourceCompatibilityCheck: async (
      sourceId: string,
      request: {
        readonly sourceSnapshotId?: string;
        readonly capsuleId?: string;
        readonly installPlanIdentity?: {
          readonly runId: string;
          readonly reportId: string;
          readonly createdBy: string;
        };
      },
    ) => {
      const identity = request.installPlanIdentity;
      if (!identity) throw new Error("compatibility identity missing");
      if (options.deterministicConflict === "compatibility") {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "deterministic compatibility identity conflict",
          { reason: "compatibility_evidence_identity_conflict" },
        );
      }
      const existingRun = runs.get(identity.runId);
      const existingReport = reports.get(identity.reportId);
      if (existingRun && existingReport) return { run: existingRun, report: existingReport };
      counts.compatibility += 1;
      const now = new Date().toISOString();
      const report: CapsuleCompatibilityReport = {
        id: identity.reportId,
        sourceId,
        capsuleId: request.capsuleId,
        sourceSnapshotId: request.sourceSnapshotId!,
        modulePath: "deploy/app",
        level: options.compatibilityLevel ?? "ready",
        findings: [],
        providers: [],
        resources: [],
        dataSources: [],
        provisioners: [],
        rootModuleVariables: [],
        rootModuleVariableDeclarations: [],
        rootModuleOutputs: [],
        createdAt: now,
      };
      const run: Run = {
        id: identity.runId,
        workspaceId: WORKSPACE.id,
        sourceId,
        capsuleId: request.capsuleId,
        type: "compatibility_check",
        status: "succeeded",
        sourceSnapshotId: request.sourceSnapshotId,
        compatibilityReportId: report.id,
        createdBy: identity.createdBy,
        createdAt: now,
        finishedAt: now,
      };
      reports.set(report.id, report);
      runs.set(run.id, run);
      lose("compatibility");
      return { run, report };
    },
    capsules: {
      getCapsule: async (id: string) => {
        if (id !== capsule.id) throw new OpenTofuControllerError("not_found", "missing");
        return capsule;
      },
      getInstallConfig: async (id: string) => {
        if (id !== installConfig.id) throw new OpenTofuControllerError("not_found", "missing");
        return installConfig;
      },
      listCapsulesPage: async () => ({ items: [capsule] }),
    },
    getCapsuleAdoptedSourceRevision: async (capsuleId: string) => {
      if (capsuleId !== capsule.id) {
        throw new OpenTofuControllerError("not_found", "missing");
      }
      return {
        sourceSnapshotId: "snap_adopted_revision",
        ref: "refs/heads/release/v1",
        path: options.adoptedPath ?? "deploy/app",
        resolvedCommit: "1".repeat(40),
      };
    },
    getRun: async (id: string) => {
      const run = runs.get(id);
      if (!run) throw new OpenTofuControllerError("not_found", "missing");
      return run;
    },
    createCapsulePlan: async (
      capsuleId: string,
      input: {
        readonly sourceSnapshotId?: string;
        readonly compatibilityReportId?: string;
        readonly planRunId?: string;
        readonly actor?: string;
      },
    ) => {
      const existing = runs.get(input.planRunId!);
      if (existing) return { planRun: existing as never };
      counts.plan += 1;
      const run: Run = {
        id: input.planRunId!,
        workspaceId: WORKSPACE.id,
        capsuleId,
        environment: capsule.environment,
        type: "plan",
        status: "waiting_approval",
        sourceSnapshotId: input.sourceSnapshotId,
        compatibilityReportId: input.compatibilityReportId,
        baseStateGeneration: capsule.currentStateGeneration,
        createdBy: input.actor!,
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
      runs.set(run.id, run);
      if (options.mutateInstallConfigDuringPlan) {
        installConfig = {
          ...installConfig,
          modulePath: "deploy/raced",
        };
      }
      lose("plan");
      return { planRun: run as never };
    },
    approveRun: async () => {
      approvalCalls += 1;
      throw new Error("revision coordinator must not approve");
    },
    createApplyRun: async () => {
      applyCalls += 1;
      throw new Error("revision coordinator must not apply");
    },
  } as unknown as ControlPlaneOperations;

  function lose(kind: LostAckMutation): void {
    if (!loseAck.delete(kind)) return;
    throw new Error(`lost ack ${kind}`);
  }

  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    headers: Readonly<Record<string, string>> = {},
    subject = WORKSPACE.ownerUserId,
  ): Promise<Response> {
    const url = new URL(`https://app.example.test${path}`);
    const response = await handleAuthenticatedControlRoute({
      request: new Request(url, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      url,
      store: accountsStore,
      operations,
      subject,
    });
    if (!response) throw new Error("control route did not dispatch");
    return response;
  }

  return {
    planStore,
    source,
    capsule,
    get installConfig() {
      return installConfig;
    },
    replaceInstallConfig(next: InstallConfig) {
      installConfig = next;
    },
    mutateCapsule(patch: Partial<Capsule>) {
      Object.assign(capsule, patch);
    },
    mutateSource(patch: Partial<Source>) {
      Object.assign(source, patch);
    },
    counts,
    get approvalCalls() {
      return approvalCalls;
    },
    get applyCalls() {
      return applyCalls;
    },
    get sourceSyncPaths() {
      return [...syncRuns.values()].map((run) => run.path);
    },
    reconcile: (planId: string) =>
      request(`/api/v1/revision-plans/${planId}/reconcile`, "POST"),
    succeedSourceSync() {
      const [id, current] = [...syncRuns.entries()][0]!;
      const succeeded: SourceSyncRun = {
        ...current,
        status: "succeeded",
        resolvedCommit: "a".repeat(40),
        archiveDigest: `sha256:${"b".repeat(64)}`,
        archiveSizeBytes: 42,
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      syncRuns.set(id, succeeded);
      snapshots.set(current.snapshotId!, {
        id: current.snapshotId!,
        origin: "git",
        workspaceId: WORKSPACE.id,
        sourceId: source.id,
        url: source.url,
        ref: current.ref,
        resolvedCommit: "a".repeat(40),
        path: current.path,
        archiveRef: current.archiveRef,
        archiveDigest: `sha256:${"b".repeat(64)}`,
        archiveSizeBytes: 42,
        repositoryManifest: { status: "absent" },
        fetchedByRunId: current.id,
        fetchedAt: new Date().toISOString(),
      });
    },
    request,
  };
}
