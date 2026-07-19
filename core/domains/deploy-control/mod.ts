/**
 * OpenTofu-native deployment-control-plane domain.
 *
 * Takosumi owns the API-facing ledger and policy gate. RunnerProfiles provide
 * provider allowlists, state-backend ownership, and runner substrate choice.
 * A profile's open executorId resolves through an explicitly injected runner
 * registry. The reference distribution binds its container adapter there; Core
 * has no vendor or label-based execution branch.
 *
 * This module hosts the controller and run-execution ceremony. Four cohesive
 * concerns live in sibling files and are composed in here:
 *   - `runner_profiles.ts` — default RunnerProfile seed data
 *   - `policy.ts`          — RunnerProfile policy engine
 *   - `validation.ts`      — request / source validation and identity guards
 *   - `projection.ts`      — output / diagnostic projection and redaction
 */

import type {
  JsonValue,
  PlanScopeSelector,
  ProviderConfigurationsEnvelope,
} from "takosumi-contract";
import type {
  ApplyExpectedGuard,
  ApplyRun,
  ApplyRunResponse,
  ProviderConnection,
  ConnectionResponse,
  CreateApplyRunRequest,
  CreateConnectionRequest,
  CreatePlanRunRequest,
  DeployControlAuditEvent,
  DispatchDepState,
  DispatchGeneratedRoot,
  DispatchSourceArchive,
  DispatchStateAdoption,
  DispatchStateScope,
  GetCapsuleResponse,
  GetStateVersionResponse,
  OutputResponse,
  InstallConfig,
  OpenTofuModuleSource,
  PlanRunCapsuleContext,
  ListConnectionsResponse,
  ListStateVersionsResponse,
  ListRunnerProfilesResponse,
  OpenTofuOutputEnvelope,
  OpenTofuPlanArtifact,
  PlanResourceChange,
  PlanRun,
  PlanRunResourceContext,
  PlanRunResponse,
  PublicPlanRun,
  PlanRunSummary,
  PolicyDecision,
  PolicyConfig,
  RunApproval,
  RunnerProfile,
  RunnerStateLockEvidence,
  RunDiagnostic,
  RunStatus,
  TestConnectionResponse,
} from "@takosumi/internal/deploy-control-api";
import type { Capsule, PublicCapsule } from "takosumi-contract/capsules";
import type {
  CredentialRecipe,
  CredentialRecipeResponse,
  ListCredentialRecipesResponse,
} from "takosumi-contract/credential-recipes";
import type { ConnectionVault } from "../../adapters/vault/mod.ts";
import type {
  InstallConfigLifecycleAction,
  OutputAllowlistEntry,
} from "takosumi-contract/install-configs";
import type {
  ManagedPublicHostnameClaimRequest,
  ManagedPublicHostnameClaimResult,
} from "takosumi-contract/install-configs";
import type {
  BillingSettings,
  CapsuleUsageSummary,
  UsageEvent,
} from "takosumi-contract/billing";
import type { SourcesService } from "../sources/mod.ts";
import { evaluateSourceUrl } from "../sources/url-policy.ts";
import type {
  CapsuleCompatibilityReport,
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
} from "takosumi-contract/capsules";
import type {
  CreateSourceRequest,
  CreateSourceResponse,
  CreateSourceSyncResponse,
  ListSourcesResponse,
  ListSourceSnapshotsResponse,
  PatchSourceRequest,
  RepositoryInstallMetadataSnapshot,
  Source,
  SourceResponse,
  SourceSnapshot,
  SourceSyncIntent,
  SourceSyncPhaseTiming,
  SourceSyncRun,
} from "takosumi-contract/sources";
import type { PageParams } from "takosumi-contract/pagination";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import { log } from "../../shared/log.ts";
import {
  InMemoryOpenTofuControlStore,
  CapsuleStateVersionGuardConflict,
  CapsuleStateGenerationGuardConflict,
  type OpenTofuControlStore,
  type PlanRunInputs,
} from "./store.ts";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";
import {
  type ActivityRecorder,
  NOOP_ACTIVITY_RECORDER,
  type RecordActivityInput,
} from "../activity/mod.ts";
import {
  createDefaultRunnerProfiles,
  DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
  DEFAULT_OPENTOFU_RUNNER_PROFILE_ID,
} from "./runner_profiles.ts";
import { evaluatePolicy } from "./policy.ts";
import {
  normalizeProviders,
  normalizeVariables,
  validateOperation,
  validatePlannedCapsuleCurrent,
  validateSource,
} from "./validation.ts";
import {
  errorDiagnostic,
  errorMessage,
  normalizePlanArtifact,
  normalizePlanSummary,
  redactRunDiagnostics,
  stateLockEvidence,
} from "./projection.ts";
import {
  type ActionPolicyResult,
  evaluateActionPolicy,
  evaluateQuotaPolicy,
  evaluateResourceAllowlist,
  evaluateScopeBoundary,
  type QuotaResult,
  type ProviderAllowlistResult,
  type ResourceAllowlistResult,
  type ScopeBoundaryResult,
} from "takosumi-policy";
import { type RootProviderBinding } from "takosumi-rootgen";
import { downstreamClosure } from "takosumi-graph";
import type {
  Run,
  RunCostInfo,
  RunEventsResponse,
  RunLogsResponse,
  RunServiceDataRestoreResult,
} from "takosumi-contract/runs";
import type {
  CreateRestoreRequest,
  ServiceDataBackupPointer,
} from "takosumi-contract/backups";
import type { Output } from "takosumi-contract/outputs";
import type { StateVersion } from "takosumi-contract/state-versions";
import type { ArtifactReferenceAllocator } from "../../adapters/storage/artifact-references.ts";
import type { SensitiveOutputResolver } from "../output-shares/mod.ts";
import type {
  Dependency,
  DependencySnapshot,
  SealedDependencyValues,
} from "takosumi-contract/dependencies";
import { projectApplyRun, projectPlanRun } from "./projection_run.ts";
import {
  DEFAULT_CAPSULE_LEASE_TTL_MS,
  type CapsuleCoordination,
  type LeaseHandle,
  withCapsuleLease,
  withPlanLease,
} from "./capsule_lease.ts";
import {
  ConnectionsService,
  resolvedProviderBindingsDigest,
  type ResolvedCapsuleProviderBinding,
} from "../connections/mod.ts";
import { SourceManagement } from "./source_management.ts";
import { SourceLifecycleService } from "./source_lifecycle.ts";
import { ConnectionManagement } from "./connection_management.ts";
import { CapsuleQuery } from "./capsule_query.ts";
import { RunQueryService } from "./run_query.ts";
import {
  BillingService,
  DISABLED_BILLING_SETTINGS,
} from "./billing_service.ts";
import type {
  BillingEnforcement,
  QuotaPolicy,
  ShowbackRater,
} from "takosumi-contract/billing";
import {
  containsSecretLikeString,
  isSecretKey,
  redactString,
} from "takosumi-contract/redaction";
import type { ObservabilitySink } from "../observability/mod.ts";
import { UsageReportingService } from "./usage_service.ts";
// The usage input-type vocabulary is owned by the usage service; re-exported here
// so the historical `./domains/deploy-control/mod.ts` import path stays stable.
export type { RecordMeteredUsageInput } from "./usage_service.ts";
import type { RecordMeteredUsageInput } from "./usage_service.ts";
import {
  canonicalProviderAddress,
  compactLayeredPolicy,
  evaluateCompatibilityReportAgainstPolicy,
  evaluateConfiguredProviderAllowlist,
  evaluateProviderInstallationPolicy,
  evaluateProviderLockfilePolicy,
  mergePolicyConfigs,
  type ProviderInstallationPolicyResult,
  type ProviderLockfilePolicyResult,
  requiredProvidersFromCompatibilityReport,
  withDefaultProviderSupplyChainPolicy,
} from "./provider_policy.ts";
import { DriftService } from "./drift_service.ts";
import { RunCredentialBroker } from "./run_credential_broker.ts";
import {
  RunEnvironmentResolutionError,
  RunEnvResolver,
  type CapsuleRunIdentityIssuer,
  type ResolvedRunEnvironment,
} from "./run_env_resolver.ts";
import {
  DependencyResolutionService,
  type ResolvedDependencies,
} from "./dependency_resolution.ts";
import { RunVerificationService } from "./run_verification.ts";
import {
  type CapsulePlanContext,
  PlanResolutionService,
  providerBindingsFromResolved,
} from "./plan_resolution.ts";
import {
  RunEngine,
  type RestoreRunLifecycleEvent,
} from "./run-engine/run_engine.ts";

// Re-export the shared error primitive and the four decomposed concerns so the
// domain's public entry point stays `./mod.ts` for importers and tests.
export {
  OpenTofuControllerError,
  OpenTofuRunnerInfrastructureError,
  isRunnerInfrastructureRequeueError,
  RUNNER_INFRASTRUCTURE_REQUEUED_REASON,
  type OpenTofuControllerErrorCode,
} from "./errors.ts";
export {
  createDefaultRunnerProfiles,
  DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
  DEFAULT_OPENTOFU_RUNNER_PROFILE_ID,
  parseEnabledRunnerProfileIds,
  resolveEnabledRunnerProfiles,
} from "./runner_profiles.ts";
export { providerMatches } from "./policy.ts";
export type { RestoreRunLifecycleEvent } from "./run-engine/run_engine.ts";

export function publicCapsule(capsule: Capsule): PublicCapsule {
  const {
    currentOutputId: _currentOutputId,
    autoUpdateAttemptSourceSnapshotId: _autoUpdateAttemptSourceSnapshotId,
    ...publicRecord
  } = capsule;
  return publicRecord;
}

export function publicPlanRun(planRun: PlanRun): PublicPlanRun {
  return planRun;
}

/**
 * Minted provider credential env/file material threaded onto the runner dispatch
 * payload only. The controller fills this from the ProviderConnection Vault in the queue
 * consumer just before dispatch; it is NEVER persisted to the store and NEVER
 * logged. For provider-using runs, an absent Vault is fail-closed before runner
 * dispatch so the runner never falls back to ambient provider credentials.
 */
export type RunCredentials = {
  readonly env: Readonly<Record<string, string>>;
  readonly files?: readonly {
    readonly path: string;
    readonly mode: number;
    readonly content: string;
    readonly envName?: string;
  }[];
  readonly manifest: import("takosumi-contract/credential-recipes").RunCredentialRecipeManifest;
};

export function withRunEnvironmentEvidence<R extends PlanRun | ApplyRun>(
  run: R,
  resolved: ResolvedRunEnvironment,
): R {
  return {
    ...run,
    providerResolutions: resolved.providerResolutions,
    runEnvironmentEvidenceDigest: resolved.runEnvironmentEvidenceDigest,
    redactionProfileId: resolved.redactionProfileId,
  };
}

export function runEnvironmentFailedRun<R extends PlanRun | ApplyRun>(
  run: R,
  error: unknown,
): R {
  return error instanceof RunEnvironmentResolutionError
    ? withRunEnvironmentEvidence(run, error.runEnvironment)
    : run;
}

/**
 * Optional generated-root dispatch fields threaded onto a run job. Plain Git
 * modules execute as root by default; a child wrapper is used only for
 * explicit HCL wiring such as provider aliases/configuration.
 * OpenTofu Outputs remain ordinary return values. Optional lifecycle actions
 * come only from the service-side InstallConfig and are pinned in this dispatch
 * alongside the root reviewed by the Plan.
 */
export interface RunModuleDispatch {
  readonly generatedRoot?: DispatchGeneratedRoot;
  /**
   * Operator-injected Resource Shape implementation module. This is never
   * accepted by the Capsule plan API and has no built-in/default registry.
   */
  readonly operatorModule?: {
    readonly files: readonly OpenTofuCapsuleSourceFile[];
  };
  /**
   * Workspace-local, non-secret Output capture selected for dependency and
   * Interface resolution. This is deliberately broader than the public
   * projection for generic Capsules.
   */
  readonly workspaceOutputAllowlist?: InstallConfig["outputAllowlist"];
  /** Explicit InstallConfig projection used by UI/public Output reads. */
  readonly outputAllowlist?: InstallConfig["outputAllowlist"];
  readonly sourceBuild?: InstallConfig["sourceBuild"];
  readonly lifecycleActions?: InstallConfig["lifecycleActions"];
  /**
   * One-shot Resource state bootstrap stored beside the generated root. It is
   * internal runner preparation, never public PlanRun data.
   */
  readonly stateAdoption?: DispatchStateAdoption;
}

/**
 * Subject-scoped execution fields threaded onto a Run job. Capsule and Resource
 * subjects both carry an encrypted `stateScope`; a Git-backed Capsule may also
 * carry its resolved `sourceArchive`. These map 1:1 onto the runner request.
 * Raw internal runs without a durable subject omit them.
 */
export interface RunExecutionDispatch {
  readonly stateScope?: DispatchStateScope;
  /**
   * Host-allocated opaque reference where the runner persists the sealed raw
   * output envelope for this apply. Core never derives a storage layout from
   * the run or subject identifiers.
   */
  readonly rawOutputRef?: string;
  readonly stateAdoption?: DispatchStateAdoption;
  readonly sourceArchive?: DispatchSourceArchive;
  /**
   * Remote-state dependency descriptors (spec §15 `remote_state`). One per
   * `remote_state` Dependency edge of the consumer Capsule; the runner DO
   * fetches + decrypts each producer state and the container writes it read-only
   * to `/work/deps/<name>.tfstate` before init/plan/apply. Absent for runs with
   * no `remote_state` edges.
   */
  readonly depStates?: readonly DispatchDepState[];
}

export interface OpenTofuPlanJob
  extends RunModuleDispatch, RunExecutionDispatch {
  readonly planRun: PlanRun;
  readonly runnerProfile: RunnerProfile;
  readonly variables: Readonly<Record<string, JsonValue>>;
  readonly providerInstallationPolicy?: {
    readonly requireMirror: boolean;
  };
  /** Policy-derived, selector-only non-secret scope projection request. */
  readonly scopeSelectors?: readonly PlanScopeSelector[];
  readonly credentials?: RunCredentials;
}

export interface OpenTofuApplyJob
  extends RunModuleDispatch, RunExecutionDispatch {
  readonly applyRun: ApplyRun;
  readonly planRun: PlanRun;
  readonly planArtifact: OpenTofuPlanArtifact;
  readonly runnerProfile: RunnerProfile;
  readonly providerInstallationPolicy?: {
    readonly requireMirror: boolean;
  };
  readonly credentials?: RunCredentials;
}

export interface OpenTofuDestroyJob
  extends RunModuleDispatch, RunExecutionDispatch {
  readonly applyRun: ApplyRun;
  readonly planRun: PlanRun;
  readonly planArtifact: OpenTofuPlanArtifact;
  /** Present only for Capsule subjects; Resource runs have no backing Capsule. */
  readonly capsule?: Capsule;
  readonly runnerProfile: RunnerProfile;
  readonly providerInstallationPolicy?: {
    readonly requireMirror: boolean;
  };
  readonly credentials?: RunCredentials;
}

export interface OpenTofuPlanResult {
  readonly planDigest: string;
  readonly planArtifact: OpenTofuPlanArtifact;
  readonly requiredProviders?: readonly string[];
  readonly sourceCommit?: string;
  readonly providerLockDigest?: string;
  readonly providerInstallation?: readonly ProviderInstallationEvidence[];
  readonly summary?: PlanRunSummary;
  readonly diagnostics?: readonly RunDiagnostic[];
  /**
   * Resource-change projection from `tofu show -json tfplan`, used by DB-owned
   * resource/scope/action/quota policy.
   */
  readonly planResourceChanges?: readonly PlanResourceChange[];
  /** Fully-known, non-sensitive values selected by the explicit output allowlist. */
  readonly plannedOutputs?: OpenTofuOutputEnvelope;
}

export interface ProviderInstallationEvidence {
  readonly provider: string;
  readonly mirrored: boolean;
  readonly installationMethod: "filesystem_mirror" | "direct" | "unknown";
  readonly mirrorPath?: string;
  readonly attested?: boolean;
  readonly attestationMethod?: "forced_filesystem_mirror_init";
  readonly cliConfigDigest?: string;
  readonly installedPath?: string;
  readonly installedDigest?: string;
}

export interface OpenTofuApplyResult {
  readonly outputs?: OpenTofuOutputEnvelope;
  readonly stateLock?: RunnerStateLockEvidence;
  readonly diagnostics?: readonly RunDiagnostic[];
  readonly providerInstallation?: readonly ProviderInstallationEvidence[];
  /**
   * Plaintext digest of the persisted OpenTofu state, echoed by the runner
   * storage adapter after durable persistence.
   */
  readonly stateDigest?: string;
  /**
   * Opaque reference of the encrypted raw `tofu output -json` envelope,
   * echoed by the runner storage adapter after durable persistence.
   */
  readonly rawOutputRef?: string;
}

export type ReleaseActivationStatus =
  "skipped" | "pending" | "succeeded" | "failed";

export interface ReleaseActivationCommand {
  readonly id: string;
  readonly phase: "post_apply" | "pre_destroy";
  readonly command: readonly string[];
  readonly workingDirectory?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly executor?: "runner" | "operator";
  readonly timeoutSeconds?: number;
  readonly useProviderCredentials?: boolean;
}

export interface ReleaseCommandRunJob {
  readonly runId: string;
  readonly commands: readonly ReleaseActivationCommand[];
  readonly sourceSnapshot: SourceSnapshot;
  readonly nonSensitiveOutputs: Readonly<Record<string, JsonValue>>;
  readonly providerConfigurations: ProviderConfigurationsEnvelope;
  readonly credentials?: RunCredentials;
  readonly applyRunId: string;
  readonly workspaceId?: string;
  readonly capsuleId: string;
  readonly stateVersionId: string;
}

export interface ReleaseCommandRunResult {
  readonly status: "succeeded";
  readonly runId: string;
  readonly commandCount: number;
  readonly stdout?: string;
}

export interface ReleaseActivationInput {
  readonly planRun: PlanRun;
  readonly applyRun: ApplyRun;
  readonly capsule: Capsule;
  readonly stateVersion: StateVersion;
  readonly output: Output;
  /**
   * Non-sensitive apply outputs available to an operator/Cloud release
   * activator. This is broader than Output.publicOutputs because generic
   * Capsules can keep public projection empty while still producing resource ids
   * that a Cloud-only artifact publisher needs. Sensitive OpenTofu outputs and
   * secret-shaped names/values are filtered before this seam.
   */
  readonly nonSensitiveOutputs: Readonly<Record<string, JsonValue>>;
  /**
   * Exact, Plan-fenced non-secret provider-block configuration resolved from
   * ProviderBindings. Lifecycle commands receive this separately from the
   * dispatch-only credential bundle.
   */
  readonly providerConfigurations: ProviderConfigurationsEnvelope;
  /**
   * Dispatch-only provider credentials for release commands.
   * Minted immediately before activation from the same reviewed ProviderBinding
   * set as apply/destroy; never persisted or recorded in activity.
   */
  readonly credentials?: RunCredentials;
  /** Service-side InstallConfig actions pinned with the reviewed Plan. */
  readonly commands: readonly ReleaseActivationCommand[];
  readonly sourceSnapshot?: SourceSnapshot;
}

export interface ReleaseActivationResult {
  /**
   * Only `succeeded` satisfies a declared Capsule lifecycle phase. `pending`,
   * `skipped`, and `failed` are observable adapter outcomes but fail closed at
   * the Run boundary until a fresh reviewed plan/apply (or destroy) retries.
   */
  readonly status: ReleaseActivationStatus;
  /** Operator-defined activation kind, for example `operator.release`. */
  readonly kind?: string;
  readonly message?: string;
  /** Operational health evidence only; runtime URLs belong to Interfaces. */
  readonly healthUrl?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface ReleaseActivator {
  activate(input: ReleaseActivationInput): Promise<ReleaseActivationResult>;
}

export interface OpenTofuDestroyResult {
  readonly diagnostics?: readonly RunDiagnostic[];
  readonly providerInstallation?: readonly ProviderInstallationEvidence[];
}

export interface OpenTofuRestoreJob {
  readonly runId: string;
  readonly stateScope: DispatchStateScope;
  readonly sourceState: {
    readonly stateRef: string;
    readonly digest: string;
  };
}

export interface OpenTofuServiceDataRestoreJob {
  readonly runId: string;
  readonly stateScope: DispatchStateScope;
  readonly sourceState: {
    readonly stateRef: string;
    readonly digest: string;
  };
  readonly serviceData: ServiceDataBackupPointer;
}

export interface OpenTofuRestoreResult {
  readonly state: {
    readonly generation: number;
    readonly stateRef: string;
    readonly digest: string;
  };
  readonly diagnostics?: readonly RunDiagnostic[];
}

export interface OpenTofuRunner {
  plan(job: OpenTofuPlanJob): Promise<OpenTofuPlanResult>;
  apply(job: OpenTofuApplyJob): Promise<OpenTofuApplyResult>;
  destroy?(job: OpenTofuDestroyJob): Promise<OpenTofuDestroyResult>;
  release?(job: ReleaseCommandRunJob): Promise<ReleaseCommandRunResult>;
  restore?(job: OpenTofuRestoreJob): Promise<OpenTofuRestoreResult>;
  restoreServiceData?(
    job: OpenTofuServiceDataRestoreJob,
  ): Promise<RunServiceDataRestoreResult>;
  /**
   * Resolves a Source to an immutable archive snapshot (Core Specification §6).
   * The runner runs `git ls-remote` + a shallow fetch in the untrusted container
   * and publishes the archive bytes through the host storage adapter at
   * {@link OpenTofuSourceSyncJob.archiveRef}; it returns only the resolved
   * commit and archive metadata. A composed runner that does not implement this
   * capability must fail the SourceSync Run explicitly; it must never leave the
   * ledger queued indefinitely.
   */
  sourceSync?(job: OpenTofuSourceSyncJob): Promise<OpenTofuSourceSyncResult>;
  /**
   * Expands an immutable SourceSnapshot archive in the Runner Container and
   * returns the OpenTofu source files needed by the Capsule Compatibility
   * analyzer. This keeps archive extraction and path validation on the same
   * untrusted execution boundary used for plan/apply.
   */
  readCapsuleSourceFiles?(
    job: OpenTofuCapsuleSourceFilesJob,
  ): Promise<readonly OpenTofuCapsuleSourceFile[]>;
  /** Resolves only the highest stable SemVer tag + immutable commit. */
  resolveStableSourceTag?(
    job: OpenTofuStableSourceTagResolutionJob,
  ): Promise<OpenTofuStableSourceTagResolutionResult>;
  /** Reads one bounded presentation file from an immutable SourceSnapshot. */
  readSourceSnapshotPresentationFile?(
    job: OpenTofuSourceSnapshotPresentationFileJob,
  ): Promise<OpenTofuSourceSnapshotPresentationFile>;
}

/**
 * Host-composed executor adapters keyed by the exact open token declared on a
 * RunnerProfile. Registry membership is execution authority; labels and
 * provider names are not.
 */
export type OpenTofuRunnerExecutorRegistry = ReadonlyMap<
  string,
  OpenTofuRunner
>;

export interface OpenTofuCapsuleSourceFile {
  readonly path: string;
  readonly text: string;
}

export interface OpenTofuCapsuleSourceFilesJob {
  readonly runId: string;
  readonly sourceSnapshot: SourceSnapshot;
  readonly modulePath?: string;
}

export interface OpenTofuStableSourceTagResolutionJob {
  readonly runId: string;
  readonly url: string;
}

export interface OpenTofuStableSourceTagResolutionResult {
  readonly tag: string;
  readonly commit: string;
}

export interface OpenTofuSourceSnapshotPresentationFileJob {
  readonly runId: string;
  readonly sourceSnapshot: SourceSnapshot;
  readonly path: string;
}

export interface OpenTofuSourceSnapshotPresentationFile {
  readonly path: string;
  readonly text: string;
  readonly digest: string;
  readonly sizeBytes: number;
}

/**
 * Source-sync dispatch job. `credentials` carries the source-phase mint result
 * (git env + files); absent for a public repo. Never logged; threaded onto the
 * runner dispatch only.
 */
export interface OpenTofuSourceSyncJob {
  readonly runId: string;
  readonly workspaceId: string;
  readonly sourceId: string;
  readonly source: {
    readonly url: string;
    readonly ref: string;
    readonly path: string;
  };
  readonly archiveRef: string;
  /**
   * Previous immutable SourceSnapshot for the same Source/ref/path. The runner
   * may resolve the ref with git ls-remote and, when it still points at this
   * commit, return this archive metadata without cloning/archiving again.
   */
  readonly reuseSnapshot?: {
    readonly id: string;
    readonly resolvedCommit: string;
    readonly archiveRef: string;
    readonly archiveDigest: string;
    readonly archiveSizeBytes: number;
  };
  readonly credentials?: {
    readonly env: Readonly<Record<string, string>>;
    readonly files?: readonly {
      readonly path: string;
      readonly mode: number;
      readonly content: string;
    }[];
  };
}

export interface OpenTofuSourceSyncResult {
  readonly resolvedCommit: string;
  readonly archiveDigest: string;
  readonly archiveSizeBytes: number;
  /** Repository-root presentation metadata captured from the same Git commit. */
  readonly repositoryInstallMetadata?: RepositoryInstallMetadataSnapshot;
  /** Existing archive reference when an unchanged ref reused a SourceSnapshot. */
  readonly archiveRef?: string;
  readonly phaseTimings?: readonly SourceSyncPhaseTiming[];
}

/**
 * Out-of-process run dispatch seam. The controller's create path persists the
 * run as `queued` and hands the run identity to `enqueueRun`; the actual
 * OpenTofu execution happens later in the queue consumer
 * (`runQueuedPlan` / `runQueuedApply`).
 *
 * The Workers adapter supplies a producer that publishes onto
 * `RUN_QUEUE`. Tests and non-queue runtimes (local / node
 * substrates) get a default inline dispatcher that runs the consumer logic
 * immediately, preserving the historical create-executes-run behavior.
 */
export interface OpenTofuRunDispatch {
  readonly action: "plan" | "apply" | "source_sync" | "restore";
  readonly runId: string;
  readonly workspaceId: string;
  readonly cause?: "controller_retry";
}

export type EnqueueRun = (dispatch: OpenTofuRunDispatch) => Promise<void>;

/**
 * Stale-heartbeat takeover window. A run left `running` by a crashed consumer
 * may be retried once its heartbeat is older than this; a fresh `running`
 * heartbeat means a sibling consumer holds the run and the duplicate no-ops.
 */
export const RUN_HEARTBEAT_STALE_MS = 10 * 60 * 1000;

/**
 * Renewal cadence for a long-running apply/destroy: re-stamp the run heartbeat
 * and renew the lease at a fraction of the tighter of the lease TTL and the
 * heartbeat-stale window, so a sibling never observes the run as crashed while
 * the single blocking runner fetch is in flight. `/3` leaves room for at least
 * two renewals before either deadline elapses.
 */
export const RUN_RENEWAL_INTERVAL_MS = Math.floor(
  Math.min(DEFAULT_CAPSULE_LEASE_TTL_MS, RUN_HEARTBEAT_STALE_MS) / 3,
);

/**
 * The non-terminal run statuses a TERMINAL transition (succeeded / failed /
 * cancelled) is allowed to fire from. (The internal run model has no distinct
 * `waiting_approval` status — a plan that parks for approval stays `succeeded`,
 * so its later cancel is handled by the `succeeded`-from cancel CAS, not here.)
 * A run already in a terminal state is never re-terminalized (the fenced CAS
 * loses and the existing row stands).
 */
export const NON_TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
];

export function providersRequiringProviderBindings(
  providers: readonly string[],
  runnerProfile?: Pick<RunnerProfile, "requireProviderBindings">,
): readonly string[] {
  if (runnerProfile && runnerProfile.requireProviderBindings !== true) {
    return [];
  }
  return normalizeProviders(providers);
}

/**
 * At-rest sealer for the SENSITIVE pinned values of a DependencySnapshot entry
 * (spec §11 / §18). The host wires this with the SAME AES-GCM envelope used for
 * state / plan / raw-output artifacts (no new key management). `seal` takes the
 * `{ name: value }` map of an edge's sensitive values and returns the sealed
 * blob persisted onto {@link SealedDependencyValues}; `open` reverses it at
 * apply time. When absent, an edge that resolves a sensitive value fails closed
 * (`dependency_value_sealer_unavailable`) rather than persisting cleartext.
 */
export interface DependencyValueSealer {
  seal(
    values: Readonly<Record<string, JsonValue>>,
  ): Promise<SealedDependencyValues>;
  open(
    sealed: SealedDependencyValues,
  ): Promise<Readonly<Record<string, JsonValue>>>;
}

export interface OpenTofuControllerDependencies {
  readonly store?: OpenTofuControlStore;
  /**
   * Explicit binding for the reference `opentofu.default` executor. It also
   * supplies optional source-sync/source-read methods to the Source domain.
   */
  readonly runner?: OpenTofuRunner;
  /** Additional open executor-id to runner adapter bindings. */
  readonly runnerExecutors?: OpenTofuRunnerExecutorRegistry;
  /**
   * Operator extension seam: permits Workspace Provider Bindings to reference
   * operator-scoped Provider Connections. Defaults off for OSS/self-host.
   */
  readonly allowOperatorScopedProviderConnections?: boolean;
  readonly runnerProfiles?: readonly RunnerProfile[];
  readonly defaultRunnerProfileId?: string;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => number;
  /**
   * Credential Vault broker. When present, the controller exposes the
   * ProviderConnection lifecycle (`createConnection` / `listConnections` /
   * `testConnection` / `deleteConnection`). When
   * absent, those methods throw `not_implemented`. The Vault is intentionally
   * Wired into plan/apply dispatch from Phase 1B onward: the queue consumer
   * mints a {@link CredentialBundle} just before the container dispatch and
   * attaches it to the dispatch payload only (never stored, never logged).
   */
  readonly vault?: ConnectionVault;
  /**
   * Optional ambient run-identity issuer for module-declared Interfaces.
   * The token is Capsule-scoped and injected only in the per-run credential
   * payload, never persisted in Run/state/output evidence.
   */
  readonly capsuleRunIdentity?: CapsuleRunIdentityIssuer;
  /**
   * Complete service-installed Credential Recipe catalog exposed through
   * discovery and used for connection validation. Omitted means that no
   * recipes are installed; Core never imports a reference catalog or infers
   * recipes from provider names.
   */
  readonly credentialRecipes?: readonly CredentialRecipe[];
  /**
   * Source domain service (Core Specification §6). When present, the controller
   * exposes the Source lifecycle (`createSource` / `listSources` / `getSource` /
   * `patchSource` / `createSourceSync` / `listSourceSnapshots`) and the
   * `source_sync` consumer path. When absent, those methods throw
   * `not_implemented`.
   */
  readonly sourcesService?: SourcesService;
  /** Host authority for allocating opaque durable artifact references. */
  readonly artifactReferenceAllocator?: ArtifactReferenceAllocator;
  /**
   * Out-of-process run dispatch. Defaults to an inline dispatcher that runs the
   * consumer immediately (preserving synchronous create-executes-run for
   * tests / local / node substrates). The Workers adapter injects a producer
   * that enqueues onto `RUN_QUEUE`.
   */
  readonly enqueueRun?: EnqueueRun;
  /**
   * Capsule lease seam (core-spec.md §22 / §23). When present, the apply
   * consumer acquires the `capsule:{capsuleId}:{environment}` lease
   * before executing a write run and releases it in `finally`, so only ONE
   * write run per (Capsule, environment) runs at a time. A busy lease
   * throws {@link CapsuleLeaseBusyError} so the queue redelivers. When
   * absent, the controller falls back to its in-process serialization on the
   * Capsule key (single-isolate safe; cross-isolate needs the DO-backed
   * seam). `source_sync` never takes the lease.
   */
  readonly capsuleCoordination?: CapsuleCoordination;
  /**
   * Renewal cadence (ms) for a long-running apply/destroy: how often the
   * controller re-stamps the run heartbeat + renews the held lease while a
   * single blocking runner fetch is in flight. Defaults to
   * {@link RUN_RENEWAL_INTERVAL_MS}. Tests inject a small value to drive the
   * renewal tick deterministically; values <= 0 disable the renewal timer.
   */
  readonly runRenewalIntervalMs?: number;
  /**
   * Workspace-scoped Activity audit trail (spec §27 audit_events / §34 Activity).
   * The controller emits run-lifecycle events (plan created, approved, applied,
   * destroyed) and stale propagation through it. Fire-and-forget: a failed audit
   * write never fails the run path. Defaults to a no-op recorder.
   */
  readonly activity?: ActivityRecorder;
  /**
   * Host-injected sensitive output resolver. Required only when a cross-Workspace
   * published_output edge consumes an OutputShare entry marked sensitive. The
   * resolver reads/decrypts the raw output artifact and returns the value for
   * dependency injection; values are never persisted outside DependencySnapshot.
   */
  readonly sensitiveOutputResolver?: SensitiveOutputResolver;
  /**
   * Host-injected at-rest sealer for the sensitive pinned values of a
   * DependencySnapshot entry (spec §11 / §18). Required whenever a
   * `published_output` edge resolves a sensitive output: the controller seals
   * the value into {@link SealedDependencyValues} instead of persisting it as a
   * cleartext ledger value, and unseals it at apply. Absent ⇒ a sensitive edge
   * fails closed.
   */
  readonly dependencyValueSealer?: DependencyValueSealer;
  /**
   * Host-injected executor for Plan-pinned, service-side Capsule lifecycle
   * actions. Only terminal `succeeded` satisfies a declared phase: post-apply
   * failure retains provider state/output but leaves the Run failed and Capsule
   * non-ready; pre-destroy failure prevents provider destroy. Operator actions
   * receive no ProviderConnection material, while an explicitly authorized
   * runner action may receive dispatch-only credentials. Sensitive Outputs are
   * filtered before either path.
   */
  readonly releaseActivator?: ReleaseActivator;
  readonly observability?: Pick<ObservabilitySink, "recordMetric">;
  readonly metricTags?: Record<string, string>;
  /**
   * Operator/self-host billing default (§28). Workspace.billingSettings overrides
   * this. Omitted means self-host style `disabled`.
   */
  readonly defaultBillingSettings?: BillingSettings;
  /** Host-injected price policy. Omitted means measurements remain unrated. */
  readonly showbackRater?: ShowbackRater;
  /**
   * Seam B enforcement port. Omitted ⇒ OSS showback no-op (never blocks /
   * never charges). A commercial host may inject a closed implementation.
   */
  readonly billingEnforcement?: BillingEnforcement;
  /** Seam B plan-quota port. Omitted ⇒ OSS no-op (no plan limits). */
  readonly quotaPolicy?: QuotaPolicy;
  /**
   * Optional owner-account limit for short, unscoped names under the
   * operator-managed public base domain. Omitted means unlimited; Workspace-
   * scoped managed hostnames never consume this allowance.
   */
  readonly managedVanityHostnameSlotsPerOwner?: number;
}

export interface DeployControlActorContext {
  readonly actor?: string;
}

export interface GenericRootPlanContext {
  readonly providerBindings: readonly RootProviderBinding[];
  readonly outputAllowlist: InstallConfig["outputAllowlist"];
  readonly sourceBuild?: InstallConfig["sourceBuild"];
  readonly lifecycleActions?: InstallConfig["lifecycleActions"];
}

export interface GenericRootDispatchContext {
  readonly generatedRoot?: DispatchGeneratedRoot;
  readonly operatorModule?: RunModuleDispatch["operatorModule"];
  readonly workspaceOutputAllowlist: InstallConfig["outputAllowlist"];
  readonly outputAllowlist: InstallConfig["outputAllowlist"];
  readonly sourceBuild?: InstallConfig["sourceBuild"];
  readonly lifecycleActions?: InstallConfig["lifecycleActions"];
  readonly stateAdoption?: DispatchStateAdoption;
}

/**
 * Internal plan-creation context for the Capsule-driven flow. Carried only
 * by {@link OpenTofuController.createCapsulePlan} /
 * `createCapsuleDestroyPlan`; the raw `/internal/v1/plan-runs` create path leaves
 * it empty.
 */
export interface PlanRunInternalContext {
  readonly capsuleContext?: PlanRunCapsuleContext;
  /** First-class Resource run subject; mutually exclusive with Capsule context. */
  readonly resourceContext?: PlanRunResourceContext;
  readonly sourceSnapshotId?: string;
  readonly compatibilityReportId?: string;
  readonly lifecycleActions?: InstallConfig["lifecycleActions"];
  /** The Capsule's current state generation (its latest StateVersion, or 0). */
  readonly baseStateGeneration?: number;
  /** Provider/root wiring for a Capsule plan when a wrapper is required. */
  readonly capsulePlan?: CapsulePlanContext;
  /** Optional generated-root dispatch for a plain Git OpenTofu Capsule. */
  readonly genericRootDispatch?: GenericRootDispatchContext;
  /**
   * RunGroup this plan belongs to (spec §19 / §24). Stamped onto the PlanRun by
   * the RunGroup space-update path so the §19 Run projects `runGroupId` and the
   * group status can be computed from its member runs. Absent for standalone
   * plans.
   */
  readonly runGroupId?: string;
  /**
   * Marks this plan as a §19 `drift_check` (Phase 8). Stamped onto the PlanRun
   * so it projects `type: "drift_check"`, never parks `waiting_approval`, and is
   * rejected by `createApplyRun`. Capsule orchestration and first-class
   * Resource observation both use this same read-only Run primitive.
   */
  readonly driftCheck?: true;
  /**
   * Executes the ordinary plan/apply pair with OpenTofu refresh-only
   * semantics. This is execution evidence, not a new public Run type.
   */
  readonly refreshOnly?: true;
  /** Reviewed config-driven Resource import; not a separate public Run type. */
  readonly resourceImport?: true;
  /**
   * Server-side auto-continue (auto-update pipeline): stamped onto the PlanRun
   * so the queue consumer creates the apply run itself when the completed plan
   * is CLEAN (`succeeded`). See {@link PlanRun.autoApplyRequested}.
   */
  readonly autoApplyRequested?: true;
  /**
   * Dependency pins resolved by the Capsule planning path before the PlanRun
   * row exists. `createPlanRun` persists them immediately after creating the run
   * row and before queue dispatch, so runner dispatch can restore remote_state
   * from the same DependencySnapshot apply will verify.
   */
  readonly resolvedDependencies?: ResolvedDependencies;
}

// `ResolvedDependencies` (the resolved consumer Dependencies for an
// Capsule-driven plan) + `ShareCoverage` now live with the resolution logic
// in {@link DependencyResolutionService}; `ResolvedDependencies` is imported above
// because the controller's plan-creation / snapshot-pin seam still threads it.

/**
 * Request to plan / destroy-plan an Capsule (spec §23). Resolves the
 * Capsule -> InstallConfig -> Source, picks the latest SourceSnapshot,
 * and creates a plan run carrying Capsule context + the resolved
 * snapshot.
 */
export interface CreateCapsulePlanRequest {
  readonly capsuleId: string;
}

/**
 * Internal options for a Capsule-driven plan created as a RunGroup member
 * (spec §19 / §24). The RunGroupsService passes the group id so the plan (and
 * its eventual apply) projects `runGroupId` onto the §19 Run. Not part of the
 * public create request.
 */
export interface CreateCapsulePlanInternal {
  readonly runGroupId?: string;
  /**
   * Operator-selected runner profile for this plan. Runner choice remains
   * service-side and never changes the Capsule's Git Source contract.
   */
  readonly runnerProfileId?: string;
  /**
   * Reuses a pre-install CapsuleCompatibilityReport that was already produced
   * for the exact SourceSnapshot the plan will use. Public callers may pass this
   * as a hint; the controller still verifies existence, snapshot/source scope,
   * and policy before using it.
   */
  readonly compatibilityReportId?: string;
  /**
   * Pins the plan to a SPECIFIC SourceSnapshot id instead of resolving the
   * Source's latest snapshot for its default ref. Used by the §30 deployment
   * rollback-plan path (`POST /internal/v1/state-versions/:id/rollback-plan`) to re-plan an
   * Capsule against the source snapshot recorded by a prior StateVersion's Run.
   * The snapshot must belong to the Capsule's Source.
   */
  readonly sourceSnapshotId?: string;
  /**
   * Server-side auto-continue (auto-update pipeline): the queue consumer
   * creates the apply run itself when the completed plan is CLEAN
   * (`succeeded`). See {@link PlanRun.autoApplyRequested}.
   */
  readonly autoApplyRequested?: true;
  /**
   * Marks the resulting plan as a §19 `drift_check` (Phase 8). Set only by
   * {@link OpenTofuController.createCapsuleDriftCheck}; threaded
   * onto the created PlanRun so it projects `type: "drift_check"`, never parks
   * `waiting_approval`, and is rejected by `createApplyRun`.
   */
  readonly driftCheck?: true;
}

/**
 * The §25 layered plan-JSON policy verdict produced by
 * {@link OpenTofuController}'s `#evaluatePlanPolicy`. Each field is
 * absent when its layer was not evaluated (e.g. the runner reported no resource
 * changes, or there was no allowlist source).
 */
export interface PlanPolicyLayers {
  provider?: ProviderAllowlistResult;
  providerLockfile?: ProviderLockfilePolicyResult;
  resource?: ResourceAllowlistResult;
  scope?: ScopeBoundaryResult;
  action?: ActionPolicyResult;
  quota?: QuotaResult;
  providerInstallation?: ProviderInstallationPolicyResult;
}

/** The Capsule compatibility policy verdict for a plan run. */
interface CapsuleCompatibilityPolicyResult {
  readonly reasons: readonly string[];
  readonly audit?: Readonly<Record<string, JsonValue>>;
}

/** The plan billing reservation verdict for a plan run. */
interface PlanBillingPolicyResult {
  readonly reasons: readonly string[];
  readonly audit?: Readonly<Record<string, JsonValue>>;
}

/**
 * The composed completion verdict for a plan run: the observed providers, each
 * policy layer's result, the merged pass/blocked policy, its digest, and the
 * §25 approval flag.
 */
export interface PlanCompletionVerdict {
  readonly requiredProviders: readonly string[];
  readonly layered: PlanPolicyLayers;
  readonly compatibilityPolicy: CapsuleCompatibilityPolicyResult;
  readonly billingPolicy: PlanBillingPolicyResult;
  readonly passedPolicy: boolean;
  readonly completedPolicy: PolicyDecision;
  readonly policyDecisionDigest: string;
  readonly requiresApproval: boolean;
}

export type RunClaimResult<R extends PlanRun | ApplyRun> =
  | { readonly won: true; readonly run: R; readonly leaseToken: string }
  | { readonly won: false; readonly run: R };

export interface TerminalRunPersistResult<R extends PlanRun | ApplyRun> {
  readonly won: boolean;
  readonly run: R;
}

export class OpenTofuController {
  readonly #store: OpenTofuControlStore;
  readonly #runner?: OpenTofuRunner;
  readonly #runnerExecutors: OpenTofuRunnerExecutorRegistry;
  readonly #vault?: ConnectionVault;
  readonly #sourcesService?: SourcesService;
  readonly #artifactReferenceAllocator?: ArtifactReferenceAllocator;
  readonly #defaultRunnerProfileId: string;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #enqueueRun: EnqueueRun;
  readonly #capsuleCoordination?: CapsuleCoordination;
  readonly #runRenewalIntervalMs: number;
  readonly #activity: ActivityRecorder;
  readonly #sensitiveOutputResolver?: SensitiveOutputResolver;
  readonly #dependencyValueSealer?: DependencyValueSealer;
  readonly #releaseActivator?: ReleaseActivator;
  readonly #observability?: Pick<ObservabilitySink, "recordMetric">;
  readonly #metricTags: Record<string, string>;
  readonly #defaultBillingSettings: BillingSettings;
  readonly #allowOperatorScopedProviderConnections: boolean;
  readonly #seededProfiles: Promise<void>;
  readonly #configuredRunnerProfileIds: ReadonlySet<string>;
  readonly #mutationChains = new Map<string, Promise<void>>();
  readonly #sources: SourceManagement;
  readonly #sourceLifecycle: SourceLifecycleService;
  readonly #connections: ConnectionManagement;
  readonly #capsules: CapsuleQuery;
  readonly #runQuery: RunQueryService;
  readonly #billing: BillingService;
  readonly #usage: UsageReportingService;
  readonly #drift: DriftService;
  readonly #credentials: RunCredentialBroker;
  readonly #runEnv: RunEnvResolver;
  readonly #dependencies: DependencyResolutionService;
  readonly #verification: RunVerificationService;
  readonly #planResolution: PlanResolutionService;
  readonly #usesExternalRunQueue: boolean;
  #connectionsService?: ConnectionsService;
  readonly #runEngine: RunEngine;
  readonly #credentialRecipes: readonly CredentialRecipe[];

  constructor(dependencies: OpenTofuControllerDependencies = {}) {
    this.#store = dependencies.store ?? new InMemoryOpenTofuControlStore();
    this.#runner = dependencies.runner;
    const runnerExecutors = new Map(dependencies.runnerExecutors ?? []);
    for (const executorId of runnerExecutors.keys()) {
      if (!executorId.trim()) {
        throw new Error(
          "runner executor registry contains an empty executorId",
        );
      }
    }
    if (dependencies.runner) {
      const configuredDefault = runnerExecutors.get(
        DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
      );
      if (configuredDefault && configuredDefault !== dependencies.runner) {
        throw new Error(
          `runner executor ${DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID} is configured more than once`,
        );
      }
      runnerExecutors.set(
        DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
        dependencies.runner,
      );
    }
    this.#runnerExecutors = runnerExecutors;
    this.#vault = dependencies.vault;
    this.#credentialRecipes = normalizeCredentialRecipeCatalog(
      dependencies.credentialRecipes ?? [],
    );
    this.#sourcesService = dependencies.sourcesService;
    this.#artifactReferenceAllocator = dependencies.artifactReferenceAllocator;
    this.#sources = new SourceManagement(dependencies.sourcesService);
    this.#connections = new ConnectionManagement(this.#store, this.#vault);
    this.#capsules = new CapsuleQuery(this.#store, publicCapsule);
    this.#runQuery = new RunQueryService(this.#store);
    this.#capsuleCoordination = dependencies.capsuleCoordination;
    this.#runRenewalIntervalMs =
      dependencies.runRenewalIntervalMs !== undefined &&
      Number.isFinite(dependencies.runRenewalIntervalMs)
        ? dependencies.runRenewalIntervalMs
        : RUN_RENEWAL_INTERVAL_MS;
    this.#activity = dependencies.activity ?? NOOP_ACTIVITY_RECORDER;
    this.#sensitiveOutputResolver = dependencies.sensitiveOutputResolver;
    this.#dependencyValueSealer = dependencies.dependencyValueSealer;
    this.#releaseActivator = dependencies.releaseActivator;
    this.#observability = dependencies.observability;
    this.#metricTags = dependencies.metricTags ?? {};
    this.#defaultBillingSettings =
      dependencies.defaultBillingSettings ?? DISABLED_BILLING_SETTINGS;
    this.#allowOperatorScopedProviderConnections =
      dependencies.allowOperatorScopedProviderConnections === true;
    this.#defaultRunnerProfileId =
      dependencies.defaultRunnerProfileId ?? DEFAULT_OPENTOFU_RUNNER_PROFILE_ID;
    this.#newId = dependencies.newId ?? newId;
    this.#now = dependencies.now ?? (() => Date.now());
    this.#sourceLifecycle = new SourceLifecycleService({
      store: this.#store,
      now: this.#now,
      newId: this.#newId,
      runRenewalIntervalMs: this.#runRenewalIntervalMs,
      ...(dependencies.sourcesService
        ? { sourcesService: dependencies.sourcesService }
        : {}),
      ...(this.#runner ? { runner: this.#runner } : {}),
      requireVault: () => this.#requireVault(),
      shouldProcessRun: (status, heartbeatAt) =>
        this.#runEngine.shouldProcessRun(status, heartbeatAt),
      onCapsuleStaleForNewSnapshot: (input) =>
        this.#maybeAutoUpdateStaleCapsule(input),
    });
    this.#billing = new BillingService({
      store: this.#store,
      newId: this.#newId,
      now: this.#now,
      defaultBillingSettings: this.#defaultBillingSettings,
      requireWorkspace: (workspaceId) => this.#requireWorkspace(workspaceId),
      ...(dependencies.showbackRater
        ? { rater: dependencies.showbackRater }
        : {}),
      ...(dependencies.billingEnforcement
        ? { enforcement: dependencies.billingEnforcement }
        : {}),
      ...(dependencies.quotaPolicy ? { quota: dependencies.quotaPolicy } : {}),
    });
    this.#usage = new UsageReportingService({
      store: this.#store,
      newId: this.#newId,
      now: this.#now,
      requireWorkspace: (workspaceId) => this.#requireWorkspace(workspaceId),
      billing: this.#billing,
    });
    this.#drift = new DriftService({
      createPlanRun: (capsuleId, destroy, context, internal) =>
        this.#runEngine.createCapsulePlanRun(
          capsuleId,
          destroy,
          context,
          internal,
        ),
      recordActivity: (event) => this.#runEngine.recordActivity(event),
    });
    this.#credentials = new RunCredentialBroker({
      store: this.#store,
      newId: this.#newId,
      now: this.#now,
      ...(this.#vault ? { vault: this.#vault } : {}),
      resolveRunProviderBindings: (planRun) =>
        this.#runEngine.resolveRunProviderBindings(planRun),
      policyForPlanRun: (planRun) => this.#runEngine.policyForPlanRun(planRun),
    });
    this.#runEnv = new RunEnvResolver({
      credentials: this.#credentials,
      resolveRunProviderBindings: (planRun) =>
        this.#runEngine.resolveRunProviderBindings(planRun),
      ...(dependencies.capsuleRunIdentity
        ? { capsuleRunIdentity: dependencies.capsuleRunIdentity }
        : {}),
    });
    this.#dependencies = new DependencyResolutionService({
      store: this.#store,
      ...(this.#dependencyValueSealer
        ? { dependencyValueSealer: this.#dependencyValueSealer }
        : {}),
      ...(this.#sensitiveOutputResolver
        ? { sensitiveOutputResolver: this.#sensitiveOutputResolver }
        : {}),
    });
    this.#verification = new RunVerificationService({
      store: this.#store,
      dependencies: this.#dependencies,
      ...(this.#artifactReferenceAllocator
        ? { artifactReferenceAllocator: this.#artifactReferenceAllocator }
        : {}),
      ...(this.#dependencyValueSealer
        ? { dependencyValueSealer: this.#dependencyValueSealer }
        : {}),
      policyForPlanRun: (planRun) => this.#runEngine.policyForPlanRun(planRun),
      assertCompatibilityReportRunnable: (report, policy) =>
        this.#runEngine.assertCompatibilityReportRunnable(report, policy),
    });
    // Default to an inline dispatcher: run the consumer immediately so local /
    // node substrates and tests keep the historical synchronous semantics.
    this.#usesExternalRunQueue = dependencies.enqueueRun !== undefined;
    this.#enqueueRun =
      dependencies.enqueueRun ??
      ((dispatch) => this.#runEngine.dispatchQueuedRun(dispatch));
    this.#planResolution = new PlanResolutionService({
      resolveCapsuleProviderBindingsForRun: (capsule, requiredProviders) =>
        this.#runEngine.resolveCapsuleProviderBindingsForRun(
          capsule,
          requiredProviders,
        ),
    });
    const runnerProfiles =
      dependencies.runnerProfiles ?? createDefaultRunnerProfiles(this.#now());
    this.#configuredRunnerProfileIds = new Set(
      runnerProfiles.map((profile) => profile.id),
    );
    this.#seededProfiles = this.#seedRunnerProfiles(runnerProfiles);
    this.#runEngine = new RunEngine({
      store: this.#store,
      runnerExecutors: this.#runnerExecutors,
      sourcesService: this.#sourcesService,
      artifactReferenceAllocator: this.#artifactReferenceAllocator,
      defaultRunnerProfileId: this.#defaultRunnerProfileId,
      newId: this.#newId,
      now: this.#now,
      enqueueRun: this.#enqueueRun,
      capsuleCoordination: this.#capsuleCoordination,
      runRenewalIntervalMs: this.#runRenewalIntervalMs,
      activity: this.#activity,
      dependencyValueSealer: this.#dependencyValueSealer,
      releaseActivator: this.#releaseActivator,
      observability: this.#observability,
      metricTags: this.#metricTags,
      allowOperatorScopedProviderConnections:
        this.#allowOperatorScopedProviderConnections,
      runnerProfiles,
      seededProfiles: this.#seededProfiles,
      runQuery: this.#runQuery,
      billing: this.#billing,
      drift: this.#drift,
      runEnv: this.#runEnv,
      dependencies: this.#dependencies,
      verification: this.#verification,
      planResolution: this.#planResolution,
      sourceLifecycle: this.#sourceLifecycle,
      capsules: this.#capsules,
      runSerialized: <T>(key: string, work: () => Promise<T>): Promise<T> =>
        this.#runSerialized(key, work),
      ...(dependencies.managedVanityHostnameSlotsPerOwner !== undefined
        ? {
            managedVanityHostnameSlotsPerOwner: Math.max(
              0,
              Math.floor(dependencies.managedVanityHostnameSlotsPerOwner),
            ),
          }
        : {}),
    });
  }

  setTerminalRunObserver(
    observer: ((run: PlanRun | ApplyRun) => Promise<void>) | undefined,
  ): void {
    this.#runEngine.setTerminalObserver(observer);
  }

  setPlanRunQueuedObserver(
    observer: ((run: PlanRun) => Promise<void>) | undefined,
  ): void {
    this.#runEngine.setPlanQueuedObserver(observer);
  }

  setApplyRunQueuedObserver(
    observer: ((run: ApplyRun) => Promise<void>) | undefined,
  ): void {
    this.#runEngine.setApplyQueuedObserver(observer);
  }

  setRestoreRunObserver(
    observer: ((event: RestoreRunLifecycleEvent) => Promise<void>) | undefined,
  ): void {
    this.#runEngine.setRestoreObserver(observer);
  }

  setInterfaceOutputSourcesResolver(
    resolver:
      | ((input: {
          readonly workspaceId: string;
          readonly capsuleId: string;
        }) => Promise<readonly string[]>)
      | undefined,
  ): void {
    this.#runEngine.setInterfaceOutputSourcesResolver(resolver);
  }

  usesExternalRunQueue(): boolean {
    return this.#usesExternalRunQueue;
  }

  async listRunnerProfiles(): Promise<ListRunnerProfilesResponse> {
    await this.#seededProfiles;
    return {
      runnerProfiles: (await this.#store.listRunnerProfiles()).filter(
        (profile) => this.#configuredRunnerProfileIds.has(profile.id),
      ),
    };
  }

  listCredentialRecipes(): Promise<ListCredentialRecipesResponse> {
    return Promise.resolve({ recipes: this.#credentialRecipes });
  }

  getCredentialRecipe(recipeId: string): Promise<CredentialRecipeResponse> {
    requireNonEmptyString(recipeId, "recipeId");
    const recipe = this.#credentialRecipes.find(
      (candidate) => candidate.id === recipeId,
    );
    if (!recipe) {
      throw new OpenTofuControllerError(
        "not_found",
        `credential recipe ${recipeId} not found`,
      );
    }
    return Promise.resolve({ recipe });
  }

  async getWorkspaceBilling(workspaceId: string): Promise<{
    readonly billing: {
      readonly settings: BillingSettings;
    };
  }> {
    return await this.#usage.getWorkspaceBilling(workspaceId);
  }

  getCapsuleUsageSummary(capsuleId: string): Promise<CapsuleUsageSummary> {
    return this.#usage.getCapsuleUsageSummary(capsuleId);
  }

  async listWorkspaceUsage(
    workspaceId: string,
    params?: PageParams,
  ): Promise<{
    readonly usageEvents: readonly UsageEvent[];
    readonly nextCursor?: string;
  }> {
    return await this.#usage.listWorkspaceUsage(workspaceId, params);
  }

  async recordMeteredUsage(
    workspaceId: string,
    input: RecordMeteredUsageInput,
  ): Promise<{ readonly usageEvent: UsageEvent }> {
    return await this.#usage.recordMeteredUsage(workspaceId, input);
  }

  async updateWorkspaceBillingSettings(
    workspaceId: string,
    input: { readonly billingSettings: BillingSettings },
  ): Promise<{ readonly billing: { readonly settings: BillingSettings } }> {
    return await this.#billing.updateWorkspaceBillingSettings(
      workspaceId,
      input,
    );
  }

  // --- Run / Capsule lifecycle (delegated to the RunEngine collaborator) ------

  createPlanRun(
    request: CreatePlanRunRequest,
    context: DeployControlActorContext = {},
    internal: PlanRunInternalContext = {},
  ): Promise<PlanRunResponse> {
    return this.#runEngine.createPlanRun(request, context, internal);
  }

  createCapsulePlan(
    capsuleId: string,
    context: DeployControlActorContext = {},
    internal: CreateCapsulePlanInternal = {},
  ): Promise<PlanRunResponse> {
    return this.#runEngine.createCapsulePlan(capsuleId, context, internal);
  }

  claimManagedPublicHostname(
    input: ManagedPublicHostnameClaimRequest,
  ): Promise<ManagedPublicHostnameClaimResult> {
    return this.#runEngine.claimManagedPublicHostname(input);
  }

  createCapsuleDestroyPlan(
    capsuleId: string,
    context: DeployControlActorContext = {},
    internal: Pick<CreateCapsulePlanInternal, "runnerProfileId"> = {},
  ): Promise<PlanRunResponse> {
    return this.#runEngine.createCapsuleDestroyPlan(
      capsuleId,
      context,
      internal,
    );
  }

  createCapsuleDriftCheck(
    capsuleId: string,
    context: DeployControlActorContext = {},
    internal: Pick<CreateCapsulePlanInternal, "runGroupId"> = {},
  ): Promise<PlanRunResponse> {
    return this.#runEngine.createCapsuleDriftCheck(
      capsuleId,
      context,
      internal,
    );
  }

  createApplyRun(
    request: CreateApplyRunRequest,
    context: DeployControlActorContext = {},
  ): Promise<ApplyRunResponse> {
    return this.#runEngine.createApplyRun(request, context);
  }

  dispatchQueuedRun(dispatch: OpenTofuRunDispatch): Promise<void> {
    return this.#runEngine.dispatchQueuedRun(dispatch);
  }

  runQueuedRestore(runId: string): Promise<Run | undefined> {
    return this.#runEngine.runQueuedRestore(runId);
  }

  runQueuedSourceSync(runId: string): Promise<SourceSyncRun | undefined> {
    return this.#runEngine.runQueuedSourceSync(runId);
  }

  markRunFailed(
    action: "plan" | "apply" | "restore" | "source_sync",
    runId: string,
    reason: string,
  ): Promise<boolean> {
    return this.#runEngine.markRunFailed(action, runId, reason);
  }

  runQueuedPlan(runId: string): Promise<PlanRun | undefined> {
    return this.#runEngine.runQueuedPlan(runId);
  }

  runQueuedApply(runId: string): Promise<ApplyRunResponse> {
    return this.#runEngine.runQueuedApply(runId);
  }

  createRestoreRun(
    workspaceId: string,
    backupId: string,
    request: CreateRestoreRequest,
    context: DeployControlActorContext = {},
  ): Promise<Run> {
    return this.#runEngine.createRestoreRun(
      workspaceId,
      backupId,
      request,
      context,
    );
  }

  cancelRun(id: string): Promise<Run> {
    return this.#runEngine.cancelRun(id);
  }

  approveRun(
    id: string,
    input: { readonly approvedBy?: string; readonly reason?: string } = {},
  ): Promise<Run> {
    return this.#runEngine.approveRun(id, input);
  }
  async getPlanRun(id: string): Promise<PlanRunResponse> {
    requireNonEmptyString(id, "planRunId");
    const planRun = await this.#store.getPlanRun(id);
    if (!planRun) {
      throw new OpenTofuControllerError(
        "not_found",
        `plan run ${id} not found`,
      );
    }
    return { planRun: publicPlanRun(planRun) };
  }

  async getApplyRun(id: string): Promise<ApplyRunResponse> {
    return await this.#capsules.getApplyRun(id);
  }

  async getCapsule(id: string): Promise<GetCapsuleResponse> {
    return await this.#capsules.getCapsule(id);
  }

  async getCurrentOutput(capsuleId: string): Promise<OutputResponse> {
    return await this.#capsules.getCurrentOutput(capsuleId);
  }

  /**
   * Lists active Capsules across all Workspaces, capped at `limit` (spec §28
   * scheduled drift sweep; Phase 8). Only active Capsules are drift-checkable
   * (a `pending` / `disabled` / `destroyed` / `error` Capsule has no
   * stable deployed state to compare against). The scheduled sweep iterates this
   * bounded set and creates one drift check per Capsule. A non-positive
   * limit returns an empty list.
   */
  async listActiveCapsules(limit: number): Promise<readonly Capsule[]> {
    return await this.#capsules.listActiveCapsules(limit);
  }

  async listStateVersions(
    capsuleId: string,
    params?: PageParams,
  ): Promise<ListStateVersionsResponse> {
    return await this.#capsules.listStateVersions(capsuleId, params);
  }

  async listStateVersionsByWorkspace(
    workspaceId: string,
  ): Promise<readonly StateVersion[]> {
    return await this.#capsules.listStateVersionsByWorkspace(workspaceId);
  }

  async listStateVersionsByIds(
    ids: readonly string[],
  ): Promise<readonly StateVersion[]> {
    return await this.#capsules.listStateVersionsByIds(ids);
  }

  async getStateVersion(id: string): Promise<GetStateVersionResponse> {
    return await this.#capsules.getStateVersion(id);
  }

  /** Internal domain read used by adapters following an ApplyRun.outputId. */
  async getOutput(id: string): Promise<Output | undefined> {
    requireNonEmptyString(id, "outputId");
    return await this.#store.getOutput(id);
  }

  async createStateVersionRollbackPlan(
    stateVersionId: string,
    context: DeployControlActorContext = {},
  ): Promise<PlanRunResponse> {
    const { stateVersion } = await this.getStateVersion(stateVersionId);
    const sourceSnapshotId = await this.#sourceSnapshotIdForStateVersion(
      stateVersion,
      new Set(),
    );
    if (!sourceSnapshotId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `state version ${stateVersionId} has no source snapshot provenance`,
      );
    }
    return await this.#runEngine.createCapsulePlanRun(
      stateVersion.capsuleId,
      false,
      context,
      { sourceSnapshotId },
    );
  }

  async #sourceSnapshotIdForStateVersion(
    stateVersion: StateVersion,
    seen: Set<string>,
  ): Promise<string | undefined> {
    if (seen.has(stateVersion.id)) return undefined;
    seen.add(stateVersion.id);
    const applyRun = await this.#store.getApplyRun(stateVersion.createdByRunId);
    if (applyRun) {
      return (await this.#store.getPlanRun(applyRun.planRunId))
        ?.sourceSnapshotId;
    }
    const restoreRun = await this.#store.getBackupRun(
      stateVersion.createdByRunId,
    );
    if (
      restoreRun?.type !== "restore" ||
      !restoreRun.restoredFromStateVersionId
    ) {
      return undefined;
    }
    const source = await this.#store.getStateVersion(
      restoreRun.restoredFromStateVersionId,
    );
    return source
      ? await this.#sourceSnapshotIdForStateVersion(source, seen)
      : undefined;
  }

  // --- Connections (provider credential registration; Phase 1A) -------------

  async createConnection(
    request: CreateConnectionRequest,
  ): Promise<ConnectionResponse> {
    return await this.#connections.createConnection(request);
  }

  async listConnections(
    workspaceId: string,
    params?: PageParams,
  ): Promise<ListConnectionsResponse> {
    return await this.#connections.listConnections(workspaceId, params);
  }

  /**
   * Lists instance-wide `operator`-scoped Connections (spec §30 `GET
   * /internal/v1/connections` with `?workspaceId` omitted). Never includes secret values.
   */
  async listOperatorConnections(): Promise<ListConnectionsResponse> {
    return await this.#connections.listOperatorConnections();
  }

  async getConnection(connectionId: string): Promise<ProviderConnection> {
    return await this.#connections.getConnection(connectionId);
  }

  async testConnection(connectionId: string): Promise<TestConnectionResponse> {
    return await this.#connections.testConnection(connectionId);
  }

  async deleteConnection(connectionId: string): Promise<boolean> {
    return await this.#connections.deleteConnection(connectionId);
  }

  #requireVault(): ConnectionVault {
    if (!this.#vault) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "connection vault is not configured",
      );
    }
    return this.#vault;
  }

  /**
   * Auto-update pipeline (consumer "app feel"): a Capsule that opted in
   * (`autoUpdate`) and just went `stale` because its Source resolved a new
   * snapshot gets an update plan run created here, flagged
   * `autoApplyRequested` so the queue consumer applies it when CLEAN. One
   * automatic attempt per snapshot (`autoUpdateAttemptSourceSnapshotId`
   * marker) — a failed attempt is not retry-looped; the Capsule stays 更新が
   * あります and the next new snapshot (or a manual update) retries. Failures
   * are recorded as Activity and never fail the source sync.
   */
  async #maybeAutoUpdateStaleCapsule(input: {
    readonly capsule: Capsule;
    readonly snapshot: SourceSnapshot;
  }): Promise<void> {
    try {
      // Re-read: the stale patch just rewrote the row, and the opt-in /
      // attempt marker must be judged against the current record.
      const capsule = await this.#store.getCapsule(input.capsule.id);
      if (!capsule || capsule.autoUpdate !== true) return;
      if (capsule.autoUpdateAttemptSourceSnapshotId === input.snapshot.id) {
        return;
      }
      await this.#store.patchCapsule(capsule.id, {
        autoUpdateAttemptSourceSnapshotId: input.snapshot.id,
        updatedAt: new Date(this.#now()).toISOString(),
      });
      await this.createCapsulePlan(
        capsule.id,
        { actor: "system:auto-update" },
        {
          autoApplyRequested: true,
          sourceSnapshotId: input.snapshot.id,
        },
      );
    } catch (error) {
      log.warn("service.deploy_control.auto_update_enqueue_failed", {
        capsuleId: input.capsule.id,
        sourceSnapshotId: input.snapshot.id,
        error,
      });
      await this.#activity
        .record({
          workspaceId: input.capsule.workspaceId,
          action: "capsule.auto_update_failed",
          targetType: "capsule",
          targetId: input.capsule.id,
          metadata: {
            sourceSnapshotId: input.snapshot.id,
            message: error instanceof Error ? error.message : String(error),
          },
        })
        .catch(() => {});
    }
  }

  // --- Sources (Core Specification §6) --------------------------------------

  async createSource(
    request: CreateSourceRequest,
  ): Promise<CreateSourceResponse> {
    return await this.#sources.createSource(request);
  }

  async listSources(
    workspaceId: string,
    params?: PageParams,
  ): Promise<ListSourcesResponse> {
    return await this.#sources.listSources(workspaceId, params);
  }

  async getSource(id: string): Promise<SourceResponse> {
    return await this.#sources.getSource(id);
  }

  async patchSource(
    id: string,
    patch: PatchSourceRequest,
  ): Promise<SourceResponse> {
    return await this.#sources.patchSource(id, patch);
  }

  async createSourceSync(
    sourceId: string,
    options: {
      readonly dedupe?: boolean;
      readonly intent?: SourceSyncIntent;
    } = {},
  ): Promise<CreateSourceSyncResponse> {
    return await this.#sources.createSourceSync(sourceId, options);
  }

  async listSourceSnapshots(
    sourceId: string,
    params?: PageParams,
  ): Promise<ListSourceSnapshotsResponse> {
    return await this.#sources.listSourceSnapshots(sourceId, params);
  }

  async getSourceSnapshot(id: string): Promise<SourceSnapshot> {
    return await this.#sources.getSourceSnapshot(id);
  }

  /**
   * Reads bounded public files from an immutable SourceSnapshot through the
   * Runner boundary. This is an in-process control-plane operation used for
   * repository-owned presentation metadata; it never reads a forge API or the
   * mutable branch directly.
   */
  async readSourceSnapshotFiles(
    id: string,
    options?: { readonly modulePath?: string },
  ): Promise<readonly { readonly path: string; readonly text: string }[]> {
    if (!this.#sourcesService) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "SourceSnapshot file inspection is not configured",
      );
    }
    const snapshot = await this.#sources.getSourceSnapshot(id);
    return await this.#sourcesService.readCapsuleSourceFiles(snapshot, options);
  }

  async resolveStableSourceTag(
    url: string,
  ): Promise<OpenTofuStableSourceTagResolutionResult> {
    const policy = evaluateSourceUrl(url);
    if (!policy.ok || policy.scheme !== "https") {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "stable source tag resolution requires a public HTTPS Git URL",
      );
    }
    if (!this.#runner?.resolveStableSourceTag) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "stable source tag resolution is not configured",
      );
    }
    try {
      return await this.#runner.resolveStableSourceTag({
        runId: `source_tag_${crypto.randomUUID().replaceAll("-", "")}`,
        url,
      });
    } catch (error) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        error instanceof Error
          ? error.message
          : "stable source tag resolution failed",
      );
    }
  }

  async readSourceSnapshotPresentationFile(
    id: string,
    path: string,
  ): Promise<OpenTofuSourceSnapshotPresentationFile> {
    if (!this.#runner?.readSourceSnapshotPresentationFile) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "SourceSnapshot presentation-file inspection is not configured",
      );
    }
    const snapshot = await this.#sources.getSourceSnapshot(id);
    const source = await this.#sources.getSource(snapshot.sourceId);
    if (source.source.authConnectionId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "presentation-file inspection is limited to credential-free public Sources",
      );
    }
    return await this.#runner.readSourceSnapshotPresentationFile({
      runId: `source_file_${crypto.randomUUID().replaceAll("-", "")}`,
      sourceSnapshot: snapshot,
      path,
    });
  }

  async createSourceCompatibilityCheck(
    sourceId: string,
    request: CreateSourceCompatibilityCheckRequest = {},
  ): Promise<CapsuleCompatibilityReportResponse> {
    return await this.#sources.createSourceCompatibilityCheck(
      sourceId,
      request,
    );
  }

  async getCompatibilityReport(
    reportId: string,
  ): Promise<CapsuleCompatibilityReportResponse> {
    return await this.#sources.getCompatibilityReport(reportId);
  }

  async getSourceSyncRun(id: string): Promise<SourceSyncRun> {
    return await this.#sources.getSourceSyncRun(id);
  }

  // --- Unified Run facade (Core Specification §6.8) -------------------------

  /**
   * Resolves a run id to the unified §6.8 {@link Run} projection, looking across
   * the PlanRun / ApplyRun / SourceSyncRun ledgers by id prefix. A plan that is
   * `succeeded` but still requires approval (destructive resource changes,
   * or its environment requires approval and it has not been approved) projects
   * to `waiting_approval`.
   */
  async getRun(id: string): Promise<Run> {
    return await this.#runQuery.getRun(id);
  }

  async listRuns(
    workspaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly Run[]> {
    return await this.#runQuery.listRuns(workspaceId, options);
  }

  async listRecoverableOpenTofuRuns(options: {
    readonly staleQueuedBeforeMs: number;
    readonly staleRunningBeforeMs: number;
    readonly limit?: number;
  }): Promise<readonly Run[]> {
    return await this.#runQuery.listRecoverableOpenTofuRuns(options);
  }

  async getRunLogs(id: string): Promise<RunLogsResponse> {
    return await this.#runQuery.getRunLogs(id);
  }

  async getRunEvents(id: string): Promise<RunEventsResponse> {
    return await this.#runQuery.getRunEvents(id);
  }

  async getRunCost(id: string): Promise<RunCostInfo> {
    return await this.#runQuery.getRunCost(id);
  }

  async listAutoSyncSources(limit: number): Promise<readonly Source[]> {
    return await this.#sources.listAutoSyncSources(limit);
  }

  async verifySourceHookSecret(
    sourceId: string,
    presentedSecret: string,
  ): Promise<boolean> {
    return await this.#sources.verifySourceHookSecret(
      sourceId,
      presentedSecret,
    );
  }

  async #requireWorkspace(workspaceId: string) {
    const workspace = await this.#store.getWorkspace(workspaceId);
    if (!workspace) {
      throw new OpenTofuControllerError("not_found", "workspace not found");
    }
    return workspace;
  }

  async #seedRunnerProfiles(profiles: readonly RunnerProfile[]): Promise<void> {
    for (const profile of profiles) {
      await this.#store.putRunnerProfile(profile);
    }
  }

  #runSerialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#mutationChains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(
      () => next,
      () => next,
    );
    this.#mutationChains.set(key, chain);
    return previous
      .catch(() => {})
      .then(work)
      .finally(() => {
        release();
        if (this.#mutationChains.get(key) === chain) {
          this.#mutationChains.delete(key);
        }
      });
  }
}

function normalizeCredentialRecipeCatalog(
  recipes: readonly CredentialRecipe[],
): readonly CredentialRecipe[] {
  const byId = new Map<string, CredentialRecipe>();
  for (const recipe of recipes) {
    requireNonEmptyString(recipe.id, "credentialRecipe.id");
    if (byId.has(recipe.id)) {
      throw new Error(`duplicate Credential Recipe id: ${recipe.id}`);
    }
    byId.set(recipe.id, recipe);
  }
  return [...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

/**
 * State generation guard. A PlanRun records the target's `baseStateGeneration`
 * at creation; if the target Capsule's generation has advanced since (a
 * successful apply/destroy ran in between), this plan is stale and must not
 * apply over the newer state. `create` plans (no planned Capsule) are
 * exempt — they have no prior generation to race.
 */
export function assertStateGenerationMatches(
  planRun: PlanRun,
  plannedCapsule: Capsule | undefined,
): void {
  if (!plannedCapsule) return;
  const base = planRun.baseStateGeneration ?? 0;
  const current = plannedCapsule.currentStateGeneration;
  if (current !== base) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `state_generation_mismatch: plan run ${planRun.id} was created against ` +
        `state generation ${base} but Capsule ${plannedCapsule.id} ` +
        `is now at generation ${current}`,
      { reason: "state_generation_mismatch" },
    );
  }
}

export async function checkApplyExpected(
  expected: CreateApplyRunRequest["expected"],
  planRun: PlanRun,
): Promise<void> {
  if (!expected) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "apply requires expected guard from the reviewed PlanRun",
    );
  }
  const reviewed = applyExpectedGuardFromPlanRun(planRun);
  // Structural compare: the request guard must reproduce the reviewed guard
  // exactly. Both sides are projected onto the same fixed guard key set (absent
  // optional keys normalized to `undefined`) before digesting, so this is
  // equivalent to the prior per-field equality over every known guard field —
  // including the directions where one side omits an optional field.
  const [reviewedHash, expectedHash] = await Promise.all([
    stableJsonDigest(projectApplyExpectedGuard(reviewed)),
    stableJsonDigest(projectApplyExpectedGuard(expected)),
  ]);
  if (reviewedHash !== expectedHash) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "expected guard does not match the reviewed PlanRun",
    );
  }
}

// Canonical key order for the ApplyExpectedGuard structural compare. Listing the
// fixed field set (instead of an object's provider envs) keeps the digest comparison
// equivalent to the prior per-field equality: every known guard field is
// compared in both directions, and absent optional fields read as `undefined`.
const APPLY_EXPECTED_GUARD_KEYS = [
  "planRunId",
  "capsuleId",
  "currentStateVersionId",
  "runnerProfileId",
  "sourceDigest",
  "variablesDigest",
  "policyDecisionDigest",
  "planDigest",
  "planArtifactDigest",
  "sourceCommit",
  "providerLockDigest",
  "resolvedProviderBindingsDigest",
] as const satisfies readonly (keyof ApplyExpectedGuard)[];

function projectApplyExpectedGuard(
  guard: ApplyExpectedGuard,
): Record<string, JsonValue | null | undefined> {
  const projection: Record<string, JsonValue | null | undefined> = {};
  for (const key of APPLY_EXPECTED_GUARD_KEYS) {
    projection[key] = guard[key];
  }
  return projection;
}

export function applyExpectedGuardFromPlanRun(
  planRun: PlanRun,
): ApplyExpectedGuard {
  if (!planRun.planDigest) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "PlanRun has no planDigest; apply requires a completed OpenTofu plan",
    );
  }
  if (!planRun.planArtifact) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "PlanRun has no planArtifact; apply requires an immutable plan artifact",
    );
  }
  // TOCTOU pin: the Capsule's current StateVersion at plan time (state
  // cursor). Present (string
  // or null), never undefined, whenever the plan targets an existing Capsule.
  const capsuleId = planRun.capsuleId ?? planRun.capsuleId;
  if (capsuleId && planRun.capsuleCurrentStateVersionId === undefined) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "PlanRun has no capsule current StateVersion guard",
    );
  }
  return {
    planRunId: planRun.id,
    ...(capsuleId ? { capsuleId } : {}),
    ...(capsuleId
      ? { currentStateVersionId: planRun.capsuleCurrentStateVersionId ?? null }
      : {}),
    runnerProfileId: planRun.runnerProfileId,
    sourceDigest: planRun.sourceDigest,
    variablesDigest: planRun.variablesDigest,
    policyDecisionDigest: planRun.policyDecisionDigest,
    planDigest: planRun.planDigest,
    planArtifactDigest: planRun.planArtifact.digest,
    ...(planRun.sourceCommit ? { sourceCommit: planRun.sourceCommit } : {}),
    ...(planRun.providerLockDigest
      ? { providerLockDigest: planRun.providerLockDigest }
      : {}),
    ...(planRun.resolvedProviderBindingsDigest
      ? {
          resolvedProviderBindingsDigest:
            planRun.resolvedProviderBindingsDigest,
        }
      : {}),
  };
}

/**
 * Merges service-side variable defaults with explicit Capsule inputs.
 */
function mergeJsonVariables(
  ...records: readonly Readonly<Record<string, unknown>>[]
): Readonly<Record<string, JsonValue>> {
  const out: Record<string, JsonValue> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (!isJsonValue(value)) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          `variableMapping.${key} must be a JSON value`,
        );
      }
      out[key] = value;
    }
  }
  return out;
}

export function mergeJsonVariableDefaults(
  defaults: Readonly<Record<string, unknown>>,
  explicit: Readonly<Record<string, unknown>>,
): Readonly<Record<string, JsonValue>> {
  return deepMergeRequestedJsonDefaults(
    mergeJsonVariables(defaults),
    mergeJsonVariables(explicit),
  );
}

function deepMergeRequestedJsonDefaults(
  defaults: Readonly<Record<string, JsonValue>>,
  explicit: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(explicit)) {
    const existing = defaults[key];
    out[key] = requestedJsonValue(existing, value);
  }
  return out;
}

function deepMergeJsonRecords(
  defaults: Readonly<Record<string, JsonValue>>,
  explicit: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  const out: Record<string, JsonValue> = { ...defaults };
  for (const [key, value] of Object.entries(explicit)) {
    const existing = out[key];
    out[key] = requestedJsonValue(existing, value);
  }
  return out;
}

function requestedJsonValue(
  existing: JsonValue | undefined,
  value: JsonValue,
): JsonValue {
  if (value === null && existing !== undefined) return existing;
  return isJsonObject(existing) && isJsonObject(value)
    ? deepMergeJsonRecords(existing, value)
    : value;
}

function isJsonObject(
  value: JsonValue | undefined,
): value is Readonly<Record<string, JsonValue>> {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (type !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

/**
 * Builds the OpenTofu module source for an env-driven plan from the registered
 * Source + resolved SourceSnapshot (M2). The bytes are restored from the
 * snapshot archive via the `sourceArchive` dispatch field, so this descriptor is
 * identity/metadata only: a `git` source pinned to the resolved commit. The
 * source_sync archive already contains the SourceSnapshot module subtree at its
 * root, so the runner must not receive the original repo subdirectory as
 * `modulePath` again. SSH / scp-style Source URLs are normalized to their https
 * form so the descriptor satisfies the HTTPS-only git source validation (the
 * real fetch never uses this URL).
 */
export function snapshotModuleSource(
  source: Source,
  snapshot: SourceSnapshot,
  modulePath?: string,
): OpenTofuModuleSource {
  const restoredArchiveModulePath = modulePathWithinSnapshotArchive(
    snapshot,
    modulePath,
  );
  return {
    kind: "git",
    url: normalizeGitUrlToHttps(source.url),
    ...(snapshot.resolvedCommit
      ? { commit: snapshot.resolvedCommit.toLowerCase() }
      : {}),
    ...(restoredArchiveModulePath
      ? { modulePath: restoredArchiveModulePath }
      : {}),
  };
}

function modulePathWithinSnapshotArchive(
  snapshot: SourceSnapshot,
  modulePath: string | undefined,
): string | undefined {
  const requested = normalizeRelativeModulePath(modulePath);
  if (!requested) return undefined;
  const snapshotPath = normalizeRelativeModulePath(snapshot.path);
  if (!snapshotPath) return requested;
  if (requested === snapshotPath) return undefined;
  const prefix = `${snapshotPath}/`;
  if (requested.startsWith(prefix)) {
    return requested.slice(prefix.length) || undefined;
  }
  return requested;
}

function normalizeRelativeModulePath(
  path: string | undefined,
): string | undefined {
  const value = path?.trim();
  if (!value || value === ".") return undefined;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || normalized === ".") return undefined;
  return normalized.replace(/\/+$/g, "");
}

/**
 * Normalizes a Source URL (https / ssh:// / scp-style `git@host:path`) to an
 * https URL for the OpenTofu module-source descriptor. The Source URL policy
 * already rejected forbidden transports and embedded credentials; this only
 * reshapes ssh/scp into https for the validation seam.
 */
function normalizeGitUrlToHttps(url: string): string {
  const value = url.trim();
  if (/^https:\/\//i.test(value)) return value;
  const sshMatch = /^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(value);
  if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2]}`;
  const scpMatch = /^(?:[^@/:]+)@([^:/]+):(.+)$/.exec(value);
  if (scpMatch) return `https://${scpMatch[1]}/${scpMatch[2]}`;
  return value;
}

/**
 * Reads module dispatch fields off the persisted plan-run-inputs sidecar.
 * Defensive copies are not needed because the
 * store hands back its own records and the runner job only reads.
 */
export function moduleDispatchFromInputs(
  inputs:
    | {
        readonly generatedRoot?: DispatchGeneratedRoot;
        readonly operatorModule?: RunModuleDispatch["operatorModule"];
        readonly workspaceOutputAllowlist?: InstallConfig["outputAllowlist"];
        readonly outputAllowlist?: InstallConfig["outputAllowlist"];
        readonly sourceBuild?: InstallConfig["sourceBuild"];
        readonly lifecycleActions?: InstallConfig["lifecycleActions"];
        readonly stateAdoption?: DispatchStateAdoption;
      }
    | undefined,
): RunModuleDispatch {
  if (!inputs) return {};
  return {
    ...(inputs.generatedRoot ? { generatedRoot: inputs.generatedRoot } : {}),
    ...(inputs.operatorModule ? { operatorModule: inputs.operatorModule } : {}),
    ...(inputs.workspaceOutputAllowlist
      ? { workspaceOutputAllowlist: inputs.workspaceOutputAllowlist }
      : {}),
    ...(inputs.outputAllowlist
      ? { outputAllowlist: inputs.outputAllowlist }
      : {}),
    ...(inputs.sourceBuild ? { sourceBuild: inputs.sourceBuild } : {}),
    ...(inputs.lifecycleActions
      ? { lifecycleActions: inputs.lifecycleActions }
      : {}),
    ...(inputs.stateAdoption ? { stateAdoption: inputs.stateAdoption } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function providerInstallationAuditEvents(
  ownerId: string,
  phase: "apply" | "destroy",
  at: number,
  evidence: readonly ProviderInstallationEvidence[] | undefined,
  policy: { readonly requireMirror: boolean } | undefined,
): readonly DeployControlAuditEvent[] {
  if (!evidence && policy?.requireMirror !== true) return [];
  const rows = evidence ?? [];
  const mirroredCount = rows.filter((entry) => entry.mirrored).length;
  const attestedCount = rows.filter((entry) => entry.attested === true).length;
  return [
    auditEvent(ownerId, `${phase}.provider_installation_evaluated`, at, {
      requireMirror: policy?.requireMirror === true,
      evidenceCount: rows.length,
      mirroredCount,
      attestedCount,
      providers: rows.map((entry) => ({
        provider: entry.provider,
        mirrored: entry.mirrored,
        installationMethod: entry.installationMethod,
        ...(entry.mirrorPath ? { mirrorPath: entry.mirrorPath } : {}),
        ...(entry.attested === true ? { attested: true } : {}),
        ...(entry.attestationMethod
          ? { attestationMethod: entry.attestationMethod }
          : {}),
        ...(entry.cliConfigDigest
          ? { cliConfigDigest: entry.cliConfigDigest }
          : {}),
        ...(entry.installedPath ? { installedPath: entry.installedPath } : {}),
        ...(entry.installedDigest
          ? { installedDigest: entry.installedDigest }
          : {}),
      })),
    }),
  ];
}

export function releaseActivationOutputs(
  outputs: OpenTofuOutputEnvelope | undefined,
): Readonly<Record<string, JsonValue>> {
  if (!outputs) return {};
  const safeOutputs: Record<string, JsonValue> = {};
  for (const [name, output] of Object.entries(outputs)) {
    if (output.sensitive === true) continue;
    if (isReleaseActivationOutputSafe(name, output.value)) {
      safeOutputs[name] = output.value;
    }
  }
  return safeOutputs;
}

export function jsonRecordFromPublicOutputs(
  outputs: Readonly<Record<string, unknown>>,
): Readonly<Record<string, JsonValue>> {
  const out: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(outputs)) {
    if (isJsonValue(value) && isReleaseActivationOutputSafe(name, value)) {
      out[name] = value;
    }
  }
  return out;
}

export function releaseActivationCommands(
  actions: readonly InstallConfigLifecycleAction[] | undefined,
  phase: ReleaseActivationCommand["phase"],
): readonly ReleaseActivationCommand[] {
  return (actions ?? [])
    .filter((action) => action.kind === "command" && action.phase === phase)
    .slice(0, 20)
    .map((action) => ({
      id: action.id,
      phase: action.phase,
      command: [...action.command],
      executor: action.executor,
      ...(action.workingDirectory
        ? { workingDirectory: action.workingDirectory }
        : {}),
      ...(action.env ? { env: { ...action.env } } : {}),
      ...(action.timeoutSeconds
        ? { timeoutSeconds: action.timeoutSeconds }
        : {}),
      ...(action.useProviderCredentials === true
        ? { useProviderCredentials: true }
        : {}),
    }));
}

function isReleaseActivationOutputSafe(
  name: string,
  value: JsonValue,
): boolean {
  if (isSecretKey(name) || containsSecretLikeString(name)) return false;
  return !releaseActivationValueLooksSecret(value);
}

function releaseActivationValueLooksSecret(value: JsonValue): boolean {
  const stack: JsonValue[] = [value];
  let inspected = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    inspected += 1;
    if (inspected > 1_000) return true;
    if (typeof current === "string") {
      if (containsSecretLikeString(current)) return true;
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    for (const [key, nested] of Object.entries(current)) {
      if (isSecretKey(key) || containsSecretLikeString(key)) {
        return true;
      }
      stack.push(nested);
    }
  }
  return false;
}

export function changedOutputNamesBetween(
  previous: Output | undefined,
  next: Output,
): readonly string[] {
  const before = previous?.workspaceOutputs ?? {};
  const after = next.workspaceOutputs;
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter(
      (name) => canonicalJson(before[name]) !== canonicalJson(after[name]),
    )
    .sort();
}

export function directChangedDependencyOutputs(input: {
  readonly edges: readonly Dependency[];
  readonly producerCapsuleId: string;
  readonly consumerCapsuleId: string;
  readonly changedOutputNames: readonly string[];
}): readonly string[] {
  const changed = new Set(input.changedOutputNames);
  const direct = new Set<string>();
  for (const edge of input.edges) {
    if (
      edge.producerCapsuleId !== input.producerCapsuleId ||
      edge.consumerCapsuleId !== input.consumerCapsuleId
    ) {
      continue;
    }
    for (const mapping of Object.values(edge.outputs)) {
      if (changed.has(mapping.from)) direct.add(mapping.from);
    }
  }
  return [...direct].sort();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function defaultProviderMirrorRequiredForProfile(
  profile: RunnerProfile | undefined,
): boolean {
  return profile !== undefined && !profile.allowedProviders.includes("*");
}

export function auditEvent(
  ownerId: string,
  type: string,
  at: number,
  data?: Readonly<Record<string, JsonValue>>,
  actor?: string,
): DeployControlAuditEvent {
  return {
    id: `${ownerId}:${type}:${at}`,
    type,
    at,
    ...(actor ? { actor } : {}),
    ...(data ? { data } : {}),
  };
}

export function redactRunApproval(
  approval: RunApproval | undefined,
): RunApproval | undefined {
  if (!approval) return undefined;
  return {
    ...approval,
    ...(approval.reason ? { reason: redactString(approval.reason) } : {}),
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Whether a run status is settled — the run engine will not dispatch / re-run it.
 * The unified RunStatus has no `blocked`; `waiting_approval` is settled for this
 * purpose (the plan execution finished and is parked awaiting a human approval,
 * so a DLQ retry must NOT re-fail it).
 */
export function isTerminalStatus(status: RunStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "waiting_approval" ||
    status === "expired" ||
    status === "cancelled"
  );
}
