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
  activeGitRevisionPreparation,
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
import { requireResourceAccess } from "./app-authorization.ts";

const MAX_IDEMPOTENCY_KEY_BYTES = 256;
const MAX_DIAGNOSTIC_CODE = 64;
const MAX_DIAGNOSTIC_REASON = 128;
const MAX_DIAGNOSTIC_MESSAGE = 256;
const DIAGNOSTIC_TOKEN = /^[A-Za-z][A-Za-z0-9._:-]*$/u;
const IMMUTABLE_COMMIT = /^[0-9a-f]{40}$/iu;

/** The terminal answer when the target is exactly what the app already runs. */
const ALREADY_CURRENT: GitInstallPlanDiagnostic = {
  code: "revision_already_current",
  message:
    "This app already runs this version: the same Git ref, path and commit. There is nothing to update.",
};

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
  const normalizedRequest = {
    operation: "revision" as const,
    capsuleId: capsule.id,
    ref: request.ref,
  };
  // Request identity is immutable input bookkeeping, not mutable preparation.
  // Observe an exact idempotency scope before capturing Workspace management
  // authority so a stopped Workspace can still return its existing record
  // without creating a successor or attempting new preparation.
  const [requestDigest, idempotencyKeyHash] = await Promise.all([
    stableJsonDigest(normalizedRequest),
    stableJsonDigest(key),
  ]);
  const existing = await ctx.operations.gitInstallPlans.getByScope({
    workspaceId: capsule.workspaceId,
    actorSubject: ctx.session.subject,
    idempotencyKeyHash,
  });
  if (existing) {
    if (
      existing.requestDigest === requestDigest &&
      isStoredGitRevisionPlan(existing)
    ) {
      return revisionPlanJson(existing);
    }
    return errorJson(
      "idempotency_conflict",
      "This Idempotency-Key was already used for a different Git lifecycle request in the same Workspace and actor scope.",
      409,
      ctx.request,
    );
  }
  // One version change at a time per Capsule: while another revision
  // coordinator is still preparing its Plan (not stalled, and pinned to the
  // current state generation and InstallConfig), a second one would race it
  // to a duplicate Plan. Its id is returned so the caller can follow it
  // instead. An exact idempotent replay was answered above.
  const preparing = await activeGitRevisionPreparation(
    ctx.operations.gitInstallPlans,
    capsule,
    Date.now(),
  );
  if (preparing) {
    return errorJson(
      "failed_precondition",
      "Another version change for this app is still being prepared.",
      409,
      ctx.request,
      {},
      { reason: "revision_in_progress", revisionPlanId: preparing.id },
    );
  }
  // Retain this exact active authority through all asynchronous Source,
  // InstallConfig, and Capsule preparation and pass it to the insert-only
  // coordinator write. A later drain -> active epoch cannot bless work
  // prepared under the old epoch.
  const expectedWorkspaceManagementAuthority =
    await ctx.operations.workspaces.captureManagementAuthority(
      capsule.workspaceId,
    );
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
  // Repository install UX pins its reviewed snapshot until the first Apply.
  // The canonical Plan controller rejects a different pin during that time.
  if (
    !capsule.currentStateVersionId &&
    installConfig.installExperience?.repositoryInstallUx?.status === "accepted"
  ) {
    return errorJson(
      "failed_precondition",
      "Review and apply the initial Capsule Plan before revising its Git ref.",
      409,
      ctx.request,
      {},
      { reason: "revision_requires_applied_state" },
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
  await ctx.operations.convergeOwnedSourceLane(source.id);
  const sourcePath = adoptedSourceRevision?.path ?? source.defaultPath;
  const installConfigDigest = await stableJsonDigest(installConfig);
  const capsuleExecutionAuthorityEpoch =
    await ctx.operations.capsules.getCapsuleExecutionAuthorityEpoch(capsule.id);
  const now = new Date().toISOString();
  const plan: StoredGitRevisionPlan = {
    id: revisionPlanId(),
    workspaceId: capsule.workspaceId,
    createdBy: ctx.session.subject,
    actorSubject: ctx.session.subject,
    idempotencyKeyHash,
    workspaceManagementAuthority: expectedWorkspaceManagementAuthority,
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
  const result = await ctx.operations.gitInstallPlans.create(
    plan,
    expectedWorkspaceManagementAuthority,
  );
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
  // A revision plan changes one existing app's version.
  const auth = await requireResourceAccess({
    operations: ctx.operations,
    store: ctx.store,
    session: ctx.session,
    workspaceId: stored.workspaceId,
    capsuleId: stored.capsuleId,
    action: method === "GET" || method === "HEAD" ? "view" : "update",
    ...(ctx.assertActive ? { assertActive: ctx.assertActive } : {}),
    ...(ctx.diagnostics ? { diagnostics: ctx.diagnostics } : {}),
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
  // Rows written before management-epoch persistence are terminal-read
  // compatible only. Never recapture a newer authority for a nonterminal
  // legacy coordinator, because that would bless stale preparation.
  const expectedWorkspaceManagementAuthority =
    observed.workspaceManagementAuthority;
  if (expectedWorkspaceManagementAuthority === undefined) {
    return errorJson(
      "failed_precondition",
      "Workspace management authority is unavailable for this coordinator record.",
      409,
      ctx.request,
      {},
      { reason: "workspace_management_admission_conflict" },
    );
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
    expectedWorkspaceManagementAuthority,
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
    // A deterministic refusal ends the coordinator with its own reason;
    // reconciling again would only repeat it. Anything else may have
    // committed before its acknowledgement was lost, so it stays retryable
    // and records which owner error it saw.
    const deterministic = permanentRevisionControllerDiagnostic(error);
    outcome =
      error instanceof PermanentRevisionPlanError
        ? { plan: failedPlan(acquired.plan, error.diagnostic), retryable: false }
        : deterministic
          ? { plan: failedPlan(acquired.plan, deterministic), retryable: false }
        : {
            plan: withDiagnostic(
              acquired.plan,
              retryableDiagnostic(acquired.plan, error),
            ),
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
  const diagnostic = permanentRevisionControllerOutcome(error);
  return diagnostic ? { ...diagnostic, ...ownerErrorFields(error) } : undefined;
}

function permanentRevisionControllerOutcome(
  error: unknown,
): GitInstallPlanDiagnostic | undefined {
  switch (structuredErrorReason(error)) {
    // An app-owned Source admits a sync only for a current account of that
    // app with an active ownership epoch. Reconciling the same row again can
    // never change who asked for it.
    case "app_access_denied":
      return {
        code: "app_access_denied",
        message:
          "The account that asked for this version change can no longer sync this app's Source.",
      };
    case "source_not_active":
      return {
        code: "source_not_active",
        message: "The app's Source is not active, so its version cannot change.",
      };
    case "source_owned_by_another_app":
      return {
        code: "source_owned_by_another_app",
        message: "This Source belongs to another app.",
      };
    case "invalid_source_revision":
      return {
        code: "invalid_source_revision",
        message: "Takosumi cannot sync the requested Git ref for this app.",
      };
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
    case "repository_install_ux_snapshot_mismatch":
      return {
        code: "repository_install_ux_snapshot_mismatch",
        message:
          "The initial install review pins a different SourceSnapshot. Apply that Plan before revising.",
      };
    default:
      break;
  }
  if (!(error instanceof OpenTofuControllerError)) return undefined;
  switch (error.code) {
    // Input the owner rejects as malformed, or a capability this host does
    // not have, is the same on every reconcile.
    case "invalid_argument":
      return {
        code: "revision_request_invalid",
        message: "Takosumi cannot prepare this version change as requested.",
      };
    case "not_implemented":
      return {
        code: "revision_unsupported",
        message: "This Takosumi host cannot prepare version changes.",
      };
    case "connection_not_owned_by_app_owner":
      return {
        code: "connection_not_owned_by_app_owner",
        message: "The Source's Git connection is not owned by the app owner.",
      };
    // Who asked for the change is part of this row; a refusal for that
    // account does not change by reconciling again.
    case "app_access_denied":
    case "app_owner_only":
    case "permission_denied":
      return {
        code: error.code,
        message:
          "The account that asked for this version change is not allowed to complete it.",
      };
    default:
      return undefined;
  }
}

/** Retryable, but never silent: which coordinator step and owner error. */
function retryableDiagnostic(
  plan: StoredGitRevisionPlan,
  error: unknown,
): GitInstallPlanDiagnostic {
  return {
    code: "revision_plan_reconcile_retryable",
    message:
      "Takosumi could not confirm the last coordinator step. Reconcile again to recover canonical state.",
    planCreationStage: revisionPlanCreationStage(plan.phase),
    ...ownerErrorFields(error),
  };
}

/** Bounded owner error classification; never exception prose. */
function ownerErrorFields(
  error: unknown,
): Pick<GitInstallPlanDiagnostic, "controllerCode" | "reason"> {
  if (!(error instanceof OpenTofuControllerError)) return {};
  const reason = structuredErrorReason(error);
  return {
    controllerCode: error.code,
    ...(reason ? { reason } : {}),
  };
}

function revisionPlanCreationStage(
  phase: StoredGitRevisionPlan["phase"],
): NonNullable<GitInstallPlanDiagnostic["planCreationStage"]> {
  if (phase === "syncing_source") return "source";
  if (phase === "planning") return "create";
  return "preparation";
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
    case "awaiting_input":
      throw permanent(
        "revision_phase_invalid",
        "The revision coordinator reached an install-only phase.",
      );
    case "reviewable":
    case "failed":
    case "discarded":
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
    // An exact commit the app already runs, from the same ref and subtree,
    // cannot have a newer version: answer without syncing it again.
    if (
      IMMUTABLE_COMMIT.test(plan.revision.targetRef) &&
      isAdoptedRevision(plan, identity.adopted, plan.revision.targetRef)
    ) {
      return failedPlan(plan, ALREADY_CURRENT);
    }
    sync = (
      await operations.createSourceSync(
        plan.sourceId,
        {
          intent: "manual_plan",
          dedupe: true,
          coordinator: {
            ref: plan.revision.targetRef,
            path: plan.source.path,
            runId: evidence.runId,
            snapshotId: evidence.snapshotId,
          },
        },
        plan.workspaceManagementAuthority,
        // An app-owned Source syncs only for a current account of its app:
        // the account that asked for this version change, which is also the
        // actor of the Plan it prepares.
        plan.createdBy,
      )
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
    sync.snapshotId!,
  );
  assertRevisionSnapshotMatches(snapshot, plan, sync);
  // A branch or tag that still resolves to the applied commit has nothing
  // newer. A different ref to the same commit is a lane change and is
  // planned like any other version.
  if (isAdoptedRevision(plan, identity.adopted, snapshot.resolvedCommit)) {
    return failedPlan(
      progressed(plan, { sourceSyncRunId: sync.id, sourceSnapshotId: snapshot.id }),
      ALREADY_CURRENT,
    );
  }
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
  const sync = await operations.getSourceSyncRun(plan.sourceSyncRunId!);
  assertSourceSyncMatches(sync, plan, identity.source, await revisionSourceEvidence(plan));
  assertRevisionSnapshotMatches(snapshot, plan, sync);
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
    {
      kind: "captured",
      authority: plan.workspaceManagementAuthority ?? null,
    },
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
  const observedExistingRun = run !== undefined;
  if (!run) {
    const created = await operations.createCapsulePlan(plan.capsuleId, {
      sourceSnapshotId: plan.sourceSnapshotId,
      compatibilityReportId: plan.compatibilityReportId,
      planRunId: exactRunId,
      expectedWorkspaceManagementAuthority:
        plan.workspaceManagementAuthority,
      actor: plan.createdBy,
      origin: { kind: "revision", ref: plan.revision.targetRef },
    });
    run = await operations.getRun(created.planRun.id);
  }
  // The canonical plan operation reads Capsule/Source/InstallConfig again.
  // Re-read our immutable scope after that mutation so a concurrent edit can
  // never be published by this coordinator as reviewable evidence.
  await assertRevisionIdentity(plan, operations);
  assertRevisionRunMatches(run, plan, exactRunId, observedExistingRun);
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
  /** The Source revision of the applied state, when the Capsule has one. */
  readonly adopted?: CapsuleAdoptedSourceRevision;
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
    !base.capsuleStateVersionId &&
    !capsule.currentStateVersionId &&
    installConfig.installExperience?.repositoryInstallUx?.status === "accepted"
  ) {
    throw permanent(
      "revision_requires_applied_state",
      "Review and apply the initial Capsule Plan before revising its Git ref.",
    );
  }
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
  return {
    capsule,
    source,
    installConfig,
    modulePath,
    ...(adoptedSourceRevision ? { adopted: adoptedSourceRevision } : {}),
  };
}

/**
 * Whether the target is exactly the applied Source revision: the same Git
 * ref (not merely the same commit), the same subtree, and the same commit.
 */
function isAdoptedRevision(
  plan: StoredGitRevisionPlan,
  adopted: CapsuleAdoptedSourceRevision | undefined,
  resolvedCommit: string | undefined,
): boolean {
  return (
    adopted !== undefined &&
    resolvedCommit !== undefined &&
    sameGitName(adopted.ref, plan.revision.targetRef) &&
    adopted.path === plan.source.path &&
    sameGitName(adopted.resolvedCommit, resolvedCommit)
  );
}

/** Ref names compare exactly; full commit ids compare without case. */
function sameGitName(left: string, right: string): boolean {
  return (
    left === right ||
    (IMMUTABLE_COMMIT.test(left) &&
      IMMUTABLE_COMMIT.test(right) &&
      left.toLowerCase() === right.toLowerCase())
  );
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
    (sync.requestedSnapshotId ?? sync.snapshotId) !== evidence.snapshotId ||
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
  sync: SourceSyncRun,
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
    sync.status !== "succeeded" ||
    snapshot.id !== sync.snapshotId ||
    snapshot.resolvedCommit !== sync.resolvedCommit ||
    snapshot.archiveDigest !== sync.archiveDigest ||
    snapshot.archiveSizeBytes !== sync.archiveSizeBytes ||
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
  observedExistingRun: boolean,
): void {
  // Before account actors were retained, this coordinator used its exact id
  // as the Plan actor. Resume only an already-existing matching Run; new
  // Plans still have to retain the account that requested this revision.
  const actorMatches = run.createdBy === plan.createdBy ||
    (observedExistingRun && run.createdBy === `git-revision-plan:${plan.id}`);
  if (
    run.id !== exactRunId ||
    run.workspaceId !== plan.workspaceId ||
    run.capsuleId !== plan.capsuleId ||
    run.sourceSnapshotId !== plan.sourceSnapshotId ||
    run.compatibilityReportId !== plan.compatibilityReportId ||
    run.baseStateGeneration !== plan.revision.base.capsuleStateGeneration ||
    run.type !== "plan" ||
    !actorMatches
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
  const controllerCode = boundedDiagnosticToken(
    diagnostic.controllerCode,
    MAX_DIAGNOSTIC_CODE,
  );
  const reason = boundedDiagnosticToken(diagnostic.reason, MAX_DIAGNOSTIC_REASON);
  return {
    code: code.slice(0, MAX_DIAGNOSTIC_CODE),
    message: message || "Takosumi could not safely advance this revision plan.",
    ...(diagnostic.planCreationStage === "source" ||
    diagnostic.planCreationStage === "preparation" ||
    diagnostic.planCreationStage === "create"
      ? { planCreationStage: diagnostic.planCreationStage }
      : {}),
    ...(controllerCode ? { controllerCode } : {}),
    ...(reason ? { reason } : {}),
  };
}

function boundedDiagnosticToken(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (!value || value.length > maxLength || !DIAGNOSTIC_TOKEN.test(value)) {
    return undefined;
  }
  return value;
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

function digestSuffix(digest: string): string {
  return digest.replace(/^sha256:/u, "").slice(0, 16);
}
