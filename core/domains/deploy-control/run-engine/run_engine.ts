/**
 * Run / installation-lifecycle orchestration engine (P3 god-file split).
 *
 * Extracted verbatim from `../mod.ts`'s `OpenTofuDeploymentController`. The
 * controller constructs exactly ONE `RunEngine`, passing the shared stores,
 * sibling collaborators, clock / id generators, and — critically — the SINGLE
 * `#runSerialized` mutex owner as a `runSerialized` port (there is still only
 * one serialization queue, owned by the controller). All run + installation
 * plan + apply + restore orchestration lives here; the controller delegates its
 * public run methods to this engine and keeps the query / billing / connection /
 * source surfaces. Method bodies are moved byte-for-byte.
 */
import {
  installExperiencePublicEndpoint,
  type JsonValue,
} from "takosumi-contract";
import type {
  ApplyRun,
  ApplyRunResponse,
  CreateApplyRunRequest,
  CreatePlanRunRequest,
  Deployment,
  DeploymentOutput,
  DispatchGeneratedRoot,
  InstallConfig,
  Installation,
  OpenTofuModuleSource,
  PlanRun,
  PlanRunInstallationContext,
  PlanRunResponse,
  PlanRunTemplateBinding,
  PolicyConfig,
  PolicyDecision,
  RunStatus,
  RunnerProfile,
  StateSnapshot,
} from "@takosumi/internal/deploy-control-api";
import type { CreateRestoreRequest } from "takosumi-contract/backups";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type {
  Dependency,
  DependencySnapshot,
} from "takosumi-contract/dependencies";
import type { OutputAllowlistEntry } from "takosumi-contract/install-configs";
import type { Output as OutputSnapshot } from "takosumi-contract/outputs";
import type { Run } from "takosumi-contract/runs";
import type {
  Source,
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";
import { sameProviderFamily } from "takosumi-contract/provider-env-rules";
import { redactString } from "takosumi-contract/redaction";
import { downstreamClosure } from "takosumi-graph";
import {
  evaluateActionPolicy,
  evaluateQuotaPolicy,
  evaluateResourceAllowlist,
  evaluateScopeBoundary,
  providerMatches,
} from "takosumi-policy";
import {
  generateGenericCapsuleRoot,
  type RootInstallationProviderEnvBinding,
} from "takosumi-rootgen";
import { stableJsonDigest } from "../../../adapters/source/digest.ts";
import { log } from "../../../shared/log.ts";
import {
  ConnectionsService,
  resolvedProviderEnvBindingsDigest,
  type ResolvedInstallationProviderEnvBinding,
} from "../../connections/mod.ts";
import { validateProjectedServiceExportsFromOutputSnapshot } from "../../output-projection/mod.ts";
import type { ActivityRecorder } from "../../activity/mod.ts";
import type { RecordActivityInput } from "../../activity/mod.ts";
import type { SourcesService } from "../../sources/mod.ts";
import {
  collectRootModuleOutputDeclarations,
  collectRootModuleVariableNames,
} from "../../sources/capsule_compatibility.ts";
import type { TemplateRegistry } from "../../templates/mod.ts";
import type { ObservabilitySink } from "../../observability/mod.ts";
import { DeploymentQuery, requireInstallation } from "../deployment_query.ts";
import { OpenTofuControllerError, requireNonEmptyString } from "../errors.ts";
import {
  DEFAULT_INSTALLATION_LEASE_TTL_MS,
  type InstallationCoordination,
  type LeaseHandle,
  withInstallationLease,
  withPlanLease,
} from "../installation_lease.ts";
import {
  type InstallTypePlanContext,
  type PlanResolutionService,
  providerEnvBindingsFromResolved,
} from "../plan_resolution.ts";
import { evaluatePolicy } from "../policy.ts";
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
} from "../projection.ts";
import {
  compactErrorCode,
  projectApplyRun,
  projectPlanRun,
} from "../projection_run.ts";
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
  InstallationPatchGuardConflict,
  type OpenTofuDeploymentStore,
  type PlanRunInputs,
} from "../store.ts";
import {
  managedPublicBaseDomainFromInstallConfig,
  managedPublicHostFromLabel,
  normalizeManagedPublicBaseDomains,
  publicHostPolicyKind,
} from "../managed_public_domains.ts";
import { evaluateTemplatePlanPolicy } from "../template_policy.ts";
import {
  normalizeProviders,
  normalizeVariables,
  validateOperation,
  validatePlannedInstallationCurrent,
  validateSource,
  validateSourceAllowedByProfile,
} from "../validation.ts";
import type { RunQueryService } from "../run_query.ts";
import type { BillingService } from "../billing_service.ts";
import {
  runnerMinuteUsdMicros,
  usdMicrosToLegacyCredits,
} from "takosumi-contract/billing";
import type { DriftService } from "../drift_service.ts";
import type { RunEnvResolver } from "../run_env_resolver.ts";
import type { ResolvedDependencies } from "../dependency_resolution.ts";
import type { DependencyResolutionService } from "../dependency_resolution.ts";
import type { RunVerificationService } from "../run_verification.ts";
import type { SourceLifecycleService } from "../source_lifecycle.ts";
// Shared helpers, constants, and run-engine types stay in the controller module
// (`../mod.ts`) so the domain's public entry point and external importers are
// unchanged; this engine imports the ones its moved bodies reference. The
// resulting `mod.ts <-> run_engine.ts` cycle is runtime-only (every symbol is
// used inside a method, never at module-evaluation time).
import {
  assertGeneratedRootDispatchPresent,
  assertStateGenerationMatches,
  auditEvent,
  changedOutputNamesBetween,
  checkApplyExpected,
  defaultProviderMirrorRequiredForProfile,
  directChangedDependencyOutputs,
  installConfigTemplateBinding,
  isTerminalStatus,
  jsonRecordFromPublicOutputs,
  mergeJsonVariableDefaults,
  newId,
  NON_TERMINAL_RUN_STATUSES,
  providerInstallationAuditEvents,
  providersRequiringProviderEnvBindings,
  publicInstallation,
  publicPlanRun,
  rawOutputArtifactKey,
  redactRunApproval,
  releaseActivationCommands,
  releaseActivationCommandsFromOutputRecord,
  releaseActivationCommandsFromPublicOutputs,
  releaseActivationOutputs,
  RUN_HEARTBEAT_STALE_MS,
  RUN_RENEWAL_INTERVAL_MS,
  runEnvironmentFailedRun,
  snapshotModuleSource,
  stateObjectKeyForScope,
  syntheticUploadSource,
  templateDispatchFromInputs,
  updatedTemplateBinding,
  withRunEnvironmentEvidence,
} from "../mod.ts";
import type {
  CreateInstallationPlanInternal,
  DependencyValueSealer,
  DeployControlActorContext,
  EnqueueRun,
  GenericRootDispatchContext,
  GenericRootPlanContext,
  OpenTofuApplyResult,
  OpenTofuCapsuleSourceFile,
  OpenTofuPlanResult,
  OpenTofuRunDispatch,
  OpenTofuRunner,
  PlanCompletionVerdict,
  PlanPolicyLayers,
  PlanRunInternalContext,
  ReleaseActivationCommand,
  ReleaseActivationResult,
  ReleaseActivationStatus,
  ReleaseActivator,
  RunClaimResult,
  RunCredentials,
  RunInstallationDispatch,
  RunTemplateDispatch,
  TerminalRunPersistResult,
} from "../mod.ts";

function releaseCommandRunId(applyRunId: string): string {
  return `release_${applyRunId.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
}

function isRetryableRunnerInfrastructureError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /Durable Object reset because its code was updated/i.test(message) ||
    /Maximum number of running container instances exceeded/i.test(message)
  );
}

function isRetryableRunnerRequeueError(error: unknown): boolean {
  return (
    error instanceof OpenTofuControllerError &&
    /retryable_runner_infrastructure_error/i.test(error.message)
  );
}

const RUNNER_INFRASTRUCTURE_RETRY_LIMIT = 1;
const PLAN_CREATION_STAGE_TIMEOUT_MS = 25_000;

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
          { stage, timeoutMs: PLAN_CREATION_STAGE_TIMEOUT_MS },
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
  return new Error(
    `runner_infrastructure_retry_exhausted: ${phase} runner infrastructure retry limit exhausted`,
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
 * The single-owner run-serialization port. The controller owns the only
 * `#mutationChains` map + `#runSerialized` implementation and passes this
 * callback in; the engine never creates a second serialization queue.
 */
type RunSerialized = <T>(key: string, work: () => Promise<T>) => Promise<T>;

/**
 * Activity input accepting either the canonical `workspaceId` or the deprecated
 * `spaceId` during the Workspace rename. {@link RunEngine.#recordActivity}
 * normalizes both onto the persisted dual fields.
 */
type RecordActivityArgs = Omit<
  RecordActivityInput,
  "workspaceId" | "spaceId"
> & {
  readonly workspaceId?: string;
  readonly spaceId?: string;
};

interface DeclaredGenericCapsuleInputs {
  readonly names: ReadonlySet<string>;
  readonly known: boolean;
}

function declaredGenericCapsuleInputs(
  moduleFiles: readonly OpenTofuCapsuleSourceFile[] | undefined,
  rootModuleVariables: readonly string[] | undefined,
): DeclaredGenericCapsuleInputs {
  if (rootModuleVariables !== undefined) {
    return { known: true, names: new Set(rootModuleVariables) };
  }
  if (moduleFiles !== undefined) {
    return {
      known: true,
      names: new Set(collectRootModuleVariableNames(moduleFiles)),
    };
  }
  return { known: false, names: new Set() };
}

function publicEndpointVariableNames(
  installConfig: InstallConfig,
): ReadonlySet<string> {
  const endpoint = installExperiencePublicEndpoint(
    installConfig.store?.installExperience,
  );
  if (!endpoint) return new Set();
  return new Set(
    [
      endpoint.subdomainVariable,
      endpoint.urlVariable,
      endpoint.routePatternVariable,
    ]
      .map((name) => nonEmptyStringValue(name))
      .filter((name): name is string => name !== undefined),
  );
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

function providerEnvResolutionProviders(
  providers: readonly string[],
  installConfig: InstallConfig,
  runnerProfile?: Pick<RunnerProfile, "requireCredentialRefs">,
): readonly string[] {
  const credentialProviders = providersRequiringProviderEnvBindings(
    providers,
    runnerProfile,
  );
  const storeProvider = installConfig.store?.provider;
  if (typeof storeProvider !== "string" || !storeProvider.trim()) {
    return credentialProviders;
  }
  return normalizeProviders([
    ...credentialProviders,
    ...providers.filter((provider) =>
      sameProviderFamily(provider, storeProvider),
    ),
  ]);
}

function genericCapsuleOutputAllowlist(
  configured: InstallConfig["outputAllowlist"],
  moduleFiles: readonly OpenTofuCapsuleSourceFile[] | undefined,
  rootModuleOutputs: readonly string[] | undefined,
): InstallConfig["outputAllowlist"] {
  const outputDeclarations = moduleFiles
    ? collectRootModuleOutputDeclarations(moduleFiles)
    : [];
  const outputDeclarationByName = new Map(
    outputDeclarations.map((output) => [output.name, output]),
  );
  const outputNames =
    rootModuleOutputs ??
    outputDeclarations.map((output) => output.name);
  if (outputNames.length === 0) return configured;
  const allowlist: Record<string, OutputAllowlistEntry> = { ...configured };
  for (const name of outputNames) {
    if (Object.prototype.hasOwnProperty.call(allowlist, name)) continue;
    const sensitive =
      outputDeclarationByName.get(name)?.sensitive === true ||
      looksSensitiveOutputName(name);
    allowlist[name] = {
      from: name,
      type: "json",
      ...(sensitive ? { sensitive: true } : {}),
    };
  }
  return allowlist;
}

function looksSensitiveOutputName(name: string): boolean {
  return /(^|[_-])(token|secret|password|credential|auth|bearer|session|cookie)([_-]|$)|(^|[_-])(api[_-]?key|private[_-]?key|signing[_-]?key)([_-]|$)/iu.test(
    name,
  );
}

const MANAGED_WORKER_NAME_RE = /^[a-z][a-z0-9-]{1,50}[a-z0-9]$/u;
const PUBLIC_URL_OUTPUT_KEYS = [
  "url",
  "launch_url",
  "app_url",
  "public_url",
] as const;

function nonEmptyStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isJsonRecordValue(
  value: unknown,
): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validManagedWorkerName(value: string): boolean {
  return MANAGED_WORKER_NAME_RE.test(value);
}

function hostFromHttpsUrlValue(value: unknown): string | undefined {
  const raw = nonEmptyStringValue(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || !parsed.hostname) return undefined;
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function hostFromRoutePatternValue(value: unknown): string | undefined {
  const raw = nonEmptyStringValue(value);
  if (!raw) return undefined;
  const host = raw.split("/", 1)[0]?.trim().toLowerCase();
  return host && !host.includes("*") ? host : undefined;
}

function publicHostsFromInstallExperienceVariables(
  variables: Readonly<Record<string, unknown>>,
  installConfig: InstallConfig | undefined,
): readonly string[] {
  const endpoint = installExperiencePublicEndpoint(
    installConfig?.store?.installExperience,
  );
  if (!endpoint) return [];

  const hosts = new Set<string>();
  const baseDomain = managedPublicBaseDomainFromInstallConfig(installConfig);
  const subdomainVariable = nonEmptyStringValue(endpoint.subdomainVariable);
  if (subdomainVariable) {
    const host = managedPublicHostFromLabel(
      variables[subdomainVariable],
      baseDomain,
    );
    if (host) hosts.add(host);
  }

  const urlVariable = nonEmptyStringValue(endpoint.urlVariable);
  if (urlVariable) {
    const host = hostFromHttpsUrlValue(variables[urlVariable]);
    if (host) hosts.add(host);
  }

  const routePatternVariable = nonEmptyStringValue(
    endpoint.routePatternVariable,
  );
  if (routePatternVariable) {
    const host = hostFromRoutePatternValue(variables[routePatternVariable]);
    if (host) hosts.add(host);
  }

  return [...hosts].sort();
}

function publicHostsFromOutput(
  outputs: Readonly<Record<string, unknown>>,
): readonly string[] {
  const hosts = new Set<string>();
  for (const key of PUBLIC_URL_OUTPUT_KEYS) {
    const host = hostFromHttpsUrlValue(outputs[key]);
    if (host) hosts.add(host);
  }
  const appDeployment = outputs.app_deployment;
  if (isJsonRecordValue(appDeployment)) {
    for (const key of PUBLIC_URL_OUTPUT_KEYS) {
      const host = hostFromHttpsUrlValue(appDeployment[key]);
      if (host) hosts.add(host);
    }
  }
  const apps = outputs.apps;
  if (Array.isArray(apps)) {
    for (const app of apps) {
      if (!isJsonRecordValue(app)) continue;
      const host = hostFromHttpsUrlValue(app.url);
      if (host) hosts.add(host);
    }
  }
  return [...hosts].sort();
}

function hasManagedCloudflareProviderDefaults(
  defaults: Readonly<Record<string, JsonValue>>,
): boolean {
  if (nonEmptyStringValue(defaults.cloudflare_api_base_url)) return true;
  const cloudflare = defaults.cloudflare;
  return (
    isJsonRecordValue(cloudflare) &&
    nonEmptyStringValue(cloudflare.api_base_url) !== undefined
  );
}

function finalizeManagedCloudflarePublicHostVariables(input: {
  readonly explicit: Readonly<Record<string, JsonValue>>;
  readonly installation: Installation;
  readonly installConfig: InstallConfig;
  readonly declaredInputs: DeclaredGenericCapsuleInputs;
  readonly endpointVariables: ReadonlySet<string>;
  readonly providerInputDefaults: Readonly<Record<string, JsonValue>>;
  readonly variables: Readonly<Record<string, JsonValue>>;
}): Readonly<Record<string, JsonValue>> {
  if (!hasManagedCloudflareProviderDefaults(input.providerInputDefaults)) {
    return input.variables;
  }
  const endpoint = installExperiencePublicEndpoint(
    input.installConfig.store?.installExperience,
  );
  if (!endpoint || input.endpointVariables.size === 0) {
    return input.variables;
  }
  const subdomainVariable = nonEmptyStringValue(endpoint.subdomainVariable);
  if (!subdomainVariable) return input.variables;
  const urlVariable = nonEmptyStringValue(endpoint.urlVariable);
  const routePatternVariable = nonEmptyStringValue(
    endpoint.routePatternVariable,
  );
  const baseDomain = managedPublicBaseDomainFromInstallConfig(
    input.installConfig,
  );
  const canSet = (name: string) =>
    Object.prototype.hasOwnProperty.call(input.variables, name) ||
    input.declaredInputs.names.has(name) ||
    (!input.declaredInputs.known && input.endpointVariables.has(name));
  const out: Record<string, JsonValue> = { ...input.variables };
  let publicLabel = nonEmptyStringValue(out[subdomainVariable]);
  if (
    !publicLabel &&
    !nonEmptyStringValue(input.explicit[subdomainVariable]) &&
    canSet(subdomainVariable)
  ) {
    publicLabel = workerNameFromCapsule(input.installation);
    if (publicLabel) out[subdomainVariable] = publicLabel;
  }
  if (!publicLabel || !validManagedWorkerName(publicLabel)) {
    return out;
  }
  const host = `${publicLabel}.${baseDomain}`;
  if (
    urlVariable &&
    !nonEmptyStringValue(input.explicit[urlVariable]) &&
    canSet(urlVariable)
  ) {
    out[urlVariable] = `https://${host}`;
  }
  if (
    routePatternVariable &&
    canSet(routePatternVariable) &&
    !nonEmptyStringValue(input.explicit[routePatternVariable])
  ) {
    out[routePatternVariable] = `${host}/*`;
  }
  return out;
}

function workerNameFromCapsule(installation: Installation): string | undefined {
  const preferred =
    nonEmptyStringValue(installation.slug) ??
    nonEmptyStringValue(installation.name);
  if (!preferred) return undefined;
  const base = preferred
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/g, "")
    .replace(/-+$/g, "")
    .replace(/-{2,}/g, "-");
  const suffix = managedWorkerNameSuffix(installation.id);
  const maxBaseLength = Math.max(1, 52 - suffix.length - 1);
  const normalized = `${base.slice(0, maxBaseLength).replace(/-+$/g, "")}-${suffix}`;
  return validManagedWorkerName(normalized) ? normalized : undefined;
}

function publicHostUnavailableMessage(): string {
  return "app_hostname_unavailable: already exists";
}

function managedWorkerNameSuffix(installationId: string): string {
  const stripped = installationId.replace(/^inst[_-]?/u, "");
  const normalized = stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 8);
  return normalized || "capsule";
}

function installationHasClaimablePublicState(
  installation: Installation,
): boolean {
  return Boolean(
    installation.currentDeploymentId ||
    installation.currentStateVersionId ||
    installation.currentStateGeneration > 0 ||
    installation.status === "active" ||
    installation.status === "stale",
  );
}

function publicHostClaimPriority(installation: Installation): number {
  switch (installation.status) {
    case "active":
      return 400;
    case "stale":
      return 300;
    case "error":
      return installation.currentStateGeneration > 0 ? 200 : 0;
    case "pending":
      return installation.currentStateGeneration > 0 ? 100 : 0;
    case "disabled":
      return 50;
    case "destroyed":
      return 0;
  }
}

function workspaceOutputsWithReleaseDescriptor(
  workspaceOutputs: Readonly<Record<string, JsonValue>>,
  outputs: OpenTofuApplyResult["outputs"],
): Readonly<Record<string, JsonValue>> {
  const descriptor = releaseActivationOutputs(outputs).takosumi_release;
  if (descriptor === undefined) return workspaceOutputs;
  return {
    ...workspaceOutputs,
    takosumi_release: descriptor,
  };
}

/** Shared dependencies the controller injects into its single RunEngine. */
export interface RunEngineDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly runner?: OpenTofuRunner;
  readonly providerEnvRunner?: OpenTofuRunner;
  readonly sourcesService?: SourcesService;
  readonly defaultRunnerProfileId: string;
  readonly newId: (prefix: string) => string;
  readonly now: () => number;
  readonly enqueueRun: EnqueueRun;
  readonly templateRegistry: TemplateRegistry;
  readonly installationCoordination?: InstallationCoordination;
  readonly runRenewalIntervalMs: number;
  readonly activity: ActivityRecorder;
  readonly dependencyValueSealer?: DependencyValueSealer;
  readonly releaseActivator?: ReleaseActivator;
  readonly observability?: Pick<ObservabilitySink, "recordMetric">;
  readonly metricTags: Record<string, string>;
  readonly allowOperatorBackedProviderEnvs: boolean;
  readonly runnerProfiles: readonly RunnerProfile[];
  readonly seededProfiles: Promise<void>;
  readonly runQuery: RunQueryService;
  readonly billing: BillingService;
  readonly drift: DriftService;
  readonly runEnv: RunEnvResolver;
  readonly dependencies: DependencyResolutionService;
  readonly verification: RunVerificationService;
  readonly planResolution: PlanResolutionService;
  readonly sourceLifecycle: SourceLifecycleService;
  readonly deployments: DeploymentQuery;
  readonly runSerialized: RunSerialized;
}

export class RunEngine {
  readonly #store: OpenTofuDeploymentStore;
  readonly #runner?: OpenTofuRunner;
  readonly #providerEnvRunner?: OpenTofuRunner;
  readonly #sourcesService?: SourcesService;
  readonly #defaultRunnerProfileId: string;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #enqueueRun: EnqueueRun;
  readonly #templateRegistry: TemplateRegistry;
  readonly #installationCoordination?: InstallationCoordination;
  readonly #runRenewalIntervalMs: number;
  readonly #activity: ActivityRecorder;
  readonly #dependencyValueSealer?: DependencyValueSealer;
  readonly #releaseActivator?: ReleaseActivator;
  readonly #observability?: Pick<ObservabilitySink, "recordMetric">;
  readonly #metricTags: Record<string, string>;
  readonly #allowOperatorBackedProviderEnvs: boolean;
  readonly #runnerProfilesById: ReadonlyMap<string, RunnerProfile>;
  readonly #seededProfiles: Promise<void>;
  readonly #runQuery: RunQueryService;
  readonly #billing: BillingService;
  readonly #drift: DriftService;
  readonly #runEnv: RunEnvResolver;
  readonly #dependencies: DependencyResolutionService;
  readonly #verification: RunVerificationService;
  readonly #planResolution: PlanResolutionService;
  readonly #sourceLifecycle: SourceLifecycleService;
  readonly #deployments: DeploymentQuery;
  readonly #runSerialized: RunSerialized;
  #connectionsService?: ConnectionsService;

  constructor(deps: RunEngineDependencies) {
    this.#store = deps.store;
    this.#runner = deps.runner;
    this.#providerEnvRunner = deps.providerEnvRunner;
    this.#sourcesService = deps.sourcesService;
    this.#defaultRunnerProfileId = deps.defaultRunnerProfileId;
    this.#newId = deps.newId;
    this.#now = deps.now;
    this.#enqueueRun = deps.enqueueRun;
    this.#templateRegistry = deps.templateRegistry;
    this.#installationCoordination = deps.installationCoordination;
    this.#runRenewalIntervalMs = deps.runRenewalIntervalMs;
    this.#activity = deps.activity;
    this.#dependencyValueSealer = deps.dependencyValueSealer;
    this.#releaseActivator = deps.releaseActivator;
    this.#observability = deps.observability;
    this.#metricTags = deps.metricTags;
    this.#allowOperatorBackedProviderEnvs =
      deps.allowOperatorBackedProviderEnvs;
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
    this.#sourceLifecycle = deps.sourceLifecycle;
    this.#deployments = deps.deployments;
    this.#runSerialized = deps.runSerialized;
  }

  // ---- public bridges: invoked by controller-side collaborator callbacks ----
  // (the controller's BillingService / DriftService / RunCredentialBroker /
  // RunEnvResolver / RunVerificationService / PlanResolutionService / source
  // lifecycle wire their callbacks to these so the shared run-lifecycle helpers
  // keep a single owner here, while the private bodies stay byte-identical.)

  getApplyRun(id: string): Promise<ApplyRunResponse> {
    return this.#deployments.getApplyRun(id);
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

  createInstallationPlanRun(
    installationId: string,
    destroy: boolean,
    context: DeployControlActorContext,
    internal: CreateInstallationPlanInternal = {},
  ): Promise<PlanRunResponse> {
    return this.#createInstallationPlanRun(
      installationId,
      destroy,
      context,
      internal,
    );
  }

  resolveRunInstallationProviderEnvBindings(
    planRun: PlanRun,
  ): Promise<readonly ResolvedInstallationProviderEnvBinding[] | undefined> {
    return this.#resolveRunInstallationProviderEnvBindings(planRun);
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

  resolveInstallationProviderEnvBindingsForRun(
    installation: Installation,
    requiredProviders: readonly string[],
  ): Promise<readonly ResolvedInstallationProviderEnvBinding[]> {
    return this.#resolveInstallationProviderEnvBindingsForRun(
      installation,
      requiredProviders,
    );
  }

  async createPlanRun(
    request: CreatePlanRunRequest,
    context: DeployControlActorContext = {},
    internal: PlanRunInternalContext = {},
  ): Promise<PlanRunResponse> {
    const workspaceId = request.workspaceId ?? request.spaceId;
    requireNonEmptyString(workspaceId, "workspaceId");
    const requestCapsuleId = request.capsuleId ?? request.installationId;
    validateSource(request.source);
    let profile = await this.#requireRunnerProfile(
      request.runnerProfileId ?? this.#defaultRunnerProfileId,
    );
    const operation =
      request.operation ?? (requestCapsuleId ? "update" : "create");
    validateOperation(operation);
    const installation =
      requestCapsuleId !== undefined
        ? await this.#requireInstallation(requestCapsuleId)
        : undefined;
    if (!installation) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "plan requires an existing capsuleId (create the Capsule first)",
      );
    }
    if (installation.workspaceId !== workspaceId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "capsule is not available to this workspace",
      );
    }
    const installationContext: PlanRunInstallationContext =
      internal.installationContext ?? {
        workspaceId: installation.workspaceId,
        spaceId: installation.spaceId,
        capsuleId: installation.id,
        installationId: installation.id,
        environment: installation.environment,
      };
    const now = this.#now();
    const variables = normalizeVariables(request.variables);
    // Cloud-only gateway materialization is rejected here; OSS Takosumi never
    // rewrites a provider base_url. The runner profile is ignored by this step
    // and by template resolution, so the Capsule's required providers are
    // profile-independent and can drive runner-profile auto-selection below.
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
    // When the caller did not pin a runner profile, auto-select the enabled
    // profile that admits the Capsule's required providers — preferring a
    // specific match (so a Cloudflare Capsule keeps `cloudflare-default`) and
    // falling back to the wildcard generic-provider surface. This is what lets a
    // user's own-key (`generic_env_provider`) connection to an ARBITRARY
    // provider run without the caller naming a profile. Only already-enabled,
    // operator-curated profiles are candidates, so auto-selection never widens
    // the operator's admitted provider surface — it only removes the manual
    // "which runner profile?" step.
    if (request.runnerProfileId === undefined) {
      profile = this.#selectRunnerProfileForProviders(
        profile,
        declaredProviders,
      );
    }
    // Resource Shape adapters pass an internal generated root that fully
    // overrides the backing Capsule's nominal Source. Keep local source
    // rejection for user-supplied Capsule runs, but do not reject the internal
    // placeholder source when the runner will execute generatedRoot instead.
    // Validated against the final (possibly auto-selected) profile.
    if (!internal.genericRootDispatch?.generatedRoot) {
      validateSourceAllowedByProfile(request.source, profile);
    }
    const allowNoProviders =
      (templatePlan !== undefined &&
        templatePlan.template.policy.allowedProviders.length === 0) ||
      (templatePlan === undefined &&
        declaredProviders.length === 0 &&
        internal.genericRootDispatch !== undefined) ||
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
    if (
      policy.status === "passed" &&
      operation !== "destroy" &&
      internal.driftCheck !== true
    ) {
      const installConfig = await this.#store.getInstallConfig(
        installation.installConfigId,
      );
      await this.#reservePublicHostsForPlan(installation, variables, now, {
        managedBaseDomains: [
          managedPublicBaseDomainFromInstallConfig(installConfig),
        ],
      });
    }
    const planRunId = this.#newId("plan");
    const sourceSnapshotId =
      internal.sourceSnapshotId ??
      (internal.genericRootDispatch?.generatedRoot
        ? await this.#recordGeneratedRootSourceSnapshot({
            workspaceId,
            planRunId,
            generatedRoot: internal.genericRootDispatch.generatedRoot,
            now,
          })
        : await this.#resolvePlanSourceSnapshotId(installation));
    const baseStateGeneration =
      internal.baseStateGeneration ?? installation.currentStateGeneration;
    const providerCredentialDelivery =
      internal.providerCredentialDelivery ??
      internal.genericRootDispatch?.providerCredentialDelivery;
    let planRun: PlanRun = {
      id: planRunId,
      workspaceId,
      spaceId: workspaceId,
      ...(requestCapsuleId
        ? { capsuleId: requestCapsuleId, installationId: requestCapsuleId }
        : {}),
      capsuleCurrentStateVersionId: installation.currentStateVersionId ?? null,
      installationCurrentDeploymentId: installation.currentDeploymentId,
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
      ...(providerCredentialDelivery ? { providerCredentialDelivery } : {}),
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
    if (
      Object.keys(variables).length > 0 ||
      generatedRoot !== undefined ||
      outputAllowlist !== undefined
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
        },
        sealSidecar,
      );
    }
    if (policy.status === "passed" && this.#hasRunnerForProfile(profile)) {
      await this.#enqueueRun({
        action: "plan",
        runId: planRun.id,
        spaceId: planRun.workspaceId ?? planRun.spaceId,
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
    internal: Pick<CreateInstallationPlanInternal, "runnerProfileId"> = {},
  ): Promise<PlanRunResponse> {
    return await this.#createInstallationPlanRun(
      installationId,
      true,
      context,
      internal,
    );
  }

  /**
   * Capsule-driven drift check (spec §19 `drift_check` run type; Phase 8
   * advanced). Creates a plan-kind internal run flagged
   * {@link PlanRun.driftCheck} that:
   *   - resolves the Capsule config -> Source -> latest snapshot
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
    requireNonEmptyString(installationId, "installationId");
    const installation = await planCreationStage(
      "installation_load",
      this.#requireInstallation(installationId),
    );
    const installConfig = await planCreationStage(
      "install_config_load",
      this.#store.getInstallConfig(installation.installConfigId),
    );
    if (!installConfig) {
      throw new OpenTofuControllerError(
        "not_found",
        `install config ${installation.installConfigId} not found for ` +
          `installation ${installationId}`,
      );
    }
    const runnerProfileId = internal.runnerProfileId ?? installConfig.runnerId;
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
      const stored = await planCreationStage(
        "source_load",
        this.#store.getSource(installation.sourceId),
      );
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
      const destroySnapshotId = destroy
        ? await this.#destroySourceSnapshotIdForInstallation(installation)
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
              this.#requireSourceSnapshotForSource(
                stored.id,
                destroySnapshotId,
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
        // Typed 409: the Installation cannot plan until a SourceSnapshot exists
        // for its source. Callers run a source_sync first.
        throw new OpenTofuControllerError(
          "failed_precondition",
          `source_sync_required: installation ${installationId} has no ` +
            `SourceSnapshot for source ${stored.id} ref ${stored.defaultRef} ` +
            `path ${stored.defaultPath}; run a source sync first`,
        );
      }
      snapshot = resolved;
    } else {
      const pinnedSnapshotId =
        internal.sourceSnapshotId ??
        (destroy
          ? await this.#destroySourceSnapshotIdForInstallation(installation)
          : undefined);
      if (!pinnedSnapshotId) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `installation ${installationId} has no git Source; a plan requires a ` +
            `pinned upload/artifact SourceSnapshot through the internal upload-compat seam`,
        );
      }
      const pinned = await planCreationStage(
        "upload_source_snapshot_load",
        this.#store.getSourceSnapshot(pinnedSnapshotId),
      );
      const installationWorkspaceId =
        installation.workspaceId ?? installation.spaceId;
      const pinnedWorkspaceId = pinned?.workspaceId ?? pinned?.spaceId;
      if (!pinned || pinnedWorkspaceId !== installationWorkspaceId) {
        throw new OpenTofuControllerError(
          "not_found",
          "upload/artifact SourceSnapshot not found in this workspace",
        );
      }
      snapshot = pinned;
      source = syntheticUploadSource(installation, pinned);
    }
    // The Installation's current state generation drives the dispatch
    // restore/persist arithmetic. No prior StateSnapshot -> generation 0.
    const latestState = await planCreationStage(
      "latest_state_load",
      this.#store.getLatestStateSnapshot(
        installation.id,
        installation.environment,
      ),
    );
    const baseStateGeneration = latestState?.generation ?? 0;
    const operation = destroy
      ? "destroy"
      : installation.currentDeploymentId
        ? "update"
        : "create";
    const compatibilityReportFromHint =
      !internal.deferCompatibilityReport && internal.compatibilityReportId
        ? true
        : false;
    const compatibilityReport = internal.deferCompatibilityReport
      ? undefined
      : internal.compatibilityReportId
        ? await planCreationStage(
            "compatibility_report_hint",
            this.#useInstallationCompatibilityReportHint(
              installation,
              source,
              snapshot,
              internal.compatibilityReportId,
            ),
          )
        : await planCreationStage(
            "compatibility_report_ensure",
            this.#ensureInstallationCompatibilityReport(
              installation,
              source,
              snapshot,
              installConfig.modulePath,
            ),
          );
    const {
      request: planRequest,
      installTypePlan,
      genericRootPlan,
    } = await planCreationStage(
      "installation_plan_request",
      this.#installationPlanRequest({
        installation,
        installConfig,
        source,
        snapshot,
        operation,
        ...(runnerProfileId ? { runnerProfileId } : {}),
        ...(compatibilityReport ? { compatibilityReport } : {}),
        skipReadySourceFileDiscovery: compatibilityReportFromHint,
      }),
    );
    const installationContext: PlanRunInstallationContext = {
      workspaceId: installation.workspaceId,
      spaceId: installation.spaceId,
      capsuleId: installation.id,
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
    const selectedPlanRequest = runnerProfileId
      ? { ...planRequest, runnerProfileId }
      : planRequest;
    const resolvedDeps = destroy
      ? undefined
      : await planCreationStage(
          "dependency_resolution",
          this.#dependencies.resolveConsumerDependencies(installation),
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
            snapshot,
          ),
        )
      : undefined;
    const response = await planCreationStage(
      "plan_run_create",
      this.createPlanRun(injectedRequest, context, {
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
      }),
    );
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

  async #resolvePlanSourceSnapshotId(
    installation: Installation,
  ): Promise<string> {
    if (!installation.sourceId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `installation ${installation.id} has no git Source; ` +
          `only internal upload-compat callers can plan it without a Git Source`,
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
      source.defaultPath,
    );
    if (!snapshot) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `source_sync_required: installation ${installation.id} has no SourceSnapshot for source ${source.id} ref ${source.defaultRef} path ${source.defaultPath}; run a source sync first`,
      );
    }
    return snapshot.id;
  }

  async #recordGeneratedRootSourceSnapshot(input: {
    readonly workspaceId: string;
    readonly planRunId: string;
    readonly generatedRoot: DispatchGeneratedRoot;
    readonly now: number;
  }): Promise<string> {
    const snapshotId = this.#newId("snap");
    const digest = await stableJsonDigest(input.generatedRoot);
    const bytes = new TextEncoder().encode(JSON.stringify(input.generatedRoot));
    const snapshot: SourceSnapshot = {
      id: snapshotId,
      origin: "upload",
      workspaceId: input.workspaceId,
      spaceId: input.workspaceId,
      url: `takosumi://generated-root/${input.planRunId}`,
      ref: "generated-root",
      resolvedCommit: digest,
      path: ".",
      archiveObjectKey: `spaces/${input.workspaceId}/generated-roots/${snapshotId}/generated-root.json`,
      archiveDigest: digest,
      archiveSizeBytes: bytes.byteLength,
      fetchedByRunId: input.planRunId,
      fetchedAt: new Date(input.now).toISOString(),
    };
    await this.#store.putSourceSnapshot(snapshot);
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
    modulePath?: string,
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
          ...(modulePath ? { modulePath } : {}),
        })
      : await this.#sourcesService.createCompatibilityCheckForSnapshot(
          snapshot,
          {
            installationId: installation.id,
            ...(modulePath ? { modulePath } : {}),
          },
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
    readonly runnerProfileId?: string;
    readonly compatibilityReport?: CapsuleCompatibilityReport;
    readonly skipReadySourceFileDiscovery?: boolean;
  }): Promise<{
    readonly request: CreatePlanRunRequest;
    readonly installTypePlan?: InstallTypePlanContext;
    readonly genericRootPlan?: GenericRootPlanContext;
  }> {
    const moduleSource = snapshotModuleSource(
      input.source,
      input.snapshot,
      input.installConfig.modulePath,
    );
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
        providerEnvResolutionProviders(requiredProviders, input.installConfig),
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
      readonly runnerProfileId?: string;
      readonly compatibilityReport?: CapsuleCompatibilityReport;
      readonly snapshot: SourceSnapshot;
      readonly skipReadySourceFileDiscovery?: boolean;
    },
    moduleSource: OpenTofuModuleSource,
  ): Promise<{
    readonly request: CreatePlanRunRequest;
    readonly genericRootPlan: GenericRootPlanContext;
  }> {
    const profile = await this.#requireRunnerProfile(
      input.runnerProfileId ?? this.#defaultRunnerProfileId,
    );
    const compatibilityProviders = requiredProvidersFromCompatibilityReport(
      input.compatibilityReport,
      profile.allowedProviders,
    );
    let requiredProviders = compatibilityProviders;
    let installTypePlan = await this.#planResolution.resolveInstallTypePlan(
      input.installation,
      input.installConfig,
      input.installConfig.installType,
      providerEnvResolutionProviders(
        requiredProviders,
        input.installConfig,
        profile,
      ),
    );
    const bindingProviders = installTypePlan.requiredProvidersFromBindings;
    if (requiredProviders.length === 0 && bindingProviders.length > 0) {
      requiredProviders = bindingProviders;
      installTypePlan = await this.#planResolution.resolveInstallTypePlan(
        input.installation,
        input.installConfig,
        input.installConfig.installType,
        providerEnvResolutionProviders(
          requiredProviders,
          input.installConfig,
          profile,
        ),
      );
    }
    const moduleFiles = await this.#sourceModuleFilesForGenericCapsule(
      input.compatibilityReport,
      input.snapshot,
      input.installConfig.modulePath,
      { skipReady: input.skipReadySourceFileDiscovery === true },
    );
    const declaredInputs = declaredGenericCapsuleInputs(
      moduleFiles,
      input.compatibilityReport?.rootModuleVariables,
    );
    const explicitVariables = normalizeVariables(
      input.installConfig.variableMapping,
    );
    const variables = finalizeManagedCloudflarePublicHostVariables({
      explicit: explicitVariables,
      installation: input.installation,
      installConfig: input.installConfig,
      declaredInputs,
      endpointVariables: publicEndpointVariableNames(input.installConfig),
      providerInputDefaults: installTypePlan.providerInputDefaults,
      variables: normalizeVariables(
        mergeJsonVariableDefaults(
          installTypePlan.providerInputDefaults,
          requestedGenericCapsuleVariables(
            explicitVariables,
            installTypePlan.providerInputDefaults,
            declaredInputs,
          ),
        ),
      ),
    });
    const outputAllowlist = genericCapsuleOutputAllowlist(
      input.installConfig.outputAllowlist,
      moduleFiles,
      input.compatibilityReport?.rootModuleOutputs,
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
        outputAllowlist,
        ...(input.compatibilityReport?.level === "auto_capsulized" &&
        moduleFiles &&
        moduleFiles.length > 0
          ? { moduleFiles }
          : {}),
      },
    };
  }

  async #reservePublicHostsForPlan(
    installation: Installation,
    variables: Readonly<Record<string, JsonValue>>,
    now: number,
    options: {
      readonly managedBaseDomains?: readonly string[];
    } = {},
  ): Promise<void> {
    const managedBaseDomains = normalizeManagedPublicBaseDomains(
      options.managedBaseDomains,
    );
    const installConfig = await this.#store.getInstallConfig(
      installation.installConfigId,
    );
    const requestedHosts = publicHostsFromInstallExperienceVariables(
      variables,
      installConfig,
    );
    const claimableHosts = requestedHosts.filter(
      (host) =>
        publicHostPolicyKind(host, managedBaseDomains) ===
        "managed_default_hostname",
    );
    if (claimableHosts.length === 0) return;
    const claims = await this.#publicHostClaims();
    for (const host of claimableHosts) {
      const claim = claims.get(host);
      if (!claim || claim.installationId === installation.id) continue;
      throw new OpenTofuControllerError(
        "failed_precondition",
        publicHostUnavailableMessage(),
        { reason: "app_hostname_unavailable" },
      );
    }
    const workspaceId = installation.workspaceId ?? installation.spaceId;
    const nowIso = new Date(now).toISOString();
    for (const host of claimableHosts) {
      const result = await this.#store.reservePublicHost({
        hostname: host,
        workspaceId,
        installationId: installation.id,
        installationName: installation.name,
        now: nowIso,
      });
      if (result.reserved) continue;
      const reservation = result.reservation;
      throw new OpenTofuControllerError(
        "failed_precondition",
        publicHostUnavailableMessage(),
        { reason: "app_hostname_unavailable" },
      );
    }
  }

  async #releasePublicHostsForInstallation(
    installationId: string,
    now: number,
  ): Promise<void> {
    try {
      await this.#store.releasePublicHostsForInstallation(
        installationId,
        new Date(now).toISOString(),
      );
    } catch (error) {
      log.warn("deploy_control.public_host_release_failed", {
        installationId,
        error,
      });
    }
  }

  async #publicHostClaims(): Promise<
    ReadonlyMap<
      string,
      {
        readonly installationId: string;
        readonly installationName: string;
        readonly workspaceId: string;
        readonly priority: number;
      }
    >
  > {
    const claims = new Map<
      string,
      {
        readonly installationId: string;
        readonly installationName: string;
        readonly workspaceId: string;
        readonly priority: number;
      }
    >();
    const installations = await this.#store.listInstallations();
    for (const installation of installations) {
      if (installation.status === "destroyed") continue;
      if (!installationHasClaimablePublicState(installation)) continue;
      let hosts: readonly string[];
      try {
        hosts = await this.#publicHostsForInstallation(installation);
      } catch (error) {
        log.warn("deploy_control.public_host_claim_skipped", {
          installationId: installation.id,
          workspaceId: installation.workspaceId ?? installation.spaceId,
          error,
        });
        continue;
      }
      for (const host of hosts) {
        const candidate = {
          installationId: installation.id,
          installationName: installation.name,
          workspaceId: installation.workspaceId ?? installation.spaceId,
          priority: publicHostClaimPriority(installation),
        };
        const current = claims.get(host);
        if (current && current.priority >= candidate.priority) continue;
        claims.set(host, candidate);
      }
    }
    return claims;
  }

  async #publicHostsForInstallation(
    installation: Installation,
  ): Promise<readonly string[]> {
    const hosts = new Set<string>();
    const installConfig = await this.#store.getInstallConfig(
      installation.installConfigId,
    );
    if (installConfig) {
      for (const host of publicHostsFromInstallExperienceVariables(
        normalizeVariables(installConfig.variableMapping),
        installConfig,
      )) {
        hosts.add(host);
      }
    }
    const outputSnapshot = await this.#store.getLatestOutputSnapshot(
      installation.id,
    );
    if (outputSnapshot) {
      for (const host of publicHostsFromOutput(outputSnapshot.publicOutputs)) {
        hosts.add(host);
      }
      for (const host of publicHostsFromOutput(
        outputSnapshot.workspaceOutputs,
      )) {
        hosts.add(host);
      }
    }
    return [...hosts].sort();
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
    const profile = await this.#requireRunnerProfile(
      request.runnerProfileId ?? this.#defaultRunnerProfileId,
    );
    const resolved = await this.#resolveInstallationProviderEnvBindingsForRun(
      installation,
      providersRequiringProviderEnvBindings(requiredProviders, profile),
    );
    return await this.#genericRootDispatchForRequest(
      request,
      {
        providerEnvBindings: providerEnvBindingsFromResolved(resolved),
        outputAllowlist: installConfig.outputAllowlist,
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

  async #sourceModuleFilesForGenericCapsule(
    report: CapsuleCompatibilityReport | undefined,
    sourceSnapshot: SourceSnapshot,
    modulePath: string | undefined,
    options: { readonly skipReady?: boolean } = {},
  ): Promise<readonly OpenTofuCapsuleSourceFile[] | undefined> {
    if (!report) return undefined;
    if (report.level === "auto_capsulized") {
      return await this.#normalizedModuleFilesForReport(report, sourceSnapshot);
    }
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
   * covered by ProviderBindings, except for Cloud/operator deployments where a
   * single public managed ProviderConnection may satisfy the provider family.
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

  async #destroySourceSnapshotIdForInstallation(
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
        snapshot.capsuleId ?? snapshot.installationId,
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
    // Installation + Deployment (and real cloud resources). Replays of a
    // successfully-applied PlanRun are idempotent: return the existing apply
    // response instead of creating a visible failed run. (update/destroy were
    // already replay-protected by the installation currentDeploymentId guard.)
    //
    // This is an OPTIMISTIC pre-check before the per-(Installation,environment)
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
    const applyCapsuleId = planRun.capsuleId ?? planRun.installationId;
    const applyRun: ApplyRun = {
      id: this.#newId("apply"),
      planRunId: planRun.id,
      workspaceId: planRun.workspaceId,
      spaceId: planRun.spaceId,
      ...(applyCapsuleId
        ? { capsuleId: applyCapsuleId, installationId: applyCapsuleId }
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
      spaceId: applyRun.workspaceId ?? applyRun.spaceId,
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
      workspaceId: installation.workspaceId,
      spaceId: installation.spaceId,
      capsuleId: installation.id,
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
      if (isRetryableRunnerRequeueError(error)) throw error;
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
    if (isGeneratedRootSourceSnapshot(snapshot)) {
      return planRun;
    }
    const source = installation.sourceId
      ? await this.#requireSourceForInstallation(installation)
      : syntheticUploadSource(installation, snapshot);
    const report = await this.#ensureInstallationCompatibilityReport(
      installation,
      source,
      snapshot,
      planRun.source.modulePath,
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
   * `outputAllowlist`) is encrypted into {@link PlanRunInputs.sealed}
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
      DispatchGeneratedRoot | undefined;
    const outputAllowlist = payload.outputAllowlist as unknown as
      Readonly<Record<string, OutputAllowlistEntry>> | undefined;
    return {
      planRunId,
      variables,
      ...(generatedRoot ? { generatedRoot } : {}),
      ...(outputAllowlist ? { outputAllowlist } : {}),
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
    const workspaceId = scope.workspaceId ?? scope.spaceId ?? "";
    const capsuleId = scope.capsuleId ?? scope.installationId ?? "";
    return {
      id: this.#newId("state"),
      workspaceId,
      spaceId: scope.spaceId ?? workspaceId,
      capsuleId,
      installationId: scope.installationId ?? capsuleId,
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
    const projectedWorkspaceOutputs = input.outputAllowlist
      ? projectOutputAllowlistSpaceOutputs(
          input.outputAllowlist,
          input.result.outputs,
        )
      : Object.fromEntries(
          input.publicOutputs.map((output) => [output.name, output.value]),
        );
    const workspaceOutputs = workspaceOutputsWithReleaseDescriptor(
      projectedWorkspaceOutputs,
      input.result.outputs,
    );
    const publicOutputs = Object.fromEntries(
      input.publicOutputs.map((output) => [output.name, output.value]),
    );
    const outputDigest = await stableJsonDigest({
      spaceOutputs: workspaceOutputs,
      publicOutputs,
    });
    const snapshot: OutputSnapshot = {
      id: this.#newId("out"),
      workspaceId: input.installation.workspaceId,
      spaceId: input.installation.workspaceId ?? input.installation.spaceId,
      capsuleId: input.installation.id,
      installationId: input.installation.id,
      stateGeneration: input.stateGeneration,
      rawOutputArtifactKey:
        input.result.rawOutputsKey ??
        rawOutputArtifactKey({
          spaceId: input.installation.workspaceId ?? input.installation.spaceId,
          installationId: input.installation.id,
          runId: input.applyRun.id,
        }),
      publicOutputs,
      workspaceOutputs,
      spaceOutputs: workspaceOutputs,
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
      input.installation.workspaceId ?? input.installation.spaceId,
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
  async #recordActivity(event: RecordActivityArgs): Promise<void> {
    // Dual-write the renamed Workspace identity during the rename: every caller
    // may pass either the canonical `workspaceId` or the deprecated `spaceId`;
    // the persisted ActivityEvent carries both so readers on either name resolve.
    const workspaceId = event.workspaceId ?? event.spaceId ?? "";
    try {
      await this.#activity.record({
        ...event,
        workspaceId,
        spaceId: workspaceId,
      });
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
    const installation = await this.#store.getInstallation(
      ctx.capsuleId ?? ctx.installationId,
    );
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
    const profile = await this.#requireRunnerProfile(planRun.runnerProfileId);
    const installConfig = await this.#store.getInstallConfig(
      installation.installConfigId,
    );
    if (!installConfig) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `install_config_not_found: ${installation.installConfigId}`,
      );
    }
    // Run-scoped: ProviderBindings plus the same Cloud/operator managed
    // fallback used by rootgen. This keeps minted TF_VAR credentials lined up
    // with the generated provider blocks.
    return await this.#connectionsService.resolveProviderEnvBindingsForRun(
      installation,
      providerEnvResolutionProviders(
        planRun.requiredProviders,
        installConfig,
        profile,
      ),
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
    const installationId =
      request.capsuleId ?? backup.capsuleId ?? backup.installationId;
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
        "capsule not found in this workspace",
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
      workspaceId: installation.workspaceId,
      spaceId,
      capsuleId: installation.id,
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
          errorCode: compactErrorCode(errorMessage(error)),
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
      spaceId: queued.spaceId,
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
        errorCode: compactErrorCode(errorMessage(error)),
        ...(queued.installationId
          ? { installationId: queued.installationId }
          : {}),
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

  async #completeApplyRunAsIdempotentReplay(input: {
    readonly running: ApplyRun;
    readonly planRun: PlanRun;
    readonly profile: RunnerProfile;
    readonly startedAt: number;
    readonly leaseToken: string;
    readonly existingApplyRunId: string;
  }): Promise<ApplyRunResponse> {
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
      ...(existing.installationId
        ? {
            capsuleId: existing.capsuleId ?? existing.installationId,
            installationId: existing.installationId,
          }
        : {}),
      ...(existing.deploymentId ? { deploymentId: existing.deploymentId } : {}),
      ...(existing.installationCurrentDeploymentId
        ? {
            installationCurrentDeploymentId:
              existing.installationCurrentDeploymentId,
          }
        : {}),
      ...(existing.stateVersionId
        ? { stateVersionId: existing.stateVersionId }
        : {}),
      status: "succeeded",
      stateLock:
        existing.stateLock ??
        stateLockEvidence(
          input.profile.stateBackend,
          input.startedAt,
          now,
          "recorded",
        ),
      ...(existing.outputs ? { outputs: existing.outputs } : {}),
      ...(existing.providerResolutions
        ? { providerResolutions: existing.providerResolutions }
        : {}),
      auditEvents: [
        ...input.running.auditEvents,
        auditEvent(input.running.id, "apply.idempotent_replay", now, {
          planRunId: input.planRun.id,
          existingApplyRunId: input.existingApplyRunId,
          ...(existing.deploymentId
            ? { deploymentId: existing.deploymentId }
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
        spaceId: applyRun.spaceId,
        action: "run.idempotent_replay",
        targetType: "run",
        targetId: applyRun.id,
        runId: applyRun.id,
        metadata: {
          phase: applyRun.operation === "destroy" ? "destroy_apply" : "apply",
          operation: applyRun.operation,
          existingApplyRunId: input.existingApplyRunId,
          ...(applyRun.installationId
            ? { installationId: applyRun.installationId }
            : {}),
        },
      });
    }
    return await this.getApplyRun(applyRun.id);
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
            errorCode: compactErrorCode(errorMessage(error)),
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
      spaceId: queued.spaceId,
      action: "run.retry_scheduled",
      targetType: "run",
      targetId: queued.id,
      runId: queued.id,
      metadata: {
        phase,
        operation: queued.operation,
        errorCode: compactErrorCode(errorMessage(error)),
        ...(queued.installationId
          ? { installationId: queued.installationId }
          : {}),
      },
    });
    await this.#enqueueRequeuedRun("apply", queued);
    return result.run as ApplyRun;
  }

  async #enqueueRequeuedRun(
    action: "plan" | "apply",
    run: PlanRun | ApplyRun,
  ): Promise<void> {
    try {
      await this.#enqueueRun({
        action,
        runId: run.id,
        spaceId: run.workspaceId ?? run.spaceId,
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
        spaceId: updated.workspaceId ?? updated.spaceId,
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
    const profile = await this.#store.getRunnerProfile(planRun.runnerProfileId);
    return await this.#policyForInstallation(installation, profile);
  }

  async #policyForInstallation(
    installation: Installation,
    runnerProfile?: RunnerProfile,
  ): Promise<PolicyConfig | undefined> {
    const [space, installConfig] = await Promise.all([
      this.#store.getSpace(installation.workspaceId ?? installation.spaceId),
      this.#store.getInstallConfig(installation.installConfigId),
    ]);
    return withDefaultProviderSupplyChainPolicy(
      mergePolicyConfigs(space?.policy, installConfig?.policy),
      {
        providerInstallationRequireMirror:
          defaultProviderMirrorRequiredForProfile(runnerProfile),
      },
    );
  }

  async #recordRunnerMinuteUsage(input: {
    readonly spaceId: string;
    readonly runId: string;
    readonly installationId?: string;
    readonly startedAt?: number;
    readonly finishedAt: number;
  }): Promise<void> {
    if (input.startedAt === undefined) return;
    const space = await this.#store.getSpace(input.spaceId);
    const billingSubjectId = space?.ownerUserId ?? input.spaceId;
    const durationMs = Math.max(0, input.finishedAt - input.startedAt);
    const quantity = durationMs / 60_000;
    const usdMicros = runnerMinuteUsdMicros(quantity);
    await this.#store.putUsageEvent({
      id: this.#newId("usage"),
      workspaceId: billingSubjectId,
      spaceId: billingSubjectId,
      ...(input.installationId ? { installationId: input.installationId } : {}),
      runId: input.runId,
      resourceMetadata: {
        source_workspace_id: input.spaceId,
      },
      kind: "runner_minute",
      quantity,
      usdMicros,
      credits: usdMicrosToLegacyCredits(usdMicros),
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
      space_id: input.run.workspaceId,
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
   * Whether a plan run targets a provider-free §10 install. A provider-free
   * template (e.g. `core`) declares zero allowed providers, while a generic
   * OpenTofu Capsule can be provider-free when compatibility preflight found no
   * required providers and the runner also observed none. Such runs are allowed
   * to declare/observe zero providers without tripping the profile's
   * "requiredProviders before init" gate.
   */
  #planAllowsNoProviders(planRun: PlanRun): boolean {
    const binding = planRun.templateBinding;
    if (!binding) {
      return (
        planRun.installationId !== undefined &&
        planRun.sourceSnapshotId !== undefined &&
        planRun.requiredProviders.length === 0
      );
    }
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
      if (runnerDispatched && isRetryableRunnerInfrastructureError(error)) {
        const runningWithEnvironmentFailure = runEnvironmentFailedRun(
          runningForFailure,
          error,
        );
        if (
          runnerInfrastructureRetryCount(runningWithEnvironmentFailure, [
            "apply.retry_scheduled",
          ]) >= RUNNER_INFRASTRUCTURE_RETRY_LIMIT
        ) {
          await this.#billing.releaseApplyBillingReservation(planRun);
          const failed = await this.#failApplyRun(
            runningWithEnvironmentFailure,
            leaseToken,
            profile,
            startedAt,
            "apply.failed",
            runnerInfrastructureRetryExhaustedError("apply"),
          );
          if (failed.finishedAt !== undefined) {
            await this.#recordRunnerMinuteUsage({
              spaceId: failed.workspaceId,
              runId: failed.id,
              installationId: failed.installationId,
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
          );
          if (queued.updatedAt !== undefined) {
            await this.#recordRunnerMinuteUsage({
              spaceId: queued.workspaceId,
              runId: queued.id,
              installationId: queued.installationId,
              startedAt,
              finishedAt: queued.updatedAt,
            });
          }
          throw retryError;
        }
      }
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
          spaceId: failed.workspaceId,
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
    // This is an idempotent replay of the same reviewed plan, not a user-visible
    // failed run.
    const persistedPlan = await this.#store.getPlanRun(planRun.id);
    if (persistedPlan?.appliedApplyRunId) {
      throw new PlanAlreadyAppliedReplay(
        planRun.id,
        persistedPlan.appliedApplyRunId,
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
      spaceId: planRun.workspaceId,
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

  async #activateReleaseAfterApply(input: {
    readonly planRun: PlanRun;
    readonly applyRun: ApplyRun;
    readonly installation: Installation;
    readonly deployment: Deployment;
    readonly outputSnapshot: OutputSnapshot;
    readonly result: OpenTofuApplyResult;
  }): Promise<void> {
    let nonSensitiveOutputs = releaseActivationOutputs(input.result.outputs);
    let commands = releaseActivationCommands(input.result.outputs);
    if (commands.length === 0) {
      const snapshotOutputs = jsonRecordFromPublicOutputs(
        input.outputSnapshot.workspaceOutputs as Readonly<
          Record<string, unknown>
        >,
      );
      const snapshotCommands = releaseActivationCommandsFromOutputRecord(
        input.outputSnapshot.workspaceOutputs as Readonly<
          Record<string, unknown>
        >,
        "post_apply",
      );
      if (snapshotCommands.length > 0) {
        commands = snapshotCommands;
        nonSensitiveOutputs = snapshotOutputs;
      }
    }
    const sourceSnapshot =
      commands.length > 0
        ? await this.#store.getSourceSnapshot(input.deployment.sourceSnapshotId)
        : undefined;
    if (!this.#releaseActivator) {
      if (commands.length > 0) {
        await this.#recordReleaseActivationActivity({
          ...input,
          status: "pending",
          kind: "takosumi.release-commands@v1",
          message:
            "post-apply release commands declared but no release activator is configured",
          commandCount: commands.length,
          outputCount: Object.keys(nonSensitiveOutputs).length,
        });
      }
      return;
    }
    try {
      const credentials = await this.#releaseCredentialsForCommands({
        planRun: input.planRun,
        applyRun: input.applyRun,
        commands,
        phase: "apply",
      });
      let result: ReleaseActivationResult;
      result = await this.#releaseActivator.activate({
        planRun: input.planRun,
        applyRun: input.applyRun,
        installation: input.installation,
        deployment: input.deployment,
        outputSnapshot: input.outputSnapshot,
        nonSensitiveOutputs,
        ...(credentials ? { credentials } : {}),
        commands,
        ...(sourceSnapshot ? { sourceSnapshot } : {}),
      });
      if (result.status === "skipped" && commands.length > 0) {
        await this.#recordReleaseActivationActivity({
          ...input,
          status: "failed",
          kind: result.kind,
          message:
            result.message ??
            "release activator skipped declared post-apply commands",
          commandCount: commands.length,
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
        commandCount: commands.length,
        outputCount: Object.keys(nonSensitiveOutputs).length,
      });
    } catch (error) {
      await this.#recordReleaseActivationActivity({
        ...input,
        status: "failed",
        message: errorMessage(error),
        commandCount: commands.length,
        outputCount: Object.keys(nonSensitiveOutputs).length,
      });
      return;
    }
  }

  async #activateReleaseBeforeDestroy(input: {
    readonly planRun: PlanRun;
    readonly applyRun: ApplyRun;
    readonly installation: Installation;
  }): Promise<void> {
    const deploymentId = input.installation.currentDeploymentId;
    if (!deploymentId) return;
    const deployment = await this.#store.getDeployment(deploymentId);
    if (!deployment || deployment.status === "destroyed") return;
    const outputSnapshot = await this.#store.getOutputSnapshot(
      deployment.outputSnapshotId,
    );
    if (!outputSnapshot) return;
    const nonSensitiveOutputs = {
      ...jsonRecordFromPublicOutputs(deployment.outputsPublic),
      ...jsonRecordFromPublicOutputs(
        outputSnapshot.workspaceOutputs as Readonly<Record<string, unknown>>,
      ),
    };
    const commands = releaseActivationCommandsFromPublicOutputs(
      nonSensitiveOutputs,
      "pre_destroy",
    );
    if (commands.length === 0) return;
    const sourceSnapshot = await this.#store.getSourceSnapshot(
      deployment.sourceSnapshotId,
    );
    if (!this.#releaseActivator) {
      await this.#recordReleaseActivationActivity({
        applyRun: input.applyRun,
        installation: input.installation,
        deployment,
        status: "failed",
        kind: "takosumi.release-commands@v1",
        message:
          "pre-destroy release commands declared but no release activator is configured",
        commandCount: commands.length,
        outputCount: Object.keys(nonSensitiveOutputs).length,
      });
      throw new OpenTofuControllerError(
        "failed_precondition",
        "pre-destroy release commands require a release activator",
      );
    }
    try {
      const credentials = await this.#releaseCredentialsForCommands({
        planRun: input.planRun,
        applyRun: input.applyRun,
        commands,
        phase: "destroy",
      });
      let result: ReleaseActivationResult;
      result = await this.#releaseActivator.activate({
        planRun: input.planRun,
        applyRun: input.applyRun,
        installation: input.installation,
        deployment,
        outputSnapshot,
        nonSensitiveOutputs,
        ...(credentials ? { credentials } : {}),
        commands,
        ...(sourceSnapshot ? { sourceSnapshot } : {}),
      });
      if (result.status === "skipped") {
        await this.#recordReleaseActivationActivity({
          applyRun: input.applyRun,
          installation: input.installation,
          deployment,
          status: "failed",
          kind: result.kind,
          message:
            result.message ??
            "release activator skipped declared pre-destroy commands",
          commandCount: commands.length,
          outputCount: Object.keys(nonSensitiveOutputs).length,
        });
        return;
      }
      await this.#recordReleaseActivationActivity({
        applyRun: input.applyRun,
        installation: input.installation,
        deployment,
        status: result.status,
        kind: result.kind,
        message: result.message,
        hasLaunchUrl: Boolean(result.launchUrl),
        hasHealthUrl: Boolean(result.healthUrl),
        metadataKeys: Object.keys(result.metadata ?? {}).sort(),
        commandCount: commands.length,
        outputCount: Object.keys(nonSensitiveOutputs).length,
      });
    } catch (error) {
      await this.#recordReleaseActivationActivity({
        applyRun: input.applyRun,
        installation: input.installation,
        deployment,
        status: "failed",
        message: errorMessage(error),
        commandCount: commands.length,
        outputCount: Object.keys(nonSensitiveOutputs).length,
      });
      return;
    }
  }

  async #releaseCredentialsForCommands(input: {
    readonly planRun: PlanRun;
    readonly applyRun: ApplyRun;
    readonly commands: readonly ReleaseActivationCommand[];
    readonly phase: "apply" | "destroy";
  }): Promise<RunCredentials | undefined> {
    if (input.commands.length === 0) return undefined;
    return (
      await this.#runEnv.resolveRunEnvironment({
        planRun: input.planRun,
        phase: input.phase,
        auditRunId: releaseCommandRunId(input.applyRun.id),
        credentialContext: "release_command",
      })
    ).credentials;
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
    readonly commandCount?: number;
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
      spaceId: completed.workspaceId,
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
      capsule: input.patched ?? installation,
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
      await this.#activateReleaseBeforeDestroy({
        planRun,
        applyRun: running,
        installation,
      });
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
        spaceId: completed.workspaceId,
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
      await this.#releasePublicHostsForInstallation(installation.id, now);
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
        capsule: publicInstallation(patched ?? installation),
        installation: publicInstallation(patched ?? installation),
      };
    } catch (error) {
      if (error instanceof InstallationPatchGuardConflict) {
        await this.#billing.releaseApplyBillingReservation(planRun);
        throw new OpenTofuControllerError("failed_precondition", error.message);
      }
      if (runnerDispatched && isRetryableRunnerInfrastructureError(error)) {
        const runningWithEnvironmentFailure = runEnvironmentFailedRun(
          running,
          error,
        );
        if (
          runnerInfrastructureRetryCount(runningWithEnvironmentFailure, [
            "destroy.retry_scheduled",
          ]) >= RUNNER_INFRASTRUCTURE_RETRY_LIMIT
        ) {
          await this.#billing.releaseApplyBillingReservation(planRun);
          const failed = await this.#failApplyRun(
            runningWithEnvironmentFailure,
            leaseToken,
            profile,
            startedAt,
            "destroy.failed",
            runnerInfrastructureRetryExhaustedError("destroy_apply"),
          );
          if (failed.finishedAt !== undefined) {
            await this.#recordRunnerMinuteUsage({
              spaceId: failed.workspaceId,
              runId: failed.id,
              installationId: failed.installationId,
              startedAt,
              finishedAt: failed.finishedAt,
            });
          }
          return {
            applyRun: failed,
            capsule: publicInstallation(installation),
            installation: publicInstallation(installation),
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
          );
          if (queued.updatedAt !== undefined) {
            await this.#recordRunnerMinuteUsage({
              spaceId: queued.workspaceId,
              runId: queued.id,
              installationId: queued.installationId,
              startedAt,
              finishedAt: queued.updatedAt,
            });
          }
          throw retryError;
        }
      }
      await this.#billing.releaseApplyBillingReservation(planRun);
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
          spaceId: failed.workspaceId,
          runId: failed.id,
          installationId: failed.installationId,
          startedAt,
          finishedAt: failed.finishedAt,
        });
      }
      return {
        applyRun: failed,
        capsule: publicInstallation(installation),
        installation: publicInstallation(installation),
      };
    }
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

  /**
   * Auto-selects the runner profile for a plan whose caller did not pin one.
   * Used only when `request.runnerProfileId` is absent, so an explicit choice is
   * always respected.
   *
   * Candidates are the operator-curated enabled profiles only
   * ({@link #runnerProfilesById}); auto-selection therefore never admits a
   * provider the operator did not already enable a surface for — it just removes
   * the "which runner profile?" step so a user's own-key connection to an
   * arbitrary OpenTofu provider runs by default. Preference order:
   *   1. keep the current (default) profile if it already admits every provider;
   *   2. a specific (non-wildcard) enabled profile that admits every provider;
   *   3. an enabled wildcard (`["*"]`) surface (the generic-provider profile)
   *      that also admits every provider (its deny-list, if any, does not deny
   *      them);
   *   4. otherwise keep the current profile so policy blocks the run exactly as
   *      before (the operator enabled no surface for these providers).
   * Every candidate is admission-tested with {@link profileAdmitsAllProviders},
   * which mirrors the §25 provider allow/deny evaluation, so a selected profile
   * passes the provider-allowlist policy layer for these providers (given the
   * operator-enabled profile set injected into {@link #runnerProfilesById}).
   */
  #selectRunnerProfileForProviders(
    currentProfile: RunnerProfile,
    declaredProviders: readonly string[],
  ): RunnerProfile {
    if (declaredProviders.length === 0) return currentProfile;
    if (profileAdmitsAllProviders(currentProfile, declaredProviders)) {
      return currentProfile;
    }
    const candidates = [...this.#runnerProfilesById.values()];
    const specific = candidates.find(
      (candidate) =>
        !candidate.allowedProviders.includes("*") &&
        profileAdmitsAllProviders(candidate, declaredProviders),
    );
    if (specific) return specific;
    const wildcard = candidates.find(
      (candidate) =>
        candidate.allowedProviders.includes("*") &&
        profileAdmitsAllProviders(candidate, declaredProviders),
    );
    return wildcard ?? currentProfile;
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
}

function isGeneratedRootSourceSnapshot(snapshot: SourceSnapshot): boolean {
  return snapshot.url.startsWith("takosumi://generated-root/");
}

/**
 * True when `profile` admits every provider in `providers`. Mirrors the §25
 * provider allow/deny evaluation: a provider must be matched by an allow rule
 * (`"*"` wildcard or hierarchical {@link providerMatches}) AND not matched by any
 * deny rule (a denial overrides an allow). Keeping this aligned with
 * {@link evaluateProviderAllowlist} means an auto-selected profile passes the
 * provider-allowlist policy layer for the same providers.
 */
function profileAdmitsAllProviders(
  profile: RunnerProfile,
  providers: readonly string[],
): boolean {
  const denied = profile.deniedProviders ?? [];
  return providers.every(
    (provider) =>
      !denied.some((rule) => providerMatches(provider, rule)) &&
      profile.allowedProviders.some(
        (allowed) => allowed === "*" || providerMatches(provider, allowed),
      ),
  );
}
