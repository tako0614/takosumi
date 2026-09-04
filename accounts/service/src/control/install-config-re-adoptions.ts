import type { JsonValue } from "takosumi-contract";
import type {
  Capsule,
  CapsuleInstallConfigReAdoptionResponse,
  CreateCapsuleInstallConfigReAdoptionRequest,
  InstallConfig,
  InstallConfigCommittedPostApplyRecoveryProof,
} from "takosumi-contract/install-configs";
import type { RepositoryManifestDocument } from "takosumi-contract/repository-manifest";
import type { Source, SourceSnapshot } from "takosumi-contract/sources";

import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import {
  containsSecretLikeString,
  isSecretKey,
} from "../../../../contract/redaction.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import type { ControlPlaneOperations } from "../control-operations.ts";
import {
  errorJson,
  json,
  methodNotAllowed,
  readJsonObject,
} from "../http-helpers.ts";
import {
  publicCapsule,
  type ControlDispatchContext,
} from "./shared.ts";
import { isPlainJsonObject, modulePathValue } from "./parse.ts";
import { DEFAULT_CAPSULE_INSTALL_CONFIG_ID } from "../../../../core/domains/capsules/default_install_config.ts";
import {
  adoptRepoOwnedInstallConfig,
  resolveRepoOwnedInstallModulePath,
} from "./repo-owned-install-config.ts";

const MAX_IDEMPOTENCY_KEY_BYTES = 256;
const MAX_REASON_BYTES = 256;
const MAX_REVIEWED_USER_VARIABLE_JSON_DEPTH = 32;
const MAX_REVIEWED_USER_VARIABLE_JSON_NODES = 4_096;
const MAX_REVIEWED_USER_VARIABLE_JSON_KEY_BYTES = 256;
const MAX_REVIEWED_USER_VARIABLE_JSON_STRING_BYTES = 32 * 1_024;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const EMPTY_DERIVED_TARGET_DIGEST = `sha256:${"0".repeat(64)}`;
const UTF8_ENCODER = new TextEncoder();

interface ReAdoptionReceipt {
  readonly capsuleId: string;
  readonly actorSubject: string;
  readonly reason: string;
  readonly idempotencyKeyHash: string;
  readonly requestDigest: string;
  readonly previousInstallConfigId: string;
  readonly previousInstallConfigDigest: string;
  readonly previousCapsuleStatus: Capsule["status"];
  readonly previousStateGeneration: number;
  readonly previousStateVersionId?: string;
  readonly previousExecutionAuthorityEpoch: number;
  readonly authorityGuard: string;
  readonly committedPostApplyRecovery?:
    InstallConfigCommittedPostApplyRecoveryProof;
  readonly derivedTargetDigest: string;
  readonly baseInstallConfigId: string;
  readonly sourceSnapshotId: string;
}

interface ReAdoptionAuthoritySnapshot {
  readonly capsule: Capsule;
  readonly installConfig: InstallConfig;
  readonly installConfigDigest: string;
  readonly executionAuthorityEpoch: number;
  readonly committedPostApplyRecovery?:
    InstallConfigCommittedPostApplyRecoveryProof;
  readonly authorityGuard: string;
}

interface ReAdoptionCasExpected {
  readonly installConfigId: string;
  readonly installConfigDigest: string;
  readonly currentStateGeneration: number;
  readonly currentStateVersionId: string | undefined;
  readonly status: Capsule["status"];
  readonly executionAuthorityEpoch: number;
  readonly committedPostApplyRecovery?:
    InstallConfigCommittedPostApplyRecoveryProof;
}

/** Opaque value-free guard issued only after the Capsule route authorizes access. */
export async function capsuleInstallConfigReAdoptionGuard(
  operations: ControlPlaneOperations,
  capsule: Capsule,
): Promise<string> {
  const snapshot = await reAdoptionAuthoritySnapshot(
    operations,
    capsule.id,
  );
  if (snapshot.capsule.workspaceId !== capsule.workspaceId) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "Capsule Workspace authority changed while issuing the re-adoption guard.",
    );
  }
  return snapshot.authorityGuard;
}

export async function handleCapsuleInstallConfigReAdoption(
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
      "Re-adoption requires a SourceSnapshot, bounded reason, exact current Capsule authority guard, and an optional JSON reviewed-user-variable record.",
      400,
      ctx.request,
    );
  }
  const actorSubject = ctx.session.subject;
  const idempotencyKeyHash = await stableJsonDigest(key);
  const requestDigest = await stableJsonDigest({
    operation: "capsule_install_config_re_adoption_v1",
    capsuleId: capsule.id,
    ...request,
  });
  const targetInstallConfigId = await targetId({
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    actorSubject,
    idempotencyKeyHash,
  });

  const replay = await existingTarget(
    ctx.operations,
    targetInstallConfigId,
  );
  if (replay) {
    if (
      replay.capsuleId !== capsule.id ||
      replay.actorSubject !== actorSubject ||
      replay.idempotencyKeyHash !== idempotencyKeyHash ||
      replay.requestDigest !== requestDigest
    ) {
      return idempotencyConflict(ctx.request);
    }
    const replayTarget = await ctx.operations.capsules.getInstallConfig(
      targetInstallConfigId,
    );
    if (!(await hasValidDerivedTargetSeal(replayTarget))) {
      return idempotencyConflict(ctx.request);
    }
    return await rebindResponse({
      operations: ctx.operations,
      capsule,
      targetInstallConfigId,
      target: replayTarget,
      actorSubject,
      requestDigest,
      reason: replay.reason,
      expected: {
        installConfigId: replay.previousInstallConfigId,
        installConfigDigest: replay.previousInstallConfigDigest,
        currentStateGeneration: replay.previousStateGeneration,
        currentStateVersionId: replay.previousStateVersionId,
        status: replay.previousCapsuleStatus,
        executionAuthorityEpoch: replay.previousExecutionAuthorityEpoch,
        ...(replay.committedPostApplyRecovery
          ? {
            committedPostApplyRecovery:
              replay.committedPostApplyRecovery,
          }
          : {}),
      },
    });
  }

  const authority = await reAdoptionAuthoritySnapshot(
    ctx.operations,
    capsule.id,
  );
  if (authority.authorityGuard !== request.expected.authorityGuard) {
    return errorJson(
      "failed_precondition",
      "The Capsule authority guard changed before re-adoption.",
      409,
      ctx.request,
      {},
      { reason: "capsule_install_config_rebind_conflict" },
    );
  }
  const current = authority.capsule;
  const currentConfig = authority.installConfig;
  const currentDigest = authority.installConfigDigest;
  if (
    current.status === "destroyed" ||
    current.status === "disabled" ||
    (await ctx.operations.gitInstallPlans.hasInFlightRevisionForCapsule(
      current.id,
    ))
  ) {
    return errorJson(
      "failed_precondition",
      "The Capsule is not available for InstallConfig re-adoption.",
      409,
      ctx.request,
      {},
      { reason: "capsule_install_config_rebind_busy" },
    );
  }

  const { source } = await ctx.operations.getSource(current.sourceId);
  const sourceSnapshot = await ctx.operations.getSourceSnapshot(
    request.sourceSnapshotId,
  );
  if (
    source.id !== current.sourceId ||
    source.workspaceId !== current.workspaceId ||
    source.status !== "active" ||
    sourceSnapshot.sourceId !== source.id ||
    sourceSnapshot.workspaceId !== current.workspaceId
  ) {
    return errorJson(
      "failed_precondition",
      "The SourceSnapshot is not current authority for this Capsule Source.",
      409,
      ctx.request,
    );
  }
  // A re-adoption may use the generic host InstallConfig or an operator-
  // explicitly supplied generic shared config. Legacy Store deployment
  // profiles are intentionally not read here; their source-URL catalog is
  // historical data and cannot contribute provider, policy, or module
  // authority.
  const resolved = await resolveReAdoptionBaseInstallConfig({
    operations: ctx.operations,
    source,
    sourceSnapshot,
    baseInstallConfigId: request.baseInstallConfigId,
  });
  if (!resolved.ok) {
    return errorJson(
      "failed_precondition",
      resolved.message,
      409,
      ctx.request,
    );
  }
  const { baseConfig, modulePath } = resolved;
  const reviewedVariables = jsonRecord(currentConfig.variableMapping);
  if (!reviewedVariables) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "The current InstallConfig variable mapping is not re-adoptable.",
    );
  }
  const reviewedUserVariables = reAdoptionReviewedUserVariables({
    document:
      sourceSnapshot.repositoryManifest?.status === "present"
        ? sourceSnapshot.repositoryManifest.document
        : undefined,
    // The scanner/compatibility modulePath is relative to Source.path, while
    // repository manifest keys are repository-root-relative. Translate only
    // for this optional input-assistance lookup; execution keeps `modulePath`.
    modulePath: repositoryManifestModulePath(sourceSnapshot, modulePath) ??
      modulePath,
    values: reviewedVariables,
    requested: request.reviewedUserVariables,
    baseValues: baseConfig.variableMapping,
  });
  if (!reviewedUserVariables.ok) {
    return errorJson(
      "failed_precondition",
      reviewedUserVariables.message,
      409,
      ctx.request,
    );
  }
  const compatibility = await ctx.operations.createSourceCompatibilityCheck(
    source.id,
    {
      sourceSnapshotId: sourceSnapshot.id,
      modulePath,
      installConfigId: baseConfig.id,
    },
  );
  const adoption = await adoptRepoOwnedInstallConfig({
    operations: ctx.operations,
    source,
    sourceSnapshot,
    baseConfig,
    modulePath,
    capsuleName: current.name,
    workspaceId: current.workspaceId,
    reviewedVariables: reviewedUserVariables.values,
    reviewedInterfaceBlueprints: currentConfig.interfaceBlueprints,
    reviewedOutputAllowlist: currentConfig.outputAllowlist,
    installingPrincipalId:
      current.installingPrincipalId ?? actorSubject,
    compatibilityReport: compatibility.report,
    requireReviewedValues: request.reviewedUserVariables === undefined
      ? false
      : true,
  });
  if (adoption.status !== "accepted") {
    return errorJson(
      "failed_precondition",
      adoption.status === "invalid"
        ? adoption.diagnostic.message
        : "The repository has no re-adoptable InstallConfig declaration.",
      409,
      ctx.request,
    );
  }
  // This timestamp only orders immutable InstallConfig authority and stays
  // deterministic for same-key callers. OIDC activation is fenced separately
  // by the Capsule epoch + exact config/profile digest, never by wall-clock
  // ordering against an Accounts row.
  const now = nextInstallConfigAuthorityTimestamp([
    current.updatedAt,
    currentConfig.updatedAt,
    baseConfig.updatedAt,
    sourceSnapshot.fetchedAt,
  ]);
  const receiptCore: Omit<ReAdoptionReceipt, "derivedTargetDigest"> = {
    capsuleId: current.id,
    actorSubject,
    reason: request.reason,
    idempotencyKeyHash,
    requestDigest,
    previousInstallConfigId: currentConfig.id,
    previousInstallConfigDigest: currentDigest,
    previousCapsuleStatus: current.status,
    previousStateGeneration: current.currentStateGeneration,
    ...(current.currentStateVersionId
      ? { previousStateVersionId: current.currentStateVersionId }
      : {}),
    previousExecutionAuthorityEpoch: authority.executionAuthorityEpoch,
    authorityGuard: authority.authorityGuard,
    ...(authority.committedPostApplyRecovery
      ? {
        committedPostApplyRecovery: authority.committedPostApplyRecovery,
      }
      : {}),
    baseInstallConfigId: baseConfig.id,
    sourceSnapshotId: sourceSnapshot.id,
  };
  const provisionalTarget = derivedTarget({
    id: targetInstallConfigId,
    baseConfig,
    adoption,
    sourceUrl: source.url,
    sourcePath: source.defaultPath,
    capsuleName: current.name,
    workspaceId: current.workspaceId,
    receipt: {
      ...receiptCore,
      derivedTargetDigest: EMPTY_DERIVED_TARGET_DIGEST,
    },
    now,
  });
  const derivedTargetDigest = await stableJsonDigest(
    derivedTargetWithoutSeal(provisionalTarget),
  );
  const receipt: ReAdoptionReceipt = {
    ...receiptCore,
    derivedTargetDigest,
  };
  const target = derivedTarget({
    id: targetInstallConfigId,
    baseConfig,
    adoption,
    sourceUrl: source.url,
    sourcePath: source.defaultPath,
    capsuleName: current.name,
    workspaceId: current.workspaceId,
    receipt,
    now,
  });
  const created = await ctx.operations.capsules.createInstallConfigIfAbsent(
    target,
  );
  const canonicalTarget = created
    ? target
    : await ctx.operations.capsules.getInstallConfig(target.id);
  const canonicalReceipt = canonicalTarget.internal?.reAdoption;
  if (
    !canonicalReceipt ||
    canonicalReceipt.capsuleId !== current.id ||
    canonicalReceipt.actorSubject !== actorSubject ||
    canonicalReceipt.idempotencyKeyHash !== idempotencyKeyHash ||
    canonicalReceipt.requestDigest !== requestDigest
  ) {
    return idempotencyConflict(ctx.request);
  }
  const [canonicalTargetDigest, expectedTargetDigest] = await Promise.all([
    stableJsonDigest(canonicalTarget),
    stableJsonDigest(target),
  ]);
  if (
    canonicalTargetDigest !== expectedTargetDigest ||
    !(await hasValidDerivedTargetSeal(canonicalTarget))
  ) {
    return idempotencyConflict(ctx.request);
  }
  return await rebindResponse({
    operations: ctx.operations,
    capsule: current,
    targetInstallConfigId: canonicalTarget.id,
    target: canonicalTarget,
    actorSubject,
    requestDigest,
    reason: request.reason,
    expected: {
      installConfigId: currentConfig.id,
      installConfigDigest: currentDigest,
      currentStateGeneration: current.currentStateGeneration,
      currentStateVersionId: current.currentStateVersionId,
      status: current.status,
      executionAuthorityEpoch: authority.executionAuthorityEpoch,
      ...(authority.committedPostApplyRecovery
        ? {
          committedPostApplyRecovery: authority.committedPostApplyRecovery,
        }
        : {}),
    },
  });
}

function derivedTargetWithoutSeal(target: InstallConfig): unknown {
  const receipt = target.internal?.reAdoption;
  if (!receipt) return target;
  const {
    derivedTargetDigest: _derivedTargetDigest,
    ...receiptWithoutSeal
  } = receipt;
  return {
    ...target,
    internal: {
      ...target.internal,
      reAdoption: receiptWithoutSeal,
    },
  };
}

async function hasValidDerivedTargetSeal(
  target: InstallConfig,
): Promise<boolean> {
  const receipt = target.internal?.reAdoption;
  return Boolean(
    receipt &&
      DIGEST.test(receipt.derivedTargetDigest) &&
      (await stableJsonDigest(derivedTargetWithoutSeal(target))) ===
        receipt.derivedTargetDigest,
  );
}

function derivedTarget(input: {
  readonly id: string;
  readonly baseConfig: InstallConfig;
  readonly adoption: Extract<
    Awaited<ReturnType<typeof adoptRepoOwnedInstallConfig>>,
    { readonly status: "accepted" }
  >;
  readonly sourceUrl: string;
  readonly sourcePath: string;
  readonly capsuleName: string;
  readonly workspaceId: string;
  readonly receipt: ReAdoptionReceipt;
  readonly now: string;
}): InstallConfig {
  const {
    id: _id,
    name: _name,
    workspaceId: _workspaceId,
    internal: _internal,
    sourceSelector: _sourceSelector,
    modulePath: _modulePath,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...baseMaterial
  } = input.baseConfig;
  return {
    ...baseMaterial,
    id: input.id,
    workspaceId: input.workspaceId,
    name: `${input.capsuleName}-repository-re-adoption`,
    sourceSelector: { url: input.sourceUrl, path: input.sourcePath },
    modulePath: input.adoption.modulePath,
    internal: {
      reason: "per_install_overrides",
      sourceSnapshotId: input.adoption.sourceSnapshotId,
      repositoryInstallUxDigest: input.adoption.digest,
      reAdoption: input.receipt,
    },
    variablePresentation: input.adoption.variablePresentation,
    installExperience: input.adoption.installExperience,
    variableMapping: input.adoption.variableMapping,
    interfaceBlueprints: input.adoption.interfaceBlueprints,
    ...(input.adoption.requiredInterfaces
      ? { requiredInterfaces: input.adoption.requiredInterfaces }
      : {}),
    ...(input.adoption.runtimeBindingMaterialization !== undefined
      ? {
          runtimeBindingMaterialization:
            input.adoption.runtimeBindingMaterialization,
        }
      : {}),
    outputAllowlist: input.adoption.outputAllowlist,
    ...(input.adoption.sourceBuild
      ? { sourceBuild: input.adoption.sourceBuild }
      : {}),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

async function rebindResponse(input: {
  readonly operations: ControlPlaneOperations;
  readonly capsule: Capsule;
  readonly targetInstallConfigId: string;
  readonly target: InstallConfig;
  readonly actorSubject: string;
  readonly requestDigest: string;
  readonly reason: string;
  readonly expected: ReAdoptionCasExpected;
}): Promise<Response> {
  const sourceSnapshotId = input.target.internal?.reAdoption?.sourceSnapshotId;
  if (!sourceSnapshotId) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "The immutable re-adoption target has no SourceSnapshot authority.",
    );
  }
  const result = await input.operations.capsules.rebindInstallConfig({
    capsuleId: input.capsule.id,
    targetInstallConfigId: input.targetInstallConfigId,
    expected: input.expected,
    actorSubject: input.actorSubject,
    reason: input.reason,
    requestDigest: input.requestDigest,
  });
  return json({
    capsule: publicCapsule(result.capsule),
    installConfigReAdoption: {
      replayed: result.replayed,
      previousInstallConfigId: input.expected.installConfigId,
      previousInstallConfigDigest: input.expected.installConfigDigest,
      targetInstallConfigId: input.target.id,
      targetInstallConfigDigest: result.targetInstallConfigDigest,
      sourceSnapshotId,
    },
  } satisfies CapsuleInstallConfigReAdoptionResponse);
}

async function existingTarget(
  operations: ControlPlaneOperations,
  id: string,
): Promise<ReAdoptionReceipt | undefined> {
  try {
    const target = await operations.capsules.getInstallConfig(id);
    return target.internal?.reAdoption;
  } catch (error) {
    if (error instanceof OpenTofuControllerError && error.code === "not_found") {
      return undefined;
    }
    throw error;
  }
}

type ReAdoptionBaseInstallConfigResolution =
  | {
      readonly ok: true;
      readonly baseConfig: InstallConfig;
      readonly modulePath: string;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

async function resolveReAdoptionBaseInstallConfig(input: {
  readonly operations: ControlPlaneOperations;
  readonly source: Source;
  readonly sourceSnapshot: SourceSnapshot;
  readonly baseInstallConfigId: string | undefined;
}): Promise<ReAdoptionBaseInstallConfigResolution> {
  const configId = input.baseInstallConfigId ?? DEFAULT_CAPSULE_INSTALL_CONFIG_ID;
  let baseConfig: InstallConfig;
  try {
    baseConfig = await input.operations.capsules.getInstallConfig(configId);
  } catch (error) {
    if (
      !(error instanceof OpenTofuControllerError) ||
      error.code !== "not_found"
    ) {
      throw error;
    }
    return {
      ok: false,
      message:
        input.baseInstallConfigId === undefined
          ? "The generic host InstallConfig is unavailable."
          : "The requested generic host InstallConfig is unavailable.",
    };
  }
  // Explicit base configs are an operator choice only when they are genuinely
  // generic shared policy. Source-URL/Store rows (including legacy profile
  // rows) are rejected before any provider or policy fields are read.
  if (
    baseConfig.workspaceId !== undefined ||
    baseConfig.internal !== undefined ||
    baseConfig.sourceSelector !== undefined ||
    baseConfig.store !== undefined
  ) {
    return {
      ok: false,
      message:
        "The requested InstallConfig is not a generic host policy configuration.",
    };
  }
  const moduleSelection = resolveRepoOwnedInstallModulePath({
    sourceSnapshot: input.sourceSnapshot,
  });
  // Re-adoption must never recover a module from Source.defaultPath or any
  // legacy InstallConfig/manifest key. A missing, malformed, stale, or
  // ambiguous source-sync index is a hard fail-closed condition.
  if (!moduleSelection.ok) {
    return {
      ok: false,
      message: moduleSelection.diagnostic.message,
    };
  }
  return {
    ok: true,
    baseConfig,
    modulePath: moduleSelection.modulePath,
  };
}

async function reAdoptionAuthoritySnapshot(
  operations: ControlPlaneOperations,
  capsuleId: string,
): Promise<ReAdoptionAuthoritySnapshot> {
  const capsule = await operations.capsules.getCapsule(capsuleId);
  const installConfig = await operations.capsules.getInstallConfig(
    capsule.installConfigId,
  );
  const [
    installConfigDigest,
    executionAuthorityEpoch,
    committedPostApplyRecovery,
  ] = await Promise.all([
    stableJsonDigest(installConfig),
    operations.capsules.getCapsuleExecutionAuthorityEpoch(capsule.id),
    operations.capsules.getInstallConfigReAdoptionRecoveryProof?.(capsule.id) ??
      Promise.resolve(undefined),
  ]);
  const authorityGuard = await stableJsonDigest({
    contract: "takosumi.capsule-install-config-re-adoption-guard/v1",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    installConfigId: capsule.installConfigId,
    installConfigDigest,
    status: capsule.status,
    currentStateGeneration: capsule.currentStateGeneration,
    currentStateVersionId: capsule.currentStateVersionId ?? null,
    executionAuthorityEpoch,
    committedPostApplyRecovery: committedPostApplyRecovery ?? null,
  });
  return {
    capsule,
    installConfig,
    installConfigDigest,
    executionAuthorityEpoch,
    ...(committedPostApplyRecovery
      ? { committedPostApplyRecovery }
      : {}),
    authorityGuard,
  };
}

async function targetId(input: {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly actorSubject: string;
  readonly idempotencyKeyHash: string;
}): Promise<string> {
  const digest = await stableJsonDigest({
    kind: "capsule_install_config_re_adoption_v1",
    ...input,
  });
  return `icfg_${digest.replace(/^sha256:/u, "").slice(0, 16)}`;
}

function parseRequest(
  value: Readonly<Record<string, unknown>>,
): CreateCapsuleInstallConfigReAdoptionRequest | undefined {
  const allowed = new Set([
    "baseInstallConfigId",
    "sourceSnapshotId",
    "reason",
    "reviewedUserVariables",
    "expected",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (!isPlainJsonObject(value.expected)) return undefined;
  const expected = value.expected;
  const expectedAllowed = new Set(["authorityGuard"]);
  if (Object.keys(expected).some((key) => !expectedAllowed.has(key))) {
    return undefined;
  }
  const baseInstallConfigId =
    value.baseInstallConfigId === undefined
      ? undefined
      : exactString(value.baseInstallConfigId);
  if (
    value.baseInstallConfigId !== undefined &&
    baseInstallConfigId === undefined
  ) {
    return undefined;
  }
  const sourceSnapshotId = exactString(value.sourceSnapshotId);
  const reason = exactString(value.reason);
  const reviewedUserVariables = value.reviewedUserVariables === undefined
    ? undefined
    : reviewedUserVariablesRecord(value.reviewedUserVariables);
  const authorityGuard = exactString(expected.authorityGuard);
  if (
    (value.reviewedUserVariables !== undefined &&
      reviewedUserVariables === undefined) ||
    !sourceSnapshotId ||
    !reason ||
    new TextEncoder().encode(reason).byteLength > MAX_REASON_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(reason) ||
    containsSecretLikeString(reason) ||
    !authorityGuard ||
    !DIGEST.test(authorityGuard)
  ) {
    return undefined;
  }
  return {
    ...(baseInstallConfigId ? { baseInstallConfigId } : {}),
    sourceSnapshotId,
    reason,
    ...(reviewedUserVariables ? { reviewedUserVariables } : {}),
    expected: {
      authorityGuard,
    },
  };
}

function jsonRecord(
  value: unknown,
): Readonly<Record<string, JsonValue>> | undefined {
  try {
    const roundTrip = JSON.parse(JSON.stringify(value)) as unknown;
    return isPlainJsonObject(roundTrip)
      ? (roundTrip as Readonly<Record<string, JsonValue>>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validate caller-owned JSON iteratively before it can enter a request digest.
 * Top-level keys are manifest variable names; nested keys are user JSON and
 * therefore participate in the ordinary secret-key vocabulary.
 */
function reviewedUserVariablesRecord(
  value: unknown,
): Readonly<Record<string, JsonValue>> | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  const pending: {
    readonly value: unknown;
    readonly depth: number;
    readonly inspectObjectKeys: boolean;
  }[] = [{ value, depth: 0, inspectObjectKeys: false }];
  let discoveredNodes = 1;

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > MAX_REVIEWED_USER_VARIABLE_JSON_DEPTH) {
      return undefined;
    }
    if (current.value === null || typeof current.value === "boolean") {
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return undefined;
      continue;
    }
    if (typeof current.value === "string") {
      if (
        UTF8_ENCODER.encode(current.value).byteLength >
          MAX_REVIEWED_USER_VARIABLE_JSON_STRING_BYTES ||
        containsSecretLikeString(current.value)
      ) {
        return undefined;
      }
      continue;
    }
    if (!current.value || typeof current.value !== "object") return undefined;

    if (Array.isArray(current.value)) {
      if (
        discoveredNodes + current.value.length >
          MAX_REVIEWED_USER_VARIABLE_JSON_NODES
      ) {
        return undefined;
      }
      discoveredNodes += current.value.length;
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: current.value[index],
          depth: current.depth + 1,
          inspectObjectKeys: true,
        });
      }
      continue;
    }
    if (!isPlainJsonObject(current.value)) return undefined;
    const entries = Object.entries(current.value);
    if (
      discoveredNodes + entries.length >
        MAX_REVIEWED_USER_VARIABLE_JSON_NODES
    ) {
      return undefined;
    }
    discoveredNodes += entries.length;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]!;
      if (
        UTF8_ENCODER.encode(key).byteLength >
          MAX_REVIEWED_USER_VARIABLE_JSON_KEY_BYTES ||
        (current.inspectObjectKeys && isSecretKey(key))
      ) {
        return undefined;
      }
      pending.push({
        value: child,
        depth: current.depth + 1,
        inspectObjectKeys: true,
      });
    }
  }
  return value as Readonly<Record<string, JsonValue>>;
}

/**
 * An explicit request replaces every required non-secret user input plus the
 * exact selected optional set declared by the pinned repository module.
 * Optional omission therefore clears a prior mapping. The omitted-field
 * legacy path instead removes only values explicitly declared as non-user-
 * owned; undeclared current values remain so the compiler still rejects them.
 * In both paths Capsule/workspace names, module defaults, and host-materialized
 * values are compiled again from current authority.
 */
type ReAdoptionReviewedUserVariablesResult =
  | {
      readonly ok: true;
      readonly values: Readonly<Record<string, JsonValue>>;
    }
  | { readonly ok: false; readonly message: string };

function reAdoptionReviewedUserVariables(input: {
  readonly document: RepositoryManifestDocument | undefined;
  readonly modulePath: string;
  readonly values: Readonly<Record<string, JsonValue>>;
  readonly requested: Readonly<Record<string, JsonValue>> | undefined;
  readonly baseValues: Readonly<Record<string, unknown>>;
}): ReAdoptionReviewedUserVariablesResult {
  const modulePath = input.modulePath === "" ? "." : input.modulePath;
  const modules = input.document?.install.modules;
  if (!modules || !Object.prototype.hasOwnProperty.call(modules, modulePath)) {
    return input.requested === undefined
      ? { ok: true, values: input.values }
      : {
          ok: false,
          message:
            "The selected repository module does not declare a reviewable user-variable set.",
        };
  }
  const module = modules[modulePath];
  if (!module) {
    return input.requested === undefined
      ? { ok: true, values: input.values }
      : {
          ok: false,
          message:
            "The selected repository module does not declare a reviewable user-variable set.",
        };
  }
  const inputOwnershipByName = new Map(
    module.inputs.map(
      (declaration) => [declaration.name, declaration] as const,
    ),
  );
  if (input.requested !== undefined) {
    for (const declaration of module.inputs) {
      if (
        declaration.source.kind === "user" &&
        Object.prototype.hasOwnProperty.call(
          input.baseValues,
          declaration.name,
        )
      ) {
        return {
          ok: false,
          message:
            `The generic host policy mapping collides with the user input ${boundedVariableName(declaration.name)}.`,
        };
      }
    }
    for (const name of Object.keys(input.requested)) {
      const declaration = inputOwnershipByName.get(name);
      if (
        !declaration ||
        declaration.source.kind !== "user" ||
        declaration.secret === true
      ) {
        return {
          ok: false,
          message:
            `The reviewed value ${boundedVariableName(name)} is not a declared non-secret user input.`,
        };
      }
    }
    for (const declaration of module.inputs) {
      if (
        declaration.source.kind !== "user" ||
        declaration.secret === true ||
        declaration.required !== true ||
        Object.prototype.hasOwnProperty.call(
          input.requested,
          declaration.name,
        )
      ) {
        continue;
      }
      return {
        ok: false,
        message:
          `The complete reviewed user-variable set is missing ${boundedVariableName(declaration.name)}.`,
      };
    }
    return { ok: true, values: input.requested };
  }
  return {
    ok: true,
    values: Object.fromEntries(
      Object.entries(input.values).filter(([name]) => {
        const declaration = inputOwnershipByName.get(name);
        // Preserve undeclared values so the compiler can reject them. Only a
        // manifest declaration that explicitly assigns a non-user source is
        // re-derived during re-adoption.
        return declaration === undefined || declaration.source.kind === "user";
      }),
    ),
  };
}

function boundedVariableName(value: string): string {
  return JSON.stringify(
    value.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 96),
  );
}

function repositoryManifestModulePath(
  snapshot: SourceSnapshot,
  modulePath: string,
): string | undefined {
  const parsedScopePath = modulePathValue(snapshot.path);
  const scopePath = parsedScopePath === "" ? "." : parsedScopePath;
  if (!scopePath) return undefined;
  if (scopePath === ".") return modulePath;
  return modulePath === "." ? scopePath : `${scopePath}/${modulePath}`;
}

function exactString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() === value && value !== ""
    ? value
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : exactString(value);
}

function idempotencyKey(raw: string | null): string | undefined {
  if (!raw || raw.trim() !== raw || /[\u0000-\u001f\u007f]/u.test(raw)) {
    return undefined;
  }
  return new TextEncoder().encode(raw).byteLength <= MAX_IDEMPOTENCY_KEY_BYTES
    ? raw
    : undefined;
}

function idempotencyConflict(request: Request): Response {
  return errorJson(
    "idempotency_conflict",
    "The Idempotency-Key is already bound to another InstallConfig re-adoption request.",
    409,
    request,
  );
}

function nextInstallConfigAuthorityTimestamp(
  authorities: readonly (string | number)[],
): string {
  const millis = authorities.map((authority) =>
    typeof authority === "number" ? authority : Date.parse(authority),
  );
  if (
    millis.length === 0 ||
    millis.some(
      (value) =>
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value >= 8_640_000_000_000_000,
    )
  ) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "InstallConfig re-adoption authority timestamp is invalid.",
    );
  }
  return new Date(Math.max(...millis) + 1).toISOString();
}
