/**
 * Internal deploy-control compatibility seam.
 *
 * The public Takosumi v1 product vocabulary is Run / StateVersion / Output. This file keeps
 * the in-process accounts-plane and operator CLI compatibility DTOs for internal
 * execution profiles, internal plan/apply records, Capsule reads,
 * StateVersion/Output reads, policy decisions, and selected non-sensitive
 * OpenTofu output projections.
 */

import type { JsonValue } from "./types.ts";
import type { PublicCapsule } from "./install-configs.ts";
import type { StateVersion } from "./state-versions.ts";
import type { ProviderResolution } from "./provider-resolution.ts";
import type { PlanResourceScope } from "./plan-scope.ts";
import { INTERNAL_V1_PREFIX } from "./api-surface.ts";
export type {
  CredentialRecipe,
  CredentialRecipeResponse,
  ListCredentialRecipesResponse,
} from "./credential-recipes.ts";

// ---------------------------------------------------------------------------
// INTERNAL deploy-control seam paths. These `/internal/v1/*` routes are the
// internal compatibility seam the accounts plane + CLI consume (PlanRun / ApplyRun /
// internal-execution-profile ledgers and the Capsule read + its
// state-version / output reads). They live under the unified
// `/internal/v1` internal-seam prefix and are never edge-public.
// ---------------------------------------------------------------------------

export const RUNNER_PROFILES_PATH =
  `${INTERNAL_V1_PREFIX}/runner-profiles` as const;
export const PLAN_RUNS_PATH = `${INTERNAL_V1_PREFIX}/plan-runs` as const;
export const PLAN_RUN_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/plan-runs/${encodeURIComponent(id)}`;
export const APPLY_RUNS_PATH = `${INTERNAL_V1_PREFIX}/apply-runs` as const;
export const APPLY_RUN_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/apply-runs/${encodeURIComponent(id)}`;
export const CAPSULE_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/capsules/${encodeURIComponent(id)}`;
export const CAPSULE_STATE_VERSIONS_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/capsules/${encodeURIComponent(id)}/state-versions`;
export const CAPSULE_OUTPUTS_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/capsules/${encodeURIComponent(id)}/outputs`;
export type OpenTofuModuleSourceKind = "git";

export interface GitOpenTofuModuleSource {
  readonly kind: "git";
  /** HTTPS Git URL. Credentials must not be embedded in the URL. */
  readonly url: string;
  readonly ref?: string;
  readonly commit?: string;
  /** Relative child-module path inside the checked-out Git repository. */
  readonly modulePath?: string;
}

/** Stack-flow execution identity. Capsule Sources are Git-only. */
export type OpenTofuModuleSource = GitOpenTofuModuleSource;

/**
 * Internal execution identity for an operator-supplied module. This is not a
 * Capsule Source and is accepted only on the Resource Shape run seam.
 */
export interface OperatorOpenTofuModuleSource {
  readonly kind: "operator_module";
  readonly digest: string;
}

export type OpenTofuExecutionSource =
  OpenTofuModuleSource | OperatorOpenTofuModuleSource;

export type OpenTofuOperation = "create" | "update" | "destroy";

/**
 * Operator-selected runner substrate token.
 *
 * Core deliberately does not publish a closed list: a deployment may use a
 * container service, a VM pool, Kubernetes Jobs, a local process, or an
 * operator plugin unknown to this build. Discovery/capability evidence, not a
 * brand-specific enum in the control-plane contract, decides whether the
 * selected runner can execute a Run.
 */
export type RunnerSubstrate = string;

export interface RunnerStateLockPolicy {
  readonly kind: "native" | "operator" | "none" | string;
  readonly ref?: string;
}

export interface RunnerStateBackend {
  readonly kind: "operator-managed" | "remote" | "local" | string;
  readonly ref?: string;
  readonly lock?: RunnerStateLockPolicy;
}

export interface RunnerResourceLimits {
  readonly maxRunSeconds?: number;
  /** Maximum immutable SourceSnapshot archive bytes accepted by the runner. */
  readonly maxSourceArchiveBytes?: number;
  /** Maximum decompressed SourceSnapshot bytes before extraction. */
  readonly maxSourceDecompressedBytes?: number;
  readonly cpu?: string;
  readonly memoryMb?: number;
}

export interface RunnerNetworkPolicy {
  readonly mode:
    "default-deny" | "egress-allowlist" | "operator-managed" | string;
  /**
   * Exact egress hosts when the runner profile owns an allowlist. Omitted for
   * operator-managed generic profiles where provider API egress is decided by
   * the operator runner environment, not by Takosumi's built-in provider list.
   */
  readonly allowedHosts?: readonly string[];
  readonly allowedHostPatterns?: readonly string[];
}

/**
 * Closed on purpose: every member is enforced somewhere, so an operator can
 * never declare a stricter-sounding value that the runner boundary silently
 * ignores. `providerCredentials: "forbidden"` denies credential minting for
 * runs on that profile; `redactLogs` / `blockSensitiveOutputs` are unconditional
 * at the runner boundary and may only be declared `true`.
 */
export interface RunnerSecretExposurePolicy {
  readonly providerCredentials: "runner-only" | "operator-managed" | "forbidden";
  readonly tenantWorkerOperatorSecrets:
    | "forbidden"
    | "tenant-scoped-references-only"
    | "operator-managed";
  readonly redactLogs?: true;
  readonly blockSensitiveOutputs?: true;
}

/**
 * Open operator-defined executor token.
 *
 * The token is resolved only through the host-injected runner registry. Core
 * attaches no substrate, provider, vendor, or edition semantics to its value.
 */
export type RunnerExecutorId = string;

export type RunnerProfileLifecycleState = "candidate" | "active" | "reserved";

export interface RunnerProfileLifecycle {
  readonly state: RunnerProfileLifecycleState;
  /** Human-readable operator reason; never interpreted as control data. */
  readonly reason?: string;
}

export type RunnerProfileAvailabilityState = "available" | "unavailable";

export interface RunnerProfileAvailability {
  readonly state: RunnerProfileAvailabilityState;
  /** Human-readable operator reason; never interpreted as control data. */
  readonly reason?: string;
}

/** Operator execution profile on the internal `/internal/v1/runner-profiles` seam. */
export interface RunnerProfile {
  readonly id: string;
  readonly name: string;
  readonly substrate: RunnerSubstrate;
  /** Exact key in the host-injected OpenTofu runner executor registry. */
  readonly executorId: RunnerExecutorId;
  /** Explicit operator lifecycle; labels never enable or reserve a profile. */
  readonly lifecycle: RunnerProfileLifecycle;
  /** Explicit execution availability; labels never report runtime readiness. */
  readonly availability: RunnerProfileAvailability;
  readonly description?: string;
  readonly tofuVersion?: string;
  readonly stateBackend: RunnerStateBackend;
  /** Generic execution capabilities implemented by this runner profile. */
  readonly capabilities?: readonly string[];
  readonly allowedProviders: readonly string[];
  readonly deniedProviders?: readonly string[];
  /**
   * Require every declared provider to resolve through an explicit
   * ProviderBinding. The binding's CredentialRecipe manifest is the sole
   * env/file authority; RunnerProfile carries no parallel credential refs.
   */
  readonly requireProviderBindings?: boolean;
  readonly resourceLimits?: RunnerResourceLimits;
  readonly networkPolicy?: RunnerNetworkPolicy;
  readonly secretExposurePolicy?: RunnerSecretExposurePolicy;
  readonly concurrency?: number;
  /** Descriptive/search metadata only. It MUST NOT affect policy or execution. */
  readonly labels?: Readonly<Record<string, string>>;
  readonly createdAt: number;
}

// RunStatus is now ONE vocabulary across the internal PlanRun / ApplyRun records
// and the public §19 Run projection. The canonical union lives in `./runs.ts`;
// the internal seam re-exports it so a single status set flows end to end. The
// retired `blocked` status is gone — a create-time / completion-time policy
// denial is now `failed` (with the policy reason), and an approval gate is the
// persisted `waiting_approval` status (no longer a read-time derivation).
export type { RunStatus } from "./runs.ts";
import type { RunStatus } from "./runs.ts";

/**
 * Read-coerces a persisted run status to the unified {@link RunStatus}. Legacy
 * rows written before the `blocked` → `failed` collapse stored `status:
 * "blocked"`; those coerce to `failed` so a stored legacy status still reads
 * back in the new model. Every other value passes through unchanged.
 */
export function coerceRunStatus(status: string): RunStatus {
  return status === "blocked" ? "failed" : (status as RunStatus);
}

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
  readonly workspaceId: string;
  readonly capsuleId?: string;
  readonly capsuleCurrentStateVersionId?: string | null;
  readonly source: OpenTofuExecutionSource;
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
  readonly providerResolutions?: readonly ProviderResolution[];
  readonly runEnvironmentEvidenceDigest?: string;
  readonly redactionProfileId?: string;
  readonly sourceCommit?: string;
  readonly providerLockDigest?: string;
  /**
   * Capsule CompatibilityReport reviewed for this plan. Set for Capsule
   * runs when the Capsule carries a compatibility report. The queue
   * consumer verifies the report before provider credential mint.
   */
  readonly compatibilityReportId?: string;
  readonly summary?: PlanRunSummary;
  /**
   * Server-side auto-continue requested at creation (the auto-update
   * pipeline). When the plan completes CLEAN (`succeeded` — approval-parked or
   * policy-blocked plans never do), the queue consumer creates the apply run
   * itself instead of waiting for a client. Never set on destroy or
   * drift-check runs.
   */
  readonly autoApplyRequested?: boolean;
  /**
   * Internal refresh-only execution evidence. The Run remains an ordinary
   * plan/apply pair; the runner adds `tofu plan -refresh-only`, so applying the
   * saved plan updates state and outputs without changing provider resources.
   * Mutually exclusive with `driftCheck` and `operation: "destroy"`.
   */
  readonly refreshOnly?: true;
  /**
   * A reviewed config-driven Resource import. The saved plan may only contain
   * one import and no native mutation actions; it still projects as plan/apply.
   */
  readonly resourceImport?: true;
  /**
   * Value-free resource/action projection from the runner's plan JSON. This is
   * persisted for policy, billing, audit, and public review; raw resource
   * values stay only in the encrypted plan JSON artifact.
   */
  readonly planResourceChanges?: readonly PlanResourceChange[];
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
   * otherwise allocates duplicate resources on every apply) may be
   * applied only once. Cleared/unset means the plan has not yet been applied.
   */
  readonly appliedApplyRunId?: string;
  /**
   * Set once the plan completes and action policy evaluated the
   * runner's `planResourceChanges`: `true` when any change is a delete or a
   * replace (`actions` containing `"delete"`), which requires an explicit
   * approval before apply. Absent before the plan completes / for runs
   * with no observed resource changes.
   */
  readonly requiresApproval?: boolean;
  /**
   * Explicit approval recorded against a plan that was parked
   * `waiting_approval` (a destroy plan, a delete/replace action-policy change, or
   * a template-flagged destructive change). Set by the approve API; its presence
   * clears the approval gate so a guarded plan may be applied. Absent means the
   * plan has not been approved.
   */
  readonly approval?: RunApproval;
  /**
   * Digest of the resolved Provider Env bindings this plan was reviewed against
   * (plan→apply TOCTOU pin). Hashes each provider, optional alias, selected
   * Env id, materialization, and required env names. Pinned at plan completion
   * for Capsule-context runs; the apply mint re-resolves the live bindings
   * and asserts this digest still matches, failing closed when an Env binding
   * changed between plan and apply.
   * Absent for runs with no Capsule context.
   */
  readonly resolvedProviderBindingsDigest?: string;
  /**
   * Resolved SourceSnapshot this plan was created against. Set for runs created
   * through the Capsule plan/destroy-plan path. The apply consumer
   * revalidates the ApplyRun's plan still references this snapshot and threads
   * the snapshot's archive into the dispatch.
   */
  readonly sourceSnapshotId?: string;
  /**
   * Capsule context this plan was created against (one Capsule =
   * Capsule + generated root + tfstate + outputs, with `environment` as a
   * column).
   * Used by the queue consumer to attach the `stateScope` / `sourceArchive`
   * dispatch fields and by the unified Run projection. Never carries secret
   * material.
   */
  readonly capsuleContext?: PlanRunCapsuleContext;
  /** First-class Resource Shape subject; mutually exclusive with Capsule context. */
  readonly resourceContext?: PlanRunResourceContext;
  /**
   * Pinned DependencySnapshot id for a Capsule plan whose
   * consumer Capsule declares Dependencies. Set at plan creation by the
   * Capsule plan path; the apply consumer re-reads the snapshot to verify
   * the producer state generations / pinned values before applying (invariant 9)
   * and the successful Run carries it forward. Absent for plans whose
   * consumer has no dependencies (or for the raw `/internal/v1/plan-runs`
   * path). Projected
   * onto the public Run `dependencySnapshotId`.
   */
  readonly dependencySnapshotId?: string;
  /**
   * RunGroup this plan belongs to. Set when the plan was
   * created as a member of a Workspace-update RunGroup (`POST
   * /internal/v1/workspaces/:id/plan-update`); the apply that follows carries it
   * onto the public Run so the
   * group status can be computed from its member runs. Absent for standalone
   * plans. Projected onto the public Run `runGroupId`.
   */
  readonly runGroupId?: string;
  /**
   * Set when this plan is a `drift_check`: an internal read-only plan that
   * detects whether the live state has drifted from the recorded configuration.
   * A drift-check plan NEVER parks `waiting_approval` and can NEVER be applied
   * (`createApplyRun` rejects it with `failed_precondition`); on completion with
   * a non-empty change summary the controller emits a subject-specific drift
   * Activity event with counts plus provider / resource
   * type / action aggregates and public-safe remediation hints only (no
   * resource addresses, values, or scope ids; no subject status mutation; the
   * public model has no `drifted` status). The Run projection maps a drift-check
   * PlanRun to `type: "drift_check"`. Absent for every other plan.
   */
  readonly driftCheck?: true;
}

/**
 * Capsule context recorded on a PlanRun. Locates the run's Capsule +
 * environment within its Workspace so the queue consumer can build the
 * `stateScope` dispatch field (`{ workspaceId, capsuleId, environment,
 * generation }`) the runner consumes to persist encrypted state at canonical
 * state-store keys.
 */
export interface PlanRunCapsuleContext {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
}

export interface PlanRunResourceContext {
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly environment: string;
  /** Explicit Target-selected Provider Connection mapping. */
  readonly providerBinding: {
    readonly provider: string;
    readonly providerSource: string;
    readonly alias?: string;
    readonly connectionId?: string;
  };
}

export type PublicPlanRun = PlanRun;

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
  /** Stable machine-readable classification; clients never parse prose. */
  readonly code?: string;
  readonly message: string;
  readonly detail?: string;
}

export interface ApplyRun {
  readonly id: string;
  readonly planRunId: string;
  readonly workspaceId: string;
  readonly capsuleId?: string;
  readonly stateVersionId?: string;
  readonly operation: OpenTofuOperation;
  readonly runnerProfileId: string;
  readonly status: RunStatus;
  readonly approval?: RunApproval;
  readonly expected: ApplyExpectedGuard;
  readonly stateBackend: RunnerStateBackend;
  readonly stateLock: RunnerStateLockEvidence;
  /** Canonical Output ledger row committed by this successful apply. */
  readonly outputId?: string;
  /**
   * Resource-owned result. Public outputs and encrypted-state pointers are
   * folded into the Resource record; no Capsule Output/StateVersion is created.
   */
  readonly resourceResult?: ResourceApplyRunResult;
  readonly providerResolutions?: readonly ProviderResolution[];
  readonly runEnvironmentEvidenceDigest?: string;
  readonly redactionProfileId?: string;
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

export interface ResourceApplyRunResult {
  readonly resourceId: string;
  readonly stateGeneration: number;
  readonly stateRef: string;
  readonly stateDigest?: string;
  readonly rawOutputRef?: string;
  readonly outputs: Readonly<Record<string, JsonValue>>;
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
  readonly capsuleId?: string;
  readonly currentStateVersionId?: string | null;
  readonly runnerProfileId: string;
  readonly sourceDigest: string;
  readonly variablesDigest: string;
  readonly policyDecisionDigest: string;
  readonly planDigest: string;
  readonly planArtifactDigest: string;
  readonly sourceCommit?: string;
  readonly providerLockDigest?: string;
  /**
   * Digest of the resolved Provider Env bindings the plan was reviewed against
   * (plan→apply TOCTOU pin; see {@link PlanRun.resolvedProviderBindingsDigest}).
   * Carried on the guard so the structural plan/apply guard compare also covers
   * a binding swap. Absent for runs with no Capsule context.
   */
  readonly resolvedProviderBindingsDigest?: string;
}

// Capsule / InstallConfig live in ./install-configs.ts and StateVersion in
// ./state-versions.ts; this internal seam exports the
// DTO set consumed by accounts-plane and operator helper paths.
export type {
  ProviderBindingSet,
  InstallConfig,
  InstallConfigLifecycleAction,
  InstallConfigLifecycleCommandAction,
  InstallConfigLifecycleExecutor,
  InstallConfigLifecyclePhase,
  Capsule,
  CapsuleStatus,
  OutputAllowlistEntry,
  OutputValueType,
  PolicyConfig,
  SourceBuildCommand,
  SourceBuildConfig,
} from "./install-configs.ts";
export {
  CAPSULE_LIFECYCLE_ACTION_FAILED_ERROR_CODE,
  CAPSULE_LIFECYCLE_COMMAND_CAPABILITY,
} from "./install-configs.ts";
export type { StateVersion } from "./state-versions.ts";
export type { OutputResponse } from "./outputs.ts";

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
  readonly workspaceId?: string;
  readonly source: OpenTofuExecutionSource;
  readonly runnerProfileId?: string;
  readonly capsuleId?: string;
  readonly operation?: OpenTofuOperation;
  readonly variables?: Readonly<Record<string, JsonValue>>;
  readonly requiredProviders?: readonly string[];
}

/**
 * Optional Takosumi-generated child-module wrapper threaded onto dispatch.
 * `files` maps a filename to HCL content; the runner writes these into
 * `/work/generated-root` and materializes the child module at
 * `/work/generated-root/module`.
 */
export interface DispatchGeneratedRoot {
  readonly files: Readonly<Record<string, string>>;
}

/**
 * Subject-scoped state location threaded onto the run dispatch payload.
 * The OpenTofu runner DO consumes `request.stateScope` to persist encrypted
 * OpenTofu state under the canonical Capsule or Resource state-store prefix. The
 * controller owns generation arithmetic: plan carries the current generation
 * (restore base), while apply / destroy_apply carries `base + 1` (persist
 * generation). Current dispatch identifies the state owner with `subject`.
 */
export interface DispatchStateScope {
  readonly workspaceId: string;
  /** Canonical state owner for first-class Resource runs. */
  readonly subject?:
    | { readonly kind: "capsule"; readonly id: string }
    | { readonly kind: "resource"; readonly id: string };
  readonly environment: string;
  readonly generation: number;
  /** Host-allocated opaque reference used for restore or persistence. */
  readonly stateRef: string;
}

/**
 * Exact, operator-confirmed pointer used once to seed a first-class Resource
 * from state written by the retired backing-Capsule implementation. Dispatch
 * never discovers this descriptor and the runner must reject it when canonical
 * Resource state already exists.
 */
export interface DispatchStateAdoption {
  readonly kind: "legacy_backing_capsule_state";
  readonly sourceWorkspaceId: string;
  readonly sourceCapsuleId: string;
  readonly sourceEnvironment: string;
  readonly sourceStateVersionId: string;
  readonly stateGeneration: number;
  readonly stateRef: string;
  readonly stateDigest: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
}

/**
 * Source-archive restore descriptor threaded onto the run dispatch payload (M2).
 * The OpenTofu runner fetches `request.sourceArchive` from the configured source
 * artifact store, verifies
 * the digest, and streams the bytes to the container which extracts them into
 * `/work/source`. The opaque reference + digest come verbatim from the resolved
 * SourceSnapshot. Absent for runs without environment context.
 */
export interface DispatchSourceArchive {
  readonly ref: string;
  readonly digest: string;
}

/**
 * Remote-state dependency descriptor threaded onto a plan/apply run dispatch
 * using the `remote_state` Dependency mode. For each `remote_state` edge the
 * controller emits the StateVersion pinned in the PlanRun's DependencySnapshot;
 * the OpenTofu runner DO fetches + decrypts that producer state (the same
 * StateArtifactCrypto path as its own state restore), verifies the recorded
 * plaintext `digest`, and streams the bytes to the container which writes them
 * read-only to `/work/deps/<name>.tfstate` BEFORE init/plan/apply. `name` is the
 * producer Capsule name the consumer references via `terraform_remote_state`
 * (file backend over `/work/deps/<name>.tfstate`). The encrypted state bytes live
 * behind the configured state adapter; the runner never exposes the passphrase or the
 * ciphertext to the container. Absent for runs with no `remote_state` edges.
 */
export interface DispatchDepState {
  /** Producer Capsule name (the `/work/deps/<name>.tfstate` filename). */
  readonly name: string;
  /** Producer Capsule id (audit / cross-reference only). */
  readonly capsuleId?: string;
  /** Producer environment (locates the state-store prefix). */
  readonly environment: string;
  /** Producer pinned StateVersion generation (the restored state generation). */
  readonly generation: number;
  /** Opaque reference for the encrypted producer state at `generation`. */
  readonly stateRef: string;
  /** Recorded plaintext digest of the producer state (DO verifies on decrypt). */
  readonly digest: string;
}

/**
 * One resource change line projected from `tofu show -json tfplan`
 * (`resource_changes`). `actions` mirrors the OpenTofu change actions, e.g.
 * `["create"]`, `["delete"]`, `["delete","create"]` (replace), `["no-op"]`.
 */
export interface PlanResourceChange {
  readonly address: string;
  readonly type: string;
  /** Explicit provider source reported by OpenTofu; never inferred from type. */
  readonly providerSource?: string;
  readonly actions: readonly string[];
  /** Value-free evidence that OpenTofu planned config-driven import. */
  readonly importing?: true;
  /**
   * Sanitized non-secret provider scope metadata extracted from plan JSON when
   * available. Raw resource values are never persisted on the run.
   */
  readonly scope?: PlanResourceScope;
}

export interface PlanRunResponse {
  readonly planRun: PublicPlanRun;
}

export interface CreateApplyRunRequest {
  readonly planRunId: string;
  readonly approval?: RunApproval;
  readonly expected: ApplyExpectedGuard;
}

export interface ApplyRunResponse {
  readonly applyRun: ApplyRun;
  readonly capsule?: PublicCapsule;
}

export interface GetCapsuleResponse {
  readonly capsule: PublicCapsule;
}

export interface ListStateVersionsResponse {
  readonly stateVersions: readonly StateVersion[];
  readonly nextCursor?: string;
}

export interface GetStateVersionResponse {
  readonly stateVersion: StateVersion;
}

// ---------------------------------------------------------------------------
// Public supporting DTO re-exports used by the private `/internal/v1` compatibility seam.
// ---------------------------------------------------------------------------

export * from "./connections.ts";
export * from "./deploy-control-errors.ts";
export {
  CREDENTIAL_RECIPE_PATH,
  CREDENTIAL_RECIPES_PATH,
} from "./credential-recipes.ts";
