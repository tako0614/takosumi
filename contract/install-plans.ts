/**
 * Durable Git lifecycle coordinator contract.
 *
 * An install plan is orchestration evidence only. It may register/sync a Git
 * Source, compile a Takosumi-owned InstallConfig, create a Capsule and create
 * one canonical Plan Run. It never approves or applies that Run.
 */

import type { JsonValue } from "./types.ts";
import type { InstallConfig } from "./install-configs.ts";

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

/** Value-free, exact identity used to select one Provider Connection. */
export interface GitInstallPlanProviderBindingRequest {
  /** Exact canonical provider source address. */
  readonly provider: string;
  /** Exact child-module local provider name from the scanned module tuple. */
  readonly moduleLocalName: string;
  /** Exact child-module configuration alias; absent means the default. */
  readonly childAlias?: string;
  /** Exact root-module alias wired to the child identity. */
  readonly rootAlias?: string;
  /** Existing Provider Connection id; credential values never enter this record. */
  readonly connectionId: string;
}

export interface GitInstallPlanCapsuleRequest {
  readonly name: string;
  readonly environment: string;
}

export interface GitInstallPlanOptions {
  /**
   * Optional exact OpenTofu module path, relative to the SourceSnapshot
   * subtree. It is a selection hint only until matched against the immutable
   * SourceSnapshot module index.
   */
  readonly modulePath?: string;
  /**
   * Exact child-module provider identities to pre-existing Provider Connection
   * ids. The list is canonicalized and may contain distinct local/alias
   * tuples for the same provider source.
   */
  readonly providerBindings?: readonly GitInstallPlanProviderBindingRequest[];
}

/**
 * Exact successful preflight already observed by an interactive installer.
 * The coordinator revalidates every id and never infers a latest snapshot.
 */
export interface GitInstallPlanPreflightAuthority {
  readonly sourceId: string;
  readonly sourceSnapshotId: string;
  readonly compatibilityCheckRunId: string;
  readonly compatibilityReportId: string;
  readonly installConfigId: string;
}

/** Reviewed fields applied only by the create-only initial authority commit. */
export interface GitInstallPlanInitialConfiguration {
  readonly runnerProfileId?: string;
  readonly outputAllowlist?: InstallConfig["outputAllowlist"];
  readonly interfaceBlueprints?: InstallConfig["interfaceBlueprints"];
  readonly store?: InstallConfig["store"];
  readonly sourceBuild?: InstallConfig["sourceBuild"];
}

export interface CreateGitInstallPlanRequest {
  readonly source: GitInstallPlanSourceRequest;
  readonly capsule: GitInstallPlanCapsuleRequest;
  readonly options?: GitInstallPlanOptions;
  readonly preflight?: GitInstallPlanPreflightAuthority;
  /** Private reviewed inputs; never projected from the coordinator record. */
  readonly variables?: Readonly<Record<string, JsonValue>>;
  /** Private create-only configuration; never projected from the coordinator record. */
  readonly initialConfiguration?: GitInstallPlanInitialConfiguration;
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
  /** Exact value-free preflight identity, when supplied by an installer. */
  readonly preflight?: GitInstallPlanPreflightAuthority;
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
