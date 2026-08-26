import type { JsonValue } from "takosumi-contract";
import type {
  Capsule,
  InstallConfig,
  PublicCapsule,
} from "takosumi-contract/install-configs";
import type { RepositoryManifestDocument } from "takosumi-contract/repository-manifest";

import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { containsSecretLikeString } from "../../../../contract/redaction.ts";
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
import { isPlainJsonObject } from "./parse.ts";
import {
  adoptRepoOwnedInstallConfig,
  resolveRepoOwnedDeploymentProfile,
} from "./repo-owned-install-config.ts";

const MAX_IDEMPOTENCY_KEY_BYTES = 256;
const MAX_REASON_BYTES = 256;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const EMPTY_DERIVED_TARGET_DIGEST = `sha256:${"0".repeat(64)}`;

interface ReAdoptionRequest {
  readonly baseInstallConfigId: string;
  readonly sourceSnapshotId: string;
  readonly deploymentProfileKey?: string;
  readonly reason: string;
  readonly expected: {
    readonly authorityGuard: string;
  };
}

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
  readonly derivedTargetDigest: string;
  readonly baseInstallConfigId: string;
  readonly sourceSnapshotId: string;
  readonly deploymentProfileKey?: string;
}

interface ReAdoptionAuthoritySnapshot {
  readonly capsule: Capsule;
  readonly installConfig: InstallConfig;
  readonly installConfigDigest: string;
  readonly executionAuthorityEpoch: number;
  readonly authorityGuard: string;
}

interface ReAdoptionCasExpected {
  readonly installConfigId: string;
  readonly installConfigDigest: string;
  readonly currentStateGeneration: number;
  readonly currentStateVersionId: string | undefined;
  readonly status: Capsule["status"];
  readonly executionAuthorityEpoch: number;
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
      "Re-adoption requires one base InstallConfig, SourceSnapshot, bounded reason, and exact current Capsule authority guard.",
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
  const sharedConfigs = await ctx.operations.capsules.listSharedInstallConfigs({
    includeInternal: false,
  });
  const profile = resolveRepoOwnedDeploymentProfile({
    source,
    sourceSnapshot,
    candidates: sharedConfigs,
    ...(request.deploymentProfileKey
      ? { deploymentProfileKey: request.deploymentProfileKey }
      : {}),
  });
  if (
    !profile.ok ||
    (profile.kind !== "profile" && profile.kind !== "legacy") ||
    profile.installConfig.id !== request.baseInstallConfigId
  ) {
    return errorJson(
      "failed_precondition",
      "The requested DB-owned deployment profile is unavailable for this SourceSnapshot.",
      409,
      ctx.request,
    );
  }
  const baseConfig = profile.installConfig;
  const modulePath =
    profile.kind === "profile"
      ? profile.modulePath
      : (baseConfig.modulePath ?? sourceSnapshot.path);
  const compatibility = await ctx.operations.createSourceCompatibilityCheck(
    source.id,
    {
      sourceSnapshotId: sourceSnapshot.id,
      modulePath,
      installConfigId: baseConfig.id,
    },
  );
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
    modulePath,
    values: reviewedVariables,
  });
  const adoption = await adoptRepoOwnedInstallConfig({
    operations: ctx.operations,
    source,
    sourceSnapshot,
    baseConfig,
    modulePath,
    capsuleName: current.name,
    workspaceId: current.workspaceId,
    reviewedVariables: reviewedUserVariables,
    reviewedInterfaceBlueprints: currentConfig.interfaceBlueprints,
    reviewedOutputAllowlist: currentConfig.outputAllowlist,
    installingPrincipalId:
      current.installingPrincipalId ?? actorSubject,
    compatibilityReport: compatibility.report,
    requireReviewedValues: false,
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
    baseInstallConfigId: baseConfig.id,
    sourceSnapshotId: sourceSnapshot.id,
    ...(request.deploymentProfileKey
      ? { deploymentProfileKey: request.deploymentProfileKey }
      : {}),
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
      sourceSnapshotId: input.target.internal?.sourceSnapshotId,
    },
  } satisfies {
    readonly capsule: PublicCapsule;
    readonly installConfigReAdoption: Readonly<Record<string, unknown>>;
  });
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

async function reAdoptionAuthoritySnapshot(
  operations: ControlPlaneOperations,
  capsuleId: string,
): Promise<ReAdoptionAuthoritySnapshot> {
  const capsule = await operations.capsules.getCapsule(capsuleId);
  const installConfig = await operations.capsules.getInstallConfig(
    capsule.installConfigId,
  );
  const [installConfigDigest, executionAuthorityEpoch] = await Promise.all([
    stableJsonDigest(installConfig),
    operations.capsules.getCapsuleExecutionAuthorityEpoch(capsule.id),
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
  });
  return {
    capsule,
    installConfig,
    installConfigDigest,
    executionAuthorityEpoch,
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
): ReAdoptionRequest | undefined {
  const allowed = new Set([
    "baseInstallConfigId",
    "sourceSnapshotId",
    "deploymentProfileKey",
    "reason",
    "expected",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (!isPlainJsonObject(value.expected)) return undefined;
  const expected = value.expected;
  const expectedAllowed = new Set(["authorityGuard"]);
  if (Object.keys(expected).some((key) => !expectedAllowed.has(key))) {
    return undefined;
  }
  const baseInstallConfigId = exactString(value.baseInstallConfigId);
  const sourceSnapshotId = exactString(value.sourceSnapshotId);
  const deploymentProfileKey = optionalString(value.deploymentProfileKey);
  if (
    value.deploymentProfileKey !== undefined &&
    deploymentProfileKey === undefined
  ) {
    return undefined;
  }
  const reason = exactString(value.reason);
  const authorityGuard = exactString(expected.authorityGuard);
  if (
    !baseInstallConfigId ||
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
    baseInstallConfigId,
    sourceSnapshotId,
    ...(deploymentProfileKey ? { deploymentProfileKey } : {}),
    reason,
    expected: {
      authorityGuard,
    },
  };
}

function jsonRecord(
  value: Readonly<Record<string, unknown>>,
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
 * Re-adoption removes only values explicitly declared as non-user-owned in the
 * pinned repository module. Capsule/workspace names, module defaults, and
 * host-materialized values are compiled again from current authority.
 * Undeclared values stay in the request so the compiler can reject them. This
 * projection is intentionally limited to this re-adoption route; ordinary
 * install flows still pass their complete request to the compiler.
 */
function reAdoptionReviewedUserVariables(input: {
  readonly document: RepositoryManifestDocument | undefined;
  readonly modulePath: string;
  readonly values: Readonly<Record<string, JsonValue>>;
}): Readonly<Record<string, JsonValue>> {
  const modulePath = input.modulePath === "" ? "." : input.modulePath;
  const modules = input.document?.install.modules;
  if (!modules || !Object.prototype.hasOwnProperty.call(modules, modulePath)) {
    return input.values;
  }
  const module = modules[modulePath];
  if (!module) return input.values;
  const inputOwnershipByName = new Map(
    module.inputs.map(
      (declaration) => [declaration.name, declaration.source.kind] as const,
    ),
  );
  return Object.fromEntries(
    Object.entries(input.values).filter(([name]) => {
      const inputOwnership = inputOwnershipByName.get(name);
      // Preserve undeclared values so the compiler can reject them. Only a
      // manifest declaration that explicitly assigns a non-user source is
      // re-derived during re-adoption.
      return inputOwnership === undefined || inputOwnership === "user";
    }),
  );
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
