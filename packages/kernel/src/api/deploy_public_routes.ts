import type { Hono as HonoApp } from "hono";
import type { PlatformContext, PlatformTraceContext } from "takosumi-contract";
import { applyV2, destroyV2 } from "../domains/deploy/apply_v2.ts";
import {
  InMemoryOperationJournalStore,
  type OperationJournalStore,
} from "../domains/deploy/operation_journal.ts";
import {
  InMemoryTakosumiDeploymentRecordStore,
  type TakosumiDeploymentRecordStore,
} from "../domains/deploy/takosumi_deployment_record_store.ts";
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
import { log } from "../shared/log.ts";
import { apiError, registerApiErrorHandler } from "./errors.ts";
import { executeDeployPublicPost } from "./deploy_public_apply_handler.ts";
import {
  checkBearer,
  constantTimeEquals,
  readBearerToken,
  readIdempotencyKey,
  readJsonBody,
  resolveManifestArtifactMaxBytes,
  sha256Hex,
} from "./deploy_public_request_helpers.ts";
import {
  attachPlatformTrace,
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
    log.warn("kernel.api.deploy_public_disabled_no_token", {
      path: TAKOSUMI_DEPLOY_PUBLIC_PATH,
      hint: "TAKOSUMI_DEPLOY_TOKEN is not set; deploy public route will " +
        "return 404 until configured.",
    });
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
  const executeDeploy = (
    body: Record<string, unknown>,
    requestCorrelation?: RequestCorrelation,
    requestTrace?: RequestTraceContext,
  ): Promise<DeployPublicHandledResponse> =>
    executeDeployPublicPost(
      {
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
      },
      body,
      requestCorrelation,
      requestTrace,
    );

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
      const response = await executeDeploy(
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
