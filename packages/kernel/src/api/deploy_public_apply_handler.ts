import type {
  JsonObject,
  ManifestResource,
  PlatformOperationRecoveryMode,
  PlatformTraceContext,
  ResourceHandle,
} from "takosumi-contract";
import type {
  ApplyV2Outcome,
  DestroyV2Outcome,
  OperationPlanPreview,
  PriorAppliedSnapshot,
} from "../domains/deploy/apply_v2.ts";
import {
  readDeploymentNameV1,
  resolveManifestResourcesV1,
} from "../domains/deploy/manifest_v1.ts";
import {
  appendOperationPlanJournalStages,
  type OperationJournalStore,
} from "../domains/deploy/operation_journal.ts";
import {
  recordsFromAppliedResources,
  type TakosumiDeploymentRecord,
  type TakosumiDeploymentRecordStore,
} from "../domains/deploy/takosumi_deployment_record_store.ts";
import {
  type DeployMetricOperationKind,
  type DeployMetricSink,
  recordDeployOperationMetric,
  startDeployMetricTimer,
} from "../domains/deploy/deploy_metrics.ts";
import type {
  RequestCorrelation,
  RequestTraceContext,
} from "./request_correlation.ts";
import type { RevokeDebtStore } from "../domains/deploy/revoke_debt_store.ts";
import { apiError } from "./errors.ts";
import { log } from "../shared/log.ts";
import {
  catalogReleaseHookDetailField,
  catalogReleaseWalHookDetail,
  handleCatalogReleasePostCommitFailure,
  handleCatalogReleasePreCommitFailure,
  invokeCatalogReleaseWalHook,
} from "./deploy_public_catalog_hooks.ts";
import {
  buildPublicOperationPlanPreview,
  handleRecoveryCompensate,
  handleRecoveryPreflight,
  providerIdForIntentPreview,
  withOperationPlanPreview,
} from "./deploy_public_recovery.ts";
import {
  attachProvenanceToResources,
  journalDetail,
  platformRecoveryMode,
  readDeployPublicProvenance,
  readMode,
  readRecoveryMode,
  validateManifestArtifactSizeQuota,
} from "./deploy_public_request_helpers.ts";
import { deployTraceFromRequest } from "./deploy_public_platform_context.ts";
import type {
  CatalogReleaseWalHookVerifier,
  DeployPublicDestroyResponse,
  DeployPublicHandledResponse,
  DeployPublicResponse,
} from "./deploy_public_types.ts";

export interface DeployPublicApplyHandlerDeps {
  readonly tenantId: string;
  readonly artifactMaxBytes: number;
  readonly recordStore: TakosumiDeploymentRecordStore;
  readonly operationJournalStore: OperationJournalStore;
  readonly revokeDebtStore: RevokeDebtStore;
  readonly catalogReleaseVerifier?: CatalogReleaseWalHookVerifier;
  readonly observability?: DeployMetricSink;
  readonly now: () => string;
  readonly applyResources: (
    resources: readonly ManifestResource[],
    priorApplied?: ReadonlyMap<string, PriorAppliedSnapshot>,
    dryRun?: boolean,
    operationPlanPreview?: OperationPlanPreview,
    recoveryMode?: PlatformOperationRecoveryMode,
    trace?: PlatformTraceContext,
  ) => Promise<ApplyV2Outcome>;
  readonly destroyResources: (
    resources: readonly ManifestResource[],
    handleFor?: (resource: ManifestResource) => ResourceHandle,
    operationPlanPreview?: OperationPlanPreview,
    recoveryMode?: PlatformOperationRecoveryMode,
    trace?: PlatformTraceContext,
  ) => Promise<DestroyV2Outcome>;
}

export async function executeDeployPublicPost(
  deps: DeployPublicApplyHandlerDeps,
  body: Record<string, unknown>,
  requestCorrelation?: RequestCorrelation,
  requestTrace?: RequestTraceContext,
): Promise<DeployPublicHandledResponse> {
  const {
    tenantId,
    artifactMaxBytes,
    recordStore,
    operationJournalStore,
    revokeDebtStore,
    catalogReleaseVerifier,
    observability,
    now,
    applyResources,
    destroyResources,
  } = deps;

  const rawManifest = body.manifest;
  const mode = readMode(body.mode);
  if (!mode.ok) {
    return {
      status: 400,
      body: apiError("invalid_argument", mode.error),
    };
  }
  const recoveryMode = readRecoveryMode(body.recoveryMode);
  if (!recoveryMode.ok) {
    return {
      status: 400,
      body: apiError("invalid_argument", recoveryMode.error),
    };
  }
  const resources = resolveManifestResourcesV1(rawManifest);
  if (!resources.ok) {
    return {
      status: 400,
      body: apiError("invalid_argument", resources.error),
    };
  }
  const provenance = readDeployPublicProvenance(body.provenance);
  if (!provenance.ok) {
    return {
      status: 400,
      body: apiError("invalid_argument", provenance.error),
    };
  }
  const manifestObject = (rawManifest && typeof rawManifest === "object" &&
      !Array.isArray(rawManifest))
    ? (rawManifest as JsonObject)
    : ({} as JsonObject);
  const deploymentName = readDeploymentNameV1(
    manifestObject,
    resources.value,
  );
  const persistedManifest = manifestObject;
  const deployResources = attachProvenanceToResources(
    resources.value,
    provenance.value,
  );
  const trace = deployTraceFromRequest(requestTrace, requestCorrelation);
  const metricTimer = startDeployMetricTimer();
  const recordMetric = (
    operationKind: DeployMetricOperationKind,
    status: "succeeded" | "failed" | "failed-validation" | "partial",
  ) =>
    recordDeployOperationMetric({
      observability,
      now,
    }, {
      operationKind,
      status,
      spaceId: tenantId,
      groupId: deploymentName,
      deploymentName,
      startedAtMs: metricTimer.startedAtMs,
      ...(requestCorrelation
        ? {
          requestId: requestCorrelation.requestId,
          correlationId: requestCorrelation.correlationId,
        }
        : {}),
    });

  if (mode.value === "plan") {
    const quota = validateManifestArtifactSizeQuota(
      deployResources,
      artifactMaxBytes,
    );
    if (!quota.ok) {
      await recordMetric("plan", "failed-validation");
      return quota.response;
    }
    const outcome = await applyResources(
      deployResources,
      undefined,
      true,
      undefined,
      undefined,
      trace,
    );
    if (outcome.status === "failed-validation") {
      await recordMetric("plan", "failed-validation");
      return { status: 400, body: { status: "error", outcome } };
    }
    await recordMetric("plan", "succeeded");
    const ok: DeployPublicResponse = {
      status: "ok",
      outcome: withOperationPlanPreview({
        outcome,
        resources: deployResources,
        tenantId,
        deploymentName,
      }),
    };
    return { status: 200, body: ok };
  }

  if (mode.value === "destroy") {
    await recordStore.acquireLock(tenantId, deploymentName);
    try {
      const operationPlan = buildPublicOperationPlanPreview({
        resources: deployResources,
        tenantId,
        deploymentName,
        op: "delete",
      });
      const recoveryResponse = await handleRecoveryPreflight({
        store: operationJournalStore,
        tenantId,
        deploymentName,
        requestedPhase: "destroy",
        operationPlanDigest: operationPlan.operationPlanDigest,
        recoveryMode: recoveryMode.value,
      });
      if (recoveryResponse) return recoveryResponse;
      if (recoveryMode.value === "compensate") {
        const response = await handleRecoveryCompensate({
          journalStore: operationJournalStore,
          revokeDebtStore,
          preview: operationPlan,
          phase: "destroy",
          tenantId,
          deploymentName,
          createdAt: now(),
        });
        await recordMetric(
          "rollback",
          response.status === 200 ? "succeeded" : "failed",
        );
        return response;
      }
      const journalStartedAt = now();
      await appendOperationPlanJournalStages({
        store: operationJournalStore,
        preview: operationPlan,
        phase: "destroy",
        stages: ["prepare"],
        status: "recorded",
        createdAt: journalStartedAt,
        detail: journalDetail(undefined, provenance.value),
      });
      const prior = await recordStore.get(tenantId, deploymentName);
      const force = body.force === true;
      if (!prior && !force) {
        await appendOperationPlanJournalStages({
          store: operationJournalStore,
          preview: operationPlan,
          phase: "destroy",
          stages: ["abort"],
          status: "failed",
          createdAt: now(),
          detail: journalDetail(
            { reason: "missing-prior-deploy-record" },
            provenance.value,
          ),
        });
        await recordMetric("destroy", "failed");
        return {
          status: 409,
          body: apiError(
            "failed_precondition",
            `destroy refused: no prior deploy record for tenant=${tenantId} ` +
              `name=${deploymentName}. The kernel cannot resolve cloud ` +
              `resource handles (e.g. AWS ARNs) without persisted state. ` +
              `If the resources are self-hosted (filesystem / docker / ` +
              `systemd) and you want to destroy by resource name, retry ` +
              `with \`force: true\` in the request body.`,
          ),
        };
      }
      const handleFor = prior ? buildHandleForFromRecord(prior) : undefined;
      if (!prior) {
        log.warn("kernel.deploy.destroy_force_no_prior_record", {
          tenantId,
          deploymentName,
          hint: "destroy --force: no record; using resource.name as handle. " +
            "Cloud handles may not match.",
        });
      }
      if (
        recoveryMode.value === "continue" && prior?.status === "destroyed"
      ) {
        const outcome: DestroyV2Outcome = {
          destroyed: deployResources.map((resource) => ({
            name: resource.name,
            providerId: providerIdForIntentPreview(resource),
            handle: resource.name,
          })),
          errors: [],
          issues: [],
          status: "succeeded",
        };
        await appendOperationPlanJournalStages({
          store: operationJournalStore,
          preview: operationPlan,
          phase: "destroy",
          stages: ["post-commit", "observe", "finalize"],
          status: "succeeded",
          createdAt: now(),
          detail: journalDetail(
            { outcomeStatus: outcome.status },
            provenance.value,
          ),
        });
        const ok: DeployPublicDestroyResponse = { status: "ok", outcome };
        await recordMetric("destroy", "succeeded");
        return { status: 200, body: ok };
      }
      const preCommitHook = await invokeCatalogReleaseWalHook({
        verifier: catalogReleaseVerifier,
        spaceId: tenantId,
        stage: "pre-commit",
        preview: operationPlan,
      });
      if (!preCommitHook.ok) {
        const response = await handleCatalogReleasePreCommitFailure({
          journalStore: operationJournalStore,
          preview: operationPlan,
          phase: "destroy",
          createdAt: now(),
          hook: preCommitHook,
        });
        await recordMetric("destroy", "failed");
        return response;
      }
      await appendOperationPlanJournalStages({
        store: operationJournalStore,
        preview: operationPlan,
        phase: "destroy",
        stages: ["pre-commit"],
        status: "recorded",
        createdAt: now(),
        detail: journalDetail(
          catalogReleaseWalHookDetail(preCommitHook),
          provenance.value,
        ),
      });
      await appendOperationPlanJournalStages({
        store: operationJournalStore,
        preview: operationPlan,
        phase: "destroy",
        stages: ["commit"],
        status: "recorded",
        createdAt: now(),
        detail: journalDetail(undefined, provenance.value),
      });
      try {
        const outcome = await destroyResources(
          deployResources,
          handleFor,
          operationPlan,
          platformRecoveryMode(recoveryMode.value),
          trace,
        );
        if (outcome.status === "failed-validation") {
          await appendOperationPlanJournalStages({
            store: operationJournalStore,
            preview: operationPlan,
            phase: "destroy",
            stages: ["abort"],
            status: "failed",
            createdAt: now(),
            detail: journalDetail(
              { outcomeStatus: outcome.status },
              provenance.value,
            ),
          });
          await recordMetric("destroy", "failed-validation");
          return { status: 400, body: { status: "error", outcome } };
        }
        if (prior) {
          await recordStore.markDestroyed(tenantId, deploymentName, now());
        }
        const postCommitHook = await invokeCatalogReleaseWalHook({
          verifier: catalogReleaseVerifier,
          spaceId: tenantId,
          stage: "post-commit",
          preview: operationPlan,
        });
        if (!postCommitHook.ok) {
          const response = await handleCatalogReleasePostCommitFailure({
            journalStore: operationJournalStore,
            revokeDebtStore,
            preview: operationPlan,
            phase: "destroy",
            tenantId,
            deploymentName,
            createdAt: now(),
            hook: postCommitHook,
          });
          await recordMetric("destroy", "failed");
          return response;
        }
        await appendOperationPlanJournalStages({
          store: operationJournalStore,
          preview: operationPlan,
          phase: "destroy",
          stages: outcome.status === "succeeded"
            ? ["post-commit", "observe", "finalize"]
            : ["abort"],
          status: outcome.status === "succeeded" ? "succeeded" : "failed",
          createdAt: now(),
          detail: journalDetail({
            outcomeStatus: outcome.status,
            ...(outcome.status === "succeeded"
              ? catalogReleaseHookDetailField(postCommitHook)
              : {}),
          }, provenance.value),
        });
        const ok: DeployPublicDestroyResponse = { status: "ok", outcome };
        await recordMetric(
          "destroy",
          outcome.status === "succeeded" ? "succeeded" : "partial",
        );
        return { status: 200, body: ok };
      } catch (error) {
        await appendOperationPlanJournalStages({
          store: operationJournalStore,
          preview: operationPlan,
          phase: "destroy",
          stages: ["abort"],
          status: "failed",
          createdAt: now(),
          detail: journalDetail(
            { reason: "destroy-threw" },
            provenance.value,
          ),
        });
        const message = error instanceof Error ? error.message : String(error);
        await recordMetric("destroy", "failed");
        return {
          status: 500,
          body: apiError("internal_error", `destroy failed: ${message}`),
        };
      }
    } finally {
      await recordStore.releaseLock(tenantId, deploymentName);
    }
  }

  await recordStore.acquireLock(tenantId, deploymentName);
  try {
    const quota = validateManifestArtifactSizeQuota(
      deployResources,
      artifactMaxBytes,
    );
    if (!quota.ok) {
      await recordMetric("apply", "failed-validation");
      return quota.response;
    }
    const operationPlan = buildPublicOperationPlanPreview({
      resources: deployResources,
      tenantId,
      deploymentName,
      op: "create",
    });
    const recoveryResponse = await handleRecoveryPreflight({
      store: operationJournalStore,
      tenantId,
      deploymentName,
      requestedPhase: "apply",
      operationPlanDigest: operationPlan.operationPlanDigest,
      recoveryMode: recoveryMode.value,
    });
    if (recoveryResponse) return recoveryResponse;
    if (recoveryMode.value === "compensate") {
      const response = await handleRecoveryCompensate({
        journalStore: operationJournalStore,
        revokeDebtStore,
        preview: operationPlan,
        phase: "apply",
        tenantId,
        deploymentName,
        createdAt: now(),
      });
      await recordMetric(
        "rollback",
        response.status === 200 ? "succeeded" : "failed",
      );
      return response;
    }
    await appendOperationPlanJournalStages({
      store: operationJournalStore,
      preview: operationPlan,
      phase: "apply",
      stages: ["prepare"],
      status: "recorded",
      createdAt: now(),
      detail: journalDetail(undefined, provenance.value),
    });
    const preCommitHook = await invokeCatalogReleaseWalHook({
      verifier: catalogReleaseVerifier,
      spaceId: tenantId,
      stage: "pre-commit",
      preview: operationPlan,
    });
    if (!preCommitHook.ok) {
      const response = await handleCatalogReleasePreCommitFailure({
        journalStore: operationJournalStore,
        preview: operationPlan,
        phase: "apply",
        createdAt: now(),
        hook: preCommitHook,
      });
      await recordMetric("apply", "failed");
      return response;
    }
    await appendOperationPlanJournalStages({
      store: operationJournalStore,
      preview: operationPlan,
      phase: "apply",
      stages: ["pre-commit"],
      status: "recorded",
      createdAt: now(),
      detail: journalDetail(
        catalogReleaseWalHookDetail(preCommitHook),
        provenance.value,
      ),
    });
    await appendOperationPlanJournalStages({
      store: operationJournalStore,
      preview: operationPlan,
      phase: "apply",
      stages: ["commit"],
      status: "recorded",
      createdAt: now(),
      detail: journalDetail(undefined, provenance.value),
    });
    const prior = await recordStore.get(tenantId, deploymentName);
    const priorApplied = prior ? buildPriorAppliedFromRecord(prior) : undefined;
    try {
      const outcome = await applyResources(
        deployResources,
        priorApplied,
        false,
        operationPlan,
        platformRecoveryMode(recoveryMode.value),
        trace,
      );
      if (outcome.status === "failed-validation") {
        await appendOperationPlanJournalStages({
          store: operationJournalStore,
          preview: operationPlan,
          phase: "apply",
          stages: ["abort"],
          status: "failed",
          createdAt: now(),
          detail: journalDetail(
            { outcomeStatus: outcome.status },
            provenance.value,
          ),
        });
        await recordMetric("apply", "failed-validation");
        return { status: 400, body: { status: "error", outcome } };
      }
      if (outcome.status === "failed-apply") {
        if (prior?.status !== "applied") {
          const failedStamp = now();
          await recordStore.upsert({
            tenantId,
            name: deploymentName,
            manifest: prior?.manifest ?? persistedManifest,
            appliedResources: prior?.appliedResources ?? [],
            status: "failed",
            now: failedStamp,
          });
        }
        await appendOperationPlanJournalStages({
          store: operationJournalStore,
          preview: operationPlan,
          phase: "apply",
          stages: ["abort"],
          status: "failed",
          createdAt: now(),
          detail: journalDetail(
            { outcomeStatus: outcome.status },
            provenance.value,
          ),
        });
        await recordMetric("apply", "failed");
        if (outcome.rollback) {
          await recordMetric("rollback", outcome.rollback.status);
        }
        return { status: 500, body: { status: "error", outcome } };
      }
      if (
        typeof outcome.reused === "number" && outcome.reused > 0
      ) {
        log.info("kernel.deploy.apply_reusing_resources", {
          reused: outcome.reused,
          tenantId,
          deploymentName,
          reason: "fingerprint_match",
        });
      }
      const stamp = now();
      await recordStore.upsert({
        tenantId,
        name: deploymentName,
        manifest: persistedManifest,
        appliedResources: recordsFromAppliedResources(
          outcome.applied,
          deployResources,
          stamp,
        ),
        status: "applied",
        now: stamp,
      });
      const postCommitHook = await invokeCatalogReleaseWalHook({
        verifier: catalogReleaseVerifier,
        spaceId: tenantId,
        stage: "post-commit",
        preview: operationPlan,
      });
      if (!postCommitHook.ok) {
        const response = await handleCatalogReleasePostCommitFailure({
          journalStore: operationJournalStore,
          revokeDebtStore,
          preview: operationPlan,
          phase: "apply",
          tenantId,
          deploymentName,
          createdAt: now(),
          hook: postCommitHook,
        });
        await recordMetric("apply", "failed");
        return response;
      }
      await appendOperationPlanJournalStages({
        store: operationJournalStore,
        preview: operationPlan,
        phase: "apply",
        stages: ["post-commit", "observe", "finalize"],
        status: "succeeded",
        createdAt: now(),
        detail: journalDetail({
          outcomeStatus: outcome.status,
          ...catalogReleaseHookDetailField(postCommitHook),
        }, provenance.value),
      });
      const ok: DeployPublicResponse = { status: "ok", outcome };
      await recordMetric("apply", "succeeded");
      return { status: 200, body: ok };
    } catch (error) {
      await appendOperationPlanJournalStages({
        store: operationJournalStore,
        preview: operationPlan,
        phase: "apply",
        stages: ["abort"],
        status: "failed",
        createdAt: now(),
        detail: journalDetail({ reason: "apply-threw" }, provenance.value),
      });
      const message = error instanceof Error ? error.message : String(error);
      await recordMetric("apply", "failed");
      return {
        status: 500,
        body: apiError("internal_error", `apply failed: ${message}`),
      };
    }
  } finally {
    await recordStore.releaseLock(tenantId, deploymentName);
  }
}

/**
 * Build the `handleFor` callback that `destroyV2` consults to map a
 * manifest resource back to the runtime handle that `provider.apply`
 * returned at deploy time.
 *
 * Falls back to `resource.name` when the persisted record does not list
 * the resource (manifest expanded but record was created from a
 * different submission). The fallback matches the existing destroyV2
 * default so behavior is unchanged for in-memory / filesystem providers.
 */
function buildHandleForFromRecord(
  record: TakosumiDeploymentRecord,
): (resource: ManifestResource) => ResourceHandle {
  const handlesByName = new Map<string, ResourceHandle>();
  for (const entry of record.appliedResources) {
    handlesByName.set(entry.resourceName, entry.handle);
  }
  return (resource) => handlesByName.get(resource.name) ?? resource.name;
}

/**
 * Build the `priorApplied` map that `applyV2` consults to short-circuit
 * `provider.apply` when a resource's fingerprint is unchanged since its
 * last apply. Only entries that carry a `specFingerprint` produce a
 * snapshot; entries without the field force a re-apply, which is safe
 * (provider.apply still runs) but not idempotent.
 */
function buildPriorAppliedFromRecord(
  record: TakosumiDeploymentRecord,
): ReadonlyMap<string, PriorAppliedSnapshot> {
  const map = new Map<string, PriorAppliedSnapshot>();
  for (const entry of record.appliedResources) {
    if (!entry.specFingerprint) continue;
    map.set(entry.resourceName, {
      specFingerprint: entry.specFingerprint,
      handle: entry.handle,
      outputs: entry.outputs,
      providerId: entry.providerId,
    });
  }
  return map;
}
