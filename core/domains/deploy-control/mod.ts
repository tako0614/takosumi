/**
 * OpenTofu-native deployment-control-plane domain.
 *
 * Takosumi owns the API-facing ledger and policy gate. RunnerProfiles provide
 * provider allowlists, state-backend ownership, and runner substrate choice.
 * OpenTofu execution is delegated to an injected runner, normally a
 * Cloudflare Container runner in the reference distribution.
 *
 * This module hosts the controller and run-execution ceremony. Four cohesive
 * concerns live in sibling files and are composed in here:
 *   - `runner_profiles.ts` — default RunnerProfile seed data
 *   - `policy.ts`          — RunnerProfile policy engine
 *   - `validation.ts`      — request / source validation and identity guards
 *   - `projection.ts`      — output / diagnostic projection and redaction
 */

import type { JsonValue } from "takosumi-contract";
import type {
  ApplyExpectedGuard,
  ApplyRun,
  ApplyRunResponse,
  Connection,
  ConnectionResponse,
  CreateApplyRunRequest,
  CreateConnectionRequest,
  CreatePlanRunRequest,
  DeployControlAuditEvent,
  Deployment,
  DeploymentOutput,
  DispatchDepState,
  DispatchGeneratedRoot,
  DispatchSourceArchive,
  DispatchStateScope,
  GetInstallationResponse,
  InstallConfig,
  OpenTofuModuleSource,
  PlanRunInstallationContext,
  StateSnapshot,
  ListConnectionsResponse,
  ListDeploymentsResponse,
  ListDeploymentOutputsResponse,
  ListRunnerProfilesResponse,
  OpenTofuOutputEnvelope,
  OpenTofuPlanArtifact,
  PlanResourceChange,
  PlanRun,
  PlanRunResponse,
  PublicPlanRun,
  PlanRunSummary,
  PlanRunTemplateBinding,
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
  ListProvidersResponse,
  ProviderListingResponse,
} from "takosumi-contract/providers";
import { computeProviderListings } from "./provider_listing.ts";
import type { ConnectionVault } from "../../adapters/vault/mod.ts";
import type { OutputAllowlistEntry } from "takosumi-contract/install-configs";
import type {
  BillingAccount,
  BillingMode,
  BillingPlan,
  BillingSettings,
  CreditBalance,
  CreditReservation,
  InvoiceUsageReconciliation,
  SpaceSubscription,
  UsageEvent,
} from "takosumi-contract/billing";
import type { SourcesService } from "../sources/mod.ts";
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
  Source,
  SourceResponse,
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";
import type { PageParams } from "takosumi-contract/pagination";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import { log } from "../../shared/log.ts";
import {
  InMemoryOpenTofuDeploymentStore,
  InstallationPatchGuardConflict,
  InstallationStateGenerationGuardConflict,
  type OpenTofuDeploymentStore,
  type PlanRunInputs,
} from "./store.ts";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";
import {
  type ActivityRecorder,
  NOOP_ACTIVITY_RECORDER,
  type RecordActivityInput,
} from "../activity/mod.ts";
import { createDefaultRunnerProfiles } from "./runner_profiles.ts";
import { evaluatePolicy } from "./policy.ts";
import {
  normalizeProviders,
  normalizeVariables,
  validateOperation,
  validatePlannedInstallationCurrent,
  validateSource,
  validateSourceAllowedByProfile,
} from "./validation.ts";
import {
  errorDiagnostic,
  errorMessage,
  normalizeDeploymentOutputs,
  normalizePlanArtifact,
  normalizePlanSummary,
  projectOutputAllowlistPublicOutputs,
  projectOutputAllowlistSpaceOutputs,
  projectTemplatePublicOutputs,
  redactRunDiagnostics,
  stateLockEvidence,
} from "./projection.ts";
import { evaluateTemplatePlanPolicy } from "./template_policy.ts";
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
import {
  defaultTemplateRegistry,
  type TemplateRegistry,
} from "../templates/mod.ts";
import {
  type RootInstallationProviderEnvBinding,
  generateGenericCapsuleRoot,
} from "takosumi-rootgen";
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
import type { Output as OutputSnapshot } from "takosumi-contract/outputs";
import type { SensitiveOutputResolver } from "../output-shares/mod.ts";
import type {
  Dependency,
  DependencySnapshot,
  SealedDependencyValues,
} from "takosumi-contract/dependencies";
import {
  compactErrorCode,
  projectApplyRun,
  projectPlanRun,
} from "./projection_run.ts";
import {
  DEFAULT_INSTALLATION_LEASE_TTL_MS,
  type InstallationCoordination,
  type LeaseHandle,
  withInstallationLease,
  withPlanLease,
} from "./installation_lease.ts";
import {
  ConnectionsService,
  resolvedProviderEnvBindingsDigest,
  type ResolvedInstallationProviderEnvBinding,
} from "../connections/mod.ts";
import { providerEnvRule } from "takosumi-contract/provider-env-rules";
import { SourceManagement } from "./source_management.ts";
import { SourceLifecycleService } from "./source_lifecycle.ts";
import { ConnectionManagement } from "./connection_management.ts";
import { DeploymentQuery, requireInstallation } from "./deployment_query.ts";
import { RunQueryService } from "./run_query.ts";
import {
  BillingService,
  DISABLED_BILLING_SETTINGS,
} from "./billing_service.ts";
import type {
  BillingEnforcement,
  QuotaPolicy,
} from "takosumi-contract/billing";
import { redactString } from "takosumi-contract/redaction";
import type { ObservabilitySink } from "../observability/mod.ts";
import { UsageReportingService } from "./usage_service.ts";
// The usage input-type vocabulary is owned by the usage service; re-exported here
// so the historical `./domains/deploy-control/mod.ts` import path stays stable.
export type {
  RecordMeteredUsageInput,
  ReconcileInvoiceUsageInput,
} from "./usage_service.ts";
import type {
  RecordMeteredUsageInput,
  ReconcileInvoiceUsageInput,
} from "./usage_service.ts";
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
  type ResolvedRunEnvironment,
} from "./run_env_resolver.ts";
import {
  DependencyResolutionService,
  type ResolvedDependencies,
} from "./dependency_resolution.ts";
import { RunVerificationService } from "./run_verification.ts";
import { validateProjectedServiceExportsFromOutputSnapshot } from "../output-projection/mod.ts";
import {
  type InstallTypePlanContext,
  PlanResolutionService,
  providerEnvBindingsFromResolved,
  type ResolvedTemplatePlan,
} from "./plan_resolution.ts";
import { RunEngine } from "./run-engine/run_engine.ts";

// Re-export the shared error primitive and the four decomposed concerns so the
// domain's public entry point stays `./mod.ts` for importers and tests.
export {
  OpenTofuControllerError,
  type OpenTofuControllerErrorCode,
} from "./errors.ts";
export {
  CREDENTIAL_FREE_UTILITY_PROVIDER_ADDRESSES,
  createDefaultRunnerProfiles,
  parseEnabledRunnerProfileIds,
  resolveEnabledRunnerProfiles,
} from "./runner_profiles.ts";
export { providerMatches } from "./policy.ts";
export { deploymentOutputsFromOpenTofu } from "./projection.ts";

export function publicInstallation(installation: Capsule): PublicCapsule {
  const { installType: _installType, ...publicRecord } = installation;
  return publicRecord;
}

export function publicPlanRun(planRun: PlanRun): PublicPlanRun {
  const { templateBinding: _templateBinding, ...publicRecord } = planRun;
  return publicRecord;
}

/**
 * Minted provider credential env/file material threaded onto the runner dispatch
 * payload only. The controller fills this from the Connection Vault in the queue
 * consumer just before dispatch; it is NEVER persisted to the store and NEVER
 * logged. For provider-using runs, an absent Vault is fail-closed before runner
 * dispatch so the runner never falls back to ambient provider credentials.
 */
export type RunCredentials =
  | Readonly<Record<string, string>>
  | {
      readonly env: Readonly<Record<string, string>>;
      readonly files?: readonly {
        readonly path: string;
        readonly mode: number;
        readonly content: string;
        readonly envName?: string;
      }[];
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
 * Generated-root dispatch fields threaded onto a run job. `generatedRoot` is
 * the canonical path for both built-in first-party modules and generic
 * Capsules; bundled modules are carried as `generatedRoot.moduleFiles`.
 * Takosumi does not dispatch app build or artifact handling; app release inputs
 * are ordinary OpenTofu variables owned by the module/app release flow.
 */
export interface RunTemplateDispatch {
  readonly generatedRoot?: DispatchGeneratedRoot;
  readonly outputAllowlist?: InstallConfig["outputAllowlist"];
}

/**
 * Environment-context dispatch fields threaded onto a run job (M2). When the run
 * carries installation context, the queue consumer attaches `stateScope`
 * (encrypted state at the spec §20 R2_STATE keys) and `sourceArchive` (the
 * resolved SourceSnapshot archive). These map 1:1 onto the `request.stateScope`
 * / `request.sourceArchive` fields the OpenTofu runner DO consumes. Absent for
 * runs without installation context (the DO falls back to its legacy paths).
 */
export interface RunInstallationDispatch {
  readonly stateScope?: DispatchStateScope;
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
  extends RunTemplateDispatch, RunInstallationDispatch {
  readonly planRun: PlanRun;
  readonly runnerProfile: RunnerProfile;
  readonly variables: Readonly<Record<string, JsonValue>>;
  readonly providerInstallationPolicy?: {
    readonly requireMirror: boolean;
  };
  readonly credentials?: RunCredentials;
}

export interface OpenTofuApplyJob
  extends RunTemplateDispatch, RunInstallationDispatch {
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
  extends RunTemplateDispatch, RunInstallationDispatch {
  readonly applyRun: ApplyRun;
  readonly planRun: PlanRun;
  readonly planArtifact: OpenTofuPlanArtifact;
  readonly installation: Capsule;
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
   * Resource-change projection from `tofu show -json tfplan` (Phase 1C). Used by
   * the template plan-JSON policy to enforce allowedResourceTypes and to flag
   * destructive (delete/replace) changes. Absent for non-template runs.
   */
  readonly planResourceChanges?: readonly PlanResourceChange[];
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
  readonly outputs?: OpenTofuOutputEnvelope | readonly DeploymentOutput[];
  readonly stateLock?: RunnerStateLockEvidence;
  readonly diagnostics?: readonly RunDiagnostic[];
  readonly providerInstallation?: readonly ProviderInstallationEvidence[];
  /**
   * Plaintext digest of the persisted OpenTofu state, echoed by the runner DO
   * after it sealed + wrote the state object to R2_STATE (M2 env-driven runs).
   * Recorded on the StateSnapshot so the ledger digest matches the R2 object.
   * Absent for runs without environment context (no R2_STATE persist).
   */
  readonly stateDigest?: string;
  /**
   * R2_ARTIFACTS key of the encrypted raw `tofu output -json` envelope, echoed
   * by the runner DO after it sealed + wrote the object (M7 env-driven runs).
   * Recorded as {@link OutputSnapshot.rawOutputArtifactKey}. Absent for runs
   * without environment context (the DO does not persist the raw envelope).
   */
  readonly rawOutputsKey?: string;
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
}

export interface ReleaseCommandRunJob {
  readonly runId: string;
  readonly commands: readonly ReleaseActivationCommand[];
  readonly sourceSnapshot: SourceSnapshot;
  readonly nonSensitiveOutputs: Readonly<Record<string, JsonValue>>;
  readonly credentials?: RunCredentials;
  readonly applyRunId: string;
  readonly installationId: string;
  readonly deploymentId: string;
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
  readonly installation: Capsule;
  readonly deployment: Deployment;
  readonly outputSnapshot: OutputSnapshot;
  /**
   * Non-sensitive apply outputs available to an operator/Cloud release
   * activator. This is broader than Deployment.outputsPublic because generic
   * Capsules can keep public projection empty while still producing resource ids
   * that a Cloud-only artifact publisher needs. Sensitive OpenTofu outputs and
   * secret-shaped names/values are filtered before this seam.
   */
  readonly nonSensitiveOutputs: Readonly<Record<string, JsonValue>>;
  /**
   * Dispatch-only provider credentials for runner-executed release commands.
   * Minted immediately before activation from the same reviewed ProviderBinding
   * set as apply/destroy; never persisted or sent to operator webhooks.
   */
  readonly credentials?: RunCredentials;
  /**
   * App-declared release commands extracted from the neutral
   * `takosumi_release.post_apply` output. Takosumi core treats them as opaque
   * argv arrays; every activation detail stays app/operator code.
   */
  readonly commands: readonly ReleaseActivationCommand[];
  readonly sourceSnapshot?: SourceSnapshot;
}

export interface ReleaseActivationResult {
  readonly status: ReleaseActivationStatus;
  /** Operator-defined activation kind, for example `operator.release`. */
  readonly kind?: string;
  readonly message?: string;
  readonly launchUrl?: string;
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
    readonly objectKey: string;
    readonly digest: string;
  };
}

export interface OpenTofuServiceDataRestoreJob {
  readonly runId: string;
  readonly stateScope: DispatchStateScope;
  readonly sourceState: {
    readonly objectKey: string;
    readonly digest: string;
  };
  readonly serviceData: ServiceDataBackupPointer;
}

export interface OpenTofuRestoreResult {
  readonly state: {
    readonly generation: number;
    readonly objectKey: string;
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
   * and PUTs the archive bytes to the DO artifact route under
   * {@link OpenTofuSourceSyncJob.archiveObjectKey}; it returns only the resolved
   * commit and archive metadata. Optional: an external/legacy runner without it
   * leaves source_sync runs queued.
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
}

export interface OpenTofuCapsuleSourceFile {
  readonly path: string;
  readonly text: string;
}

export interface OpenTofuCapsuleSourceFilesJob {
  readonly runId: string;
  readonly sourceSnapshot: SourceSnapshot;
  readonly modulePath?: string;
}

/**
 * Source-sync dispatch job. `credentials` carries the source-phase mint result
 * (git env + files); absent for a public repo. Never logged; threaded onto the
 * runner dispatch only.
 */
export interface OpenTofuSourceSyncJob {
  readonly runId: string;
  readonly spaceId: string;
  readonly sourceId: string;
  readonly source: {
    readonly url: string;
    readonly ref: string;
    readonly path: string;
  };
  readonly archiveObjectKey: string;
  /**
   * Previous immutable SourceSnapshot for the same Source/ref/path. The runner
   * may resolve the ref with git ls-remote and, when it still points at this
   * commit, return this archive metadata without cloning/archiving again.
   */
  readonly reuseSnapshot?: {
    readonly id: string;
    readonly resolvedCommit: string;
    readonly archiveObjectKey: string;
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
  /** Existing archive object key when an unchanged ref reused a SourceSnapshot. */
  readonly archiveObjectKey?: string;
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
  readonly spaceId: string;
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
  Math.min(DEFAULT_INSTALLATION_LEASE_TTL_MS, RUN_HEARTBEAT_STALE_MS) / 3,
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

export function providersRequiringProviderEnvBindings(
  providers: readonly string[],
  runnerProfile?: Pick<RunnerProfile, "requireCredentialRefs">,
): readonly string[] {
  if (runnerProfile && runnerProfile.requireCredentialRefs !== true) {
    return [];
  }
  return normalizeProviders(
    providers.filter((provider) => providerEnvRule(provider) !== undefined),
  );
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

export interface OpenTofuDeploymentControllerDependencies {
  readonly store?: OpenTofuDeploymentStore;
  readonly runner?: OpenTofuRunner;
  readonly providerEnvRunner?: OpenTofuRunner;
  /** @deprecated Use providerEnvRunner. */
  readonly ownKeyProviderRunner?: OpenTofuRunner;
  /**
   * Cloud-only compatibility seam: permits Space-scoped ProviderEnv rows to be
   * backed by operator-scoped Connections. Defaults off for OSS/self-host.
   */
  readonly allowOperatorBackedProviderEnvs?: boolean;
  readonly runnerProfiles?: readonly RunnerProfile[];
  readonly defaultRunnerProfileId?: string;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => number;
  /**
   * Credential Vault broker. When present, the controller exposes the
   * Connection lifecycle (`createConnection` / `listConnections` /
   * `testConnection` / `deleteConnection`). When
   * absent, those methods throw `not_implemented`. The Vault is intentionally
   * Wired into plan/apply dispatch from Phase 1B onward: the queue consumer
   * mints a {@link CredentialBundle} just before the container dispatch and
   * attaches it to the dispatch payload only (never stored, never logged).
   */
  readonly vault?: ConnectionVault;
  /**
   * Source domain service (Core Specification §6). When present, the controller
   * exposes the Source lifecycle (`createSource` / `listSources` / `getSource` /
   * `patchSource` / `createSourceSync` / `listSourceSnapshots`) and the
   * `source_sync` consumer path. When absent, those methods throw
   * `not_implemented`.
   */
  readonly sourcesService?: SourcesService;
  /**
   * Out-of-process run dispatch. Defaults to an inline dispatcher that runs the
   * consumer immediately (preserving synchronous create-executes-run for
   * tests / local / node substrates). The Workers adapter injects a producer
   * that enqueues onto `RUN_QUEUE`.
   */
  readonly enqueueRun?: EnqueueRun;
  /**
   * Built-in first-party module registry. Defaults to the bundled registry.
   * Resolves template-backed plan runs, validates inputs, and drives rootgen.
   */
  readonly templateRegistry?: TemplateRegistry;
  /**
   * Capsule lease seam (core-spec.md §22 / §23). When present, the apply
   * consumer acquires the `installation:{installationId}:{environment}` lease
   * before executing a write run and releases it in `finally`, so only ONE
   * write run per (Capsule, environment) runs at a time. A busy lease
   * throws {@link InstallationLeaseBusyError} so the queue redelivers. When
   * absent, the controller falls back to its in-process serialization on the
   * installation key (single-isolate safe; cross-isolate needs the DO-backed
   * seam). `source_sync` never takes the lease.
   */
  readonly installationCoordination?: InstallationCoordination;
  /**
   * Renewal cadence (ms) for a long-running apply/destroy: how often the
   * controller re-stamps the run heartbeat + renews the held lease while a
   * single blocking runner fetch is in flight. Defaults to
   * {@link RUN_RENEWAL_INTERVAL_MS}. Tests inject a small value to drive the
   * renewal tick deterministically; values <= 0 disable the renewal timer.
   */
  readonly runRenewalIntervalMs?: number;
  /**
   * Space-scoped Activity audit trail (spec §27 audit_events / §34 Activity).
   * The controller emits run-lifecycle events (plan created, approved, applied,
   * destroyed) and stale propagation through it. Fire-and-forget: a failed audit
   * write never fails the run path. Defaults to a no-op recorder.
   */
  readonly activity?: ActivityRecorder;
  /**
   * Host-injected sensitive output resolver. Required only when a cross-Space
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
   * Operator/Cloud-only post-apply seam. OSS core records OpenTofu apply as the
   * Deployment of infrastructure/state. A host may additionally publish an
   * application artifact and report that release activation here. The hook
   * receives no credential material and no sensitive outputs.
   */
  readonly releaseActivator?: ReleaseActivator;
  readonly observability?: Pick<ObservabilitySink, "recordMetric">;
  readonly metricTags?: Record<string, string>;
  /**
   * Operator/self-host billing default (§28). Space.billingSettings overrides
   * this. Omitted means self-host style `disabled`.
   */
  readonly defaultBillingSettings?: BillingSettings;
  /**
   * Seam B enforcement port. Omitted ⇒ OSS showback no-op (never blocks /
   * never charges). Cloud injects a Stripe-backed implementation.
   */
  readonly billingEnforcement?: BillingEnforcement;
  /** Seam B plan-quota port. Omitted ⇒ OSS no-op (no plan limits). */
  readonly quotaPolicy?: QuotaPolicy;
}

export interface DeployControlActorContext {
  readonly actor?: string;
}

export interface GenericRootPlanContext {
  readonly providerEnvBindings: readonly RootInstallationProviderEnvBinding[];
  readonly outputAllowlist: InstallConfig["outputAllowlist"];
  readonly moduleFiles?: readonly OpenTofuCapsuleSourceFile[];
}

export interface GenericRootDispatchContext {
  readonly generatedRoot: DispatchGeneratedRoot;
  readonly outputAllowlist: InstallConfig["outputAllowlist"];
}

/**
 * Internal plan-creation context for the Capsule-driven flow. Carried only
 * by {@link OpenTofuDeploymentController.createInstallationPlan} /
 * `createInstallationDestroyPlan`; the raw `/internal/v1/plan-runs` create path leaves
 * it empty.
 */
export interface PlanRunInternalContext {
  readonly installationContext?: PlanRunInstallationContext;
  readonly sourceSnapshotId?: string;
  readonly compatibilityReportId?: string;
  /** The Capsule's current state generation (its latest StateSnapshot, or 0). */
  readonly baseStateGeneration?: number;
  /** Install-type wiring for an installation-driven template plan (§13). */
  readonly installTypePlan?: InstallTypePlanContext;
  /** Generated-root dispatch for a non-template OpenTofu Capsule (§7). */
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
   * rejected by `createApplyRun`. Set only by `createInstallationDriftCheck`.
   */
  readonly driftCheck?: true;
  /**
   * Dependency pins resolved by the Capsule planning path before the PlanRun
   * row exists. `createPlanRun` persists them immediately after creating the run
   * row and before queue dispatch, so runner dispatch can restore remote_state
   * from the same DependencySnapshot apply will verify.
   */
  readonly resolvedDependencies?: ResolvedDependencies;
}

// `ResolvedDependencies` (the resolved consumer Dependencies for an
// installation-driven plan) + `ShareCoverage` now live with the resolution logic
// in {@link DependencyResolutionService}; `ResolvedDependencies` is imported above
// because the controller's plan-creation / snapshot-pin seam still threads it.

/**
 * Request to plan / destroy-plan an Capsule (spec §23). Resolves the
 * Capsule -> InstallConfig -> Source, picks the latest SourceSnapshot,
 * and creates a plan run carrying installation context + the resolved
 * snapshot.
 */
export interface CreateInstallationPlanRequest {
  readonly installationId: string;
}

/**
 * Internal options for an installation-driven plan created as a RunGroup member
 * (spec §19 / §24). The RunGroupsService passes the group id so the plan (and
 * its eventual apply) projects `runGroupId` onto the §19 Run. Not part of the
 * public create request.
 */
export interface CreateInstallationPlanInternal {
  readonly runGroupId?: string;
  /**
   * Operator-selected runner profile for this plan. Public upload deploy uses
   * this to opt into an enabled generic OpenTofu runner profile without making
   * the Capsule source carry Takosumi-specific metadata.
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
   * Capsule against the source snapshot a prior Deployment was built from.
   * The snapshot must belong to the Capsule's Source.
   */
  readonly sourceSnapshotId?: string;
  /**
   * Internal upload-deploy fast path: defer Capsule compatibility inspection to
   * the queued plan consumer. Not exposed on public plan routes.
   */
  readonly deferCompatibilityReport?: true;
  /**
   * Marks the resulting plan as a §19 `drift_check` (Phase 8). Set only by
   * {@link OpenTofuDeploymentController.createInstallationDriftCheck}; threaded
   * onto the created PlanRun so it projects `type: "drift_check"`, never parks
   * `waiting_approval`, and is rejected by `createApplyRun`.
   */
  readonly driftCheck?: true;
}

/**
 * The §25 layered plan-JSON policy verdict produced by
 * {@link OpenTofuDeploymentController}'s `#evaluatePlanPolicy`. Each field is
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
  templatePolicy?: ReturnType<typeof evaluateTemplatePlanPolicy>;
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

export class OpenTofuDeploymentController {
  readonly #store: OpenTofuDeploymentStore;
  readonly #runner?: OpenTofuRunner;
  readonly #providerEnvRunner?: OpenTofuRunner;
  readonly #vault?: ConnectionVault;
  readonly #sourcesService?: SourcesService;
  readonly #defaultRunnerProfileId: string;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #enqueueRun: EnqueueRun;
  readonly #templateRegistry: TemplateRegistry;
  readonly #installationCoordination?: InstallationCoordination;
  readonly #runRenewalIntervalMs: number;
  readonly #activity: ActivityRecorder;
  readonly #sensitiveOutputResolver?: SensitiveOutputResolver;
  readonly #dependencyValueSealer?: DependencyValueSealer;
  readonly #releaseActivator?: ReleaseActivator;
  readonly #observability?: Pick<ObservabilitySink, "recordMetric">;
  readonly #metricTags: Record<string, string>;
  readonly #defaultBillingSettings: BillingSettings;
  readonly #allowOperatorBackedProviderEnvs: boolean;
  readonly #seededProfiles: Promise<void>;
  readonly #mutationChains = new Map<string, Promise<void>>();
  readonly #sources: SourceManagement;
  readonly #sourceLifecycle: SourceLifecycleService;
  readonly #connections: ConnectionManagement;
  readonly #deployments: DeploymentQuery;
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

  constructor(dependencies: OpenTofuDeploymentControllerDependencies = {}) {
    this.#store = dependencies.store ?? new InMemoryOpenTofuDeploymentStore();
    this.#runner = dependencies.runner;
    this.#providerEnvRunner =
      dependencies.providerEnvRunner ?? dependencies.ownKeyProviderRunner;
    this.#vault = dependencies.vault;
    this.#sourcesService = dependencies.sourcesService;
    this.#sources = new SourceManagement(dependencies.sourcesService);
    this.#connections = new ConnectionManagement(this.#store, this.#vault);
    this.#deployments = new DeploymentQuery(this.#store, publicInstallation);
    this.#runQuery = new RunQueryService(this.#store);
    this.#installationCoordination = dependencies.installationCoordination;
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
    this.#allowOperatorBackedProviderEnvs =
      dependencies.allowOperatorBackedProviderEnvs === true;
    this.#defaultRunnerProfileId =
      dependencies.defaultRunnerProfileId ?? "cloudflare-default";
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
    });
    this.#billing = new BillingService({
      store: this.#store,
      newId: this.#newId,
      now: this.#now,
      defaultBillingSettings: this.#defaultBillingSettings,
      requireSpace: (spaceId) => this.#requireSpace(spaceId),
      ...(dependencies.billingEnforcement
        ? { enforcement: dependencies.billingEnforcement }
        : {}),
      ...(dependencies.quotaPolicy ? { quota: dependencies.quotaPolicy } : {}),
    });
    this.#usage = new UsageReportingService({
      store: this.#store,
      newId: this.#newId,
      now: this.#now,
      requireSpace: (spaceId) => this.#requireSpace(spaceId),
      billing: this.#billing,
    });
    this.#drift = new DriftService({
      createPlanRun: (installationId, destroy, context, internal) =>
        this.#runEngine.createInstallationPlanRun(
          installationId,
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
      resolveRunInstallationProviderEnvBindings: (planRun) =>
        this.#runEngine.resolveRunInstallationProviderEnvBindings(planRun),
      policyForPlanRun: (planRun) => this.#runEngine.policyForPlanRun(planRun),
    });
    this.#runEnv = new RunEnvResolver({
      credentials: this.#credentials,
      resolveRunInstallationProviderEnvBindings: (planRun) =>
        this.#runEngine.resolveRunInstallationProviderEnvBindings(planRun),
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
    this.#templateRegistry =
      dependencies.templateRegistry ?? defaultTemplateRegistry;
    this.#planResolution = new PlanResolutionService({
      templateRegistry: this.#templateRegistry,
      now: this.#now,
      resolveInstallationProviderEnvBindingsForRun: (
        installation,
        requiredProviders,
      ) =>
        this.#runEngine.resolveInstallationProviderEnvBindingsForRun(
          installation,
          requiredProviders,
        ),
    });
    this.#seededProfiles = this.#seedRunnerProfiles(
      dependencies.runnerProfiles ?? createDefaultRunnerProfiles(this.#now()),
    );
    this.#runEngine = new RunEngine({
      store: this.#store,
      runner: this.#runner,
      providerEnvRunner: this.#providerEnvRunner,
      sourcesService: this.#sourcesService,
      defaultRunnerProfileId: this.#defaultRunnerProfileId,
      newId: this.#newId,
      now: this.#now,
      enqueueRun: this.#enqueueRun,
      templateRegistry: this.#templateRegistry,
      installationCoordination: this.#installationCoordination,
      runRenewalIntervalMs: this.#runRenewalIntervalMs,
      activity: this.#activity,
      dependencyValueSealer: this.#dependencyValueSealer,
      releaseActivator: this.#releaseActivator,
      observability: this.#observability,
      metricTags: this.#metricTags,
      allowOperatorBackedProviderEnvs: this.#allowOperatorBackedProviderEnvs,
      seededProfiles: this.#seededProfiles,
      runQuery: this.#runQuery,
      billing: this.#billing,
      drift: this.#drift,
      runEnv: this.#runEnv,
      dependencies: this.#dependencies,
      verification: this.#verification,
      planResolution: this.#planResolution,
      sourceLifecycle: this.#sourceLifecycle,
      deployments: this.#deployments,
      runSerialized: <T>(key: string, work: () => Promise<T>): Promise<T> =>
        this.#runSerialized(key, work),
    });
  }

  usesExternalRunQueue(): boolean {
    return this.#usesExternalRunQueue;
  }

  async listRunnerProfiles(): Promise<ListRunnerProfilesResponse> {
    await this.#seededProfiles;
    return { runnerProfiles: await this.#store.listRunnerProfiles() };
  }

  listProviderCatalogEntries(): Promise<ListProvidersResponse> {
    return Promise.resolve({ providers: computeProviderListings() });
  }

  getProviderCatalogEntry(
    providerId: string,
  ): Promise<ProviderListingResponse> {
    requireNonEmptyString(providerId, "providerId");
    const provider = computeProviderListings().find(
      (entry) => entry.id === providerId,
    );
    if (!provider) {
      throw new OpenTofuControllerError(
        "not_found",
        `provider ${providerId} not found`,
      );
    }
    return Promise.resolve({ provider });
  }

  async getSpaceBilling(spaceId: string): Promise<{
    readonly billing: {
      readonly settings: BillingSettings;
      readonly balance?: CreditBalance;
      readonly account?: BillingAccount;
      readonly subscription?: SpaceSubscription;
      readonly plan?: BillingPlan;
    };
  }> {
    return await this.#usage.getSpaceBilling(spaceId);
  }

  async listSpaceUsage(
    spaceId: string,
    params?: PageParams,
  ): Promise<{
    readonly usageEvents: readonly UsageEvent[];
    readonly nextCursor?: string;
  }> {
    return await this.#usage.listSpaceUsage(spaceId, params);
  }

  async recordMeteredUsage(
    spaceId: string,
    input: RecordMeteredUsageInput,
  ): Promise<{ readonly usageEvent: UsageEvent }> {
    return await this.#usage.recordMeteredUsage(spaceId, input);
  }

  async reconcileInvoiceUsage(
    spaceId: string,
    input: ReconcileInvoiceUsageInput,
  ): Promise<InvoiceUsageReconciliation> {
    return await this.#usage.reconcileInvoiceUsage(spaceId, input);
  }

  async listSpaceCreditReservations(spaceId: string): Promise<{
    readonly creditReservations: readonly CreditReservation[];
  }> {
    return await this.#usage.listSpaceCreditReservations(spaceId);
  }

  async topUpSpaceCredits(
    spaceId: string,
    input: { readonly usdMicros?: number; readonly credits?: number },
  ): Promise<{ readonly balance: CreditBalance }> {
    return await this.#usage.topUpSpaceCredits(spaceId, input);
  }

  async changeSpaceSubscription(
    spaceId: string,
    input: { readonly billingSettings: BillingSettings },
  ): Promise<{ readonly billing: { readonly settings: BillingSettings } }> {
    return await this.#billing.changeSpaceSubscription(spaceId, input);
  }

  // --- Run / installation lifecycle (delegated to the RunEngine collaborator) -

  createPlanRun(
    request: CreatePlanRunRequest,
    context: DeployControlActorContext = {},
    internal: PlanRunInternalContext = {},
  ): Promise<PlanRunResponse> {
    return this.#runEngine.createPlanRun(request, context, internal);
  }

  createInstallationPlan(
    installationId: string,
    context: DeployControlActorContext = {},
    internal: CreateInstallationPlanInternal = {},
  ): Promise<PlanRunResponse> {
    return this.#runEngine.createInstallationPlan(
      installationId,
      context,
      internal,
    );
  }

  createInstallationDestroyPlan(
    installationId: string,
    context: DeployControlActorContext = {},
    internal: Pick<CreateInstallationPlanInternal, "runnerProfileId"> = {},
  ): Promise<PlanRunResponse> {
    return this.#runEngine.createInstallationDestroyPlan(
      installationId,
      context,
      internal,
    );
  }

  createInstallationDriftCheck(
    installationId: string,
    context: DeployControlActorContext = {},
    internal: Pick<CreateInstallationPlanInternal, "runGroupId"> = {},
  ): Promise<PlanRunResponse> {
    return this.#runEngine.createInstallationDriftCheck(
      installationId,
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
    spaceId: string,
    backupId: string,
    request: CreateRestoreRequest,
    context: DeployControlActorContext = {},
  ): Promise<Run> {
    return this.#runEngine.createRestoreRun(
      spaceId,
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
    return await this.#deployments.getApplyRun(id);
  }

  async getInstallation(id: string): Promise<GetInstallationResponse> {
    return await this.#deployments.getInstallation(id);
  }

  /**
   * Lists ACTIVE Installations across all Spaces, capped at `limit` (spec §28
   * scheduled drift sweep; Phase 8). Only `active` Installations are drift-checkable
   * (a `pending` / `disabled` / `destroyed` / `error` Capsule has no
   * stable deployed state to compare against). The scheduled sweep iterates this
   * bounded set and creates one drift check per Capsule. A non-positive
   * limit returns an empty list.
   */
  async listActiveInstallations(limit: number): Promise<readonly Capsule[]> {
    return await this.#deployments.listActiveInstallations(limit);
  }

  async listDeployments(
    installationId: string,
    params?: PageParams,
  ): Promise<ListDeploymentsResponse> {
    return await this.#deployments.listDeployments(installationId, params);
  }

  async listDeploymentsBySpace(
    spaceId: string,
  ): Promise<readonly Deployment[]> {
    return await this.#deployments.listDeploymentsBySpace(spaceId);
  }

  async listDeploymentsByIds(
    ids: readonly string[],
  ): Promise<readonly Deployment[]> {
    return await this.#deployments.listDeploymentsByIds(ids);
  }

  async listDeploymentOutputs(
    installationId: string,
  ): Promise<ListDeploymentOutputsResponse> {
    return await this.#deployments.listDeploymentOutputs(installationId);
  }

  /**
   * Reads a single Deployment ledger record (spec §21 / §30 `GET
   * /internal/v1/state-versions/:id`). A missing id is a typed 404.
   */
  async getDeployment(id: string): Promise<Deployment> {
    return await this.#deployments.getDeployment(id);
  }

  /**
   * Creates a rollback PLAN run for a Deployment (spec §30 `POST
   * /internal/v1/state-versions/:id/rollback-plan`): re-plans the Deployment's Capsule
   * pinned to THAT Deployment's `sourceSnapshotId`. The plan then flows through
   * the normal approval/apply path. Reuses the installation plan path with an
   * internal snapshot override.
   */
  async createDeploymentRollbackPlan(
    deploymentId: string,
    context: DeployControlActorContext = {},
  ): Promise<PlanRunResponse> {
    const deployment = await this.getDeployment(deploymentId);
    return await this.#runEngine.createInstallationPlanRun(
      deployment.installationId,
      false,
      context,
      { sourceSnapshotId: deployment.sourceSnapshotId },
    );
  }

  // --- Connections (provider credential registration; Phase 1A) -------------

  async createConnection(
    request: CreateConnectionRequest,
  ): Promise<ConnectionResponse> {
    return await this.#connections.createConnection(request);
  }

  async listConnections(
    spaceId: string,
    params?: PageParams,
  ): Promise<ListConnectionsResponse> {
    return await this.#connections.listConnections(spaceId, params);
  }

  /**
   * Lists instance-wide `operator`-scoped Connections (spec §30 `GET
   * /internal/v1/connections` with `?spaceId` omitted). Never includes secret values.
   */
  async listOperatorConnections(): Promise<ListConnectionsResponse> {
    return await this.#connections.listOperatorConnections();
  }

  async getConnection(connectionId: string): Promise<Connection> {
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

  // --- Sources (Core Specification §6) --------------------------------------

  async createSource(
    request: CreateSourceRequest,
  ): Promise<CreateSourceResponse> {
    return await this.#sources.createSource(request);
  }

  async listSources(
    spaceId: string,
    params?: PageParams,
  ): Promise<ListSourcesResponse> {
    return await this.#sources.listSources(spaceId, params);
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
    options: { readonly dedupe?: boolean } = {},
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
   * Records an upload-origin SourceSnapshot. The archive bytes are written to
   * R2_SOURCE by the upload route before this call; this persists the ledger row
   * for the internal upload-compat pipeline.
   */
  async recordUploadSnapshot(input: {
    readonly spaceId: string;
    readonly archiveObjectKey: string;
    readonly archiveDigest: string;
    readonly archiveSizeBytes: number;
    readonly path?: string;
    readonly snapshotId?: string;
  }): Promise<SourceSnapshot> {
    return await this.#sources.recordUploadSnapshot(input);
  }

  /**
   * Records a legacy prepared source archive SourceSnapshot. The archive bytes
   * are fetched, digest-verified, and written to R2_SOURCE before this call; the
   * row exists for compatibility with internal deploy-control source-archive
   * ingest, not as a public app artifact/build pipeline.
   */
  async recordArtifactSnapshot(input: {
    readonly spaceId: string;
    readonly url: string;
    readonly archiveObjectKey: string;
    readonly archiveDigest: string;
    readonly archiveSizeBytes: number;
    readonly path?: string;
    readonly snapshotId?: string;
  }): Promise<SourceSnapshot> {
    return await this.#sources.recordArtifactSnapshot(input);
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
   * `succeeded` but still requires approval (template destructive confirmation,
   * or its environment requires approval and it has not been approved) projects
   * to `waiting_approval`.
   */
  async getRun(id: string): Promise<Run> {
    return await this.#runQuery.getRun(id);
  }

  async listRuns(
    spaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly Run[]> {
    return await this.#runQuery.listRuns(spaceId, options);
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

  async #requireSpace(spaceId: string) {
    const space = await this.#store.getSpace(spaceId);
    if (!space) {
      throw new OpenTofuControllerError(
        "not_found",
        `space ${spaceId} not found`,
      );
    }
    return space;
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

/**
 * State generation guard. A PlanRun records the target's `baseStateGeneration`
 * at creation; if the target Capsule's generation has advanced since (a
 * successful apply/destroy ran in between), this plan is stale and must not
 * apply over the newer state. `create` plans (no planned installation) are
 * exempt — they have no prior generation to race.
 */
export function assertStateGenerationMatches(
  planRun: PlanRun,
  plannedInstallation: Capsule | undefined,
): void {
  if (!plannedInstallation) return;
  const base = planRun.baseStateGeneration ?? 0;
  const current = plannedInstallation.currentStateGeneration;
  if (current !== base) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `state_generation_mismatch: plan run ${planRun.id} was created against ` +
        `state generation ${base} but installation ${plannedInstallation.id} ` +
        `is now at generation ${current}`,
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
  "resolvedProviderEnvBindingsDigest",
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
  // TOCTOU pin: the Capsule's current StateVersion at plan time (Deployment
  // ledger retired). Mirrors the prior currentDeployment guard — present (string
  // or null), never undefined, whenever the plan targets an existing Capsule.
  const capsuleId = planRun.capsuleId ?? planRun.installationId;
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
    ...(planRun.resolvedProviderEnvBindingsDigest
      ? {
          resolvedProviderEnvBindingsDigest:
            planRun.resolvedProviderEnvBindingsDigest,
        }
      : {}),
  };
}

/**
 * Resolves an InstallConfig's catalog template binding + its variable mapping
 * (template inputs). Returns `undefined` when the config has no template
 * binding and should be wrapped by the generic generated-root path.
 */
export function installConfigTemplateBinding(config: InstallConfig):
  | {
      readonly templateId: string;
      readonly templateVersion: string;
      readonly inputs?: Readonly<Record<string, JsonValue>>;
    }
  | undefined {
  if (!config.templateBinding) return undefined;
  const inputs = normalizeVariables(config.variableMapping);
  return {
    templateId: config.templateBinding.templateId,
    templateVersion: config.templateBinding.templateVersion,
    ...(inputs && Object.keys(inputs).length > 0
      ? { inputs: inputs as Readonly<Record<string, JsonValue>> }
      : {}),
  };
}

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
 * Mirrors the OpenTofu runner DO's R2_STATE object key formula (spec §20) so
 * the StateSnapshot ledger pointer matches the encrypted object the DO writes:
 * `spaces/{spaceId}/installations/{installationId}/envs/{environment}/states/
 * {NNNNNNNN}.tfstate.enc`, with each id segment sanitized and the generation
 * zero-padded to 8 digits. Kept in lockstep with
 * `worker/src/durable/OpenTofuRunnerObject.ts` (the DO is the writer).
 */
export function stateObjectKeyForScope(scope: DispatchStateScope): string {
  const seg = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const generation = String(scope.generation).padStart(8, "0");
  // Physical R2_STATE key prefix is frozen (`spaces/.../installations/...`) and
  // must stay in lockstep with the OpenTofuRunnerObject DO writer; only the
  // logical vocabulary renamed. Read canonical ids, falling back to the
  // deprecated mirror during the rename.
  const workspaceId = scope.workspaceId ?? scope.spaceId ?? "";
  const capsuleId = scope.capsuleId ?? scope.installationId ?? "";
  return `spaces/${seg(workspaceId)}/installations/${seg(
    capsuleId,
  )}/envs/${seg(scope.environment)}/states/${generation}.tfstate.enc`;
}

/**
 * Mirrors the runner DO's R2_ARTIFACTS key for the encrypted raw output envelope
 * (spec §26): `spaces/{spaceId}/installations/{installationId}/runs/{runId}/
 * outputs.raw.json.enc`, with each id segment sanitized. Kept in lockstep with
 * `worker/src/durable/OpenTofuRunnerObject.ts` (the DO is the writer). Used to
 * record {@link OutputSnapshot.rawOutputArtifactKey} when the runner did not echo
 * a key (e.g. a run without environment context that never persisted the raw
 * envelope).
 */
export function rawOutputArtifactKey(input: {
  readonly spaceId: string;
  readonly installationId: string;
  readonly runId: string;
}): string {
  const seg = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `spaces/${seg(input.spaceId)}/installations/${seg(
    input.installationId,
  )}/runs/${seg(input.runId)}/outputs.raw.json.enc`;
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
/**
 * In-memory Source for a no-git Capsule that has no registered Source row.
 * It is never persisted; it only supplies the few fields the plan
 * pipeline reads (`url` / `defaultRef` / `defaultPath`) so the generated-root
 * module-source descriptor validates. The runner still restores the actual code
 * from the snapshot's `archiveObjectKey`, so the synthetic git url is metadata.
 */
export function syntheticUploadSource(
  installation: Capsule,
  snapshot: SourceSnapshot,
): Source {
  return {
    id: `upload:${installation.id}`,
    workspaceId: installation.workspaceId,
    spaceId: installation.workspaceId ?? installation.spaceId,
    name: `${installation.name}-upload`,
    url: snapshot.url,
    defaultRef: snapshot.ref,
    defaultPath: snapshot.path,
    status: "active",
    autoSync: false,
    createdAt: snapshot.fetchedAt,
    updatedAt: snapshot.fetchedAt,
  };
}

export function snapshotModuleSource(
  source: Source,
  snapshot: SourceSnapshot,
  modulePath?: string,
): OpenTofuModuleSource {
  return {
    kind: "git",
    url: normalizeGitUrlToHttps(source.url),
    ...(snapshot.resolvedCommit
      ? { commit: snapshot.resolvedCommit.toLowerCase() }
      : {}),
    ...(modulePath ? { modulePath } : {}),
  };
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
 * Reads generated-root dispatch fields off the persisted plan-run-inputs
 * sidecar. Sidecars carry `generatedRoot` (+ output allowlist) for built-in
 * modules and generic Capsules. Defensive copies are not needed because the
 * store hands back its own records and the runner job only reads.
 */
export function templateDispatchFromInputs(
  inputs:
    | {
        readonly generatedRoot?: DispatchGeneratedRoot;
        readonly outputAllowlist?: InstallConfig["outputAllowlist"];
      }
    | undefined,
): RunTemplateDispatch {
  if (!inputs) return {};
  return {
    ...(inputs.generatedRoot ? { generatedRoot: inputs.generatedRoot } : {}),
    ...(inputs.outputAllowlist
      ? { outputAllowlist: inputs.outputAllowlist }
      : {}),
  };
}

export function assertGeneratedRootDispatchPresent(
  planRun: PlanRun,
  dispatch: RunTemplateDispatch,
): void {
  if (!planRun.installationId || dispatch.generatedRoot) return;
  throw new OpenTofuControllerError(
    "failed_precondition",
    `generated_root_sidecar_missing: plan run ${planRun.id} is Capsule-bound but has no generated root sidecar`,
  );
}

/**
 * Folds the template plan-JSON policy verdict into the recorded template
 * binding, setting `requiresConfirmation`. Returns `undefined` (binding unchanged
 * / absent) for non-template runs or when there is no policy verdict yet.
 */
export function updatedTemplateBinding(
  planRun: PlanRun,
  templatePolicy: ReturnType<typeof evaluateTemplatePlanPolicy> | undefined,
): PlanRunTemplateBinding | undefined {
  const binding = planRun.templateBinding;
  if (!binding) return undefined;
  if (!templatePolicy) return binding;
  return {
    ...binding,
    requiresConfirmation: templatePolicy.requiresConfirmation,
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

const RELEASE_ACTIVATION_SECRET_NAME_RE =
  /(?:^|[_-])(?:token|secret|password|passwd|credential|auth|bearer|session|cookie|key)(?:$|[_-])|(?:^|[_-])(?:database|db|postgres|postgresql|mysql|mariadb|redis|mongo|mongodb|libsql|sqlite)[_-]?(?:url|uri|dsn)(?:$|[_-])|(?:^|[_-])(?:dsn|connection[_-]?string)(?:$|[_-])/i;
const RELEASE_ACTIVATION_SECRET_VALUE_RE =
  /(?:token|secret|password|passwd|credential|auth|bearer|session|cookie|key|database[_-]?url|connection[_-]?string|\bdsn\b|(?:postgres(?:ql)?|mysql|mariadb|redis|mongo|mongodb|libsql|sqlite):\/\/|:\/\/[^/\s:@]+:[^@\s]+@)/i;
const RELEASE_ACTIVATION_ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/u;
const RELEASE_ACTIVATION_RESERVED_ENV_RE = /^(?:TAKOSUMI_|OPENTOFU_|TF_)/u;
const RELEASE_ACTIVATION_RESERVED_ENV_NAMES = new Set(["PATH", "HOME", "PWD"]);

export function releaseActivationOutputs(
  outputs: OpenTofuOutputEnvelope | readonly DeploymentOutput[] | undefined,
): Readonly<Record<string, JsonValue>> {
  if (!outputs) return {};
  const safeOutputs: Record<string, JsonValue> = {};
  if (Array.isArray(outputs)) {
    for (const output of outputs) {
      if (isReleaseActivationOutputSafe(output.name, output.value)) {
        safeOutputs[output.name] = output.value;
      }
    }
    return safeOutputs;
  }
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
  outputs: OpenTofuOutputEnvelope | readonly DeploymentOutput[] | undefined,
): readonly ReleaseActivationCommand[] {
  if (!outputs) return [];
  const commands: ReleaseActivationCommand[] = [];
  const visit = (name: string, value: JsonValue, sensitive?: boolean): void => {
    if (sensitive === true) return;
    if (name === "takosumi_release") {
      commands.push(...parseReleaseCommandDescriptor(value, "post_apply"));
    }
  };
  if (Array.isArray(outputs)) {
    for (const output of outputs) {
      visit(output.name, output.value, output.sensitive);
    }
  } else {
    for (const [name, output] of Object.entries(outputs)) {
      visit(name, output.value, output.sensitive);
    }
  }
  return commands.slice(0, 20);
}

export function releaseActivationCommandsFromPublicOutputs(
  outputs: Readonly<Record<string, JsonValue>>,
  phase: ReleaseActivationCommand["phase"],
): readonly ReleaseActivationCommand[] {
  const descriptor = outputs.takosumi_release;
  if (descriptor === undefined) return [];
  return parseReleaseCommandDescriptor(descriptor, phase).slice(0, 20);
}

function parseReleaseCommandDescriptor(
  descriptor: JsonValue,
  phase: ReleaseActivationCommand["phase"],
): readonly ReleaseActivationCommand[] {
  if (!isRecord(descriptor)) return [];
  const phaseRows =
    phase === "post_apply"
      ? (descriptor.post_apply ?? descriptor.postApply)
      : (descriptor.pre_destroy ?? descriptor.preDestroy);
  const rows = Array.isArray(phaseRows)
    ? phaseRows
    : isRecord(phaseRows) && Array.isArray(phaseRows.commands)
      ? phaseRows.commands
      : [];
  const commands: ReleaseActivationCommand[] = [];
  for (const [index, row] of rows.entries()) {
    const command = parseReleaseCommand(row, index, phase);
    if (command) commands.push(command);
  }
  return commands;
}

function parseReleaseCommand(
  value: unknown,
  index: number,
  phase: ReleaseActivationCommand["phase"],
): ReleaseActivationCommand | undefined {
  if (!isRecord(value)) return undefined;
  const argv = releaseCommandArgv(value.command);
  if (!argv || argv.length === 0 || argv.length > 40) return undefined;
  const id = releaseCommandId(value.id) ?? `${phase}_${index + 1}`;
  const rawWorkingDirectory =
    nonEmptyString(value.workingDirectory) ??
    nonEmptyString(value.working_directory);
  const workingDirectory =
    rawWorkingDirectory &&
    isSafeReleaseCommandWorkingDirectory(rawWorkingDirectory)
      ? rawWorkingDirectory
      : undefined;
  if (rawWorkingDirectory && !workingDirectory) return undefined;
  const env = releaseCommandEnv(value.env);
  const executor = releaseCommandExecutor(value.executor);
  return {
    id,
    phase,
    command: argv,
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(env ? { env } : {}),
    ...(executor ? { executor } : {}),
  };
}

function releaseCommandExecutor(
  value: unknown,
): "runner" | "operator" | undefined {
  return value === "runner" || value === "operator" ? value : undefined;
}

function releaseCommandArgv(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 40) {
    return undefined;
  }
  const argv: string[] = [];
  for (const part of value) {
    const stringPart = nonEmptyString(part);
    if (!stringPart || /[\0\r\n]/u.test(stringPart)) return undefined;
    argv.push(stringPart);
  }
  return argv;
}

function releaseCommandId(value: unknown): string | undefined {
  const id = nonEmptyString(value);
  if (!id || /[\0\r\n]/u.test(id)) return undefined;
  return id;
}

function isSafeReleaseCommandWorkingDirectory(value: string): boolean {
  if (
    value.length === 0 ||
    /[\0\r\n]/u.test(value) ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(value)
  ) {
    return false;
  }
  return !value.split(/[\\/]+/u).some((segment) => segment === "..");
}

function releaseCommandEnv(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!RELEASE_ACTIVATION_ENV_NAME_RE.test(key)) continue;
    if (
      RELEASE_ACTIVATION_RESERVED_ENV_RE.test(key) ||
      RELEASE_ACTIVATION_RESERVED_ENV_NAMES.has(key)
    ) {
      continue;
    }
    if (RELEASE_ACTIVATION_SECRET_NAME_RE.test(key)) continue;
    const stringValue =
      typeof raw === "string" ||
      typeof raw === "number" ||
      typeof raw === "boolean"
        ? String(raw)
        : undefined;
    if (
      !stringValue ||
      /[\0\r\n]/u.test(stringValue) ||
      RELEASE_ACTIVATION_SECRET_VALUE_RE.test(stringValue)
    ) {
      continue;
    }
    env[key] = stringValue;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function isReleaseActivationOutputSafe(
  name: string,
  value: JsonValue,
): boolean {
  if (RELEASE_ACTIVATION_SECRET_NAME_RE.test(name)) return false;
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
      if (RELEASE_ACTIVATION_SECRET_VALUE_RE.test(current)) return true;
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    for (const [key, nested] of Object.entries(current)) {
      if (
        RELEASE_ACTIVATION_SECRET_NAME_RE.test(key) ||
        RELEASE_ACTIVATION_SECRET_VALUE_RE.test(key)
      ) {
        return true;
      }
      stack.push(nested);
    }
  }
  return false;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function changedOutputNamesBetween(
  previous: OutputSnapshot | undefined,
  next: OutputSnapshot,
): readonly string[] {
  const before = previous?.spaceOutputs ?? {};
  const after = next.spaceOutputs;
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter(
      (name) => canonicalJson(before[name]) !== canonicalJson(after[name]),
    )
    .sort();
}

export function directChangedDependencyOutputs(input: {
  readonly edges: readonly Dependency[];
  readonly producerInstallationId: string;
  readonly consumerInstallationId: string;
  readonly changedOutputNames: readonly string[];
}): readonly string[] {
  const changed = new Set(input.changedOutputNames);
  const direct = new Set<string>();
  for (const edge of input.edges) {
    if (
      edge.producerInstallationId !== input.producerInstallationId ||
      edge.consumerInstallationId !== input.consumerInstallationId
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
  return profile?.labels?.["takosumi.com/provider-surface"] !== "generic";
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
