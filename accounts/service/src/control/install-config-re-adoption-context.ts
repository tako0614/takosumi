/** Read-only, Capsule-authorized user-input context for one existing revision. */
import type {
  CapsuleInstallConfigReAdoptionInputContext,
  CapsuleReAdoptionCurrentUserValue,
  CapsuleReAdoptionInputVariable,
} from "takosumi-contract";
import { normalizeInstallConfigSourceUrl, type Capsule, type InstallConfig } from "takosumi-contract/install-configs";
import type { SourceSnapshot } from "takosumi-contract/sources";
import { capsuleScopeRef, normalizeCompatibilityReportModulePath } from "takosumi-contract/capsules";
import { isSecretKey, REDACTED_VALUE } from "takosumi-contract/redaction";
import { compileRepositoryInstallUx } from "../../../../core/domains/capsules/repository_install_ux_compiler.ts";
import { redactedInstallConfigVariableMapping } from "../../../../core/domains/capsules/public_install_config.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import type { StoredGitInstallPlan } from "../../../../core/domains/install-plans/store.ts";
import { errorJson, json, methodNotAllowed } from "../http-helpers.ts";
import type { ControlDispatchContext } from "./shared.ts";
import {
  capsuleInstallConfigReAdoptionAuthoritySnapshot,
  resolveReAdoptionBaseInstallConfig,
  reviewedUserVariablesRecord,
} from "./install-config-re-adoptions.ts";
import { declaredRepositoryManifestModulePath, remapRepositoryManifestModule } from "./repo-owned-install-config.ts";
import { sameGitName } from "./revision-plans.ts";

export async function handleCapsuleReAdoptionInputContext(
  ctx: ControlDispatchContext,
  authorizedCapsule: Capsule,
  method: string,
): Promise<Response> {
  if (method !== "GET") return methodNotAllowed("GET");
  const values = new URL(ctx.request.url).searchParams.getAll("revisionPlanId");
  const revisionPlanId = values[0];
  if (values.length !== 1 || !revisionPlanId || revisionPlanId.trim() !== revisionPlanId ||
    revisionPlanId.length > 256) {
    return errorJson("invalid_request", "One exact revisionPlanId is required.", 400, ctx.request);
  }
  const authority = await capsuleInstallConfigReAdoptionAuthoritySnapshot(ctx.operations, authorizedCapsule.id);
  const capsule = authority.capsule;
  if (capsule.workspaceId !== authorizedCapsule.workspaceId || capsule.sourceId !== authorizedCapsule.sourceId) {
    return refused(ctx, "re_adoption_input_context_stale");
  }
  const plan = await ctx.operations.gitInstallPlans.get(revisionPlanId);
  if (!plan || !matchesCurrentRevision(plan, capsule, authority.installConfigDigest)) {
    return refused(ctx, "re_adoption_input_context_target_mismatch");
  }
  const source = (await ctx.operations.getSource(capsule.sourceId)).source;
  const snapshot = await ctx.operations.getSourceSnapshot(plan.sourceSnapshotId!);
  if (source.id !== capsule.sourceId || source.workspaceId !== capsule.workspaceId || source.status !== "active" ||
    snapshot.id !== plan.sourceSnapshotId || snapshot.sourceId !== source.id || snapshot.workspaceId !== capsule.workspaceId ||
    snapshot.origin !== "git" || normalizeInstallConfigSourceUrl(snapshot.url) !== normalizeInstallConfigSourceUrl(source.url) ||
    normalizeInstallConfigSourceUrl(plan.source.url) !== normalizeInstallConfigSourceUrl(source.url) ||
    snapshot.path !== plan.source.path || !sameGitName(snapshot.ref, plan.revision!.targetRef) ||
    !/^[0-9a-f]{40}$/iu.test(snapshot.resolvedCommit)) {
    return refused(ctx, "re_adoption_input_context_target_mismatch");
  }
  const resolved = await resolveReAdoptionBaseInstallConfig({ operations: ctx.operations, source, sourceSnapshot: snapshot, baseInstallConfigId: undefined });
  if (!resolved.ok || resolved.modulePath !== plan.installModulePath) {
    return refused(ctx, "re_adoption_input_context_module_unavailable");
  }
  const manifestPath = declaredRepositoryManifestModulePath(snapshot, resolved.modulePath);
  if (!manifestPath || snapshot.repositoryManifest?.status !== "present" || !plan.compatibilityReportId) {
    return refused(ctx, "re_adoption_input_context_metadata_unavailable");
  }
  const { report } = await ctx.operations.getCompatibilityReport(plan.compatibilityReportId);
  if (report.id !== plan.compatibilityReportId || report.sourceId !== source.id || report.sourceSnapshotId !== snapshot.id ||
    (report.capsuleId !== undefined && report.capsuleId !== capsule.id) ||
    normalizeCompatibilityReportModulePath(report.modulePath) !== resolved.modulePath || report.level !== "ready") {
    return refused(ctx, "re_adoption_input_context_metadata_unavailable");
  }
  // This existing compiler is pure. In particular, do not call the adoption
  // wrapper: that wrapper may scan and write a preview InstallConfig.
  const compiled = compileRepositoryInstallUx({
    document: remapRepositoryManifestModule(snapshot.repositoryManifest.document, manifestPath, resolved.modulePath),
    sourceSnapshotId: snapshot.id,
    modulePath: resolved.modulePath,
    compatibilityReport: report,
    capsuleName: capsule.name,
    workspaceId: capsuleScopeRef(capsule),
    requireReviewedValues: false,
    policy: {
      ...resolved.baseConfig.policy.repositoryInstallUx,
      allowedInterfacePermissions: resolved.baseConfig.policy.repositoryInstallUx?.allowedInterfacePermissions ?? [],
    },
  });
  if (!compiled.ok) return refused(ctx, "re_adoption_input_context_metadata_unavailable");
  const module = snapshot.repositoryManifest.document.install.modules[manifestPath]!;
  const currentSnapshot = await currentConfigurationSnapshot(ctx, capsule, authority.installConfig);
  const variables: CapsuleReAdoptionInputVariable[] = [];
  let blockedReason: CapsuleInstallConfigReAdoptionInputContext["blockedReason"];
  for (const declaration of module.inputs) {
    if (declaration.source.kind !== "user") continue;
    const presentation = compiled.compiled.variablePresentation.find((entry) => entry.name === declaration.name);
    if (declaration.secret === true || presentation?.secret === true || isSecretKey(declaration.name)) {
      blockedReason = "secret_inputs";
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(resolved.baseConfig.variableMapping, declaration.name)) {
      blockedReason ??= "host_policy_conflict";
      continue;
    }
    if (!presentation?.type || !["string", "number", "boolean", "json"].includes(presentation.type)) {
      blockedReason ??= "unsupported_inputs";
      continue;
    }
    variables.push({
      name: declaration.name, type: presentation.type,
      required: presentation.required === true, sensitive: false, userEditable: true,
      label: presentation.label,
      ...(presentation.helper ? { description: presentation.helper } : {}),
      ...(presentation.placeholder ? { placeholder: presentation.placeholder } : {}),
      ...(presentation.advanced !== undefined ? { advanced: presentation.advanced } : {}),
      currentValue: currentUserValue(authority.installConfig, currentSnapshot, resolved.modulePath, declaration.name, presentation.type),
    });
  }
  const [current, finalPlan] = await Promise.all([
    capsuleInstallConfigReAdoptionAuthoritySnapshot(ctx.operations, capsule.id),
    ctx.operations.gitInstallPlans.get(revisionPlanId),
  ]);
  if (current.authorityGuard !== authority.authorityGuard || !finalPlan ||
    revisionTargetIdentity(finalPlan) !== revisionTargetIdentity(plan)) {
    return refused(ctx, "re_adoption_input_context_stale");
  }
  const context: CapsuleInstallConfigReAdoptionInputContext = {
    capsuleId: capsule.id, revisionPlanId: plan.id, sourceId: source.id,
    sourceSnapshotId: snapshot.id, targetRef: plan.revision!.targetRef,
    resolvedCommit: snapshot.resolvedCommit, modulePath: resolved.modulePath,
    currentInstallConfigId: capsule.installConfigId,
    currentStateGeneration: capsule.currentStateGeneration,
    ...(capsule.currentStateVersionId ? { currentStateVersionId: capsule.currentStateVersionId } : {}),
    authorityGuard: authority.authorityGuard, baseInstallConfigId: resolved.baseConfig.id,
    variables, ...(blockedReason ? { blockedReason } : {}),
  };
  const response = json({ installConfigReAdoptionContext: context });
  response.headers.set("cache-control", "no-store");
  return response;
}

export function matchesCurrentRevision(plan: StoredGitInstallPlan, capsule: Capsule, configDigest: string): boolean {
  return plan.operation === "revision" && plan.workspaceId === capsule.workspaceId &&
    plan.capsuleId === capsule.id && plan.sourceId === capsule.sourceId &&
    plan.installConfigId === capsule.installConfigId && !!plan.sourceSnapshotId && !!plan.installModulePath &&
    typeof plan.revision?.targetRef === "string" &&
    plan.source.ref === plan.revision.targetRef && plan.capsule.name === capsule.name &&
    plan.capsule.environment === capsule.environment &&
    plan.revision.base.installConfigId === capsule.installConfigId &&
    plan.revision.base.installConfigDigest === configDigest &&
    plan.revision.base.capsuleStateGeneration === capsule.currentStateGeneration &&
    plan.revision.base.capsuleStateVersionId === capsule.currentStateVersionId;
}

export function revisionTargetIdentity(plan: StoredGitInstallPlan): string {
  return JSON.stringify([plan.operation, plan.workspaceId, plan.capsuleId, plan.sourceId,
    plan.sourceSnapshotId, plan.installModulePath, plan.compatibilityReportId, plan.installConfigId,
    plan.source, plan.capsule, plan.revision]);
}

async function currentConfigurationSnapshot(
  ctx: ControlDispatchContext, capsule: Capsule, config: InstallConfig,
): Promise<SourceSnapshot | undefined> {
  const id = config.internal?.sourceSnapshotId;
  if (!id) return undefined;
  try {
    const snapshot = await ctx.operations.getSourceSnapshot(id);
    return snapshot.id === id && snapshot.sourceId === capsule.sourceId && snapshot.workspaceId === capsule.workspaceId
      ? snapshot : undefined;
  } catch (error) {
    if (error instanceof OpenTofuControllerError && error.code === "not_found") return undefined;
    throw error;
  }
}

function currentUserValue(
  config: InstallConfig, snapshot: SourceSnapshot | undefined, targetModulePath: string,
  name: string, type: CapsuleReAdoptionInputVariable["type"],
): CapsuleReAdoptionCurrentUserValue {
  const modulePath = normalizeCompatibilityReportModulePath(config.modulePath ?? ".");
  if (!modulePath || modulePath !== targetModulePath || !snapshot) return { status: "unavailable" };
  const manifestPath = declaredRepositoryManifestModulePath(snapshot, modulePath);
  if (!manifestPath || snapshot.repositoryManifest?.status !== "present") return { status: "unavailable" };
  const declarations = snapshot.repositoryManifest.document.install.modules[manifestPath]!.inputs.filter((input) => input.name === name);
  if (declarations.length !== 1 || declarations[0]!.source.kind !== "user" || declarations[0]!.secret === true) return { status: "unavailable" };
  if (!Object.prototype.hasOwnProperty.call(config.variableMapping, name)) return { status: "unset" };
  const value = config.variableMapping[name];
  // The same bounds and secret-like rejection as the mutation, then the exact
  // existing public projection (including generic write-only/secret priority).
  const accepted = reviewedUserVariablesRecord({ [name]: value });
  if (!accepted || !matchesType(accepted[name], type)) return { status: "unavailable" };
  const selected = { ...config, variableMapping: { [name]: value } };
  const publicValue = redactedInstallConfigVariableMapping(selected)[name];
  const encoded = JSON.stringify(accepted[name]);
  if (encoded.includes(JSON.stringify(REDACTED_VALUE)) || JSON.stringify(publicValue) !== encoded) return { status: "unavailable" };
  return { status: "present", value: accepted[name]! };
}

function matchesType(value: unknown, type: CapsuleReAdoptionInputVariable["type"]): boolean {
  return type === "json" || (type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === type);
}

function refused(ctx: ControlDispatchContext, reason: string): Response {
  return errorJson("failed_precondition", "The exact revision input context is unavailable; read the current app and target again.", 409, ctx.request, {}, { reason });
}
