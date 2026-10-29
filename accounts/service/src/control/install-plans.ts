import type {
  CreateGitInstallAttemptRequest,
  CreateGitInstallPlanRequest,
  GitInstallPlan,
  GitInstallPlanDiagnostic,
  GitInstallPlanInvalidation,
  GitInstallPlanInterfaceLinkRequest,
  GitInstallPlanInterfaceRequirement,
  GitInstallPlanProviderBindingRequest,
  GitInstallPlanResponse,
  GitInstallPlanSourceRequest,
  JsonValue,
  ListOpenGitInstallPlansResponse,
  PatchGitInstallPlanRequest,
} from "takosumi-contract";
import {
  normalizeInstallConfigSourceUrl,
  type Capsule,
  type InstallConfig,
} from "takosumi-contract/install-configs";
import type { ProviderBindings } from "takosumi-contract/connections";
import { resolveCapsuleInterfaceBlueprintInstallingPrincipal } from "takosumi-contract/interfaces";
import {
  isOpenTofuBuiltinProviderSource,
  isOpenTofuIdentifier,
  normalizeProviderSourceAddress,
} from "takosumi-contract/provider-env-rules";
import {
  normalizeCompatibilityReportModulePath,
  type CapsuleRootModuleVariableDeclaration,
  type CapsuleCompatibilityReportResponse,
} from "takosumi-contract/capsules";
import type { Run } from "takosumi-contract/runs";
import type {
  RepositoryModuleRootProviderRequirement,
  Source,
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";

import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { InterfaceServiceError } from "../../../../core/domains/interfaces/service.ts";
import {
  OpenTofuControllerError,
  structuredErrorReason,
} from "../../../../core/domains/deploy-control/errors.ts";
import {
  WorkspaceManagementAdmissionConflictError,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import {
  GIT_INSTALL_ATTEMPT_IDLE_TTL_MS,
  GIT_INSTALL_ATTEMPT_LIST_LIMIT,
  GIT_INSTALL_PLAN_RECONCILE_LEASE_MS,
  isReconcileableGitInstallPlanPhase,
  publicGitInstallPlan,
  type GitInstallAttemptFacts,
  type StoredGitInstallPlan,
} from "../../../../core/domains/install-plans/store.ts";
import {
  attemptCanExpire,
  attemptInputFacts,
  attemptIsExpired,
  bindingMatchesRequirement,
  checkAttemptVariables,
  committedAttemptReviewSummary,
  connectionRequirements,
  connectionsReady,
  deterministicInitialCapsuleId,
  deterministicInstallSourceId,
  effectiveProviderBindings,
  effectiveInterfaceLinks,
  interfaceRequirements,
  duplicateSelectedInterface,
  interfacesReady,
  moduleCandidates,
  nameProposal,
  proposedAppName,
  userActionFor,
} from "./install-attempt-facts.ts";
import { evaluateSourceUrl } from "../../../../core/domains/sources/url-policy.ts";
import type { InstallPlanCompatibilityCheckRequest } from "../../../../core/domains/sources/mod.ts";
import type { ControlPlaneOperations } from "../control-operations.ts";
import { defaultProjectId } from "../../../../core/domains/projects/mod.ts";
import {
  errorJson,
  json,
  methodNotAllowed,
  readJsonObject,
  stringValue,
} from "../http-helpers.ts";
import {
  installConfigStoreValue,
  jsonRecordValue,
  modulePathValue,
  outputAllowlistValue,
  sourceBuildValue,
} from "./parse.ts";
import {
  genericOpenTofuVariableContractDigest,
  genericOpenTofuVariableDeclarationsAreCanonical as declarationsAreCanonical,
} from "./generic-opentofu-variable-contract.ts";
import { parseInterfaceBlueprintsValue } from "./interface-blueprints.ts";
import {
  previewRepoOwnedInstallConfig,
  resolveRepoOwnedInstallModulePath,
} from "./repo-owned-install-config.ts";
import {
  resolveStoreBaseInstallConfig,
} from "./sources.ts";
import {
  requireWorkspaceAccess,
  resolveProviderBindings,
  type ControlDispatchContext,
} from "./shared.ts";

const MAX_IDEMPOTENCY_KEY_BYTES = 256;
const MAX_DIAGNOSTIC_CODE = 64;
const MAX_DIAGNOSTIC_MESSAGE = 256;
const MAX_DIAGNOSTIC_REASON = 128;
const DIAGNOSTIC_TOKEN = /^[A-Za-z][A-Za-z0-9._:-]*$/u;
const CONNECTION_REFERENCE_PATTERN = /^conn_[0-9A-Za-z]{8,64}$/u;
const PROVIDER_SOURCE_PATTERN =
  /^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[a-z0-9_-]+\/[a-z0-9_-]+$/u;
const MAX_PROVIDER_BINDINGS = 32;

/**
 * POST/GET /api/v1/workspaces/:workspaceId/install-plans (Workspace auth is
 * done by the parent handler). GET lists the caller's open attempts.
 */
export async function handleWorkspaceInstallPlans(
  ctx: ControlDispatchContext,
  workspaceId: string,
  method: string,
): Promise<Response> {
  if (method === "GET") return await listOpenInstallAttempts(ctx, workspaceId);
  if (method !== "POST") return methodNotAllowed("GET, POST");
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
  const attempt = body && body.mode !== undefined
    ? parseCreateAttemptRequest(body)
    : undefined;
  const parsed = body && body.mode === undefined
    ? parseCreateRequest(body)
    : undefined;
  if (!parsed && !attempt) {
    return errorJson(
      "invalid_request",
      "The install plan must contain only a normalized Git Source, Capsule name/environment, and safe option references. Variable values are not accepted without an exact reviewed preflight; an install attempt (mode \"attempt\") accepts them only when it is confirmed.",
      400,
      ctx.request,
    );
  }
  // Request identity is immutable input bookkeeping, not mutable preparation.
  // Observe an exact idempotency scope before capturing Workspace management
  // authority so a stopped Workspace can still return its existing record
  // without creating a successor or attempting new preparation.
  //
  // Variable values never enter the public request digest: only their names
  // do. A replay is still recognized against digests written before values
  // were excluded.
  const variables = parsed?.variables;
  const [requestDigest, legacyRequestDigest, idempotencyKeyHash] = await Promise.all([
    stableJsonDigest(attempt ?? requestDigestInput(parsed!)),
    variables ? stableJsonDigest(parsed) : Promise.resolve(undefined),
    stableJsonDigest(key),
  ]);
  const existing = await ctx.operations.gitInstallPlans.getByScope({
    workspaceId,
    actorSubject: ctx.session.subject,
    idempotencyKeyHash,
  });
  if (existing) {
    if (
      existing.requestDigest === requestDigest ||
      (legacyRequestDigest !== undefined &&
        existing.requestDigest === legacyRequestDigest)
    ) {
      return await installPlanJson(ctx, existing);
    }
    return errorJson(
      "idempotency_conflict",
      "This Idempotency-Key was already used for a different install-plan request in the same Workspace and actor scope.",
      409,
      ctx.request,
    );
  }
  // Retain this exact active authority through all asynchronous preflight
  // preparation and pass it to the insert-only coordinator write. A later
  // drain -> active epoch cannot bless work prepared under the old epoch.
  const expectedWorkspaceManagementAuthority =
    await ctx.operations.workspaces.captureManagementAuthority(workspaceId);
  const now = new Date().toISOString();
  if (attempt) {
    const attemptPlan: StoredGitInstallPlan = {
      id: installPlanId(),
      workspaceId,
      createdBy: ctx.session.subject,
      actorSubject: ctx.session.subject,
      idempotencyKeyHash,
      workspaceManagementAuthority: expectedWorkspaceManagementAuthority,
      requestDigest,
      operation: "install",
      mode: "attempt",
      source: attempt.source,
      capsule: attempt.capsule,
      options: attempt.options,
      phase: "syncing_source",
      generation: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: attemptExpiry(now),
    };
    const created = await ctx.operations.gitInstallPlans.create(
      attemptPlan,
      expectedWorkspaceManagementAuthority,
    );
    if (created.status === "conflict") {
      return errorJson(
        "idempotency_conflict",
        "This Idempotency-Key was already used for a different install-plan request in the same Workspace and actor scope.",
        409,
        ctx.request,
      );
    }
    return await installPlanJson(
      ctx,
      created.plan,
      created.status === "created" ? 201 : 200,
    );
  }
  const request = parsed!;
  let preflightAuthority:
    | {
        readonly installConfigDigest: string;
        readonly baseInstallConfigId: string;
        readonly baseInstallConfigDigest: string;
      }
    | undefined;
  if (request.preflight) {
    const base = await resolveStoreBaseInstallConfig(ctx.operations);
    if (!base.ok) {
      return errorJson(
        "invalid_request",
        base.diagnostic.message,
        409,
        ctx.request,
        {},
        { reason: base.diagnostic.code },
      );
    }
    const reviewed = await ctx.operations.capsules.getInstallConfig(
      request.preflight.installConfigId,
    );
    if (
      reviewed.workspaceId !== undefined &&
      reviewed.workspaceId !== workspaceId
    ) {
      return errorJson(
        "invalid_request",
        "The reviewed InstallConfig is unavailable to this Workspace.",
        400,
        ctx.request,
      );
    }
    preflightAuthority = {
      installConfigDigest: await stableJsonDigest(reviewed),
      baseInstallConfigId: base.installConfig.id,
      baseInstallConfigDigest: await stableJsonDigest(base.installConfig),
    };
  }
  const plan: StoredGitInstallPlan = {
    id: installPlanId(),
    workspaceId,
    createdBy: ctx.session.subject,
    actorSubject: ctx.session.subject,
    idempotencyKeyHash,
    workspaceManagementAuthority: expectedWorkspaceManagementAuthority,
    requestDigest,
    operation: "install",
    source: request.source,
    capsule: request.capsule,
    options: request.options ?? {},
    ...(request.preflight
      ? {
          preflight: request.preflight,
          sourceId: request.preflight.sourceId,
          sourceSnapshotId: request.preflight.sourceSnapshotId,
          installConfigBaseId: preflightAuthority!.baseInstallConfigId,
          installConfigBaseDigest:
            preflightAuthority!.baseInstallConfigDigest,
          preflightInstallConfigDigest:
            preflightAuthority!.installConfigDigest,
          compatibilityCheckRunId:
            request.preflight.compatibilityCheckRunId,
          compatibilityReportId: request.preflight.compatibilityReportId,
        }
      : {}),
    // Legacy reviewed-preflight values keep their previous lifetime: private,
    // never projected, consumed by atomic creation and scrubbed by every
    // terminal transition. Install attempts never store values.
    ...(variables ? { initialVariables: variables } : {}),
    ...(request.initialConfiguration
      ? { initialConfiguration: request.initialConfiguration }
      : {}),
    phase: request.preflight ? "creating_capsule" : "syncing_source",
    generation: 0,
    createdAt: now,
    updatedAt: now,
  };
  if (plan.preflight) {
    try {
      await assertLegacyPreflightSourceOwnership(plan, ctx.operations);
    } catch (error) {
      if (error instanceof PermanentInstallPlanError) {
        return errorJson(error.diagnostic.code, error.diagnostic.message, 409, ctx.request);
      }
      throw error;
    }
  }
  const result = await ctx.operations.gitInstallPlans.create(
    plan,
    expectedWorkspaceManagementAuthority,
  );
  if (result.status === "conflict") {
    return errorJson(
      "idempotency_conflict",
      "This Idempotency-Key was already used for a different install-plan request in the same Workspace and actor scope.",
      409,
      ctx.request,
    );
  }
  return await installPlanJson(
    ctx,
    result.plan,
    result.status === "created" ? 201 : 200,
  );
}

/** The request digest input: variable names only, never values. */
function requestDigestInput(
  request: CreateGitInstallPlanRequest,
): Record<string, unknown> {
  const { variables, ...rest } = request;
  return variables === undefined
    ? rest
    : { ...rest, variableNames: Object.keys(variables).sort() };
}

function attemptExpiry(now: string): string {
  return new Date(Date.parse(now) + GIT_INSTALL_ATTEMPT_IDLE_TTL_MS)
    .toISOString();
}

/**
 * GET/PATCH/DELETE /api/v1/install-plans/:id and POST .../reconcile.
 *
 * GET never writes. An attempt that can no longer advance (it expired before
 * its Capsule existed, or its management epoch was replaced) is only reported
 * as `invalidated`; destructive cleanup happens solely in its creator's own
 * DELETE, or in a creator PATCH that finds the attempt invalid.
 */
export async function handleInstallPlans(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  if (segments[0] !== "install-plans" || segments.length < 2) {
    return undefined;
  }
  const planId = decodeURIComponent(segments[1] ?? "");
  const plan = await ctx.operations.gitInstallPlans.get(planId);
  if (!plan || plan.operation === "revision") {
    return errorJson("not_found", "Install plan not found.", 404);
  }
  const auth = await requireWorkspaceAccess({
    operations: ctx.operations,
    store: ctx.store,
    session: ctx.session,
    workspaceId: plan.workspaceId,
  });
  if (!auth.ok) return auth.response;

  if (segments.length === 2) {
    if (method === "GET") return await installPlanJson(ctx, plan);
    if (method === "PATCH") return await answerInstallAttempt(ctx, plan);
    if (method === "DELETE") return await discardInstallAttempt(ctx, plan);
    return methodNotAllowed("GET, PATCH, DELETE");
  }
  if (segments.length === 3 && segments[2] === "reconcile") {
    if (method !== "POST") return methodNotAllowed("POST");
    return await reconcileInstallPlan(ctx, plan);
  }
  return undefined;
}

/** GET /api/v1/workspaces/:id/install-plans?open=1 — the caller's attempts. */
async function listOpenInstallAttempts(
  ctx: ControlDispatchContext,
  workspaceId: string,
): Promise<Response> {
  const open = ctx.url.searchParams.get("open");
  if (open !== "1" && open !== "true") {
    return errorJson(
      "invalid_request",
      "Only open install attempts can be listed; pass open=1.",
      400,
      ctx.request,
    );
  }
  // The store applies the open filter (including never-applied Capsules)
  // before its limit. A read-only listing never settles anything.
  const candidates = await ctx.operations.gitInstallPlans.listOpenAttempts({
    workspaceId,
    actorSubject: ctx.session.subject,
    limit: GIT_INSTALL_ATTEMPT_LIST_LIMIT,
  });
  const installPlans: GitInstallPlanResponse[] = [];
  for (const plan of candidates) {
    // Defense in depth for a store without a co-located Capsule reader.
    if (
      plan.phase === "reviewable" &&
      (await attemptCapsuleState(ctx, plan)) !== "unapplied"
    ) {
      continue;
    }
    installPlans.push(await installPlanResponseFor(ctx, plan));
  }
  const body: ListOpenGitInstallPlansResponse = { installPlans };
  return json(body, 200, { "cache-control": "no-store" });
}

/** Whether the attempt's Capsule is still a never-applied install. */
async function attemptCapsuleState(
  ctx: ControlDispatchContext,
  plan: StoredGitInstallPlan,
): Promise<"none" | "unapplied" | "applied" | "gone"> {
  if (!plan.capsuleId) return "none";
  const capsule = await getCapsuleIfPresent(ctx.operations, plan.capsuleId);
  if (!capsule || capsule.status === "destroyed") return "gone";
  return capsuleHasAppliedState(capsule) ? "applied" : "unapplied";
}

function capsuleHasAppliedState(capsule: Capsule): boolean {
  return Boolean(
    capsule.currentStateVersionId || capsule.currentStateGeneration > 0,
  );
}

async function getCapsuleIfPresent(
  operations: ControlPlaneOperations,
  capsuleId: string,
): Promise<Capsule | undefined> {
  try {
    return await operations.capsules.getCapsule(capsuleId);
  } catch (error) {
    if (error instanceof OpenTofuControllerError && error.code === "not_found") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Read-only: why an attempt can no longer advance. Expiry applies only before
 * the Capsule exists; a replaced management epoch matters only while the
 * attempt idles in `awaiting_input` (any advance re-checks it atomically).
 */
async function attemptInvalidation(
  ctx: ControlDispatchContext,
  plan: StoredGitInstallPlan,
): Promise<GitInstallPlanInvalidation | undefined> {
  if (plan.mode !== "attempt") return undefined;
  if (attemptIsExpired(plan, Date.now())) return "install_attempt_expired";
  if (
    plan.phase === "awaiting_input" &&
    !(await originalAdmissionIsCurrent(ctx, plan))
  ) {
    return "workspace_management_changed";
  }
  return undefined;
}

const INVALIDATION_MESSAGES: Readonly<Record<GitInstallPlanInvalidation, string>> = {
  install_attempt_expired:
    "This install attempt expired before its app was created; discard it and start again.",
  workspace_management_changed:
    "Workspace management changed while this install attempt waited for input; discard it and start again.",
};

async function originalAdmissionIsCurrent(
  ctx: ControlDispatchContext,
  plan: StoredGitInstallPlan,
): Promise<boolean> {
  const original = plan.workspaceManagementAuthority;
  if (!original) return false;
  try {
    const current = await ctx.operations.workspaces.captureManagementAuthority(
      plan.workspaceId,
    );
    return current.managementEpoch === original.managementEpoch;
  } catch (error) {
    // Only a definite admission refusal proves the epoch is gone; any other
    // failure is not evidence against the attempt.
    if (error instanceof WorkspaceManagementAdmissionConflictError) return false;
    return true;
  }
}

type DiscardResult =
  | { readonly ok: true; readonly plan: StoredGitInstallPlan }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly reason?: string;
    };

const INITIAL_PHASES_WITHOUT_CAPSULE: ReadonlySet<string> = new Set([
  "syncing_source",
  "compiling_install",
  "analyzing_compatibility",
]);

/**
 * Phases in which a lease holder (a reconcile, or a confirming request) may
 * be creating or planning on this attempt's Capsule.
 */
const LEASABLE_CAPSULE_PHASES: ReadonlySet<string> = new Set([
  "creating_capsule",
  "planning",
  "awaiting_input",
]);

/** The deterministic or recorded Capsule this attempt may have created. */
function attemptCapsuleCandidate(plan: StoredGitInstallPlan): string | undefined {
  if (plan.capsuleId) return plan.capsuleId;
  if (INITIAL_PHASES_WITHOUT_CAPSULE.has(plan.phase)) return undefined;
  if (plan.phase === "awaiting_input" && plan.creationAttempted !== true) {
    return undefined;
  }
  return deterministicInitialCapsuleId(plan.id);
}

type AbandonCheck =
  | { readonly ok: true; readonly capsule?: Capsule; readonly authority?: WorkspaceManagementAuthority }
  | Extract<DiscardResult, { ok: false }>;

/** Read-only: whether the Capsule can be abandoned, without abandoning it. */
async function checkAbandonableCapsule(
  ctx: ControlDispatchContext,
  plan: StoredGitInstallPlan,
  capsuleId: string | undefined,
): Promise<AbandonCheck> {
  try {
    const capsule = capsuleId
      ? await getCapsuleIfPresent(ctx.operations, capsuleId)
      : undefined;
    if (!capsule) return { ok: true };
    if (
      capsule.workspaceId !== plan.workspaceId ||
      capsule.installingPrincipalId !== plan.createdBy ||
      (plan.sourceId !== undefined && capsule.sourceId !== plan.sourceId)
    ) {
      return {
        ok: false,
        status: 409,
        code: "capsule_identity_conflict",
        message: "The Capsule does not belong to this install attempt.",
      };
    }
    if (capsule.status === "destroyed") return { ok: true, capsule };
    if (capsuleHasAppliedState(capsule)) {
      return {
        ok: false,
        status: 409,
        code: "install_attempt_applied",
        message:
          "This app was already installed; uninstall it from its app page instead.",
      };
    }
    return {
      ok: true,
      capsule,
      authority: await ctx.operations.workspaces.captureManagementAuthority(
        plan.workspaceId,
      ),
    };
  } catch (error) {
    const refusal = abandonRefusal(error);
    if (refusal) return refusal;
    throw error;
  }
}

function abandonRefusal(
  error: unknown,
): Extract<DiscardResult, { ok: false }> | undefined {
  if (
    !(error instanceof OpenTofuControllerError) &&
    !(error instanceof WorkspaceManagementAdmissionConflictError)
  ) {
    return undefined;
  }
  const reason = error instanceof OpenTofuControllerError
    ? structuredErrorReason(error)
    : "workspace_management_admission_conflict";
  return {
    ok: false,
    status: 409,
    code: "install_attempt_discard_refused",
    message:
      "Takosumi could not abandon the app this attempt created; it may be installing now.",
    ...(reason && DIAGNOSTIC_TOKEN.test(reason) &&
        reason.length <= MAX_DIAGNOSTIC_REASON
      ? { reason }
      : {}),
  };
}

function casRefusal(
  status: "busy" | "conflict" | "not_found",
): Extract<DiscardResult, { ok: false }> {
  if (status === "not_found") {
    return { ok: false, status: 404, code: "not_found", message: "Install plan not found." };
  }
  return status === "busy"
    ? {
        ok: false,
        status: 409,
        code: "reconcile_in_progress",
        message: "Another reconciler currently owns this install plan; retry the discard.",
      }
    : {
        ok: false,
        status: 409,
        code: "install_plan_generation_conflict",
        message: "The install plan changed; read it and retry explicitly.",
      };
}

/**
 * Discards one install attempt on behalf of its creator. Nothing is ever
 * abandoned under a lease holder:
 *
 * 1. Read-only checks first; a refusal there writes nothing.
 * 2. Where a lease holder could be creating or planning on the Capsule, a
 *    lease-free CAS reserves the row by moving it to the terminal,
 *    non-claimable `failed` phase (`install_attempt_discard_incomplete`). A
 *    held lease or a newer generation refuses the reservation, and no later
 *    claim can start. If the discard then stops, the creator discards again.
 * 3. The never-applied Capsule is abandoned (which retires its binding slot
 *    and leaves its per-install InstallConfig as unreferenced history).
 * 4. One lease-free CAS records the terminal `discarded` phase and scrubs
 *    retained private inputs.
 *
 * Source retirement follows the committed terminal transition. A failed
 * cleanup is retried by a repeated discard or the scheduled sweeper.
 */
async function discardAttemptRecord(
  ctx: ControlDispatchContext,
  observed: StoredGitInstallPlan,
  diagnostic: GitInstallPlanDiagnostic,
): Promise<DiscardResult> {
  if (observed.phase === "discarded") {
    await retireAttemptSource(ctx, observed);
    return { ok: true, plan: observed };
  }
  const store = ctx.operations.gitInstallPlans;
  const capsuleId = attemptCapsuleCandidate(observed);
  let check = await checkAbandonableCapsule(ctx, observed, capsuleId);
  if (!check.ok) return check;
  let current = observed;
  if (capsuleId && LEASABLE_CAPSULE_PHASES.has(observed.phase)) {
    const reservedAt = new Date().toISOString();
    const {
      initialVariables: _initialVariables,
      transientVariableNames: _transientVariableNames,
      awaitingInput: _awaitingInput,
      expiresAt: _expiresAt,
      ...retained
    } = observed;
    const reserved = await store.transitionUnleased({
      id: observed.id,
      expectedGeneration: observed.generation,
      expectedPhase: observed.phase,
      plan: {
        ...retained,
        phase: "failed",
        generation: observed.generation + 1,
        diagnostic: boundedDiagnostic({
          code: "install_attempt_discard_incomplete",
          message: "Discarding this install attempt did not finish; discard it again.",
        }),
        updatedAt: reservedAt,
        completedAt: reservedAt,
      },
      at: reservedAt,
    });
    if (reserved.status !== "updated") return casRefusal(reserved.status);
    current = reserved.plan;
    // A crashed lease holder may have committed the Capsule after the first
    // read; the reserved row is stable now, so read it again.
    check = await checkAbandonableCapsule(ctx, current, capsuleId);
    if (!check.ok) return check;
  }
  if (check.capsule) {
    try {
      await ctx.operations.capsules.abandonUnappliedCapsule(
        check.capsule.id,
        "install attempt discarded before first successful apply",
        check.authority,
      );
    } catch (error) {
      const refusal = abandonRefusal(error);
      if (refusal) return refusal;
      throw error;
    }
  }
  const completedAt = new Date().toISOString();
  const {
    initialVariables: _initialVariables,
    transientVariableNames: _transientVariableNames,
    awaitingInput: _awaitingInput,
    expiresAt: _expiresAt,
    ...retained
  } = current;
  const result = await store.transitionUnleased({
    id: current.id,
    expectedGeneration: current.generation,
    expectedPhase: current.phase,
    plan: {
      ...retained,
      phase: "discarded",
      generation: current.generation + 1,
      diagnostic: boundedDiagnostic(diagnostic),
      updatedAt: completedAt,
      completedAt,
    },
    at: completedAt,
  });
  if (result.status !== "updated") return casRefusal(result.status);
  await retireAttemptSource(ctx, result.plan);
  return { ok: true, plan: result.plan };
}

/**
 * Retirement is best effort after terminal commit. The deterministic Source
 * id covers a crash between Source creation and plan progress persistence.
 */
async function retireAttemptSource(
  ctx: ControlDispatchContext,
  plan: StoredGitInstallPlan,
): Promise<void> {
  if (plan.mode !== "attempt") return;
  try {
    await ctx.operations.retireOwnedSource(
      deterministicInstallSourceId(plan.id),
      "install attempt discarded",
    );
  } catch (error) {
    console.warn("install_attempt.source_retirement_failed", {
      installPlanId: plan.id,
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }
}

function discardRefusal(
  ctx: ControlDispatchContext,
  result: Extract<DiscardResult, { ok: false }>,
): Response {
  return errorJson(
    result.code,
    result.message,
    result.status,
    ctx.request,
    {},
    result.reason ? { reason: result.reason } : undefined,
  );
}

/** DELETE /api/v1/install-plans/:id — the creator discards an attempt. */
async function discardInstallAttempt(
  ctx: ControlDispatchContext,
  stored: StoredGitInstallPlan,
): Promise<Response> {
  if (stored.mode !== "attempt") {
    return errorJson(
      "install_plan_not_attempt",
      "Only install attempts can be discarded through this route.",
      409,
      ctx.request,
    );
  }
  if (stored.actorSubject !== ctx.session.subject) {
    return errorJson(
      "forbidden",
      "Only the member who started this install can discard it.",
      403,
      ctx.request,
    );
  }
  const expectedGeneration = await discardExpectedGeneration(ctx.request, ctx.url);
  if (expectedGeneration === undefined) {
    return errorJson(
      "invalid_request",
      "Discarding an install plan requires its exact expectedGeneration.",
      400,
      ctx.request,
    );
  }
  if (stored.phase === "discarded") {
    await retireAttemptSource(ctx, stored);
    return await installPlanJson(ctx, stored);
  }
  if (stored.generation !== expectedGeneration) {
    return generationConflict(ctx);
  }
  const result = await discardAttemptRecord(ctx, stored, {
    code: "install_attempt_discarded",
    message: "The install attempt was discarded.",
  });
  if (!result.ok) return discardRefusal(ctx, result);
  return await installPlanJson(ctx, result.plan);
}

async function discardExpectedGeneration(
  request: Request,
  url: URL,
): Promise<number | undefined> {
  const query = url.searchParams.get("expectedGeneration");
  const text = await request.text();
  if (text.trim() !== "") {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (
      query !== null || !isRecord(body) ||
      !hasOnlyKeys(body, ["expectedGeneration"])
    ) return undefined;
    return generationValue(body.expectedGeneration);
  }
  if (query === null || !/^(0|[1-9][0-9]{0,15})$/u.test(query)) return undefined;
  return generationValue(Number(query));
}

function generationValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function generationConflict(ctx: ControlDispatchContext): Response {
  return errorJson(
    "install_plan_generation_conflict",
    "The install plan changed; read it and answer again.",
    409,
    ctx.request,
  );
}

/**
 * The creator's write found the attempt can no longer advance: discard it
 * (cleanup belongs to this request) and answer with the standard envelope.
 */
async function discardInvalidAttempt(
  ctx: ControlDispatchContext,
  plan: StoredGitInstallPlan,
  invalidation: GitInstallPlanInvalidation,
  reason: string = invalidation,
): Promise<Response> {
  const discarded = await discardAttemptRecord(ctx, plan, {
    code: invalidation,
    message: INVALIDATION_MESSAGES[invalidation],
  });
  if (!discarded.ok) return discardRefusal(ctx, discarded);
  return errorJson(
    "install_attempt_invalid",
    INVALIDATION_MESSAGES[invalidation],
    409,
    ctx.request,
    {},
    { reason },
  );
}

/** PATCH /api/v1/install-plans/:id — answer an `awaiting_input` attempt. */
async function answerInstallAttempt(
  ctx: ControlDispatchContext,
  observed: StoredGitInstallPlan,
): Promise<Response> {
  if (observed.mode !== "attempt") {
    return errorJson(
      "install_plan_not_attempt",
      "Only install attempts accept answers.",
      409,
      ctx.request,
    );
  }
  if (observed.actorSubject !== ctx.session.subject) {
    return errorJson(
      "forbidden",
      "Only the member who started this install can answer it.",
      403,
      ctx.request,
    );
  }
  const body = await readJsonObject(ctx.request);
  const patch = body ? parsePatchRequest(body) : undefined;
  if (!patch) {
    return errorJson(
      "invalid_request",
      "The answer must contain expectedGeneration and only modulePath, capsuleName, providerBindings, interfaceLinks, observedInterfaces, continue, and variables (observedInterfaces and variables only with continue).",
      400,
      ctx.request,
    );
  }
  if (observed.generation !== patch.expectedGeneration) {
    return generationConflict(ctx);
  }
  if (observed.phase !== "awaiting_input") {
    return errorJson(
      "install_plan_not_awaiting_input",
      "This install plan is not waiting for an answer.",
      409,
      ctx.request,
    );
  }
  const invalidation = await attemptInvalidation(ctx, observed);
  if (invalidation) return await discardInvalidAttempt(ctx, observed, invalidation);
  const authority = observed.workspaceManagementAuthority!;
  const invalid = (code: string, message: string) =>
    errorJson(code, message, 400, ctx.request);
  if (
    observed.creationAttempted === true &&
    (!patch.continue || patch.modulePath !== undefined ||
      patch.capsuleName !== undefined || patch.providerBindings !== undefined ||
      patch.interfaceLinks !== undefined || patch.observedInterfaces !== undefined)
  ) {
    // The confirmed Capsule may already exist and will be adopted as it was
    // created; accepting new answers here would silently ignore them.
    return errorJson(
      "install_inputs_resubmission_only",
      "Only the same settings can be sent again now; discard the attempt to change anything else.",
      409,
      ctx.request,
    );
  }
  const now = new Date().toISOString();
  let next: StoredGitInstallPlan = {
    ...observed,
    generation: observed.generation + 1,
    updatedAt: now,
    // Once creation started a Capsule may exist; such an attempt never expires.
    ...(observed.creationAttempted === true ? {} : { expiresAt: attemptExpiry(now) }),
  };
  const currentModule = observed.attemptFacts?.inputs?.modulePath ??
    observed.installModulePath;
  if (
    patch.modulePath !== undefined &&
    (observed.awaitingInput === "module" || patch.modulePath !== currentModule)
  ) {
    if (patch.continue) {
      return invalid(
        "invalid_request",
        "Choosing a module restarts the analysis; continue after it finishes.",
      );
    }
    const snapshot = observed.sourceSnapshotId && observed.sourceId
      ? await sourceSnapshotById(ctx.operations, observed.sourceId, observed.sourceSnapshotId)
      : undefined;
    const selection = resolveRepoOwnedInstallModulePath({
      sourceSnapshot: snapshot,
      modulePath: patch.modulePath,
    });
    if (!selection.ok) {
      return invalid("install_module_unavailable", selection.diagnostic.message);
    }
    const {
      installConfigBaseId: _baseId,
      installConfigBaseDigest: _baseDigest,
      installModulePath: _modulePath,
      compatibilityRequestDigest: _requestDigest,
      compatibilityCheckRunId: _checkRunId,
      compatibilityReportId: _reportId,
      installConfigId: _installConfigId,
      attemptFacts: _facts,
      awaitingInput: _awaiting,
      diagnostic: _diagnostic,
      ...rest
    } = next;
    // Connection answers name module-bound provider identities.
    const {
      providerBindings: _bindings,
      interfaceLinks: _interfaceLinks,
      ...options
    } = next.options;
    next = {
      ...rest,
      options: { ...options, modulePath: selection.modulePath },
      phase: "compiling_install",
    };
  } else if (observed.awaitingInput === "module" && patch.continue) {
    return errorJson(
      "install_module_required",
      "Choose one module before continuing.",
      409,
      ctx.request,
    );
  }
  if (patch.capsuleName !== undefined) {
    next = { ...next, capsule: { ...next.capsule, name: patch.capsuleName } };
  }
  if (patch.providerBindings !== undefined) {
    const facts = next.attemptFacts?.inputs;
    if (
      next.phase !== "awaiting_input" || next.awaitingInput !== "inputs" ||
      !facts ||
      patch.providerBindings.some((binding) =>
        !bindingMatchesRequirement(facts, binding)
      )
    ) {
      return invalid(
        "provider_binding_invalid",
        "Each connection answer must repeat one exact provider requirement of the analyzed module.",
      );
    }
    next = {
      ...next,
      options: { ...next.options, providerBindings: patch.providerBindings },
    };
  }
  if (patch.interfaceLinks !== undefined) {
    const requirements = next.attemptFacts?.inputs?.requiredInterfaces;
    if (
      next.phase !== "awaiting_input" || next.awaitingInput !== "inputs" ||
      patch.interfaceLinks.some((answer) =>
        !requirements?.some((requirement) => requirement.key === answer.requirementKey)
      )
    ) {
      return invalid(
        "interface_link_invalid",
        "Each Interface answer must name one requirement of the analyzed module.",
      );
    }
    next = {
      ...next,
      options: { ...next.options, interfaceLinks: patch.interfaceLinks },
      autoSelectedInterfaceKeys: undefined,
    };
  }
  if (patch.continue) {
    return await continueInstallAttempt(ctx, observed, next, patch.variables ?? {}, patch.observedInterfaces ?? []);
  }
  if (next.phase === "awaiting_input" && next.diagnostic?.code !== undefined &&
    ATTEMPT_INPUT_DIAGNOSTICS.has(next.diagnostic.code)) {
    // A new answer supersedes the previous refusal.
    next = { ...next, diagnostic: undefined };
  }
  let result;
  try {
    result = await ctx.operations.gitInstallPlans.transitionUnleased({
      id: observed.id,
      expectedGeneration: observed.generation,
      expectedPhase: observed.phase,
      plan: next,
      at: next.updatedAt,
      expectedWorkspaceManagementAuthority: authority,
    });
  } catch (error) {
    if (error instanceof WorkspaceManagementAdmissionConflictError) {
      return await discardInvalidAttempt(
        ctx,
        observed,
        "workspace_management_changed",
        "workspace_management_admission_conflict",
      );
    }
    throw error;
  }
  if (result.status === "not_found") {
    return errorJson("not_found", "Install plan not found.", 404);
  }
  if (result.status === "busy") {
    return errorJson(
      "reconcile_in_progress",
      "Another reconciler currently owns this install plan.",
      409,
      ctx.request,
    );
  }
  if (result.status === "conflict") return generationConflict(ctx);
  return await installPlanJson(ctx, result.plan);
}

/**
 * Confirms an `inputs` pause. Readiness is checked against live connections,
 * app names and the captured variable presentation before anything is
 * written; the claim then fences the record and the atomic creation receives
 * the request's variables directly. Values never reach the record.
 */
async function continueInstallAttempt(
  ctx: ControlDispatchContext,
  observed: StoredGitInstallPlan,
  answered: StoredGitInstallPlan,
  variables: Readonly<Record<string, JsonValue>>,
  observedInterfaces: NonNullable<PatchGitInstallPlanRequest["observedInterfaces"]>,
): Promise<Response> {
  if (observed.awaitingInput !== "inputs") {
    return errorJson(
      "install_inputs_not_ready",
      "This install attempt is not ready to continue.",
      409,
      ctx.request,
    );
  }
  let next = answered;
  const facts = next.attemptFacts?.inputs;
  if (observedInterfaces.some((entry) =>
    !facts?.requiredInterfaces?.some((requirement) => requirement.key === entry.requirementKey)
  )) {
    return errorJson(
      "invalid_request",
      "Each observed Interface must name one requirement of the analyzed module.",
      400,
      ctx.request,
      {},
      { reason: "interface_observation_invalid" },
    );
  }
  const resubmitting = observed.creationAttempted === true;
  // While resubmitting: the values of the unconfirmed request, nothing else.
  // The answers that request carried are recorded and may be committed.
  if (
    resubmitting &&
    JSON.stringify(observed.transientVariableNames ?? []) !==
      JSON.stringify(Object.keys(variables).sort())
  ) {
    return errorJson(
      "install_inputs_resubmission_only",
      "Send exactly the settings of the unconfirmed request again.",
      409,
      ctx.request,
      {},
      { reason: "install_variable_resubmission_mismatch" },
    );
  }
  const check = checkAttemptVariables(facts, variables);
  if (!check.ok) {
    return errorJson(
      "invalid_request",
      `The settings are incomplete or invalid: ${check.names.slice(0, 8).join(", ")}.`,
      400,
      ctx.request,
      {},
      { reason: check.reason },
    );
  }
  if (!resubmitting) {
    const [rows, interfaces] = await Promise.all([
      connectionRequirements(ctx.operations, next),
      interfaceRequirements(ctx.operations, next),
    ]);
    const changedObserved = observedInterfaces.some((entry) => {
      if (next.options.interfaceLinks?.some((answer) =>
        answer.requirementKey === entry.requirementKey
      )) return false;
      const row = interfaces.find((candidateRow) => candidateRow.requirementKey === entry.requirementKey);
      return !row || JSON.stringify(row.candidates.map((candidate) => candidate.id)) !==
        JSON.stringify(entry.candidateIds);
    });
    const changedUnobservedAutoSelection = facts?.autoInterfaceCandidates?.some((captured) => {
      if (next.options.interfaceLinks?.some((answer) =>
        answer.requirementKey === captured.requirementKey
      )) return false;
      const echoed = observedInterfaces.find((entry) => entry.requirementKey === captured.requirementKey);
      const expectedIds = echoed?.candidateIds ?? captured.candidateIds;
      const row = interfaces.find((candidateRow) => candidateRow.requirementKey === captured.requirementKey);
      return !row || JSON.stringify(row.candidates.map((candidate) => candidate.id)) !==
        JSON.stringify(expectedIds);
    });
    if (changedObserved || changedUnobservedAutoSelection) {
      return await refreshChangedInterfaceCandidates(ctx, observed, next, interfaces);
    }
    if (!connectionsReady(rows)) {
      return errorJson(
        "install_inputs_incomplete",
        "Choose a connection for every provider this app needs before continuing.",
        409,
        ctx.request,
        {},
        { reason: "provider_connection_required" },
      );
    }
    if (!interfacesReady(interfaces)) {
      const duplicate = duplicateSelectedInterface(interfaces);
      const unavailable = interfaces.some((row) => {
        const choice = row.choice;
        return choice?.kind === "interface" &&
          !row.candidates.some((candidate) => candidate.id === choice.interfaceId);
      });
      return errorJson(
        unavailable ? "interface_candidate_unavailable" : "install_inputs_incomplete",
        unavailable
          ? "A selected Interface provider is no longer available; choose another provider or configure it later."
          : duplicate
          ? "An Interface provider can serve only one requirement of this app; choose another provider or configure one later."
          : "Choose an Interface provider or configure it later before continuing.",
        409,
        ctx.request,
        {},
        { reason: unavailable ? "interface_candidate_unavailable" : "interface_choice_required" },
      );
    }
    const name = await nameProposal(ctx.operations, next);
    if (name.conflict) {
      return errorJson(
        "install_inputs_incomplete",
        "Another app here already uses this name; choose a different name.",
        409,
        ctx.request,
        {},
        { reason: "capsule_name_conflict" },
      );
    }
    next = {
      ...next,
      options: {
        ...next.options,
        providerBindings: effectiveProviderBindings(rows),
        ...(interfaces.length > 0 || next.options.interfaceLinks !== undefined
          ? { interfaceLinks: effectiveInterfaceLinks(interfaces) }
          : {}),
      },
      ...(interfaces.length > 0
        ? {
            autoSelectedInterfaceKeys: interfaces.filter((row) =>
              !next.options.interfaceLinks?.some((answer) =>
                answer.requirementKey === row.requirementKey
              )
            ).map((row) => row.requirementKey),
          }
        : {}),
    };
  }
  const variableNames = Object.keys(variables).sort();
  const {
    awaitingInput: _awaitingInput,
    diagnostic: _diagnostic,
    transientVariableNames: _previousNames,
    // An attempt that is creating its Capsule never expires again.
    expiresAt: _expiresAt,
    ...rest
  } = next;
  next = {
    ...rest,
    phase: "creating_capsule",
    // Recorded with or without variables: from here a Capsule may exist.
    creationAttempted: true,
    ...(variableNames.length > 0 ? { transientVariableNames: variableNames } : {}),
  };
  const claimedAt = new Date();
  const leaseToken = `gipl_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  let result;
  try {
    result = await ctx.operations.gitInstallPlans.transitionUnleased({
      id: observed.id,
      expectedGeneration: observed.generation,
      expectedPhase: observed.phase,
      plan: { ...next, updatedAt: claimedAt.toISOString() },
      at: claimedAt.toISOString(),
      lease: {
        token: leaseToken,
        expiresAt: new Date(
          claimedAt.getTime() + GIT_INSTALL_PLAN_RECONCILE_LEASE_MS,
        ).toISOString(),
      },
      expectedWorkspaceManagementAuthority: observed.workspaceManagementAuthority!,
    });
  } catch (error) {
    if (error instanceof WorkspaceManagementAdmissionConflictError) {
      return await discardInvalidAttempt(
        ctx,
        observed,
        "workspace_management_changed",
        "workspace_management_admission_conflict",
      );
    }
    throw error;
  }
  if (result.status === "not_found") {
    return errorJson("not_found", "Install plan not found.", 404);
  }
  if (result.status === "busy") {
    return errorJson(
      "reconcile_in_progress",
      "Another reconciler currently owns this install plan.",
      409,
      ctx.request,
    );
  }
  if (result.status === "conflict") return generationConflict(ctx);
  return await runTransientCreation(ctx, result.plan, leaseToken, variables);
}

function autoInterfaceCandidateSnapshot(rows: readonly GitInstallPlanInterfaceRequirement[]) {
  return rows.map((row) => ({
    requirementKey: row.requirementKey,
    candidateIds: row.candidates.map((candidate) => candidate.id),
  }));
}

/** A changed automatic choice is acknowledged once, then the fresh sheet can proceed. */
async function refreshChangedInterfaceCandidates(
  ctx: ControlDispatchContext,
  observed: StoredGitInstallPlan,
  answered: StoredGitInstallPlan,
  rows: readonly GitInstallPlanInterfaceRequirement[],
): Promise<Response> {
  let result;
  try {
    result = await ctx.operations.gitInstallPlans.transitionUnleased({
      id: observed.id,
      expectedGeneration: observed.generation,
      expectedPhase: observed.phase,
      plan: {
        ...answered,
        attemptFacts: {
          ...answered.attemptFacts,
          inputs: {
            ...answered.attemptFacts!.inputs!,
            autoInterfaceCandidates: autoInterfaceCandidateSnapshot(rows),
          },
        },
      },
      at: answered.updatedAt,
      expectedWorkspaceManagementAuthority: observed.workspaceManagementAuthority!,
    });
  } catch (error) {
    if (error instanceof WorkspaceManagementAdmissionConflictError) {
      return await discardInvalidAttempt(ctx, observed, "workspace_management_changed");
    }
    throw error;
  }
  if (result.status === "not_found") return errorJson("not_found", "Install plan not found.", 404);
  if (result.status === "conflict") return generationConflict(ctx);
  if (result.status === "busy") {
    return errorJson("reconcile_in_progress", "Another reconciler currently owns this install plan.", 409, ctx.request);
  }
  return errorJson(
    "interface_candidate_unavailable",
    "An automatically selected Interface provider is no longer available; review the updated choices and continue again.",
    409,
    ctx.request,
    {},
    { reason: "interface_candidate_unavailable" },
  );
}

async function runTransientCreation(
  ctx: ControlDispatchContext,
  claimed: StoredGitInstallPlan,
  leaseToken: string,
  variables: Readonly<Record<string, JsonValue>>,
): Promise<Response> {
  let outcome: StoredGitInstallPlan;
  try {
    outcome = await createCapsule(claimed, ctx, variables);
  } catch (error) {
    outcome = error instanceof PermanentInstallPlanError
      ? failedPlan(claimed, error.diagnostic)
      // The outcome of the atomic creation is unknown. The values are gone
      // with this request, so the next attempt must bring them again; a
      // committed Capsule is adopted by its deterministic id first.
      : awaitingResubmission(claimed, retryableDiagnostic(claimed, error));
  }
  const completed = await ctx.operations.gitInstallPlans.completeReconcile({
    id: claimed.id,
    expectedGeneration: claimed.generation,
    leaseToken,
    plan: reopenUserFixableFailure(outcome),
  });
  if (completed.status === "not_found") {
    return errorJson("not_found", "Install plan not found.", 404);
  }
  if (completed.status === "conflict") {
    return errorJson(
      "reconcile_conflict",
      "The install plan advanced concurrently; read it and retry explicitly.",
      409,
      ctx.request,
    );
  }
  return await installPlanJson(ctx, completed.plan);
}

/** Diagnostics that reopen an attempt's sheet instead of failing it. */
const ATTEMPT_INPUT_DIAGNOSTICS: ReadonlySet<string> = new Set([
  "interface_candidate_unavailable",
  "provider_binding_invalid",
  "capsule_name_conflict",
  "generic_opentofu_variable_invalid",
  "generic_opentofu_required_variable_missing",
  "repository_install_ux_variable_value_unsupported",
  "repository_install_ux_variable_value_type_mismatch",
  "repository_install_ux_variable_value_missing",
  "install_inputs_resubmission_required",
]);

/** Validation failures happen before any commit, so the attempt may expire again. */
function reopenUserFixableFailure(plan: StoredGitInstallPlan): StoredGitInstallPlan {
  if (
    plan.mode !== "attempt" || plan.phase !== "failed" ||
    !plan.attemptFacts?.inputs ||
    !ATTEMPT_INPUT_DIAGNOSTICS.has(plan.diagnostic?.code ?? "")
  ) {
    return plan;
  }
  // These failures are pre-commit checks that run after the adoption probe in
  // the same lease, so they prove no Capsule exists: answers and expiry apply
  // again.
  const {
    completedAt: _completedAt,
    transientVariableNames: _names,
    creationAttempted: _creationAttempted,
    autoSelectedInterfaceKeys: _autoSelectedInterfaceKeys,
    ...rest
  } = plan;
  return {
    ...rest,
    options: {
      ...rest.options,
      ...(rest.options.interfaceLinks !== undefined
        ? {
            interfaceLinks: rest.options.interfaceLinks.filter((answer) =>
              !plan.autoSelectedInterfaceKeys?.includes(answer.requirementKey)
            ),
          }
        : {}),
    },
    phase: "awaiting_input",
    awaitingInput: "inputs",
    expiresAt: attemptExpiry(plan.updatedAt),
  };
}

/**
 * Attempt mode only. The Capsule may already be committed, so this pause has
 * no expiry; the creator re-sends the values or discards the attempt.
 */
function awaitingResubmission(
  plan: StoredGitInstallPlan,
  cause: GitInstallPlanDiagnostic,
): StoredGitInstallPlan {
  const { expiresAt: _expiresAt, ...rest } = plan;
  return {
    ...rest,
    phase: "awaiting_input",
    awaitingInput: "inputs",
    diagnostic: boundedDiagnostic({
      code: "install_inputs_resubmission_required",
      message:
        "Takosumi could not confirm creating this app. Send the same settings again to continue.",
      ...(cause.controllerCode ? { controllerCode: cause.controllerCode } : {}),
      ...(cause.reason ? { reason: cause.reason } : {}),
    }),
    updatedAt: new Date().toISOString(),
  };
}

async function reconcileInstallPlan(
  ctx: ControlDispatchContext,
  observed: StoredGitInstallPlan,
): Promise<Response> {
  if (
    observed.phase === "reviewable" || observed.phase === "failed" ||
    observed.phase === "awaiting_input" || observed.phase === "discarded" ||
    // An expired attempt can no longer advance; only its creator discards it.
    attemptIsExpired(observed, Date.now())
  ) {
    return await installPlanJson(ctx, observed);
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
    leaseToken: `gipl_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    claimedAt: claimedAt.toISOString(),
    leaseExpiresAt: new Date(
      claimedAt.getTime() + GIT_INSTALL_PLAN_RECONCILE_LEASE_MS,
    ).toISOString(),
    expectedWorkspaceManagementAuthority,
  });
  if (claim.status !== "claimed") {
    if (claim.status === "not_found") {
      return errorJson("not_found", "Install plan not found.", 404);
    }
    return claim.status === "busy"
      ? errorJson(
          "reconcile_in_progress",
          "Another reconciler currently owns this install plan.",
          409,
          ctx.request,
        )
      : errorJson(
          "reconcile_conflict",
          "The install plan advanced concurrently; read it and retry explicitly.",
          409,
          ctx.request,
        );
  }
  const acquired = claim.claim;

  let outcome: AdvanceOutcome;
  try {
    outcome = await advanceInstallPlan(acquired.plan, ctx);
  } catch (error) {
    const permanentControllerDiagnostic =
      permanentInstallControllerDiagnostic(error);
    if (error instanceof PermanentInstallPlanError) {
      outcome = {
        plan: failedPlan(acquired.plan, error.diagnostic),
        retryable: false,
      };
    } else if (permanentControllerDiagnostic) {
      outcome = {
        plan: failedPlan(acquired.plan, permanentControllerDiagnostic),
        retryable: false,
      };
    } else {
      // A thrown canonical mutation may have committed before its acknowledgement
      // was lost. Release the lease without moving phase; the next explicit
      // reconcile first discovers canonical evidence before mutating again.
      outcome = {
        plan: withDiagnostic(
          acquired.plan,
          retryableDiagnostic(acquired.plan, error),
        ),
        retryable: true,
      };
    }
  }
  const settled = reopenUserFixableFailure(outcome.plan);
  const completed = await ctx.operations.gitInstallPlans.completeReconcile({
    id: observed.id,
    expectedGeneration: acquired.plan.generation,
    leaseToken: acquired.leaseToken,
    // Coordinator activity keeps an attempt alive before its Capsule exists;
    // only idleness expires it.
    plan: attemptCanExpire(settled) && settled.expiresAt !== undefined
      ? { ...settled, expiresAt: attemptExpiry(settled.updatedAt) }
      : settled,
  });
  if (completed.status === "not_found") {
    return errorJson("not_found", "Install plan not found.", 404);
  }
  if (completed.status === "conflict") {
    return errorJson(
      "reconcile_conflict",
      "The install plan advanced concurrently; read it and retry explicitly.",
      409,
      ctx.request,
    );
  }
  return await installPlanJson(ctx, completed.plan, outcome.retryable ? 202 : 200);
}

interface AdvanceOutcome {
  readonly plan: StoredGitInstallPlan;
  readonly retryable: boolean;
}

async function advanceInstallPlan(
  plan: StoredGitInstallPlan,
  ctx: ControlDispatchContext,
): Promise<AdvanceOutcome> {
  switch (plan.phase) {
    case "syncing_source":
      return {
        plan: await advanceSource(plan, ctx.operations),
        retryable: false,
      };
    case "compiling_install":
      return {
        plan: await prepareInstallCompilation(plan, ctx.operations),
        retryable: false,
      };
    case "analyzing_compatibility":
      return {
        plan: await analyzeAndCompileInstall(plan, ctx.operations),
        retryable: false,
      };
    case "creating_capsule":
      return { plan: await createCapsule(plan, ctx, undefined), retryable: false };
    case "planning":
      return {
        plan: await createOrObservePlanRun(plan, ctx.operations),
        retryable: false,
      };
    case "awaiting_input":
    case "reviewable":
    case "failed":
    case "discarded":
      return { plan, retryable: false };
  }
}

async function advanceSource(
  plan: StoredGitInstallPlan,
  operations: ControlPlaneOperations,
): Promise<StoredGitInstallPlan> {
  let sourceId = plan.sourceId;
  if (!sourceId) {
    sourceId = deterministicInstallSourceId(plan.id);
    const created = await operations.ensureOwnedSource({
      id: sourceId,
      workspaceId: plan.workspaceId,
      name: plan.source.name,
      ownerCapsuleId: deterministicInitialCapsuleId(plan.id),
      createdByInstallPlanId: plan.id,
      url: plan.source.url,
      ref: plan.source.ref,
      path: plan.source.path,
      ...(plan.source.authConnectionId
        ? { authConnectionId: plan.source.authConnectionId }
        : {}),
      createdAt: plan.createdAt,
    }, plan.workspaceManagementAuthority);
    assertInstallSourceMatchesPlan(created.source, plan, sourceId);
    return progressed(plan, {
      sourceId,
    });
  }

  const { source } = await operations.getSource(sourceId);
  if (!sourceMatchesPlan(source, plan) || source.status !== "active") {
    throw permanent(
      "source_identity_changed",
      "The canonical Source no longer matches this immutable install plan.",
    );
  }

  let sync: SourceSyncRun | undefined;
  if (plan.sourceSyncRunId) {
    sync = await operations.getSourceSyncRun(plan.sourceSyncRunId);
  } else {
    const evidence = await installSourceSyncEvidence(plan, sourceId);
    sync = (
      await operations.createSourceSync(
        sourceId,
        {
          intent: "manual_plan",
          dedupe: true,
          coordinator: {
            ref: plan.source.ref,
            path: plan.source.path,
            runId: evidence.runId,
            snapshotId: evidence.snapshotId,
          },
        },
        plan.workspaceManagementAuthority,
      )
    ).run;
  }
  return sourceSyncProgress(plan, sync, operations);
}

async function sourceSyncProgress(
  plan: StoredGitInstallPlan,
  sync: SourceSyncRun,
  operations: ControlPlaneOperations,
): Promise<StoredGitInstallPlan> {
  const sourceId = plan.sourceId!;
  const evidence = await installSourceSyncEvidence(plan, sourceId);
  const source = (await operations.getSource(sourceId)).source;
  if (!sourceMatchesPlan(source, plan) || source.status !== "active") {
    throw permanent(
      "source_identity_changed",
      "The canonical Source no longer matches this immutable install plan.",
    );
  }
  // Before app-owned Sources, an in-flight coordinator could persist the
  // random Source sync id returned by Core. Only that exact recorded id may
  // resume; an unrecorded sync still uses the plan's deterministic identity.
  const recordedLegacySync = isRecordedLegacySource(plan) &&
    plan.sourceSyncRunId !== undefined &&
    plan.sourceSyncRunId !== evidence.runId &&
    sync.id === plan.sourceSyncRunId;
  if (
    (!recordedLegacySync &&
      (sync.id !== evidence.runId ||
        (sync.requestedSnapshotId ?? sync.snapshotId) !== evidence.snapshotId)) ||
    sync.kind !== "source_sync" ||
    sync.workspaceId !== plan.workspaceId ||
    sync.sourceId !== sourceId ||
    sync.url !== source.url ||
    sync.ref !== plan.source.ref ||
    sync.path !== plan.source.path ||
    sync.intent !== "manual_plan"
  ) {
    throw permanent(
      "source_sync_identity_conflict",
      "The deterministic Source sync identity is bound to different install-plan evidence.",
    );
  }
  if (sync.status === "queued" || sync.status === "running") {
    return progressed(plan, { sourceSyncRunId: sync.id });
  }
  if (sync.status === "failed") {
    return failedPlan(plan, {
      code: "source_sync_failed",
      message: "The canonical Source sync failed before producing a snapshot.",
    });
  }
  if (!sync.snapshotId) {
    throw permanent(
      "source_snapshot_missing",
      "The successful Source sync did not identify a canonical snapshot.",
    );
  }
  const snapshot = await sourceSnapshotById(
    operations,
    sourceId,
    sync.snapshotId,
  );
  if (
    !snapshotMatchesPlan(snapshot, plan) ||
    !sync.resolvedCommit ||
    snapshot.resolvedCommit !== sync.resolvedCommit ||
    !sync.archiveDigest ||
    snapshot.archiveDigest !== sync.archiveDigest ||
    sync.archiveSizeBytes === undefined ||
    snapshot.archiveSizeBytes !== sync.archiveSizeBytes
  ) {
    throw permanent(
      "source_snapshot_scope_mismatch",
      "The Source snapshot does not match this immutable install plan.",
    );
  }
  return progressed(plan, {
    sourceSyncRunId: sync.id,
    sourceSnapshotId: snapshot.id,
    phase: "compiling_install",
  });
}

async function prepareInstallCompilation(
  plan: StoredGitInstallPlan,
  operations: ControlPlaneOperations,
): Promise<StoredGitInstallPlan> {
  const source = (await operations.getSource(plan.sourceId!)).source;
  const snapshot = await sourceSnapshotById(
    operations,
    source.id,
    plan.sourceSnapshotId!,
  );
  const base = await resolveStoreBaseInstallConfig(operations);
  if (!base.ok) {
    return failedPlan(plan, base.diagnostic);
  }
  const moduleSelection = resolveRepoOwnedInstallModulePath({
    sourceSnapshot: snapshot,
    modulePath: plan.options.modulePath,
  });
  if (!moduleSelection.ok) {
    const modules = moduleCandidates(snapshot);
    if (
      plan.mode === "attempt" && modules.length > 0 &&
      moduleSelection.diagnostic.code !== "repository_install_module_index_unavailable"
    ) {
      // Several roots, or a requested path the scan cannot prove: the actor
      // chooses one exact scanned module.
      return pauseForInput(plan, "module", { modules }, {
        ...(plan.options.modulePath !== undefined
          ? {
              diagnostic: boundedDiagnostic({
                code: moduleSelection.diagnostic.code,
                message: moduleSelection.diagnostic.message,
              }),
            }
          : {}),
      });
    }
    return failedPlan(plan, {
      code: moduleSelection.diagnostic.code,
      message: moduleSelection.diagnostic.message,
    });
  }

  const manifest = snapshot.repositoryManifest;
  if (!manifest || manifest.status === "absent" || manifest.status === "invalid") {
    const requiredManifestApiVersion =
      base.installConfig.policy?.repositoryInstallUx
        ?.requiredManifestApiVersion;
    if (requiredManifestApiVersion) {
      return failedPlan(plan, {
        code: "repository_install_ux_manifest_api_version_required",
        message:
          "The generic host policy requires a valid repository install manifest before this plan can continue.",
      });
    }
    // The repository manifest is optional assistance. A malformed optional
    // document disables that assistance, but the exact scanner-selected
    // OpenTofu root can still be installed through the generic host policy.
    // Even a plain Git repository must execute the exact scanner-selected
    // root; never let a missing InstallConfig.modulePath fall back to
    // Source.defaultPath.
    const installConfigBaseDigest = await stableJsonDigest(base.installConfig);
    const evidence = await installPlanCompatibilityEvidence({
      plan,
      source,
      snapshot,
      installConfigBaseId: base.installConfig.id,
      installConfigBaseDigest,
      modulePath: moduleSelection.modulePath,
      rootProviderRequirements: moduleSelection.rootProviderRequirements,
    });
    const compatibilityRequest: InstallPlanCompatibilityCheckRequest = {
      sourceSnapshotId: snapshot.id,
      modulePath: moduleSelection.modulePath,
      installConfigId: base.installConfig.id,
      installPlanIdentity: {
        runId: evidence.runId,
        reportId: evidence.reportId,
        createdBy: evidence.createdBy,
      },
    };
    const compatibility = await operations.createSourceCompatibilityCheck(
      source.id,
      compatibilityRequest,
      {
        kind: "captured",
        authority: plan.workspaceManagementAuthority ?? null,
      },
    );
    assertCompatibilityEvidenceMatches({
      compatibility,
      plan,
      source,
      snapshot,
      modulePath: moduleSelection.modulePath,
      evidence,
    });
    if (compatibility.run?.status !== "succeeded") {
      return failedPlan(plan, {
        code: "generic_opentofu_compatibility_analysis_failed",
        message:
          "The generic OpenTofu compatibility analysis did not complete successfully.",
      });
    }
    if (compatibility.report.level !== "ready") {
      return failedPlan(plan, {
        code: "generic_opentofu_compatibility_not_ready",
        message:
          "The generic OpenTofu compatibility analysis is not ready for installation.",
      });
    }
    const declarations = compatibility.report.rootModuleVariableDeclarations;
    if (declarations === undefined) {
      return failedPlan(plan, {
        code: "generic_opentofu_variable_declarations_missing",
        message:
          "The generic OpenTofu compatibility analysis did not return variable declarations.",
      });
    }
    if (!declarationsAreCanonical(declarations)) {
      return failedPlan(plan, {
        code: "generic_opentofu_variable_declarations_invalid",
        message:
          "The generic OpenTofu compatibility analysis returned non-canonical variable declarations.",
      });
    }
    const genericVariableContractDigest =
      await genericOpenTofuVariableContractDigest({
        declarations,
        modulePath: moduleSelection.modulePath,
      });
    const installConfig = await materializeSelectedModuleInstallConfig({
      operations,
      plan,
      source,
      snapshot,
      baseConfig: base.installConfig,
      modulePath: moduleSelection.modulePath,
      rootProviderRequirements: moduleSelection.rootProviderRequirements,
      genericVariableContractDigest,
    });
    if (!installConfig.ok) {
      return failedPlan(plan, installConfig.diagnostic);
    }
    const analyzed = {
      installConfigId: installConfig.installConfig.id,
      installConfigBaseId: base.installConfig.id,
      installConfigBaseDigest,
      installModulePath: moduleSelection.modulePath,
      compatibilityRequestDigest: evidence.requestDigest,
      compatibilityCheckRunId: evidence.runId,
      compatibilityReportId: evidence.reportId,
    };
    if (plan.mode === "attempt") {
      const facts = attemptInputFacts({
        modulePath: moduleSelection.modulePath,
        report: compatibility.report,
        installConfig: installConfig.installConfig,
        baseConfig: base.installConfig,
        repositoryManifest: false,
      });
      if (!facts.ok) return failedPlan(plan, facts);
      return await pauseForAttemptInputs(
        progressed(plan, analyzed),
        operations,
        facts.facts,
      );
    }
    return progressed(plan, { ...analyzed, phase: "creating_capsule" });
  }
  const installConfigBaseDigest = await stableJsonDigest(base.installConfig);
  const evidence = await installPlanCompatibilityEvidence({
    plan,
    source,
    snapshot,
    installConfigBaseId: base.installConfig.id,
    installConfigBaseDigest,
    modulePath: moduleSelection.modulePath,
    rootProviderRequirements: moduleSelection.rootProviderRequirements,
  });
  // Persist the full exact analysis identity before invoking the read-only
  // runner. A committed Run/report followed by a lost acknowledgement can then
  // be recovered by direct id, without a paginated or semantic-near-match scan.
  return progressed(plan, {
    installConfigBaseId: base.installConfig.id,
    installConfigBaseDigest,
    installModulePath: moduleSelection.modulePath,
    compatibilityRequestDigest: evidence.requestDigest,
    compatibilityCheckRunId: evidence.runId,
    compatibilityReportId: evidence.reportId,
    phase: "analyzing_compatibility",
  });
}

async function analyzeAndCompileInstall(
  plan: StoredGitInstallPlan,
  operations: ControlPlaneOperations,
): Promise<StoredGitInstallPlan> {
  const source = (await operations.getSource(plan.sourceId!)).source;
  const snapshot = await sourceSnapshotById(
    operations,
    source.id,
    plan.sourceSnapshotId!,
  );
  const base = await resolveStoreBaseInstallConfig(operations);
  if (!base.ok) return failedPlan(plan, base.diagnostic);
  const manifest = snapshot.repositoryManifest;
  if (!manifest || manifest.status !== "present") {
    throw permanent(
      "install_compilation_identity_changed",
      "The pinned repository source metadata changed after compilation was prepared.",
    );
  }
  const moduleSelection = resolveRepoOwnedInstallModulePath({
    sourceSnapshot: snapshot,
    modulePath: plan.options.modulePath,
  });
  if (!moduleSelection.ok) {
    return failedPlan(plan, moduleSelection.diagnostic);
  }
  const installConfigBaseDigest = await stableJsonDigest(base.installConfig);
  const evidence = await installPlanCompatibilityEvidence({
    plan,
    source,
    snapshot,
    installConfigBaseId: base.installConfig.id,
    installConfigBaseDigest,
    modulePath: moduleSelection.modulePath,
    rootProviderRequirements: moduleSelection.rootProviderRequirements,
  });
  if (
    plan.installConfigBaseId !== base.installConfig.id ||
    plan.installConfigBaseDigest !== installConfigBaseDigest ||
    plan.installModulePath !== moduleSelection.modulePath ||
    plan.compatibilityRequestDigest !== evidence.requestDigest ||
    plan.compatibilityCheckRunId !== evidence.runId ||
    plan.compatibilityReportId !== evidence.reportId
  ) {
    throw permanent(
      "install_compilation_identity_changed",
      "The generic host policy or repository module changed after compatibility analysis was prepared.",
    );
  }

  const compatibilityRequest: InstallPlanCompatibilityCheckRequest = {
    sourceSnapshotId: snapshot.id,
    modulePath: moduleSelection.modulePath,
    installConfigId: base.installConfig.id,
    installPlanIdentity: {
      runId: evidence.runId,
      reportId: evidence.reportId,
      createdBy: evidence.createdBy,
    },
  };
  const compatibility = await operations.createSourceCompatibilityCheck(
    source.id,
    compatibilityRequest,
    {
      kind: "captured",
      authority: plan.workspaceManagementAuthority ?? null,
    },
  );
  assertCompatibilityEvidenceMatches({
    compatibility,
    plan,
    source,
    snapshot,
    modulePath: moduleSelection.modulePath,
    evidence,
  });
  const preview = await previewRepoOwnedInstallConfig({
    operations,
    source,
    sourceSnapshot: snapshot,
    baseConfig: base.installConfig,
    modulePath: moduleSelection.modulePath,
    capsuleName: plan.capsule.name,
    workspaceId: plan.workspaceId,
    installingPrincipalId: plan.createdBy,
    compatibilityReport: compatibility.report,
    identityScope: plan.id,
    persist: false,
    // An attempt collects user values at its pause; analysis only proves the
    // manifest compiles for this exact snapshot.
    ...(plan.mode === "attempt" ? { requireReviewedValues: false } : {}),
  });
  if (preview.status === "invalid") {
    return failedPlan(plan, preview.diagnostic);
  }
  if (preview.status === "absent") {
    return failedPlan(plan, {
      code: "repository_install_manifest_unavailable",
      message: "The pinned repository install manifest could not be compiled.",
    });
  }
  if (plan.mode === "attempt") {
    if (compatibility.run?.status !== "succeeded" || compatibility.report.level !== "ready") {
      return failedPlan(plan, {
        code: "generic_opentofu_compatibility_not_ready",
        message:
          "The OpenTofu compatibility analysis is not ready for installation.",
      });
    }
    const facts = attemptInputFacts({
      modulePath: moduleSelection.modulePath,
      report: compatibility.report,
      installConfig: preview.installConfig,
      baseConfig: base.installConfig,
      repositoryManifest: true,
    });
    if (!facts.ok) return failedPlan(plan, facts);
    return await pauseForAttemptInputs(
      progressed(plan, { installConfigId: preview.installConfig.id }),
      operations,
      facts.facts,
    );
  }
  return progressed(plan, {
    installConfigId: preview.installConfig.id,
    phase: "creating_capsule",
  });
}

/** Persist one value-free auto-selection observation when entering the sheet. */
async function pauseForAttemptInputs(
  plan: StoredGitInstallPlan,
  operations: ControlPlaneOperations,
  facts: NonNullable<GitInstallAttemptFacts["inputs"]>,
): Promise<StoredGitInstallPlan> {
  const interfaces = await interfaceRequirements(operations, {
    ...plan,
    attemptFacts: { inputs: facts },
  });
  return pauseForInput(plan, "inputs", {
    inputs: {
      ...facts,
      ...(interfaces.length > 0
        ? { autoInterfaceCandidates: autoInterfaceCandidateSnapshot(interfaces) }
        : {}),
    },
  });
}

/** Enter `awaiting_input` with value-free facts; refreshes the expiry. */
function pauseForInput(
  plan: StoredGitInstallPlan,
  awaitingInput: "module" | "inputs",
  facts: GitInstallAttemptFacts,
  patch: Partial<StoredGitInstallPlan> = {},
): StoredGitInstallPlan {
  const paused = progressed(plan, {
    phase: "awaiting_input",
    awaitingInput,
    attemptFacts: facts,
  });
  return { ...paused, ...patch, expiresAt: attemptExpiry(paused.updatedAt) };
}

/**
 * Atomic initial creation. `transientVariables` are the reviewed values of
 * the request that started this step; they are passed straight into the
 * materialized InstallConfig and never written to the coordinator record.
 */
async function createCapsule(
  plan: StoredGitInstallPlan,
  ctx: ControlDispatchContext,
  transientVariables: Readonly<Record<string, JsonValue>> | undefined,
): Promise<StoredGitInstallPlan> {
  const operations = ctx.operations;
  if (
    plan.creationAttempted === true ||
    (plan.transientVariableNames?.length ?? 0) > 0
  ) {
    // A confirming request may have committed before its acknowledgement was
    // lost. Adopt that exact Capsule by its deterministic id before any
    // create; never re-create authority without the values it was created
    // with.
    const adopted = await adoptCommittedInitialCapsule(plan, ctx);
    if (adopted) return adopted;
    if (
      transientVariables === undefined &&
      (plan.transientVariableNames?.length ?? 0) > 0
    ) {
      return awaitingResubmission(plan, {
        code: "install_inputs_resubmission_required",
        message: "The reviewed values must be sent again.",
      });
    }
  }
  const reviewedVariables = transientVariables ?? plan.initialVariables;
  const source = (await operations.getSource(plan.sourceId!)).source;
  if (!sourceMatchesPlan(source, plan, true) || source.status !== "active") {
    throw permanent(
      "source_identity_changed",
      "The canonical Source no longer matches this immutable install plan.",
    );
  }
  const snapshot = await sourceSnapshotById(
    operations,
    source.id,
    plan.sourceSnapshotId!,
  );
  if (!snapshotMatchesPlan(snapshot, plan)) {
    throw permanent(
      "source_snapshot_scope_mismatch",
      "The SourceSnapshot no longer matches this immutable install plan.",
    );
  }
  const compatibility = await exactSuccessfulCompatibility(
    plan,
    operations,
    source,
    snapshot,
  );
  if (plan.mode === "attempt") {
    const name = await nameProposal(operations, plan);
    if (name.conflict) {
      return failedPlan(plan, {
        code: "capsule_name_conflict",
        message: "Another app here already uses this name; choose a different name.",
      });
    }
  }
  const materializedInstallConfig = plan.preflight
    ? await materializePreflightInitialInstallConfig({
        plan,
        operations,
        source,
        snapshot,
        compatibilityReport: compatibility.report,
        reviewedVariables: reviewedVariables ?? {},
      })
    : await materializeCoordinatorInitialInstallConfig({
        plan,
        operations,
        source,
        snapshot,
        compatibilityReport: compatibility.report,
        ...(reviewedVariables !== undefined ? { reviewedVariables } : {}),
      });
  const configuredInstallConfig = await applyInitialConfiguration(
    plan,
    materializedInstallConfig,
  );
  // The install-plan creation timestamp is part of the immutable coordinator
  // record. Re-materializing after an atomic commit acknowledgement is lost
  // must therefore reproduce the exact InstallConfig bytes accepted by the
  // create-only store CAS, rather than minting a new wall-clock timestamp.
  const installConfig: InstallConfig = {
    ...configuredInstallConfig,
    createdAt: plan.createdAt,
    updatedAt: plan.createdAt,
  };
  if ((plan.options.interfaceLinks?.length ?? 0) > 0) {
    const requirements = installConfig.requiredInterfaces ?? [];
    if (plan.options.interfaceLinks!.some((answer) =>
      !requirements.some((requirement) => requirement.key === answer.requirementKey)
    )) {
      return failedPlan(plan, {
        code: "interface_link_invalid",
        message: "An Interface choice no longer names a requirement of this app.",
      });
    }
    const interfaces = await interfaceRequirements(operations, plan, requirements);
    if (duplicateSelectedInterface(interfaces)) {
      return failedPlan(plan, {
        code: "interface_choice_conflict",
        message: "An Interface provider was selected for more than one requirement of this app.",
      });
    }
    if (interfaces.some((row) => {
      const choice = row.choice;
      return choice?.kind === "interface" &&
        !row.candidates.some((candidate) => candidate.id === choice.interfaceId);
    })) {
      return failedPlan(plan, {
        code: "interface_candidate_unavailable",
        message: "A selected Interface provider is no longer available; choose another provider or configure it later.",
      });
    }
  }
  const requestedBindings = requestedProviderBindings(plan);
  const resolved = await resolveProviderBindings(
    operations,
    plan.workspaceId,
    requestedBindings,
  );
  if (!resolved.ok) {
    return failedPlan(plan, {
      code: "provider_binding_invalid",
      message: "A referenced Provider Connection is unavailable to this Workspace.",
    });
  }
  const capsuleId = deterministicInitialCapsuleId(plan.id);
  const candidateCapsule: Capsule = {
    id: capsuleId,
    workspaceId: plan.workspaceId,
    projectId: defaultProjectId(plan.workspaceId),
    name: plan.capsule.name,
    slug: plan.capsule.name,
    environment: plan.capsule.environment,
    sourceId: source.id,
    installConfigId: installConfig.id,
    installingPrincipalId: plan.createdBy,
    currentStateGeneration: 0,
    status: "pending",
    createdAt: installConfig.createdAt,
    updatedAt: installConfig.updatedAt,
  };
  try {
    await operations.validateCapsuleConfigurationProviderBindings({
      capsule: candidateCapsule,
      installConfig,
      compatibilityReport: compatibility.report,
      providerBindings: resolved.bindings,
    });
  } catch (error) {
    if (error instanceof OpenTofuControllerError) {
      return failedPlan(plan, {
        code: "provider_binding_invalid",
        message:
          "The complete provider semantic preflight failed before initial authority was committed.",
        controllerCode: error.code,
        ...(structuredErrorReason(error)
          ? { reason: structuredErrorReason(error) }
          : {}),
      });
    }
    throw error;
  }
  const created = await operations.capsules.createCapsuleInitialAuthority({
    capsuleId,
    workspaceId: plan.workspaceId,
    name: plan.capsule.name,
    environment: plan.capsule.environment,
    sourceId: source.id,
    installingPrincipalId: plan.createdBy,
    expectedWorkspaceManagementAuthority: plan.workspaceManagementAuthority,
    installConfig,
    providerBindingSetId: deterministicInitialBindingSetId(plan.id),
    providerBindings: resolved.bindings,
  });
  const completedPlan = {
    ...plan,
    installConfigId: installConfig.id,
    capsuleId: created.capsule.id,
  };
  assertCapsuleMatches(created.capsule, completedPlan);
  return await finishInitialInterfaceLinks(completedPlan, ctx);
}

async function adoptCommittedInitialCapsule(
  plan: StoredGitInstallPlan,
  ctx: ControlDispatchContext,
): Promise<StoredGitInstallPlan | undefined> {
  const operations = ctx.operations;
  const capsule = await getCapsuleIfPresent(
    operations,
    deterministicInitialCapsuleId(plan.id),
  );
  if (!capsule) return undefined;
  const adopted = {
    ...plan,
    installConfigId: capsule.installConfigId,
    capsuleId: capsule.id,
  };
  assertCapsuleMatches(capsule, adopted);
  return await finishInitialInterfaceLinks(adopted, ctx);
}

/** A committed Capsule is adopted before repairing its exact frozen links. */
async function finishInitialInterfaceLinks(
  plan: StoredGitInstallPlan,
  ctx: ControlDispatchContext,
): Promise<StoredGitInstallPlan> {
  const operations = ctx.operations;
  const selections = (plan.options.interfaceLinks ?? []).flatMap((answer) =>
    answer.choice.kind === "interface"
      ? [{
          requirementKey: answer.requirementKey,
          interfaceId: answer.choice.interfaceId,
          selection: plan.autoSelectedInterfaceKeys?.includes(answer.requirementKey)
            ? "auto_single" as const
            : "explicit" as const,
        }]
      : []
  );
  if (selections.length > 0) {
    try {
      const config = await operations.capsules.getInstallConfig(plan.installConfigId!);
      if (!operations.interfaces?.ensureCapsuleInterfaceLinks) {
        throw new Error("Interface link service is unavailable");
      }
      await operations.interfaces.ensureCapsuleInterfaceLinks({
        workspaceId: plan.workspaceId,
        capsuleId: plan.capsuleId!,
        requirements: config.requiredInterfaces ?? [],
        selections,
      }, { actorAccountId: plan.createdBy, roles: [], requestId: plan.id }, {
        assertCurrent: async () => {
          const auth = await requireWorkspaceAccess({
            operations,
            store: ctx.store,
            session: ctx.session,
            workspaceId: plan.workspaceId,
          });
          if (!auth.ok) {
            throw new OpenTofuControllerError("permission_denied", "Interface link access is no longer available.");
          }
          const authority = await operations.workspaces.captureManagementAuthority(plan.workspaceId);
          if (authority.managementEpoch !== plan.workspaceManagementAuthority?.managementEpoch) {
            throw new OpenTofuControllerError("failed_precondition", "Interface link management authority changed.");
          }
          const current = await operations.gitInstallPlans.get(plan.id);
          if (
            !current || current.generation !== plan.generation ||
            current.phase !== "creating_capsule" ||
            Date.now() >= Date.parse(plan.updatedAt) + GIT_INSTALL_PLAN_RECONCILE_LEASE_MS
          ) {
            throw new OpenTofuControllerError("failed_precondition", "Interface link install lease is no longer current.");
          }
          return authority;
        },
      });
    } catch (error) {
      if (error instanceof InterfaceServiceError &&
        (error.code === "conflict" || error.code === "failed_precondition")) {
        return failedPlan(plan, {
          code: "interface_link_unavailable",
          message: "The selected Interface provider cannot be linked; choose another provider or configure it later.",
          controllerCode: error.code,
        });
      }
      // Initial authority is known committed. Keep it reconcileable without
      // asking for values that will never be used to recreate that Capsule.
      return progressed(plan, {
        phase: "creating_capsule",
        initialVariables: undefined,
        initialConfiguration: undefined,
        transientVariableNames: undefined,
        diagnostic: retryableDiagnostic(plan, error),
      });
    }
  }
  return progressed(plan, {
    initialVariables: undefined,
    initialConfiguration: undefined,
    transientVariableNames: undefined,
    phase: "planning",
  });
}

async function exactSuccessfulCompatibility(
  plan: StoredGitInstallPlan,
  operations: ControlPlaneOperations,
  source: Source,
  snapshot: SourceSnapshot,
): Promise<CapsuleCompatibilityReportResponse> {
  if (!plan.compatibilityCheckRunId || !plan.compatibilityReportId) {
    throw permanent(
      "compatibility_evidence_missing",
      "The install plan has no exact compatibility declaration.",
    );
  }
  const [response, run] = await Promise.all([
    operations.getCompatibilityReport(plan.compatibilityReportId),
    operations.getRun(plan.compatibilityCheckRunId),
  ]);
  const report = response.report;
  if (
    run.id !== plan.compatibilityCheckRunId ||
    run.type !== "compatibility_check" ||
    run.status !== "succeeded" ||
    run.workspaceId !== plan.workspaceId ||
    run.sourceId !== source.id ||
    run.sourceSnapshotId !== snapshot.id ||
    run.compatibilityReportId !== report.id ||
    report.id !== plan.compatibilityReportId ||
    report.sourceId !== source.id ||
    report.sourceSnapshotId !== snapshot.id ||
    report.capsuleId !== undefined ||
    report.level !== "ready" ||
    normalizeCompatibilityReportModulePath(report.modulePath) !==
      normalizeCompatibilityReportModulePath(
        plan.installModulePath ?? plan.options.modulePath,
      )
  ) {
    throw permanent(
      "compatibility_evidence_identity_conflict",
      "The compatibility declaration is not a successful exact preflight for this install.",
    );
  }
  return { ...response, run };
}

async function materializePreflightInitialInstallConfig(input: {
  readonly plan: StoredGitInstallPlan;
  readonly operations: ControlPlaneOperations;
  readonly source: Source;
  readonly snapshot: SourceSnapshot;
  readonly compatibilityReport: CapsuleCompatibilityReportResponse["report"];
  readonly reviewedVariables: Readonly<Record<string, JsonValue>>;
}): Promise<InstallConfig> {
  if (
    !input.plan.preflightInstallConfigDigest ||
    !input.plan.installConfigBaseId ||
    !input.plan.installConfigBaseDigest
  ) {
    throw permanent(
      "install_preflight_config_authority_missing",
      "The install plan did not pin its reviewed InstallConfig authority.",
    );
  }
  const [reviewed, baseConfig] = await Promise.all([
    input.operations.capsules.getInstallConfig(
      input.plan.preflight!.installConfigId,
    ),
    input.operations.capsules.getInstallConfig(
      input.plan.installConfigBaseId,
    ),
  ]);
  if (
    (reviewed.workspaceId !== undefined &&
      reviewed.workspaceId !== input.plan.workspaceId) ||
    (await stableJsonDigest(reviewed)) !==
      input.plan.preflightInstallConfigDigest ||
    (await stableJsonDigest(baseConfig)) !== input.plan.installConfigBaseDigest
  ) {
    throw permanent(
      "install_preflight_config_identity_changed",
      "The exact reviewed InstallConfig authority changed after preflight.",
    );
  }
  const selection = resolveRepoOwnedInstallModulePath({
    sourceSnapshot: input.snapshot,
    modulePath: input.plan.options.modulePath,
  });
  if (!selection.ok) {
    throw permanent(selection.diagnostic.code, selection.diagnostic.message);
  }
  const manifest = input.snapshot.repositoryManifest;
  if (manifest?.status === "present") {
    if (
      reviewed.internal?.sourceSnapshotId !== input.snapshot.id ||
      reviewed.internal.repositoryInstallUxDigest !== manifest.digest ||
      normalizeCompatibilityReportModulePath(reviewed.modulePath) !==
        normalizeCompatibilityReportModulePath(selection.modulePath)
    ) {
      throw permanent(
        "install_preflight_config_identity_changed",
        "The reviewed repository InstallConfig is not bound to the exact preflight snapshot.",
      );
    }
    const baseline = await previewRepoOwnedInstallConfig({
      operations: input.operations,
      source: input.source,
      sourceSnapshot: input.snapshot,
      baseConfig,
      modulePath: selection.modulePath,
      capsuleName: input.plan.capsule.name,
      workspaceId: input.plan.workspaceId,
      installingPrincipalId: input.plan.createdBy,
      compatibilityReport: input.compatibilityReport,
      persist: false,
    });
    if (
      baseline.status !== "accepted" ||
      (await stableJsonDigest(stripInstallConfigTimestamps(reviewed))) !==
        (await stableJsonDigest(
          stripInstallConfigTimestamps(baseline.installConfig),
        ))
    ) {
      throw permanent(
        "install_preflight_config_identity_changed",
        "The reviewed repository InstallConfig no longer matches its pinned base authority.",
      );
    }
    const preview = await previewRepoOwnedInstallConfig({
      operations: input.operations,
      source: input.source,
      sourceSnapshot: input.snapshot,
      baseConfig,
      modulePath: selection.modulePath,
      capsuleName: input.plan.capsule.name,
      workspaceId: input.plan.workspaceId,
      installingPrincipalId: input.plan.createdBy,
      compatibilityReport: input.compatibilityReport,
      reviewedVariables: input.reviewedVariables,
      requireReviewedValues: true,
      identityScope: input.plan.id,
      persist: false,
    });
    if (preview.status !== "accepted") {
      throw permanent(
        preview.status === "invalid"
          ? preview.diagnostic.code
          : "repository_install_manifest_unavailable",
        preview.status === "invalid"
          ? preview.diagnostic.message
          : "The exact repository install declaration is unavailable.",
      );
    }
    return preview.installConfig;
  }
  const declarations = input.compatibilityReport.rootModuleVariableDeclarations;
  if (!declarations || !declarationsAreCanonical(declarations)) {
    throw permanent(
      "generic_opentofu_variable_declarations_missing",
      "The successful compatibility declaration has no canonical variable contract.",
    );
  }
  assertReviewedVariablesMatchDeclarations(
    input.reviewedVariables,
    baseConfig.variableMapping,
    declarations,
  );
  if (reviewed.id !== baseConfig.id) {
    throw permanent(
      "install_preflight_config_identity_changed",
      "A generic install must pin the exact generic host base configuration.",
    );
  }
  const genericVariableContractDigest =
    await genericOpenTofuVariableContractDigest({
      declarations,
      modulePath: selection.modulePath,
    });
  const materialized = await materializeSelectedModuleInstallConfig({
    operations: input.operations,
    plan: input.plan,
    source: input.source,
    snapshot: input.snapshot,
    baseConfig,
    modulePath: selection.modulePath,
    rootProviderRequirements: selection.rootProviderRequirements,
    genericVariableContractDigest,
    reviewedVariables: input.reviewedVariables,
  });
  if (!materialized.ok) {
    throw permanent(materialized.diagnostic.code, materialized.diagnostic.message);
  }
  return materialized.installConfig;
}

function assertReviewedVariablesMatchDeclarations(
  reviewed: Readonly<Record<string, JsonValue>>,
  base: InstallConfig["variableMapping"],
  declarations: readonly CapsuleRootModuleVariableDeclaration[],
): void {
  const byName = new Map(declarations.map((item) => [item.name, item]));
  for (const [name, value] of Object.entries(reviewed)) {
    const declaration = byName.get(name);
    const typeMatches = declaration &&
      (declaration.type === "unknown" ||
        declaration.type === "json" ||
        (declaration.type === "string" && typeof value === "string") ||
        (declaration.type === "number" && typeof value === "number") ||
        (declaration.type === "boolean" && typeof value === "boolean"));
    if (!typeMatches) {
      throw permanent(
        "generic_opentofu_variable_invalid",
        "A reviewed variable is absent from or incompatible with the exact runner declaration.",
      );
    }
  }
  for (const declaration of declarations) {
    if (
      !declaration.hasDefault &&
      !Object.prototype.hasOwnProperty.call(reviewed, declaration.name) &&
      !Object.prototype.hasOwnProperty.call(base, declaration.name)
    ) {
      throw permanent(
        "generic_opentofu_required_variable_missing",
        "A required variable from the exact runner declaration was not reviewed.",
      );
    }
  }
}

async function materializeCoordinatorInitialInstallConfig(input: {
  readonly plan: StoredGitInstallPlan;
  readonly operations: ControlPlaneOperations;
  readonly source: Source;
  readonly snapshot: SourceSnapshot;
  readonly compatibilityReport: CapsuleCompatibilityReportResponse["report"];
  /** Attempt mode only: the confirming request's values. */
  readonly reviewedVariables?: Readonly<Record<string, JsonValue>>;
}): Promise<InstallConfig> {
  const base = await resolveStoreBaseInstallConfig(input.operations);
  if (!base.ok) throw permanent(base.diagnostic.code, base.diagnostic.message);
  const baseDigest = await stableJsonDigest(base.installConfig);
  const selection = resolveRepoOwnedInstallModulePath({
    sourceSnapshot: input.snapshot,
    modulePath: input.plan.options.modulePath,
  });
  if (!selection.ok) {
    throw permanent(selection.diagnostic.code, selection.diagnostic.message);
  }
  if (
    input.plan.installConfigBaseId !== base.installConfig.id ||
    input.plan.installConfigBaseDigest !== baseDigest ||
    normalizeCompatibilityReportModulePath(input.plan.installModulePath) !==
      normalizeCompatibilityReportModulePath(selection.modulePath)
  ) {
    throw permanent(
      "install_compilation_identity_changed",
      "The exact host policy or repository module changed after review preparation.",
    );
  }
  if (input.snapshot.repositoryManifest?.status === "present") {
    const preview = await previewRepoOwnedInstallConfig({
      operations: input.operations,
      source: input.source,
      sourceSnapshot: input.snapshot,
      baseConfig: base.installConfig,
      modulePath: selection.modulePath,
      capsuleName: input.plan.capsule.name,
      workspaceId: input.plan.workspaceId,
      installingPrincipalId: input.plan.createdBy,
      compatibilityReport: input.compatibilityReport,
      identityScope: input.plan.id,
      persist: false,
      ...(input.reviewedVariables !== undefined
        ? { reviewedVariables: input.reviewedVariables, requireReviewedValues: true }
        : {}),
    });
    if (preview.status !== "accepted") {
      throw permanent(
        preview.status === "invalid"
          ? preview.diagnostic.code
          : "repository_install_manifest_unavailable",
        preview.status === "invalid"
          ? preview.diagnostic.message
          : "The exact repository install declaration is unavailable.",
      );
    }
    return preview.installConfig;
  }
  const declarations = input.compatibilityReport.rootModuleVariableDeclarations;
  if (!declarations || !declarationsAreCanonical(declarations)) {
    throw permanent(
      "generic_opentofu_variable_declarations_missing",
      "The successful compatibility declaration has no canonical variable contract.",
    );
  }
  if (input.plan.mode === "attempt") {
    const reviewed = input.reviewedVariables ?? {};
    // Host-mapped values stay host-owned; an attempt never overrides them.
    if (
      Object.keys(reviewed).some((name) =>
        Object.prototype.hasOwnProperty.call(base.installConfig.variableMapping, name)
      )
    ) {
      throw permanent(
        "generic_opentofu_variable_invalid",
        "A reviewed variable is owned by the host configuration.",
      );
    }
    assertReviewedVariablesMatchDeclarations(
      reviewed,
      base.installConfig.variableMapping,
      declarations,
    );
  }
  const genericVariableContractDigest =
    await genericOpenTofuVariableContractDigest({
      declarations,
      modulePath: selection.modulePath,
    });
  const materialized = await materializeSelectedModuleInstallConfig({
    operations: input.operations,
    plan: input.plan,
    source: input.source,
    snapshot: input.snapshot,
    baseConfig: base.installConfig,
    modulePath: selection.modulePath,
    rootProviderRequirements: selection.rootProviderRequirements,
    genericVariableContractDigest,
    ...(input.reviewedVariables !== undefined
      ? { reviewedVariables: input.reviewedVariables }
      : {}),
  });
  if (!materialized.ok) {
    throw permanent(materialized.diagnostic.code, materialized.diagnostic.message);
  }
  return materialized.installConfig;
}

async function applyInitialConfiguration(
  plan: StoredGitInstallPlan,
  config: InstallConfig,
): Promise<InstallConfig> {
  const requested = plan.initialConfiguration;
  if (!requested) return config;
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...material
  } = config;
  const nextMaterial: Omit<InstallConfig, "id" | "createdAt" | "updatedAt"> = {
    ...material,
    ...(requested.runnerProfileId
      ? { runnerId: requested.runnerProfileId }
      : {}),
    ...(requested.outputAllowlist !== undefined
      ? { outputAllowlist: requested.outputAllowlist }
      : {}),
    ...(requested.interfaceBlueprints !== undefined
      ? {
          interfaceBlueprints:
            resolveCapsuleInterfaceBlueprintInstallingPrincipal(
              requested.interfaceBlueprints,
              plan.createdBy,
            ),
        }
      : {}),
    ...(requested.store !== undefined ? { store: requested.store } : {}),
    ...(requested.sourceBuild !== undefined
      ? { sourceBuild: requested.sourceBuild }
      : {}),
  };
  const digest = await stableJsonDigest({
    kind: "git_install_initial_configuration_v1",
    installPlanId: plan.id,
    sourceSnapshotId: plan.sourceSnapshotId,
    config: nextMaterial,
  });
  const now = new Date().toISOString();
  return {
    id: `icfg_${digest.replace(/^sha256:/u, "").slice(0, 16)}`,
    ...nextMaterial,
    createdAt: now,
    updatedAt: now,
  };
}

function deterministicInitialBindingSetId(planId: string): string {
  const suffix = planId.replace(/[^A-Za-z0-9]/gu, "").slice(-16);
  return `dpf_${suffix.padStart(16, "0")}`;
}

async function createOrObservePlanRun(
  plan: StoredGitInstallPlan,
  operations: ControlPlaneOperations,
): Promise<StoredGitInstallPlan> {
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
    const created = await operations.createCapsulePlan(plan.capsuleId!, {
      sourceSnapshotId: plan.sourceSnapshotId,
      planRunId: exactRunId,
      expectedWorkspaceManagementAuthority:
        plan.workspaceManagementAuthority,
      actor: installPlanRunActor(plan.id),
    });
    run = await operations.getRun(created.planRun.id);
  }
  assertRunMatches(run, plan, exactRunId);
  if (
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "expired"
  ) {
    return failedPlan(progressed(plan, { planRunId: run.id }), {
      code: "plan_run_failed",
      message: "The canonical Plan Run did not reach a reviewable state.",
    });
  }
  if (run.status === "succeeded" || run.status === "waiting_approval") {
    await enableInstallSourcePolling(plan, operations);
    return progressed(plan, {
      planRunId: run.id,
      phase: "reviewable",
      completedAt: new Date().toISOString(),
    });
  }
  return progressed(plan, { planRunId: run.id });
}

/**
 * The install-owned Source follows its Git ref once the app is reviewable.
 * Retirement closes the Source on a discarded attempt.
 */
async function enableInstallSourcePolling(
  plan: StoredGitInstallPlan,
  operations: ControlPlaneOperations,
): Promise<boolean> {
  const { source } = await operations.getSource(plan.sourceId!);
  // Never tune a Source whose ownership or immutable Git address changed.
  if (!sourceMatchesPlan(source, plan) || source.autoSync) return false;
  await operations.patchSource(source.id, { autoSync: true });
  return true;
}

function parseCreateRequest(
  body: Record<string, unknown>,
): CreateGitInstallPlanRequest | undefined {
  if (
    !hasOnlyKeys(body, [
      "source",
      "capsule",
      "options",
      "preflight",
      "variables",
      "initialConfiguration",
    ])
  ) return undefined;
  if (!isRecord(body.source) || !isRecord(body.capsule)) return undefined;
  if (
    !hasOnlyKeys(body.source, ["name", "url", "ref", "path", "authConnectionId"]) ||
    !hasOnlyKeys(body.capsule, ["name", "environment"])
  ) {
    return undefined;
  }
  const sourceName = boundedPlainString(body.source.name, 128);
  const rawUrl = boundedString(body.source.url, 2048);
  const ref = boundedPlainString(body.source.ref ?? "HEAD", 256);
  const rawPath = body.source.path ?? ".";
  const parsedPath = modulePathValue(rawPath);
  const capsuleName = boundedPlainString(body.capsule.name, 128);
  const environment = boundedPlainString(body.capsule.environment, 128);
  const authConnectionId = connectionReference(body.source.authConnectionId);
  if (
    !sourceName ||
    !rawUrl ||
    !ref ||
    parsedPath === undefined ||
    !capsuleName ||
    !/^[a-z0-9-]+$/u.test(capsuleName) ||
    !environment ||
    (body.source.authConnectionId !== undefined && !authConnectionId) ||
    !sourceUrlIsSafeToPersist(rawUrl)
  ) {
    return undefined;
  }
  const source: GitInstallPlanSourceRequest = {
    name: sourceName,
    url: normalizeInstallConfigSourceUrl(rawUrl),
    ref,
    path: parsedPath === "" ? "." : parsedPath,
    ...(authConnectionId ? { authConnectionId } : {}),
  };
  let options: NonNullable<CreateGitInstallPlanRequest["options"]> = {};
  if (body.options !== undefined) {
    if (!isRecord(body.options)) return undefined;
    if (
      !hasOnlyKeys(body.options, [
        "modulePath",
        "providerBindings",
        "interfaceLinks",
      ])
    ) {
      return undefined;
    }
    const rawModulePath = body.options.modulePath;
    const parsedModulePath =
      rawModulePath === undefined
        ? undefined
        : modulePathValue(rawModulePath);
    const modulePath =
      parsedModulePath === undefined
        ? undefined
        : parsedModulePath === ""
          ? "."
          : parsedModulePath;
    if (
      rawModulePath !== undefined &&
      (modulePath === undefined || rawModulePath !== modulePath)
    ) {
      return undefined;
    }
    const providerBindings = providerBindingRequests(
      body.options.providerBindings,
    );
    if (body.options.providerBindings !== undefined && !providerBindings) {
      return undefined;
    }
    const interfaceLinks = interfaceLinkRequests(body.options.interfaceLinks);
    if (body.options.interfaceLinks !== undefined && !interfaceLinks) return undefined;
    options = {
      ...(modulePath !== undefined ? { modulePath } : {}),
      ...(providerBindings !== undefined ? { providerBindings } : {}),
      ...(interfaceLinks !== undefined ? { interfaceLinks } : {}),
    };
  }
  let preflight: CreateGitInstallPlanRequest["preflight"];
  if (body.preflight !== undefined) {
    if (
      !isRecord(body.preflight) ||
      !hasOnlyKeys(body.preflight, [
        "sourceId",
        "sourceSnapshotId",
        "compatibilityCheckRunId",
        "compatibilityReportId",
        "installConfigId",
      ])
    ) {
      return undefined;
    }
    const sourceId = authorityId(body.preflight.sourceId, "src");
    const sourceSnapshotId = authorityId(
      body.preflight.sourceSnapshotId,
      "snap",
    );
    const compatibilityCheckRunId = authorityId(
      body.preflight.compatibilityCheckRunId,
      "ccr",
    );
    const compatibilityReportId = authorityId(
      body.preflight.compatibilityReportId,
      "caprep",
    );
    const installConfigId = authorityId(
      body.preflight.installConfigId,
      "(?:cfg|icfg)",
    );
    if (
      !sourceId ||
      !sourceSnapshotId ||
      !compatibilityCheckRunId ||
      !compatibilityReportId ||
      !installConfigId ||
      options.modulePath === undefined
    ) {
      return undefined;
    }
    preflight = {
      sourceId,
      sourceSnapshotId,
      compatibilityCheckRunId,
      compatibilityReportId,
      installConfigId,
    };
  }
  let variables: Readonly<Record<string, JsonValue>> | undefined;
  if (body.variables !== undefined) {
    variables = reviewedVariablesValue(body.variables);
    if (!variables) return undefined;
  }
  let initialConfiguration: CreateGitInstallPlanRequest["initialConfiguration"];
  if (body.initialConfiguration !== undefined) {
    if (
      !isRecord(body.initialConfiguration) ||
      !hasOnlyKeys(body.initialConfiguration, [
        "runnerProfileId",
        "outputAllowlist",
        "interfaceBlueprints",
        "store",
        "sourceBuild",
      ])
    ) {
      return undefined;
    }
    const runnerProfileId =
      body.initialConfiguration.runnerProfileId === undefined
        ? undefined
        : boundedPlainString(
            body.initialConfiguration.runnerProfileId,
            128,
          );
    const outputAllowlist = outputAllowlistValue(
      body.initialConfiguration.outputAllowlist,
    );
    const interfaceBlueprintsResult =
      body.initialConfiguration.interfaceBlueprints === undefined
        ? undefined
        : parseInterfaceBlueprintsValue(
            body.initialConfiguration.interfaceBlueprints,
          );
    const store = installConfigStoreValue(body.initialConfiguration.store);
    const sourceBuild = sourceBuildValue(
      body.initialConfiguration.sourceBuild,
    );
    if (
      (body.initialConfiguration.runnerProfileId !== undefined &&
        !runnerProfileId) ||
      (body.initialConfiguration.outputAllowlist !== undefined &&
        outputAllowlist === undefined) ||
      (interfaceBlueprintsResult !== undefined &&
        !interfaceBlueprintsResult.ok) ||
      (body.initialConfiguration.store !== undefined && store === undefined) ||
      (body.initialConfiguration.sourceBuild !== undefined &&
        sourceBuild === undefined)
    ) {
      return undefined;
    }
    initialConfiguration = {
      ...(runnerProfileId ? { runnerProfileId } : {}),
      ...(outputAllowlist !== undefined ? { outputAllowlist } : {}),
      ...(interfaceBlueprintsResult?.ok
        ? { interfaceBlueprints: interfaceBlueprintsResult.value }
        : {}),
      ...(store !== undefined ? { store } : {}),
      ...(sourceBuild !== undefined ? { sourceBuild } : {}),
    };
  }
  if (
    (variables !== undefined || initialConfiguration !== undefined) &&
    !preflight
  ) return undefined;
  return {
    source,
    capsule: {
      name: capsuleName,
      environment,
    },
    options,
    ...(preflight ? { preflight } : {}),
    ...(variables ? { variables } : {}),
    ...(initialConfiguration ? { initialConfiguration } : {}),
  };
}

/**
 * Normalized attempt request: every default is filled so the request digest
 * is the same whether a client omits a default or states it.
 */
function parseCreateAttemptRequest(
  body: Record<string, unknown>,
):
  | (CreateGitInstallAttemptRequest & {
      readonly source: GitInstallPlanSourceRequest;
      readonly capsule: StoredGitInstallPlan["capsule"];
      readonly options: StoredGitInstallPlan["options"];
    })
  | undefined {
  if (
    body.mode !== "attempt" ||
    !hasOnlyKeys(body, ["mode", "source", "capsule", "options"]) ||
    !isRecord(body.source) ||
    !hasOnlyKeys(body.source, ["name", "url", "ref", "path", "authConnectionId"]) ||
    (body.capsule !== undefined &&
      (!isRecord(body.capsule) ||
        !hasOnlyKeys(body.capsule, ["name", "environment"])))
  ) {
    return undefined;
  }
  const rawUrl = boundedString(body.source.url, 2048);
  if (!rawUrl || !sourceUrlIsSafeToPersist(rawUrl)) return undefined;
  const url = normalizeInstallConfigSourceUrl(rawUrl);
  const proposed = proposedAppName(url);
  const sourceName = body.source.name === undefined
    ? proposed
    : boundedPlainString(body.source.name, 128);
  const ref = boundedPlainString(body.source.ref ?? "HEAD", 256);
  const parsedPath = modulePathValue(body.source.path ?? ".");
  const authConnectionId = connectionReference(body.source.authConnectionId);
  const capsule = isRecord(body.capsule) ? body.capsule : {};
  const capsuleName = capsule.name === undefined
    ? proposed
    : boundedPlainString(capsule.name, 128);
  const environment = capsule.environment === undefined
    ? "production"
    : boundedPlainString(capsule.environment, 128);
  if (
    !sourceName || !ref || parsedPath === undefined || !capsuleName ||
    !/^[a-z0-9-]+$/u.test(capsuleName) || !environment ||
    (body.source.authConnectionId !== undefined && !authConnectionId)
  ) {
    return undefined;
  }
  const options = optionsValue(body.options);
  if (!options) return undefined;
  return {
    mode: "attempt",
    source: {
      name: sourceName,
      url,
      ref,
      path: parsedPath === "" ? "." : parsedPath,
      ...(authConnectionId ? { authConnectionId } : {}),
    },
    capsule: { name: capsuleName, environment },
    options,
  };
}

function optionsValue(
  value: unknown,
): NonNullable<CreateGitInstallPlanRequest["options"]> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value) || !hasOnlyKeys(value, ["modulePath", "providerBindings", "interfaceLinks"])) {
    return undefined;
  }
  const modulePath = canonicalModulePathAnswer(value.modulePath);
  if (value.modulePath !== undefined && modulePath === undefined) return undefined;
  const providerBindings = providerBindingRequests(value.providerBindings);
  if (value.providerBindings !== undefined && !providerBindings) return undefined;
  const interfaceLinks = interfaceLinkRequests(value.interfaceLinks);
  if (value.interfaceLinks !== undefined && !interfaceLinks) return undefined;
  return {
    ...(modulePath !== undefined ? { modulePath } : {}),
    ...(providerBindings !== undefined ? { providerBindings } : {}),
    ...(interfaceLinks !== undefined ? { interfaceLinks } : {}),
  };
}

/** A module path must already be in canonical spelling (`.` for the root). */
function canonicalModulePathAnswer(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const parsed = modulePathValue(value);
  const modulePath = parsed === undefined ? undefined : parsed === "" ? "." : parsed;
  return modulePath !== undefined && value === modulePath ? modulePath : undefined;
}

function parsePatchRequest(
  body: Record<string, unknown>,
): PatchGitInstallPlanRequest | undefined {
  if (
    !hasOnlyKeys(body, [
      "expectedGeneration",
      "modulePath",
      "capsuleName",
      "providerBindings",
      "interfaceLinks",
      "observedInterfaces",
      "variables",
      "continue",
    ])
  ) return undefined;
  const expectedGeneration = generationValue(body.expectedGeneration);
  if (expectedGeneration === undefined) return undefined;
  const modulePath = canonicalModulePathAnswer(body.modulePath);
  if (body.modulePath !== undefined && modulePath === undefined) return undefined;
  const capsuleName = body.capsuleName === undefined
    ? undefined
    : boundedPlainString(body.capsuleName, 128);
  if (
    body.capsuleName !== undefined &&
    (!capsuleName || !/^[a-z0-9-]+$/u.test(capsuleName))
  ) return undefined;
  const providerBindings = providerBindingRequests(body.providerBindings);
  if (body.providerBindings !== undefined && !providerBindings) return undefined;
  const interfaceLinks = interfaceLinkRequests(body.interfaceLinks);
  if (body.interfaceLinks !== undefined && !interfaceLinks) return undefined;
  const observedInterfaces = observedInterfaceRequests(body.observedInterfaces);
  if (body.observedInterfaces !== undefined &&
    (observedInterfaces === undefined || body.continue !== true)) return undefined;
  if (body.continue !== undefined && typeof body.continue !== "boolean") {
    return undefined;
  }
  const variables = body.variables === undefined
    ? undefined
    : reviewedVariablesValue(body.variables);
  if (body.variables !== undefined && (!variables || body.continue !== true)) {
    return undefined;
  }
  return {
    expectedGeneration,
    ...(modulePath !== undefined ? { modulePath } : {}),
    ...(capsuleName !== undefined ? { capsuleName } : {}),
    ...(providerBindings !== undefined ? { providerBindings } : {}),
    ...(interfaceLinks !== undefined ? { interfaceLinks } : {}),
    ...(observedInterfaces !== undefined ? { observedInterfaces } : {}),
    ...(variables !== undefined ? { variables } : {}),
    ...(body.continue === true ? { continue: true } : {}),
  };
}

/** Read observations only fence auto-selection; they are never stored or grant inputs. */
function observedInterfaceRequests(
  value: unknown,
): PatchGitInstallPlanRequest["observedInterfaces"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const keys = new Set<string>();
  const observations: NonNullable<PatchGitInstallPlanRequest["observedInterfaces"]>[number][] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["requirementKey", "candidateIds"])) return undefined;
    const requirementKey = boundedPlainString(entry.requirementKey, 128);
    if (!requirementKey || keys.has(requirementKey) || !Array.isArray(entry.candidateIds) ||
      entry.candidateIds.length > 100) return undefined;
    const candidateIds = entry.candidateIds.map((id) => boundedPlainString(id, 132));
    if (candidateIds.some((id) => !id) || new Set(candidateIds).size !== candidateIds.length) return undefined;
    keys.add(requirementKey);
    observations.push({ requirementKey, candidateIds: (candidateIds as string[]).sort() });
  }
  return observations;
}

/** Choices contain identities only; repository requirements own permissions. */
function interfaceLinkRequests(value: unknown): readonly GitInstallPlanInterfaceLinkRequest[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const keys = new Set<string>();
  const answers: GitInstallPlanInterfaceLinkRequest[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["requirementKey", "choice"])) return undefined;
    const requirementKey = boundedPlainString(entry.requirementKey, 128);
    if (!requirementKey || keys.has(requirementKey) || !isRecord(entry.choice)) return undefined;
    keys.add(requirementKey);
    if (entry.choice.kind === "later" && hasOnlyKeys(entry.choice, ["kind"])) {
      answers.push({ requirementKey, choice: { kind: "later" } });
    } else if (
      entry.choice.kind === "interface" &&
      hasOnlyKeys(entry.choice, ["kind", "interfaceId"])
    ) {
      const interfaceId = boundedPlainString(entry.choice.interfaceId, 132);
      if (!interfaceId) return undefined;
      answers.push({ requirementKey, choice: { kind: "interface", interfaceId } });
    } else return undefined;
  }
  return answers.sort((left, right) =>
    left.requirementKey < right.requirementKey ? -1 : left.requirementKey > right.requirementKey ? 1 : 0
  );
}

function reviewedVariablesValue(
  value: unknown,
): Readonly<Record<string, JsonValue>> | undefined {
  const parsed = jsonRecordValue(value);
  if (
    !parsed ||
    Object.keys(parsed).length > 256 ||
    Object.keys(parsed).some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) ||
    new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 256 * 1024
  ) {
    return undefined;
  }
  return parsed;
}

function authorityId(value: unknown, prefix: string): string | undefined {
  const candidate = boundedPlainString(value, 132);
  return candidate && new RegExp(`^${prefix}[-_][0-9A-Za-z-]{3,120}$`, "u")
      .test(candidate)
    ? candidate
    : undefined;
}

function sourceUrlIsSafeToPersist(value: string): boolean {
  if (!evaluateSourceUrl(value).ok) return false;
  if (/^https?:\/\//iu.test(value) || /^ssh:\/\//iu.test(value)) {
    try {
      const parsed = new URL(value);
      return (
        parsed.username.length === 0 ||
        (parsed.protocol === "ssh:" && parsed.username === "git")
      ) && parsed.password.length === 0 && !parsed.search && !parsed.hash;
    } catch {
      return false;
    }
  }
  return !value.includes("?") && !value.includes("#");
}

interface InstallPlanCompatibilityEvidence {
  readonly requestDigest: string;
  readonly runId: string;
  readonly reportId: string;
  readonly createdBy: string;
}

/**
 * Materialize the scanner-selected module for a plain Git install. Generic
 * InstallConfig rows intentionally do not carry a module path, so without a
 * scoped row Core would infer Source.defaultPath at Plan time. The generated
 * row is deterministic and strips Store/source-selector presentation fields.
 * When compatibility analysis produced a terminal runner variable contract,
 * the exact declaration digest and SourceSnapshot id are retained as
 * value-free provenance; no provider or variable values become authority.
 * This preparation never persists a partial row. The initial-authority
 * coordinator commits the config together with the Capsule and bindings.
 */
async function materializeSelectedModuleInstallConfig(input: {
  readonly operations: ControlPlaneOperations;
  readonly plan: StoredGitInstallPlan;
  readonly source: Source;
  readonly snapshot: SourceSnapshot;
  readonly baseConfig: InstallConfig;
  readonly modulePath: string;
  readonly rootProviderRequirements: readonly RepositoryModuleRootProviderRequirement[];
  /** Digest of the exact runner-discovered generic variable declarations. */
  readonly genericVariableContractDigest: string;
  readonly reviewedVariables?: InstallConfig["variableMapping"];
}): Promise<
  | { readonly ok: true; readonly installConfig: InstallConfig }
  | { readonly ok: false; readonly diagnostic: GitInstallPlanDiagnostic }
> {
  const baseModulePath = modulePathValue(input.baseConfig.modulePath);
  if (
    baseModulePath !== undefined &&
    (baseModulePath === "" ? "." : baseModulePath) === input.modulePath &&
    input.baseConfig.workspaceId === input.plan.workspaceId &&
    input.baseConfig.internal?.genericOpenTofuVariableContractDigest ===
      input.genericVariableContractDigest &&
    input.baseConfig.internal?.genericOpenTofuSourceSnapshotId ===
      input.snapshot.id
  ) {
    return { ok: true, installConfig: input.baseConfig };
  }
  const {
    id: _baseId,
    name: _baseName,
    workspaceId: _baseWorkspaceId,
    internal: _baseInternal,
    modulePath: _baseModulePath,
    sourceSelector: _baseSourceSelector,
    store: _baseStore,
    createdAt: _baseCreatedAt,
    updatedAt: _baseUpdatedAt,
    ...baseMaterial
  } = input.baseConfig;
  const installConfigMaterial: Omit<
    InstallConfig,
    "id" | "createdAt" | "updatedAt"
  > = {
    ...baseMaterial,
    workspaceId: input.plan.workspaceId,
    name: `${input.plan.capsule.name}-repository-install`,
    internal: {
      reason: "per_install_overrides",
      genericOpenTofuVariableContractDigest:
        input.genericVariableContractDigest,
      genericOpenTofuSourceSnapshotId: input.snapshot.id,
    },
    modulePath: input.modulePath,
    variableMapping: {
      ...baseMaterial.variableMapping,
      ...(input.reviewedVariables ?? {}),
    },
  };
  const digest = await stableJsonDigest({
    kind: "git-install-module-config-v1",
    initialAuthorityId: input.plan.id,
    sourceId: input.source.id,
    sourceSnapshotId: input.snapshot.id,
    baseInstallConfigId: input.baseConfig.id,
    installConfig: installConfigMaterial,
    rootProviderRequirements: input.rootProviderRequirements,
  });
  const id = `icfg_${digest.replace(/^sha256:/u, "").slice(0, 16)}`;
  const now = new Date().toISOString();
  const expected: InstallConfig = {
    id,
    ...installConfigMaterial,
    createdAt: now,
    updatedAt: now,
  };
  try {
    const existing = await input.operations.capsules.getInstallConfig(id);
    if (
      (await stableJsonDigest(stripInstallConfigTimestamps(existing))) !==
      (await stableJsonDigest(stripInstallConfigTimestamps(expected)))
    ) {
      return {
        ok: false,
        diagnostic: {
          code: "repository_install_module_config_identity_conflict",
          message:
            "The deterministic module InstallConfig identity conflicts with another configuration.",
        },
      };
    }
    return { ok: true, installConfig: existing };
  } catch (error) {
    if (
      !(error instanceof OpenTofuControllerError) ||
      error.code !== "not_found"
    ) {
      throw error;
    }
  }
  return { ok: true, installConfig: expected };
}

function stripInstallConfigTimestamps(
  config: InstallConfig,
): Omit<InstallConfig, "createdAt" | "updatedAt"> {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...material } = config;
  return material;
}

async function installPlanCompatibilityEvidence(input: {
  readonly plan: StoredGitInstallPlan;
  readonly source: Source;
  readonly snapshot: SourceSnapshot;
  readonly installConfigBaseId: string;
  readonly installConfigBaseDigest: string;
  readonly modulePath: string;
  readonly rootProviderRequirements: readonly RepositoryModuleRootProviderRequirement[];
}): Promise<InstallPlanCompatibilityEvidence> {
  const requestDigest = await stableJsonDigest({
    kind: "git_install_plan_compatibility_v1",
    installPlanId: input.plan.id,
    installPlanRequestDigest: input.plan.requestDigest,
    workspaceId: input.plan.workspaceId,
    sourceId: input.source.id,
    sourceSnapshotId: input.snapshot.id,
    installConfigBaseId: input.installConfigBaseId,
    installConfigBaseDigest: input.installConfigBaseDigest,
    modulePath: input.modulePath,
    rootProviderRequirements: input.rootProviderRequirements,
  });
  const suffix = requestDigest.replace(/^sha256:/u, "").slice(0, 16);
  return {
    requestDigest,
    runId: `ccr_${suffix}`,
    reportId: `caprep_${suffix}`,
    createdBy: `git-install-plan:${input.plan.id}:${suffix}`,
  };
}

function assertCompatibilityEvidenceMatches(input: {
  readonly compatibility: CapsuleCompatibilityReportResponse;
  readonly plan: StoredGitInstallPlan;
  readonly source: Source;
  readonly snapshot: SourceSnapshot;
  readonly modulePath: string;
  readonly evidence: InstallPlanCompatibilityEvidence;
}): void {
  const { report, run } = input.compatibility;
  if (
    report.id !== input.evidence.reportId ||
    report.sourceId !== input.source.id ||
    report.sourceSnapshotId !== input.snapshot.id ||
    report.capsuleId !== undefined ||
    normalizeCompatibilityReportModulePath(report.modulePath) !==
      normalizeCompatibilityReportModulePath(input.modulePath) ||
    !run ||
    run.id !== input.evidence.runId ||
    run.workspaceId !== input.plan.workspaceId ||
    run.sourceId !== input.source.id ||
    run.sourceSnapshotId !== input.snapshot.id ||
    run.type !== "compatibility_check" ||
    run.createdBy !== input.evidence.createdBy ||
    run.compatibilityReportId !== report.id ||
    (run.status !== "succeeded" && run.status !== "failed")
  ) {
    throw permanent(
      "compatibility_evidence_identity_conflict",
      "The deterministic compatibility Run or report is bound to different install evidence.",
    );
  }
}

async function sourceSnapshotById(
  operations: ControlPlaneOperations,
  sourceId: string,
  snapshotId: string,
): Promise<SourceSnapshot> {
  let snapshot: SourceSnapshot;
  try {
    snapshot = await operations.getSourceSnapshot(snapshotId);
  } catch (error) {
    if (!(error instanceof OpenTofuControllerError) || error.code !== "not_found") {
      throw error;
    }
    throw permanent(
      "source_snapshot_not_found",
      "The canonical Source snapshot is unavailable.",
    );
  }
  if (snapshot.sourceId !== sourceId) {
    throw permanent(
      "source_snapshot_scope_mismatch",
      "The canonical Source snapshot belongs to a different Source.",
    );
  }
  return snapshot;
}

function sourceMatchesPlan(
  source: Source,
  plan: StoredGitInstallPlan,
  allowUnclaimedPreflight = false,
): boolean {
  const recordedLegacySource = isRecordedLegacySource(plan);
  return (
    source.id === plan.sourceId &&
    source.workspaceId === plan.workspaceId &&
    (!recordedLegacySource || source.name === plan.source.name) &&
    (source.ownerCapsuleId === deterministicInitialCapsuleId(plan.id) ||
      (allowUnclaimedPreflight && plan.preflight !== undefined &&
        source.ownerCapsuleId === undefined) ||
      (recordedLegacySource && plan.capsuleId === undefined &&
        source.ownerCapsuleId === undefined)) &&
    normalizeInstallConfigSourceUrl(source.url) === plan.source.url &&
    source.defaultRef === plan.source.ref &&
    source.defaultPath === plan.source.path &&
    (source.authConnectionId ?? undefined) ===
      (plan.source.authConnectionId ?? undefined)
  );
}

/** A prior coordinator already persisted this random, name-scoped Source id. */
function isRecordedLegacySource(plan: StoredGitInstallPlan): boolean {
  return (plan.operation ?? "install") === "install" &&
    plan.preflight === undefined &&
    plan.sourceId !== undefined &&
    plan.sourceId !== deterministicInstallSourceId(plan.id);
}

function assertInstallSourceMatchesPlan(
  source: Source,
  plan: StoredGitInstallPlan,
  sourceId: string,
): void {
  if (
    source.id !== sourceId ||
    source.workspaceId !== plan.workspaceId ||
    source.ownerCapsuleId !== deterministicInitialCapsuleId(plan.id) ||
    normalizeInstallConfigSourceUrl(source.url) !== plan.source.url ||
    source.defaultRef !== plan.source.ref ||
    source.defaultPath !== plan.source.path ||
    (source.authConnectionId ?? undefined) !==
      (plan.source.authConnectionId ?? undefined)
  ) {
    throw permanent(
      "source_identity_conflict",
      "The deterministic Source id is bound to different install-plan ownership or Git address.",
    );
  }
}

async function assertLegacyPreflightSourceOwnership(
  plan: StoredGitInstallPlan,
  operations: ControlPlaneOperations,
): Promise<void> {
  const sourceId = plan.sourceId;
  if (!sourceId || !plan.preflight) {
    throw permanent(
      "install_preflight_source_missing",
      "The reviewed preflight has no Source identity.",
    );
  }
  const { source } = await operations.getSource(sourceId);
  const intendedCapsuleId = deterministicInitialCapsuleId(plan.id);
  if (
    source.id !== sourceId ||
    source.workspaceId !== plan.workspaceId ||
    normalizeInstallConfigSourceUrl(source.url) !== plan.source.url ||
    source.defaultRef !== plan.source.ref ||
    source.defaultPath !== plan.source.path ||
    (source.authConnectionId ?? undefined) !==
      (plan.source.authConnectionId ?? undefined)
  ) {
    throw permanent(
      "source_identity_changed",
      "The reviewed preflight Source no longer matches its immutable Git address.",
    );
  }
  if (
    source.ownerCapsuleId !== undefined &&
    source.ownerCapsuleId !== intendedCapsuleId
  ) {
    throw permanent(
      "source_owned_by_another_app",
      "The reviewed preflight Source already belongs to another app.",
    );
  }
}

interface InstallSourceSyncEvidence {
  readonly requestDigest: string;
  readonly runId: string;
  readonly snapshotId: string;
}

async function installSourceSyncEvidence(
  plan: StoredGitInstallPlan,
  sourceId: string,
): Promise<InstallSourceSyncEvidence> {
  const requestDigest = await stableJsonDigest({
    kind: "git_install_source_sync_v1",
    installPlanId: plan.id,
    installRequestDigest: plan.requestDigest,
    workspaceId: plan.workspaceId,
    capsuleId: deterministicInitialCapsuleId(plan.id),
    sourceId,
    url: plan.source.url,
    ref: plan.source.ref,
    path: plan.source.path,
    authConnectionId: plan.source.authConnectionId ?? null,
  });
  const suffix = requestDigest.replace(/^sha256:/u, "").slice(0, 16);
  return {
    requestDigest,
    runId: `ssr_${suffix}`,
    snapshotId: `snap_${suffix}`,
  };
}

function snapshotMatchesPlan(
  snapshot: SourceSnapshot,
  plan: StoredGitInstallPlan,
): boolean {
  return (
    snapshot.workspaceId === plan.workspaceId &&
    snapshot.sourceId === plan.sourceId &&
    normalizeInstallConfigSourceUrl(snapshot.url) === plan.source.url &&
    snapshot.ref === plan.source.ref &&
    snapshot.path === plan.source.path
  );
}

function capsuleMatchesPlan(
  capsule: Capsule,
  plan: StoredGitInstallPlan,
): boolean {
  return (
    capsule.workspaceId === plan.workspaceId &&
    capsule.name === plan.capsule.name &&
    capsule.environment === plan.capsule.environment &&
    capsule.sourceId === plan.sourceId &&
    capsule.installConfigId === plan.installConfigId &&
    capsule.installingPrincipalId === plan.createdBy &&
    capsule.status !== "destroyed"
  );
}

function assertCapsuleMatches(
  capsule: Capsule,
  plan: StoredGitInstallPlan,
): void {
  if (!capsuleMatchesPlan(capsule, plan)) {
    throw permanent(
      "capsule_identity_changed",
      "The canonical Capsule no longer matches this immutable install plan.",
    );
  }
}

function assertRunMatches(
  run: Run,
  plan: StoredGitInstallPlan,
  exactRunId: string,
): void {
  if (
    run.id !== exactRunId ||
    run.workspaceId !== plan.workspaceId ||
    run.capsuleId !== plan.capsuleId ||
    run.sourceSnapshotId !== plan.sourceSnapshotId ||
    run.type !== "plan" ||
    run.createdBy !== installPlanRunActor(plan.id)
  ) {
    throw permanent(
      "plan_run_identity_conflict",
      "The deterministic Plan Run identity is already bound to different canonical evidence.",
    );
  }
}

function requestedProviderBindings(
  plan: StoredGitInstallPlan,
): ProviderBindings {
  const requested = plan.options.providerBindings ?? [];
  return requested.map((binding) => ({
    provider: binding.provider,
    moduleLocalName: binding.moduleLocalName,
    ...(binding.childAlias !== undefined
      ? { childAlias: binding.childAlias }
      : {}),
    ...(binding.rootAlias !== undefined || binding.childAlias !== undefined
      ? { rootAlias: binding.rootAlias ?? binding.childAlias }
      : {}),
    connectionId: binding.connectionId,
  }));
}

function sameProviderBindings(
  left: ProviderBindings,
  right: ProviderBindings,
): boolean {
  const canonical = (bindings: ProviderBindings) =>
    bindings
      .map((binding) => ({
        provider: binding.provider,
        ...(binding.moduleLocalName !== undefined
          ? { moduleLocalName: binding.moduleLocalName }
          : {}),
        ...(binding.childAlias !== undefined
          ? { childAlias: binding.childAlias }
          : {}),
        ...(binding.rootAlias !== undefined
          ? { rootAlias: binding.rootAlias }
          : {}),
        connectionId: binding.connectionId,
      }))
      .sort(compareProviderBindingTuple);
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function progressed(
  plan: StoredGitInstallPlan,
  patch: Partial<StoredGitInstallPlan>,
): StoredGitInstallPlan {
  return {
    ...plan,
    ...patch,
    diagnostic: undefined,
    updatedAt: new Date().toISOString(),
  };
}

function withDiagnostic(
  plan: StoredGitInstallPlan,
  diagnostic: GitInstallPlanDiagnostic,
): StoredGitInstallPlan {
  return {
    ...plan,
    diagnostic: boundedDiagnostic(diagnostic),
    updatedAt: new Date().toISOString(),
  };
}

function failedPlan(
  plan: StoredGitInstallPlan,
  diagnostic: GitInstallPlanDiagnostic,
): StoredGitInstallPlan {
  const now = new Date().toISOString();
  // A terminal record never keeps legacy reviewed values.
  const {
    initialVariables: _initialVariables,
    transientVariableNames: _transientVariableNames,
    ...retained
  } = plan;
  return {
    ...retained,
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
    : "install_plan_failed";
  const message = diagnostic.message
    .replace(/[\r\n\0]/gu, " ")
    .slice(0, MAX_DIAGNOSTIC_MESSAGE);
  const controllerCode = boundedDiagnosticToken(
    diagnostic.controllerCode,
    MAX_DIAGNOSTIC_CODE,
  );
  const reason = boundedDiagnosticToken(
    diagnostic.reason,
    MAX_DIAGNOSTIC_REASON,
  );
  return {
    code: code.slice(0, MAX_DIAGNOSTIC_CODE),
    message:
      message || "Takosumi could not safely advance this install plan.",
    ...(diagnostic.planCreationStage === "source" ||
    diagnostic.planCreationStage === "preparation" ||
    diagnostic.planCreationStage === "create"
      ? { planCreationStage: diagnostic.planCreationStage }
      : {}),
    ...(controllerCode ? { controllerCode } : {}),
    ...(reason ? { reason } : {}),
  };
}

function retryableDiagnostic(
  plan: StoredGitInstallPlan,
  error: unknown,
): GitInstallPlanDiagnostic {
  const controllerCode =
    error instanceof OpenTofuControllerError ? error.code : undefined;
  const reason =
    error instanceof OpenTofuControllerError
      ? structuredErrorReason(error)
      : undefined;
  return {
    code: "install_plan_reconcile_retryable",
    message:
      "Takosumi could not confirm the last coordinator step. Reconcile again to recover canonical state.",
    planCreationStage: planCreationStage(plan.phase),
    ...(controllerCode ? { controllerCode } : {}),
    ...(reason ? { reason } : {}),
  };
}

function permanentInstallControllerDiagnostic(
  error: unknown,
): GitInstallPlanDiagnostic | undefined {
  switch (structuredErrorReason(error)) {
    case "source_identity_conflict":
      return {
        code: "source_identity_conflict",
        message:
          "The deterministic Source id is bound to different install-plan ownership or Git address.",
      };
    case "source_owned_by_another_app":
      return {
        code: "source_owned_by_another_app",
        message: "This Source already belongs to another app.",
      };
    case "source_sync_identity_conflict":
      return {
        code: "source_sync_identity_conflict",
        message:
          "The deterministic Source sync identity is bound to different install-plan evidence.",
      };
    default:
      return undefined;
  }
}

function planCreationStage(
  phase: StoredGitInstallPlan["phase"],
): NonNullable<GitInstallPlanDiagnostic["planCreationStage"]> {
  if (phase === "creating_capsule" || phase === "awaiting_input") {
    return "preparation";
  }
  if (phase === "syncing_source") return "source";
  if (phase === "planning" || phase === "reviewable") return "create";
  return "preparation";
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

class PermanentInstallPlanError extends Error {
  readonly diagnostic: GitInstallPlanDiagnostic;

  constructor(diagnostic: GitInstallPlanDiagnostic) {
    super(diagnostic.code);
    this.name = "PermanentInstallPlanError";
    this.diagnostic = boundedDiagnostic(diagnostic);
  }
}

function permanent(code: string, message: string): PermanentInstallPlanError {
  return new PermanentInstallPlanError({ code, message });
}

async function installPlanJson(
  ctx: ControlDispatchContext,
  stored: StoredGitInstallPlan,
  status = 200,
): Promise<Response> {
  return json(await installPlanResponseFor(ctx, stored), status, {
    "cache-control": "no-store",
  });
}

async function installPlanResponseFor(
  ctx: ControlDispatchContext,
  stored: StoredGitInstallPlan,
): Promise<GitInstallPlanResponse> {
  const invalidated = await attemptInvalidation(ctx, stored);
  const reviewSummary = stored.mode === "attempt" &&
      (stored.phase === "planning" || stored.phase === "reviewable") &&
      stored.capsuleId && stored.installConfigId
    ? await committedReviewSummary(ctx.operations, stored)
    : undefined;
  return installPlanResponse(
    publicGitInstallPlan(stored),
    invalidated
      ? { kind: "retry", code: invalidated, restart: true }
      : await userActionFor(ctx.operations, stored),
    invalidated,
    reviewSummary,
  );
}

async function committedReviewSummary(
  operations: ControlPlaneOperations,
  plan: StoredGitInstallPlan,
): Promise<GitInstallPlanResponse["reviewSummary"]> {
  const capsuleId = plan.capsuleId;
  const installConfigId = plan.installConfigId;
  if (!capsuleId || !installConfigId) return undefined;
  // Summary enrichment is optional. Its reads must never make the canonical
  // attempt GET unavailable or discard the independently available sections.
  const [installConfig, baseConfig, bindingSet, listed, capsule] = await Promise.all([
    optionalReviewRead(() => operations.capsules.getInstallConfig(installConfigId)),
    optionalReviewRead(() => plan.installConfigBaseId
      ? operations.capsules.getInstallConfig(plan.installConfigBaseId)
      : Promise.resolve(undefined)),
    optionalReviewRead(() => operations.capsules.getProviderBindingSetByCapsule(
      capsuleId, plan.capsule.environment,
    )),
    optionalReviewRead(() => operations.connections.listProviderConnections(plan.workspaceId)),
    optionalReviewRead(() => operations.capsules.getCapsule(capsuleId)),
  ]);
  const owner = capsule?.id === capsuleId && capsule.workspaceId === plan.workspaceId
    ? await reviewOwnerAccountId(operations, capsule)
    : undefined;
  const connections = (listed ?? []).filter((connection) => !connection.ownerAccountId);
  const known = new Set(connections.map((connection) => connection.id));
  const selectedIds = [...new Set((bindingSet?.bindings ?? []).map((binding) => binding.connectionId))];
  const selectedInterfaceIds = [...new Set((plan.options.interfaceLinks ?? [])
    .flatMap((link) => link.choice.kind === "interface" ? [link.choice.interfaceId] : []))];
  const [personal, interfaces] = await Promise.all([
    Promise.all(selectedIds.filter((id) => !known.has(id) && owner !== undefined).map((id) =>
      optionalReviewRead(async () => {
        // Read committed IDs only; never enumerate the owner's personal inventory.
        const connection = await operations.getConnection(id);
        return connection.id === id && connection.scope !== "operator" &&
            connection.ownerAccountId === owner
          ? connection
          : undefined;
      })
    )),
    Promise.all(selectedInterfaceIds.map((id) => optionalReviewRead(async () => {
      const value = await operations.interfaces?.get?.(id);
      return value?.metadata.id === id && value.metadata.workspaceId === plan.workspaceId
        ? value
        : undefined;
    }))),
  ]);
  if (personal.some((connection) => connection !== undefined)) {
    const current = await optionalReviewRead(() => operations.capsules.getCapsule(capsuleId));
    if (current?.id === capsuleId && current.workspaceId === plan.workspaceId &&
      current.ownershipEpoch === capsule?.ownershipEpoch &&
      await reviewOwnerAccountId(operations, current) === owner) {
      connections.push(...personal.flatMap((connection) => connection ? [connection] : []));
    }
  }
  return committedAttemptReviewSummary({
    plan, installConfig, baseConfig, bindingSet, connections,
    interfaces: interfaces.flatMap((value) => value ? [value] : []),
  });
}

/** Catch only optional presentation reads, never attempt admission or authority. */
async function optionalReviewRead<T>(read: () => Promise<T>): Promise<T | undefined> {
  try { return await read(); } catch { return undefined; }
}

async function reviewOwnerAccountId(
  operations: ControlPlaneOperations,
  capsule: Capsule,
): Promise<string | undefined> {
  if (capsule.ownerAccountId) return capsule.ownerAccountId;
  const workspace = await optionalReviewRead(() => operations.workspaces.getWorkspace(capsule.workspaceId));
  return workspace?.id === capsule.workspaceId ? workspace.ownerUserId : undefined;
}

function installPlanResponse(
  plan: GitInstallPlan,
  userAction: GitInstallPlanResponse["userAction"],
  invalidated: GitInstallPlanInvalidation | undefined,
  reviewSummary?: GitInstallPlanResponse["reviewSummary"],
): GitInstallPlanResponse {
  const self = `/api/v1/install-plans/${encodeURIComponent(plan.id)}`;
  const reconcileable = invalidated === undefined &&
    isReconcileableGitInstallPlanPhase(plan.phase);
  return {
    installPlan: plan,
    nextAction:
      plan.phase === "reviewable"
        ? "review_run"
        : reconcileable
          ? "reconcile"
          : "none",
    userAction,
    ...(invalidated ? { invalidated } : {}),
    ...(reviewSummary ? { reviewSummary } : {}),
    links: {
      self,
      ...(reconcileable ? { reconcile: `${self}/reconcile` } : {}),
      ...(plan.planRunId
        ? { run: `/api/v1/runs/${encodeURIComponent(plan.planRunId)}` }
        : {}),
    },
  };
}

function deterministicPlanRunId(planId: string): string {
  const suffix = planId.replace(/[^A-Za-z0-9]/gu, "").slice(-16);
  return `plan_${suffix.padStart(16, "0")}`;
}

function installPlanRunActor(planId: string): string {
  return `git-install-plan:${planId}`;
}

function installPlanId(): string {
  return `gip_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function idempotencyKey(raw: string | null): string | undefined {
  if (!raw || raw.trim() !== raw || /[\u0000-\u001f\u007f]/u.test(raw)) {
    return undefined;
  }
  return new TextEncoder().encode(raw).byteLength <= MAX_IDEMPOTENCY_KEY_BYTES
    ? raw
    : undefined;
}

function providerBindingRequests(
  value: unknown,
): readonly GitInstallPlanProviderBindingRequest[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_PROVIDER_BINDINGS) {
    return undefined;
  }
  const result: GitInstallPlanProviderBindingRequest[] = [];
  const identities = new Set<string>();
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, [
        "provider",
        "moduleLocalName",
        "childAlias",
        "rootAlias",
        "connectionId",
      ])
    ) {
      return undefined;
    }
    const provider = boundedPlainString(item.provider, 512);
    const moduleLocalName = boundedPlainString(item.moduleLocalName, 128);
    const childAlias =
      item.childAlias === undefined
        ? undefined
        : boundedPlainString(item.childAlias, 128);
    const connectionId = connectionReference(item.connectionId);
    const rootAlias =
      item.rootAlias === undefined
        ? undefined
        : boundedPlainString(item.rootAlias, 128);
    if (
      !provider ||
      item.provider !== provider ||
      !PROVIDER_SOURCE_PATTERN.test(provider) ||
      normalizeProviderSourceAddress(provider) !== provider ||
      isOpenTofuBuiltinProviderSource(provider) ||
      !moduleLocalName ||
      item.moduleLocalName !== moduleLocalName ||
      !isOpenTofuIdentifier(moduleLocalName) ||
      (item.childAlias !== undefined &&
        (childAlias === undefined ||
          item.childAlias !== childAlias ||
          !isOpenTofuIdentifier(childAlias))) ||
      (item.rootAlias !== undefined &&
        (rootAlias === undefined ||
          item.rootAlias !== rootAlias ||
          !isOpenTofuIdentifier(rootAlias))) ||
      !connectionId ||
      item.connectionId !== connectionId
    ) {
      return undefined;
    }
    // Core resolves one exact local/alias identity. Reject duplicates even if
    // callers point the duplicate identity at different Provider Connections.
    const identity = JSON.stringify([
      provider,
      moduleLocalName,
      childAlias ?? null,
    ]);
    if (identities.has(identity)) return undefined;
    identities.add(identity);
    result.push({
      provider,
      moduleLocalName,
      ...(childAlias !== undefined ? { childAlias } : {}),
      ...(rootAlias !== undefined ? { rootAlias } : {}),
      connectionId,
    });
  }
  result.sort(compareProviderBindingRequest);
  return result;
}

function compareProviderBindingRequest(
  left: GitInstallPlanProviderBindingRequest,
  right: GitInstallPlanProviderBindingRequest,
): number {
  return (
    compareString(left.provider, right.provider) ||
    compareString(left.moduleLocalName, right.moduleLocalName) ||
    compareString(left.childAlias ?? "", right.childAlias ?? "") ||
    compareString(left.rootAlias ?? "", right.rootAlias ?? "") ||
    compareString(left.connectionId, right.connectionId)
  );
}

function compareProviderBindingTuple(
  left: {
    readonly provider: string;
    readonly moduleLocalName?: string;
    readonly childAlias?: string;
    readonly rootAlias?: string;
    readonly connectionId: string;
  },
  right: {
    readonly provider: string;
    readonly moduleLocalName?: string;
    readonly childAlias?: string;
    readonly rootAlias?: string;
    readonly connectionId: string;
  },
): number {
  return (
    compareString(left.provider, right.provider) ||
    compareString(left.moduleLocalName ?? "", right.moduleLocalName ?? "") ||
    compareString(left.childAlias ?? "", right.childAlias ?? "") ||
    compareString(left.rootAlias ?? "", right.rootAlias ?? "") ||
    compareString(left.connectionId, right.connectionId)
  );
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedString(value: unknown, max: number): string | undefined {
  const string = stringValue(value)?.trim();
  return string && string.length <= max ? string : undefined;
}

function boundedPlainString(
  value: unknown,
  max: number,
): string | undefined {
  const string = boundedString(value, max);
  return string && !/[\u0000-\u001f\u007f]/u.test(string) ? string : undefined;
}

function connectionReference(value: unknown): string | undefined {
  const string = boundedString(value, 69);
  return string && CONNECTION_REFERENCE_PATTERN.test(string)
    ? string
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}
