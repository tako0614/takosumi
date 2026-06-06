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
  DispatchGeneratedRoot,
  DispatchSourceArchive,
  DispatchStateScope,
  DispatchTemplateRef,
  GetInstallationResponse,
  InstallBuildConfig,
  InstallConfig,
  Installation,
  InstallType,
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
  PlanRunSummary,
  PlanRunTemplateBinding,
  RunnerProfile,
  RunnerStateLockEvidence,
  RunDiagnostic,
  RunStatus,
  TemplateDefinition,
  TestConnectionResponse,
} from "takosumi-contract/deploy-control-api";
import type {
  ConnectionVault,
  CredentialBundle,
} from "../../adapters/vault/mod.ts";
import { ConnectionVaultError } from "../../adapters/vault/mod.ts";
import type { SourcesService } from "../sources/mod.ts";
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
import {
  InMemoryOpenTofuDeploymentStore,
  InstallationPatchGuardConflict,
  type OpenTofuDeploymentStore,
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
  projectTemplatePublicOutputs,
  redactRunDiagnostics,
  spaceOutputsFromOpenTofu,
  stateLockEvidence,
} from "./projection.ts";
import { evaluateTemplatePlanPolicy } from "./template_policy.ts";
import {
  type ActionPolicyResult,
  evaluateActionPolicy,
  evaluateResourceAllowlist,
  type ResourceAllowlistResult,
} from "takosumi-policy";
import {
  defaultTemplateRegistry,
  type TemplateInputValue,
  type TemplateRegistry,
  validateTemplateInputs,
} from "../templates/mod.ts";
import {
  type CapabilityKind,
  type CapabilityProvider,
  generateInstallationRoot,
  type GeneratedRootInstallType,
  generateRootModule,
} from "takosumi-rootgen";
import { downstreamClosure } from "takosumi-graph";
import type {
  Run,
  RunEventsResponse,
  RunLogsResponse,
} from "takosumi-contract/runs";
import type { OutputSnapshot } from "takosumi-contract/output-snapshots";
import type {
  Dependency,
  DependencySnapshot,
  DependencySnapshotEntry,
  DependencySnapshotMode,
} from "takosumi-contract/dependencies";
import {
  projectApplyRun,
  projectPlanRun,
  projectSourceSyncRun,
} from "./projection_run.ts";
import {
  type InstallationCoordination,
  withInstallationLease,
} from "./installation_lease.ts";
import {
  ConnectionsService,
  mintableConnectionIds,
  type ResolvedCapability,
} from "../connections/mod.ts";

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

/**
 * Minted provider credential env vars threaded onto the runner dispatch payload
 * only. The controller fills this from `vault.mint(...).env` in the queue
 * consumer just before dispatch; it is NEVER persisted to the store and NEVER
 * logged. The runner filters it through provider-env-rules and falls back to its
 * own `Bun.env` when absent.
 */
export type RunCredentials = Readonly<Record<string, string>>;

/**
 * Template dispatch fields threaded onto a run job (Phase 1C). When present the
 * runner runs `tofu` in `/work/generated-root` against the baked-in template
 * module; the optional build phase runs first in the user source checkout with
 * NO credentials. These map 1:1 onto the `request.template` / `generatedRoot` /
 * `build` fields of the `takosumi.opentofu-run@v1` dispatch envelope.
 */
export interface RunTemplateDispatch {
  readonly template?: DispatchTemplateRef;
  readonly generatedRoot?: DispatchGeneratedRoot;
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
}

export interface OpenTofuPlanJob extends RunTemplateDispatch, RunInstallationDispatch {
  readonly planRun: PlanRun;
  readonly runnerProfile: RunnerProfile;
  readonly variables: Readonly<Record<string, JsonValue>>;
  readonly credentials?: RunCredentials;
}

export interface OpenTofuApplyJob extends RunTemplateDispatch, RunInstallationDispatch {
  readonly applyRun: ApplyRun;
  readonly planRun: PlanRun;
  readonly planArtifact: OpenTofuPlanArtifact;
  readonly runnerProfile: RunnerProfile;
  readonly credentials?: RunCredentials;
}

export interface OpenTofuDestroyJob extends RunTemplateDispatch, RunInstallationDispatch {
  readonly applyRun: ApplyRun;
  readonly planRun: PlanRun;
  readonly planArtifact: OpenTofuPlanArtifact;
  readonly installation: Installation;
  readonly runnerProfile: RunnerProfile;
  readonly credentials?: RunCredentials;
}

export interface OpenTofuPlanResult {
  readonly planDigest: string;
  readonly planArtifact: OpenTofuPlanArtifact;
  readonly requiredProviders?: readonly string[];
  readonly sourceCommit?: string;
  readonly providerLockDigest?: string;
  readonly summary?: PlanRunSummary;
  readonly diagnostics?: readonly RunDiagnostic[];
  /**
   * Resource-change projection from `tofu show -json tfplan` (Phase 1C). Used by
   * the template plan-JSON policy to enforce allowedResourceTypes and to flag
   * destructive (delete/replace) changes. Absent for non-template runs.
   */
  readonly planResourceChanges?: readonly PlanResourceChange[];
}

export interface OpenTofuApplyResult {
  readonly outputs?: OpenTofuOutputEnvelope | readonly DeploymentOutput[];
  readonly stateLock?: RunnerStateLockEvidence;
  readonly diagnostics?: readonly RunDiagnostic[];
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

export interface OpenTofuDeploymentControllerDependencies {
  readonly store?: OpenTofuDeploymentStore;
  readonly runner?: OpenTofuRunner;
  readonly runnerProfiles?: readonly RunnerProfile[];
  readonly defaultRunnerProfileId?: string;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => number;
  /**
   * Credential Vault broker. When present, the controller exposes the
   * Connection lifecycle (`createConnection` / `listConnections` /
   * `testConnection` / `deleteConnection`) and `mintCredentialBundle`. When
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
   * Official template catalog (Phase 1C). Defaults to the built-in registry.
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
}

export interface DeployControlActorContext {
  readonly actor?: string;
}

/**
 * Install-type wiring for an installation-driven template plan (§13). Carried
 * through {@link PlanRunInternalContext} so {@link
 * OpenTofuDeploymentController.createPlanRun} can drive `generateInstallationRoot`
 * (installType-aware generated root + per-capability provider aliases + the
 * `app_source` build) instead of the raw {@link generateRootModule}. Absent for
 * the raw `/v1/plan-runs` template path (no installation context = no
 * capabilities), which stays on `generateRootModule`.
 */
interface InstallTypePlanContext {
  /** §13 generated-root install type (core / opentofu_module / app_source). */
  readonly installType: GeneratedRootInstallType;
  /** Per-capability provider mapping derived from the resolved capabilities. */
  readonly capabilityProviders: readonly CapabilityProvider[];
  /**
   * Manual-mode capability values flattened into module input overrides (§13
   * decision: manual values override the InstallConfig variableMapping).
   */
  readonly manualValues: Readonly<Record<string, JsonValue>>;
  /** InstallConfig.build, when enabled (overrides the template build). */
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
  /** The Installation's current state generation (its latest StateSnapshot, or 0). */
  readonly baseStateGeneration?: number;
  /** Install-type wiring for an installation-driven template plan (§13). */
  readonly installTypePlan?: InstallTypePlanContext;
  /**
   * RunGroup this plan belongs to (spec §19 / §24). Stamped onto the PlanRun by
   * the RunGroup space-update path so the §19 Run projects `runGroupId` and the
   * group status can be computed from its member runs. Absent for standalone
   * plans.
   */
  readonly runGroupId?: string;
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
  readonly entries: readonly DependencySnapshotEntry[];
  readonly mode: DependencySnapshotMode;
}

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
   * rollback-plan path (`POST /api/deployments/:id/rollback-plan`) to re-plan an
   * Installation against the source snapshot a prior Deployment was built from.
   * The snapshot must belong to the Installation's Source.
   */
  readonly sourceSnapshotId?: string;
}

export class OpenTofuDeploymentController {
  readonly #store: OpenTofuDeploymentStore;
  readonly #runner?: OpenTofuRunner;
  readonly #vault?: ConnectionVault;
  readonly #sourcesService?: SourcesService;
  readonly #defaultRunnerProfileId: string;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #enqueueRun: EnqueueRun;
  readonly #templateRegistry: TemplateRegistry;
  readonly #installationCoordination?: InstallationCoordination;
  readonly #activity: ActivityRecorder;
  readonly #seededProfiles: Promise<void>;
  readonly #mutationChains = new Map<string, Promise<void>>();
  #connectionsService?: ConnectionsService;

  constructor(dependencies: OpenTofuDeploymentControllerDependencies = {}) {
    this.#store = dependencies.store ?? new InMemoryOpenTofuDeploymentStore();
    this.#runner = dependencies.runner;
    this.#vault = dependencies.vault;
    this.#sourcesService = dependencies.sourcesService;
    this.#installationCoordination = dependencies.installationCoordination;
    this.#activity = dependencies.activity ?? NOOP_ACTIVITY_RECORDER;
    this.#defaultRunnerProfileId = dependencies.defaultRunnerProfileId ??
      "cloudflare-default";
    this.#newId = dependencies.newId ?? newId;
    this.#now = dependencies.now ?? (() => Date.now());
    // Default to an inline dispatcher: run the consumer immediately so local /
    // node substrates and tests keep the historical synchronous semantics.
    this.#enqueueRun = dependencies.enqueueRun ??
      ((dispatch) => this.dispatchQueuedRun(dispatch));
    this.#templateRegistry = dependencies.templateRegistry ??
      defaultTemplateRegistry;
    this.#seededProfiles = this.#seedRunnerProfiles(
      dependencies.runnerProfiles ?? createDefaultRunnerProfiles(this.#now()),
    );
  }

  async listRunnerProfiles(): Promise<ListRunnerProfilesResponse> {
    await this.#seededProfiles;
    return { runnerProfiles: await this.#store.listRunnerProfiles() };
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
    const operation = request.operation ?? (request.installationId
      ? "update"
      : "create");
    validateOperation(operation);
    const installation = request.installationId !== undefined
      ? await this.#requireInstallation(request.installationId)
      : undefined;
    // Installation-first model (spec §5): every plan / destroy plan targets an
    // existing Installation row. The create-on-apply legacy path is removed.
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
    validateSourceAllowedByProfile(request.source, profile);
    const now = this.#now();
    const variables = normalizeVariables(request.variables);
    // Template path (Phase 1C). When templateId is present the official template
    // is the OpenTofu surface: requiredProviders come from the template policy
    // (the request must NOT also pass requiredProviders), inputs are validated
    // against the template, and rootgen produces the generated root module that
    // is threaded onto the dispatch payload via the plan-run-inputs sidecar.
    const templatePlan = this.#resolveTemplatePlan(request, internal.installTypePlan);
    const declaredProviders = templatePlan
      ? normalizeProviders(templatePlan.requiredProviders)
      : normalizeProviders(request.requiredProviders ?? []);
    // A template that declares zero allowed providers is an intentionally
    // provider-free §10 install (e.g. `core`, pure value plumbing): the
    // "requiredProviders before init" gate does not apply. A raw cloud run still
    // must declare providers.
    const allowNoProviders = templatePlan !== undefined &&
      templatePlan.template.policy.allowedProviders.length === 0;
    const policy = evaluatePolicy({
      profile,
      requiredProviders: declaredProviders,
      checkedAt: now,
      ...(allowNoProviders ? { allowNoProviders: true } : {}),
    });
    const sourceDigest = await stableJsonDigest(request.source);
    const variablesDigest = await stableJsonDigest(variables);
    const policyDecisionDigest = await stableJsonDigest(policy);
    // Snapshot the target's state generation so a stale plan cannot apply over a
    // newer state. `create` plans have no prior target and record 0. An
    // env-driven run carries the Environment's current generation (read from its
    // latest StateSnapshot) so the M2 dispatch can derive the restore/persist
    // generations even before the first Installation exists.
    const baseStateGeneration = internal.baseStateGeneration ??
      (installation ? installation.currentStateGeneration : 0);
    const planRun: PlanRun = {
      id: this.#newId("plan"),
      spaceId: request.spaceId,
      ...(request.installationId ? { installationId: request.installationId } : {}),
      ...(installation
        ? {
          // A fresh Installation has no current Deployment yet; record an
          // explicit `null` (not `undefined`) so the apply expected-guard
          // precondition treats the run as having recorded its installation
          // context (the guard builder normalizes undefined -> null anyway).
          installationCurrentDeploymentId: installation.currentDeploymentId ??
            null,
        }
        : {}),
      source: request.source,
      sourceDigest,
      operation,
      runnerProfileId: profile.id,
      variablesDigest,
      requiredProviders: declaredProviders,
      baseStateGeneration,
      ...(internal.sourceSnapshotId
        ? { sourceSnapshotId: internal.sourceSnapshotId }
        : {}),
      ...(internal.installationContext
        ? { installationContext: internal.installationContext }
        : {}),
      ...(internal.runGroupId ? { runGroupId: internal.runGroupId } : {}),
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
        auditEvent("plan", "plan.requested", now, {
          sourceDigest,
          variablesDigest,
          runnerProfileId: profile.id,
          ...(templatePlan
            ? {
              templateId: templatePlan.template.id,
              templateVersion: templatePlan.template.version,
            }
            : {}),
        }, context.actor),
        auditEvent("plan", "plan.policy_evaluated", now, {
          policyDecisionDigest,
          status: policy.status,
        }, context.actor),
      ],
      createdAt: now,
      updatedAt: now,
      ...(policy.status === "blocked" ? { finishedAt: now } : {}),
    };
    await this.#store.putPlanRun(planRun);
    // Activity (§27 / §34): a plan / destroy-plan Run was created. Run id +
    // operation + policy status only.
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
    // Persist the plan inputs out-of-band (internal, never part of the public
    // ledger projection) so the queue consumer can re-run the plan without the
    // controller retaining them on the public PlanRun record. This sidecar also
    // carries the template dispatch data (template ref / generated root / build)
    // for template-backed runs. Skipped only when there is nothing to persist.
    if (Object.keys(variables).length > 0 || templatePlan) {
      await this.#store.putPlanRunInputs({
        planRunId: planRun.id,
        variables,
        ...(templatePlan
          ? {
            template: {
              id: templatePlan.template.id,
              version: templatePlan.template.version,
              localModulePath: templatePlan.template.source.localModulePath,
            },
            generatedRoot: templatePlan.generatedRoot,
            ...(templatePlan.build ? { build: templatePlan.build } : {}),
          }
          : {}),
      });
    }
    if (policy.status === "passed" && this.#runner) {
      // Hand off to the dispatch seam. The default inline dispatcher executes the
      // consumer synchronously (so this call returns a terminal PlanRun, exactly
      // as before); the Workers producer enqueues and returns immediately, after
      // which clients poll GET /v1/plan-runs/:id.
      await this.#enqueueRun({
        action: "plan",
        runId: planRun.id,
        spaceId: planRun.spaceId,
      });
      const dispatched = await this.#store.getPlanRun(planRun.id);
      return { planRun: dispatched ?? planRun };
    }
    return { planRun };
  }

  /**
   * Installation-driven plan (spec §23 Plan). Resolves the Installation ->
   * InstallConfig -> Source (installation.sourceId), picks the LATEST
   * SourceSnapshot for the source (preferring the Source's defaultRef), and
   * creates a plan run carrying installation context + the resolved snapshot.
   * The base state generation is the Installation's current generation (its
   * latest StateSnapshot, or 0).
   */
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
    const source = await this.#store.getSource(installation.sourceId);
    if (!source) {
      throw new OpenTofuControllerError(
        "not_found",
        `source ${installation.sourceId} not found for installation ${installationId}`,
      );
    }
    // The rollback-plan path pins a SPECIFIC SourceSnapshot (a prior
    // Deployment's snapshot); otherwise resolve the Source's latest snapshot for
    // its default ref.
    const snapshot = internal.sourceSnapshotId
      ? await this.#requireSourceSnapshotForSource(
        source.id,
        internal.sourceSnapshotId,
      )
      : await this.#resolveLatestSnapshot(source.id, source.defaultRef);
    if (!snapshot) {
      // Typed 409: the Installation cannot plan until a SourceSnapshot exists
      // for its source. Callers run a source_sync first.
      throw new OpenTofuControllerError(
        "failed_precondition",
        `source_sync_required: installation ${installationId} has no ` +
          `SourceSnapshot for source ${source.id} ref ${source.defaultRef}; ` +
          `run a source sync first`,
      );
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
      : (installation.currentDeploymentId ? "update" : "create");
    const { request: planRequest, installTypePlan } = await this
      .#installationPlanRequest({
        installation,
        installConfig,
        source,
        snapshot,
        operation,
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
    // injected values, and merge them into the plan inputs (template) / variables
    // (raw module) BEFORE the run is created. The DependencySnapshot is pinned
    // AFTER the run row exists (runId known), then the planRun is re-put with its
    // id (order: resolve -> inject -> create plan -> snapshot -> re-put).
    const resolvedDeps = destroy
      ? undefined
      : await this.#resolveConsumerDependencies(installation);
    const injectedRequest = resolvedDeps
      ? this.#injectDependencyValues(planRequest, resolvedDeps.injectedValues)
      : planRequest;
    const response = await this.createPlanRun(injectedRequest, context, {
      installationContext,
      sourceSnapshotId: snapshot.id,
      baseStateGeneration,
      ...(installTypePlan ? { installTypePlan } : {}),
      ...(internal.runGroupId ? { runGroupId: internal.runGroupId } : {}),
    });
    if (!resolvedDeps || resolvedDeps.entries.length === 0) {
      return response;
    }
    // Pin the DependencySnapshot against the just-created run, record it, and
    // re-put the PlanRun carrying its id so the apply consumer re-reads + verifies
    // it (invariant 9). Return the updated PlanRun.
    return await this.#pinDependencySnapshot(response.planRun, resolvedDeps);
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
    const entries: DependencySnapshotEntry[] = [];
    for (const dependency of dependencies) {
      // MVP supports variable_injection only; the DependenciesService rejects
      // other modes at creation, but guard here too (a stored remote_state /
      // published_output edge cannot be honored yet).
      if (dependency.mode !== "variable_injection") {
        throw new OpenTofuControllerError(
          "not_implemented",
          `dependency ${dependency.id} mode ${dependency.mode} is not ` +
            `implemented (only variable_injection is supported)`,
        );
      }
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
      const outputSnapshot = producer.currentOutputSnapshotId
        ? await this.#store.getOutputSnapshot(producer.currentOutputSnapshotId)
        : undefined;
      const values: Record<string, JsonValue> = {};
      for (const mapping of Object.values(dependency.outputs)) {
        const available = outputSnapshot?.spaceOutputs ?? {};
        const present = Object.prototype.hasOwnProperty.call(
          available,
          mapping.from,
        );
        if (!present) {
          if (mapping.required) {
            throw new OpenTofuControllerError(
              "failed_precondition",
              `dependency_outputs_unavailable: dependency ${dependency.id} ` +
                `requires producer output ${mapping.from} which the producer ` +
                `installation ${producer.id} has not published`,
            );
          }
          // An optional mapping with no producer value contributes nothing.
          continue;
        }
        const value = available[mapping.from] as JsonValue;
        values[mapping.to] = value;
        injectedValues[mapping.to] = value;
      }
      // Pin the snapshot entry even when no producer output existed yet so the
      // apply-time tamper check has the full edge set; the values digest is over
      // exactly what was injected for this edge.
      const valuesDigest = await stableJsonDigest(values);
      entries.push({
        dependencyId: dependency.id,
        producerInstallationId: producer.id,
        producerStateGeneration: producer.currentStateGeneration,
        producerOutputSnapshotId: outputSnapshot?.id ?? "",
        producerOutputDigest: outputSnapshot?.outputDigest ?? "",
        valuesDigest,
        values,
      });
    }
    const mode: DependencySnapshotMode =
      consumer.environment.trim().toLowerCase() === "production"
        ? "strict"
        : "pinned";
    return { injectedValues, entries, mode };
  }

  /**
   * Merges the dependency-injected values into a plan request (spec §15). A
   * template-backed request (carries `templateId`) merges into `inputs` (only
   * keys the template would accept; `validateTemplateInputs` downstream rejects
   * unknown keys, so the injected `to` names MUST be declared template inputs —
   * a required mapping to an undeclared input surfaces as `failed_precondition`
   * via the template validator); a raw-module request merges into `variables`.
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
   * Returns the updated PlanRunResponse.
   */
  async #pinDependencySnapshot(
    planRun: PlanRun,
    resolved: ResolvedDependencies,
  ): Promise<PlanRunResponse> {
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
    return { planRun: updated };
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

  /**
   * Builds the {@link CreatePlanRunRequest} (+ install-type plan context) for an
   * installation-driven plan. The InstallConfig's installType selects the
   * OpenTofu surface (§10 / §13):
   *
   *   - `core` / `opentofu_module` / `app_source`: a template-bound config reuses
   *     the template plan path with an {@link InstallTypePlanContext} so the
   *     generated root comes from {@link generateInstallationRoot} (installType +
   *     per-capability provider aliases + the app_source build); the config's
   *     variableMapping supplies the template inputs and manual-mode capability
   *     values override them. A non-template `opentofu_module` / `app_source`
   *     config has no generated root to build yet and falls back to the raw path.
   *   - `opentofu_root`: the SourceSnapshot IS the root configuration — no
   *     generated root, no template (asserted) — exactly the raw-module path.
   */
  async #installationPlanRequest(input: {
    readonly installation: Installation;
    readonly installConfig: InstallConfig;
    readonly source: Source;
    readonly snapshot: SourceSnapshot;
    readonly operation: "create" | "update" | "destroy";
  }): Promise<{
    readonly request: CreatePlanRunRequest;
    readonly installTypePlan?: InstallTypePlanContext;
  }> {
    const moduleSource = snapshotModuleSource(input.source, input.snapshot);
    const installType = input.installConfig.installType;
    const templateBinding = installConfigTemplateBinding(input.installConfig);
    // opentofu_root: the SourceSnapshot IS the root configuration (no generated
    // root, no template). A templateBinding here is a config error — it would
    // silently generate a root over a config that asked for the raw root path.
    if (installType === "opentofu_root") {
      if (templateBinding) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `install config ${input.installConfig.id} is opentofu_root but ` +
            `carries a templateBinding; opentofu_root uses the SourceSnapshot ` +
            `as the root configuration directly (no generated root)`,
        );
      }
      return { request: await this.#rawModulePlanRequest(input, moduleSource) };
    }
    if (templateBinding) {
      // Template-backed config (core / opentofu_module / app_source): reuse the
      // template plan path. The config's variableMapping supplies the template
      // inputs (public, never secret); the user source archive is a build input
      // only. The install-type context drives the §13 generated root.
      const installTypePlan = await this.#resolveInstallTypePlan(
        input.installation,
        input.installConfig,
        installType,
      );
      return {
        request: {
          spaceId: input.installation.spaceId,
          installationId: input.installation.id,
          source: moduleSource,
          operation: input.operation,
          templateId: templateBinding.templateId,
          templateVersion: templateBinding.templateVersion,
          ...(templateBinding.inputs
            ? { inputs: templateBinding.inputs }
            : {}),
        },
        installTypePlan,
      };
    }
    // Non-template opentofu_module / app_source / core config: no catalog
    // template to generate a root from — fall back to the raw-module path with
    // the snapshot as the module source.
    return { request: await this.#rawModulePlanRequest(input, moduleSource) };
  }

  /**
   * Raw-module plan request: the snapshot is the OpenTofu module source (used by
   * opentofu_root and by template-less configs). The runner profile's allowed
   * providers are declared as the run's required providers so the create-time
   * policy gate (which requires providers before init) is satisfied; the runner
   * re-reports the providers it actually used.
   */
  async #rawModulePlanRequest(
    input: {
      readonly installation: Installation;
      readonly operation: "create" | "update" | "destroy";
    },
    moduleSource: OpenTofuModuleSource,
  ): Promise<CreatePlanRunRequest> {
    const profile = await this.#requireRunnerProfile(this.#defaultRunnerProfileId);
    return {
      spaceId: input.installation.spaceId,
      installationId: input.installation.id,
      source: moduleSource,
      operation: input.operation,
      runnerProfileId: profile.id,
      requiredProviders: [...profile.allowedProviders],
    };
  }

  /**
   * Derives the §13 install-type plan context for a template-bound installation
   * config: the generated-root install type, the per-capability provider aliases
   * (from the installation's resolved capabilities), the flattened manual-mode
   * values, and the build override. Capabilities resolve through the
   * {@link ConnectionsService} so binding changes take effect on the next plan.
   * `source` and `disabled` capabilities (and `manual`, which contributes values
   * not a provider) are skipped for the provider-alias derivation.
   */
  async #resolveInstallTypePlan(
    installation: Installation,
    installConfig: InstallConfig,
    installType: InstallType,
  ): Promise<InstallTypePlanContext> {
    this.#connectionsService ??= new ConnectionsService({ store: this.#store });
    const resolved = await this.#connectionsService.resolveCapabilities(
      installation,
    );
    const capabilityProviders = capabilityProvidersFromResolved(resolved);
    const manualValues = manualValuesFromResolved(resolved);
    return {
      // opentofu_root never reaches here (asserted in #installationPlanRequest);
      // core / opentofu_module / app_source map 1:1 to the generated-root types.
      installType: installType as GeneratedRootInstallType,
      capabilityProviders,
      manualValues,
      ...(installConfig.build?.enabled
        ? { build: installConfigBuildSpec(installConfig.build) }
        : {}),
    };
  }

  async getPlanRun(id: string): Promise<PlanRunResponse> {
    requireNonEmptyString(id, "planRunId");
    const planRun = await this.#store.getPlanRun(id);
    if (!planRun) {
      throw new OpenTofuControllerError("not_found", `plan run ${id} not found`);
    }
    return { planRun };
  }

  /**
   * Resolves a template-backed plan request into its resolved template, derived
   * required providers, generated root module, and optional build phase. Returns
   * `undefined` for raw-module plans. Throws on a malformed template request
   * (missing version, conflicting requiredProviders, unknown template, invalid
   * inputs).
   *
   * `installTypePlan` is present only for an installation-driven plan (§13). When
   * present the generated root comes from {@link generateInstallationRoot}
   * (installType-aware, per-capability provider aliases, the `app_source` build);
   * the manual-mode capability values are merged into the template inputs with
   * manual values overriding the InstallConfig variableMapping (§13 decision:
   * manual values are per-installation overrides). When absent (the raw
   * `/v1/plan-runs` template path, no installation context = no capabilities) the
   * generated root stays on {@link generateRootModule} byte-for-byte.
   */
  #resolveTemplatePlan(
    request: CreatePlanRunRequest,
    installTypePlan?: InstallTypePlanContext,
  ): ResolvedTemplatePlan | undefined {
    if (request.templateId === undefined) {
      // A bare inputs/templateVersion without templateId is a request error: it
      // would otherwise silently fall back to a raw-module plan that ignores them.
      if (request.templateVersion !== undefined || request.inputs !== undefined) {
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
    // Manual-mode capability values are per-installation overrides: they win on a
    // key collision with the InstallConfig variableMapping (which flows in via
    // request.inputs). Only keys the template DECLARES as inputs survive
    // validation (validateTemplateInputs rejects unknown keys), so an unknown
    // manual key would otherwise throw — filter to declared inputs for MVP and
    // ignore the rest (no DependencySnapshot/manual-value contract here yet).
    const mergedInputs = installTypePlan
      ? mergeManualInputs(template, request.inputs, installTypePlan.manualValues)
      : request.inputs;
    const inputs = validateTemplateInputs(template, mergedInputs);
    // Installation-driven (§13): installType-aware generated root with
    // per-capability provider aliases + the app_source artifact_path wiring.
    // Raw template path (no installation context): the byte-stable wrapper.
    const generatedRoot = installTypePlan
      ? generateInstallationRoot({
        template,
        inputs,
        installType: installTypePlan.installType,
        ...(installTypePlan.capabilityProviders.length > 0
          ? { capabilityProviders: installTypePlan.capabilityProviders }
          : {}),
      })
      : generateRootModule(template, inputs);
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
    await checkApplyExpected(request.expected, planRun);
    if (planRun.installationId) {
      await this.#requireCurrentPlannedInstallation(planRun);
    }
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
      ...(planRun.installationId ? { installationId: planRun.installationId } : {}),
      operation: planRun.operation,
      runnerProfileId: profile.id,
      status: "queued",
      ...(request.approval ? { approval: request.approval } : {}),
      expected: request.expected,
      stateBackend: profile.stateBackend,
      stateLock: stateLockEvidence(profile.stateBackend, now, now, "pending"),
      auditEvents: [
        auditEvent("apply", "apply.queued", now, {
          planRunId: planRun.id,
          runnerProfileId: profile.id,
        }, context.actor),
      ],
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.putApplyRun(applyRun);
    if (!this.#runner) return { applyRun };
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
    if (!this.#runner) return await this.#store.getPlanRun(runId);
    const planRun = await this.#store.getPlanRun(runId);
    if (!planRun) {
      throw new OpenTofuControllerError("not_found", `plan run ${runId} not found`);
    }
    if (!this.#shouldProcessRun(planRun.status, planRun.heartbeatAt)) {
      // Terminal, or a sibling consumer holds it with a fresh heartbeat: no-op.
      return planRun;
    }
    const profile = await this.#requireRunnerProfile(planRun.runnerProfileId);
    const inputs = await this.#store.getPlanRunInputs(runId);
    const variables = normalizeVariables(inputs?.variables);
    const dispatch = templateDispatchFromInputs(inputs);
    const running = await this.#markPlanRunning(planRun);
    const credentials = await this.#mintRunCredentials(planRun);
    const result = await this.#executePlan(
      running,
      profile,
      variables,
      credentials,
      dispatch,
    );
    // Retain the inputs sidecar for a SUCCEEDED template run: the apply consumer
    // re-reads the generated root / build / template ref to build the apply
    // dispatch payload (the same generated root the plan was reviewed against).
    // It is deleted once the plan is applied (apply-once) or the run is failed.
    // Raw-module runs and non-succeeded template plans drop the sidecar now.
    const retainForApply = result.status === "succeeded" &&
      dispatch.template !== undefined;
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
      throw new OpenTofuControllerError("not_found", `apply run ${runId} not found`);
    }
    if (!this.#runner) return { applyRun };
    if (!this.#shouldProcessRun(applyRun.status, applyRun.heartbeatAt)) {
      return await this.getApplyRun(runId);
    }
    const planRun = await this.#requirePlanRun(applyRun.planRunId);
    const profile = await this.#requireRunnerProfile(applyRun.runnerProfileId);
    // Template dispatch for apply: re-read the retained inputs sidecar so the
    // apply runs tofu in the SAME generated root the plan was reviewed against.
    const inputs = await this.#store.getPlanRunInputs(planRun.id);
    const dispatch = templateDispatchFromInputs(inputs);
    const key = planRun.installationId ?? planRun.id;
    // Installation lease (spec §22 / §23): when a DO-backed coordination seam is
    // wired, acquire the cross-isolate
    // `installation:{installationId}:{environment}` lease so only one write run
    // per (Installation, environment) executes at a time. A busy lease throws so
    // the queue redelivers. The in-process serialization stays as the inner
    // guard (single-isolate correctness).
    const runWork = () =>
      this.#runSerialized(
        key,
        () => this.#executeApply(applyRun, planRun, profile, dispatch),
      );
    if (this.#installationCoordination && planRun.installationId) {
      const environment = planRun.installationContext?.environment ??
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
   * Mints provider credentials for a run when a Vault is configured. Returns
   * `undefined` (and dispatches with no credential override, leaving the runner
   * to fall back to its own env) when no Vault is wired. Never logs the bundle.
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
    const snapshot = await this.#store.getSourceSnapshot(planRun.sourceSnapshotId);
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
    const sourceArchive: DispatchSourceArchive = {
      objectKey: snapshot.archiveObjectKey,
      digest: snapshot.archiveDigest,
    };
    return { stateScope, sourceArchive };
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
    const snapshot = await this.#store.getSourceSnapshot(planRun.sourceSnapshotId);
    if (!snapshot) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `source_snapshot_missing: plan run ${planRun.id} references ` +
          `SourceSnapshot ${planRun.sourceSnapshotId} which is no longer present`,
      );
    }
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
      // pinned digest. A re-put that mutated the frozen values trips this.
      const recomputed = await stableJsonDigest(entry.values);
      if (recomputed !== entry.valuesDigest) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `dependency_snapshot_tampered: plan run ${planRun.id} dependency ` +
            `${entry.dependencyId} pinned values no longer match the pinned digest`,
        );
      }
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
   *   - `spaceOutputs` = EVERY non-sensitive output from the raw runner envelope
   *     (name -> value), the same-Space dependency-consumption surface.
   *   - `publicOutputs` = the existing public projection already computed for
   *     `Deployment.outputsPublic` (well-known / template-allowlisted + secret
   *     filter), the UI / display surface.
   *   - Sensitive-flagged outputs appear in NEITHER (invariants 11/12).
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
    readonly stateGeneration: number;
    readonly now: number;
  }): Promise<OutputSnapshot> {
    const spaceOutputs = spaceOutputsFromOpenTofu(input.result.outputs);
    const publicOutputs = Object.fromEntries(
      input.publicOutputs.map((output) => [output.name, output.value]),
    );
    const outputDigest = await stableJsonDigest({ spaceOutputs, publicOutputs });
    const snapshot: OutputSnapshot = {
      id: this.#newId("out"),
      spaceId: input.installation.spaceId,
      installationId: input.installation.id,
      stateGeneration: input.stateGeneration,
      rawOutputArtifactKey: input.result.rawOutputsKey ??
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
   * `active` consumers are moved: `installing` / `error` / `destroyed` are left
   * untouched (a stale flag on a not-yet-applied or torn-down Installation is
   * meaningless). No-ops when the digest is unchanged, or when there are no
   * downstream consumers. Each patch carries no guard: stale is an advisory flag,
   * not a state-generation move, so it never races the currentDeployment pointer.
   */
  async #propagateStale(input: {
    readonly installation: Installation;
    readonly previousDigest: string | undefined;
    readonly newDigest: string;
    readonly now: number;
  }): Promise<void> {
    if (input.previousDigest === input.newDigest) return;
    const edges = await this.#store.listDependenciesBySpace(
      input.installation.spaceId,
    );
    if (edges.length === 0) return;
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
      await this.#recordActivity({
        spaceId: consumer.spaceId,
        action: "installation.stale",
        targetType: "installation",
        targetId: consumer.id,
        metadata: { producerInstallationId: input.installation.id },
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
      console.warn(
        `[takosumi-service] controller activity record failed ` +
          `(action=${event.action}): ${String(error)}`,
      );
    }
  }

  async #mintRunCredentials(
    planRun: PlanRun,
  ): Promise<RunCredentials | undefined> {
    if (!this.#vault || planRun.requiredProviders.length === 0) {
      return undefined;
    }
    try {
      const connectionIds = await this.#capabilityConnectionIds(planRun);
      const bundle = await this.#vault.mint(
        planRun.spaceId,
        planRun.requiredProviders,
        connectionIds !== undefined ? { connectionIds } : undefined,
      );
      return bundle.env;
    } catch (error) {
      throw mapVaultError(error);
    }
  }

  /**
   * Capability-resolved connection pool for an installation-driven run
   * (spec §9). Resolution happens at mint time so binding changes take effect
   * on the next run. Returns `undefined` (legacy space-wide pool) for runs
   * without installation context, or while the installation has neither
   * bindings nor operator defaults — the capability wiring becomes
   * authoritative with the install types (conformance M5).
   */
  async #capabilityConnectionIds(
    planRun: PlanRun,
  ): Promise<readonly string[] | undefined> {
    const ctx = planRun.installationContext;
    if (!ctx) return undefined;
    const installation = await this.#store.getInstallation(ctx.installationId);
    if (!installation) return undefined;
    this.#connectionsService ??= new ConnectionsService({
      store: this.#store,
    });
    const resolved = await this.#connectionsService.resolveCapabilities(
      installation,
    );
    const ids = mintableConnectionIds(resolved);
    return ids.length > 0 ? ids : undefined;
  }

  async getApplyRun(id: string): Promise<ApplyRunResponse> {
    requireNonEmptyString(id, "applyRunId");
    const applyRun = await this.#store.getApplyRun(id);
    if (!applyRun) {
      throw new OpenTofuControllerError("not_found", `apply run ${id} not found`);
    }
    const installation = applyRun.installationId
      ? await this.#store.getInstallation(applyRun.installationId)
      : undefined;
    const deployment = applyRun.deploymentId
      ? await this.#store.getDeployment(applyRun.deploymentId)
      : undefined;
    return {
      applyRun,
      ...(installation ? { installation } : {}),
      ...(deployment ? { deployment } : {}),
    };
  }

  async getInstallation(id: string): Promise<GetInstallationResponse> {
    return { installation: await this.#requireInstallation(id) };
  }

  async listDeployments(
    installationId: string,
  ): Promise<ListDeploymentsResponse> {
    await this.#requireInstallation(installationId);
    return {
      deployments: await this.#store.listDeployments(installationId),
    };
  }

  async listDeploymentOutputs(
    installationId: string,
  ): Promise<ListDeploymentOutputsResponse> {
    const installation = await this.#requireInstallation(installationId);
    if (!installation.currentDeploymentId) return { outputs: [] };
    const deployment = await this.#store.getDeployment(
      installation.currentDeploymentId,
    );
    const outputsPublic = deployment?.outputsPublic ?? {};
    return {
      outputs: Object.entries(outputsPublic).map(([name, value]) => ({
        name,
        kind: name,
        value: value as JsonValue,
        sensitive: false,
      })),
    };
  }

  /**
   * Reads a single Deployment ledger record (spec §21 / §30 `GET
   * /api/deployments/:id`). A missing id is a typed 404.
   */
  async getDeployment(id: string): Promise<Deployment> {
    requireNonEmptyString(id, "deploymentId");
    const deployment = await this.#store.getDeployment(id);
    if (!deployment) {
      throw new OpenTofuControllerError(
        "not_found",
        `deployment ${id} not found`,
      );
    }
    return deployment;
  }

  /**
   * Creates a rollback PLAN run for a Deployment (spec §30 `POST
   * /api/deployments/:id/rollback-plan`): re-plans the Deployment's Installation
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
    const vault = this.#requireVault();
    try {
      const connection = await vault.register(request);
      return { connection };
    } catch (error) {
      throw mapVaultError(error);
    }
  }

  async listConnections(spaceId: string): Promise<ListConnectionsResponse> {
    requireNonEmptyString(spaceId, "spaceId");
    return { connections: await this.#store.listConnections(spaceId) };
  }

  /**
   * Lists instance-wide `operator`-scoped Connections (spec §30 `GET
   * /api/connections` with `?spaceId` omitted). Never includes secret values.
   */
  async listOperatorConnections(): Promise<ListConnectionsResponse> {
    return { connections: await this.#store.listOperatorConnections() };
  }

  async getConnection(connectionId: string): Promise<Connection> {
    requireNonEmptyString(connectionId, "connectionId");
    const connection = await this.#store.getConnection(connectionId);
    if (!connection) {
      throw new OpenTofuControllerError(
        "not_found",
        `connection ${connectionId} not found`,
      );
    }
    return connection;
  }

  async testConnection(
    connectionId: string,
  ): Promise<TestConnectionResponse> {
    const vault = this.#requireVault();
    requireNonEmptyString(connectionId, "connectionId");
    try {
      return await vault.test(connectionId);
    } catch (error) {
      throw mapVaultError(error);
    }
  }

  async deleteConnection(connectionId: string): Promise<boolean> {
    const vault = this.#requireVault();
    requireNonEmptyString(connectionId, "connectionId");
    try {
      return await vault.revoke(connectionId);
    } catch (error) {
      throw mapVaultError(error);
    }
  }

  /**
   * Mints a credential bundle for a space + providers. Exposed for Phase 1B
   * dispatch; NOT wired into plan/apply here. Returns an opaque
   * {@link CredentialBundle} that never serializes its values.
   */
  async mintCredentialBundle(
    spaceId: string,
    providers: readonly string[],
  ): Promise<CredentialBundle> {
    const vault = this.#requireVault();
    try {
      return await vault.mint(spaceId, providers);
    } catch (error) {
      throw mapVaultError(error);
    }
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
    return await this.#requireSources().createSource(request);
  }

  async listSources(spaceId: string): Promise<ListSourcesResponse> {
    return await this.#requireSources().listSources(spaceId);
  }

  async getSource(id: string): Promise<SourceResponse> {
    return await this.#requireSources().getSource(id);
  }

  async patchSource(
    id: string,
    patch: PatchSourceRequest,
  ): Promise<SourceResponse> {
    return await this.#requireSources().patchSource(id, patch);
  }

  async createSourceSync(
    sourceId: string,
    options: { readonly dedupe?: boolean } = {},
  ): Promise<CreateSourceSyncResponse> {
    return await this.#requireSources().createSync(sourceId, options);
  }

  async listSourceSnapshots(
    sourceId: string,
  ): Promise<ListSourceSnapshotsResponse> {
    return await this.#requireSources().listSnapshots(sourceId);
  }

  async getSourceSyncRun(id: string): Promise<SourceSyncRun> {
    return await this.#requireSources().getSyncRun(id);
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
      return projectApplyRun(applyRun, plan ? this.#installationProjection(plan) : {});
    }
    const sync = await this.#store.getSourceSyncRun(id);
    if (sync) return projectSourceSyncRun(sync);
    throw new OpenTofuControllerError("not_found", `run ${id} not found`);
  }

  /**
   * Reads the run-level diagnostics + audit trail for a Run (spec §30 `GET
   * /api/runs/:runId/logs`). Diagnostics + audit events are recorded on the
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
   * /api/runs/:runId/events`). MVP: the run-level audit events only.
   */
  async getRunEvents(id: string): Promise<RunEventsResponse> {
    requireNonEmptyString(id, "runId");
    const record = await this.#requireRunRecordWithLogs(id);
    return { auditEvents: record.auditEvents };
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
    throw new OpenTofuControllerError("not_found", `run ${id} not found`);
  }

  /**
   * Projects a PlanRun's recorded installation context + source snapshot onto
   * the §19 Run projection options. Empty for runs without installation
   * context.
   */
  #installationProjection(
    planRun: PlanRun,
  ): {
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
        (await this.#store.getSourceSyncRun(id))
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
        auditEvent(planRun.id, "plan.approved", now, {
          ...(input.approvedBy ? { approvedBy: input.approvedBy } : {}),
        }, input.approvedBy),
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
    return await this.#requireSources().listAutoSyncSources(limit);
  }

  async verifySourceHookSecret(
    sourceId: string,
    presentedSecret: string,
  ): Promise<boolean> {
    return await this.#requireSources().verifyHookSecret(
      sourceId,
      presentedSecret,
    );
  }

  #requireSources(): SourcesService {
    if (!this.#sourcesService) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "sources service is not configured",
      );
    }
    return this.#sourcesService;
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
      stateLock: stateLockEvidence(profile.stateBackend, startedAt, startedAt, "pending"),
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
      stateLock: stateLockEvidence(profile.stateBackend, startedAt, now, "recorded"),
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
      const result = await this.#runner!.plan({
        planRun: running,
        runnerProfile: profile,
        variables,
        // Template dispatch (Phase 1C): the runner runs tofu in the generated
        // root against the baked-in template module. Empty for raw-module runs.
        ...(dispatch.template ? { template: dispatch.template } : {}),
        ...(dispatch.generatedRoot ? { generatedRoot: dispatch.generatedRoot } : {}),
        ...(dispatch.build ? { build: dispatch.build } : {}),
        // M2 env dispatch (state scope + source archive). Absent without env ctx.
        ...(envDispatch.stateScope ? { stateScope: envDispatch.stateScope } : {}),
        ...(envDispatch.sourceArchive
          ? { sourceArchive: envDispatch.sourceArchive }
          : {}),
        // Dispatch-only: the minted env never lands on the persisted run.
        ...(credentials ? { credentials } : {}),
      });
      const now = this.#now();
      const diagnostics = redactRunDiagnostics(result.diagnostics);
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
        ...(this.#planAllowsNoProviders(running) ? { allowNoProviders: true } : {}),
      });
      // Layered plan-JSON policy (§25). When the runner returned resource
      // changes, evaluate the resource-type allowlist (layer 5) and the action
      // policy (layer 7) over them for ALL runs — not only template-backed:
      //   - template-backed runs use the recorded template.policy (tamper-safe);
      //   - non-template installation-context runs use the Installation's
      //     InstallConfig.policy (resolved via installConfigId);
      //   - raw `/v1/plan-runs` runs without installation context keep today's
      //     behavior (no allowlist source -> no resource enforcement).
      // A disallowed resource type DENIES the plan; a delete/replace marks it
      // requiresApproval (parked waiting_approval until approved). The template
      // destructive-confirmation gate (requiresConfirmation) additionally needs
      // confirmDestructive at apply.
      const layered = await this.#evaluatePlanPolicy(running, result);
      const blockedByResources = layered.resource?.reasons ?? [];
      const passedPolicy = policy.status === "passed" &&
        blockedByResources.length === 0;
      const policyDecisionDigest = await stableJsonDigest(policy);
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
      // §25 action policy: any delete/replace requires approval before apply.
      // Recorded so the §19 Run projection parks the succeeded plan
      // `waiting_approval`. Destroy plans are always-approval independently
      // (#planAwaitsApproval), so they need no field.
      const requiresApproval = layered.action?.requiresApproval === true;
      const updated: PlanRun = {
        ...running,
        status: passedPolicy ? "succeeded" : "blocked",
        requiredProviders,
        policy: passedPolicy
          ? policy
          : {
            status: "blocked",
            reasons: [...policy.reasons, ...blockedByResources],
            checkedAt: now,
          },
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
            ...(layered.resource
              ? { resourceTypesAllowed: blockedByResources.length === 0 }
              : {}),
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
      await this.#store.putPlanRun(updated);
      return updated;
    } catch (error) {
      return await this.#failPlanRun(running, error);
    }
  }

  /**
   * Evaluates the layered plan-JSON policy (§25 layers 5 + 7) over the runner's
   * resource changes for ANY run that returned them:
   *   - `resource`: the resource-type allowlist verdict. The allowlist source is
   *     the recorded template.policy (template-backed runs, tamper-safe) or the
   *     Installation's InstallConfig.policy.allowedResourceTypes (non-template
   *     installation-context runs). A raw `/v1/plan-runs` run without
   *     installation context has no allowlist source -> no resource enforcement.
   *   - `action`: the §25 action policy (delete/replace requires approval).
   *   - `templatePolicy`: the template destructive-confirmation verdict (only
   *     for template-backed runs) used to fold `requiresConfirmation` onto the
   *     binding.
   * Returns empty (`undefined` fields) when the runner reported no resource
   * changes. Quota / scope-boundary (§25 layers 6 / 10) stay post-MVP; the typed
   * seams are on {@link composePolicyVerdict}.
   */
  async #evaluatePlanPolicy(
    planRun: PlanRun,
    result: OpenTofuPlanResult,
  ): Promise<{
    resource?: ResourceAllowlistResult;
    action?: ActionPolicyResult;
    templatePolicy?: ReturnType<typeof evaluateTemplatePlanPolicy>;
  }> {
    const changes = result.planResourceChanges;
    if (changes === undefined) return {};
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
      return { resource, action, templatePolicy };
    }
    // Non-template installation-context run: enforce the InstallConfig.policy
    // resource-type allowlist. An undefined allowlist (or a run without
    // installation context) means "not configured" -> no resource enforcement.
    const allowedResourceTypes = await this.#installConfigResourceAllowlist(
      planRun,
    );
    const resource = evaluateResourceAllowlist(changes, allowedResourceTypes);
    return { resource, action };
  }

  /**
   * Resolves the resource-type allowlist for a non-template installation-context
   * plan from its Installation's InstallConfig.policy. Returns `undefined` (the
   * resource layer is skipped) for runs without installation context, or when
   * the Installation / config / allowlist is absent.
   */
  async #installConfigResourceAllowlist(
    planRun: PlanRun,
  ): Promise<readonly string[] | undefined> {
    const installationId = planRun.installationContext?.installationId ??
      planRun.installationId;
    if (!installationId) return undefined;
    const installation = await this.#store.getInstallation(installationId);
    if (!installation) return undefined;
    const installConfig = await this.#store.getInstallConfig(
      installation.installConfigId,
    );
    return installConfig?.policy.allowedResourceTypes;
  }

  /**
   * Whether a plan run targets a provider-free §10 install (a template whose
   * policy declares zero allowed providers, e.g. `core`). Such a run is allowed
   * to declare/observe zero providers without tripping the profile's
   * "requiredProviders before init" gate. Resolved from the recorded binding;
   * raw-module runs are never provider-free here.
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
    const startedAt = this.#now();
    const running = await this.#markApplyRunning(applyRun, profile, startedAt);
    // Mint provider credentials NOW (just before dispatch). Apply runs resolve
    // requiredProviders from the reviewed PlanRun. The bundle is attached to the
    // runner dispatch ONLY — never stored, never logged.
    const credentials = await this.#mintRunCredentials(planRun);
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
    // M2 env dispatch: an apply persists state at `base + 1` (the DO writes the
    // new state object + current.json at this generation). Empty without env ctx.
    const persistGeneration = (planRun.baseStateGeneration ?? 0) + 1;
    const envDispatch = await this.#installationDispatch(planRun, persistGeneration);
    try {
      const result = await this.#runner!.apply({
        applyRun: running,
        planRun,
        planArtifact: planRun.planArtifact,
        runnerProfile: profile,
        // Template dispatch (Phase 1C): apply tofu in the generated root.
        ...(dispatch.template ? { template: dispatch.template } : {}),
        ...(dispatch.generatedRoot ? { generatedRoot: dispatch.generatedRoot } : {}),
        ...(dispatch.build ? { build: dispatch.build } : {}),
        // M2 env dispatch (state scope at base+1 + source archive).
        ...(envDispatch.stateScope ? { stateScope: envDispatch.stateScope } : {}),
        ...(envDispatch.sourceArchive
          ? { sourceArchive: envDispatch.sourceArchive }
          : {}),
        ...(credentials ? { credentials } : {}),
      });
      const now = this.#now();
      // Output allowlist: a template run projects ONLY the template's public
      // outputs (mapped from their `from` module-output names) after the existing
      // sensitive/redaction filter. Raw-module runs keep the well-known
      // projection.
      const outputs = this.#projectApplyOutputs(planRun, result);
      const installation = plannedInstallation ??
        await this.#requireCurrentPlannedInstallation(planRun);
      // Bump the state generation atomically with the state persist (the
      // currentDeployment pointer move). A create starts at base 0 -> 1; an
      // update advances the installation's generation by one.
      const nextStateGeneration = installation.currentStateGeneration + 1;
      // §16 OutputSnapshot: capture the projected outputs after a successful
      // apply. `spaceOutputs` is every non-sensitive output from the raw runner
      // envelope; `publicOutputs` is the existing public projection (what
      // Deployment.outputsPublic carries). Sensitive-flagged outputs appear in
      // NEITHER (invariants 11/12); the raw envelope stays an encrypted artifact
      // referenced by rawOutputArtifactKey. The Installation's PREVIOUS snapshot
      // digest drives stale propagation (§24) after this record.
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
        stateGeneration: nextStateGeneration,
        now,
      });
      const deployment: Deployment = {
        id: this.#newId("dep"),
        spaceId: planRun.spaceId,
        installationId: installation.id,
        environment: installation.environment,
        applyRunId: applyRun.id,
        ...(planRun.sourceSnapshotId
          ? { sourceSnapshotId: planRun.sourceSnapshotId }
          : {}),
        ...(planRun.dependencySnapshotId
          ? { dependencySnapshotId: planRun.dependencySnapshotId }
          : {}),
        stateGeneration: nextStateGeneration,
        outputSnapshotId: outputSnapshot.id,
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
          await this.#store.putDeployment({ ...previous, status: "superseded" });
        }
      }
      // Record the StateSnapshot metadata aligned to the SAME generation
      // written to R2_STATE (persistGeneration). The DO wrote the encrypted
      // object + current.json at this key; only metadata enters the ledger.
      // Recorded BEFORE the installation generation bump so the two advance
      // together.
      await this.#recordStateSnapshot({
        planRun,
        envDispatch,
        generation: persistGeneration,
        stateDigest: result.stateDigest,
        runId: applyRun.id,
        now,
      });
      const patched = await this.#store.patchInstallation(installation.id, {
        currentDeploymentId: deployment.id,
        status: "active",
        updatedAt: new Date(now).toISOString(),
        currentStateGeneration: nextStateGeneration,
        currentOutputSnapshotId: outputSnapshot.id,
      }, {
        currentDeploymentId: planRun.installationCurrentDeploymentId ?? undefined,
        status: plannedInstallation?.status,
      });
      // §24 stale propagation: when this apply's projected outputs changed
      // versus the Installation's PREVIOUS OutputSnapshot, every transitive
      // downstream consumer in the Space that is currently `active` is marked
      // `stale`. The just-applied Installation itself stays `active` (patched
      // above); installing/error/destroyed consumers are left untouched.
      await this.#propagateStale({
        installation,
        previousDigest: previousOutputSnapshot?.outputDigest,
        newDigest: outputSnapshot.outputDigest,
        now,
      });
      const diagnostics = redactRunDiagnostics(result.diagnostics);
      const completed: ApplyRun = {
        ...running,
        installationId: installation.id,
        deploymentId: deployment.id,
        status: "succeeded",
        stateLock: result.stateLock ??
          stateLockEvidence(profile.stateBackend, startedAt, now, "recorded"),
        outputs,
        ...(diagnostics ? { diagnostics } : {}),
        auditEvents: [
          ...running.auditEvents,
          auditEvent(applyRun.id, "apply.completed", now, {
            deploymentId: deployment.id,
            outputCount: outputs.length,
          }),
        ],
        updatedAt: now,
        finishedAt: now,
      };
      await this.#store.putApplyRun(completed);
      // Mark the PlanRun applied so it cannot be applied again (apply-once).
      await this.#store.putPlanRun({
        ...planRun,
        appliedApplyRunId: applyRun.id,
        updatedAt: now,
      });
      // The retained template inputs sidecar is no longer needed once applied.
      if (dispatch.template) {
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
          stateGeneration: nextStateGeneration,
          outputCount: outputs.length,
        },
      });
      return {
        applyRun: completed,
        installation: patched ?? installation,
        deployment,
      };
    } catch (error) {
      const failed = await this.#failApplyRun(
        running,
        profile,
        startedAt,
        "apply.failed",
        error,
      );
      return { applyRun: failed };
    }
  }

  /**
   * Projects the public DeploymentOutputs for an apply result. Template runs are
   * restricted to the template's allowlisted public outputs (resolved from the
   * recorded binding); raw-module runs use the well-known output projection.
   * Both run AFTER the sensitive/redaction filter in `projection.ts`.
   */
  #projectApplyOutputs(
    planRun: PlanRun,
    result: OpenTofuApplyResult,
  ): readonly DeploymentOutput[] {
    const binding = planRun.templateBinding;
    if (!binding) return normalizeDeploymentOutputs(result.outputs);
    const template = this.#templateRegistry.require(
      binding.templateId,
      binding.templateVersion,
    );
    return projectTemplatePublicOutputs(template, result.outputs);
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
    const installation = plannedInstallation ??
      await this.#requireCurrentPlannedInstallation(planRun);
    // A destroy_apply persists the post-teardown state at `base + 1`. Empty for
    // runs without installation context.
    const persistGeneration = (planRun.baseStateGeneration ?? 0) + 1;
    const envDispatch = await this.#installationDispatch(planRun, persistGeneration);
    try {
      if (typeof this.#runner!.destroy !== "function") {
        // Without a real teardown the Installation must NOT be marked
        // destroyed: doing so would record a successful destroy in the ledger
        // while the underlying cloud resources keep running (silent leak).
        throw new OpenTofuControllerError(
          "failed_precondition",
          "runner does not implement destroy; refusing to mark installation destroyed without teardown",
        );
      }
      const result = await this.#runner!.destroy({
        applyRun: running,
        planRun,
        planArtifact: planRun.planArtifact,
        installation,
        runnerProfile: profile,
        // Template dispatch (Phase 1C): destroy tofu in the generated root.
        ...(dispatch.template ? { template: dispatch.template } : {}),
        ...(dispatch.generatedRoot ? { generatedRoot: dispatch.generatedRoot } : {}),
        ...(dispatch.build ? { build: dispatch.build } : {}),
        // M2 env dispatch (state scope at base+1 + source archive).
        ...(envDispatch.stateScope ? { stateScope: envDispatch.stateScope } : {}),
        ...(envDispatch.sourceArchive
          ? { sourceArchive: envDispatch.sourceArchive }
          : {}),
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
      const patched = await this.#store.patchInstallation(installation.id, {
        currentDeploymentId: undefined,
        status: "destroyed",
        updatedAt: new Date(now).toISOString(),
        currentStateGeneration: nextStateGeneration,
      }, {
        currentDeploymentId: planRun.installationCurrentDeploymentId ?? undefined,
        status: installation.status,
      });
      const diagnostics = redactRunDiagnostics(result?.diagnostics);
      const completed: ApplyRun = {
        ...running,
        status: "succeeded",
        stateLock: stateLockEvidence(profile.stateBackend, startedAt, now, "recorded"),
        ...(diagnostics ? { diagnostics } : {}),
        auditEvents: [
          ...running.auditEvents,
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
      // Mark the PlanRun applied so a destroy plan cannot be re-applied.
      await this.#store.putPlanRun({
        ...planRun,
        appliedApplyRunId: running.id,
        updatedAt: now,
      });
      if (dispatch.template) {
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
      return { applyRun: completed, installation: patched ?? installation };
    } catch (error) {
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
      return { applyRun: failed, installation };
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
      throw new OpenTofuControllerError("not_found", `plan run ${id} not found`);
    }
    return planRun;
  }

  async #requireInstallation(id: string): Promise<Installation> {
    requireNonEmptyString(id, "installationId");
    const installation = await this.#store.getInstallation(id);
    if (!installation) {
      throw new OpenTofuControllerError(
        "not_found",
        `installation ${id} not found`,
      );
    }
    return installation;
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
    const installation = await this.#requireInstallation(planRun.installationId);
    validatePlannedInstallationCurrent({ planRun, installation });
    return installation;
  }

  async #seedRunnerProfiles(
    profiles: readonly RunnerProfile[],
  ): Promise<void> {
    for (const profile of profiles) {
      await this.#store.putRunnerProfile(profile);
    }
  }

  #runSerialized<T>(
    key: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#mutationChains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => next, () => next);
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

export function applyExpectedGuardFromPlanRun(planRun: PlanRun): ApplyExpectedGuard {
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
    ...(planRun.installationId ? { installationId: planRun.installationId } : {}),
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
 * binding (an opentofu_module / opentofu_root config that is not
 * template-backed).
 */
function installConfigTemplateBinding(
  config: InstallConfig,
):
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

/**
 * §13 capability kinds the generated root emits provider aliases for. The
 * `source` capability is a git credential (mapped only at the source phase, not
 * a provider in the generated root) so it has no rootgen CapabilityKind.
 */
const PROVIDER_CAPABILITY_KINDS = {
  compute: "compute",
  dns: "dns",
  storage: "storage",
  database: "database",
  secrets: "secrets",
} as const satisfies Readonly<Record<string, CapabilityKind>>;

/**
 * Derives the §13 per-capability provider mapping from an installation's
 * resolved capabilities: one {@link CapabilityProvider} per capability that
 * resolved to a Connection (mode `connection` or `default` with an operator
 * default) and carries a provider. `source` (git credential, not a provider),
 * `disabled`, and `manual` (values, not a provider) contribute no alias.
 */
function capabilityProvidersFromResolved(
  resolved: readonly ResolvedCapability[],
): readonly CapabilityProvider[] {
  const providers: CapabilityProvider[] = [];
  for (const entry of resolved) {
    const kind = PROVIDER_CAPABILITY_KINDS[
      entry.capability as keyof typeof PROVIDER_CAPABILITY_KINDS
    ];
    if (!kind) continue;
    const provider = entry.connection?.provider;
    if (!provider) continue;
    providers.push({ capability: kind, provider });
  }
  return providers;
}

/**
 * Flattens an installation's manual-mode capability values into module input
 * overrides (§13 decision). Manual values are per-installation overrides; only
 * JSON-scalar values flow through (the template input validator rejects unknown
 * keys downstream, and rootgen renders scalars only). Later capabilities win on
 * a key collision (deterministic by the fixed CAPABILITIES order).
 */
function manualValuesFromResolved(
  resolved: readonly ResolvedCapability[],
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
 * Merges the manual-mode capability values OVER the InstallConfig variableMapping
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
    // Only keys the template declares as inputs are merged; unknown manual keys
    // are ignored for MVP (no DependencySnapshot / typed manual-value contract
    // yet), avoiding a validateTemplateInputs "unknown input" rejection.
    if (key in template.inputs) manualForTemplate[key] = value;
  }
  if (
    (!configInputs || Object.keys(configInputs).length === 0) &&
    Object.keys(manualForTemplate).length === 0
  ) {
    return configInputs;
  }
  return { ...(configInputs ?? {}), ...manualForTemplate };
}

function isJsonScalar(value: unknown): value is string | number | boolean {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean";
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
  return `spaces/${seg(scope.spaceId)}/installations/${
    seg(scope.installationId)
  }/envs/${seg(scope.environment)}/states/${generation}.tfstate.enc`;
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
  return `spaces/${seg(input.spaceId)}/installations/${
    seg(input.installationId)
  }/runs/${seg(input.runId)}/outputs.raw.json.enc`;
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
  const trimmed = path.replace(/^\.\/+/, "").replace(/^\/+|\/+$/g, "").trim();
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
 * Canonicalizes a provider rule to a fully-qualified OpenTofu registry address.
 * A bare `namespace/type` (the OpenTofu source form templates declare) is
 * prefixed with the default registry host; an already-qualified address (3+
 * segments) is returned unchanged.
 */
function canonicalProviderAddress(rule: string): string {
  const segments = rule.split("/").filter((part) => part.length > 0);
  if (segments.length === 2) return `registry.opentofu.org/${rule}`;
  return rule;
}

/**
 * Reads the template dispatch fields off the persisted plan-run-inputs sidecar.
 * Returns an empty dispatch for raw-module runs. Defensive copies are not needed
 * because the store hands back its own records and the runner job only reads.
 */
function templateDispatchFromInputs(
  inputs: { readonly template?: DispatchTemplateRef; readonly generatedRoot?: DispatchGeneratedRoot; readonly build?: DispatchBuildSpec } | undefined,
): RunTemplateDispatch {
  if (!inputs?.template) return {};
  return {
    template: inputs.template,
    ...(inputs.generatedRoot ? { generatedRoot: inputs.generatedRoot } : {}),
    ...(inputs.build ? { build: inputs.build } : {}),
  };
}

/**
 * Folds the template plan-JSON policy verdict into the recorded template
 * binding, setting `requiresConfirmation`. Returns `undefined` (binding unchanged
 * / absent) for raw-module runs or when there is no policy verdict yet.
 */
function updatedTemplateBinding(
  planRun: PlanRun,
  templatePolicy: ReturnType<typeof evaluateTemplatePlanPolicy> | undefined,
): PlanRunTemplateBinding | undefined {
  const binding = planRun.templateBinding;
  if (!binding) return undefined;
  if (!templatePolicy) return binding;
  return { ...binding, requiresConfirmation: templatePolicy.requiresConfirmation };
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
  return status === "succeeded" || status === "failed" ||
    status === "blocked" || status === "cancelled";
}

// Translate a Vault error into the controller error vocabulary. Missing env
// groups (no values) are appended to the message so callers can fix their
// registration without the Vault ever exposing secret material.
function mapVaultError(error: unknown): unknown {
  if (!(error instanceof ConnectionVaultError)) return error;
  const groups = error.missingEnvGroups;
  const suffix = groups && groups.length > 0
    ? `: provide one of [${groups.map((group) => group.join("+")).join(", ")}]`
    : "";
  return new OpenTofuControllerError(error.code, `${error.message}${suffix}`);
}
