/**
 * Manifestless Installer domain.
 *
 * The v1 public installer surface accepts Source descriptors, derives generic
 * repository metadata, resolves requested PlatformService bindings through an
 * operator catalog, and records Installation / Deployment ledger entries.
 */

import type { JsonValue } from "takosumi-contract";
import type {
  BindingSelection,
  ChangeEntry,
  Deployment,
  DeploymentApplyRequest,
  DeploymentApplyResponse,
  DeploymentDryRunRequest,
  DeploymentDryRunResponse,
  DeploymentOutputMaterial,
  DeploymentOutputs,
  Installation,
  InstallationApplyRequest,
  InstallationApplyResponse,
  InstallationDryRunRequest,
  InstallationDryRunResponse,
  InstallPlan,
  InstallerErrorCode,
  PlatformService,
  RepoMetadata,
  ResolvedBinding,
  RollbackRequest,
  RollbackResponse,
  Source,
  SourcePin,
  SourceSummary,
} from "takosumi-contract/installer-api";
import type { TakosumiPlugin } from "takosumi-contract/reference/plugin";
import type {
  GitRunner,
  TarRunner,
} from "takosumi-contract/reference/runtime-capability";
import { fetchGitSource, fetchPreparedSource } from "takosumi-installer";
import { currentRuntime } from "../../shared/runtime/index.ts";
import {
  type DeploymentStore,
  InMemoryDeploymentStore,
  InMemoryInstallationStore,
  InstallationPatchGuardConflict,
  type InstallationStore,
} from "./store.ts";

export type InstallerPipelineErrorCode = InstallerErrorCode;

export class InstallerPipelineError extends Error {
  readonly code: InstallerPipelineErrorCode;
  constructor(code: InstallerPipelineErrorCode, message: string) {
    super(message);
    this.name = "InstallerPipelineError";
    this.code = code;
  }
}

export interface ProviderApplyContext {
  readonly installation: Installation;
  readonly source: SourceSummary;
  readonly sourceDirectory: string;
  readonly plan: InstallPlan;
}

export interface ProviderApplyResult {
  readonly outputs?: DeploymentOutputs;
  readonly artifactDigest?: string;
}

/**
 * Optional operator-owned apply boundary. It is intentionally source/plan
 * shaped, not component/kind shaped.
 */
export interface InstallerProviderRegistry {
  apply?(context: ProviderApplyContext): Promise<ProviderApplyResult>;
}

export interface PlatformServiceResolveContext {
  readonly spaceId: string;
  readonly installationId?: string;
  readonly appId?: string;
  readonly source: SourceSummary;
  readonly repo: RepoMetadata;
  readonly selectedProfile?: string;
  readonly binding: BindingSelection;
}

export interface PlatformServiceResolver {
  resolve(
    context: PlatformServiceResolveContext,
  ):
    | Promise<PlatformService | readonly PlatformService[] | undefined>
    | PlatformService
    | readonly PlatformService[]
    | undefined;
}

export interface HttpPlatformServiceResolverOptions {
  readonly url: string;
  readonly token?: string;
  readonly fetch?: typeof fetch;
}

export function httpPlatformServiceResolver(
  options: HttpPlatformServiceResolverOptions,
): PlatformServiceResolver {
  return {
    async resolve(context) {
      const requestFetch = options.fetch ?? fetch;
      const response = await requestFetch(options.url, {
        method: "POST",
        headers: {
          "accept": "application/json",
          "content-type": "application/json",
          ...(options.token
            ? { authorization: `Bearer ${options.token}` }
            : {}),
        },
        body: JSON.stringify(context),
      });
      if (response.status === 204 || response.status === 404) {
        return undefined;
      }
      const text = await response.text();
      let payload: unknown = text;
      if (text.length > 0) {
        try {
          payload = JSON.parse(text);
        } catch {
          // Keep raw text for the validation error below.
        }
      }
      if (response.status < 200 || response.status >= 300) {
        throw new InstallerPipelineError(
          "failed_precondition",
          `platform service resolver returned HTTP ${response.status}`,
        );
      }
      return parsePlatformServiceResolverPayload(payload);
    },
  };
}

export interface InstallationStatus {
  readonly installation: Installation;
  readonly currentDeployment?: Deployment;
  readonly deployments: readonly Deployment[];
}

export interface InstallerPipelineDependencies {
  readonly installations?: InstallationStore;
  readonly deployments?: DeploymentStore;
  readonly providers?: InstallerProviderRegistry;
  /**
   * Accepted for host compatibility. Manifestless v1 does not interpret
   * component kinds in space; operator distributions may use these values inside
   * their own provider implementation.
   */
  readonly plugins?: readonly TakosumiPlugin[];
  readonly platformServices?: PlatformServiceResolver;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => number;
  readonly localSourceRoot?: string;
  readonly gitRunner?: GitRunner;
  readonly tarRunner?: TarRunner;
}

export class InstallerPipeline {
  readonly #installations: InstallationStore;
  readonly #deployments: DeploymentStore;
  readonly #providers?: InstallerProviderRegistry;
  readonly #platformServices?: PlatformServiceResolver;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #localSourceRoot?: string;
  readonly #gitRunner?: GitRunner;
  readonly #tarRunner?: TarRunner;
  readonly #mutationChains = new Map<string, Promise<void>>();

  constructor(dependencies: InstallerPipelineDependencies = {}) {
    this.#installations = dependencies.installations ??
      new InMemoryInstallationStore();
    this.#deployments = dependencies.deployments ??
      new InMemoryDeploymentStore();
    this.#providers = dependencies.providers;
    this.#platformServices = dependencies.platformServices;
    this.#newId = dependencies.newId ?? newId;
    this.#now = dependencies.now ?? (() => Date.now());
    this.#localSourceRoot = dependencies.localSourceRoot;
    this.#gitRunner = dependencies.gitRunner;
    this.#tarRunner = dependencies.tarRunner;
    void dependencies.plugins;
  }

  async installationDryRun(
    request: InstallationDryRunRequest,
  ): Promise<InstallationDryRunResponse> {
    requireNonEmptyString(request.spaceId, "spaceId");
    const fetched = await this.#fetchSource(request.source);
    try {
      return await this.#dryRun({
        spaceId: request.spaceId,
        source: request.source,
        fetched,
        profile: request.profile,
        bindings: request.bindings,
      });
    } finally {
      await fetched.cleanup();
    }
  }

  async installationApply(
    request: InstallationApplyRequest,
  ): Promise<InstallationApplyResponse> {
    requireNonEmptyString(request.spaceId, "spaceId");
    const fetched = await this.#fetchSource(request.source);
    let installation: Installation;
    let deployment!: Deployment;
    try {
      const dryRun = await this.#dryRun({
        spaceId: request.spaceId,
        source: request.source,
        fetched,
        profile: request.profile,
        bindings: request.bindings,
      });
      checkExpectedPin(request.expected, dryRun.source, dryRun.expected);
      const now = this.#now();
      installation = {
        id: this.#newId("ins"),
        spaceId: request.spaceId,
        appId: dryRun.installPlan.repo.id,
        currentDeploymentId: null,
        status: "installing",
        createdAt: now,
      };
      await this.#installations.put(installation);
      deployment = await this.#recordDeployment({
        installation,
        sourceDirectory: fetched.workingDirectory,
        plan: dryRun.installPlan,
        planSnapshotDigest: dryRun.planSnapshotDigest,
        source: dryRun.source,
      });
      const patched = await this.#installations.patch(installation.id, {
        currentDeploymentId: deployment.id,
        status: deployment.status === "succeeded" ? "ready" : "failed",
      });
      installation = patched ?? installation;
    } catch (error) {
      throw error;
    } finally {
      await fetched.cleanup();
    }
    return { installation, deployment };
  }

  async deploymentDryRun(
    installationId: string,
    request: DeploymentDryRunRequest,
  ): Promise<DeploymentDryRunResponse> {
    const installation = await this.#requireInstallation(installationId);
    const source = request.source ??
      await this.#sourceFromInstallation(installation);
    const fetched = await this.#fetchSource(source);
    try {
      const dryRun = await this.#dryRun({
        spaceId: installation.spaceId,
        installationId: installation.id,
        appId: installation.appId,
        source,
        fetched,
        profile: request.profile,
        bindings: request.bindings,
      });
      return {
        ...dryRun,
        expected: {
          ...dryRun.expected,
          currentDeploymentId: installation.currentDeploymentId,
        },
      };
    } finally {
      await fetched.cleanup();
    }
  }

  deploymentApply(
    installationId: string,
    request: DeploymentApplyRequest,
  ): Promise<DeploymentApplyResponse> {
    return this.#runSerialized(
      installationId,
      () => this.#deploymentApplyImpl(installationId, request),
    );
  }

  async #deploymentApplyImpl(
    installationId: string,
    request: DeploymentApplyRequest,
  ): Promise<DeploymentApplyResponse> {
    const installation = await this.#requireInstallation(installationId);
    checkExpectedCurrentDeploymentId(request.expected, installation);
    const source = request.source ??
      await this.#sourceFromInstallation(installation);
    const fetched = await this.#fetchSource(source);
    try {
      const dryRun = await this.#dryRun({
        spaceId: installation.spaceId,
        installationId: installation.id,
        appId: installation.appId,
        source,
        fetched,
        profile: request.profile,
        bindings: request.bindings,
      });
      checkExpectedPin(request.expected, dryRun.source, dryRun.expected);
      const deployment = await this.#recordDeployment({
        installation,
        sourceDirectory: fetched.workingDirectory,
        plan: dryRun.installPlan,
        planSnapshotDigest: dryRun.planSnapshotDigest,
        source: dryRun.source,
      });
      const guard = request.expected !== undefined
        ? { currentDeploymentId: installation.currentDeploymentId }
        : undefined;
      try {
        await this.#installations.patch(installation.id, {
          currentDeploymentId: deployment.id,
          status: deployment.status === "succeeded" ? "ready" : "failed",
        }, guard);
      } catch (error) {
        if (error instanceof InstallationPatchGuardConflict) {
          throw new InstallerPipelineError(
            "failed_precondition",
            error.message,
          );
        }
        throw error;
      }
      return { deployment };
    } finally {
      await fetched.cleanup();
    }
  }

  async rollback(
    installationId: string,
    request: RollbackRequest,
  ): Promise<RollbackResponse> {
    const installation = await this.#requireInstallation(installationId);
    requireNonEmptyString(request.deploymentId, "deploymentId");
    const target = await this.#deployments.get(request.deploymentId);
    if (!target || target.installationId !== installation.id) {
      throw new InstallerPipelineError(
        "not_found",
        `deployment ${request.deploymentId} not found for installation ${installationId}`,
      );
    }
    const previous = installation.currentDeploymentId;
    const patched = await this.#installations.patch(installation.id, {
      currentDeploymentId: target.id,
      status: target.status === "succeeded" ? "ready" : "failed",
    });
    if (this.#deployments.recordRollback) {
      await this.#deployments.recordRollback({
        installationId,
        rolledBackFrom: previous,
        rolledBackTo: target.id,
        createdAt: this.#now(),
      });
    }
    return {
      installation: patched ?? { ...installation, currentDeploymentId: target.id },
      deployment: target,
      rollback: {
        rolledBackFrom: previous,
        rolledBackTo: target.id,
        scope: {
          pointer: "reverted",
          resourceMaterialization: "not-reapplied",
          workloadState: "not-reverted",
        },
      },
    };
  }

  async status(installationId: string): Promise<InstallationStatus> {
    const installation = await this.#requireInstallation(installationId);
    const deployments = await this.#deployments.listForInstallation(
      installation.id,
    );
    const currentDeployment = installation.currentDeploymentId
      ? await this.#deployments.get(installation.currentDeploymentId)
      : undefined;
    return {
      installation,
      ...(currentDeployment ? { currentDeployment } : {}),
      deployments,
    };
  }

  listInstallations(spaceId?: string): Promise<readonly Installation[]> {
    return this.#installations.list(spaceId);
  }

  async #dryRun(input: {
    readonly spaceId: string;
    readonly installationId?: string;
    readonly appId?: string;
    readonly source: Source;
    readonly fetched: FetchedSource;
    readonly profile?: string;
    readonly bindings?: readonly BindingSelection[];
  }): Promise<InstallationDryRunResponse> {
    const source = summarizeSource(input.source, input.fetched);
    const repo = await inspectRepoMetadata(input.fetched.workingDirectory, source);
    const requestedBindings = normalizeBindingSelections(input.bindings ?? []);
    const resolvedBindings = await this.#resolveBindings({
      spaceId: input.spaceId,
      installationId: input.installationId,
      appId: input.appId ?? repo.id,
      source,
      repo,
      selectedProfile: input.profile,
      bindings: requestedBindings,
    });
    const changes = computeChangeSet(source, resolvedBindings);
    const installPlan: InstallPlan = {
      source,
      repo,
      ...(input.profile ? { selectedProfile: input.profile } : {}),
      requestedBindings,
      resolvedBindings,
      publications: [],
      changes,
      warnings: [],
    };
    const planSnapshotDigest = await digestJson(installPlan);
    return {
      source,
      installPlan,
      planSnapshotDigest,
      changes,
      expected: sourcePinFromSummary(source, planSnapshotDigest),
    };
  }

  async #resolveBindings(input: {
    readonly spaceId: string;
    readonly installationId?: string;
    readonly appId?: string;
    readonly source: SourceSummary;
    readonly repo: RepoMetadata;
    readonly selectedProfile?: string;
    readonly bindings: readonly BindingSelection[];
  }): Promise<readonly ResolvedBinding[]> {
    const resolved: ResolvedBinding[] = [];
    for (const binding of input.bindings) {
      if (!this.#platformServices) {
        if (binding.required) {
          throw new InstallerPipelineError(
            "failed_precondition",
            `required binding ${binding.name} cannot resolve without an operator catalog`,
          );
        }
        resolved.push({ name: binding.name, selection: binding, services: [] });
        continue;
      }
      const value = await this.#platformServices.resolve({
        spaceId: input.spaceId,
        installationId: input.installationId,
        appId: input.appId,
        source: input.source,
        repo: input.repo,
        selectedProfile: input.selectedProfile,
        binding,
      });
      const services = normalizeResolvedServices(value);
      if (services.length === 0 && binding.required) {
        throw new InstallerPipelineError(
          "failed_precondition",
          `required binding ${binding.name} was not found in the operator catalog`,
        );
      }
      if (services.length > 1 && binding.many !== true) {
        throw new InstallerPipelineError(
          "failed_precondition",
          `binding ${binding.name} matched ${services.length} platform services; set many: true or narrow the selector`,
        );
      }
      resolved.push({ name: binding.name, selection: binding, services });
    }
    return resolved;
  }

  async #recordDeployment(input: {
    readonly installation: Installation;
    readonly sourceDirectory: string;
    readonly plan: InstallPlan;
    readonly planSnapshotDigest: string;
    readonly source: SourceSummary;
  }): Promise<Deployment> {
    const providerResult = await this.#providers?.apply?.({
      installation: input.installation,
      source: input.source,
      sourceDirectory: input.sourceDirectory,
      plan: input.plan,
    });
    const deployment: Deployment = {
      id: this.#newId("dep"),
      installationId: input.installation.id,
      source: input.source,
      ...(input.source.sourceDigest
        ? { sourceDigest: input.source.sourceDigest }
        : {}),
      ...(providerResult?.artifactDigest
        ? { artifactDigest: providerResult.artifactDigest }
        : {}),
      planSnapshotDigest: input.planSnapshotDigest,
      planSnapshot: input.plan,
      bindingsSnapshot: input.plan.resolvedBindings,
      status: "succeeded",
      outputs: providerResult?.outputs ?? outputsFromPlan(input.plan),
      createdAt: this.#now(),
    };
    await this.#deployments.put(deployment);
    return deployment;
  }

  async #requireInstallation(id: string): Promise<Installation> {
    const installation = await this.#installations.get(id);
    if (!installation) {
      throw new InstallerPipelineError(
        "not_found",
        `installation ${id} not found`,
      );
    }
    return installation;
  }

  async #sourceFromInstallation(installation: Installation): Promise<Source> {
    if (installation.currentDeploymentId) {
      const current = await this.#deployments.get(
        installation.currentDeploymentId,
      );
      if (current) {
        if (current.source.kind === "local") {
          throw new InstallerPipelineError(
            "failed_precondition",
            "current deployment uses local source; supply source explicitly",
          );
        }
        return sourceFromSummary(current.source);
      }
    }
    throw new InstallerPipelineError(
      "failed_precondition",
      "installation has no current deployment; supply a source explicitly",
    );
  }

  async #fetchSource(source: Source): Promise<FetchedSource> {
    validateSourceDescriptor(source);
    if (source.kind === "local") {
      const requested = source.url;
      const jailRoot = this.#localSourceRoot;
      if (jailRoot !== undefined) {
        const workingDirectory = requested === undefined
          ? resolvePosixPath(jailRoot)
          : resolveLocalSourceUnderJail(jailRoot, requested);
        return { workingDirectory, cleanup: () => Promise.resolve() };
      }
      if (!requested) {
        throw new InstallerPipelineError(
          "invalid_argument",
          "local source requires source.url or a configured localSourceRoot",
        );
      }
      return { workingDirectory: requested, cleanup: () => Promise.resolve() };
    }
    if (source.kind === "git") {
      if (!source.url) {
        throw new InstallerPipelineError(
          "invalid_argument",
          "git source requires source.url",
        );
      }
      try {
        const result = await fetchGitSource({
          url: source.url,
          ref: source.ref,
          fs: currentRuntime().fs,
          ...(this.#gitRunner ? { gitRunner: this.#gitRunner } : {}),
        });
        return {
          workingDirectory: result.workingDirectory,
          commit: result.commit,
          cleanup: result.cleanup,
        };
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new InstallerPipelineError(
          classifySourceFetchError(cause),
          `failed to fetch git source: ${cause}`,
        );
      }
    }
    if (source.kind === "prepared") {
      if (!source.url) {
        throw new InstallerPipelineError(
          "invalid_argument",
          "prepared source requires source.url",
        );
      }
      if (!source.digest) {
        throw new InstallerPipelineError(
          "invalid_argument",
          "prepared source requires source.digest",
        );
      }
      try {
        const result = await fetchPreparedSource({
          url: source.url,
          digest: source.digest,
          fs: currentRuntime().fs,
          ...(this.#tarRunner ? { tarRunner: this.#tarRunner } : {}),
        });
        return {
          workingDirectory: result.workingDirectory,
          sourceDigest: result.digest,
          cleanup: result.cleanup,
        };
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new InstallerPipelineError(
          classifySourceFetchError(cause),
          `failed to fetch prepared source: ${cause}`,
        );
      }
    }
    throw new InstallerPipelineError(
      "not_implemented",
      "source.kind is not yet supported",
    );
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
    this.#mutationChains.set(key, previous.then(() => next, () => next));
    return previous
      .catch(() => {})
      .then(work)
      .finally(() => {
        release();
        if (this.#mutationChains.get(key) === next) {
          this.#mutationChains.delete(key);
        }
      });
  }
}

export function installerProviderRegistryFromPlugins(
  _plugins: readonly TakosumiPlugin[],
): InstallerProviderRegistry {
  return {};
}

interface FetchedSource {
  readonly workingDirectory: string;
  readonly commit?: string;
  readonly sourceDigest?: string;
  readonly cleanup: () => Promise<void>;
}

interface PackageJson {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly description?: unknown;
  readonly homepage?: unknown;
  readonly repository?: unknown;
}

async function inspectRepoMetadata(
  workingDirectory: string,
  source: SourceSummary,
): Promise<RepoMetadata> {
  const packageJson = await readPackageJson(workingDirectory);
  const name = stringValue(packageJson?.name) ?? repoNameFromSource(source);
  const repositoryUrl = repositoryUrlFromPackage(packageJson?.repository) ??
    (source.kind === "git" ? source.url : undefined);
  return {
    id: repoIdFromParts(repositoryUrl ?? source.url ?? name, name),
    name,
    ...(stringValue(packageJson?.version)
      ? { version: stringValue(packageJson?.version) }
      : {}),
    ...(stringValue(packageJson?.description)
      ? { description: stringValue(packageJson?.description) }
      : {}),
    ...(stringValue(packageJson?.homepage)
      ? { homepage: stringValue(packageJson?.homepage) }
      : {}),
    ...(repositoryUrl ? { repositoryUrl } : {}),
  };
}

async function readPackageJson(
  workingDirectory: string,
): Promise<PackageJson | undefined> {
  try {
    const text = await currentRuntime().fs.readTextFile(
      `${workingDirectory.replace(/\/+$/, "")}/package.json`,
    );
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function repositoryUrlFromPackage(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (isRecord(value) && typeof value.url === "string" && value.url.length > 0) {
    return value.url;
  }
  return undefined;
}

function repoNameFromSource(source: SourceSummary): string {
  const raw = source.url ?? source.ref ?? source.kind;
  const withoutQuery = raw.split(/[?#]/)[0] ?? raw;
  const parts = withoutQuery.split(/[/:]/).filter((part) => part.length > 0);
  const last = parts[parts.length - 1] ?? source.kind;
  return last.replace(/\.git$/, "") || source.kind;
}

function repoIdFromParts(seed: string, name: string): string {
  const sanitized = `${seed}:${name}`
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "source";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeBindingSelections(
  bindings: readonly BindingSelection[],
): readonly BindingSelection[] {
  return bindings.map((binding, index) => {
    requireNonEmptyString(binding.name, `bindings[${index}].name`);
    const normalized: BindingSelection = {
      name: binding.name,
      ...(binding.servicePath ? { servicePath: binding.servicePath } : {}),
      ...(binding.serviceKind ? { serviceKind: binding.serviceKind } : {}),
      ...(binding.labels ? { labels: { ...binding.labels } } : {}),
      ...(binding.many !== undefined ? { many: binding.many } : {}),
      ...(binding.required !== undefined ? { required: binding.required } : {}),
      ...(binding.inject !== undefined ? { inject: binding.inject } : {}),
    };
    if (!normalized.servicePath && !normalized.serviceKind) {
      throw new InstallerPipelineError(
        "invalid_argument",
        `bindings[${index}] must include servicePath or serviceKind`,
      );
    }
    return normalized;
  });
}

function normalizeResolvedServices(
  value: PlatformService | readonly PlatformService[] | undefined,
): readonly PlatformService[] {
  if (value === undefined) return [];
  const services = Array.isArray(value) ? value : [value];
  return services.map(validatePlatformService);
}

function validatePlatformService(value: PlatformService): PlatformService {
  if (!isRecord(value)) {
    throw new InstallerPipelineError(
      "failed_precondition",
      "operator catalog returned a non-object platform service",
    );
  }
  if (typeof value.kind !== "string" || value.kind.length === 0) {
    throw new InstallerPipelineError(
      "failed_precondition",
      "operator catalog platform service must include kind",
    );
  }
  return value;
}

function parsePlatformServiceResolverPayload(
  payload: unknown,
): PlatformService | readonly PlatformService[] | undefined {
  if (payload === undefined || payload === null) return undefined;
  if (isRecord(payload) && Array.isArray(payload.services)) {
    return normalizeResolvedServices(payload.services as PlatformService[]);
  }
  if (isRecord(payload) && isRecord(payload.service)) {
    return validatePlatformService(payload.service as unknown as PlatformService);
  }
  if (Array.isArray(payload)) {
    return normalizeResolvedServices(payload as PlatformService[]);
  }
  if (isRecord(payload)) {
    return validatePlatformService(payload as unknown as PlatformService);
  }
  throw new InstallerPipelineError(
    "failed_precondition",
    "operator catalog response must be a platform service object or services array",
  );
}

function computeChangeSet(
  source: SourceSummary,
  bindings: readonly ResolvedBinding[],
): readonly ChangeEntry[] {
  return [
    {
      op: "create",
      subject: source.url ?? source.commit ?? source.kind,
      kind: "deployment",
      reason: "source apply",
    },
    ...bindings.map((binding): ChangeEntry => ({
      op: binding.services.length === 0 ? "noop" : "create",
      subject: binding.name,
      kind: "binding",
      reason: binding.services.length === 0
        ? "no matching platform service"
        : "operator catalog binding",
    })),
  ];
}

function outputsFromPlan(plan: InstallPlan): DeploymentOutputs {
  const publicOutputs: Record<string, DeploymentOutputMaterial> = {};
  for (const binding of plan.resolvedBindings) {
    for (const service of binding.services) {
      if (service.material) {
        publicOutputs[binding.name] = service.material;
        break;
      }
    }
  }
  return {
    ...(Object.keys(publicOutputs).length > 0 ? { public: publicOutputs } : {}),
    extensions: {
      resolvedBindings: plan.resolvedBindings as unknown as JsonValue,
    },
  };
}

function summarizeSource(
  source: Source,
  fetched: FetchedSource,
): SourceSummary {
  return {
    kind: source.kind,
    url: stripUrlCredentials(source.url),
    ref: source.ref,
    commit: fetched.commit,
    digest: source.digest,
    sourceDigest: fetched.sourceDigest ?? source.digest,
  };
}

function stripUrlCredentials(value: string | undefined): string | undefined {
  if (value === undefined) return value;
  try {
    const parsed = new URL(value);
    if (parsed.username === "" && parsed.password === "") return value;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return value;
  }
}

function sourceFromSummary(summary: SourceSummary): Source {
  if (summary.kind === "git") {
    requireNonEmptyString(summary.url, "source.url");
    requireNonEmptyString(summary.commit, "source.commit");
    return { kind: "git", url: summary.url, ref: summary.commit };
  }
  if (summary.kind === "prepared") {
    requireNonEmptyString(summary.url, "source.url");
    requireNonEmptyString(summary.sourceDigest, "source.sourceDigest");
    return {
      kind: "prepared",
      url: summary.url,
      digest: summary.sourceDigest,
    };
  }
  requireNonEmptyString(summary.url, "source.url");
  return { kind: "local", url: summary.url };
}

function sourcePinFromSummary(
  summary: SourceSummary,
  planSnapshotDigest: string,
): SourcePin {
  if (summary.kind === "git") {
    requireNonEmptyString(summary.commit, "source.commit");
    return {
      commit: summary.commit,
      planSnapshotDigest,
      ...(summary.sourceDigest ? { sourceDigest: summary.sourceDigest } : {}),
    };
  }
  if (summary.kind === "prepared") {
    requireNonEmptyString(summary.sourceDigest, "source.sourceDigest");
    return { sourceDigest: summary.sourceDigest, planSnapshotDigest };
  }
  return { planSnapshotDigest };
}

function checkExpectedPin(
  expected: SourcePin | undefined,
  source: SourceSummary,
  actual: SourcePin,
): void {
  if (!expected) return;
  validateExpectedPinShape(expected, source.kind);
  if (expected.planSnapshotDigest !== actual.planSnapshotDigest) {
    throw new InstallerPipelineError(
      "failed_precondition",
      `expected planSnapshotDigest ${expected.planSnapshotDigest} but source resolved to ${actual.planSnapshotDigest}`,
    );
  }
  if (expected.commit && actual.commit && expected.commit !== actual.commit) {
    throw new InstallerPipelineError(
      "failed_precondition",
      `expected commit ${expected.commit} but source resolved to ${actual.commit}`,
    );
  }
  if (
    expected.sourceDigest &&
    actual.sourceDigest &&
    expected.sourceDigest !== actual.sourceDigest
  ) {
    throw new InstallerPipelineError(
      "failed_precondition",
      `expected sourceDigest ${expected.sourceDigest} but source resolved to ${actual.sourceDigest}`,
    );
  }
}

function checkExpectedCurrentDeploymentId(
  expected: DeploymentApplyRequest["expected"],
  installation: Installation,
): void {
  if (!expected) return;
  if (!("currentDeploymentId" in expected)) {
    throw new InstallerPipelineError(
      "invalid_argument",
      "deploy expected guard must include expected.currentDeploymentId",
    );
  }
  if (expected.currentDeploymentId !== installation.currentDeploymentId) {
    throw new InstallerPipelineError(
      "failed_precondition",
      `expected currentDeploymentId ${
        expected.currentDeploymentId ?? "<none>"
      } but Installation current pointer is ${
        installation.currentDeploymentId ?? "<none>"
      }`,
    );
  }
}

function validateExpectedPinShape(
  expected: SourcePin,
  sourceKind: SourceSummary["kind"],
): void {
  if (typeof expected.planSnapshotDigest !== "string") {
    throw new InstallerPipelineError(
      "invalid_argument",
      "expected guard must include expected.planSnapshotDigest",
    );
  }
  if (sourceKind === "git") {
    if (expected.commit === undefined) {
      throw new InstallerPipelineError(
        "invalid_argument",
        "git source expected guard must include expected.commit",
      );
    }
    return;
  }
  if (sourceKind === "prepared") {
    if (expected.sourceDigest === undefined || expected.commit !== undefined) {
      throw new InstallerPipelineError(
        "invalid_argument",
        "prepared source expected guard must include expected.sourceDigest and must not include expected.commit",
      );
    }
    return;
  }
  if (expected.commit !== undefined || expected.sourceDigest !== undefined) {
    throw new InstallerPipelineError(
      "invalid_argument",
      "local source expected guard must include only expected.planSnapshotDigest",
    );
  }
}

function validateSourceDescriptor(source: Source): void {
  const raw = source as unknown as Record<string, unknown>;
  if (!isRecord(raw)) {
    throw new InstallerPipelineError("invalid_argument", "source must be an object");
  }
  if (
    source.kind !== "git" &&
    source.kind !== "prepared" &&
    source.kind !== "local"
  ) {
    throw new InstallerPipelineError(
      "invalid_argument",
      "source.kind must be one of git, prepared, or local",
    );
  }
  rejectUnknownSourceFields(raw, allowedSourceKeys(source.kind));
  requireNonEmptyString(source.url, "source.url");
  if (source.kind === "git") {
    requireNonEmptyString(source.ref, "source.ref");
    if (source.digest !== undefined || source.commit !== undefined) {
      throw new InstallerPipelineError(
        "invalid_argument",
        "git source must not include source.digest or source.commit",
      );
    }
    return;
  }
  if (source.commit !== undefined) {
    throw new InstallerPipelineError(
      "invalid_argument",
      `${source.kind} source must not include source.commit`,
    );
  }
  if (source.kind === "prepared") {
    requireNonEmptyString(source.digest, "source.digest");
    if (source.ref !== undefined) {
      throw new InstallerPipelineError(
        "invalid_argument",
        "prepared source must not include source.ref",
      );
    }
  }
  if (source.kind === "local") {
    if (source.ref !== undefined || source.digest !== undefined) {
      throw new InstallerPipelineError(
        "invalid_argument",
        "local source must not include source.ref or source.digest",
      );
    }
  }
}

function allowedSourceKeys(kind: Source["kind"]): readonly string[] {
  if (kind === "git") return ["kind", "url", "ref"];
  if (kind === "prepared") return ["kind", "url", "digest"];
  return ["kind", "url"];
}

function rejectUnknownSourceFields(
  source: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(source)) {
    if (allowedSet.has(key)) continue;
    throw new InstallerPipelineError(
      "invalid_argument",
      `source.${key} is not allowed for source.kind ${JSON.stringify(source.kind)}`,
    );
  }
}

function classifySourceFetchError(message: string): InstallerPipelineErrorCode {
  if (
    message.includes("archive_too_large") ||
    message.includes("payload too large") ||
    message.includes("exceeds")
  ) {
    return "resource_exhausted";
  }
  if (message.includes("digest mismatch")) return "failed_precondition";
  if (
    message.includes("unsupported_source_url") ||
    message.includes("scheme is not allowed") ||
    message.includes("must use https://") ||
    message.includes("must not start with '-'") ||
    message.includes("must not contain control characters") ||
    message.includes("has no host") ||
    message.includes("host is not allowed") ||
    message.includes("digest must use sha256") ||
    message.includes("requires a non-empty url") ||
    message.includes("malformed")
  ) {
    return "invalid_argument";
  }
  return "failed_precondition";
}

function requireNonEmptyString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InstallerPipelineError(
      "invalid_argument",
      `${field} must be a non-empty string`,
    );
  }
}

async function digestJson(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(stableJson(value)));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return `sha256:${
    Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  }`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  ).join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function resolveLocalSourceUnderJail(
  jailRoot: string,
  requested: string,
): string {
  const normalizedRoot = resolvePosixPath(jailRoot);
  const candidate = isAbsolutePosixPath(requested)
    ? resolvePosixPath(requested)
    : resolvePosixPath(joinPosixPath(normalizedRoot, requested));
  const relative = posixPathRelative(normalizedRoot, candidate);
  if (relative === ".." || relative.startsWith("../")) {
    throw new InstallerPipelineError(
      "invalid_argument",
      `local source ${
        JSON.stringify(requested)
      } resolves outside the configured localSourceRoot`,
    );
  }
  return candidate;
}

function isAbsolutePosixPath(value: string): boolean {
  return value.startsWith("/");
}

function joinPosixPath(left: string, right: string): string {
  if (right.length === 0) return left;
  if (left.endsWith("/")) return left + right;
  return `${left}/${right}`;
}

function resolvePosixPath(value: string): string {
  const segments = value.split("/");
  const stack: string[] = [];
  const absolute = isAbsolutePosixPath(value);
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!absolute) {
        stack.push("..");
      }
      continue;
    }
    stack.push(segment);
  }
  const joined = stack.join("/");
  if (absolute) return `/${joined}`;
  return joined.length === 0 ? "." : joined;
}

function posixPathRelative(from: string, to: string): string {
  const fromAbs = resolvePosixPath(from);
  const toAbs = resolvePosixPath(to);
  if (fromAbs === toAbs) return "";
  const fromSegments = fromAbs.split("/").filter((seg) => seg.length > 0);
  const toSegments = toAbs.split("/").filter((seg) => seg.length > 0);
  let i = 0;
  while (
    i < fromSegments.length && i < toSegments.length &&
    fromSegments[i] === toSegments[i]
  ) {
    i += 1;
  }
  const up = fromSegments.slice(i).map(() => "..");
  const down = toSegments.slice(i);
  const parts = [...up, ...down];
  return parts.length === 0 ? "" : parts.join("/");
}
