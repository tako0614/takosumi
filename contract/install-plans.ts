/**
 * Durable Git lifecycle coordinator contract.
 *
 * An install plan is orchestration evidence only. It may register/sync a Git
 * Source, compile a Takosumi-owned InstallConfig, create a Capsule and create
 * one canonical Plan Run. It never approves or applies that Run.
 */

export type GitInstallPlanPhase =
  | "syncing_source"
  | "compiling_install"
  | "analyzing_compatibility"
  | "creating_capsule"
  | "planning"
  | "reviewable"
  | "failed";

export type GitInstallPlanOperation = "install" | "revision";

export interface GitInstallPlanSourceRequest {
  readonly name: string;
  readonly url: string;
  readonly ref: string;
  readonly path: string;
  /** Reference only. Credential values never enter this record. */
  readonly authConnectionId?: string;
}

export interface GitInstallPlanCapsuleRequest {
  readonly name: string;
  readonly environment: string;
}

export interface GitInstallPlanOptions {
  /** Opaque key of a pre-existing, server-owned deployment profile. */
  readonly deploymentProfileKey?: string;
  /** Provider name to pre-existing ProviderConnection id. Values are forbidden. */
  readonly providerBindingConnectionIds?: Readonly<Record<string, string>>;
}

export interface CreateGitInstallPlanRequest {
  readonly source: GitInstallPlanSourceRequest;
  readonly capsule: GitInstallPlanCapsuleRequest;
  readonly options?: GitInstallPlanOptions;
}

/** Exact, value-free upgrade intent for an existing Capsule. */
export interface CreateGitRevisionPlanRequest {
  readonly ref: string;
}

export interface GitRevisionPlanBase {
  readonly capsuleStateGeneration: number;
  readonly capsuleStateVersionId?: string;
  readonly installConfigId: string;
  readonly installConfigDigest: string;
  readonly sourceDefaultRef: string;
  readonly sourceDefaultPath: string;
  readonly sourceAuthConnectionId?: string;
}

export interface GitRevisionPlanIntent {
  readonly targetRef: string;
  readonly base: GitRevisionPlanBase;
}

export interface GitInstallPlanDiagnostic {
  /** Stable, bounded classification. Clients must not parse the message. */
  readonly code: string;
  /** Bounded non-secret operator/user guidance. */
  readonly message: string;
  /** Coarse coordinator boundary where a retryable step could not be confirmed. */
  readonly planCreationStage?: "source" | "preparation" | "create";
  /** Bounded deploy-control error code, when the owner returned one. */
  readonly controllerCode?: string;
  /** Bounded structured reason from the owner error contract; never exception prose. */
  readonly reason?: string;
}

/** Public, secret-free coordinator record. */
export interface GitInstallPlan {
  readonly id: string;
  readonly workspaceId: string;
  readonly createdBy: string;
  /** Missing only on records created before operation discrimination. */
  readonly operation?: GitInstallPlanOperation;
  /** Digest of the normalized immutable create request. */
  readonly requestDigest: string;
  readonly source: GitInstallPlanSourceRequest;
  readonly capsule: GitInstallPlanCapsuleRequest;
  readonly options: GitInstallPlanOptions;
  /** Present only for `operation: "revision"`. */
  readonly revision?: GitRevisionPlanIntent;
  readonly sourceId?: string;
  readonly sourceSyncRunId?: string;
  readonly sourceSnapshotId?: string;
  /** Exact DB-owned policy/profile config selected before compatibility analysis. */
  readonly installConfigBaseId?: string;
  /** Digest of the complete selected base config at preparation time. */
  readonly installConfigBaseDigest?: string;
  /** Exact repository module analyzed and later compiled into InstallConfig. */
  readonly installModulePath?: string;
  /** Digest binding plan/request/source/snapshot/base/module evidence. */
  readonly compatibilityRequestDigest?: string;
  /** Deterministic, caller-owned compatibility evidence identities. */
  readonly compatibilityCheckRunId?: string;
  readonly compatibilityReportId?: string;
  readonly installConfigId?: string;
  readonly capsuleId?: string;
  readonly planRunId?: string;
  readonly phase: GitInstallPlanPhase;
  /** Monotonic CAS generation. */
  readonly generation: number;
  readonly diagnostic?: GitInstallPlanDiagnostic;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export type GitRevisionPlan = GitInstallPlan & {
  readonly operation: "revision";
  readonly revision: GitRevisionPlanIntent;
  readonly sourceId: string;
  readonly capsuleId: string;
  readonly installConfigId: string;
};

export interface GitInstallPlanResponse {
  readonly installPlan: GitInstallPlan;
  readonly nextAction: "reconcile" | "review_run" | "none";
  readonly links: {
    readonly self: string;
    readonly reconcile?: string;
    /** Canonical Run review URL. Approval/apply stay exclusively on Run routes. */
    readonly run?: string;
  };
}

export interface GitRevisionPlanResponse {
  readonly revisionPlan: GitRevisionPlan;
  readonly nextAction: "reconcile" | "review_run" | "none";
  readonly links: {
    readonly self: string;
    readonly reconcile?: string;
    /** Canonical Run review URL. Approval/apply stay exclusively on Run routes. */
    readonly run?: string;
  };
}
