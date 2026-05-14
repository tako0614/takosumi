import type { Hono as HonoApp } from "hono";
import type {
  JsonObject,
  ManifestResource,
  PlatformContext,
  PlatformTraceContext,
  ResourceHandle,
} from "takosumi-contract";
import {
  applyV2,
  destroyV2,
  type DestroyV2Outcome,
  type PriorAppliedSnapshot,
} from "../domains/deploy/apply_v2.ts";
import {
  readDeploymentNameV1,
  resolveManifestResourcesV1,
} from "../domains/deploy/manifest_v1.ts";
import {
  appendOperationPlanJournalStages,
  InMemoryOperationJournalStore,
  type OperationJournalStore,
} from "../domains/deploy/operation_journal.ts";
import {
  InMemoryTakosumiDeploymentRecordStore,
  recordsFromAppliedResources,
  type TakosumiDeploymentRecord,
  type TakosumiDeploymentRecordStore,
} from "../domains/deploy/takosumi_deployment_record_store.ts";
import {
  type DeployMetricOperationKind,
  recordDeployOperationMetric,
  startDeployMetricTimer,
} from "../domains/deploy/deploy_metrics.ts";
import {
  readRequestCorrelation,
  readRequestTrace,
  type RequestCorrelation,
  type RequestTraceContext,
} from "./request_correlation.ts";
import {
  type DeployPublicIdempotencyStore,
  InMemoryDeployPublicIdempotencyStore,
} from "../domains/deploy/deploy_public_idempotency_store.ts";
import {
  InMemoryRevokeDebtStore,
  type RevokeDebtStore,
} from "../domains/deploy/revoke_debt_store.ts";
import { apiError, registerApiErrorHandler } from "./errors.ts";
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
  checkBearer,
  constantTimeEquals,
  journalDetail,
  platformRecoveryMode,
  readBearerToken,
  readDeployPublicProvenance,
  readIdempotencyKey,
  readJsonBody,
  readMode,
  readRecoveryMode,
  resolveManifestArtifactMaxBytes,
  sha256Hex,
  validateManifestArtifactSizeQuota,
} from "./deploy_public_request_helpers.ts";
import {
  attachPlatformTrace,
  deployTraceFromRequest,
  platformContextFromAppContext,
} from "./deploy_public_platform_context.ts";
import {
  toDeploymentAuditResponse,
  toDeploymentSummary,
} from "./deploy_public_summaries.ts";
import {
  type CatalogReleaseWalHookVerifier,
  type DeploymentAuditCauseSummary,
  type DeploymentAuditSummary,
  type DeploymentJournalEntrySummary,
  type DeploymentJournalSummary,
  type DeploymentRevokeDebtRecordSummary,
  type DeploymentSummary,
  type DeployPublicAuditResponse,
  type DeployPublicDestroyResponse,
  type DeployPublicHandledResponse,
  type DeployPublicJsonStatus,
  type DeployPublicMode,
  type DeployPublicProvenance,
  type DeployPublicRecoveryCompensateResponse,
  type DeployPublicRecoveryInspectResponse,
  type DeployPublicRecoveryMode,
  type DeployPublicResponse,
  type RegisterDeployPublicRoutesOptions,
  TAKOSUMI_DEPLOY_PUBLIC_PATH,
  TAKOSUMI_IDEMPOTENCY_KEY_HEADER,
  TAKOSUMI_IDEMPOTENCY_REPLAYED_HEADER,
  TAKOSUMI_MANIFEST_ARTIFACT_SIZE_MAX_BYTES_DEFAULT,
} from "./deploy_public_types.ts";

export {
  type CatalogReleaseWalHookVerifier,
  type DeploymentAuditCauseSummary,
  type DeploymentAuditSummary,
  type DeploymentJournalEntrySummary,
  type DeploymentJournalSummary,
  type DeploymentRevokeDebtRecordSummary,
  type DeploymentSummary,
  type DeployPublicAuditResponse,
  type DeployPublicDestroyResponse,
  type DeployPublicMode,
  type DeployPublicProvenance,
  type DeployPublicRecoveryCompensateResponse,
  type DeployPublicRecoveryInspectResponse,
  type DeployPublicRecoveryMode,
  type DeployPublicResponse,
  type RegisterDeployPublicRoutesOptions,
  TAKOSUMI_DEPLOY_PUBLIC_PATH,
  TAKOSUMI_IDEMPOTENCY_KEY_HEADER,
  TAKOSUMI_IDEMPOTENCY_REPLAYED_HEADER,
  TAKOSUMI_MANIFEST_ARTIFACT_SIZE_MAX_BYTES_DEFAULT,
};

export function registerDeployPublicRoutes(
  app: HonoApp,
  options: RegisterDeployPublicRoutesOptions = {},
): void {
  registerApiErrorHandler(app);
  const getToken = options.getDeployToken ??
    (() => Deno.env.get("TAKOSUMI_DEPLOY_TOKEN"));
  const initialToken = getToken();
  if (!initialToken) {
    console.warn(
      `[takosumi-deploy] TAKOSUMI_DEPLOY_TOKEN is not set; ` +
        `${TAKOSUMI_DEPLOY_PUBLIC_PATH} will return 404 until configured.`,
    );
  }

  const tenantId = options.tenantId ?? "takosumi-deploy";
  const recordStore: TakosumiDeploymentRecordStore = options.recordStore ??
    new InMemoryTakosumiDeploymentRecordStore();
  const idempotencyStore: DeployPublicIdempotencyStore =
    options.idempotencyStore ?? new InMemoryDeployPublicIdempotencyStore();
  const operationJournalStore: OperationJournalStore =
    options.operationJournalStore ?? new InMemoryOperationJournalStore();
  const revokeDebtStore: RevokeDebtStore = options.revokeDebtStore ??
    new InMemoryRevokeDebtStore();
  const catalogReleaseVerifier = options.catalogReleaseVerifier;
  const artifactMaxBytes = resolveManifestArtifactMaxBytes(
    options.artifactMaxBytes,
  );
  const observability = options.observability ??
    options.appContext?.adapters.observability;
  const now = options.now ?? (() => new Date().toISOString());

  const buildPlatformContext = (
    trace?: PlatformTraceContext,
  ): PlatformContext => {
    if (options.createPlatformContext) {
      return attachPlatformTrace(options.createPlatformContext(), trace);
    }
    if (options.appContext) {
      return platformContextFromAppContext(options.appContext, tenantId, trace);
    }
    throw new Error(
      "registerDeployPublicRoutes: no platform context configured. " +
        "Pass `appContext`, `createPlatformContext`, or override " +
        "`applyResources` (test usage).",
    );
  };

  const applyResources = options.applyResources ??
    ((
      resources,
      priorApplied,
      dryRun,
      operationPlanPreview,
      recoveryMode,
      trace,
    ) =>
      applyV2({
        resources,
        context: buildPlatformContext(trace),
        ...(priorApplied ? { priorApplied } : {}),
        ...(dryRun ? { dryRun } : {}),
        ...(operationPlanPreview ? { operationPlanPreview } : {}),
        ...(recoveryMode ? { recoveryMode } : {}),
      }));

  const destroyResources = options.destroyResources ??
    ((resources, handleFor, operationPlanPreview, recoveryMode, trace) =>
      destroyV2({
        resources,
        context: buildPlatformContext(trace),
        ...(handleFor ? { handleFor } : {}),
        ...(operationPlanPreview ? { operationPlanPreview } : {}),
        ...(recoveryMode ? { recoveryMode } : {}),
      }));
  const executeDeployPublicPost = async (
    body: Record<string, unknown>,
    requestCorrelation?: RequestCorrelation,
    requestTrace?: RequestTraceContext,
  ): Promise<DeployPublicHandledResponse> => {
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
          console.warn(
            `[takosumi-deploy] destroy --force: no record for tenant=${tenantId} ` +
              `name=${deploymentName}; using resource.name as handle. ` +
              `Cloud handles may not match.`,
          );
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
          const message = error instanceof Error
            ? error.message
            : String(error);
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
      const priorApplied = prior
        ? buildPriorAppliedFromRecord(prior)
        : undefined;
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
          console.log(
            `[takosumi-apply] reusing ${outcome.reused} resources from prior ` +
              `apply (fingerprint match) for tenant=${tenantId} ` +
              `name=${deploymentName}`,
          );
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
  };

  app.post(TAKOSUMI_DEPLOY_PUBLIC_PATH, async (c) => {
    const expected = getToken();
    if (!expected) {
      return c.json(apiError("not_found", "deploy endpoint disabled"), 404);
    }
    const presented = readBearerToken(c.req.header("authorization"));
    if (!presented) {
      return c.json(
        apiError("unauthenticated", "missing bearer token"),
        401,
      );
    }
    if (!constantTimeEquals(presented, expected)) {
      return c.json(apiError("unauthenticated", "invalid token"), 401);
    }

    const body = await readJsonBody(c.req.raw);
    if (!body.ok) {
      return c.json(apiError("invalid_argument", body.error), 400);
    }
    const idempotencyKey = readIdempotencyKey(
      c.req.header(TAKOSUMI_IDEMPOTENCY_KEY_HEADER),
    );
    if (!idempotencyKey.ok) {
      return c.json(
        apiError("invalid_argument", idempotencyKey.error),
        400,
      );
    }
    const requestDigest = await sha256Hex(body.rawText);
    await idempotencyStore.acquireLock(tenantId, idempotencyKey.value);
    try {
      const prior = await idempotencyStore.get(tenantId, idempotencyKey.value);
      if (prior) {
        if (prior.requestDigest !== requestDigest) {
          return c.json(
            apiError(
              "failed_precondition",
              "idempotency key already used with a different request body",
            ),
            409,
          );
        }
        c.header(TAKOSUMI_IDEMPOTENCY_REPLAYED_HEADER, "true");
        return c.json(
          prior.responseBody,
          prior.responseStatus as DeployPublicJsonStatus,
        );
      }
      const response = await executeDeployPublicPost(
        body.value,
        readRequestCorrelation(c),
        readRequestTrace(c),
      );
      await idempotencyStore.save({
        tenantId,
        key: idempotencyKey.value,
        requestDigest,
        responseStatus: response.status,
        responseBody: response.body,
        now: now(),
      });
      return c.json(response.body, response.status);
    } finally {
      await idempotencyStore.releaseLock(tenantId, idempotencyKey.value);
    }
  });

  app.get(TAKOSUMI_DEPLOY_PUBLIC_PATH, async (c) => {
    const auth = checkBearer(c.req.header("authorization"), getToken());
    if (auth.status !== "ok") return c.json(auth.body, auth.code);
    const records = await recordStore.list(tenantId);
    return c.json(
      {
        deployments: await Promise.all(
          records.map((record) =>
            toDeploymentSummary(record, operationJournalStore, revokeDebtStore)
          ),
        ),
      },
      200,
    );
  });

  app.get(`${TAKOSUMI_DEPLOY_PUBLIC_PATH}/:name/audit`, async (c) => {
    const auth = checkBearer(c.req.header("authorization"), getToken());
    if (auth.status !== "ok") return c.json(auth.body, auth.code);
    const name = c.req.param("name");
    if (!name) {
      return c.json(apiError("invalid_argument", "name is required"), 400);
    }
    const record = await recordStore.get(tenantId, name);
    if (!record) {
      return c.json(apiError("not_found", `deployment ${name} not found`), 404);
    }
    return c.json(
      await toDeploymentAuditResponse(
        record,
        operationJournalStore,
        revokeDebtStore,
      ),
      200,
    );
  });

  app.get(`${TAKOSUMI_DEPLOY_PUBLIC_PATH}/:name`, async (c) => {
    const auth = checkBearer(c.req.header("authorization"), getToken());
    if (auth.status !== "ok") return c.json(auth.body, auth.code);
    const name = c.req.param("name");
    if (!name) {
      return c.json(apiError("invalid_argument", "name is required"), 400);
    }
    const record = await recordStore.get(tenantId, name);
    if (!record) {
      return c.json(apiError("not_found", `deployment ${name} not found`), 404);
    }
    return c.json(
      await toDeploymentSummary(record, operationJournalStore, revokeDebtStore),
      200,
    );
  });
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
