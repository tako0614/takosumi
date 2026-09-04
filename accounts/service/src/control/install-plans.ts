import type {
  CreateGitInstallPlanRequest,
  GitInstallPlan,
  GitInstallPlanDiagnostic,
  GitInstallPlanProviderBindingRequest,
  GitInstallPlanResponse,
  GitInstallPlanSourceRequest,
  JsonValue,
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
import {
  OpenTofuControllerError,
  structuredErrorReason,
} from "../../../../core/domains/deploy-control/errors.ts";
import {
  GIT_INSTALL_PLAN_RECONCILE_LEASE_MS,
  publicGitInstallPlan,
  type StoredGitInstallPlan,
} from "../../../../core/domains/install-plans/store.ts";
import { evaluateSourceUrl } from "../../../../core/domains/sources/url-policy.ts";
import type { InstallPlanCompatibilityCheckRequest } from "../../../../core/domains/sources/mod.ts";
import type { ControlPlaneOperations } from "../control-operations.ts";
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
const MAX_SOURCE_INVENTORY = 500;
const MAX_DIAGNOSTIC_CODE = 64;
const MAX_DIAGNOSTIC_MESSAGE = 256;
const MAX_DIAGNOSTIC_REASON = 128;
const DIAGNOSTIC_TOKEN = /^[A-Za-z][A-Za-z0-9._:-]*$/u;
const CONNECTION_REFERENCE_PATTERN = /^conn_[0-9A-Za-z]{8,64}$/u;
const PROVIDER_SOURCE_PATTERN =
  /^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[a-z0-9_-]+\/[a-z0-9_-]+$/u;
const MAX_PROVIDER_BINDINGS = 32;

/** POST /api/v1/workspaces/:workspaceId/install-plans (Workspace auth is done by the parent handler). */
export async function handleWorkspaceInstallPlans(
  ctx: ControlDispatchContext,
  workspaceId: string,
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
  const parsed = body ? parseCreateRequest(body) : undefined;
  if (!parsed) {
    return errorJson(
      "invalid_request",
      "The install plan must contain only a normalized Git Source, Capsule name/environment, and safe option references. Variable values are not accepted without an exact reviewed preflight.",
      400,
      ctx.request,
    );
  }
  let preflightAuthority:
    | {
        readonly installConfigDigest: string;
        readonly baseInstallConfigId: string;
        readonly baseInstallConfigDigest: string;
      }
    | undefined;
  if (parsed.preflight) {
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
      parsed.preflight.installConfigId,
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
  const requestDigest = await stableJsonDigest(parsed);
  const idempotencyKeyHash = await stableJsonDigest(key);
  const now = new Date().toISOString();
  const plan: StoredGitInstallPlan = {
    id: installPlanId(),
    workspaceId,
    createdBy: ctx.session.subject,
    actorSubject: ctx.session.subject,
    idempotencyKeyHash,
    requestDigest,
    operation: "install",
    source: parsed.source,
    capsule: parsed.capsule,
    options: parsed.options ?? {},
    ...(parsed.preflight
      ? {
          preflight: parsed.preflight,
          sourceId: parsed.preflight.sourceId,
          sourceSnapshotId: parsed.preflight.sourceSnapshotId,
          installConfigBaseId: preflightAuthority!.baseInstallConfigId,
          installConfigBaseDigest:
            preflightAuthority!.baseInstallConfigDigest,
          preflightInstallConfigDigest:
            preflightAuthority!.installConfigDigest,
          compatibilityCheckRunId:
            parsed.preflight.compatibilityCheckRunId,
          compatibilityReportId: parsed.preflight.compatibilityReportId,
        }
      : {}),
    ...(parsed.variables ? { initialVariables: parsed.variables } : {}),
    ...(parsed.initialConfiguration
      ? { initialConfiguration: parsed.initialConfiguration }
      : {}),
    phase: parsed.preflight ? "creating_capsule" : "syncing_source",
    generation: 0,
    createdAt: now,
    updatedAt: now,
  };
  const result = await ctx.operations.gitInstallPlans.create(plan);
  if (result.status === "conflict") {
    return errorJson(
      "idempotency_conflict",
      "This Idempotency-Key was already used for a different install-plan request in the same Workspace and actor scope.",
      409,
      ctx.request,
    );
  }
  return installPlanJson(
    result.plan,
    result.status === "created" ? 201 : 200,
  );
}

/** GET/POST /api/v1/install-plans/:id[/reconcile]. GET performs no mutation. */
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
    if (method !== "GET") return methodNotAllowed("GET");
    // Deliberately no claim, reconcile, canonical-resource write, or timestamp
    // update here. Polling GET is a pure durable-record read.
    return installPlanJson(plan);
  }
  if (segments.length === 3 && segments[2] === "reconcile") {
    if (method !== "POST") return methodNotAllowed("POST");
    return await reconcileInstallPlan(ctx, plan);
  }
  return undefined;
}

async function reconcileInstallPlan(
  ctx: ControlDispatchContext,
  observed: StoredGitInstallPlan,
): Promise<Response> {
  if (observed.phase === "reviewable" || observed.phase === "failed") {
    return installPlanJson(observed);
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
    if (error instanceof PermanentInstallPlanError) {
      outcome = {
        plan: failedPlan(acquired.plan, error.diagnostic),
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
  const completed = await ctx.operations.gitInstallPlans.completeReconcile({
    id: observed.id,
    expectedGeneration: acquired.plan.generation,
    leaseToken: acquired.leaseToken,
    plan: outcome.plan,
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
  return installPlanJson(completed.plan, outcome.retryable ? 202 : 200);
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
      return { plan: await createCapsule(plan, ctx), retryable: false };
    case "planning":
      return {
        plan: await createOrObservePlanRun(plan, ctx.operations),
        retryable: false,
      };
    case "reviewable":
    case "failed":
      return { plan, retryable: false };
  }
}

async function advanceSource(
  plan: StoredGitInstallPlan,
  operations: ControlPlaneOperations,
): Promise<StoredGitInstallPlan> {
  let sourceId = plan.sourceId;
  if (!sourceId) {
    const inventory = await operations.listSources(plan.workspaceId, {
      limit: MAX_SOURCE_INVENTORY,
    });
    const matches = inventory.sources.filter((source) =>
      sourceMatchesPlan(source, plan),
    );
    if (matches.length > 1) {
      throw permanent(
        "source_identity_ambiguous",
        "More than one Source matches the immutable install-plan address.",
      );
    }
    if (matches[0]) {
      sourceId = matches[0].id;
    } else {
      if (inventory.nextCursor) {
        throw permanent(
          "source_inventory_incomplete",
          "The bounded Source inventory cannot prove that creating another Source is safe.",
        );
      }
      const created = await operations.createSource({
        workspaceId: plan.workspaceId,
        name: plan.source.name,
        url: plan.source.url,
        defaultRef: plan.source.ref,
        defaultPath: plan.source.path,
        ...(plan.source.authConnectionId
          ? { authConnectionId: plan.source.authConnectionId }
          : {}),
      });
      // `hookSecret` is deliberately discarded at the call boundary.
      sourceId = created.source.id;
    }
    return progressed(plan, { sourceId });
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
    const candidates = (await operations.listRuns(plan.workspaceId, {
      limit: MAX_SOURCE_INVENTORY,
    }))
      .filter(
        (run) =>
          run.type === "source_sync" &&
          run.sourceId === sourceId &&
          run.ref === plan.source.ref &&
          run.createdAt >= plan.createdAt,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (candidates[0]) {
      sync = await operations.getSourceSyncRun(candidates[0].id);
    } else {
      sync = (
        await operations.createSourceSync(sourceId, {
          intent: "manual_plan",
          dedupe: true,
        })
      ).run;
    }
  }
  return sourceSyncProgress(plan, sync, operations);
}

async function sourceSyncProgress(
  plan: StoredGitInstallPlan,
  sync: SourceSyncRun,
  operations: ControlPlaneOperations,
): Promise<StoredGitInstallPlan> {
  if (
    sync.workspaceId !== plan.workspaceId ||
    sync.sourceId !== plan.sourceId ||
    sync.ref !== plan.source.ref ||
    sync.path !== plan.source.path
  ) {
    throw permanent(
      "source_sync_scope_mismatch",
      "The Source sync evidence does not match this install plan.",
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
    plan.sourceId!,
    sync.snapshotId,
  );
  if (!snapshotMatchesPlan(snapshot, plan)) {
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
      persist: false,
    });
    if (!installConfig.ok) {
      return failedPlan(plan, installConfig.diagnostic);
    }
    return progressed(plan, {
      installConfigId: installConfig.installConfig.id,
      installConfigBaseId: base.installConfig.id,
      installConfigBaseDigest,
      installModulePath: moduleSelection.modulePath,
      compatibilityRequestDigest: evidence.requestDigest,
      compatibilityCheckRunId: evidence.runId,
      compatibilityReportId: evidence.reportId,
      phase: "creating_capsule",
    });
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
  return progressed(plan, {
    installConfigId: preview.installConfig.id,
    phase: "creating_capsule",
  });
}

async function createCapsule(
  plan: StoredGitInstallPlan,
  ctx: ControlDispatchContext,
): Promise<StoredGitInstallPlan> {
  const operations = ctx.operations;
  const source = (await operations.getSource(plan.sourceId!)).source;
  if (!sourceMatchesPlan(source, plan) || source.status !== "active") {
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
  const materializedInstallConfig = plan.preflight
    ? await materializePreflightInitialInstallConfig({
        plan,
        operations,
        source,
        snapshot,
        compatibilityReport: compatibility.report,
      })
    : await materializeCoordinatorInitialInstallConfig({
        plan,
        operations,
        source,
        snapshot,
        compatibilityReport: compatibility.report,
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
  const created = await operations.capsules.createCapsuleInitialAuthority({
    capsuleId,
    workspaceId: plan.workspaceId,
    name: plan.capsule.name,
    environment: plan.capsule.environment,
    sourceId: source.id,
    installingPrincipalId: plan.createdBy,
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
  return progressed(completedPlan, {
    initialVariables: undefined,
    initialConfiguration: undefined,
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
      reviewedVariables: input.plan.initialVariables ?? {},
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
    input.plan.initialVariables ?? {},
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
    reviewedVariables: input.plan.initialVariables ?? {},
    persist: false,
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
    persist: false,
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

function deterministicInitialCapsuleId(planId: string): string {
  const suffix = planId.replace(/[^A-Za-z0-9]/gu, "").slice(-16);
  return `cap_${suffix.padStart(16, "0")}`;
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
    return progressed(plan, {
      planRunId: run.id,
      phase: "reviewable",
      completedAt: new Date().toISOString(),
    });
  }
  return progressed(plan, { planRunId: run.id });
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
    options = {
      ...(modulePath !== undefined ? { modulePath } : {}),
      ...(providerBindings !== undefined ? { providerBindings } : {}),
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
    const parsedVariables = jsonRecordValue(body.variables);
    if (
      !parsedVariables ||
      Object.keys(parsedVariables).length > 256 ||
      Object.keys(parsedVariables).some(
        (name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name),
      ) ||
      new TextEncoder().encode(JSON.stringify(parsedVariables)).byteLength >
        256 * 1024
    ) {
      return undefined;
    }
    variables = parsedVariables;
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
  readonly persist?: boolean;
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
  if (input.persist === false) {
    return { ok: true, installConfig: expected };
  }
  const created = await input.operations.capsules.createInstallConfigIfAbsent(
    expected,
  );
  const stored = created
    ? expected
    : await input.operations.capsules.getInstallConfig(expected.id);
  if (
    (await stableJsonDigest(stripInstallConfigTimestamps(stored))) !==
    (await stableJsonDigest(stripInstallConfigTimestamps(expected)))
  ) {
    return {
      ok: false,
      diagnostic: {
        code: "repository_install_module_config_identity_conflict",
        message:
          "The module InstallConfig did not persist its exact deterministic identity.",
      },
    };
  }
  return { ok: true, installConfig: stored };
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
): boolean {
  return (
    source.workspaceId === plan.workspaceId &&
    source.name === plan.source.name &&
    normalizeInstallConfigSourceUrl(source.url) === plan.source.url &&
    source.defaultRef === plan.source.ref &&
    source.defaultPath === plan.source.path &&
    (source.authConnectionId ?? undefined) ===
      (plan.source.authConnectionId ?? undefined)
  );
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

function planCreationStage(
  phase: StoredGitInstallPlan["phase"],
): NonNullable<GitInstallPlanDiagnostic["planCreationStage"]> {
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

function installPlanJson(
  stored: StoredGitInstallPlan,
  status = 200,
): Response {
  return json(installPlanResponse(publicGitInstallPlan(stored)), status, {
    "cache-control": "no-store",
  });
}

function installPlanResponse(plan: GitInstallPlan): GitInstallPlanResponse {
  const self = `/api/v1/install-plans/${encodeURIComponent(plan.id)}`;
  const terminal = plan.phase === "reviewable" || plan.phase === "failed";
  return {
    installPlan: plan,
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
