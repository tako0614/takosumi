import type { Hono as HonoApp } from "hono";
import type {
  JsonObject,
  ManifestResource,
  PlatformContext,
  PlatformOperationRecoveryMode,
  RefResolver,
  ResourceHandle,
} from "takosumi-contract";
import type { AppContext } from "../app_context.ts";
import {
  applyV2,
  type ApplyV2Outcome,
  destroyV2,
  type DestroyV2Outcome,
  type OperationPlanPreview,
  type PlannedResource,
  type PriorAppliedSnapshot,
} from "../domains/deploy/apply_v2.ts";
import {
  readDeploymentNameV1,
  resolveManifestResourcesV1,
} from "../domains/deploy/manifest_v1.ts";
import { buildOperationPlanPreview } from "../domains/deploy/operation_plan_preview.ts";
import {
  appendOperationPlanJournalStages,
  InMemoryOperationJournalStore,
  type OperationJournalEntry,
  type OperationJournalPhase,
  type OperationJournalStage,
  type OperationJournalStatus,
  type OperationJournalStore,
} from "../domains/deploy/operation_journal.ts";
import { buildRefDag } from "../domains/deploy/ref_resolver_v2.ts";
import {
  InMemoryTakosumiDeploymentRecordStore,
  recordsFromAppliedResources,
  type TakosumiAppliedResourceRecord,
  type TakosumiDeploymentRecord,
  type TakosumiDeploymentRecordStore,
} from "../domains/deploy/takosumi_deployment_record_store.ts";
import {
  type DeployPublicIdempotencyStore,
  InMemoryDeployPublicIdempotencyStore,
} from "../domains/deploy/deploy_public_idempotency_store.ts";
import {
  InMemoryRevokeDebtStore,
  type RevokeDebtRecord,
  type RevokeDebtStore,
  type RevokeDebtSummary,
  summarizeRevokeDebt,
} from "../domains/deploy/revoke_debt_store.ts";
import type {
  CatalogReleaseVerificationResult,
} from "../domains/registry/mod.ts";
import type {
  CatalogReleaseExecutableHookPackageResult,
  CatalogReleaseExecutableHookRunner,
  CatalogReleaseExecutableHookRunResult,
  ExecutableCatalogHookInvocation,
} from "../plugins/executable_hooks.ts";
import {
  apiError,
  MalformedJsonRequestError,
  registerApiErrorHandler,
} from "./errors.ts";

/**
 * v1 CLI deploy endpoint contract.
 *
 *   POST /v1/deployments
 *   Authorization: Bearer <TAKOSUMI_DEPLOY_TOKEN>
 *   Content-Type: application/json
 *
 *   Body:  { mode: "apply" | "plan" | "destroy", manifest: { ... } }
 *
 * The endpoint runs the same `applyV2` pipeline that the CLI uses in local
 * mode, against whatever shapes / providers the operator has registered with
 * the global contract registry. It is intentionally simple: one deploy bearer
 * maps to one operator-configured public deploy scope (`tenantId` / `spaceId`,
 * default `"takosumi-deploy"`). Full per-actor Space auth and control-plane
 * policy gating belong to the internal route set.
 *
 * If `TAKOSUMI_DEPLOY_TOKEN` is unset the route is disabled and falls
 * through to the framework default 404 — operators must explicitly opt in
 * by setting the env var.
 */
export const TAKOSUMI_DEPLOY_PUBLIC_PATH = "/v1/deployments" as const;
export const TAKOSUMI_IDEMPOTENCY_KEY_HEADER = "x-idempotency-key" as const;
export const TAKOSUMI_IDEMPOTENCY_REPLAYED_HEADER =
  "x-idempotency-replayed" as const;

export type DeployPublicMode = "apply" | "plan" | "destroy";
export type DeployPublicRecoveryMode = "inspect" | "continue" | "compensate";

export interface DeployPublicResponse {
  readonly status: "ok";
  readonly outcome: ApplyV2Outcome;
}

export interface DeployPublicDestroyResponse {
  readonly status: "ok";
  readonly outcome: DestroyV2Outcome;
}

export interface DeployPublicRecoveryInspectResponse {
  readonly status: "ok";
  readonly outcome: {
    readonly status: "recovery-inspect";
    readonly tenantId: string;
    readonly deploymentName: string;
    readonly journal?: DeploymentJournalSummary;
    readonly entries: readonly DeploymentJournalEntrySummary[];
  };
}

export interface DeployPublicRecoveryCompensateResponse {
  readonly status: "ok";
  readonly outcome: {
    readonly status: "recovery-compensate";
    readonly tenantId: string;
    readonly deploymentName: string;
    readonly journal?: DeploymentJournalSummary;
    readonly debts: readonly DeploymentRevokeDebtRecordSummary[];
  };
}

export interface RegisterDeployPublicRoutesOptions {
  /**
   * Shared-secret token. When undefined the route is disabled (a startup
   * warning is emitted by `registerDeployPublicRoutes` so operators see
   * why the CLI cannot reach the kernel).
   */
  readonly getDeployToken?: () => string | undefined;
  /**
   * Optional injection point for tests so apply runs against a fake.
   * The optional `priorApplied` argument lets tests assert that the
   * route forwards the per-resource snapshot lookup so applyV2 can
   * short-circuit `provider.apply` on idempotent re-submissions.
   * The optional `dryRun` argument is true for `mode: "plan"`.
   * The optional `operationPlanPreview` argument is present after the route
   * has recorded WAL prepare / pre-commit / commit stages for a real apply.
   * The optional `recoveryMode` argument is `"normal"` unless the caller is
   * resuming a matching WAL with `recoveryMode: "continue"`.
   */
  readonly applyResources?: (
    resources: readonly ManifestResource[],
    priorApplied?: ReadonlyMap<string, PriorAppliedSnapshot>,
    dryRun?: boolean,
    operationPlanPreview?: OperationPlanPreview,
    recoveryMode?: PlatformOperationRecoveryMode,
  ) => Promise<ApplyV2Outcome>;
  /**
   * Optional injection point for tests so destroy runs against a fake.
   * When omitted the route delegates to `destroyV2` against the platform
   * context constructed from `appContext` / `createPlatformContext`. The
   * test override receives the resources and an optional `handleFor`
   * resolver so that fake destroyers can assert the kernel passed the
   * persisted handles back through.
   * The optional `operationPlanPreview` argument is present after the route
   * has recorded WAL prepare / pre-commit / commit stages for destroy.
   * The optional `recoveryMode` argument is `"normal"` unless the caller is
   * resuming a matching WAL with `recoveryMode: "continue"`.
   */
  readonly destroyResources?: (
    resources: readonly ManifestResource[],
    handleFor?: (resource: ManifestResource) => ResourceHandle,
    operationPlanPreview?: OperationPlanPreview,
    recoveryMode?: PlatformOperationRecoveryMode,
  ) => Promise<DestroyV2Outcome>;
  /**
   * Real `AppContext` from which the public deploy route derives the
   * `PlatformContext` passed to `applyV2`. The kernel boots the AppContext
   * once at startup with DB-backed secrets / KMS / observability / object
   * storage adapters; this option threads those through to the public
   * deploy pipeline so a CLI deploy is not silently writing to noop
   * adapters.
   *
   * When neither `appContext` nor `createPlatformContext` is supplied,
   * `applyV2` is invoked without a context (caller-provided
   * `applyResources` overrides this entirely; tests use that path).
   */
  readonly appContext?: AppContext;
  /**
   * Tenant / Space id surfaced into `PlatformContext.tenantId` and
   * `PlatformContext.spaceId` when deriving the context from `appContext`.
   * Defaults to `"takosumi-deploy"`.
   */
  readonly tenantId?: string;
  /** Override the platform context that `applyV2` receives. */
  readonly createPlatformContext?: () => PlatformContext;
  /**
   * Persistent record of every applied / destroyed deployment routed
   * through this endpoint. The route uses it to:
   *   - Persist `applyV2.outcome.applied[]` after a successful apply.
   *   - Look up the persisted per-resource handles when destroy mode
   *     submits the same manifest (otherwise destroy receives only
   *     `resource.name` and fails for any provider whose runtime handle
   *     differs from the resource name — i.e. anything that returns a real
   *     ARN / object id).
   *   - Render `GET /v1/deployments` and `GET /v1/deployments/:name`.
   *
   * Defaults to an in-memory store. Operators that need durability across
   * restarts must inject a SQL-backed store keyed off `takosumi_deployments`
   * (migration `20260430000020_takosumi_deployments`).
   */
  readonly recordStore?: TakosumiDeploymentRecordStore;
  /**
   * Stores the first JSON response for each `(tenantId, X-Idempotency-Key)`
   * tuple. A retry with the same key and byte-identical body replays that
   * response without re-entering apply / destroy. A retry with the same key
   * and a different body fails with 409 so one operation intent cannot be
   * accidentally rebound to another manifest.
   */
  readonly idempotencyStore?: DeployPublicIdempotencyStore;
  /**
   * WAL stage record store for the public deploy route. SQL-backed stores
   * persist `(spaceId, operationPlanDigest, journalEntryId, stage)` entries
   * before side-effecting provider calls so retries have an execution
   * authority beyond the compatibility deployment record.
   */
  readonly operationJournalStore?: OperationJournalStore;
  /**
   * RevokeDebt store used by `recoveryMode: "compensate"` and future
   * post-commit cleanup paths. SQL-backed stores keep compensation debt
   * visible across restarts; in-memory is only for tests / dev.
   */
  readonly revokeDebtStore?: RevokeDebtStore;
  /**
   * Optional CatalogRelease trust hook. When supplied, the route re-verifies
   * the Space's adopted CatalogRelease at WAL pre-commit and post-commit.
   * Verification failures fail closed before commit; post-commit failures
   * journal the hook failure and enqueue RevokeDebt for committed effects.
   */
  readonly catalogReleaseVerifier?: CatalogReleaseWalHookVerifier;
  /**
   * Wall-clock factory used when stamping `created_at` / `updated_at` on
   * persisted records. Defaults to `() => new Date().toISOString()`. Tests
   * override this to assert deterministic timestamps.
   */
  readonly now?: () => string;
}

export interface CatalogReleaseWalHookVerifier {
  verifyCurrentReleaseForSpace(
    spaceId: string,
  ): Promise<CatalogReleaseVerificationResult | undefined>;
  runExecutableHooks?: CatalogReleaseExecutableHookRunner[
    "runExecutableHooks"
  ];
}

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
  const now = options.now ?? (() => new Date().toISOString());

  const buildPlatformContext = (): PlatformContext => {
    if (options.createPlatformContext) return options.createPlatformContext();
    if (options.appContext) {
      return platformContextFromAppContext(options.appContext, tenantId);
    }
    throw new Error(
      "registerDeployPublicRoutes: no platform context configured. " +
        "Pass `appContext`, `createPlatformContext`, or override " +
        "`applyResources` (test usage).",
    );
  };

  const applyResources = options.applyResources ??
    ((resources, priorApplied, dryRun, operationPlanPreview, recoveryMode) =>
      applyV2({
        resources,
        context: buildPlatformContext(),
        ...(priorApplied ? { priorApplied } : {}),
        ...(dryRun ? { dryRun } : {}),
        ...(operationPlanPreview ? { operationPlanPreview } : {}),
        ...(recoveryMode ? { recoveryMode } : {}),
      }));

  const destroyResources = options.destroyResources ??
    ((resources, handleFor, operationPlanPreview, recoveryMode) =>
      destroyV2({
        resources,
        context: buildPlatformContext(),
        ...(handleFor ? { handleFor } : {}),
        ...(operationPlanPreview ? { operationPlanPreview } : {}),
        ...(recoveryMode ? { recoveryMode } : {}),
      }));

  const executeDeployPublicPost = async (
    body: Record<string, unknown>,
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
    const manifestObject = (rawManifest && typeof rawManifest === "object" &&
        !Array.isArray(rawManifest))
      ? (rawManifest as JsonObject)
      : ({} as JsonObject);
    const deploymentName = readDeploymentNameV1(
      manifestObject,
      resources.value,
    );

    if (mode.value === "plan") {
      const outcome = await applyResources(resources.value, undefined, true);
      if (outcome.status === "failed-validation") {
        return { status: 400, body: { status: "error", outcome } };
      }
      const ok: DeployPublicResponse = {
        status: "ok",
        outcome: withOperationPlanPreview({
          outcome,
          resources: resources.value,
          tenantId,
          deploymentName,
        }),
      };
      return { status: 200, body: ok as unknown as JsonObject };
    }

    if (mode.value === "destroy") {
      await recordStore.acquireLock(tenantId, deploymentName);
      try {
        const operationPlan = buildPublicOperationPlanPreview({
          resources: resources.value,
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
          return await handleRecoveryCompensate({
            journalStore: operationJournalStore,
            revokeDebtStore,
            preview: operationPlan,
            phase: "destroy",
            tenantId,
            deploymentName,
            createdAt: now(),
          });
        }
        const journalStartedAt = now();
        await appendOperationPlanJournalStages({
          store: operationJournalStore,
          preview: operationPlan,
          phase: "destroy",
          stages: ["prepare"],
          status: "recorded",
          createdAt: journalStartedAt,
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
            detail: { reason: "missing-prior-deploy-record" },
          });
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
            destroyed: resources.value.map((resource) => ({
              name: resource.name,
              providerId: resource.provider,
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
            detail: { outcomeStatus: outcome.status },
          });
          const ok: DeployPublicDestroyResponse = { status: "ok", outcome };
          return { status: 200, body: ok as unknown as JsonObject };
        }
        const preCommitHook = await invokeCatalogReleaseWalHook({
          verifier: catalogReleaseVerifier,
          spaceId: tenantId,
          stage: "pre-commit",
          preview: operationPlan,
        });
        if (!preCommitHook.ok) {
          return await handleCatalogReleasePreCommitFailure({
            journalStore: operationJournalStore,
            preview: operationPlan,
            phase: "destroy",
            createdAt: now(),
            hook: preCommitHook,
          });
        }
        await appendOperationPlanJournalStages({
          store: operationJournalStore,
          preview: operationPlan,
          phase: "destroy",
          stages: ["pre-commit"],
          status: "recorded",
          createdAt: now(),
          detail: catalogReleaseWalHookDetail(preCommitHook),
        });
        await appendOperationPlanJournalStages({
          store: operationJournalStore,
          preview: operationPlan,
          phase: "destroy",
          stages: ["commit"],
          status: "recorded",
          createdAt: now(),
        });
        try {
          const outcome = await destroyResources(
            resources.value,
            handleFor,
            operationPlan,
            platformRecoveryMode(recoveryMode.value),
          );
          if (outcome.status === "failed-validation") {
            await appendOperationPlanJournalStages({
              store: operationJournalStore,
              preview: operationPlan,
              phase: "destroy",
              stages: ["abort"],
              status: "failed",
              createdAt: now(),
              detail: { outcomeStatus: outcome.status },
            });
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
            return await handleCatalogReleasePostCommitFailure({
              journalStore: operationJournalStore,
              revokeDebtStore,
              preview: operationPlan,
              phase: "destroy",
              tenantId,
              deploymentName,
              createdAt: now(),
              hook: postCommitHook,
            });
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
            detail: {
              outcomeStatus: outcome.status,
              ...(outcome.status === "succeeded"
                ? catalogReleaseHookDetailField(postCommitHook)
                : {}),
            },
          });
          const ok: DeployPublicDestroyResponse = { status: "ok", outcome };
          return { status: 200, body: ok as unknown as JsonObject };
        } catch (error) {
          await appendOperationPlanJournalStages({
            store: operationJournalStore,
            preview: operationPlan,
            phase: "destroy",
            stages: ["abort"],
            status: "failed",
            createdAt: now(),
            detail: { reason: "destroy-threw" },
          });
          const message = error instanceof Error
            ? error.message
            : String(error);
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
      const operationPlan = buildPublicOperationPlanPreview({
        resources: resources.value,
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
        return await handleRecoveryCompensate({
          journalStore: operationJournalStore,
          revokeDebtStore,
          preview: operationPlan,
          phase: "apply",
          tenantId,
          deploymentName,
          createdAt: now(),
        });
      }
      await appendOperationPlanJournalStages({
        store: operationJournalStore,
        preview: operationPlan,
        phase: "apply",
        stages: ["prepare"],
        status: "recorded",
        createdAt: now(),
      });
      const preCommitHook = await invokeCatalogReleaseWalHook({
        verifier: catalogReleaseVerifier,
        spaceId: tenantId,
        stage: "pre-commit",
        preview: operationPlan,
      });
      if (!preCommitHook.ok) {
        return await handleCatalogReleasePreCommitFailure({
          journalStore: operationJournalStore,
          preview: operationPlan,
          phase: "apply",
          createdAt: now(),
          hook: preCommitHook,
        });
      }
      await appendOperationPlanJournalStages({
        store: operationJournalStore,
        preview: operationPlan,
        phase: "apply",
        stages: ["pre-commit"],
        status: "recorded",
        createdAt: now(),
        detail: catalogReleaseWalHookDetail(preCommitHook),
      });
      await appendOperationPlanJournalStages({
        store: operationJournalStore,
        preview: operationPlan,
        phase: "apply",
        stages: ["commit"],
        status: "recorded",
        createdAt: now(),
      });
      const prior = await recordStore.get(tenantId, deploymentName);
      const priorApplied = prior
        ? buildPriorAppliedFromRecord(prior)
        : undefined;
      try {
        const outcome = await applyResources(
          resources.value,
          priorApplied,
          false,
          operationPlan,
          platformRecoveryMode(recoveryMode.value),
        );
        if (outcome.status === "failed-validation") {
          await appendOperationPlanJournalStages({
            store: operationJournalStore,
            preview: operationPlan,
            phase: "apply",
            stages: ["abort"],
            status: "failed",
            createdAt: now(),
            detail: { outcomeStatus: outcome.status },
          });
          return { status: 400, body: { status: "error", outcome } };
        }
        if (outcome.status === "failed-apply") {
          await recordStore.upsert({
            tenantId,
            name: deploymentName,
            manifest: manifestObject,
            appliedResources: [],
            status: "failed",
            now: now(),
          });
          await appendOperationPlanJournalStages({
            store: operationJournalStore,
            preview: operationPlan,
            phase: "apply",
            stages: ["abort"],
            status: "failed",
            createdAt: now(),
            detail: { outcomeStatus: outcome.status },
          });
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
          manifest: manifestObject,
          appliedResources: recordsFromAppliedResources(
            outcome.applied,
            resources.value,
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
          return await handleCatalogReleasePostCommitFailure({
            journalStore: operationJournalStore,
            revokeDebtStore,
            preview: operationPlan,
            phase: "apply",
            tenantId,
            deploymentName,
            createdAt: now(),
            hook: postCommitHook,
          });
        }
        await appendOperationPlanJournalStages({
          store: operationJournalStore,
          preview: operationPlan,
          phase: "apply",
          stages: ["post-commit", "observe", "finalize"],
          status: "succeeded",
          createdAt: now(),
          detail: {
            outcomeStatus: outcome.status,
            ...catalogReleaseHookDetailField(postCommitHook),
          },
        });
        const ok: DeployPublicResponse = { status: "ok", outcome };
        return { status: 200, body: ok as unknown as JsonObject };
      } catch (error) {
        await appendOperationPlanJournalStages({
          store: operationJournalStore,
          preview: operationPlan,
          phase: "apply",
          stages: ["abort"],
          status: "failed",
          createdAt: now(),
          detail: { reason: "apply-threw" },
        });
        const message = error instanceof Error ? error.message : String(error);
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
          prior.responseStatus as 200 | 400 | 409 | 500,
        );
      }
      const response = await executeDeployPublicPost(body.value);
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

interface BearerCheckOk {
  readonly status: "ok";
}
interface BearerCheckFail {
  readonly status: "fail";
  readonly code: 401 | 404;
  readonly body: ReturnType<typeof apiError>;
}

type DeployPublicJsonStatus = 200 | 400 | 409 | 500;

interface DeployPublicHandledResponse {
  readonly status: DeployPublicJsonStatus;
  readonly body: unknown;
}

function checkBearer(
  header: string | undefined,
  expected: string | undefined,
): BearerCheckOk | BearerCheckFail {
  if (!expected) {
    return {
      status: "fail",
      code: 404,
      body: apiError("not_found", "deploy endpoint disabled"),
    };
  }
  const presented = readBearerToken(header);
  if (!presented) {
    return {
      status: "fail",
      code: 401,
      body: apiError("unauthenticated", "missing bearer token"),
    };
  }
  if (!constantTimeEquals(presented, expected)) {
    return {
      status: "fail",
      code: 401,
      body: apiError("unauthenticated", "invalid token"),
    };
  }
  return { status: "ok" };
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
 * snapshot — pre-0.9.0 records lack the field and force a re-apply,
 * which is safe (provider.apply still runs) but not idempotent.
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

function withOperationPlanPreview(input: {
  readonly outcome: ApplyV2Outcome;
  readonly resources: readonly ManifestResource[];
  readonly tenantId: string;
  readonly deploymentName: string;
}): ApplyV2Outcome {
  if (input.outcome.status !== "succeeded") return input.outcome;

  const dag = buildRefDag(input.resources);
  if (dag.issues.length > 0) return input.outcome;
  const resourcesByName = new Map(
    input.resources.map((resource) => [resource.name, resource]),
  );
  const planned = input.outcome.planned ?? dag.order.flatMap((name) => {
    const resource = resourcesByName.get(name);
    return resource
      ? [{
        name: resource.name,
        shape: resource.shape,
        providerId: resource.provider,
        op: "create" as const,
      }]
      : [];
  });

  return {
    ...input.outcome,
    planned,
    operationPlanPreview: buildOperationPlanPreview({
      resources: input.resources,
      planned,
      edges: dag.edges,
      spaceId: input.tenantId,
      deploymentName: input.deploymentName,
    }),
  };
}

async function handleRecoveryPreflight(input: {
  readonly store: OperationJournalStore;
  readonly tenantId: string;
  readonly deploymentName: string;
  readonly requestedPhase: OperationJournalPhase;
  readonly operationPlanDigest: `sha256:${string}`;
  readonly recoveryMode?: DeployPublicRecoveryMode;
}): Promise<DeployPublicHandledResponse | undefined> {
  const entries = await input.store.listByDeployment(
    input.tenantId,
    input.deploymentName,
  );
  const journal = summarizeLatestJournal(entries);
  if (input.recoveryMode === "inspect") {
    const ok: DeployPublicRecoveryInspectResponse = {
      status: "ok",
      outcome: {
        status: "recovery-inspect",
        tenantId: input.tenantId,
        deploymentName: input.deploymentName,
        ...(journal ? { journal } : {}),
        entries: entries.map(toJournalEntrySummary),
      },
    };
    return { status: 200, body: ok as unknown as JsonObject };
  }
  if (input.recoveryMode === "continue") {
    if (!journal || journal.terminal) {
      return {
        status: 409,
        body: apiError(
          "failed_precondition",
          `deployment ${input.deploymentName} has no unfinished public WAL ` +
            `to continue`,
        ),
      };
    }
    if (journal.status === "failed") {
      return {
        status: 409,
        body: apiError(
          "failed_precondition",
          `deployment ${input.deploymentName} has failed public WAL ` +
            `phase=${journal.phase} stage=${journal.latestStage}; inspect ` +
            `before choosing compensate or a new apply/destroy`,
        ),
      };
    }
    if (journal.phase !== input.requestedPhase) {
      return {
        status: 409,
        body: apiError(
          "failed_precondition",
          `recoveryMode continue refused: unfinished public WAL phase=` +
            `${journal.phase} does not match requested phase=` +
            `${input.requestedPhase}`,
        ),
      };
    }
    if (journal.operationPlanDigest !== input.operationPlanDigest) {
      return {
        status: 409,
        body: apiError(
          "failed_precondition",
          `recoveryMode continue refused: request operationPlanDigest=` +
            `${input.operationPlanDigest} does not match unfinished public ` +
            `WAL operationPlanDigest=${journal.operationPlanDigest}`,
        ),
      };
    }
    if (!isContinuableRecoveryStage(journal.latestStage)) {
      return {
        status: 409,
        body: apiError(
          "failed_precondition",
          `recoveryMode continue refused: public WAL stage=` +
            `${journal.latestStage} is not continuable`,
        ),
      };
    }
    return undefined;
  }
  if (input.recoveryMode === "compensate") {
    if (!journal || journal.terminal) {
      return {
        status: 409,
        body: apiError(
          "failed_precondition",
          `deployment ${input.deploymentName} has no unfinished public WAL ` +
            `to compensate`,
        ),
      };
    }
    if (journal.phase !== input.requestedPhase) {
      return {
        status: 409,
        body: apiError(
          "failed_precondition",
          `recoveryMode compensate refused: unfinished public WAL phase=` +
            `${journal.phase} does not match requested phase=` +
            `${input.requestedPhase}`,
        ),
      };
    }
    if (journal.operationPlanDigest !== input.operationPlanDigest) {
      return {
        status: 409,
        body: apiError(
          "failed_precondition",
          `recoveryMode compensate refused: request operationPlanDigest=` +
            `${input.operationPlanDigest} does not match unfinished public ` +
            `WAL operationPlanDigest=${journal.operationPlanDigest}`,
        ),
      };
    }
    if (!isCompensableRecoveryStage(journal.latestStage)) {
      return {
        status: 409,
        body: apiError(
          "failed_precondition",
          `recoveryMode compensate refused: public WAL stage=` +
            `${journal.latestStage} has no committed effect to compensate`,
        ),
      };
    }
    return undefined;
  }
  if (journal && !journal.terminal) {
    return {
      status: 409,
      body: apiError(
        "failed_precondition",
        `deployment ${input.deploymentName} has unfinished public WAL ` +
          `phase=${journal.phase} stage=${journal.latestStage} ` +
          `status=${journal.status}; retry with recoveryMode: "inspect" ` +
          `or continue the same OperationPlan with recoveryMode: ` +
          `"continue", or compensate committed effects with recoveryMode: ` +
          `"compensate" before starting another apply/destroy`,
      ),
    };
  }
  return undefined;
}

async function handleRecoveryCompensate(input: {
  readonly journalStore: OperationJournalStore;
  readonly revokeDebtStore: RevokeDebtStore;
  readonly preview: OperationPlanPreview;
  readonly phase: OperationJournalPhase;
  readonly tenantId: string;
  readonly deploymentName: string;
  readonly createdAt: string;
}): Promise<DeployPublicHandledResponse> {
  const debts: RevokeDebtRecord[] = [];
  for (const operation of input.preview.operations) {
    debts.push(
      await input.revokeDebtStore.enqueue({
        generatedObjectId: generatedObjectIdForPublicOperation({
          deploymentName: input.deploymentName,
          resourceName: operation.resourceName,
        }),
        reason: "activation-rollback",
        ownerSpaceId: input.tenantId,
        deploymentName: input.deploymentName,
        operationPlanDigest: input.preview.operationPlanDigest,
        journalEntryId: operation.idempotencyKey.journalEntryId,
        operationId: operation.operationId,
        resourceName: operation.resourceName,
        providerId: operation.providerId,
        now: input.createdAt,
        detail: {
          kind: "takosumi.public-recovery-compensate@v1",
          phase: input.phase,
          operationKind: operation.op,
          desiredSnapshotDigest: input.preview.desiredSnapshotDigest,
          desiredDigest: operation.desiredDigest,
          idempotencyKey: {
            spaceId: operation.idempotencyKey.spaceId,
            operationPlanDigest: operation.idempotencyKey.operationPlanDigest,
            journalEntryId: operation.idempotencyKey.journalEntryId,
          },
        },
      }),
    );
  }
  await appendOperationPlanJournalStages({
    store: input.journalStore,
    preview: input.preview,
    phase: input.phase,
    stages: ["abort"],
    status: "failed",
    createdAt: input.createdAt,
    detail: {
      reason: "compensate-revoke-debt-enqueued",
      revokeDebtIds: debts.map((debt) => debt.id),
    },
  });
  const entries = await input.journalStore.listByDeployment(
    input.tenantId,
    input.deploymentName,
  );
  const journal = summarizeLatestJournal(entries);
  const ok: DeployPublicRecoveryCompensateResponse = {
    status: "ok",
    outcome: {
      status: "recovery-compensate",
      tenantId: input.tenantId,
      deploymentName: input.deploymentName,
      ...(journal ? { journal } : {}),
      debts: debts.map(toRevokeDebtRecordSummary),
    },
  };
  return { status: 200, body: ok as unknown as JsonObject };
}

type CatalogReleaseWalHookStage = "pre-commit" | "post-commit";

type CatalogReleaseWalHookResult =
  | {
    readonly ok: true;
    readonly status: "skipped";
    readonly stage: CatalogReleaseWalHookStage;
  }
  | {
    readonly ok: true;
    readonly status: "succeeded";
    readonly stage: CatalogReleaseWalHookStage;
    readonly descriptorDigest?: string;
    readonly publisherId?: string;
    readonly publisherKeyId?: string;
    readonly executableHook?: CatalogReleaseExecutableHookRunResult;
  }
  | {
    readonly ok: false;
    readonly status: "failed";
    readonly stage: CatalogReleaseWalHookStage;
    readonly reason: string;
    readonly message: string;
    readonly descriptorDigest?: string;
    readonly publisherKeyId?: string;
    readonly executableHook?: CatalogReleaseExecutableHookRunResult & {
      readonly ok: false;
    };
  };

async function invokeCatalogReleaseWalHook(input: {
  readonly verifier?: CatalogReleaseWalHookVerifier;
  readonly spaceId: string;
  readonly stage: CatalogReleaseWalHookStage;
  readonly preview: OperationPlanPreview;
}): Promise<CatalogReleaseWalHookResult> {
  if (!input.verifier) {
    return { ok: true, status: "skipped", stage: input.stage };
  }
  const verification = await input.verifier.verifyCurrentReleaseForSpace(
    input.spaceId,
  );
  if (!verification) {
    return { ok: true, status: "skipped", stage: input.stage };
  }
  if (!verification.ok) {
    return {
      ok: false,
      status: "failed",
      stage: input.stage,
      reason: verification.reason,
      message: verification.message,
      ...(verification.descriptorDigest
        ? { descriptorDigest: verification.descriptorDigest }
        : {}),
      ...(verification.publisherKeyId
        ? { publisherKeyId: verification.publisherKeyId }
        : {}),
    };
  }
  const executableHook = await input.verifier.runExecutableHooks?.(
    executableHookInvocation({
      spaceId: input.spaceId,
      stage: input.stage,
      preview: input.preview,
      verification: verification.ok ? verification : undefined,
    }),
  );
  if (executableHook && !executableHook.ok) {
    return {
      ok: false,
      status: "failed",
      stage: input.stage,
      reason: executableHook.reason,
      message: executableHook.message,
      ...(verification.ok
        ? {
          descriptorDigest: verification.descriptorDigest,
          publisherKeyId: verification.publisherKeyId,
        }
        : {}),
      executableHook,
    };
  }
  return {
    ok: true,
    status: "succeeded",
    stage: input.stage,
    descriptorDigest: verification.descriptorDigest,
    publisherId: verification.publisherId,
    publisherKeyId: verification.publisherKeyId,
    ...(executableHook ? { executableHook } : {}),
  };
}

async function handleCatalogReleasePreCommitFailure(input: {
  readonly journalStore: OperationJournalStore;
  readonly preview: OperationPlanPreview;
  readonly phase: OperationJournalPhase;
  readonly createdAt: string;
  readonly hook: CatalogReleaseWalHookResult & { readonly ok: false };
}): Promise<DeployPublicHandledResponse> {
  await appendOperationPlanJournalStages({
    store: input.journalStore,
    preview: input.preview,
    phase: input.phase,
    stages: ["abort"],
    status: "failed",
    createdAt: input.createdAt,
    detail: {
      reason: "catalog-release-pre-commit-hook-failed",
      catalogReleaseHook: catalogReleaseWalHookDetailRequired(input.hook),
    },
  });
  return {
    status: 409,
    body: apiError(
      "failed_precondition",
      `CatalogRelease pre-commit hook failed: ${input.hook.message}`,
    ),
  };
}

async function handleCatalogReleasePostCommitFailure(input: {
  readonly journalStore: OperationJournalStore;
  readonly revokeDebtStore: RevokeDebtStore;
  readonly preview: OperationPlanPreview;
  readonly phase: OperationJournalPhase;
  readonly tenantId: string;
  readonly deploymentName: string;
  readonly createdAt: string;
  readonly hook: CatalogReleaseWalHookResult & { readonly ok: false };
}): Promise<DeployPublicHandledResponse> {
  const debts = await enqueueCatalogReleaseHookFailureDebts({
    revokeDebtStore: input.revokeDebtStore,
    preview: input.preview,
    phase: input.phase,
    tenantId: input.tenantId,
    deploymentName: input.deploymentName,
    createdAt: input.createdAt,
    hook: input.hook,
  });
  await appendOperationPlanJournalStages({
    store: input.journalStore,
    preview: input.preview,
    phase: input.phase,
    stages: ["post-commit"],
    status: "failed",
    createdAt: input.createdAt,
    detail: {
      reason: "catalog-release-post-commit-hook-failed",
      catalogReleaseHook: catalogReleaseWalHookDetailRequired(input.hook),
      revokeDebtIds: debts.map((debt) => debt.id),
    },
  });
  await appendOperationPlanJournalStages({
    store: input.journalStore,
    preview: input.preview,
    phase: input.phase,
    stages: ["observe", "finalize"],
    status: "succeeded",
    createdAt: input.createdAt,
    detail: {
      reason: "catalog-release-post-commit-hook-failed-observed",
      revokeDebtIds: debts.map((debt) => debt.id),
    },
  });
  return {
    status: 409,
    body: apiError(
      "failed_precondition",
      `CatalogRelease post-commit hook failed after provider commit; ` +
        `RevokeDebt enqueued: ${input.hook.message}`,
    ),
  };
}

async function enqueueCatalogReleaseHookFailureDebts(input: {
  readonly revokeDebtStore: RevokeDebtStore;
  readonly preview: OperationPlanPreview;
  readonly phase: OperationJournalPhase;
  readonly tenantId: string;
  readonly deploymentName: string;
  readonly createdAt: string;
  readonly hook: CatalogReleaseWalHookResult & { readonly ok: false };
}): Promise<readonly RevokeDebtRecord[]> {
  const debts: RevokeDebtRecord[] = [];
  for (const operation of input.preview.operations) {
    debts.push(
      await input.revokeDebtStore.enqueue({
        generatedObjectId: generatedObjectIdForPublicOperation({
          deploymentName: input.deploymentName,
          resourceName: operation.resourceName,
        }),
        reason: "approval-invalidated",
        ownerSpaceId: input.tenantId,
        deploymentName: input.deploymentName,
        operationPlanDigest: input.preview.operationPlanDigest,
        journalEntryId: operation.idempotencyKey.journalEntryId,
        operationId: operation.operationId,
        resourceName: operation.resourceName,
        providerId: operation.providerId,
        now: input.createdAt,
        detail: {
          kind: "takosumi.catalog-release-hook-failure@v1",
          phase: input.phase,
          hookStage: input.hook.stage,
          failureReason: input.hook.reason,
          desiredSnapshotDigest: input.preview.desiredSnapshotDigest,
          desiredDigest: operation.desiredDigest,
          idempotencyKey: {
            spaceId: operation.idempotencyKey.spaceId,
            operationPlanDigest: operation.idempotencyKey.operationPlanDigest,
            journalEntryId: operation.idempotencyKey.journalEntryId,
          },
        },
      }),
    );
  }
  return debts;
}

function catalogReleaseWalHookDetail(
  hook: CatalogReleaseWalHookResult,
): JsonObject | undefined {
  if (hook.status === "skipped") return undefined;
  if (!hook.ok) {
    return {
      kind: "takosumi.catalog-release-wal-hook@v1",
      stage: hook.stage,
      status: hook.status,
      reason: hook.reason,
      ...(hook.descriptorDigest
        ? { descriptorDigest: hook.descriptorDigest }
        : {}),
      ...(hook.publisherKeyId ? { publisherKeyId: hook.publisherKeyId } : {}),
      ...(hook.executableHook
        ? { executableHook: executableHookDetail(hook.executableHook) }
        : {}),
    };
  }
  return {
    kind: "takosumi.catalog-release-wal-hook@v1",
    stage: hook.stage,
    status: hook.status,
    ...(hook.descriptorDigest
      ? { descriptorDigest: hook.descriptorDigest }
      : {}),
    ...(hook.publisherId ? { publisherId: hook.publisherId } : {}),
    ...(hook.publisherKeyId ? { publisherKeyId: hook.publisherKeyId } : {}),
    ...(hook.executableHook
      ? { executableHook: executableHookDetail(hook.executableHook) }
      : {}),
  };
}

function executableHookInvocation(input: {
  readonly spaceId: string;
  readonly stage: CatalogReleaseWalHookStage;
  readonly preview: OperationPlanPreview;
  readonly verification?: CatalogReleaseVerificationResult & {
    readonly ok: true;
  };
}): ExecutableCatalogHookInvocation {
  return {
    spaceId: input.spaceId,
    stage: input.stage,
    operationPlanDigest: input.preview.operationPlanDigest,
    desiredSnapshotDigest: input.preview.desiredSnapshotDigest,
    operations: input.preview.operations.map((operation) => ({
      operationId: operation.operationId,
      resourceName: operation.resourceName,
      providerId: operation.providerId,
      operationKind: operation.op === "create"
        ? "materialize-create"
        : "materialize-delete",
      desiredDigest: operation.desiredDigest,
      journalEntryId: operation.idempotencyKey.journalEntryId,
      idempotencyKey: operation.idempotencyKey,
    })),
    ...(input.verification
      ? {
        catalogRelease: {
          descriptorDigest: input.verification.descriptorDigest,
          publisherId: input.verification.publisherId,
          publisherKeyId: input.verification.publisherKeyId,
        },
      }
      : {}),
  };
}

function executableHookDetail(
  hook: CatalogReleaseExecutableHookRunResult,
): JsonObject {
  if (hook.status === "skipped") {
    return {
      kind: "takosumi.catalog-release-executable-hook@v1",
      stage: hook.stage,
      status: hook.status,
    };
  }
  if (!hook.ok) {
    return {
      kind: "takosumi.catalog-release-executable-hook@v1",
      stage: hook.stage,
      status: hook.status,
      packageId: hook.packageId,
      packageVersion: hook.packageVersion,
      reason: hook.reason,
      packages: executableHookPackageDetails(hook.packages),
      ...(hook.metadata ? { metadata: hook.metadata } : {}),
    };
  }
  return {
    kind: "takosumi.catalog-release-executable-hook@v1",
    stage: hook.stage,
    status: hook.status,
    packages: executableHookPackageDetails(hook.packages),
  };
}

function executableHookPackageDetails(
  packages: readonly CatalogReleaseExecutableHookPackageResult[],
): JsonObject[] {
  return packages.map((item) => {
    const detail: JsonObject = {
      packageId: item.packageId,
      packageVersion: item.packageVersion,
      status: item.status,
    };
    if (item.message) detail.message = item.message;
    if (item.reason) detail.reason = item.reason;
    if (isJsonObject(item.metadata)) detail.metadata = item.metadata;
    return detail;
  });
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function catalogReleaseWalHookDetailRequired(
  hook: CatalogReleaseWalHookResult,
): JsonObject {
  const detail = catalogReleaseWalHookDetail(hook);
  if (!detail) {
    throw new Error("CatalogRelease WAL hook detail is required");
  }
  return detail;
}

function catalogReleaseHookDetailField(
  hook: CatalogReleaseWalHookResult,
): JsonObject {
  const detail = catalogReleaseWalHookDetail(hook);
  return detail ? { catalogReleaseHook: detail } : {};
}

function generatedObjectIdForPublicOperation(input: {
  readonly deploymentName: string;
  readonly resourceName: string;
}): string {
  return `generated:takosumi-public-deploy/${
    encodeURIComponent(input.deploymentName)
  }/${encodeURIComponent(input.resourceName)}`;
}

function toRevokeDebtRecordSummary(
  record: RevokeDebtRecord,
): DeploymentRevokeDebtRecordSummary {
  return {
    id: record.id,
    generatedObjectId: record.generatedObjectId,
    reason: record.reason,
    status: record.status,
    ownerSpaceId: record.ownerSpaceId,
    originatingSpaceId: record.originatingSpaceId,
    ...(record.deploymentName ? { deploymentName: record.deploymentName } : {}),
    ...(record.operationPlanDigest
      ? { operationPlanDigest: record.operationPlanDigest }
      : {}),
    ...(record.journalEntryId ? { journalEntryId: record.journalEntryId } : {}),
    ...(record.operationId ? { operationId: record.operationId } : {}),
    ...(record.resourceName ? { resourceName: record.resourceName } : {}),
    ...(record.providerId ? { providerId: record.providerId } : {}),
    retryAttempts: record.retryAttempts,
    createdAt: record.createdAt,
    statusUpdatedAt: record.statusUpdatedAt,
    ...(record.lastRetryAt ? { lastRetryAt: record.lastRetryAt } : {}),
    ...(record.nextRetryAt ? { nextRetryAt: record.nextRetryAt } : {}),
    ...(record.agedAt ? { agedAt: record.agedAt } : {}),
    ...(record.clearedAt ? { clearedAt: record.clearedAt } : {}),
  };
}

function buildPublicOperationPlanPreview(input: {
  readonly resources: readonly ManifestResource[];
  readonly tenantId: string;
  readonly deploymentName: string;
  readonly op: PlannedResource["op"];
}) {
  const dag = buildRefDag(input.resources);
  if (dag.issues.length > 0) {
    // The caller has already accepted `resolveManifestResourcesV1`; ref-DAG
    // validation errors will be surfaced by applyV2/destroyV2. Build a stable
    // fallback order so the journal still records the rejected intent.
    const planned = input.resources.map((resource) => ({
      name: resource.name,
      shape: resource.shape,
      providerId: resource.provider,
      op: input.op,
    }));
    return buildOperationPlanPreview({
      resources: input.resources,
      planned,
      edges: [],
      spaceId: input.tenantId,
      deploymentName: input.deploymentName,
    });
  }
  const resourcesByName = new Map(
    input.resources.map((resource) => [resource.name, resource]),
  );
  const orderedNames = input.op === "delete"
    ? [...dag.order].reverse()
    : dag.order;
  const planned: PlannedResource[] = orderedNames.flatMap((name) => {
    const resource = resourcesByName.get(name);
    return resource
      ? [{
        name: resource.name,
        shape: resource.shape,
        providerId: resource.provider,
        op: input.op,
      }]
      : [];
  });
  return buildOperationPlanPreview({
    resources: input.resources,
    planned,
    edges: dag.edges,
    spaceId: input.tenantId,
    deploymentName: input.deploymentName,
  });
}

interface DeploymentResourceSummary {
  readonly name: string;
  readonly shape: string;
  readonly provider: string;
  readonly status: "applied";
  readonly outputs: JsonObject;
  readonly handle: ResourceHandle;
}

interface DeploymentSummary {
  readonly name: string;
  readonly status: TakosumiDeploymentRecord["status"];
  readonly tenantId: string;
  readonly appliedAt: string;
  readonly updatedAt: string;
  readonly journal?: DeploymentJournalSummary;
  readonly revokeDebt?: RevokeDebtSummary;
  readonly resources: readonly DeploymentResourceSummary[];
}

export interface DeploymentJournalSummary {
  readonly operationPlanDigest: `sha256:${string}`;
  readonly phase: OperationJournalPhase;
  readonly latestStage: OperationJournalStage;
  readonly status: OperationJournalStatus;
  readonly entryCount: number;
  readonly failedEntryCount: number;
  readonly terminal: boolean;
  readonly updatedAt: string;
}

export interface DeploymentJournalEntrySummary {
  readonly operationPlanDigest: `sha256:${string}`;
  readonly journalEntryId: string;
  readonly operationId: string;
  readonly phase: OperationJournalPhase;
  readonly stage: OperationJournalStage;
  readonly operationKind: string;
  readonly resourceName?: string;
  readonly providerId?: string;
  readonly effectDigest: `sha256:${string}`;
  readonly status: OperationJournalStatus;
  readonly createdAt: string;
}

export interface DeploymentRevokeDebtRecordSummary {
  readonly id: string;
  readonly generatedObjectId: string;
  readonly reason: RevokeDebtRecord["reason"];
  readonly status: RevokeDebtRecord["status"];
  readonly ownerSpaceId: string;
  readonly originatingSpaceId: string;
  readonly deploymentName?: string;
  readonly operationPlanDigest?: `sha256:${string}`;
  readonly journalEntryId?: string;
  readonly operationId?: string;
  readonly resourceName?: string;
  readonly providerId?: string;
  readonly retryAttempts: number;
  readonly createdAt: string;
  readonly statusUpdatedAt: string;
  readonly lastRetryAt?: string;
  readonly nextRetryAt?: string;
  readonly agedAt?: string;
  readonly clearedAt?: string;
}

async function toDeploymentSummary(
  record: TakosumiDeploymentRecord,
  journalStore: OperationJournalStore,
  revokeDebtStore: RevokeDebtStore,
): Promise<DeploymentSummary> {
  const journal = summarizeLatestJournal(
    await journalStore.listByDeployment(record.tenantId, record.name),
  );
  const revokeDebts = await revokeDebtStore.listByDeployment(
    record.tenantId,
    record.name,
  );
  return {
    name: record.name,
    status: record.status,
    tenantId: record.tenantId,
    appliedAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(journal ? { journal } : {}),
    ...(revokeDebts.length > 0
      ? { revokeDebt: summarizeRevokeDebt(revokeDebts) }
      : {}),
    resources: record.appliedResources.map(toResourceSummary),
  };
}

function summarizeLatestJournal(
  entries: readonly OperationJournalEntry[],
): DeploymentJournalSummary | undefined {
  if (entries.length === 0) return undefined;
  const sorted = [...entries].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) ||
    left.operationPlanDigest.localeCompare(right.operationPlanDigest) ||
    left.operationId.localeCompare(right.operationId)
  );
  const latest = sorted.at(-1);
  if (!latest) return undefined;
  const samePlan = entries.filter((entry) =>
    entry.operationPlanDigest === latest.operationPlanDigest &&
    entry.phase === latest.phase
  );
  const stageRanked = [...samePlan].sort((left, right) =>
    journalStageRank(left.stage) - journalStageRank(right.stage) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.operationId.localeCompare(right.operationId)
  );
  const latestStageEntry = stageRanked.at(-1) ?? latest;
  return {
    operationPlanDigest: latest.operationPlanDigest,
    phase: latest.phase,
    latestStage: latestStageEntry.stage,
    status: summarizeJournalStatus(samePlan),
    entryCount: samePlan.length,
    failedEntryCount: samePlan.filter((entry) => entry.status === "failed")
      .length,
    terminal: isTerminalJournalStage(latestStageEntry.stage),
    updatedAt: latestStageEntry.createdAt,
  };
}

function toJournalEntrySummary(
  entry: OperationJournalEntry,
): DeploymentJournalEntrySummary {
  return {
    operationPlanDigest: entry.operationPlanDigest,
    journalEntryId: entry.journalEntryId,
    operationId: entry.operationId,
    phase: entry.phase,
    stage: entry.stage,
    operationKind: entry.operationKind,
    ...(entry.resourceName ? { resourceName: entry.resourceName } : {}),
    ...(entry.providerId ? { providerId: entry.providerId } : {}),
    effectDigest: entry.effectDigest,
    status: entry.status,
    createdAt: entry.createdAt,
  };
}

function summarizeJournalStatus(
  entries: readonly OperationJournalEntry[],
): OperationJournalStatus {
  if (entries.some((entry) => entry.status === "failed")) return "failed";
  if (entries.some((entry) => entry.status === "skipped")) return "skipped";
  if (entries.some((entry) => entry.status === "succeeded")) {
    return "succeeded";
  }
  return "recorded";
}

function isTerminalJournalStage(stage: OperationJournalStage): boolean {
  return stage === "finalize" || stage === "abort" || stage === "skip";
}

function isContinuableRecoveryStage(stage: OperationJournalStage): boolean {
  return stage === "prepare" || stage === "pre-commit" ||
    stage === "commit" || stage === "post-commit" || stage === "observe";
}

function isCompensableRecoveryStage(stage: OperationJournalStage): boolean {
  return stage === "commit" || stage === "post-commit" || stage === "observe";
}

function journalStageRank(stage: OperationJournalStage): number {
  switch (stage) {
    case "prepare":
      return 0;
    case "pre-commit":
      return 1;
    case "commit":
      return 2;
    case "post-commit":
      return 3;
    case "observe":
      return 4;
    case "finalize":
      return 5;
    case "abort":
      return 6;
    case "skip":
      return 7;
  }
}

function toResourceSummary(
  entry: TakosumiAppliedResourceRecord,
): DeploymentResourceSummary {
  return {
    name: entry.resourceName,
    shape: entry.shape,
    provider: entry.providerId,
    status: "applied",
    outputs: entry.outputs,
    handle: entry.handle,
  };
}

function readBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const prefix = "bearer ";
  if (trimmed.length <= prefix.length) return undefined;
  if (trimmed.slice(0, prefix.length).toLowerCase() !== prefix) {
    return undefined;
  }
  const value = trimmed.slice(prefix.length).trim();
  return value.length > 0 ? value : undefined;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function readJsonBody(
  request: Request,
): Promise<
  | { ok: true; value: Record<string, unknown>; rawText: string }
  | { ok: false; error: string }
> {
  const text = await request.text();
  if (text.trim() === "") return { ok: true, value: {}, rawText: text };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new MalformedJsonRequestError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "request body must be a JSON object" };
  }
  return { ok: true, value: value as Record<string, unknown>, rawText: text };
}

function readIdempotencyKey(
  header: string | undefined,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: string } {
  const trimmed = header?.trim();
  if (!trimmed) {
    return { ok: true, value: `generated:${crypto.randomUUID()}` };
  }
  if (trimmed.length > 256) {
    return {
      ok: false,
      error: "X-Idempotency-Key must be at most 256 characters",
    };
  }
  return { ok: true, value: trimmed };
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return "sha256:" + Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function readMode(
  value: unknown,
):
  | { ok: true; value: DeployPublicMode }
  | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: "apply" };
  if (value === "apply" || value === "plan" || value === "destroy") {
    return { ok: true, value };
  }
  return {
    ok: false,
    error: "mode must be one of apply|plan|destroy",
  };
}

function readRecoveryMode(
  value: unknown,
):
  | { ok: true; value?: DeployPublicRecoveryMode }
  | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (
    value === "inspect" || value === "continue" || value === "compensate"
  ) {
    return { ok: true, value };
  }
  return {
    ok: false,
    error:
      "recoveryMode must be one of inspect|continue|compensate when provided",
  };
}

function platformRecoveryMode(
  value: DeployPublicRecoveryMode | undefined,
): PlatformOperationRecoveryMode {
  return value ?? "normal";
}

/**
 * Build a `PlatformContext` from the kernel's `AppContext`. The kernel's
 * adapters (`secrets` / `observability` / `kms` / `objectStorage`) implement
 * the contract's `PlatformContext` ports directly, so we just thread them
 * through. `refResolver` is overwritten per-resource by `applyV2` itself; the
 * fallback returned here is never invoked during a normal apply.
 */
function platformContextFromAppContext(
  appContext: AppContext,
  tenantId: string,
): PlatformContext {
  const adapters = appContext.adapters;
  return {
    tenantId,
    spaceId: tenantId,
    secrets: adapters.secrets as PlatformContext["secrets"],
    observability: adapters.observability as PlatformContext["observability"],
    kms: adapters.kms as PlatformContext["kms"],
    objectStorage: adapters.objectStorage as PlatformContext["objectStorage"],
    refResolver: PUBLIC_DEPLOY_REF_RESOLVER,
    resolvedOutputs: new Map<string, JsonObject>(),
  };
}

const PUBLIC_DEPLOY_REF_RESOLVER: RefResolver = {
  resolve(_expression: string) {
    // applyV2 builds its own per-resource ref resolver; this fallback is
    // never invoked during a shape-model apply.
    return null;
  },
};
