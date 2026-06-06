/**
 * Takosumi v1 OpenTofu deployment control-plane API.
 *
 * Repositories are plain OpenTofu modules. Takosumi records runner profiles,
 * PlanRun and ApplyRun ledgers, Installation ledgers, Deployment ledgers, policy
 * decisions, and selected non-sensitive OpenTofu outputs.
 */

import type { JsonValue } from "./types.ts";

export const RUNNER_PROFILES_PATH = "/v1/runner-profiles" as const;
export const PLAN_RUNS_PATH = "/v1/plan-runs" as const;
export const PLAN_RUN_PATH = (id: string): string =>
  `/v1/plan-runs/${encodeURIComponent(id)}`;
export const APPLY_RUNS_PATH = "/v1/apply-runs" as const;
export const APPLY_RUN_PATH = (id: string): string =>
  `/v1/apply-runs/${encodeURIComponent(id)}`;
export const INSTALLATION_PATH = (id: string): string =>
  `/v1/installations/${encodeURIComponent(id)}`;
export const INSTALLATION_DEPLOYMENTS_PATH = (id: string): string =>
  `/v1/installations/${encodeURIComponent(id)}/deployments`;
export const INSTALLATION_DEPLOYMENT_OUTPUTS_PATH = (id: string): string =>
  `/v1/installations/${encodeURIComponent(id)}/deployment-outputs`;

export type OpenTofuModuleSourceKind = "git" | "local" | "prepared";

export interface GitOpenTofuModuleSource {
  readonly kind: "git";
  /** HTTPS Git URL. Credentials must not be embedded in the URL. */
  readonly url: string;
  readonly ref?: string;
  readonly commit?: string;
  /**
   * Path to the OpenTofu root module inside the repository. Omitted means repo
   * root.
   */
  readonly modulePath?: string;
}

export interface LocalOpenTofuModuleSource {
  readonly kind: "local";
  /** Service-local path for dev/operator-local profiles. */
  readonly path: string;
  readonly modulePath?: string;
}

export interface PreparedOpenTofuModuleSource {
  readonly kind: "prepared";
  /** HTTPS URL for an operator-prepared source archive. */
  readonly url: string;
  /** Digest of the prepared source archive payload bytes. */
  readonly digest: string;
  readonly modulePath?: string;
}

export type OpenTofuModuleSource =
  | GitOpenTofuModuleSource
  | LocalOpenTofuModuleSource
  | PreparedOpenTofuModuleSource;

export type OpenTofuOperation = "create" | "update" | "destroy";

export type RunnerSubstrate =
  | "cloudflare-containers"
  | "local"
  | "external";

export interface RunnerStateLockPolicy {
  readonly kind: "native" | "operator" | "none" | string;
  readonly ref?: string;
}

export interface RunnerStateBackend {
  readonly kind: "operator-managed" | "remote" | "local" | string;
  readonly ref?: string;
  readonly lock?: RunnerStateLockPolicy;
}

export interface RunnerCredentialReference {
  readonly provider: string;
  readonly ref: string;
  readonly required?: boolean;
}

export interface RunnerResourceLimits {
  readonly maxRunSeconds?: number;
  /** Maximum prepared-source archive bytes fetched by the runner. */
  readonly maxSourceArchiveBytes?: number;
  /** Maximum declared decompressed prepared-source bytes before extraction. */
  readonly maxSourceDecompressedBytes?: number;
  readonly cpu?: string;
  readonly memoryMb?: number;
}

export interface RunnerNetworkPolicy {
  readonly mode: "default-deny" | "egress-allowlist" | "operator-managed" | string;
  readonly allowedHosts?: readonly string[];
  readonly allowedHostPatterns?: readonly string[];
}

export interface RunnerSourcePolicy {
  readonly allowLocalSource?: boolean;
}

export interface CloudflareContainerExecution {
  readonly image: string;
  readonly queueName?: string;
  readonly durableObjectBinding?: string;
  readonly workDir?: string;
}

export interface CloudflareWorkersForPlatformsExecution {
  readonly dispatchNamespace: string;
  readonly dispatchWorkerBinding?: string;
  readonly outboundWorker?: CloudflareOutboundWorkerPolicy;
  readonly userWorkerBindings?: CloudflareUserWorkerBindingPolicy;
}

export interface CloudflareOutboundWorkerPolicy {
  readonly serviceBinding?: string;
  readonly enforceNetworkPolicy?: boolean;
}

export interface CloudflareUserWorkerBindingPolicy {
  readonly mode:
    | "none"
    | "tenant-scoped-only"
    | "operator-managed"
    | string;
  readonly allowedBindingKinds?: readonly string[];
}

export interface RunnerSecretExposurePolicy {
  readonly providerCredentials: "runner-only" | "operator-managed" | string;
  readonly tenantWorkerOperatorSecrets:
    | "forbidden"
    | "tenant-scoped-references-only"
    | "operator-managed"
    | string;
  readonly redactLogs?: boolean;
  readonly blockSensitiveOutputs?: boolean;
}

export interface RunnerProfile {
  readonly id: string;
  readonly name: string;
  readonly substrate: RunnerSubstrate | string;
  readonly description?: string;
  readonly tofuVersion?: string;
  readonly stateBackend: RunnerStateBackend;
  readonly allowedProviders: readonly string[];
  readonly deniedProviders?: readonly string[];
  readonly credentialRefs?: readonly RunnerCredentialReference[];
  readonly requireCredentialRefs?: boolean;
  readonly sourcePolicy?: RunnerSourcePolicy;
  readonly resourceLimits?: RunnerResourceLimits;
  readonly networkPolicy?: RunnerNetworkPolicy;
  readonly cloudflareContainer?: CloudflareContainerExecution;
  readonly cloudflareWorkersForPlatforms?: CloudflareWorkersForPlatformsExecution;
  readonly secretExposurePolicy?: RunnerSecretExposurePolicy;
  readonly concurrency?: number;
  readonly labels?: Readonly<Record<string, string>>;
  readonly createdAt: number;
}

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

export interface PolicyDecision {
  readonly status: "passed" | "blocked";
  readonly reasons: readonly string[];
  readonly checkedAt: number;
}

export interface DeployControlAuditEvent {
  readonly id: string;
  readonly type: string;
  readonly at: number;
  readonly actor?: string;
  readonly message?: string;
  readonly data?: Readonly<Record<string, JsonValue>>;
}

export interface PlanRun {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId?: string;
  readonly installationCurrentDeploymentId?: string | null;
  readonly source: OpenTofuModuleSource;
  readonly sourceDigest: string;
  readonly operation: OpenTofuOperation;
  readonly runnerProfileId: string;
  readonly variablesDigest: string;
  readonly requiredProviders: readonly string[];
  readonly status: RunStatus;
  readonly policy: PolicyDecision;
  readonly policyDecisionDigest: string;
  readonly planDigest?: string;
  readonly planArtifact?: OpenTofuPlanArtifact;
  readonly sourceCommit?: string;
  readonly providerLockDigest?: string;
  readonly summary?: PlanRunSummary;
  readonly diagnostics?: readonly RunDiagnostic[];
  readonly auditEvents: readonly DeployControlAuditEvent[];
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Set when the queued run begins executing in the consumer. */
  readonly startedAt?: number;
  /**
   * Liveness marker refreshed while the run executes. Used by the queue consumer
   * idempotency guard to take over a run left `running` by a crashed consumer
   * once the heartbeat is stale (older than the takeover window).
   */
  readonly heartbeatAt?: number;
  readonly finishedAt?: number;
  /**
   * State generation observed for this PlanRun's target at creation time. The
   * apply consumer rejects when the target's current generation has advanced
   * past this value (`state_generation_mismatch`), so a stale plan cannot apply
   * over a newer state. `create` plans have no prior target and record `0`.
   */
  readonly baseStateGeneration?: number;
  /**
   * Set to the ApplyRun id once this PlanRun has been successfully applied.
   * Enforces apply-once: a succeeded PlanRun (especially a `create` plan, which
   * otherwise allocates a fresh Installation/Deployment on every apply) may be
   * applied only once. Cleared/unset means the plan has not yet been applied.
   */
  readonly appliedApplyRunId?: string;
}

export interface PlanRunSummary {
  readonly add?: number;
  readonly change?: number;
  readonly destroy?: number;
}

export interface OpenTofuPlanArtifact {
  readonly kind: "runner-local" | "object-storage" | "remote" | string;
  readonly ref: string;
  readonly digest: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly createdAt?: number;
}

export interface RunDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly detail?: string;
}

export interface ApplyRun {
  readonly id: string;
  readonly planRunId: string;
  readonly spaceId: string;
  readonly installationId?: string;
  readonly deploymentId?: string;
  readonly operation: OpenTofuOperation;
  readonly runnerProfileId: string;
  readonly status: RunStatus;
  readonly approval?: RunApproval;
  readonly expected: ApplyExpectedGuard;
  readonly stateBackend: RunnerStateBackend;
  readonly stateLock: RunnerStateLockEvidence;
  readonly outputs?: readonly DeploymentOutput[];
  readonly diagnostics?: readonly RunDiagnostic[];
  readonly auditEvents: readonly DeployControlAuditEvent[];
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Set when the queued run begins executing in the consumer. */
  readonly startedAt?: number;
  /**
   * Liveness marker refreshed while the run executes. Drives the queue consumer
   * idempotency guard's stale-takeover window (see {@link PlanRun.heartbeatAt}).
   */
  readonly heartbeatAt?: number;
  readonly finishedAt?: number;
}

export interface RunnerStateLockEvidence {
  readonly status: "pending" | "recorded" | "not_required";
  readonly backendRef: string;
  readonly lockRef?: string;
  readonly acquiredAt?: number;
  readonly releasedAt?: number;
}

export interface RunApproval {
  readonly approvedBy?: string;
  readonly approvedAt?: number;
  readonly reason?: string;
}

export interface ApplyExpectedGuard {
  readonly planRunId: string;
  readonly installationId?: string;
  readonly currentDeploymentId?: string | null;
  readonly runnerProfileId: string;
  readonly sourceDigest: string;
  readonly variablesDigest: string;
  readonly policyDecisionDigest: string;
  readonly planDigest: string;
  readonly planArtifactDigest: string;
  readonly sourceCommit?: string;
  readonly providerLockDigest?: string;
}

export type InstallationStatus =
  | "installing"
  | "ready"
  | "failed"
  | "destroying"
  | "destroyed"
  | "suspended";

export interface Installation {
  readonly id: string;
  readonly spaceId: string;
  readonly appId: string;
  readonly source: OpenTofuModuleSource;
  readonly runnerProfileId: string;
  readonly currentDeploymentId: string | null;
  readonly status: InstallationStatus;
  /**
   * Monotonic state generation for this Installation's OpenTofu state. Bumped
   * atomically with each successful apply/destroy state persist; a PlanRun that
   * recorded an older `baseStateGeneration` is rejected at apply. Absent on
   * legacy records is read as `0`.
   */
  readonly stateGeneration?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type DeploymentStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "destroyed";

export interface Deployment {
  readonly id: string;
  readonly installationId: string;
  readonly planRunId: string;
  readonly applyRunId: string;
  readonly source: OpenTofuModuleSource;
  readonly runnerProfileId: string;
  readonly status: DeploymentStatus;
  readonly planDigest?: string;
  readonly sourceCommit?: string;
  readonly providerLockDigest?: string;
  readonly outputs: readonly DeploymentOutput[];
  readonly auditEvents: readonly DeployControlAuditEvent[];
  readonly createdAt: number;
  readonly completedAt?: number;
}

export type DeploymentOutputKind =
  | "launch_url"
  | "admin_url"
  | "health_url"
  | "docs_url"
  | "service_url"
  | string;

export interface DeploymentOutput {
  readonly name: string;
  readonly kind: DeploymentOutputKind;
  readonly value: JsonValue;
  readonly sensitive: false;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface OpenTofuOutputValue {
  readonly sensitive?: boolean;
  readonly type?: JsonValue;
  readonly value: JsonValue;
}

export type OpenTofuOutputEnvelope = Readonly<
  Record<string, OpenTofuOutputValue>
>;

export interface ListRunnerProfilesResponse {
  readonly runnerProfiles: readonly RunnerProfile[];
}

export interface CreatePlanRunRequest {
  readonly spaceId: string;
  readonly source: OpenTofuModuleSource;
  readonly runnerProfileId?: string;
  readonly installationId?: string;
  readonly operation?: OpenTofuOperation;
  readonly variables?: Readonly<Record<string, JsonValue>>;
  readonly requiredProviders?: readonly string[];
}

export interface PlanRunResponse {
  readonly planRun: PlanRun;
}

export interface CreateApplyRunRequest {
  readonly planRunId: string;
  readonly approval?: RunApproval;
  readonly expected: ApplyExpectedGuard;
}

export interface ApplyRunResponse {
  readonly applyRun: ApplyRun;
  readonly installation?: Installation;
  readonly deployment?: Deployment;
}

export interface GetInstallationResponse {
  readonly installation: Installation;
}

export interface ListDeploymentsResponse {
  readonly deployments: readonly Deployment[];
}

export interface ListDeploymentOutputsResponse {
  readonly outputs: readonly DeploymentOutput[];
}

// ---------------------------------------------------------------------------
// Connections (provider credential registration — Phase 1A credential core).
//
// A Connection records that a Space has registered provider credentials with
// Takosumi. The secret values are NEVER part of the public Connection type:
// they are write-only on `POST /v1/connections` and are sealed into a separate
// secret blob by the in-process Vault broker. Phase 1 supports the
// `static_secret` authMethod for the `cloudflare` provider end-to-end; the
// type unions anticipate `aws_assume_role` / `github_app_installation` later.
// ---------------------------------------------------------------------------

export const CONNECTIONS_PATH = "/v1/connections" as const;
export const CONNECTION_PATH = (id: string): string =>
  `/v1/connections/${encodeURIComponent(id)}`;
export const CONNECTION_TEST_PATH = (id: string): string =>
  `/v1/connections/${encodeURIComponent(id)}/test`;

/**
 * Credential acquisition method. Phase 1 implements `static_secret`; the other
 * members are reserved so consumers can switch exhaustively ahead of their
 * implementation (Phase 1B+).
 */
export type ConnectionAuthMethod =
  | "static_secret"
  | "aws_assume_role"
  | "github_app_installation";

/** Whether the credentials belong to the operator (service) or the customer. */
export type ConnectionOwner = "service" | "customer";

export type ConnectionStatus = "pending" | "verified" | "revoked";

/**
 * Optional provider-scope hints recorded alongside a Connection (non-secret).
 * For cloudflare these narrow the account / zone the credentials act on.
 */
export interface ConnectionScope {
  readonly accountId?: string;
  readonly zoneId?: string;
}

/**
 * Public Connection record. NEVER carries secret values. `envNames` lists which
 * provider env vars this Connection supplies (validated against
 * provider-env-rules); the values themselves live only in the sealed secret
 * blob owned by the Vault broker.
 */
export interface Connection {
  readonly id: string;
  readonly spaceId: string;
  /** `cloudflare` short name or a full registry path. */
  readonly provider: string;
  readonly owner: ConnectionOwner;
  readonly authMethod: ConnectionAuthMethod;
  readonly displayName?: string;
  readonly status: ConnectionStatus;
  readonly scope?: ConnectionScope;
  readonly envNames: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly verifiedAt?: string;
}

export interface CreateConnectionRequest {
  readonly spaceId: string;
  readonly provider: string;
  readonly authMethod: "static_secret";
  readonly displayName?: string;
  readonly owner?: ConnectionOwner;
  readonly scope?: ConnectionScope;
  /**
   * Write-only credential values keyed by env name. Validated against the
   * provider's allowed env names and required groups. Never echoed back.
   */
  readonly values: Readonly<Record<string, string>>;
}

export interface ConnectionResponse {
  readonly connection: Connection;
}

export interface ListConnectionsResponse {
  readonly connections: readonly Connection[];
}

export interface TestConnectionResponse {
  readonly status: Extract<ConnectionStatus, "verified" | "pending">;
  readonly detail?: string;
}

export type DeployControlErrorCode =
  | "invalid_argument"
  | "unauthenticated"
  | "permission_denied"
  | "not_found"
  | "failed_precondition"
  | "resource_exhausted"
  | "not_implemented"
  | "internal_error";

export type DeployControlErrorHttpStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 413
  | 500
  | 501;

export const DEPLOY_CONTROL_ERROR_CODES = [
  "invalid_argument",
  "unauthenticated",
  "permission_denied",
  "not_found",
  "failed_precondition",
  "resource_exhausted",
  "not_implemented",
  "internal_error",
] as const satisfies readonly DeployControlErrorCode[];

export const DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE = {
  invalid_argument: 400,
  unauthenticated: 401,
  permission_denied: 403,
  not_found: 404,
  failed_precondition: 409,
  resource_exhausted: 413,
  not_implemented: 501,
  internal_error: 500,
} as const satisfies Record<DeployControlErrorCode, DeployControlErrorHttpStatus>;

export interface DeployControlErrorEnvelope {
  readonly error: {
    readonly code: DeployControlErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly details?: unknown;
  };
}
