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
  DispatchBuildSpec,
  DispatchDepState,
  DispatchGeneratedRoot,
  DispatchSourceArchive,
  DispatchStateScope,
  GetInstallationResponse,
  InstallConfig,
  Installation,
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
import type {
  ListProviderCatalogEntriesResponse,
  ProviderCatalogEntry,
  ProviderCatalogEntryResponse,
} from "takosumi-contract/providers";
import type { ConnectionVault } from "../../adapters/vault/mod.ts";
import type {
  OutputAllowlistEntry,
  PublicInstallation,
} from "takosumi-contract/installations";
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
import type { OutputSnapshot } from "takosumi-contract/output-snapshots";
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
import { SourceManagement } from "./source_management.ts";
import { SourceLifecycleService } from "./source_lifecycle.ts";
import { ConnectionManagement } from "./connection_management.ts";
import { DeploymentQuery, requireInstallation } from "./deployment_query.ts";
import { RunQueryService } from "./run_query.ts";
import {
  BillingService,
  DISABLED_BILLING_SETTINGS,
  type ReconcileStripeSpaceSubscriptionInput,
} from "./billing_service.ts";
import { redactString } from "../observability/redaction.ts";
import type { ObservabilitySink } from "../observability/mod.ts";
import { UsageReportingService } from "./usage_service.ts";
// The usage input-type vocabulary is owned by the usage service; re-exported here
// so the historical `./domains/deploy-control/mod.ts` import path stays stable.
export type {
  RecordMeteredUsageInput,
  RecordGatewayResourceUsageInput,
  ReconcileInvoiceUsageInput,
} from "./usage_service.ts";
import type {
  RecordMeteredUsageInput,
  RecordGatewayResourceUsageInput,
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
import {
  validateProjectedServiceExportsFromOutputSnapshot,
  type ServiceGraphOperations,
} from "../service-graph/mod.ts";
import {
  installConfigBuildSpec,
  type InstallTypePlanContext,
  PlanResolutionService,
  providerEnvBindingsFromResolved,
  type ResolvedTemplatePlan,
} from "./plan_resolution.ts";

// Re-export the shared error primitive and the four decomposed concerns so the
// domain's public entry point stays `./mod.ts` for importers and tests.
export {
  OpenTofuControllerError,
  type OpenTofuControllerErrorCode,
} from "./errors.ts";
export {
  createDefaultRunnerProfiles,
  parseEnabledRunnerProfileIds,
  resolveEnabledRunnerProfiles,
} from "./runner_profiles.ts";
export { providerMatches } from "./policy.ts";
export { deploymentOutputsFromOpenTofu } from "./projection.ts";
export type { ReconcileStripeSpaceSubscriptionInput } from "./billing_service.ts";

function publicInstallation(installation: Installation): PublicInstallation {
  const { installType: _installType, ...publicRecord } = installation;
  return publicRecord;
}

function publicPlanRun(planRun: PlanRun): PublicPlanRun {
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

function withRunEnvironmentEvidence<R extends PlanRun | ApplyRun>(
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

function runEnvironmentFailedRun<R extends PlanRun | ApplyRun>(
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
 * Capsules; bundled modules are carried as `generatedRoot.moduleFiles`. The optional
 * build phase runs first in the user source checkout with NO credentials.
 */
export interface RunTemplateDispatch {
  readonly generatedRoot?: DispatchGeneratedRoot;
  readonly outputAllowlist?: InstallConfig["outputAllowlist"];
  readonly build?: DispatchBuildSpec;
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
   * `remote_state` Dependency edge of the consumer Installation; the runner DO
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
  readonly installation: Installation;
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
  | "skipped"
  | "pending"
  | "succeeded"
  | "failed";

export interface ReleaseActivationInput {
  readonly planRun: PlanRun;
  readonly applyRun: ApplyRun;
  readonly installation: Installation;
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
}

export interface ReleaseActivationResult {
  readonly status: ReleaseActivationStatus;
  /** Operator-defined activation kind, for example `takos.cloudflare.worker`. */
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
}

export type EnqueueRun = (dispatch: OpenTofuRunDispatch) => Promise<void>;

/**
 * Stale-heartbeat takeover window. A run left `running` by a crashed consumer
 * may be retried once its heartbeat is older than this; a fresh `running`
 * heartbeat means a sibling consumer holds the run and the duplicate no-ops.
 */
const RUN_HEARTBEAT_STALE_MS = 10 * 60 * 1000;

/**
 * Renewal cadence for a long-running apply/destroy: re-stamp the run heartbeat
 * and renew the lease at a fraction of the tighter of the lease TTL and the
 * heartbeat-stale window, so a sibling never observes the run as crashed while
 * the single blocking runner fetch is in flight. `/3` leaves room for at least
 * two renewals before either deadline elapses.
 */
const RUN_RENEWAL_INTERVAL_MS = Math.floor(
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
const NON_TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["queued", "running"];
const PROVIDER_CATALOG_SEED_TIMESTAMP = "2026-06-08T00:00:00.000Z";

function initialProviderCatalogEntries(): readonly ProviderCatalogEntry[] {
  return [
    {
      id: "cloudflare",
      providerSource: "registry.opentofu.org/cloudflare/cloudflare",
      displayName: "Cloudflare",
      recommendedEnvNames: ["CLOUDFLARE_API_TOKEN"],
      credentialRecipeIds: ["cloudflare", "generic-env"],
      requiredEnvGroups: [["CLOUDFLARE_API_TOKEN"]],
      genericEnvSupported: true,
      helpers: ["cloudflare_api_token", "cloudflare_oauth"],
      ownershipOptions: ["env"],
      allowedResources: [],
      allowedDataSources: [],
      policyPackId: "cloudflare-default",
      costEstimatorId: "cloudflare-basic",
      docsUrl: "https://developers.cloudflare.com/",
      createdAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
      updatedAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
    },
    {
      id: "aws",
      providerSource: "registry.opentofu.org/hashicorp/aws",
      displayName: "AWS",
      recommendedEnvNames: [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_REGION",
      ],
      credentialRecipeIds: ["aws", "s3-compatible", "generic-env"],
      requiredEnvGroups: [
        ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
        ["AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN"],
      ],
      genericEnvSupported: true,
      helpers: ["aws_assume_role", "generic_env"],
      ownershipOptions: ["env"],
      allowedResources: ["aws_s3_bucket", "aws_s3_bucket_public_access_block"],
      allowedDataSources: [],
      policyPackId: "aws-basic",
      createdAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
      updatedAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
    },
    {
      id: "gcp",
      providerSource: "registry.opentofu.org/hashicorp/google",
      displayName: "Google Cloud",
      recommendedEnvNames: [
        "GOOGLE_CREDENTIALS",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
      ],
      credentialRecipeIds: ["google", "generic-env"],
      requiredEnvGroups: [
        ["GOOGLE_CREDENTIALS"],
        ["GOOGLE_APPLICATION_CREDENTIALS"],
      ],
      genericEnvSupported: true,
      helpers: [
        "gcp_service_account_json",
        "gcp_oauth_bootstrap",
        "gcp_service_account_impersonation",
        "generic_env",
      ],
      ownershipOptions: ["env"],
      allowedResources: [
        "google_storage_bucket",
        "google_cloud_run_v2_service",
      ],
      allowedDataSources: [],
      policyPackId: "gcp-basic",
      createdAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
      updatedAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
    },
    {
      id: "github",
      providerSource: "registry.opentofu.org/integrations/github",
      displayName: "GitHub",
      recommendedEnvNames: ["GITHUB_TOKEN"],
      credentialRecipeIds: ["github", "generic-env"],
      requiredEnvGroups: [["GITHUB_TOKEN"]],
      genericEnvSupported: true,
      helpers: ["generic_env"],
      ownershipOptions: ["env"],
      allowedResources: [],
      allowedDataSources: [],
      policyPackId: "github-basic",
      createdAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
      updatedAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
    },
    {
      id: "kubernetes",
      providerSource: "registry.opentofu.org/hashicorp/kubernetes",
      displayName: "Kubernetes",
      recommendedEnvNames: ["KUBE_CONFIG_PATH", "KUBE_HOST", "KUBE_TOKEN"],
      credentialRecipeIds: ["kubernetes", "helm", "generic-env"],
      requiredEnvGroups: [["KUBE_CONFIG_PATH"], ["KUBE_HOST", "KUBE_TOKEN"]],
      genericEnvSupported: true,
      helpers: ["generic_env"],
      ownershipOptions: ["env"],
      allowedResources: [],
      allowedDataSources: [],
      policyPackId: "kubernetes-basic",
      createdAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
      updatedAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
    },
    {
      id: "digitalocean",
      providerSource: "registry.opentofu.org/digitalocean/digitalocean",
      displayName: "DigitalOcean",
      recommendedEnvNames: ["DIGITALOCEAN_TOKEN"],
      credentialRecipeIds: ["digitalocean", "generic-env"],
      requiredEnvGroups: [["DIGITALOCEAN_TOKEN"]],
      genericEnvSupported: true,
      helpers: ["generic_env"],
      ownershipOptions: ["env"],
      allowedResources: [],
      allowedDataSources: [],
      policyPackId: "digitalocean-basic",
      createdAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
      updatedAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
    },
    {
      id: "hcloud",
      providerSource: "registry.opentofu.org/hetznercloud/hcloud",
      displayName: "Hetzner Cloud",
      recommendedEnvNames: ["HCLOUD_TOKEN"],
      credentialRecipeIds: ["hcloud", "generic-env"],
      requiredEnvGroups: [["HCLOUD_TOKEN"]],
      genericEnvSupported: true,
      helpers: ["generic_env"],
      ownershipOptions: ["env"],
      allowedResources: [],
      allowedDataSources: [],
      policyPackId: "hcloud-basic",
      createdAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
      updatedAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
    },
    {
      id: "vultr",
      providerSource: "registry.opentofu.org/vultr/vultr",
      displayName: "Vultr",
      recommendedEnvNames: ["VULTR_API_KEY"],
      credentialRecipeIds: ["vultr", "generic-env"],
      requiredEnvGroups: [["VULTR_API_KEY"]],
      genericEnvSupported: true,
      helpers: ["generic_env"],
      ownershipOptions: ["env"],
      allowedResources: [],
      allowedDataSources: [],
      policyPackId: "vultr-basic",
      createdAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
      updatedAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
    },
    {
      id: "scaleway",
      providerSource: "registry.opentofu.org/scaleway/scaleway",
      displayName: "Scaleway",
      recommendedEnvNames: ["SCW_ACCESS_KEY", "SCW_SECRET_KEY"],
      credentialRecipeIds: ["scaleway", "generic-env"],
      requiredEnvGroups: [
        ["SCW_ACCESS_KEY", "SCW_SECRET_KEY"],
        ["SCW_PROFILE"],
      ],
      genericEnvSupported: true,
      helpers: ["generic_env"],
      ownershipOptions: ["env"],
      allowedResources: [],
      allowedDataSources: [],
      policyPackId: "scaleway-basic",
      createdAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
      updatedAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
    },
    {
      id: "openstack",
      providerSource:
        "registry.opentofu.org/terraform-provider-openstack/openstack",
      displayName: "OpenStack",
      recommendedEnvNames: ["OS_CLOUD"],
      credentialRecipeIds: ["openstack", "generic-env"],
      requiredEnvGroups: [
        ["OS_CLOUD"],
        ["OS_AUTH_URL", "OS_USERNAME", "OS_PASSWORD", "OS_PROJECT_NAME"],
        [
          "OS_AUTH_URL",
          "OS_APPLICATION_CREDENTIAL_ID",
          "OS_APPLICATION_CREDENTIAL_SECRET",
        ],
      ],
      genericEnvSupported: true,
      helpers: ["generic_env"],
      ownershipOptions: ["env"],
      allowedResources: [],
      allowedDataSources: [],
      policyPackId: "openstack-basic",
      createdAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
      updatedAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
    },
  ];
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
   * Installation lease seam (core-spec.md §22 / §23). When present, the apply
   * consumer acquires the `installation:{installationId}:{environment}` lease
   * before executing a write run and releases it in `finally`, so only ONE
   * write run per (Installation, environment) runs at a time. A busy lease
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
   * Service Graph projection service. When present, a successful apply projects
   * the validated `service_exports` OutputSnapshot entry into ServiceExport rows
   * after the apply ledger commit.
   */
  readonly serviceGraphService?: ServiceGraphOperations;
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
   * application artifact (for example the Takos Worker script/assets) and report
   * that release activation here. The hook receives no credential material and
   * no sensitive outputs.
   */
  readonly releaseActivator?: ReleaseActivator;
  readonly observability?: Pick<ObservabilitySink, "recordMetric">;
  readonly metricTags?: Record<string, string>;
  /**
   * Operator/self-host billing default (§28). Space.billingSettings overrides
   * this. Omitted means self-host style `disabled`.
   */
  readonly defaultBillingSettings?: BillingSettings;
}

export interface DeployControlActorContext {
  readonly actor?: string;
}

interface GenericRootPlanContext {
  readonly providerEnvBindings: readonly RootInstallationProviderEnvBinding[];
  readonly outputAllowlist: InstallConfig["outputAllowlist"];
  readonly moduleFiles?: readonly OpenTofuCapsuleSourceFile[];
  readonly build?: DispatchBuildSpec;
}

interface GenericRootDispatchContext {
  readonly generatedRoot: DispatchGeneratedRoot;
  readonly outputAllowlist: InstallConfig["outputAllowlist"];
  readonly build?: DispatchBuildSpec;
}

/**
 * Internal plan-creation context for the Installation-driven flow. Carried only
 * by {@link OpenTofuDeploymentController.createInstallationPlan} /
 * `createInstallationDestroyPlan`; the raw `/internal/v1/plan-runs` create path leaves
 * it empty.
 */
interface PlanRunInternalContext {
  readonly installationContext?: PlanRunInstallationContext;
  readonly sourceSnapshotId?: string;
  readonly compatibilityReportId?: string;
  /** The Installation's current state generation (its latest StateSnapshot, or 0). */
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
   * Dependency pins resolved by the Installation planning path before the PlanRun
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
 * Request to plan / destroy-plan an Installation (spec §23). Resolves the
 * Installation -> InstallConfig -> Source, picks the latest SourceSnapshot,
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
   * Reuses a pre-install CapsuleCompatibilityReport that was already produced
   * for the exact SourceSnapshot the plan will use. Public callers may pass this
   * as a hint; the controller still verifies existence, snapshot/source scope,
   * and policy before using it.
   */
  readonly compatibilityReportId?: string;
  /**
   * Pins the plan to a SPECIFIC SourceSnapshot id instead of resolving the
   * Source's latest snapshot for its default ref. Used by the §30 deployment
   * rollback-plan path (`POST /internal/v1/deployments/:id/rollback-plan`) to re-plan an
   * Installation against the source snapshot a prior Deployment was built from.
   * The snapshot must belong to the Installation's Source.
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
interface PlanPolicyLayers {
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
interface PlanCompletionVerdict {
  readonly requiredProviders: readonly string[];
  readonly layered: PlanPolicyLayers;
  readonly compatibilityPolicy: CapsuleCompatibilityPolicyResult;
  readonly billingPolicy: PlanBillingPolicyResult;
  readonly passedPolicy: boolean;
  readonly completedPolicy: PolicyDecision;
  readonly policyDecisionDigest: string;
  readonly requiresApproval: boolean;
}

type RunClaimResult<R extends PlanRun | ApplyRun> =
  | { readonly won: true; readonly run: R; readonly leaseToken: string }
  | { readonly won: false; readonly run: R };

interface TerminalRunPersistResult<R extends PlanRun | ApplyRun> {
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
  readonly #serviceGraphService?: ServiceGraphOperations;
  readonly #sensitiveOutputResolver?: SensitiveOutputResolver;
  readonly #dependencyValueSealer?: DependencyValueSealer;
  readonly #releaseActivator?: ReleaseActivator;
  readonly #observability?: Pick<ObservabilitySink, "recordMetric">;
  readonly #metricTags: Record<string, string>;
  readonly #defaultBillingSettings: BillingSettings;
  readonly #allowOperatorBackedProviderEnvs: boolean;
  readonly #seededProfiles: Promise<void>;
  readonly #seededProviderCatalogEntries: Promise<void>;
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
  #connectionsService?: ConnectionsService;

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
    this.#serviceGraphService = dependencies.serviceGraphService;
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
        this.#shouldProcessRun(status, heartbeatAt),
    });
    this.#billing = new BillingService({
      store: this.#store,
      newId: this.#newId,
      now: this.#now,
      defaultBillingSettings: this.#defaultBillingSettings,
      requireSpace: (spaceId) => this.#requireSpace(spaceId),
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
        this.#createInstallationPlanRun(
          installationId,
          destroy,
          context,
          internal,
        ),
      recordActivity: (event) => this.#recordActivity(event),
    });
    this.#credentials = new RunCredentialBroker({
      store: this.#store,
      newId: this.#newId,
      now: this.#now,
      ...(this.#vault ? { vault: this.#vault } : {}),
      resolveRunInstallationProviderEnvBindings: (planRun) =>
        this.#resolveRunInstallationProviderEnvBindings(planRun),
      policyForPlanRun: (planRun) => this.#policyForPlanRun(planRun),
    });
    this.#runEnv = new RunEnvResolver({
      credentials: this.#credentials,
      resolveRunInstallationProviderEnvBindings: (planRun) =>
        this.#resolveRunInstallationProviderEnvBindings(planRun),
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
      policyForPlanRun: (planRun) => this.#policyForPlanRun(planRun),
      assertCompatibilityReportRunnable: (report, policy) =>
        this.#assertCompatibilityReportRunnable(report, policy),
    });
    // Default to an inline dispatcher: run the consumer immediately so local /
    // node substrates and tests keep the historical synchronous semantics.
    this.#enqueueRun =
      dependencies.enqueueRun ??
      ((dispatch) => this.dispatchQueuedRun(dispatch));
    this.#templateRegistry =
      dependencies.templateRegistry ?? defaultTemplateRegistry;
    this.#planResolution = new PlanResolutionService({
      templateRegistry: this.#templateRegistry,
      now: this.#now,
      resolveInstallationProviderEnvBindingsForRun: (
        installation,
        requiredProviders,
      ) =>
        this.#resolveInstallationProviderEnvBindingsForRun(
          installation,
          requiredProviders,
        ),
    });
    this.#seededProfiles = this.#seedRunnerProfiles(
      dependencies.runnerProfiles ?? createDefaultRunnerProfiles(this.#now()),
    );
    this.#seededProviderCatalogEntries = this.#seedProviderCatalogEntries(
      initialProviderCatalogEntries(),
    );
  }

  async listRunnerProfiles(): Promise<ListRunnerProfilesResponse> {
    await this.#seededProfiles;
    return { runnerProfiles: await this.#store.listRunnerProfiles() };
  }

  async listProviderCatalogEntries(): Promise<ListProviderCatalogEntriesResponse> {
    await this.#seededProviderCatalogEntries;
    return { providers: await this.#store.listProviderCatalogEntries() };
  }

  async #seedProviderCatalogEntries(
    entries: readonly ProviderCatalogEntry[],
  ): Promise<void> {
    for (const entry of entries) {
      await this.#store.putProviderCatalogEntry(entry);
    }
  }

  async getProviderCatalogEntry(
    providerId: string,
  ): Promise<ProviderCatalogEntryResponse> {
    requireNonEmptyString(providerId, "providerId");
    await this.#seededProviderCatalogEntries;
    const provider = await this.#store.getProviderCatalogEntry(providerId);
    if (!provider) {
      throw new OpenTofuControllerError(
        "not_found",
        `provider ${providerId} not found`,
      );
    }
    return { provider };
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

  async recordGatewayResourceUsage(
    spaceId: string,
    input: RecordGatewayResourceUsageInput,
  ): Promise<{ readonly usageEvents: readonly UsageEvent[] }> {
    return await this.#usage.recordGatewayResourceUsage(spaceId, input);
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
    input: { readonly credits: number },
  ): Promise<{ readonly balance: CreditBalance }> {
    return await this.#usage.topUpSpaceCredits(spaceId, input);
  }

  async changeSpaceSubscription(
    spaceId: string,
    input: { readonly billingSettings: BillingSettings },
  ): Promise<{ readonly billing: { readonly settings: BillingSettings } }> {
    return await this.#billing.changeSpaceSubscription(spaceId, input);
  }

  async reconcileStripeSpaceSubscription(
    spaceId: string,
    input: ReconcileStripeSpaceSubscriptionInput,
  ): Promise<{
    readonly billingAccount: BillingAccount;
    readonly subscription: SpaceSubscription;
    readonly billing: { readonly settings: BillingSettings };
  }> {
    return await this.#billing.reconcileStripeSpaceSubscription(spaceId, input);
  }

  async createPlanRun(
    request: CreatePlanRunRequest,
    context: DeployControlActorContext = {},
    internal: PlanRunInternalContext = {},
  ): Promise<PlanRunResponse> {
    await this.#seededProfiles;
    requireNonEmptyString(request.spaceId, "spaceId");
    validateSource(request.source);
    const profile = await this.#requireRunnerProfile(
      request.runnerProfileId ?? this.#defaultRunnerProfileId,
    );
    const operation =
      request.operation ?? (request.installationId ? "update" : "create");
    validateOperation(operation);
    const installation =
      request.installationId !== undefined
        ? await this.#requireInstallation(request.installationId)
        : undefined;
    if (!installation) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "plan requires an existing installationId (create the Installation first)",
      );
    }
    if (installation.spaceId !== request.spaceId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `installation ${installation.id} belongs to space ${installation.spaceId}, not ${request.spaceId}`,
      );
    }
    const installationContext: PlanRunInstallationContext =
      internal.installationContext ?? {
        spaceId: installation.spaceId,
        installationId: installation.id,
        environment: installation.environment,
      };
    validateSourceAllowedByProfile(request.source, profile);
    const now = this.#now();
    const variables = normalizeVariables(request.variables);
    // Cloud-only gateway materialization is rejected here; OSS Takosumi never
    // rewrites a provider base_url.
    const installTypePlan =
      await this.#planResolution.applyGatewayEndpointBaseUrl(
        internal.installTypePlan,
        profile,
        installation,
      );
    const templatePlan = this.#planResolution.resolveTemplatePlan(
      request,
      installTypePlan,
    );
    const declaredProviders = templatePlan
      ? normalizeProviders(templatePlan.requiredProviders)
      : normalizeProviders(request.requiredProviders ?? []);
    const allowNoProviders =
      (templatePlan !== undefined &&
        templatePlan.template.policy.allowedProviders.length === 0) ||
      (declaredProviders.length === 0 &&
        profile.allowedProviders.includes("*"));
    const basePolicy = evaluatePolicy({
      profile,
      requiredProviders: declaredProviders,
      checkedAt: now,
      ...(allowNoProviders ? { allowNoProviders: true } : {}),
    });
    const genericEnvProviderPolicy =
      await this.#evaluateGenericEnvProviderExecutionPolicy({
        profile,
        installation,
        requiredProviders: declaredProviders,
        hasProviderEnvRunner: this.#providerEnvRunner !== undefined,
      });
    const policyReasons = [
      ...basePolicy.reasons,
      ...genericEnvProviderPolicy.reasons,
    ];
    const policy: PolicyDecision =
      policyReasons.length === basePolicy.reasons.length
        ? basePolicy
        : {
            ...basePolicy,
            status: policyReasons.length === 0 ? "passed" : "blocked",
            reasons: policyReasons,
          };
    const sourceDigest = await stableJsonDigest(request.source);
    const variablesDigest = await stableJsonDigest(variables);
    const policyDecisionDigest = await stableJsonDigest(policy);
    const sourceSnapshotId =
      internal.sourceSnapshotId ??
      (await this.#resolvePlanSourceSnapshotId(installation));
    const baseStateGeneration =
      internal.baseStateGeneration ?? installation.currentStateGeneration;
    let planRun: PlanRun = {
      id: this.#newId("plan"),
      spaceId: request.spaceId,
      installationId: request.installationId,
      installationCurrentDeploymentId: installation.currentDeploymentId ?? null,
      source: request.source,
      sourceDigest,
      operation,
      runnerProfileId: profile.id,
      variablesDigest,
      requiredProviders: declaredProviders,
      baseStateGeneration,
      sourceSnapshotId,
      ...(internal.compatibilityReportId
        ? { compatibilityReportId: internal.compatibilityReportId }
        : {}),
      installationContext,
      ...(internal.runGroupId ? { runGroupId: internal.runGroupId } : {}),
      ...(internal.driftCheck ? { driftCheck: true as const } : {}),
      ...(templatePlan
        ? {
            templateBinding: {
              templateId: templatePlan.template.id,
              templateVersion: templatePlan.template.version,
            } satisfies PlanRunTemplateBinding,
          }
        : {}),
      // A create-time policy denial is a terminal `failed` run carrying the
      // policy reason (the retired `blocked` status is gone); a passed plan is
      // `queued` for the consumer to execute.
      status: policy.status === "passed" ? "queued" : "failed",
      policy,
      policyDecisionDigest,
      auditEvents: [
        auditEvent(
          "plan",
          "plan.requested",
          now,
          {
            sourceDigest,
            variablesDigest,
            runnerProfileId: profile.id,
            ...(templatePlan
              ? {
                  templateId: templatePlan.template.id,
                  templateVersion: templatePlan.template.version,
                }
              : {}),
          },
          context.actor,
        ),
        auditEvent(
          "plan",
          "plan.policy_evaluated",
          now,
          {
            policyDecisionDigest,
            status: policy.status,
          },
          context.actor,
        ),
      ],
      createdAt: now,
      updatedAt: now,
      // A create-time policy denial finishes immediately (terminal `failed`).
      ...(policy.status === "blocked" ? { finishedAt: now } : {}),
    };
    await this.#store.putPlanRun(planRun);
    if (internal.resolvedDependencies?.entries.length) {
      planRun = await this.#pinDependencySnapshotRecord(
        planRun,
        internal.resolvedDependencies,
      );
    }
    await this.#recordActivity({
      spaceId: planRun.spaceId,
      ...(context.actor ? { actorId: context.actor } : {}),
      action: "run.plan_created",
      targetType: "run",
      targetId: planRun.id,
      runId: planRun.id,
      metadata: {
        operation: planRun.operation,
        installationId: planRun.installationId,
        policyStatus: planRun.policy.status,
      },
    });
    if (planRun.status === "failed") {
      await this.#recordDeployOperationMetric({
        run: planRun,
        operationKind: "plan",
        status: "failed",
      });
    }
    const genericRootDispatch =
      internal.genericRootDispatch ??
      (templatePlan
        ? undefined
        : await this.#defaultGenericRootDispatchForPlanRun(
            request,
            installation,
            internal.compatibilityReportId,
            sourceSnapshotId,
          ));
    const generatedRoot =
      templatePlan?.generatedRoot ?? genericRootDispatch?.generatedRoot;
    const outputAllowlist = genericRootDispatch?.outputAllowlist;
    const build = genericRootDispatch?.build ?? templatePlan?.build;
    if (
      Object.keys(variables).length > 0 ||
      generatedRoot !== undefined ||
      outputAllowlist !== undefined ||
      build !== undefined
    ) {
      // A sensitive dependency-injected value flows into `variables` AND (for a
      // generic Capsule) is baked as a literal into the generated root's
      // `main.tf`. Both would persist in cleartext in the runs_inputs sidecar, so
      // seal the WHOLE sidecar at rest when any sensitive value was injected (spec
      // §11 / §18: secret outputs are never stored as cleartext ledger values).
      // The controller unseals it transparently at plan/apply dispatch.
      const sealSidecar =
        internal.resolvedDependencies?.hasSensitiveInjected === true;
      await this.#putPlanRunInputs(
        {
          planRunId: planRun.id,
          variables,
          ...(generatedRoot ? { generatedRoot } : {}),
          ...(outputAllowlist ? { outputAllowlist } : {}),
          ...(build ? { build } : {}),
        },
        sealSidecar,
      );
    }
    if (policy.status === "passed" && this.#hasRunnerForProfile(profile)) {
      await this.#enqueueRun({
        action: "plan",
        runId: planRun.id,
        spaceId: planRun.spaceId,
      });
      const dispatched = await this.#store.getPlanRun(planRun.id);
      return { planRun: publicPlanRun(dispatched ?? planRun) };
    }
    return { planRun: publicPlanRun(planRun) };
  }

  async createInstallationPlan(
    installationId: string,
    context: DeployControlActorContext = {},
    internal: CreateInstallationPlanInternal = {},
  ): Promise<PlanRunResponse> {
    return await this.#createInstallationPlanRun(
      installationId,
      false,
      context,
      internal,
    );
  }

  /**
   * Installation-driven destroy-plan (spec §23 Destroy). Same resolution as
   * {@link createInstallationPlan} with a destroy operation; the plan ALWAYS
   * lands the persisted `waiting_approval` status after completion (a destroy
   * plan is always two-stage).
   */
  async createInstallationDestroyPlan(
    installationId: string,
    context: DeployControlActorContext = {},
  ): Promise<PlanRunResponse> {
    return await this.#createInstallationPlanRun(installationId, true, context);
  }

  /**
   * Installation-driven drift check (spec §19 `drift_check` run type; Phase 8
   * advanced). Creates a plan-kind internal run flagged
   * {@link PlanRun.driftCheck} that:
   *   - resolves the Installation -> InstallConfig -> Source -> latest snapshot
   *     exactly like {@link createInstallationPlan} (an `update`-kind plan), so
   *     the runner produces a real `tofu plan` against the live state;
   *   - NEVER parks `waiting_approval` (`RunQueryService.planAwaitsApproval`
   *     short-circuits a drift check) — it is a read-only signal, not an applyable plan;
   *   - can NEVER be applied (`createApplyRun` rejects a drift-check plan with
   *     `failed_precondition`);
   *   - on completion with a non-empty change summary emits an
   *     `installation.drift_detected` Activity event with public-safe aggregate
   *     metadata only (no values, no installation status change; the spec has no
   *     `drifted` status).
   * The §19 Run projection maps it to `type: "drift_check"`.
   *
   * The public API exposes drift-check creation as a canonical read-only run
   * route; it records ledger/activity evidence without creating an applyable
   * plan artifact.
   */
  async createInstallationDriftCheck(
    installationId: string,
    context: DeployControlActorContext = {},
    internal: Pick<CreateInstallationPlanInternal, "runGroupId"> = {},
  ): Promise<PlanRunResponse> {
    return await this.#drift.createInstallationDriftCheck(
      installationId,
      context,
      internal,
    );
  }

  async #createInstallationPlanRun(
    installationId: string,
    destroy: boolean,
    context: DeployControlActorContext,
    internal: CreateInstallationPlanInternal = {},
  ): Promise<PlanRunResponse> {
    await this.#seededProfiles;
    requireNonEmptyString(installationId, "installationId");
    const installation = await this.#requireInstallation(installationId);
    const installConfig = await this.#store.getInstallConfig(
      installation.installConfigId,
    );
    if (!installConfig) {
      throw new OpenTofuControllerError(
        "not_found",
        `install config ${installation.installConfigId} not found for ` +
          `installation ${installationId}`,
      );
    }
    // Two snapshot-resolution paths share the rest of the pipeline:
    //   - git installations resolve their registered Source's snapshot;
    //   - upload installations (no Source) pin the upload snapshot the deploy
    //     passed in and run against an in-memory synthesized Source. Both feed
    //     the same Capsule Gate / generated-root / plan dispatch because the
    //     runner restores the archive from the snapshot's archiveObjectKey
    //     regardless of origin.
    let source: Source;
    let snapshot: SourceSnapshot;
    if (installation.sourceId) {
      const stored = await this.#store.getSource(installation.sourceId);
      if (!stored) {
        throw new OpenTofuControllerError(
          "not_found",
          `source ${installation.sourceId} not found for installation ${installationId}`,
        );
      }
      source = stored;
      // The rollback-plan path pins a SPECIFIC SourceSnapshot (a prior
      // Deployment's snapshot); otherwise resolve the Source's latest snapshot
      // for its default ref.
      const resolved = internal.sourceSnapshotId
        ? await this.#requireSourceSnapshotForSource(
            stored.id,
            internal.sourceSnapshotId,
          )
        : await this.#resolveLatestSnapshot(stored.id, stored.defaultRef);
      if (!resolved) {
        // Typed 409: the Installation cannot plan until a SourceSnapshot exists
        // for its source. Callers run a source_sync first.
        throw new OpenTofuControllerError(
          "failed_precondition",
          `source_sync_required: installation ${installationId} has no ` +
            `SourceSnapshot for source ${stored.id} ref ${stored.defaultRef}; ` +
            `run a source sync first`,
        );
      }
      snapshot = resolved;
    } else {
      const pinnedSnapshotId =
        internal.sourceSnapshotId ??
        (destroy
          ? await this.#destroySourceSnapshotIdForUploadInstallation(
              installation,
            )
          : undefined);
      if (!pinnedSnapshotId) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `installation ${installationId} is upload-origin; a plan requires a ` +
            `pinned upload SourceSnapshot (deploy a new upload via takosumi deploy)`,
        );
      }
      const pinned = await this.#store.getSourceSnapshot(pinnedSnapshotId);
      if (!pinned || pinned.spaceId !== installation.spaceId) {
        throw new OpenTofuControllerError(
          "not_found",
          `upload SourceSnapshot ${pinnedSnapshotId} not found in ` +
            `space ${installation.spaceId}`,
        );
      }
      snapshot = pinned;
      source = syntheticUploadSource(installation, pinned);
    }
    // The Installation's current state generation drives the dispatch
    // restore/persist arithmetic. No prior StateSnapshot -> generation 0.
    const latestState = await this.#store.getLatestStateSnapshot(
      installation.id,
      installation.environment,
    );
    const baseStateGeneration = latestState?.generation ?? 0;
    const operation = destroy
      ? "destroy"
      : installation.currentDeploymentId
        ? "update"
        : "create";
    const compatibilityReport = internal.deferCompatibilityReport
      ? undefined
      : internal.compatibilityReportId
        ? await this.#useInstallationCompatibilityReportHint(
            installation,
            source,
            snapshot,
            internal.compatibilityReportId,
          )
        : await this.#ensureInstallationCompatibilityReport(
            installation,
            source,
            snapshot,
          );
    const {
      request: planRequest,
      installTypePlan,
      genericRootPlan,
    } = await this.#installationPlanRequest({
      installation,
      installConfig,
      source,
      snapshot,
      operation,
      ...(compatibilityReport ? { compatibilityReport } : {}),
    });
    const installationContext: PlanRunInstallationContext = {
      spaceId: installation.spaceId,
      installationId: installation.id,
      environment: installation.environment,
    };
    // Dependency variable_injection (spec §15 / §17). A destroy plan does NOT
    // inject dependency values: there is nothing to wire into a teardown, and the
    // pinned producer outputs would be irrelevant. For plan/update, resolve the
    // consumer's Dependencies, read each producer's OutputSnapshot, build the
    // injected values, and merge them into the generated-root module inputs
    // BEFORE the run is created. The DependencySnapshot is pinned
    // AFTER the run row exists (runId known), then the planRun is re-put with its
    // id (order: resolve -> inject -> create plan -> snapshot -> re-put).
    const resolvedDeps = destroy
      ? undefined
      : await this.#dependencies.resolveConsumerDependencies(installation);
    const injectedRequest = resolvedDeps
      ? this.#injectDependencyValues(planRequest, resolvedDeps.injectedValues)
      : planRequest;
    const finalizedGenericRoot = genericRootPlan
      ? await this.#genericRootDispatchForRequest(
          injectedRequest,
          genericRootPlan,
          compatibilityReport,
          snapshot,
        )
      : undefined;
    const response = await this.createPlanRun(injectedRequest, context, {
      installationContext,
      sourceSnapshotId: snapshot.id,
      baseStateGeneration,
      ...(compatibilityReport
        ? { compatibilityReportId: compatibilityReport.id }
        : {}),
      ...(installTypePlan ? { installTypePlan } : {}),
      ...(finalizedGenericRoot
        ? { genericRootDispatch: finalizedGenericRoot }
        : {}),
      ...(resolvedDeps && resolvedDeps.entries.length > 0
        ? { resolvedDependencies: resolvedDeps }
        : {}),
      ...(internal.runGroupId ? { runGroupId: internal.runGroupId } : {}),
      ...(internal.driftCheck ? { driftCheck: true as const } : {}),
    });
    return response;
  }

  /**
   * Merges the dependency-injected values into a plan request (spec §15). A
   * template-backed request (carries `templateId`) merges into `inputs` (only
   * keys the template would accept; `validateTemplateInputs` downstream rejects
   * unknprovider envs, so the injected `to` names MUST be declared template inputs —
   * a required mapping to an undeclared input surfaces as `failed_precondition`
   * via the template validator); a template-less Capsule request merges into
   * `variables`, which rootgen later exposes as module inputs.
   * Injected values win on a key collision (they are the resolved producer
   * outputs the consumer was wired to consume).
   */
  #injectDependencyValues(
    request: CreatePlanRunRequest,
    injectedValues: Readonly<Record<string, JsonValue>>,
  ): CreatePlanRunRequest {
    if (Object.keys(injectedValues).length === 0) return request;
    if (request.templateId !== undefined) {
      return {
        ...request,
        inputs: { ...(request.inputs ?? {}), ...injectedValues },
      };
    }
    return {
      ...request,
      variables: { ...(request.variables ?? {}), ...injectedValues },
    };
  }

  /**
   * Records the DependencySnapshot for a created PlanRun and re-puts the run with
   * its id (spec §17). The snapshot pins exactly the entries resolved at plan
   * creation; the apply consumer re-reads it to verify producer state generations
   * (strict mode) + recompute the values digests (tamper check) before applying.
   * Returns the updated PlanRun.
   */
  async #pinDependencySnapshotRecord(
    planRun: PlanRun,
    resolved: ResolvedDependencies,
  ): Promise<PlanRun> {
    const snapshot: DependencySnapshot = {
      id: this.#newId("depsnap"),
      runId: planRun.id,
      dependencies: resolved.entries,
      mode: resolved.mode,
      createdAt: new Date(this.#now()).toISOString(),
    };
    await this.#store.putDependencySnapshot(snapshot);
    const updated: PlanRun = { ...planRun, dependencySnapshotId: snapshot.id };
    await this.#store.putPlanRun(updated);
    return updated;
  }

  /**
   * Picks the LATEST SourceSnapshot for a source, preferring one whose ref
   * matches the requested ref when any such snapshot exists; otherwise the
   * newest snapshot for the source. Returns `undefined` when the source has no
   * snapshot yet.
   */
  async #resolveLatestSnapshot(
    sourceId: string,
    ref: string,
  ): Promise<SourceSnapshot | undefined> {
    const snapshots = await this.#store.listSourceSnapshots(sourceId);
    if (snapshots.length === 0) return undefined;
    // listSourceSnapshots is ordered oldest-first (fetchedAt asc); the last
    // ref-matching snapshot is the newest for that ref.
    const refMatches = snapshots.filter((snap) => snap.ref === ref);
    const pool = refMatches.length > 0 ? refMatches : snapshots;
    return pool[pool.length - 1];
  }

  async #resolvePlanSourceSnapshotId(
    installation: Installation,
  ): Promise<string> {
    if (!installation.sourceId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `installation ${installation.id} is upload-origin (no git Source); ` +
          `deploy a new upload snapshot via takosumi deploy`,
      );
    }
    const source = await this.#store.getSource(installation.sourceId);
    if (!source) {
      throw new OpenTofuControllerError(
        "not_found",
        `source ${installation.sourceId} not found for installation ${installation.id}`,
      );
    }
    const snapshot = await this.#resolveLatestSnapshot(
      source.id,
      source.defaultRef,
    );
    if (!snapshot) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `source_sync_required: installation ${installation.id} has no SourceSnapshot for source ${source.id}; run a source sync first`,
      );
    }
    return snapshot.id;
  }

  /**
   * Resolves a SourceSnapshot by id and asserts it belongs to the given Source.
   * Used by the rollback-plan path to pin a prior Deployment's snapshot; a
   * snapshot from another Source (or a missing id) is a typed 404.
   */
  async #requireSourceSnapshotForSource(
    sourceId: string,
    snapshotId: string,
  ): Promise<SourceSnapshot> {
    const snapshots = await this.#store.listSourceSnapshots(sourceId);
    const snapshot = snapshots.find((snap) => snap.id === snapshotId);
    if (!snapshot) {
      throw new OpenTofuControllerError(
        "not_found",
        `source snapshot ${snapshotId} not found for source ${sourceId}`,
      );
    }
    return snapshot;
  }

  async #ensureInstallationCompatibilityReport(
    installation: Installation,
    source: Source,
    snapshot: SourceSnapshot,
  ): Promise<CapsuleCompatibilityReport | undefined> {
    const existing = installation.compatibilityReportId
      ? await this.#store.getCapsuleCompatibilityReport(
          installation.compatibilityReportId,
        )
      : undefined;
    const policy = await this.#policyForInstallation(installation);
    if (
      existing &&
      this.#isCompatibilityReportScopedToInstallationPlan(
        existing,
        installation,
        source,
        snapshot,
      )
    ) {
      this.#assertCompatibilityReportRunnable(existing, policy);
      return existing;
    }
    const preflight =
      await this.#store.getLatestCapsuleCompatibilityReportForSourceSnapshot(
        snapshot.id,
        {
          sourceId: source.id,
          installationId: installation.id,
        },
      );
    if (preflight) {
      this.#assertCompatibilityReportScopedToInstallationPlan(
        preflight,
        installation,
        source,
        snapshot,
      );
      this.#assertCompatibilityReportRunnable(preflight, policy);
      await this.#store.patchInstallation(installation.id, {
        compatibilityReportId: preflight.id,
        compatibilityStatus: preflight.level,
        updatedAt: new Date(this.#now()).toISOString(),
      });
      return preflight;
    }
    if (!this.#sourcesService) {
      if (existing) {
        this.#assertCompatibilityReportScopedToInstallationPlan(
          existing,
          installation,
          source,
          snapshot,
        );
      }
      return undefined;
    }
    // Upload-origin installations have no registered Source; gate the snapshot
    // directly. Git installations gate through their Source id.
    const { report } = installation.sourceId
      ? await this.#sourcesService.createCompatibilityCheck(source.id, {
          sourceSnapshotId: snapshot.id,
          installationId: installation.id,
        })
      : await this.#sourcesService.createCompatibilityCheckForSnapshot(
          snapshot,
          { installationId: installation.id },
        );
    await this.#store.patchInstallation(installation.id, {
      compatibilityReportId: report.id,
      compatibilityStatus: report.level,
      updatedAt: new Date(this.#now()).toISOString(),
    });
    this.#assertCompatibilityReportRunnable(report, policy);
    return report;
  }

  async #useInstallationCompatibilityReportHint(
    installation: Installation,
    source: Source,
    snapshot: SourceSnapshot,
    reportId: string,
  ): Promise<CapsuleCompatibilityReport> {
    const report = await this.#store.getCapsuleCompatibilityReport(reportId);
    if (!report) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_missing: ${reportId}`,
      );
    }
    this.#assertCompatibilityReportScopedToInstallationPlan(
      report,
      installation,
      source,
      snapshot,
    );
    const policy = await this.#policyForInstallation(installation);
    this.#assertCompatibilityReportRunnable(report, policy);
    if (installation.compatibilityReportId !== report.id) {
      await this.#store.patchInstallation(installation.id, {
        compatibilityReportId: report.id,
        compatibilityStatus: report.level,
        updatedAt: new Date(this.#now()).toISOString(),
      });
    }
    return report;
  }

  #isCompatibilityReportScopedToInstallationPlan(
    report: CapsuleCompatibilityReport,
    installation: Installation,
    source: Source,
    snapshot: SourceSnapshot,
  ): boolean {
    return (
      report.sourceSnapshotId === snapshot.id &&
      (!report.sourceId || report.sourceId === source.id) &&
      (!report.installationId || report.installationId === installation.id)
    );
  }

  #assertCompatibilityReportScopedToInstallationPlan(
    report: CapsuleCompatibilityReport,
    installation: Installation,
    source: Source,
    snapshot: SourceSnapshot,
  ): void {
    if (report.sourceSnapshotId !== snapshot.id) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_snapshot_mismatch: plan uses SourceSnapshot ` +
          `${snapshot.id} but report ${report.id} was created for ` +
          `${report.sourceSnapshotId}`,
      );
    }
    if (report.sourceId && report.sourceId !== source.id) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_source_mismatch: plan uses Source ${source.id} ` +
          `but report ${report.id} was created for ${report.sourceId}`,
      );
    }
    if (report.installationId && report.installationId !== installation.id) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_installation_mismatch: plan uses Capsule ` +
          `${installation.id} but report ${report.id} was created for ` +
          `${report.installationId}`,
      );
    }
  }

  #assertCompatibilityReportRunnable(
    report: CapsuleCompatibilityReport,
    policy?: PolicyConfig,
  ): void {
    const evaluation = evaluateCompatibilityReportAgainstPolicy(report, policy);
    if (evaluation.runnable) {
      return;
    }
    throw new OpenTofuControllerError(
      "failed_precondition",
      evaluation.reasons[0] ??
        `compatibility_report_not_runnable: report ${report.id} is ${report.level}`,
    );
  }

  async #evaluateGenericEnvProviderExecutionPolicy(input: {
    readonly profile: RunnerProfile;
    readonly installation?: Installation;
    readonly requiredProviders: readonly string[];
    readonly hasProviderEnvRunner?: boolean;
  }): Promise<{ readonly reasons: readonly string[] }> {
    if (!input.installation) return { reasons: [] };
    this.#connectionsService ??= new ConnectionsService({
      store: this.#store,
      allowOperatorBackedProviderEnvs: this.#allowOperatorBackedProviderEnvs,
    });
    const resolved = await this.#connectionsService.resolveProviderEnvBindings(
      input.installation,
    );
    const genericEnvConnections = resolved
      .map((entry) => entry.connection)
      .filter(
        (connection): connection is NonNullable<typeof connection> =>
          connection !== undefined &&
          connection.kind === "generic_env_provider",
      );
    if (genericEnvConnections.length === 0) return { reasons: [] };

    const reasons: string[] = [];
    void input.hasProviderEnvRunner;
    if (input.requiredProviders.length === 0) {
      reasons.push(
        `generic-env provider bindings on runner profile ${input.profile.id} require requiredProviders before OpenTofu init`,
      );
    }
    for (const connection of genericEnvConnections) {
      if (connection.scope !== "space") {
        reasons.push(
          `generic-env provider connection ${connection.id} for ${connection.provider} must be Space-scoped`,
        );
      }
    }
    return { reasons };
  }

  #isCustomRunnerProfile(profile: RunnerProfile): boolean {
    return profile.labels?.["takosumi.com/runner-class"] === "custom";
  }

  #hasRunnerForProfile(profile: RunnerProfile): boolean {
    return this.#isCustomRunnerProfile(profile)
      ? this.#providerEnvRunner !== undefined
      : this.#runner !== undefined;
  }

  #runnerForProfile(profile: RunnerProfile): OpenTofuRunner {
    const runner = this.#isCustomRunnerProfile(profile)
      ? this.#providerEnvRunner
      : this.#runner;
    if (!runner) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        this.#isCustomRunnerProfile(profile)
          ? `runner profile ${profile.id} requires a configured custom provider runner`
          : "OpenTofu runner is not configured",
      );
    }
    return runner;
  }

  /**
   * Threads Capsule Gate results into the plan PolicyDecision (core-spec §25)
   * without replacing the hard pre-mint guard (§26). Runnable reports keep the
   * policy passed but are still summarized in `plan.policy_evaluated` audit
   * metadata; stale/missing/non-runnable reports become policy block reasons.
   */
  async #evaluateCapsuleCompatibilityPolicy(input: {
    readonly planRunId: string;
    readonly compatibilityReportId?: string;
    readonly sourceSnapshotId?: string;
    readonly policy?: PolicyConfig;
  }): Promise<{
    readonly reasons: readonly string[];
    readonly audit?: Readonly<Record<string, JsonValue>>;
  }> {
    if (!input.compatibilityReportId) return { reasons: [] };
    const report = await this.#store.getCapsuleCompatibilityReport(
      input.compatibilityReportId,
    );
    if (!report) {
      return {
        reasons: [
          `compatibility_report_missing: plan run ${input.planRunId} references CompatibilityReport ${input.compatibilityReportId} which no longer exists`,
        ],
        audit: {
          reportId: input.compatibilityReportId,
          status: "missing",
        },
      };
    }
    const findingCounts = report.findings.reduce(
      (counts, finding) => {
        counts[finding.severity] += 1;
        return counts;
      },
      { info: 0, warning: 0, error: 0 },
    );
    const audit = {
      reportId: report.id,
      level: report.level,
      findingCount: report.findings.length,
      infoCount: findingCounts.info,
      warningCount: findingCounts.warning,
      errorCount: findingCounts.error,
    } satisfies Readonly<Record<string, JsonValue>>;
    const reasons: string[] = [];
    if (
      input.sourceSnapshotId &&
      report.sourceSnapshotId !== input.sourceSnapshotId
    ) {
      reasons.push(
        `compatibility_report_snapshot_mismatch: plan run ${input.planRunId} uses SourceSnapshot ${input.sourceSnapshotId} but report ${report.id} was created for ${report.sourceSnapshotId}`,
      );
    }
    reasons.push(
      ...evaluateCompatibilityReportAgainstPolicy(report, input.policy).reasons,
    );
    return { reasons, audit };
  }

  /**
   * Builds the {@link CreatePlanRunRequest} (+ install-type plan context) for an
   * installation-driven plan. The InstallConfig's installType selects the
   * OpenTofu surface (§10 / §13):
   *
   *   - `core` / `opentofu_module` / `app_source`: a template-bound config reuses
   *     the template plan path with an {@link InstallTypePlanContext} so the
   *     generated root comes from {@link generateInstallationRoot}. A non-template
   *     config uses the generic Capsule root builder, wrapping the SourceSnapshot
   *     module as a child module under Takosumi-owned provider/state/root wiring.
   *   - `opentofu_root`: legacy direct-root ledger rows remain readable but cannot
   *     create new plans; Takosumi v1 runs OpenTofu Capsules through a generated
   *     root.
   */
  async #installationPlanRequest(input: {
    readonly installation: Installation;
    readonly installConfig: InstallConfig;
    readonly source: Source;
    readonly snapshot: SourceSnapshot;
    readonly operation: "create" | "update" | "destroy";
    readonly compatibilityReport?: CapsuleCompatibilityReport;
  }): Promise<{
    readonly request: CreatePlanRunRequest;
    readonly installTypePlan?: InstallTypePlanContext;
    readonly genericRootPlan?: GenericRootPlanContext;
  }> {
    const moduleSource = snapshotModuleSource(input.source, input.snapshot);
    const installType = input.installConfig.installType;
    const templateBinding = installConfigTemplateBinding(input.installConfig);
    if (installType === "opentofu_root") {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `install config ${input.installConfig.id} is legacy opentofu_root; ` +
          `Takosumi v1 plans require an OpenTofu Capsule install type wrapped by ` +
          `a Takosumi generated root`,
      );
    }
    if (templateBinding) {
      // Template-backed config (core / opentofu_module / app_source): reuse the
      // template plan path. The config's variableMapping supplies the template
      // inputs (public, never secret); the user source archive is a build input
      // only. The install-type context drives the §13 generated root.
      //
      // The required providers MUST match what the dispatch path stores on the
      // plan run (`#resolveTemplatePlan`: the template's allowed providers
      // canonicalized) so rootgen and credential mint resolve the same set.
      const template = this.#templateRegistry.require(
        templateBinding.templateId,
        templateBinding.templateVersion,
      );
      const requiredProviders = template.policy.allowedProviders.map(
        canonicalProviderAddress,
      );
      const installTypePlan = await this.#planResolution.resolveInstallTypePlan(
        input.installation,
        input.installConfig,
        installType,
        requiredProviders,
      );
      return {
        request: {
          spaceId: input.installation.spaceId,
          installationId: input.installation.id,
          source: moduleSource,
          operation: input.operation,
          templateId: templateBinding.templateId,
          templateVersion: templateBinding.templateVersion,
          ...(templateBinding.inputs ? { inputs: templateBinding.inputs } : {}),
        },
        installTypePlan,
      };
    }
    const generic = await this.#genericCapsulePlanRequest(input, moduleSource);
    return {
      request: generic.request,
      genericRootPlan: generic.genericRootPlan,
    };
  }

  /**
   * Generic Capsule plan request: the snapshot source stays as the child module
   * to be copied under the Takosumi generated root. The generated root itself is
   * created after DependencySnapshot injection, because dependency values become
   * root module inputs.
   */
  async #genericCapsulePlanRequest(
    input: {
      readonly installation: Installation;
      readonly installConfig: InstallConfig;
      readonly operation: "create" | "update" | "destroy";
      readonly compatibilityReport?: CapsuleCompatibilityReport;
    },
    moduleSource: OpenTofuModuleSource,
  ): Promise<{
    readonly request: CreatePlanRunRequest;
    readonly genericRootPlan: GenericRootPlanContext;
  }> {
    const profile = await this.#requireRunnerProfile(
      this.#defaultRunnerProfileId,
    );
    const compatibilityProviders = requiredProvidersFromCompatibilityReport(
      input.compatibilityReport,
      profile.allowedProviders,
    );
    let requiredProviders =
      compatibilityProviders.length > 0
        ? compatibilityProviders
        : profile.allowedProviders.includes("*")
          ? []
          : [...profile.allowedProviders];
    let installTypePlan = await this.#planResolution.resolveInstallTypePlan(
      input.installation,
      input.installConfig,
      input.installConfig.installType,
      requiredProviders,
    );
    const bindingProviders = requiredProvidersFromProviderEnvBindings(
      installTypePlan.providerEnvBindings,
    );
    if (
      requiredProviders.length === 0 &&
      profile.allowedProviders.includes("*") &&
      bindingProviders.length > 0
    ) {
      requiredProviders = bindingProviders;
      installTypePlan = await this.#planResolution.resolveInstallTypePlan(
        input.installation,
        input.installConfig,
        input.installConfig.installType,
        requiredProviders,
      );
    }
    const variables = normalizeVariables(
      mergeJsonVariableDefaults(
        installTypePlan.providerInputDefaults,
        input.installConfig.variableMapping,
      ),
    );
    return {
      request: {
        spaceId: input.installation.spaceId,
        installationId: input.installation.id,
        source: moduleSource,
        operation: input.operation,
        runnerProfileId: profile.id,
        requiredProviders,
        ...(Object.keys(variables).length > 0 ? { variables } : {}),
      },
      genericRootPlan: {
        providerEnvBindings: installTypePlan.providerEnvBindings,
        outputAllowlist: input.installConfig.outputAllowlist,
        ...(installTypePlan.build ? { build: installTypePlan.build } : {}),
      },
    };
  }

  async #genericRootDispatchForRequest(
    request: CreatePlanRunRequest,
    context: GenericRootPlanContext,
    compatibilityReport: CapsuleCompatibilityReport | undefined,
    sourceSnapshot: SourceSnapshot | undefined,
  ): Promise<GenericRootDispatchContext> {
    const requiredProviders = normalizeProviders(
      request.requiredProviders ?? [],
    );
    const moduleFiles =
      context.moduleFiles ??
      (compatibilityReport && sourceSnapshot
        ? await this.#normalizedModuleFilesForReport(
            compatibilityReport,
            sourceSnapshot,
          )
        : undefined);
    return {
      generatedRoot: {
        ...generateGenericCapsuleRoot({
          requiredProviders,
          inputs: normalizeVariables(request.variables),
          outputAllowlist: context.outputAllowlist,
          ...(context.providerEnvBindings.length > 0
            ? { providerEnvBindings: context.providerEnvBindings }
            : {}),
        }),
        ...(moduleFiles && moduleFiles.length > 0 ? { moduleFiles } : {}),
      },
      outputAllowlist: context.outputAllowlist,
      ...(context.build ? { build: context.build } : {}),
    };
  }

  async #defaultGenericRootDispatchForPlanRun(
    request: CreatePlanRunRequest,
    installation: Installation,
    compatibilityReportId: string | undefined,
    sourceSnapshotId: string | undefined,
  ): Promise<GenericRootDispatchContext> {
    const installConfig = await this.#store.getInstallConfig(
      installation.installConfigId,
    );
    if (!installConfig) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `install_config_not_found: ${installation.installConfigId}`,
      );
    }
    const compatibilityReport = compatibilityReportId
      ? await this.#store.getCapsuleCompatibilityReport(compatibilityReportId)
      : undefined;
    const sourceSnapshot = sourceSnapshotId
      ? await this.#store.getSourceSnapshot(sourceSnapshotId)
      : undefined;
    const requiredProviders = normalizeProviders(
      request.requiredProviders ?? installConfig.policy.allowedProviders ?? [],
    );
    const resolved = await this.#resolveInstallationProviderEnvBindingsForRun(
      installation,
      requiredProviders,
    );
    return await this.#genericRootDispatchForRequest(
      request,
      {
        providerEnvBindings: providerEnvBindingsFromResolved(resolved),
        outputAllowlist: installConfig.outputAllowlist,
        ...(installConfig.build?.enabled
          ? { build: installConfigBuildSpec(installConfig.build) }
          : {}),
      },
      compatibilityReport,
      sourceSnapshot,
    );
  }

  async #normalizedModuleFilesForReport(
    report: CapsuleCompatibilityReport,
    sourceSnapshot: SourceSnapshot,
  ): Promise<readonly OpenTofuCapsuleSourceFile[] | undefined> {
    if (report.level !== "auto_capsulized") return undefined;
    if (!report.normalizedObjectKey || !report.normalizedDigest) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `normalized_capsule_artifact_missing: CompatibilityReport ${report.id} ` +
          "is auto_capsulized but has no normalizedObjectKey/normalizedDigest",
      );
    }
    if (!this.#sourcesService) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "normalized capsule artifact reader is not configured",
      );
    }
    return await this.#sourcesService.readNormalizedCapsuleArtifact({
      sourceSnapshot,
      objectKey: report.normalizedObjectKey,
      digest: report.normalizedDigest as `sha256:${string}`,
    });
  }

  /**
   * Run-scoped provider env binding resolution. Required providers must be
   * covered by explicit Installation provider env bindings.
   * Lazily constructs the shared {@link ConnectionsService} so the SAME instance
   * resolves provider env bindings for rootgen (via {@link PlanResolutionService}) and for the
   * mint path (`#resolveRunInstallationProviderEnvBindings`).
   */
  #resolveInstallationProviderEnvBindingsForRun(
    installation: Installation,
    requiredProviders: readonly string[],
  ): Promise<readonly ResolvedInstallationProviderEnvBinding[]> {
    this.#connectionsService ??= new ConnectionsService({
      store: this.#store,
      allowOperatorBackedProviderEnvs: this.#allowOperatorBackedProviderEnvs,
    });
    return this.#connectionsService.resolveProviderEnvBindingsForRun(
      installation,
      requiredProviders,
    );
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

  async #currentDeploymentSourceSnapshotId(
    installation: Installation,
  ): Promise<string | undefined> {
    if (!installation.currentDeploymentId) return undefined;
    const deployment = await this.#store.getDeployment(
      installation.currentDeploymentId,
    );
    if (
      !deployment ||
      deployment.installationId !== installation.id ||
      deployment.environment !== installation.environment
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `installation ${installation.id} current Deployment ${installation.currentDeploymentId} is not available for destroy planning`,
      );
    }
    return deployment.sourceSnapshotId;
  }

  async #destroySourceSnapshotIdForUploadInstallation(
    installation: Installation,
  ): Promise<string | undefined> {
    return (
      (await this.#currentDeploymentSourceSnapshotId(installation)) ??
      (await this.#currentStateSourceSnapshotId(installation))
    );
  }

  async #currentStateSourceSnapshotId(
    installation: Installation,
  ): Promise<string | undefined> {
    if (installation.currentStateGeneration <= 0) return undefined;
    const snapshots = await this.#store.listStateSnapshots(
      installation.id,
      installation.environment,
    );
    const current = snapshots.find(
      (snapshot) => snapshot.generation === installation.currentStateGeneration,
    );
    return current
      ? await this.#sourceSnapshotIdForStateSnapshot(current, new Set())
      : undefined;
  }

  async #sourceSnapshotIdForStateSnapshot(
    snapshot: StateSnapshot,
    seenStateSnapshotIds: Set<string>,
  ): Promise<string | undefined> {
    if (seenStateSnapshotIds.has(snapshot.id)) return undefined;
    seenStateSnapshotIds.add(snapshot.id);

    const applyRun = await this.#store.getApplyRun(snapshot.createdByRunId);
    if (applyRun) {
      const planRun = await this.#store.getPlanRun(applyRun.planRunId);
      return planRun?.sourceSnapshotId;
    }

    const restoreRun = await this.#store.getBackupRun(snapshot.createdByRunId);
    if (
      restoreRun?.type !== "restore" ||
      !restoreRun.restoredFromStateSnapshotId
    ) {
      return undefined;
    }
    const restoredSource = (
      await this.#store.listStateSnapshots(
        snapshot.installationId,
        snapshot.environment,
      )
    ).find(
      (candidate) => candidate.id === restoreRun.restoredFromStateSnapshotId,
    );
    return restoredSource
      ? await this.#sourceSnapshotIdForStateSnapshot(
          restoredSource,
          seenStateSnapshotIds,
        )
      : undefined;
  }

  async createApplyRun(
    request: CreateApplyRunRequest,
    context: DeployControlActorContext = {},
  ): Promise<ApplyRunResponse> {
    await this.#seededProfiles;
    requireNonEmptyString(request.planRunId, "planRunId");
    const planRun = await this.#requirePlanRun(request.planRunId);
    // A §19 drift_check is a read-only signal: it can NEVER be applied (Phase 8).
    // Rejected up front, independent of status, so a succeeded drift check cannot
    // be promoted into a write run.
    if (planRun.driftCheck === true) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} is a drift_check and cannot be applied`,
      );
    }
    if (planRun.status !== "succeeded") {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} is ${planRun.status}; apply requires a succeeded plan`,
      );
    }
    if (planRun.policy.status !== "passed") {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} did not pass policy`,
      );
    }
    if (!planRun.planArtifact) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} has no immutable plan artifact`,
      );
    }
    // SECURITY (apply-once / idempotency): a `create` plan never carries an
    // installationId, so without this guard each apply allocates a brand-new
    // Installation + Deployment (and real cloud resources). Reject any apply of a
    // PlanRun that has already been successfully applied. (update/destroy were
    // already replay-protected by the installation currentDeploymentId guard.)
    //
    // This is an OPTIMISTIC pre-check before the per-(Installation,environment)
    // lease serializes the apply. Two concurrent createApplyRun calls can both
    // pass it and each insert an ApplyRun row + enqueue — wasteful, but NOT a
    // double-apply: the authoritative apply-once re-check runs INSIDE the
    // serialized section against the persisted PlanRun (see
    // `appliedApplyRunId` re-read in the commit path), so the second worker's
    // dispatch is rejected before it commits any state generation. The pre-
    // check stays as a cheap early-out for the common (non-concurrent) case.
    if (planRun.appliedApplyRunId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} has already been applied by apply run ${planRun.appliedApplyRunId}`,
      );
    }
    // Destructive-confirmation gate (Phase 1C): a template plan-JSON policy that
    // flagged delete/replace under requireExplicitConfirmation requires the apply
    // request to carry confirmDestructive=true. Non-template and non-destructive
    // plans are unaffected.
    if (
      planRun.templateBinding?.requiresConfirmation === true &&
      request.confirmDestructive !== true
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} contains destructive changes; resubmit apply with confirmDestructive=true`,
      );
    }
    // Approval gate (spec §10.6 always-two-stage destroy / invariant 22). A
    // destroy plan is "always two-stage": it must carry a RECORDED approval
    // (POST /runs/:id/approve, which sets planRun.approval) before it can apply.
    // Without this the approval surfaced as `awaitingApproval` in the dashboard
    // is display-only and the single most destructive operation would apply
    // unreviewed. (A non-destroy delete/replace flagged `requiresApproval` is
    // additionally gated by the confirmDestructive flow above for template
    // Capsules; broadening the recorded-approval requirement to every
    // requiresApproval plan is a separate, intentional decision.)
    if (planRun.operation === "destroy" && !planRun.approval) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} is a destroy awaiting approval; approve it (POST /runs/${planRun.id}/approve) before apply`,
      );
    }
    await checkApplyExpected(request.expected, planRun);
    if (planRun.installationId) {
      await this.#requireCurrentPlannedInstallation(planRun);
    }
    // Source snapshot revalidation (spec invariant 10): an env-driven plan is
    // pinned to a SourceSnapshot; the apply must run against the SAME snapshot
    // the plan was reviewed against. Re-read the persisted plan and confirm its
    // sourceSnapshotId is unchanged + still resolvable, mirroring the
    // digest/generation guards. Runs without a recorded snapshot are unaffected.
    await this.#verification.revalidateSourceSnapshot(planRun);
    const profile = await this.#requireRunnerProfile(planRun.runnerProfileId);
    const now = this.#now();
    const approval = redactRunApproval(request.approval);
    const applyRun: ApplyRun = {
      id: this.#newId("apply"),
      planRunId: planRun.id,
      spaceId: planRun.spaceId,
      ...(planRun.installationId
        ? { installationId: planRun.installationId }
        : {}),
      operation: planRun.operation,
      runnerProfileId: profile.id,
      status: "queued",
      ...(approval ? { approval } : {}),
      expected: request.expected,
      stateBackend: profile.stateBackend,
      stateLock: stateLockEvidence(profile.stateBackend, now, now, "pending"),
      auditEvents: [
        auditEvent(
          "apply",
          "apply.queued",
          now,
          {
            planRunId: planRun.id,
            runnerProfileId: profile.id,
          },
          context.actor,
        ),
      ],
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.putApplyRun(applyRun);
    if (!this.#hasRunnerForProfile(profile)) return { applyRun };
    // Hand off to the dispatch seam. The default inline dispatcher runs the
    // apply consumer synchronously and returns the terminal ApplyRunResponse;
    // the Workers producer enqueues and returns the queued ApplyRun immediately.
    await this.#enqueueRun({
      action: "apply",
      runId: applyRun.id,
      spaceId: applyRun.spaceId,
    });
    const dispatched = await this.getApplyRun(applyRun.id);
    return dispatched;
  }

  /**
   * Queue-consumer entry point. Routes a dispatched run to the plan or apply
   * consumer. Both the default inline dispatcher and the Workers `queue()`
   * consumer call this. Errors propagate so the queue can retry (the apply/plan
   * consumers themselves convert runner failures into recorded `failed` runs and
   * only rethrow infrastructure/transport errors).
   */
  async dispatchQueuedRun(dispatch: OpenTofuRunDispatch): Promise<void> {
    if (dispatch.action === "plan") {
      await this.runQueuedPlan(dispatch.runId);
      return;
    }
    if (dispatch.action === "source_sync") {
      await this.runQueuedSourceSync(dispatch.runId);
      return;
    }
    if (dispatch.action === "restore") {
      await this.runQueuedRestore(dispatch.runId);
      return;
    }
    await this.runQueuedApply(dispatch.runId);
  }

  async runQueuedRestore(runId: string): Promise<Run | undefined> {
    const run = await this.#store.getBackupRun(runId);
    if (!run || run.type !== "restore") return undefined;
    if (!this.#shouldProcessRun(run.status, run.heartbeatAt)) return run;
    let leaseTarget: {
      readonly installationId: string;
      readonly environment: string;
    };
    try {
      leaseTarget = await this.#restoreLeaseTarget(run);
    } catch (error) {
      await this.#failRestoreRun(run, undefined, error);
      throw error;
    }
    const runWork = (handle?: LeaseHandle) =>
      this.#runSerialized(
        `restore:${leaseTarget.installationId}:${leaseTarget.environment}`,
        () => this.#executeRestore(run, handle),
      );
    if (this.#installationCoordination) {
      return await withInstallationLease(
        this.#installationCoordination,
        {
          installationId: leaseTarget.installationId,
          environment: leaseTarget.environment,
          holderId: run.id,
        },
        runWork,
      );
    }
    return await runWork();
  }

  async #restoreLeaseTarget(run: Run): Promise<{
    readonly installationId: string;
    readonly environment: string;
  }> {
    if (!run.backupId || run.restoreStateGeneration === undefined) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "restore run is missing backupId or restoreStateGeneration",
      );
    }
    const backup = await this.#store.getBackupRecord(run.backupId);
    if (!backup || backup.spaceId !== run.spaceId) {
      throw new OpenTofuControllerError(
        "not_found",
        `backup ${run.backupId} not found`,
      );
    }
    if (run.planDigest && backup.digest !== run.planDigest) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "backup digest changed before restore dispatch",
      );
    }
    const installationId = run.installationId ?? backup.installationId;
    if (!installationId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "restore run has no target installation",
      );
    }
    const installation = await this.#store.getInstallation(installationId);
    if (!installation || installation.spaceId !== run.spaceId) {
      throw new OpenTofuControllerError(
        "not_found",
        `installation ${installationId} not found`,
      );
    }
    const environment =
      run.environment ?? backup.environment ?? installation.environment;
    return { installationId: installation.id, environment };
  }

  async #executeRestore(run: Run, lease?: LeaseHandle): Promise<Run> {
    const current = await this.#store.getBackupRun(run.id);
    if (!current || current.type !== "restore") return run;
    if (!this.#shouldProcessRun(current.status, current.heartbeatAt)) {
      return current;
    }
    const startedAtMs = this.#now();
    const startedAt = new Date(startedAtMs).toISOString();
    const running: Run = {
      ...current,
      status: "running",
      startedAt: current.startedAt ?? startedAt,
      heartbeatAt: startedAtMs,
    };
    const claim = await this.#claimRestoreRunning(
      current.status,
      running,
      startedAtMs,
      current.heartbeatAt ?? null,
    );
    if (!claim.won) return claim.run;
    try {
      return await this.#withRunRenewal(
        "restore",
        claim.run,
        claim.leaseToken,
        lease,
        () => this.#completeRestoreRun(claim.run, claim.leaseToken),
      );
    } catch (error) {
      await this.#failRestoreRun(claim.run, claim.leaseToken, error);
      throw error;
    }
  }

  async #completeRestoreRun(run: Run, leaseToken: string): Promise<Run> {
    if (!run.backupId || run.restoreStateGeneration === undefined) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "restore run is missing backupId or restoreStateGeneration",
      );
    }
    const backup = await this.#store.getBackupRecord(run.backupId);
    if (!backup || backup.spaceId !== run.spaceId) {
      throw new OpenTofuControllerError(
        "not_found",
        `backup ${run.backupId} not found`,
      );
    }
    if (run.planDigest && backup.digest !== run.planDigest) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "backup digest changed before restore dispatch",
      );
    }
    const installationId = run.installationId ?? backup.installationId;
    if (!installationId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "restore run has no target installation",
      );
    }
    const installation = await this.#store.getInstallation(installationId);
    if (!installation || installation.spaceId !== run.spaceId) {
      throw new OpenTofuControllerError(
        "not_found",
        `installation ${installationId} not found`,
      );
    }
    const environment =
      run.environment ?? backup.environment ?? installation.environment;
    const source = (
      await this.#store.listStateSnapshots(installation.id, environment)
    ).find((snapshot) => snapshot.generation === run.restoreStateGeneration);
    if (!source) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `state generation ${run.restoreStateGeneration} is not available for restore`,
      );
    }
    if (
      run.restoredFromStateSnapshotId &&
      run.restoredFromStateSnapshotId !== source.id
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "restore source StateSnapshot changed before dispatch",
      );
    }
    const latest = await this.#store.getLatestStateSnapshot(
      installation.id,
      environment,
    );
    const nextGeneration =
      Math.max(installation.currentStateGeneration, latest?.generation ?? 0) +
      1;
    const nowMs = this.#now();
    const now = new Date(nowMs).toISOString();
    const stateScope = {
      spaceId: installation.spaceId,
      installationId: installation.id,
      environment,
      generation: nextGeneration,
    };
    const restoreServiceData = run.restoreServiceData === true;
    if (restoreServiceData && !backup.serviceData) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "backup service-data artifact disappeared before restore dispatch",
      );
    }
    if (restoreServiceData && !this.#runner?.restoreServiceData) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "service-data restore requires a service-data restore-capable runner",
      );
    }
    const restoreResult = this.#runner?.restore
      ? await this.#runner.restore({
          runId: run.id,
          stateScope,
          sourceState: {
            objectKey: source.objectKey,
            digest: source.digest,
          },
        })
      : undefined;
    const restoredServiceData = restoreServiceData
      ? await this.#runner!.restoreServiceData!({
          runId: run.id,
          stateScope,
          sourceState: {
            objectKey: source.objectKey,
            digest: source.digest,
          },
          serviceData: backup.serviceData!,
        })
      : undefined;
    if (restoreServiceData && restoredServiceData?.status !== "restored") {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "runner did not confirm service-data restore",
      );
    }
    const restoredState: StateSnapshot = {
      id: this.#newId("state"),
      spaceId: installation.spaceId,
      installationId: installation.id,
      environment,
      generation: nextGeneration,
      objectKey: restoreResult?.state.objectKey ?? source.objectKey,
      digest: restoreResult?.state.digest ?? source.digest,
      createdByRunId: run.id,
      createdAt: now,
    };
    const sourceOutput = (
      await this.#store.listOutputSnapshots(installation.id)
    ).find((snapshot) => snapshot.stateGeneration === source.generation);
    const previousOutputSnapshot = installation.currentOutputSnapshotId
      ? await this.#store.getOutputSnapshot(
          installation.currentOutputSnapshotId,
        )
      : undefined;
    const completed: Run = {
      ...run,
      status: "succeeded",
      heartbeatAt: nowMs,
      restoredStateSnapshotId: restoredState.id,
      ...(restoredServiceData ? { restoredServiceData } : {}),
      finishedAt: now,
    };
    const committed = await this.#store.commitRestoredState({
      stateSnapshot: restoredState,
      installationPatch: {
        id: installation.id,
        patch: {
          currentStateGeneration: nextGeneration,
          ...(sourceOutput ? { currentOutputSnapshotId: sourceOutput.id } : {}),
          status: "stale",
          updatedAt: now,
        },
        guard: {
          currentStateGeneration: installation.currentStateGeneration,
          status: installation.status,
        },
      },
      restoreRunTerminal: completed,
      restoreRunLeaseToken: leaseToken,
    });
    if (committed.restoreRunLeaseLost) {
      return (await this.#store.getBackupRun(run.id)) ?? run;
    }
    if (sourceOutput) {
      await this.#markDownstreamInstallationsStale({
        installation,
        previousOutputSnapshot,
        newOutputSnapshot: sourceOutput,
        now: nowMs,
      });
    }
    await this.#recordActivity({
      spaceId: run.spaceId,
      action: "restore.succeeded",
      targetType: "run",
      targetId: run.id,
      runId: run.id,
      metadata: {
        backupId: backup.id,
        installationId: installation.id,
        environment,
        restoredStateSnapshotId: restoredState.id,
        restoredFromStateSnapshotId: source.id,
        restoredFromGeneration: source.generation,
        currentStateGeneration: nextGeneration,
        ...(restoredServiceData
          ? {
              restoredServiceDataObjectKey: restoredServiceData.objectKey,
              restoredServiceDataDigest: restoredServiceData.digest,
              restoredServiceDataCount: restoredServiceData.restoredCount ?? 0,
            }
          : {}),
      },
    });
    return completed;
  }

  /**
   * Source-sync consumer (Core Specification §6). Idempotency guard, transition
   * to `running`, mint source-phase credentials NOW (git-only; never provider),
   * dispatch to the runner, and on success record the SourceSnapshot + update the
   * Source's `lastSeenCommit`. Never logs credential material. Delegates to
   * {@link SourceLifecycleService}; kept on the controller surface so the queue
   * consumer and the inline dispatcher keep calling it unchanged.
   */
  async runQueuedSourceSync(runId: string): Promise<SourceSyncRun | undefined> {
    return await this.#sourceLifecycle.runQueuedSourceSync(runId);
  }

  /**
   * Dead-letter backstop. Marks a run failed with the given reason when it is
   * not already settled (succeeded/failed/waiting_approval/expired/cancelled).
   * Used by the DLQ consumer for runs whose consumer crashed before it could
   * record failure.
   * Returns true when it transitioned the run.
   */
  async markRunFailed(
    action: "plan" | "apply" | "restore",
    runId: string,
    reason: string,
  ): Promise<boolean> {
    if (action === "plan") {
      const planRun = await this.#store.getPlanRun(runId);
      if (!planRun || isTerminalStatus(planRun.status)) return false;
      if (planRun.status === "running") return false;
      await this.#failPlanRun(planRun, undefined, new Error(reason));
      await this.#store.deletePlanRunInputs(runId);
      return true;
    }
    if (action === "restore") {
      const run = await this.#store.getBackupRun(runId);
      if (!run || run.type !== "restore" || isTerminalStatus(run.status)) {
        return false;
      }
      if (run.status === "running") return false;
      const failed: Run = {
        ...run,
        status: "failed",
        heartbeatAt: this.#now(),
        errorCode: reason,
        finishedAt: new Date(this.#now()).toISOString(),
      };
      const result = await this.#store.transitionRun({
        id: run.id,
        kind: "restore",
        expectFrom: [run.status],
        run: failed,
        clearLeaseToken: true,
        heartbeatAt: failed.heartbeatAt,
      });
      return result.won;
    }
    const applyRun = await this.#store.getApplyRun(runId);
    if (!applyRun || isTerminalStatus(applyRun.status)) return false;
    if (applyRun.status === "running") return false;
    const profile = await this.#requireRunnerProfile(applyRun.runnerProfileId);
    await this.#failApplyRun(
      applyRun,
      undefined,
      profile,
      applyRun.startedAt ?? applyRun.createdAt,
      "apply.failed",
      new Error(reason),
    );
    return true;
  }

  /**
   * Plan consumer. Idempotency guard (only `queued`, or `running` with a stale
   * heartbeat, proceeds), transition to `running` with startedAt + heartbeatAt,
   * mint credentials NOW, attach them to the runner dispatch ONLY, and record
   * the terminal status. Returns the resulting PlanRun (used by the inline
   * dispatcher); the Workers consumer ignores the return value and polls the
   * store.
   */
  async runQueuedPlan(runId: string): Promise<PlanRun | undefined> {
    let planRun = await this.#store.getPlanRun(runId);
    if (!planRun) {
      throw new OpenTofuControllerError(
        "not_found",
        `plan run ${runId} not found`,
      );
    }
    if (!this.#shouldProcessRun(planRun.status, planRun.heartbeatAt)) {
      // Terminal, or a sibling consumer holds it with a fresh heartbeat: no-op.
      return planRun;
    }
    const profile = await this.#requireRunnerProfile(planRun.runnerProfileId);
    if (!this.#hasRunnerForProfile(profile)) return planRun;
    try {
      planRun = await this.#ensureQueuedPlanCompatibilityReport(planRun);
    } catch (error) {
      await this.#store.deletePlanRunInputs(runId);
      return await this.#failPlanRun(planRun, undefined, error);
    }
    // The sidecar is sealed at rest when a sensitive dependency value was
    // injected; #getPlanRunInputs unseals it transparently here so the plan runs
    // against the same inputs / generated root it was created with.
    const inputs = await this.#getPlanRunInputs(runId);
    const variables = normalizeVariables(inputs?.variables);
    const dispatch = templateDispatchFromInputs(inputs);
    try {
      await this.#verification.assertCapsuleCompatibilityAllowsRun(planRun);
      assertGeneratedRootDispatchPresent(planRun, dispatch);
    } catch (error) {
      await this.#store.deletePlanRunInputs(runId);
      return await this.#failPlanRun(planRun, undefined, error);
    }
    const claim = await this.#markPlanRunning(planRun);
    if (!claim.won) {
      // A sibling consumer already claimed this run (or a cancel won the row).
      // Do NOT dispatch the runner; return the row the winner persisted.
      return claim.run;
    }
    const running = claim.run;
    let result: PlanRun;
    try {
      const runEnvironment = await this.#runEnv.resolveRunEnvironment({
        planRun,
        phase: "plan",
        auditRunId: planRun.id,
      });
      const runningWithEnv = withRunEnvironmentEvidence(
        running,
        runEnvironment,
      );
      result = await this.#executePlan(
        runningWithEnv,
        claim.leaseToken,
        profile,
        variables,
        runEnvironment.credentials,
        dispatch,
      );
    } catch (error) {
      await this.#store.deletePlanRunInputs(runId);
      const failedRun = runEnvironmentFailedRun(running, error);
      return await this.#failPlanRun(failedRun, claim.leaseToken, error);
    }
    // Retain the inputs sidecar for an APPLYABLE generated-root run: the apply
    // consumer re-reads the generated root / build payload (the same generated
    // root the plan was reviewed against). An applyable plan is one that
    // completed `succeeded`, OR parked `waiting_approval` (it becomes applyable
    // once approved — the sidecar must survive the approval gate). It is deleted
    // once the plan is applied (apply-once) or the run is failed. Other terminal
    // generated-root plans drop the sidecar now.
    const retainForApply =
      (result.status === "succeeded" || result.status === "waiting_approval") &&
      dispatch.generatedRoot !== undefined;
    if (!retainForApply) {
      await this.#store.deletePlanRunInputs(runId);
    }
    return result;
  }

  /**
   * Apply consumer. Idempotency + stale-heartbeat takeover, generation
   * pre-flight, credential mint, and serialized execution on the installation
   * key. Returns the ApplyRunResponse for the inline dispatcher.
   */
  async runQueuedApply(runId: string): Promise<ApplyRunResponse> {
    const applyRun = await this.#store.getApplyRun(runId);
    if (!applyRun) {
      throw new OpenTofuControllerError(
        "not_found",
        `apply run ${runId} not found`,
      );
    }
    if (!this.#shouldProcessRun(applyRun.status, applyRun.heartbeatAt)) {
      return await this.getApplyRun(runId);
    }
    const planRun = await this.#requirePlanRun(applyRun.planRunId);
    const profile = await this.#requireRunnerProfile(applyRun.runnerProfileId);
    if (!this.#hasRunnerForProfile(profile)) return { applyRun };
    // Generated-root dispatch for apply: re-read the retained inputs sidecar so
    // apply runs tofu in the SAME generated root the plan reviewed.
    // #getPlanRunInputs unseals a sealed (sensitive-bearing) sidecar.
    const inputs = await this.#getPlanRunInputs(planRun.id);
    const dispatch = templateDispatchFromInputs(inputs);
    const key = planRun.installationId ?? planRun.id;
    // Installation lease (spec §22 / §23): when a DO-backed coordination seam is
    // wired, acquire the cross-isolate
    // `installation:{installationId}:{environment}` lease so only one write run
    // per (Installation, environment) executes at a time. A busy lease throws so
    // the queue redelivers. The in-process serialization stays as the inner
    // guard (single-isolate correctness). The held-lease handle is threaded into
    // #executeApply so a long apply can renew the lease + re-stamp its heartbeat
    // while a single blocking runner fetch is in flight.
    const runWork = (handle?: LeaseHandle) =>
      this.#runSerialized(key, () =>
        this.#executeApply(applyRun, planRun, profile, dispatch, handle),
      );
    if (this.#installationCoordination && planRun.installationId) {
      const environment =
        planRun.installationContext?.environment ??
        (await this.#requireInstallation(planRun.installationId)).environment;
      return await withInstallationLease(
        this.#installationCoordination,
        {
          installationId: planRun.installationId,
          environment,
          holderId: applyRun.id,
        },
        runWork,
      );
    }
    // SECURITY (apply-once / S5): a `create` plan has no installationId yet, so
    // the installation lease above cannot cover it. Without a cross-isolate
    // guard two concurrent create-applies of the SAME plan both observe
    // `appliedApplyRunId` undefined and each allocate a brand-new Installation +
    // Deployment (real duplicate cloud resources). Take the `plan:{planRunId}`
    // lease so create-applies serialize; the inner #executeApply re-reads the
    // persisted PlanRun and rejects a sibling that already marked it applied.
    if (this.#installationCoordination) {
      return await withPlanLease(
        this.#installationCoordination,
        { planRunId: planRun.id, holderId: applyRun.id },
        runWork,
      );
    }
    return await runWork();
  }

  /**
   * Idempotency predicate for the queue consumer. Proceed when the run is still
   * `queued`, or when it is `running` but its heartbeat is stale (a prior
   * consumer crashed mid-run). A fresh `running` heartbeat means a sibling
   * consumer owns the run; terminal states are never reprocessed.
   */
  #shouldProcessRun(
    status: RunStatus,
    heartbeatAt: number | undefined,
  ): boolean {
    if (status === "queued") return true;
    if (status !== "running") return false;
    const last = heartbeatAt ?? 0;
    return this.#now() - last > RUN_HEARTBEAT_STALE_MS;
  }

  async #ensureQueuedPlanCompatibilityReport(
    planRun: PlanRun,
  ): Promise<PlanRun> {
    if (
      planRun.compatibilityReportId ||
      !planRun.installationId ||
      !planRun.sourceSnapshotId ||
      !this.#sourcesService
    ) {
      return planRun;
    }
    const installation = await this.#requireInstallation(
      planRun.installationId,
    );
    const snapshot = await this.#store.getSourceSnapshot(
      planRun.sourceSnapshotId,
    );
    if (!snapshot) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `source_snapshot_missing: plan run ${planRun.id} references ` +
          `SourceSnapshot ${planRun.sourceSnapshotId} which is no longer present`,
      );
    }
    const source = installation.sourceId
      ? await this.#requireSourceForInstallation(installation)
      : syntheticUploadSource(installation, snapshot);
    const report = await this.#ensureInstallationCompatibilityReport(
      installation,
      source,
      snapshot,
    );
    if (!report) return planRun;
    await this.#refreshPlanRunInputsForCompatibilityReport(
      planRun,
      report,
      snapshot,
    );
    const updated: PlanRun = {
      ...planRun,
      compatibilityReportId: report.id,
      updatedAt: this.#now(),
    };
    await this.#store.putPlanRun(updated);
    return updated;
  }

  async #requireSourceForInstallation(
    installation: Installation,
  ): Promise<Source> {
    if (!installation.sourceId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `installation ${installation.id} has no Source`,
      );
    }
    const source = await this.#store.getSource(installation.sourceId);
    if (!source) {
      throw new OpenTofuControllerError(
        "not_found",
        `source ${installation.sourceId} not found for installation ${installation.id}`,
      );
    }
    return source;
  }

  async #refreshPlanRunInputsForCompatibilityReport(
    planRun: PlanRun,
    report: CapsuleCompatibilityReport,
    snapshot: SourceSnapshot,
  ): Promise<void> {
    if (report.level !== "auto_capsulized") return;
    const rawInputs = await this.#store.getPlanRunInputs(planRun.id);
    if (!rawInputs) return;
    const inputs = await this.#getPlanRunInputs(planRun.id);
    if (!inputs?.generatedRoot) return;
    const moduleFiles = await this.#normalizedModuleFilesForReport(
      report,
      snapshot,
    );
    if (!moduleFiles || moduleFiles.length === 0) return;
    await this.#putPlanRunInputs(
      {
        ...inputs,
        generatedRoot: {
          ...inputs.generatedRoot,
          moduleFiles,
        },
      },
      rawInputs.sealed !== undefined,
    );
  }

  /**
   * Persists the runs_inputs sidecar (spec §11 / §18). When `seal` is set, the
   * sidecar carries at least one SENSITIVE dependency-injected value — in
   * `variables` and (for a generic Capsule) baked as a literal into the generated
   * `main.tf` — so the WHOLE sealable payload (`variables` / `generatedRoot` /
   * `outputAllowlist` / `build`) is encrypted into {@link PlanRunInputs.sealed}
   * with the SAME at-rest envelope used for state / plan / dependency-value
   * artifacts, and the cleartext fields are dropped from the row. The store only
   * ever sees ciphertext. A sealer is REQUIRED in that case: missing ⇒ fail closed
   * (the dependency-snapshot seal would already have failed closed upstream, but
   * this never persists a cleartext credential under any path). When `seal` is
   * unset the sidecar is plain (no sensitive value to protect).
   */
  async #putPlanRunInputs(inputs: PlanRunInputs, seal: boolean): Promise<void> {
    if (!seal) {
      await this.#store.putPlanRunInputs(inputs);
      return;
    }
    if (!this.#dependencyValueSealer) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `dependency_value_sealer_unavailable: plan run ${inputs.planRunId} ` +
          `carries a sensitive dependency-injected value but no at-rest value ` +
          `sealer is configured to protect the runs_inputs sidecar`,
      );
    }
    const payload: Record<string, JsonValue> = {
      variables: inputs.variables as JsonValue,
      ...(inputs.generatedRoot
        ? { generatedRoot: inputs.generatedRoot as unknown as JsonValue }
        : {}),
      ...(inputs.outputAllowlist
        ? { outputAllowlist: inputs.outputAllowlist as unknown as JsonValue }
        : {}),
      ...(inputs.build ? { build: inputs.build as unknown as JsonValue } : {}),
    };
    const sealed = await this.#dependencyValueSealer.seal(payload);
    // Cleartext sealable fields are dropped; only `planRunId` + `sealed` persist.
    await this.#store.putPlanRunInputs({
      planRunId: inputs.planRunId,
      variables: {},
      sealed,
    });
  }

  /**
   * Reads the runs_inputs sidecar, transparently unsealing a sensitive-bearing
   * row (spec §11 / §18) back into the full {@link PlanRunInputs} shape so plan /
   * apply dispatch sees the same inputs / generated root the plan was created
   * with. A sealed row with no configured sealer fails closed; a tampered/wrong
   * key blob fails closed at the AES-GCM auth tag + content digest inside the
   * sealer. A plain row is returned unchanged.
   */
  async #getPlanRunInputs(
    planRunId: string,
  ): Promise<PlanRunInputs | undefined> {
    const row = await this.#store.getPlanRunInputs(planRunId);
    if (!row?.sealed) return row;
    if (!this.#dependencyValueSealer) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `dependency_value_sealer_unavailable: plan run ${planRunId} sealed its ` +
          `runs_inputs sidecar but no at-rest value sealer is configured to ` +
          `open it`,
      );
    }
    const payload = await this.#dependencyValueSealer.open(row.sealed);
    const variables = (payload.variables ?? {}) as Readonly<
      Record<string, JsonValue>
    >;
    const generatedRoot = payload.generatedRoot as unknown as
      | DispatchGeneratedRoot
      | undefined;
    const outputAllowlist = payload.outputAllowlist as unknown as
      | Readonly<Record<string, OutputAllowlistEntry>>
      | undefined;
    const build = payload.build as unknown as DispatchBuildSpec | undefined;
    return {
      planRunId,
      variables,
      ...(generatedRoot ? { generatedRoot } : {}),
      ...(outputAllowlist ? { outputAllowlist } : {}),
      ...(build ? { build } : {}),
    };
  }

  /**
   * Builds the §6.9 StateSnapshot metadata for a successful env-driven apply /
   * destroy state persist. The object key mirrors the DO's R2_STATE key formula
   * (`spaces/{spaceId}/installations/{installationId}/envs/{environment}/states/{NNNNNNNN}.tfstate.enc`)
   * so the ledger pointer matches the encrypted object the DO wrote at the same
   * generation. Returns `undefined` for a run without environment context. The
   * digest is the plaintext digest the runner DO echoed back, when present. The
   * record is PERSISTED atomically with the Deployment / OutputSnapshot /
   * Installation advance by {@link OpenTofuDeploymentStore.commitAppliedDeployment}.
   */
  #buildStateSnapshot(input: {
    readonly envDispatch: RunInstallationDispatch;
    readonly generation: number;
    readonly stateDigest: string | undefined;
    readonly runId: string;
    readonly now: number;
  }): StateSnapshot | undefined {
    const scope = input.envDispatch.stateScope;
    if (!scope) return undefined;
    return {
      id: this.#newId("state"),
      spaceId: scope.spaceId,
      installationId: scope.installationId,
      environment: scope.environment,
      generation: input.generation,
      objectKey: stateObjectKeyForScope(scope),
      digest: input.stateDigest ?? "",
      createdByRunId: input.runId,
      createdAt: new Date(input.now).toISOString(),
    };
  }

  /**
   * Builds the §16 OutputSnapshot for a successful (non-destroy) apply.
   *
   *   - `spaceOutputs` = InstallConfig.outputAllowlist projection (or template
   *     public projection for template-backed runs), after sensitive filtering
   *     and type validation.
   *   - `publicOutputs` = the same projection surfaced on Deployment.
   *   - Sensitive-flagged outputs appear in NEITHER (invariants 11/12), and a
   *     required sensitive/missing/wrong-type output fails closed.
   *   - `outputDigest` = stableJsonDigest over `{ spaceOutputs, publicOutputs }`,
   *     which drives stale propagation (§24).
   *   - `rawOutputArtifactKey` = the §26 key the runner DO sealed + wrote the raw
   *     envelope to (echoed as `result.rawOutputsKey`); falls back to the derived
   *     key when the runner did not echo one (e.g. runs without env context).
   *
   * The raw envelope itself never enters the ledger — only the projection. The
   * record is PERSISTED atomically with the Deployment / StateSnapshot /
   * Installation advance by {@link OpenTofuDeploymentStore.commitAppliedDeployment}.
   */
  async #buildOutputSnapshot(input: {
    readonly installation: Installation;
    readonly applyRun: ApplyRun;
    readonly result: OpenTofuApplyResult;
    readonly publicOutputs: readonly DeploymentOutput[];
    readonly outputAllowlist?: RunTemplateDispatch["outputAllowlist"];
    readonly stateGeneration: number;
    readonly now: number;
  }): Promise<OutputSnapshot> {
    const spaceOutputs = input.outputAllowlist
      ? projectOutputAllowlistSpaceOutputs(
          input.outputAllowlist,
          input.result.outputs,
        )
      : Object.fromEntries(
          input.publicOutputs.map((output) => [output.name, output.value]),
        );
    const publicOutputs = Object.fromEntries(
      input.publicOutputs.map((output) => [output.name, output.value]),
    );
    const outputDigest = await stableJsonDigest({
      spaceOutputs,
      publicOutputs,
    });
    const snapshot: OutputSnapshot = {
      id: this.#newId("out"),
      spaceId: input.installation.spaceId,
      installationId: input.installation.id,
      stateGeneration: input.stateGeneration,
      rawOutputArtifactKey:
        input.result.rawOutputsKey ??
        rawOutputArtifactKey({
          spaceId: input.installation.spaceId,
          installationId: input.installation.id,
          runId: input.applyRun.id,
        }),
      publicOutputs,
      spaceOutputs,
      outputDigest,
      createdAt: new Date(input.now).toISOString(),
    };
    return snapshot;
  }

  /**
   * §24 stale propagation. After a successful apply records a new OutputSnapshot,
   * compares its digest to the Installation's PREVIOUS OutputSnapshot digest;
   * when they differ (the outputs changed) every transitive downstream consumer
   * in the SAME Space that is currently `active` is patched to `stale`.
   *
   * The downstream closure is computed over the Space's `variable_injection`
   * dependency edges (producer -> consumer) via {@link downstreamClosure}. Only
   * `active` consumers are moved: `pending` / `error` / `destroyed` are left
   * untouched (a stale flag on a not-yet-applied or torn-down Installation is
   * meaningless). No-ops when the digest is unchanged, or when there are no
   * downstream consumers. Each patch carries no guard: stale is an advisory flag,
   * not a state-generation move, so it never races the currentDeployment pointer.
   */
  async #propagateStale(input: {
    readonly installation: Installation;
    readonly previousOutputSnapshot: OutputSnapshot | undefined;
    readonly newOutputSnapshot: OutputSnapshot;
    readonly now: number;
  }): Promise<void> {
    if (
      input.previousOutputSnapshot?.outputDigest ===
      input.newOutputSnapshot.outputDigest
    )
      return;
    const edges = await this.#store.listDependenciesBySpace(
      input.installation.spaceId,
    );
    if (edges.length === 0) return;
    const changedOutputNames = changedOutputNamesBetween(
      input.previousOutputSnapshot,
      input.newOutputSnapshot,
    );
    const producerOutputReasons = changedOutputNames.map(
      (outputName) => `${input.installation.name}.${outputName} changed`,
    );
    const closure = downstreamClosure(
      edges.map((edge) => ({
        from: edge.producerInstallationId,
        to: edge.consumerInstallationId,
      })),
      input.installation.id,
    );
    if (closure.size === 0) return;
    const updatedAt = new Date(input.now).toISOString();
    for (const consumerId of closure) {
      const consumer = await this.#store.getInstallation(consumerId);
      // Only an active consumer becomes stale; skip the rest (and a consumer the
      // ledger no longer holds).
      if (!consumer || consumer.status !== "active") continue;
      await this.#store.patchInstallation(consumerId, {
        status: "stale",
        updatedAt,
      });
      // Activity (§27 / §34): a downstream consumer was marked stale by the
      // producer's changed outputs (§24). One event per affected consumer.
      const directOutputNames = directChangedDependencyOutputs({
        edges,
        producerInstallationId: input.installation.id,
        consumerInstallationId: consumer.id,
        changedOutputNames,
      });
      const directReasons = directOutputNames.map(
        (outputName) => `${input.installation.name}.${outputName} changed`,
      );
      await this.#recordActivity({
        spaceId: consumer.spaceId,
        action: "installation.stale",
        targetType: "installation",
        targetId: consumer.id,
        metadata: {
          producerInstallationId: input.installation.id,
          producerInstallationName: input.installation.name,
          changedOutputs: changedOutputNames,
          reasons:
            directReasons.length > 0 ? directReasons : producerOutputReasons,
          directChangedOutputs: directOutputNames,
          outputSnapshotId: input.newOutputSnapshot.id,
          previousOutputSnapshotId: input.previousOutputSnapshot?.id ?? null,
        },
      });
    }
  }

  /**
   * Fire-and-forget Activity emission (spec §27 / §34). Wraps the recorder so a
   * failed audit write (or a recorder that throws) never propagates into the run
   * path. The {@link ActivityService} already swallows store errors; this is the
   * controller-side belt-and-suspenders.
   */
  async #recordActivity(event: RecordActivityInput): Promise<void> {
    try {
      await this.#activity.record(event);
    } catch (error) {
      log.warn("service.deploy_control.activity_record_failed", {
        action: event.action,
        error,
      });
    }
  }

  /**
   * Resolves an installation-driven run's provider env bindings (spec §9) at mint time so
   * binding changes take effect on the next run. Returns `undefined` only for
   * runs without installation context. If a run names an Installation that no
   * longer exists, it fails closed instead of falling back to a Space-wide pool. The result
   * feeds BOTH {@link mintableConnectionIds} (shared pool) and
   * {@link providerMintEntriesFromResolved} (the §13 per-alias TF_VAR split),
   * mirroring `providerEnvBindingsFromResolved` so the minted vars match the
   * rootgen aliases.
   */
  async #resolveRunInstallationProviderEnvBindings(
    planRun: PlanRun,
  ): Promise<readonly ResolvedInstallationProviderEnvBinding[] | undefined> {
    const ctx = planRun.installationContext;
    if (!ctx) return undefined;
    const installation = await this.#store.getInstallation(ctx.installationId);
    if (!installation) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `installation_not_found: ${ctx.installationId}`,
      );
    }
    this.#connectionsService ??= new ConnectionsService({
      store: this.#store,
      allowOperatorBackedProviderEnvs: this.#allowOperatorBackedProviderEnvs,
    });
    // Run-scoped: explicit Installation provider env bindings only. The same
    // resolution feeds rootgen, so the minted TF_VAR credentials line up with the
    // generated provider blocks.
    return await this.#connectionsService.resolveProviderEnvBindingsForRun(
      installation,
      planRun.requiredProviders,
    );
  }

  /**
   * Pins the resolved provider-connection digest (plan→apply TOCTOU) onto a completed plan.
   * Resolves the plan's live provider env bindings ONCE and hashes the
   * provider→{connectionId,mode,alias} set onto `resolvedProviderEnvBindingsDigest`. Only
   * pinned for an installation-context run (a raw `/plan-runs` run resolves no
   * provider env bindings, so there is nothing to fence); the apply mint re-resolves and
   * asserts this digest is unchanged. A failed/denied plan is never applied, so
   * the pin is harmless either way.
   */
  async #pinResolvedBindingsDigest(planRun: PlanRun): Promise<PlanRun> {
    if (!planRun.installationContext) return planRun;
    const resolved =
      await this.#resolveRunInstallationProviderEnvBindings(planRun);
    if (resolved === undefined) return planRun;
    const digest = await resolvedProviderEnvBindingsDigest(resolved);
    return { ...planRun, resolvedProviderEnvBindingsDigest: digest };
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
   * (a `pending` / `disabled` / `destroyed` / `error` Installation has no
   * stable deployed state to compare against). The scheduled sweep iterates this
   * bounded set and creates one drift check per Installation. A non-positive
   * limit returns an empty list.
   */
  async listActiveInstallations(
    limit: number,
  ): Promise<readonly Installation[]> {
    return await this.#deployments.listActiveInstallations(limit);
  }

  async listDeployments(
    installationId: string,
    params?: PageParams,
  ): Promise<ListDeploymentsResponse> {
    return await this.#deployments.listDeployments(installationId, params);
  }

  async listDeploymentOutputs(
    installationId: string,
  ): Promise<ListDeploymentOutputsResponse> {
    return await this.#deployments.listDeploymentOutputs(installationId);
  }

  /**
   * Reads a single Deployment ledger record (spec §21 / §30 `GET
   * /internal/v1/deployments/:id`). A missing id is a typed 404.
   */
  async getDeployment(id: string): Promise<Deployment> {
    return await this.#deployments.getDeployment(id);
  }

  /**
   * Creates a rollback PLAN run for a Deployment (spec §30 `POST
   * /internal/v1/deployments/:id/rollback-plan`): re-plans the Deployment's Installation
   * pinned to THAT Deployment's `sourceSnapshotId`. The plan then flows through
   * the normal approval/apply path. Reuses the installation plan path with an
   * internal snapshot override.
   */
  async createDeploymentRollbackPlan(
    deploymentId: string,
    context: DeployControlActorContext = {},
  ): Promise<PlanRunResponse> {
    const deployment = await this.getDeployment(deploymentId);
    return await this.#createInstallationPlanRun(
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
   * for the `takosumi deploy` pipeline.
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

  async getRunLogs(id: string): Promise<RunLogsResponse> {
    return await this.#runQuery.getRunLogs(id);
  }

  async getRunEvents(id: string): Promise<RunEventsResponse> {
    return await this.#runQuery.getRunEvents(id);
  }

  async getRunCost(id: string): Promise<RunCostInfo> {
    return await this.#runQuery.getRunCost(id);
  }

  async createRestoreRun(
    spaceId: string,
    backupId: string,
    request: CreateRestoreRequest,
    context: DeployControlActorContext = {},
  ): Promise<Run> {
    requireNonEmptyString(spaceId, "spaceId");
    requireNonEmptyString(backupId, "backupId");
    if (
      !Number.isInteger(request.stateGeneration) ||
      request.stateGeneration < 0
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "stateGeneration must be a non-negative integer",
      );
    }
    const backup = await this.#store.getBackupRecord(backupId);
    if (!backup || backup.spaceId !== spaceId) {
      throw new OpenTofuControllerError(
        "not_found",
        `backup ${backupId} not found in space ${spaceId}`,
      );
    }
    const restoreServiceData = request.restoreServiceData === true;
    if (restoreServiceData && !backup.serviceData) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "backup has no service-data artifact to restore",
      );
    }
    if (restoreServiceData && !this.#runner?.restoreServiceData) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "service-data restore requires a service-data restore-capable runner",
      );
    }
    if (
      request.expectedBackupDigest &&
      request.expectedBackupDigest !== backup.digest
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "backup digest guard did not match",
      );
    }
    const installationId = request.installationId ?? backup.installationId;
    if (!installationId) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "installationId is required for control/state restore",
      );
    }
    const installation = await this.#store.getInstallation(installationId);
    if (!installation || installation.spaceId !== spaceId) {
      throw new OpenTofuControllerError(
        "not_found",
        `installation ${installationId} not found in space ${spaceId}`,
      );
    }
    const environment =
      request.environment ?? backup.environment ?? installation.environment;
    const source = (
      await this.#store.listStateSnapshots(installation.id, environment)
    ).find((snapshot) => snapshot.generation === request.stateGeneration);
    if (!source) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `state generation ${request.stateGeneration} is not available for restore`,
      );
    }
    const now = new Date(this.#now()).toISOString();
    const run: Run = {
      id: this.#newId("restore"),
      spaceId,
      installationId: installation.id,
      environment,
      type: "restore",
      status: "waiting_approval",
      backupId: backup.id,
      restoreStateGeneration: source.generation,
      ...(restoreServiceData ? { restoreServiceData: true } : {}),
      restoredFromStateSnapshotId: source.id,
      planDigest: backup.digest,
      createdBy: context.actor ?? "system",
      createdAt: now,
    };
    await this.#store.putBackupRun(run);
    await this.#recordActivity({
      spaceId,
      ...(context.actor ? { actorId: context.actor } : {}),
      action: "restore.created",
      targetType: "run",
      targetId: run.id,
      runId: run.id,
      metadata: {
        backupId: backup.id,
        installationId: installation.id,
        environment,
        stateGeneration: source.generation,
        ...(restoreServiceData
          ? {
              restoreServiceData: true,
              serviceDataObjectKey: backup.serviceData!.objectKey,
              serviceDataDigest: backup.serviceData!.digest,
            }
          : {}),
      },
    });
    return run;
  }

  /**
   * Cancels a run that has not started executing. Only `queued` plan/apply runs
   * (or a plan parked in the persisted `waiting_approval` status) may be
   * cancelled; a `running` or terminal run is rejected. Returns the resulting
   * unified Run.
   */
  async cancelRun(id: string): Promise<Run> {
    requireNonEmptyString(id, "runId");
    const planRun = await this.#store.getPlanRun(id);
    if (planRun) {
      if (
        planRun.status !== "queued" &&
        !(await this.#runQuery.planAwaitsApproval(planRun))
      ) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `plan run ${id} is ${planRun.status}; only queued or waiting-approval runs can be cancelled`,
        );
      }
      const now = this.#now();
      const cancelled: PlanRun = {
        ...planRun,
        status: "cancelled",
        auditEvents: [
          ...planRun.auditEvents,
          auditEvent(planRun.id, "plan.cancelled", now),
        ],
        updatedAt: now,
        finishedAt: now,
      };
      // Fenced cancel: the CAS fires ONLY when the row is still in the status we
      // read (`queued` or the parked `waiting_approval`). If a consumer claim
      // raced us to `running` first, the CAS loses and the cancel is rejected —
      // it must not clobber a run a sibling already owns. Conversely, when the
      // cancel wins, a later claim CAS (expectFrom `queued`) loses, so a
      // cancelled run is never resurrected into `running`.
      const result = await this.#store.transitionRun({
        id,
        kind: "plan",
        expectFrom: [planRun.status],
        run: cancelled,
        clearLeaseToken: true,
      });
      if (!result.won) {
        const current = (result.run as PlanRun | undefined) ?? planRun;
        throw new OpenTofuControllerError(
          "failed_precondition",
          `plan run ${id} is ${current.status}; only queued or waiting-approval runs can be cancelled`,
        );
      }
      await this.#store.deletePlanRunInputs(id);
      return projectPlanRun(cancelled, {
        awaitingApproval: false,
        ...this.#runQuery.installationProjection(cancelled),
      });
    }
    const applyRun = await this.#store.getApplyRun(id);
    if (applyRun) {
      if (applyRun.status !== "queued") {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `apply run ${id} is ${applyRun.status}; only queued runs can be cancelled`,
        );
      }
      const now = this.#now();
      const cancelled: ApplyRun = {
        ...applyRun,
        status: "cancelled",
        auditEvents: [
          ...applyRun.auditEvents,
          auditEvent(applyRun.id, "apply.cancelled", now),
        ],
        updatedAt: now,
        finishedAt: now,
      };
      // Fenced cancel: fire ONLY while the apply is still `queued`. A consumer
      // claim (expectFrom `queued`) and this cancel race the same row; exactly
      // one wins. If the claim won (now `running`), the cancel CAS loses and is
      // rejected — never clobbering the in-flight apply; if the cancel won, the
      // later claim loses and the cancelled apply is never resurrected.
      const result = await this.#store.transitionRun({
        id,
        kind: "apply",
        expectFrom: ["queued"],
        run: cancelled,
        clearLeaseToken: true,
      });
      if (!result.won) {
        const current = (result.run as ApplyRun | undefined) ?? applyRun;
        throw new OpenTofuControllerError(
          "failed_precondition",
          `apply run ${id} is ${current.status}; only queued runs can be cancelled`,
        );
      }
      return projectApplyRun(cancelled);
    }
    if (
      (await this.#store.getSourceSyncRun(id)) ||
      (await this.#store.getCompatibilityCheckRun(id)) ||
      (await this.#store.getBackupRun(id))
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `run ${id} is not a cancellable plan or apply run`,
      );
    }
    throw new OpenTofuControllerError("not_found", `run ${id} not found`);
  }

  /**
   * Records an explicit approval against a `waiting_approval` plan run, clearing
   * the approval gate so its apply may proceed (spec §10.6 destroy approval and
   * the template destructive-confirmation gate). Idempotent: re-approving an
   * already-approved plan returns it unchanged. Rejects a run that is not a plan
   * or is not parked awaiting approval.
   */
  async approveRun(
    id: string,
    input: { readonly approvedBy?: string; readonly reason?: string } = {},
  ): Promise<Run> {
    requireNonEmptyString(id, "runId");
    const planRun = await this.#store.getPlanRun(id);
    if (!planRun) {
      const genericRun = await this.#store.getBackupRun(id);
      if (genericRun?.type === "restore") {
        return await this.#approveRestoreRun(genericRun, input);
      }
      // Only plan runs carry an approval gate; an apply/source-sync id is a
      // client error here.
      if (
        (await this.#store.getApplyRun(id)) ||
        (await this.#store.getSourceSyncRun(id)) ||
        (await this.#store.getCompatibilityCheckRun(id)) ||
        (await this.#store.getBackupRun(id))
      ) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `run ${id} is not an approvable plan run`,
        );
      }
      throw new OpenTofuControllerError("not_found", `run ${id} not found`);
    }
    if (planRun.approval) {
      return projectPlanRun(planRun, {
        awaitingApproval: false,
        ...this.#runQuery.installationProjection(planRun),
      });
    }
    if (!(await this.#runQuery.planAwaitsApproval(planRun))) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${id} is not awaiting approval`,
      );
    }
    const now = this.#now();
    const approval = redactRunApproval({
      ...(input.approvedBy ? { approvedBy: input.approvedBy } : {}),
      approvedAt: now,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    const approved: PlanRun = {
      ...planRun,
      // Approving the gate advances the persisted status to `succeeded` so the
      // plan becomes applyable (the apply precondition requires `succeeded`). A
      // legacy row already persisted `succeeded` stays `succeeded`.
      status: "succeeded",
      ...(approval ? { approval } : {}),
      auditEvents: [
        ...planRun.auditEvents,
        auditEvent(
          planRun.id,
          "plan.approved",
          now,
          {
            ...(input.approvedBy ? { approvedBy: input.approvedBy } : {}),
          },
          input.approvedBy,
        ),
      ],
      updatedAt: now,
    };
    // Fenced approve. expectFrom is scoped to the READ status so a concurrent
    // double-approve cannot win: the normal path parks in `waiting_approval`,
    // so `expectFrom: ["waiting_approval"]` — the FIRST approve advances the row
    // to `succeeded` and a second concurrent approve (which also read
    // `waiting_approval`) loses the CAS because `succeeded` is no longer in
    // expectFrom (it would otherwise have re-won against the just-written
    // `succeeded` and clobbered the approval with a duplicate). A legacy row
    // already persisted `succeeded` WITHOUT an approval takes the narrow
    // `["succeeded"]` path (its `if (planRun.approval) return` early-out above
    // already handles the already-approved legacy row). The lease column is
    // left untouched (a parked/terminal plan carries no lease fence). A lost
    // CAS means the row moved between read and write, so the approval is
    // dropped rather than clobbering the new state.
    const approveResult = await this.#store.transitionRun({
      id,
      kind: "plan",
      expectFrom:
        planRun.status === "succeeded" ? ["succeeded"] : ["waiting_approval"],
      run: approved,
    });
    if (!approveResult.won) {
      const current = (approveResult.run as PlanRun | undefined) ?? approved;
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${id} is ${current.status}; only a plan awaiting approval can be approved`,
      );
    }
    // Activity (§27 / §34): the plan Run was approved.
    await this.#recordActivity({
      spaceId: approved.spaceId,
      ...(input.approvedBy ? { actorId: input.approvedBy } : {}),
      action: "run.approved",
      targetType: "run",
      targetId: approved.id,
      runId: approved.id,
      metadata: {
        operation: approved.operation,
        installationId: approved.installationId,
      },
    });
    return projectPlanRun(approved, {
      awaitingApproval: false,
      ...this.#runQuery.installationProjection(approved),
    });
  }

  async #approveRestoreRun(
    restoreRun: Run,
    input: { readonly approvedBy?: string; readonly reason?: string } = {},
  ): Promise<Run> {
    if (restoreRun.status !== "waiting_approval") {
      if (
        restoreRun.status === "queued" ||
        restoreRun.status === "running" ||
        restoreRun.status === "succeeded"
      ) {
        return restoreRun;
      }
      throw new OpenTofuControllerError(
        "failed_precondition",
        `restore run ${restoreRun.id} is ${restoreRun.status}; only a restore awaiting approval can be approved`,
      );
    }
    const now = new Date(this.#now()).toISOString();
    const approved: Run = {
      ...restoreRun,
      status: "queued",
    };
    const approveResult = await this.#store.transitionRun({
      id: restoreRun.id,
      kind: "restore",
      expectFrom: ["waiting_approval"],
      run: approved,
    });
    if (!approveResult.won) {
      return (approveResult.run as Run | undefined) ?? restoreRun;
    }
    await this.#recordActivity({
      spaceId: approved.spaceId,
      ...(input.approvedBy ? { actorId: input.approvedBy } : {}),
      action: "run.approved",
      targetType: "run",
      targetId: approved.id,
      runId: approved.id,
      metadata: {
        operation: "restore",
        backupId: approved.backupId ?? null,
        installationId: approved.installationId ?? null,
        approvedAt: now,
        ...(input.reason ? { reason: redactString(input.reason) } : {}),
      },
    });
    await this.#enqueueRun({
      action: "restore",
      runId: approved.id,
      spaceId: approved.spaceId,
    });
    return (await this.#store.getBackupRun(approved.id)) ?? approved;
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

  // Status-transition ceremony shared by the three execute paths: clone the run
  // into `running`, append the phase `started` audit event, and CLAIM it with a
  // fenced compare-and-set so exactly one consumer can move a `queued` (or a
  // stale-`running`) run into `running`. A lost CAS (`won:false`) means a
  // sibling already owns the run — or a cancel won the row — and the caller must
  // NOT dispatch the runner. The claim stamps the run id as the lease fence
  // token + the heartbeat, so a concurrent claim/cancel cannot both win.
  async #markPlanRunning(planRun: PlanRun): Promise<RunClaimResult<PlanRun>> {
    const startedAt = this.#now();
    const expectedHeartbeatAt = planRun.heartbeatAt ?? null;
    const running: PlanRun = {
      ...planRun,
      status: "running",
      startedAt,
      heartbeatAt: startedAt,
      auditEvents: [
        ...planRun.auditEvents,
        auditEvent(planRun.id, "plan.started", startedAt),
      ],
      updatedAt: startedAt,
    };
    return await this.#claimRunRunning(
      "plan",
      planRun.status,
      running,
      startedAt,
      expectedHeartbeatAt,
    );
  }

  async #markApplyRunning(
    applyRun: ApplyRun,
    profile: RunnerProfile,
    startedAt: number,
  ): Promise<RunClaimResult<ApplyRun>> {
    const expectedHeartbeatAt = applyRun.heartbeatAt ?? null;
    const running: ApplyRun = {
      ...applyRun,
      status: "running",
      startedAt,
      heartbeatAt: startedAt,
      stateLock: stateLockEvidence(
        profile.stateBackend,
        startedAt,
        startedAt,
        "pending",
      ),
      auditEvents: [
        ...applyRun.auditEvents,
        auditEvent(applyRun.id, "apply.started", startedAt),
      ],
      updatedAt: startedAt,
    };
    return await this.#claimRunRunning(
      "apply",
      applyRun.status,
      running,
      startedAt,
      expectedHeartbeatAt,
    );
  }

  /**
   * Fenced `→ running` claim shared by the plan / apply consumers. The CAS fires
   * only when the row is still in the expected pre-state: `queued` (the normal
   * claim) or a stale `running` (crash takeover — the pre-read in
   * {@link #shouldProcessRun} already established staleness). On a win it stamps
   * the run id as the lease fence token + the heartbeat. On a loss the row was
   * cancelled or already claimed by a sibling, so the caller skips dispatch and
   * returns the re-read current row.
   */
  async #claimRunRunning<R extends PlanRun | ApplyRun>(
    kind: "plan" | "apply",
    fromStatus: RunStatus,
    running: R,
    heartbeatAt: number,
    expectedHeartbeatAt: number | null,
  ): Promise<RunClaimResult<R>> {
    const expectFrom: RunStatus[] =
      fromStatus === "running" ? ["running"] : ["queued"];
    const leaseToken = this.#newId("runlease");
    const result = await this.#store.transitionRun({
      id: running.id,
      kind,
      expectFrom,
      run: running,
      setLeaseToken: leaseToken,
      ...(fromStatus === "running"
        ? { expectHeartbeatAt: expectedHeartbeatAt }
        : {}),
      heartbeatAt,
    });
    const run = (result.run ?? running) as R;
    return result.won ? { won: true, run, leaseToken } : { won: false, run };
  }

  async #claimRestoreRunning(
    fromStatus: RunStatus,
    running: Run,
    heartbeatAt: number,
    expectedHeartbeatAt: number | null,
  ): Promise<
    | { readonly won: true; readonly run: Run; readonly leaseToken: string }
    | { readonly won: false; readonly run: Run }
  > {
    const expectFrom: RunStatus[] =
      fromStatus === "running" ? ["running"] : ["queued"];
    const leaseToken = this.#newId("runlease");
    const result = await this.#store.transitionRun({
      id: running.id,
      kind: "restore",
      expectFrom,
      run: running,
      setLeaseToken: leaseToken,
      ...(fromStatus === "running"
        ? { expectHeartbeatAt: expectedHeartbeatAt }
        : {}),
      heartbeatAt,
    });
    const run = (result.run ?? running) as Run;
    return result.won ? { won: true, run, leaseToken } : { won: false, run };
  }

  /**
   * Re-stamps a `running` run's heartbeat (the renewal harness, around a long
   * blocking runner fetch). Lease-fenced on the run id so a stale takeover that
   * already re-claimed the row with a fresh token does NOT get its heartbeat
   * bumped by the crashed prior owner. A lost CAS is a no-op (the run moved on).
   */
  async #heartbeatRunningRun(
    kind: "plan" | "apply" | "restore",
    run: PlanRun | ApplyRun | Run,
    leaseToken: string,
  ): Promise<void> {
    const now = this.#now();
    await this.#store.transitionRun({
      id: run.id,
      kind,
      expectFrom: ["running"],
      expectLeaseToken: leaseToken,
      run: { ...run, heartbeatAt: now, updatedAt: now },
      heartbeatAt: now,
    });
  }

  /**
   * Runs `work` (a single long blocking runner fetch) under a renewal timer:
   * every {@link RUN_RENEWAL_INTERVAL_MS} it re-stamps the run's heartbeat AND
   * renews the held lease so a sibling consumer never treats the run as crashed
   * mid-apply. The interval is cleared in a `finally` on EVERY exit path
   * (success, throw, or cancel). Each tick is best-effort: a renewal/heartbeat
   * error is swallowed so it can never reject `work`'s result or crash the run.
   */
  async #withRunRenewal<T>(
    kind: "plan" | "apply" | "restore",
    run: PlanRun | ApplyRun | Run,
    leaseToken: string,
    lease: LeaseHandle | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    const tick = async (): Promise<void> => {
      try {
        await this.#heartbeatRunningRun(kind, run, leaseToken);
        if (lease) {
          await lease.renew(DEFAULT_INSTALLATION_LEASE_TTL_MS);
        }
      } catch {
        // Best-effort: a transient renewal failure must not kill the apply it is
        // babysitting. The next tick retries; a permanently-lost lease surfaces
        // as a stale-takeover by a sibling, not as a thrown apply.
      }
    };
    const intervalMs = this.#runRenewalIntervalMs;
    // A non-positive interval disables the renewal timer (used by tests / inline
    // substrates that never need it). The work still runs unchanged.
    if (intervalMs <= 0) {
      return await work();
    }
    const timer = setInterval(() => void tick(), intervalMs);
    // Some runtimes keep the event loop alive for a pending interval; unref when
    // available so the renewal timer never blocks process exit on its own.
    (timer as { unref?: () => void }).unref?.();
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * Persists a run that has reached a TERMINAL status (succeeded / failed /
   * cancelled). Routed through {@link OpenTofuDeploymentStore.transitionRun}
   * instead of a raw `put*` so the lease fence column is CLEARED on the same
   * write (a `put*` would leave a stale `lease_token` behind). Non-terminal →
   * terminal is uncontested (the consumer that reached this point already holds
   * the run), so the CAS accepts any non-terminal from-state; a lost CAS means a
   * sibling already terminalized it and the existing terminal row stands.
   */
  async #persistTerminalRun<R extends PlanRun | ApplyRun>(
    kind: "plan" | "apply",
    terminal: R,
    leaseToken?: string,
  ): Promise<TerminalRunPersistResult<R>> {
    const result = await this.#store.transitionRun({
      id: terminal.id,
      kind,
      expectFrom: NON_TERMINAL_RUN_STATUSES,
      ...(leaseToken ? { expectLeaseToken: leaseToken } : {}),
      run: terminal,
      clearLeaseToken: true,
    });
    return {
      won: result.won,
      run: (result.won ? terminal : (result.run ?? terminal)) as R,
    };
  }

  async #failRestoreRun(
    running: Run,
    leaseToken: string | undefined,
    error: unknown,
  ): Promise<Run> {
    const finishedAtMs = this.#now();
    const failed: Run = {
      ...running,
      status: "failed",
      heartbeatAt: finishedAtMs,
      errorCode: compactErrorCode(errorMessage(error)),
      finishedAt: new Date(finishedAtMs).toISOString(),
    };
    const result = await this.#store.transitionRun({
      id: failed.id,
      kind: "restore",
      expectFrom: NON_TERMINAL_RUN_STATUSES,
      ...(leaseToken ? { expectLeaseToken: leaseToken } : {}),
      run: failed,
      clearLeaseToken: true,
      heartbeatAt: finishedAtMs,
    });
    return (result.won ? failed : (result.run ?? failed)) as Run;
  }

  // Failure ceremony shared by the three catch bodies: clone the running run
  // into `failed`, attach the redacted error diagnostic and the phase `failed`
  // audit event, persist, and return the failed run.
  async #failPlanRun(
    running: PlanRun,
    leaseToken: string | undefined,
    error: unknown,
  ): Promise<PlanRun> {
    const now = this.#now();
    const failed: PlanRun = {
      ...running,
      status: "failed",
      diagnostics: [errorDiagnostic(error)],
      auditEvents: [
        ...running.auditEvents,
        auditEvent(running.id, "plan.failed", now, {
          message: errorMessage(error),
        }),
      ],
      updatedAt: now,
      finishedAt: now,
    };
    const persisted = await this.#persistTerminalRun(
      "plan",
      failed,
      leaseToken,
    );
    if (!persisted.won) return persisted.run;
    await this.#recordDeployOperationMetric({
      run: failed,
      operationKind: "plan",
      status: "failed",
    });
    // Activity (§27 / §34): a plan / destroy_plan reached a failed terminal
    // state. Public-safe metadata only — a compact error CODE (never the raw
    // diagnostic message), the run phase, and the targeted Installation id.
    await this.#recordActivity({
      spaceId: failed.spaceId,
      action: "run.failed",
      targetType: "run",
      targetId: failed.id,
      runId: failed.id,
      metadata: {
        phase: failed.driftCheck === true ? "drift_check" : "plan",
        operation: failed.operation,
        errorCode: compactErrorCode(errorMessage(error)),
        ...(failed.installationId
          ? { installationId: failed.installationId }
          : {}),
      },
    });
    return failed;
  }

  async #failApplyRun(
    running: ApplyRun,
    leaseToken: string | undefined,
    profile: RunnerProfile,
    startedAt: number,
    eventType: "apply.failed" | "destroy.failed",
    error: unknown,
  ): Promise<ApplyRun> {
    const now = this.#now();
    const failed: ApplyRun = {
      ...running,
      status: "failed",
      stateLock: stateLockEvidence(
        profile.stateBackend,
        startedAt,
        now,
        "recorded",
      ),
      diagnostics: [errorDiagnostic(error)],
      auditEvents: [
        ...running.auditEvents,
        auditEvent(running.id, eventType, now, {
          message: errorMessage(error),
        }),
      ],
      updatedAt: now,
      finishedAt: now,
    };
    const persisted = await this.#persistTerminalRun(
      "apply",
      failed,
      leaseToken,
    );
    if (!persisted.won) return persisted.run;
    await this.#recordDeployOperationMetric({
      run: failed,
      operationKind: eventType === "destroy.failed" ? "destroy_apply" : "apply",
      status: "failed",
      startedAt,
      finishedAt: now,
      recordApplyDuration: true,
    });
    // Activity (§27 / §34): an apply / destroy_apply reached a failed terminal
    // state. Public-safe metadata only — a compact error CODE (never the raw
    // diagnostic message), the run phase, and the targeted Installation id.
    await this.#recordActivity({
      spaceId: failed.spaceId,
      action: "run.failed",
      targetType: "run",
      targetId: failed.id,
      runId: failed.id,
      metadata: {
        phase: eventType === "destroy.failed" ? "destroy_apply" : "apply",
        operation: failed.operation,
        errorCode: compactErrorCode(errorMessage(error)),
        ...(failed.installationId
          ? { installationId: failed.installationId }
          : {}),
      },
    });
    return failed;
  }

  async #executePlan(
    running: PlanRun,
    leaseToken: string,
    profile: RunnerProfile,
    variables: Readonly<Record<string, JsonValue>>,
    credentials: RunCredentials | undefined,
    dispatch: RunTemplateDispatch,
  ): Promise<PlanRun> {
    try {
      // A plan restores against the CURRENT generation
      // (`baseStateGeneration`). Empty for runs without installation context.
      const envDispatch = await this.#verification.installationDispatch(
        running,
        running.baseStateGeneration ?? 0,
      );
      const planPolicy = await this.#policyForPlanRun(running);
      const providerInstallationPolicy =
        planPolicy?.providerInstallation?.requireMirror === true
          ? { requireMirror: true }
          : undefined;
      const runner = this.#runnerForProfile(profile);
      const result = await this.#withRunRenewal(
        "plan",
        running,
        leaseToken,
        undefined,
        () =>
          runner.plan({
            planRun: running,
            runnerProfile: profile,
            variables,
            ...(providerInstallationPolicy
              ? { providerInstallationPolicy }
              : {}),
            // Generated-root dispatch (§7): built-in modules and generic Capsules
            // use the same generated-root/moduleFiles shape. Empty only for the
            // lower-level raw `/internal/v1/plan-runs` compatibility path.
            ...(dispatch.generatedRoot
              ? { generatedRoot: dispatch.generatedRoot }
              : {}),
            ...(dispatch.build ? { build: dispatch.build } : {}),
            // M2 env dispatch (state scope + source archive). Absent without env ctx.
            ...(envDispatch.stateScope
              ? { stateScope: envDispatch.stateScope }
              : {}),
            ...(envDispatch.sourceArchive
              ? { sourceArchive: envDispatch.sourceArchive }
              : {}),
            // remote_state dependency states materialized into /work/deps (spec §15).
            ...(envDispatch.depStates
              ? { depStates: envDispatch.depStates }
              : {}),
            // Dispatch-only: the minted env never lands on the persisted run.
            ...(credentials ? { credentials } : {}),
          }),
      );
      const now = this.#now();
      const verdict = await this.#evaluatePlanCompletion({
        running,
        profile,
        result,
        now,
      });
      const completed = this.#buildCompletedPlanRun({
        running,
        result,
        verdict,
        now,
      });
      // plan→apply TOCTOU pin (S2): hash the resolved provider env bindings this
      // plan was reviewed against onto the plan (installation-context runs only),
      // so the apply mint can assert nothing was swapped between plan and apply.
      const updated = await this.#pinResolvedBindingsDigest(completed);
      // Terminal write of the running plan (succeeded / waiting_approval /
      // failed): route through the fenced transition so the lease fence column is
      // cleared on the same write (a raw put* would leave a stale lease_token on
      // the terminal row).
      const persisted = await this.#persistTerminalRun(
        "plan",
        updated,
        leaseToken,
      );
      if (!persisted.won) return persisted.run;
      await this.#recordRunnerMinuteUsage({
        spaceId: updated.spaceId,
        runId: updated.id,
        installationId: updated.installationId,
        startedAt: running.startedAt,
        finishedAt: now,
      });
      await this.#recordDeployOperationMetric({
        run: updated,
        operationKind: "plan",
        status: updated.status,
      });
      // Drift check (§19 drift_check; Phase 8): resource changes are available
      // only in the runner result and are intentionally not persisted on the
      // PlanRun. Emit the sanitized aggregate Activity here while the plan JSON
      // projection is still in scope.
      if (updated.driftCheck === true && updated.status === "succeeded") {
        await this.#drift.recordDriftDetected(
          updated,
          result.planResourceChanges ?? [],
        );
      }
      return updated;
    } catch (error) {
      return await this.#failPlanRun(running, leaseToken, error);
    }
  }

  /**
   * Composes every plan policy layer (profile gate + §25 layered + Capsule
   * compatibility + billing reservation) into the completed policy verdict for a
   * plan run. Returns the observed providers, each layer's result, the merged
   * pass/blocked policy, its digest, and the §25 approval flag.
   */
  async #evaluatePlanCompletion(input: {
    readonly running: PlanRun;
    readonly profile: RunnerProfile;
    readonly result: OpenTofuPlanResult;
    readonly now: number;
  }): Promise<PlanCompletionVerdict> {
    const { running, profile, result, now } = input;
    const requiredProviders = normalizeProviders(
      result.requiredProviders ?? running.requiredProviders,
    );
    // Re-evaluate against the SAME provider-free allowance as the create gate:
    // a provider-free template (e.g. `core`) that observes zero providers at
    // plan time stays passed instead of tripping the "providers before init"
    // gate. Resolved from the recorded binding so a tampered catalog cannot
    // retroactively change the allowance.
    const policy = evaluatePolicy({
      profile,
      requiredProviders,
      checkedAt: now,
      ...(this.#planAllowsNoProviders(running)
        ? { allowNoProviders: true }
        : {}),
    });
    // Layered plan-JSON policy (§25). When the runner returned resource
    // changes, evaluate the resource-type allowlist (layer 5) and the action
    // policy (layer 7) over them for ALL runs — not only template-backed:
    //   - template-backed runs use the recorded template.policy for resource
    //     types (tamper-safe) and the target Space/InstallConfig for scope +
    //     quota;
    //   - non-template installation-context runs use the Installation's
    //     Space/InstallConfig policy (resolved via installConfigId);
    //   - raw `/internal/v1/plan-runs` runs without installation context keep today's
    //     behavior (no allowlist source -> no resource enforcement).
    // A disallowed resource type DENIES the plan; a delete/replace marks it
    // requiresApproval (parked waiting_approval until approved). The template
    // destructive-confirmation gate (requiresConfirmation) additionally needs
    // confirmDestructive at apply.
    const layered = await this.#evaluatePlanPolicy(running, result);
    const blockedByLayeredPolicy = [
      ...(layered.provider?.reasons ?? []),
      ...(layered.resource?.reasons ?? []),
      ...(layered.scope?.reasons ?? []),
      ...(layered.quota?.reasons ?? []),
      ...(layered.providerLockfile?.reasons ?? []),
      ...(layered.providerInstallation?.reasons ?? []),
    ];
    const runPolicy = await this.#policyForPlanRun(running);
    const compatibilityPolicy = await this.#evaluateCapsuleCompatibilityPolicy({
      planRunId: running.id,
      ...(running.compatibilityReportId
        ? { compatibilityReportId: running.compatibilityReportId }
        : {}),
      ...(running.sourceSnapshotId
        ? { sourceSnapshotId: running.sourceSnapshotId }
        : {}),
      ...(runPolicy ? { policy: runPolicy } : {}),
    });
    const billingPolicy = await this.#billing.evaluatePlanBillingReservation({
      planRun: running,
      result,
      now,
      policyPassedBeforeBilling:
        policy.status === "passed" &&
        blockedByLayeredPolicy.length === 0 &&
        compatibilityPolicy.reasons.length === 0,
    });
    const passedPolicy =
      policy.status === "passed" &&
      blockedByLayeredPolicy.length === 0 &&
      compatibilityPolicy.reasons.length === 0 &&
      billingPolicy.reasons.length === 0;
    const completedPolicy = passedPolicy
      ? policy
      : {
          status: "blocked" as const,
          reasons: [
            ...policy.reasons,
            ...blockedByLayeredPolicy,
            ...compatibilityPolicy.reasons,
            ...billingPolicy.reasons,
          ],
          checkedAt: now,
        };
    const policyDecisionDigest = await stableJsonDigest(completedPolicy);
    // §25 action policy: any delete/replace requires approval before apply.
    // Recorded so the §19 Run projection parks the succeeded plan
    // `waiting_approval`. Destroy plans are always-approval independently
    // (RunQueryService.planAwaitsApproval), so they need no field. A drift_check is read-only
    // and can never be applied (Phase 8), so it never carries requiresApproval.
    const requiresApproval =
      running.driftCheck !== true && layered.action?.requiresApproval === true;
    return {
      requiredProviders,
      layered,
      compatibilityPolicy,
      billingPolicy,
      passedPolicy,
      completedPolicy,
      policyDecisionDigest,
      requiresApproval,
    };
  }

  /**
   * Assembles the completed PlanRun from the runner result and the policy
   * verdict: the succeeded/blocked status, the normalized plan artifact /
   * summary / template binding, and the `plan.policy_evaluated` +
   * `plan.completed` audit events.
   */
  #buildCompletedPlanRun(input: {
    readonly running: PlanRun;
    readonly result: OpenTofuPlanResult;
    readonly verdict: PlanCompletionVerdict;
    readonly now: number;
  }): PlanRun {
    const { running, result, verdict, now } = input;
    const {
      requiredProviders,
      layered,
      compatibilityPolicy,
      billingPolicy,
      passedPolicy,
      completedPolicy,
      policyDecisionDigest,
      requiresApproval,
    } = verdict;
    const diagnostics = redactRunDiagnostics(result.diagnostics);
    const planArtifact = normalizePlanArtifact({
      artifact: result.planArtifact,
      planDigest: result.planDigest,
      now,
    });
    const summary = normalizePlanSummary(result.summary);
    const templateBinding = updatedTemplateBinding(
      running,
      layered.templatePolicy,
    );
    // §25 approval gate as a PERSISTED status (S2): a destroy plan is always
    // two-stage — it MUST carry a recorded approval (`approveRun`) before apply —
    // so a passed destroy plan parks in the persisted `waiting_approval` status
    // instead of `succeeded` (it was previously `succeeded` + a read-time
    // derivation). The OTHER gates are NOT approval-mandatory at apply and stay
    // `succeeded`: a `requiresApproval` (delete/replace) change is a display
    // signal, and a template `requiresConfirmation` change is enforced by
    // `confirmDestructive` at apply — both still PROJECT `waiting_approval` via
    // the read-time `planAwaitsApproval` derivation, so their semantics are
    // unchanged. A read-only drift_check never parks; a policy-denied plan is
    // `failed`.
    const parksForApproval =
      passedPolicy &&
      running.driftCheck !== true &&
      running.operation === "destroy";
    const completedStatus: RunStatus = passedPolicy
      ? parksForApproval
        ? "waiting_approval"
        : "succeeded"
      : "failed";
    return {
      ...running,
      status: completedStatus,
      requiredProviders,
      policy: completedPolicy,
      policyDecisionDigest,
      planDigest: result.planDigest,
      planArtifact,
      ...(result.sourceCommit ? { sourceCommit: result.sourceCommit } : {}),
      ...(result.providerLockDigest
        ? { providerLockDigest: result.providerLockDigest }
        : {}),
      ...(summary ? { summary } : {}),
      ...(result.planResourceChanges
        ? { planResourceChanges: result.planResourceChanges }
        : {}),
      ...(diagnostics ? { diagnostics } : {}),
      ...(templateBinding ? { templateBinding } : {}),
      ...(requiresApproval ? { requiresApproval: true } : {}),
      auditEvents: [
        ...running.auditEvents,
        auditEvent(running.id, "plan.policy_evaluated", now, {
          policyDecisionDigest,
          status: passedPolicy ? "passed" : "blocked",
          observedProviderCount: requiredProviders.length,
          requiresApproval,
          ...(layered.provider
            ? {
                installConfigProvidersAllowed:
                  layered.provider.denied.length === 0 &&
                  layered.provider.notAllowed.length === 0 &&
                  !layered.provider.missingProviders,
              }
            : {}),
          ...(layered.resource
            ? {
                resourceTypesAllowed:
                  layered.resource.disallowedResourceTypes.length === 0,
              }
            : {}),
          ...(compatibilityPolicy.audit
            ? { capsuleCompatibility: compatibilityPolicy.audit }
            : {}),
          ...(layered.providerLockfile
            ? {
                providerLockfileDigestPresent:
                  layered.providerLockfile.digestPresent,
              }
            : {}),
          ...(layered.providerInstallation
            ? {
                providerMirrorRequired:
                  layered.providerInstallation.requireMirror,
                providerMirrorPassed:
                  layered.providerInstallation.reasons.length === 0,
                providerMirrorEvidenceCount:
                  layered.providerInstallation.evidenceCount,
              }
            : {}),
          ...(layered.scope
            ? { scopeBoundaryPassed: layered.scope.outOfScope.length === 0 }
            : {}),
          ...(layered.quota
            ? { quotaPassed: layered.quota.exceeded.length === 0 }
            : {}),
          ...(billingPolicy.audit ? { billing: billingPolicy.audit } : {}),
          ...(layered.templatePolicy
            ? {
                templateRequiresConfirmation:
                  layered.templatePolicy.requiresConfirmation,
              }
            : {}),
        }),
        auditEvent(running.id, "plan.completed", now, {
          planDigest: result.planDigest,
          planArtifactDigest: planArtifact.digest,
          providerLockDigest: result.providerLockDigest ?? "",
        }),
      ],
      updatedAt: now,
      finishedAt: now,
    };
  }

  /**
   * Evaluates the layered plan-JSON policy (§25 layers 5 + 7) over the runner's
   * resource changes for ANY run that returned them:
   *   - `resource`: the resource-type allowlist verdict. The allowlist source is
   *     the recorded template.policy (template-backed runs, tamper-safe) or the
   *     Space/InstallConfig policy (non-template installation-context runs). A
   *     raw `/internal/v1/plan-runs` run without installation context has no allowlist
   *     source -> no resource enforcement.
   *   - `scope`: the §25 scope boundary using sanitized provider metadata when
   *     configured.
   *   - `action`: the §25 action policy (delete/replace requires approval).
   *   - `quota`: the §25 simple mutating-resource count quota when configured.
   *   - `templatePolicy`: the template destructive-confirmation verdict (only
   *     for template-backed runs) used to fold `requiresConfirmation` onto the
   *     binding.
   * Returns empty (`undefined` fields) when the runner reported no resource
   * changes.
   */
  async #evaluatePlanPolicy(
    planRun: PlanRun,
    result: OpenTofuPlanResult,
  ): Promise<PlanPolicyLayers> {
    const changes = result.planResourceChanges;
    const policy = await this.#policyForPlanRun(planRun);
    const observedProviders = normalizeProviders(
      result.requiredProviders ?? planRun.requiredProviders,
    );
    const provider = evaluateConfiguredProviderAllowlist(
      observedProviders,
      policy,
      this.#planAllowsNoProviders(planRun),
    );
    const providerLockfile = evaluateProviderLockfilePolicy(
      result.providerLockDigest,
      policy,
      observedProviders,
    );
    const providerInstallation = evaluateProviderInstallationPolicy(
      result.providerInstallation,
      policy,
      observedProviders,
    );
    if (changes === undefined) {
      return compactLayeredPolicy({
        provider,
        providerLockfile,
        providerInstallation,
      });
    }
    const action = evaluateActionPolicy(changes);
    const binding = planRun.templateBinding;
    if (binding) {
      const template = this.#templateRegistry.require(
        binding.templateId,
        binding.templateVersion,
      );
      const templatePolicy = evaluateTemplatePlanPolicy({
        policy: template.policy,
        changes,
      });
      const resource = evaluateResourceAllowlist(
        changes,
        template.policy.allowedResourceTypes,
      );
      const scope = evaluateScopeBoundary(changes, policy?.scopeBoundary);
      const quota = evaluateQuotaPolicy(changes, policy?.quota);
      return {
        provider,
        providerLockfile,
        providerInstallation,
        resource,
        scope,
        action,
        quota,
        templatePolicy,
      };
    }
    // Non-template installation-context run: enforce the composed
    // Space/InstallConfig policy. An undefined allowlist (or a run without
    // installation context) means "not configured" -> no resource enforcement.
    const resource = evaluateResourceAllowlist(
      changes,
      policy?.allowedResourceTypes,
    );
    const scope = evaluateScopeBoundary(changes, policy?.scopeBoundary);
    const quota = evaluateQuotaPolicy(changes, policy?.quota);
    return {
      provider,
      providerLockfile,
      providerInstallation,
      resource,
      scope,
      action,
      quota,
    };
  }

  /**
   * Resolves the Space + InstallConfig policy for an installation-context plan.
   * Space policy is a ceiling; InstallConfig policy can narrow it but not widen
   * it. Returns `undefined` for runs without installation context or when the
   * Installation / config is absent.
   */
  async #policyForPlanRun(planRun: PlanRun): Promise<PolicyConfig | undefined> {
    const installationId =
      planRun.installationContext?.installationId ?? planRun.installationId;
    if (!installationId) return undefined;
    const installation = await this.#store.getInstallation(installationId);
    if (!installation) return undefined;
    return await this.#policyForInstallation(installation);
  }

  async #policyForInstallation(
    installation: Installation,
  ): Promise<PolicyConfig | undefined> {
    const [space, installConfig] = await Promise.all([
      this.#store.getSpace(installation.spaceId),
      this.#store.getInstallConfig(installation.installConfigId),
    ]);
    return withDefaultProviderSupplyChainPolicy(
      mergePolicyConfigs(space?.policy, installConfig?.policy),
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

  async #recordRunnerMinuteUsage(input: {
    readonly spaceId: string;
    readonly runId: string;
    readonly installationId?: string;
    readonly startedAt?: number;
    readonly finishedAt: number;
  }): Promise<void> {
    if (input.startedAt === undefined) return;
    const durationMs = Math.max(0, input.finishedAt - input.startedAt);
    const quantity = durationMs / 60_000;
    await this.#store.putUsageEvent({
      id: this.#newId("usage"),
      spaceId: input.spaceId,
      ...(input.installationId ? { installationId: input.installationId } : {}),
      runId: input.runId,
      kind: "runner_minute",
      quantity,
      credits: Math.max(1, Math.ceil(quantity)),
      source: "runner",
      idempotencyKey: `${input.runId}:runner_minute`,
      createdAt: new Date(input.finishedAt).toISOString(),
    });
  }

  async #recordDeployOperationMetric(input: {
    readonly run: PlanRun | ApplyRun;
    readonly operationKind: "plan" | "apply" | "destroy_apply";
    readonly status: RunStatus;
    readonly startedAt?: number;
    readonly finishedAt?: number;
    readonly recordApplyDuration?: boolean;
  }): Promise<void> {
    const tags = this.#deployMetricTags(input);
    await this.#recordMetric({
      name: "takosumi_deploy_operation_count",
      kind: "counter",
      value: 1,
      tags,
      observedAtMs: input.finishedAt,
    });
    if (
      input.recordApplyDuration === true &&
      input.startedAt !== undefined &&
      input.finishedAt !== undefined
    ) {
      await this.#recordMetric({
        name: "takosumi_apply_duration_seconds",
        kind: "histogram",
        value: Math.max(0, input.finishedAt - input.startedAt) / 1000,
        tags,
        observedAtMs: input.finishedAt,
      });
    }
  }

  #deployMetricTags(input: {
    readonly run: PlanRun | ApplyRun;
    readonly operationKind: "plan" | "apply" | "destroy_apply";
    readonly status: RunStatus;
  }): Record<string, string> {
    return {
      ...this.#metricTags,
      space_id: input.run.spaceId,
      capsule_id: input.run.installationId ?? "unbound",
      operationKind: input.operationKind,
      status: input.status,
    };
  }

  async #recordMetric(input: {
    readonly name: string;
    readonly kind: "counter" | "gauge" | "histogram";
    readonly value: number;
    readonly tags: Record<string, string>;
    readonly observedAtMs?: number;
  }): Promise<void> {
    if (!this.#observability) return;
    try {
      await this.#observability.recordMetric({
        id: `metric_${crypto.randomUUID()}`,
        name: input.name,
        kind: input.kind,
        value: input.value,
        tags: input.tags,
        observedAt: new Date(input.observedAtMs ?? this.#now()).toISOString(),
      });
    } catch (error) {
      log.warn("deploy_control.metric_record_failed", {
        metric: input.name,
        message: errorMessage(error),
      });
    }
  }

  /**
   * Whether a plan run targets a provider-free §10 install (a template whose
   * policy declares zero allowed providers, e.g. `core`). Such a run is allowed
   * to declare/observe zero providers without tripping the profile's
   * "requiredProviders before init" gate. Resolved from the recorded binding;
   * generic Capsule runs are never provider-free here.
   */
  #planAllowsNoProviders(planRun: PlanRun): boolean {
    const binding = planRun.templateBinding;
    if (!binding) return false;
    const template = this.#templateRegistry.require(
      binding.templateId,
      binding.templateVersion,
    );
    return template.policy.allowedProviders.length === 0;
  }

  async #executeApply(
    applyRun: ApplyRun,
    planRun: PlanRun,
    profile: RunnerProfile,
    dispatch: RunTemplateDispatch,
    lease?: LeaseHandle,
  ): Promise<ApplyRunResponse> {
    const startedAt = this.#now();
    const claim = await this.#markApplyRunning(applyRun, profile, startedAt);
    if (!claim.won) {
      // A sibling consumer already claimed this apply (or a cancel won the row).
      // Do NOT dispatch the runner; return the row the winner persisted.
      return { applyRun: claim.run };
    }
    const running = claim.run;
    const leaseToken = claim.leaseToken;
    let runningForFailure = running;
    let runnerDispatched = false;

    try {
      const plannedInstallation = await this.#assertApplyPreconditions(
        planRun,
        dispatch,
      );
      // Mint provider credentials NOW (just before dispatch). Apply runs resolve
      // requiredProviders from the reviewed PlanRun. The bundle is attached to the
      // runner dispatch ONLY — never stored, never logged.
      const runEnvironment = await this.#runEnv.resolveRunEnvironment({
        planRun,
        phase: planRun.operation === "destroy" ? "destroy" : "apply",
        auditRunId: running.id,
      });
      const runningWithEnv = withRunEnvironmentEvidence(
        running,
        runEnvironment,
      );
      runningForFailure = runningWithEnv;
      if (planRun.operation === "destroy") {
        return await this.#executeDestroyApply(
          runningWithEnv,
          planRun,
          profile,
          startedAt,
          plannedInstallation,
          runEnvironment.credentials,
          dispatch,
          leaseToken,
          lease,
        );
      }
      // Renewal harness: #dispatchApply's runner.apply() is ONE awaited blocking
      // fetch for the whole tofu run, which can outlive the lease TTL + the
      // heartbeat-stale window. Around it, periodically re-stamp the run
      // heartbeat AND renew the installation/plan lease so a sibling does not
      // treat the run as crashed and take it over mid-apply.
      const {
        result,
        envDispatch,
        persistGeneration,
        providerInstallationPolicy,
      } = await this.#withRunRenewal(
        "apply",
        runningWithEnv,
        leaseToken,
        lease,
        () =>
          this.#dispatchApply({
            running: runningWithEnv,
            planRun,
            profile,
            dispatch,
            credentials: runEnvironment.credentials,
            // Flip the runner-dispatched flag ONLY when the runner is actually
            // invoked, so a throw from the pre-dispatch env/policy resolution does
            // not record runner-minute usage (matches the pre-extraction order).
            onDispatch: () => {
              runnerDispatched = true;
            },
          }),
      );
      const now = this.#now();
      const projected = await this.#projectAndRecordApplyOutputs({
        planRun,
        applyRun,
        plannedInstallation,
        result,
        dispatch,
        now,
      });
      const { deployment, supersededDeployment } =
        await this.#buildApplyDeployment({
          planRun,
          applyRun,
          installation: projected.installation,
          outputs: projected.outputs,
          outputSnapshot: projected.outputSnapshot,
          nextStateGeneration: projected.nextStateGeneration,
          now,
        });
      // Build the terminal ApplyRun + the apply-once PlanRun marker NOW so they
      // commit atomically with the Deployment (commit-tail fold, S2).
      const completed = this.#buildCompletedApplyRun({
        running: runningWithEnv,
        applyRun,
        profile,
        installation: projected.installation,
        deployment,
        outputs: projected.outputs,
        result,
        providerInstallationPolicy,
        startedAt,
        now,
      });
      const appliedPlan: PlanRun = {
        ...planRun,
        appliedApplyRunId: applyRun.id,
        updatedAt: now,
      };
      // ATOMIC ledger commit (spec §20 / §21 / §16): the new (+ superseded)
      // Deployment, the StateSnapshot, the OutputSnapshot, the guarded
      // Installation advance, AND the terminal ApplyRun + applied PlanRun marker
      // land all-or-nothing. A crash mid-write can no longer leave torn state or
      // a stuck `running` run over a finished Deployment.
      const patched = await this.#commitApplyLedger({
        planRun,
        plannedInstallation,
        installation: projected.installation,
        deployment,
        ...(supersededDeployment ? { supersededDeployment } : {}),
        outputSnapshot: projected.outputSnapshot,
        envDispatch,
        persistGeneration,
        nextStateGeneration: projected.nextStateGeneration,
        stateDigest: result.stateDigest,
        runId: applyRun.id,
        applyRunTerminal: completed,
        planRunApplied: appliedPlan,
        applyRunLeaseToken: leaseToken,
        now,
      });
      if (patched === "lease_lost") {
        return { applyRun: (await this.getApplyRun(applyRun.id)).applyRun };
      }
      if (patched) {
        await this.#projectServiceExportsFromApply({
          installation: patched,
          deployment,
          outputSnapshot: projected.outputSnapshot,
        });
        await this.#activateReleaseAfterApply({
          planRun,
          applyRun: completed,
          installation: patched,
          deployment,
          outputSnapshot: projected.outputSnapshot,
          result,
        });
      }
      // §24 stale propagation: when this apply's projected outputs changed
      // versus the Installation's PREVIOUS OutputSnapshot, every transitive
      // downstream consumer in the Space that is currently `active` is marked
      // `stale`. The just-applied Installation itself stays `active` (patched
      // above); pending/error/destroyed consumers are left untouched.
      await this.#markDownstreamInstallationsStale({
        installation: projected.installation,
        previousOutputSnapshot: projected.previousOutputSnapshot,
        newOutputSnapshot: projected.outputSnapshot,
        now,
      });
      return await this.#completeApplyRun({
        completed,
        planRun,
        installation: projected.installation,
        patched,
        deployment,
        outputs: projected.outputs,
        nextStateGeneration: projected.nextStateGeneration,
        dispatch,
        startedAt,
        now,
      });
    } catch (error) {
      await this.#billing.releaseApplyBillingReservation(planRun);
      const failed = await this.#failApplyRun(
        runEnvironmentFailedRun(runningForFailure, error),
        leaseToken,
        profile,
        startedAt,
        "apply.failed",
        error,
      );
      if (runnerDispatched && failed.finishedAt !== undefined) {
        await this.#recordRunnerMinuteUsage({
          spaceId: failed.spaceId,
          runId: failed.id,
          installationId: failed.installationId,
          startedAt,
          finishedAt: failed.finishedAt,
        });
      }
      return { applyRun: failed };
    }
  }

  /**
   * Projects the public DeploymentOutputs for an apply result. Template runs are
   * restricted to the template's allowlisted public outputs (resolved from the
   * recorded binding); generic Capsule runs use the InstallConfig output
   * allowlist captured in the generated-root dispatch.
   * Both run AFTER the sensitive/redaction filter in `projection.ts`.
   */
  #projectApplyOutputs(
    planRun: PlanRun,
    result: OpenTofuApplyResult,
    dispatch: RunTemplateDispatch,
  ): readonly DeploymentOutput[] {
    const binding = planRun.templateBinding;
    if (!binding) {
      if (dispatch.outputAllowlist) {
        return projectOutputAllowlistPublicOutputs(
          dispatch.outputAllowlist,
          result.outputs,
        );
      }
      return normalizeDeploymentOutputs(result.outputs);
    }
    const template = this.#templateRegistry.require(
      binding.templateId,
      binding.templateVersion,
    );
    return projectTemplatePublicOutputs(template, result.outputs);
  }

  /**
   * Re-asserts every apply pre-flight invariant inside the serialized section
   * (immutable plan artifact, apply-once, state generation, source snapshot,
   * dependency snapshot, Capsule compatibility, generated-root dispatch, and
   * billing reservation) just before dispatch. Returns the currently-planned
   * Installation (undefined for runs without installation context).
   */
  async #assertApplyPreconditions(
    planRun: PlanRun,
    dispatch: RunTemplateDispatch,
  ): Promise<Installation | undefined> {
    if (!planRun.planArtifact) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} has no immutable plan artifact`,
      );
    }
    // Apply-once re-check inside the serialized section: a concurrent apply of the
    // same PlanRun is serialized on its id, so re-read the persisted PlanRun here
    // to observe a sibling apply that already completed and marked it applied.
    const persistedPlan = await this.#store.getPlanRun(planRun.id);
    if (persistedPlan?.appliedApplyRunId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} has already been applied by apply run ${persistedPlan.appliedApplyRunId}`,
      );
    }
    const plannedInstallation = planRun.installationId
      ? await this.#requireCurrentPlannedInstallation(planRun)
      : undefined;
    // State generation guard: reject when the target's state advanced past the
    // generation this plan was created against (a stale plan over newer state).
    assertStateGenerationMatches(planRun, plannedInstallation);
    // Env-driven runs guard against the Environment's latest StateSnapshot
    // generation instead of an Installation generation (M2).
    await this.#verification.assertInstallationStateGeneration(planRun);
    // Consumer pre-flight: re-assert the plan still references its SourceSnapshot
    // (spec invariant 10) just before dispatch, mirroring the digest/generation
    // pre-flight checks.
    await this.#verification.revalidateSourceSnapshot(planRun);
    // DependencySnapshot verification (spec §17 / invariant 9): when the plan
    // pinned a DependencySnapshot, re-read it and verify producer state
    // generations (strict mode) + recompute the pinned values digests (tamper
    // check) before applying. A moved producer (strict) is
    // `dependency_snapshot_stale`; a digest mismatch is
    // `dependency_snapshot_tampered`.
    await this.#verification.verifyDependencySnapshot(planRun);
    await this.#verification.assertCapsuleCompatibilityAllowsRun(planRun);
    assertGeneratedRootDispatchPresent(planRun, dispatch);
    await this.#billing.assertApplyBillingReservation(planRun);
    return plannedInstallation;
  }

  /**
   * Dispatches the non-destroy apply to the runner. Resolves the M2 env dispatch
   * (state scope at `base + 1` + source archive + dependency states) and the
   * provider-installation mirror policy, then runs `runner.apply` with the minted
   * credentials (dispatch-only — never persisted).
   */
  async #dispatchApply(input: {
    readonly running: ApplyRun;
    readonly planRun: PlanRun;
    readonly profile: RunnerProfile;
    readonly dispatch: RunTemplateDispatch;
    readonly credentials: RunCredentials | undefined;
    /** Fired immediately before the runner is invoked (runner-dispatched flag). */
    readonly onDispatch: () => void;
  }): Promise<{
    result: OpenTofuApplyResult;
    envDispatch: RunInstallationDispatch;
    persistGeneration: number;
    providerInstallationPolicy: { requireMirror: boolean } | undefined;
  }> {
    const { running, planRun, profile, dispatch, credentials } = input;
    // Narrowed by #assertApplyPreconditions; re-checked here for the type guard.
    const planArtifact = planRun.planArtifact;
    if (!planArtifact) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} has no immutable plan artifact`,
      );
    }
    // M2 env dispatch: an apply persists state at `base + 1` (the DO writes the
    // new state object + current.json at this generation). Empty without env ctx.
    const persistGeneration = (planRun.baseStateGeneration ?? 0) + 1;
    const envDispatch = await this.#verification.installationDispatch(
      planRun,
      persistGeneration,
    );
    const planPolicy = await this.#policyForPlanRun(planRun);
    const providerInstallationPolicy =
      planPolicy?.providerInstallation?.requireMirror === true
        ? { requireMirror: true }
        : undefined;
    input.onDispatch();
    const runner = this.#runnerForProfile(profile);
    const result = await runner.apply({
      applyRun: running,
      planRun,
      planArtifact,
      runnerProfile: profile,
      ...(providerInstallationPolicy ? { providerInstallationPolicy } : {}),
      // Generated-root dispatch: apply tofu in the reviewed root.
      ...(dispatch.generatedRoot
        ? { generatedRoot: dispatch.generatedRoot }
        : {}),
      ...(dispatch.build ? { build: dispatch.build } : {}),
      // M2 env dispatch (state scope at base+1 + source archive).
      ...(envDispatch.stateScope ? { stateScope: envDispatch.stateScope } : {}),
      ...(envDispatch.sourceArchive
        ? { sourceArchive: envDispatch.sourceArchive }
        : {}),
      // remote_state dependency states materialized into /work/deps (spec §15).
      ...(envDispatch.depStates ? { depStates: envDispatch.depStates } : {}),
      ...(credentials ? { credentials } : {}),
    });
    return {
      result,
      envDispatch,
      persistGeneration,
      providerInstallationPolicy,
    };
  }

  /**
   * Projects the apply outputs and BUILDS the §16 OutputSnapshot (persisted
   * later, atomically, by `commitAppliedDeployment`). Returns the resolved
   * Installation, the bumped state generation, the new OutputSnapshot, and the
   * Installation's PREVIOUS OutputSnapshot (which drives §24 stale propagation).
   */
  async #projectAndRecordApplyOutputs(input: {
    readonly planRun: PlanRun;
    readonly applyRun: ApplyRun;
    readonly plannedInstallation: Installation | undefined;
    readonly result: OpenTofuApplyResult;
    readonly dispatch: RunTemplateDispatch;
    readonly now: number;
  }): Promise<{
    outputs: readonly DeploymentOutput[];
    installation: Installation;
    nextStateGeneration: number;
    previousOutputSnapshot: OutputSnapshot | undefined;
    outputSnapshot: OutputSnapshot;
  }> {
    const { planRun, applyRun, result, dispatch, now } = input;
    // Output allowlist: a template run projects ONLY the template's public
    // outputs after the existing sensitive/redaction filter. Generic Capsule
    // runs use InstallConfig.outputAllowlist for both dependency-consumable
    // space outputs and public Deployment outputs.
    const outputs = this.#projectApplyOutputs(planRun, result, dispatch);
    const installation =
      input.plannedInstallation ??
      (await this.#requireCurrentPlannedInstallation(planRun));
    // Bump the state generation atomically with the state persist (the
    // currentDeployment pointer move). A create starts at base 0 -> 1; an
    // update advances the installation's generation by one.
    const nextStateGeneration = installation.currentStateGeneration + 1;
    // §16 OutputSnapshot: capture the allowlisted projected outputs after a
    // successful apply. Sensitive-flagged outputs appear in NEITHER
    // projection; the raw envelope stays an encrypted artifact referenced by
    // rawOutputArtifactKey. The Installation's PREVIOUS snapshot digest drives
    // stale propagation (§24) after this record.
    const previousOutputSnapshot = installation.currentOutputSnapshotId
      ? await this.#store.getOutputSnapshot(
          installation.currentOutputSnapshotId,
        )
      : undefined;
    const outputSnapshot = await this.#buildOutputSnapshot({
      installation,
      applyRun,
      result,
      publicOutputs: outputs,
      ...(dispatch.outputAllowlist
        ? { outputAllowlist: dispatch.outputAllowlist }
        : {}),
      stateGeneration: nextStateGeneration,
      now,
    });
    validateProjectedServiceExportsFromOutputSnapshot(
      outputSnapshot.spaceOutputs as Readonly<Record<string, JsonValue>>,
    );
    return {
      outputs,
      installation,
      nextStateGeneration,
      previousOutputSnapshot,
      outputSnapshot,
    };
  }

  /**
   * Builds the §21 Deployment for a successful apply AND the superseded
   * transition for the Installation's previously-current Deployment. READS the
   * previous Deployment (so the superseded record carries its full row), but
   * writes NOTHING: both records are persisted atomically with the StateSnapshot
   * / OutputSnapshot / Installation advance by `commitAppliedDeployment`.
   */
  async #buildApplyDeployment(input: {
    readonly planRun: PlanRun;
    readonly applyRun: ApplyRun;
    readonly installation: Installation;
    readonly outputs: readonly DeploymentOutput[];
    readonly outputSnapshot: OutputSnapshot;
    readonly nextStateGeneration: number;
    readonly now: number;
  }): Promise<{
    readonly deployment: Deployment;
    readonly supersededDeployment?: Deployment;
  }> {
    const { planRun, applyRun, installation, outputs, now } = input;
    if (!planRun.sourceSnapshotId) {
      throw new Error(
        `PlanRun ${planRun.id} has no SourceSnapshot for Deployment recording`,
      );
    }
    const deployment: Deployment = {
      id: this.#newId("dep"),
      spaceId: planRun.spaceId,
      installationId: installation.id,
      environment: installation.environment,
      applyRunId: applyRun.id,
      sourceSnapshotId: planRun.sourceSnapshotId,
      ...(planRun.dependencySnapshotId
        ? { dependencySnapshotId: planRun.dependencySnapshotId }
        : {}),
      stateGeneration: input.nextStateGeneration,
      outputSnapshotId: input.outputSnapshot.id,
      outputsPublic: Object.fromEntries(
        outputs.map((output) => [output.name, output.value]),
      ),
      status: "active",
      createdAt: new Date(now).toISOString(),
    };
    // §21 status transition: the previously-current Deployment is superseded by
    // the new active one. Only an `active` previous is flipped (matches the
    // pre-atomic behavior); the read is done now so the write can be batched.
    if (installation.currentDeploymentId) {
      const previous = await this.#store.getDeployment(
        installation.currentDeploymentId,
      );
      if (previous && previous.status === "active") {
        return {
          deployment,
          supersededDeployment: { ...previous, status: "superseded" },
        };
      }
    }
    return { deployment };
  }

  /**
   * Atomically commits the ledger writes that finalize a successful apply:
   * the new (and superseded) Deployment, the StateSnapshot at `persistGeneration`,
   * the OutputSnapshot, and the GUARDED Installation advance — as ONE all-or-
   * nothing unit (spec §20 / §21 / §16) so a crash mid-write cannot leave torn
   * state. Returns the patched Installation (or undefined when the guarded patch
   * did not apply), exactly as the prior scattered-awaits sequence.
   */
  async #commitApplyLedger(input: {
    readonly planRun: PlanRun;
    readonly plannedInstallation: Installation | undefined;
    readonly installation: Installation;
    readonly deployment: Deployment;
    readonly supersededDeployment?: Deployment;
    readonly outputSnapshot: OutputSnapshot;
    readonly envDispatch: RunInstallationDispatch;
    readonly persistGeneration: number;
    readonly nextStateGeneration: number;
    readonly stateDigest: string | undefined;
    readonly runId: string;
    /**
     * Commit-tail fold (S2): the succeeded ApplyRun + the applied PlanRun are
     * committed in the SAME atomic unit as the Deployment so a crash can never
     * tear them apart. On the no-state-context fallback path (no atomic unit)
     * they are written here through the same terminal-run / put paths the tail
     * used before the fold.
     */
    readonly applyRunTerminal: ApplyRun;
    readonly planRunApplied: PlanRun;
    readonly applyRunLeaseToken: string;
    readonly now: number;
  }): Promise<Installation | "lease_lost" | undefined> {
    const { planRun, installation, deployment, outputSnapshot, now } = input;
    // StateSnapshot metadata aligned to the SAME generation written to R2_STATE
    // (persistGeneration); the DO wrote the encrypted object + current.json at
    // this key, only metadata enters the ledger. Built (not yet persisted) so it
    // commits together with the installation generation bump.
    const stateSnapshot = this.#buildStateSnapshot({
      envDispatch: input.envDispatch,
      generation: input.persistGeneration,
      stateDigest: input.stateDigest,
      runId: input.runId,
      now,
    });
    if (!stateSnapshot) {
      // No environment context => no StateSnapshot, so there is no atomic unit
      // to commit beyond the guarded installation patch. Preserve the prior
      // behavior: patch the installation (deployment/outputSnapshot were already
      // built and are recorded via the patch's pointers) directly. In practice
      // an apply that reaches here always has a state scope; this branch only
      // guards the type.
      await this.#store.putDeployment(deployment);
      if (input.supersededDeployment) {
        await this.#store.putDeployment(input.supersededDeployment);
      }
      await this.#store.putOutputSnapshot(outputSnapshot);
      const patched = await this.#store.patchInstallation(
        installation.id,
        {
          currentDeploymentId: deployment.id,
          status: "active",
          updatedAt: new Date(now).toISOString(),
          currentStateGeneration: input.nextStateGeneration,
          currentOutputSnapshotId: outputSnapshot.id,
        },
        {
          currentDeploymentId:
            planRun.installationCurrentDeploymentId ?? undefined,
          status: input.plannedInstallation?.status,
        },
      );
      // Fallback path (no env context, no atomic unit): write the commit-tail
      // runs the way the tail did before the fold — the terminal ApplyRun via
      // the lease-clearing transition, then the apply-once PlanRun marker.
      const persisted = await this.#persistTerminalRun(
        "apply",
        input.applyRunTerminal,
        input.applyRunLeaseToken,
      );
      if (!persisted.won) return "lease_lost";
      await this.#store.putPlanRun(input.planRunApplied);
      return patched;
    }
    const committed = await this.#store.commitAppliedDeployment({
      newDeployment: deployment,
      ...(input.supersededDeployment
        ? { supersededDeployment: input.supersededDeployment }
        : {}),
      stateSnapshot,
      outputSnapshot,
      installationPatch: {
        id: installation.id,
        patch: {
          currentDeploymentId: deployment.id,
          status: "active",
          updatedAt: new Date(now).toISOString(),
          currentStateGeneration: input.nextStateGeneration,
          currentOutputSnapshotId: outputSnapshot.id,
        },
        guard: {
          currentDeploymentId:
            planRun.installationCurrentDeploymentId ?? undefined,
          status: input.plannedInstallation?.status,
        },
      },
      // Commit-tail fold (S2): terminal ApplyRun + applied PlanRun in the unit.
      applyRunTerminal: input.applyRunTerminal,
      planRunApplied: input.planRunApplied,
      applyRunLeaseToken: input.applyRunLeaseToken,
    });
    if (committed.applyRunLeaseLost) return "lease_lost";
    return committed.installation;
  }

  async #projectServiceExportsFromApply(input: {
    readonly installation: Installation;
    readonly deployment: Deployment;
    readonly outputSnapshot: OutputSnapshot;
  }): Promise<void> {
    if (!this.#serviceGraphService) return;
    try {
      await this.#serviceGraphService.projectExportsFromOutputSnapshot({
        workspaceId: input.installation.spaceId,
        producerCapsuleId: input.installation.id,
        applyRunId: input.deployment.applyRunId,
        outputId: input.outputSnapshot.id,
        outputGeneration: input.outputSnapshot.stateGeneration,
        outputs: input.outputSnapshot.spaceOutputs as Readonly<
          Record<string, JsonValue>
        >,
      });
    } catch (error) {
      log.warn("service.deploy_control.service_graph_projection_failed", {
        installationId: input.installation.id,
        deploymentId: input.deployment.id,
        outputSnapshotId: input.outputSnapshot.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #activateReleaseAfterApply(input: {
    readonly planRun: PlanRun;
    readonly applyRun: ApplyRun;
    readonly installation: Installation;
    readonly deployment: Deployment;
    readonly outputSnapshot: OutputSnapshot;
    readonly result: OpenTofuApplyResult;
  }): Promise<void> {
    if (!this.#releaseActivator) return;
    const nonSensitiveOutputs = releaseActivationOutputs(input.result.outputs);
    let result: ReleaseActivationResult;
    try {
      result = await this.#releaseActivator.activate({
        planRun: input.planRun,
        applyRun: input.applyRun,
        installation: input.installation,
        deployment: input.deployment,
        outputSnapshot: input.outputSnapshot,
        nonSensitiveOutputs,
      });
    } catch (error) {
      await this.#recordReleaseActivationActivity({
        ...input,
        status: "failed",
        message: errorMessage(error),
        outputCount: Object.keys(nonSensitiveOutputs).length,
      });
      return;
    }
    if (result.status === "skipped") return;
    await this.#recordReleaseActivationActivity({
      ...input,
      status: result.status,
      kind: result.kind,
      message: result.message,
      hasLaunchUrl: Boolean(result.launchUrl),
      hasHealthUrl: Boolean(result.healthUrl),
      metadataKeys: Object.keys(result.metadata ?? {}).sort(),
      outputCount: Object.keys(nonSensitiveOutputs).length,
    });
  }

  async #recordReleaseActivationActivity(input: {
    readonly applyRun: ApplyRun;
    readonly installation: Installation;
    readonly deployment: Deployment;
    readonly status: Exclude<ReleaseActivationStatus, "skipped">;
    readonly kind?: string;
    readonly message?: string;
    readonly hasLaunchUrl?: boolean;
    readonly hasHealthUrl?: boolean;
    readonly metadataKeys?: readonly string[];
    readonly outputCount: number;
  }): Promise<void> {
    await this.#recordActivity({
      spaceId: input.applyRun.spaceId,
      action: `release_activation.${input.status}`,
      targetType: "deployment",
      targetId: input.deployment.id,
      runId: input.applyRun.id,
      metadata: {
        installationId: input.installation.id,
        deploymentId: input.deployment.id,
        applyRunId: input.applyRun.id,
        outputCount: input.outputCount,
        ...(input.kind ? { activationKind: input.kind } : {}),
        ...(input.message ? { message: input.message } : {}),
        ...(input.hasLaunchUrl === undefined
          ? {}
          : { hasLaunchUrl: input.hasLaunchUrl }),
        ...(input.hasHealthUrl === undefined
          ? {}
          : { hasHealthUrl: input.hasHealthUrl }),
        ...(input.metadataKeys && input.metadataKeys.length > 0
          ? { metadataKeys: [...input.metadataKeys] }
          : {}),
      },
    });
  }

  /**
   * §24 stale propagation for an apply: a thin named wrapper over
   * `#propagateStale` so the top-level apply flow reads as a sequence of named
   * steps.
   */
  async #markDownstreamInstallationsStale(input: {
    readonly installation: Installation;
    readonly previousOutputSnapshot: OutputSnapshot | undefined;
    readonly newOutputSnapshot: OutputSnapshot;
    readonly now: number;
  }): Promise<void> {
    await this.#propagateStale(input);
  }

  /**
   * Builds the terminal (`succeeded`) ApplyRun for a non-destroy apply. The run
   * is BUILT here (not persisted): it is committed atomically with the Deployment
   * by {@link #commitApplyLedger} (commit-tail fold, S2) so the terminal status
   * can never tear from the Deployment it produced.
   */
  #buildCompletedApplyRun(input: {
    readonly running: ApplyRun;
    readonly applyRun: ApplyRun;
    readonly profile: RunnerProfile;
    readonly installation: Installation;
    readonly deployment: Deployment;
    readonly outputs: readonly DeploymentOutput[];
    readonly result: OpenTofuApplyResult;
    readonly providerInstallationPolicy: { requireMirror: boolean } | undefined;
    readonly startedAt: number;
    readonly now: number;
  }): ApplyRun {
    const { running, applyRun, profile, installation, deployment, outputs } =
      input;
    const { result, startedAt, now } = input;
    const diagnostics = redactRunDiagnostics(result.diagnostics);
    return {
      ...running,
      installationId: installation.id,
      deploymentId: deployment.id,
      status: "succeeded",
      stateLock:
        result.stateLock ??
        stateLockEvidence(profile.stateBackend, startedAt, now, "recorded"),
      outputs,
      ...(diagnostics ? { diagnostics } : {}),
      auditEvents: [
        ...running.auditEvents,
        ...providerInstallationAuditEvents(
          applyRun.id,
          "apply",
          now,
          result.providerInstallation,
          input.providerInstallationPolicy,
        ),
        auditEvent(applyRun.id, "apply.completed", now, {
          deploymentId: deployment.id,
          outputCount: outputs.length,
        }),
      ],
      updatedAt: now,
      finishedAt: now,
    };
  }

  /**
   * Finalizes a successful apply AFTER the atomic commit-tail fold has already
   * persisted the terminal ApplyRun + the applied PlanRun marker (S2): records
   * runner-minute usage, captures billing usage (own idempotencyKey, so it stays
   * OUTSIDE the atomic unit), drops the retained generated-root inputs sidecar,
   * and emits the §27 / §34 activity. Returns the apply response.
   */
  async #completeApplyRun(input: {
    readonly completed: ApplyRun;
    readonly planRun: PlanRun;
    readonly installation: Installation;
    readonly patched: Installation | undefined;
    readonly deployment: Deployment;
    readonly outputs: readonly DeploymentOutput[];
    readonly nextStateGeneration: number;
    readonly dispatch: RunTemplateDispatch;
    readonly startedAt: number;
    readonly now: number;
  }): Promise<ApplyRunResponse> {
    const {
      completed,
      planRun,
      installation,
      deployment,
      outputs,
      dispatch,
      startedAt,
      now,
    } = input;
    await this.#recordRunnerMinuteUsage({
      spaceId: completed.spaceId,
      runId: completed.id,
      installationId: completed.installationId,
      startedAt,
      finishedAt: now,
    });
    await this.#recordDeployOperationMetric({
      run: completed,
      operationKind: "apply",
      status: "succeeded",
      startedAt,
      finishedAt: now,
      recordApplyDuration: true,
    });
    await this.#billing.captureApplyBillingUsage({
      planRun,
      applyRun: completed,
      now,
    });
    // The retained generated-root inputs sidecar is no longer needed once applied.
    if (dispatch.generatedRoot) {
      await this.#store.deletePlanRunInputs(planRun.id);
    }
    // Activity (§27 / §34): a successful apply produced a new Deployment. Run
    // id + deployment id + state generation + output COUNT only (never output
    // values).
    await this.#recordActivity({
      spaceId: completed.spaceId,
      action: "run.applied",
      targetType: "run",
      targetId: completed.id,
      runId: completed.id,
      metadata: {
        installationId: installation.id,
        deploymentId: deployment.id,
        stateGeneration: input.nextStateGeneration,
        outputCount: outputs.length,
      },
    });
    return {
      applyRun: completed,
      installation: input.patched ?? installation,
      deployment,
    };
  }

  async #executeDestroyApply(
    running: ApplyRun,
    planRun: PlanRun,
    profile: RunnerProfile,
    startedAt: number,
    plannedInstallation: Installation | undefined,
    credentials: RunCredentials | undefined,
    dispatch: RunTemplateDispatch,
    leaseToken: string,
    lease?: LeaseHandle,
  ): Promise<ApplyRunResponse> {
    if (!planRun.planArtifact) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} has no immutable destroy plan artifact`,
      );
    }
    if (!planRun.installationId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "destroy apply requires a PlanRun with installationId",
      );
    }
    const installation =
      plannedInstallation ??
      (await this.#requireCurrentPlannedInstallation(planRun));
    // A destroy_apply persists the post-teardown state at `base + 1`. Empty for
    // runs without installation context.
    const persistGeneration = (planRun.baseStateGeneration ?? 0) + 1;
    const envDispatch = await this.#verification.installationDispatch(
      planRun,
      persistGeneration,
    );
    const planPolicy = await this.#policyForPlanRun(planRun);
    const providerInstallationPolicy =
      planPolicy?.providerInstallation?.requireMirror === true
        ? { requireMirror: true }
        : undefined;
    let runnerDispatched = false;
    try {
      const runner = this.#runnerForProfile(profile);
      if (typeof runner.destroy !== "function") {
        // Without a real teardown the Installation must NOT be marked
        // destroyed: doing so would record a successful destroy in the ledger
        // while the underlying cloud resources keep running (silent leak).
        throw new OpenTofuControllerError(
          "failed_precondition",
          "runner does not implement destroy; refusing to mark installation destroyed without teardown",
        );
      }
      runnerDispatched = true;
      const destroyFn = runner.destroy;
      // Renewal harness: destroy is ONE awaited blocking fetch for the whole
      // tofu teardown; re-stamp the heartbeat + renew the lease around it so a
      // long destroy is not taken over by a sibling. clearInterval on every exit.
      const result = await this.#withRunRenewal(
        "apply",
        running,
        leaseToken,
        lease,
        () =>
          destroyFn.call(runner, {
            applyRun: running,
            planRun,
            planArtifact: planRun.planArtifact!,
            installation,
            runnerProfile: profile,
            ...(providerInstallationPolicy
              ? { providerInstallationPolicy }
              : {}),
            // Generated-root dispatch: destroy tofu in the reviewed root.
            ...(dispatch.generatedRoot
              ? { generatedRoot: dispatch.generatedRoot }
              : {}),
            ...(dispatch.build ? { build: dispatch.build } : {}),
            // M2 env dispatch (state scope at base+1 + source archive).
            ...(envDispatch.stateScope
              ? { stateScope: envDispatch.stateScope }
              : {}),
            ...(envDispatch.sourceArchive
              ? { sourceArchive: envDispatch.sourceArchive }
              : {}),
            // remote_state dependency states materialized into /work/deps (§15):
            // the teardown config still refreshes its `terraform_remote_state` data
            // sources, so the producer state files must be present.
            ...(envDispatch.depStates
              ? { depStates: envDispatch.depStates }
              : {}),
            ...(credentials ? { credentials } : {}),
          }),
      );
      const now = this.#now();
      // Build the post-teardown StateSnapshot at the SAME generation the DO
      // wrote to R2_STATE, plus the destroyed-Deployment transition, then commit
      // them ATOMICALLY with the Installation generation advance so a stale plan
      // created against the pre-destroy generation cannot re-apply and a crash
      // mid-write cannot leave torn state (spec §20 / §21).
      const stateSnapshot = this.#buildStateSnapshot({
        envDispatch,
        generation: persistGeneration,
        stateDigest: undefined,
        runId: running.id,
        now,
      });
      let destroyedDeployment: Deployment | undefined;
      if (installation.currentDeploymentId) {
        const previous = await this.#store.getDeployment(
          installation.currentDeploymentId,
        );
        if (previous && previous.status !== "destroyed") {
          destroyedDeployment = { ...previous, status: "destroyed" };
        }
      }
      const nextStateGeneration = installation.currentStateGeneration + 1;
      const destroyPatch = {
        id: installation.id,
        patch: {
          currentDeploymentId: undefined,
          status: "destroyed" as const,
          updatedAt: new Date(now).toISOString(),
          currentStateGeneration: nextStateGeneration,
        },
        guard: {
          currentDeploymentId:
            planRun.installationCurrentDeploymentId ?? undefined,
          status: installation.status,
        },
      };
      // Build the terminal (`succeeded`) destroy-apply ApplyRun + the apply-once
      // PlanRun marker NOW so they commit atomically with the destroy ledger
      // writes (commit-tail fold, S2): a torn tail can no longer leave a stuck
      // `running` destroy run over a finished teardown.
      const diagnostics = redactRunDiagnostics(result?.diagnostics);
      const completed: ApplyRun = {
        ...running,
        status: "succeeded",
        stateLock: stateLockEvidence(
          profile.stateBackend,
          startedAt,
          now,
          "recorded",
        ),
        ...(diagnostics ? { diagnostics } : {}),
        auditEvents: [
          ...running.auditEvents,
          ...providerInstallationAuditEvents(
            running.id,
            "destroy",
            now,
            result?.providerInstallation,
            providerInstallationPolicy,
          ),
          auditEvent(running.id, "destroy.completed", now, {
            installationId: installation.id,
          }),
          auditEvent(running.id, "apply.completed", now, {
            operation: "destroy",
            installationId: installation.id,
          }),
        ],
        updatedAt: now,
        finishedAt: now,
      };
      const appliedPlan: PlanRun = {
        ...planRun,
        appliedApplyRunId: running.id,
        updatedAt: now,
      };
      let patched: Installation | undefined;
      if (stateSnapshot) {
        const committed = await this.#store.commitAppliedDeployment({
          ...(destroyedDeployment
            ? { supersededDeployment: destroyedDeployment }
            : {}),
          stateSnapshot,
          installationPatch: destroyPatch,
          // Commit-tail fold (S2): terminal destroy-apply + applied PlanRun.
          applyRunTerminal: completed,
          planRunApplied: appliedPlan,
          applyRunLeaseToken: leaseToken,
        });
        if (committed.applyRunLeaseLost) {
          return { applyRun: (await this.getApplyRun(running.id)).applyRun };
        }
        patched = committed.installation;
      } else {
        // No environment context => no StateSnapshot, no atomic unit. Preserve
        // the prior (deployment flip + guarded patch) sequence and write the
        // commit-tail runs the way the tail did before the fold.
        if (destroyedDeployment) {
          await this.#store.putDeployment(destroyedDeployment);
        }
        patched = await this.#store.patchInstallation(
          destroyPatch.id,
          destroyPatch.patch,
          destroyPatch.guard,
        );
        const persisted = await this.#persistTerminalRun(
          "apply",
          completed,
          leaseToken,
        );
        if (!persisted.won) {
          return { applyRun: persisted.run };
        }
        await this.#store.putPlanRun(appliedPlan);
      }
      await this.#recordRunnerMinuteUsage({
        spaceId: completed.spaceId,
        runId: completed.id,
        installationId: completed.installationId,
        startedAt,
        finishedAt: now,
      });
      await this.#recordDeployOperationMetric({
        run: completed,
        operationKind: "destroy_apply",
        status: "succeeded",
        startedAt,
        finishedAt: now,
        recordApplyDuration: true,
      });
      await this.#billing.captureApplyBillingUsage({
        planRun,
        applyRun: completed,
        now,
      });
      if (dispatch.generatedRoot) {
        await this.#store.deletePlanRunInputs(planRun.id);
      }
      // Activity (§27 / §34): a successful destroy tore the Installation down.
      await this.#recordActivity({
        spaceId: completed.spaceId,
        action: "run.destroyed",
        targetType: "run",
        targetId: completed.id,
        runId: completed.id,
        metadata: {
          installationId: installation.id,
          stateGeneration: nextStateGeneration,
        },
      });
      return {
        applyRun: completed,
        installation: publicInstallation(patched ?? installation),
      };
    } catch (error) {
      await this.#billing.releaseApplyBillingReservation(planRun);
      if (error instanceof InstallationPatchGuardConflict) {
        throw new OpenTofuControllerError("failed_precondition", error.message);
      }
      const failed = await this.#failApplyRun(
        running,
        leaseToken,
        profile,
        startedAt,
        "destroy.failed",
        error,
      );
      if (runnerDispatched && failed.finishedAt !== undefined) {
        await this.#recordRunnerMinuteUsage({
          spaceId: failed.spaceId,
          runId: failed.id,
          installationId: failed.installationId,
          startedAt,
          finishedAt: failed.finishedAt,
        });
      }
      return {
        applyRun: failed,
        installation: publicInstallation(installation),
      };
    }
  }

  async #requireRunnerProfile(id: string): Promise<RunnerProfile> {
    requireNonEmptyString(id, "runnerProfileId");
    const profile = await this.#store.getRunnerProfile(id);
    if (!profile) {
      throw new OpenTofuControllerError(
        "not_found",
        `runner profile ${id} not found`,
      );
    }
    return profile;
  }

  async #requirePlanRun(id: string): Promise<PlanRun> {
    const planRun = await this.#store.getPlanRun(id);
    if (!planRun) {
      throw new OpenTofuControllerError(
        "not_found",
        `plan run ${id} not found`,
      );
    }
    return planRun;
  }

  async #requireInstallation(id: string): Promise<Installation> {
    return await requireInstallation(this.#store, id);
  }

  async #requireCurrentPlannedInstallation(
    planRun: PlanRun,
  ): Promise<Installation> {
    if (!planRun.installationId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "PlanRun does not target an existing Installation",
      );
    }
    const installation = await this.#requireInstallation(
      planRun.installationId,
    );
    validatePlannedInstallationCurrent({ planRun, installation });
    return installation;
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
 * at creation; if the target Installation's generation has advanced since (a
 * successful apply/destroy ran in between), this plan is stale and must not
 * apply over the newer state. `create` plans (no planned installation) are
 * exempt — they have no prior generation to race.
 */
function assertStateGenerationMatches(
  planRun: PlanRun,
  plannedInstallation: Installation | undefined,
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

async function checkApplyExpected(
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
  "installationId",
  "currentDeploymentId",
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
  if (
    planRun.installationId &&
    planRun.installationCurrentDeploymentId === undefined
  ) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "PlanRun has no installation current Deployment guard",
    );
  }
  return {
    planRunId: planRun.id,
    ...(planRun.installationId
      ? { installationId: planRun.installationId }
      : {}),
    ...(planRun.installationId
      ? { currentDeploymentId: planRun.installationCurrentDeploymentId ?? null }
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
function installConfigTemplateBinding(config: InstallConfig):
  | {
      readonly templateId: string;
      readonly templateVersion: string;
      readonly inputs?: Readonly<Record<string, JsonValue>>;
    }
  | undefined {
  if (!config.templateBinding) return undefined;
  const inputs = config.variableMapping;
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

function mergeJsonVariableDefaults(
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
    out[key] =
      isJsonObject(existing) && isJsonObject(value)
        ? deepMergeJsonRecords(existing, value)
        : value;
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
    out[key] =
      isJsonObject(existing) && isJsonObject(value)
        ? deepMergeJsonRecords(existing, value)
        : value;
  }
  return out;
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
function stateObjectKeyForScope(scope: DispatchStateScope): string {
  const seg = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const generation = String(scope.generation).padStart(8, "0");
  return `spaces/${seg(scope.spaceId)}/installations/${seg(
    scope.installationId,
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
function rawOutputArtifactKey(input: {
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
 * In-memory Source for an upload-origin Installation that has no registered
 * Source row. It is never persisted; it only supplies the few fields the plan
 * pipeline reads (`url` / `defaultRef` / `defaultPath`) so the generated-root
 * module-source descriptor validates. The runner still restores the actual code
 * from the snapshot's `archiveObjectKey`, so the synthetic git url is metadata.
 */
function syntheticUploadSource(
  installation: Installation,
  snapshot: SourceSnapshot,
): Source {
  return {
    id: `upload:${installation.id}`,
    spaceId: installation.spaceId,
    name: `${installation.name}-upload`,
    url: snapshot.url,
    defaultRef: snapshot.ref,
    defaultPath: snapshot.path,
    status: "active",
    createdAt: snapshot.fetchedAt,
    updatedAt: snapshot.fetchedAt,
  };
}

function snapshotModuleSource(
  source: Source,
  snapshot: SourceSnapshot,
): OpenTofuModuleSource {
  return {
    kind: "git",
    url: normalizeGitUrlToHttps(source.url),
    ...(snapshot.resolvedCommit
      ? { commit: snapshot.resolvedCommit.toLowerCase() }
      : {}),
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
 * sidecar. Sidecars carry `generatedRoot` (+ optional build/output allowlist)
 * for built-in modules and generic Capsules. Defensive copies are not needed
 * because the store hands back its own records and the runner job only reads.
 */
function templateDispatchFromInputs(
  inputs:
    | {
        readonly generatedRoot?: DispatchGeneratedRoot;
        readonly outputAllowlist?: InstallConfig["outputAllowlist"];
        readonly build?: DispatchBuildSpec;
      }
    | undefined,
): RunTemplateDispatch {
  if (!inputs) return {};
  return {
    ...(inputs.generatedRoot ? { generatedRoot: inputs.generatedRoot } : {}),
    ...(inputs.outputAllowlist
      ? { outputAllowlist: inputs.outputAllowlist }
      : {}),
    ...(inputs.build ? { build: inputs.build } : {}),
  };
}

function assertGeneratedRootDispatchPresent(
  planRun: PlanRun,
  dispatch: RunTemplateDispatch,
): void {
  if (!planRun.installationId || dispatch.generatedRoot) return;
  throw new OpenTofuControllerError(
    "failed_precondition",
    `generated_root_sidecar_missing: plan run ${planRun.id} is Installation-bound but has no generated root sidecar`,
  );
}

/**
 * Folds the template plan-JSON policy verdict into the recorded template
 * binding, setting `requiresConfirmation`. Returns `undefined` (binding unchanged
 * / absent) for non-template runs or when there is no policy verdict yet.
 */
function updatedTemplateBinding(
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

function requiredProvidersFromProviderEnvBindings(
  bindings: InstallTypePlanContext["providerEnvBindings"],
): readonly string[] {
  return normalizeProviders(
    bindings.map((binding) => canonicalProviderAddress(binding.provider)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerInstallationAuditEvents(
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
  /(?:^|[_-])(token|secret|password|passwd|credential|auth|bearer|session|cookie|key)(?:$|[_-])/i;
const RELEASE_ACTIVATION_SECRET_VALUE_RE =
  /(?:token|secret|password|passwd|credential|auth|bearer|session|cookie|key)/i;

function releaseActivationOutputs(
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

function changedOutputNamesBetween(
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

function directChangedDependencyOutputs(input: {
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

function auditEvent(
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

function redactRunApproval(
  approval: RunApproval | undefined,
): RunApproval | undefined {
  if (!approval) return undefined;
  return {
    ...approval,
    ...(approval.reason ? { reason: redactString(approval.reason) } : {}),
  };
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Whether a run status is settled — the run engine will not dispatch / re-run it.
 * The unified RunStatus has no `blocked`; `waiting_approval` is settled for this
 * purpose (the plan execution finished and is parked awaiting a human approval,
 * so a DLQ retry must NOT re-fail it).
 */
function isTerminalStatus(status: RunStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "waiting_approval" ||
    status === "expired" ||
    status === "cancelled"
  );
}
