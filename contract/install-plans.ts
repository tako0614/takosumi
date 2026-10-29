/**
 * Durable Git lifecycle coordinator contract.
 *
 * An install plan is orchestration evidence only. It may register/sync a Git
 * Source, compile a Takosumi-owned InstallConfig, create a Capsule and create
 * one canonical Plan Run. It never approves or applies that Run.
 *
 * An install plan created with `mode: "attempt"` is an install attempt: the
 * coordinator owns the whole attempt (Source sync, module scan, compatibility
 * analysis and connection matching) and pauses in `awaiting_input` whenever it
 * needs the user, including once before it creates the Capsule. Clients follow
 * `userAction`, answer with `PATCH /api/v1/install-plans/:id`, and may discard
 * the attempt with `DELETE /api/v1/install-plans/:id`.
 *
 * An install plan created without `mode` can also be discarded by its creator
 * while it has not recorded its Capsule (syncing the Source through creating
 * the Capsule, or `failed` there). A name already used by another live app
 * ends such a plan `failed` with `capsule_name_conflict`.
 */

import type { JsonValue } from "./types.ts";
import type {
  InstallConfig,
  InstallConfigStoreText,
} from "./install-configs.ts";
import type { CapsuleResourceSummary } from "./capsules.ts";
import type { ProviderConnection } from "./connections.ts";

export type GitInstallPlanPhase =
  | "syncing_source"
  | "compiling_install"
  | "analyzing_compatibility"
  /**
   * Attempt mode only. Idle and lease-free until the actor answers through
   * PATCH; holds no execution authority and is not a Workspace management
   * blocker. Any advance re-checks the original management admission.
   */
  | "awaiting_input"
  | "creating_capsule"
  | "planning"
  | "reviewable"
  | "failed"
  /** Terminal: discarded by its actor, or expired lazily on read. */
  | "discarded";

/** `"attempt"`: the coordinator owns the attempt and pauses for input. */
export type GitInstallPlanMode = "attempt";

/** What an `awaiting_input` attempt is waiting for. */
export type GitInstallPlanAwaitingInput = "module" | "inputs";

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

/** An exact provider choice, or an explicit decision to configure it later. */
export type GitInstallPlanInterfaceChoice =
  | { readonly kind: "interface"; readonly interfaceId: string }
  | { readonly kind: "later" };

export interface GitInstallPlanInterfaceLinkRequest {
  readonly requirementKey: string;
  readonly choice: GitInstallPlanInterfaceChoice;
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
  /** Exact Interface ids only; permissions come from the compiled configuration. */
  readonly interfaceLinks?: readonly GitInstallPlanInterfaceLinkRequest[];
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

/**
 * Create an install attempt (`mode: "attempt"`). Everything except the Git
 * address is optional: the coordinator proposes the app name, scans modules,
 * matches Provider Connections and pauses in `awaiting_input` for anything it
 * cannot decide alone. Variable values are not accepted here; they are sent
 * only in the confirming `PATCH { continue: true }` request.
 *
 * Idempotency: the request digest is the normalized request itself (it has no
 * values). For a reviewed-preflight `CreateGitInstallPlanRequest`, the digest
 * covers variable names only, never their values, so reusing one
 * Idempotency-Key with different values replays the first record (200)
 * instead of reporting a conflict. Use a new key for new values.
 */
export interface CreateGitInstallAttemptRequest {
  readonly mode: GitInstallPlanMode;
  readonly source: {
    readonly url: string;
    /** Defaults to `HEAD`. */
    readonly ref?: string;
    /** Source-sync subtree; defaults to `.`. */
    readonly path?: string;
    /** Defaults to a name derived from the Git URL. */
    readonly name?: string;
    /** Reference only. Credential values never enter this record. */
    readonly authConnectionId?: string;
  };
  readonly capsule?: {
    /** Defaults to a collision-checked name derived from the Git URL. */
    readonly name?: string;
    /** Defaults to `production`. */
    readonly environment?: string;
  };
  readonly options?: GitInstallPlanOptions;
}

/**
 * Answer an `awaiting_input` attempt. Every field except
 * `expectedGeneration` is optional; omitted fields keep their current answer.
 *
 * - `modulePath` selects one scanned module and restarts analysis for it
 *   (previous connection answers are cleared because they are module-bound).
 * - `capsuleName` renames the app before the Capsule exists.
 * - `providerBindings` replaces the complete explicit connection selection;
 *   requirements left unanswered still auto-select their only candidate.
 * - `interfaceLinks` replaces the complete explicit Interface selection;
 *   unanswered requirements auto-select their sole non-private provider,
 *   defer when none exists, and otherwise need a provider choice or `later`.
 * - `observedInterfaces` echoes each implicit candidate set shown by the client,
 *   only with `continue: true`. It detects changed candidates and never grants
 *   authority or changes the explicit answers stored in `options`.
 * - `continue: true` confirms the sheet: the coordinator validates the
 *   answers, creates the Capsule atomically and starts the Plan Run.
 * - `variables` are accepted only together with `continue: true`. They are
 *   handed straight to the atomic initial creation and never stored in the
 *   coordinator record, logs, diagnostics or responses.
 * - While the attempt waits for re-sent values (`resubmitVariables`), only
 *   `continue: true` with exactly those variable names is accepted; other
 *   answers are refused with `install_inputs_resubmission_only`.
 * - An invalidated attempt is discarded by its creator's PATCH, which then
 *   answers 409 `install_attempt_invalid`.
 */
export interface PatchGitInstallPlanRequest {
  readonly expectedGeneration: number;
  readonly modulePath?: string;
  readonly capsuleName?: string;
  readonly providerBindings?: readonly GitInstallPlanProviderBindingRequest[];
  /** Replaces the complete explicit selection for this module's requirements. */
  readonly interfaceLinks?: readonly GitInstallPlanInterfaceLinkRequest[];
  /** Displayed implicit candidate sets, checked only by the confirming request. */
  readonly observedInterfaces?: readonly {
    readonly requirementKey: string;
    readonly candidateIds: readonly string[];
  }[];
  readonly variables?: Readonly<Record<string, JsonValue>>;
  readonly continue?: boolean;
}

/**
 * Discard an attempt, or an install plan that has not recorded its Capsule.
 * The expected generation fences concurrent advances.
 */
export interface DiscardGitInstallPlanRequest {
  readonly expectedGeneration: number;
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
  /** Implicit Interface answers in `options`, so restart keeps only choices the person made. */
  readonly implicitInterfaceKeys?: readonly string[];
  /** Exact value-free preflight identity, when supplied by an installer. */
  readonly preflight?: GitInstallPlanPreflightAuthority;
  /** `"attempt"` when this record is a coordinator-owned install attempt. */
  readonly mode?: GitInstallPlanMode;
  /** Present only while `phase` is `awaiting_input`. */
  readonly awaitingInput?: GitInstallPlanAwaitingInput;
  /**
   * Attempt mode, before the Capsule exists only: past this instant the
   * attempt is reported `invalidated: "install_attempt_expired"` and can no
   * longer advance. Reads never change it; the creator discards it. Refreshed
   * by answers and coordinator progress, and removed once the confirming
   * request starts creating the Capsule — an attempt with a Capsule never
   * expires. An unleased expired attempt does not block Workspace management.
   */
  readonly expiresAt?: string;
  /** Present only for `operation: "revision"`. */
  readonly revision?: GitRevisionPlanIntent;
  /** Plan-scoped Source id; install plans never discover/reuse by Git address. */
  readonly sourceId?: string;
  readonly sourceSyncRunId?: string;
  /** Canonical same-lane snapshot adopted by the deterministic sync. */
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

/** One scanned OpenTofu root the actor may choose. */
export interface GitInstallPlanModuleCandidate {
  /** Exact module path relative to the SourceSnapshot subtree. */
  readonly path: string;
  /** Canonical provider source addresses the module uses. */
  readonly providers: readonly string[];
}

/** A Provider Connection offered for one requirement. Never carries values. */
export interface GitInstallPlanConnectionCandidate {
  readonly id: string;
  readonly displayName: string;
  readonly status: ProviderConnection["status"];
  readonly scope: ProviderConnection["scope"];
}

/**
 * One provider identity that needs credential material, with the exact
 * tuple a `providerBindings` answer must repeat.
 */
export interface GitInstallPlanConnectionRequirement {
  readonly provider: string;
  readonly moduleLocalName: string;
  readonly childAlias?: string;
  readonly rootAlias?: string;
  /** Eligible connections under the Workspace and install policy. */
  readonly candidates: readonly GitInstallPlanConnectionCandidate[];
  /** Explicit answer, or the only candidate when `autoSelected`. */
  readonly selectedConnectionId?: string;
  /** True when the coordinator chose the only eligible candidate. */
  readonly autoSelected: boolean;
}

/** Value-free provider summary offered for an Interface requirement. */
export interface GitInstallPlanInterfaceCandidate {
  readonly id: string;
  readonly name: string;
  readonly capsuleId: string;
  readonly capsuleName: string;
}

export interface GitInstallPlanInterfaceRequirement {
  readonly requirementKey: string;
  readonly type: string;
  readonly version: string;
  readonly permissions: readonly string[];
  readonly candidates: readonly GitInstallPlanInterfaceCandidate[];
  /** Explicit answer, sole candidate, or implicit `later` when none exists. */
  readonly choice?: GitInstallPlanInterfaceChoice;
  readonly autoSelected: boolean;
  /** Link persistence is not installed, so candidates cannot be selected yet. */
  readonly linkStoreUnavailable?: true;
}

/**
 * Value-free presentation of one install input. `sensitive` inputs are
 * write-only: no default or value is ever echoed. Generic OpenTofu variables
 * are reported sensitive because static analysis cannot prove HCL
 * `sensitive` metadata, so the host treats every such value as write-only.
 */
export interface GitInstallPlanVariablePresentation {
  readonly name: string;
  readonly type: "string" | "number" | "boolean" | "json" | "unknown";
  readonly required: boolean;
  readonly sensitive: boolean;
  readonly advanced?: boolean;
  readonly label?: InstallConfigStoreText;
  readonly description?: InstallConfigStoreText;
  readonly placeholder?: string;
  /** Literal default for a non-sensitive input. */
  readonly defaultValue?: JsonValue;
  /** Takosumi derives the value from the app name unless it is supplied. */
  readonly derivedDefault?: "capsule_name" | "workspace_scoped_capsule_name";
}

export interface GitInstallPlanNameProposal {
  /** The app name the attempt will create. */
  readonly current: string;
  /** Collision-free suggestion; equals `current` when it is free. */
  readonly proposed: string;
  /** True when `current` is already used by another app here. */
  readonly conflict: boolean;
}

/**
 * The single next thing the actor can do. `provide_inputs` is one sheet:
 * connections, settings and the app name are answered together, and
 * `continue` is allowed once `missing` is empty and every required variable
 * is supplied in the confirming request.
 */
export type GitInstallPlanUserAction =
  | {
      /** Coordinator work is pending; call `links.reconcile`. */
      readonly kind: "wait";
      readonly phase: GitInstallPlanPhase;
    }
  | {
      readonly kind: "choose_module";
      readonly modules: readonly GitInstallPlanModuleCandidate[];
      /** A requested path the scan could not prove, when there was one. */
      readonly requested?: string;
    }
  | {
      readonly kind: "provide_inputs";
      readonly modulePath: string;
      /** Planned resources from the compatibility analysis. */
      readonly resources: readonly CapsuleResourceSummary[];
      readonly connections: readonly GitInstallPlanConnectionRequirement[];
      readonly interfaces: readonly GitInstallPlanInterfaceRequirement[];
      readonly variables: readonly GitInstallPlanVariablePresentation[];
      readonly name: GitInstallPlanNameProposal;
      /** Answers that still block `continue`. */
      readonly missing: readonly ("connections" | "interfaces" | "name")[];
      /**
       * Present (possibly empty) once a confirming request started creation
       * and could not be confirmed: send `continue` again with exactly these
       * variable names. Values are never retained between requests.
       */
      readonly resubmitVariables?: readonly string[];
    }
  | {
      readonly kind: "review_run";
      readonly planRunId: string;
      readonly capsuleId: string;
    }
  | {
      readonly kind: "retry";
      /** Bounded diagnostic or invalidation code. */
      readonly code: string;
      /**
       * `false`: call `links.reconcile` again. `true`: this attempt failed or
       * was invalidated; its creator discards it and starts a new attempt.
       */
      readonly restart: boolean;
    }
  | { readonly kind: "none" };

/**
 * Why an attempt can no longer advance, computed on every read and never
 * applied by one: it expired before its Capsule existed, or the Workspace
 * management epoch it was admitted under was replaced while it waited.
 */
export type GitInstallPlanInvalidation =
  | "install_attempt_expired"
  | "workspace_management_changed";

/** Read-only reconstruction of the choices committed for an install attempt. */
export interface GitInstallPlanReviewSummary {
  readonly modulePath: string;
  readonly appName: string;
  readonly environment: string;
  readonly connections: readonly {
    readonly provider: string;
    readonly moduleLocalName: string;
    readonly childAlias?: string;
    readonly rootAlias?: string;
    readonly connectionId: string;
    /** Current display label, falling back to the committed id. */
    readonly displayName: string;
    /** Historical explicit/automatic choice is unknown for retained provider rows. */
    readonly autoSelected: boolean | null;
  }[];
  readonly interfaces: readonly {
    readonly requirementKey: string;
    readonly choice: GitInstallPlanInterfaceChoice;
    /** Current selected Interface label, when its metadata is available. */
    readonly displayName?: string;
    readonly autoSelected: boolean;
  }[];
  readonly settings: readonly {
    readonly name: string;
    readonly type?: GitInstallPlanVariablePresentation["type"];
    readonly required?: boolean;
    readonly sensitive: boolean;
    /** True when the committed InstallConfig contains the setting. */
    readonly set: boolean;
    /** Only trusted, non-sensitive repository presentation permits a value. */
    readonly value?: JsonValue;
  }[];
}

export interface GitInstallPlanResponse {
  readonly installPlan: GitInstallPlan;
  readonly nextAction: "reconcile" | "review_run" | "none";
  readonly userAction: GitInstallPlanUserAction;
  /** Present when the attempt can no longer advance; `userAction` is `retry`. */
  readonly invalidated?: GitInstallPlanInvalidation;
  /** Available after an attempt has committed its initial Capsule authority. */
  readonly reviewSummary?: GitInstallPlanReviewSummary;
  readonly links: {
    readonly self: string;
    readonly reconcile?: string;
    /** Canonical Run review URL. Approval/apply stay exclusively on Run routes. */
    readonly run?: string;
  };
}

/**
 * `GET /api/v1/workspaces/:id/install-plans?open=1`, newest first: the
 * caller's attempts that are not failed or discarded and whose Capsule, if
 * any, was never applied. Invalidated attempts are listed (flagged) so their
 * creator can discard them. The caller's install plans that are not attempts
 * (`mode` absent) are listed while they have not recorded a Capsule, so a plan
 * that stopped there can be discarded. The listing itself never writes.
 */
export interface ListOpenGitInstallPlansResponse {
  readonly installPlans: readonly GitInstallPlanResponse[];
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
