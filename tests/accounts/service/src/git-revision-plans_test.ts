import { expect, test } from "bun:test";

import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { handleAuthenticatedControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { defaultCapsuleInstallConfig } from "../../../../core/domains/capsules/default_install_config.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import {
  InMemoryOpenTofuControlStore,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import {
  SourcesService,
  type CompatibilityCheckManagementContext,
  type InstallPlanCompatibilityCheckRequest,
} from "../../../../core/domains/sources/mod.ts";
import type { CapsuleCompatibilityAnalysis } from "../../../../core/domains/sources/capsule_compatibility.ts";
import type { StoredSource } from "../../../../core/domains/deploy-control/store.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import {
  GIT_REVISION_PREPARATION_STALL_AFTER_MS,
  InMemoryGitInstallPlanStore,
  type StoredGitInstallPlan,
} from "../../../../core/domains/install-plans/store.ts";
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
  await fixture.enableRealSourcesService();
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
  // An app-owned Source admits a sync only for a current account of the app:
  // the coordinator forwards the account that asked for the change.
  expect(fixture.sourceSyncActors).toEqual([WORKSPACE.ownerUserId]);
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
  expect([...fixture.runs.values()].find((run) => run.type === "compatibility_check")?.createdBy)
    .toMatch(/^git-revision-plan:[^:]+:[0-9a-f]{16}$/u);
  const storedCompatibilityRun = await fixture.getStoredCompatibilityRun();
  expect(storedCompatibilityRun?.createdBy).toBe(
    [...fixture.runs.values()].find((run) => run.type === "compatibility_check")?.createdBy,
  );
  expect([...fixture.runs.values()].find((run) => run.type === "plan")?.createdBy)
    .toBe(WORKSPACE.ownerUserId);
  expect(fixture.approvalCalls).toBe(0);
  expect(fixture.applyCalls).toBe(0);
  // The Plan records the version change it was made for, so a failed apply
  // can be retried as the same change.
  expect([...fixture.runs.values()].find((run) => run.type === "plan")?.origin).toEqual({
    kind: "revision",
    ref: "release/v2",
  });

  const denied = await fixture.request(
    `/api/v1/revision-plans/${planId}`,
    "GET",
    undefined,
    {},
    "tsub_foreign",
  );
  expect(denied.status).toBe(403);
});

test("Git revision recovers a lost sync acknowledgement after same-lane snapshot dedupe", async () => {
  const fixture = revisionFixture({ loseAckOnce: ["sync"] });
  const created = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans", "POST", { ref: "release/v2" },
    { "idempotency-key": "deduped-revision" },
  );
  const planId = (await created.json()).revisionPlan.id as string;
  await fixture.reconcile(planId);
  fixture.succeedSourceSync("snap_canonical_previous");
  let response = await fixture.reconcile(planId);
  expect((await response.json()).revisionPlan).toMatchObject({
    phase: "analyzing_compatibility", sourceSnapshotId: "snap_canonical_previous",
  });
  await fixture.reconcile(planId);
  response = await fixture.reconcile(planId);
  expect((await response.json()).revisionPlan.phase).toBe("reviewable");
  expect(fixture.counts).toEqual({ sync: 1, compatibility: 1, plan: 1 });
});

test("Git revision cannot replace an un-applied accepted install review", async () => {
  const fixture = revisionFixture({
    unAppliedInitialInstall: true,
    acceptedRepositoryInstallUx: true,
  });
  const response = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
    { "idempotency-key": "revision-before-first-apply" },
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: {
      code: "failed_precondition",
      details: { reason: "revision_requires_applied_state" },
    },
  });
  expect(fixture.counts).toEqual({ sync: 0, compatibility: 0, plan: 0 });
});

test("an already persisted pre-Apply revision stops instead of retrying Plan forever", async () => {
  const earlier = revisionFixture({ acceptedRepositoryInstallUx: true });
  const created = await earlier.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
    { "idempotency-key": "legacy-revision-before-first-apply" },
  );
  const id = (await created.json()).revisionPlan.id as string;
  const original = (await earlier.planStore.get(id))!;
  const fixture = revisionFixture({
    unAppliedInitialInstall: true,
    acceptedRepositoryInstallUx: true,
  });
  await fixture.planStore.create({
    ...original,
    phase: "planning",
    revision: {
      ...original.revision!,
      base: {
        ...original.revision!.base,
        capsuleStateGeneration: 0,
        capsuleStateVersionId: undefined,
      },
    },
  }, original.workspaceManagementAuthority);

  const stopped = await fixture.reconcile(id);
  expect(stopped.status).toBe(200);
  expect((await stopped.json()).revisionPlan).toMatchObject({
    phase: "failed",
    diagnostic: { code: "revision_requires_applied_state" },
  });
  expect(fixture.counts.plan).toBe(0);
});

test("plain Git revision remains available before first Apply", async () => {
  const fixture = revisionFixture({ unAppliedInitialInstall: true });
  const created = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
    { "idempotency-key": "plain-git-revision-before-first-apply" },
  );
  expect(created.status).toBe(201);
  const id = (await created.json()).revisionPlan.id as string;
  await fixture.reconcile(id);
  fixture.succeedSourceSync();
  await fixture.reconcile(id);
  await fixture.reconcile(id);
  const reviewable = await fixture.reconcile(id);
  expect((await reviewable.json()).revisionPlan).toMatchObject({
    phase: "reviewable",
    planRunId: expect.stringMatching(/^plan_/u),
  });
});

test("Git revision POST rejects preparation captured before drain and resume", async () => {
  const fixture = revisionFixture({ pausePreparation: true });
  const pending = fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
    { "idempotency-key": "revision-stale-management-epoch" },
  );

  await fixture.preparationStarted;
  await fixture.drainAndResume();
  fixture.releasePreparation();

  const response = await pending;
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: {
      code: "failed_precondition",
      details: { reason: "workspace_management_admission_conflict" },
    },
  });
  expect(
    await fixture.planStore.getByScope({
      workspaceId: WORKSPACE.id,
      actorSubject: WORKSPACE.ownerUserId,
      idempotencyKeyHash: await stableJsonDigest(
        "revision-stale-management-epoch",
      ),
    }),
  ).toBeUndefined();
});

test("Git revision POST replays an exact idempotency key while draining", async () => {
  const fixture = revisionFixture();
  const first = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
    { "idempotency-key": "revision-draining-replay" },
  );
  expect(first.status).toBe(201);
  const planId = (await first.json()).revisionPlan.id as string;

  await fixture.beginDrain();
  const replay = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
    { "idempotency-key": "revision-draining-replay" },
  );
  expect(replay.status).toBe(200);
  expect((await replay.json()).revisionPlan.id).toBe(planId);
});

test("a second version change waits while one is being prepared, and is admitted once that one planned", async () => {
  const fixture = revisionFixture();
  const first = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
    { "idempotency-key": "revision-first" },
  );
  expect(first.status).toBe(201);
  const planId = (await first.json()).revisionPlan.id as string;
  // Another request with its own key would race the first to a second Plan.
  const second = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v3" },
    { "idempotency-key": "revision-second" },
  );
  expect(second.status).toBe(409);
  expect(await second.json()).toMatchObject({
    error: { details: { reason: "revision_in_progress", revisionPlanId: planId } },
  });
  // The first request's own replay is still answered.
  const replay = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
    { "idempotency-key": "revision-first" },
  );
  expect(replay.status).toBe(200);
  // Once the first one created its Plan Run, a new version change is admitted.
  await fixture.reconcile(planId);
  fixture.succeedSourceSync();
  for (let step = 0; step < 6; step += 1) {
    const response = await fixture.reconcile(planId);
    if ((await response.json()).revisionPlan.phase === "reviewable") break;
  }
  const later = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v3" },
    { "idempotency-key": "revision-second" },
  );
  expect(later.status).toBe(201);
});

/**
 * A revision coordinator row left behind by an earlier request, stored in a
 * fresh fixture as `change` rewrites it, then a new version change.
 */
async function newRevisionBeside(
  change: (row: StoredGitInstallPlan) => StoredGitInstallPlan,
): Promise<Response> {
  const earlier = revisionFixture();
  const created = await earlier.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
    { "idempotency-key": "revision-left-behind" },
  );
  expect(created.status).toBe(201);
  const original = (await earlier.planStore.get((await created.json()).revisionPlan.id))!;
  const fixture = revisionFixture();
  expect((await fixture.planStore.create(change(original), original.workspaceManagementAuthority)).status)
    .toBe("created");
  return await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v3" },
    { "idempotency-key": "revision-next" },
  );
}

function idleFor(row: StoredGitInstallPlan, ms: number): StoredGitInstallPlan {
  const at = new Date(Date.now() - ms).toISOString();
  return { ...row, createdAt: at, updatedAt: at };
}

test("a version change that stopped moving no longer blocks a new one", async () => {
  // Inside the stall window it still holds the app.
  expect((await newRevisionBeside((row) => idleFor(row, GIT_REVISION_PREPARATION_STALL_AFTER_MS - 60_000))).status)
    .toBe(409);
  expect((await newRevisionBeside((row) => idleFor(row, GIT_REVISION_PREPARATION_STALL_AFTER_MS + 60_000))).status)
    .toBe(201);
});

test("a failed version change never blocks a new one", async () => {
  const failed = await newRevisionBeside((row) => ({
    ...row,
    phase: "failed",
    diagnostic: { code: "revision_identity_changed", message: "The pinned base changed." },
    completedAt: row.updatedAt,
  }));
  expect(failed.status).toBe(201);
});

test("a version change pinned to an older state does not block a new one", async () => {
  // Another change was applied after it started: its reconcile can only fail.
  const moved = await newRevisionBeside((row) => ({
    ...row,
    revision: {
      ...row.revision!,
      base: { ...row.revision!.base, capsuleStateGeneration: row.revision!.base.capsuleStateGeneration - 1 },
    },
  }));
  expect(moved.status).toBe(201);
});

test("a version change pinned to an InstallConfig a settings change replaced does not block a new one", async () => {
  // A settings change rebinds the InstallConfig without a new generation;
  // the old row's reconcile can only fail on the moved base.
  const rebound = await newRevisionBeside((row) => ({
    ...row,
    installConfigId: "cfg_before_settings",
    installConfigBaseId: "cfg_before_settings",
    revision: {
      ...row.revision!,
      base: { ...row.revision!.base, installConfigId: "cfg_before_settings" },
    },
  }));
  expect(rebound.status).toBe(201);
});

test("Git revision reconciliation uses the original private management authority", async () => {
  const fixture = revisionFixture();
  const created = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
    { "idempotency-key": "revision-persisted-management-authority" },
  );
  expect(created.status).toBe(201);
  const payload = await created.json();
  const planId = payload.revisionPlan.id as string;
  expect(JSON.stringify(payload)).not.toContain("workspaceManagementAuthority");
  expect((await fixture.planStore.get(planId))?.workspaceManagementAuthority).toEqual({
    workspaceId: WORKSPACE.id,
    managementState: "active",
    managementEpoch: 1,
  });

  await fixture.drainAndResume();
  const rejected = await fixture.reconcile(planId);
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toMatchObject({
    error: {
      code: "failed_precondition",
      details: { reason: "workspace_management_admission_conflict" },
    },
  });
  expect((await fixture.planStore.get(planId))?.generation).toBe(0);
  expect(fixture.counts).toEqual({ sync: 0, compatibility: 0, plan: 0 });
});

test("Git revision Source sync forwarding rejects a post-claim management epoch race", async () => {
  const fixture = revisionFixture({
    raceAfterClaimBeforeSourceSync: true,
  });
  const created = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
    { "idempotency-key": "revision-post-claim-source-sync-race" },
  );
  expect(created.status).toBe(201);
  const planId = (await created.json()).revisionPlan.id as string;

  const raced = await fixture.reconcile(planId);
  expect(raced.status).toBe(202);
  expect(await raced.json()).toMatchObject({
    revisionPlan: {
      phase: "syncing_source",
      generation: 1,
      diagnostic: { code: "revision_plan_reconcile_retryable" },
    },
  });
  expect(fixture.counts).toEqual({ sync: 0, compatibility: 0, plan: 0 });
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

test("Git revision resumes an in-flight legacy Plan actor without replacing the requesting account", async () => {
  const fixture = revisionFixture({ loseAckOnce: ["plan"] });
  const created = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans", "POST", { ref: "release/v2" },
    { "idempotency-key": "revision-legacy-plan-actor" },
  );
  const planId = (await created.json()).revisionPlan.id as string;
  await fixture.reconcile(planId);
  fixture.succeedSourceSync();
  await fixture.reconcile(planId);
  await fixture.reconcile(planId);
  expect((await fixture.reconcile(planId)).status).toBe(202);
  const run = [...fixture.runs.values()].find((candidate) => candidate.type === "plan")!;
  const legacyActor = `git-revision-plan:${planId}`;
  fixture.runs.set(run.id, { ...run, createdBy: legacyActor, status: "running" });
  // A lost acknowledgement left the old coordinator without the Run id.
  expect((await fixture.planStore.get(planId))?.planRunId).toBeUndefined();

  const running = await fixture.reconcile(planId);
  expect((await running.json()).revisionPlan).toMatchObject({ phase: "planning", planRunId: run.id });
  fixture.runs.set(run.id, { ...run, createdBy: legacyActor });
  expect((await (await fixture.reconcile(planId)).json()).revisionPlan.phase).toBe("reviewable");
  expect((await fixture.planStore.get(planId))?.createdBy).toBe(WORKSPACE.ownerUserId);
  expect(fixture.runs.get(run.id)?.createdBy).toBe(legacyActor);
  expect(fixture.counts).toEqual({ sync: 1, compatibility: 1, plan: 1 });
  expect(fixture.approvalCalls).toBe(0);
  expect(fixture.applyCalls).toBe(0);
});

test("Git revision legacy Plan compatibility rejects other actors and mismatched evidence", async () => {
  for (const kind of ["other_account", "other_revision", "compatibility_actor", "snapshot"] as const) {
    const fixture = revisionFixture({ loseAckOnce: ["plan"] });
    const created = await fixture.request(
      "/api/v1/capsules/cap_revision/revision-plans", "POST", { ref: "release/v2" },
      { "idempotency-key": `revision-legacy-reject-${kind}` },
    );
    const planId = (await created.json()).revisionPlan.id as string;
    await fixture.reconcile(planId);
    fixture.succeedSourceSync();
    await fixture.reconcile(planId);
    await fixture.reconcile(planId);
    await fixture.reconcile(planId);
    const run = [...fixture.runs.values()].find((candidate) => candidate.type === "plan")!;
    fixture.runs.set(run.id, {
      ...run,
      createdBy: kind === "other_account" ? "tsub_foreign"
        : kind === "other_revision" ? "git-revision-plan:grp_other"
        : kind === "compatibility_actor" ? `git-revision-plan:${planId}:${"a".repeat(16)}`
        : `git-revision-plan:${planId}`,
      ...(kind === "snapshot" ? { sourceSnapshotId: "snap_other" } : {}),
    });
    const response = await fixture.reconcile(planId);
    expect((await response.json()).revisionPlan, kind).toMatchObject({
      phase: "failed", diagnostic: { code: "plan_run_identity_conflict" },
    });
    expect(fixture.counts.plan).toBe(1);
    expect((await fixture.planStore.get(planId))?.createdBy).toBe(WORKSPACE.ownerUserId);
  }
});

test("a newly created Git revision Plan must retain the requesting account actor", async () => {
  const fixture = revisionFixture({
    planRunActor: (runId) => `git-revision-plan:grp_${runId.slice("plan_".length)}`,
  });
  const created = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans", "POST", { ref: "release/v2" },
    { "idempotency-key": "revision-fresh-actor" },
  );
  const planId = (await created.json()).revisionPlan.id as string;
  await fixture.reconcile(planId);
  fixture.succeedSourceSync();
  await fixture.reconcile(planId);
  await fixture.reconcile(planId);
  expect((await (await fixture.reconcile(planId)).json()).revisionPlan).toMatchObject({
    phase: "failed", diagnostic: { code: "plan_run_identity_conflict" },
  });
  expect((await fixture.planStore.get(planId))?.createdBy).toBe(WORKSPACE.ownerUserId);
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

test("Git revision Plan does not retry a rejected initial install snapshot pin", async () => {
  const fixture = revisionFixture({ deterministicConflict: "plan_snapshot" });
  const created = await fixture.request(
    "/api/v1/capsules/cap_revision/revision-plans",
    "POST",
    { ref: "release/v2" },
    { "idempotency-key": "revision-initial-pin-conflict" },
  );
  const id = (await created.json()).revisionPlan.id as string;
  await fixture.reconcile(id);
  fixture.succeedSourceSync();
  await fixture.reconcile(id);
  await fixture.reconcile(id);

  const stopped = await fixture.reconcile(id);
  expect(stopped.status).toBe(200);
  expect((await stopped.json()).revisionPlan).toMatchObject({
    phase: "failed",
    diagnostic: { code: "repository_install_ux_snapshot_mismatch" },
  });
  expect(fixture.counts.plan).toBe(0);
});

test("a Source sync refusal that cannot change ends the revision with its own reason", async () => {
  const cases: readonly {
    readonly error: () => unknown;
    readonly diagnostic: Record<string, string>;
  }[] = [
    {
      error: () => new OpenTofuControllerError(
        "failed_precondition",
        "App-owned Source sync requires a trusted current actor and ownership epoch.",
        { reason: "app_access_denied" },
      ),
      diagnostic: {
        code: "app_access_denied",
        controllerCode: "failed_precondition",
        reason: "app_access_denied",
      },
    },
    {
      error: () => new OpenTofuControllerError(
        "failed_precondition",
        "Source src_revision is not active",
        { reason: "source_not_active" },
      ),
      diagnostic: { code: "source_not_active", reason: "source_not_active" },
    },
    {
      error: () => new OpenTofuControllerError("invalid_argument", "bad coordinator"),
      diagnostic: { code: "revision_request_invalid", controllerCode: "invalid_argument" },
    },
    {
      error: () => new OpenTofuControllerError("permission_denied", "not allowed"),
      diagnostic: { code: "permission_denied", controllerCode: "permission_denied" },
    },
  ];
  for (const [index, entry] of cases.entries()) {
    const fixture = revisionFixture({ sourceSyncError: entry.error });
    const created = await fixture.request(
      "/api/v1/capsules/cap_revision/revision-plans",
      "POST",
      { ref: "release/v2" },
      { "idempotency-key": `deterministic-sync-refusal-${index}` },
    );
    const planId = (await created.json()).revisionPlan.id as string;
    const stopped = await fixture.reconcile(planId);
    expect(stopped.status).toBe(200);
    const body = await stopped.json();
    expect(body).toMatchObject({
      revisionPlan: { phase: "failed", diagnostic: entry.diagnostic },
      nextAction: "none",
    });
    expect(JSON.stringify(body)).not.toContain("trusted current actor");
    const replay = await fixture.reconcile(planId);
    expect(replay.status).toBe(200);
    expect((await replay.json()).revisionPlan.generation).toBe(body.revisionPlan.generation);
    expect(fixture.sourceSyncActors).toEqual([WORKSPACE.ownerUserId]);
  }
});

test("a transient Source sync failure stays retryable and records the owner error", async () => {
  const unknown = revisionFixture({ sourceSyncError: () => new Error("lost acknowledgement") });
  const first = await unknown.request(
    "/api/v1/capsules/cap_revision/revision-plans", "POST", { ref: "release/v2" },
    { "idempotency-key": "transient-sync-unknown" },
  );
  const firstId = (await first.json()).revisionPlan.id as string;
  const retried = await unknown.reconcile(firstId);
  expect(retried.status).toBe(202);
  const retriedPlan = (await retried.json()).revisionPlan;
  expect(retriedPlan).toMatchObject({
    phase: "syncing_source",
    diagnostic: { code: "revision_plan_reconcile_retryable", planCreationStage: "source" },
  });
  expect(retriedPlan.diagnostic.controllerCode).toBeUndefined();
  expect(JSON.stringify(retriedPlan)).not.toContain("lost acknowledgement");

  const internal = revisionFixture({
    sourceSyncError: () => new OpenTofuControllerError("internal_error", "storage unavailable"),
  });
  const second = await internal.request(
    "/api/v1/capsules/cap_revision/revision-plans", "POST", { ref: "release/v2" },
    { "idempotency-key": "transient-sync-internal" },
  );
  const secondId = (await second.json()).revisionPlan.id as string;
  const recorded = await internal.reconcile(secondId);
  expect(recorded.status).toBe(202);
  expect((await recorded.json()).revisionPlan.diagnostic).toEqual({
    code: "revision_plan_reconcile_retryable",
    message:
      "Takosumi could not confirm the last coordinator step. Reconcile again to recover canonical state.",
    planCreationStage: "source",
    controllerCode: "internal_error",
  });
});

test("a revision to the exact applied commit is already current; the same commit under another ref is planned", async () => {
  const commit = "1".repeat(40);
  const pinned = revisionFixture({ adoptedRef: commit });
  const created = await pinned.request(
    "/api/v1/capsules/cap_revision/revision-plans", "POST", { ref: commit.toUpperCase() },
    { "idempotency-key": "pinned-already-current" },
  );
  const planId = (await created.json()).revisionPlan.id as string;
  const settled = await pinned.reconcile(planId);
  expect(settled.status).toBe(200);
  expect(await settled.json()).toMatchObject({
    revisionPlan: { phase: "failed", diagnostic: { code: "revision_already_current" } },
    nextAction: "none",
  });
  expect(pinned.counts).toEqual({ sync: 0, compatibility: 0, plan: 0 });

  // The app follows a branch at that commit; pinning the commit changes its
  // lane, so it is a real version change.
  const tracking = revisionFixture();
  const pin = await tracking.request(
    "/api/v1/capsules/cap_revision/revision-plans", "POST", { ref: commit },
    { "idempotency-key": "pin-current-commit" },
  );
  const pinId = (await pin.json()).revisionPlan.id as string;
  const syncing = await tracking.reconcile(pinId);
  expect(syncing.status).toBe(200);
  expect((await syncing.json()).revisionPlan).toMatchObject({
    phase: "syncing_source",
    sourceSyncRunId: expect.stringMatching(/^ssr_/u),
  });
  expect(tracking.counts.sync).toBe(1);
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
      name: "Source authentication",
      mutate: (fixture: ReturnType<typeof revisionFixture>) =>
        fixture.mutateSource({ authConnectionId: "changed_auth" }),
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
    readonly deterministicConflict?: "sync" | "compatibility" | "plan_snapshot";
    readonly compatibilityLevel?: CapsuleCompatibilityReport["level"];
    readonly mutateInstallConfigDuringPlan?: boolean;
    readonly sourceDefaultPath?: string;
    readonly adoptedPath?: string;
    readonly pausePreparation?: boolean;
    readonly raceAfterClaimBeforeSourceSync?: boolean;
    readonly unAppliedInitialInstall?: boolean;
    readonly acceptedRepositoryInstallUx?: boolean;
    readonly planRunActor?: (runId: string) => string;
    readonly adoptedRef?: string;
    readonly sourceSyncError?: () => unknown;
  } = {},
) {
  const managementStore = new InMemoryOpenTofuControlStore();
  // The in-memory store installs the Workspace synchronously before resolving.
  void managementStore.putWorkspace(WORKSPACE);
  const workspacesService = new WorkspacesService({ store: managementStore });
  let resumedManagementEpoch: number | undefined;
  const managementValidator = {
    isWorkspaceManagementAdmissionAllowed(
      workspaceId: string,
      expected?: WorkspaceManagementAuthority,
    ): boolean {
      if (resumedManagementEpoch !== undefined) {
        return workspaceId === WORKSPACE.id &&
          (expected === undefined ||
            expected.workspaceId === workspaceId &&
              expected.managementEpoch === resumedManagementEpoch);
      }
      return managementStore.isWorkspaceManagementAdmissionAllowed(
        workspaceId,
        expected,
      );
    },
  };
  const planStore = new InMemoryGitInstallPlanStore(managementValidator);
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
    ...(options.unAppliedInitialInstall
      ? { currentStateGeneration: 0 }
      : { currentStateVersionId: "sv_three", currentStateGeneration: 3 }),
    status: "active",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
  let installConfig: InstallConfig = {
    ...defaultCapsuleInstallConfig(),
    id: "cfg_revision",
    workspaceId: WORKSPACE.id,
    modulePath: "deploy/app",
    ...(options.acceptedRepositoryInstallUx
      ? { installExperience: { repositoryInstallUx: { status: "accepted" } } }
      : {}),
  };
  const syncRuns = new Map<string, SourceSyncRun>();
  const snapshots = new Map<string, SourceSnapshot>();
  const reports = new Map<string, CapsuleCompatibilityReport>();
  const runs = new Map<string, Run>();
  let realSourcesService: SourcesService | undefined;
  const counts = { sync: 0, compatibility: 0, plan: 0 };
  const sourceSyncActors: (string | undefined)[] = [];
  let approvalCalls = 0;
  let applyCalls = 0;
  let preparationPausePending = options.pausePreparation === true;
  let raceAfterClaimBeforeSourceSyncPending =
    options.raceAfterClaimBeforeSourceSync === true;
  let resolvePreparationStarted: (() => void) | undefined;
  let releasePreparationGate: (() => void) | undefined;
  const preparationStarted = new Promise<void>((resolve) => {
    resolvePreparationStarted = resolve;
  });
  const preparationGate = new Promise<void>((resolve) => {
    releasePreparationGate = resolve;
  });

  async function raceManagementEpochAfterClaim(): Promise<void> {
    const management = await managementStore.getWorkspaceManagement(
      WORKSPACE.id,
    );
    if (!management || management.managementState !== "active") {
      throw new Error("Workspace is not active");
    }
    const result = await managementStore.beginWorkspaceDraining(WORKSPACE.id, {
      workspaceId: WORKSPACE.id,
      managementState: "active",
      managementEpoch: management.managementEpoch,
    });
    if (result.status !== "started") {
      throw new Error("Workspace did not start draining");
    }
    // There is intentionally no public abort/resume endpoint yet. The
    // fixture's read-only validator models the documented N+2 active epoch
    // so stale child preparation cannot be blessed by a later active state.
    resumedManagementEpoch = management.managementEpoch + 2;
  }

  const operations = {
    gitInstallPlans: planStore,
    workspaces: {
      getWorkspace: async (id: string) => {
        if (id !== WORKSPACE.id) throw new Error("workspace not found");
        return WORKSPACE;
      },
      captureManagementAuthority: async (workspaceId: string) => {
        if (resumedManagementEpoch !== undefined) {
          return {
            workspaceId,
            managementState: "active" as const,
            managementEpoch: resumedManagementEpoch,
          };
        }
        return await workspacesService.captureManagementAuthority(workspaceId);
      },
    },
    members: {
      getMember: async () => undefined,
      listMembers: async () => [],
    },
    convergeOwnedSourceLane: async () => ({ source }),
    getSource: async (id: string) => {
      if (id !== source.id) throw new OpenTofuControllerError("not_found", "missing");
      return { source };
    },
    createSourceSync: async (
      sourceId: string,
      request: CreateSourceSyncRequest,
      expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
      actorAccountId?: string,
    ) => {
      const identity = request.coordinator;
      if (!identity || sourceId !== source.id) throw new Error("coordinator identity missing");
      sourceSyncActors.push(actorAccountId);
      if (options.sourceSyncError) throw options.sourceSyncError();
      if (options.deterministicConflict === "sync") {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "deterministic sync identity conflict",
          { reason: "source_sync_identity_conflict" },
        );
      }
      if (raceAfterClaimBeforeSourceSyncPending) {
        raceAfterClaimBeforeSourceSyncPending = false;
        await raceManagementEpochAfterClaim();
      }
      if (
        !managementValidator.isWorkspaceManagementAdmissionAllowed(
          WORKSPACE.id,
          expectedWorkspaceManagementAuthority,
        )
      ) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "Workspace management admission conflict",
          { reason: "workspace_management_admission_conflict" },
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
      request: InstallPlanCompatibilityCheckRequest,
      managementContext?: CompatibilityCheckManagementContext,
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
      if (realSourcesService) {
        if (!managementContext) {
          throw new Error("compatibility management context missing");
        }
        const result = await realSourcesService.createCompatibilityCheck(
          sourceId,
          request,
          managementContext,
        );
        counts.compatibility += 1;
        if (result.run) runs.set(result.run.id, result.run);
        reports.set(result.report.id, result.report);
        lose("compatibility");
        return result;
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
        providerPackages: [],
        rootProviderRequirements: [],
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
        if (preparationPausePending) {
          preparationPausePending = false;
          resolvePreparationStarted?.();
          await preparationGate;
        }
        return installConfig;
      },
      getCapsuleExecutionAuthorityEpoch: async () => 1,
      listCapsulesPage: async () => ({ items: [capsule] }),
    },
    getCapsuleAdoptedSourceRevision: async (capsuleId: string) => {
      if (capsuleId !== capsule.id) {
        throw new OpenTofuControllerError("not_found", "missing");
      }
      return {
        sourceSnapshotId: "snap_adopted_revision",
        ref: options.adoptedRef ?? "refs/heads/release/v1",
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
        readonly origin?: Run["origin"];
      },
    ) => {
      const existing = runs.get(input.planRunId!);
      if (existing) return { planRun: existing as never };
      if (options.deterministicConflict === "plan_snapshot") {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "The initial install review pins a different SourceSnapshot.",
          { reason: "repository_install_ux_snapshot_mismatch" },
        );
      }
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
        ...(input.origin ? { origin: input.origin } : {}),
        createdBy: options.planRunActor?.(input.planRunId!) ?? input.actor!,
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

  async function enableRealSourcesService(): Promise<void> {
    const storedSource: StoredSource = {
      ...source,
      hookSecretHash: "revision-test-hook-secret-hash",
      autoSync: false,
    };
    await Promise.all([
      managementStore.putSource(storedSource),
      managementStore.putCapsule(capsule),
      managementStore.putInstallConfig(installConfig),
    ]);
    realSourcesService = new SourcesService({
      store: managementStore,
      compatibilityAnalyzer: {
        analyze: async (): Promise<CapsuleCompatibilityAnalysis> => ({
          level: "ready",
          findings: [],
          providerPackages: [],
          rootProviderRequirements: [],
          resources: [],
          dataSources: [],
          provisioners: [],
          rootModuleVariables: [],
          rootModuleVariableDeclarations: [],
          rootModuleOutputs: [],
        }),
      },
    });
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
    runs,
    enableRealSourcesService,
    async getStoredCompatibilityRun() {
      const run = [...runs.values()].find((candidate) =>
        candidate.type === "compatibility_check"
      );
      return run
        ? await managementStore.getCompatibilityCheckRun(run.id)
        : undefined;
    },
    preparationStarted,
    releasePreparation: () => releasePreparationGate?.(),
    async beginDrain() {
      const management = await managementStore.getWorkspaceManagement(
        WORKSPACE.id,
      );
      if (!management || management.managementState !== "active") {
        throw new Error("Workspace is not active");
      }
      return await managementStore.beginWorkspaceDraining(WORKSPACE.id, {
        workspaceId: WORKSPACE.id,
        managementState: "active",
        managementEpoch: management.managementEpoch,
      });
    },
    async drainAndResume() {
      const management = await managementStore.getWorkspaceManagement(
        WORKSPACE.id,
      );
      if (!management || management.managementState !== "active") {
        throw new Error("Workspace is not active");
      }
      const result = await managementStore.beginWorkspaceDraining(WORKSPACE.id, {
        workspaceId: WORKSPACE.id,
        managementState: "active",
        managementEpoch: management.managementEpoch,
      });
      if (result.status !== "started") {
        throw new Error("Workspace did not start draining");
      }
      // There is intentionally no public abort/resume endpoint yet. The
      // fixture's read-only validator models the documented N+2 active epoch
      // so stale preparation cannot be blessed by a later active state.
      resumedManagementEpoch = management.managementEpoch + 2;
      return result;
    },
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
    sourceSyncActors,
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
    succeedSourceSync(canonicalSnapshotId?: string) {
      const [id, current] = [...syncRuns.entries()][0]!;
      const snapshotId = canonicalSnapshotId ?? current.snapshotId!;
      const succeeded: SourceSyncRun = {
        ...current,
        ...(canonicalSnapshotId ? { requestedSnapshotId: current.snapshotId, snapshotId } : {}),
        status: "succeeded",
        resolvedCommit: "a".repeat(40),
        archiveDigest: `sha256:${"b".repeat(64)}`,
        archiveSizeBytes: 42,
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      syncRuns.set(id, succeeded);
      const snapshot: SourceSnapshot = {
        id: snapshotId,
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
        repositoryInstallMetadata: { status: "absent" },
        repositoryManifest: { status: "absent" },
        repositoryModules: {
          status: "ready",
          scopePath: current.path,
          modules: [
            {
              path: ".",
              providerPackages: [],
              rootProviderRequirements: [],
            },
          ],
        },
        fetchedByRunId: canonicalSnapshotId ? "ssr_previous_observation" : current.id,
        fetchedAt: new Date().toISOString(),
      };
      snapshots.set(snapshotId, snapshot);
      if (realSourcesService) void managementStore.putSourceSnapshot(snapshot);
    },
    request,
  };
}


test("a revision base does not pin mutable Source lane defaults", async () => {
  const fixture = revisionFixture();
  const response = await fixture.request("/api/v1/capsules/cap_revision/revision-plans", "POST",
    { ref: "release/v2" }, { "idempotency-key": "lane-default-change" });
  const plan = (await response.json()).revisionPlan;
  expect(plan.revision.base.sourceDefaultRef).toBeUndefined();
  expect(plan.revision.base.sourceDefaultPath).toBeUndefined();
  fixture.mutateSource({ defaultRef: "another-default", defaultPath: "another/path" });
  expect((await (await fixture.reconcile(plan.id)).json()).revisionPlan.phase).not.toBe("failed");
});
