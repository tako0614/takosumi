import type {
  JsonObject,
  ManifestResource,
  PlatformContext,
  PlatformOperationRecoveryMode,
  PlatformTraceContext,
  ResourceHandle,
} from "takosumi-contract";
import type { AppContext } from "../app_context.ts";
import type {
  ApplyV2Outcome,
  DestroyV2Outcome,
  OperationPlanPreview,
  PriorAppliedSnapshot,
} from "../domains/deploy/apply_v2.ts";
import type {
  OperationJournalPhase,
  OperationJournalStage,
  OperationJournalStatus,
  OperationJournalStore,
} from "../domains/deploy/operation_journal.ts";
import type { TakosumiDeploymentRecord } from "../domains/deploy/takosumi_deployment_record_store.ts";
import type { TakosumiDeploymentRecordStore } from "../domains/deploy/takosumi_deployment_record_store.ts";
import type { DeployMetricSink } from "../domains/deploy/deploy_metrics.ts";
import type { DeployPublicIdempotencyStore } from "../domains/deploy/deploy_public_idempotency_store.ts";
import type {
  RevokeDebtRecord,
  RevokeDebtStore,
  RevokeDebtSummary,
} from "../domains/deploy/revoke_debt_store.ts";
import type { CatalogReleaseVerificationResult } from "../domains/registry/mod.ts";
import type { CatalogReleaseExecutableHookRunner } from "../plugins/executable_hooks.ts";
import type { ApiErrorEnvelope } from "./errors.ts";

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
export const TAKOSUMI_MANIFEST_ARTIFACT_SIZE_MAX_BYTES_DEFAULT = 52_428_800;

export type DeployPublicMode = "apply" | "plan" | "destroy";
export type DeployPublicRecoveryMode = "inspect" | "continue" | "compensate";
export type DeployPublicProvenance = JsonObject;

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

export interface DeployPublicAuditResponse {
  readonly status: "ok";
  readonly audit: DeploymentAuditSummary;
}

export interface DeploymentAuditSummary {
  readonly deployment: DeploymentSummary;
  readonly journal?: DeploymentJournalSummary;
  readonly provenance?: DeployPublicProvenance;
  readonly causeChain: readonly DeploymentAuditCauseSummary[];
  readonly entries: readonly DeploymentJournalEntrySummary[];
  readonly revokeDebts: readonly DeploymentRevokeDebtRecordSummary[];
}

export interface DeploymentAuditCauseSummary {
  readonly operationPlanDigest: `sha256:${string}`;
  readonly journalEntryId: string;
  readonly operationId: string;
  readonly phase: OperationJournalPhase;
  readonly stage: OperationJournalStage;
  readonly operationKind: string;
  readonly effectDigest: `sha256:${string}`;
  readonly status: OperationJournalStatus;
  readonly createdAt: string;
  readonly resourceName?: string;
  readonly providerId?: string;
  readonly reason?: string;
  readonly outcomeStatus?: string;
  readonly revokeDebtIds?: readonly string[];
  readonly detail?: JsonObject;
  readonly provenance?: DeployPublicProvenance;
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
    trace?: PlatformTraceContext,
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
    trace?: PlatformTraceContext,
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
   * Fallback max for manifest-declared `spec.artifact.size`. Registered
   * artifact-kind `maxSize` values override this per kind.
   */
  readonly artifactMaxBytes?: number;
  /** Optional metric sink for deploy success / latency / rollback counters. */
  readonly observability?: DeployMetricSink;
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

export interface DeploymentResourceSummary {
  readonly name: string;
  readonly shape: string;
  readonly provider: string;
  readonly status: "applied";
  readonly outputs: JsonObject;
  readonly handle: ResourceHandle;
}

export interface DeploymentSummary {
  readonly id: string;
  readonly name: string;
  readonly status: TakosumiDeploymentRecord["status"];
  readonly tenantId: string;
  readonly appliedAt: string;
  readonly updatedAt: string;
  readonly provenance?: DeployPublicProvenance;
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
  readonly provenance?: DeployPublicProvenance;
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

export interface BearerCheckOk {
  readonly status: "ok";
}
export interface BearerCheckFail {
  readonly status: "fail";
  readonly code: 401 | 404;
  readonly body: ApiErrorEnvelope;
}

export type DeployPublicJsonStatus = 200 | 400 | 409 | 413 | 500;

export interface DeployPublicHandledResponse {
  readonly status: DeployPublicJsonStatus;
  readonly body: unknown;
}
