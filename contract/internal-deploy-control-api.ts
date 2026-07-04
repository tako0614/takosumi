/**
 * Internal deploy-control compatibility seam.
 *
 * The public Takosumi v1 product vocabulary is Run / StateVersion / Output (the
 * `Deployment` ledger is retired and kept read-only for audit). This file keeps
 * the in-process accounts-plane and operator CLI compatibility DTOs for internal
 * execution profiles, internal plan/apply records, Capsule reads, retired
 * Deployment reads, policy decisions, and selected non-sensitive OpenTofu output
 * projections.
 */

import type { JsonValue } from "./types.ts";
import type { PublicCapsule } from "./install-configs.ts";
import type { Deployment } from "./deployments.ts";
import type { ProviderResolution } from "./provider-resolution.ts";
import type { DeployRequest } from "./deploy.ts";
import type { CapsuleProviderEnvBindings } from "./connections.ts";
import type { ProviderCredentialMintEvidence } from "./security.ts";
import { INTERNAL_V1_PREFIX } from "./api-surface.ts";
export type {
  ListProvidersResponse,
  ProviderListingResponse,
  ProviderListing,
} from "./providers.ts";

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
export const INTERNAL_DEPLOY_PATH = `${INTERNAL_V1_PREFIX}/deploy` as const;

/**
 * Internal in-process upload-source deploy request. Internal callers provide
 * operator-policy runner profile and Provider Binding resolution after
 * authorization. Public callers must not send it.
 */
export interface InternalDeployRequest extends Omit<
  DeployRequest,
  "providerConnections" | "runnerId"
> {
  readonly runnerProfileId?: string;
  readonly providerEnvBindings?: CapsuleProviderEnvBindings;
}

export type OpenTofuModuleSourceKind = "git" | "local" | "prepared";

export interface GitOpenTofuModuleSource {
  readonly kind: "git";
  /** HTTPS Git URL. Credentials must not be embedded in the URL. */
  readonly url: string;
  readonly ref?: string;
  readonly commit?: string;
  /** Compatibility alias for the Capsule path inside the repository. */
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

export type RunnerSubstrate = "cloudflare-containers" | "local" | "external";

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
  readonly mode:
    | "default-deny"
    | "egress-allowlist"
    | "operator-managed"
    | string;
  /**
   * Exact egress hosts when the runner profile owns an allowlist. Omitted for
   * operator-managed generic profiles where provider API egress is decided by
   * the operator runner environment, not by Takosumi's built-in provider list.
   */
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

/** Legacy DTO name for an internal execution profile on the `/internal/v1/runner-profiles` seam. */
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
  readonly secretExposurePolicy?: RunnerSecretExposurePolicy;
  readonly concurrency?: number;
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
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly capsuleId?: string;
  /** @deprecated Use capsuleId. */
  readonly installationId?: string;
  /** @deprecated Retired Deployment ledger pointer. */
  readonly installationCurrentDeploymentId?: string;
  readonly capsuleCurrentStateVersionId?: string | null;
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
   * otherwise allocates a fresh Capsule/Deployment on every apply) may be
   * applied only once. Cleared/unset means the plan has not yet been applied.
   */
  readonly appliedApplyRunId?: string;
  /**
   * Resolved service-side module binding for a template-backed PlanRun. Records
   * the built-in module id/version this plan targets and the plan-JSON policy
   * outcome (allowlist verdict + destructive-confirmation requirement). Absent
   * for template-less Capsule plans. Never carries input values (those live in
   * the plan-run-inputs sidecar) — only the binding + policy verdict.
   */
  readonly templateBinding?: PlanRunTemplateBinding;
  /**
   * Set once the plan completes and action policy evaluated the
   * runner's `planResourceChanges`: `true` when any change is a delete or a
   * replace (`actions` containing `"delete"`), which requires an explicit
   * approval before apply. Independent of `templateBinding.requiresConfirmation`
   * (the template destructive-confirmation gate, which additionally requires
   * `confirmDestructive` at apply). Absent before the plan completes / for runs
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
   * for installation-context runs; the apply mint re-resolves the live bindings
   * and asserts this digest still matches, failing closed when an Env binding
   * changed between plan and apply.
   * Absent for runs with no installation context.
   */
  readonly resolvedProviderEnvBindingsDigest?: string;
  /**
   * Internal generated-root credential delivery selected at plan creation.
   *
   * Normal OpenTofu Stack flow uses `generated_root_variable`, keeping provider
   * credentials as root-only sensitive variables. Resource Shape managed
   * compatibility targets may use `provider_env` when the generated root renders
   * only a provider `base_url` and the selected ProviderConnection should expose
   * the provider's normal env names to the runner. This is non-secret metadata;
   * secret values still come only from the vault.
   */
  readonly providerCredentialDelivery?: ProviderCredentialMintEvidence["delivery"];
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
  /** @deprecated Use capsuleContext. */
  readonly installationContext?: PlanRunCapsuleContext;
  /**
   * Pinned DependencySnapshot id for an installation-driven plan whose
   * consumer Capsule declares Dependencies. Set at plan creation by the
   * installation plan path; the apply consumer re-reads the snapshot to verify
   * the producer state generations / pinned values before applying (invariant 9)
   * and the successful Deployment carries it forward. Absent for plans whose
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
   * a non-empty change summary the controller emits an
   * `installation.drift_detected` Activity event with counts plus provider /
   * resource type / action aggregates and public-safe remediation hints only (no
   * resource addresses, values, or scope ids; no installation status change; the
   * public model has no `drifted` status). The Run projection maps a drift-check
   * PlanRun to `type: "drift_check"`. Absent for every other plan.
   */
  readonly driftCheck?: true;
}

/**
 * Capsule context recorded on a PlanRun. Locates the run's Capsule +
 * environment within its Workspace so the queue consumer can build the
 * `stateScope` dispatch field (`{ workspaceId, capsuleId, environment,
 * generation }`) the DO consumes to persist encrypted state at the R2_STATE
 * keys.
 */
export interface PlanRunCapsuleContext {
  readonly workspaceId: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly capsuleId: string;
  /** @deprecated Use capsuleId. */
  readonly installationId?: string;
  readonly environment: string;
}

export interface PlanRunTemplateBinding {
  readonly templateId: string;
  readonly templateVersion: string;
  /**
   * Set once the runner returns `planResourceChanges` and the template plan-JSON
   * policy has been evaluated: `true` when a delete/replace change requires an
   * explicit apply-time confirmation (`requireExplicitConfirmation`). Absent
   * before the plan completes.
   */
  readonly requiresConfirmation?: boolean;
}

/**
 * Internal compatibility projection returned by the private `/internal/v1`
 * plan-run seam. Ledger-only authoring conveniences such as `templateBinding`
 * stay
 * inside the service; the public contract exposes unified `Run` records
 * instead.
 */
export type PublicPlanRun = Omit<PlanRun, "templateBinding">;

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
  readonly workspaceId: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly capsuleId?: string;
  /** @deprecated Use capsuleId. */
  readonly installationId?: string;
  /** @deprecated Retired Deployment ledger pointer. */
  readonly deploymentId?: string;
  /** @deprecated Retired Deployment ledger pointer. */
  readonly installationCurrentDeploymentId?: string;
  readonly stateVersionId?: string;
  readonly operation: OpenTofuOperation;
  readonly runnerProfileId: string;
  readonly status: RunStatus;
  readonly approval?: RunApproval;
  readonly expected: ApplyExpectedGuard;
  readonly stateBackend: RunnerStateBackend;
  readonly stateLock: RunnerStateLockEvidence;
  readonly outputs?: readonly DeploymentOutput[];
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
  /** @deprecated Use capsuleId. */
  readonly installationId?: string;
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
   * (plan→apply TOCTOU pin; see {@link PlanRun.resolvedProviderEnvBindingsDigest}).
   * Carried on the guard so the structural plan/apply guard compare also covers
   * an Env binding swap. Absent for runs with no installation context.
   */
  readonly resolvedProviderEnvBindingsDigest?: string;
  readonly providerCredentialDelivery?: ProviderCredentialMintEvidence["delivery"];
}

// Capsule / InstallConfig live in ./install-configs.ts and
// Deployment / StateVersion in ./deployments.ts; this internal seam exports the
// DTO set consumed by accounts-plane and operator helper paths.
export type {
  CapsuleProviderEnvBindingSet,
  InstallBuildConfig,
  InstallConfig,
  InstallPrebuiltArtifactConfig,
  Capsule,
  CapsuleStatus,
  InstallType,
  OutputAllowlistEntry,
  OutputValueType,
  PolicyConfig,
  TrustLevel,
} from "./install-configs.ts";
export type {
  Deployment,
  DeploymentStatus,
  StateVersion,
} from "./deployments.ts";

// Transient deprecated pre-rename names, still importable from this seam.
/** @deprecated use `Capsule` / `CapsuleStatus` / `CapsuleProviderEnvBindingSet`. */
export type {
  Capsule as Installation,
  CapsuleStatus as InstallationStatus,
  CapsuleProviderEnvBindingSet as InstallationProviderEnvBindingSet,
} from "./install-configs.ts";
/** @deprecated use `StateVersion`. */
export type { StateVersion as StateSnapshot } from "./deployments.ts";

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
  readonly workspaceId?: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly source: OpenTofuModuleSource;
  readonly runnerProfileId?: string;
  readonly capsuleId?: string;
  /** @deprecated Use capsuleId. */
  readonly installationId?: string;
  readonly operation?: OpenTofuOperation;
  readonly variables?: Readonly<Record<string, JsonValue>>;
  readonly requiredProviders?: readonly string[];
  /**
   * Built-in first-party module binding path. When `templateId` is present the
   * plan resolves to the same generated-root dispatch shape as any OpenTofu
   * Capsule: bundled module files are carried as `generatedRoot.moduleFiles`
   * and wired with the supplied `inputs`. Takosumi no longer treats the user
   * source as an app build input; app release/build values must be ordinary
   * OpenTofu variables. `requiredProviders` is derived from policy and must not
   * be supplied explicitly alongside a template binding.
   */
  readonly templateId?: string;
  readonly templateVersion?: string;
  /**
   * Typed input values for the template, validated against `template.inputs`.
   * Literal scalars only (string / number / boolean); rendered into HCL by the
   * Takosumi rootgen.
   */
  readonly inputs?: Readonly<Record<string, JsonValue>>;
  /**
   * Apply-time confirmation that the operator accepts the destructive plan
   * (delete / replace) a template policy flagged with
   * `destructiveChanges.requireExplicitConfirmation`. Carried on the ApplyRun
   * request, not here; see {@link CreateApplyRunRequest.confirmDestructive}.
   */
}

// ---------------------------------------------------------------------------
// Built-in first-party module bindings. The public surface stays
// Capsule / Deployment / PlanRun / ApplyRun / RunnerProfile /
// DeploymentOutput; templateBinding is a service-side InstallConfig convenience
// that produces a Takosumi-generated OpenTofu root module. These DTOs describe
// the binding reference + rootgen output threaded onto the runner dispatch only;
// they are never projected into the public ledger.
// ---------------------------------------------------------------------------

export type TemplateInputType = "string" | "number" | "boolean";

export interface TemplateInputSpec {
  readonly type: TemplateInputType;
  readonly title: string;
  readonly required: boolean;
  readonly description?: string;
  /** Optional default applied when the input is omitted and not required. */
  readonly default?: string | number | boolean;
}

export interface TemplatePublicOutputSpec {
  /** OpenTofu output type hint for display (e.g. "string"). */
  readonly type: string;
  /** Name of the template-module output this public output reads from. */
  readonly from: string;
}

export interface TemplateBuildSpec {
  readonly runtime: "bun";
  /** Retired metadata for the old app build phase; not dispatched by new runs. */
  readonly commands: readonly string[];
  /** Historical file/dir relative to the old source root. */
  readonly artifactPath: string;
}

export interface TemplateDestructivePolicy {
  readonly requireExplicitConfirmation: boolean;
}

export interface TemplatePolicySpec {
  readonly allowedProviders: readonly string[];
  readonly allowedResourceTypes: readonly string[];
  readonly destructiveChanges: TemplateDestructivePolicy;
}

export interface TemplateSourceSpec {
  /**
   * Path INSIDE the runner image to a bundled first-party Capsule module, e.g.
   * `/app/templates/cloudflare-hello-worker/module`. The runner copies it to
   * `/work/generated-root/template-module`.
   */
  readonly localModulePath: string;
}

export interface TemplateDefinition {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly source: TemplateSourceSpec;
  readonly build?: TemplateBuildSpec;
  readonly inputs: Readonly<Record<string, TemplateInputSpec>>;
  readonly outputs: {
    readonly public: Readonly<Record<string, TemplatePublicOutputSpec>>;
  };
  readonly policy: TemplatePolicySpec;
}

/**
 * Takosumi-generated OpenTofu root module threaded onto the dispatch payload.
 * `files` maps a filename to HCL content; the runner writes these into
 * `/work/generated-root` and materializes the child module at
 * `/work/generated-root/template-module`.
 */
export interface DispatchGeneratedRoot {
  readonly files: Readonly<Record<string, string>>;
  /**
   * Optional child module files for bundled first-party modules or normalized
   * Capsules.
   * When present, the runner materializes these files as
   * `/work/generated-root/template-module` instead of copying a restored
   * SourceSnapshot module. This keeps every generated-root run on the same
   * Capsule dispatch shape.
   */
  readonly moduleFiles?: readonly {
    readonly path: string;
    readonly text: string;
  }[];
}

/**
 * Legacy optional build metadata kept for stored rows. New generated-root
 * dispatch does not thread this payload to the runner.
 *
 * @deprecated New app installs should run the Git-hosted OpenTofu/Terraform
 * module directly. App builds and container/image publishing belong in the app
 * repo or CI/release pipeline, not in Takosumi dispatch semantics.
 */
export interface DispatchBuildSpec {
  readonly runtime: "bun";
  readonly commands: readonly string[];
  readonly artifactPath: string;
}

/**
 * Legacy prepared path metadata kept for stored rows. New generated-root
 * dispatch does not thread this path to the runner.
 *
 * @deprecated New generic Capsule installs should not use a Takosumi-owned
 * app release artifact path. The OpenTofu/Terraform module should receive any
 * app-specific values as ordinary variables.
 */
export interface DispatchPrebuiltArtifactSpec {
  readonly path: string;
}

/**
 * Capsule-scoped state location threaded onto the run dispatch payload.
 * The OpenTofu runner DO consumes `request.stateScope` to persist OpenTofu state
 * encrypted to the canonical R2_STATE keys
 * (`spaces/{workspaceId}/installations/{capsuleId}/envs/{environment}/states/
 * {NNNNNNNN}.tfstate.enc` + `current.json`). The controller owns the generation
 * arithmetic: a plan dispatch carries the CURRENT generation (restore base); an
 * apply / destroy_apply carries `base + 1` (persist generation). Absent for runs
 * without installation context, in which case the DO falls back to its legacy
 * R2_ARTIFACTS state path.
 */
export interface DispatchStateScope {
  readonly workspaceId?: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly capsuleId?: string;
  /** @deprecated Use capsuleId. */
  readonly installationId?: string;
  readonly environment: string;
  readonly generation: number;
}

/**
 * Source-archive restore descriptor threaded onto the run dispatch payload (M2).
 * The OpenTofu runner DO fetches `request.sourceArchive` from R2_SOURCE, verifies
 * the digest, and streams the bytes to the container which extracts them into
 * `/work/source`. The object key + digest come verbatim from the resolved
 * SourceSnapshot. Absent for runs without environment context.
 */
export interface DispatchSourceArchive {
  readonly objectKey: string;
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
 * in R2_STATE at `objectKey`; the DO never exposes the passphrase or the
 * ciphertext to the container. Absent for runs with no `remote_state` edges.
 */
export interface DispatchDepState {
  /** Producer Capsule name (the `/work/deps/<name>.tfstate` filename). */
  readonly name: string;
  /** Producer Capsule id (audit / cross-reference only). */
  readonly capsuleId?: string;
  /** @deprecated Use capsuleId. */
  readonly installationId?: string;
  /** Producer environment (locates the R2_STATE prefix). */
  readonly environment: string;
  /** Producer pinned StateVersion generation (the restored state generation). */
  readonly generation: number;
  /** R2_STATE object key of the encrypted producer state at `generation`. */
  readonly objectKey: string;
  /** Recorded plaintext digest of the producer state (DO verifies on decrypt). */
  readonly digest: string;
}

// StateVersion lives in ./deployments.ts and is re-exported below.

/**
 * One resource change line projected from `tofu show -json tfplan`
 * (`resource_changes`). `actions` mirrors the OpenTofu change actions, e.g.
 * `["create"]`, `["delete"]`, `["delete","create"]` (replace), `["no-op"]`.
 */
export interface PlanResourceChange {
  readonly address: string;
  readonly type: string;
  readonly actions: readonly string[];
  /**
   * Sanitized non-secret provider scope metadata extracted from plan JSON when
   * available. Raw resource values are never persisted on the run.
   */
  readonly scope?: {
    readonly cloudflareAccountId?: string;
    readonly cloudflareZoneId?: string;
    readonly awsAccountId?: string;
    readonly awsRegion?: string;
  };
}

export interface PlanRunResponse {
  readonly planRun: PublicPlanRun;
}

export interface CreateApplyRunRequest {
  readonly planRunId: string;
  readonly approval?: RunApproval;
  readonly expected: ApplyExpectedGuard;
  /**
   * Required to be `true` to apply a PlanRun whose template policy flagged the
   * plan as destructive (delete / replace under
   * `destructiveChanges.requireExplicitConfirmation`). Absent / false on a
   * destructive plan rejects the apply with `failed_precondition`. Ignored for
   * non-destructive and non-template plans.
   */
  readonly confirmDestructive?: boolean;
}

export interface ApplyRunResponse {
  readonly applyRun: ApplyRun;
  readonly capsule?: PublicCapsule;
  /** @deprecated Use capsule. */
  readonly installation?: PublicCapsule;
  /** @deprecated retired Deployment ledger read; kept for audit compatibility. */
  readonly deployment?: Deployment;
}

export interface GetCapsuleResponse {
  readonly capsule: PublicCapsule;
  /** @deprecated Use capsule. */
  readonly installation?: PublicCapsule;
}

/** @deprecated use {@link GetCapsuleResponse}. */
export type GetInstallationResponse = GetCapsuleResponse;
/** @deprecated use {@link PlanRunCapsuleContext}. */
export type PlanRunInstallationContext = PlanRunCapsuleContext;

export interface ListDeploymentsResponse {
  readonly deployments: readonly Deployment[];
  /**
   * Opaque keyset cursor for the next page when the listing was capped (spec §30
   * pagination). Absent on the last page. Additive: readers that ignore it are
   * unaffected.
   */
  readonly nextCursor?: string;
}

export interface ListDeploymentOutputsResponse {
  readonly outputs: readonly DeploymentOutput[];
}

// ---------------------------------------------------------------------------
// Public supporting DTO re-exports used by the private `/internal/v1` compatibility seam.
// ---------------------------------------------------------------------------

export * from "./connections.ts";
export * from "./deploy-control-errors.ts";
export { PROVIDER_PATH, PROVIDERS_PATH } from "./providers.ts";
