import type {
  CapsuleConfigurationPlanRequest,
  CapsuleConfigurationPlanResponse,
  JsonValue,
} from "takosumi-contract";
import {
  type CapsuleCompatibilityReportResponse,
  normalizeCompatibilityReportModulePath,
} from "takosumi-contract/capsules";
import type {
  ProviderBindings,
  ProviderBindingSet,
} from "takosumi-contract/connections";
import type {
  Capsule,
  InstallConfig,
  PublicCapsule,
} from "takosumi-contract/install-configs";
import type { PublicPlanRun } from "@takosumi/internal/deploy-control-api";
import type { Run } from "takosumi-contract/runs";
import type { Source, SourceSnapshot } from "takosumi-contract/sources";
import { REDACTED_VALUE } from "takosumi-contract/redaction";
import {
  capsuleInterfaceBlueprintsNeedInstallingPrincipal,
  resolveCapsuleInterfaceBlueprintInstallingPrincipal,
} from "takosumi-contract/interfaces";

import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import { evaluateCompatibilityReportAgainstPolicy } from "../../../../core/domains/deploy-control/provider_policy.ts";
import { providerBindingSetAuthorityDigest } from "../../../../core/domains/deploy-control/store.ts";
import type { InstallPlanCompatibilityCheckRequest } from "../../../../core/domains/sources/mod.ts";
import {
  errorJson,
  json,
  methodNotAllowed,
  readJsonObject,
} from "../http-helpers.ts";
import { parseInterfaceBlueprintsValue } from "./interface-blueprints.ts";
import {
  genericOpenTofuVariableContractDigest,
  genericOpenTofuVariableDeclarationsAreCanonical,
} from "./generic-opentofu-variable-contract.ts";
import {
  isPlainJsonObject,
  isJsonValue,
  jsonRecordValue,
  modulePathValue,
  parseProviderBindings,
} from "./parse.ts";
import { resolveRepoOwnedInstallModulePath } from "./repo-owned-install-config.ts";
import {
  capsuleInstallConfigReAdoptionAuthoritySnapshot,
  hasValidDerivedTargetSeal,
  nextInstallConfigAuthorityTimestamp,
  type ReAdoptionAuthoritySnapshot,
  type ReAdoptionCasExpected,
  type ReAdoptionReceipt,
  sealInstallConfigSuccessor,
} from "./install-config-re-adoptions.ts";
import {
  type ControlDispatchContext,
  publicCapsule,
  resolveProviderBindings,
} from "./shared.ts";

const MAX_IDEMPOTENCY_KEY_BYTES = 256;
const MAX_CONFIGURATION_VARIABLES = 256;
const MAX_CONFIGURATION_VARIABLE_NAME_BYTES = 128;
const MAX_CONFIGURATION_PATCH_BYTES = 256 * 1024;
const MAX_CONFIGURATION_REQUEST_BYTES = 512 * 1024;
const MAX_PROVIDER_BINDINGS = 64;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CONFIGURATION_REASON = "Create reviewed Capsule configuration Plan";

interface ConfigurationEvidenceIdentity {
  readonly compatibilityCheckRunId: string;
  readonly compatibilityReportId: string;
  /** Durable Plan identity derived from the same immutable request evidence. */
  readonly planRunId: string;
  readonly compatibilityCreatedBy: string;
  readonly planCreatedBy: string;
}

/** POST /api/v1/capsules/:capsuleId/configuration-plans. */
export async function handleCapsuleConfigurationPlans(
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
  const request = body ? parseRequest(body) : undefined;
  if (!request) {
    return errorJson(
      "invalid_request",
      "Configuration planning requires exactly a variablePatch, value-free providerBindings, interfaceBlueprints, and the current authority guard.",
      400,
      ctx.request,
    );
  }

  const actorSubject = ctx.session.subject;
  const idempotencyKeyHash = await stableJsonDigest(key);
  const requestDigest = await stableJsonDigest({
    operation: "capsule_configuration_plan_v1",
    capsuleId: capsule.id,
    ...request,
  });
  const targetInstallConfigId = await configurationTargetInstallConfigId({
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    actorSubject,
    idempotencyKeyHash,
  });

  const existing = await installConfigIfPresent(
    ctx,
    targetInstallConfigId,
  );
  if (existing) {
    const receipt = existing.internal?.reAdoption;
    if (
      !receipt ||
      receipt.capsuleId !== capsule.id ||
      receipt.actorSubject !== actorSubject ||
      receipt.idempotencyKeyHash !== idempotencyKeyHash ||
      receipt.requestDigest !== requestDigest ||
      receipt.reason !== CONFIGURATION_REASON ||
      !receipt.previousProviderBindingSetAuthorityDigest ||
      !receipt.baseInstallConfigDigest ||
      !(await hasValidDerivedTargetSeal(existing))
    ) {
      return idempotencyConflict(ctx.request);
    }
    return await finishConfigurationPlan({
      ctx,
      requestDigest,
      target: existing,
      receipt,
    });
  }

  const authority = await capsuleInstallConfigReAdoptionAuthoritySnapshot(
    ctx.operations,
    capsule.id,
  );
  if (
    authority.capsule.workspaceId !== capsule.workspaceId ||
    authority.authorityGuard !== request.expected.authorityGuard
  ) {
    return authorityConflict(ctx.request);
  }
  if (
    authority.capsule.status === "destroyed" ||
    authority.capsule.status === "disabled" ||
    (await ctx.operations.gitInstallPlans.hasInFlightRevisionForCapsule(
      authority.capsule.id,
    ))
  ) {
    return errorJson(
      "failed_precondition",
      "The Capsule is not available for configuration planning.",
      409,
      ctx.request,
      {},
      { reason: "capsule_install_config_rebind_busy" },
    );
  }

  const sourceContext = await currentSourceContext(ctx, authority);
  const moduleSelection = resolveRepoOwnedInstallModulePath({
    sourceSnapshot: sourceContext.sourceSnapshot,
    ...(authority.installConfig.modulePath
      ? { modulePath: authority.installConfig.modulePath }
      : {}),
  });
  if (!moduleSelection.ok) {
    return errorJson(
      "failed_precondition",
      moduleSelection.diagnostic.message,
      409,
      ctx.request,
      {},
      { reason: moduleSelection.diagnostic.code },
    );
  }
  const resolvedBindings = await resolveProviderBindings(
    ctx.operations,
    authority.capsule.workspaceId,
    request.providerBindings,
  );
  if (!resolvedBindings.ok) {
    return errorJson(
      "invalid_request",
      resolvedBindings.message,
      400,
      ctx.request,
    );
  }
  const resolvedValueFreeBindings = resolvedBindings.bindings;
  if (
    capsuleInterfaceBlueprintsNeedInstallingPrincipal(
      request.interfaceBlueprints,
    ) &&
    !boundedExactIdentifier(authority.capsule.installingPrincipalId)
  ) {
    return errorJson(
      "failed_precondition",
      "The Capsule has no exact installing Principal for this Interface binding declaration.",
      409,
      ctx.request,
      {},
      { reason: "capsule_configuration_installing_principal_unavailable" },
    );
  }
  const resolvedInterfaceBlueprints =
    capsuleInterfaceBlueprintsNeedInstallingPrincipal(
      request.interfaceBlueprints,
    )
      ? resolveCapsuleInterfaceBlueprintInstallingPrincipal(
          request.interfaceBlueprints,
          authority.capsule.installingPrincipalId!,
        )!
      : request.interfaceBlueprints;
  const baseInstallConfigDigest = authority.installConfigDigest;
  const now = nextInstallConfigAuthorityTimestamp([
    authority.capsule.updatedAt,
    authority.installConfig.updatedAt,
    sourceContext.sourceSnapshot.fetchedAt,
  ]);
  const targetBindingSet = await configurationProviderBindingSet({
    targetInstallConfigId,
    requestDigest,
    capsule: authority.capsule,
    bindings: resolvedValueFreeBindings,
    timestamp: now,
  });
  const targetProviderBindingSetDigest = await stableJsonDigest(
    targetBindingSet,
  );
  const evidence = await configurationEvidenceIdentity({
    requestDigest,
    targetInstallConfigId,
    targetProviderBindingSetDigest,
    baseInstallConfigDigest,
    sourceSnapshotId: sourceContext.sourceSnapshot.id,
    modulePath: moduleSelection.modulePath,
  });
  const compatibility = await createOrObserveCompatibilityEvidence({
    ctx,
    source: sourceContext.source,
    sourceSnapshot: sourceContext.sourceSnapshot,
    installConfigId: authority.installConfig.id,
    modulePath: moduleSelection.modulePath,
    evidence,
  });
  const compatibilityPolicy = evaluateCompatibilityReportAgainstPolicy(
    compatibility.report,
    authority.installConfig.policy,
  );
  if (!compatibilityPolicy.runnable) {
    return errorJson(
      "failed_precondition",
      "The current SourceSnapshot is not runnable under this Capsule's policy.",
      409,
      ctx.request,
      {},
      { reason: "capsule_configuration_compatibility_not_runnable" },
    );
  }
  const variableMapping = await applyConfigurationVariablePatch(
    authority.installConfig,
    request.variablePatch,
    sourceContext.sourceSnapshot,
    moduleSelection.modulePath,
    compatibility.report,
  );
  if (!variableMapping.ok) {
    const authorityFailure =
      variableMapping.reason ===
        "capsule_configuration_manifest_authority_unavailable" ||
      variableMapping.reason.startsWith(
        "capsule_configuration_generic_authority_",
      );
    return errorJson(
      authorityFailure ? "failed_precondition" : "invalid_request",
      variableMapping.message,
      authorityFailure ? 409 : 400,
      ctx.request,
      {},
      { reason: variableMapping.reason },
    );
  }
  const receiptCore: Omit<ReAdoptionReceipt, "derivedTargetDigest"> = {
    capsuleId: authority.capsule.id,
    actorSubject,
    reason: CONFIGURATION_REASON,
    idempotencyKeyHash,
    requestDigest,
    previousInstallConfigId: authority.installConfig.id,
    previousInstallConfigDigest: authority.installConfigDigest,
    previousCapsuleStatus: authority.capsule.status,
    previousStateGeneration: authority.capsule.currentStateGeneration,
    ...(authority.capsule.currentStateVersionId
      ? { previousStateVersionId: authority.capsule.currentStateVersionId }
      : {}),
    previousExecutionAuthorityEpoch: authority.executionAuthorityEpoch,
    previousProviderBindingSetAuthorityDigest:
      authority.providerBindingSetAuthorityDigest,
    targetProviderBindingSet: targetBindingSet,
    targetProviderBindingSetDigest,
    authorityGuard: authority.authorityGuard,
    ...(authority.committedPostApplyRecovery
      ? { committedPostApplyRecovery: authority.committedPostApplyRecovery }
      : {}),
    baseInstallConfigId: authority.installConfig.id,
    baseInstallConfigDigest,
    sourceSnapshotId: sourceContext.sourceSnapshot.id,
  };
  const currentInternal = authority.installConfig.internal;
  const {
    reAdoption: _previousReAdoption,
    ...preservedInternal
  } = currentInternal ?? { reason: "per_install_overrides" as const };
  const targetDraft = {
    ...authority.installConfig,
    id: targetInstallConfigId,
    workspaceId: authority.capsule.workspaceId,
    modulePath: moduleSelection.modulePath,
    internal: {
      ...preservedInternal,
      reason: "per_install_overrides",
      ...(authority.installConfig.internal
          ?.genericOpenTofuVariableContractDigest !== undefined
        ? {
            // For an applied Capsule, the current StateVersion selects the
            // exact SourceSnapshot. A successful declaration-digest check
            // above authorizes carrying the generic contract marker forward
            // to that adopted revision; the old historical snapshot id is not
            // itself the variable contract authority.
            genericOpenTofuSourceSnapshotId:
              sourceContext.sourceSnapshot.id,
          }
        : {}),
    },
    variableMapping: variableMapping.value,
    interfaceBlueprints: resolvedInterfaceBlueprints,
    createdAt: now,
    updatedAt: now,
  } satisfies InstallConfig;
  await ctx.operations.validateCapsuleConfigurationProviderBindings({
    capsule: authority.capsule,
    installConfig: targetDraft,
    compatibilityReport: compatibility.report,
    providerBindings: resolvedValueFreeBindings,
  });
  const expectedTarget = await sealInstallConfigSuccessor({
    target: targetDraft,
    receiptCore,
  });
  const created = await ctx.operations.capsules.createInstallConfigIfAbsent(
    expectedTarget,
  );
  const target = created
    ? expectedTarget
    : await ctx.operations.capsules.getInstallConfig(targetInstallConfigId);
  if (
    !(await exactConfigurationTarget(target, expectedTarget, requestDigest))
  ) {
    return idempotencyConflict(ctx.request);
  }
  const receipt = target.internal!.reAdoption!;
  return await finishConfigurationPlan({
    ctx,
    requestDigest,
    target,
    receipt,
  });
}

async function finishConfigurationPlan(input: {
  readonly ctx: ControlDispatchContext;
  readonly requestDigest: string;
  readonly target: InstallConfig;
  readonly receipt: ReAdoptionReceipt;
}): Promise<Response> {
  const previousBindingAuthorityDigest =
    input.receipt.previousProviderBindingSetAuthorityDigest;
  const baseInstallConfigDigest = input.receipt.baseInstallConfigDigest;
  const targetBindingSet = input.receipt.targetProviderBindingSet;
  const targetProviderBindingSetDigest =
    input.receipt.targetProviderBindingSetDigest;
  if (
    !previousBindingAuthorityDigest ||
    !baseInstallConfigDigest ||
    !targetBindingSet ||
    !targetProviderBindingSetDigest ||
    (await stableJsonDigest(targetBindingSet)) !==
      targetProviderBindingSetDigest
  ) {
    return idempotencyConflict(input.ctx.request);
  }
  const targetReceipt = input.target.internal?.reAdoption;
  if (
    !targetReceipt ||
    targetReceipt.capsuleId !== input.receipt.capsuleId ||
    targetReceipt.requestDigest !== input.requestDigest ||
    targetReceipt.sourceSnapshotId !== input.receipt.sourceSnapshotId ||
    !(await hasValidDerivedTargetSeal(input.target))
  ) {
    return idempotencyConflict(input.ctx.request);
  }

  const current = await input.ctx.operations.capsules.getCapsule(
    input.receipt.capsuleId,
  );
  const [sourceResponse, sourceSnapshot] = await Promise.all([
    input.ctx.operations.getSource(current.sourceId),
    input.ctx.operations.getSourceSnapshot(input.receipt.sourceSnapshotId),
  ]);
  const source = sourceResponse.source;
  assertSourceSnapshotScope(current, source, sourceSnapshot);
  if (input.target.modulePath === undefined) {
    throw configurationIdentityConflict(
      "The sealed target does not retain its exact OpenTofu module.",
    );
  }

  if (
    targetBindingSet.workspaceId !== current.workspaceId ||
    targetBindingSet.capsuleId !== current.id ||
    targetBindingSet.environment !== current.environment ||
    targetBindingSet.createdAt !== input.target.createdAt ||
    targetBindingSet.updatedAt !== input.target.updatedAt
  ) {
    throw configurationIdentityConflict(
      "The sealed ProviderBindingSet does not target this Capsule configuration.",
    );
  }
  const evidence = await configurationEvidenceIdentity({
    requestDigest: input.requestDigest,
    targetInstallConfigId: input.target.id,
    targetProviderBindingSetDigest,
    baseInstallConfigDigest,
    sourceSnapshotId: sourceSnapshot.id,
    modulePath: input.target.modulePath,
  });
  // A Plan is the durable completion receipt for this operation. Read it by
  // deterministic id before touching mutable Capsule authority: a retry after
  // Apply or a later configuration must return that original Plan, never try to
  // rebind the current (possibly newer) InstallConfig back to this target.
  const existingPlan = await planRunIfPresent(input.ctx, evidence.planRunId);
  if (existingPlan) {
    const compatibility = await observeExactCompatibilityEvidence({
      ctx: input.ctx,
      source,
      sourceSnapshot,
      modulePath: input.target.modulePath,
      evidence,
    });
    assertConfigurationCompatibilityPolicy(compatibility, input.target);
    await assertConfigurationPlanRun({
      run: existingPlan,
      capsule: current,
      source,
      sourceSnapshot,
      targetInstallConfig: input.target,
      compatibilityReportId: compatibility.report.id,
      executionAuthorityEpoch:
        input.receipt.previousExecutionAuthorityEpoch + 1,
      expectedBaseStateGeneration: input.receipt.previousStateGeneration,
      expectedBaseStateVersionId: input.receipt.previousStateVersionId,
      evidence,
    });
    return await configurationPlanResponse({
      ctx: input.ctx,
      capsule: current,
      previousInstallConfigId: input.receipt.previousInstallConfigId,
      targetInstallConfigId: input.target.id,
      sourceSnapshotId: sourceSnapshot.id,
      planRunId: existingPlan.id,
      replayed: true,
    });
  }

  // Re-read every mutable authority cursor before deciding whether this is a
  // first attempt (predecessor is still current) or a recovery after the
  // target rebind committed. A later successor, advanced state, or changed
  // binding is never repaired by moving authority backwards.
  const authority = await capsuleInstallConfigReAdoptionAuthoritySnapshot(
    input.ctx.operations,
    input.receipt.capsuleId,
  );
  if (
    authority.capsule.workspaceId !== current.workspaceId ||
    authority.capsule.id !== current.id
  ) {
    throw configurationIdentityConflict(
      "The Capsule authority changed while recovering this configuration Plan.",
    );
  }
  const targetInstallConfigDigest = await stableJsonDigest(input.target);
  const targetBindingAuthorityDigest = await providerBindingSetAuthorityDigest(
    targetBindingSet,
  );
  const reboundEpoch = input.receipt.previousExecutionAuthorityEpoch + 1;
  let planCapsule = authority.capsule;
  let executionAuthorityEpoch: number;
  // Reaching this branch means no durable Plan receipt exists yet. Even when
  // the atomic rebind committed before its acknowledgement was delivered, the
  // successor Plan created below is the first completed response, not a replay.
  let replayed = false;

  if (authority.capsule.installConfigId === input.receipt.previousInstallConfigId) {
    if (!configurationPredecessorMatchesReceipt(authority, input.receipt)) {
      throw configurationIdentityConflict(
        "The Capsule predecessor authority changed before configuration planning resumed.",
      );
    }
    if (
      authority.capsule.status === "destroyed" ||
      authority.capsule.status === "disabled" ||
      (await input.ctx.operations.gitInstallPlans.hasInFlightRevisionForCapsule(
        authority.capsule.id,
      ))
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "The Capsule is not available for configuration planning.",
        { reason: "capsule_install_config_rebind_busy" },
      );
    }
    // The insert-only successor may be analyzed before it becomes current. This
    // keeps an incompatible target from changing Capsule authority while still
    // checking the exact module and preserved policy that the Plan will use.
    const compatibility = await createOrObserveCompatibilityEvidence({
      ctx: input.ctx,
      source,
      sourceSnapshot,
      installConfigId: input.target.id,
      modulePath: input.target.modulePath,
      evidence,
    });
    assertConfigurationCompatibilityPolicy(compatibility, input.target);
    // A persisted successor can outlive an acknowledgement failure before the
    // Capsule CAS. Re-run the complete connection/provider preflight on every
    // predecessor recovery, immediately before that CAS, so a connection that
    // was revoked (or otherwise changed) after successor creation cannot move
    // the Capsule pointer, ProviderBindingSet, or execution epoch and only then
    // fail during Plan construction.
    await input.ctx.operations.validateCapsuleConfigurationProviderBindings({
      capsule: authority.capsule,
      installConfig: input.target,
      compatibilityReport: compatibility.report,
      providerBindings: targetBindingSet.bindings,
    });
    const rebound = await input.ctx.operations.capsules.rebindInstallConfig({
      capsuleId: input.receipt.capsuleId,
      targetInstallConfigId: input.target.id,
      expected: rebindExpected(input.receipt),
      actorSubject: input.receipt.actorSubject,
      reason: input.receipt.reason,
      requestDigest: input.requestDigest,
      providerBindingSetReplacement: {
        expectedCurrentAuthorityDigest: previousBindingAuthorityDigest,
        target: targetBindingSet,
        targetDigest: targetProviderBindingSetDigest,
      },
    });
    if (
      rebound.capsule.installConfigId !== input.target.id ||
      rebound.targetProviderBindingSetDigest !== targetProviderBindingSetDigest
    ) {
      throw configurationIdentityConflict(
        "The atomic deployment-intent transition did not retain its exact target.",
      );
    }
    planCapsule = rebound.capsule;
    executionAuthorityEpoch = await input.ctx.operations.capsules
      .getCapsuleExecutionAuthorityEpoch(rebound.capsule.id);
    if (executionAuthorityEpoch !== reboundEpoch) {
      throw configurationIdentityConflict(
        "The Capsule execution authority epoch did not advance with its configuration target.",
      );
    }
  } else if (authority.capsule.installConfigId === input.target.id) {
    if (
      authority.installConfigDigest !== targetInstallConfigDigest ||
      authority.executionAuthorityEpoch !== reboundEpoch ||
      authority.capsule.currentStateGeneration !==
        input.receipt.previousStateGeneration ||
      authority.capsule.currentStateVersionId !==
        input.receipt.previousStateVersionId ||
      authority.capsule.status !== input.receipt.previousCapsuleStatus ||
      authority.providerBindingSetAuthorityDigest !==
        targetBindingAuthorityDigest
    ) {
      throw configurationIdentityConflict(
        "The sealed configuration target is current but its execution authority has advanced; refusing a stale Plan.",
      );
    }
    if (
      authority.capsule.status === "destroyed" ||
      authority.capsule.status === "disabled" ||
      (await input.ctx.operations.gitInstallPlans.hasInFlightRevisionForCapsule(
        authority.capsule.id,
      ))
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "The Capsule is not available for configuration planning.",
        { reason: "capsule_install_config_rebind_busy" },
      );
    }
    const compatibility = await createOrObserveCompatibilityEvidence({
      ctx: input.ctx,
      source,
      sourceSnapshot,
      installConfigId: input.target.id,
      modulePath: input.target.modulePath,
      evidence,
    });
    assertConfigurationCompatibilityPolicy(compatibility, input.target);
    planCapsule = authority.capsule;
    executionAuthorityEpoch = authority.executionAuthorityEpoch;
  } else {
    throw configurationIdentityConflict(
      "The Capsule has moved beyond this configuration target; refusing to create a stale Plan.",
    );
  }

  const planRunId = await createFreshPlanRun({
    ctx: input.ctx,
    capsule: planCapsule,
    source,
    sourceSnapshot,
    targetInstallConfig: input.target,
    compatibilityReportId: evidence.compatibilityReportId,
    executionAuthorityEpoch,
    expectedBaseStateGeneration: input.receipt.previousStateGeneration,
    expectedBaseStateVersionId: input.receipt.previousStateVersionId,
    evidence,
  });
  const finalCapsule = await input.ctx.operations.capsules.getCapsule(planCapsule.id);
  const finalExecutionAuthorityEpoch = await input.ctx.operations.capsules
    .getCapsuleExecutionAuthorityEpoch(finalCapsule.id);
  if (
    finalCapsule.installConfigId !== input.target.id ||
    finalExecutionAuthorityEpoch !== executionAuthorityEpoch
  ) {
    throw configurationIdentityConflict(
      "The Capsule configuration changed while its canonical Plan was created.",
    );
  }
  return await configurationPlanResponse({
    ctx: input.ctx,
    capsule: finalCapsule,
    previousInstallConfigId: input.receipt.previousInstallConfigId,
    targetInstallConfigId: input.target.id,
    sourceSnapshotId: sourceSnapshot.id,
    planRunId,
    replayed,
  });
}

async function publicConfigurationCapsule(
  ctx: ControlDispatchContext,
  capsule: Capsule,
): Promise<PublicCapsule> {
  const {
    publicOriginReservation: _publicOriginReservation,
    ...publicInput
  } = capsule;
  const projected = publicCapsule(publicInput);
  if (!capsule.currentStateVersionId) return projected;
  const adoptedSourceRevision = await ctx.operations
    .getCapsuleAdoptedSourceRevision(capsule.id);
  return adoptedSourceRevision
    ? { ...projected, adoptedSourceRevision }
    : projected;
}

async function currentSourceContext(
  ctx: ControlDispatchContext,
  authority: ReAdoptionAuthoritySnapshot,
): Promise<
  { readonly source: Source; readonly sourceSnapshot: SourceSnapshot }
> {
  const capsule = authority.capsule;
  const { source } = await ctx.operations.getSource(capsule.sourceId);
  const adopted = await ctx.operations.getCapsuleAdoptedSourceRevision(
    capsule.id,
  );
  let sourceSnapshotId: string | undefined;
  if (capsule.currentStateVersionId || capsule.currentStateGeneration > 0) {
    sourceSnapshotId = adopted?.sourceSnapshotId;
    if (!sourceSnapshotId) {
      throw configurationIdentityConflict(
        "The Capsule's applied StateVersion has no adopted SourceSnapshot.",
      );
    }
  } else {
    sourceSnapshotId = unappliedInstallConfigSourceSnapshotId(
      authority.installConfig,
    );
  }
  if (!sourceSnapshotId) {
    throw configurationIdentityConflict(
      "The never-applied Capsule has no reviewed SourceSnapshot configuration.",
    );
  }
  const sourceSnapshot = await ctx.operations.getSourceSnapshot(
    sourceSnapshotId,
  );
  assertSourceSnapshotScope(capsule, source, sourceSnapshot);
  if (
    adopted &&
    (adopted.sourceSnapshotId !== sourceSnapshot.id ||
      adopted.ref !== sourceSnapshot.ref ||
      adopted.path !== sourceSnapshot.path ||
      adopted.resolvedCommit.toLowerCase() !==
        sourceSnapshot.resolvedCommit.toLowerCase())
  ) {
    throw configurationIdentityConflict(
      "The applied Source revision does not match its exact SourceSnapshot.",
    );
  }
  return { source, sourceSnapshot };
}

/**
 * Resolve the exact source provenance for a never-applied Capsule. Generic
 * OpenTofu rows use their own snapshot/digest pair; repository-manifest rows
 * retain the historical pair. A marker from either lane is never accepted by
 * itself or mixed with the other lane. Applied Capsules do not call this
 * helper: their StateVersion -> ApplyRun -> PlanRun lineage is authoritative.
 */
function unappliedInstallConfigSourceSnapshotId(
  installConfig: InstallConfig,
): string {
  const internal = installConfig.internal;
  const hasGenericDigest =
    internal?.genericOpenTofuVariableContractDigest !== undefined;
  const hasGenericSnapshot =
    internal?.genericOpenTofuSourceSnapshotId !== undefined;
  const hasRepositorySnapshot = internal?.sourceSnapshotId !== undefined;
  const hasRepositoryDigest =
    internal?.repositoryInstallUxDigest !== undefined;

  if (hasGenericDigest || hasGenericSnapshot) {
    if (!hasGenericDigest || !hasGenericSnapshot) {
      throw configurationIdentityConflict(
        "The never-applied Capsule has partial generic OpenTofu provenance.",
      );
    }
    if (hasRepositorySnapshot || hasRepositoryDigest) {
      throw configurationIdentityConflict(
        "The never-applied Capsule mixes generic and repository-manifest provenance.",
      );
    }
    if (
      !DIGEST.test(internal!.genericOpenTofuVariableContractDigest!) ||
      !boundedExactIdentifier(internal!.genericOpenTofuSourceSnapshotId!) ||
      !isCanonicalModulePath(installConfig.modulePath)
    ) {
      throw configurationIdentityConflict(
        "The never-applied Capsule has invalid generic OpenTofu provenance.",
      );
    }
    return internal!.genericOpenTofuSourceSnapshotId!;
  }

  if (hasRepositorySnapshot || hasRepositoryDigest) {
    if (!hasRepositorySnapshot || !hasRepositoryDigest) {
      throw configurationIdentityConflict(
        "The never-applied Capsule has partial repository-manifest provenance.",
      );
    }
    if (
      !boundedExactIdentifier(internal!.sourceSnapshotId!) ||
      !DIGEST.test(internal!.repositoryInstallUxDigest!)
    ) {
      throw configurationIdentityConflict(
        "The never-applied Capsule has invalid repository-manifest provenance.",
      );
    }
    return internal!.sourceSnapshotId!;
  }

  throw configurationIdentityConflict(
    "The never-applied Capsule has no reviewed SourceSnapshot configuration.",
  );
}

function boundedExactIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isCanonicalModulePath(value: unknown): value is string {
  const parsed = modulePathValue(value);
  const canonical = parsed === "" ? "." : parsed;
  return (
    typeof value === "string" &&
    parsed !== undefined &&
    value === canonical &&
    canonical.length <= 1_024 &&
    (canonical === "." ||
      canonical.split("/").every(
        (segment) => segment.length > 0 && segment !== "." && segment !== "..",
      ))
  );
}

function assertSourceSnapshotScope(
  capsule: Capsule,
  source: Source,
  snapshot: SourceSnapshot,
): void {
  if (
    source.id !== capsule.sourceId ||
    source.workspaceId !== capsule.workspaceId ||
    source.status !== "active" ||
    snapshot.origin !== "git" ||
    snapshot.sourceId !== source.id ||
    snapshot.workspaceId !== capsule.workspaceId ||
    snapshot.url !== source.url ||
    snapshot.resolvedCommit.trim() === ""
  ) {
    throw configurationIdentityConflict(
      "The SourceSnapshot is not exact Git authority for this Capsule Source.",
    );
  }
}

async function createOrObserveCompatibilityEvidence(input: {
  readonly ctx: ControlDispatchContext;
  readonly source: Source;
  readonly sourceSnapshot: SourceSnapshot;
  readonly installConfigId: string;
  readonly modulePath: string;
  readonly evidence: ConfigurationEvidenceIdentity;
}): Promise<CapsuleCompatibilityReportResponse> {
  const request: InstallPlanCompatibilityCheckRequest = {
    sourceSnapshotId: input.sourceSnapshot.id,
    modulePath: input.modulePath,
    installConfigId: input.installConfigId,
    installPlanIdentity: {
      runId: input.evidence.compatibilityCheckRunId,
      reportId: input.evidence.compatibilityReportId,
      createdBy: input.evidence.compatibilityCreatedBy,
    },
  };
  const compatibility = await input.ctx.operations
    .createSourceCompatibilityCheck(
      input.source.id,
      request,
    );
  const { report, run } = compatibility;
  if (
    report.id !== input.evidence.compatibilityReportId ||
    report.sourceId !== input.source.id ||
    report.sourceSnapshotId !== input.sourceSnapshot.id ||
    report.capsuleId !== undefined ||
    normalizeCompatibilityReportModulePath(report.modulePath) !==
      normalizeCompatibilityReportModulePath(input.modulePath) ||
    !run ||
    run.id !== input.evidence.compatibilityCheckRunId ||
    run.workspaceId !== input.source.workspaceId ||
    run.sourceId !== input.source.id ||
    run.sourceSnapshotId !== input.sourceSnapshot.id ||
    run.type !== "compatibility_check" ||
    run.createdBy !== input.evidence.compatibilityCreatedBy ||
    run.compatibilityReportId !== report.id ||
    run.status !== "succeeded"
  ) {
    throw configurationIdentityConflict(
      "The deterministic compatibility evidence is bound to another configuration.",
    );
  }
  return compatibility;
}

async function createFreshPlanRun(input: {
  readonly ctx: ControlDispatchContext;
  readonly capsule: Capsule;
  readonly source: Source;
  readonly sourceSnapshot: SourceSnapshot;
  readonly targetInstallConfig: InstallConfig;
  readonly compatibilityReportId: string;
  readonly executionAuthorityEpoch: number;
  readonly expectedBaseStateGeneration: number;
  readonly expectedBaseStateVersionId: string | undefined;
  readonly evidence: ConfigurationEvidenceIdentity;
}): Promise<string> {
  // Run persistence happens before private-input sidecars, notification, and
  // enqueue. The exact identity is derived from the sealed successor/evidence,
  // so a lost acknowledgement reuses the same durable PlanRun row and never
  // creates a second Plan for one Idempotency-Key operation.
  const created = await input.ctx.operations.createCapsulePlan(
    input.capsule.id,
    {
      sourceSnapshotId: input.sourceSnapshot.id,
      compatibilityReportId: input.compatibilityReportId,
      planRunId: input.evidence.planRunId,
      expectedCapsulePlanAuthority: {
        installConfigId: input.targetInstallConfig.id,
        executionAuthorityEpoch: input.executionAuthorityEpoch,
        currentStateGeneration: input.expectedBaseStateGeneration,
        currentStateVersionId: input.expectedBaseStateVersionId,
      },
      actor: input.evidence.planCreatedBy,
    },
  );
  const observed = await input.ctx.operations.getPlanRun(created.planRun.id);
  const run = observed.planRun;
  await assertConfigurationPlanRun({
    run,
    capsule: input.capsule,
    source: input.source,
    sourceSnapshot: input.sourceSnapshot,
    targetInstallConfig: input.targetInstallConfig,
    compatibilityReportId: input.compatibilityReportId,
    executionAuthorityEpoch: input.executionAuthorityEpoch,
    expectedBaseStateGeneration: input.expectedBaseStateGeneration,
    expectedBaseStateVersionId: input.expectedBaseStateVersionId,
    evidence: input.evidence,
  });
  return run.id;
}

async function planRunIfPresent(
  ctx: ControlDispatchContext,
  id: string,
): Promise<PublicPlanRun | undefined> {
  try {
    return (await ctx.operations.getPlanRun(id)).planRun;
  } catch (error) {
    if (error instanceof OpenTofuControllerError && error.code === "not_found") {
      return undefined;
    }
    throw error;
  }
}

async function observeExactCompatibilityEvidence(input: {
  readonly ctx: ControlDispatchContext;
  readonly source: Source;
  readonly sourceSnapshot: SourceSnapshot;
  readonly modulePath: string;
  readonly evidence: ConfigurationEvidenceIdentity;
}): Promise<CapsuleCompatibilityReportResponse> {
  let run: Run;
  try {
    run = await input.ctx.operations.getRun(
      input.evidence.compatibilityCheckRunId,
    );
  } catch (error) {
    if (error instanceof OpenTofuControllerError && error.code === "not_found") {
      throw configurationIdentityConflict(
        "The deterministic compatibility evidence for the canonical Plan is missing.",
      );
    }
    throw error;
  }
  let reportResponse: CapsuleCompatibilityReportResponse;
  try {
    reportResponse = await input.ctx.operations.getCompatibilityReport(
      input.evidence.compatibilityReportId,
    );
  } catch (error) {
    if (error instanceof OpenTofuControllerError && error.code === "not_found") {
      throw configurationIdentityConflict(
        "The deterministic compatibility report for the canonical Plan is missing.",
      );
    }
    throw error;
  }
  const report = reportResponse.report;
  if (
    report.id !== input.evidence.compatibilityReportId ||
    report.sourceId !== input.source.id ||
    report.sourceSnapshotId !== input.sourceSnapshot.id ||
    report.capsuleId !== undefined ||
    normalizeCompatibilityReportModulePath(report.modulePath) !==
      normalizeCompatibilityReportModulePath(input.modulePath) ||
    run.id !== input.evidence.compatibilityCheckRunId ||
    run.workspaceId !== input.source.workspaceId ||
    run.sourceId !== input.source.id ||
    run.sourceSnapshotId !== input.sourceSnapshot.id ||
    run.type !== "compatibility_check" ||
    run.createdBy !== input.evidence.compatibilityCreatedBy ||
    run.compatibilityReportId !== report.id ||
    run.status !== "succeeded"
  ) {
    throw configurationIdentityConflict(
      "The deterministic compatibility evidence is bound to another configuration.",
    );
  }
  return { report, run };
}

function assertConfigurationCompatibilityPolicy(
  compatibility: CapsuleCompatibilityReportResponse,
  target: InstallConfig,
): void {
  const policy = evaluateCompatibilityReportAgainstPolicy(
    compatibility.report,
    target.policy,
  );
  if (!policy.runnable) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "The sealed configuration target is not runnable under its compatibility policy.",
      { reason: "capsule_configuration_compatibility_not_runnable" },
    );
  }
}

async function assertConfigurationPlanRun(input: {
  readonly run: PublicPlanRun;
  readonly capsule: Capsule;
  readonly source: Source;
  readonly sourceSnapshot: SourceSnapshot;
  readonly targetInstallConfig: InstallConfig;
  readonly compatibilityReportId: string;
  readonly executionAuthorityEpoch: number;
  readonly expectedBaseStateGeneration: number;
  readonly expectedBaseStateVersionId: string | undefined;
  readonly evidence: ConfigurationEvidenceIdentity;
}): Promise<void> {
  const capsuleContext = input.run.capsuleContext;
  const expectedOperation = input.expectedBaseStateGeneration > 0
    ? "update"
    : "create";
  if (
    input.run.id !== input.evidence.planRunId ||
    input.run.workspaceId !== input.capsule.workspaceId ||
    input.run.capsuleId !== input.capsule.id ||
    !capsuleContext ||
    capsuleContext.workspaceId !== input.capsule.workspaceId ||
    capsuleContext.capsuleId !== input.capsule.id ||
    capsuleContext.environment !== input.capsule.environment ||
    input.run.sourceSnapshotId !== input.sourceSnapshot.id ||
    input.run.compatibilityReportId !== input.compatibilityReportId ||
    input.run.createdBy !== input.evidence.planCreatedBy ||
    input.run.capsuleExecutionAuthorityEpoch !== input.executionAuthorityEpoch ||
    (input.run.capsuleCurrentStateVersionId ?? null) !==
      (input.expectedBaseStateVersionId ?? null) ||
    input.run.baseStateGeneration !== input.expectedBaseStateGeneration ||
    input.run.operation !== expectedOperation ||
    input.run.source.kind !== "git" ||
    input.run.source.url !== input.source.url ||
    input.run.source.commit?.toLowerCase() !==
      input.sourceSnapshot.resolvedCommit.toLowerCase() ||
    normalizeCompatibilityReportModulePath(input.run.source.modulePath) !==
      normalizeCompatibilityReportModulePath(input.targetInstallConfig.modulePath)
  ) {
    throw configurationIdentityConflict(
      "The canonical Plan Run is bound to another Capsule configuration.",
    );
  }
}

function configurationPredecessorMatchesReceipt(
  authority: ReAdoptionAuthoritySnapshot,
  receipt: ReAdoptionReceipt,
): boolean {
  return authority.capsule.installConfigId === receipt.previousInstallConfigId &&
    authority.installConfigDigest === receipt.previousInstallConfigDigest &&
    authority.capsule.status === receipt.previousCapsuleStatus &&
    authority.capsule.currentStateGeneration === receipt.previousStateGeneration &&
    authority.capsule.currentStateVersionId === receipt.previousStateVersionId &&
    authority.executionAuthorityEpoch === receipt.previousExecutionAuthorityEpoch &&
    authority.providerBindingSetAuthorityDigest ===
      receipt.previousProviderBindingSetAuthorityDigest;
}

async function configurationPlanResponse(input: {
  readonly ctx: ControlDispatchContext;
  readonly capsule: Capsule;
  readonly previousInstallConfigId: string;
  readonly targetInstallConfigId: string;
  readonly sourceSnapshotId: string;
  readonly planRunId: string;
  readonly replayed: boolean;
}): Promise<Response> {
  const response: CapsuleConfigurationPlanResponse = {
    capsule: await publicConfigurationCapsule(input.ctx, input.capsule),
    configurationPlan: {
      replayed: input.replayed,
      previousInstallConfigId: input.previousInstallConfigId,
      targetInstallConfigId: input.targetInstallConfigId,
      sourceSnapshotId: input.sourceSnapshotId,
      planRunId: input.planRunId,
    },
    links: { run: `/api/v1/runs/${input.planRunId}` },
  };
  return json(response, input.replayed ? 200 : 201);
}

async function applyConfigurationVariablePatch(
  config: InstallConfig,
  patch: CapsuleConfigurationPlanRequest["variablePatch"],
  sourceSnapshot: SourceSnapshot,
  modulePath: string,
  compatibilityReport: CapsuleCompatibilityReportResponse["report"],
): Promise<
  | { readonly ok: true; readonly value: Readonly<Record<string, JsonValue>> }
  | { readonly ok: false; readonly message: string; readonly reason: string }
> {
  const genericDigest =
    config.internal?.genericOpenTofuVariableContractDigest;
  const genericSnapshotId =
    config.internal?.genericOpenTofuSourceSnapshotId;
  let authorityInputs:
    | ReadonlyMap<string, ConfigurationVariableInput>
    | undefined;
  let authorityName = "repository manifest";
  let invalidVariableReason =
    "capsule_configuration_manifest_user_variable_invalid";
  if (genericDigest !== undefined || genericSnapshotId !== undefined) {
    if (
      genericDigest === undefined ||
      genericSnapshotId === undefined ||
      !DIGEST.test(genericDigest) ||
      !boundedExactIdentifier(genericSnapshotId) ||
      !isCanonicalModulePath(modulePath)
    ) {
      return {
        ok: false,
        message:
          "The generic OpenTofu configuration has invalid declaration authority.",
        reason: "capsule_configuration_generic_authority_invalid",
      };
    }
    const declarations = compatibilityReport.rootModuleVariableDeclarations;
    if (
      !declarations ||
      !genericOpenTofuVariableDeclarationsAreCanonical(declarations)
    ) {
      return {
        ok: false,
        message:
          "The exact compatibility report has no canonical generic OpenTofu variable declaration.",
        reason: "capsule_configuration_generic_authority_declarations_invalid",
      };
    }
    const observedDigest = await genericOpenTofuVariableContractDigest({
      declarations,
      modulePath,
    });
    if (observedDigest !== genericDigest) {
      return {
        ok: false,
        message:
          "The exact compatibility declaration does not match the generic OpenTofu variable authority stored for this Capsule.",
        reason: "capsule_configuration_generic_authority_digest_mismatch",
      };
    }
    authorityInputs = new Map(
      declarations.map((declaration) => [
        declaration.name,
        {
          name: declaration.name,
          source: { kind: "user" },
          type: declaration.type,
          required: !declaration.hasDefault,
        },
      ] as const),
    );
    authorityName = "generic OpenTofu variable contract";
    invalidVariableReason =
      "capsule_configuration_generic_variable_invalid";
  } else {
    authorityInputs = repositoryManifestInputMap(sourceSnapshot, modulePath);
  }
  const hasPatch = Object.keys(patch.set).length > 0 || patch.remove.length > 0;
  if (!authorityInputs && hasPatch) {
    return {
      ok: false,
      message:
        "The immutable SourceSnapshot has no repository-manifest input authority for this configuration; only an empty variable patch is allowed.",
      reason: "capsule_configuration_manifest_authority_unavailable",
    };
  }
  if (authorityInputs) {
    for (const name of [
      ...Object.keys(patch.set),
      ...patch.remove,
    ]) {
      const declaration = authorityInputs.get(name);
      if (
        !declaration ||
        declaration.source.kind !== "user"
      ) {
        return {
          ok: false,
          message: `The configuration value ${boundedVariableName(name)} is not a declared user input in the pinned ${authorityName}.`,
          reason: invalidVariableReason,
        };
      }
    }
  }
  for (const [name, value] of Object.entries(patch.set)) {
    if (containsRedactedSentinel(value)) {
      return {
        ok: false,
        message: `The replacement for ${boundedVariableName(name)} contains the reserved redaction marker.`,
        reason: "capsule_configuration_redacted_value_reserved",
      };
    }
  }

  for (const [name, value] of Object.entries(config.variableMapping)) {
    if (!isJsonValue(value)) {
      return {
        ok: false,
        message: `The current private value for ${boundedVariableName(name)} is not valid JSON configuration.`,
        reason: "capsule_configuration_current_value_invalid",
      };
    }
  }
  const next = { ...config.variableMapping } as Record<string, JsonValue>;
  for (const name of patch.remove) delete next[name];
  Object.assign(next, patch.set);

  for (const presentation of config.variablePresentation ?? []) {
    const present = Object.prototype.hasOwnProperty.call(next, presentation.name);
    if (presentation.required === true && !present) {
      return {
        ok: false,
        message: `The required configuration value ${boundedVariableName(presentation.name)} cannot be removed.`,
        reason: "capsule_configuration_required_value_missing",
      };
    }
    if (
      present &&
      !configurationValueMatchesType(next[presentation.name]!, presentation.type)
    ) {
      return {
        ok: false,
        message: `The configuration value ${boundedVariableName(presentation.name)} does not match its declared type.`,
        reason: "capsule_configuration_value_type_mismatch",
      };
    }
  }
  for (const declaration of authorityInputs?.values() ?? []) {
    const present = Object.prototype.hasOwnProperty.call(next, declaration.name);
    if (declaration.required === true && !present) {
      return {
        ok: false,
        message: `The required configuration value ${boundedVariableName(declaration.name)} cannot be removed.`,
        reason: "capsule_configuration_required_value_missing",
      };
    }
    if (
      present &&
      !configurationValueMatchesType(next[declaration.name]!, declaration.type)
    ) {
      return {
        ok: false,
        message: `The configuration value ${boundedVariableName(declaration.name)} does not match its declared type.`,
        reason: "capsule_configuration_value_type_mismatch",
      };
    }
  }
  return { ok: true, value: next };
}

type ConfigurationVariableInput = {
  readonly name: string;
  readonly source: { readonly kind: string };
  readonly secret?: boolean;
  readonly required?: boolean;
  readonly type?: "string" | "number" | "boolean" | "json" | "unknown";
};

/**
 * Return only the exact input declarations from the immutable repository
 * manifest module selected by the source-sync module index. An absent module
 * declaration is deliberately different from an empty declaration: both deny
 * variable patches, while an empty map still proves that the manifest was
 * present and authoritative for this module.
 */
function repositoryManifestInputMap(
  snapshot: SourceSnapshot,
  modulePath: string,
): ReadonlyMap<string, ConfigurationVariableInput> | undefined {
  const observation = snapshot.repositoryManifest;
  if (!observation || observation.status !== "present") return undefined;
  const manifestModulePath = repositoryManifestModulePath(snapshot, modulePath);
  if (!manifestModulePath) return undefined;
  const module = observation.document.install.modules[manifestModulePath];
  if (!module) return undefined;
  return new Map(
    module.inputs.map((input) => [input.name, input] as const),
  );
}

function repositoryManifestModulePath(
  snapshot: SourceSnapshot,
  modulePath: string,
): string | undefined {
  const scopePath = modulePathValue(snapshot.path);
  if (scopePath === undefined) return undefined;
  const canonicalScopePath = scopePath === "" ? "." : scopePath;
  if (canonicalScopePath === ".") return modulePath;
  return modulePath === "." ? canonicalScopePath : `${canonicalScopePath}/${modulePath}`;
}

function configurationValueMatchesType(
  value: JsonValue,
  type: "string" | "number" | "boolean" | "json" | "unknown" | undefined,
): boolean {
  switch (type ?? "string") {
    case "json":
    case "unknown":
      return true;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
  }
}

function containsRedactedSentinel(value: JsonValue): boolean {
  if (value === REDACTED_VALUE) return true;
  if (Array.isArray(value)) return value.some(containsRedactedSentinel);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsRedactedSentinel);
  }
  return false;
}

function boundedVariableName(value: string): string {
  const bounded = value.length <= 80 ? value : `${value.slice(0, 77)}...`;
  return JSON.stringify(bounded);
}

function parseRequest(
  body: Readonly<Record<string, unknown>>,
): CapsuleConfigurationPlanRequest | undefined {
  if (
    new TextEncoder().encode(JSON.stringify(body)).byteLength >
      MAX_CONFIGURATION_REQUEST_BYTES ||
    !hasOnlyKeys(body, [
      "variablePatch",
      "providerBindings",
      "interfaceBlueprints",
      "expected",
    ])
  ) {
    return undefined;
  }
  const variablePatch = parseVariablePatch(body.variablePatch);
  const bindings = parseProviderBindings(body.providerBindings);
  const interfaceBlueprints = parseInterfaceBlueprintsValue(
    body.interfaceBlueprints,
  );
  if (
    variablePatch === undefined ||
    !bindings.ok ||
    bindings.bindings.length > MAX_PROVIDER_BINDINGS ||
    !providerBindingRecordsAreClosed(body.providerBindings) ||
    !interfaceBlueprints.ok ||
    !isPlainJsonObject(body.expected) ||
    !hasOnlyKeys(body.expected, ["authorityGuard"])
  ) {
    return undefined;
  }
  const authorityGuard = body.expected.authorityGuard;
  if (typeof authorityGuard !== "string" || !DIGEST.test(authorityGuard)) {
    return undefined;
  }
  return {
    variablePatch,
    providerBindings: bindings.bindings,
    interfaceBlueprints: interfaceBlueprints.value,
    expected: { authorityGuard },
  };
}

function providerBindingRecordsAreClosed(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const allowed = new Set([
    "provider",
    "moduleLocalName",
    "childAlias",
    "rootAlias",
    "connectionId",
    "region",
    "runCredentialSettings",
  ]);
  return value.every(
    (entry) =>
      isPlainJsonObject(entry) &&
      Object.keys(entry).every((key) => allowed.has(key)),
  );
}

function parseVariablePatch(
  value: unknown,
): CapsuleConfigurationPlanRequest["variablePatch"] | undefined {
  if (
    !isPlainJsonObject(value) ||
    !hasOnlyKeys(value, ["set", "remove"]) ||
    !isPlainJsonObject(value.set)
  ) {
    return undefined;
  }
  const set = jsonRecordValue(value.set);
  if (
    !set ||
    Object.keys(set).length !== Object.keys(value.set).length ||
    !Array.isArray(value.remove)
  ) {
    return undefined;
  }
  const remove = value.remove;
  if (
    Object.keys(set).length > MAX_CONFIGURATION_VARIABLES ||
    remove.length > MAX_CONFIGURATION_VARIABLES ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
      MAX_CONFIGURATION_PATCH_BYTES
  ) {
    return undefined;
  }
  const removed = new Set<string>();
  for (const name of remove) {
    if (
      typeof name !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      new TextEncoder().encode(name).byteLength >
        MAX_CONFIGURATION_VARIABLE_NAME_BYTES ||
      removed.has(name) ||
      Object.prototype.hasOwnProperty.call(set, name)
    ) {
      return undefined;
    }
    removed.add(name);
  }
  if (
    Object.keys(set).some(
      (name) =>
        new TextEncoder().encode(name).byteLength >
        MAX_CONFIGURATION_VARIABLE_NAME_BYTES,
    )
  ) {
    return undefined;
  }
  return { set, remove: [...remove] as string[] };
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

async function configurationProviderBindingSet(input: {
  readonly targetInstallConfigId: string;
  readonly requestDigest: string;
  readonly capsule: Capsule;
  readonly bindings: ProviderBindings;
  readonly timestamp: string;
}): Promise<ProviderBindingSet> {
  const digest = await stableJsonDigest({
    kind: "capsule_configuration_provider_binding_set_v1",
    targetInstallConfigId: input.targetInstallConfigId,
    requestDigest: input.requestDigest,
  });
  return {
    id: `dpf_${digestSuffix(digest)}`,
    workspaceId: input.capsule.workspaceId,
    capsuleId: input.capsule.id,
    environment: input.capsule.environment,
    bindings: input.bindings,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  };
}

async function configurationEvidenceIdentity(input: {
  readonly requestDigest: string;
  readonly targetInstallConfigId: string;
  readonly targetProviderBindingSetDigest: string;
  readonly baseInstallConfigDigest: string;
  readonly sourceSnapshotId: string;
  readonly modulePath: string;
}): Promise<ConfigurationEvidenceIdentity> {
  const compatibilityDigest = await stableJsonDigest({
    kind: "capsule_configuration_compatibility_v1",
    ...input,
  });
  const compatibilitySuffix = digestSuffix(compatibilityDigest);
  return {
    compatibilityCheckRunId: `ccr_${compatibilitySuffix}`,
    compatibilityReportId: `caprep_${compatibilitySuffix}`,
    planRunId: `plan_${compatibilitySuffix}`,
    compatibilityCreatedBy:
      `capsule-configuration-plan:${input.targetInstallConfigId}:${compatibilitySuffix}`,
    planCreatedBy:
      `capsule-configuration-plan:${input.targetInstallConfigId}:${compatibilitySuffix}`,
  };
}

function rebindExpected(receipt: ReAdoptionReceipt): ReAdoptionCasExpected {
  return {
    installConfigId: receipt.previousInstallConfigId,
    installConfigDigest: receipt.previousInstallConfigDigest,
    currentStateGeneration: receipt.previousStateGeneration,
    currentStateVersionId: receipt.previousStateVersionId,
    status: receipt.previousCapsuleStatus,
    executionAuthorityEpoch: receipt.previousExecutionAuthorityEpoch,
    ...(receipt.committedPostApplyRecovery
      ? { committedPostApplyRecovery: receipt.committedPostApplyRecovery }
      : {}),
  };
}

async function exactConfigurationTarget(
  actual: InstallConfig,
  expected: InstallConfig,
  requestDigest: string,
): Promise<boolean> {
  return actual.internal?.reAdoption?.requestDigest === requestDigest &&
    (await hasValidDerivedTargetSeal(actual)) &&
    (await stableJsonDigest(actual)) === (await stableJsonDigest(expected));
}

async function installConfigIfPresent(
  ctx: ControlDispatchContext,
  id: string,
): Promise<InstallConfig | undefined> {
  try {
    return await ctx.operations.capsules.getInstallConfig(id);
  } catch (error) {
    if (
      error instanceof OpenTofuControllerError && error.code === "not_found"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function configurationTargetInstallConfigId(input: {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly actorSubject: string;
  readonly idempotencyKeyHash: string;
}): Promise<string> {
  const digest = await stableJsonDigest({
    kind: "capsule_configuration_plan_v1",
    ...input,
  });
  return `icfg_${digestSuffix(digest)}`;
}

function digestSuffix(digest: string): string {
  return digest.replace(/^sha256:/u, "").slice(0, 16);
}

function idempotencyKey(raw: string | null): string | undefined {
  if (!raw || raw.trim() !== raw || /[\u0000-\u001f\u007f]/u.test(raw)) {
    return undefined;
  }
  return new TextEncoder().encode(raw).byteLength <= MAX_IDEMPOTENCY_KEY_BYTES
    ? raw
    : undefined;
}

function authorityConflict(request: Request): Response {
  return errorJson(
    "failed_precondition",
    "The Capsule configuration authority changed before planning.",
    409,
    request,
    {},
    { reason: "capsule_install_config_rebind_conflict" },
  );
}

function idempotencyConflict(request: Request): Response {
  return errorJson(
    "idempotency_conflict",
    "The Idempotency-Key is already bound to another Capsule configuration request.",
    409,
    request,
  );
}

function configurationIdentityConflict(
  message: string,
): OpenTofuControllerError {
  return new OpenTofuControllerError(
    "failed_precondition",
    message,
    { reason: "capsule_configuration_identity_conflict" },
  );
}
