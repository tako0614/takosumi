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
  InstallBuildConfig,
  InstallConfig,
  Installation,
  InstallType,
  OpenTofuModuleSource,
  PlanRunInstallationContext,
  StateSnapshot,
  ListConnectionsResponse,
  CloudflareApiProxyConfig,
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
  RunnerProfile,
  RunnerStateLockEvidence,
  RunDiagnostic,
  RunStatus,
  TemplateDefinition,
  TestConnectionResponse,
} from "@takosumi/internal/deploy-control-api";
import type {
  ListProviderTemplatesResponse,
  ProviderTemplate,
  ProviderTemplateResponse,
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
  ManagedResourceUsageMeter,
  SpaceSubscription,
  UsageEvent,
  UsageEventKind,
  UsageEventSource,
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
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import { log } from "../../shared/log.ts";
import { isValidTenantScriptName } from "../../../providers/cloudflare/hosting/wfp_script_name.ts";
import { signCfProxyScope } from "../../../providers/cloudflare/hosting/cf_proxy_signature.ts";
import {
  InMemoryOpenTofuDeploymentStore,
  InstallationPatchGuardConflict,
  type OpenTofuDeploymentStore,
  type PlanRunInputs,
} from "./store.ts";
import {
  mapVaultError,
  OpenTofuControllerError,
  requireNonEmptyString,
} from "./errors.ts";
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
  type TemplateInputValue,
  type TemplateRegistry,
  validateTemplateInputs,
} from "../templates/mod.ts";
import {
  type RootProviderBinding,
  generateGenericCapsuleRoot,
  generateInstallationRoot,
  type GeneratedRootInstallType,
  generateRootModule,
} from "takosumi-rootgen";
import { downstreamClosure } from "takosumi-graph";
import type {
  Run,
  RunCostInfo,
  RunEventsResponse,
  RunLogsResponse,
} from "takosumi-contract/runs";
import type { OutputSnapshot } from "takosumi-contract/output-snapshots";
import type {
  SensitiveOutputResolver,
  SensitiveOutputValue,
} from "../output-shares/mod.ts";
import type {
  Dependency,
  DependencySnapshot,
  DependencySnapshotEntry,
  DependencySnapshotMode,
  SealedDependencyValues,
} from "takosumi-contract/dependencies";
import {
  compactErrorCode,
  projectApplyRun,
  projectPlanRun,
  projectPlanRunCost,
  projectSourceSyncRun,
} from "./projection_run.ts";
import {
  type InstallationCoordination,
  withInstallationLease,
  withPlanLease,
} from "./installation_lease.ts";
import {
  ConnectionsService,
  type ResolvedProviderBinding,
} from "../connections/mod.ts";
import { SourceManagement } from "./source_management.ts";
import { ConnectionManagement } from "./connection_management.ts";
import { DeploymentQuery, requireInstallation } from "./deployment_query.ts";
import {
  BillingService,
  DISABLED_BILLING_SETTINGS,
  type ReconcileStripeSpaceSubscriptionInput,
} from "./billing_service.ts";
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
import { classifyDriftResourceChanges } from "./drift.ts";
import { RunCredentialBroker } from "./run_credential_broker.ts";

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
 * Minted provider credential env vars threaded onto the runner dispatch payload
 * only. The controller fills this from the Connection Vault in the queue
 * consumer just before dispatch; it is NEVER persisted to the store and NEVER
 * logged. For provider-using runs, an absent Vault is fail-closed before runner
 * dispatch so the runner never falls back to ambient provider credentials.
 */
export type RunCredentials = Readonly<Record<string, string>>;

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

/** Internal resolution of a template-backed plan request (never persisted as-is). */
interface ResolvedTemplatePlan {
  readonly template: TemplateDefinition;
  readonly inputs: Readonly<Record<string, TemplateInputValue>>;
  readonly generatedRoot: DispatchGeneratedRoot;
  readonly requiredProviders: readonly string[];
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

export interface OpenTofuDestroyResult {
  readonly diagnostics?: readonly RunDiagnostic[];
  readonly providerInstallation?: readonly ProviderInstallationEvidence[];
}

export interface OpenTofuRunner {
  plan(job: OpenTofuPlanJob): Promise<OpenTofuPlanResult>;
  apply(job: OpenTofuApplyJob): Promise<OpenTofuApplyResult>;
  destroy?(job: OpenTofuDestroyJob): Promise<OpenTofuDestroyResult>;
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
  readonly action: "plan" | "apply" | "source_sync";
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
const PROVIDER_CATALOG_SEED_TIMESTAMP = "2026-06-08T00:00:00.000Z";

function initialProviderTemplates(): readonly ProviderTemplate[] {
  return [
    {
      id: "cloudflare",
      providerSource: "registry.opentofu.org/cloudflare/cloudflare",
      displayName: "Cloudflare",
      recommendedEnvNames: ["CLOUDFLARE_API_TOKEN"],
      helpers: ["cloudflare_api_token", "cloudflare_oauth"],
      credentialSources: ["takosumi_managed", "user_env_set"],
      takosumiManagedAvailable: true,
      allowedResources: [
        "cloudflare_workers_script",
        "cloudflare_workers_route",
        "cloudflare_dns_record",
        "cloudflare_r2_bucket",
      ],
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
      helpers: ["aws_assume_role", "generic_env"],
      credentialSources: ["user_env_set"],
      takosumiManagedAvailable: false,
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
      helpers: [
        "gcp_oauth_bootstrap",
        "gcp_service_account_impersonation",
        "generic_env",
      ],
      credentialSources: ["user_env_set"],
      takosumiManagedAvailable: false,
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
      helpers: ["generic_env"],
      credentialSources: ["user_env_set"],
      takosumiManagedAvailable: false,
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
      helpers: ["generic_env"],
      credentialSources: ["user_env_set"],
      takosumiManagedAvailable: false,
      allowedResources: [],
      allowedDataSources: [],
      policyPackId: "kubernetes-basic",
      createdAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
      updatedAt: PROVIDER_CATALOG_SEED_TIMESTAMP,
    },
  ];
}

export interface RecordMeteredUsageInput {
  readonly installationId?: string;
  readonly runId?: string;
  readonly kind: UsageEventKind;
  readonly quantity: number;
  readonly credits: number;
  readonly source: Exclude<UsageEventSource, "runner">;
  readonly idempotencyKey: string;
  readonly createdAt?: string;
}

export interface RecordManagedResourceUsageInput {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly meters: readonly ManagedResourceUsageMeter[];
}

export interface ReconcileInvoiceUsageInput {
  readonly invoiceId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly invoicedCredits: number;
  readonly createdAt?: string;
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
  readonly userEnvSetProviderRunner?: OpenTofuRunner;
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
   * Operator/self-host billing default (§28). Space.billingSettings overrides
   * this. Omitted means self-host style `disabled`.
   */
  readonly defaultBillingSettings?: BillingSettings;
  /**
   * Per-Space cumulative write-apply ceiling for runs that resolve to an
   * operator-default (managed) credential while billing is NOT in `enforce`
   * mode. It protects the OPERATOR'S key on the managed/free default, where no
   * credit reservation gates apply: a Space whose cumulative write-applies
   * (create / update / destroy_apply) reach this cap can no longer apply on the
   * operator key until billing is upgraded to `enforce` or it brings its own
   * Connection. Keyed on operator-default-credential usage, NOT billing mode
   * alone, so a self-hoster applying on their OWN Connection is never capped.
   * Omitted (the self-host build target default) means uncapped — a self-hoster
   * owns their own infrastructure, so only the hosted platform worker sets this.
   */
  readonly managedDefaultApplyCap?: number;
  /**
   * HMAC secret used to sign the managed cf-proxy `base_url` scope so the proxy
   * can verify it (see {@link signCfProxyScope}). Wired from the operator's
   * `TAKOSUMI_DEPLOY_CONTROL_TOKEN` on the platform worker. Omitted on self-host
   * builds (no managed Cloudflare hosting), where a managed run fails closed.
   */
  readonly cfProxySigningSecret?: string;
}

export interface DeployControlActorContext {
  readonly actor?: string;
}

/**
 * Install-type wiring for an installation-driven template plan (§13). Carried
 * through {@link PlanRunInternalContext} so {@link
 * OpenTofuDeploymentController.createPlanRun} can drive `generateInstallationRoot`
 * (installType-aware generated root + provider aliases + the
 * `app_source` build) instead of the raw {@link generateRootModule}. Public
 * `/api` calls always target an Installation; the low-level compatibility path
 * backfills this context from the Installation row when callers omit it.
 */
interface InstallTypePlanContext {
  /** §13 generated-root install type (core / opentofu_module / app_source). */
  readonly installType: GeneratedRootInstallType;
  /** Provider mapping derived from the resolved provider bindings. */
  readonly providerBindings: readonly RootProviderBinding[];
  /**
   * Manual-mode provider values flattened into module input overrides (§13
   * decision: manual values override the InstallConfig variableMapping).
   */
  readonly manualValues: Readonly<Record<string, JsonValue>>;
  /** InstallConfig.build, when enabled (overrides the template build). */
  readonly build?: DispatchBuildSpec;
  /**
   * True when this run resolved a required provider to the operator-default
   * connection (spec §7.1 fall-through) — i.e. the managed (takosumi-hosted)
   * case. The control plane uses this to host a Cloudflare Worker capsule in the
   * operator's Workers-for-Platforms dispatch namespace instead of as a
   * standalone account-level Worker. Mirrors
   * `billing_service.#runUsesOperatorDefaultCredential`.
   */
  readonly usesOperatorDefaultCredential: boolean;
}

interface GenericRootPlanContext {
  readonly providerBindings: readonly RootProviderBinding[];
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
 * `createInstallationDestroyPlan`; the raw `/v1/plan-runs` create path leaves
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

/**
 * Resolved consumer Dependencies for an installation-driven plan (spec §15 / §17
 * variable_injection). Built at plan creation BEFORE the run row exists:
 *   - `injectedValues` are the producer-output values keyed by the consumer
 *     input name (each mapping's `to`), merged into the plan inputs / variables;
 *   - `entries` are the DependencySnapshotEntry pins (one per edge) minus the
 *     run-level fields; the runId is stamped onto the snapshot, not the entries;
 *   - `mode` is `strict` for a production consumer, else `pinned` (§17).
 *
 * Diagnostics carry only digests (never values).
 */
interface ResolvedDependencies {
  readonly injectedValues: Readonly<Record<string, JsonValue>>;
  /**
   * `true` when at least one injected value came from a SENSITIVE producer
   * output. Such a value is sealed into the DependencySnapshot, but it ALSO flows
   * into the plan `variables` and (for a generic Capsule) is baked as a literal
   * into the generated root's `main.tf`. Both land in the runs_inputs sidecar, so
   * when this is set the sidecar MUST be sealed at rest (spec §11 / §18: secret
   * outputs are never stored as cleartext ledger values).
   */
  readonly hasSensitiveInjected: boolean;
  readonly entries: readonly DependencySnapshotEntry[];
  readonly mode: DependencySnapshotMode;
}

/**
 * The names a `published_output` cross-Space edge may consume, resolved from the
 * consumer Space's ACTIVE OutputShares for one producer Installation. Maps the
 * SHARED name (the grant alias, else the producer output name) -> the producer's
 * actual output name plus whether it must be resolved from the raw sensitive
 * output artifact instead of OutputSnapshot.spaceOutputs.
 */
type ShareCoverage = ReadonlyMap<
  string,
  { readonly outputName: string; readonly sensitive: boolean }
>;

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
   * Pins the plan to a SPECIFIC SourceSnapshot id instead of resolving the
   * Source's latest snapshot for its default ref. Used by the §30 deployment
   * rollback-plan path (`POST /internal/v1/deployments/:id/rollback-plan`) to re-plan an
   * Installation against the source snapshot a prior Deployment was built from.
   * The snapshot must belong to the Installation's Source.
   */
  readonly sourceSnapshotId?: string;
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

export class OpenTofuDeploymentController {
  readonly #store: OpenTofuDeploymentStore;
  readonly #runner?: OpenTofuRunner;
  readonly #userEnvSetProviderRunner?: OpenTofuRunner;
  readonly #vault?: ConnectionVault;
  readonly #sourcesService?: SourcesService;
  readonly #defaultRunnerProfileId: string;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #enqueueRun: EnqueueRun;
  readonly #templateRegistry: TemplateRegistry;
  readonly #installationCoordination?: InstallationCoordination;
  readonly #activity: ActivityRecorder;
  readonly #sensitiveOutputResolver?: SensitiveOutputResolver;
  readonly #dependencyValueSealer?: DependencyValueSealer;
  readonly #defaultBillingSettings: BillingSettings;
  readonly #managedDefaultApplyCap?: number;
  readonly #cfProxySigningSecret?: string;
  readonly #seededProfiles: Promise<void>;
  readonly #seededProviderTemplates: Promise<void>;
  readonly #mutationChains = new Map<string, Promise<void>>();
  readonly #sources: SourceManagement;
  readonly #connections: ConnectionManagement;
  readonly #deployments: DeploymentQuery;
  readonly #billing: BillingService;
  readonly #credentials: RunCredentialBroker;
  #connectionsService?: ConnectionsService;

  constructor(dependencies: OpenTofuDeploymentControllerDependencies = {}) {
    this.#store = dependencies.store ?? new InMemoryOpenTofuDeploymentStore();
    this.#runner = dependencies.runner;
    this.#userEnvSetProviderRunner = dependencies.userEnvSetProviderRunner;
    this.#vault = dependencies.vault;
    this.#sourcesService = dependencies.sourcesService;
    this.#sources = new SourceManagement(dependencies.sourcesService);
    this.#connections = new ConnectionManagement(this.#store, this.#vault);
    this.#deployments = new DeploymentQuery(this.#store, publicInstallation);
    this.#installationCoordination = dependencies.installationCoordination;
    this.#activity = dependencies.activity ?? NOOP_ACTIVITY_RECORDER;
    this.#sensitiveOutputResolver = dependencies.sensitiveOutputResolver;
    this.#dependencyValueSealer = dependencies.dependencyValueSealer;
    this.#defaultBillingSettings =
      dependencies.defaultBillingSettings ?? DISABLED_BILLING_SETTINGS;
    this.#cfProxySigningSecret = dependencies.cfProxySigningSecret;
    this.#managedDefaultApplyCap =
      dependencies.managedDefaultApplyCap !== undefined &&
      Number.isFinite(dependencies.managedDefaultApplyCap) &&
      dependencies.managedDefaultApplyCap > 0
        ? Math.floor(dependencies.managedDefaultApplyCap)
        : undefined;
    this.#defaultRunnerProfileId =
      dependencies.defaultRunnerProfileId ?? "cloudflare-default";
    this.#newId = dependencies.newId ?? newId;
    this.#now = dependencies.now ?? (() => Date.now());
    this.#billing = new BillingService({
      store: this.#store,
      newId: this.#newId,
      now: this.#now,
      defaultBillingSettings: this.#defaultBillingSettings,
      ...(this.#managedDefaultApplyCap !== undefined
        ? { managedDefaultApplyCap: this.#managedDefaultApplyCap }
        : {}),
      requireSpace: (spaceId) => this.#requireSpace(spaceId),
      resolveRunProviderBindings: (planRun) =>
        this.#resolveRunProviderBindings(planRun),
    });
    this.#credentials = new RunCredentialBroker({
      store: this.#store,
      newId: this.#newId,
      now: this.#now,
      ...(this.#vault ? { vault: this.#vault } : {}),
      resolveRunProviderBindings: (planRun) =>
        this.#resolveRunProviderBindings(planRun),
      policyForPlanRun: (planRun) => this.#policyForPlanRun(planRun),
    });
    // Default to an inline dispatcher: run the consumer immediately so local /
    // node substrates and tests keep the historical synchronous semantics.
    this.#enqueueRun =
      dependencies.enqueueRun ??
      ((dispatch) => this.dispatchQueuedRun(dispatch));
    this.#templateRegistry =
      dependencies.templateRegistry ?? defaultTemplateRegistry;
    this.#seededProfiles = this.#seedRunnerProfiles(
      dependencies.runnerProfiles ?? createDefaultRunnerProfiles(this.#now()),
    );
    this.#seededProviderTemplates = this.#seedProviderTemplates(
      initialProviderTemplates(),
    );
  }

  async listRunnerProfiles(): Promise<ListRunnerProfilesResponse> {
    await this.#seededProfiles;
    return { runnerProfiles: await this.#store.listRunnerProfiles() };
  }

  async listProviderTemplates(): Promise<ListProviderTemplatesResponse> {
    await this.#seededProviderTemplates;
    return { providers: await this.#store.listProviderTemplates() };
  }

  async #seedProviderTemplates(
    entries: readonly ProviderTemplate[],
  ): Promise<void> {
    for (const entry of entries) {
      await this.#store.putProviderTemplate(entry);
    }
  }

  async getProviderTemplate(
    providerId: string,
  ): Promise<ProviderTemplateResponse> {
    requireNonEmptyString(providerId, "providerId");
    await this.#seededProviderTemplates;
    const provider = await this.#store.getProviderTemplate(providerId);
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
    requireNonEmptyString(spaceId, "spaceId");
    await this.#requireSpace(spaceId);
    await this.#billing.reconcileSpaceMonthlyCredits(spaceId);
    const settings = await this.#billing.billingSettingsForSpace(spaceId);
    const balance = await this.#store.getCreditBalance(spaceId);
    const account = await this.#store.getBillingAccountForOwner(
      "space",
      spaceId,
    );
    const subscription = await this.#store.getSpaceSubscription(spaceId);
    const plan = subscription
      ? await this.#store.getBillingPlan(subscription.planId)
      : undefined;
    return {
      billing: {
        settings,
        ...(balance ? { balance } : {}),
        ...(account ? { account } : {}),
        ...(subscription ? { subscription } : {}),
        ...(plan ? { plan } : {}),
      },
    };
  }

  async listSpaceUsage(spaceId: string): Promise<{
    readonly usageEvents: readonly UsageEvent[];
  }> {
    requireNonEmptyString(spaceId, "spaceId");
    await this.#requireSpace(spaceId);
    return { usageEvents: await this.#store.listUsageEvents(spaceId) };
  }

  async recordMeteredUsage(
    spaceId: string,
    input: RecordMeteredUsageInput,
  ): Promise<{ readonly usageEvent: UsageEvent }> {
    requireNonEmptyString(spaceId, "spaceId");
    await this.#requireSpace(spaceId);
    if (input.source === "billing_reconciliation") {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "usage event source must be resource_meter or manual_adjustment",
      );
    }
    if (!isExternalOperatorUsageEventSource(input.source)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "usage event source must be resource_meter or manual_adjustment",
      );
    }
    const usageEvent = await this.#store.putUsageEvent(
      normalizeMeteredUsageEvent(
        spaceId,
        input,
        () => this.#newId("usage"),
        () => new Date(this.#now()).toISOString(),
      ),
    );
    return { usageEvent };
  }

  async #recordBillingReconciliationUsage(
    spaceId: string,
    input: Omit<RecordMeteredUsageInput, "source"> & {
      readonly source: "billing_reconciliation";
    },
  ): Promise<{ readonly usageEvent: UsageEvent }> {
    const usageEvent = await this.#store.putUsageEvent(
      normalizeMeteredUsageEvent(
        spaceId,
        input,
        () => this.#newId("usage"),
        () => new Date(this.#now()).toISOString(),
      ),
    );
    return { usageEvent };
  }

  async #recordResourceMeterUsage(
    spaceId: string,
    input: Omit<RecordMeteredUsageInput, "source">,
  ): Promise<{ readonly usageEvent: UsageEvent }> {
    const usageEvent = await this.#store.putUsageEvent(
      normalizeMeteredUsageEvent(
        spaceId,
        {
          ...input,
          source: "resource_meter",
        },
        () => this.#newId("usage"),
        () => new Date(this.#now()).toISOString(),
      ),
    );
    return { usageEvent };
  }

  async recordManagedResourceUsage(
    spaceId: string,
    input: RecordManagedResourceUsageInput,
  ): Promise<{ readonly usageEvents: readonly UsageEvent[] }> {
    requireNonEmptyString(spaceId, "spaceId");
    await this.#requireSpace(spaceId);
    const period = normalizeUsagePeriod(input);
    const usageEvents: UsageEvent[] = [];
    for (const meter of input.meters) {
      const recorded = await this.#recordResourceMeterUsage(spaceId, {
        ...(meter.installationId
          ? { installationId: meter.installationId }
          : {}),
        kind: meter.kind,
        quantity: meter.quantity,
        credits: meter.credits,
        idempotencyKey: [
          "managed-resource",
          spaceId,
          period.periodStart,
          period.periodEnd,
          meter.meterId,
          meter.installationId ?? "space",
          meter.kind,
        ].join(":"),
        createdAt: period.periodEnd,
      });
      usageEvents.push(recorded.usageEvent);
    }
    return { usageEvents };
  }

  async reconcileInvoiceUsage(
    spaceId: string,
    input: ReconcileInvoiceUsageInput,
  ): Promise<InvoiceUsageReconciliation> {
    requireNonEmptyString(spaceId, "spaceId");
    await this.#requireSpace(spaceId);
    requireNonEmptyString(input.invoiceId, "invoiceId");
    const period = normalizeInvoiceUsagePeriod(input);
    const events = await this.#store.listUsageEvents(spaceId);
    const meteredCredits = events
      .filter((event) => isMeteredInvoiceUsageSource(event.source))
      .filter((event) =>
        isUsageEventInInvoicePeriod(
          event,
          period.periodStart,
          period.periodEnd,
        ),
      )
      .reduce((sum, event) => sum + event.credits, 0);
    const adjustmentCredits = input.invoicedCredits - meteredCredits;
    const { usageEvent } = await this.#recordBillingReconciliationUsage(
      spaceId,
      {
        kind: "operation",
        quantity: 1,
        credits: adjustmentCredits,
        source: "billing_reconciliation",
        idempotencyKey: [
          "invoice-reconciliation",
          spaceId,
          input.invoiceId,
          period.periodStart,
          period.periodEnd,
        ].join(":"),
        createdAt: input.createdAt ?? new Date(this.#now()).toISOString(),
      },
    );
    return {
      invoiceId: input.invoiceId,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      meteredCredits,
      invoicedCredits: input.invoicedCredits,
      adjustmentCredits,
      usageEvent,
    };
  }

  async listSpaceCreditReservations(spaceId: string): Promise<{
    readonly creditReservations: readonly CreditReservation[];
  }> {
    requireNonEmptyString(spaceId, "spaceId");
    await this.#requireSpace(spaceId);
    return {
      creditReservations: await this.#store.listCreditReservations(spaceId),
    };
  }

  async topUpSpaceCredits(
    spaceId: string,
    input: { readonly credits: number },
  ): Promise<{ readonly balance: CreditBalance }> {
    requireNonEmptyString(spaceId, "spaceId");
    await this.#requireSpace(spaceId);
    if (
      !Number.isInteger(input.credits) ||
      !Number.isFinite(input.credits) ||
      input.credits <= 0
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "credits must be a positive integer",
      );
    }
    await this.#billing.reconcileSpaceMonthlyCredits(spaceId);
    const existing = await this.#store.getCreditBalance(spaceId);
    const nowIso = new Date(this.#now()).toISOString();
    const balance = await this.#store.putCreditBalance({
      spaceId,
      availableCredits: (existing?.availableCredits ?? 0) + input.credits,
      reservedCredits: existing?.reservedCredits ?? 0,
      monthlyIncludedCredits: existing?.monthlyIncludedCredits ?? 0,
      purchasedCredits: (existing?.purchasedCredits ?? 0) + input.credits,
      updatedAt: nowIso,
    });
    return { balance };
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
    // Managed hosting: redirect the cloudflare provider base_url to the cf-proxy
    // when this run resolved the operator-default credential (no-op otherwise).
    const installTypePlan = await this.#applyManagedProxyBaseUrl(
      internal.installTypePlan,
      profile,
      installation,
    );
    const templatePlan = this.#resolveTemplatePlan(request, installTypePlan);
    const declaredProviders = templatePlan
      ? normalizeProviders(templatePlan.requiredProviders)
      : normalizeProviders(request.requiredProviders ?? []);
    const allowNoProviders =
      templatePlan !== undefined &&
      templatePlan.template.policy.allowedProviders.length === 0;
    const basePolicy = evaluatePolicy({
      profile,
      requiredProviders: declaredProviders,
      checkedAt: now,
      ...(allowNoProviders ? { allowNoProviders: true } : {}),
    });
    const userEnvPolicy = await this.#evaluateUserEnvSetProviderExecutionPolicy(
      {
        profile,
        installation,
        hasUserEnvSetProviderRunner:
          this.#userEnvSetProviderRunner !== undefined,
      },
    );
    const policyReasons = [...basePolicy.reasons, ...userEnvPolicy.reasons];
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
      status: policy.status === "passed" ? "queued" : "blocked",
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
   * lands `waiting_approval` after completion (the §19 Run projection maps a
   * succeeded destroy_plan to waiting_approval).
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
   *   - NEVER parks `waiting_approval` (`#planAwaitsApproval` short-circuits a
   *     drift check) — it is a read-only signal, not an applyable plan;
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
    return await this.#createInstallationPlanRun(
      installationId,
      false,
      context,
      {
        ...internal,
        driftCheck: true,
      },
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
      if (!internal.sourceSnapshotId) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `installation ${installationId} is upload-origin; a plan requires a ` +
            `pinned upload SourceSnapshot (deploy a new upload via takosumi deploy)`,
        );
      }
      const pinned = await this.#store.getSourceSnapshot(
        internal.sourceSnapshotId,
      );
      if (!pinned || pinned.spaceId !== installation.spaceId) {
        throw new OpenTofuControllerError(
          "not_found",
          `upload SourceSnapshot ${internal.sourceSnapshotId} not found in ` +
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
    const compatibilityReport =
      await this.#ensureInstallationCompatibilityReport(
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
      : await this.#resolveConsumerDependencies(installation);
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
   * Resolves a consumer Installation's Dependencies into the injected values +
   * pinned snapshot entries (spec §15 / §17). For each `variable_injection` edge
   * it reads the producer's current OutputSnapshot and pulls each mapped output
   * (`from`) into the injected values under the consumer input name (`to`). A
   * required mapping whose producer output is absent (no current OutputSnapshot,
   * or the named output is missing) is a typed `failed_precondition`
   * (`dependency_outputs_unavailable`). Returns `undefined` when the consumer has
   * no Dependencies. The snapshot `mode` is `strict` for a production environment,
   * else `pinned` (§17).
   */
  async #resolveConsumerDependencies(
    consumer: Installation,
  ): Promise<ResolvedDependencies | undefined> {
    const dependencies = await this.#store.listDependenciesForConsumer(
      consumer.id,
    );
    if (dependencies.length === 0) return undefined;
    const injectedValues: Record<string, JsonValue> = {};
    let hasSensitiveInjected = false;
    const entries: DependencySnapshotEntry[] = [];
    for (const dependency of dependencies) {
      const producer = await this.#store.getInstallation(
        dependency.producerInstallationId,
      );
      if (!producer) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `dependency_outputs_unavailable: dependency ${dependency.id} producer ` +
            `installation ${dependency.producerInstallationId} not found`,
        );
      }
      // remote_state injects NO values: instead the producer StateSnapshot bytes
      // are pinned here and later materialized into the container at dispatch
      // time. This makes both `strict` and `pinned` plans apply the same producer
      // state bytes that were reviewed at plan time; strict mode additionally
      // rejects a producer whose current generation moved.
      if (dependency.mode === "remote_state") {
        const stateSnapshot =
          await this.#latestProducerStateSnapshotForDependency(
            dependency.id,
            producer,
          );
        const values: Record<string, JsonValue> = {};
        entries.push({
          dependencyId: dependency.id,
          producerInstallationId: producer.id,
          producerStateGeneration: stateSnapshot.generation,
          producerStateSnapshotId: stateSnapshot.id,
          producerStateObjectKey: stateSnapshot.objectKey,
          producerStateDigest: stateSnapshot.digest,
          producerOutputSnapshotId: "",
          producerOutputDigest: "",
          valuesDigest: await stableJsonDigest(values),
          values,
        });
        continue;
      }
      // variable_injection (same-Space) and published_output (cross-Space via an
      // active OutputShare) both pull producer outputs into the consumer inputs.
      // published_output restricts the readable names to the active grant and
      // resolves each mapped SHARED name back to the producer output name.
      const coverage =
        dependency.mode === "published_output"
          ? await this.#resolveShareCoverage(producer, consumer)
          : undefined;
      const outputSnapshot = producer.currentOutputSnapshotId
        ? await this.#store.getOutputSnapshot(producer.currentOutputSnapshotId)
        : undefined;
      // Full plaintext value map for this edge (drives the digest). Sensitive
      // keys are tracked separately so they can be sealed out of `values`
      // before the snapshot is persisted (the digest stays over the FULL map).
      const values: Record<string, JsonValue> = {};
      const sensitiveValues: Record<string, JsonValue> = {};
      for (const mapping of Object.values(dependency.outputs)) {
        // For published_output the mapping `from` is the SHARED name the grant
        // exposes; resolve it to the producer output name (and fail
        // output_share_revoked when the active grant no longer covers it). For
        // variable_injection `from` IS the producer output name.
        let producerOutputName = mapping.from;
        let sensitive = false;
        if (coverage) {
          const resolved = coverage.get(mapping.from);
          if (resolved === undefined) {
            throw new OpenTofuControllerError(
              "failed_precondition",
              `output_share_revoked: dependency ${dependency.id} consumes ` +
                `shared output ${mapping.from} from producer installation ` +
                `${producer.id} but no active OutputShare covers it`,
            );
          }
          producerOutputName = resolved.outputName;
          sensitive = resolved.sensitive;
        }
        const resolvedValue = await this.#resolveDependencyOutputValue({
          dependencyId: dependency.id,
          producer,
          consumer,
          outputSnapshot,
          producerOutputName,
          sensitive,
        });
        if (!resolvedValue) {
          if (mapping.required) {
            throw new OpenTofuControllerError(
              "failed_precondition",
              `dependency_outputs_unavailable: dependency ${dependency.id} ` +
                `requires producer output ${producerOutputName} which the ` +
                `producer installation ${producer.id} has not published`,
            );
          }
          // An optional mapping with no producer value contributes nothing.
          continue;
        }
        const value = resolvedValue.value;
        values[mapping.to] = value;
        injectedValues[mapping.to] = value;
        if (sensitive) sensitiveValues[mapping.to] = value;
      }
      // Pin the snapshot entry even when no producer output existed yet so the
      // apply-time tamper check has the full edge set. The values digest is over
      // the FULL plaintext value map (sensitive + non-sensitive) so it is
      // independent of at-rest sealing.
      const valuesDigest = await stableJsonDigest(values);
      // Seal the sensitive subset OUT of the cleartext `values` map: a resolved
      // `published_output` secret must never land as a cleartext ledger value
      // (spec §11 / §18). The digest above already covered the full plaintext.
      const sensitiveNames = Object.keys(sensitiveValues);
      let cleartextValues: Record<string, JsonValue> = values;
      let sealedValues: SealedDependencyValues | undefined;
      if (sensitiveNames.length > 0) {
        hasSensitiveInjected = true;
        if (!this.#dependencyValueSealer) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            `dependency_value_sealer_unavailable: dependency ${dependency.id} ` +
              `resolved sensitive output(s) ${sensitiveNames.join(", ")} but no ` +
              `at-rest value sealer is configured`,
          );
        }
        sealedValues = await this.#dependencyValueSealer.seal(sensitiveValues);
        cleartextValues = Object.fromEntries(
          Object.entries(values).filter(
            ([key]) =>
              !Object.prototype.hasOwnProperty.call(sensitiveValues, key),
          ),
        );
      }
      entries.push({
        dependencyId: dependency.id,
        producerInstallationId: producer.id,
        producerStateGeneration: producer.currentStateGeneration,
        producerOutputSnapshotId: outputSnapshot?.id ?? "",
        producerOutputDigest: outputSnapshot?.outputDigest ?? "",
        valuesDigest,
        values: cleartextValues,
        ...(sealedValues ? { sealedValues } : {}),
      });
    }
    const mode: DependencySnapshotMode =
      consumer.environment.trim().toLowerCase() === "production"
        ? "strict"
        : "pinned";
    return {
      injectedValues,
      hasSensitiveInjected,
      entries,
      mode,
    };
  }

  /**
   * Resolves the ACTIVE OutputShare coverage for a `published_output` edge (spec
   * §18) into a SHARED-name -> producer-output-name map. Reads the consumer
   * Space's shares granted by the producer Space for this producer Installation,
   * keeps only `active` grants, and exposes each entry under its SHARED name (the
   * grant `alias` when set, else its `name`) mapped to the producer output name.
   * A revoked grant simply drops its entries from the map, so a mapped name the
   * grant no longer covers surfaces as `output_share_revoked` upstream. Re-run at
   * BOTH plan and apply (the apply path re-resolves consumer dependencies),
   * so a revoke between plan and apply fails the apply.
   */
  async #resolveShareCoverage(
    producer: Installation,
    consumer: Installation,
  ): Promise<ShareCoverage> {
    const shares = await this.#store.listOutputSharesToSpace(consumer.spaceId);
    const coverage = new Map<
      string,
      { readonly outputName: string; readonly sensitive: boolean }
    >();
    for (const share of shares) {
      if (
        share.status !== "active" ||
        share.fromSpaceId !== producer.spaceId ||
        share.producerInstallationId !== producer.id
      )
        continue;
      for (const entry of share.outputs) {
        coverage.set(entry.alias ?? entry.name, {
          outputName: entry.name,
          sensitive: entry.sensitive === true,
        });
      }
    }
    return coverage;
  }

  async #resolveDependencyOutputValue(input: {
    readonly dependencyId: string;
    readonly producer: Installation;
    readonly consumer: Installation;
    readonly outputSnapshot: OutputSnapshot | undefined;
    readonly producerOutputName: string;
    readonly sensitive: boolean;
  }): Promise<{ readonly value: JsonValue } | undefined> {
    if (!input.sensitive) {
      const available = input.outputSnapshot?.spaceOutputs ?? {};
      if (
        !Object.prototype.hasOwnProperty.call(
          available,
          input.producerOutputName,
        )
      ) {
        return undefined;
      }
      return { value: available[input.producerOutputName] as JsonValue };
    }
    if (!input.outputSnapshot) return undefined;
    if (!this.#sensitiveOutputResolver) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `sensitive_output_resolver_unavailable: dependency ${input.dependencyId} ` +
          `requires sensitive output ${input.producerOutputName}`,
      );
    }
    const resolved: SensitiveOutputValue | undefined =
      await this.#sensitiveOutputResolver.resolve({
        outputSnapshot: input.outputSnapshot,
        outputName: input.producerOutputName,
        fromSpaceId: input.producer.spaceId,
        toSpaceId: input.consumer.spaceId,
        producerInstallationId: input.producer.id,
      });
    if (!resolved) return undefined;
    return { value: resolved.value };
  }

  /**
   * Merges the dependency-injected values into a plan request (spec §15). A
   * template-backed request (carries `templateId`) merges into `inputs` (only
   * keys the template would accept; `validateTemplateInputs` downstream rejects
   * unknown keys, so the injected `to` names MUST be declared template inputs —
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
    if (existing && existing.sourceSnapshotId === snapshot.id) {
      this.#assertCompatibilityReportRunnable(existing, policy);
      return existing;
    }
    if (!this.#sourcesService) {
      if (existing && existing.sourceSnapshotId !== snapshot.id) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `compatibility_report_stale: installation ${installation.id} ` +
            `has report ${existing.id} for SourceSnapshot ` +
            `${existing.sourceSnapshotId}, but plan uses ${snapshot.id}`,
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

  async #evaluateUserEnvSetProviderExecutionPolicy(input: {
    readonly profile: RunnerProfile;
    readonly installation?: Installation;
    readonly hasUserEnvSetProviderRunner?: boolean;
  }): Promise<{ readonly reasons: readonly string[] }> {
    if (!input.installation) return { reasons: [] };
    this.#connectionsService ??= new ConnectionsService({ store: this.#store });
    const resolved = await this.#connectionsService.resolveProviderBindings(
      input.installation,
    );
    const envSetConnections = resolved
      .map((entry) => entry.connection)
      .filter(
        (connection): connection is NonNullable<typeof connection> =>
          connection !== undefined && connection.kind === "provider_env_set",
      );
    if (envSetConnections.length === 0) return { reasons: [] };

    const reasons: string[] = [];
    if (input.profile.labels?.["takosumi.com/runner-class"] !== "custom") {
      reasons.push(
        `runner profile ${input.profile.id} is not a user env set provider runner class`,
      );
    } else if (input.hasUserEnvSetProviderRunner !== true) {
      reasons.push(
        `runner profile ${input.profile.id} requires a configured user env set provider runner`,
      );
    }
    for (const connection of envSetConnections) {
      if (connection.scope !== "space") {
        reasons.push(
          `provider env set connection ${connection.id} for ${connection.provider} must be Space-scoped`,
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
      ? this.#userEnvSetProviderRunner !== undefined
      : this.#runner !== undefined;
  }

  #runnerForProfile(profile: RunnerProfile): OpenTofuRunner {
    const runner = this.#isCustomRunnerProfile(profile)
      ? this.#userEnvSetProviderRunner
      : this.#runner;
    if (!runner) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        this.#isCustomRunnerProfile(profile)
          ? `runner profile ${profile.id} requires a configured user env set provider runner`
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
      // canonicalized) so the operator-default fall-through resolves the same
      // set for rootgen here and for credential mint at run time.
      const template = this.#templateRegistry.require(
        templateBinding.templateId,
        templateBinding.templateVersion,
      );
      const requiredProviders = template.policy.allowedProviders.map(
        canonicalProviderAddress,
      );
      const installTypePlan = await this.#resolveInstallTypePlan(
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
    const requiredProviders =
      compatibilityProviders.length > 0
        ? compatibilityProviders
        : [...profile.allowedProviders];
    const installTypePlan = await this.#resolveInstallTypePlan(
      input.installation,
      input.installConfig,
      input.installConfig.installType,
      requiredProviders,
    );
    const variables = normalizeVariables(
      mergeJsonVariables(
        input.installConfig.variableMapping,
        installTypePlan.manualValues,
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
        providerBindings: installTypePlan.providerBindings,
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
          ...(context.providerBindings.length > 0
            ? { providerBindings: context.providerBindings }
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
    return await this.#genericRootDispatchForRequest(
      request,
      {
        providerBindings: [],
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
   * Derives the §13 install-type plan context for a template-bound installation
   * config: the generated-root install type, the provider aliases
   * (from the installation's resolved provider bindings), the flattened manual-mode
   * values, and the build override. Provider bindings resolve through the
   * {@link ConnectionsService} so binding changes take effect on the next plan.
   * `disabled` provider bindings (and `manual`, which contributes values not a
   * provider credential) are skipped for provider-alias derivation.
   */
  async #resolveInstallTypePlan(
    installation: Installation,
    installConfig: InstallConfig,
    installType: InstallType,
    requiredProviders: readonly string[],
  ): Promise<InstallTypePlanContext> {
    this.#connectionsService ??= new ConnectionsService({ store: this.#store });
    // Run-scoped resolution so the generated-root provider blocks include the
    // operator-default fall-through (spec §7.1) for unbound required providers.
    // `requiredProviders` MUST equal the value stored on the plan run so the
    // mint path (#resolveRunProviderBindings) resolves the identical set.
    const resolved =
      await this.#connectionsService.resolveProviderBindingsForRun(
        installation,
        requiredProviders,
      );
    const providerBindings = providerBindingsFromResolved(resolved);
    const manualValues = manualValuesFromResolved(resolved);
    // Managed signal: a required provider fell through to the operator-default
    // connection (§7.1). Same predicate as the billing path so a managed run is
    // detected identically for hosting and for spend accounting.
    const usesOperatorDefaultCredential = resolved.some(
      (entry) =>
        entry.mode === "default" && entry.connection?.scope === "operator",
    );
    return {
      // opentofu_root never reaches here (asserted in #installationPlanRequest);
      // core / opentofu_module / app_source map 1:1 to the generated-root types.
      installType: installType as GeneratedRootInstallType,
      providerBindings,
      manualValues,
      usesOperatorDefaultCredential,
      ...(installConfig.build?.enabled
        ? { build: installConfigBuildSpec(installConfig.build) }
        : {}),
    };
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

  /**
   * Managed (takosumi-hosted) Worker hosting. When this run resolved the
   * cloudflare provider to the operator-default credential (managed) AND the
   * runner profile carries a cf-proxy config, redirect the cloudflare provider's
   * `base_url` to the Takosumi cf-proxy so a PLAIN `cloudflare_workers_script`
   * lands in the WfP dispatch namespace (the provider cannot place a script in a
   * namespace itself). The base_url path carries the namespace + the install
   * slug as the script-name prefix; the proxy rewrites + enforces both. The
   * capsule cannot override the redirect — the generated root passes providers
   * in, so a capsule's own provider block fails tofu plan (fail-closed).
   *
   * Self-host (an owned connection) and non-cloudflare/non-Worker runs are
   * returned unchanged, so their generated root is byte-identical.
   */
  async #applyManagedProxyBaseUrl(
    installTypePlan: InstallTypePlanContext | undefined,
    profile: RunnerProfile,
    installation: Installation,
  ): Promise<InstallTypePlanContext | undefined> {
    if (!installTypePlan?.usesOperatorDefaultCredential) return installTypePlan;
    const wfp = profile.cloudflareWorkersForPlatforms;
    if (!wfp?.apiProxy) return installTypePlan;
    const slug = installation.name;
    if (!isValidTenantScriptName(slug)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `managed install slug ${JSON.stringify(slug)} is not a valid ` +
          `Workers-for-Platforms script-name prefix (1-63 char DNS label)`,
      );
    }
    // Fail closed: a managed run requires the cf-proxy signing secret so the
    // proxy can verify the scope. Without it the run cannot proceed (the proxy
    // would reject every forward anyway).
    if (!this.#cfProxySigningSecret) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "managed cf-proxy signing secret is not configured " +
          "(TAKOSUMI_DEPLOY_CONTROL_TOKEN); managed Cloudflare runs are disabled",
      );
    }
    const signature = await signCfProxyScope(this.#cfProxySigningSecret, {
      namespace: wfp.dispatchNamespace,
      slug,
      expMs: this.#now() + CF_PROXY_SIGNATURE_TTL_MS,
    });
    const baseUrl = managedCloudflareProxyBaseUrl(
      wfp.apiProxy,
      wfp.dispatchNamespace,
      slug,
      signature,
    );
    const providerBindings = installTypePlan.providerBindings.map((binding) =>
      isCloudflareProvider(binding.provider)
        ? { ...binding, baseUrl }
        : binding,
    );
    return { ...installTypePlan, providerBindings };
  }

  /**
   * Resolves a template-backed plan request into its resolved template, derived
   * required providers, generated root module, and optional build phase. Returns
   * `undefined` only when the caller should use the generic Capsule generated
   * root path. Throws on a malformed template request
   * (missing version, conflicting requiredProviders, unknown template, invalid
   * inputs).
   *
   * `installTypePlan` is present only for an installation-driven plan (§13). When
   * present the generated root comes from {@link generateInstallationRoot}
   * (installType-aware, provider aliases, the `app_source` build);
   * the manual-mode provider values are merged into the template inputs with
   * manual values overriding the InstallConfig variableMapping (§13 decision:
   * manual values are per-installation overrides). When absent (the raw
   * `/v1/plan-runs` template path, no installation context = no provider bindings) the
   * generated root stays on {@link generateRootModule} byte-for-byte.
   */
  #resolveTemplatePlan(
    request: CreatePlanRunRequest,
    installTypePlan?: InstallTypePlanContext,
  ): ResolvedTemplatePlan | undefined {
    if (request.templateId === undefined) {
      // A bare inputs/templateVersion without templateId is a request error: it
      // would otherwise silently fall back to a generic Capsule plan that ignores
      // template-only fields.
      if (
        request.templateVersion !== undefined ||
        request.inputs !== undefined
      ) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          "templateVersion/inputs require templateId",
        );
      }
      return undefined;
    }
    requireNonEmptyString(request.templateId, "templateId");
    requireNonEmptyString(request.templateVersion, "templateVersion");
    if (request.requiredProviders !== undefined) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "requiredProviders is derived from the template; do not pass it with templateId",
      );
    }
    const template = this.#templateRegistry.require(
      request.templateId,
      request.templateVersion!,
    );
    // Manual-mode provider values are per-installation overrides: they win on a
    // key collision with the InstallConfig variableMapping (which flows in via
    // request.inputs). Unknown keys fail closed instead of being silently
    // dropped, so manual inputs remain auditable and match the template contract.
    const mergedInputs = installTypePlan
      ? mergeManualInputs(
          template,
          request.inputs,
          installTypePlan.manualValues,
        )
      : request.inputs;
    const inputs = validateTemplateInputs(template, mergedInputs);
    // Installation-driven (§13): installType-aware generated root with
    // provider aliases + the app_source artifact_path wiring.
    // Raw template path (no installation context): the byte-stable wrapper.
    const baseGeneratedRoot = installTypePlan
      ? generateInstallationRoot({
          template,
          inputs,
          installType: installTypePlan.installType,
          ...(installTypePlan.providerBindings.length > 0
            ? { providerBindings: installTypePlan.providerBindings }
            : {}),
        })
      : generateRootModule(template, inputs);
    const generatedRoot: DispatchGeneratedRoot = {
      ...baseGeneratedRoot,
      moduleFiles: this.#templateRegistry.requireModuleFiles(
        template.id,
        template.version,
      ),
    };
    // Build phase precedence: an installation-driven app_source InstallConfig.build
    // (when enabled) overrides the template's own build; otherwise the template
    // build is used (§13 / M5 decision: InstallConfig.build takes precedence).
    const build = installTypePlan?.build ?? templateBuildSpec(template);
    return {
      template,
      inputs,
      generatedRoot,
      // Canonicalize the template's provider rules (OpenTofu source form, e.g.
      // `cloudflare/cloudflare`) to fully-qualified registry addresses so they
      // satisfy a runner profile allowlist (whose rules are fully-qualified or
      // short — `providerMatches` admits a fully-qualified provider against
      // either form, but not a short provider against a fully-qualified rule).
      requiredProviders: template.policy.allowedProviders.map(
        canonicalProviderAddress,
      ),
      ...(build ? { build } : {}),
    };
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
    // Operator-economic ceiling (P2): a managed/free default Space is NOT in
    // `enforce` mode, so the credit-reservation path that gates apply under
    // `enforce` does nothing here. Without this, a Space could spend unbounded
    // amounts on the OPERATOR'S key by repeatedly applying. Reject apply once a
    // Space's cumulative write-applies reach the operator-configured cap — but
    // ONLY for runs that actually resolve to an operator-default credential, so
    // a self-hoster applying on their own Connection is never capped.
    await this.#billing.assertManagedDefaultApplyCap(planRun);
    // Source snapshot revalidation (spec invariant 10): an env-driven plan is
    // pinned to a SourceSnapshot; the apply must run against the SAME snapshot
    // the plan was reviewed against. Re-read the persisted plan and confirm its
    // sourceSnapshotId is unchanged + still resolvable, mirroring the
    // digest/generation guards. Runs without a recorded snapshot are unaffected.
    await this.#revalidateSourceSnapshot(planRun);
    const profile = await this.#requireRunnerProfile(planRun.runnerProfileId);
    const now = this.#now();
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
      ...(request.approval ? { approval: request.approval } : {}),
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
    await this.runQueuedApply(dispatch.runId);
  }

  /**
   * Source-sync consumer (Core Specification §6). Idempotency guard, transition
   * to `running`, mint source-phase credentials NOW (git-only; never provider),
   * dispatch to the runner, and on success record the SourceSnapshot + update the
   * Source's `lastSeenCommit`. Never logs credential material.
   */
  async runQueuedSourceSync(runId: string): Promise<SourceSyncRun | undefined> {
    const sources = this.#sourcesService;
    if (!sources || !this.#runner?.sourceSync) {
      return await this.#store.getSourceSyncRun(runId);
    }
    const run = await this.#store.getSourceSyncRun(runId);
    if (!run) {
      throw new OpenTofuControllerError(
        "not_found",
        `source sync run ${runId} not found`,
      );
    }
    if (!this.#shouldProcessRun(run.status, run.heartbeatAt)) {
      return run;
    }
    const startedAtMs = this.#now();
    const running: SourceSyncRun = {
      ...run,
      status: "running",
      startedAt: new Date(startedAtMs).toISOString(),
      heartbeatAt: startedAtMs,
      updatedAt: new Date(startedAtMs).toISOString(),
    };
    await this.#store.putSourceSyncRun(running);

    let stored;
    try {
      stored = await sources.getStoredSource(run.sourceId);
    } catch (error) {
      await this.#failSourceSyncRun(running, error);
      return await this.#store.getSourceSyncRun(runId);
    }

    let credentials;
    try {
      if (stored.authConnectionId) {
        const bundle = await this.#requireVault().mintForPhase({
          spaceId: run.spaceId,
          phase: "source",
          sourceConnectionId: stored.authConnectionId,
        });
        await this.#recordSourceCredentialMintEvent({
          runId: run.id,
          spaceId: run.spaceId,
          sourceId: run.sourceId,
          connectionId: stored.authConnectionId,
        });
        credentials = bundle.toMintResponse();
      }
    } catch (error) {
      await this.#failSourceSyncRun(running, mapVaultError(error));
      return await this.#store.getSourceSyncRun(runId);
    }

    try {
      const result = await this.#runner.sourceSync({
        runId: run.id,
        spaceId: run.spaceId,
        sourceId: run.sourceId,
        source: { url: run.url, ref: run.ref, path: run.path },
        archiveObjectKey: run.archiveObjectKey,
        ...(credentials ? { credentials } : {}),
      });
      return await this.#succeedSourceSyncRun(running, result);
    } catch (error) {
      await this.#failSourceSyncRun(running, error);
      return await this.#store.getSourceSyncRun(runId);
    }
  }

  async #succeedSourceSyncRun(
    running: SourceSyncRun,
    result: OpenTofuSourceSyncResult,
  ): Promise<SourceSyncRun> {
    const finishedAtMs = this.#now();
    const finishedAtIso = new Date(finishedAtMs).toISOString();
    const snapshotId = running.snapshotId ?? this.#newId("snap");
    const snapshot: SourceSnapshot = {
      id: snapshotId,
      origin: "git",
      spaceId: running.spaceId,
      sourceId: running.sourceId,
      url: running.url,
      ref: running.ref,
      resolvedCommit: result.resolvedCommit,
      path: running.path,
      archiveObjectKey: running.archiveObjectKey,
      archiveDigest: result.archiveDigest,
      archiveSizeBytes: result.archiveSizeBytes,
      fetchedByRunId: running.id,
      fetchedAt: finishedAtIso,
    };
    await this.#store.putSourceSnapshot(snapshot);
    // Record lastSeenCommit on the Source so the scheduler can skip an unchanged
    // ref. Read-modify-write through the store (internal field, never projected).
    const stored = await this.#store.getSource(running.sourceId);
    if (stored) {
      await this.#store.putSource({
        ...stored,
        lastSeenCommit: result.resolvedCommit,
        updatedAt: finishedAtIso,
      });
    }
    const succeeded: SourceSyncRun = {
      ...running,
      status: "succeeded",
      heartbeatAt: finishedAtMs,
      finishedAt: finishedAtIso,
      updatedAt: finishedAtIso,
      resolvedCommit: result.resolvedCommit,
      archiveDigest: result.archiveDigest,
      archiveSizeBytes: result.archiveSizeBytes,
      snapshotId,
    };
    await this.#store.putSourceSyncRun(succeeded);
    return succeeded;
  }

  async #failSourceSyncRun(
    running: SourceSyncRun,
    error: unknown,
  ): Promise<void> {
    const finishedAtMs = this.#now();
    const finishedAtIso = new Date(finishedAtMs).toISOString();
    const failed: SourceSyncRun = {
      ...running,
      status: "failed",
      heartbeatAt: finishedAtMs,
      finishedAt: finishedAtIso,
      updatedAt: finishedAtIso,
      error: errorMessage(error),
    };
    await this.#store.putSourceSyncRun(failed);
  }

  /**
   * Dead-letter backstop. Marks a run failed with the given reason when it is
   * not already terminal (succeeded/failed/blocked/cancelled). Used by the DLQ
   * consumer for runs whose consumer crashed before it could record failure.
   * Returns true when it transitioned the run.
   */
  async markRunFailed(
    action: "plan" | "apply",
    runId: string,
    reason: string,
  ): Promise<boolean> {
    if (action === "plan") {
      const planRun = await this.#store.getPlanRun(runId);
      if (!planRun || isTerminalStatus(planRun.status)) return false;
      await this.#failPlanRun(planRun, new Error(reason));
      await this.#store.deletePlanRunInputs(runId);
      return true;
    }
    const applyRun = await this.#store.getApplyRun(runId);
    if (!applyRun || isTerminalStatus(applyRun.status)) return false;
    const profile = await this.#requireRunnerProfile(applyRun.runnerProfileId);
    await this.#failApplyRun(
      applyRun,
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
    const planRun = await this.#store.getPlanRun(runId);
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
    // The sidecar is sealed at rest when a sensitive dependency value was
    // injected; #getPlanRunInputs unseals it transparently here so the plan runs
    // against the same inputs / generated root it was created with.
    const inputs = await this.#getPlanRunInputs(runId);
    const variables = normalizeVariables(inputs?.variables);
    const dispatch = templateDispatchFromInputs(inputs);
    try {
      await this.#assertCapsuleCompatibilityAllowsRun(planRun);
      assertGeneratedRootDispatchPresent(planRun, dispatch);
    } catch (error) {
      await this.#store.deletePlanRunInputs(runId);
      return await this.#failPlanRun(planRun, error);
    }
    const running = await this.#markPlanRunning(planRun);
    let result: PlanRun;
    try {
      const credentials = await this.#credentials.mintRunCredentials(
        planRun,
        "plan",
        planRun.id,
      );
      result = await this.#executePlan(
        running,
        profile,
        variables,
        credentials,
        dispatch,
      );
    } catch (error) {
      await this.#store.deletePlanRunInputs(runId);
      return await this.#failPlanRun(running, error);
    }
    // Retain the inputs sidecar for a SUCCEEDED generated-root run: the apply
    // consumer re-reads the generated root / build payload (the same generated
    // root the plan was reviewed against).
    // It is deleted once the plan is applied (apply-once) or the run is failed.
    // Non-succeeded generated-root plans drop the sidecar now.
    const retainForApply =
      result.status === "succeeded" && dispatch.generatedRoot !== undefined;
    if (!retainForApply) {
      await this.#store.deletePlanRunInputs(runId);
    }
    return result;
  }

  /**
   * Emits `installation.drift_detected` (§27 / §34 Activity) when a succeeded
   * drift_check observed a non-empty change summary. Metadata carries the run id,
   * add/change/destroy counts, provider/type/action aggregates, and public-safe
   * remediation hints only (never resource names, values, or scope identifiers).
   * A run with an empty summary emits nothing.
   */
  async #recordDriftDetected(
    planRun: PlanRun,
    changes: readonly PlanResourceChange[],
  ): Promise<void> {
    const summary = planRun.summary;
    const add = summary?.add ?? 0;
    const change = summary?.change ?? 0;
    const destroy = summary?.destroy ?? 0;
    if (add + change + destroy <= 0) return;
    const classification = classifyDriftResourceChanges(changes);
    await this.#recordActivity({
      spaceId: planRun.spaceId,
      action: "installation.drift_detected",
      targetType: "installation",
      targetId:
        planRun.installationContext?.installationId ??
        planRun.installationId ??
        planRun.id,
      runId: planRun.id,
      metadata: {
        ...(planRun.installationContext?.installationId
          ? { installationId: planRun.installationContext.installationId }
          : planRun.installationId
            ? { installationId: planRun.installationId }
            : {}),
        add,
        change,
        destroy,
        ...(Object.keys(classification.resourceTypes).length > 0
          ? { resourceTypes: classification.resourceTypes }
          : {}),
        ...(Object.keys(classification.providers).length > 0
          ? { providers: classification.providers }
          : {}),
        ...(Object.keys(classification.actions).length > 0
          ? { actions: classification.actions }
          : {}),
        ...(classification.remediationHints.length > 0
          ? { remediationHints: classification.remediationHints }
          : {}),
      },
    });
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
    // guard (single-isolate correctness).
    const runWork = () =>
      this.#runSerialized(key, () =>
        this.#executeApply(applyRun, planRun, profile, dispatch),
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

  /**
   * Mints provider credentials for provider-using runs. Provider-free runs
   * dispatch without a credential bundle; provider-using runs fail closed when
   * no Vault is wired so the runner never falls back to ambient provider env.
   * Never logs the bundle.
   */
  /**
   * Builds the M2 environment dispatch fields (`stateScope` + `sourceArchive`)
   * for a run that carries environment context. The `generation` is the state
   * generation this phase writes/restores at: a plan passes the CURRENT
   * generation (restore base); an apply / destroy_apply passes `base + 1` (the
   * persist generation the DO writes). Returns an empty object for a run WITHOUT
   * environment context so existing dispatch payloads are byte-for-byte
   * unchanged. Throws when the recorded SourceSnapshot is missing (a run cannot
   * dispatch against a snapshot the ledger no longer holds).
   */
  async #installationDispatch(
    planRun: PlanRun,
    generation: number,
  ): Promise<RunInstallationDispatch> {
    const ctx = planRun.installationContext;
    if (!ctx || !planRun.sourceSnapshotId) return {};
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
    const stateScope: DispatchStateScope = {
      spaceId: ctx.spaceId,
      installationId: ctx.installationId,
      environment: ctx.environment,
      generation,
    };
    const sourceArchive = await this.#dispatchSourceArchive(planRun, snapshot);
    // remote_state dependencies (spec §15): for each remote_state edge, dispatch
    // the producer StateSnapshot pinned by the plan's DependencySnapshot so
    // apply/destroy use the same state bytes the plan reviewed.
    const depStates = await this.#resolveRemoteStateDispatch(planRun);
    return {
      stateScope,
      sourceArchive,
      ...(depStates.length > 0 ? { depStates } : {}),
    };
  }

  async #dispatchSourceArchive(
    planRun: PlanRun,
    snapshot: SourceSnapshot,
  ): Promise<DispatchSourceArchive> {
    if (!planRun.compatibilityReportId) {
      return {
        objectKey: snapshot.archiveObjectKey,
        digest: snapshot.archiveDigest,
      };
    }
    const report = await this.#store.getCapsuleCompatibilityReport(
      planRun.compatibilityReportId,
    );
    if (!report) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_missing: plan run ${planRun.id} references ` +
          `CompatibilityReport ${planRun.compatibilityReportId} which no longer exists`,
      );
    }
    if (report.sourceSnapshotId !== snapshot.id) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_snapshot_mismatch: plan run ${planRun.id} ` +
          `uses SourceSnapshot ${snapshot.id} but report ${report.id} was created for ${report.sourceSnapshotId}`,
      );
    }
    const policy = await this.#policyForPlanRun(planRun);
    this.#assertCompatibilityReportRunnable(report, policy);
    if (
      report.level === "auto_capsulized" &&
      (!report.normalizedObjectKey || !report.normalizedDigest)
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `normalized_capsule_artifact_missing: CompatibilityReport ${report.id} ` +
          "is auto_capsulized but has no normalizedObjectKey/normalizedDigest",
      );
    }
    // auto_capsulized normalized modules are threaded through generatedRoot
    // moduleFiles; sourceArchive remains the immutable original SourceSnapshot
    // so the runner can still restore source/build context and verify commit
    // lineage without pretending the JSON artifact is an R2_SOURCE archive.
    return {
      objectKey: snapshot.archiveObjectKey,
      digest: snapshot.archiveDigest,
    };
  }

  /**
   * Builds the {@link DispatchDepState} list for a PlanRun's `remote_state`
   * DependencySnapshot entries (spec §15/§17). New PlanRuns pin the exact
   * StateSnapshot objectKey/digest at plan time. Older snapshots without those
   * optional fields fall back to the StateSnapshot with the pinned generation.
   * `name` is the producer Installation name — the `/work/deps/<name>.tfstate`
   * filename the consumer references via `terraform_remote_state`. Returns an
   * empty list when the plan pinned no remote_state edges.
   */
  async #resolveRemoteStateDispatch(
    planRun: PlanRun,
  ): Promise<readonly DispatchDepState[]> {
    if (!planRun.dependencySnapshotId) return [];
    const snapshot = await this.#store.getDependencySnapshot(
      planRun.dependencySnapshotId,
    );
    if (!snapshot) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `dependency_snapshot_missing: plan run ${planRun.id} references ` +
          `DependencySnapshot ${planRun.dependencySnapshotId} which is no ` +
          `longer present`,
      );
    }
    const depStates: DispatchDepState[] = [];
    for (const entry of snapshot.dependencies) {
      const dependency = await this.#store.getDependency(entry.dependencyId);
      if (!dependency) continue;
      if (dependency.mode !== "remote_state") continue;
      const producer = await this.#store.getInstallation(
        entry.producerInstallationId,
      );
      if (!producer) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `dependency_state_unavailable: dependency ${dependency.id} producer ` +
            `installation ${entry.producerInstallationId} not found`,
        );
      }
      const pinned = await this.#pinnedRemoteStateSnapshotForEntry(
        planRun,
        entry,
        producer,
      );
      depStates.push({
        name: producer.name,
        installationId: producer.id,
        environment: producer.environment,
        generation: pinned.generation,
        objectKey: pinned.objectKey,
        digest: pinned.digest,
      });
    }
    return depStates;
  }

  async #latestProducerStateSnapshotForDependency(
    dependencyId: string,
    producer: Installation,
  ): Promise<StateSnapshot> {
    const stateSnapshot = await this.#store.getLatestStateSnapshot(
      producer.id,
      producer.environment,
    );
    if (!stateSnapshot) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `dependency_state_unavailable: dependency ${dependencyId} producer ` +
          `installation ${producer.id} has no StateSnapshot yet (apply it first)`,
      );
    }
    return stateSnapshot;
  }

  async #pinnedRemoteStateSnapshotForEntry(
    planRun: PlanRun,
    entry: DependencySnapshotEntry,
    producer: Installation,
  ): Promise<StateSnapshot> {
    const snapshots = await this.#store.listStateSnapshots(
      producer.id,
      producer.environment,
    );
    const pinned = snapshots.find(
      (snapshot) => snapshot.generation === entry.producerStateGeneration,
    );
    if (!pinned) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `dependency_state_unavailable: plan run ${planRun.id} dependency ` +
          `${entry.dependencyId} pinned producer StateSnapshot generation ` +
          `${entry.producerStateGeneration} is no longer present`,
      );
    }
    if (entry.producerStateObjectKey || entry.producerStateDigest) {
      if (
        (entry.producerStateSnapshotId &&
          pinned.id !== entry.producerStateSnapshotId) ||
        pinned.objectKey !== entry.producerStateObjectKey ||
        pinned.digest !== entry.producerStateDigest
      ) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `dependency_snapshot_tampered: plan run ${planRun.id} dependency ` +
            `${entry.dependencyId} pinned producer StateSnapshot no longer ` +
            `matches the ledger row`,
        );
      }
    }
    return pinned;
  }

  async #reverifyRemoteStateSnapshotPin(
    planRun: PlanRun,
    entry: DependencySnapshotEntry,
  ): Promise<void> {
    const dependency = await this.#store.getDependency(entry.dependencyId);
    if (dependency?.mode !== "remote_state") return;
    const producer = await this.#store.getInstallation(
      entry.producerInstallationId,
    );
    if (!producer) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `dependency_state_unavailable: dependency ${entry.dependencyId} ` +
          `producer installation ${entry.producerInstallationId} not found`,
      );
    }
    await this.#pinnedRemoteStateSnapshotForEntry(planRun, entry, producer);
  }

  /**
   * Env-driven state generation guard (M2). For a run carrying environment
   * context, rejects when the Environment's latest StateSnapshot generation no
   * longer equals the generation this plan was created against (a sibling apply
   * advanced the env state in between). Runs without env context are unaffected
   * (the Installation-backed guard handles them).
   */
  async #assertInstallationStateGeneration(planRun: PlanRun): Promise<void> {
    const ctx = planRun.installationContext;
    if (!ctx) return;
    const base = planRun.baseStateGeneration ?? 0;
    const latest = await this.#store.getLatestStateSnapshot(
      ctx.installationId,
      ctx.environment,
    );
    const current = latest?.generation ?? 0;
    if (current !== base) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `state_generation_mismatch: plan run ${planRun.id} was created against ` +
          `installation ${ctx.installationId} (${ctx.environment}) state ` +
          `generation ${base} but it is now at generation ${current}`,
      );
    }
  }

  /**
   * Source snapshot revalidation (spec invariant 10; M2). For a plan pinned to a
   * SourceSnapshot, re-reads the persisted plan and confirms its sourceSnapshotId
   * is unchanged and still resolves to a stored snapshot — so an apply cannot run
   * against a snapshot the plan no longer references or the ledger has dropped.
   * No-ops for runs without a recorded snapshot.
   */
  async #revalidateSourceSnapshot(planRun: PlanRun): Promise<void> {
    if (!planRun.sourceSnapshotId) return;
    const persisted = await this.#store.getPlanRun(planRun.id);
    const persistedSnapshotId = persisted?.sourceSnapshotId;
    if (persistedSnapshotId !== planRun.sourceSnapshotId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `source_snapshot_mismatch: plan run ${planRun.id} source snapshot ` +
          `changed since review (${planRun.sourceSnapshotId} -> ` +
          `${persistedSnapshotId ?? "<none>"})`,
      );
    }
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
  }

  /**
   * Capsule Gate precondition (core-spec §6 / §26): when a PlanRun was created
   * from an Installation that has a reviewed CompatibilityReport, the queued
   * plan/apply consumer must re-read it before provider credential mint. Only
   * `ready` and `auto_capsulized` reports are runnable; `needs_patch` and
   * `unsupported` stop before credentials are issued.
   */
  async #assertCapsuleCompatibilityAllowsRun(planRun: PlanRun): Promise<void> {
    if (!planRun.compatibilityReportId) return;
    const report = await this.#store.getCapsuleCompatibilityReport(
      planRun.compatibilityReportId,
    );
    if (!report) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_missing: plan run ${planRun.id} references ` +
          `CompatibilityReport ${planRun.compatibilityReportId} which no longer exists`,
      );
    }
    if (
      planRun.sourceSnapshotId &&
      report.sourceSnapshotId !== planRun.sourceSnapshotId
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_snapshot_mismatch: plan run ${planRun.id} ` +
          `uses SourceSnapshot ${planRun.sourceSnapshotId} but report ` +
          `${report.id} was created for ${report.sourceSnapshotId}`,
      );
    }
    const policy = await this.#policyForPlanRun(planRun);
    this.#assertCompatibilityReportRunnable(report, policy);
  }

  /**
   * Verifies the plan's pinned DependencySnapshot at apply time (spec §17 /
   * invariant 9). No-ops when the plan pinned no snapshot.
   *
   *   - `strict` mode (production consumer): every entry's producer Installation
   *     must STILL be at the `producerStateGeneration` pinned at plan time; a
   *     moved producer is a typed `failed_precondition`
   *     (`dependency_snapshot_stale`).
   *   - both modes: recompute the per-entry `valuesDigest` over the pinned values
   *     and fail on mismatch (`dependency_snapshot_tampered`) — the pinned values
   *     are exactly what was injected and digested at plan time.
   *
   * `pinned` mode (preview / dev) intentionally tolerates a producer that moved
   * after plan: it applies the values frozen at plan time regardless.
   *
   * INDEPENDENTLY of mode, a `published_output` edge re-verifies the backing
   * OutputShare is STILL active and covers every mapped name (spec §18): a grant
   * revoked between plan and apply fails the apply `output_share_revoked`, even
   * in `pinned` mode (a revoked grant must not be applied from frozen values).
   */
  async #verifyDependencySnapshot(planRun: PlanRun): Promise<void> {
    if (!planRun.dependencySnapshotId) return;
    const snapshot = await this.#store.getDependencySnapshot(
      planRun.dependencySnapshotId,
    );
    if (!snapshot) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `dependency_snapshot_missing: plan run ${planRun.id} references ` +
          `DependencySnapshot ${planRun.dependencySnapshotId} which is no ` +
          `longer present`,
      );
    }
    for (const entry of snapshot.dependencies) {
      // Tamper check (both modes): the pinned values must still hash to the
      // pinned digest. A re-put that mutated the frozen values — OR a tampered
      // sealed-values blob (the AES-GCM auth tag and the post-decrypt content
      // digest both fail closed) — trips this. The digest is over the FULL
      // plaintext value map, so sealed sensitive values are recovered first.
      const fullValues = await this.#recoverEntryValues(planRun, entry);
      const recomputed = await stableJsonDigest(fullValues);
      if (recomputed !== entry.valuesDigest) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `dependency_snapshot_tampered: plan run ${planRun.id} dependency ` +
            `${entry.dependencyId} pinned values no longer match the pinned digest`,
        );
      }
      // published_output: re-verify the backing OutputShare at apply (spec §18).
      // A revoke after plan must fail the apply regardless of snapshot mode.
      await this.#reverifyPublishedOutputShare(planRun, entry.dependencyId);
      // remote_state: the pinned state objectKey/digest must still match the
      // immutable StateSnapshot ledger row, regardless of strict/pinned mode.
      await this.#reverifyRemoteStateSnapshotPin(planRun, entry);
      if (snapshot.mode !== "strict") continue;
      // Strict freshness: the producer must not have moved since plan.
      const producer = await this.#store.getInstallation(
        entry.producerInstallationId,
      );
      const current = producer?.currentStateGeneration ?? 0;
      if (current !== entry.producerStateGeneration) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `dependency_snapshot_stale: plan run ${planRun.id} dependency ` +
            `${entry.dependencyId} producer installation ` +
            `${entry.producerInstallationId} advanced from state generation ` +
            `${entry.producerStateGeneration} to ${current} since plan`,
        );
      }
    }
  }

  /**
   * Recovers the FULL plaintext value map of a DependencySnapshot entry: the
   * cleartext non-sensitive `values` merged with the unsealed sensitive values
   * (spec §11 / §18). A sealed entry with no configured sealer fails closed
   * (`dependency_value_sealer_unavailable`); a tampered/wrong-key blob fails
   * closed at the AES-GCM auth tag (and the post-decrypt content digest) inside
   * {@link DependencyValueSealer.open}. Used by the apply-time tamper check so
   * the recomputed `valuesDigest` is over the same full plaintext that was
   * digested at plan time.
   */
  async #recoverEntryValues(
    planRun: PlanRun,
    entry: DependencySnapshotEntry,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (!entry.sealedValues) return entry.values;
    if (!this.#dependencyValueSealer) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `dependency_value_sealer_unavailable: plan run ${planRun.id} dependency ` +
          `${entry.dependencyId} pinned sealed values but no at-rest value ` +
          `sealer is configured to open them`,
      );
    }
    const unsealed = await this.#dependencyValueSealer.open(entry.sealedValues);
    return { ...entry.values, ...unsealed };
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
   * Re-verifies the OutputShare backing a `published_output` dependency is STILL
   * active and covers every mapped name at apply time (spec §18). No-ops for a
   * non-published_output edge or one whose Dependency row is gone (the snapshot
   * already pinned the values; a missing edge cannot be re-validated and the
   * tamper/staleness checks still apply). A grant revoked (or narrowed) between
   * plan and apply throws `output_share_revoked`.
   */
  async #reverifyPublishedOutputShare(
    planRun: PlanRun,
    dependencyId: string,
  ): Promise<void> {
    const dependency = await this.#store.getDependency(dependencyId);
    if (!dependency || dependency.mode !== "published_output") return;
    const producer = await this.#store.getInstallation(
      dependency.producerInstallationId,
    );
    const consumer = await this.#store.getInstallation(
      dependency.consumerInstallationId,
    );
    if (!producer || !consumer) return;
    const coverage = await this.#resolveShareCoverage(producer, consumer);
    for (const mapping of Object.values(dependency.outputs)) {
      if (!coverage.has(mapping.from)) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `output_share_revoked: plan run ${planRun.id} dependency ` +
            `${dependencyId} consumes shared output ${mapping.from} from ` +
            `producer installation ${producer.id} but no active OutputShare ` +
            `covers it`,
        );
      }
    }
  }

  /**
   * Records the §6.9 StateSnapshot metadata after a successful env-driven apply /
   * destroy state persist. The object key mirrors the DO's R2_STATE key formula
   * (`spaces/{spaceId}/installations/{installationId}/envs/{environment}/states/{NNNNNNNN}.tfstate.enc`)
   * so the ledger pointer matches the encrypted object the DO wrote at the same
   * generation. No-ops for a run without environment context. The digest is the
   * plaintext digest the runner DO echoed back, when present.
   */
  async #recordStateSnapshot(input: {
    readonly planRun: PlanRun;
    readonly envDispatch: RunInstallationDispatch;
    readonly generation: number;
    readonly stateDigest: string | undefined;
    readonly runId: string;
    readonly now: number;
  }): Promise<void> {
    const scope = input.envDispatch.stateScope;
    if (!scope) return;
    const snapshot: StateSnapshot = {
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
    await this.#store.putStateSnapshot(snapshot);
  }

  /**
   * Records the §16 OutputSnapshot after a successful (non-destroy) apply.
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
   * The raw envelope itself never enters the ledger — only the projection.
   */
  async #recordOutputSnapshot(input: {
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
    await this.#store.putOutputSnapshot(snapshot);
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

  async #recordSourceCredentialMintEvent(input: {
    readonly runId: string;
    readonly spaceId: string;
    readonly sourceId: string;
    readonly connectionId: string;
  }): Promise<void> {
    await this.#store.putCredentialMintEvent({
      id: this.#newId("credmint"),
      runId: input.runId,
      spaceId: input.spaceId,
      sourceId: input.sourceId,
      connectionId: input.connectionId,
      phase: "source",
      capabilities: ["source"],
      createdAt: new Date(this.#now()).toISOString(),
    });
  }

  /**
   * Resolves an installation-driven run's provider bindings (spec §9) at mint time so
   * binding changes take effect on the next run. Returns `undefined` for runs
   * without installation context or whose installation row is gone — the legacy
   * space-wide pool then applies and no per-alias split is produced. The result
   * feeds BOTH {@link mintableConnectionIds} (shared pool) and
   * {@link providerMintEntriesFromResolved} (the §13 per-alias TF_VAR split),
   * mirroring `providerBindingsFromResolved` so the minted vars match the
   * rootgen aliases.
   */
  async #resolveRunProviderBindings(
    planRun: PlanRun,
  ): Promise<readonly ResolvedProviderBinding[] | undefined> {
    const ctx = planRun.installationContext;
    if (!ctx) return undefined;
    const installation = await this.#store.getInstallation(ctx.installationId);
    if (!installation) return undefined;
    this.#connectionsService ??= new ConnectionsService({
      store: this.#store,
    });
    // Run-scoped: explicit bindings + the operator-default fall-through for the
    // run's required providers (spec §7.1). The same resolution feeds rootgen, so
    // the minted TF_VAR credentials line up with the generated provider blocks.
    return await this.#connectionsService.resolveProviderBindingsForRun(
      installation,
      planRun.requiredProviders,
    );
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
  ): Promise<ListDeploymentsResponse> {
    return await this.#deployments.listDeployments(installationId);
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

  async listConnections(spaceId: string): Promise<ListConnectionsResponse> {
    return await this.#connections.listConnections(spaceId);
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

  async listSources(spaceId: string): Promise<ListSourcesResponse> {
    return await this.#sources.listSources(spaceId);
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
  ): Promise<ListSourceSnapshotsResponse> {
    return await this.#sources.listSourceSnapshots(sourceId);
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
    requireNonEmptyString(id, "runId");
    const planRun = await this.#store.getPlanRun(id);
    if (planRun) {
      return projectPlanRun(planRun, {
        awaitingApproval: await this.#planAwaitsApproval(planRun),
        ...this.#installationProjection(planRun),
      });
    }
    const applyRun = await this.#store.getApplyRun(id);
    if (applyRun) {
      // The ApplyRun does not carry env context; recover it from its PlanRun so
      // the unified Run still projects installationId / environment / sourceSnapshotId.
      const plan = await this.#store.getPlanRun(applyRun.planRunId);
      return projectApplyRun(
        applyRun,
        plan ? this.#installationProjection(plan) : {},
      );
    }
    const sync = await this.#store.getSourceSyncRun(id);
    if (sync) return projectSourceSyncRun(sync);
    const compatibilityCheck = await this.#store.getCompatibilityCheckRun(id);
    if (compatibilityCheck) return compatibilityCheck;
    const backupRun = await this.#store.getBackupRun(id);
    if (backupRun) return backupRun;
    throw new OpenTofuControllerError("not_found", `run ${id} not found`);
  }

  /**
   * Reads the run-level diagnostics + audit trail for a Run (spec §30 `GET
   * /internal/v1/runs/:runId/logs`). Diagnostics + audit events are recorded on the
   * underlying PlanRun / ApplyRun ledger record; a `source_sync` run carries no
   * structured diagnostics, so its single `error`, when present, is surfaced as
   * one error diagnostic. Returns the unified `{ diagnostics, auditEvents }`
   * shape. A missing run is a typed 404.
   */
  async getRunLogs(id: string): Promise<RunLogsResponse> {
    requireNonEmptyString(id, "runId");
    const record = await this.#requireRunRecordWithLogs(id);
    return { diagnostics: record.diagnostics, auditEvents: record.auditEvents };
  }

  /**
   * Reads the run-level audit trail for a Run (spec §30 `GET
   * /internal/v1/runs/:runId/events`). MVP: the run-level audit events only.
   */
  async getRunEvents(id: string): Promise<RunEventsResponse> {
    requireNonEmptyString(id, "runId");
    const record = await this.#requireRunRecordWithLogs(id);
    return { auditEvents: record.auditEvents };
  }

  /**
   * Public, non-secret cost projection for a `plan` / `destroy_plan` Run. It
   * re-projects the billing reservation values the controller ALREADY computed
   * at plan time (estimated credits / available credits / reservation status /
   * the credit-shortfall + plan-limit reasons recorded on the run's policy
   * decision), so a dashboard can explain, before apply, why an apply would be
   * blocked under `enforce` mode. It computes no cost (never calls the credit
   * estimator) and surfaces no secret material. Only a PlanRun (and the
   * destroy_plan that is a PlanRun) carries billing; an ApplyRun / SourceSyncRun
   * resolves to the PlanRun that produced it where possible, else `not_found`.
   */
  async getRunCost(id: string): Promise<RunCostInfo> {
    requireNonEmptyString(id, "runId");
    const planRun = await this.#store.getPlanRun(id);
    if (planRun) return projectPlanRunCost(planRun);
    // An apply / destroy_apply carries no billing of its own; resolve the
    // PlanRun it was applied from so the cost view follows the same run lineage.
    const applyRun = await this.#store.getApplyRun(id);
    if (applyRun) {
      const plan = await this.#store.getPlanRun(applyRun.planRunId);
      if (plan) return projectPlanRunCost(plan);
    }
    throw new OpenTofuControllerError(
      "not_found",
      `cost not available for run ${id}`,
    );
  }

  /**
   * Resolves a Run id to its underlying ledger record's `{ diagnostics,
   * auditEvents }`. PlanRun / ApplyRun carry both; a SourceSyncRun has neither,
   * so its `error` is projected to a single error diagnostic and its audit trail
   * is empty. A missing run is a typed 404. Used by the run logs/events routes;
   * no credential material or sensitive output value enters these projections.
   */
  async #requireRunRecordWithLogs(id: string): Promise<{
    readonly diagnostics: readonly RunDiagnostic[];
    readonly auditEvents: readonly DeployControlAuditEvent[];
  }> {
    const planRun = await this.#store.getPlanRun(id);
    if (planRun) {
      return {
        diagnostics: planRun.diagnostics ?? [],
        auditEvents: planRun.auditEvents,
      };
    }
    const applyRun = await this.#store.getApplyRun(id);
    if (applyRun) {
      return {
        diagnostics: applyRun.diagnostics ?? [],
        auditEvents: applyRun.auditEvents,
      };
    }
    const sync = await this.#store.getSourceSyncRun(id);
    if (sync) {
      return {
        diagnostics: sync.error
          ? [{ severity: "error", message: sync.error }]
          : [],
        auditEvents: [],
      };
    }
    const compatibilityCheck = await this.#store.getCompatibilityCheckRun(id);
    if (compatibilityCheck) {
      return {
        diagnostics: compatibilityCheck.errorCode
          ? [{ severity: "error", message: compatibilityCheck.errorCode }]
          : [],
        auditEvents: [],
      };
    }
    const backupRun = await this.#store.getBackupRun(id);
    if (backupRun) {
      return {
        diagnostics: backupRun.errorCode
          ? [{ severity: "error", message: backupRun.errorCode }]
          : [],
        auditEvents: [],
      };
    }
    throw new OpenTofuControllerError("not_found", `run ${id} not found`);
  }

  /**
   * Projects a PlanRun's recorded installation context + source snapshot onto
   * the §19 Run projection options. Empty for runs without installation
   * context.
   */
  #installationProjection(planRun: PlanRun): {
    installationId?: string;
    environment?: string;
    sourceSnapshotId?: string;
    dependencySnapshotId?: string;
    runGroupId?: string;
  } {
    return {
      ...(planRun.installationContext
        ? {
            installationId: planRun.installationContext.installationId,
            environment: planRun.installationContext.environment,
          }
        : {}),
      ...(planRun.sourceSnapshotId
        ? { sourceSnapshotId: planRun.sourceSnapshotId }
        : {}),
      ...(planRun.dependencySnapshotId
        ? { dependencySnapshotId: planRun.dependencySnapshotId }
        : {}),
      ...(planRun.runGroupId ? { runGroupId: planRun.runGroupId } : {}),
    };
  }

  /**
   * Cancels a run that has not started executing. Only `queued` plan/apply runs
   * (or a plan parked `waiting_approval`, i.e. `blocked` with a pending approval)
   * may be cancelled; a `running` or terminal run is rejected. Returns the
   * resulting unified Run.
   */
  async cancelRun(id: string): Promise<Run> {
    requireNonEmptyString(id, "runId");
    const planRun = await this.#store.getPlanRun(id);
    if (planRun) {
      if (
        planRun.status !== "queued" &&
        !(await this.#planAwaitsApproval(planRun))
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
      await this.#store.putPlanRun(cancelled);
      await this.#store.deletePlanRunInputs(id);
      return projectPlanRun(cancelled, {
        awaitingApproval: false,
        ...this.#installationProjection(cancelled),
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
      await this.#store.putApplyRun(cancelled);
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
   * Whether a plan run is parked awaiting an explicit approval before its apply
   * may proceed (§25 action policy). A succeeded, un-applied, un-approved plan
   * awaits approval when:
   *   - it is a destroy plan (spec §10.6 always-two-stage destroy / §25
   *     `destroy: destroy flow`); OR
   *   - the §25 action policy flagged a delete/replace change
   *     (`requiresApproval`, recorded at plan completion); OR
   *   - a template plan flagged a destructive change under
   *     `requireExplicitConfirmation` (`requiresConfirmation`).
   * The environment no longer gates approval on its own (the provisional
   * "non-preview environments always require approval" rule is removed):
   * approval is driven by the plan's actual changes.
   */
  #planAwaitsApproval(planRun: PlanRun): Promise<boolean> {
    // A §19 drift_check is read-only and can never be applied (Phase 8): it never
    // parks waiting_approval regardless of the changes it observed.
    if (planRun.driftCheck === true) return Promise.resolve(false);
    if (planRun.appliedApplyRunId) return Promise.resolve(false);
    if (planRun.approval) return Promise.resolve(false);
    if (planRun.status !== "succeeded") return Promise.resolve(false);
    if (planRun.operation === "destroy") return Promise.resolve(true);
    if (planRun.requiresApproval === true) return Promise.resolve(true);
    if (planRun.templateBinding?.requiresConfirmation === true) {
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
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
        ...this.#installationProjection(planRun),
      });
    }
    if (!(await this.#planAwaitsApproval(planRun))) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${id} is not awaiting approval`,
      );
    }
    const now = this.#now();
    const approved: PlanRun = {
      ...planRun,
      approval: {
        ...(input.approvedBy ? { approvedBy: input.approvedBy } : {}),
        approvedAt: now,
        ...(input.reason ? { reason: input.reason } : {}),
      },
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
    await this.#store.putPlanRun(approved);
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
      ...this.#installationProjection(approved),
    });
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
  // into `running`, append the phase `started` audit event, persist, and return
  // the running run.
  async #markPlanRunning(planRun: PlanRun): Promise<PlanRun> {
    const startedAt = this.#now();
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
    await this.#store.putPlanRun(running);
    return running;
  }

  async #markApplyRunning(
    applyRun: ApplyRun,
    profile: RunnerProfile,
    startedAt: number,
  ): Promise<ApplyRun> {
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
    await this.#store.putApplyRun(running);
    return running;
  }

  // Failure ceremony shared by the three catch bodies: clone the running run
  // into `failed`, attach the redacted error diagnostic and the phase `failed`
  // audit event, persist, and return the failed run.
  async #failPlanRun(running: PlanRun, error: unknown): Promise<PlanRun> {
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
    await this.#store.putPlanRun(failed);
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
    await this.#store.putApplyRun(failed);
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
    profile: RunnerProfile,
    variables: Readonly<Record<string, JsonValue>>,
    credentials: RunCredentials | undefined,
    dispatch: RunTemplateDispatch,
  ): Promise<PlanRun> {
    try {
      // A plan restores against the CURRENT generation
      // (`baseStateGeneration`). Empty for runs without installation context.
      const envDispatch = await this.#installationDispatch(
        running,
        running.baseStateGeneration ?? 0,
      );
      const planPolicy = await this.#policyForPlanRun(running);
      const providerInstallationPolicy =
        planPolicy?.providerInstallation?.requireMirror === true
          ? { requireMirror: true }
          : undefined;
      const runner = this.#runnerForProfile(profile);
      const result = await runner.plan({
        planRun: running,
        runnerProfile: profile,
        variables,
        ...(providerInstallationPolicy ? { providerInstallationPolicy } : {}),
        // Generated-root dispatch (§7): built-in modules and generic Capsules
        // use the same generated-root/moduleFiles shape. Empty only for the
        // lower-level raw `/v1/plan-runs` compatibility path.
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
        ...(envDispatch.depStates ? { depStates: envDispatch.depStates } : {}),
        // Dispatch-only: the minted env never lands on the persisted run.
        ...(credentials ? { credentials } : {}),
      });
      const now = this.#now();
      const verdict = await this.#evaluatePlanCompletion({
        running,
        profile,
        result,
        now,
      });
      const updated = this.#buildCompletedPlanRun({
        running,
        result,
        verdict,
        now,
      });
      await this.#store.putPlanRun(updated);
      await this.#recordRunnerMinuteUsage({
        spaceId: updated.spaceId,
        runId: updated.id,
        installationId: updated.installationId,
        startedAt: running.startedAt,
        finishedAt: now,
      });
      // Drift check (§19 drift_check; Phase 8): resource changes are available
      // only in the runner result and are intentionally not persisted on the
      // PlanRun. Emit the sanitized aggregate Activity here while the plan JSON
      // projection is still in scope.
      if (updated.driftCheck === true && updated.status === "succeeded") {
        await this.#recordDriftDetected(
          updated,
          result.planResourceChanges ?? [],
        );
      }
      return updated;
    } catch (error) {
      return await this.#failPlanRun(running, error);
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
    //   - raw `/v1/plan-runs` runs without installation context keep today's
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
    // (#planAwaitsApproval), so they need no field. A drift_check is read-only
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
    return {
      ...running,
      status: passedPolicy ? "succeeded" : "blocked",
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
   *     raw `/v1/plan-runs` run without installation context has no allowlist
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
  ): Promise<ApplyRunResponse> {
    const startedAt = this.#now();
    const running = await this.#markApplyRunning(applyRun, profile, startedAt);
    let runnerDispatched = false;

    try {
      const plannedInstallation = await this.#assertApplyPreconditions(
        planRun,
        dispatch,
      );
      // Mint provider credentials NOW (just before dispatch). Apply runs resolve
      // requiredProviders from the reviewed PlanRun. The bundle is attached to the
      // runner dispatch ONLY — never stored, never logged.
      const credentials = await this.#credentials.mintRunCredentials(
        planRun,
        planRun.operation === "destroy" ? "destroy" : "apply",
        running.id,
      );
      if (planRun.operation === "destroy") {
        return await this.#executeDestroyApply(
          running,
          planRun,
          profile,
          startedAt,
          plannedInstallation,
          credentials,
          dispatch,
        );
      }
      const {
        result,
        envDispatch,
        persistGeneration,
        providerInstallationPolicy,
      } = await this.#dispatchApply({
        running,
        planRun,
        profile,
        dispatch,
        credentials,
        // Flip the runner-dispatched flag ONLY when the runner is actually
        // invoked, so a throw from the pre-dispatch env/policy resolution does
        // not record runner-minute usage (matches the pre-extraction order).
        onDispatch: () => {
          runnerDispatched = true;
        },
      });
      const now = this.#now();
      const projected = await this.#projectAndRecordApplyOutputs({
        planRun,
        applyRun,
        plannedInstallation,
        result,
        dispatch,
        now,
      });
      const deployment = await this.#recordApplyDeployment({
        planRun,
        applyRun,
        installation: projected.installation,
        outputs: projected.outputs,
        outputSnapshot: projected.outputSnapshot,
        nextStateGeneration: projected.nextStateGeneration,
        now,
      });
      const patched = await this.#persistApplyStateGeneration({
        planRun,
        plannedInstallation,
        installation: projected.installation,
        deployment,
        outputSnapshot: projected.outputSnapshot,
        envDispatch,
        persistGeneration,
        nextStateGeneration: projected.nextStateGeneration,
        stateDigest: result.stateDigest,
        runId: applyRun.id,
        now,
      });
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
        running,
        planRun,
        applyRun,
        profile,
        installation: projected.installation,
        patched,
        deployment,
        outputs: projected.outputs,
        nextStateGeneration: projected.nextStateGeneration,
        result,
        providerInstallationPolicy,
        dispatch,
        startedAt,
        now,
      });
    } catch (error) {
      await this.#billing.releaseApplyBillingReservation(planRun);
      const failed = await this.#failApplyRun(
        running,
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
    await this.#assertInstallationStateGeneration(planRun);
    // Consumer pre-flight: re-assert the plan still references its SourceSnapshot
    // (spec invariant 10) just before dispatch, mirroring the digest/generation
    // pre-flight checks.
    await this.#revalidateSourceSnapshot(planRun);
    // DependencySnapshot verification (spec §17 / invariant 9): when the plan
    // pinned a DependencySnapshot, re-read it and verify producer state
    // generations (strict mode) + recompute the pinned values digests (tamper
    // check) before applying. A moved producer (strict) is
    // `dependency_snapshot_stale`; a digest mismatch is
    // `dependency_snapshot_tampered`.
    await this.#verifyDependencySnapshot(planRun);
    await this.#assertCapsuleCompatibilityAllowsRun(planRun);
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
    const envDispatch = await this.#installationDispatch(
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
   * Projects the apply outputs and captures the §16 OutputSnapshot. Returns the
   * resolved Installation, the bumped state generation, the new OutputSnapshot,
   * and the Installation's PREVIOUS OutputSnapshot (which drives §24 stale
   * propagation).
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
    const outputSnapshot = await this.#recordOutputSnapshot({
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
    return {
      outputs,
      installation,
      nextStateGeneration,
      previousOutputSnapshot,
      outputSnapshot,
    };
  }

  /**
   * Records the §21 Deployment for a successful apply and supersedes the
   * Installation's previously-current Deployment.
   */
  async #recordApplyDeployment(input: {
    readonly planRun: PlanRun;
    readonly applyRun: ApplyRun;
    readonly installation: Installation;
    readonly outputs: readonly DeploymentOutput[];
    readonly outputSnapshot: OutputSnapshot;
    readonly nextStateGeneration: number;
    readonly now: number;
  }): Promise<Deployment> {
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
    await this.#store.putDeployment(deployment);
    // §21 status transition: the previously-current Deployment is superseded
    // by the new active one.
    if (installation.currentDeploymentId) {
      const previous = await this.#store.getDeployment(
        installation.currentDeploymentId,
      );
      if (previous && previous.status === "active") {
        await this.#store.putDeployment({
          ...previous,
          status: "superseded",
        });
      }
    }
    return deployment;
  }

  /**
   * Records the StateSnapshot for the persisted generation and advances the
   * Installation's currentDeployment / state generation / OutputSnapshot
   * pointers. Returns the patched Installation (or undefined when the guarded
   * patch did not apply).
   */
  async #persistApplyStateGeneration(input: {
    readonly planRun: PlanRun;
    readonly plannedInstallation: Installation | undefined;
    readonly installation: Installation;
    readonly deployment: Deployment;
    readonly outputSnapshot: OutputSnapshot;
    readonly envDispatch: RunInstallationDispatch;
    readonly persistGeneration: number;
    readonly nextStateGeneration: number;
    readonly stateDigest: string | undefined;
    readonly runId: string;
    readonly now: number;
  }): Promise<Installation | undefined> {
    const { planRun, installation, deployment, outputSnapshot, now } = input;
    // Record the StateSnapshot metadata aligned to the SAME generation
    // written to R2_STATE (persistGeneration). The DO wrote the encrypted
    // object + current.json at this key; only metadata enters the ledger.
    // Recorded BEFORE the installation generation bump so the two advance
    // together.
    await this.#recordStateSnapshot({
      planRun,
      envDispatch: input.envDispatch,
      generation: input.persistGeneration,
      stateDigest: input.stateDigest,
      runId: input.runId,
      now,
    });
    return await this.#store.patchInstallation(
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
   * Finalizes a successful apply: persists the succeeded ApplyRun, records
   * runner-minute usage, marks the PlanRun applied (apply-once), captures
   * billing usage, drops the retained generated-root inputs sidecar, and emits
   * the §27 / §34 activity. Returns the apply response.
   */
  async #completeApplyRun(input: {
    readonly running: ApplyRun;
    readonly planRun: PlanRun;
    readonly applyRun: ApplyRun;
    readonly profile: RunnerProfile;
    readonly installation: Installation;
    readonly patched: Installation | undefined;
    readonly deployment: Deployment;
    readonly outputs: readonly DeploymentOutput[];
    readonly nextStateGeneration: number;
    readonly result: OpenTofuApplyResult;
    readonly providerInstallationPolicy: { requireMirror: boolean } | undefined;
    readonly dispatch: RunTemplateDispatch;
    readonly startedAt: number;
    readonly now: number;
  }): Promise<ApplyRunResponse> {
    const {
      running,
      planRun,
      applyRun,
      profile,
      installation,
      deployment,
      outputs,
      result,
      dispatch,
      startedAt,
      now,
    } = input;
    const diagnostics = redactRunDiagnostics(result.diagnostics);
    const completed: ApplyRun = {
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
    await this.#store.putApplyRun(completed);
    await this.#recordRunnerMinuteUsage({
      spaceId: completed.spaceId,
      runId: completed.id,
      installationId: completed.installationId,
      startedAt,
      finishedAt: now,
    });
    // Mark the PlanRun applied so it cannot be applied again (apply-once).
    await this.#store.putPlanRun({
      ...planRun,
      appliedApplyRunId: applyRun.id,
      updatedAt: now,
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
    const envDispatch = await this.#installationDispatch(
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
      const result = await runner.destroy({
        applyRun: running,
        planRun,
        planArtifact: planRun.planArtifact,
        installation,
        runnerProfile: profile,
        ...(providerInstallationPolicy ? { providerInstallationPolicy } : {}),
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
        // remote_state dependency states materialized into /work/deps (spec §15):
        // the teardown config still refreshes its `terraform_remote_state` data
        // sources, so the producer state files must be present.
        ...(envDispatch.depStates ? { depStates: envDispatch.depStates } : {}),
        ...(credentials ? { credentials } : {}),
      });
      const now = this.#now();
      // Record the post-teardown StateSnapshot at the SAME generation the DO
      // wrote to R2_STATE, then advance the Installation generation so a stale
      // plan created against the pre-destroy generation cannot re-apply.
      await this.#recordStateSnapshot({
        planRun,
        envDispatch,
        generation: persistGeneration,
        stateDigest: undefined,
        runId: running.id,
        now,
      });
      if (installation.currentDeploymentId) {
        const previous = await this.#store.getDeployment(
          installation.currentDeploymentId,
        );
        if (previous && previous.status !== "destroyed") {
          await this.#store.putDeployment({ ...previous, status: "destroyed" });
        }
      }
      const nextStateGeneration = installation.currentStateGeneration + 1;
      const patched = await this.#store.patchInstallation(
        installation.id,
        {
          currentDeploymentId: undefined,
          status: "destroyed",
          updatedAt: new Date(now).toISOString(),
          currentStateGeneration: nextStateGeneration,
        },
        {
          currentDeploymentId:
            planRun.installationCurrentDeploymentId ?? undefined,
          status: installation.status,
        },
      );
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
      await this.#store.putApplyRun(completed);
      await this.#recordRunnerMinuteUsage({
        spaceId: completed.spaceId,
        runId: completed.id,
        installationId: completed.installationId,
        startedAt,
        finishedAt: now,
      });
      // Mark the PlanRun applied so a destroy plan cannot be re-applied.
      await this.#store.putPlanRun({
        ...planRun,
        appliedApplyRunId: running.id,
        updatedAt: now,
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
// fixed field set (instead of an object's own keys) keeps the digest comparison
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

/** Derives generated-root provider bindings from resolved provider bindings. */
function providerBindingsFromResolved(
  resolved: readonly ResolvedProviderBinding[],
): readonly RootProviderBinding[] {
  const providers: RootProviderBinding[] = [];
  for (const entry of resolved) {
    const provider = entry.connection?.provider;
    if (!provider) continue;
    providers.push({
      provider,
      ...(entry.alias ? { alias: entry.alias } : {}),
    });
  }
  return providers;
}

/**
 * Flattens an installation's manual-mode provider binding values into module input
 * overrides (§13 decision). Manual values are per-installation overrides; only
 * JSON-scalar values flow through (the template input validator rejects unknown
 * keys downstream, and rootgen renders scalars only). Later bindings win on a
 * key collision in profile order.
 */
function manualValuesFromResolved(
  resolved: readonly ResolvedProviderBinding[],
): Readonly<Record<string, JsonValue>> {
  const merged: Record<string, JsonValue> = {};
  for (const entry of resolved) {
    if (entry.mode !== "manual" || !entry.values) continue;
    for (const [key, value] of Object.entries(entry.values)) {
      if (isJsonScalar(value)) merged[key] = value;
    }
  }
  return merged;
}

/**
 * Merges the manual-mode provider values OVER the InstallConfig variableMapping
 * (§13 decision: manual values are per-installation overrides and win on a key
 * collision). Returns `undefined` when neither side contributes a key so the
 * caller passes `undefined` (byte-identical to no inputs).
 */
function mergeManualInputs(
  template: TemplateDefinition,
  configInputs: Readonly<Record<string, JsonValue>> | undefined,
  manualValues: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> | undefined {
  const manualForTemplate: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(manualValues)) {
    if (!(key in template.inputs)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `manual provider value '${key}' is not declared by template ${template.id}`,
      );
    }
    manualForTemplate[key] = value;
  }
  if (
    (!configInputs || Object.keys(configInputs).length === 0) &&
    Object.keys(manualForTemplate).length === 0
  ) {
    return configInputs;
  }
  return { ...(configInputs ?? {}), ...manualForTemplate };
}

// Managed cf-proxy: the cloudflare provider local name (a binding's `provider`
// may be short `cloudflare`, `cloudflare/cloudflare`, or fully-qualified).
function isCloudflareProvider(provider: string): boolean {
  return provider.split("/").pop() === "cloudflare";
}

// cf-proxy signature lifetime. Covers the longest realistic plan+apply run (the
// signature is minted fresh per run, so this only needs to outlast one run's
// provider calls, not be long-lived).
const CF_PROXY_SIGNATURE_TTL_MS = 12 * 60 * 60 * 1000;

// Builds the cf-proxy provider base_url for a managed run. The path carries a
// control-plane signature segment + the dispatch namespace + the install slug
// (the script-name prefix) so the proxy verifies the scope, then rewrites
// `…/workers/scripts/{n}` -> `…/dispatch/namespaces/{ns}/scripts/{slug}-{n}` and
// passes other calls through. The signature stops the edge route being an
// unauthenticated open relay; the capsule cannot override the base_url (root-only
// provider config), and cannot forge the signature (control-plane secret only).
function managedCloudflareProxyBaseUrl(
  proxy: CloudflareApiProxyConfig,
  namespace: string,
  slug: string,
  signature: string,
): string {
  const origin = proxy.origin.replace(/\/+$/, "");
  const route = (proxy.route.startsWith("/") ? proxy.route : `/${proxy.route}`)
    .replace(/\/+$/, "");
  return (
    `${origin}${route}/${signature}/${encodeURIComponent(namespace)}/` +
    `${encodeURIComponent(slug)}/client/v4`
  );
}

function isJsonScalar(value: unknown): value is string | number | boolean {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean";
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

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (type !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

/** Maps a TemplateDefinition's optional build into a DispatchBuildSpec. */
function templateBuildSpec(
  template: TemplateDefinition,
): DispatchBuildSpec | undefined {
  if (!template.build) return undefined;
  return {
    runtime: template.build.runtime,
    commands: [...template.build.commands],
    artifactPath: template.build.artifactPath,
  };
}

/**
 * Maps an enabled InstallConfig.build into the DispatchBuildSpec the runner build
 * phase consumes (M5 decision: same DispatchBuildSpec threading the template
 * build uses; the build runs in the Container with ZERO credentials — invariant
 * 3). `artifactPath` defaults to `dist` when the config omits it.
 */
function installConfigBuildSpec(build: InstallBuildConfig): DispatchBuildSpec {
  return {
    runtime: "bun",
    commands: [...build.commands],
    artifactPath: build.artifactPath ?? "dist",
  };
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
 * identity/metadata only: a `git` source pinned to the resolved commit and the
 * snapshot module path. SSH / scp-style Source URLs are normalized to their
 * https form so the descriptor satisfies the HTTPS-only git source validation
 * (the real fetch never uses this URL).
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
  const modulePath = normalizeModulePath(snapshot.path);
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
 * Normalizes a SourceSnapshot `path` (the module path within the repo) to the
 * OpenTofu `modulePath` shape: drops a leading `./`, trims slashes, and returns
 * `undefined` for the repo root (`.` / empty) so the descriptor omits it.
 */
function normalizeModulePath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const trimmed = path
    .replace(/^\.\/+/, "")
    .replace(/^\/+|\/+$/g, "")
    .trim();
  if (trimmed.length === 0 || trimmed === ".") return undefined;
  return trimmed;
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

function normalizeMeteredUsageEvent(
  spaceId: string,
  input: RecordMeteredUsageInput,
  newIdForUsage: () => string,
  nowIso: () => string,
): UsageEvent {
  if (!isUsageEventKind(input.kind)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "usage event kind is not supported",
    );
  }
  if (!isExternalUsageEventSource(input.source)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "usage event source must be resource_meter, billing_reconciliation, or manual_adjustment",
    );
  }
  if (!Number.isFinite(input.quantity) || input.quantity < 0) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "usage quantity must be a non-negative finite number",
    );
  }
  if (
    !Number.isInteger(input.credits) ||
    (input.source !== "billing_reconciliation" && input.credits < 0)
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      input.source === "billing_reconciliation"
        ? "usage credits must be an integer"
        : "usage credits must be a non-negative integer",
    );
  }
  requireNonEmptyString(input.idempotencyKey, "idempotencyKey");
  const createdAt = input.createdAt ?? nowIso();
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "usage createdAt must be an ISO timestamp",
    );
  }
  return {
    id: newIdForUsage(),
    spaceId,
    ...(input.installationId ? { installationId: input.installationId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    kind: input.kind,
    quantity: input.quantity,
    credits: input.credits,
    source: input.source,
    idempotencyKey: input.idempotencyKey,
    createdAt,
  };
}

function normalizeUsagePeriod(input: RecordManagedResourceUsageInput): {
  readonly periodStart: string;
  readonly periodEnd: string;
} {
  const periodStartMs = Date.parse(input.periodStart);
  const periodEndMs = Date.parse(input.periodEnd);
  if (
    !Number.isFinite(periodStartMs) ||
    !Number.isFinite(periodEndMs) ||
    periodEndMs <= periodStartMs
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "managed resource usage period must have valid ISO periodStart < periodEnd",
    );
  }
  if (!Array.isArray(input.meters)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "managed resource usage meters must be an array",
    );
  }
  for (const meter of input.meters) {
    if (!isManagedResourceUsageKind(meter.kind)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "managed resource usage kind is not supported",
      );
    }
    requireNonEmptyString(meter.meterId, "meterId");
  }
  return {
    periodStart: new Date(periodStartMs).toISOString(),
    periodEnd: new Date(periodEndMs).toISOString(),
  };
}

function normalizeInvoiceUsagePeriod(input: ReconcileInvoiceUsageInput): {
  readonly periodStart: string;
  readonly periodEnd: string;
} {
  const periodStartMs = Date.parse(input.periodStart);
  const periodEndMs = Date.parse(input.periodEnd);
  if (
    !Number.isFinite(periodStartMs) ||
    !Number.isFinite(periodEndMs) ||
    periodEndMs <= periodStartMs
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "invoice usage period must have valid ISO periodStart < periodEnd",
    );
  }
  return {
    periodStart: new Date(periodStartMs).toISOString(),
    periodEnd: new Date(periodEndMs).toISOString(),
  };
}

function isUsageEventKind(value: unknown): value is UsageEventKind {
  return (
    value === "runner_minute" ||
    value === "managed_compute" ||
    value === "managed_storage_gb_hour" ||
    value === "artifact_storage_gb_hour" ||
    value === "backup_storage_gb_hour" ||
    value === "egress_gb" ||
    value === "operation"
  );
}

function isManagedResourceUsageKind(
  value: unknown,
): value is ManagedResourceUsageMeter["kind"] {
  return (
    value === "managed_compute" ||
    value === "managed_storage_gb_hour" ||
    value === "artifact_storage_gb_hour" ||
    value === "backup_storage_gb_hour" ||
    value === "egress_gb"
  );
}

function isExternalUsageEventSource(
  value: unknown,
): value is Exclude<UsageEventSource, "runner"> {
  return (
    value === "resource_meter" ||
    value === "billing_reconciliation" ||
    value === "manual_adjustment"
  );
}

function isExternalOperatorUsageEventSource(
  value: unknown,
): value is "resource_meter" | "manual_adjustment" {
  return value === "resource_meter" || value === "manual_adjustment";
}

function isMeteredInvoiceUsageSource(source: UsageEventSource): boolean {
  return source === "runner" || source === "resource_meter";
}

function isUsageEventInInvoicePeriod(
  event: UsageEvent,
  periodStart: string,
  periodEnd: string,
): boolean {
  const createdAt = Date.parse(event.createdAt);
  if (!Number.isFinite(createdAt)) return false;
  const start = Date.parse(periodStart);
  const end = Date.parse(periodEnd);
  if (event.source === "resource_meter") {
    return createdAt > start && createdAt <= end;
  }
  return createdAt >= start && createdAt < end;
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

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function isTerminalStatus(status: RunStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "blocked" ||
    status === "cancelled"
  );
}
