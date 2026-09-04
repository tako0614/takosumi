/**
 * Run / Capsule-lifecycle orchestration engine (P3 god-file split).
 *
 * Extracted verbatim from `../mod.ts`'s `OpenTofuController`. The
 * controller constructs exactly ONE `RunEngine`, passing the shared stores,
 * sibling collaborators, clock / id generators, and — critically — the SINGLE
 * `#runSerialized` mutex owner as a `runSerialized` port (there is still only
 * one serialization queue, owned by the controller). All Run + Capsule
 * plan + apply + restore orchestration lives here; the controller delegates its
 * public run methods to this engine and keeps the query / billing / connection /
 * source surfaces. Method bodies are moved byte-for-byte.
 */
import {
  planScopeSelectors,
  type JsonValue,
} from "takosumi-contract";
import type {
  ApplyRun,
  ApplyExpectedGuard,
  ApplyRunResponse,
  CreateApplyRunRequest,
  CreatePlanRunRequest,
  DispatchGeneratedRoot,
  DispatchRuntimeInputs,
  InstallConfig,
  Capsule,
  OpenTofuExecutionSource,
  OpenTofuModuleSource,
  PlanRun,
  PlanRunCapsuleContext,
  PlanRunResponse,
  PolicyConfig,
  PolicyDecision,
  ProviderConnection,
  RunDiagnostic,
  RunStatus,
  RunnerProfile,
  RunnerSecretExposurePolicy,
} from "@takosumi/internal/deploy-control-api";
import type { CreateRestoreRequest } from "takosumi-contract/backups";
import type {
  CapsuleCompatibilityReport,
  CapsuleProviderRequirement,
  CapsuleRootProviderRequirement,
} from "takosumi-contract/capsules";
import { normalizeCompatibilityReportModulePath } from "takosumi-contract/capsules";
import { usesDeclaredEnvCredentialRecipe } from "takosumi-contract/connections";
import { providerVersionMeetsRuntimeInputFloor } from "takosumi-contract/credential-recipes";
import { isOpenTofuBuiltinProviderSource } from "takosumi-contract/provider-env-rules";
import type {
  Dependency,
  DependencySnapshot,
} from "takosumi-contract/dependencies";
import {
  CAPSULE_LIFECYCLE_ACTION_FAILED_ERROR_CODE,
  type InstallConfigLifecycleAction,
  type InstallConfigLifecycleCommandAction,
  type InstallConfigLifecyclePhase,
  type OutputAllowlistEntry,
} from "takosumi-contract/install-configs";
import type { Output } from "takosumi-contract/outputs";
import type { StateVersion } from "takosumi-contract/state-versions";
import type { Run } from "takosumi-contract/runs";
import type {
  Source,
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";
import {
  containsSecretLikeString,
  isSecretKey,
  redactString,
} from "takosumi-contract/redaction";
import { downstreamClosure } from "takosumi-graph";
import {
  evaluateActionPolicy,
  evaluateQuotaPolicy,
  evaluateResourceAllowlist,
  evaluateScopeBoundary,
} from "takosumi-policy";
import {
  generateOpenTofuChildModuleRoot,
  type RootProviderBinding,
  type RootProviderRequirement,
} from "takosumi-rootgen";
import { stableJsonDigest } from "../../../adapters/source/digest.ts";
import { log } from "../../../shared/log.ts";
import {
  ConnectionsService,
  resolvedProviderBindingsDigest,
  type ResolvedCapsuleProviderBinding,
  validateRequiredProviderBindingIdentities,
} from "../../connections/mod.ts";
import type { ActivityRecorder } from "../../activity/mod.ts";
import type { RecordActivityInput } from "../../activity/mod.ts";
import type { SourcesService } from "../../sources/mod.ts";
import {
  collectRootModuleOutputDeclarations,
  collectRootModuleVariableNames,
} from "../../sources/capsule_compatibility.ts";
import type { ObservabilitySink } from "../../observability/mod.ts";
import { CapsuleQuery, requireCapsule } from "../capsule_query.ts";
import { getCapsuleAdoptedSourceSnapshot } from "../capsule_source_revision.ts";
import {
  accountsOidcModuleVariableProfile,
  type AccountsOidcModuleVariableProfile,
} from "../accounts_oidc_module_variable_profile.ts";
import {
  isRunnerInfrastructureRequeueError,
  OpenTofuControllerError,
  OpenTofuRunnerExecutionError,
  OpenTofuRunnerInfrastructureError,
  PROVIDER_CONNECTION_SETUP_REQUIRED_REASON,
  RUNNER_INFRASTRUCTURE_REQUEUED_REASON,
  RUNTIME_INPUT_MATERIALIZER_UNAVAILABLE_REASON,
  RUNTIME_INPUTS_MATERIAL_UNUSABLE_REASON,
  RUNTIME_INPUTS_PROFILE_MISSING_REASON,
  RUNTIME_INPUTS_PROVIDER_VERSION_UNPROVEN_REASON,
  RUNTIME_INPUTS_REQUIRE_GENERATED_ROOT_REASON,
  requireNonEmptyString,
  runErrorCode,
  sourceSyncRequiredError,
} from "../errors.ts";
import { rootgenErrorForController } from "../rootgen_error.ts";
import {
  DEFAULT_CAPSULE_LEASE_TTL_MS,
  CapsuleLeaseBusyError,
  type CapsuleCoordination,
  type LeaseHandle,
  withCapsuleLease,
  withPlanLease,
} from "../capsule_lease.ts";
import {
  type CapsulePlanContext,
  type PlanResolutionService,
  type ResolvedRootRuntimeInputs,
  providerBindingsFromResolved,
} from "../plan_resolution.ts";
import { evaluatePolicy } from "../policy.ts";
import {
  errorDiagnostic,
  errorMessage,
  normalizePlanArtifact,
  normalizePlanSummary,
  projectOutputAllowlistPublicOutputs,
  projectOutputAllowlistSpaceOutputs,
  projectAllWorkspaceOutputs,
  redactRunDiagnostics,
  stateLockEvidence,
} from "../projection.ts";
import { projectApplyRun, projectPlanRun } from "../projection_run.ts";
import {
  canonicalProviderAddress,
  compactLayeredPolicy,
  evaluateCompatibilityReportAgainstPolicy,
  evaluateConfiguredProviderAllowlist,
  evaluateProviderInstallationPolicy,
  evaluateProviderLockfilePolicy,
  mergePolicyConfigs,
  requiredProvidersFromCompatibilityReport,
  withDefaultProviderSupplyChainPolicy,
} from "../provider_policy.ts";
import {
  APPLY_BILLING_CAPTURE_COMPLETED_EVENT,
  APPLY_BILLING_CAPTURE_PENDING_EVENT,
  APPLY_RUNTIME_SECRET_RETIREMENT_COMPLETED_EVENT,
  APPLY_RUNTIME_SECRET_RETIREMENT_DEFERRED_EVENT,
  APPLY_RUNTIME_SECRET_RETIREMENT_PENDING_EVENT,
  applyRunBillingCapturePending,
  applyRunRuntimeSecretRetirementPending,
  capsuleLifecycleExpected,
  CapsuleStateVersionGuardConflict,
  planRunExecutionInputsDigestMaterial,
  type OpenTofuControlStore,
  type PlanRunInputs,
} from "../store.ts";
import {
  mergeInstallContextVariables,
  normalizeProviders,
  normalizeVariables,
  validateOperation,
  validatePlannedCapsuleCurrent,
  validateSource,
} from "../validation.ts";
import type { RunQueryService } from "../run_query.ts";
import type { BillingService } from "../billing_service.ts";
import type { DriftService } from "../drift_service.ts";
import type {
  ResolvedRunEnvironment,
  RunEnvResolver,
} from "../run_env_resolver.ts";
import type { ResolvedDependencies } from "../dependency_resolution.ts";
import type { DependencyResolutionService } from "../dependency_resolution.ts";
import type { RunVerificationService } from "../run_verification.ts";
import type { SourceLifecycleService } from "../source_lifecycle.ts";
import type {
  CapsuleModuleVariableMaterialization,
  CapsuleModuleVariableMaterializer,
} from "../module_variable_materializer.ts";
import {
  capsuleInterfaceMaterializationIntentId,
  createCapsuleInterfaceMaterializationIntent,
  createRestoredCapsuleInterfaceMaterializationIntent,
  pinCapsuleInterfaceBlueprints,
  restoredCapsuleInterfaceMaterializationIntentId,
  type CapsuleInterfaceMaterializationIntent,
} from "../interface_materialization_intent.ts";
import type {
  RuntimeSecretFileBundle,
  RuntimeSecretFileMaterializer,
} from "../runtime_secret_file_materializer.ts";
import type { RuntimeInputMaterializer } from "../runtime_input_materializer.ts";
import { runtimeInputWiringFromResolved } from "../runtime_input_wiring.ts";
// Shared helpers, constants, and run-engine types stay in the controller module
// (`../mod.ts`) so the domain's public entry point and external importers are
// unchanged; this engine imports the ones its moved bodies reference. The
// resulting `mod.ts <-> run_engine.ts` cycle is runtime-only (every symbol is
// used inside a method, never at module-evaluation time).
import {
  assertStateGenerationMatches,
  auditEvent,
  changedOutputNamesBetween,
  checkApplyExpected,
  defaultProviderMirrorRequiredForProfile,
  directChangedDependencyOutputs,
  isTerminalStatus,
  jsonRecordFromPublicOutputs,
  mergeJsonVariableDefaults,
  newId,
  NON_TERMINAL_RUN_STATUSES,
  providerInstallationAuditEvents,
  publicCapsule,
  publicPlanRun,
  redactRunApproval,
  releaseActivationCommands,
  releaseActivationOutputs,
  applyExpectedGuardFromPlanRun,
  RUN_HEARTBEAT_STALE_MS,
  RUN_RENEWAL_INTERVAL_MS,
  runEnvironmentFailedRun,
  snapshotModuleSource,
  moduleDispatchFromInputs,
  withRunEnvironmentEvidence,
} from "../mod.ts";

interface RuntimeSecretRetirementIntent {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly installConfigId: string;
  readonly profileDigest: string;
}

function runtimeSecretRetirementIntentFromRun(
  run: ApplyRun,
): RuntimeSecretRetirementIntent | undefined {
  const event = [...run.auditEvents]
    .reverse()
    .find(
      (entry) => entry.type === APPLY_RUNTIME_SECRET_RETIREMENT_PENDING_EVENT,
    );
  const data = event?.data;
  if (
    !data ||
    typeof data.workspaceId !== "string" ||
    typeof data.capsuleId !== "string" ||
    typeof data.installConfigId !== "string" ||
    typeof data.profileDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(data.profileDigest)
  ) {
    return undefined;
  }
  return {
    workspaceId: data.workspaceId,
    capsuleId: data.capsuleId,
    installConfigId: data.installConfigId,
    profileDigest: data.profileDigest,
  };
}
import type { ArtifactReferenceAllocator } from "../../../adapters/storage/artifact-references.ts";
import type {
  CreateCapsulePlanInternal,
  ApplyRunInternalContext,
  DependencyValueSealer,
  DeployControlActorContext,
  EnqueueRun,
  GenericRootDispatchContext,
  GenericRootPlanContext,
  OpenTofuApplyResult,
  OpenTofuCapsuleSourceFile,
  OpenTofuDestroyResult,
  OpenTofuPlanResult,
  OpenTofuRestoreResult,
  OpenTofuRestoreSourceState,
  OpenTofuRunDispatch,
  OpenTofuRunner,
  OpenTofuRunnerExecutorRegistry,
  PlanCompletionVerdict,
  PlanPolicyLayers,
  PlanRunInternalContext,
  ReleaseActivationAction,
  ReleaseActivationCommand,
  ReleaseActivationResult,
  ReleaseActivationStatus,
  ReleaseActivator,
  RunClaimResult,
  RunCredentials,
  RunExecutionDispatch,
  RunModuleDispatch,
  TerminalRunPersistResult,
} from "../mod.ts";

/** Internal-only widening used by the inventory-backed pre-v1 destroy drain. */
type InternalCreatePlanRunRequest = Omit<CreatePlanRunRequest, "source"> & {
  readonly source: OpenTofuExecutionSource;
};

interface CapsulePlanExecutionAuthority {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly installConfigId: string;
  readonly installConfigDigest: string;
  readonly capsuleExecutionAuthorityEpoch: number;
  /** Stateful destroy provenance cursor captured before request construction. */
  readonly currentStateVersionId?: string | null;
  readonly currentStateGeneration?: number;
}

/**
 * The marker is controller-owned context, not a request-body field. Only
 * #createLegacySourcelessDestroyPlan constructs it after inventory checks.
 */
type RunEnginePlanRunInternalContext = PlanRunInternalContext & {
  readonly legacySourcelessDestroyRecovery?: true;
  /** Authority used to derive the private Capsule Plan request/root. */
  readonly capsulePlanExecutionAuthority?: CapsulePlanExecutionAuthority;
};

function assertCapsulePlanStateAuthority(
  capsule: Capsule,
  authority: CapsulePlanExecutionAuthority | undefined,
): void {
  const expectedStateVersionId = authority?.currentStateVersionId;
  const expectedGeneration = authority?.currentStateGeneration;
  if (expectedStateVersionId === undefined && expectedGeneration === undefined) {
    return;
  }
  const actualStateVersionId = capsule.currentStateVersionId ?? null;
  if (
    expectedStateVersionId === undefined ||
    expectedGeneration === undefined ||
    actualStateVersionId !== expectedStateVersionId ||
    capsule.currentStateGeneration !== expectedGeneration
  ) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `capsule ${capsule.id} current StateVersion changed before Plan creation`,
      { reason: "destroy_provenance_changed" },
    );
  }
}

function releaseCommandRunId(applyRunId: string): string {
  return `release_${applyRunId.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
}

function isRetryableRunnerInfrastructureError(error: unknown): boolean {
  return error instanceof OpenTofuRunnerInfrastructureError;
}

/**
 * A mutating Run is safe to redeliver only when the runner proved either that
 * capacity was refused before provider execution, or that an exact immutable
 * artifact target can adopt a lost acknowledgement. A substrate reset is
 * ambiguous: the provider may already have changed external state without
 * returning a durable state artifact, so replaying the immutable Plan can
 * duplicate creates or destroys.
 */
function isSafeMutatingRunnerInfrastructureRetryError(
  error: unknown,
): boolean {
  return (
    error instanceof OpenTofuRunnerInfrastructureError &&
    (error.reason === "capacity_exhausted" ||
      error.reason === "runner_artifact_relay_ambiguous")
  );
}

const RUNNER_INFRASTRUCTURE_RETRY_LIMIT = 1;
const PLAN_CREATION_STAGE_TIMEOUT_MS = 25_000;
const RUN_EXECUTION_LEASE_LOST_REASON = "run_execution_lease_lost";
const APPLY_EXECUTION_LEASE_LOST = Symbol("apply_execution_lease_lost");
const APPLY_MATERIALIZATION_SOURCE_RUN_ID = Symbol(
  "apply_materialization_source_run_id",
);
const RUN_EXECUTION_RENEWAL_UNAVAILABLE_REASON =
  "run_execution_renewal_unavailable";
const RUN_RENEWAL_TRANSPORT_RETRY_LIMIT = 1;
const RUN_RENEWAL_TRANSPORT_RETRY_MAX_DELAY_MS = 250;

type RunRenewalTarget = "run_heartbeat" | "capsule_lease";
type RunRenewalFailure = "lost" | "unavailable";
type ApplyRunExecutionResponse = ApplyRunResponse & {
  readonly [APPLY_EXECUTION_LEASE_LOST]?: true;
  /** Internal-only provenance for the post-lease Interface intent drain. */
  readonly [APPLY_MATERIALIZATION_SOURCE_RUN_ID]?: string;
};

async function planCreationStage<T>(
  stage: string,
  promise: Promise<T>,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(
        new OpenTofuControllerError(
          "failed_precondition",
          `capsule_plan_creation_timeout: stage ${stage} did not return within ${PLAN_CREATION_STAGE_TIMEOUT_MS}ms`,
          {
            reason: "capsule_plan_creation_timeout",
            stage,
            timeoutMs: PLAN_CREATION_STAGE_TIMEOUT_MS,
          },
        ),
      );
    }, PLAN_CREATION_STAGE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function runnerInfrastructureRetryCount(
  run: PlanRun | ApplyRun,
  retryEventTypes: readonly string[],
): number {
  return run.auditEvents.filter((event) => retryEventTypes.includes(event.type))
    .length;
}

function runnerInfrastructureRetryExhaustedError(phase: string): Error {
  return new OpenTofuControllerError(
    "failed_precondition",
    `runner_infrastructure_retry_exhausted: ${phase} runner infrastructure retry limit exhausted`,
    { reason: "runner_infrastructure_retry_exhausted", phase },
  );
}

class PlanAlreadyAppliedReplay extends Error {
  readonly existingApplyRunId: string;

  constructor(planRunId: string, existingApplyRunId: string) {
    super(
      `plan run ${planRunId} has already been applied by apply run ${existingApplyRunId}`,
    );
    this.name = "PlanAlreadyAppliedReplay";
    this.existingApplyRunId = existingApplyRunId;
  }
}

/**
 * The runner has durably persisted the target artifact, but the authoritative
 * D1/Postgres ledger tail did not return a commit result. The only safe retry
 * is the same ApplyRun: the runner can adopt its exact target generation.
 */
class ArtifactLedgerTailAmbiguousError extends Error {
  readonly cause: unknown;

  constructor(runId: string, cause: unknown) {
    super(
      `artifact_ledger_tail_ambiguous: apply run ${runId} persisted its target artifact before the ledger commit failed`,
    );
    this.name = "ArtifactLedgerTailAmbiguousError";
    this.cause = cause;
  }
}

class RunExecutionRenewalError extends OpenTofuControllerError {
  readonly target: RunRenewalTarget;
  readonly failure: RunRenewalFailure;
  readonly diagnosticCode: `${RunRenewalTarget}_${RunRenewalFailure}`;
  readonly originalError?: unknown;
  secondaryError?: unknown;

  constructor(input: {
    readonly kind: "plan" | "apply" | "restore";
    readonly runId: string;
    readonly target: RunRenewalTarget;
    readonly failure: RunRenewalFailure;
    readonly attempts: number;
    readonly originalError?: unknown;
  }) {
    const reason =
      input.failure === "lost"
        ? RUN_EXECUTION_LEASE_LOST_REASON
        : RUN_EXECUTION_RENEWAL_UNAVAILABLE_REASON;
    const diagnosticCode = `${input.target}_${input.failure}` as const;
    super(
      "failed_precondition",
      `${diagnosticCode}: ${input.kind} run ${input.runId} ${
        input.failure === "lost"
          ? "lost its execution fence"
          : "could not confirm its execution fence"
      }`,
      {
        reason,
        kind: input.kind,
        runId: input.runId,
        renewalTarget: input.target,
        failure: input.failure,
        attempts: input.attempts,
      },
    );
    this.name = "RunExecutionRenewalError";
    this.target = input.target;
    this.failure = input.failure;
    this.diagnosticCode = diagnosticCode;
    this.originalError = input.originalError;
  }

  preserveSecondaryError(error: unknown): void {
    if (
      error === undefined ||
      error === this ||
      this.secondaryError !== undefined
    ) {
      return;
    }
    this.secondaryError = error;
  }
}

type LifecycleActionActivityStatus = Exclude<
  ReleaseActivationStatus,
  "skipped"
>;

interface LifecycleActionOutcome {
  readonly phase: InstallConfigLifecyclePhase;
  readonly reportedStatus:
    | ReleaseActivationStatus
    | "unavailable"
    | "error"
    | "not_applicable";
  readonly activityStatus: LifecycleActionActivityStatus;
  readonly actionDispatched: boolean;
  /** True when a first-apply cleanup was proven unnecessary and skipped. */
  readonly notApplicable?: boolean;
  /** True when the durable not-applicable marker already existed on retry. */
  readonly alreadyPersisted?: boolean;
  readonly pairedActionIds?: readonly string[];
  readonly stateVersionId?: string;
  readonly creatorRunId?: string;
  readonly reason?: string;
  readonly kind?: string;
  readonly message?: string;
  /** Already-redacted bounded detail from a terminal runner command failure. */
  readonly detail?: string;
  readonly hasHealthUrl?: boolean;
  readonly metadataKeys?: readonly string[];
  readonly commandCount: number;
  readonly outputCount: number;
}

class CapsuleLifecycleActionError extends OpenTofuControllerError {
  readonly phase: InstallConfigLifecyclePhase;
  readonly actionDispatched: boolean;
  readonly reportedStatus: LifecycleActionOutcome["reportedStatus"];
  readonly outcome: LifecycleActionOutcome;

  constructor(outcome: LifecycleActionOutcome) {
    const phaseLabel =
      outcome.phase === "post_apply" ? "post-apply" : "pre-destroy";
    super(
      "failed_precondition",
      outcome.message ??
        `${phaseLabel} lifecycle actions did not reach terminal success (${outcome.reportedStatus})`,
      {
        reason: CAPSULE_LIFECYCLE_ACTION_FAILED_ERROR_CODE,
        phase: outcome.phase,
        status: outcome.reportedStatus,
      },
    );
    this.name = "CapsuleLifecycleActionError";
    this.phase = outcome.phase;
    this.actionDispatched = outcome.actionDispatched;
    this.reportedStatus = outcome.reportedStatus;
    this.outcome = outcome;
  }
}

function runFailureDiagnostics(error: unknown) {
  const primary = lifecycleActionDiagnostic(error);
  if (!(error instanceof RunExecutionRenewalError)) return [primary];
  return [
    { ...primary, code: error.diagnosticCode },
    ...(error.secondaryError === undefined
      ? []
      : [lifecycleActionDiagnostic(error.secondaryError)]),
  ];
}

const MAX_LIFECYCLE_ACTION_DIAGNOSTIC_DETAIL_CHARS = 4_096;

function lifecycleActionDiagnostic(error: unknown) {
  const primary = errorDiagnostic(error);
  const lifecycleError = lifecycleActionErrorEvidence(error);
  const detail = lifecycleError?.outcome.detail;
  if (!detail) return primary;
  return {
    ...primary,
    detail: boundedLifecycleActionDiagnosticDetail(
      redactString(detail, { redactedValue: "[redacted]" }),
    ),
  };
}

function boundedLifecycleActionDiagnosticDetail(detail: string): string {
  if (detail.length <= MAX_LIFECYCLE_ACTION_DIAGNOSTIC_DETAIL_CHARS) {
    return detail;
  }
  const omission = "\n... diagnostics omitted ...\n";
  if (MAX_LIFECYCLE_ACTION_DIAGNOSTIC_DETAIL_CHARS <= omission.length) {
    return detail.slice(0, MAX_LIFECYCLE_ACTION_DIAGNOSTIC_DETAIL_CHARS);
  }
  const retainedLength =
    MAX_LIFECYCLE_ACTION_DIAGNOSTIC_DETAIL_CHARS - omission.length;
  const headLength = Math.ceil(retainedLength / 2);
  const tailLength = retainedLength - headLength;
  return `${detail.slice(0, headLength)}${omission}${detail.slice(-tailLength)}`;
}

function lifecycleActionErrorEvidence(
  error: unknown,
): CapsuleLifecycleActionError | undefined {
  if (error instanceof CapsuleLifecycleActionError) return error;
  return error instanceof RunExecutionRenewalError &&
      error.secondaryError instanceof CapsuleLifecycleActionError
    ? error.secondaryError
    : undefined;
}

function isRetryableCapsuleRenewalTransportError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly retryable?: unknown }).retryable === true
  );
}

/**
 * The single-owner run-serialization port. The controller owns the only
 * `#mutationChains` map + `#runSerialized` implementation and passes this
 * callback in; the engine never creates a second serialization queue.
 */
type RunSerialized = <T>(key: string, work: () => Promise<T>) => Promise<T>;

export interface RestoreRunLifecycleEvent {
  readonly phase: "started" | "succeeded" | "failed";
  /** The persisted Run projection for this lifecycle transition. */
  readonly run: Run;
}

type RecordActivityArgs = RecordActivityInput;

interface DeclaredGenericCapsuleInputs {
  readonly names: ReadonlySet<string>;
  readonly known: boolean;
}

function declaredGenericCapsuleInputs(
  sourceFiles: readonly OpenTofuCapsuleSourceFile[] | undefined,
  rootModuleVariables: readonly string[] | undefined,
): DeclaredGenericCapsuleInputs {
  if (rootModuleVariables !== undefined) {
    return { known: true, names: new Set(rootModuleVariables) };
  }
  if (sourceFiles !== undefined) {
    return {
      known: true,
      names: new Set(collectRootModuleVariableNames(sourceFiles)),
    };
  }
  return { known: false, names: new Set() };
}

function requestedGenericCapsuleVariables(
  explicit: Readonly<Record<string, unknown>>,
  providerInputDefaults: Readonly<Record<string, JsonValue>>,
  declaredInputs: DeclaredGenericCapsuleInputs,
): Readonly<Record<string, unknown>> {
  if (!declaredInputs.known) return explicit;
  const requested: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(explicit)) {
    if (!declaredInputs.names.has(key)) continue;
    requested[key] = value;
  }
  for (const key of Object.keys(providerInputDefaults)) {
    if (!declaredInputs.names.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(requested, key)) continue;
    requested[key] = null;
  }
  return requested;
}

function providerBindingResolutionRequirements(
  requirements: readonly CapsuleProviderRequirement[],
  runnerProfile?: Pick<RunnerProfile, "requireProviderBindings">,
): readonly CapsuleProviderRequirement[] {
  return runnerProfile?.requireProviderBindings === true
    ? requirements.map((requirement) => ({
        ...requirement,
        credentialRequired: true,
      }))
    : requirements;
}

/**
 * Historical destroy Plans may include OpenTofu's built-in runtime capability
 * (`terraform.io/builtin/terraform`) in the provider inventory. It is not an
 * installable package or a bindable credential, so remove it before deriving
 * the exact requirement set used for provider resolution and root generation.
 * Every non-built-in source and its exact identity/version are retained.
 */
function normalizeDestroyProviderInventory(
  requiredProviders: readonly string[],
  exactRequirements: readonly CapsuleProviderRequirement[] | undefined,
): {
  readonly requiredProviders: readonly string[];
  readonly exactRequirements: readonly CapsuleProviderRequirement[];
} {
  const installableProviders = normalizeProviders(requiredProviders).filter(
    (provider) => !isOpenTofuBuiltinProviderSource(provider),
  );
  const storedRequirements =
    exactRequirements ??
    legacyProviderRequirementsForStoredPlan(installableProviders);
  return {
    requiredProviders: installableProviders,
    exactRequirements: storedRequirements.filter(
      (requirement) =>
        !isOpenTofuBuiltinProviderSource(requirement.source),
    ),
  };
}

function requiredProviderRequirementsForNewPlan(
  requiredProviders: readonly string[],
  exact: readonly CapsuleProviderRequirement[],
  defaultCredentialRequired = false,
): readonly CapsuleProviderRequirement[] {
  const requirements = exact.map((requirement) =>
    defaultCredentialRequired
      ? { ...requirement, credentialRequired: true }
      : requirement,
  );
  const validated = validateRequiredProviderBindingIdentities(requirements);
  if (requirements.some((requirement) => requirement.allowed !== true)) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "required provider requirements must contain only allowed providers",
    );
  }
  const sourceSet = new Set(
    requirements.map((requirement) => requirement.source),
  );
  const requiredSourceSet = new Set(
    requiredProviders.map(canonicalProviderAddress),
  );
  if ([...sourceSet].some((source) => !requiredSourceSet.has(source))) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "root provider requirements contain a source outside requiredProviders",
    );
  }
  return validated;
}

/**
 * Decode only a genuinely pre-field stored PlanRun. The legacy source mirror
 * cannot recover aliases or module-local names, so its conservative identity
 * is usable only for the historical default-name path and never for a new
 * request that omitted exact rows.
 */
function legacyProviderRequirementsForStoredPlan(
  requiredProviders: readonly string[],
): readonly CapsuleProviderRequirement[] {
  return requiredProviders.map((source) => ({
    source: canonicalProviderAddress(source),
    moduleLocalName: providerTypeLocalName(source),
    allowed: true,
  }));
}

function providerRequirementsFromCompatibilityReport(
  report: CapsuleCompatibilityReport | undefined,
  requiredProviders: readonly string[],
): readonly CapsuleProviderRequirement[] {
  if (!report) return [];
  const required = new Set(requiredProviders.map(canonicalProviderAddress));
  const allowedPackages = new Set(
    report.providerPackages
      .filter((providerPackage) => providerPackage.allowed)
      .map((providerPackage) =>
        canonicalProviderAddress(providerPackage.source)
      ),
  );
  const requirements = report.rootProviderRequirements
    .filter((requirement) => {
      const source = canonicalProviderAddress(requirement.source);
      return required.has(source) && allowedPackages.has(source);
    })
    .map((requirement) => ({ ...requirement, allowed: true }));
  return validateRequiredProviderBindingIdentities(requirements);
}

function providerRequirementsFromResolvedBindings(
  resolved: readonly ResolvedCapsuleProviderBinding[],
): readonly CapsuleProviderRequirement[] {
  const ambiguous = resolved.find(
    (entry) => entry.alias !== undefined || entry.moduleLocalName === undefined,
  );
  if (ambiguous) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      ambiguous.alias !== undefined
        ? `deprecated ambiguous ProviderBinding alias cannot compile an exact provider identity: ${ambiguous.alias}`
        : `ProviderBinding ${ambiguous.provider} must declare moduleLocalName before it can compile an exact provider identity`,
      { reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON },
    );
  }
  const requirements = resolved.map((entry) => ({
    source: canonicalProviderAddress(entry.provider),
    moduleLocalName: entry.moduleLocalName!,
    ...(entry.childAlias ? { childAlias: entry.childAlias } : {}),
    allowed: true,
    credentialRequired: true,
  }));
  return validateRequiredProviderBindingIdentities(requirements);
}

function providerTypeLocalName(source: string): string {
  const canonical = canonicalProviderAddress(source);
  return canonical.split("/").at(-1) ?? canonical;
}

/**
 * A pre-v1 source-less binding may omit moduleLocalName for the provider's
 * default configuration. Recover only that one conservative identity from the
 * already-pinned legacy requirement; aliases and child configurations remain
 * fail-closed because their identity cannot be inferred safely.
 */
function legacyDefaultProviderBindingsForSourcelessDestroy(
  bindings: readonly ResolvedCapsuleProviderBinding[],
  requirements: readonly CapsuleProviderRequirement[],
): readonly ResolvedCapsuleProviderBinding[] {
  return bindings.map((binding) => {
    if (
      binding.alias !== undefined ||
      binding.moduleLocalName !== undefined ||
      binding.childAlias !== undefined
    ) {
      return binding;
    }
    const requirement = requirements.find(
      (candidate) =>
        canonicalProviderAddress(candidate.source) ===
          canonicalProviderAddress(binding.provider) &&
        candidate.childAlias === undefined &&
        candidate.moduleLocalName === providerTypeLocalName(binding.provider),
    );
    return requirement
      ? { ...binding, moduleLocalName: requirement.moduleLocalName }
      : binding;
  });
}

function rootProviderRequirementsForGeneratedRoot(
  requirements: readonly Pick<
    CapsuleRootProviderRequirement,
    "source" | "moduleLocalName" | "childAlias" | "version"
  >[],
): readonly RootProviderRequirement[] {
  return requirements.map((requirement) => ({
    source: requirement.source,
    moduleLocalName: requirement.moduleLocalName,
    ...(requirement.childAlias
      ? { childAlias: requirement.childAlias }
      : {}),
    ...(requirement.version ? { version: requirement.version } : {}),
  }));
}

const MAX_AUTO_CAPTURED_ROOT_OUTPUTS = 128;

function genericCapsuleWorkspaceOutputAllowlist(
  configured: InstallConfig["outputAllowlist"],
  sourceFiles: readonly OpenTofuCapsuleSourceFile[] | undefined,
  rootModuleOutputs:
    CapsuleCompatibilityReport["rootModuleOutputs"] | undefined,
  interfaceSources: readonly string[] = [],
): InstallConfig["outputAllowlist"] {
  const sourceOutputDeclarations = sourceFiles
    ? collectRootModuleOutputDeclarations(sourceFiles)
    : [];
  const reportOutputDeclarations = rootModuleOutputs ?? [];
  if (
    reportOutputDeclarations.some(
      (output) =>
        !output ||
        typeof output !== "object" ||
        typeof output.name !== "string" ||
        typeof output.sensitive !== "boolean" ||
        typeof output.ephemeral !== "boolean",
    )
  ) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "Compatibility report lacks current OpenTofu Output metadata; run compatibility_check again",
      { reason: "compatibility_report_output_metadata_missing" },
    );
  }
  const outputDeclarations =
    reportOutputDeclarations.length > 0
      ? reportOutputDeclarations
      : sourceOutputDeclarations;
  const outputDeclarationByName = new Map(
    outputDeclarations.map((output) => [output.name, output]),
  );
  const configuredSourceEntries = Object.values(configured);
  const configuredSources = [
    ...new Set(configuredSourceEntries.map((entry) => entry.from)),
  ].sort((left, right) => left.localeCompare(right));
  const configuredSourceSet = new Set(configuredSources);
  const interfaceSourceNames = [...new Set(interfaceSources)].sort(
    (left, right) => left.localeCompare(right),
  );
  const priorityNames = [
    ...new Set([...interfaceSourceNames, ...configuredSources]),
  ];
  if (priorityNames.length > MAX_AUTO_CAPTURED_ROOT_OUTPUTS) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `Interface/public Output mappings require ${priorityNames.length} root ` +
        `Outputs, exceeding the ${MAX_AUTO_CAPTURED_ROOT_OUTPUTS} capture limit`,
    );
  }
  const ephemeralPriorityNames = priorityNames.filter(
    (name) => outputDeclarationByName.get(name)?.ephemeral === true,
  );
  if (ephemeralPriorityNames.length > 0) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `Ephemeral root Outputs cannot be projected or re-exported: ${ephemeralPriorityNames.join(", ")}`,
      { reason: "ephemeral_output_projection_unsupported" },
    );
  }
  const configuredSensitiveSources = new Set(
    configuredSourceEntries
      .filter((entry) => entry.sensitive === true)
      .map((entry) => entry.from),
  );
  const discoveredSources = [
    ...new Set(outputDeclarations.map((output) => output.name)),
  ]
    .filter(
      (name) =>
        outputDeclarationByName.get(name)?.ephemeral !== true &&
        !configuredSourceSet.has(name) &&
        !interfaceSourceNames.includes(name),
    )
    .sort((left, right) => left.localeCompare(right));
  const outputNames = [...priorityNames, ...discoveredSources].slice(
    0,
    MAX_AUTO_CAPTURED_ROOT_OUTPUTS,
  );
  const allowlist: Record<string, OutputAllowlistEntry> = {};
  for (const name of outputNames) {
    const sensitive =
      outputDeclarationByName.get(name)?.sensitive === true ||
      configuredSensitiveSources.has(name);
    allowlist[name] = {
      from: name,
      type: "json",
      ...(sensitive ? { sensitive: true } : {}),
    };
  }
  return allowlist;
}

function lifecycleActionsForPlan(
  installConfig: InstallConfig,
  runnerProfile: RunnerProfile,
): InstallConfig["lifecycleActions"] {
  const actions = installConfig.lifecycleActions ?? [];
  if (actions.length === 0) return undefined;
  if (actions.length > 20) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "lifecycleActions must contain at most 20 actions",
    );
  }
  const policy = installConfig.policy.lifecycleActions;
  if (!policy) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "lifecycleActions require policy.lifecycleActions",
    );
  }
  const profileCapabilities = new Set(runnerProfile.capabilities ?? []);
  const actionsById = new Map(actions.map((action) => [action.id, action]));
  for (const action of actions) {
    if (
      action.apiVersion !== "takosumi.dev/v1alpha1" ||
      (action.kind !== "command" && action.kind !== "resource_migration")
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `lifecycle action ${action.id} uses an unsupported version or kind`,
      );
    }
    if (!policy.allowedExecutors.includes(action.executor)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `lifecycle action ${action.id} executor is not allowed by InstallConfig policy`,
      );
    }
    if (!policy.allowedRunnerCapabilities.includes(action.runnerCapability)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `lifecycle action ${action.id} capability is not allowed by InstallConfig policy`,
      );
    }
    if (
      action.executor === "runner" &&
      !profileCapabilities.has(action.runnerCapability)
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `lifecycle action ${action.id} requires unavailable runner capability ${action.runnerCapability}`,
      );
    }
    if (
      action.kind === "command" &&
      action.useProviderCredentials === true &&
      (action.executor !== "runner" || policy.allowProviderCredentials !== true)
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `lifecycle action ${action.id} is not allowed to use provider credentials`,
      );
    }
    if (action.kind === "command" && action.cleanupFor !== undefined) {
      if (action.phase !== "pre_destroy") {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `lifecycle action ${action.id} cleanupFor is supported only on pre_destroy actions`,
        );
      }
      const paired = actionsById.get(action.cleanupFor);
      if (!paired || paired.phase !== "post_apply") {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `lifecycle action ${action.id} cleanupFor must reference a post_apply action`,
        );
      }
    }
  }
  assertRunnerLifecycleCredentialModes(actions);
  return actions;
}

function latestOutputAtGeneration(
  outputs: readonly Output[],
  stateGeneration: number,
): Output | undefined {
  return outputs
    .filter((snapshot) => snapshot.stateGeneration === stateGeneration)
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id),
    )[0];
}

function assertRestoreRunnerResult(
  result: OpenTofuRestoreResult | undefined,
  runId: string,
  logicalTargetStateRef: string,
  generation: number,
): asserts result is OpenTofuRestoreResult {
  const state = result?.state;
  const authority = state?.restoreAuthority;
  const validAuthority =
    authority !== undefined &&
    authority.kind === "takosumi.runner-restore-ack@v1" &&
    Number.isSafeInteger(authority.version) &&
    authority.version > 0 &&
    Number.isSafeInteger(authority.fence) &&
    authority.fence > 0 &&
    typeof authority.operationId === "string" &&
    authority.operationId.trim().length > 0 &&
    typeof authority.stateEtag === "string" &&
    authority.stateEtag.trim().length > 0;
  if (
    !state ||
    state.generation !== generation ||
    typeof state.stateRef !== "string" ||
    state.stateRef.trim().length === 0 ||
    typeof state.logicalTargetStateRef !== "string" ||
    state.logicalTargetStateRef !== logicalTargetStateRef ||
    typeof state.digest !== "string" ||
    state.digest.trim().length === 0 ||
    state.runId !== runId ||
    !Number.isSafeInteger(state.ciphertextLength) ||
    state.ciphertextLength < 0 ||
    !validAuthority
  ) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `runner restore returned an incomplete or non-authoritative acknowledgement for run ${runId}`,
      { reason: "restore_acknowledgement_invalid" },
    );
  }
}

function restoreSourceStateFromStateVersion(
  state: StateVersion,
): OpenTofuRestoreSourceState {
  return {
    stateVersionId: state.id,
    workspaceId: state.workspaceId,
    capsuleId: state.capsuleId,
    environment: state.environment,
    generation: state.generation,
    stateRef: state.stateRef,
    digest: state.digest,
    createdByRunId: state.createdByRunId,
  };
}

async function stateVersionIdForApplyRun(applyRunId: string): Promise<string> {
  // One ApplyRun owns at most one StateVersion. Derive its ledger identity from
  // a domain-separated digest so a non-landed commit tail reconstructs the
  // exact id without persisting a premature StateVersion pointer on the Run.
  const digest = await stableJsonDigest({
    kind: "takosumi.state-version-id@v1",
    applyRunId,
  });
  return `state_${digest.slice("sha256:".length)}`;
}

function assertPinnedLifecycleRunnerCapabilities(
  actions: InstallConfig["lifecycleActions"],
  runnerProfile: RunnerProfile,
): void {
  const profileCapabilities = new Set(runnerProfile.capabilities ?? []);
  for (const action of actions ?? []) {
    if (
      action.executor === "runner" &&
      !profileCapabilities.has(action.runnerCapability)
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `lifecycle action ${action.id} requires unavailable runner capability ${action.runnerCapability}`,
      );
    }
  }
  assertRunnerLifecycleCredentialModes(actions ?? []);
}

function assertRunnerLifecycleCredentialModes(
  actions: readonly InstallConfigLifecycleAction[],
): void {
  for (const phase of ["post_apply", "pre_destroy"] as const) {
    const runnerActions = actions.filter(
      (action): action is InstallConfigLifecycleCommandAction =>
        action.kind === "command" &&
        action.phase === phase &&
        action.executor === "runner",
    );
    const credentialActions = runnerActions.filter(
      (action) => action.useProviderCredentials === true,
    );
    if (
      credentialActions.length > 0 &&
      credentialActions.length !== runnerActions.length
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `${phase} runner lifecycle actions must all opt in to provider credentials or all run without them`,
      );
    }
  }
}

/** Shared dependencies the controller injects into its single RunEngine. */
export interface RunEngineDependencies {
  readonly store: OpenTofuControlStore;
  /** Exact executor-id to runner adapter bindings supplied by the host. */
  readonly runnerExecutors: OpenTofuRunnerExecutorRegistry;
  readonly sourcesService?: SourcesService;
  readonly artifactReferenceAllocator?: ArtifactReferenceAllocator;
  readonly defaultRunnerProfileId: string;
  readonly newId: (prefix: string) => string;
  readonly now: () => number;
  readonly enqueueRun: EnqueueRun;
  /** Whether ledger-tail retries can be handed to an external queue owner. */
  readonly enqueueArtifactLedgerRetry: boolean;
  readonly capsuleCoordination?: CapsuleCoordination;
  readonly runRenewalIntervalMs: number;
  readonly activity: ActivityRecorder;
  readonly dependencyValueSealer?: DependencyValueSealer;
  readonly releaseActivator?: ReleaseActivator;
  readonly observability?: Pick<ObservabilitySink, "recordMetric">;
  readonly metricTags: Record<string, string>;
  readonly allowOperatorScopedProviderConnections: boolean;
  readonly operatorProviderConnections: readonly ProviderConnection[];
  readonly runnerProfiles: readonly RunnerProfile[];
  readonly seededProfiles: Promise<void>;
  readonly runQuery: RunQueryService;
  readonly billing: BillingService;
  readonly drift: DriftService;
  readonly runEnv: RunEnvResolver;
  readonly dependencies: DependencyResolutionService;
  readonly verification: RunVerificationService;
  readonly planResolution: PlanResolutionService;
  readonly moduleVariableMaterializer?: CapsuleModuleVariableMaterializer;
  readonly runtimeSecretFileMaterializer?: RuntimeSecretFileMaterializer;
  readonly runtimeInputMaterializer?: RuntimeInputMaterializer;
  readonly sourceLifecycle: SourceLifecycleService;
  readonly capsules: CapsuleQuery;
  readonly runSerialized: RunSerialized;
}

export class RunEngine {
  readonly #store: OpenTofuControlStore;
  readonly #runnerExecutors: OpenTofuRunnerExecutorRegistry;
  readonly #sourcesService?: SourcesService;
  readonly #artifactReferenceAllocator?: ArtifactReferenceAllocator;
  readonly #defaultRunnerProfileId: string;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #enqueueRun: EnqueueRun;
  readonly #enqueueArtifactLedgerRetry: boolean;
  readonly #capsuleCoordination?: CapsuleCoordination;
  readonly #runRenewalIntervalMs: number;
  readonly #activity: ActivityRecorder;
  readonly #dependencyValueSealer?: DependencyValueSealer;
  readonly #releaseActivator?: ReleaseActivator;
  readonly #observability?: Pick<ObservabilitySink, "recordMetric">;
  readonly #metricTags: Record<string, string>;
  readonly #allowOperatorScopedProviderConnections: boolean;
  readonly #operatorProviderConnections: readonly ProviderConnection[];
  readonly #runnerProfilesById: ReadonlyMap<string, RunnerProfile>;
  readonly #seededProfiles: Promise<void>;
  readonly #runQuery: RunQueryService;
  readonly #billing: BillingService;
  readonly #drift: DriftService;
  readonly #runEnv: RunEnvResolver;
  readonly #dependencies: DependencyResolutionService;
  readonly #verification: RunVerificationService;
  readonly #planResolution: PlanResolutionService;
  readonly #moduleVariableMaterializer?: CapsuleModuleVariableMaterializer;
  readonly #runtimeSecretFileMaterializer?: RuntimeSecretFileMaterializer;
  readonly #runtimeInputMaterializer?: RuntimeInputMaterializer;
  readonly #sourceLifecycle: SourceLifecycleService;
  readonly #capsules: CapsuleQuery;
  readonly #runSerialized: RunSerialized;
  #connectionsService?: ConnectionsService;
  #terminalObserver?: (run: PlanRun | ApplyRun) => Promise<void>;
  #postApplyLeaseReleasedObserver?: (
    run: ApplyRun,
    materializationSourceApplyRunId?: string,
  ) => Promise<void>;
  #planQueuedObserver?: (run: PlanRun) => Promise<void>;
  #applyQueuedObserver?: (run: ApplyRun) => Promise<void>;
  #restoreObserver?: (event: RestoreRunLifecycleEvent) => Promise<void>;
  #interfaceOutputSources?: (input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
  }) => Promise<readonly string[]>;

  constructor(deps: RunEngineDependencies) {
    this.#store = deps.store;
    this.#runnerExecutors = deps.runnerExecutors;
    this.#sourcesService = deps.sourcesService;
    this.#artifactReferenceAllocator = deps.artifactReferenceAllocator;
    this.#defaultRunnerProfileId = deps.defaultRunnerProfileId;
    this.#newId = deps.newId;
    this.#now = deps.now;
    this.#enqueueRun = deps.enqueueRun;
    this.#enqueueArtifactLedgerRetry = deps.enqueueArtifactLedgerRetry;
    this.#capsuleCoordination = deps.capsuleCoordination;
    this.#runRenewalIntervalMs = deps.runRenewalIntervalMs;
    this.#activity = deps.activity;
    this.#dependencyValueSealer = deps.dependencyValueSealer;
    this.#releaseActivator = deps.releaseActivator;
    this.#observability = deps.observability;
    this.#metricTags = deps.metricTags;
    this.#allowOperatorScopedProviderConnections =
      deps.allowOperatorScopedProviderConnections;
    this.#operatorProviderConnections = deps.operatorProviderConnections;
    this.#runnerProfilesById = new Map(
      deps.runnerProfiles.map((profile) => [profile.id, profile]),
    );
    this.#seededProfiles = deps.seededProfiles;
    this.#runQuery = deps.runQuery;
    this.#billing = deps.billing;
    this.#drift = deps.drift;
    this.#runEnv = deps.runEnv;
    this.#dependencies = deps.dependencies;
    this.#verification = deps.verification;
    this.#planResolution = deps.planResolution;
    this.#moduleVariableMaterializer = deps.moduleVariableMaterializer;
    this.#runtimeSecretFileMaterializer = deps.runtimeSecretFileMaterializer;
    this.#runtimeInputMaterializer = deps.runtimeInputMaterializer;
    this.#sourceLifecycle = deps.sourceLifecycle;
    this.#capsules = deps.capsules;
    this.#runSerialized = deps.runSerialized;
  }

  setTerminalObserver(
    observer: ((run: PlanRun | ApplyRun) => Promise<void>) | undefined,
  ): void {
    this.#terminalObserver = observer;
  }

  /**
   * Installs the fast-path hook for a successful Apply after its outer
   * Capsule/plan lease has fully released. This remains separate from the
   * terminal observer, whose existing lifecycle notifications run inside the
   * lease and must retain their current semantics.
   */
  setPostApplyLeaseReleasedObserver(
    observer:
      | ((
          run: ApplyRun,
          materializationSourceApplyRunId?: string,
        ) => Promise<void>)
      | undefined,
  ): void {
    this.#postApplyLeaseReleasedObserver = observer;
  }

  setPlanQueuedObserver(
    observer: ((run: PlanRun) => Promise<void>) | undefined,
  ): void {
    this.#planQueuedObserver = observer;
  }

  setApplyQueuedObserver(
    observer: ((run: ApplyRun) => Promise<void>) | undefined,
  ): void {
    this.#applyQueuedObserver = observer;
  }

  setRestoreObserver(
    observer: ((event: RestoreRunLifecycleEvent) => Promise<void>) | undefined,
  ): void {
    this.#restoreObserver = observer;
  }

  setInterfaceOutputSourcesResolver(
    resolver:
      | ((input: {
          readonly workspaceId: string;
          readonly capsuleId: string;
        }) => Promise<readonly string[]>)
      | undefined,
  ): void {
    this.#interfaceOutputSources = resolver;
  }

  async #notifyApplyQueued(run: ApplyRun): Promise<void> {
    if (!this.#applyQueuedObserver) return;
    try {
      await this.#applyQueuedObserver(run);
    } catch (error) {
      log.warn("service.deploy_control.apply_queued_observer_failed", {
        runId: run.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #notifyTerminal(run: PlanRun | ApplyRun): Promise<void> {
    if (!this.#terminalObserver) return;
    try {
      await this.#terminalObserver(run);
    } catch (error) {
      log.warn("service.deploy_control.terminal_observer_failed", {
        runId: run.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #notifyPostApplyLeaseReleased(
    response: ApplyRunExecutionResponse,
  ): Promise<void> {
    const run = response.applyRun;
    const materializationSourceApplyRunId =
      response[APPLY_MATERIALIZATION_SOURCE_RUN_ID] ?? run.id;
    if (
      response[APPLY_EXECUTION_LEASE_LOST] === true ||
      run.status !== "succeeded" ||
      run.operation === "destroy" ||
      !this.#postApplyLeaseReleasedObserver
    ) {
      return;
    }
    try {
      await this.#postApplyLeaseReleasedObserver(
        run,
        materializationSourceApplyRunId,
      );
    } catch (error) {
      // The Apply commit is already authoritative. A transient fast-path
      // failure must leave the durable intent for the scheduled recovery
      // drainer rather than rewriting or failing the committed run.
      log.warn("service.deploy_control.post_apply_lease_released_failed", {
        runId: run.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #notifyPlanQueued(run: PlanRun): Promise<void> {
    if (!this.#planQueuedObserver) return;
    try {
      await this.#planQueuedObserver(run);
    } catch (error) {
      log.warn("service.deploy_control.plan_queued_observer_failed", {
        runId: run.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #notifyRestore(event: RestoreRunLifecycleEvent): Promise<void> {
    if (!this.#restoreObserver) return;
    try {
      await this.#restoreObserver(event);
    } catch (error) {
      log.warn("service.deploy_control.restore_observer_failed", {
        runId: event.run.id,
        phase: event.phase,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ---- public bridges: invoked by controller-side collaborator callbacks ----
  // (the controller's BillingService / DriftService / RunCredentialBroker /
  // RunEnvResolver / RunVerificationService / PlanResolutionService / source
  // lifecycle wire their callbacks to these so the shared run-lifecycle helpers
  // keep a single owner here, while the private bodies stay byte-identical.)

  getApplyRun(id: string): Promise<ApplyRunResponse> {
    return this.#capsules.getApplyRun(id);
  }

  shouldProcessRun(
    status: RunStatus,
    heartbeatAt: number | undefined,
  ): boolean {
    return this.#shouldProcessRun(status, heartbeatAt);
  }

  recordActivity(event: RecordActivityArgs): Promise<void> {
    return this.#recordActivity(event);
  }

  createCapsulePlanRun(
    capsuleId: string,
    destroy: boolean,
    context: DeployControlActorContext,
    internal: CreateCapsulePlanInternal = {},
  ): Promise<PlanRunResponse> {
    return this.#createCapsulePlanRun(capsuleId, destroy, context, internal);
  }

  resolveRunProviderBindings(
    planRun: PlanRun,
  ): Promise<readonly ResolvedCapsuleProviderBinding[] | undefined> {
    return this.#resolveRunProviderBindings(planRun);
  }

  /**
   * Value-free run-scoped sensitive input wiring the Plan pinned into the
   * private run-inputs sidecar. The credential broker fences the Apply-time
   * derivation against it; nothing here is or contains a value.
   */
  async runtimeInputsForPlanRun(
    planRun: PlanRun,
  ): Promise<readonly DispatchRuntimeInputs[] | undefined> {
    const inputs = await this.#requirePreparedPlanRunInputs(planRun);
    return inputs.runtimeInputs;
  }

  /** Secret exposure policy of the profile a run dispatches to (credential gate). */
  async runnerSecretExposurePolicy(
    planRun: PlanRun,
  ): Promise<RunnerSecretExposurePolicy | undefined> {
    const profile = await this.#requireRunnerProfile(planRun.runnerProfileId);
    return profile.secretExposurePolicy;
  }

  policyForPlanRun(planRun: PlanRun): Promise<PolicyConfig | undefined> {
    return this.#policyForPlanRun(planRun);
  }

  assertCompatibilityReportRunnable(
    report: CapsuleCompatibilityReport,
    policy?: PolicyConfig,
  ): void {
    this.#assertCompatibilityReportRunnable(report, policy);
  }

  resolveCapsuleProviderBindingsForRun(
    capsule: Capsule,
    requiredProviders: readonly CapsuleProviderRequirement[],
  ): Promise<readonly ResolvedCapsuleProviderBinding[]> {
    return this.#resolveCapsuleProviderBindingsForRun(
      capsule,
      requiredProviders,
    );
  }

  async createPlanRun(
    request: InternalCreatePlanRunRequest,
    context: DeployControlActorContext = {},
    internal: RunEnginePlanRunInternalContext = {},
  ): Promise<PlanRunResponse> {
    const workspaceId = request.workspaceId;
    requireNonEmptyString(workspaceId, "workspaceId");
    const requestCapsuleId = request.capsuleId;
    const operation =
      request.operation ?? (requestCapsuleId ? "update" : "create");
    const compatibilityReportId =
      operation === "destroy" ? undefined : internal.compatibilityReportId;
    const legacySourcelessDestroyRecovery =
      internal.legacySourcelessDestroyRecovery === true;
    if (legacySourcelessDestroyRecovery) {
      if (
        !requestCapsuleId ||
        operation !== "destroy" ||
        request.source.kind !== "operator_module" ||
        !internal.genericRootDispatch?.generatedRoot ||
        !internal.genericRootDispatch.operatorModule ||
        internal.sourceSnapshotId !== undefined
      ) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "legacy source-less recovery requires an exact Capsule destroy with an operator module",
        );
      }
    } else {
      validateSource(request.source);
    }
    const profile = await this.#requireRunnerProfile(
      request.runnerProfileId ?? this.#defaultRunnerProfileId,
    );
    validateOperation(operation);
    if (
      internal.refreshOnly === true &&
      (operation === "destroy" || internal.driftCheck === true)
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "refreshOnly cannot be combined with destroy or driftCheck",
      );
    }
    let capsule =
      requestCapsuleId !== undefined
        ? await this.#requireCapsule(requestCapsuleId)
        : undefined;
    if (!capsule) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "plan requires an existing capsuleId (create the Capsule first)",
      );
    }
    if (capsule && capsule.workspaceId !== workspaceId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "capsule is not available to this workspace",
      );
    }
    if (
      legacySourcelessDestroyRecovery &&
      (!capsule || capsule.sourceId || capsule.currentStateGeneration <= 0)
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "legacy source-less recovery is limited to stateful pre-v1 Capsules without a Source",
      );
    }
    // SECURITY (operation label must match the target): the route derives the
    // required scope from the caller-supplied operation, so an explicit
    // `create` against a Capsule that already has a StateVersion would let a
    // principal scoped to `create` alone plan and apply over a deployed
    // Capsule. The label must match what the Capsule's state cursor implies.
    if (
      capsule &&
      operation === "create" &&
      capsule.currentStateVersionId !== undefined
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `capsule ${capsule.id} already has a current StateVersion; use operation "update"`,
      );
    }
    // Capture the epoch, then re-read the Capsule. A re-adoption may otherwise
    // land after #requireCapsule and let inputs derived from the old immutable
    // InstallConfig be stamped with the new execution-authority epoch.
    const capsuleExecutionAuthorityEpoch =
      await this.#store.getCapsuleExecutionAuthorityEpoch(capsule.id);
    if (
      typeof capsuleExecutionAuthorityEpoch !== "number" ||
      !Number.isSafeInteger(capsuleExecutionAuthorityEpoch) ||
      capsuleExecutionAuthorityEpoch < 1
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "Capsule execution authority is unavailable",
      );
    }
    const currentCapsule = await this.#requireCapsule(capsule.id);
    const outerAuthority = internal.capsulePlanExecutionAuthority;
    if (
      currentCapsule.id !== capsule.id ||
      currentCapsule.workspaceId !== capsule.workspaceId ||
      currentCapsule.installConfigId !== capsule.installConfigId ||
      (outerAuthority !== undefined &&
        (outerAuthority.workspaceId !== currentCapsule.workspaceId ||
          outerAuthority.capsuleId !== currentCapsule.id ||
          outerAuthority.installConfigId !== currentCapsule.installConfigId ||
          outerAuthority.capsuleExecutionAuthorityEpoch !==
            capsuleExecutionAuthorityEpoch))
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "Capsule execution authority changed before Plan creation",
        { reason: "capsule_execution_authority_changed" },
      );
    }
    assertCapsulePlanStateAuthority(currentCapsule, outerAuthority);
    capsule = currentCapsule;
    const capsuleContext: PlanRunCapsuleContext =
      internal.capsuleContext ?? {
        workspaceId: capsule.workspaceId,
        capsuleId: capsule.id,
        environment: capsule.environment,
      };
    const now = this.#now();
    const variables = normalizeVariables(request.variables);
    if (!Array.isArray(request.requiredProviderRequirements)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "requiredProviderRequirements must be present for every new Plan, including an explicit empty array",
      );
    }
    if (!Array.isArray(request.requiredProviders)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "requiredProviders must be present for every new Plan, including an explicit empty array",
      );
    }
    const declaredProviders = normalizeProviders(request.requiredProviders);
    const requiredProviderRequirements = requiredProviderRequirementsForNewPlan(
      declaredProviders,
      request.requiredProviderRequirements,
      profile.requireProviderBindings === true,
    );
    const currentInstallConfig = await this.#store.getInstallConfig(
      capsule.installConfigId,
    );
    if (!currentInstallConfig) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `install_config_not_found: ${capsule.installConfigId}`,
        { reason: "install_config_not_found" },
      );
    }
    if (
      outerAuthority !== undefined &&
      (currentInstallConfig.id !== outerAuthority.installConfigId ||
        (await stableJsonDigest(currentInstallConfig)) !==
          outerAuthority.installConfigDigest)
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "Capsule execution authority changed before Plan creation",
        { reason: "capsule_execution_authority_changed" },
      );
    }
    const materializationDigest =
      internal.genericRootDispatch?.moduleVariableMaterializationDigest;
    const currentMaterialization =
      hasModuleVariableMaterialization(currentInstallConfig);
    if (Boolean(materializationDigest) !== currentMaterialization) {
      throw moduleVariableMaterializationError(
        "declaration changed before the Plan variable digest",
      );
    }
    if (currentMaterialization) {
      if (
        !materializationDigest ||
        !MODULE_VARIABLE_MATERIALIZATION_DIGEST.test(materializationDigest) ||
        !this.#moduleVariableMaterializer
      ) {
        throw moduleVariableMaterializationError(
          "Capsule Plan did not carry its private materialization digest",
        );
      }
      const materializerVariables = moduleVariableMaterializerInputVariables(
        currentInstallConfig,
        variables,
      );
      const resolvedProviderBindings =
        await this.#resolveCapsuleProviderBindingsForRun(
          capsule,
          providerBindingResolutionRequirements(
            requiredProviderRequirements,
            profile,
          ),
        );
      let rematerialized: CapsuleModuleVariableMaterialization | undefined;
      try {
        rematerialized = await this.#moduleVariableMaterializer.materialize({
          phase: "plan",
          expectedDigest: materializationDigest,
          capsuleExecutionAuthorityEpoch,
          capsule,
          installConfig: currentInstallConfig,
          resolvedProviderBindings,
          variables: materializerVariables,
        });
      } catch (error) {
        throw moduleVariableMaterializationError(errorMessage(error));
      }
      const current = requireValidModuleVariableMaterialization(
        currentInstallConfig,
        rematerialized,
      );
      if (current.digest !== materializationDigest) {
        throw moduleVariableMaterializationError(
          "digest changed before the Plan variable digest",
        );
      }
      assertPinnedModuleVariableValues(variables, current);
    }
    // Provider identity never selects an execution profile; callers may
    // explicitly select an operator-defined capability profile when
    // private-network or host access is required.
    const capsulePlan = capsule ? internal.capsulePlan : undefined;
    const allowNoProviders =
      (declaredProviders.length === 0 && requestCapsuleId !== undefined) ||
      (declaredProviders.length === 0 &&
        profile.allowedProviders.includes("*"));
    const basePolicy = evaluatePolicy({
      profile,
      requiredProviders: declaredProviders,
      checkedAt: now,
      ...(allowNoProviders ? { allowNoProviders: true } : {}),
    });
    const declaredEnvProviderPolicy =
      await this.#evaluateDeclaredEnvProviderExecutionPolicy({
        profile,
        capsule,
        requiredProviders: declaredProviders,
      });
    const policyReasons = [
      ...basePolicy.reasons,
      ...declaredEnvProviderPolicy.reasons,
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
    if (internal.planRunId !== undefined) {
      requireNonEmptyString(internal.planRunId, "planRunId");
    }
    const planRunId = internal.planRunId ?? this.#newId("plan");
    const sourceSnapshotId =
      legacySourcelessDestroyRecovery
        ? undefined
        : (internal.sourceSnapshotId ??
          (await this.#resolvePlanSourceSnapshotId(capsule!)));
    const baseStateGeneration =
      internal.baseStateGeneration ?? capsule?.currentStateGeneration ?? 0;
    const genericRootDispatch =
      internal.genericRootDispatch ??
      (capsule && request.source.kind === "git"
        ? await this.#defaultGenericRootDispatchForPlanRun(
            { ...request, source: request.source },
            capsule,
            compatibilityReportId,
            requiredProviderRequirements,
          )
        : undefined);
    const generatedRoot = genericRootDispatch?.generatedRoot;
    const operatorModule = genericRootDispatch?.operatorModule;
    const workspaceOutputAllowlist =
      genericRootDispatch?.workspaceOutputAllowlist;
    const outputAllowlist = genericRootDispatch?.outputAllowlist;
    const sourceBuild = genericRootDispatch?.sourceBuild;
    const stateAdoption = genericRootDispatch?.stateAdoption;
    const priorState = genericRootDispatch?.priorState;
    const moduleVariableMaterializationDigest =
      genericRootDispatch?.moduleVariableMaterializationDigest;
    const interfaceMaterialization =
      genericRootDispatch?.interfaceMaterialization;
    const runtimeInputs = genericRootDispatch?.runtimeInputs;
    const lifecycleActions =
      internal.lifecycleActions ?? genericRootDispatch?.lifecycleActions;
    const planRunInputs: PlanRunInputs = {
      planRunId,
      variables,
      ...(generatedRoot ? { generatedRoot } : {}),
      ...(operatorModule ? { operatorModule } : {}),
      ...(workspaceOutputAllowlist ? { workspaceOutputAllowlist } : {}),
      ...(outputAllowlist ? { outputAllowlist } : {}),
      ...(sourceBuild ? { sourceBuild } : {}),
      ...(stateAdoption ? { stateAdoption } : {}),
      ...(priorState ? { priorState } : {}),
      ...(moduleVariableMaterializationDigest
        ? { moduleVariableMaterializationDigest }
        : {}),
      ...(interfaceMaterialization ? { interfaceMaterialization } : {}),
      ...(runtimeInputs ? { runtimeInputs } : {}),
      ...(lifecycleActions ? { lifecycleActions } : {}),
    };
    const dependencySnapshot = internal.resolvedDependencies?.entries.length
      ? this.#dependencySnapshotForPlanRun(
          planRunId,
          internal.resolvedDependencies,
        )
      : undefined;
    const executionInputsDigest = await stableJsonDigest(
      planRunExecutionInputsDigestMaterial(planRunInputs, dependencySnapshot),
    );
    const storedPlanRunInputs = await this.#planRunInputsForStorage(
      planRunInputs,
      internal.resolvedDependencies?.hasSensitiveInjected === true,
    );
    const dispatchDiagnostics = genericRootDispatch?.diagnostics ?? [];
    let planRun: PlanRun = {
      id: planRunId,
      workspaceId,
      createdBy: context.actor ?? "system",
      ...(requestCapsuleId ? { capsuleId: requestCapsuleId } : {}),
      ...(capsule
        ? {
            capsuleCurrentStateVersionId: capsule.currentStateVersionId ?? null,
            capsuleExecutionAuthorityEpoch,
          }
        : {}),
      source: request.source,
      sourceDigest,
      operation,
      runnerProfileId: profile.id,
      variablesDigest,
      executionInputsDigest,
      requiredProviders: declaredProviders,
      requiredProviderRequirements,
      baseStateGeneration,
      ...(sourceSnapshotId ? { sourceSnapshotId } : {}),
      ...(dependencySnapshot
        ? { dependencySnapshotId: dependencySnapshot.id }
        : {}),
      ...(compatibilityReportId ? { compatibilityReportId } : {}),
      ...(capsuleContext ? { capsuleContext } : {}),
      ...(internal.runGroupId ? { runGroupId: internal.runGroupId } : {}),
      ...(internal.driftCheck ? { driftCheck: true as const } : {}),
      ...(internal.refreshOnly ? { refreshOnly: true as const } : {}),
      ...(internal.autoApplyRequested
        ? { autoApplyRequested: true as const }
        : {}),
      ...(dispatchDiagnostics.length > 0
        ? { diagnostics: dispatchDiagnostics }
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
            ...(internal.refreshOnly ? { refreshOnly: true } : {}),
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
    if (
      outerAuthority?.currentStateVersionId !== undefined ||
      outerAuthority?.currentStateGeneration !== undefined
    ) {
      // A concurrent Apply can advance the Capsule while the immutable Plan
      // inputs are being assembled. Re-read immediately before persisting so
      // a destroy Plan can never combine old StateVersion provenance with a
      // newer current state.
      const latestCapsule = await this.#requireCapsule(capsule.id);
      assertCapsulePlanStateAuthority(latestCapsule, outerAuthority);
    }
    const prepared = await this.#store.preparePlanRun({
      run: planRun,
      inputs: storedPlanRunInputs,
      ...(dependencySnapshot ? { dependencySnapshot } : {}),
    });
    planRun = prepared.run;
    if (prepared.status === "created") {
      await this.#recordActivity({
        workspaceId: planRun.workspaceId,
        ...(context.actor ? { actorId: context.actor } : {}),
        action: "run.plan_created",
        targetType: "run",
        targetId: planRun.id,
        runId: planRun.id,
        metadata: {
          operation: planRun.operation,
          capsuleId: planRun.capsuleId,
          policyStatus: planRun.policy.status,
          ...(planRun.refreshOnly ? { refreshOnly: true } : {}),
        },
      });
      if (planRun.status === "failed") {
        await this.#recordDeployOperationMetric({
          run: planRun,
          operationKind: "plan",
          status: "failed",
        });
      }
    }
    if (prepared.status === "created" && planRun.status === "queued") {
      // A queued plan observes desired/provider state but has not changed the
      // pinned runtime revision. Notify the Interface lifecycle before an
      // inline queue can complete the plan, so terminal observation can always
      // clear the matching pending condition deterministically.
      await this.#notifyPlanQueued(planRun);
    }
    // Re-enqueue an existing queued row to recover a lost enqueue
    // acknowledgement, but never enqueue a Plan that a consumer has already
    // completed (or parked for approval). The queue consumer's own CAS remains
    // the execution fence for the duplicate queued message.
    if (planRun.status === "queued" && this.#hasRunnerForProfile(profile)) {
      await this.#enqueueRun({
        action: "plan",
        runId: planRun.id,
        workspaceId: planRun.workspaceId,
      });
      const dispatched = await this.#store.getPlanRun(planRun.id);
      return { planRun: publicPlanRun(dispatched ?? planRun) };
    }
    return { planRun: publicPlanRun(planRun) };
  }

  async createCapsulePlan(
    capsuleId: string,
    context: DeployControlActorContext = {},
    internal: CreateCapsulePlanInternal = {},
  ): Promise<PlanRunResponse> {
    return await this.#createCapsulePlanRun(
      capsuleId,
      false,
      context,
      internal,
    );
  }

  /**
   * Capsule-driven destroy-plan (spec §23 Destroy). Same resolution as
   * {@link createCapsulePlan} with a destroy operation; the plan ALWAYS
   * lands the persisted `waiting_approval` status after completion (a destroy
   * plan is always two-stage).
   */
  async createCapsuleDestroyPlan(
    capsuleId: string,
    context: DeployControlActorContext = {},
    internal: Pick<
      CreateCapsulePlanInternal,
      "runnerProfileId" | "sourceSnapshotId"
    > = {},
  ): Promise<PlanRunResponse> {
    return await this.#createCapsulePlanRun(capsuleId, true, context, internal);
  }

  /**
   * Capsule-driven drift check (spec §19 `drift_check` run type; Phase 8
   * advanced). Creates a plan-kind internal run flagged
   * {@link PlanRun.driftCheck} that:
   *   - resolves the Capsule config -> Source -> latest snapshot
   *     exactly like {@link createCapsulePlan} (an `update`-kind plan), so
   *     the runner produces a real `tofu plan` against the live state;
   *   - NEVER parks `waiting_approval` (`RunQueryService.planAwaitsApproval`
   *     short-circuits a drift check) — it is a read-only signal, not an applyable plan;
   *   - can NEVER be applied (`createApplyRun` rejects a drift-check plan with
   *     `failed_precondition`);
   *   - on completion with a non-empty change summary emits a subject-specific
   *     drift Activity event with public-safe aggregate metadata only (no
   *     values and no subject status mutation).
   * The §19 Run projection maps it to `type: "drift_check"`.
   *
   * The public API exposes drift-check creation as a canonical read-only run
   * route; it records ledger/activity evidence without creating an applyable
   * plan artifact.
   */
  async createCapsuleDriftCheck(
    capsuleId: string,
    context: DeployControlActorContext = {},
    internal: Pick<CreateCapsulePlanInternal, "runGroupId"> = {},
  ): Promise<PlanRunResponse> {
    return await this.#drift.createCapsuleDriftCheck(
      capsuleId,
      context,
      internal,
    );
  }

  async #createCapsulePlanRun(
    capsuleId: string,
    destroy: boolean,
    context: DeployControlActorContext,
    internal: CreateCapsulePlanInternal = {},
  ): Promise<PlanRunResponse> {
    requireNonEmptyString(capsuleId, "capsuleId");
    const capsule = await planCreationStage(
      "capsule_load",
      this.#requireCapsule(capsuleId),
    );
    const installConfig = await planCreationStage(
      "install_config_load",
      this.#store.getInstallConfig(capsule.installConfigId),
    );
    if (!installConfig) {
      throw new OpenTofuControllerError(
        "not_found",
        `install config ${capsule.installConfigId} not found for ` +
          `Capsule ${capsuleId}`,
      );
    }
    const runnerProfileId = internal.runnerProfileId ?? installConfig.runnerId;
    const runnerProfile = await this.#requireRunnerProfile(
      runnerProfileId ?? this.#defaultRunnerProfileId,
    );
    const lifecycleActions = lifecycleActionsForPlan(
      installConfig,
      runnerProfile,
    );
    if (destroy && !capsule.sourceId) {
      return await this.#createLegacySourcelessDestroyPlan({
        capsule,
        runnerProfile,
        context,
        ...(lifecycleActions ? { lifecycleActions } : {}),
      });
    }
    // A stateful destroy must be reconstructed from the exact PlanRun that
    // produced the current StateVersion. CompatibilityReport rows are
    // admission evidence for create/update only; they are not teardown
    // authority and may be unreadable legacy storage.
    const appliedPlan =
      destroy && capsule.currentStateGeneration > 0
        ? await planCreationStage(
            "current_state_plan_load",
            this.#currentStatePlanRunForCapsule(capsule),
          )
        : undefined;
    if (destroy && capsule.currentStateGeneration > 0 && !appliedPlan) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `capsule ${capsule.id} current StateVersion has no applied PlanRun provenance`,
        { reason: "destroy_provenance_missing" },
      );
    }
    if (destroy && appliedPlan && !appliedPlan.sourceSnapshotId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `capsule ${capsule.id} current StateVersion applied PlanRun has no SourceSnapshot provenance`,
        { reason: "destroy_source_snapshot_missing" },
      );
    }
    const destroyProviderRequirements = appliedPlan
      ? (() => {
          const inventory = normalizeDestroyProviderInventory(
            appliedPlan.requiredProviders,
            appliedPlan.requiredProviderRequirements,
          );
          const requiredProviderRequirements =
            requiredProviderRequirementsForNewPlan(
              inventory.requiredProviders,
              inventory.exactRequirements,
              runnerProfile.requireProviderBindings === true,
            );
          return {
            requiredProviders: inventory.requiredProviders,
            requiredProviderRequirements,
          };
        })()
      : undefined;
    const stored = await planCreationStage(
      "source_load",
      this.#store.getSource(capsule.sourceId),
    );
    if (!stored) {
      throw new OpenTofuControllerError(
        "not_found",
        `source ${capsule.sourceId} not found for Capsule ${capsuleId}`,
      );
    }
    const source: Source = stored;
    const appliedSourceSnapshot =
      destroy && appliedPlan?.sourceSnapshotId
        ? await planCreationStage(
            "current_state_source_snapshot_load",
            this.#requireSourceSnapshotForSource(
              stored.id,
              appliedPlan.sourceSnapshotId,
            ),
          )
        : undefined;
    const appliedModulePath =
      destroy && appliedPlan && appliedSourceSnapshot
        ? this.#assertDestroyAppliedPlanSource({
            capsule,
            source,
            snapshot: appliedSourceSnapshot,
            planRun: appliedPlan,
          })
        : undefined;
    if (destroy && internal.sourceSnapshotId) {
      if (!capsule.currentStateVersionId) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "destroy recovery requires an applied Capsule StateVersion",
        );
      }
      if (source.status !== "active") {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "destroy recovery requires an active Source",
        );
      }
      const recoverySnapshot = await planCreationStage(
        "source_snapshot_recovery_pin",
        this.#requireSourceSnapshotForSource(
          stored.id,
          internal.sourceSnapshotId,
        ),
      );
      const latest = await planCreationStage(
        "source_snapshot_recovery_latest",
        this.#resolveLatestSnapshot(
          stored.id,
          stored.defaultRef,
          stored.defaultPath,
        ),
      );
      if (
        recoverySnapshot.ref !== stored.defaultRef ||
        recoverySnapshot.path !== stored.defaultPath ||
        latest?.id !== recoverySnapshot.id
      ) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "destroy recovery SourceSnapshot must be the latest snapshot for the Source current ref and path",
        );
      }
    }
    // The rollback-plan path pins a specific SourceSnapshot from a prior
    // StateVersion; otherwise resolve the registered Source's latest snapshot.
    const destroySnapshotId = destroy
      ? appliedPlan?.sourceSnapshotId
      : undefined;
    const acceptedRepositoryInstallUx =
      installConfig.installExperience?.repositoryInstallUx?.status ===
        "accepted" &&
      !capsule.currentStateVersionId &&
      !destroy;
    const repositoryInstallUxSnapshotId = acceptedRepositoryInstallUx
      ? installConfig.internal?.sourceSnapshotId
      : undefined;
    if (acceptedRepositoryInstallUx && !repositoryInstallUxSnapshotId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "repository_install_ux_snapshot_missing: the initial Plan has no reviewed SourceSnapshot pin",
      );
    }
    if (
      repositoryInstallUxSnapshotId &&
      internal.sourceSnapshotId &&
      internal.sourceSnapshotId !== repositoryInstallUxSnapshotId
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "repository_install_ux_snapshot_mismatch: an initial Plan cannot replace the reviewed SourceSnapshot pin",
      );
    }
    const adoptedSnapshot =
      !destroy &&
      !internal.sourceSnapshotId &&
      !repositoryInstallUxSnapshotId &&
      capsule.currentStateVersionId
        ? await planCreationStage(
            "source_snapshot_adopted",
            getCapsuleAdoptedSourceSnapshot(this.#store, capsule),
          )
        : undefined;
    const resolved = internal.sourceSnapshotId
      ? await planCreationStage(
          "source_snapshot_pin",
          this.#requireSourceSnapshotForSource(
            stored.id,
            internal.sourceSnapshotId,
          ),
        )
      : destroySnapshotId
        ? await planCreationStage(
            "source_snapshot_destroy_pin",
            this.#requireSourceSnapshotForSource(stored.id, destroySnapshotId),
          )
        : repositoryInstallUxSnapshotId
          ? await planCreationStage(
              "source_snapshot_install_ux_pin",
              this.#requireSourceSnapshotForSource(
                stored.id,
                repositoryInstallUxSnapshotId,
              ),
            )
          : adoptedSnapshot
            ? await planCreationStage(
                "source_snapshot_tracked_latest",
                this.#resolveLatestSnapshot(
                  stored.id,
                  adoptedSnapshot.ref,
                  adoptedSnapshot.path,
                ),
              )
          : await planCreationStage(
              "source_snapshot_latest",
              this.#resolveLatestSnapshot(
                stored.id,
                stored.defaultRef,
                stored.defaultPath,
              ),
            );
    if (!resolved) {
      const ref = adoptedSnapshot?.ref ?? stored.defaultRef;
      const path = adoptedSnapshot?.path ?? stored.defaultPath;
      throw sourceSyncRequiredError(
        `source_sync_required: Capsule ${capsuleId} has no ` +
          `SourceSnapshot for source ${stored.id} ref ${ref} ` +
          `path ${path}; run a source sync first`,
      );
    }
    const snapshot: SourceSnapshot = resolved;
    if (
      repositoryInstallUxSnapshotId &&
      (snapshot.repositoryManifest?.status !== "present" ||
        !installConfig.internal?.repositoryInstallUxDigest ||
        snapshot.repositoryManifest.digest !==
          installConfig.internal.repositoryInstallUxDigest)
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "repository_install_ux_snapshot_mismatch: the initial Plan snapshot does not match the reviewed install configuration",
      );
    }
    // The Capsule's current state generation drives the dispatch
    // restore/persist arithmetic. No prior StateVersion -> generation 0.
    const latestState = await planCreationStage(
      "latest_state_load",
      this.#store.getLatestStateVersion(capsule.id, capsule.environment),
    );
    const baseStateGeneration =
      destroy && appliedPlan
        ? capsule.currentStateGeneration
        : latestState?.generation ?? 0;
    const operation = destroy
      ? "destroy"
      : capsule.currentStateVersionId
        ? "update"
        : "create";
    const compatibilityReportFromHint =
      !destroy && Boolean(internal.compatibilityReportId);
    const compatibilityReport = destroy
      ? undefined
      : internal.compatibilityReportId
        ? await planCreationStage(
            "compatibility_report_hint",
            this.#useCapsuleCompatibilityReportHint(
              capsule,
              source,
              snapshot,
              internal.compatibilityReportId,
              installConfig.modulePath,
            ),
          )
        : await planCreationStage(
            "compatibility_report_ensure",
            this.#ensureCapsuleCompatibilityReport(
              capsule,
              source,
              snapshot,
              installConfig.modulePath,
            ),
          );
    const {
      request: planRequest,
      capsulePlan,
      genericRootPlan,
      capsulePlanExecutionAuthority,
    } = await planCreationStage(
      "capsule_plan_request",
      this.#capsulePlanRequest({
        capsule,
        installConfig,
        source,
        snapshot,
        operation,
        modulePath:
          destroy && appliedPlan ? appliedModulePath : installConfig.modulePath,
        ...(runnerProfileId ? { runnerProfileId } : {}),
        ...(destroyProviderRequirements
          ? destroyProviderRequirements
          : {}),
        ...(compatibilityReport ? { compatibilityReport } : {}),
        skipReadySourceFileDiscovery: compatibilityReportFromHint,
      }),
    );
    const capsuleContext: PlanRunCapsuleContext = {
      workspaceId: capsule.workspaceId,
      capsuleId: capsule.id,
      environment: capsule.environment,
    };
    // Dependency variable_injection (spec §15 / §17). A destroy plan does NOT
    // inject dependency values: there is nothing to wire into a teardown, and the
    // pinned producer outputs would be irrelevant. For plan/update, resolve the
    // consumer's Dependencies, read each producer's Output, build the
    // injected values, and merge them into the generated-root module inputs
    // BEFORE the run is created. The DependencySnapshot and exact private
    // inputs are then committed atomically with the queue-visible PlanRun.
    const selectedPlanRequest = runnerProfileId
      ? { ...planRequest, runnerProfileId }
      : planRequest;
    const resolvedDeps = destroy
      ? undefined
      : await planCreationStage(
          "dependency_resolution",
          this.#dependencies.resolveConsumerDependencies(capsule),
        );
    const injectedRequest = resolvedDeps
      ? this.#injectDependencyValues(
          selectedPlanRequest,
          resolvedDeps.injectedValues,
        )
      : selectedPlanRequest;
    const finalizedGenericRoot = genericRootPlan
      ? await planCreationStage(
          "generic_root_dispatch",
          this.#genericRootDispatchForRequest(
            injectedRequest,
            genericRootPlan,
            compatibilityReport,
          ),
        )
      : undefined;
    const response = await planCreationStage(
      "plan_run_create",
      this.createPlanRun(injectedRequest, context, {
        capsuleContext,
        sourceSnapshotId: snapshot.id,
        ...(internal.planRunId ? { planRunId: internal.planRunId } : {}),
        baseStateGeneration,
        ...(compatibilityReport
          ? { compatibilityReportId: compatibilityReport.id }
          : {}),
        ...(capsulePlan ? { capsulePlan } : {}),
        capsulePlanExecutionAuthority,
        ...(lifecycleActions ? { lifecycleActions } : {}),
        ...(finalizedGenericRoot
          ? { genericRootDispatch: finalizedGenericRoot }
          : {}),
        ...(resolvedDeps && resolvedDeps.entries.length > 0
          ? { resolvedDependencies: resolvedDeps }
          : {}),
        ...(internal.runGroupId ? { runGroupId: internal.runGroupId } : {}),
        ...(internal.driftCheck ? { driftCheck: true as const } : {}),
        ...(internal.autoApplyRequested
          ? { autoApplyRequested: true as const }
          : {}),
      }),
    );
    return response;
  }

  /** Merges dependency-injected values into ordinary root-module variables. */
  #injectDependencyValues(
    request: CreatePlanRunRequest,
    injectedValues: Readonly<Record<string, JsonValue>>,
  ): CreatePlanRunRequest {
    if (Object.keys(injectedValues).length === 0) return request;
    return {
      ...request,
      variables: { ...(request.variables ?? {}), ...injectedValues },
    };
  }

  /** Builds the immutable DependencySnapshot included in Plan preparation. */
  #dependencySnapshotForPlanRun(
    planRunId: string,
    resolved: ResolvedDependencies,
  ): DependencySnapshot {
    return {
      id: this.#newId("depsnap"),
      runId: planRunId,
      dependencies: resolved.entries,
      mode: resolved.mode,
      createdAt: new Date(this.#now()).toISOString(),
    };
  }

  /**
   * Picks the latest SourceSnapshot for a Source's current Git ref/path.
   * Source sync archives the selected subtree, so a same-ref snapshot from a
   * previous defaultPath is not interchangeable with the current Capsule path.
   */
  async #resolveLatestSnapshot(
    sourceId: string,
    ref: string,
    path: string,
  ): Promise<SourceSnapshot | undefined> {
    const snapshots = await this.#store.listSourceSnapshots(sourceId);
    if (snapshots.length === 0) return undefined;
    // listSourceSnapshots is ordered oldest-first (fetchedAt asc); the last
    // ref/path-matching snapshot is the newest archive for that Capsule path.
    const matches = snapshots.filter(
      (snap) => snap.ref === ref && snap.path === path,
    );
    return matches[matches.length - 1];
  }

  async #resolvePlanSourceSnapshotId(capsule: Capsule): Promise<string> {
    if (!capsule.sourceId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `capsule ${capsule.id} has no Git Source`,
      );
    }
    const source = await this.#store.getSource(capsule.sourceId);
    if (!source) {
      throw new OpenTofuControllerError(
        "not_found",
        `source ${capsule.sourceId} not found for capsule ${capsule.id}`,
      );
    }
    if (!capsule.currentStateVersionId) {
      const installConfig = await this.#store.getInstallConfig(
        capsule.installConfigId,
      );
      if (!installConfig) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `install_config_not_found: ${capsule.installConfigId}`,
        );
      }
      const acceptedRepositoryInstallUx =
        installConfig.installExperience?.repositoryInstallUx?.status ===
        "accepted";
      const pinnedSnapshotId = installConfig.internal?.sourceSnapshotId;
      if (acceptedRepositoryInstallUx && !pinnedSnapshotId) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "repository_install_ux_snapshot_missing: the initial Plan has no reviewed SourceSnapshot pin",
        );
      }
      if (pinnedSnapshotId) {
        const snapshot = await this.#requireSourceSnapshotForSource(
          source.id,
          pinnedSnapshotId,
        );
        const expectedDigest =
          installConfig.internal?.repositoryInstallUxDigest;
        if (
          !expectedDigest ||
          snapshot.repositoryManifest?.status !== "present" ||
          snapshot.repositoryManifest.digest !== expectedDigest
        ) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            "repository_install_ux_snapshot_mismatch: the initial Plan snapshot does not match the reviewed install configuration",
          );
        }
        return snapshot.id;
      }
    }
    const snapshot = await this.#resolveLatestSnapshot(
      source.id,
      source.defaultRef,
      source.defaultPath,
    );
    if (!snapshot) {
      throw sourceSyncRequiredError(
        `source_sync_required: capsule ${capsule.id} has no SourceSnapshot for source ${source.id} ref ${source.defaultRef} path ${source.defaultPath}; run a source sync first`,
      );
    }
    return snapshot.id;
  }

  /**
   * Resolves a SourceSnapshot by id and asserts it belongs to the given Source.
   * Used by the rollback-plan path to pin a prior StateVersion's source; a
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
   * Validates and returns the module coordinate that the applied PlanRun used.
   * A mutable InstallConfig may be edited after Apply, but teardown must still
   * restore the exact child module selected by that applied StateVersion.
   */
  #assertDestroyAppliedPlanSource(input: {
    readonly capsule: Capsule;
    readonly source: Source;
    readonly snapshot: SourceSnapshot;
    readonly planRun: PlanRun;
  }): string | undefined {
    const plannedSourceValue = input.planRun.source as unknown;
    const plannedSource = isPlainRecord(plannedSourceValue)
      ? plannedSourceValue
      : undefined;
    const modulePath =
      typeof plannedSource?.modulePath === "string"
        ? plannedSource.modulePath
        : undefined;
    if (
      !plannedSource ||
      plannedSource.kind !== "git" ||
      typeof plannedSource.url !== "string" ||
      plannedSource.url.trim() === "" ||
      typeof plannedSource.commit !== "string" ||
      plannedSource.commit.trim() === "" ||
      (plannedSource.modulePath !== undefined &&
        typeof plannedSource.modulePath !== "string") ||
      !isPlainRecord(input.source) ||
      !isPlainRecord(input.snapshot) ||
      typeof input.source.id !== "string" ||
      input.source.id.trim() === "" ||
      typeof input.source.workspaceId !== "string" ||
      input.source.workspaceId.trim() === "" ||
      typeof input.source.url !== "string" ||
      input.source.url.trim() === "" ||
      typeof input.snapshot.id !== "string" ||
      input.snapshot.id.trim() === "" ||
      typeof input.snapshot.workspaceId !== "string" ||
      input.snapshot.workspaceId.trim() === "" ||
      typeof input.snapshot.sourceId !== "string" ||
      input.snapshot.sourceId.trim() === "" ||
      typeof input.snapshot.url !== "string" ||
      input.snapshot.url.trim() === "" ||
      typeof input.snapshot.ref !== "string" ||
      input.snapshot.ref.trim() === "" ||
      typeof input.snapshot.path !== "string" ||
      input.snapshot.path.trim() === ""
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `capsule ${input.capsule.id} applied PlanRun has invalid Git source provenance`,
        { reason: "destroy_source_provenance_invalid" },
      );
    }
    if (
      input.source.id !== input.capsule.sourceId ||
      input.source.workspaceId !== input.capsule.workspaceId ||
      input.snapshot.origin !== "git" ||
      input.snapshot.workspaceId !== input.capsule.workspaceId ||
      input.snapshot.sourceId !== input.source.id ||
      input.snapshot.url !== input.source.url ||
      typeof input.snapshot.resolvedCommit !== "string" ||
      input.snapshot.resolvedCommit.trim() === "" ||
      input.snapshot.id !== input.planRun.sourceSnapshotId
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `capsule ${input.capsule.id} applied PlanRun SourceSnapshot provenance is invalid`,
        { reason: "destroy_source_provenance_invalid" },
      );
    }
    const expectedSource = snapshotModuleSource(
      input.source,
      input.snapshot,
      modulePath,
    );
    if (
      plannedSource.url !== expectedSource.url ||
      plannedSource.commit.toLowerCase() !== expectedSource.commit ||
      normalizeDestroyModulePath(modulePath) !==
        expectedSource.modulePath
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `capsule ${input.capsule.id} applied PlanRun source does not match its SourceSnapshot`,
        { reason: "destroy_source_provenance_invalid" },
      );
    }
    return expectedSource.modulePath;
  }

  async #ensureCapsuleCompatibilityReport(
    capsule: Capsule,
    source: Source,
    snapshot: SourceSnapshot,
    modulePath?: string,
  ): Promise<CapsuleCompatibilityReport | undefined> {
    const existing = capsule.compatibilityReportId
      ? await this.#store.getCapsuleCompatibilityReport(
          capsule.compatibilityReportId,
        )
      : undefined;
    const policy = await this.#policyForCapsule(capsule);
    if (
      existing &&
      this.#isCompatibilityReportScopedToCapsulePlan(
        existing,
        capsule,
        source,
        snapshot,
        modulePath,
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
          capsuleId: capsule.id,
        },
      );
    // A preflight report that analyzed a different module path is not evidence
    // about this plan's module. That is an ordinary miss, not tampering, so
    // fall through to a fresh Capsule Gate run at the planned path rather than
    // reusing it.
    if (
      preflight &&
      this.#isCompatibilityReportScopedToCapsulePlan(
        preflight,
        capsule,
        source,
        snapshot,
        modulePath,
      )
    ) {
      this.#assertCompatibilityReportRunnable(preflight, policy);
      await this.#recordCapsuleCompatibility(capsule, preflight);
      return preflight;
    }
    if (!this.#sourcesService) {
      if (existing) {
        this.#assertCompatibilityReportScopedToCapsulePlan(
          existing,
          capsule,
          source,
          snapshot,
          modulePath,
        );
      }
      return undefined;
    }
    const { report } = await this.#sourcesService.createCompatibilityCheck(
      source.id,
      {
        sourceSnapshotId: snapshot.id,
        capsuleId: capsule.id,
        ...(modulePath ? { modulePath } : {}),
      },
    );
    this.#assertCompatibilityReportRunnable(report, policy);
    await this.#recordCapsuleCompatibility(capsule, report);
    return report;
  }

  async #useCapsuleCompatibilityReportHint(
    capsule: Capsule,
    source: Source,
    snapshot: SourceSnapshot,
    reportId: string,
    modulePath: string | undefined,
  ): Promise<CapsuleCompatibilityReport> {
    const report = await this.#store.getCapsuleCompatibilityReport(reportId);
    if (!report) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_missing: ${reportId}`,
        { reason: "compatibility_report_missing" },
      );
    }
    this.#assertCompatibilityReportScopedToCapsulePlan(
      report,
      capsule,
      source,
      snapshot,
      modulePath,
    );
    const policy = await this.#policyForCapsule(capsule);
    this.#assertCompatibilityReportRunnable(report, policy);
    if (capsule.compatibilityReportId !== report.id) {
      await this.#recordCapsuleCompatibility(capsule, report);
    }
    return report;
  }

  async #recordCapsuleCompatibility(
    capsule: Capsule,
    report: CapsuleCompatibilityReport,
  ): Promise<void> {
    const epoch = await this.#store.getCapsuleExecutionAuthorityEpoch(
      capsule.id,
    );
    if (epoch === undefined) {
      throw new OpenTofuControllerError(
        "not_found",
        `capsule ${capsule.id} not found`,
      );
    }
    const result = await this.#store.updateCapsuleLifecycle({
      capsuleId: capsule.id,
      expected: capsuleLifecycleExpected(capsule, epoch),
      mutation: {
        kind: "compatibility",
        reportId: report.id,
        status: report.level,
      },
      updatedAt: new Date(this.#now()).toISOString(),
    });
    if (result.kind === "updated") return;
    throw new OpenTofuControllerError(
      "failed_precondition",
      `capsule ${capsule.id} lifecycle changed while recording compatibility`,
      { reason: "capsule_lifecycle_changed" },
    );
  }

  #isCompatibilityReportScopedToCapsulePlan(
    report: CapsuleCompatibilityReport,
    capsule: Capsule,
    source: Source,
    snapshot: SourceSnapshot,
    modulePath: string | undefined,
  ): boolean {
    return (
      report.sourceSnapshotId === snapshot.id &&
      (!report.sourceId || report.sourceId === source.id) &&
      (!report.capsuleId || report.capsuleId === capsule.id) &&
      this.#isCompatibilityReportForPlannedModule(report, modulePath)
    );
  }

  /**
   * A report only reviewed the module it was analyzed for. The plan executes
   * `InstallConfig.modulePath`, so a report produced for a benign sibling
   * module in the same snapshot must never gate it. A report written before the
   * analyzed path was recorded is unknown, not root, and is never reusable.
   */
  #isCompatibilityReportForPlannedModule(
    report: CapsuleCompatibilityReport,
    modulePath: string | undefined,
  ): boolean {
    if (!report.modulePath) return false;
    return (
      normalizeCompatibilityReportModulePath(report.modulePath) ===
      normalizeCompatibilityReportModulePath(modulePath)
    );
  }

  #assertCompatibilityReportScopedToCapsulePlan(
    report: CapsuleCompatibilityReport,
    capsule: Capsule,
    source: Source,
    snapshot: SourceSnapshot,
    modulePath: string | undefined,
  ): void {
    if (report.sourceSnapshotId !== snapshot.id) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_snapshot_mismatch: plan uses SourceSnapshot ` +
          `${snapshot.id} but report ${report.id} was created for ` +
          `${report.sourceSnapshotId}`,
        { reason: "compatibility_report_snapshot_mismatch" },
      );
    }
    if (report.sourceId && report.sourceId !== source.id) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_source_mismatch: plan uses Source ${source.id} ` +
          `but report ${report.id} was created for ${report.sourceId}`,
        { reason: "compatibility_report_source_mismatch" },
      );
    }
    if (report.capsuleId && report.capsuleId !== capsule.id) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_capsule_mismatch: plan uses Capsule ` +
          `${capsule.id} but report ${report.id} was created for ` +
          `${report.capsuleId}`,
        { reason: "compatibility_report_capsule_mismatch" },
      );
    }
    if (!this.#isCompatibilityReportForPlannedModule(report, modulePath)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_module_path_mismatch: plan executes module path ` +
          `${normalizeCompatibilityReportModulePath(modulePath)} but report ` +
          `${report.id} analyzed ` +
          `${report.modulePath ? normalizeCompatibilityReportModulePath(report.modulePath) : "an unrecorded path"}`,
        { reason: "compatibility_report_module_path_mismatch" },
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
      { reason: "compatibility_report_not_runnable" },
    );
  }

  async #evaluateDeclaredEnvProviderExecutionPolicy(input: {
    readonly profile: RunnerProfile;
    readonly capsule?: Capsule;
    readonly requiredProviders: readonly string[];
  }): Promise<{ readonly reasons: readonly string[] }> {
    if (!input.capsule) return { reasons: [] };
    this.#connectionsService ??= new ConnectionsService({
      store: this.#store,
      operatorProviderConnections: this.#operatorProviderConnections,
      allowOperatorScopedProviderConnections:
        this.#allowOperatorScopedProviderConnections,
    });
    const resolved = await this.#connectionsService.resolveProviderBindings(
      input.capsule,
    );
    const declaredEnvConnections = resolved
      .map((entry) => entry.connection)
      .filter(
        (connection): connection is NonNullable<typeof connection> =>
          connection !== undefined &&
          usesDeclaredEnvCredentialRecipe(connection),
      );
    if (declaredEnvConnections.length === 0) return { reasons: [] };

    const reasons: string[] = [];
    if (input.requiredProviders.length === 0) {
      reasons.push(
        `declared-env provider bindings on runner profile ${input.profile.id} require requiredProviders before OpenTofu init`,
      );
    }
    for (const connection of declaredEnvConnections) {
      if (connection.scope !== "workspace") {
        reasons.push(
          `declared-env provider connection ${connection.id} for ${connection.provider} must be Workspace-scoped`,
        );
      }
    }
    return { reasons };
  }

  #hasRunnerForProfile(profile: RunnerProfile): boolean {
    return (
      typeof profile.executorId === "string" &&
      profile.executorId.trim().length > 0 &&
      this.#runnerExecutors.has(profile.executorId)
    );
  }

  #runnerForProfile(profile: RunnerProfile): OpenTofuRunner {
    if (!profile.executorId?.trim()) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `runner profile ${profile.id} has no executorId`,
      );
    }
    const runner = this.#runnerExecutors.get(profile.executorId);
    if (!runner) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `runner profile ${profile.id} references unregistered executor ${profile.executorId}`,
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
    readonly operation: PlanRun["operation"];
    readonly compatibilityReportId?: string;
    readonly sourceSnapshotId?: string;
    readonly policy?: PolicyConfig;
  }): Promise<{
    readonly reasons: readonly string[];
    readonly audit?: Readonly<Record<string, JsonValue>>;
  }> {
    // Compatibility reports are create/update admission evidence, never a
    // teardown lock. Destroy must not even read a legacy report row while
    // completing its plan.
    if (input.operation === "destroy" || !input.compatibilityReportId) {
      return { reasons: [] };
    }
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

  /** Builds a plan request for the Capsule's selected Git module. */
  async #capsulePlanRequest(input: {
    readonly capsule: Capsule;
    readonly installConfig: InstallConfig;
    readonly source: Source;
    readonly snapshot: SourceSnapshot;
    readonly operation: "create" | "update" | "destroy";
    readonly modulePath: string | undefined;
    readonly runnerProfileId?: string;
    readonly requiredProviders?: readonly string[];
    readonly requiredProviderRequirements?: readonly CapsuleProviderRequirement[];
    readonly compatibilityReport?: CapsuleCompatibilityReport;
    readonly skipReadySourceFileDiscovery?: boolean;
  }): Promise<{
    readonly request: CreatePlanRunRequest;
    readonly capsulePlan: CapsulePlanContext;
    readonly requiredProviderRequirements: readonly CapsuleProviderRequirement[];
    readonly genericRootPlan?: GenericRootPlanContext;
    readonly capsulePlanExecutionAuthority: CapsulePlanExecutionAuthority;
  }> {
    const moduleSource = snapshotModuleSource(
      input.source,
      input.snapshot,
      input.modulePath,
    );
    const generic = await this.#genericCapsulePlanRequest(input, moduleSource);
    return {
      request: generic.request,
      capsulePlan: generic.capsulePlan,
      requiredProviderRequirements: generic.requiredProviderRequirements,
      genericRootPlan: generic.genericRootPlan,
      capsulePlanExecutionAuthority: generic.capsulePlanExecutionAuthority,
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
      readonly capsule: Capsule;
      readonly installConfig: InstallConfig;
      readonly operation: "create" | "update" | "destroy";
      readonly modulePath: string | undefined;
      readonly runnerProfileId?: string;
      readonly requiredProviders?: readonly string[];
      readonly requiredProviderRequirements?: readonly CapsuleProviderRequirement[];
      readonly compatibilityReport?: CapsuleCompatibilityReport;
      readonly snapshot: SourceSnapshot;
      readonly skipReadySourceFileDiscovery?: boolean;
    },
    moduleSource: OpenTofuModuleSource,
  ): Promise<{
    readonly request: CreatePlanRunRequest;
    readonly capsulePlan: CapsulePlanContext;
    readonly requiredProviderRequirements: readonly CapsuleProviderRequirement[];
    readonly genericRootPlan: GenericRootPlanContext;
    readonly capsulePlanExecutionAuthority: CapsulePlanExecutionAuthority;
  }> {
    const profile = await this.#requireRunnerProfile(
      input.runnerProfileId ?? this.#defaultRunnerProfileId,
    );
    const compatibilityProviders = requiredProvidersFromCompatibilityReport(
      input.compatibilityReport,
      profile.allowedProviders,
    );
    let requiredProviders = input.requiredProviders
      ? normalizeProviders(input.requiredProviders)
      : compatibilityProviders;
    let requiredProviderRequirements = input.requiredProviderRequirements ??
      providerRequirementsFromCompatibilityReport(
        input.compatibilityReport,
        requiredProviders,
      );
    if (
      input.requiredProviders === undefined &&
      input.requiredProviderRequirements === undefined &&
      input.compatibilityReport === undefined &&
      requiredProviderRequirements.length === 0
    ) {
      const resolvedBindings = await this.#resolveCapsuleProviderBindings(
        input.capsule,
      );
      if (resolvedBindings.length > 0) {
        requiredProviderRequirements = providerRequirementsFromResolvedBindings(
          resolvedBindings,
        );
        requiredProviders = normalizeProviders(
          requiredProviderRequirements.map((requirement) => requirement.source),
        );
      }
    }
    const capsulePlan = await this.#planResolution.resolveCapsulePlan(
      input.capsule,
      providerBindingResolutionRequirements(
        requiredProviderRequirements,
        profile,
      ),
    );
    const sourceFiles = await this.#sourceModuleFilesForGenericCapsule(
      input.compatibilityReport,
      input.snapshot,
      input.modulePath,
      { skipReady: input.skipReadySourceFileDiscovery === true },
    );
    const declaredInputs = declaredGenericCapsuleInputs(
      sourceFiles,
      input.compatibilityReport?.rootModuleVariables,
    );
    const explicitVariables = mergeInstallContextVariables(
      input.installConfig.variableMapping,
      input.installConfig.installContextVariableMapping,
      {
        workspaceId: input.capsule.workspaceId,
        capsuleId: input.capsule.id,
      },
    );
    const baseVariables = normalizeVariables(
      mergeJsonVariableDefaults(
        capsulePlan.providerInputDefaults,
        requestedGenericCapsuleVariables(
          explicitVariables,
          capsulePlan.providerInputDefaults,
          declaredInputs,
        ),
      ),
    );
    const capsuleExecutionAuthorityEpoch =
      await this.#store.getCapsuleExecutionAuthorityEpoch(input.capsule.id);
    if (
      typeof capsuleExecutionAuthorityEpoch !== "number" ||
      !Number.isSafeInteger(capsuleExecutionAuthorityEpoch) ||
      capsuleExecutionAuthorityEpoch < 1
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "Capsule execution authority is unavailable for module-variable materialization",
      );
    }
    const moduleVariableMaterialization =
      await this.#materializeModuleVariablesForPlan({
        capsule: input.capsule,
        installConfig: input.installConfig,
        capsuleExecutionAuthorityEpoch,
        resolvedProviderBindings: capsulePlan.resolvedProviderBindings,
        variables: baseVariables,
      });
    const variables = normalizeVariables({
      ...baseVariables,
      ...(moduleVariableMaterialization?.variables ?? {}),
    });
    const interfaceMaterialization = input.operation === "destroy"
      ? undefined
      : await pinCapsuleInterfaceBlueprints({
          installConfigId: input.installConfig.id,
          blueprints: input.installConfig.interfaceBlueprints,
        });
    const runtimeInputWiring = runtimeInputWiringFromResolved(
      capsulePlan.resolvedProviderBindings,
    );
    return {
      capsulePlan,
      requiredProviderRequirements,
      capsulePlanExecutionAuthority: {
        workspaceId: input.capsule.workspaceId,
        capsuleId: input.capsule.id,
        installConfigId: input.installConfig.id,
        installConfigDigest: await stableJsonDigest(input.installConfig),
        capsuleExecutionAuthorityEpoch,
        ...(input.operation === "destroy"
          ? {
              // Preserve the exact no-state cursor too. `undefined` would
              // disable the final re-read fence and let a generation-0 → 1
              // Apply race mint a destroy Plan from an obsolete Capsule.
              currentStateVersionId: input.capsule.currentStateVersionId ?? null,
              currentStateGeneration: input.capsule.currentStateGeneration,
            }
          : {}),
      },
      request: {
        workspaceId: input.capsule.workspaceId,
        capsuleId: input.capsule.id,
        source: moduleSource,
        operation: input.operation,
        runnerProfileId: profile.id,
        requiredProviderRequirements,
        requiredProviders,
        ...(Object.keys(variables).length > 0 ? { variables } : {}),
      },
      genericRootPlan: {
        providerBindings: capsulePlan.providerBindings,
        resolvedProviderBindings: capsulePlan.resolvedProviderBindings,
        outputAllowlist: input.installConfig.outputAllowlist,
        ...(runtimeInputWiring
          ? {
              runtimeInputWiring,
              runtimeInputAuthority: {
                workspaceId: input.capsule.workspaceId,
                capsuleId: input.capsule.id,
                installConfigId: input.installConfig.id,
              },
            }
          : {}),
        ...(input.installConfig.sourceBuild
          ? { sourceBuild: input.installConfig.sourceBuild }
          : {}),
        ...(moduleVariableMaterialization
          ? { moduleVariableMaterialization }
          : {}),
        ...(interfaceMaterialization ? { interfaceMaterialization } : {}),
      },
    };
  }

  async #materializeModuleVariablesForPlan(input: {
    readonly capsule: Capsule;
    readonly installConfig: InstallConfig;
    readonly capsuleExecutionAuthorityEpoch: number;
    readonly resolvedProviderBindings: readonly ResolvedCapsuleProviderBinding[];
    readonly variables: Readonly<Record<string, JsonValue>>;
  }): Promise<CapsuleModuleVariableMaterialization | undefined> {
    if (!hasModuleVariableMaterialization(input.installConfig)) {
      return undefined;
    }
    if (!this.#moduleVariableMaterializer) {
      throw moduleVariableMaterializationError(
        "host materializer is unavailable",
      );
    }
    const materializerVariables = moduleVariableMaterializerInputVariables(
      input.installConfig,
      input.variables,
    );
    let result: CapsuleModuleVariableMaterialization | undefined;
    try {
      result = await this.#moduleVariableMaterializer.materialize({
        phase: "plan",
        capsuleExecutionAuthorityEpoch:
          input.capsuleExecutionAuthorityEpoch,
        capsule: input.capsule,
        installConfig: input.installConfig,
        resolvedProviderBindings: input.resolvedProviderBindings,
        variables: materializerVariables,
      });
    } catch (error) {
      throw moduleVariableMaterializationError(errorMessage(error));
    }
    return requireValidModuleVariableMaterialization(
      input.installConfig,
      result,
    );
  }

  async #revalidateModuleVariableMaterialization(
    planRun: PlanRun,
    inputs: PlanRunInputs | undefined,
    phase: "apply_check" | "apply",
  ): Promise<void> {
    const expectedDigest = inputs?.moduleVariableMaterializationDigest;
    if (!planRun.capsuleContext || !planRun.capsuleId) {
      if (expectedDigest) {
        throw moduleVariableMaterializationError(
          "a non-Capsule Plan cannot carry a materialization digest",
        );
      }
      return;
    }
    const capsule = await this.#requireCapsule(planRun.capsuleId);
    const installConfig = await this.#store.getInstallConfig(
      capsule.installConfigId,
    );
    if (!installConfig) {
      throw moduleVariableMaterializationError(
        `InstallConfig ${capsule.installConfigId} is missing`,
      );
    }
    const declared = hasModuleVariableMaterialization(installConfig);
    if (!expectedDigest && !declared) return;
    if (!expectedDigest) {
      throw moduleVariableMaterializationError(
        "the declaration appeared after Plan and has no pinned digest",
      );
    }
    if (!inputs) {
      throw moduleVariableMaterializationError(
        "the Plan input sidecar is missing",
      );
    }
    if (!this.#moduleVariableMaterializer) {
      throw moduleVariableMaterializationError(
        "host materializer is unavailable",
      );
    }
    const resolvedProviderBindings =
      (await this.#resolveRunProviderBindings(planRun)) ?? [];
    const materializerVariables = moduleVariableMaterializerInputVariables(
      installConfig,
      inputs.variables,
    );
    const plannedVariables = moduleVariableMaterializerPlannedVariables(
      installConfig,
      inputs.variables,
    );
    let result: CapsuleModuleVariableMaterialization | undefined;
    try {
      result = await this.#moduleVariableMaterializer.materialize({
        phase,
        expectedDigest,
        plannedVariables,
        capsuleExecutionAuthorityEpoch:
          planRun.capsuleExecutionAuthorityEpoch ?? 1,
        capsule,
        installConfig,
        resolvedProviderBindings,
        variables: materializerVariables,
      });
    } catch (error) {
      throw moduleVariableMaterializationError(errorMessage(error));
    }
    const current = requireValidModuleVariableMaterialization(
      installConfig,
      result,
    );
    if (current.digest !== expectedDigest) {
      throw moduleVariableMaterializationError(
        "digest changed since Plan",
      );
    }
    assertPinnedModuleVariableValues(inputs.variables, current);
  }

  /**
   * Resolves the Plan-time wiring for run-scoped sensitive provider inputs.
   *
   * Value-free throughout: it derives the plan-stable nonce and pins the exact
   * deliverable name set, but never opens the sealed material. The values are
   * minted only at Apply, by the credential broker.
   *
   * Two situations leave the path inert rather than failing the Run:
   *   - a destroy plan, whose provider teardown reads neither argument and for
   *     which no value may be minted at all; and
   *   - a Capsule whose pinned provider version does not PROVE the provider
   *     accepts the arguments, which is reported as a value-free warning so a
   *     Capsule that does not need run-scoped inputs still plans.
   */
  async #runtimeInputsForPlan(
    context: GenericRootPlanContext,
    input: {
      readonly destroy: boolean;
      readonly rootProviderRequirements: readonly RootProviderRequirement[];
    },
  ): Promise<
    | {
        readonly descriptor?: DispatchRuntimeInputs;
        readonly rootWiring?: ResolvedRootRuntimeInputs;
        readonly diagnostic?: RunDiagnostic;
      }
    | undefined
  > {
    const wiring = context.runtimeInputWiring;
    const authority = context.runtimeInputAuthority;
    if (!wiring || !authority) return undefined;
    if (input.destroy) {
      // A destroy plan's provider teardown never reads the map, and both
      // arguments are optional on the provider block. Minting material for a
      // teardown would widen exposure for no purpose, and pinning a descriptor
      // would block the very teardown that is the recovery path for a Capsule
      // whose profile has drifted.
      return undefined;
    }
    const pinnedVersion = input.rootProviderRequirements.find(
      (requirement) =>
        requirement.moduleLocalName === wiring.moduleLocalName &&
        requirement.childAlias === undefined,
    )?.version;
    if (
      !providerVersionMeetsRuntimeInputFloor(
        pinnedVersion,
        wiring.minimumProviderVersion,
      )
    ) {
      return {
        diagnostic: {
          severity: "warning",
          code: RUNTIME_INPUTS_PROVIDER_VERSION_UNPROVEN_REASON,
          message:
            `run-scoped sensitive provider inputs stay inert: provider ` +
            `${wiring.moduleLocalName} is not pinned to an exact version of at ` +
            `least ${wiring.minimumProviderVersion}, which is the first release ` +
            `that accepts them`,
          ...(pinnedVersion ? { detail: `pinned version ${pinnedVersion}` } : {}),
        },
      };
    }
    const materializer = this.#runtimeInputMaterializer;
    if (!materializer) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "run-scoped sensitive provider inputs are declared but no runtime input materializer is configured",
        { reason: RUNTIME_INPUT_MATERIALIZER_UNAVAILABLE_REASON },
      );
    }
    let profile;
    try {
      profile = await materializer.profile(authority);
    } catch (error) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `run-scoped sensitive provider inputs have no manifest-gated runtime binding profile: ${errorMessage(error)}`,
        { reason: RUNTIME_INPUTS_PROFILE_MISSING_REASON },
      );
    }
    // Every materializer failure is a precondition on Capsule material, not an
    // internal fault: a raw throw here would surface as an opaque 500.
    let nonce: string;
    try {
      nonce = await materializer.nonce({
        ...authority,
        providerInstance: wiring.providerInstance,
      });
    } catch (error) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `run-scoped sensitive provider input material is not usable: ${errorMessage(error)}`,
        { reason: RUNTIME_INPUTS_MATERIAL_UNUSABLE_REASON },
      );
    }
    return {
      descriptor: {
        contract: "takosumi.dispatch-runtime-inputs/v1",
        variableName: wiring.variableName,
        providerInstance: wiring.providerInstance,
        nonce,
        names: [...profile.names].sort(),
        profileDigest: profile.profileDigest,
      },
      rootWiring: {
        moduleLocalName: wiring.moduleLocalName,
        ...(wiring.rootAlias ? { rootAlias: wiring.rootAlias } : {}),
        nonce,
        nonceArgument: wiring.nonceArgument,
        mapArgument: wiring.mapArgument,
      },
    };
  }

  async #genericRootDispatchForRequest(
    request: CreatePlanRunRequest,
    context: GenericRootPlanContext,
    compatibilityReport: CapsuleCompatibilityReport | undefined,
  ): Promise<GenericRootDispatchContext> {
    if (context.moduleVariableMaterialization) {
      assertPinnedModuleVariableValues(
        request.variables,
        context.moduleVariableMaterialization,
      );
    }
    const interfaceWorkspaceId = request.workspaceId;
    const interfaceCapsuleId = request.capsuleId;
    const interfaceSources =
      interfaceWorkspaceId && interfaceCapsuleId && this.#interfaceOutputSources
        ? await this.#interfaceOutputSources({
            workspaceId: interfaceWorkspaceId,
            capsuleId: interfaceCapsuleId,
          })
        : [];
    // A destroy plan consumes the existing state and does not publish new
    // Outputs. Re-emitting historical output projections can make teardown
    // impossible when a newer source no longer declares one of those outputs.
    // Keep the generated destroy root output-free; pre-destroy lifecycle hooks
    // read the last committed Output ledger row instead.
    const destroy = request.operation === "destroy";
    const workspaceOutputAllowlist = destroy
      ? {}
      : genericCapsuleWorkspaceOutputAllowlist(
          context.outputAllowlist,
          undefined,
          compatibilityReport?.rootModuleOutputs,
          interfaceSources,
        );
    const outputAllowlist = destroy ? {} : context.outputAllowlist;
    const rootProviderRequirements =
      rootProviderRequirementsForGeneratedRoot(
        request.requiredProviderRequirements ?? [],
      );
    const runtimeInputs = await this.#runtimeInputsForPlan(context, {
      destroy,
      rootProviderRequirements,
    });
    const wrapperProviderBindings = runtimeInputs?.rootWiring
      ? providerBindingsFromResolved(
          context.resolvedProviderBindings ?? [],
          runtimeInputs.rootWiring,
        )
      : context.providerBindings;
    let generatedRoot: DispatchGeneratedRoot | undefined;
    if (wrapperProviderBindings.length > 0) {
      try {
        generatedRoot = generateOpenTofuChildModuleRoot({
          rootProviderRequirements,
          inputs: normalizeVariables(request.variables),
          outputAllowlist: workspaceOutputAllowlist,
          providerBindings: wrapperProviderBindings,
        });
      } catch (error) {
        throw rootgenErrorForController(error);
      }
    }
    if (runtimeInputs?.descriptor && !generatedRoot) {
      // Without a generated root Takosumi does not own any provider block, so
      // there is structurally nowhere to declare the ephemeral variable or the
      // two provider arguments. Fail closed instead of silently dropping them.
      throw new OpenTofuControllerError(
        "failed_precondition",
        "run-scoped sensitive provider inputs require a Takosumi-generated root",
        { reason: RUNTIME_INPUTS_REQUIRE_GENERATED_ROOT_REASON },
      );
    }
    return {
      ...(generatedRoot ? { generatedRoot } : {}),
      ...(runtimeInputs?.descriptor
        ? { runtimeInputs: [runtimeInputs.descriptor] }
        : {}),
      ...(runtimeInputs?.diagnostic
        ? { diagnostics: [runtimeInputs.diagnostic] }
        : {}),
      workspaceOutputAllowlist,
      outputAllowlist,
      ...(context.sourceBuild ? { sourceBuild: context.sourceBuild } : {}),
      ...(context.lifecycleActions
        ? { lifecycleActions: context.lifecycleActions }
        : {}),
      ...(context.moduleVariableMaterialization
        ? {
            moduleVariableMaterializationDigest:
              context.moduleVariableMaterialization.digest,
          }
        : {}),
      ...(context.interfaceMaterialization
        ? { interfaceMaterialization: context.interfaceMaterialization }
        : {}),
    };
  }

  async #defaultGenericRootDispatchForPlanRun(
    request: CreatePlanRunRequest,
    capsule: Capsule,
    compatibilityReportId: string | undefined,
    requiredProviderRequirements: readonly CapsuleProviderRequirement[],
  ): Promise<GenericRootDispatchContext> {
    const installConfig = await this.#store.getInstallConfig(
      capsule.installConfigId,
    );
    if (!installConfig) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `install_config_not_found: ${capsule.installConfigId}`,
        { reason: "install_config_not_found" },
      );
    }
    const compatibilityReport = compatibilityReportId
      ? await this.#store.getCapsuleCompatibilityReport(compatibilityReportId)
      : undefined;
    const requiredProviders = normalizeProviders(
      request.requiredProviders ??
        (compatibilityReport?.providerPackages ?? [])
          .filter((providerPackage) => providerPackage.allowed)
          .map((providerPackage) => providerPackage.source),
    );
    const profile = await this.#requireRunnerProfile(
      request.runnerProfileId ?? this.#defaultRunnerProfileId,
    );
    const lifecycleActions = lifecycleActionsForPlan(installConfig, profile);
    const interfaceMaterialization = request.operation === "destroy"
      ? undefined
      : await pinCapsuleInterfaceBlueprints({
          installConfigId: installConfig.id,
          blueprints: installConfig.interfaceBlueprints,
        });
    const resolved = await this.#resolveCapsuleProviderBindingsForRun(
      capsule,
      providerBindingResolutionRequirements(
        requiredProviderRequirements,
        profile,
      ),
    );
    const runtimeInputWiring = runtimeInputWiringFromResolved(resolved);
    return await this.#genericRootDispatchForRequest(
      { ...request, requiredProviders, requiredProviderRequirements },
      {
        providerBindings: providerBindingsFromResolved(resolved),
        resolvedProviderBindings: resolved,
        outputAllowlist: installConfig.outputAllowlist,
        ...(runtimeInputWiring
          ? {
              runtimeInputWiring,
              runtimeInputAuthority: {
                workspaceId: capsule.workspaceId,
                capsuleId: capsule.id,
                installConfigId: installConfig.id,
              },
            }
          : {}),
        ...(installConfig.sourceBuild
          ? { sourceBuild: installConfig.sourceBuild }
          : {}),
        ...(lifecycleActions ? { lifecycleActions } : {}),
        ...(interfaceMaterialization ? { interfaceMaterialization } : {}),
      },
      compatibilityReport,
    );
  }

  async #sourceModuleFilesForGenericCapsule(
    report: CapsuleCompatibilityReport | undefined,
    sourceSnapshot: SourceSnapshot,
    modulePath: string | undefined,
    options: { readonly skipReady?: boolean } = {},
  ): Promise<readonly OpenTofuCapsuleSourceFile[] | undefined> {
    if (!report) return undefined;
    if (report.level !== "ready") return undefined;
    if (options.skipReady) return undefined;
    if (!this.#sourcesService) return undefined;
    try {
      return await this.#sourcesService.readCapsuleSourceFiles(
        sourceSnapshot,
        modulePath ? { modulePath } : undefined,
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Run-scoped provider env binding resolution. Required providers must be
   * covered by ProviderBindings. A public operator-managed connection is still
   * matched by its explicit provider source; Core never widens by family.
   * Lazily constructs the shared {@link ConnectionsService} so the SAME instance
   * resolves provider env bindings for rootgen (via {@link PlanResolutionService}) and for the
   * mint path (`#resolveRunProviderBindings`).
   */
  #resolveCapsuleProviderBindingsForRun(
    capsule: Capsule,
    requiredProviders: readonly CapsuleProviderRequirement[],
  ): Promise<readonly ResolvedCapsuleProviderBinding[]> {
    this.#connectionsService ??= new ConnectionsService({
      store: this.#store,
      operatorProviderConnections: this.#operatorProviderConnections,
      allowOperatorScopedProviderConnections:
        this.#allowOperatorScopedProviderConnections,
    });
    return this.#connectionsService.resolveProviderBindingsForRun(
      capsule,
      requiredProviders,
    );
  }

  #resolveCapsuleProviderBindings(
    capsule: Capsule,
  ): Promise<readonly ResolvedCapsuleProviderBinding[]> {
    this.#connectionsService ??= new ConnectionsService({
      store: this.#store,
      operatorProviderConnections: this.#operatorProviderConnections,
      allowOperatorScopedProviderConnections:
        this.#allowOperatorScopedProviderConnections,
    });
    return this.#connectionsService.resolveProviderBindings(capsule);
  }

  #resolveCapsuleProviderBindingsForLegacyStoredRun(
    capsule: Capsule,
    requiredProviders: readonly CapsuleProviderRequirement[],
  ): Promise<readonly ResolvedCapsuleProviderBinding[]> {
    this.#connectionsService ??= new ConnectionsService({
      store: this.#store,
      operatorProviderConnections: this.#operatorProviderConnections,
      allowOperatorScopedProviderConnections:
        this.#allowOperatorScopedProviderConnections,
    });
    return this.#connectionsService.resolveProviderBindingsForLegacyStoredRun(
      capsule,
      requiredProviders,
    );
  }

  async #createLegacySourcelessDestroyPlan(input: {
    readonly capsule: Capsule;
    readonly runnerProfile: RunnerProfile;
    readonly context: DeployControlActorContext;
    readonly lifecycleActions?: InstallConfig["lifecycleActions"];
  }): Promise<PlanRunResponse> {
    const { capsule, runnerProfile } = input;
    const appliedPlan = await this.#currentStatePlanRunForCapsule(capsule);
    if (!appliedPlan || !isEligibleLegacySourcelessPlan(appliedPlan)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `capsule ${capsule.id} has no Git Source and is not an eligible pre-v1 source-less Capsule`,
        { reason: "legacy_sourceless_destroy_ineligible" },
      );
    }
    // Keep the legacy eligibility guard for a genuinely source-less PlanRun
    // with no provider identity at all. A historical builtin-only inventory is
    // explicit runtime-capability evidence, though, and must remain eligible
    // for provider-free teardown (for example a terraform_data-only state).
    const historicalProviders = normalizeProviders(
      appliedPlan.requiredProviders,
    );
    if (historicalProviders.length === 0) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `capsule ${capsule.id} legacy source-less plan has no provider identity`,
        { reason: "legacy_sourceless_destroy_ineligible" },
      );
    }
    const inventory = normalizeDestroyProviderInventory(
      historicalProviders,
      appliedPlan.requiredProviderRequirements,
    );
    const requiredProviders = inventory.requiredProviders;
    const requiredProviderRequirements = requiredProviderRequirementsForNewPlan(
      requiredProviders,
      inventory.exactRequirements,
      runnerProfile.requireProviderBindings === true,
    );
    const bindingRequirements = providerBindingResolutionRequirements(
      requiredProviderRequirements,
      runnerProfile,
    );
    const resolvedBindings =
      appliedPlan.requiredProviderRequirements === undefined
        ? await this.#resolveCapsuleProviderBindingsForLegacyStoredRun(
            capsule,
            bindingRequirements,
          )
        : await this.#resolveCapsuleProviderBindingsForRun(
            capsule,
            bindingRequirements,
          );
    const rootBindings = legacyDefaultProviderBindingsForSourcelessDestroy(
      resolvedBindings,
      requiredProviderRequirements,
    );
    const generatedRoot = generateOpenTofuChildModuleRoot({
      rootProviderRequirements: rootProviderRequirementsForGeneratedRoot(
        requiredProviderRequirements,
      ),
      inputs: {},
      outputAllowlist: {},
      providerBindings: providerBindingsFromResolved(rootBindings),
    });
    const childVersions =
      generatedRoot.files["versions.tf"] ?? "terraform {}\n";
    const sourceDigest = await stableJsonDigest({
      kind: "legacy_generated_root_destroy_recovery",
      capsuleId: capsule.id,
      appliedPlanRunId: appliedPlan.id,
      sourceSnapshotId: appliedPlan.sourceSnapshotId,
      requiredProviders,
      requiredProviderRequirements,
    });
    return await this.createPlanRun(
      {
        workspaceId: capsule.workspaceId,
        capsuleId: capsule.id,
        source: {
          kind: "operator_module",
          digest: sourceDigest,
        },
        operation: "destroy",
        requiredProviderRequirements,
        requiredProviders,
        runnerProfileId: runnerProfile.id,
      },
      input.context,
      {
        capsuleContext: {
          workspaceId: capsule.workspaceId,
          capsuleId: capsule.id,
          environment: capsule.environment,
        },
        baseStateGeneration: capsule.currentStateGeneration,
        legacySourcelessDestroyRecovery: true,
        genericRootDispatch: {
          generatedRoot,
          operatorModule: {
            files: [
              {
                path: "versions.tf",
                text: [
                  "# Delete-only bridge for state created by a retired pre-v1 source-less flow.",
                  childVersions,
                ].join("\n"),
              },
            ],
          },
          workspaceOutputAllowlist: {},
          outputAllowlist: {},
          ...(input.lifecycleActions
            ? { lifecycleActions: input.lifecycleActions }
            : {}),
        },
        ...(input.lifecycleActions
          ? { lifecycleActions: input.lifecycleActions }
          : {}),
      },
    );
  }

  async #currentStatePlanRunForCapsule(
    capsule: Capsule,
  ): Promise<PlanRun | undefined> {
    if (
      !Number.isSafeInteger(capsule.currentStateGeneration) ||
      capsule.currentStateGeneration <= 0 ||
      typeof capsule.currentStateVersionId !== "string" ||
      capsule.currentStateVersionId.trim() === ""
    ) {
      return undefined;
    }
    const current = await this.#store.getStateVersion(
      capsule.currentStateVersionId,
    );
    if (!current || !stateVersionMatchesCapsuleCurrent(capsule, current)) {
      return undefined;
    }
    return await this.#validatedPlanRunForStateVersion(
      capsule,
      current,
      new Set(),
    );
  }

  async #validatedPlanRunForStateVersion(
    capsule: Capsule,
    stateVersion: StateVersion,
    seenStateVersionIds: Set<string>,
  ): Promise<PlanRun | undefined> {
    if (
      seenStateVersionIds.has(stateVersion.id) ||
      seenStateVersionIds.size >= 64 ||
      !stateVersionMatchesCapsuleScope(capsule, stateVersion)
    ) {
      return undefined;
    }
    seenStateVersionIds.add(stateVersion.id);

    const applyRun = await this.#store.getApplyRun(stateVersion.createdByRunId);
    if (applyRun) {
      if (!applyRunMatchesStateVersion(capsule, stateVersion, applyRun)) {
        return undefined;
      }
      const planRun = await this.#store.getPlanRun(applyRun.planRunId);
      return planRun &&
        planRunMatchesAppliedState(capsule, stateVersion, applyRun, planRun)
        ? planRun
        : undefined;
    }

    const restoreRun = await this.#store.getBackupRun(
      stateVersion.createdByRunId,
    );
    if (!restoreRunMatchesStateVersion(capsule, stateVersion, restoreRun)) {
      return undefined;
    }
    const restoredState = await this.#store.getStateVersion(
      restoreRun.restoredFromStateVersionId!,
    );
    if (
      !restoredState ||
      !stateVersionMatchesCapsuleScope(capsule, restoredState) ||
      restoredState.generation >= stateVersion.generation
    ) {
      return undefined;
    }
    return await this.#validatedPlanRunForStateVersion(
      capsule,
      restoredState,
      seenStateVersionIds,
    );
  }

  async #sourceSnapshotIdForStateVersion(
    snapshot: StateVersion,
    seenStateVersionIds: Set<string>,
  ): Promise<string | undefined> {
    return (await this.#planRunForStateVersion(snapshot, seenStateVersionIds))
      ?.sourceSnapshotId;
  }

  async #planRunForStateVersion(
    snapshot: StateVersion,
    seenStateVersionIds: Set<string>,
  ): Promise<PlanRun | undefined> {
    if (seenStateVersionIds.has(snapshot.id)) return undefined;
    seenStateVersionIds.add(snapshot.id);

    const applyRun = await this.#store.getApplyRun(snapshot.createdByRunId);
    if (applyRun) {
      return await this.#store.getPlanRun(applyRun.planRunId);
    }

    const restoreRun = await this.#store.getBackupRun(snapshot.createdByRunId);
    if (
      restoreRun?.type !== "restore" ||
      !restoreRun.restoredFromStateVersionId
    ) {
      return undefined;
    }
    const restoredSource = (
      await this.#store.listStateVersions(
        snapshot.capsuleId,
        snapshot.environment,
      )
    ).find(
      (candidate) => candidate.id === restoreRun.restoredFromStateVersionId,
    );
    return restoredSource
      ? await this.#planRunForStateVersion(restoredSource, seenStateVersionIds)
      : undefined;
  }

  async createApplyRun(
    request: CreateApplyRunRequest,
    context: DeployControlActorContext = {},
    internal: ApplyRunInternalContext = {},
  ): Promise<ApplyRunResponse> {
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
    const exactApplyRunId = internal.applyRunId;
    if (exactApplyRunId !== undefined) {
      requireNonEmptyString(exactApplyRunId, "applyRunId");
      const exact = await this.#store.getApplyRun(exactApplyRunId);
      if (planRun.appliedApplyRunId) {
        if (planRun.appliedApplyRunId !== exactApplyRunId) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            `plan run ${planRun.id} was already applied by a different ApplyRun ${planRun.appliedApplyRunId}; exact recovery requires ${exactApplyRunId}`,
          );
        }
        if (!exact) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            `plan run ${planRun.id} points to missing exact ApplyRun ${exactApplyRunId}`,
          );
        }
      }
      if (exact) {
        await checkApplyExpected(request.expected, planRun);
        const exactProfile = await this.#requireRunnerProfile(
          planRun.runnerProfileId,
        );
        await assertApplyRunCreationAuthority(
          exact,
          planRun,
          exactProfile,
          request.expected,
        );
        await internal.onPrepared?.(exact);
        await this.#repairQueuedApplyRunDispatch(
          exact,
          planRun,
          exactProfile,
          request.expected,
        );
        const response = await this.getApplyRun(exactApplyRunId);
        assertExactApplyRunResponse(response, exactApplyRunId);
        return response;
      }
    }
    // SECURITY (apply-once / idempotency): a `create` plan never carries an
    // capsuleId, so without this guard each apply allocates a brand-new
    // Capsule + StateVersion (and real cloud resources). Replays of a
    // successfully-applied PlanRun are idempotent: return the existing apply
    // response instead of creating a visible failed run. (update/destroy were
    // already replay-protected by the capsule currentStateVersionId guard.)
    //
    // This is an OPTIMISTIC pre-check before the per-(Capsule,environment)
    // lease serializes the apply. Two concurrent createApplyRun calls can both
    // pass it and each insert an ApplyRun row + enqueue — wasteful, but NOT a
    // double-apply: the authoritative apply-once re-check runs INSIDE the
    // serialized section against the persisted PlanRun (see
    // `appliedApplyRunId` re-read in the commit path), so the second worker's
    // dispatch is folded into an idempotent replay before it commits any state
    // generation. The pre-check stays as a cheap early-out for the common
    // (non-concurrent) case.
    if (planRun.appliedApplyRunId) {
      await checkApplyExpected(request.expected, planRun);
      return await this.getApplyRun(planRun.appliedApplyRunId);
    }
    // Approval gate (spec §10.6 always-two-stage destroy / §25 action policy /
    // invariant 22). A destroy plan is "always two-stage", and an action-policy
    // delete/replace plan records `requiresApproval`: both must carry a RECORDED
    // approval (POST /runs/:id/approve, which sets planRun.approval) before they
    // can apply. The gate is enforced against exactly the set
    // `RunQueryService.planAwaitsApproval` reports — otherwise the §19 Run
    // projection would show `waiting_approval` (and the auto-apply hook would
    // refuse) while this route accepted the apply, making the review of the most
    // destructive changes display-only.
    if (
      !planRun.approval &&
      (planRun.operation === "destroy" || planRun.requiresApproval === true)
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} is awaiting approval; approve it (POST /runs/${planRun.id}/approve) before apply`,
      );
    }
    await checkApplyExpected(request.expected, planRun);
    if (planRun.capsuleId) {
      await this.#requireCurrentPlannedCapsule(planRun);
    }
    // Source snapshot revalidation (spec invariant 10): an env-driven plan is
    // pinned to a SourceSnapshot; the apply must run against the SAME snapshot
    // the plan was reviewed against. Re-read the persisted plan and confirm its
    // sourceSnapshotId is unchanged + still resolvable, mirroring the
    // digest/generation guards. Runs without a recorded snapshot are unaffected.
    await this.#verification.revalidateSourceSnapshot(planRun);
    const planInputs = await this.#requirePreparedPlanRunInputs(planRun);
    await this.#revalidateModuleVariableMaterialization(
      planRun,
      planInputs,
      "apply_check",
    );
    const profile = await this.#requireRunnerProfile(planRun.runnerProfileId);
    const now = this.#now();
    const approval = redactRunApproval(request.approval);
    const applyCapsuleId = planRun.capsuleId;
    const applyRun: ApplyRun = {
      id: exactApplyRunId ?? this.#newId("apply"),
      planRunId: planRun.id,
      workspaceId: planRun.workspaceId,
      ...(applyCapsuleId ? { capsuleId: applyCapsuleId } : {}),
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
    await internal.onPrepared?.(applyRun);
    const begun = await this.#store.beginApplyRun(applyRun);
    if (begun.status === "conflict") {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `ApplyRun id ${applyRun.id} is already bound to a different Run kind`,
      );
    }
    await assertApplyRunCreationAuthority(
      begun.run,
      planRun,
      profile,
      request.expected,
    );
    if (begun.status === "existing") {
      await this.#repairQueuedApplyRunDispatch(
        begun.run,
        planRun,
        profile,
        request.expected,
      );
      const response = await this.getApplyRun(applyRun.id);
      assertExactApplyRunResponse(response, applyRun.id);
      return response;
    }
    await this.#notifyApplyQueued(applyRun);
    if (!this.#hasRunnerForProfile(profile)) return { applyRun };
    // Hand off to the dispatch seam. The default inline dispatcher runs the
    // apply consumer synchronously and returns the terminal ApplyRunResponse;
    // the Workers producer enqueues and returns the queued ApplyRun immediately.
    await this.#enqueueRun({
      action: "apply",
      runId: applyRun.id,
      workspaceId: applyRun.workspaceId,
    });
    const dispatched = await this.getApplyRun(applyRun.id);
    return dispatched;
  }

  async #repairQueuedApplyRunDispatch(
    adopted: ApplyRun,
    planRun: PlanRun,
    profile: RunnerProfile,
    expected: ApplyExpectedGuard,
  ): Promise<void> {
    const current = await this.#store.getApplyRun(adopted.id);
    if (!current || current.status !== "queued") return;
    await assertApplyRunCreationAuthority(
      current,
      planRun,
      profile,
      expected,
    );
    await this.#notifyApplyQueued(current);
    if (!this.#hasRunnerForProfile(profile)) return;
    // Insert acknowledgement or process loss can leave the exact row queued
    // before its first enqueue. Redelivering a queued message is safe: the
    // queue consumer's queued -> running lease CAS admits at most one provider
    // execution, while a running or terminal row never reaches this branch.
    await this.#enqueueRun({
      action: "apply",
      runId: current.id,
      workspaceId: current.workspaceId,
    });
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
      readonly capsuleId: string;
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
        `restore:${leaseTarget.capsuleId}:${leaseTarget.environment}`,
        () => this.#executeRestore(run, handle),
      );
    if (this.#capsuleCoordination) {
      return await withCapsuleLease(
        this.#capsuleCoordination,
        {
          capsuleId: leaseTarget.capsuleId,
          environment: leaseTarget.environment,
          holderId: run.id,
        },
        runWork,
      );
    }
    return await runWork();
  }

  async #restoreLeaseTarget(run: Run): Promise<{
    readonly capsuleId: string;
    readonly environment: string;
  }> {
    if (!run.backupId || run.restoreStateGeneration === undefined) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "restore run is missing backupId or restoreStateGeneration",
      );
    }
    const backup = await this.#store.getBackupRecord(run.backupId);
    if (!backup || backup.workspaceId !== run.workspaceId) {
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
    const capsuleId = run.capsuleId ?? backup.capsuleId;
    if (!capsuleId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "restore run has no target Capsule",
      );
    }
    const capsule = await this.#store.getCapsule(capsuleId);
    if (!capsule || capsule.workspaceId !== run.workspaceId) {
      throw new OpenTofuControllerError(
        "not_found",
        `Capsule ${capsuleId} not found`,
      );
    }
    const environment =
      run.environment ?? backup.environment ?? capsule.environment;
    return { capsuleId: capsule.id, environment };
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
    await this.#notifyRestore({ phase: "started", run: claim.run });
    try {
      return await this.#withRunRenewal(
        "restore",
        claim.run,
        claim.leaseToken,
        lease,
        (signal) =>
          this.#completeRestoreRun(claim.run, claim.leaseToken, signal),
      );
    } catch (error) {
      await this.#failRestoreRun(claim.run, claim.leaseToken, error);
      throw error;
    }
  }

  async #completeRestoreRun(
    run: Run,
    leaseToken: string,
    signal: AbortSignal,
  ): Promise<Run> {
    signal.throwIfAborted();
    if (!run.backupId || run.restoreStateGeneration === undefined) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "restore run is missing backupId or restoreStateGeneration",
      );
    }
    const backup = await this.#store.getBackupRecord(run.backupId);
    if (!backup || backup.workspaceId !== run.workspaceId) {
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
    const capsuleId = run.capsuleId ?? backup.capsuleId;
    if (!capsuleId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "restore run has no target Capsule",
      );
    }
    const capsule = await this.#store.getCapsule(capsuleId);
    if (!capsule || capsule.workspaceId !== run.workspaceId) {
      throw new OpenTofuControllerError(
        "not_found",
        `Capsule ${capsuleId} not found`,
      );
    }
    const environment =
      run.environment ?? backup.environment ?? capsule.environment;
    // Restore provenance is an exact StateVersion identity, never a
    // generation-only lookup.  Generation numbers are scoped cursors and a
    // stale/replayed run must not be allowed to select another row that merely
    // happens to have the same generation.
    if (
      typeof run.restoredFromStateVersionId !== "string" ||
      run.restoredFromStateVersionId.trim() === ""
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "restore run is missing its exact source StateVersion identity",
      );
    }
    const source = await this.#store.getStateVersion(
      run.restoredFromStateVersionId,
    );
    if (
      !source ||
      source.id !== run.restoredFromStateVersionId ||
      source.workspaceId !== capsule.workspaceId ||
      source.capsuleId !== capsule.id ||
      source.environment !== environment ||
      source.generation !== run.restoreStateGeneration ||
      typeof source.stateRef !== "string" ||
      source.stateRef.trim() === "" ||
      typeof source.digest !== "string" ||
      source.digest.trim() === "" ||
      typeof source.createdByRunId !== "string" ||
      source.createdByRunId.trim() === ""
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `exact restore source StateVersion ${run.restoredFromStateVersionId} is missing or changed before dispatch`,
      );
    }
    const sourceState = restoreSourceStateFromStateVersion(source);
    // Bind the read-only authority to the selected StateVersion id, rather
    // than closing over its first read. Restore adapters must re-read this
    // exact row immediately before writing a target artifact so a source
    // update, deletion, or store outage fails closed.
    const sourceAuthority = {
      readExact: async () => {
        const exact = await this.#store.getStateVersion(source.id);
        return exact ? restoreSourceStateFromStateVersion(exact) : undefined;
      },
    };
    const sourceInterfaceMaterializationIntent =
      await this.#interfaceMaterializationIntentForState(source);
    if (!sourceInterfaceMaterializationIntent && capsule.currentStateVersionId) {
      const currentState = await this.#store.getStateVersion(
        capsule.currentStateVersionId,
      );
      const currentIntent = currentState
        ? await this.#interfaceMaterializationIntentForState(currentState)
        : undefined;
      if (currentIntent) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "restore_interface_snapshot_missing: the selected StateVersion has no exact durable Interface declaration; run a fresh Apply before restoring it",
        );
      }
    }
    const sourceOutput = sourceInterfaceMaterializationIntent
      ? await this.#store.getOutput(
          sourceInterfaceMaterializationIntent.outputId,
        )
      : latestOutputAtGeneration(
          await this.#store.listOutputs(capsule.id),
          source.generation,
        );
    if (sourceInterfaceMaterializationIntent) {
      if (!sourceOutput) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "restore_interface_output_missing: the selected Interface declaration has no exact Output snapshot; run a fresh Apply",
        );
      }
      if (
        sourceOutput.id !== sourceInterfaceMaterializationIntent.outputId ||
        sourceOutput.workspaceId !== sourceInterfaceMaterializationIntent.workspaceId ||
        sourceOutput.capsuleId !== sourceInterfaceMaterializationIntent.capsuleId ||
        sourceOutput.stateGeneration !==
          sourceInterfaceMaterializationIntent.stateGeneration ||
        sourceOutput.stateGeneration !== source.generation
      ) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "restore_interface_output_mismatch: the exact Output snapshot does not match its durable Interface declaration",
        );
      }
    }
    const restoreServiceData = run.restoreServiceData === true;
    const restoreProfile = await this.#requireRunnerProfile(
      this.#defaultRunnerProfileId,
    );
    const restoreRunner = this.#runnerExecutors.get(restoreProfile.executorId);
    // Restore is a destructive state transition. A composed runner that does
    // not implement the exact capability must fail before allocating or
    // committing a target StateVersion; an absent method is never a successful
    // no-op and must not be replaced with a synthetic source digest.
    if (!restoreRunner || typeof restoreRunner.restore !== "function") {
      throw new OpenTofuControllerError(
        "not_implemented",
        "restore requires a restore-capable runner",
      );
    }
    if (restoreServiceData && typeof restoreRunner.restoreServiceData !== "function") {
      throw new OpenTofuControllerError(
        "not_implemented",
        "service-data restore requires a service-data restore-capable runner",
      );
    }
    const latest = await this.#store.getLatestStateVersion(
      capsule.id,
      environment,
    );
    const nextGeneration =
      Math.max(capsule.currentStateGeneration, latest?.generation ?? 0) + 1;
    const nowMs = this.#now();
    const now = new Date(nowMs).toISOString();
    const allocator = this.#artifactReferenceAllocator;
    if (!allocator) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "restore requires an artifact-reference allocator",
      );
    }
    const stateRef = await allocator.allocate({
      kind: "state",
      workspaceId: capsule.workspaceId,
      subject: { kind: "capsule", id: capsule.id },
      environment,
      generation: nextGeneration,
    });
    if (!stateRef.trim()) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "artifact-reference allocator returned an empty stateRef for restore",
      );
    }
    const stateScope = {
      workspaceId: capsule.workspaceId,
      subject: { kind: "capsule" as const, id: capsule.id },
      environment,
      generation: nextGeneration,
      stateRef,
    };
    if (restoreServiceData && !backup.serviceData) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "backup service-data artifact disappeared before restore dispatch",
      );
    }
    const restoreResult = await restoreRunner.restore(
      {
        runId: run.id,
        stateScope,
        sourceState,
      },
      { signal, sourceAuthority },
    );
    signal.throwIfAborted();
    assertRestoreRunnerResult(
      restoreResult,
      run.id,
      stateRef,
      nextGeneration,
    );
    const restoredServiceData = restoreServiceData
      ? await restoreRunner.restoreServiceData!(
          {
            runId: run.id,
            stateScope,
            sourceState,
            serviceData: backup.serviceData!,
          },
          { signal, sourceAuthority },
        )
      : undefined;
    signal.throwIfAborted();
    if (restoreServiceData && restoredServiceData?.status !== "restored") {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "runner did not confirm service-data restore",
      );
    }
    const restoredState: StateVersion = {
      id: this.#newId("state"),
      workspaceId: capsule.workspaceId,
      capsuleId: capsule.id,
      environment,
      generation: nextGeneration,
      // The DB row points at the immutable operation artifact attested by the
      // runner. `stateRef` above is only the host-allocated logical target
      // coordinate and is intentionally not used as the physical artifact ref.
      stateRef: restoreResult.state.stateRef,
      digest: restoreResult.state.digest,
      createdByRunId: run.id,
      createdAt: now,
    };
    const restoredOutput: Output | undefined = sourceOutput
      ? {
          ...sourceOutput,
          id: this.#newId("out"),
          stateGeneration: nextGeneration,
          createdAt: now,
        }
      : undefined;
    const previousOutput = capsule.currentOutputId
      ? await this.#store.getOutput(capsule.currentOutputId)
      : undefined;
    const completed: Run = {
      ...run,
      status: "succeeded",
      heartbeatAt: nowMs,
      restoredStateVersionId: restoredState.id,
      ...(restoredServiceData ? { restoredServiceData } : {}),
      finishedAt: now,
    };
    signal.throwIfAborted();
    const committed = await this.#store.commitRestoredState({
      stateVersion: restoredState,
      ...(restoredOutput ? { output: restoredOutput } : {}),
      capsulePatch: {
        id: capsule.id,
        patch: {
          currentStateVersionId: restoredState.id,
          currentStateGeneration: nextGeneration,
          currentOutputId: restoredOutput?.id,
          status: "stale",
          updatedAt: now,
        },
        guard: {
          currentStateVersionId: capsule.currentStateVersionId,
          currentStateGeneration: capsule.currentStateGeneration,
          status: capsule.status,
        },
      },
      restoreRunTerminal: completed,
      restoreRunLeaseToken: leaseToken,
      ...(sourceInterfaceMaterializationIntent && restoredOutput
        ? {
            interfaceMaterializationReplacement: {
              sourceIntentId: sourceInterfaceMaterializationIntent.id,
              intent: createRestoredCapsuleInterfaceMaterializationIntent({
                restoreRunId: run.id,
                sourceIntent: sourceInterfaceMaterializationIntent,
                stateVersionId: restoredState.id,
                outputId: restoredOutput.id,
                stateGeneration: nextGeneration,
                createdAt: now,
              }),
            },
          }
        : {}),
    });
    if (committed.restoreRunLeaseLost) {
      return (await this.#store.getBackupRun(run.id)) ?? run;
    }
    if (!committed.capsule) {
      throw new OpenTofuControllerError(
        "not_found",
        `Capsule ${capsule.id} disappeared before Restore commit`,
      );
    }
    await this.#notifyRestore({ phase: "succeeded", run: completed });
    if (restoredOutput) {
      await this.#markDownstreamCapsulesStale({
        capsule,
        previousOutput,
        newOutput: restoredOutput,
        now: nowMs,
      });
    }
    await this.#recordActivity({
      workspaceId: run.workspaceId,
      action: "restore.succeeded",
      targetType: "run",
      targetId: run.id,
      runId: run.id,
      metadata: {
        backupId: backup.id,
        capsuleId: capsule.id,
        environment,
        restoredStateVersionId: restoredState.id,
        restoredFromStateVersionId: source.id,
        restoredFromGeneration: source.generation,
        currentStateGeneration: nextGeneration,
        ...(restoredServiceData
          ? {
              restoredServiceDataRef: restoredServiceData.ref,
              restoredServiceDataDigest: restoredServiceData.digest,
              restoredServiceDataCount: restoredServiceData.restoredCount ?? 0,
            }
          : {}),
      },
    });
    return completed;
  }

  async #interfaceMaterializationIntentForState(
    state: StateVersion,
  ): Promise<CapsuleInterfaceMaterializationIntent | undefined> {
    const candidateIds = [
      capsuleInterfaceMaterializationIntentId(state.createdByRunId),
      restoredCapsuleInterfaceMaterializationIntentId(state.createdByRunId),
    ];
    for (const id of candidateIds) {
      const intent =
        await this.#store.getCapsuleInterfaceMaterializationIntent(id);
      if (!intent) continue;
      if (
        intent.workspaceId !== state.workspaceId ||
        intent.capsuleId !== state.capsuleId ||
        intent.stateVersionId !== state.id ||
        intent.stateGeneration !== state.generation
      ) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "restore_interface_snapshot_mismatch: the durable Interface declaration does not match its StateVersion",
        );
      }
      return intent;
    }
    return undefined;
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
    action: "plan" | "apply" | "restore" | "source_sync",
    runId: string,
    reason: string,
  ): Promise<boolean> {
    if (action === "source_sync") {
      const run = await this.#store.getSourceSyncRun(runId);
      if (!run || run.status === "succeeded" || run.status === "failed") {
        return false;
      }
      const now = this.#now();
      const finishedAt = new Date(now).toISOString();
      const failed: SourceSyncRun = {
        ...run,
        status: "failed",
        heartbeatAt: now,
        finishedAt,
        updatedAt: finishedAt,
        error: reason,
      };
      const result = await this.#store.transitionRun({
        id: run.id,
        kind: "source_sync",
        expectFrom: [run.status],
        run: failed,
        clearLeaseToken: true,
        heartbeatAt: now,
      });
      return result.won;
    }
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
      if (result.won) {
        await this.#notifyRestore({ phase: "failed", run: failed });
      }
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
    let inputs: PlanRunInputs;
    try {
      inputs = await this.#requirePreparedPlanRunInputs(planRun);
    } catch (error) {
      await this.#store.deletePlanRunInputs(runId);
      return await this.#failPlanRun(planRun, undefined, error);
    }
    const profile = await this.#requireRunnerProfile(planRun.runnerProfileId);
    // An asynchronous dispatcher is execution authority: a missing explicit executor
    // binding is a hard configuration failure, never a silent fallback.
    this.#runnerForProfile(profile);
    try {
      planRun = await this.#ensureQueuedPlanCompatibilityReport(planRun);
    } catch (error) {
      await this.#store.deletePlanRunInputs(runId);
      return await this.#failPlanRun(planRun, undefined, error);
    }
    // The sidecar is sealed at rest when a sensitive dependency value was
    // injected. Preparation verification above unseals it and checks the whole
    // plaintext bundle against the digest committed with the queue-visible Run.
    const variables = inputs.variables;
    const dispatch = moduleDispatchFromInputs(inputs);
    try {
      await this.#verification.assertCapsuleCompatibilityAllowsRun(planRun);
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
        runEnvironment,
        dispatch,
      );
    } catch (error) {
      if (isRunnerInfrastructureRequeueError(error)) throw error;
      await this.#store.deletePlanRunInputs(runId);
      const failedRun = runEnvironmentFailedRun(running, error);
      return await this.#failPlanRun(failedRun, claim.leaseToken, error);
    }
    // Retain the inputs sidecar for an applyable Capsule run: direct-root runs
    // also need the same variables, Output policy, source build, and lifecycle
    // actions reviewed by plan. An applyable plan is one that
    // completed `succeeded`, OR parked `waiting_approval` (it becomes applyable
    // once approved — the sidecar must survive the approval gate). It is deleted
    // once the plan is applied (apply-once) or the run is failed. Other terminal
    // plans drop the sidecar now.
    const retainForApply =
      (result.status === "succeeded" || result.status === "waiting_approval") &&
      inputs !== undefined;
    if (!retainForApply) {
      await this.#store.deletePlanRunInputs(runId);
    }
    return result;
  }

  /**
   * Apply consumer. Idempotency + stale-heartbeat takeover, generation
   * pre-flight, credential mint, and serialized execution on the capsule
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
    if (
      (applyRun.status === "succeeded" || applyRun.status === "failed") &&
      (applyRunBillingCapturePending(applyRun) ||
        applyRunRuntimeSecretRetirementPending(applyRun))
    ) {
      const planRun = await this.#requirePlanRun(applyRun.planRunId);
      let finalized = await this.#tryFinalizeApplyBilling(planRun, applyRun);
      finalized = await this.#tryFinalizeRuntimeSecretRetirement(
        planRun,
        finalized,
      );
      const capsule = finalized.capsuleId
        ? await this.#store.getCapsule(finalized.capsuleId)
        : undefined;
      return {
        applyRun: finalized,
        ...(capsule ? { capsule } : {}),
      };
    }
    if (!this.#shouldProcessRun(applyRun.status, applyRun.heartbeatAt)) {
      return await this.getApplyRun(runId);
    }
    const planRun = await this.#requirePlanRun(applyRun.planRunId);
    const profile = await this.#requireRunnerProfile(applyRun.runnerProfileId);
    this.#runnerForProfile(profile);
    // Generated-root dispatch for apply: re-read and authenticate the retained
    // preparation bundle so apply runs tofu in the SAME generated root and
    // policy/runtime context that the plan reviewed.
    let inputs: PlanRunInputs | undefined;
    if (!planRun.appliedApplyRunId) {
      try {
        inputs = await this.#requirePreparedPlanRunInputs(planRun);
      } catch (error) {
        await this.#store.deletePlanRunInputs(planRun.id);
        const failed = await this.#failApplyRun(
          applyRun,
          undefined,
          profile,
          applyRun.startedAt ?? applyRun.createdAt,
          planRun.operation === "destroy" ? "destroy.failed" : "apply.failed",
          error,
        );
        const capsule = failed.capsuleId
          ? await this.#store.getCapsule(failed.capsuleId)
          : undefined;
        return { applyRun: failed, ...(capsule ? { capsule } : {}) };
      }
    }
    const dispatch = moduleDispatchFromInputs(inputs);
    const key = planRun.capsuleId ?? planRun.id;
    // Capsule lease (spec §22 / §23): when a durable coordination seam is
    // wired, acquire the cross-isolate
    // `capsule:{capsuleId}:{environment}` lease so only one write Run per
    // (Capsule, environment) executes at a time. A busy lease throws so
    // the queue redelivers. The in-process serialization stays as the inner
    // guard (single-isolate correctness). The held-lease handle is threaded into
    // #executeApply so a long apply can renew the lease + re-stamp its heartbeat
    // while a single blocking runner fetch is in flight.
    const runWork = (handle?: LeaseHandle) =>
      this.#runSerialized(key, () =>
        this.#executeApply(
          applyRun,
          planRun,
          profile,
          dispatch,
          inputs,
          handle,
        ),
      );
    let response: ApplyRunExecutionResponse;
    if (this.#capsuleCoordination && planRun.capsuleId) {
      const environment =
        planRun.capsuleContext?.environment ??
        (await this.#requireCapsule(planRun.capsuleId)).environment;
      response = await withCapsuleLease(
        this.#capsuleCoordination,
        {
          capsuleId: planRun.capsuleId,
          environment,
          holderId: applyRun.id,
        },
        runWork,
      );
    } else {
      // SECURITY (apply-once / S5): a `create` plan has no capsuleId yet, so
      // the capsule lease above cannot cover it. Without a cross-isolate
      // guard two concurrent create-applies of the SAME plan both observe
      // `appliedApplyRunId` undefined and each allocate a brand-new Capsule +
      // apply (real duplicate cloud resources). Take the `plan:{planRunId}`
      // lease so create-applies serialize; the inner #executeApply re-reads the
      // persisted PlanRun and rejects a sibling that already marked it applied.
      if (this.#capsuleCoordination) {
        response = await withPlanLease(
          this.#capsuleCoordination,
          { planRunId: planRun.id, holderId: applyRun.id },
          runWork,
        );
      } else {
        response = await runWork();
      }
    }
    await this.#notifyPostApplyLeaseReleased(response);
    return response;
  }

  /**
   * Idempotency predicate for the RunOwner. Proceed when the run is still
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
      planRun.operation === "destroy" ||
      planRun.compatibilityReportId ||
      !planRun.capsuleId ||
      !planRun.sourceSnapshotId ||
      !this.#sourcesService
    ) {
      return planRun;
    }
    const capsule = await this.#requireCapsule(planRun.capsuleId);
    const snapshot = await this.#store.getSourceSnapshot(
      planRun.sourceSnapshotId,
    );
    if (!snapshot) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `source_snapshot_missing: plan run ${planRun.id} references ` +
          `SourceSnapshot ${planRun.sourceSnapshotId} which is no longer present`,
        { reason: "source_snapshot_missing" },
      );
    }
    const source = await this.#requireSourceForCapsule(capsule);
    const report = await this.#ensureCapsuleCompatibilityReport(
      capsule,
      source,
      snapshot,
      planRun.source.kind === "operator_module"
        ? undefined
        : planRun.source.modulePath,
    );
    if (!report) return planRun;
    const updated: PlanRun = {
      ...planRun,
      compatibilityReportId: report.id,
      updatedAt: this.#now(),
    };
    await this.#store.putPlanRun(updated);
    return updated;
  }

  async #requireSourceForCapsule(capsule: Capsule): Promise<Source> {
    if (!capsule.sourceId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `capsule ${capsule.id} has no Source`,
      );
    }
    const source = await this.#store.getSource(capsule.sourceId);
    if (!source) {
      throw new OpenTofuControllerError(
        "not_found",
        `source ${capsule.sourceId} not found for capsule ${capsule.id}`,
      );
    }
    return source;
  }

  /**
   * Builds the at-rest runs_inputs sidecar (spec §11 / §18). When `seal` is set, the
   * sidecar carries at least one SENSITIVE dependency-injected value, so the
   * complete sidecar payload (variables, generated root, output policy,
   * source/lifecycle actions, OIDC/interface materialization, and runtime-input
   * descriptors) is encrypted into {@link PlanRunInputs.sealed}
   * with the SAME at-rest envelope used for state / plan / dependency-value
   * artifacts, and the cleartext fields are dropped from the row. The store only
   * ever sees ciphertext. A sealer is REQUIRED in that case: missing ⇒ fail closed
   * (the dependency-snapshot seal would already have failed closed upstream, but
   * this never persists a cleartext credential under any path). When `seal` is
   * unset the sidecar is plain (no sensitive value to protect).
   */
  async #planRunInputsForStorage(
    inputs: PlanRunInputs,
    seal: boolean,
  ): Promise<PlanRunInputs> {
    if (!seal) {
      return inputs;
    }
    if (!this.#dependencyValueSealer) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `dependency_value_sealer_unavailable: plan run ${inputs.planRunId} ` +
          `carries a sensitive dependency-injected value but no at-rest value ` +
          `sealer is configured to protect the runs_inputs sidecar`,
        { reason: "dependency_value_sealer_unavailable" },
      );
    }
    const payload: Record<string, JsonValue> = {
      variables: inputs.variables as JsonValue,
      ...(inputs.generatedRoot
        ? { generatedRoot: inputs.generatedRoot as unknown as JsonValue }
        : {}),
      ...(inputs.operatorModule
        ? { operatorModule: inputs.operatorModule as unknown as JsonValue }
        : {}),
      ...(inputs.workspaceOutputAllowlist
        ? {
            workspaceOutputAllowlist:
              inputs.workspaceOutputAllowlist as unknown as JsonValue,
          }
        : {}),
      ...(inputs.outputAllowlist
        ? { outputAllowlist: inputs.outputAllowlist as unknown as JsonValue }
        : {}),
      ...(inputs.sourceBuild
        ? { sourceBuild: inputs.sourceBuild as unknown as JsonValue }
        : {}),
      ...(inputs.lifecycleActions
        ? { lifecycleActions: inputs.lifecycleActions as unknown as JsonValue }
        : {}),
      ...(inputs.stateAdoption
        ? { stateAdoption: inputs.stateAdoption as unknown as JsonValue }
        : {}),
      ...(inputs.priorState
        ? { priorState: inputs.priorState as unknown as JsonValue }
        : {}),
      ...(inputs.moduleVariableMaterializationDigest
        ? {
            moduleVariableMaterializationDigest:
              inputs.moduleVariableMaterializationDigest,
          }
        : {}),
      ...(inputs.interfaceMaterialization
        ? {
            interfaceMaterialization:
              inputs.interfaceMaterialization as unknown as JsonValue,
          }
        : {}),
      ...(inputs.runtimeInputs
        ? { runtimeInputs: inputs.runtimeInputs as unknown as JsonValue }
        : {}),
    };
    const sealed = await this.#dependencyValueSealer.seal(payload);
    // Cleartext sealable fields are dropped; only `planRunId` + `sealed` persist.
    return {
      planRunId: inputs.planRunId,
      variables: {},
      sealed,
    };
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
        { reason: "dependency_value_sealer_unavailable" },
      );
    }
    const payload = await this.#dependencyValueSealer.open(row.sealed);
    if (!Object.prototype.hasOwnProperty.call(payload, "variables")) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan_run_inputs_corrupt: plan run ${planRunId} sealed inputs omit variables`,
        { reason: "plan_run_inputs_corrupt" },
      );
    }
    const variables = normalizeVariables(
      payload.variables as Readonly<Record<string, unknown>>,
    );
    const generatedRoot = payload.generatedRoot as unknown as
      DispatchGeneratedRoot | undefined;
    const operatorModule = payload.operatorModule as unknown as
      PlanRunInputs["operatorModule"] | undefined;
    const workspaceOutputAllowlist =
      payload.workspaceOutputAllowlist as unknown as
        Readonly<Record<string, OutputAllowlistEntry>> | undefined;
    const outputAllowlist = payload.outputAllowlist as unknown as
      Readonly<Record<string, OutputAllowlistEntry>> | undefined;
    const sourceBuild = payload.sourceBuild as unknown as
      InstallConfig["sourceBuild"] | undefined;
    const lifecycleActions = payload.lifecycleActions as unknown as
      InstallConfig["lifecycleActions"] | undefined;
    const stateAdoption = payload.stateAdoption as unknown as
      PlanRunInputs["stateAdoption"] | undefined;
    const priorState = payload.priorState as unknown as
      PlanRunInputs["priorState"] | undefined;
    const moduleVariableMaterializationDigest =
      payload.moduleVariableMaterializationDigest as string | undefined;
    const interfaceMaterialization = payload.interfaceMaterialization as unknown as
      PlanRunInputs["interfaceMaterialization"] | undefined;
    const runtimeInputs = payload.runtimeInputs as unknown as
      PlanRunInputs["runtimeInputs"] | undefined;
    return {
      planRunId,
      variables,
      ...(generatedRoot ? { generatedRoot } : {}),
      ...(operatorModule ? { operatorModule } : {}),
      ...(workspaceOutputAllowlist ? { workspaceOutputAllowlist } : {}),
      ...(outputAllowlist ? { outputAllowlist } : {}),
      ...(sourceBuild ? { sourceBuild } : {}),
      ...(lifecycleActions ? { lifecycleActions } : {}),
      ...(stateAdoption ? { stateAdoption } : {}),
      ...(priorState ? { priorState } : {}),
      ...(moduleVariableMaterializationDigest
        ? { moduleVariableMaterializationDigest }
        : {}),
      ...(interfaceMaterialization ? { interfaceMaterialization } : {}),
      ...(runtimeInputs ? { runtimeInputs } : {}),
    };
  }

  /**
   * Loads and authenticates the exact plaintext preparation bundle committed
   * atomically with a PlanRun. Historical/torn rows deliberately fail closed:
   * neither restart repair nor Apply may synthesize `{}` or a different root.
   */
  async #requirePreparedPlanRunInputs(planRun: PlanRun): Promise<PlanRunInputs> {
    const executionInputsDigest = planRun.executionInputsDigest?.trim();
    if (!executionInputsDigest) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan_run_inputs_unprepared: plan run ${planRun.id} has no exact preparation digest`,
        { reason: "plan_run_inputs_unprepared" },
      );
    }
    const inputs = await this.#getPlanRunInputs(planRun.id);
    if (!inputs) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan_run_inputs_missing: plan run ${planRun.id} has no exact prepared inputs`,
        { reason: "plan_run_inputs_missing" },
      );
    }
    if (
      inputs.planRunId !== planRun.id ||
      !Object.prototype.hasOwnProperty.call(inputs, "variables")
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan_run_inputs_corrupt: plan run ${planRun.id} inputs do not match their owner`,
        { reason: "plan_run_inputs_corrupt" },
      );
    }
    let variables: Readonly<Record<string, JsonValue>>;
    try {
      variables = normalizeVariables(inputs.variables);
    } catch {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan_run_inputs_corrupt: plan run ${planRun.id} variables are not valid JSON input`,
        { reason: "plan_run_inputs_corrupt" },
      );
    }
    const normalizedInputs: PlanRunInputs = { ...inputs, variables };
    if ((await stableJsonDigest(variables)) !== planRun.variablesDigest) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan_run_inputs_corrupt: plan run ${planRun.id} variables changed after preparation`,
        { reason: "plan_run_inputs_corrupt" },
      );
    }
    let dependencySnapshot: DependencySnapshot | undefined;
    if (planRun.dependencySnapshotId) {
      dependencySnapshot = await this.#store.getDependencySnapshot(
        planRun.dependencySnapshotId,
      );
      if (
        !dependencySnapshot ||
        dependencySnapshot.id !== planRun.dependencySnapshotId ||
        dependencySnapshot.runId !== planRun.id
      ) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `plan_run_inputs_missing: plan run ${planRun.id} has no exact dependency snapshot`,
          { reason: "plan_run_inputs_missing" },
        );
      }
    }
    const actualDigest = await stableJsonDigest(
      planRunExecutionInputsDigestMaterial(
        normalizedInputs,
        dependencySnapshot,
      ),
    );
    if (actualDigest !== executionInputsDigest) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan_run_inputs_corrupt: plan run ${planRun.id} exact preparation digest changed`,
        { reason: "plan_run_inputs_corrupt" },
      );
    }
    return normalizedInputs;
  }

  /** Allocates the opaque raw-output destination before runner dispatch. */
  async #allocateRawOutputRef(
    applyRun: ApplyRun,
    dispatch: RunExecutionDispatch,
  ): Promise<string> {
    const allocator = this.#artifactReferenceAllocator;
    const scope = dispatch.stateScope;
    if (!allocator || !scope?.subject) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `apply run ${applyRun.id} has no artifact-reference allocator or durable subject`,
      );
    }
    const ref = await allocator.allocate({
      kind: "raw_output",
      workspaceId: scope.workspaceId,
      subject: scope.subject,
      runId: applyRun.id,
    });
    if (!ref.trim()) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `artifact-reference allocator returned an empty rawOutputRef for apply run ${applyRun.id}`,
      );
    }
    return ref;
  }

  /**
   * Builds the §6.9 StateVersion metadata for a successful env-driven apply /
   * destroy state persist. The opaque reference is allocated by the host before
   * dispatch, so the ledger pointer matches the encrypted object written at the
   * same generation. Returns `undefined` for a Run without environment context.
   * The digest is the plaintext digest the runner echoed back, when present. The
   * Its id is stable for the ApplyRun across ledger-tail redelivery. The record
   * is PERSISTED atomically with the StateVersion / Output / Capsule advance by
   * {@link OpenTofuControlStore.commitRunState}.
   */
  async #buildStateVersion(input: {
    readonly envDispatch: RunExecutionDispatch;
    readonly generation: number;
    readonly stateDigest: string | undefined;
    readonly runId: string;
    readonly now: number;
  }): Promise<StateVersion | undefined> {
    const scope = input.envDispatch.stateScope;
    if (!scope) return undefined;
    if (!input.stateDigest?.trim()) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `apply run ${input.runId} completed without a durable state digest`,
      );
    }
    const workspaceId = scope.workspaceId;
    const capsuleId = scope.subject?.kind === "capsule" ? scope.subject.id : "";
    return {
      id: await stateVersionIdForApplyRun(input.runId),
      workspaceId,
      capsuleId,
      environment: scope.environment,
      generation: input.generation,
      stateRef: scope.stateRef,
      digest: input.stateDigest,
      createdByRunId: input.runId,
      createdAt: new Date(input.now).toISOString(),
    };
  }

  /**
   * Builds the §16 Output for a successful (non-destroy) apply.
   *
   *   - `workspaceOutputs` = the Workspace-local capture projection after sensitive filtering,
   *     bounded-size checks, and type validation.
   *   - `publicOutputs` = only the explicit InstallConfig projection surfaced
   *     on Output.
   *   - Sensitive-flagged outputs appear in NEITHER (invariants 11/12), and a
   *     required sensitive/missing/wrong-type output fails closed.
   *   - `outputDigest` = stableJsonDigest over `{ workspaceOutputs, publicOutputs }`,
   *     which drives stale propagation (§24).
   *   - `rawArtifactRef` = the opaque host-allocated reference the runner used
   *     for the sealed raw envelope.
   *
   * The raw envelope itself never enters the ledger — only the projection. The
   * record is PERSISTED atomically with the StateVersion /
   * Capsule advance by {@link OpenTofuControlStore.commitRunState}.
   */
  async #buildOutput(input: {
    readonly capsule: Capsule;
    readonly applyRun: ApplyRun;
    readonly result: OpenTofuApplyResult;
    readonly envDispatch: RunExecutionDispatch;
    readonly publicOutputs: Readonly<Record<string, JsonValue>>;
    readonly workspaceOutputAllowlist?: RunModuleDispatch["workspaceOutputAllowlist"];
    readonly outputAllowlist?: RunModuleDispatch["outputAllowlist"];
    readonly stateGeneration: number;
    readonly now: number;
  }): Promise<Output> {
    const rawArtifactRef = input.result.rawOutputRef;
    if (
      !rawArtifactRef ||
      rawArtifactRef !== input.envDispatch.rawOutputRef
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `apply run ${input.applyRun.id} completed without its exact confirmed raw output artifact reference`,
      );
    }
    const projectedWorkspaceOutputs =
      input.workspaceOutputAllowlist &&
      Object.keys(input.workspaceOutputAllowlist).length > 0
        ? projectOutputAllowlistSpaceOutputs(
            input.workspaceOutputAllowlist,
            input.result.outputs,
          )
        : projectAllWorkspaceOutputs(input.result.outputs);
    const workspaceOutputs = projectedWorkspaceOutputs;
    const publicOutputs = input.publicOutputs;
    const outputDigest = await stableJsonDigest({
      workspaceOutputs,
      publicOutputs,
    });
    const snapshot: Output = {
      id: this.#newId("out"),
      workspaceId: input.capsule.workspaceId,
      capsuleId: input.capsule.id,
      stateGeneration: input.stateGeneration,
      rawArtifactRef,
      publicOutputs,
      workspaceOutputs,
      outputDigest,
      createdAt: new Date(input.now).toISOString(),
    };
    return snapshot;
  }

  /**
   * §24 stale propagation. After a successful apply records a new Output,
   * compares its digest to the Capsule's PREVIOUS Output digest;
   * when they differ (the outputs changed) every transitive downstream consumer
   * in the same Workspace that is currently `active` is patched to `stale`.
   *
   * The downstream closure is computed over the Workspace's `variable_injection`
   * dependency edges (producer -> consumer) via {@link downstreamClosure}. Only
   * `active` consumers are moved: `pending` / `error` / `destroyed` are left
   * untouched (a stale flag on a not-yet-applied or torn-down Capsule is
   * meaningless). No-ops when the digest is unchanged, or when there are no
   * downstream consumers. The lifecycle transition is exact-record CAS-fenced,
   * so a concurrent state or status commit wins without a stale activity.
   */
  async #propagateStale(input: {
    readonly capsule: Capsule;
    readonly previousOutput: Output | undefined;
    readonly newOutput: Output;
    readonly now: number;
  }): Promise<void> {
    if (input.previousOutput?.outputDigest === input.newOutput.outputDigest)
      return;
    const edges = await this.#store.listDependenciesByWorkspace(
      input.capsule.workspaceId,
    );
    if (edges.length === 0) return;
    const changedOutputNames = changedOutputNamesBetween(
      input.previousOutput,
      input.newOutput,
    );
    const producerOutputReasons = changedOutputNames.map(
      (outputName) => `${input.capsule.name}.${outputName} changed`,
    );
    const closure = downstreamClosure(
      edges.map((edge) => ({
        from: edge.producerCapsuleId,
        to: edge.consumerCapsuleId,
      })),
      input.capsule.id,
    );
    if (closure.size === 0) return;
    const updatedAt = new Date(input.now).toISOString();
    for (const consumerId of closure) {
      const consumer = await this.#store.getCapsule(consumerId);
      // Only an active consumer becomes stale; skip the rest (and a consumer the
      // ledger no longer holds).
      if (!consumer || consumer.status !== "active") continue;
      const stale = await this.#store.markCapsuleStale({
        capsuleId: consumerId,
        expected: consumer,
        reason: "dependency-output",
        updatedAt,
      });
      if (stale.kind !== "updated") continue;
      const staleConsumer = stale.capsule;
      // Activity (§27 / §34): a downstream consumer was marked stale by the
      // producer's changed outputs (§24). One event per affected consumer.
      const directOutputNames = directChangedDependencyOutputs({
        edges,
        producerCapsuleId: input.capsule.id,
        consumerCapsuleId: staleConsumer.id,
        changedOutputNames,
      });
      const directReasons = directOutputNames.map(
        (outputName) => `${input.capsule.name}.${outputName} changed`,
      );
      await this.#recordActivity({
        workspaceId: staleConsumer.workspaceId,
        action: "capsule.stale",
        targetType: "capsule",
        targetId: staleConsumer.id,
        metadata: {
          producerCapsuleId: input.capsule.id,
          producerCapsuleName: input.capsule.name,
          changedOutputs: changedOutputNames,
          reasons:
            directReasons.length > 0 ? directReasons : producerOutputReasons,
          directChangedOutputs: directOutputNames,
          outputId: input.newOutput.id,
          previousOutputId: input.previousOutput?.id ?? null,
        },
      });
    }
  }

  /**
   * Server-side auto-continue for the auto-update pipeline (and any plan
   * created with `autoApplyRequested`): a CLEAN completed plan — `succeeded`,
   * which an approval-parked (destructive), policy-blocked, or drift-check
   * plan never reaches — applies itself so no client has to press deploy.
   * `createApplyRun` re-verifies every apply precondition (policy pass, plan
   * artifact, apply-once, destroy approval), so this path adds no bypass. A
   * failure records an Activity event and leaves the succeeded plan for manual
   * continuation; it never fails the plan itself.
   */
  async #maybeAutoApplyCompletedPlan(planRun: PlanRun): Promise<void> {
    if (planRun.autoApplyRequested !== true) return;
    if (planRun.driftCheck === true) return;
    if (planRun.status !== "succeeded") return;
    if (planRun.operation === "destroy") return;
    if (planRun.requiresApproval === true) return;
    if (planRun.appliedApplyRunId) return;
    // A no-op plan already proves desired and observed state converge. Creating
    // an apply would only spend runner time and cannot publish a new StateVersion or Output.
    if (
      planRun.planResourceChanges !== undefined &&
      planRun.planResourceChanges.length === 0
    )
      return;
    try {
      await this.createApplyRun(
        {
          planRunId: planRun.id,
          expected: applyExpectedGuardFromPlanRun(planRun),
        },
        { actor: "system:auto-update" },
      );
    } catch (error) {
      await this.#recordActivity({
        workspaceId: planRun.workspaceId,
        action: "capsule.auto_update_apply_failed",
        targetType: "capsule",
        targetId: planRun.capsuleId ?? planRun.id,
        metadata: {
          planRunId: planRun.id,
          message: error instanceof Error ? error.message : String(error),
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
  async #recordActivity(event: RecordActivityArgs): Promise<void> {
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
   * Resolves a Capsule-bound Run's Provider Bindings at mint time. Raw Runs
   * return `undefined`; missing, cross-Workspace, mismatched, or unverified
   * Connections fail closed.
   */
  async #resolveRunProviderBindings(
    planRun: PlanRun,
  ): Promise<readonly ResolvedCapsuleProviderBinding[] | undefined> {
    const ctx = planRun.capsuleContext;
    if (!ctx) return undefined;
    const capsule = await this.#store.getCapsule(ctx.capsuleId);
    if (!capsule) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `capsule_not_found: ${ctx.capsuleId}`,
        { reason: "capsule_not_found" },
      );
    }
    this.#connectionsService ??= new ConnectionsService({
      store: this.#store,
      operatorProviderConnections: this.#operatorProviderConnections,
      allowOperatorScopedProviderConnections:
        this.#allowOperatorScopedProviderConnections,
    });
    const profile = await this.#requireRunnerProfile(planRun.runnerProfileId);
    const installConfig = await this.#store.getInstallConfig(
      capsule.installConfigId,
    );
    if (!installConfig) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `install_config_not_found: ${capsule.installConfigId}`,
        { reason: "install_config_not_found" },
      );
    }
    // Destroy provider identities come from the current StateVersion's
    // applied PlanRun, not CompatibilityReport admission evidence. In
    // particular, do not parse a legacy flat providers_json row while minting
    // destroy credentials.
    const compatibilityReport =
      planRun.operation === "destroy"
        ? undefined
        : planRun.compatibilityReportId
          ? await this.#store.getCapsuleCompatibilityReport(
              planRun.compatibilityReportId,
            )
          : undefined;
    const requiredProviderRequirements =
      planRun.requiredProviderRequirements !== undefined
        ? requiredProviderRequirementsForNewPlan(
            planRun.requiredProviders,
            planRun.requiredProviderRequirements,
          )
        : requiredProviderRequirementsForNewPlan(
            planRun.requiredProviders,
            legacyProviderRequirementsForStoredPlan(
              planRun.requiredProviders,
            ).map((requirement) => ({
              ...requirement,
              ...(compatibilityReport?.rootProviderRequirements.some(
                (candidate) =>
                  canonicalProviderAddress(candidate.source) ===
                    requirement.source &&
                  candidate.credentialRequired === true,
              )
                ? { credentialRequired: true }
                : {}),
            })),
          );
    // Run-scoped: exact ProviderBindings required by this plan. Create/update
    // plans may also carry CompatibilityReport evidence, but destroy never
    // uses that report as provider or teardown authority.
    const bindingRequirements = providerBindingResolutionRequirements(
      requiredProviderRequirements,
      profile,
    );
    const resolved =
      planRun.requiredProviderRequirements === undefined ||
      planRun.source.kind === "operator_module"
        ? await this.#connectionsService.resolveProviderBindingsForLegacyStoredRun(
            capsule,
            bindingRequirements,
          )
        : await this.#connectionsService.resolveProviderBindingsForRun(
            capsule,
            bindingRequirements,
          );
    return planRun.source.kind === "operator_module"
      ? legacyDefaultProviderBindingsForSourcelessDestroy(
          resolved,
          requiredProviderRequirements,
        )
      : resolved;
  }

  /**
   * Pins the resolved provider-connection digest (plan→apply TOCTOU) onto a completed plan.
   * Resolves the plan's live provider env bindings ONCE and hashes the
   * provider→{connectionId,mode,alias} set onto `resolvedProviderBindingsDigest`. Only
   * pinned for a subject-bound Run (a raw `/plan-runs` Run resolves no Provider
   * Bindings, so there is nothing to fence); the apply mint re-resolves and
   * asserts this digest is unchanged. A failed/denied plan is never applied.
   */
  async #pinResolvedBindingsDigest(planRun: PlanRun): Promise<PlanRun> {
    if (!planRun.capsuleContext) return planRun;
    const resolved = await this.#resolveRunProviderBindings(planRun);
    if (resolved === undefined) return planRun;
    const digest = await resolvedProviderBindingsDigest(resolved);
    return { ...planRun, resolvedProviderBindingsDigest: digest };
  }

  async createRestoreRun(
    workspaceId: string,
    backupId: string,
    request: CreateRestoreRequest,
    context: DeployControlActorContext = {},
  ): Promise<Run> {
    requireNonEmptyString(workspaceId, "workspaceId");
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
    if (!backup || backup.workspaceId !== workspaceId) {
      throw new OpenTofuControllerError(
        "not_found",
        "backup not found in this workspace",
      );
    }
    const restoreServiceData = request.restoreServiceData === true;
    if (restoreServiceData && !backup.serviceData) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "backup has no service-data artifact to restore",
      );
    }
    if (restoreServiceData) {
      const profile = await this.#requireRunnerProfile(
        this.#defaultRunnerProfileId,
      );
      if (!this.#runnerForProfile(profile).restoreServiceData) {
        throw new OpenTofuControllerError(
          "not_implemented",
          "service-data restore requires a service-data restore-capable runner",
        );
      }
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
    const capsuleId = request.capsuleId ?? backup.capsuleId;
    if (!capsuleId) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "capsuleId is required for control/state restore",
      );
    }
    const capsule = await this.#store.getCapsule(capsuleId);
    if (!capsule || capsule.workspaceId !== workspaceId) {
      throw new OpenTofuControllerError(
        "not_found",
        "capsule not found in this workspace",
      );
    }
    const environment =
      request.environment ?? backup.environment ?? capsule.environment;
    const source = (
      await this.#store.listStateVersions(capsule.id, environment)
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
      workspaceId: capsule.workspaceId,
      capsuleId: capsule.id,
      environment,
      type: "restore",
      status: "waiting_approval",
      backupId: backup.id,
      restoreStateGeneration: source.generation,
      ...(restoreServiceData ? { restoreServiceData: true } : {}),
      restoredFromStateVersionId: source.id,
      planDigest: backup.digest,
      createdBy: context.actor ?? "system",
      createdAt: now,
    };
    await this.#store.putBackupRun(run);
    await this.#recordActivity({
      workspaceId,
      ...(context.actor ? { actorId: context.actor } : {}),
      action: "restore.created",
      targetType: "run",
      targetId: run.id,
      runId: run.id,
      metadata: {
        backupId: backup.id,
        capsuleId: capsule.id,
        environment,
        stateGeneration: source.generation,
        ...(restoreServiceData
          ? {
              restoreServiceData: true,
              serviceDataRef: backup.serviceData!.ref,
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
      await this.#notifyTerminal(cancelled);
      return projectPlanRun(cancelled, {
        awaitingApproval: false,
        ...this.#runQuery.capsuleProjection(cancelled),
      });
    }
    const applyRun = await this.#store.getApplyRun(id);
    if (applyRun) {
      // A retryable runner-infrastructure failure deliberately requeues the
      // SAME ApplyRun after it has started. Such a row may already carry
      // provider/lifecycle mutation evidence (notably a succeeded pre_destroy
      // action), so treating it like a never-started queue item would let
      // cancellation erase the only fail-closed runtime-safety candidate.
      if (applyRun.status !== "queued" || applyRun.startedAt !== undefined) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `apply run ${id} is ${applyRun.status}${applyRun.startedAt !== undefined ? " and has already started" : ""}; only queued runs can be cancelled, and only before they start`,
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
        // Status alone is insufficient: a runner can claim this never-started
        // row and requeue it after provider/lifecycle execution between our read
        // and CAS. Require the row to still be genuinely never-started.
        expectStartedAt: null,
        run: cancelled,
        clearLeaseToken: true,
      });
      if (!result.won) {
        const current = (result.run as ApplyRun | undefined) ?? applyRun;
        throw new OpenTofuControllerError(
          "failed_precondition",
          `apply run ${id} is ${current.status}${current.startedAt !== undefined ? " and has already started" : ""}; only queued runs can be cancelled, and only before they start`,
        );
      }
      await this.#notifyTerminal(cancelled);
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
   * destructive changes). Idempotent: re-approving an
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
        ...this.#runQuery.capsuleProjection(planRun),
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
      workspaceId: approved.workspaceId,
      ...(input.approvedBy ? { actorId: input.approvedBy } : {}),
      action: "run.approved",
      targetType: "run",
      targetId: approved.id,
      runId: approved.id,
      metadata: {
        operation: approved.operation,
        capsuleId: approved.capsuleId,
      },
    });
    return projectPlanRun(approved, {
      awaitingApproval: false,
      ...this.#runQuery.capsuleProjection(approved),
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
      workspaceId: approved.workspaceId,
      ...(input.approvedBy ? { actorId: input.approvedBy } : {}),
      action: "run.approved",
      targetType: "run",
      targetId: approved.id,
      runId: approved.id,
      metadata: {
        operation: "restore",
        backupId: approved.backupId ?? null,
        capsuleId: approved.capsuleId ?? null,
        approvedAt: now,
        ...(input.reason ? { reason: redactString(input.reason) } : {}),
      },
    });
    await this.#enqueueRun({
      action: "restore",
      runId: approved.id,
      workspaceId: approved.workspaceId,
    });
    return (await this.#store.getBackupRun(approved.id)) ?? approved;
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
  ): Promise<{ readonly won: boolean; readonly heartbeatAt: number }> {
    const now = this.#now();
    const result = await this.#store.transitionRun({
      id: run.id,
      kind,
      expectFrom: ["running"],
      expectLeaseToken: leaseToken,
      run: { ...run, heartbeatAt: now, updatedAt: now },
      heartbeatAt: now,
    });
    return { won: result.won, heartbeatAt: now };
  }

  /**
   * Runs `work` (a single long blocking external dispatch) under a renewal
   * guard:
   * every {@link RUN_RENEWAL_INTERVAL_MS} it re-stamps the run's heartbeat AND
   * renews the held lease so a sibling consumer never treats the run as crashed
   * mid-apply. A lost heartbeat CAS or non-acquired lease renewal aborts
   * immediately. A transport-unavailable probe gets one short retry only while
   * both fences retain deadline headroom; exhaustion aborts the signal passed to
   * `work`. Continuing after an ambiguous renewal failure would let a fenced-out
   * executor perform external adapter or release side effects beside its successor.
   */
  async #withRunRenewal<T>(
    kind: "plan" | "apply" | "restore",
    run: PlanRun | ApplyRun | Run,
    leaseToken: string,
    lease: LeaseHandle | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const abortController = new AbortController();
    const initialFenceAt = run.heartbeatAt ?? this.#now();
    let lastHeartbeatAt = initialFenceAt;
    let runHeartbeatDeadline = initialFenceAt + RUN_HEARTBEAT_STALE_MS;
    let capsuleLeaseDeadline = lease
      ? initialFenceAt + DEFAULT_CAPSULE_LEASE_TTL_MS
      : Number.POSITIVE_INFINITY;
    const retryDelayMs = Math.min(
      RUN_RENEWAL_TRANSPORT_RETRY_MAX_DELAY_MS,
      Math.max(1, Math.floor(Math.max(this.#runRenewalIntervalMs, 1) / 20)),
    );
    const hasRetryHeadroom = (): boolean =>
      Math.min(runHeartbeatDeadline, capsuleLeaseDeadline) - this.#now() >
      retryDelayMs;
    const failClosed = (
      target: RunRenewalTarget,
      failure: RunRenewalFailure,
      attempts: number,
      originalError?: unknown,
    ): void => {
      if (abortController.signal.aborted) return;
      const error = new RunExecutionRenewalError({
        kind,
        runId: run.id,
        target,
        failure,
        attempts,
        ...(originalError === undefined ? {} : { originalError }),
      });
      abortController.abort(error);
    };
    let activeTick: Promise<void> | undefined;
    const renewRunHeartbeat = async (): Promise<boolean> => {
      let attempts = 0;
      while (!abortController.signal.aborted) {
        attempts += 1;
        let heartbeat: { readonly won: boolean; readonly heartbeatAt: number };
        try {
          heartbeat = await this.#heartbeatRunningRun(
            kind,
            run,
            leaseToken,
          );
        } catch (error) {
          if (
            attempts <= RUN_RENEWAL_TRANSPORT_RETRY_LIMIT &&
            hasRetryHeadroom()
          ) {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, retryDelayMs),
            );
            continue;
          }
          failClosed(
            "run_heartbeat",
            "unavailable",
            attempts,
            error,
          );
          return false;
        }
        if (!heartbeat.won) {
          failClosed("run_heartbeat", "lost", attempts);
          return false;
        }
        lastHeartbeatAt = heartbeat.heartbeatAt;
        runHeartbeatDeadline = lastHeartbeatAt + RUN_HEARTBEAT_STALE_MS;
        return true;
      }
      return false;
    };
    const renewCapsuleLease = async (): Promise<boolean> => {
      if (!lease) return true;
      let attempts = 0;
      while (!abortController.signal.aborted) {
        attempts += 1;
        let renewed: Awaited<ReturnType<LeaseHandle["renew"]>>;
        try {
          renewed = await lease.renew(DEFAULT_CAPSULE_LEASE_TTL_MS);
        } catch (error) {
          if (
            isRetryableCapsuleRenewalTransportError(error) &&
            attempts <= RUN_RENEWAL_TRANSPORT_RETRY_LIMIT &&
            hasRetryHeadroom()
          ) {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, retryDelayMs),
            );
            continue;
          }
          failClosed("capsule_lease", "unavailable", attempts, error);
          return false;
        }
        if (!renewed.acquired) {
          failClosed("capsule_lease", "lost", attempts);
          return false;
        }
        const renewedExpiresAt = Date.parse(renewed.expiresAt);
        capsuleLeaseDeadline = Number.isFinite(renewedExpiresAt)
          ? renewedExpiresAt
          : lastHeartbeatAt + DEFAULT_CAPSULE_LEASE_TTL_MS;
        return true;
      }
      return false;
    };
    const tick = async (): Promise<void> => {
      if (abortController.signal.aborted) return;
      if (!(await renewRunHeartbeat())) return;
      await renewCapsuleLease();
    };
    const runTick = (): Promise<void> => {
      if (activeTick) return activeTick;
      const pending = tick().finally(() => {
        if (activeTick === pending) activeTick = undefined;
      });
      activeTick = pending;
      return pending;
    };
    // Validate both fences immediately before the external dispatch. This closes
    // the claim-to-dispatch window instead of waiting one interval to discover a
    // takeover that already happened.
    await runTick();
    if (abortController.signal.aborted) {
      throw abortController.signal.reason;
    }
    const intervalMs = this.#runRenewalIntervalMs;
    const timer =
      intervalMs > 0
        ? setInterval(() => void runTick(), intervalMs)
        : undefined;
    if (timer) {
      // Some runtimes keep the event loop alive for a pending interval; unref
      // when available so the renewal timer never blocks process exit on its own.
      (timer as { unref?: () => void }).unref?.();
    }
    let result: T | undefined;
    let workError: unknown;
    let workFailed = false;
    try {
      result = await work(abortController.signal);
    } catch (error) {
      workFailed = true;
      workError = error;
    } finally {
      if (timer) clearInterval(timer);
      if (activeTick) await activeTick;
    }
    // Revalidate after the adapter has acknowledged cancellation/completion, but
    // before callers perform any terminal ledger or follow-up side effects.
    // Restore currently commits its terminal ledger inside `work`; a post-work
    // heartbeat would correctly lose against that terminal row and falsely turn
    // a successful restore into a fence-loss failure. Plan/apply keep their
    // terminal commit outside `work`, so they receive the final guard check.
    if (kind !== "restore" && !abortController.signal.aborted) await runTick();
    if (abortController.signal.aborted) {
      const renewalError = abortController.signal.reason;
      if (renewalError instanceof RunExecutionRenewalError && workFailed) {
        renewalError.preserveSecondaryError(workError);
      }
      throw renewalError;
    }
    if (workFailed) throw workError;
    return result as T;
  }

  /**
   * Persists a run that has reached a TERMINAL status (succeeded / failed /
   * cancelled). Routed through {@link OpenTofuControlStore.transitionRun}
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
    if (result.won) await this.#notifyTerminal(terminal);
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
      errorCode: runErrorCode(error, "restore_failed"),
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
    if (result.won) {
      await this.#notifyRestore({ phase: "failed", run: failed });
    }
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
      diagnostics: runFailureDiagnostics(error),
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
    // diagnostic message), the run phase, and the targeted Capsule id.
    await this.#recordActivity({
      workspaceId: failed.workspaceId,
      action: "run.failed",
      targetType: "run",
      targetId: failed.id,
      runId: failed.id,
      metadata: {
        phase: failed.driftCheck === true ? "drift_check" : "plan",
        operation: failed.operation,
        errorCode: runErrorCode(error, "plan_failed"),
        ...(failed.capsuleId ? { capsuleId: failed.capsuleId } : {}),
      },
    });
    return failed;
  }

  async #requeuePlanRunAfterRunnerInfrastructureError(
    running: PlanRun,
    leaseToken: string | undefined,
    error: unknown,
  ): Promise<PlanRun | undefined> {
    const now = this.#now();
    const retryEvent =
      running.operation === "destroy"
        ? "destroy_plan.retry_scheduled"
        : "plan.retry_scheduled";
    const queued: PlanRun = {
      ...running,
      status: "queued",
      heartbeatAt: undefined,
      diagnostics: undefined,
      auditEvents: [
        ...running.auditEvents,
        auditEvent(running.id, retryEvent, now, {
          reason: "runner_infrastructure_error",
          errorCode: runErrorCode(error, "runner_infrastructure_error"),
        }),
      ],
      updatedAt: now,
      finishedAt: undefined,
    };
    const result = await this.#store.transitionRun({
      id: running.id,
      kind: "plan",
      expectFrom: ["running"],
      ...(leaseToken ? { expectLeaseToken: leaseToken } : {}),
      run: queued,
      clearLeaseToken: true,
      clearHeartbeat: true,
    });
    if (!result.won) return undefined;
    await this.#recordDeployOperationMetric({
      run: queued,
      operationKind: "plan",
      status: "queued",
    });
    await this.#recordActivity({
      workspaceId: queued.workspaceId,
      action: "run.retry_scheduled",
      targetType: "run",
      targetId: queued.id,
      runId: queued.id,
      metadata: {
        phase:
          queued.driftCheck === true
            ? "drift_check"
            : queued.operation === "destroy"
              ? "destroy_plan"
              : "plan",
        operation: queued.operation,
        errorCode: runErrorCode(error, "runner_infrastructure_error"),
        ...(queued.capsuleId ? { capsuleId: queued.capsuleId } : {}),
      },
    });
    await this.#enqueueRequeuedRun("plan", queued);
    return result.run as PlanRun;
  }

  async #failApplyRun(
    running: ApplyRun,
    leaseToken: string | undefined,
    profile: RunnerProfile,
    startedAt: number,
    eventType: "apply.failed" | "destroy.failed",
    error: unknown,
    providerDispatched = false,
    lifecycleActionDispatched = false,
    lifecycleOutcome?: LifecycleActionOutcome,
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
      diagnostics: runFailureDiagnostics(error),
      auditEvents: [
        ...running.auditEvents,
        ...(lifecycleOutcome
          ? [
              auditEvent(
                running.id,
                `lifecycle_action.${lifecycleOutcome.phase}.${lifecycleOutcome.activityStatus}`,
                now,
                {
                  phase: lifecycleOutcome.phase,
                  status: lifecycleOutcome.reportedStatus,
                  commandCount: lifecycleOutcome.commandCount,
                  actionDispatched: lifecycleOutcome.actionDispatched,
                },
              ),
            ]
          : []),
        auditEvent(running.id, eventType, now, {
          message: errorMessage(error),
          providerDispatched,
          ...(lifecycleActionDispatched
            ? { lifecycleActionDispatched: true }
            : {}),
          ...(lifecycleOutcome
            ? {
                lifecycleActionPhase: lifecycleOutcome.phase,
                lifecycleActionStatus: lifecycleOutcome.reportedStatus,
                lifecycleActionCommandCount: lifecycleOutcome.commandCount,
              }
            : {}),
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
    // diagnostic message), the run phase, and the targeted Capsule id.
    await this.#recordActivity({
      workspaceId: failed.workspaceId,
      action: "run.failed",
      targetType: "run",
      targetId: failed.id,
      runId: failed.id,
      metadata: {
        phase: eventType === "destroy.failed" ? "destroy_apply" : "apply",
        operation: failed.operation,
        errorCode: runErrorCode(
          error,
          eventType === "destroy.failed" ? "destroy_failed" : "apply_failed",
        ),
        ...(failed.capsuleId ? { capsuleId: failed.capsuleId } : {}),
      },
    });
    return failed;
  }

  async #completeApplyRunAsIdempotentReplay(input: {
    readonly running: ApplyRun;
    readonly planRun: PlanRun;
    readonly profile: RunnerProfile;
    readonly startedAt: number;
    readonly leaseToken: string;
    readonly existingApplyRunId: string;
  }): Promise<ApplyRunExecutionResponse> {
    const existing = await this.#store.getApplyRun(input.existingApplyRunId);
    if (!existing || existing.status !== "succeeded") {
      const failed = await this.#failApplyRun(
        input.running,
        input.leaseToken,
        input.profile,
        input.startedAt,
        "apply.failed",
        new OpenTofuControllerError(
          "failed_precondition",
          `plan run ${input.planRun.id} was marked applied, but apply run ${input.existingApplyRunId} is not available as a succeeded run`,
        ),
      );
      return { applyRun: failed };
    }
    const now = this.#now();
    const replayed: ApplyRun = {
      ...input.running,
      ...(existing.capsuleId
        ? {
            capsuleId: existing.capsuleId,
          }
        : {}),
      ...(existing.stateVersionId
        ? { stateVersionId: existing.stateVersionId }
        : {}),
      ...(existing.outputId ? { outputId: existing.outputId } : {}),
      status: "succeeded",
      stateLock:
        existing.stateLock ??
        stateLockEvidence(
          input.profile.stateBackend,
          input.startedAt,
          now,
          "recorded",
        ),
      ...(existing.providerResolutions
        ? { providerResolutions: existing.providerResolutions }
        : {}),
      auditEvents: [
        ...input.running.auditEvents,
        auditEvent(input.running.id, "apply.idempotent_replay", now, {
          planRunId: input.planRun.id,
          existingApplyRunId: input.existingApplyRunId,
          ...(existing.stateVersionId
            ? { stateVersionId: existing.stateVersionId }
            : {}),
        }),
      ],
      updatedAt: now,
      finishedAt: now,
      heartbeatAt: now,
    };
    const persisted = await this.#persistTerminalRun(
      "apply",
      replayed,
      input.leaseToken,
    );
    const applyRun = persisted.run;
    if (persisted.won) {
      await this.#recordActivity({
        workspaceId: applyRun.workspaceId,
        action: "run.idempotent_replay",
        targetType: "run",
        targetId: applyRun.id,
        runId: applyRun.id,
        metadata: {
          phase: applyRun.operation === "destroy" ? "destroy_apply" : "apply",
          operation: applyRun.operation,
          existingApplyRunId: input.existingApplyRunId,
          ...(applyRun.capsuleId ? { capsuleId: applyRun.capsuleId } : {}),
        },
      });
    }
    const response = await this.getApplyRun(applyRun.id);
    return {
      ...response,
      [APPLY_MATERIALIZATION_SOURCE_RUN_ID]: input.existingApplyRunId,
    };
  }

  async #requeueApplyRunAfterRunnerInfrastructureError(
    running: ApplyRun,
    leaseToken: string | undefined,
    profile: RunnerProfile,
    startedAt: number,
    error: unknown,
    operationKind: "apply" | "destroy_apply" = "apply",
  ): Promise<ApplyRun | undefined> {
    const now = this.#now();
    const phase = operationKind === "destroy_apply" ? "destroy_apply" : "apply";
    const queued: ApplyRun = {
      ...running,
      status: "queued",
      stateLock: stateLockEvidence(
        profile.stateBackend,
        startedAt,
        now,
        "recorded",
      ),
      heartbeatAt: undefined,
      diagnostics: undefined,
      auditEvents: [
        ...running.auditEvents,
        auditEvent(
          running.id,
          operationKind === "destroy_apply"
            ? "destroy.retry_scheduled"
            : "apply.retry_scheduled",
          now,
          {
            reason: "runner_infrastructure_error",
            errorCode: runErrorCode(error, "runner_infrastructure_error"),
          },
        ),
      ],
      updatedAt: now,
      finishedAt: undefined,
    };
    const result = await this.#store.transitionRun({
      id: running.id,
      kind: "apply",
      expectFrom: ["running"],
      ...(leaseToken ? { expectLeaseToken: leaseToken } : {}),
      run: queued,
      clearLeaseToken: true,
      clearHeartbeat: true,
    });
    if (!result.won) return undefined;
    await this.#recordDeployOperationMetric({
      run: queued,
      operationKind,
      status: "queued",
      startedAt,
      finishedAt: now,
      recordApplyDuration: true,
    });
    await this.#recordActivity({
      workspaceId: queued.workspaceId,
      action: "run.retry_scheduled",
      targetType: "run",
      targetId: queued.id,
      runId: queued.id,
      metadata: {
        phase,
        operation: queued.operation,
        errorCode: runErrorCode(error, "runner_infrastructure_error"),
        ...(queued.capsuleId ? { capsuleId: queued.capsuleId } : {}),
      },
    });
    await this.#enqueueRequeuedRun("apply", queued);
    return result.run as ApplyRun;
  }

  async #requeueApplyRunAfterArtifactLedgerTailError(
    running: ApplyRun,
    leaseToken: string | undefined,
    profile: RunnerProfile,
    startedAt: number,
    operationKind: "apply" | "destroy_apply",
  ): Promise<ApplyRun | undefined> {
    const now = this.#now();
    const queued: ApplyRun = {
      ...running,
      status: "queued",
      stateLock: stateLockEvidence(
        profile.stateBackend,
        startedAt,
        now,
        "recorded",
      ),
      heartbeatAt: undefined,
      diagnostics: undefined,
      auditEvents: [
        ...running.auditEvents,
        auditEvent(
          running.id,
          operationKind === "destroy_apply"
            ? "destroy.artifact_ledger_retry_scheduled"
            : "apply.artifact_ledger_retry_scheduled",
          now,
          { reason: "artifact_ledger_tail_ambiguous" },
        ),
      ],
      updatedAt: now,
      finishedAt: undefined,
    };
    const result = await this.#store.transitionRun({
      id: running.id,
      kind: "apply",
      expectFrom: ["running"],
      ...(leaseToken ? { expectLeaseToken: leaseToken } : {}),
      run: queued,
      clearLeaseToken: true,
      clearHeartbeat: true,
    });
    if (!result.won) {
      return (result.run as ApplyRun | undefined) ??
        (await this.#store.getApplyRun(running.id));
    }
    const requeued = result.run as ApplyRun;
    await this.#recordDeployOperationMetric({
      run: requeued,
      operationKind,
      status: "queued",
      startedAt,
      finishedAt: now,
      recordApplyDuration: true,
    });
    await this.#recordActivity({
      workspaceId: requeued.workspaceId,
      action: "run.artifact_ledger_retry_scheduled",
      targetType: "run",
      targetId: requeued.id,
      runId: requeued.id,
      metadata: {
        phase: operationKind,
        operation: requeued.operation,
        reason: "artifact_ledger_tail_ambiguous",
        ...(requeued.capsuleId ? { capsuleId: requeued.capsuleId } : {}),
      },
    });
    // An inline dispatcher would recursively wait on the execution lease still
    // held by this attempt. External queue owners can accept the retry now;
    // inline callers observe `queued` and explicitly drive it after return.
    if (this.#enqueueArtifactLedgerRetry) {
      await this.#enqueueRequeuedRun("apply", requeued);
    }
    return requeued;
  }

  async #enqueueRequeuedRun(
    action: "plan" | "apply",
    run: PlanRun | ApplyRun,
  ): Promise<void> {
    try {
      await this.#enqueueRun({
        action,
        runId: run.id,
        workspaceId: run.workspaceId ?? run.workspaceId,
        cause: "controller_retry",
      });
    } catch (error) {
      log.warn("deploy_control.retry_enqueue_failed", {
        action,
        runId: run.id,
        error: errorMessage(error),
      });
    }
  }

  async #executePlan(
    running: PlanRun,
    leaseToken: string,
    profile: RunnerProfile,
    variables: Readonly<Record<string, JsonValue>>,
    runEnvironment: ResolvedRunEnvironment,
    dispatch: RunModuleDispatch,
  ): Promise<PlanRun> {
    try {
      const effectiveRunning = running;
      const effectiveRunEnvironment = runEnvironment;
      // A plan restores against the CURRENT generation
      // (`baseStateGeneration`). Empty for runs without capsule context.
      const envDispatch = await this.#verification.executionDispatch(
        running,
        running.baseStateGeneration ?? 0,
        dispatch.stateAdoption,
        dispatch.priorState,
      );
      const planPolicy = await this.#policyForPlanRun(running);
      const providerInstallationPolicy =
        planPolicy?.providerInstallation?.requireMirror === true
          ? { requireMirror: true }
          : undefined;
      const scopeSelectors = planScopeSelectors(planPolicy?.scopeBoundary);
      const runner = this.#runnerForProfile(profile);
      const dispatchPlan = (
        environment: ResolvedRunEnvironment,
        signal: AbortSignal,
      ) =>
        runner.plan(
          {
            planRun: effectiveRunning,
            runnerProfile: profile,
            variables,
            ...(providerInstallationPolicy
              ? { providerInstallationPolicy }
              : {}),
            ...(scopeSelectors.length > 0 ? { scopeSelectors } : {}),
            // Capsules use a generated root only when explicit provider configuration
            // requires a child-module wrapper.
            ...(dispatch.generatedRoot
              ? { generatedRoot: dispatch.generatedRoot }
              : {}),
            ...(dispatch.operatorModule
              ? {
                  operatorModule: dispatch.operatorModule,
                  legacySourcelessDestroyRecovery: true as const,
                }
              : {}),
            ...(dispatch.sourceBuild
              ? { sourceBuild: dispatch.sourceBuild }
              : {}),
            ...((dispatch.workspaceOutputAllowlist ?? dispatch.outputAllowlist)
              ? {
                  outputAllowlist:
                    dispatch.workspaceOutputAllowlist ??
                    dispatch.outputAllowlist,
                }
              : {}),
            // M2 env dispatch (state scope + source archive). Absent without env ctx.
            ...(envDispatch.stateScope
              ? { stateScope: envDispatch.stateScope }
              : {}),
            ...(envDispatch.stateAdoption
              ? { stateAdoption: envDispatch.stateAdoption }
              : {}),
            ...(envDispatch.sourceArchive
              ? { sourceArchive: envDispatch.sourceArchive }
              : {}),
            // remote_state dependency states materialized into /work/deps (spec §15).
            ...(envDispatch.depStates
              ? { depStates: envDispatch.depStates }
              : {}),
            // Dispatch-only: the minted env never lands on the persisted run.
            ...(environment.credentials
              ? { credentials: environment.credentials }
              : {}),
          },
          { signal },
        );
      const result = await this.#withRunRenewal(
        "plan",
        effectiveRunning,
        leaseToken,
        undefined,
        (signal) => dispatchPlan(effectiveRunEnvironment, signal),
      );
      const now = this.#now();
      const verdict = await this.#evaluatePlanCompletion({
        running: effectiveRunning,
        profile,
        result,
        now,
      });
      const completed = this.#buildCompletedPlanRun({
        running: effectiveRunning,
        result,
        verdict,
        now,
      });
      // plan→apply TOCTOU pin (S2): hash the resolved provider env bindings this
      // plan was reviewed against onto the plan (capsule-context runs only),
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
        workspaceId: updated.workspaceId ?? updated.workspaceId,
        runId: updated.id,
        capsuleId: updated.capsuleId,
        startedAt: effectiveRunning.startedAt,
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
      await this.#maybeAutoApplyCompletedPlan(updated);
      return updated;
    } catch (error) {
      if (isRetryableRunnerInfrastructureError(error)) {
        const retryEvent =
          running.operation === "destroy"
            ? "destroy_plan.retry_scheduled"
            : "plan.retry_scheduled";
        if (
          runnerInfrastructureRetryCount(running, [retryEvent]) >=
          RUNNER_INFRASTRUCTURE_RETRY_LIMIT
        ) {
          return await this.#failPlanRun(
            running,
            leaseToken,
            runnerInfrastructureRetryExhaustedError(
              running.operation === "destroy" ? "destroy_plan" : "plan",
            ),
          );
        }
        const queued = await this.#requeuePlanRunAfterRunnerInfrastructureError(
          running,
          leaseToken,
          error,
        );
        if (queued) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            `retryable_runner_infrastructure_error: plan run ${queued.id} requeued after runner infrastructure failure`,
            { reason: RUNNER_INFRASTRUCTURE_REQUEUED_REASON },
          );
        }
      }
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
    if (
      result.requiredProviders !== undefined &&
      JSON.stringify(requiredProviders) !==
        JSON.stringify(normalizeProviders(running.requiredProviders))
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "runner requiredProviders do not match the compatibility-reviewed provider packages",
      );
    }
    if (running.requiredProviderRequirements !== undefined) {
      requiredProviderRequirementsForNewPlan(
        requiredProviders,
        running.requiredProviderRequirements,
      );
    }
    // Re-evaluate against the SAME provider-free allowance as the create gate:
    // a provider-free Capsule that observes zero providers at
    // plan time stays passed instead of tripping the "providers before init"
    // gate. This is derived from the recorded Capsule run.
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
    // policy (layer 7) over them for all runs. Capsule runs use the DB-owned
    // Workspace/InstallConfig policy resolved through installConfigId;
    //   - raw `/internal/v1/plan-runs` runs without capsule context keep today's
    //     behavior (no allowlist source -> no resource enforcement).
    // A disallowed resource type DENIES the plan; a delete/replace marks it
    // requiresApproval (parked waiting_approval until approved).
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
      operation: running.operation,
      ...(running.compatibilityReportId
        ? { compatibilityReportId: running.compatibilityReportId }
        : {}),
      ...(running.sourceSnapshotId
        ? { sourceSnapshotId: running.sourceSnapshotId }
        : {}),
      ...(runPolicy ? { policy: runPolicy } : {}),
    });
    const billingPolicy = await this.#billing.evaluatePlanBilling({
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
      running.driftCheck !== true &&
      running.refreshOnly !== true &&
      layered.action?.requiresApproval === true;
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
   * summary, and the `plan.policy_evaluated` +
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
    // §25 approval gate as a PERSISTED status (S2): a destroy plan is always
    // two-stage — it MUST carry a recorded approval (`approveRun`) before apply —
    // so a passed destroy plan parks in the persisted `waiting_approval` status
    // instead of `succeeded` (it was previously `succeeded` + a read-time
    // derivation). An action-policy delete/replace plan keeps the persisted
    // `succeeded` status and carries its gate in `requiresApproval`, which
    // `planAwaitsApproval` (read model) and `createApplyRun` (apply gate) both
    // honour. A read-only drift_check never parks; a policy-denied plan is
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
   *     the recorded Workspace/InstallConfig policy. A
   *     raw `/internal/v1/plan-runs` run without capsule context has no allowlist
   *     source -> no resource enforcement.
   *   - `scope`: the §25 scope boundary using sanitized provider metadata when
   *     configured.
   *   - `action`: the §25 action policy (delete/replace requires approval).
   *   - `quota`: the §25 simple mutating-resource count quota when configured.
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
    // Enforce the composed Workspace/InstallConfig policy. An undefined
    // allowlist (or a run without
    // capsule context) means "not configured" -> no resource enforcement.
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
   * Resolves the Workspace + InstallConfig policy for an capsule-context plan.
   * Workspace policy is a ceiling; InstallConfig policy can narrow it but not widen
  * it. Returns `undefined` for runs without capsule context or when the
   * Capsule / config is absent.
  */
  async #policyForPlanRun(planRun: PlanRun): Promise<PolicyConfig | undefined> {
    const capsuleId = planRun.capsuleContext?.capsuleId ?? planRun.capsuleId;
    if (!capsuleId) return undefined;
    const capsule = await this.#store.getCapsule(capsuleId);
    if (!capsule) return undefined;
    const profile = await this.#store.getRunnerProfile(planRun.runnerProfileId);
    return await this.#policyForCapsule(capsule, profile);
  }

  async #policyForCapsule(
    capsule: Capsule,
    runnerProfile?: RunnerProfile,
  ): Promise<PolicyConfig | undefined> {
    const [workspace, installConfig] = await Promise.all([
      this.#store.getWorkspace(capsule.workspaceId),
      this.#store.getInstallConfig(capsule.installConfigId),
    ]);
    return withDefaultProviderSupplyChainPolicy(
      mergePolicyConfigs(workspace?.policy, installConfig?.policy),
      {
        providerInstallationRequireMirror:
          defaultProviderMirrorRequiredForProfile(runnerProfile),
      },
    );
  }

  async #recordRunnerMinuteUsage(input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly capsuleId?: string;
    readonly startedAt?: number;
    readonly finishedAt: number;
  }): Promise<void> {
    if (input.startedAt === undefined) return;
    const durationMs = Math.max(0, input.finishedAt - input.startedAt);
    const quantity = durationMs / 60_000;
    const createdAt = new Date(input.finishedAt).toISOString();
    const rating = await this.#billing.rateUsageMeasurement({
      workspaceId: input.workspaceId,
      ...(input.capsuleId ? { capsuleId: input.capsuleId } : {}),
      runId: input.runId,
      meterId: "opentofu.runner",
      kind: "runner_minute",
      quantity,
      source: "runner",
      createdAt,
    });
    if (!rating) return;
    await this.#store.putUsageEvent({
      id: this.#newId("usage"),
      workspaceId: input.workspaceId,
      ...(input.capsuleId ? { capsuleId: input.capsuleId } : {}),
      runId: input.runId,
      kind: "runner_minute",
      quantity,
      usdMicros: rating.usdMicros,
      ratingStatus: rating.ratingStatus,
      source: "runner",
      idempotencyKey: `${input.runId}:runner_minute`,
      createdAt,
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
      workspace_id: input.run.workspaceId,
      capsule_id: input.run.capsuleId ?? "unbound",
      operation_kind: input.operationKind,
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

  /** Whether a Capsule plan legitimately discovered no provider usage. */
  #planAllowsNoProviders(planRun: PlanRun): boolean {
    return (
      planRun.capsuleId !== undefined &&
      planRun.sourceSnapshotId !== undefined &&
      planRun.requiredProviders.length === 0
    );
  }

  async #executeApply(
    applyRun: ApplyRun,
    planRun: PlanRun,
    profile: RunnerProfile,
    dispatch: RunModuleDispatch,
    inputs: PlanRunInputs | undefined,
    lease?: LeaseHandle,
  ): Promise<ApplyRunExecutionResponse> {
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
    let ledgerCommitted = false;

    try {
      const plannedCapsule = await this.#assertApplyPreconditions(
        planRun,
        dispatch,
      );
      await this.#revalidateModuleVariableMaterialization(
        planRun,
        inputs,
        planRun.operation === "destroy" ? "apply_check" : "apply",
      );
      // The Plan pins lifecycle action content, but runner execution authority
      // is revocable operator state. Re-check it immediately before any
      // provider or lifecycle dispatch so an old Plan cannot retain a removed
      // capability. This also rejects legacy mixed credential modes before a
      // shared release-command credential context could expose secrets to a
      // sibling command that did not opt in.
      assertPinnedLifecycleRunnerCapabilities(
        dispatch.lifecycleActions,
        profile,
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
          plannedCapsule,
          runEnvironment.credentials,
          dispatch,
          inputs,
          leaseToken,
          lease,
        );
      }
      // Renewal harness: #dispatchApply's runner.apply() is ONE awaited blocking
      // fetch for the whole tofu run, which can outlive the lease TTL + the
      // heartbeat-stale window. Around it, periodically re-stamp the run
      // heartbeat AND renew the capsule/plan lease so a sibling does not
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
        (signal) =>
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
            signal,
          }),
      );
      const now = this.#now();
      if (result.providerExecutionFailure) {
        const committedFailure =
          await this.#commitFailedProviderMutationWithState({
            action: "apply",
            running: runningWithEnv,
            applyRun,
            planRun,
            profile,
            plannedCapsule,
            result,
            envDispatch,
            persistGeneration,
            providerInstallationPolicy,
            leaseToken,
            startedAt,
            now,
          });
        if (committedFailure === "lease_lost") {
          return {
            applyRun: (await this.getApplyRun(applyRun.id)).applyRun,
            [APPLY_EXECUTION_LEASE_LOST]: true,
          };
        }
        ledgerCommitted = true;
        return await this.#completeFailedProviderMutation({
          action: "apply",
          ...committedFailure,
          planRun,
          startedAt,
          now,
        });
      }
      const projected = await this.#projectAndRecordApplyOutputs({
        planRun,
        applyRun,
        plannedCapsule,
        result,
        envDispatch,
        dispatch,
        now,
      });
      const stateVersion = await this.#buildStateVersion({
        envDispatch,
        generation: persistGeneration,
        stateDigest: result.stateDigest,
        runId: applyRun.id,
        now,
      });
      if (!stateVersion) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "apply completed without a durable Capsule state scope",
        );
      }
      // Build the terminal ApplyRun + apply-once PlanRun marker before the
      // atomic Run + StateVersion + Output commit.
      const providerApplied = this.#buildCompletedApplyRun({
        running: runningWithEnv,
        applyRun,
        profile,
        capsule: projected.capsule,
        stateVersionId: stateVersion.id,
        outputId: projected.output.id,
        outputCount: Object.keys(projected.output.publicOutputs).length,
        result,
        providerInstallationPolicy,
        startedAt,
        now,
      });
      // Required post-apply actions are part of the reviewed Run boundary, not
      // a best-effort notification after readiness. Execute the Plan-pinned
      // commands after provider state/output persistence has completed in the
      // runner, but before the atomic ledger makes the Capsule active.
      const lifecycleOutcome = await this.#withRunRenewal(
        "apply",
        runningWithEnv,
        leaseToken,
        lease,
        (signal) =>
          this.#activateReleaseAfterApply({
            planRun,
            applyRun: providerApplied,
            capsule: projected.capsule,
            stateVersion,
            output: projected.output,
            result,
            lifecycleActions: dispatch.lifecycleActions,
            sourceBuild: dispatch.sourceBuild,
            signal,
          }),
      );
      const completed = this.#applyPostApplyLifecycleOutcome({
        providerApplied,
        lifecycleOutcome,
        now,
      });
      const appliedPlan: PlanRun = {
        ...planRun,
        appliedApplyRunId: applyRun.id,
        updatedAt: now,
      };
      // Close the observable lifecycle Activity before attempting the guarded
      // ledger commit. The action has already reached a concrete adapter
      // outcome; if the commit loses its lease or conflicts, leaving only the
      // earlier `pending` Activity would falsely imply resumable background
      // work. This Activity describes the action outcome, not ledger success.
      if (lifecycleOutcome) {
        await this.#recordLifecycleActionOutcome({
          applyRun: completed,
          capsule: projected.capsule,
          stateVersion,
          outcome: lifecycleOutcome,
        });
      }
      // Atomic authority: terminal Run + StateVersion + Output + Capsule cursors.
      const patched = await this.#commitApplyLedger({
        planRun,
        plannedCapsule,
        capsule: projected.capsule,
        stateVersion,
        output: projected.output,
        previousOutput: projected.previousOutput,
        nextStateGeneration: projected.nextStateGeneration,
        applyRunTerminal: completed,
        planRunApplied: appliedPlan,
        applyRunLeaseToken: leaseToken,
        capsuleStatus: completed.status === "succeeded" ? "active" : "error",
        inputs,
        now,
      });
      if (patched === "lease_lost") {
        return {
          applyRun: (await this.getApplyRun(applyRun.id)).applyRun,
          [APPLY_EXECUTION_LEASE_LOST]: true,
        };
      }
      ledgerCommitted = true;
      // §24 stale propagation: when this apply's projected outputs changed
      // versus the Capsule's PREVIOUS Output, every transitive
      // downstream consumer in the Workspace that is currently `active` is marked
      // `stale`. The just-applied Capsule keeps the status selected by the
      // lifecycle gate (`active` or fail-closed `error`); pending/error/
      // destroyed consumers are left untouched.
      await this.#markDownstreamCapsulesStale({
        capsule: projected.capsule,
        previousOutput: projected.previousOutput,
        newOutput: projected.output,
        now,
      });
      return await this.#completeApplyRun({
        completed,
        planRun,
        capsule: projected.capsule,
        patched,
        outputCount: Object.keys(projected.output.publicOutputs).length,
        nextStateGeneration: projected.nextStateGeneration,
        startedAt,
        now,
      });
    } catch (error) {
      // A busy Capsule lease is a queue contention signal, not an Apply
      // failure. Leave the claimed Run retryable so the queue owner redelivers
      // after the lease holder releases the shared scope.
      if (error instanceof CapsuleLeaseBusyError) throw error;
      if (ledgerCommitted) {
        // The atomic provider ledger is already authoritative. Never route a
        // downstream cleanup/observer failure through reservation release or
        // terminal failure rewriting; leave/retry the durable billing marker.
        const persisted = (await this.#store.getApplyRun(applyRun.id))!;
        const finalized = await this.#tryFinalizeApplyBilling(
          planRun,
          persisted,
        );
        log.warn("deploy_control.apply_post_commit_finalization_failed", {
          planRunId: planRun.id,
          applyRunId: applyRun.id,
          message: errorMessage(error),
        });
        const currentCapsule = planRun.capsuleId
          ? await this.#store.getCapsule(planRun.capsuleId)
          : undefined;
        return {
          applyRun: finalized,
          ...(currentCapsule ? { capsule: currentCapsule } : {}),
        };
      }
      if (error instanceof ArtifactLedgerTailAmbiguousError) {
        const operationKind =
          planRun.operation === "destroy" ? "destroy_apply" : "apply";
        const recovered =
          await this.#requeueApplyRunAfterArtifactLedgerTailError(
            runningForFailure,
            leaseToken,
            profile,
            startedAt,
            operationKind,
          );
        if (recovered) {
          const finalized = isTerminalStatus(recovered.status)
            ? await this.#tryFinalizeApplyBilling(planRun, recovered)
            : recovered;
          const currentCapsule = recovered.capsuleId
            ? await this.#store.getCapsule(recovered.capsuleId)
            : undefined;
          return {
            applyRun: finalized,
            ...(currentCapsule ? { capsule: currentCapsule } : {}),
          };
        }
        throw error;
      }
      if (isRunnerInfrastructureRequeueError(error)) {
        // Destroy owns its retry transition inside #executeDestroyApply. Do not
        // let that structured signal fall through this outer apply catch and
        // release the still-needed reservation after the row was requeued.
        const requeued = await this.#store.getApplyRun(applyRun.id);
        if (requeued?.status === "queued") {
          const currentCapsule = requeued.capsuleId
            ? await this.#store.getCapsule(requeued.capsuleId)
            : undefined;
          return {
            applyRun: requeued,
            ...(currentCapsule ? { capsule: currentCapsule } : {}),
          };
        }
        throw error;
      }
      if (error instanceof PlanAlreadyAppliedReplay) {
        return await this.#completeApplyRunAsIdempotentReplay({
          running,
          planRun,
          profile,
          startedAt,
          leaseToken,
          existingApplyRunId: error.existingApplyRunId,
        });
      }
      if (
        runnerDispatched &&
        isSafeMutatingRunnerInfrastructureRetryError(error)
      ) {
        const runningWithEnvironmentFailure = runEnvironmentFailedRun(
          runningForFailure,
          error,
        );
        if (
          runnerInfrastructureRetryCount(runningWithEnvironmentFailure, [
            "apply.retry_scheduled",
          ]) >= RUNNER_INFRASTRUCTURE_RETRY_LIMIT
        ) {
          await this.#billing.releaseApplyBilling(planRun);
          const failed = await this.#failApplyRun(
            runningWithEnvironmentFailure,
            leaseToken,
            profile,
            startedAt,
            "apply.failed",
            runnerInfrastructureRetryExhaustedError("apply"),
            true,
          );
          if (failed.finishedAt !== undefined) {
            await this.#recordRunnerMinuteUsage({
              workspaceId: failed.workspaceId,
              runId: failed.id,
              capsuleId: failed.capsuleId,
              startedAt,
              finishedAt: failed.finishedAt,
            });
          }
          return { applyRun: failed };
        }
        const queued =
          await this.#requeueApplyRunAfterRunnerInfrastructureError(
            runningWithEnvironmentFailure,
            leaseToken,
            profile,
            startedAt,
            error,
          );
        if (queued) {
          const retryError = new OpenTofuControllerError(
            "failed_precondition",
            `retryable_runner_infrastructure_error: apply run ${queued.id} requeued after runner infrastructure failure`,
            { reason: RUNNER_INFRASTRUCTURE_REQUEUED_REASON },
          );
          if (queued.updatedAt !== undefined) {
            await this.#recordRunnerMinuteUsage({
              workspaceId: queued.workspaceId,
              runId: queued.id,
              capsuleId: queued.capsuleId,
              startedAt,
              finishedAt: queued.updatedAt,
            });
          }
          throw retryError;
        }
      }
      await this.#billing.releaseApplyBilling(planRun);
      const failed = await this.#failApplyRun(
        runEnvironmentFailedRun(runningForFailure, error),
        leaseToken,
        profile,
        startedAt,
        "apply.failed",
        error,
        runnerDispatched,
      );
      if (runnerDispatched && failed.finishedAt !== undefined) {
        await this.#recordRunnerMinuteUsage({
          workspaceId: failed.workspaceId,
          runId: failed.id,
          capsuleId: failed.capsuleId,
          startedAt,
          finishedAt: failed.finishedAt,
        });
      }
      return { applyRun: failed };
    }
  }

  /** Projects only the DB-owned public allowlist after redaction. */
  #projectApplyOutputs(
    _planRun: PlanRun,
    result: OpenTofuApplyResult,
    dispatch: RunModuleDispatch,
  ): Readonly<Record<string, JsonValue>> {
    if (dispatch.outputAllowlist) {
      return projectOutputAllowlistPublicOutputs(
        dispatch.outputAllowlist,
        result.outputs,
      );
    }
    return {};
  }

  /**
   * Re-asserts every apply pre-flight invariant inside the serialized section
   * (immutable plan artifact, apply-once, state generation, source snapshot,
   * dependency snapshot, Capsule compatibility, generated-root dispatch, and
   * billing reservation) just before dispatch. Returns the currently-planned
   * Capsule (undefined for runs without Capsule context).
   */
  async #assertApplyPreconditions(
    planRun: PlanRun,
    dispatch: RunModuleDispatch,
  ): Promise<Capsule | undefined> {
    if (!planRun.planArtifact) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} has no immutable plan artifact`,
      );
    }
    // Apply-once re-check inside the serialized section: a concurrent apply of the
    // same PlanRun is serialized on its id, so re-read the persisted PlanRun here
    // to observe a sibling apply that already completed and marked it applied.
    // This is an idempotent replay of the same reviewed plan, not a user-visible
    // failed run.
    const persistedPlan = await this.#store.getPlanRun(planRun.id);
    if (persistedPlan?.appliedApplyRunId) {
      throw new PlanAlreadyAppliedReplay(
        planRun.id,
        persistedPlan.appliedApplyRunId,
      );
    }
    const plannedCapsule = planRun.capsuleId
      ? await this.#requireCurrentPlannedCapsule(planRun)
      : undefined;
    // State generation guard: reject when the target's state advanced past the
    // generation this plan was created against (a stale plan over newer state).
    assertStateGenerationMatches(planRun, plannedCapsule);
    // Env-driven runs guard against the Environment's latest StateVersion
    // generation instead of an Capsule generation (M2).
    await this.#verification.assertCapsuleStateGeneration(planRun);
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
    await this.#billing.assertApplyBillingAllowed(planRun);
    return plannedCapsule;
  }

  /**
   * Dispatches the non-destroy apply to the runner. Resolves the M2 env dispatch
   * (state scope at `base + 1` + source archive + dependency states) and the
   * provider-capsule mirror policy, then runs `runner.apply` with the minted
   * credentials (dispatch-only — never persisted).
   */
  async #dispatchApply(input: {
    readonly running: ApplyRun;
    readonly planRun: PlanRun;
    readonly profile: RunnerProfile;
    readonly dispatch: RunModuleDispatch;
    readonly credentials: RunCredentials | undefined;
    readonly signal: AbortSignal;
    /** Fired immediately before the runner is invoked (runner-dispatched flag). */
    readonly onDispatch: () => void;
  }): Promise<{
    result: OpenTofuApplyResult;
    envDispatch: RunExecutionDispatch;
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
    const verifiedDispatch = await this.#verification.executionDispatch(
      planRun,
      persistGeneration,
      dispatch.stateAdoption,
      dispatch.priorState,
    );
    const rawOutputRef = await this.#allocateRawOutputRef(
      running,
      verifiedDispatch,
    );
    const envDispatch: RunExecutionDispatch = {
      ...verifiedDispatch,
      rawOutputRef,
    };
    const planPolicy = await this.#policyForPlanRun(planRun);
    const providerInstallationPolicy =
      planPolicy?.providerInstallation?.requireMirror === true
        ? { requireMirror: true }
        : undefined;
    input.onDispatch();
    const runner = this.#runnerForProfile(profile);
    const result = await runner.apply(
      {
        applyRun: running,
        planRun,
        planArtifact,
        runnerProfile: profile,
        ...(providerInstallationPolicy ? { providerInstallationPolicy } : {}),
        // Generated-root dispatch: apply tofu in the reviewed root.
        ...(dispatch.generatedRoot
          ? { generatedRoot: dispatch.generatedRoot }
          : {}),
        ...(dispatch.operatorModule
          ? {
              operatorModule: dispatch.operatorModule,
              legacySourcelessDestroyRecovery: true as const,
            }
          : {}),
        ...(dispatch.sourceBuild ? { sourceBuild: dispatch.sourceBuild } : {}),
        // M2 env dispatch (state scope at base+1 + source archive).
        ...(envDispatch.stateScope
          ? { stateScope: envDispatch.stateScope }
          : {}),
        rawOutputRef,
        ...(envDispatch.stateAdoption
          ? { stateAdoption: envDispatch.stateAdoption }
          : {}),
        ...(envDispatch.sourceArchive
          ? { sourceArchive: envDispatch.sourceArchive }
          : {}),
        // remote_state dependency states materialized into /work/deps (spec §15).
        ...(envDispatch.depStates ? { depStates: envDispatch.depStates } : {}),
        ...(credentials ? { credentials } : {}),
      },
      { signal: input.signal },
    );
    if (result.providerExecutionFailure) {
      const stateWasPersisted =
        result.providerExecutionFailure.statePersistence === "persisted";
      if (stateWasPersisted !== Boolean(result.stateDigest?.trim())) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `runner returned inconsistent failed-state persistence evidence for apply run ${running.id}`,
        );
      }
      return {
        result,
        envDispatch,
        persistGeneration,
        providerInstallationPolicy,
      };
    }
    if (result.rawOutputRef !== rawOutputRef) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `runner did not confirm the exact allocated raw output reference for apply run ${running.id}`,
      );
    }
    return {
      result,
      envDispatch,
      persistGeneration,
      providerInstallationPolicy,
    };
  }

  /**
   * Projects the apply outputs and BUILDS the §16 Output (persisted
   * later, atomically, by `commitRunState`). Returns the resolved
   * Capsule, the bumped state generation, the new Output, and the Capsule's
   * PREVIOUS Output (which drives §24 stale propagation).
   */
  async #projectAndRecordApplyOutputs(input: {
    readonly planRun: PlanRun;
    readonly applyRun: ApplyRun;
    readonly plannedCapsule: Capsule | undefined;
    readonly result: OpenTofuApplyResult;
    readonly envDispatch: RunExecutionDispatch;
    readonly dispatch: RunModuleDispatch;
    readonly now: number;
  }): Promise<{
    capsule: Capsule;
    nextStateGeneration: number;
    previousOutput: Output | undefined;
    output: Output;
  }> {
    const { planRun, applyRun, result, envDispatch, dispatch, now } = input;
    // A Capsule keeps its broader non-secret Workspace capture separate from the
    // explicitly allowlisted public Output projection.
    const publicOutputs = this.#projectApplyOutputs(planRun, result, dispatch);
    const capsule =
      input.plannedCapsule ??
      (await this.#requireCurrentPlannedCapsule(planRun));
    // Bump the state generation atomically with the state persist (the
    // current StateVersion pointer move). A create starts at base 0 -> 1; an
    // update advances the capsule's generation by one.
    const nextStateGeneration = capsule.currentStateGeneration + 1;
    // §16 Output: capture the allowlisted projected outputs after a
    // successful apply. Sensitive-flagged outputs appear in NEITHER
    // projection; the raw envelope stays an encrypted artifact referenced by
    // rawArtifactRef. The Capsule's PREVIOUS snapshot digest drives
    // stale propagation (§24) after this record.
    const previousOutput = capsule.currentOutputId
      ? await this.#store.getOutput(capsule.currentOutputId)
      : undefined;
    const output = await this.#buildOutput({
      capsule,
      applyRun,
      result,
      envDispatch,
      publicOutputs,
      ...(dispatch.workspaceOutputAllowlist
        ? { workspaceOutputAllowlist: dispatch.workspaceOutputAllowlist }
        : {}),
      ...(dispatch.outputAllowlist
        ? { outputAllowlist: dispatch.outputAllowlist }
        : {}),
      stateGeneration: nextStateGeneration,
      now,
    });
    return {
      capsule,
      nextStateGeneration,
      previousOutput,
      output,
    };
  }

  /**
   * Atomically commits the provider-applied StateVersion/Output, applied Plan
   * marker, terminal Run, and runtime-readiness Capsule status. A lifecycle
   * failure deliberately commits `error` + failed Run without discarding the
   * successfully materialized provider state.
   */
  async #commitApplyLedger(input: {
    readonly planRun: PlanRun;
    readonly plannedCapsule: Capsule | undefined;
    readonly capsule: Capsule;
    readonly stateVersion: StateVersion;
    readonly output: Output;
    readonly previousOutput: Output | undefined;
    readonly nextStateGeneration: number;
    readonly applyRunTerminal: ApplyRun;
    readonly planRunApplied: PlanRun;
    readonly applyRunLeaseToken: string;
    readonly capsuleStatus: "active" | "error";
    readonly inputs: PlanRunInputs | undefined;
    readonly now: number;
  }): Promise<Capsule | "lease_lost" | undefined> {
    const { planRun, capsule, stateVersion, output, now } = input;
    let committed: Awaited<
      ReturnType<OpenTofuControlStore["commitRunState"]>
    >;
    try {
      committed = await this.#store.commitRunState({
        stateVersion,
        output,
        capsulePatch: {
          id: capsule.id,
          patch: {
            currentStateVersionId: stateVersion.id,
            status: input.capsuleStatus,
            updatedAt: new Date(now).toISOString(),
            currentStateGeneration: input.nextStateGeneration,
            currentOutputId: output.id,
          },
          guard: {
            currentStateVersionId:
              planRun.capsuleCurrentStateVersionId ?? undefined,
            status: input.plannedCapsule?.status,
          },
        },
        // Commit-tail fold (S2): terminal ApplyRun + applied PlanRun in the unit.
        applyRunTerminal: input.applyRunTerminal,
        planRunApplied: input.planRunApplied,
        applyRunLeaseToken: input.applyRunLeaseToken,
        ...(input.applyRunTerminal.status === "succeeded" &&
        input.inputs?.interfaceMaterialization
          ? {
              interfaceMaterializationIntent:
                createCapsuleInterfaceMaterializationIntent({
                  applyRunId: input.applyRunTerminal.id,
                  workspaceId: capsule.workspaceId,
                  capsuleId: capsule.id,
                  stateVersionId: stateVersion.id,
                  outputId: output.id,
                  stateGeneration: input.nextStateGeneration,
                  pinned: input.inputs.interfaceMaterialization,
                  createdAt: new Date(now).toISOString(),
                }),
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof CapsuleStateVersionGuardConflict) throw error;
      throw new ArtifactLedgerTailAmbiguousError(
        input.applyRunTerminal.id,
        error,
      );
    }
    if (committed.applyRunLeaseLost) return "lease_lost";
    // The atomic commit above is the terminal-state authority. Notify before
    // billing/activity side effects so Interface safety observes the durable
    // ApplyRun + Output/State generation immediately.
    await this.#notifyTerminal(input.applyRunTerminal);
    return committed.capsule;
  }

  async #commitFailedProviderMutationWithState(input: {
    readonly action: "apply" | "destroy";
    readonly running: ApplyRun;
    readonly applyRun: ApplyRun;
    readonly planRun: PlanRun;
    readonly profile: RunnerProfile;
    readonly plannedCapsule: Capsule | undefined;
    readonly result: OpenTofuApplyResult | OpenTofuDestroyResult;
    readonly envDispatch: RunExecutionDispatch;
    readonly persistGeneration: number;
    readonly providerInstallationPolicy:
      | { readonly requireMirror: boolean }
      | undefined;
    readonly leaseToken: string;
    readonly startedAt: number;
    readonly now: number;
  }): Promise<
    | {
        readonly failed: ApplyRun;
        readonly capsule: Capsule;
        readonly stateVersion: StateVersion | undefined;
        readonly nextStateGeneration: number;
      }
    | "lease_lost"
  > {
    const action = input.action;
    const failure = input.result.providerExecutionFailure;
    if (!failure) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "provider failure commit requires a typed provider execution failure",
      );
    }
    const capsule =
      input.plannedCapsule ??
      (await this.#requireCurrentPlannedCapsule(input.planRun));
    const stateVersion =
      failure.statePersistence === "persisted"
        ? await this.#buildStateVersion({
            envDispatch: input.envDispatch,
            generation: input.persistGeneration,
            stateDigest: input.result.stateDigest,
            runId: input.applyRun.id,
            now: input.now,
          })
        : undefined;
    if (failure.statePersistence === "persisted" && !stateVersion) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `failed provider ${action} returned state without a durable Capsule state scope`,
      );
    }
    const nextStateGeneration = stateVersion
      ? input.persistGeneration
      : capsule.currentStateGeneration;
    const errorCode = failure.errorCode ?? "apply_failed";
    const diagnostics = redactRunDiagnostics(input.result.diagnostics) ?? [];
    const stateLock =
      "stateLock" in input.result ? input.result.stateLock : undefined;
    const failed: ApplyRun = {
      ...input.running,
      capsuleId: capsule.id,
      ...(stateVersion ? { stateVersionId: stateVersion.id } : {}),
      outputId: undefined,
      status: "failed",
      stateLock:
        stateLock ??
        stateLockEvidence(
          input.profile.stateBackend,
          input.startedAt,
          input.now,
          "recorded",
        ),
      diagnostics: [
        ...diagnostics,
        {
          severity: "error",
          code: errorCode,
          message: "OpenTofu provider execution failed after dispatch",
        },
      ],
      auditEvents: [
        ...input.running.auditEvents,
        ...providerInstallationAuditEvents(
          input.applyRun.id,
          action,
          input.now,
          input.result.providerInstallation,
          input.providerInstallationPolicy,
        ),
        auditEvent(input.applyRun.id, `${action}.failed`, input.now, {
          message: "OpenTofu provider execution failed after dispatch",
          providerDispatched: true,
          ...(action === "destroy"
            ? { providerDestroySucceeded: false }
            : { providerApplySucceeded: false }),
          statePersistence: failure.statePersistence,
          ...(stateVersion ? { stateVersionId: stateVersion.id } : {}),
        }),
      ],
      updatedAt: input.now,
      finishedAt: input.now,
    };
    const appliedPlan: PlanRun = {
      ...input.planRun,
      appliedApplyRunId: input.applyRun.id,
      updatedAt: input.now,
    };
    let committed: Awaited<
      ReturnType<OpenTofuControlStore["commitRunState"]>
    >;
    try {
      committed = await this.#store.commitRunState({
        ...(stateVersion ? { stateVersion } : {}),
        capsulePatch: {
          id: capsule.id,
          patch: {
            ...(stateVersion
              ? {
                  currentStateVersionId: stateVersion.id,
                  currentStateGeneration: nextStateGeneration,
                }
              : {}),
            currentOutputId: undefined,
            status: "error",
            updatedAt: new Date(input.now).toISOString(),
          },
          guard: {
            currentStateVersionId:
              input.planRun.capsuleCurrentStateVersionId ?? undefined,
            status: input.plannedCapsule?.status,
          },
        },
        applyRunTerminal: failed,
        planRunApplied: appliedPlan,
        applyRunLeaseToken: input.leaseToken,
      });
    } catch (error) {
      if (error instanceof CapsuleStateVersionGuardConflict) throw error;
      throw new ArtifactLedgerTailAmbiguousError(input.applyRun.id, error);
    }
    if (committed.applyRunLeaseLost) return "lease_lost";
    await this.#notifyTerminal(failed);
    return {
      failed,
      capsule: committed.capsule ?? capsule,
      stateVersion,
      nextStateGeneration,
    };
  }

  async #completeFailedProviderMutation(input: {
    readonly action: "apply" | "destroy";
    readonly failed: ApplyRun;
    readonly capsule: Capsule;
    readonly stateVersion: StateVersion | undefined;
    readonly nextStateGeneration: number;
    readonly planRun: PlanRun;
    readonly startedAt: number;
    readonly now: number;
  }): Promise<ApplyRunResponse> {
    try {
      await this.#billing.releaseApplyBilling(input.planRun);
      await this.#recordRunnerMinuteUsage({
        workspaceId: input.failed.workspaceId,
        runId: input.failed.id,
        capsuleId: input.failed.capsuleId,
        startedAt: input.startedAt,
        finishedAt: input.now,
      });
      await this.#recordDeployOperationMetric({
        run: input.failed,
        operationKind: input.action === "destroy" ? "destroy_apply" : "apply",
        status: "failed",
        startedAt: input.startedAt,
        finishedAt: input.now,
        recordApplyDuration: true,
      });
      await this.#store.deletePlanRunInputs(input.planRun.id);
    } catch (error) {
      log.warn(
        input.action === "destroy"
          ? "deploy_control.destroy_post_commit_cleanup_failed"
          : "deploy_control.failed_apply_post_commit_cleanup_failed",
        {
          planRunId: input.planRun.id,
          applyRunId: input.failed.id,
          message: errorMessage(error),
        },
      );
    }
    const errorCode =
      input.failed.diagnostics?.find(
        (diagnostic) => diagnostic.severity === "error" && diagnostic.code,
      )?.code ?? (input.action === "destroy" ? "destroy_failed" : "apply_failed");
    await this.#recordActivity({
      workspaceId: input.failed.workspaceId,
      action: "run.failed",
      targetType: "run",
      targetId: input.failed.id,
      runId: input.failed.id,
      metadata: {
        phase: input.action === "destroy" ? "destroy_apply" : "apply",
        operation: input.failed.operation,
        errorCode,
        capsuleId: input.capsule.id,
        statePersistence: input.stateVersion ? "persisted" : "unavailable",
        ...(input.stateVersion
          ? {
              stateVersionId: input.stateVersion.id,
              stateGeneration: input.nextStateGeneration,
            }
          : {}),
      },
    });
    return { applyRun: input.failed, capsule: input.capsule };
  }

  async #activateReleaseAfterApply(input: {
    readonly planRun: PlanRun;
    readonly applyRun: ApplyRun;
    readonly capsule: Capsule;
    readonly stateVersion: StateVersion;
    readonly output: Output;
    readonly result: OpenTofuApplyResult;
    readonly lifecycleActions: InstallConfig["lifecycleActions"];
    readonly sourceBuild: InstallConfig["sourceBuild"];
    readonly signal: AbortSignal;
  }): Promise<LifecycleActionOutcome | undefined> {
    const commands = releaseActivationCommands(
      input.lifecycleActions,
      "post_apply",
    );
    if (commands.length === 0) return undefined;
    const nonSensitiveOutputs = releaseActivationOutputs(input.result.outputs);
    const base = {
      phase: "post_apply" as const,
      commandCount: commands.length,
      outputCount: Object.keys(nonSensitiveOutputs).length,
    };
    const sourceSnapshot = input.planRun.sourceSnapshotId
      ? await this.#store.getSourceSnapshot(input.planRun.sourceSnapshotId)
      : undefined;
    if (!this.#releaseActivator) {
      return {
        ...base,
        reportedStatus: "unavailable",
        activityStatus: "failed",
        actionDispatched: false,
        kind: "takosumi.install-config-actions@v1",
        message:
          "post-apply lifecycle actions declared but no release activator is configured",
      };
    }
    await this.#recordReleaseActivationActivity({
      ...input,
      status: "pending",
      kind: "takosumi.install-config-actions@v1",
      message: "post-apply lifecycle actions are running",
      commandCount: commands.length,
      outputCount: Object.keys(nonSensitiveOutputs).length,
    });
    let actionDispatched = false;
    try {
      const releaseEnvironment = await this.#releaseEnvironmentForCommands({
        planRun: input.planRun,
        applyRun: input.applyRun,
        commands,
        phase: "apply",
      });
      const runtimeSecretFileBundle =
        await this.#materializeRuntimeSecretFileAfterApply({
          capsule: input.capsule,
          commands,
        });
      let result: ReleaseActivationResult;
      actionDispatched = true;
      result = await this.#releaseActivator.activate(
        {
          planRun: input.planRun,
          applyRun: input.applyRun,
          capsule: input.capsule,
          stateVersion: input.stateVersion,
          output: input.output,
          nonSensitiveOutputs,
          providerConfigurations: releaseEnvironment.providerConfigurations,
          ...(releaseEnvironment.credentials
            ? { credentials: releaseEnvironment.credentials }
            : {}),
          ...(runtimeSecretFileBundle ? { runtimeSecretFileBundle } : {}),
          commands,
          ...(input.sourceBuild ? { sourceBuild: input.sourceBuild } : {}),
          ...(sourceSnapshot ? { sourceSnapshot } : {}),
        },
        { signal: input.signal },
      );
      if (result.status === "skipped" && commands.length > 0) {
        return {
          ...base,
          reportedStatus: "skipped",
          activityStatus: "failed",
          actionDispatched,
          ...(result.kind ? { kind: result.kind } : {}),
          message:
            result.message ??
            "release activator skipped declared post-apply commands",
        };
      }
      return {
        ...base,
        reportedStatus: result.status,
        // A declared phase has exactly one accepted terminal result. Preserve
        // the adapter's non-terminal/failed status in Run audit evidence, but
        // close the Activity event as failed so no durable "pending" record can
        // be mistaken for work that Takosumi will resume in the background.
        activityStatus: result.status === "succeeded" ? "succeeded" : "failed",
        actionDispatched,
        ...(result.kind ? { kind: result.kind } : {}),
        ...(result.message ? { message: result.message } : {}),
        hasHealthUrl: Boolean(result.healthUrl),
        metadataKeys: Object.keys(result.metadata ?? {}).sort(),
      };
    } catch (error) {
      return {
        ...base,
        reportedStatus: "error",
        activityStatus: "failed",
        actionDispatched,
        message: errorMessage(error),
        ...(error instanceof OpenTofuRunnerExecutionError && error.detail
          ? { detail: error.detail }
          : {}),
      };
    }
  }

  #applyPostApplyLifecycleOutcome(input: {
    readonly providerApplied: ApplyRun;
    readonly lifecycleOutcome: LifecycleActionOutcome | undefined;
    readonly now: number;
  }): ApplyRun {
    const outcome = input.lifecycleOutcome;
    if (!outcome || outcome.reportedStatus === "succeeded") {
      return input.providerApplied;
    }
    const error = new CapsuleLifecycleActionError(outcome);
    return {
      ...input.providerApplied,
      status: "failed",
      diagnostics: [
        ...(input.providerApplied.diagnostics ?? []),
        lifecycleActionDiagnostic(error),
      ],
      auditEvents: [
        ...input.providerApplied.auditEvents,
        auditEvent(
          input.providerApplied.id,
          `lifecycle_action.${outcome.phase}.${outcome.activityStatus}`,
          input.now,
          {
            phase: outcome.phase,
            status: outcome.reportedStatus,
            commandCount: outcome.commandCount,
            actionDispatched: outcome.actionDispatched,
          },
        ),
        auditEvent(input.providerApplied.id, "apply.failed", input.now, {
          message: error.message,
          providerDispatched: true,
          providerApplySucceeded: true,
          lifecycleActionDispatched: outcome.actionDispatched,
          lifecycleActionPhase: outcome.phase,
          lifecycleActionStatus: outcome.reportedStatus,
        }),
      ],
      updatedAt: input.now,
      finishedAt: input.now,
    };
  }

  async #recordLifecycleActionOutcome(input: {
    readonly applyRun: ApplyRun;
    readonly capsule: Capsule;
    readonly stateVersion: StateVersion;
    readonly outcome: LifecycleActionOutcome;
  }): Promise<void> {
    await this.#recordReleaseActivationActivity({
      applyRun: input.applyRun,
      capsule: input.capsule,
      stateVersion: input.stateVersion,
      status: input.outcome.activityStatus,
      ...(input.outcome.kind ? { kind: input.outcome.kind } : {}),
      ...(input.outcome.message ? { message: input.outcome.message } : {}),
      ...(input.outcome.hasHealthUrl === undefined
        ? {}
        : { hasHealthUrl: input.outcome.hasHealthUrl }),
      ...(input.outcome.metadataKeys
        ? { metadataKeys: input.outcome.metadataKeys }
        : {}),
      commandCount: input.outcome.commandCount,
      outputCount: input.outcome.outputCount,
    });
  }

  /**
   * Proves that a pre-destroy action is compensating for a failed first apply
   * rather than tearing down a live Capsule. This is intentionally narrow:
   * only generation 1, provider-dispatched create failures with durable state
   * and no Output may use the cleanup pairing. Any missing or contradictory
   * evidence returns `undefined`, leaving the normal missing-Output guard in
   * force.
   */
  async #failedFirstApplyCleanupEvidence(input: {
    readonly applyRun: ApplyRun;
    readonly capsule: Capsule;
    readonly stateVersion: StateVersion;
    readonly lifecycleActions: InstallConfig["lifecycleActions"];
  }): Promise<{
    readonly creatorRunId: string;
    readonly pairedActionIds: readonly string[];
    readonly reason: string;
    readonly alreadyPersisted: boolean;
  } | undefined> {
    const preDestroyActions = (input.lifecycleActions ?? []).filter(
      (action) => action.phase === "pre_destroy",
    );
    if (
      preDestroyActions.length === 0 ||
      preDestroyActions.some(
        (action) => action.kind !== "command" || action.cleanupFor === undefined,
      )
    ) {
      return undefined;
    }
    const actionsById = new Map(
      (input.lifecycleActions ?? []).map((action) => [action.id, action]),
    );
    const pairedActionIds = preDestroyActions.map(
      (action) => (action.kind === "command" ? action.cleanupFor : undefined)!,
    );
    if (
      pairedActionIds.length === 0 ||
      pairedActionIds.some((id) => {
        const paired = actionsById.get(id);
        return !paired || paired.phase !== "post_apply";
      })
    ) {
      return undefined;
    }

    if (
      input.capsule.currentStateVersionId !== input.stateVersion.id ||
      input.capsule.currentStateGeneration !== input.stateVersion.generation ||
      input.stateVersion.capsuleId !== input.capsule.id ||
      input.stateVersion.workspaceId !== input.capsule.workspaceId ||
      input.stateVersion.environment !== input.capsule.environment ||
      input.stateVersion.generation !== 1 ||
      input.capsule.currentOutputId !== undefined
    ) {
      return undefined;
    }

    const creatorRunId = input.stateVersion.createdByRunId;
    const creatorRun = await this.#store.getApplyRun(creatorRunId);
    if (
      !creatorRun ||
      creatorRun.id !== creatorRunId ||
      creatorRun.capsuleId !== input.capsule.id ||
      creatorRun.operation !== "create" ||
      creatorRun.status !== "failed" ||
      creatorRun.stateVersionId !== input.stateVersion.id ||
      creatorRun.outputId !== undefined
    ) {
      return undefined;
    }

    // A failed first apply must not have left an Output row behind even if a
    // stale Capsule pointer was later cleared. The generation-scoped check is
    // deliberately stronger than the two pointer checks above.
    const generationOutputs = await this.#store.listOutputs(input.capsule.id);
    if (
      generationOutputs.some(
        (output) => output.stateGeneration === input.stateVersion.generation,
      )
    ) {
      return undefined;
    }

    const providerFailureEvidence = creatorRun.auditEvents.some((event) => {
      if (event.type !== "apply.failed") return false;
      const data = event.data;
      return (
        data?.providerDispatched === true &&
        data.providerApplySucceeded === false &&
        data.statePersistence === "persisted" &&
        data.stateVersionId === input.stateVersion.id
      );
    });
    if (!providerFailureEvidence) return undefined;

    // Any lifecycle dispatch on the creator run invalidates the compensation
    // proof. In particular, a post_apply action may have mutated an external
    // system even though no Output was persisted.
    const lifecycleDispatched = [
      ...creatorRun.auditEvents,
      ...input.applyRun.auditEvents,
    ].some((event) => {
      const data = event.data;
      return (
        data?.lifecycleActionDispatched === true ||
        (event.type.startsWith("lifecycle_action.") &&
          data?.actionDispatched === true)
      );
    });
    if (lifecycleDispatched) return undefined;

    const reason = "provider_failed_before_post_apply";
    const marker = input.applyRun.auditEvents.find((event) => {
      if (event.type !== "lifecycle_action.pre_destroy.not_applicable") {
        return false;
      }
      const data = event.data;
      if (
        data?.stateVersionId !== input.stateVersion.id ||
        data.creatorRunId !== creatorRunId ||
        data.actionDispatched !== false
      ) {
        return false;
      }
      const markerIds = Array.isArray(data.pairedActionIds)
        ? data.pairedActionIds.filter(
            (id): id is string => typeof id === "string",
          )
        : data.pairedActionId !== undefined
          ? typeof data.pairedActionId === "string"
            ? [data.pairedActionId]
            : []
          : [];
      return (
        markerIds.length === pairedActionIds.length &&
        markerIds.every((id) => pairedActionIds.includes(id))
      );
    });

    return {
      creatorRunId,
      pairedActionIds,
      reason,
      alreadyPersisted: marker !== undefined,
    };
  }

  async #recordFailedFirstApplyCleanupActivity(input: {
    readonly applyRun: ApplyRun;
    readonly capsule: Capsule;
    readonly stateVersion: StateVersion;
    readonly creatorRunId: string;
    readonly pairedActionIds: readonly string[];
    readonly reason: string;
  }): Promise<void> {
    await this.#recordActivity({
      workspaceId: input.applyRun.workspaceId,
      action: "release_activation.not_applicable",
      targetType: "state_version",
      targetId: input.stateVersion.id,
      runId: input.applyRun.id,
      metadata: {
        capsuleId: input.capsule.id,
        stateVersionId: input.stateVersion.id,
        creatorRunId: input.creatorRunId,
        pairedActionIds: [...input.pairedActionIds],
        reason: input.reason,
      },
    });
  }

  async #activateReleaseBeforeDestroy(input: {
    readonly planRun: PlanRun;
    readonly applyRun: ApplyRun;
    readonly capsule: Capsule;
    readonly lifecycleActions: InstallConfig["lifecycleActions"];
    readonly sourceBuild: InstallConfig["sourceBuild"];
    readonly signal: AbortSignal;
  }): Promise<LifecycleActionOutcome | undefined> {
    const commands = releaseActivationCommands(
      input.lifecycleActions,
      "pre_destroy",
    );
    if (commands.length === 0) return undefined;
    const stateVersionId = input.capsule.currentStateVersionId;
    if (!stateVersionId) {
      throw new CapsuleLifecycleActionError({
        phase: "pre_destroy",
        reportedStatus: "unavailable",
        activityStatus: "failed",
        actionDispatched: false,
        message: "pre-destroy lifecycle actions require a current StateVersion",
        commandCount: commands.length,
        outputCount: 0,
      });
    }
    const stateVersion = await this.#store.getStateVersion(stateVersionId);
    if (!stateVersion) {
      throw new CapsuleLifecycleActionError({
        phase: "pre_destroy",
        reportedStatus: "unavailable",
        activityStatus: "failed",
        actionDispatched: false,
        message:
          "pre-destroy lifecycle actions require the current StateVersion ledger row",
        commandCount: commands.length,
        outputCount: 0,
      });
    }
    const cleanupEvidence = await this.#failedFirstApplyCleanupEvidence({
      applyRun: input.applyRun,
      capsule: input.capsule,
      stateVersion,
      lifecycleActions: input.lifecycleActions,
    });
    if (cleanupEvidence) {
      if (!cleanupEvidence.alreadyPersisted) {
        await this.#recordFailedFirstApplyCleanupActivity({
          applyRun: input.applyRun,
          capsule: input.capsule,
          stateVersion,
          creatorRunId: cleanupEvidence.creatorRunId,
          pairedActionIds: cleanupEvidence.pairedActionIds,
          reason: cleanupEvidence.reason,
        });
      }
      return {
        phase: "pre_destroy",
        reportedStatus: "not_applicable",
        activityStatus: "succeeded",
        actionDispatched: false,
        notApplicable: true,
        alreadyPersisted: cleanupEvidence.alreadyPersisted,
        pairedActionIds: cleanupEvidence.pairedActionIds,
        stateVersionId: stateVersion.id,
        creatorRunId: cleanupEvidence.creatorRunId,
        reason: cleanupEvidence.reason,
        commandCount: commands.length,
        outputCount: 0,
      };
    }
    const output = input.capsule.currentOutputId
      ? await this.#store.getOutput(input.capsule.currentOutputId)
      : undefined;
    if (!output) {
      throw new CapsuleLifecycleActionError({
        phase: "pre_destroy",
        reportedStatus: "unavailable",
        activityStatus: "failed",
        actionDispatched: false,
        message: "pre-destroy lifecycle actions require the current Output",
        commandCount: commands.length,
        outputCount: 0,
      });
    }
    const nonSensitiveOutputs = {
      ...jsonRecordFromPublicOutputs(output.publicOutputs),
      ...jsonRecordFromPublicOutputs(
        output.workspaceOutputs as Readonly<Record<string, unknown>>,
      ),
    };
    // A normal destroy Plan is already pinned to the applied StateVersion's
    // SourceSnapshot. An operator recovery Plan is the one deliberate
    // exception: it pins a newer, validated snapshot so a broken historical
    // cleanup command can be forward-repaired. Execute the reviewed Plan's
    // source in both cases; fall back to the StateVersion only for legacy
    // source-less Plans.
    const sourceSnapshotId =
      input.planRun.sourceSnapshotId ??
      (await this.#sourceSnapshotIdForStateVersion(stateVersion, new Set()));
    const sourceSnapshot = sourceSnapshotId
      ? await this.#store.getSourceSnapshot(sourceSnapshotId)
      : undefined;
    if (!this.#releaseActivator) {
      await this.#recordReleaseActivationActivity({
        applyRun: input.applyRun,
        capsule: input.capsule,
        stateVersion,
        status: "failed",
        kind: "takosumi.install-config-actions@v1",
        message:
          "pre-destroy lifecycle actions declared but no release activator is configured",
        commandCount: commands.length,
        outputCount: Object.keys(nonSensitiveOutputs).length,
      });
      throw new CapsuleLifecycleActionError({
        phase: "pre_destroy",
        reportedStatus: "unavailable",
        activityStatus: "failed",
        actionDispatched: false,
        kind: "takosumi.install-config-actions@v1",
        message:
          "pre-destroy lifecycle actions declared but no release activator is configured",
        commandCount: commands.length,
        outputCount: Object.keys(nonSensitiveOutputs).length,
      });
    }
    await this.#recordReleaseActivationActivity({
      applyRun: input.applyRun,
      capsule: input.capsule,
      stateVersion,
      status: "pending",
      kind: "takosumi.install-config-actions@v1",
      message: "pre-destroy lifecycle actions are running",
      commandCount: commands.length,
      outputCount: Object.keys(nonSensitiveOutputs).length,
    });
    let result: ReleaseActivationResult;
    let actionDispatched = false;
    try {
      const releaseEnvironment = await this.#releaseEnvironmentForCommands({
        planRun: input.planRun,
        applyRun: input.applyRun,
        commands,
        phase: "destroy",
      });
      actionDispatched = true;
      result = await this.#releaseActivator.activate(
        {
          planRun: input.planRun,
          applyRun: input.applyRun,
          capsule: input.capsule,
          stateVersion,
          output,
          nonSensitiveOutputs,
          providerConfigurations: releaseEnvironment.providerConfigurations,
          ...(releaseEnvironment.credentials
            ? { credentials: releaseEnvironment.credentials }
            : {}),
          commands,
          ...(input.sourceBuild ? { sourceBuild: input.sourceBuild } : {}),
          ...(sourceSnapshot ? { sourceSnapshot } : {}),
        },
        { signal: input.signal },
      );
    } catch (error) {
      const outcome: LifecycleActionOutcome = {
        phase: "pre_destroy",
        reportedStatus: "error",
        activityStatus: "failed",
        actionDispatched,
        message: errorMessage(error),
        ...(error instanceof OpenTofuRunnerExecutionError && error.detail
          ? { detail: error.detail }
          : {}),
        commandCount: commands.length,
        outputCount: Object.keys(nonSensitiveOutputs).length,
      };
      await this.#recordReleaseActivationActivity({
        applyRun: input.applyRun,
        capsule: input.capsule,
        stateVersion,
        status: outcome.activityStatus,
        message: outcome.message,
        commandCount: commands.length,
        outputCount: Object.keys(nonSensitiveOutputs).length,
      });
      throw new CapsuleLifecycleActionError(outcome);
    }
    const skipped = result.status === "skipped";
    const outcome: LifecycleActionOutcome = {
      phase: "pre_destroy",
      reportedStatus: result.status,
      activityStatus: result.status === "succeeded" ? "succeeded" : "failed",
      actionDispatched,
      ...(result.kind ? { kind: result.kind } : {}),
      ...(result.message || skipped
        ? {
            message:
              result.message ??
              "release activator skipped declared pre-destroy commands",
          }
        : {}),
      hasHealthUrl: Boolean(result.healthUrl),
      metadataKeys: Object.keys(result.metadata ?? {}).sort(),
      commandCount: commands.length,
      outputCount: Object.keys(nonSensitiveOutputs).length,
    };
    await this.#recordLifecycleActionOutcome({
      applyRun: input.applyRun,
      capsule: input.capsule,
      stateVersion,
      outcome,
    });
    if (result.status !== "succeeded") {
      throw new CapsuleLifecycleActionError(outcome);
    }
    return outcome;
  }

  async #releaseEnvironmentForCommands(input: {
    readonly planRun: PlanRun;
    readonly applyRun: ApplyRun;
    readonly commands: readonly ReleaseActivationAction[];
    readonly phase: "apply" | "destroy";
  }): Promise<ResolvedRunEnvironment> {
    return await this.#runEnv.resolveRunEnvironment({
      planRun: input.planRun,
      phase: input.phase,
      auditRunId: releaseCommandRunId(input.applyRun.id),
      credentialRunId: input.applyRun.id,
      credentialContext: "release_command",
      mintCredentials: input.commands.some(
        (command) =>
          command.kind !== "resource_migration" &&
          command.useProviderCredentials === true,
      ),
    });
  }

  async #recordReleaseActivationActivity(input: {
    readonly applyRun: ApplyRun;
    readonly capsule: Capsule;
    readonly stateVersion: StateVersion;
    readonly status: Exclude<ReleaseActivationStatus, "skipped">;
    readonly kind?: string;
    readonly message?: string;
    readonly hasHealthUrl?: boolean;
    readonly metadataKeys?: readonly string[];
    readonly commandCount?: number;
    readonly outputCount: number;
  }): Promise<void> {
    await this.#recordActivity({
      workspaceId: input.applyRun.workspaceId,
      action: `release_activation.${input.status}`,
      targetType: "state_version",
      targetId: input.stateVersion.id,
      runId: input.applyRun.id,
      metadata: {
        capsuleId: input.capsule.id,
        stateVersionId: input.stateVersion.id,
        applyRunId: input.applyRun.id,
        outputCount: input.outputCount,
        ...(input.kind ? { activationKind: input.kind } : {}),
        ...(input.message ? { message: input.message } : {}),
        ...(input.hasHealthUrl === undefined
          ? {}
          : { hasHealthUrl: input.hasHealthUrl }),
        ...(input.metadataKeys && input.metadataKeys.length > 0
          ? { metadataKeys: [...input.metadataKeys] }
          : {}),
        ...(input.commandCount === undefined
          ? {}
          : { commandCount: input.commandCount }),
      },
    });
  }

  /**
   * §24 stale propagation for an apply: a thin named wrapper over
   * `#propagateStale` so the top-level apply flow reads as a sequence of named
   * steps.
   */
  async #markDownstreamCapsulesStale(input: {
    readonly capsule: Capsule;
    readonly previousOutput: Output | undefined;
    readonly newOutput: Output;
    readonly now: number;
  }): Promise<void> {
    await this.#propagateStale(input);
  }

  /** Builds the terminal ApplyRun committed with StateVersion and Output. */
  #buildCompletedApplyRun(input: {
    readonly running: ApplyRun;
    readonly applyRun: ApplyRun;
    readonly profile: RunnerProfile;
    readonly capsule: Capsule;
    readonly stateVersionId: string;
    readonly outputId: string;
    readonly outputCount: number;
    readonly result: OpenTofuApplyResult;
    readonly providerInstallationPolicy: { requireMirror: boolean } | undefined;
    readonly startedAt: number;
    readonly now: number;
  }): ApplyRun {
    const { running, applyRun, profile, capsule, stateVersionId, outputId } =
      input;
    const { result, startedAt, now } = input;
    const diagnostics = redactRunDiagnostics(result.diagnostics);
    const completed: ApplyRun = {
      ...running,
      capsuleId: capsule.id,
      stateVersionId,
      outputId,
      status: "succeeded",
      stateLock:
        result.stateLock ??
        stateLockEvidence(profile.stateBackend, startedAt, now, "recorded"),
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
          stateVersionId,
          outputId,
          outputCount: input.outputCount,
        }),
      ],
      updatedAt: now,
      finishedAt: now,
    };
    return this.#withPendingApplyBillingCapture(completed, now);
  }

  /**
   * The pending marker lands in the same atomic write as the terminal ApplyRun
   * and provider state. It is deliberately present even in OSS-disabled mode:
   * the no-op finalizer immediately closes it, while a process crash still
   * leaves an unambiguous durable repair target on every substrate.
   */
  #withPendingApplyBillingCapture(run: ApplyRun, now: number): ApplyRun {
    if (applyRunBillingCapturePending(run)) return run;
    return {
      ...run,
      auditEvents: [
        ...run.auditEvents,
        auditEvent(run.id, APPLY_BILLING_CAPTURE_PENDING_EVENT, now, {
          planRunId: run.planRunId,
          providerMutationCommitted: true,
        }),
      ],
    };
  }

  /**
   * Retries the idempotent UsageEvent + host capture and only then closes the
   * durable marker. Concurrent repair workers may both call the host port; the
   * BillingEnforcement contract keys capture by applyRunId, and the OSS usage
   * write is already idempotent by `${applyRun.id}:opentofu.apply`.
   */
  async #finalizeApplyBilling(
    planRun: PlanRun,
    applyRun: ApplyRun,
  ): Promise<ApplyRun> {
    if (!applyRunBillingCapturePending(applyRun)) return applyRun;
    const capturedAt = applyRun.finishedAt ?? applyRun.updatedAt ?? this.#now();
    await this.#billing.captureApplyBillingUsage({
      planRun,
      applyRun,
      now: capturedAt,
    });
    const completedMarker = auditEvent(
      applyRun.id,
      APPLY_BILLING_CAPTURE_COMPLETED_EVENT,
      this.#now(),
      {
        planRunId: planRun.id,
        applyRunId: applyRun.id,
      },
    );
    const result = await this.#store.transitionRun({
      id: applyRun.id,
      kind: "apply",
      expectFrom: [applyRun.status],
      run: {
        ...applyRun,
        auditEvents: [...applyRun.auditEvents, completedMarker],
      },
    });
    return (result.run as ApplyRun | undefined) ?? applyRun;
  }

  async #tryFinalizeApplyBilling(
    planRun: PlanRun,
    applyRun: ApplyRun,
  ): Promise<ApplyRun> {
    try {
      return await this.#finalizeApplyBilling(planRun, applyRun);
    } catch (error) {
      log.warn("deploy_control.billing_capture_finalization_deferred", {
        planRunId: planRun.id,
        applyRunId: applyRun.id,
        message: errorMessage(error),
      });
      return applyRun;
    }
  }

  async #runtimeSecretRetirementIntent(
    capsule: Capsule,
  ): Promise<RuntimeSecretRetirementIntent | undefined> {
    const installConfig = await this.#store.getInstallConfig(
      capsule.installConfigId,
    );
    const profile =
      installConfig?.runtimeBindingMaterialization?.runtimeSecretFile;
    if (!installConfig || profile === undefined) return undefined;
    return {
      workspaceId: capsule.workspaceId,
      capsuleId: capsule.id,
      installConfigId: installConfig.id,
      profileDigest: await stableJsonDigest(profile),
    };
  }

  #withPendingRuntimeSecretRetirement(
    run: ApplyRun,
    now: number,
    intent: RuntimeSecretRetirementIntent | undefined,
  ): ApplyRun {
    if (!intent || applyRunRuntimeSecretRetirementPending(run)) return run;
    return {
      ...run,
      auditEvents: [
        ...run.auditEvents,
        auditEvent(run.id, APPLY_RUNTIME_SECRET_RETIREMENT_PENDING_EVENT, now, {
          ...intent,
          providerDestroyCommitted: true,
        }),
      ],
    };
  }

  async #finalizeRuntimeSecretRetirement(
    planRun: PlanRun,
    applyRun: ApplyRun,
  ): Promise<ApplyRun> {
    if (!applyRunRuntimeSecretRetirementPending(applyRun)) return applyRun;
    const intent = runtimeSecretRetirementIntentFromRun(applyRun);
    if (!intent || !planRun.capsuleId || intent.capsuleId !== planRun.capsuleId) {
      throw new TypeError("runtime secret retirement intent is malformed");
    }
    if (!this.#runtimeSecretFileMaterializer) {
      throw new TypeError("runtime secret retirement port is unavailable");
    }
    await this.#runtimeSecretFileMaterializer.retire(intent);
    const completedMarker = auditEvent(
      applyRun.id,
      APPLY_RUNTIME_SECRET_RETIREMENT_COMPLETED_EVENT,
      this.#now(),
      {
        capsuleId: intent.capsuleId,
        installConfigId: intent.installConfigId,
        profileDigest: intent.profileDigest,
      },
    );
    const result = await this.#store.transitionRun({
      id: applyRun.id,
      kind: "apply",
      expectFrom: [applyRun.status],
      run: {
        ...applyRun,
        auditEvents: [...applyRun.auditEvents, completedMarker],
      },
    });
    return (result.run as ApplyRun | undefined) ?? applyRun;
  }

  async #tryFinalizeRuntimeSecretRetirement(
    planRun: PlanRun,
    applyRun: ApplyRun,
  ): Promise<ApplyRun> {
    try {
      return await this.#finalizeRuntimeSecretRetirement(planRun, applyRun);
    } catch {
      log.warn("deploy_control.runtime_secret_file_retirement_deferred", {
        planRunId: planRun.id,
        applyRunId: applyRun.id,
        capsuleId: planRun.capsuleId,
        reason: "durable_retirement_pending",
      });
      // Persist a value-free retry timestamp on the terminal outbox row. The
      // scheduler scans oldest attempt first, so one persistently failing
      // retirement cannot starve later Capsules forever.
      const now = this.#now();
      const result = await this.#store.transitionRun({
        id: applyRun.id,
        kind: "apply",
        expectFrom: [applyRun.status],
        run: {
          ...applyRun,
          updatedAt: now,
          auditEvents: [
            ...applyRun.auditEvents,
            auditEvent(
              applyRun.id,
              APPLY_RUNTIME_SECRET_RETIREMENT_DEFERRED_EVENT,
              now,
              { reason: "durable_retirement_pending" },
            ),
          ],
        },
      });
      return (result.run as ApplyRun | undefined) ?? applyRun;
    }
  }

  /**
   * Finalizes a provider-applied Run AFTER the atomic commit-tail fold. Billing
   * and runner usage are captured even when a required post-apply action made
   * the terminal Run failed: the provider mutation and retained state already
   * happened, so releasing that usage would be incorrect.
   */
  async #completeApplyRun(input: {
    readonly completed: ApplyRun;
    readonly planRun: PlanRun;
    readonly capsule: Capsule;
    readonly patched: Capsule | undefined;
    readonly outputCount: number;
    readonly nextStateGeneration: number;
    readonly startedAt: number;
    readonly now: number;
  }): Promise<ApplyRunResponse> {
    const { completed, planRun, capsule, outputCount, startedAt, now } = input;
    const finalized = await this.#tryFinalizeApplyBilling(planRun, completed);
    // Everything below is post-commit observability/cleanup. A failure must not
    // escape to the pre-commit catch path, which would incorrectly release a
    // reservation after provider state and the terminal Run are already durable.
    try {
      await this.#recordRunnerMinuteUsage({
        workspaceId: completed.workspaceId,
        runId: completed.id,
        capsuleId: completed.capsuleId,
        startedAt,
        finishedAt: now,
      });
      await this.#recordDeployOperationMetric({
        run: completed,
        operationKind: "apply",
        status: completed.status,
        startedAt,
        finishedAt: now,
        recordApplyDuration: true,
      });
      await this.#store.deletePlanRunInputs(planRun.id);
    } catch (error) {
      log.warn("deploy_control.apply_post_commit_cleanup_failed", {
        planRunId: planRun.id,
        applyRunId: completed.id,
        message: errorMessage(error),
      });
    }
    const lifecycleFailed = completed.status === "failed";
    const lifecycleErrorCode = lifecycleFailed
      ? CAPSULE_LIFECYCLE_ACTION_FAILED_ERROR_CODE
      : undefined;
    // A failed lifecycle action is still explicit that the provider-applied
    // StateVersion/Output were retained; callers must not retry the same Plan.
    await this.#recordActivity({
      workspaceId: completed.workspaceId,
      action: lifecycleFailed ? "run.failed" : "run.applied",
      targetType: "run",
      targetId: completed.id,
      runId: completed.id,
      metadata: {
        capsuleId: capsule.id,
        stateVersionId: completed.stateVersionId,
        stateGeneration: input.nextStateGeneration,
        outputId: completed.outputId,
        outputCount,
        ...(lifecycleFailed
          ? {
              errorCode: lifecycleErrorCode!,
              providerApplySucceeded: true,
              appliedStateRetained: true,
            }
          : {}),
      },
    });
    return {
      applyRun: finalized,
      capsule: input.patched ?? capsule,
    };
  }

  async #executeDestroyApply(
    running: ApplyRun,
    planRun: PlanRun,
    profile: RunnerProfile,
    startedAt: number,
    plannedCapsule: Capsule | undefined,
    credentials: RunCredentials | undefined,
    dispatch: RunModuleDispatch,
    inputs: PlanRunInputs | undefined,
    leaseToken: string,
    lease?: LeaseHandle,
  ): Promise<ApplyRunResponse> {
    if (!planRun.planArtifact) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} has no immutable destroy plan artifact`,
      );
    }
    if (!planRun.capsuleId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "destroy apply requires a PlanRun with capsuleId",
      );
    }
    const capsule =
      plannedCapsule ?? (await this.#requireCurrentPlannedCapsule(planRun));
    // Resolve the value-free retirement fence before any external teardown.
    // A missing/corrupt pinned InstallConfig must fail while provider state is
    // still untouched; only the marker append waits for successful destroy.
    const runtimeSecretRetirementIntent =
      await this.#runtimeSecretRetirementIntent(capsule);
    // A destroy_apply persists the post-teardown state at `base + 1`. Empty for
    // runs without capsule context.
    const persistGeneration = (planRun.baseStateGeneration ?? 0) + 1;
    const envDispatch = await this.#verification.executionDispatch(
      planRun,
      persistGeneration,
      dispatch.stateAdoption,
      dispatch.priorState,
    );
    const planPolicy = await this.#policyForPlanRun(planRun);
    const providerInstallationPolicy =
      planPolicy?.providerInstallation?.requireMirror === true
        ? { requireMirror: true }
        : undefined;
    let runnerDispatched = false;
    let effectiveRunning = running;
    let ledgerCommitted = false;
    try {
      const runner = this.#runnerForProfile(profile);
      if (typeof runner.destroy !== "function") {
        // Without a real teardown the Capsule must NOT be marked
        // destroyed: doing so would record a successful destroy in the ledger
        // while the underlying cloud resources keep running (silent leak).
        throw new OpenTofuControllerError(
          "failed_precondition",
          "runner does not implement destroy; refusing to mark capsule destroyed without teardown",
        );
      }
      const lifecycleOutcome = await this.#withRunRenewal(
        "apply",
        running,
        leaseToken,
        lease,
        (signal) =>
          this.#activateReleaseBeforeDestroy({
            planRun,
            applyRun: running,
            capsule: capsule,
            lifecycleActions: dispatch.lifecycleActions,
            sourceBuild: dispatch.sourceBuild,
            signal,
          }),
      );
      if (lifecycleOutcome) {
        if (lifecycleOutcome.alreadyPersisted) {
          // The durable not_applicable marker was written by an earlier owner
          // before a destroy retry. Do not append a second marker or redispatch
          // the paired cleanup action.
          effectiveRunning = running;
        } else {
          const lifecycleCompletedAt = this.#now();
          const lifecycleAuditStatus = lifecycleOutcome.notApplicable
            ? "not_applicable"
            : lifecycleOutcome.activityStatus;
          const pairedActionIds = lifecycleOutcome.pairedActionIds ?? [];
          const lifecycleAudited: ApplyRun = {
            ...running,
            auditEvents: [
              ...running.auditEvents,
              auditEvent(
                running.id,
                `lifecycle_action.${lifecycleOutcome.phase}.${lifecycleAuditStatus}`,
                lifecycleCompletedAt,
                {
                  phase: lifecycleOutcome.phase,
                  status: lifecycleOutcome.reportedStatus,
                  commandCount: lifecycleOutcome.commandCount,
                  actionDispatched: lifecycleOutcome.actionDispatched,
                  ...(lifecycleOutcome.notApplicable
                    ? {
                        ...(pairedActionIds.length === 1
                          ? { pairedActionId: pairedActionIds[0] }
                          : {}),
                        pairedActionIds: [...pairedActionIds],
                        stateVersionId: lifecycleOutcome.stateVersionId,
                        stateVersionGeneration: 1,
                        creatorRunId: lifecycleOutcome.creatorRunId,
                        reason: lifecycleOutcome.reason,
                      }
                    : {}),
                },
              ),
            ],
            updatedAt: lifecycleCompletedAt,
          };
          // Persist the successful pre_destroy evidence BEFORE provider
          // destroy. Otherwise a process crash after the lifecycle action but
          // before the terminal/requeue write would erase the only structured
          // proof that the external action ran and a takeover could dispatch it
          // again blindly.
          const persistedLifecycle = await this.#store.transitionRun({
            id: running.id,
            kind: "apply",
            expectFrom: ["running"],
            expectLeaseToken: leaseToken,
            run: lifecycleAudited,
            heartbeatAt: lifecycleCompletedAt,
          });
          if (!persistedLifecycle.won) {
            // The lifecycle action already happened, but this owner lost its
            // execution fence. Never continue into provider destroy under a
            // stale lease; the current owner/terminal row is authoritative.
            return {
              applyRun:
                (persistedLifecycle.run as ApplyRun | undefined) ?? running,
              capsule: publicCapsule(capsule),
            };
          }
          effectiveRunning = persistedLifecycle.run as ApplyRun;
        }
      }
      runnerDispatched = true;
      const destroyFn = runner.destroy;
      // Renewal harness: destroy is ONE awaited blocking fetch for the whole
      // tofu teardown; re-stamp the heartbeat + renew the lease around it so a
      // long destroy is not taken over by a sibling. clearInterval on every exit.
      const result = await this.#withRunRenewal(
        "apply",
        effectiveRunning,
        leaseToken,
        lease,
        (signal) =>
          destroyFn.call(
            runner,
            {
              applyRun: effectiveRunning,
              planRun,
              planArtifact: planRun.planArtifact!,
              capsule,
              runnerProfile: profile,
              ...(providerInstallationPolicy
                ? { providerInstallationPolicy }
                : {}),
              // Generated-root dispatch: destroy tofu in the reviewed root.
              ...(dispatch.generatedRoot
                ? { generatedRoot: dispatch.generatedRoot }
                : {}),
              ...(dispatch.operatorModule
                ? {
                    operatorModule: dispatch.operatorModule,
                    legacySourcelessDestroyRecovery: true as const,
                  }
                : {}),
              ...(dispatch.sourceBuild
                ? { sourceBuild: dispatch.sourceBuild }
                : {}),
              // M2 env dispatch (state scope at base+1 + source archive).
              ...(envDispatch.stateScope
                ? { stateScope: envDispatch.stateScope }
                : {}),
              ...(envDispatch.stateAdoption
                ? { stateAdoption: envDispatch.stateAdoption }
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
            },
            { signal },
          ),
      );
      const now = this.#now();
      if (result.providerExecutionFailure) {
        const stateWasPersisted =
          result.providerExecutionFailure.statePersistence === "persisted";
        if (stateWasPersisted !== Boolean(result.stateDigest?.trim())) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            `runner returned inconsistent failed-state persistence evidence for destroy apply run ${running.id}`,
          );
        }
        const committedFailure =
          await this.#commitFailedProviderMutationWithState({
            action: "destroy",
            running: effectiveRunning,
            applyRun: running,
            planRun,
            profile,
            plannedCapsule: capsule,
            result,
            envDispatch,
            persistGeneration,
            providerInstallationPolicy,
            leaseToken,
            startedAt,
            now,
          });
        if (committedFailure === "lease_lost") {
          return { applyRun: (await this.getApplyRun(running.id)).applyRun };
        }
        ledgerCommitted = true;
        return await this.#completeFailedProviderMutation({
          action: "destroy",
          ...committedFailure,
          planRun,
          startedAt,
          now,
        });
      }
      // Build the post-teardown StateVersion at the generation persisted by the
      // runner, then atomically advance the Capsule and terminal Run.
      const stateVersion = await this.#buildStateVersion({
        envDispatch,
        generation: persistGeneration,
        stateDigest: result?.stateDigest,
        runId: running.id,
        now,
      });
      if (!stateVersion) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "destroy completed without a durable Capsule state scope",
        );
      }
      const nextStateGeneration = capsule.currentStateGeneration + 1;
      const destroyPatch = {
        id: capsule.id,
        patch: {
          currentStateVersionId: stateVersion.id,
          status: "destroyed" as const,
          updatedAt: new Date(now).toISOString(),
          currentStateGeneration: nextStateGeneration,
          currentOutputId: undefined,
        },
        guard: {
          currentStateVersionId:
            planRun.capsuleCurrentStateVersionId ?? undefined,
          status: capsule.status,
        },
      };
      // Build the terminal (`succeeded`) destroy-apply ApplyRun + the apply-once
      // PlanRun marker NOW so they commit atomically with the destroy ledger
      // writes (commit-tail fold, S2): a torn tail can no longer leave a stuck
      // `running` destroy run over a finished teardown.
      const diagnostics = redactRunDiagnostics(result?.diagnostics);
      const completed = this.#withPendingRuntimeSecretRetirement(
        this.#withPendingApplyBillingCapture({
          ...effectiveRunning,
          stateVersionId: stateVersion.id,
          status: "succeeded",
          stateLock: stateLockEvidence(
            profile.stateBackend,
            startedAt,
            now,
            "recorded",
          ),
          ...(diagnostics ? { diagnostics } : {}),
          auditEvents: [
            ...effectiveRunning.auditEvents,
            ...providerInstallationAuditEvents(
              running.id,
              "destroy",
              now,
              result?.providerInstallation,
              providerInstallationPolicy,
            ),
            auditEvent(running.id, "destroy.completed", now, {
              capsuleId: capsule.id,
            }),
            auditEvent(running.id, "apply.completed", now, {
              operation: "destroy",
              capsuleId: capsule.id,
            }),
          ],
          updatedAt: now,
          finishedAt: now,
        }, now),
        now,
        runtimeSecretRetirementIntent,
      );
      const appliedPlan: PlanRun = {
        ...planRun,
        appliedApplyRunId: running.id,
        updatedAt: now,
      };
      let committed: Awaited<
        ReturnType<OpenTofuControlStore["commitRunState"]>
      >;
      try {
        committed = await this.#store.commitRunState({
          stateVersion,
          capsulePatch: destroyPatch,
          applyRunTerminal: completed,
          planRunApplied: appliedPlan,
          applyRunLeaseToken: leaseToken,
        });
      } catch (error) {
        if (error instanceof CapsuleStateVersionGuardConflict) throw error;
        throw new ArtifactLedgerTailAmbiguousError(running.id, error);
      }
      if (committed.applyRunLeaseLost) {
        return { applyRun: (await this.getApplyRun(running.id)).applyRun };
      }
      ledgerCommitted = true;
      await this.#retireModuleVariableMaterializationAfterDestroy({
        planRun,
        applyRun: completed,
        inputs,
      });
      await this.#retireRuntimeInputsAfterDestroy({
        planRun,
        applyRun: completed,
        inputs,
      });
      await this.#notifyTerminal(completed);
      const patched = committed.capsule;
      let finalized = await this.#tryFinalizeApplyBilling(planRun, completed);
      finalized = await this.#tryFinalizeRuntimeSecretRetirement(
        planRun,
        finalized,
      );
      try {
        await this.#recordRunnerMinuteUsage({
          workspaceId: completed.workspaceId,
          runId: completed.id,
          capsuleId: completed.capsuleId,
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
        await this.#store.deletePlanRunInputs(planRun.id);
      } catch (error) {
        log.warn("deploy_control.destroy_post_commit_cleanup_failed", {
          planRunId: planRun.id,
          applyRunId: completed.id,
          message: errorMessage(error),
        });
      }
      // Activity (§27 / §34): a successful destroy tore the Capsule down.
      await this.#recordActivity({
        workspaceId: completed.workspaceId,
        action: "run.destroyed",
        targetType: "run",
        targetId: completed.id,
        runId: completed.id,
        metadata: {
          capsuleId: capsule.id,
          stateGeneration: nextStateGeneration,
        },
      });
      return {
        applyRun: finalized,
        capsule: publicCapsule(patched ?? capsule),
      };
    } catch (error) {
      if (ledgerCommitted) {
        const persisted = (await this.#store.getApplyRun(running.id))!;
        const finalized = await this.#tryFinalizeApplyBilling(
          planRun,
          persisted,
        );
        log.warn("deploy_control.destroy_post_commit_finalization_failed", {
          planRunId: planRun.id,
          applyRunId: running.id,
          message: errorMessage(error),
        });
        const currentCapsule = await this.#store.getCapsule(capsule.id);
        return {
          applyRun: finalized,
          capsule: publicCapsule(currentCapsule ?? capsule),
        };
      }
      if (error instanceof ArtifactLedgerTailAmbiguousError) {
        const recovered =
          await this.#requeueApplyRunAfterArtifactLedgerTailError(
            effectiveRunning,
            leaseToken,
            profile,
            startedAt,
            "destroy_apply",
          );
        if (recovered) {
          const finalized = isTerminalStatus(recovered.status)
            ? await this.#tryFinalizeApplyBilling(planRun, recovered)
            : recovered;
          const currentCapsule = await this.#store.getCapsule(capsule.id);
          return {
            applyRun: finalized,
            capsule: publicCapsule(currentCapsule ?? capsule),
          };
        }
        throw error;
      }
      if (error instanceof CapsuleStateVersionGuardConflict) {
        await this.#billing.releaseApplyBilling(planRun);
        throw new OpenTofuControllerError("failed_precondition", error.message);
      }
      if (
        runnerDispatched &&
        isSafeMutatingRunnerInfrastructureRetryError(error)
      ) {
        const runningWithEnvironmentFailure = runEnvironmentFailedRun(
          effectiveRunning,
          error,
        );
        if (
          runnerInfrastructureRetryCount(runningWithEnvironmentFailure, [
            "destroy.retry_scheduled",
          ]) >= RUNNER_INFRASTRUCTURE_RETRY_LIMIT
        ) {
          await this.#billing.releaseApplyBilling(planRun);
          const failed = await this.#failApplyRun(
            runningWithEnvironmentFailure,
            leaseToken,
            profile,
            startedAt,
            "destroy.failed",
            runnerInfrastructureRetryExhaustedError("destroy_apply"),
            true,
          );
          if (failed.finishedAt !== undefined) {
            await this.#recordRunnerMinuteUsage({
              workspaceId: failed.workspaceId,
              runId: failed.id,
              capsuleId: failed.capsuleId,
              startedAt,
              finishedAt: failed.finishedAt,
            });
          }
          return {
            applyRun: failed,
            capsule: publicCapsule(capsule),
          };
        }
        const queued =
          await this.#requeueApplyRunAfterRunnerInfrastructureError(
            runningWithEnvironmentFailure,
            leaseToken,
            profile,
            startedAt,
            error,
            "destroy_apply",
          );
        if (queued) {
          const retryError = new OpenTofuControllerError(
            "failed_precondition",
            `retryable_runner_infrastructure_error: destroy apply run ${queued.id} requeued after runner infrastructure failure`,
            { reason: RUNNER_INFRASTRUCTURE_REQUEUED_REASON },
          );
          if (queued.updatedAt !== undefined) {
            await this.#recordRunnerMinuteUsage({
              workspaceId: queued.workspaceId,
              runId: queued.id,
              capsuleId: queued.capsuleId,
              startedAt,
              finishedAt: queued.updatedAt,
            });
          }
          throw retryError;
        }
      }
      await this.#billing.releaseApplyBilling(planRun);
      const lifecycleError = lifecycleActionErrorEvidence(error);
      const lifecycleActionDispatched = lifecycleError?.actionDispatched === true;
      const lifecycleOutcome = lifecycleError?.outcome;
      const failed = await this.#failApplyRun(
        effectiveRunning,
        leaseToken,
        profile,
        startedAt,
        "destroy.failed",
        error,
        runnerDispatched,
        lifecycleActionDispatched,
        lifecycleOutcome,
      );
      if (runnerDispatched && failed.finishedAt !== undefined) {
        await this.#recordRunnerMinuteUsage({
          workspaceId: failed.workspaceId,
          runId: failed.id,
          capsuleId: failed.capsuleId,
          startedAt,
          finishedAt: failed.finishedAt,
        });
      }
      return {
        applyRun: failed,
        capsule: publicCapsule(capsule),
      };
    }
  }

  /**
   * Best-effort retirement of a destroyed Capsule's run-scoped sensitive input
   * material. A failure only leaves a sealed orphan blob that a later destroy
   * can still remove, so it never fails the terminal destroy.
   *
   * It deliberately does NOT require the destroy plan to have pinned a
   * descriptor: a destroy plan wires no run-scoped inputs at all, and the
   * Capsule whose profile drifted into an unreadable shape is exactly the one
   * whose material most needs clearing. The owner fence inside `retire` is what
   * proves whose material this is, and a Capsule that never had any is a
   * no-op.
   */
  async #retireRuntimeInputsAfterDestroy(input: {
    readonly planRun: PlanRun;
    readonly applyRun: ApplyRun;
    readonly inputs: PlanRunInputs | undefined;
  }): Promise<void> {
    const materializer = this.#runtimeInputMaterializer;
    // No materializer means no lane could ever have minted material for this
    // Capsule, so there is nothing to retire and nothing to report.
    if (!materializer) return;
    try {
      if (!input.planRun.capsuleId) {
        throw new TypeError("retirement authority is invalid");
      }
      const capsule = await this.#requireCapsule(input.planRun.capsuleId);
      if (capsule.status !== "destroyed") {
        throw new TypeError("Capsule is not terminal");
      }
      await materializer.retire({
        workspaceId: capsule.workspaceId,
        capsuleId: capsule.id,
        installConfigId: capsule.installConfigId,
      });
    } catch (error) {
      log.warn("deploy_control.runtime_input_retirement_deferred", {
        planRunId: input.planRun.id,
        applyRunId: input.applyRun.id,
        capsuleId: input.planRun.capsuleId,
        message: errorMessage(error),
      });
    }
  }

  async #retireModuleVariableMaterializationAfterDestroy(input: {
    readonly planRun: PlanRun;
    readonly applyRun: ApplyRun;
    readonly inputs: PlanRunInputs | undefined;
  }): Promise<void> {
    const expectedDigest =
      input.inputs?.moduleVariableMaterializationDigest;
    if (!expectedDigest) return;
    const retire = this.#moduleVariableMaterializer?.retire;
    if (!retire) {
      log.warn("deploy_control.module_variable_retirement_deferred", {
        planRunId: input.planRun.id,
        applyRunId: input.applyRun.id,
        capsuleId: input.planRun.capsuleId,
        reason: "retirement_port_unavailable",
      });
      return;
    }
    try {
      if (
        !input.planRun.capsuleId ||
        !MODULE_VARIABLE_MATERIALIZATION_DIGEST.test(expectedDigest) ||
        !input.inputs
      ) {
        throw new TypeError("retirement authority is invalid");
      }
      const capsule = await this.#requireCapsule(input.planRun.capsuleId);
      if (capsule.status !== "destroyed") {
        throw new TypeError("Capsule is not terminal");
      }
      const installConfig = await this.#store.getInstallConfig(
        capsule.installConfigId,
      );
      if (!installConfig) {
        throw new TypeError("InstallConfig is missing");
      }
      const resolvedProviderBindings =
        (await this.#resolveRunProviderBindings(input.planRun)) ?? [];
      await retire.call(this.#moduleVariableMaterializer, {
        expectedDigest,
        plannedVariables: moduleVariableMaterializerPlannedVariables(
          installConfig,
          input.inputs.variables,
        ),
        capsuleExecutionAuthorityEpoch:
          input.planRun.capsuleExecutionAuthorityEpoch ?? 1,
        capsule,
        installConfig,
        resolvedProviderBindings,
        variables: moduleVariableMaterializerInputVariables(
          installConfig,
          input.inputs.variables,
        ),
      });
    } catch {
      // Accounts live-grant checks already deny a destroyed Capsule and retry
      // physical deletion best-effort. The provider teardown + atomic Capsule
      // terminal commit are authoritative, so a cleanup outage must never
      // rewrite that success as a retryable destroy or recreate the client.
      log.warn("deploy_control.module_variable_retirement_deferred", {
        planRunId: input.planRun.id,
        applyRunId: input.applyRun.id,
        capsuleId: input.planRun.capsuleId,
        reason: "best_effort_cleanup_failed",
      });
    }
  }

  async #materializeRuntimeSecretFileAfterApply(input: {
    readonly capsule: Capsule;
    readonly commands: readonly ReleaseActivationAction[];
  }): Promise<RuntimeSecretFileBundle | undefined> {
    const hasRunnerCommand = input.commands.some(
      (action) =>
        action.kind !== "resource_migration" &&
        action.executor !== "operator",
    );
    if (!hasRunnerCommand) return undefined;
    const installConfig = await this.#store.getInstallConfig(
      input.capsule.installConfigId,
    );
    if (!installConfig) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "runtime secret file InstallConfig is unavailable",
      );
    }
    if (
      installConfig.runtimeBindingMaterialization?.runtimeSecretFile ===
      undefined
    ) {
      return undefined;
    }
    if (!this.#runtimeSecretFileMaterializer) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "runtime secret file materializer is unavailable",
      );
    }
    return await this.#runtimeSecretFileMaterializer.materialize({
      workspaceId: input.capsule.workspaceId,
      capsuleId: input.capsule.id,
      installConfigId: installConfig.id,
      phase: "post_apply",
    });
  }

  async #requireRunnerProfile(id: string): Promise<RunnerProfile> {
    requireNonEmptyString(id, "runnerProfileId");
    const configuredProfile = this.#runnerProfilesById.get(id);
    if (configuredProfile) return configuredProfile;
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

  async #requireCapsule(id: string): Promise<Capsule> {
    return await requireCapsule(this.#store, id);
  }

  async #requireCurrentPlannedCapsule(planRun: PlanRun): Promise<Capsule> {
    if (!planRun.capsuleId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "PlanRun does not target an existing Capsule",
      );
    }
    const capsule = await this.#requireCapsule(planRun.capsuleId);
    validatePlannedCapsuleCurrent({ planRun, capsule: capsule });
    const currentEpoch =
      await this.#store.getCapsuleExecutionAuthorityEpoch(capsule.id);
    // Legacy Plan rows predate the explicit field and therefore belong only to
    // epoch 1. Once an immutable authority replacement advances the Capsule,
    // absence must fail closed rather than granting the legacy row the new
    // epoch by implication.
    const plannedEpoch = planRun.capsuleExecutionAuthorityEpoch ?? 1;
    if (currentEpoch !== plannedEpoch) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `capsule ${capsule.id} execution authority changed since PlanRun ${planRun.id}`,
        { reason: "capsule_execution_authority_changed" },
      );
    }
    return capsule;
  }
}

const MODULE_VARIABLE_MATERIALIZATION_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const OPENTOFU_MODULE_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function hasModuleVariableMaterialization(
  installConfig: InstallConfig,
): boolean {
  try {
    return accountsOidcModuleVariableProfile(installConfig) !== undefined;
  } catch (error) {
    throw moduleVariableMaterializationError(errorMessage(error));
  }
}

function moduleVariableMaterializerInputVariables(
  installConfig: InstallConfig,
  variables: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  const { sourceNames, additionalInputNames } =
    requireValidModuleVariableProfile(installConfig);
  const selected: Record<string, JsonValue> = {};
  const allowedNames = new Set([...sourceNames, ...additionalInputNames]);
  for (const name of allowedNames) {
    const value = variables[name];
    if (value === undefined) continue;
    if (
      value !== null &&
      !isPublicModuleVariableScalar(value)
    ) {
      throw moduleVariableMaterializationError(
        `materializer input ${name} is not safe public scalar metadata`,
      );
    }
    selected[name] = value;
  }
  return selected;
}

function moduleVariableMaterializerPlannedVariables(
  installConfig: InstallConfig,
  variables: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  const { targetNames } = requireValidModuleVariableProfile(installConfig);
  const selected: Record<string, JsonValue> = {};
  for (const name of targetNames) {
    const value = variables[name];
    if (value === undefined) {
      throw moduleVariableMaterializationError(
        `reviewed Plan is missing materialized variable ${name}`,
      );
    }
    selected[name] = value;
  }
  return selected;
}

function requireValidModuleVariableProfile(installConfig: InstallConfig): {
  readonly profile: AccountsOidcModuleVariableProfile;
  readonly sourceNames: readonly string[];
  readonly targetNames: readonly string[];
  readonly additionalInputNames: readonly string[];
} {
  let profile: AccountsOidcModuleVariableProfile | undefined;
  try {
    profile = accountsOidcModuleVariableProfile(installConfig);
  } catch (error) {
    throw moduleVariableMaterializationError(errorMessage(error));
  }
  if (!profile) {
    throw moduleVariableMaterializationError("declaration is missing");
  }
  const sourceNames = [profile.publicUrlVariable];
  const targetNames = [
    profile.accountsUrlVariable,
    profile.issuerUrlVariable,
    profile.clientIdVariable,
    profile.redirectUriVariable,
  ];
  const additionalInputNames: readonly string[] = [];
  const publicNames = [...sourceNames, ...targetNames, ...additionalInputNames];
  if (
    publicNames.some(
      (name) =>
        typeof name !== "string" || !OPENTOFU_MODULE_VARIABLE_NAME.test(name),
    ) ||
    publicNames.some(
      (name) =>
        typeof name !== "string" ||
        isSecretKey(name) ||
        name.toUpperCase() === "ENCRYPTION_KEY",
    ) ||
    new Set(publicNames).size !== publicNames.length
  ) {
    throw moduleVariableMaterializationError(
      "declaration contains an invalid, duplicate, or secret-shaped variable name",
    );
  }
  return {
    profile,
    sourceNames,
    targetNames,
    additionalInputNames,
  };
}

function isPublicModuleVariableScalar(value: JsonValue): boolean {
  if (typeof value === "string") return !containsSecretLikeString(value);
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "boolean";
}

function requireValidModuleVariableMaterialization(
  installConfig: InstallConfig,
  result: CapsuleModuleVariableMaterialization | undefined,
): CapsuleModuleVariableMaterialization {
  const { profile, targetNames } =
    requireValidModuleVariableProfile(installConfig);
  if (!result) {
    throw moduleVariableMaterializationError(
      "declared materialization did not return values",
    );
  }
  if (!MODULE_VARIABLE_MATERIALIZATION_DIGEST.test(result.digest)) {
    throw moduleVariableMaterializationError("digest is invalid");
  }
  const actualNames = Object.keys(result.variables).sort();
  const expectedNames = [...targetNames].sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw moduleVariableMaterializationError(
      "host returned variables outside the exact declared target set",
    );
  }
  const valid =
    isBoundedNonSecretString(
      result.variables[profile.issuerUrlVariable],
    ) &&
    isBoundedNonSecretString(
      result.variables[profile.clientIdVariable],
    ) &&
    isBoundedNonSecretString(
      result.variables[profile.accountsUrlVariable],
    ) &&
    isBoundedNonSecretString(
      result.variables[profile.redirectUriVariable],
    );
  if (!valid) {
    throw moduleVariableMaterializationError(
      "host returned an invalid or secret-shaped public OIDC value",
    );
  }
  return result;
}

function isBoundedNonSecretString(value: JsonValue | undefined): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= 4_096 &&
    !containsSecretLikeString(value)
  );
}

function assertPinnedModuleVariableValues(
  variables: Readonly<Record<string, JsonValue>> | undefined,
  materialization: CapsuleModuleVariableMaterialization,
): void {
  const actual = variables ?? {};
  for (const [name, value] of Object.entries(materialization.variables)) {
    if (actual[name] !== value) {
      throw moduleVariableMaterializationError(
        `dependency injection changed materialized variable ${name}`,
      );
    }
  }
}

function moduleVariableMaterializationError(
  detail: string,
): OpenTofuControllerError {
  return new OpenTofuControllerError(
    "failed_precondition",
    `module_variable_materialization_failed: ${redactString(detail)}`,
    { reason: "module_variable_materialization_failed" },
  );
}

async function assertApplyRunCreationAuthority(
  run: ApplyRun,
  planRun: PlanRun,
  profile: RunnerProfile,
  expected: ApplyExpectedGuard,
): Promise<void> {
  if (
    run.planRunId !== planRun.id ||
    run.workspaceId !== planRun.workspaceId ||
    run.capsuleId !== planRun.capsuleId ||
    run.operation !== planRun.operation ||
    run.runnerProfileId !== profile.id ||
    (await stableJsonDigest(run.expected)) !==
      (await stableJsonDigest(expected)) ||
    (await stableJsonDigest(run.stateBackend)) !==
      (await stableJsonDigest(profile.stateBackend))
  ) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `ApplyRun id ${run.id} is already bound to different run authority`,
    );
  }
}

function assertExactApplyRunResponse(
  response: ApplyRunResponse,
  expectedApplyRunId: string,
): void {
  if (response.applyRun.id !== expectedApplyRunId) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `ApplyRun recovery did not return exact ApplyRun ${expectedApplyRunId}`,
    );
  }
}

function isEligibleLegacySourcelessPlan(planRun: PlanRun): boolean {
  const source = planRun.source as unknown;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return false;
  }
  const record = source as Readonly<Record<string, unknown>>;
  const retiredGeneratedRoot =
    record.kind === "local" &&
    typeof record.path === "string" &&
    record.path.startsWith("/resource-shape/");
  const retiredUploadProjection =
    record.kind === "git" &&
    typeof record.url === "string" &&
    record.url.startsWith("https://uploads.takosumi.com/") &&
    typeof record.commit === "string" &&
    /^[0-9a-f]{64}$/i.test(record.commit);
  return (
    (retiredGeneratedRoot || retiredUploadProjection) &&
    typeof planRun.sourceSnapshotId === "string" &&
    planRun.sourceSnapshotId.length > 0 &&
    (planRun.appliedApplyRunId === undefined ||
      (typeof planRun.appliedApplyRunId === "string" &&
        planRun.appliedApplyRunId.length > 0))
  );
}

function normalizeDestroyModulePath(
  path: string | undefined,
): string | undefined {
  const value = path?.trim();
  if (!value || value === ".") return undefined;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || normalized === ".") return undefined;
  return normalized.replace(/\/+$/g, "");
}

function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stateVersionMatchesCapsuleScope(
  capsule: Capsule,
  stateVersion: StateVersion,
): boolean {
  return (
    typeof stateVersion.id === "string" &&
    stateVersion.id.trim() !== "" &&
    stateVersion.workspaceId === capsule.workspaceId &&
    stateVersion.capsuleId === capsule.id &&
    stateVersion.environment === capsule.environment &&
    Number.isSafeInteger(stateVersion.generation) &&
    stateVersion.generation >= 1 &&
    typeof stateVersion.createdByRunId === "string" &&
    stateVersion.createdByRunId.trim() !== ""
  );
}

function stateVersionMatchesCapsuleCurrent(
  capsule: Capsule,
  stateVersion: StateVersion,
): boolean {
  return (
    stateVersionMatchesCapsuleScope(capsule, stateVersion) &&
    stateVersion.id === capsule.currentStateVersionId &&
    stateVersion.generation === capsule.currentStateGeneration
  );
}

function isOpenTofuOperation(value: unknown): value is PlanRun["operation"] {
  return value === "create" || value === "update" || value === "destroy";
}

function applyRunMatchesStateVersion(
  capsule: Capsule,
  stateVersion: StateVersion,
  applyRun: ApplyRun,
): boolean {
  const expected = applyRun.expected;
  return (
    applyRun.id === stateVersion.createdByRunId &&
    typeof applyRun.planRunId === "string" &&
    applyRun.planRunId.trim() !== "" &&
    applyRun.workspaceId === capsule.workspaceId &&
    applyRun.capsuleId === capsule.id &&
    isOpenTofuOperation(applyRun.operation) &&
    (applyRun.status === "succeeded" || applyRun.status === "failed") &&
    applyRun.stateVersionId === stateVersion.id &&
    expected !== undefined &&
    expected !== null &&
    typeof expected === "object" &&
    expected.capsuleId === capsule.id &&
    expected.planRunId === applyRun.planRunId
  );
}

function planRunMatchesAppliedState(
  capsule: Capsule,
  stateVersion: StateVersion,
  applyRun: ApplyRun,
  planRun: PlanRun,
): boolean {
  const expectedCurrentStateVersionId =
    applyRun.expected?.currentStateVersionId ?? null;
  const plannedCurrentStateVersionId =
    planRun.capsuleCurrentStateVersionId ?? null;
  const source = planRun.source as unknown;
  const context = planRun.capsuleContext;
  return (
    planRun.id === applyRun.planRunId &&
    planRun.workspaceId === capsule.workspaceId &&
    planRun.capsuleId === capsule.id &&
    planRun.status === "succeeded" &&
    isOpenTofuOperation(planRun.operation) &&
    planRun.operation === applyRun.operation &&
    (planRun.appliedApplyRunId === undefined ||
      planRun.appliedApplyRunId === applyRun.id) &&
    typeof planRun.sourceSnapshotId === "string" &&
    planRun.sourceSnapshotId.trim() !== "" &&
    source !== null &&
    typeof source === "object" &&
    !Array.isArray(source) &&
    (!capsule.sourceId ||
      (source as { readonly kind?: unknown }).kind === "git") &&
    expectedCurrentStateVersionId === plannedCurrentStateVersionId &&
    (planRun.baseStateGeneration === undefined ||
      (Number.isSafeInteger(planRun.baseStateGeneration) &&
        planRun.baseStateGeneration + 1 === stateVersion.generation)) &&
    (context === undefined ||
      context === null ||
      (context.workspaceId === capsule.workspaceId &&
        context.capsuleId === capsule.id &&
        context.environment === capsule.environment))
  );
}

function restoreRunMatchesStateVersion(
  capsule: Capsule,
  stateVersion: StateVersion,
  restoreRun: Run | undefined,
): restoreRun is Run & { readonly restoredFromStateVersionId: string } {
  return (
    restoreRun !== undefined &&
    restoreRun.id === stateVersion.createdByRunId &&
    restoreRun.type === "restore" &&
    restoreRun.status === "succeeded" &&
    restoreRun.workspaceId === capsule.workspaceId &&
    restoreRun.capsuleId === capsule.id &&
    restoreRun.environment === capsule.environment &&
    restoreRun.restoredStateVersionId === stateVersion.id &&
    typeof restoreRun.restoredFromStateVersionId === "string" &&
    restoreRun.restoredFromStateVersionId.trim() !== ""
  );
}
