import type {
  CreateGitRevisionPlanRequest,
  GitInstallPlanDiagnostic,
  GitRevisionPlan,
  GitRevisionPlanResponse,
} from "takosumi-contract";
import {
  normalizeInstallConfigSourceUrl,
  type Capsule,
  type InstallConfig,
} from "takosumi-contract/install-configs";
import {
  normalizeCompatibilityReportModulePath,
  type CapsuleCompatibilityReportResponse,
} from "takosumi-contract/capsules";
import type { CapsuleAdoptedSourceRevision } from "takosumi-contract/capsules";
import type { Run } from "takosumi-contract/runs";
import type {
  Source,
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";

import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import {
  OpenTofuControllerError,
  structuredErrorReason,
} from "../../../../core/domains/deploy-control/errors.ts";
import { evaluateCompatibilityReportAgainstPolicy } from "../../../../core/domains/deploy-control/provider_policy.ts";
import {
  GIT_INSTALL_PLAN_RECONCILE_LEASE_MS,
  publicGitInstallPlan,
  type StoredGitInstallPlan,
} from "../../../../core/domains/install-plans/store.ts";
import type { InstallPlanCompatibilityCheckRequest } from "../../../../core/domains/sources/mod.ts";
import type { ControlPlaneOperations } from "../control-operations.ts";
import {
  errorJson,
  json,
  methodNotAllowed,
  readJsonObject,
} from "../http-helpers.ts";
import {
  requireWorkspaceAccess,
  type ControlDispatchContext,
} from "./shared.ts";

const MAX_IDEMPOTENCY_KEY_BYTES = 256;
const MAX_DIAGNOSTIC_CODE = 64;
const MAX_DIAGNOSTIC_MESSAGE = 256;

type StoredGitRevisionPlan = StoredGitInstallPlan & {
  readonly operation: "revision";
  readonly revision: NonNullable<StoredGitInstallPlan["revision"]>;
  readonly sourceId: string;
  readonly capsuleId: string;
  readonly installConfigId: string;
};

/** POST /api/v1/capsules/:capsuleId/revision-plans. */
export async function handleCapsuleRevisionPlans(
  ctx: ControlDispatchContext,
  capsule: Capsule,
  method: string,
): Promise<Response> {
  if (method !== "POST") return methodNotAllowed("POST");
  const key = idempotencyKey(ctx.request.headers.get("idempotency-key"));
  if (!key) {
    return errorJson(
      "idempotency_key_required",
      `Idempotency-Key is required and must be at most ${MAX_IDEMPOTENCY_KEY_BYTES} bytes.`,
      400,
      ctx.request,
    );
  }
  const body = await readJsonObject(ctx.request);
  const request = body ? parseCreateRevisionRequest(body) : undefined;
  if (!request) {
    return errorJson(
      "invalid_request",
      "The revision plan accepts only one safe Git ref. Variables, credentials, and secret values are not accepted.",
      400,
      ctx.request,
    );
  }
  if (capsule.status === "destroyed") {
    return errorJson(
      "failed_precondition",
      "A destroyed Capsule cannot be revised.",
      409,
      ctx.request,
    );
  }
  const { source } = await ctx.operations.getSource(capsule.sourceId);
  const installConfig = await ctx.operations.capsules.getInstallConfig(
    capsule.installConfigId,
  );
  if (
    source.workspaceId !== capsule.workspaceId ||
    source.id !== capsule.sourceId ||
    source.status !== "active" ||
    (installConfig.workspaceId !== undefined &&
      installConfig.workspaceId !== capsule.workspaceId)
  ) {
    return errorJson(
      "failed_precondition",
      "The Capsule, Source, or InstallConfig identity is not revision-ready.",
      409,
      ctx.request,
    );
  }
  const adoptedSourceRevision =
    await ctx.operations.getCapsuleAdoptedSourceRevision(capsule.id);
  if (capsule.currentStateVersionId && !adoptedSourceRevision) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "The Capsule's applied StateVersion has no adopted SourceSnapshot.",
    );
  }
  const sourcePath = adoptedSourceRevision?.path ?? source.defaultPath;
  const installConfigDigest = await stableJsonDigest(installConfig);
  const capsuleExecutionAuthorityEpoch =
    await ctx.operations.capsules.getCapsuleExecutionAuthorityEpoch(capsule.id);
  const normalizedRequest = {
    operation: "revision" as const,
    capsuleId: capsule.id,
    ref: request.ref,
  };
  const requestDigest = await stableJsonDigest(normalizedRequest);
  const idempotencyKeyHash = await stableJsonDigest(key);
  const now = new Date().toISOString();
  const plan: StoredGitRevisionPlan = {
    id: revisionPlanId(),
    workspaceId: capsule.workspaceId,
    createdBy: ctx.session.subject,
    actorSubject: ctx.session.subject,
    idempotencyKeyHash,
    capsuleExecutionAuthorityEpoch,
    requestDigest,
    operation: "revision",
    source: {
      name: source.name,
      url: normalizeInstallConfigSourceUrl(source.url),
      ref: request.ref,
      path: sourcePath,
      ...(source.authConnectionId
        ? { authConnectionId: source.authConnectionId }
        : {}),
    },
    capsule: {
      name: capsule.name,
      environment: capsule.environment,
    },
    options: {},
    revision: {
      targetRef: request.ref,
      base: {
        capsuleStateGeneration: capsule.currentStateGeneration,
        ...(capsule.currentStateVersionId
          ? { capsuleStateVersionId: capsule.currentStateVersionId }
          : {}),
        installConfigId: installConfig.id,
        installConfigDigest,
        sourceDefaultRef: source.defaultRef,
        sourceDefaultPath: source.defaultPath,
        ...(source.authConnectionId
          ? { sourceAuthConnectionId: source.authConnectionId }
          : {}),
      },
    },
    sourceId: source.id,
    capsuleId: capsule.id,
    installConfigId: installConfig.id,
    installConfigBaseId: installConfig.id,
    installConfigBaseDigest: installConfigDigest,
    installModulePath: normalizeCompatibilityReportModulePath(
      installConfig.modulePath,
    ),
    phase: "syncing_source",
    generation: 0,
    createdAt: now,
    updatedAt: now,
  };
  const result = await ctx.operations.gitInstallPlans.create(plan);
  if (result.status === "conflict") {
    return errorJson(
      "idempotency_conflict",
      "This Idempotency-Key was already used for a different Git lifecycle request in the same Workspace and actor scope.",
      409,
      ctx.request,
    );
  }
  if (!isStoredGitRevisionPlan(result.plan)) {
    return errorJson(
      "idempotency_conflict",
      "This Idempotency-Key is already bound to a different Git lifecycle operation.",
      409,
      ctx.request,
    );
  }
  return revisionPlanJson(
    result.plan,
    result.status === "created" ? 201 : 200,
  );
}

/** GET/POST /api/v1/revision-plans/:id[/reconcile]. */
export async function handleRevisionPlans(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  if (segments[0] !== "revision-plans" || segments.length < 2) {
    return undefined;
  }
  const id = decodeURIComponent(segments[1] ?? "");
  const stored = await ctx.operations.gitInstallPlans.get(id);
  if (!stored || !isStoredGitRevisionPlan(stored)) {
    return errorJson("not_found", "Revision plan not found.", 404);
  }
  const auth = await requireWorkspaceAccess({
    operations: ctx.operations,
    store: ctx.store,
    session: ctx.session,
    workspaceId: stored.workspaceId,
  });
  if (!auth.ok) return auth.response;

  if (segments.length === 2) {
    if (method !== "GET") return methodNotAllowed("GET");
    return revisionPlanJson(stored);
  }
  if (segments.length === 3 && segments[2] === "reconcile") {
    if (method !== "POST") return methodNotAllowed("POST");
    return await reconcileRevisionPlan(ctx, stored);
  }
  return undefined;
}

async function reconcileRevisionPlan(
  ctx: ControlDispatchContext,
  observed: StoredGitRevisionPlan,
): Promise<Response> {
  if (observed.phase === "reviewable" || observed.phase === "failed") {
    return revisionPlanJson(observed);
  }
  const claimedAt = new Date();
  const claim = await ctx.operations.gitInstallPlans.claimReconcile({
    id: observed.id,
    expectedGeneration: observed.generation,
    leaseToken: `grpl_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    claimedAt: claimedAt.toISOString(),
    leaseExpiresAt: new Date(
      claimedAt.getTime() + GIT_INSTALL_PLAN_RECONCILE_LEASE_MS,
    ).toISOString(),
  });
  if (claim.status !== "claimed") {
    if (claim.status === "not_found") {
      return errorJson("not_found", "Revision plan not found.", 404);
    }
    return claim.status === "busy"
      ? errorJson(
          "reconcile_in_progress",
          "Another reconciler currently owns this revision plan.",
          409,
          ctx.request,
        )
      : errorJson(
          "reconcile_conflict",
          "The revision plan advanced concurrently; read it and retry explicitly.",
          409,
          ctx.request,
        );
  }
  if (!isStoredGitRevisionPlan(claim.claim.plan)) {
    return errorJson("reconcile_conflict", "Revision identity changed.", 409);
  }
  const acquired = {
    ...claim.claim,
    plan: claim.claim.plan,
  };
  let outcome: RevisionAdvanceOutcome;
  try {
    outcome = {
      plan: await advanceRevisionPlan(acquired.plan, ctx.operations),
      retryable: false,
    };
  } catch (error) {
    const durableConflict = permanentRevisionControllerDiagnostic(error);
    outcome =
      error instanceof PermanentRevisionPlanError
        ? { plan: failedPlan(acquired.plan, error.diagnostic), retryable: false }
        : durableConflict
          ? { plan: failedPlan(acquired.plan, durableConflict), retryable: false }
        : {
            plan: withDiagnostic(acquired.plan, {
              code: "revision_plan_reconcile_retryable",
              message:
                "Takosumi could not confirm the last coordinator step. Reconcile again to recover canonical state.",
            }),
            retryable: true,
          };
  }
  const completed = await ctx.operations.gitInstallPlans.completeReconcile({
    id: observed.id,
    expectedGeneration: acquired.plan.generation,
    leaseToken: acquired.leaseToken,
    plan: outcome.plan,
  });
  if (completed.status === "not_found") {
    return errorJson("not_found", "Revision plan not found.", 404);
  }
  if (completed.status === "conflict" || !isStoredGitRevisionPlan(completed.plan)) {
    return errorJson(
      "reconcile_conflict",
      "The revision plan advanced concurrently; read it and retry explicitly.",
      409,
      ctx.request,
    );
  }
  return revisionPlanJson(completed.plan, outcome.retryable ? 202 : 200);
}

function permanentRevisionControllerDiagnostic(
  error: unknown,
): GitInstallPlanDiagnostic | undefined {
  switch (structuredErrorReason(error)) {
    case "source_sync_identity_conflict":
      return {
        code: "source_sync_identity_conflict",
        message:
          "The deterministic Source sync identity is bound to different revision evidence.",
      };
    case "compatibility_evidence_identity_conflict":
      return {
        code: "compatibility_evidence_identity_conflict",
        message:
          "The deterministic compatibility identity is bound to different revision evidence.",
      };
    case "compatibility_evidence_incomplete":
      return {
        code: "compatibility_evidence_incomplete",
        message:
          "The deterministic compatibility evidence is incomplete and cannot be adopted safely.",
      };
    default:
      return undefined;
  }
}

interface RevisionAdvanceOutcome {
  readonly plan: StoredGitRevisionPlan;
  readonly retryable: boolean;
}

async function advanceRevisionPlan(
  plan: StoredGitRevisionPlan,
  operations: ControlPlaneOperations,
): Promise<StoredGitRevisionPlan> {
  switch (plan.phase) {
    case "syncing_source":
      return await advanceRevisionSource(plan, operations);
    case "analyzing_compatibility":
      return await analyzeRevisionCompatibility(plan, operations);
    case "planning":
      return await createOrObserveRevisionPlanRun(plan, operations);
    case "compiling_install":
    case "creating_capsule":
      throw permanent(
        "revision_phase_invalid",
        "The revision coordinator reached an install-only phase.",
      );
    case "reviewable":
    case "failed":
      return plan;
  }
}

async function advanceRevisionSource(
  plan: StoredGitRevisionPlan,
  operations: ControlPlaneOperations,
): Promise<StoredGitRevisionPlan> {
  const identity = await assertRevisionIdentity(plan, operations);
  const evidence = await revisionSourceEvidence(plan);
  let sync: SourceSyncRun;
  if (plan.sourceSyncRunId) {
    sync = await operations.getSourceSyncRun(plan.sourceSyncRunId);
  } else {
    sync = (
      await operations.createSourceSync(plan.sourceId, {
        intent: "manual_plan",
        dedupe: true,
        coordinator: {
          ref: plan.revision.targetRef,
          path: plan.source.path,
          runId: evidence.runId,
          snapshotId: evidence.snapshotId,
        },
      })
    ).run;
  }
  assertSourceSyncMatches(sync, plan, identity.source, evidence);
  if (sync.status === "queued" || sync.status === "running") {
    return progressed(plan, { sourceSyncRunId: sync.id });
  }
  if (sync.status === "failed") {
    return failedPlan(plan, {
      code: "source_sync_failed",
      message: "The canonical revision Source sync failed.",
    });
  }
  const snapshot = await sourceSnapshotById(
    operations,
    plan.sourceId,
    evidence.snapshotId,
  );
  assertRevisionSnapshotMatches(snapshot, plan, sync);
  const compatibility = await revisionCompatibilityEvidence(plan, snapshot);
  return progressed(plan, {
    sourceSyncRunId: sync.id,
    sourceSnapshotId: snapshot.id,
    compatibilityRequestDigest: compatibility.requestDigest,
    compatibilityCheckRunId: compatibility.runId,
    compatibilityReportId: compatibility.reportId,
    phase: "analyzing_compatibility",
  });
}

async function analyzeRevisionCompatibility(
  plan: StoredGitRevisionPlan,
  operations: ControlPlaneOperations,
): Promise<StoredGitRevisionPlan> {
  const identity = await assertRevisionIdentity(plan, operations);
  const snapshot = await sourceSnapshotById(
    operations,
    plan.sourceId,
    plan.sourceSnapshotId!,
  );
  assertRevisionSnapshotMatches(snapshot, plan, {
    id: plan.sourceSyncRunId!,
    sourceId: plan.sourceId,
  });
  const evidence = await revisionCompatibilityEvidence(plan, snapshot);
  if (
    plan.compatibilityRequestDigest !== evidence.requestDigest ||
    plan.compatibilityCheckRunId !== evidence.runId ||
    plan.compatibilityReportId !== evidence.reportId
  ) {
    throw permanent(
      "revision_identity_changed",
      "The pinned compatibility evidence changed after revision preparation.",
    );
  }
  const request: InstallPlanCompatibilityCheckRequest = {
    sourceSnapshotId: snapshot.id,
    capsuleId: plan.capsuleId,
    installPlanIdentity: {
      runId: evidence.runId,
      reportId: evidence.reportId,
      createdBy: evidence.createdBy,
    },
  };
  const compatibility = await operations.createSourceCompatibilityCheck(
    identity.source.id,
    request,
  );
  assertRevisionCompatibilityMatches({
    compatibility,
    plan,
    snapshot,
    modulePath: identity.modulePath,
    evidence,
  });
  const compatibilityPolicy = evaluateCompatibilityReportAgainstPolicy(
    compatibility.report,
    identity.installConfig.policy,
  );
  if (!compatibilityPolicy.runnable) {
    return failedPlan(plan, {
      code: "revision_compatibility_not_runnable",
      message:
        "The target revision is not runnable under this Capsule's compatibility policy.",
    });
  }
  return progressed(plan, { phase: "planning" });
}

async function createOrObserveRevisionPlanRun(
  plan: StoredGitRevisionPlan,
  operations: ControlPlaneOperations,
): Promise<StoredGitRevisionPlan> {
  await assertRevisionIdentity(plan, operations);
  const exactRunId = plan.planRunId ?? deterministicPlanRunId(plan.id);
  let run: Run | undefined;
  try {
    run = await operations.getRun(exactRunId);
  } catch (error) {
    if (!(error instanceof OpenTofuControllerError) || error.code !== "not_found") {
      throw error;
    }
  }
  if (!run) {
    const created = await operations.createCapsulePlan(plan.capsuleId, {
      sourceSnapshotId: plan.sourceSnapshotId,
      compatibilityReportId: plan.compatibilityReportId,
      planRunId: exactRunId,
      actor: revisionPlanRunActor(plan.id),
    });
    run = await operations.getRun(created.planRun.id);
  }
  // The canonical plan operation reads Capsule/Source/InstallConfig again.
  // Re-read our immutable scope after that mutation so a concurrent edit can
  // never be published by this coordinator as reviewable evidence.
  await assertRevisionIdentity(plan, operations);
  assertRevisionRunMatches(run, plan, exactRunId);
  if (
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "expired"
  ) {
    return failedPlan(progressed(plan, { planRunId: run.id }), {
      code: "plan_run_failed",
      message: "The canonical revision Plan Run did not become reviewable.",
    });
  }
  if (run.status === "succeeded" || run.status === "waiting_approval") {
    return progressed(plan, {
      planRunId: run.id,
      phase: "reviewable",
      completedAt: new Date().toISOString(),
    });
  }
  return progressed(plan, { planRunId: run.id });
}

interface RevisionIdentity {
  readonly capsule: Capsule;
  readonly source: Source;
  readonly installConfig: InstallConfig;
  readonly modulePath: string;
}

async function assertRevisionIdentity(
  plan: StoredGitRevisionPlan,
  operations: ControlPlaneOperations,
): Promise<RevisionIdentity> {
  let capsule: Capsule;
  let source: Source;
  let installConfig: InstallConfig;
  let adoptedSourceRevision: CapsuleAdoptedSourceRevision | undefined;
  try {
    capsule = await operations.capsules.getCapsule(plan.capsuleId);
    source = (await operations.getSource(plan.sourceId)).source;
    installConfig = await operations.capsules.getInstallConfig(
      plan.installConfigId,
    );
    adoptedSourceRevision =
      await operations.getCapsuleAdoptedSourceRevision(capsule.id);
  } catch (error) {
    if (error instanceof OpenTofuControllerError && error.code === "not_found") {
      throw permanent(
        "revision_identity_changed",
        "The pinned Capsule, Source, or InstallConfig is no longer available.",
      );
    }
    if (
      error instanceof OpenTofuControllerError &&
      error.code === "failed_precondition"
    ) {
      throw permanent(
        "revision_identity_changed",
        "The Capsule's adopted SourceSnapshot lineage is no longer valid.",
      );
    }
    throw error;
  }
  const configDigest = await stableJsonDigest(installConfig);
  const capsuleExecutionAuthorityEpoch =
    await operations.capsules.getCapsuleExecutionAuthorityEpoch(capsule.id);
  const modulePath = normalizeCompatibilityReportModulePath(
    installConfig.modulePath,
  );
  const base = plan.revision.base;
  if (
    capsule.id !== plan.capsuleId ||
    capsule.workspaceId !== plan.workspaceId ||
    capsule.sourceId !== plan.sourceId ||
    capsule.installConfigId !== plan.installConfigId ||
    capsule.name !== plan.capsule.name ||
    capsule.environment !== plan.capsule.environment ||
    capsule.status === "destroyed" ||
    capsule.currentStateGeneration !== base.capsuleStateGeneration ||
    (plan.capsuleExecutionAuthorityEpoch !== undefined &&
      capsuleExecutionAuthorityEpoch !==
        plan.capsuleExecutionAuthorityEpoch) ||
    (capsule.currentStateVersionId ?? undefined) !==
      (base.capsuleStateVersionId ?? undefined) ||
    source.id !== plan.sourceId ||
    source.workspaceId !== plan.workspaceId ||
    source.status !== "active" ||
    source.name !== plan.source.name ||
    normalizeInstallConfigSourceUrl(source.url) !== plan.source.url ||
    source.defaultRef !== base.sourceDefaultRef ||
    source.defaultPath !== base.sourceDefaultPath ||
    (adoptedSourceRevision?.path ?? source.defaultPath) !== plan.source.path ||
    (source.authConnectionId ?? undefined) !==
      (base.sourceAuthConnectionId ?? undefined) ||
    (source.authConnectionId ?? undefined) !==
      (plan.source.authConnectionId ?? undefined) ||
    installConfig.id !== base.installConfigId ||
    configDigest !== base.installConfigDigest ||
    plan.installConfigBaseId !== installConfig.id ||
    plan.installConfigBaseDigest !== configDigest ||
    plan.installModulePath !== modulePath ||
    (installConfig.workspaceId !== undefined &&
      installConfig.workspaceId !== plan.workspaceId)
  ) {
    throw permanent(
      "revision_identity_changed",
      "The pinned Capsule, Source, state generation, or InstallConfig changed before planning.",
    );
  }
  return { capsule, source, installConfig, modulePath };
}

interface RevisionSourceEvidence {
  readonly requestDigest: string;
  readonly runId: string;
  readonly snapshotId: string;
}

async function revisionSourceEvidence(
  plan: StoredGitRevisionPlan,
): Promise<RevisionSourceEvidence> {
  const requestDigest = await stableJsonDigest({
    kind: "git_revision_source_sync_v1",
    revisionPlanId: plan.id,
    revisionRequestDigest: plan.requestDigest,
    workspaceId: plan.workspaceId,
    capsuleId: plan.capsuleId,
    sourceId: plan.sourceId,
    targetRef: plan.revision.targetRef,
    sourcePath: plan.source.path,
    base: plan.revision.base,
  });
  const suffix = digestSuffix(requestDigest);
  return {
    requestDigest,
    runId: `ssr_${suffix}`,
    snapshotId: `snap_${suffix}`,
  };
}

interface RevisionCompatibilityEvidence {
  readonly requestDigest: string;
  readonly runId: string;
  readonly reportId: string;
  readonly createdBy: string;
}

async function revisionCompatibilityEvidence(
  plan: StoredGitRevisionPlan,
  snapshot: SourceSnapshot,
): Promise<RevisionCompatibilityEvidence> {
  const requestDigest = await stableJsonDigest({
    kind: "git_revision_plan_compatibility_v1",
    revisionPlanId: plan.id,
    revisionRequestDigest: plan.requestDigest,
    workspaceId: plan.workspaceId,
    capsuleId: plan.capsuleId,
    sourceId: plan.sourceId,
    sourceSnapshotId: snapshot.id,
    sourceSnapshotDigest: snapshot.archiveDigest,
    installConfigId: plan.installConfigId,
    installConfigDigest: plan.revision.base.installConfigDigest,
    modulePath: plan.installModulePath,
  });
  const suffix = digestSuffix(requestDigest);
  return {
    requestDigest,
    runId: `ccr_${suffix}`,
    reportId: `caprep_${suffix}`,
    createdBy: `git-revision-plan:${plan.id}:${suffix}`,
  };
}

function assertSourceSyncMatches(
  sync: SourceSyncRun,
  plan: StoredGitRevisionPlan,
  source: Source,
  evidence: RevisionSourceEvidence,
): void {
  if (
    sync.id !== evidence.runId ||
    sync.snapshotId !== evidence.snapshotId ||
    sync.workspaceId !== plan.workspaceId ||
    sync.sourceId !== plan.sourceId ||
    sync.url !== source.url ||
    sync.ref !== plan.revision.targetRef ||
    sync.path !== plan.source.path ||
    sync.intent !== "manual_plan"
  ) {
    throw permanent(
      "source_sync_identity_conflict",
      "The deterministic Source sync identity is bound to different revision evidence.",
    );
  }
}

function assertRevisionSnapshotMatches(
  snapshot: SourceSnapshot,
  plan: StoredGitRevisionPlan,
  sync: Pick<SourceSyncRun, "id" | "sourceId">,
): void {
  if (
    snapshot.id !== plan.sourceSnapshotId &&
    plan.sourceSnapshotId !== undefined
  ) {
    throw permanent(
      "source_snapshot_scope_mismatch",
      "The Source snapshot identity changed after it was pinned.",
    );
  }
  if (
    snapshot.workspaceId !== plan.workspaceId ||
    snapshot.sourceId !== plan.sourceId ||
    snapshot.sourceId !== sync.sourceId ||
    snapshot.fetchedByRunId !== sync.id ||
    normalizeInstallConfigSourceUrl(snapshot.url) !== plan.source.url ||
    snapshot.ref !== plan.revision.targetRef ||
    snapshot.path !== plan.source.path
  ) {
    throw permanent(
      "source_snapshot_scope_mismatch",
      "The Source snapshot does not match the immutable revision intent.",
    );
  }
}

function assertRevisionCompatibilityMatches(input: {
  readonly compatibility: CapsuleCompatibilityReportResponse;
  readonly plan: StoredGitRevisionPlan;
  readonly snapshot: SourceSnapshot;
  readonly modulePath: string;
  readonly evidence: RevisionCompatibilityEvidence;
}): void {
  const { report, run } = input.compatibility;
  if (
    report.id !== input.evidence.reportId ||
    report.sourceId !== input.plan.sourceId ||
    report.capsuleId !== input.plan.capsuleId ||
    report.sourceSnapshotId !== input.snapshot.id ||
    normalizeCompatibilityReportModulePath(report.modulePath) !==
      input.modulePath ||
    !run ||
    run.id !== input.evidence.runId ||
    run.workspaceId !== input.plan.workspaceId ||
    run.sourceId !== input.plan.sourceId ||
    run.capsuleId !== input.plan.capsuleId ||
    run.sourceSnapshotId !== input.snapshot.id ||
    run.type !== "compatibility_check" ||
    run.createdBy !== input.evidence.createdBy ||
    run.compatibilityReportId !== report.id ||
    (run.status !== "succeeded" && run.status !== "failed")
  ) {
    throw permanent(
      "compatibility_evidence_identity_conflict",
      "The deterministic compatibility evidence is bound to a different revision.",
    );
  }
}

function assertRevisionRunMatches(
  run: Run,
  plan: StoredGitRevisionPlan,
  exactRunId: string,
): void {
  if (
    run.id !== exactRunId ||
    run.workspaceId !== plan.workspaceId ||
    run.capsuleId !== plan.capsuleId ||
    run.sourceSnapshotId !== plan.sourceSnapshotId ||
    run.compatibilityReportId !== plan.compatibilityReportId ||
    run.baseStateGeneration !== plan.revision.base.capsuleStateGeneration ||
    run.type !== "plan" ||
    run.createdBy !== revisionPlanRunActor(plan.id)
  ) {
    throw permanent(
      "plan_run_identity_conflict",
      "The deterministic Plan Run identity is bound to different revision evidence.",
    );
  }
}

async function sourceSnapshotById(
  operations: ControlPlaneOperations,
  sourceId: string,
  snapshotId: string,
): Promise<SourceSnapshot> {
  try {
    const snapshot = await operations.getSourceSnapshot(snapshotId);
    if (snapshot.sourceId !== sourceId) {
      throw permanent(
        "source_snapshot_scope_mismatch",
        "The canonical Source snapshot belongs to a different Source.",
      );
    }
    return snapshot;
  } catch (error) {
    if (error instanceof PermanentRevisionPlanError) throw error;
    if (error instanceof OpenTofuControllerError && error.code === "not_found") {
      throw permanent(
        "source_snapshot_not_found",
        "The canonical revision Source snapshot is unavailable.",
      );
    }
    throw error;
  }
}

function parseCreateRevisionRequest(
  body: Record<string, unknown>,
): CreateGitRevisionPlanRequest | undefined {
  if (Object.keys(body).length !== 1 || !("ref" in body)) return undefined;
  const ref = safeGitRef(body.ref);
  return ref ? { ref } : undefined;
}

function safeGitRef(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() !== value) return undefined;
  if (
    value.length < 1 ||
    new TextEncoder().encode(value).byteLength > 256 ||
    /[\u0000-\u0020\u007f~^:?*\[\\]/u.test(value) ||
    value === "@" ||
    value === "." ||
    value === ".." ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  ) {
    return undefined;
  }
  return value;
}

function idempotencyKey(raw: string | null): string | undefined {
  if (!raw || raw.trim() !== raw || /[\u0000-\u001f\u007f]/u.test(raw)) {
    return undefined;
  }
  return new TextEncoder().encode(raw).byteLength <= MAX_IDEMPOTENCY_KEY_BYTES
    ? raw
    : undefined;
}

function isStoredGitRevisionPlan(
  plan: StoredGitInstallPlan,
): plan is StoredGitRevisionPlan {
  return Boolean(
    plan.operation === "revision" &&
      plan.revision &&
      plan.sourceId &&
      plan.capsuleId &&
      plan.installConfigId,
  );
}

function progressed(
  plan: StoredGitRevisionPlan,
  patch: Partial<StoredGitRevisionPlan>,
): StoredGitRevisionPlan {
  return {
    ...plan,
    ...patch,
    diagnostic: undefined,
    updatedAt: new Date().toISOString(),
  };
}

function withDiagnostic(
  plan: StoredGitRevisionPlan,
  diagnostic: GitInstallPlanDiagnostic,
): StoredGitRevisionPlan {
  return {
    ...plan,
    diagnostic: boundedDiagnostic(diagnostic),
    updatedAt: new Date().toISOString(),
  };
}

function failedPlan(
  plan: StoredGitRevisionPlan,
  diagnostic: GitInstallPlanDiagnostic,
): StoredGitRevisionPlan {
  const now = new Date().toISOString();
  return {
    ...plan,
    phase: "failed",
    diagnostic: boundedDiagnostic(diagnostic),
    updatedAt: now,
    completedAt: now,
  };
}

function boundedDiagnostic(
  diagnostic: GitInstallPlanDiagnostic,
): GitInstallPlanDiagnostic {
  const code = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/u.test(diagnostic.code)
    ? diagnostic.code
    : "revision_plan_failed";
  const message = diagnostic.message
    .replace(/[\r\n\0]/gu, " ")
    .slice(0, MAX_DIAGNOSTIC_MESSAGE);
  return {
    code: code.slice(0, MAX_DIAGNOSTIC_CODE),
    message: message || "Takosumi could not safely advance this revision plan.",
  };
}

class PermanentRevisionPlanError extends Error {
  readonly diagnostic: GitInstallPlanDiagnostic;

  constructor(diagnostic: GitInstallPlanDiagnostic) {
    super(diagnostic.code);
    this.name = "PermanentRevisionPlanError";
    this.diagnostic = boundedDiagnostic(diagnostic);
  }
}

function permanent(code: string, message: string): PermanentRevisionPlanError {
  return new PermanentRevisionPlanError({ code, message });
}

function revisionPlanJson(
  stored: StoredGitRevisionPlan,
  status = 200,
): Response {
  const publicPlan = publicGitInstallPlan(stored);
  if (!isPublicGitRevisionPlan(publicPlan)) {
    throw new TypeError("invalid Git revision plan projection");
  }
  return json(revisionPlanResponse(publicPlan), status, {
    "cache-control": "no-store",
  });
}

function isPublicGitRevisionPlan(
  plan: ReturnType<typeof publicGitInstallPlan>,
): plan is GitRevisionPlan {
  return Boolean(
    plan.operation === "revision" &&
      plan.revision &&
      plan.sourceId &&
      plan.capsuleId &&
      plan.installConfigId,
  );
}

function revisionPlanResponse(plan: GitRevisionPlan): GitRevisionPlanResponse {
  const self = `/api/v1/revision-plans/${encodeURIComponent(plan.id)}`;
  const terminal = plan.phase === "reviewable" || plan.phase === "failed";
  return {
    revisionPlan: plan,
    nextAction:
      plan.phase === "reviewable"
        ? "review_run"
        : plan.phase === "failed"
          ? "none"
          : "reconcile",
    links: {
      self,
      ...(!terminal ? { reconcile: `${self}/reconcile` } : {}),
      ...(plan.planRunId
        ? { run: `/api/v1/runs/${encodeURIComponent(plan.planRunId)}` }
        : {}),
    },
  };
}

function revisionPlanId(): string {
  return `grp_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function deterministicPlanRunId(planId: string): string {
  const suffix = planId.replace(/[^A-Za-z0-9]/gu, "").slice(-16);
  return `plan_${suffix.padStart(16, "0")}`;
}

function revisionPlanRunActor(planId: string): string {
  return `git-revision-plan:${planId}`;
}

function digestSuffix(digest: string): string {
  return digest.replace(/^sha256:/u, "").slice(0, 16);
}
