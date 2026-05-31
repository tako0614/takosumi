/**
 * Installer domain — orchestrates Installation lifecycle.
 *
 * Wave 5 implementation, Wave 9 KernelPlugin integration. The pipeline:
 *   1. fetches source (git / local working tree)
 *   2. parses `.takosumi.yml` via @takos/takosumi-installer
 *   3. validates AppSpec (delegated to yaml-parser)
 *   4. computes change set + source pin
 *   5. on apply:
 *        - fires `onInstallStart` / `onDeploymentStart` hooks
 *        - resolves each Component.kind to a `KernelPlugin` via the
 *          registry and invokes `plugin.apply()`
 *        - persists Installation + Deployment
 *        - fires `onDeploymentComplete` / `onInstallComplete` hooks
 *
 * Returns the response shapes from `takosumi-contract/installer-api`.
 *
 * Persistence is in-memory (see ./store.ts); a SQL-backed variant is a
 * follow-up wave.
 */

import type { JsonValue } from "takosumi-contract";
import type { KernelPlugin } from "takosumi-contract/reference/compat";
import type {
  GitRunner,
  TarRunner,
} from "takosumi-contract/reference/runtime-capability";
import type {
  AppSpec,
  BindingOptions,
  Component,
  ComponentOutputRef,
  ListenOptions,
  OutputSlotName,
  PublishOptions,
} from "takosumi-contract/app-spec";
import type {
  ChangeEntry,
  Deployment,
  DeploymentApplyRequest,
  DeploymentApplyResponse,
  DeploymentDryRunRequest,
  DeploymentDryRunResponse,
  DeploymentOutputs,
  Installation,
  InstallationApplyRequest,
  InstallationApplyResponse,
  InstallationDryRunRequest,
  InstallationDryRunResponse,
  RollbackRequest,
  RollbackResponse,
  Source,
  SourcePin,
  SourceSummary,
} from "takosumi-contract/installer-api";

import type { OutputMaterial } from "takosumi-contract/reference/plugin";
import {
  AppSpecParseError,
  fetchGitSource,
  fetchPreparedSource,
  parseAppSpec,
} from "takosumi-installer";
import {
  createKernelPluginRegistry,
  findPluginForKind,
  type KernelPluginRegistry,
  type KindAliasMap,
} from "../../plugins/mod.ts";
import { log } from "../../shared/log.ts";
import { currentRuntime } from "../../shared/runtime/index.ts";
import {
  assertListenMaterialKind,
  BindingResolutionError,
  BindingResolver,
  type ResolvedBinding,
} from "../binding/mod.ts";
import {
  type DeploymentStore,
  InMemoryDeploymentStore,
  InMemoryInstallationStore,
  InMemoryPublicationPathStore,
  InstallationPatchGuardConflict,
  type InstallationStore,
  type PublicationPathClaim,
  type PublicationPathStore,
} from "./store.ts";

/**
 * Apply context passed to {@link InstallerProviderRegistry.apply}. The
 * canonical adapter, {@link installerProviderRegistryFromPlugins}, derives
 * one of these from each `Component` and forwards it to the plugin
 * resolved via `provides[]`.
 *
 * The local material registry is populated at apply time;
 * `inputMaterials` carries the resolved upstream material payload for each
 * connect/listen binding the component consumes.
 */
export interface ProviderApplyContext {
  readonly installationId: string;
  readonly componentName: string;
  readonly component: Component;
  readonly source: SourceSummary;
  readonly sourceDirectory: string;
  /**
   * Materials this component consumes, keyed by the local binding name as
   * declared in `Component.connect` or `Component.listen`. Pre-resolved by
   * the installer from local component outputs or platform service paths; the
   * consumer's `applyBinding` (or the kernel
   * default) has already emitted env / mount / target descriptors before
   * the plugin's `apply` is called.
   */
  readonly inputMaterials?: Readonly<
    Record<string, OutputMaterial>
  >;
  /**
   * @deprecated Use `inputMaterials`.
   */
  readonly listenedMaterials: Readonly<
    Record<string, OutputMaterial>
  >;
  /**
   * Env / mount / target descriptors produced by input binding resolution for
   * each edge. Plugins may inspect these to apply runtime injection;
   * the descriptors are also persisted on the Deployment outputs.
   */
  readonly resolvedBindings: readonly ResolvedBinding[];
}

export interface ProviderApplyResult {
  readonly resource: ProviderResourceEvidence;
  /**
   * Outputs the plugin emits. Needed output slots are projected into material
   * by the component kind's materializer.
   */
  readonly outputs: Readonly<Record<string, JsonValue>>;
}

interface ProviderResourceEvidence {
  readonly component: string;
  readonly kind: string;
  readonly provider: string;
  readonly resourceHandle: string;
}

/**
 * Component-level apply boundary. Concrete implementations are derived
 * either from a `KernelPlugin[]` registry (production / standard path,
 * via {@link installerProviderRegistryFromPlugins}) or hand-rolled in
 * tests.
 */
export interface InstallerProviderRegistry {
  apply(context: ProviderApplyContext): Promise<ProviderApplyResult>;
}

export interface PlatformServiceResolveContext {
  readonly installationId: string;
  readonly spaceId: string;
  readonly appId: string;
  readonly componentName: string;
  readonly component: Component;
  readonly bindingName: string;
  readonly sourceRef?: string;
  readonly kind?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly many?: boolean;
}

export interface PlatformServiceResolver {
  resolve(
    context: PlatformServiceResolveContext,
  ):
    | Promise<OutputMaterial | readonly OutputMaterial[] | undefined>
    | OutputMaterial
    | readonly OutputMaterial[]
    | undefined;
}

export interface HttpPlatformServiceResolverOptions {
  readonly url: string;
  readonly token?: string;
  readonly fetch?: typeof fetch;
}

const PUBLISH_PATH_CLAIM_TTL_MS = 10 * 60 * 1000;

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
          // Keep the raw text for the error below.
        }
      }
      if (response.status < 200 || response.status >= 300) {
        throw new InstallerPipelineError(
          "failed_precondition",
          `platform service resolver returned HTTP ${response.status}`,
        );
      }
      const material = isRecord(payload) && isOutputMaterial(payload.material)
        ? payload.material
        : payload;
      const materials = isRecord(payload) && Array.isArray(payload.materials)
        ? payload.materials
        : undefined;
      if (materials !== undefined) {
        if (!materials.every(isOutputMaterial)) {
          throw new InstallerPipelineError(
            "failed_precondition",
            "platform service resolver response materials must be material objects",
          );
        }
        return materials;
      }
      if (!isOutputMaterial(material)) {
        throw new InstallerPipelineError(
          "failed_precondition",
          "platform service resolver response must be a material object",
        );
      }
      return material;
    },
  };
}

/**
 * Read-only status projection returned by {@link InstallerPipeline.status}.
 * The current Deployment is omitted when the Installation has never recorded a
 * successful pointer (`currentDeploymentId === null`).
 */
export interface InstallationStatus {
  readonly installation: Installation;
  readonly currentDeployment?: Deployment;
  readonly deployments: readonly Deployment[];
}

export interface InstallerPipelineDependencies {
  readonly installations?: InstallationStore;
  readonly deployments?: DeploymentStore;
  readonly publicationPaths?: PublicationPathStore;
  /**
   * Component apply boundary. When unset, `plugins` (or the default
   * empty plugin registry) is consulted to materialize each component.
   * If both are unset, the installer falls back to a noop provider that
   * records resources without external side effects.
   */
  readonly providers?: InstallerProviderRegistry;
  /**
   * Operator-supplied KernelPlugin set. When `providers` is omitted, the
   * installer builds a registry from this list and resolves each
   * `Component.kind` to the plugin whose `provides[]` contains it.
   * Lifecycle hooks (`onInstallStart` / `onInstallComplete` /
   * `onDeploymentStart` / `onDeploymentComplete`) are awaited serially
   * across this array in registration order.
   */
  readonly plugins?: readonly KernelPlugin[];
  /**
   * Operator-owned short-name aliases for component kinds. Takosumi does not
   * define contract-owned component kinds; aliases are resolved before plugin lookup.
   */
  readonly kindAliases?: KindAliasMap;
  /**
   * Operator-owned resolver for Space-visible publications. Exact listens pass
   * a platform service path such as `identity.primary.oidc`; discovery listens
   * pass material kind, labels, and `many`. The kernel treats the returned
   * material like any other listened material.
   */
  readonly platformServices?: PlatformServiceResolver;
  /** Defaults to `crypto.randomUUID()`-based id generation. */
  readonly newId?: (prefix: string) => string;
  /** Defaults to `Date.now()`. */
  readonly now?: () => number;
  /**
   * Working tree base for `source.kind: "local"`. When unset, local sources
   * must supply `source.url` as an absolute path.
   */
  readonly localSourceRoot?: string;
  /**
   * Injected `git` capability used to fetch `source.kind: "git"` checkouts.
   * When unset, the installer's source fetcher falls back to its own
   * Deno-runtime default; the kernel bootstrap injects a runner routed through
   * `currentRuntime().subprocess` (operator-overridable) so the same path runs
   * on Node / Workers without the installer referencing `Deno.Command`.
   */
  readonly gitRunner?: GitRunner;
  /**
   * Injected `tar` capability used to verify / extract
   * `source.kind: "prepared"` archives. Defaults like {@link gitRunner}.
   */
  readonly tarRunner?: TarRunner;
}

export class InstallerPipeline {
  readonly #installations: InstallationStore;
  readonly #deployments: DeploymentStore;
  readonly #publicationPaths: PublicationPathStore;
  readonly #providers: InstallerProviderRegistry;
  readonly #plugins: readonly KernelPlugin[];
  readonly #pluginRegistry: KernelPluginRegistry;
  readonly #usesPluginProviders: boolean;
  readonly #platformServices?: PlatformServiceResolver;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #localSourceRoot?: string;
  readonly #gitRunner?: GitRunner;
  readonly #tarRunner?: TarRunner;
  /**
   * Per-Installation mutation queue. `deploymentApply` and `rollback` for the
   * same `installationId` chain onto the previous promise so two concurrent
   * mutations cannot interleave their reads/writes against the same
   * Installation pointer. We await the previous in-flight mutation rather
   * than failing fast — concurrent control-plane requests against the same
   * Installation are uncommon and a transient queue is the least surprising
   * behavior. Callers that want fail-fast behavior should still rely on the
   * `expected.currentDeploymentId` guard.
   */
  readonly #mutationChains = new Map<string, Promise<unknown>>();
  /**
   * Per-Space mutation queue. Any apply (`installationApply` /
   * `deploymentApply`) whose AppSpec declares one or more pathful
   * `publish` entries chains onto the previous in-flight apply for the same
   * `spaceId` so the pathful-publication conflict guard's read-then-write
   * (#collectActivePublishPaths followed by writing the publication) cannot
   * interleave with a sibling Installation's apply in the same Space.
   *
   * The per-Installation `#mutationChains` only serializes within a single
   * Installation, which does not cover two *different* fresh installs racing
   * for the same Space path. This Space-level chain closes that in-process
   * race.
   *
   * RESIDUAL CAVEAT (honest): this is an in-process lock only. On the
   * documented multi-isolate (Cloudflare Workers) / multi-replica
   * (node-postgres) profiles, two replicas hold independent maps and
   * independent in-memory stores, so the lock cannot serialize across
   * replicas. Durable cross-replica path uniqueness needs a store-level
   * guard (a UNIQUE constraint over active publications, or an atomic
   * compare-and-set claim) which the current in-memory store layer does not
   * provide. Until a durable store backs publications, single-replica
   * deployments are protected and multi-replica deployments retain a
   * narrow race window on identical fresh pathful publishes.
   */
  readonly #spaceMutationChains = new Map<string, Promise<unknown>>();
  constructor(dependencies: InstallerPipelineDependencies = {}) {
    this.#installations = dependencies.installations ??
      new InMemoryInstallationStore();
    this.#deployments = dependencies.deployments ??
      new InMemoryDeploymentStore();
    this.#publicationPaths = dependencies.publicationPaths ??
      new InMemoryPublicationPathStore();
    this.#plugins = dependencies.plugins ?? [];
    this.#pluginRegistry = createKernelPluginRegistry(this.#plugins, {
      kindAliases: dependencies.kindAliases,
    });
    this.#usesPluginProviders = dependencies.providers === undefined &&
      this.#plugins.length > 0;
    this.#providers = dependencies.providers ??
      (dependencies.plugins && dependencies.plugins.length > 0
        ? installerProviderRegistryFromPluginRegistry(this.#pluginRegistry)
        : new NoopProviderRegistry());
    this.#platformServices = dependencies.platformServices;
    // Full-entropy UUID with hyphens stripped. The previous implementation
    // truncated to 16 hex chars, which dropped half the entropy and was
    // observably collision-prone in long-running test fixtures. Hyphens are
    // removed so the resulting `ins_*` / `dep_*` ids satisfy the
    // `INSTALLATION_ID_PATTERN` regex (`[0-9a-zA-Z]{16,32}`) used by the
    // public installer routes.
    this.#newId = dependencies.newId ??
      ((prefix: string) =>
        `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`);
    this.#now = dependencies.now ?? (() => Date.now());
    this.#localSourceRoot = dependencies.localSourceRoot;
    this.#gitRunner = dependencies.gitRunner;
    this.#tarRunner = dependencies.tarRunner;
  }

  /**
   * Compute the {@link OutputMaterial} for a single component output slot.
   * Delegates to the plugin's `materializeOutput` hook when present; the
   * fallback is intentionally narrow and never selects arbitrary output paths.
   */
  async #materializeOutput(ctx: {
    readonly installationId: string;
    readonly componentName: string;
    readonly component: Component;
    readonly outputName: OutputSlotName;
    readonly options?: PublishOptions;
    readonly outputs: Readonly<Record<string, JsonValue>>;
  }): Promise<OutputMaterial> {
    const plugin = findPluginForKind(this.#pluginRegistry, ctx.component.kind);
    let material: OutputMaterial;
    const materializeOutput = plugin?.materializeOutput ??
      plugin?.publishMaterial;
    if (materializeOutput) {
      material = await materializeOutput({
        installationId: ctx.installationId,
        componentName: ctx.componentName,
        component: ctx.component,
        outputName: ctx.outputName,
        options: ctx.options,
        outputs: ctx.outputs,
      });
    } else {
      material = defaultOutputMaterial(
        ctx.outputName,
        ctx.outputs,
        { allowEmpty: !this.#usesPluginProviders || plugin === undefined },
      );
    }
    validateOutputMaterial({
      componentName: ctx.componentName,
      outputName: ctx.outputName,
      material,
    });
    return material;
  }

  async installationDryRun(
    request: InstallationDryRunRequest,
  ): Promise<InstallationDryRunResponse> {
    requireNonEmptyString(request.spaceId, "spaceId");
    const fetched = await this.#fetchSource(request.source);
    try {
      const { appSpec, manifestDigest } = await readAppSpec(
        fetched.workingDirectory,
      );
      const changes = computeFreshInstallChangeSet(appSpec);
      const sourceSummary = summarizeSource(request.source, fetched);
      return {
        source: sourceSummary,
        manifestDigest,
        appSpec,
        changes,
        expected: sourcePinFromSummary(sourceSummary, manifestDigest),
      };
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
      const { appSpec, manifestDigest } = await readAppSpec(
        fetched.workingDirectory,
      );
      const sourceSummary = summarizeSource(request.source, fetched);
      checkExpectedPin(request.expected, sourceSummary, manifestDigest);
      await this.#preflightPluginProviders(appSpec);

      const installationId = this.#newId("ins");
      const now = this.#now();
      installation = {
        id: installationId,
        spaceId: request.spaceId,
        appId: appSpec.metadata.id,
        currentDeploymentId: null,
        status: "installing",
        createdAt: now,
      };
      await this.#installations.put(installation);

      // Serialize the apply + status patch per Space when the AppSpec
      // declares pathful publications so the conflict guard's read-then-write
      // cannot interleave with a sibling Installation's apply in the same
      // Space. See `#spaceMutationChains` for the in-process scope + the
      // residual multi-replica caveat.
      const applyAndPatch = async (): Promise<void> => {
        try {
          // Vite-style `onInstallStart` runs before the very first Deployment
          // of this Installation. Errors here are fatal — Installation goes
          // to `failed` status and the apply rejects.
          await this.#fireInstallationHook("onInstallStart", { installation });

          deployment = await this.#runDeployment({
            installation,
            appSpec,
            manifestDigest,
            sourceSummary,
            workingDirectory: fetched.workingDirectory,
          });

          const patched = await this.#installations.patch(installation.id, {
            currentDeploymentId: deployment.id,
            status: deployment.status === "succeeded" ? "ready" : "failed",
          });
          installation = patched ?? installation;

          // After-the-fact installer-complete hook. Errors here are logged
          // but do NOT roll the Installation back; the Deployment already
          // succeeded so post-install cleanup failures should not destroy
          // the user's app.
          if (deployment.status === "succeeded") {
            await this.#fireInstallationHook("onInstallComplete", {
              installation,
              deployment,
            }, { swallowErrors: true });
          }
        } catch (error) {
          const patched = await this.#installations.patch(installation.id, {
            status: "failed",
          });
          installation = patched ?? installation;
          throw error;
        }
      };
      await this.#runMaybeSpaceSerialized(
        request.spaceId,
        appSpec,
        applyAndPatch,
      );
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
    const dryRun = await this.installationDryRun({
      spaceId: installation.spaceId,
      source,
    });
    return {
      ...dryRun,
      expected: {
        ...dryRun.expected,
        currentDeploymentId: installation.currentDeploymentId,
      },
    };
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
    let deployment!: Deployment;
    try {
      const { appSpec, manifestDigest } = await readAppSpec(
        fetched.workingDirectory,
      );
      const sourceSummary = summarizeSource(source, fetched);
      checkExpectedPin(request.expected, sourceSummary, manifestDigest);
      await this.#preflightPluginProviders(appSpec);
      // Serialize the apply + status patch per Space when the AppSpec
      // declares pathful publications (alongside the already-applied
      // per-Installation `#runSerialized`) so the conflict guard's
      // read-then-write cannot interleave with a sibling Installation's
      // apply in the same Space.
      await this.#runMaybeSpaceSerialized(
        installation.spaceId,
        appSpec,
        async () => {
          deployment = await this.#runDeployment({
            installation,
            appSpec,
            manifestDigest,
            sourceSummary,
            workingDirectory: fetched.workingDirectory,
          });
          // When the caller supplied an `expected.currentDeploymentId` guard,
          // fence the pointer write at the store with a compare-and-set on the
          // value we pre-read and validated in `checkExpectedCurrentDeploymentId`.
          // This turns the dry-run → apply TOCTOU guard into an atomic CAS on
          // the durable SQL store so two replicas racing the same Installation
          // cannot lose each other's pointer write. No-`expected` applies keep
          // the unfenced patch (no value to fence against).
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
              // A concurrent deploy advanced the pointer between our pre-read
              // and this write. Surface the same fail-fast closed-envelope
              // conflict the in-app `checkExpectedCurrentDeploymentId` guard
              // raises (HTTP 409), rather than a generic 500.
              throw new InstallerPipelineError(
                "failed_precondition",
                error.message,
              );
            }
            throw error;
          }
        },
      );
    } finally {
      await fetched.cleanup();
    }
    return { deployment };
  }

  /**
   * Pointer-only rollback. This call flips the Installation's
   * `currentDeploymentId` back to a previously succeeded Deployment and
   * appends a `RollbackEvent` to the deployment store's audit log; it does
   * NOT re-apply the targeted source against any backend, and it does NOT
   * destroy resources that were created or mutated by Deployments since the
   * rollback target.
   *
   * If resource state must match the rolled-back Deployment, operators are
   * expected to follow this call with a new `deploymentApply` against the
   * rolled-back source (or a forward fix). The returned record carries
   * `rollback.rolledBackFrom` / `rolledBackTo` so callers can audit the
   * pointer flip, and the response itself reflects that the rollback was a
   * pointer-only operation (no new Deployment is created).
   *
   * Serialized per-Installation: concurrent `deploymentApply` / `rollback`
   * calls for the same `installationId` are awaited via the mutation chain
   * so the pointer flip cannot race with an in-flight apply.
   */
  rollback(
    installationId: string,
    request: RollbackRequest,
  ): Promise<RollbackResponse> {
    return this.#runSerialized(
      installationId,
      () => this.#rollbackImpl(installationId, request),
    );
  }

  /**
   * Read-only status accessor: returns the Installation record plus its
   * current Deployment (when the pointer is set) and the full Deployment
   * history for the Installation. This is a thin read over the already-wired
   * Installation / Deployment stores — it does not fetch source, materialize
   * components, or mutate any record — so the in-process operate facade
   * (`createPaaSApp(...).kernel.status`) can surface Installation lifecycle
   * state without re-running the apply pipeline.
   *
   * Throws an `InstallerPipelineError("not_found")` when the Installation does
   * not exist, mirroring the Installer API surface.
   */
  async status(installationId: string): Promise<InstallationStatus> {
    const installation = await this.#requireInstallation(installationId);
    const deployments = await this.#deployments.listForInstallation(
      installationId,
    );
    const currentDeployment = installation.currentDeploymentId
      ? deployments.find((d) => d.id === installation.currentDeploymentId)
      : undefined;
    return {
      installation,
      ...(currentDeployment ? { currentDeployment } : {}),
      deployments,
    };
  }

  async #rollbackImpl(
    installationId: string,
    request: RollbackRequest,
  ): Promise<RollbackResponse> {
    requireNonEmptyString(request.deploymentId, "deploymentId");
    const installation = await this.#requireInstallation(installationId);
    const previous = await this.#deployments.get(request.deploymentId);
    if (!previous || previous.installationId !== installationId) {
      throw new InstallerPipelineError(
        "not_found",
        `deployment ${request.deploymentId} not found for installation ${installationId}`,
      );
    }
    if (previous.status !== "succeeded") {
      throw new InstallerPipelineError(
        "failed_precondition",
        `deployment ${request.deploymentId} is not a succeeded rollback target`,
      );
    }
    await this.#assertDeploymentPublishPathsAvailable({
      installation,
      deployment: previous,
    });
    const rolledBackFrom = installation.currentDeploymentId;
    // Pointer-only update: we flip currentDeploymentId, append a RollbackEvent
    // to the audit log, and return. No re-apply, no resource destroy.
    const patched = await this.#installations.patch(installation.id, {
      currentDeploymentId: previous.id,
      status: "ready",
    });
    await this.#deployments.recordRollback?.({
      installationId,
      rolledBackFrom,
      rolledBackTo: previous.id,
      createdAt: this.#now(),
    });
    const updatedInstallation = patched ?? {
      ...installation,
      currentDeploymentId: previous.id,
      status: "ready" as const,
    };
    await this.#commitDeploymentPublishPathClaims({
      installation: updatedInstallation,
      deployment: previous,
    });
    // `rollback.scope` is the first-class, contract-declared statement of what
    // this operation reverts: the Deployment pointer is flipped, provider
    // resources are NOT re-materialized, and workload data/schema are NEVER
    // reverted. It replaces the previous out-of-contract `rollbackKind` marker
    // so callers cannot mistake a pointer rollback for a state rollback.
    const response: RollbackResponse = {
      installation: updatedInstallation,
      deployment: previous,
      rollback: {
        rolledBackFrom,
        rolledBackTo: previous.id,
        scope: {
          pointer: "reverted",
          resourceMaterialization: "not-reapplied",
          workloadState: "not-reverted",
        },
      },
    };
    return response;
  }

  /**
   * Per-Installation mutation queue. Chains every `deploymentApply` /
   * `rollback` for the same `installationId` so two mutations cannot
   * interleave. We await the previous in-flight mutation rather than failing
   * fast — see `#mutationChains` for rationale.
   */
  #runSerialized<T>(
    installationId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    requireNonEmptyString(installationId, "installationId");
    return this.#runChained(this.#mutationChains, installationId, work);
  }

  /**
   * Run `work` under the per-Space mutation chain when `appSpec` declares one
   * or more pathful `publish` entries; otherwise run it directly. Engaging
   * the lock only for pathful publishes avoids serializing unrelated applies
   * in the same Space. See `#spaceMutationChains` for scope + caveats.
   */
  #runMaybeSpaceSerialized<T>(
    spaceId: string,
    appSpec: AppSpec,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!hasPathfulPublish(appSpec)) return work();
    return this.#runChained(this.#spaceMutationChains, spaceId, work);
  }

  async #preflightPluginProviders(appSpec: AppSpec): Promise<void> {
    if (!this.#usesPluginProviders) return;
    for (const componentName of topologicalOrder(appSpec)) {
      const component = appSpec.components[componentName];
      const plugin = findPluginForKind(this.#pluginRegistry, component.kind);
      if (!plugin) {
        throw new InstallerPipelineError(
          "not_implemented",
          `no kernel plugin advertises kind ${component.kind} (component ${componentName})`,
        );
      }
      if (!plugin.validateComponent) continue;
      try {
        await plugin.validateComponent(component);
      } catch (error) {
        throw new InstallerPipelineError(
          "failed_precondition",
          `plugin ${plugin.name} rejected component ${componentName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * Generic FIFO mutation queue keyed on `key` against the supplied chain
   * map. Each call chains onto the previous in-flight promise for the same
   * key and self-evicts the map entry when it was the tail.
   */
  async #runChained<T>(
    chains: Map<string, Promise<unknown>>,
    key: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    let resolveCurrent!: (value: unknown) => void;
    const current = new Promise<unknown>((resolve) => {
      resolveCurrent = resolve;
    });
    chains.set(key, current);
    try {
      await previous.catch(() => {});
      return await work();
    } finally {
      resolveCurrent(undefined);
      if (chains.get(key) === current) {
        chains.delete(key);
      }
    }
  }

  listInstallations(spaceId?: string): Promise<readonly Installation[]> {
    return this.#installations.list(spaceId);
  }

  async #runDeployment(input: {
    installation: Installation;
    appSpec: AppSpec;
    manifestDigest: string;
    sourceSummary: SourceSummary;
    workingDirectory: string;
  }): Promise<Deployment> {
    const deploymentId = this.#newId("dep");
    const now = this.#now();
    const componentOutputs: Record<
      string,
      Record<string, Readonly<Record<string, JsonValue>>>
    > = {};
    const appliedOutputsByComponent = new Map<
      string,
      {
        readonly component: Component;
        readonly outputs: Readonly<Record<string, JsonValue>>;
      }
    >();

    // Material registry — single Installation-scoped store used for component
    // output refs (`component.output`) and platform service paths
    // (`identity.primary.oidc`). Built incrementally as each component applies in
    // topological order.
    const registry = new MaterialRegistry();
    const resolver = new BindingResolver({
      findMaterializer: (kind) => {
        if (!kind) return undefined;
        return findPluginForKind(this.#pluginRegistry, kind);
      },
    });

    await this.#reservePublishPaths({
      installation: input.installation,
      deploymentId,
      appSpec: input.appSpec,
      leaseExpiresAt: now + PUBLISH_PATH_CLAIM_TTL_MS,
    });
    const preflightListenMaterials = await this.#preflightListens({
      installation: input.installation,
      appSpec: input.appSpec,
    });

    // Stable pre-apply Deployment snapshot used as the lifecycle hook
    // context. Status is "running" pending materialization; the
    // persisted final value is overwritten below with "succeeded" or
    // "failed".
    const provisionalDeployment: Deployment = {
      id: deploymentId,
      installationId: input.installation.id,
      source: input.sourceSummary,
      manifestDigest: input.manifestDigest,
      status: "running",
      outputs: {},
      createdAt: now,
    };
    await this.#fireDeploymentHook("onDeploymentStart", {
      installation: input.installation,
      deployment: provisionalDeployment,
    });

    // Count + concrete resource evidence of components that returned
    // successfully from `providers.apply()` during this Deployment. Used to
    // populate `partialApplyDetected` / `partiallyAppliedResources` on the
    // failed-Deployment record below — see the failure handler's JSDoc for
    // why we record evidence instead of running a compensating transaction.
    let appliedComponentCount = 0;
    const appliedResources: ProviderResourceEvidence[] = [];
    try {
      const order = topologicalOrder(input.appSpec);
      const neededOutputs = collectNeededOutputSlots(input.appSpec);
      const servicePathExposures: Record<string, JsonValue> = {};
      for (const componentName of order) {
        const component = input.appSpec.components[componentName];
        // Resolve deterministic same-AppSpec `connect` bindings first, then
        // operator-resolved platform-service `listen` bindings.
        const listenedMaterials: Record<string, OutputMaterial> = {};
        const resolvedBindings: ResolvedBinding[] = [];
        if (component.connect) {
          for (
            const [bindingName, options] of Object.entries(component.connect)
          ) {
            const sourceRef = options.output;
            const material = registry.get(sourceRef);
            if (!material) {
              throw new InstallerPipelineError(
                "invalid_argument",
                `${componentName}.connect.${bindingName}.output refers to ` +
                  `unresolved component output ${JSON.stringify(sourceRef)}`,
              );
            }
            const binding = await this.#resolveEdgeChecked(resolver, {
              installationId: input.installation.id,
              listenerComponent: componentName,
              listenerKind: component.kind,
              listenerComponentRef: component,
              bindingName,
              sourceRef,
              options,
              material,
            });
            listenedMaterials[bindingName] = material;
            resolvedBindings.push(binding);
          }
        }
        if (component.listen) {
          for (
            const [bindingName, options] of Object.entries(component.listen)
          ) {
            const sourceRef = listenSourceRef(options);
            // A `listen.path` resolves an operator platform service. If that
            // path string collides with an already-published `component.output`
            // ref, registry.get would silently bind the LOCAL output and
            // shadow the platform service. Reject the ambiguity rather than
            // resolving the wrong material.
            if (
              typeof options.path === "string" &&
              registry.isLocalOutput(sourceRef)
            ) {
              throw new InstallerPipelineError(
                "failed_precondition",
                `${componentName}.listen.${bindingName}.path ${
                  JSON.stringify(sourceRef)
                } collides with a component output of the same ref; rename ` +
                  `the publish path or the component output`,
              );
            }
            const listenKey = listenMaterialKey(componentName, bindingName);
            const hasPreflightMaterial = preflightListenMaterials.has(
              listenKey,
            );
            const preflightMaterial = preflightListenMaterials.get(listenKey);
            const material = hasPreflightMaterial
              ? preflightMaterial ?? undefined
              : registry.get(sourceRef) ??
                await this.#resolvePublishedMaterial({
                  installation: input.installation,
                  sourceRef,
                  options,
                }) ??
                await this.#resolvePlatformService({
                  installation: input.installation,
                  componentName,
                  component,
                  bindingName,
                  sourceRef,
                  options,
                });
            if (!material) {
              if (options.required !== true) {
                continue;
              }
              throw new InstallerPipelineError(
                "failed_precondition",
                `${componentName}.listen.${bindingName} refers to ` +
                  `unresolved platform service ${JSON.stringify(sourceRef)}`,
              );
            }
            // Enforce the documented `listen.kind` compatibility assertion at
            // apply time. resolveAppSpec runs this in the test-only path; the
            // production pipeline walks listen edges itself, so we run the
            // shared guard here so a material whose advertised `kind` differs
            // from the declared `listen.kind` selector is rejected instead of
            // being silently bound.
            const binding = await this.#resolveEdgeChecked(resolver, {
              installationId: input.installation.id,
              listenerComponent: componentName,
              listenerKind: component.kind,
              listenerComponentRef: component,
              bindingName,
              sourceRef,
              options,
              material,
              assertListenKind: true,
            });
            listenedMaterials[bindingName] = material;
            resolvedBindings.push(binding);
          }
        }

        const applied = await this.#providers.apply({
          installationId: input.installation.id,
          componentName,
          component,
          source: input.sourceSummary,
          sourceDirectory: input.workingDirectory,
          inputMaterials: listenedMaterials,
          listenedMaterials,
          resolvedBindings,
        });
        appliedComponentCount += 1;
        appliedResources.push(applied.resource);
        appliedOutputsByComponent.set(componentName, {
          component,
          outputs: applied.outputs,
        });
        const neededComponentOutputs = neededOutputs.get(componentName) ??
          new Set<OutputSlotName>();
        for (const outputName of neededComponentOutputs) {
          const outputRef = localOutputRef(componentName, outputName);
          const material = await this.#materializeOutput({
            installationId: input.installation.id,
            componentName,
            component,
            outputName,
            outputs: applied.outputs,
          });
          registry.publish(outputRef, componentName, material);
          componentOutputs[componentName] ??= {};
          componentOutputs[componentName][outputName] =
            materialToDeploymentOutput(material);
        }
        if (Object.keys(applied.outputs).length > 0) {
          componentOutputs[componentName] ??= {};
          componentOutputs[componentName].providerOutputs =
            providerOutputsToDeploymentOutput(applied.outputs);
        }
      }
      const publishEntries = Object.entries(input.appSpec.publish ?? {});
      // Pathful publication conflict guard: when this Deployment publishes
      // any entry with a stable `path`, scan the active publications of
      // sibling Installations in the same Space and reject if another
      // active Installation already owns that path. Limitation: we reject
      // the new apply outright (no owner-disable / transfer flow). To
      // resolve a conflict, the operator must uninstall or re-publish the
      // conflicting Installation under a different path before re-applying.
      const pathfulPublishCount = publishEntries.reduce(
        (count, [, options]) => (options.path ? count + 1 : count),
        0,
      );
      if (pathfulPublishCount > 0) {
        const existingPaths = await this.#collectActivePublishPaths({
          spaceId: input.installation.spaceId,
          excludeInstallationId: input.installation.id,
        });
        for (const [name, options] of publishEntries) {
          if (!options.path) continue;
          const owner = existingPaths.get(options.path);
          if (owner !== undefined) {
            throw new InstallerPipelineError(
              "failed_precondition",
              `publish.${name}.path ${
                JSON.stringify(options.path)
              } conflicts with an active publication owned by installation ${
                JSON.stringify(owner)
              } (publish_path_conflict)`,
            );
          }
        }
      }
      for (const [name, options] of publishEntries) {
        const [componentName, outputName] = options.output.split(".");
        const applied = componentName
          ? appliedOutputsByComponent.get(componentName)
          : undefined;
        if (!componentName || !outputName || !applied) {
          throw new InstallerPipelineError(
            "failed_precondition",
            `publish.${name}.output refers to unresolved component output ` +
              JSON.stringify(options.output),
          );
        }
        const material = await this.#materializeOutput({
          installationId: input.installation.id,
          componentName,
          component: applied.component,
          outputName: outputName as OutputSlotName,
          options,
          outputs: applied.outputs,
        });
        assertPublishMaterialKind(name, options, material);
        servicePathExposures[name] = {
          output: options.output,
          ...(options.kind ? { kind: options.kind } : {}),
          ...(options.path ? { path: options.path } : {}),
          ...(options.labels ? { labels: options.labels } : {}),
          material: materialToDeploymentOutput(material),
        };
      }
      const outputs: DeploymentOutputs = {
        components: Object.keys(componentOutputs).length === 0
          ? undefined
          : componentOutputs,
        extensions: Object.keys(servicePathExposures).length === 0
          ? undefined
          : { servicePathExposures },
      };
      const deployment: Deployment = {
        id: deploymentId,
        installationId: input.installation.id,
        source: input.sourceSummary,
        manifestDigest: input.manifestDigest,
        status: "succeeded",
        outputs,
        createdAt: now,
      };
      const persisted = await this.#deployments.put(deployment);
      await this.#commitPublishPaths({
        installation: input.installation,
        deployment: persisted,
        appSpec: input.appSpec,
      });
      // After-apply hook: errors do not roll back the Deployment.
      await this.#fireDeploymentHook("onDeploymentComplete", {
        installation: input.installation,
        deployment: persisted,
      }, { swallowErrors: true });
      return persisted;
    } catch (err) {
      // Partial apply, NO compensation. When `providers.apply()` rejects on
      // component N, the components 0..N-1 that already succeeded keep
      // whatever side effects their kernel plugin produced (created
      // resources, written secrets, registered DNS records, etc). The
      // installer does NOT call `plugin.destroy()` or re-apply a previous
      // Deployment's source to compensate; that responsibility is left to
      // the operator via a forward fix (`deploymentApply` again with a
      // corrected source) or a manual cleanup.
      //
      // We persist `appliedComponentCount` on the failed Deployment as
      // `partialApplyDetected`, and the concrete resource evidence
      // (component / kind / provider / resourceHandle) of each already-applied
      // component as `partiallyAppliedResources`, so operators / tooling can
      // drive deterministic cleanup of the orphaned backend resources instead
      // of only seeing a count. (The kernel still does NOT auto-compensate;
      // see above.)
      const failed: Deployment = {
        id: deploymentId,
        installationId: input.installation.id,
        source: input.sourceSummary,
        manifestDigest: input.manifestDigest,
        status: "failed",
        outputs: {
          components: Object.keys(componentOutputs).length === 0
            ? undefined
            : componentOutputs,
          extensions: appliedComponentCount > 0
            ? {
              partialApplyDetected: appliedComponentCount,
              partiallyAppliedResources: appliedResources.map((resource) => ({
                component: resource.component,
                kind: resource.kind,
                provider: resource.provider,
                resourceHandle: resource.resourceHandle,
              })),
            }
            : undefined,
        },
        createdAt: now,
      };
      await this.#deployments.put(failed);
      throw err;
    }
  }

  /**
   * Resolve a single connect/listen edge, optionally running the
   * `listen.kind` compatibility assertion first, and translating any
   * {@link BindingResolutionError} (kind mismatch, env-key collision, ...)
   * into a closed-envelope {@link InstallerPipelineError} so the public
   * Installer API returns a documented `failed_precondition` (409) rather
   * than a generic 500.
   */
  async #resolveEdgeChecked(
    resolver: BindingResolver,
    input: {
      readonly installationId: string;
      readonly listenerComponent: string;
      readonly listenerKind: string;
      readonly listenerComponentRef: Component;
      readonly bindingName: string;
      readonly sourceRef: string;
      readonly options: BindingOptions;
      readonly material: OutputMaterial;
      readonly assertListenKind?: boolean;
    },
  ): Promise<ResolvedBinding> {
    try {
      if (input.assertListenKind) {
        assertListenMaterialKind({
          component: input.listenerComponent,
          bindingName: input.bindingName,
          options: input.options as ListenOptions,
          sourceRef: input.sourceRef,
          material: input.material,
        });
      }
      return await resolver.resolveEdge({
        installationId: input.installationId,
        listenerComponent: input.listenerComponent,
        listenerKind: input.listenerKind,
        listenerComponentRef: input.listenerComponentRef,
        bindingName: input.bindingName,
        sourceRef: input.sourceRef,
        options: input.options,
        material: input.material,
      });
    } catch (error) {
      if (error instanceof BindingResolutionError) {
        throw new InstallerPipelineError(
          "failed_precondition",
          error.message,
        );
      }
      throw error;
    }
  }

  async #preflightListens(input: {
    readonly installation: Installation;
    readonly appSpec: AppSpec;
  }): Promise<Map<string, OutputMaterial | null>> {
    const materials = new Map<string, OutputMaterial | null>();
    for (const componentName of topologicalOrder(input.appSpec)) {
      const component = input.appSpec.components[componentName];
      for (const [bindingName, options] of Object.entries(
        component.listen ?? {},
      )) {
        const sourceRef = listenSourceRef(options);
        const material = await this.#resolvePublishedMaterial({
          installation: input.installation,
          sourceRef,
          options,
        }) ??
          await this.#resolvePlatformService({
            installation: input.installation,
            componentName,
            component,
            bindingName,
            sourceRef,
            options,
          });
        if (!material) {
          if (options.required === true) {
            throw new InstallerPipelineError(
              "failed_precondition",
              `${componentName}.listen.${bindingName} refers to ` +
                `unresolved platform service ${JSON.stringify(sourceRef)}`,
            );
          }
          materials.set(listenMaterialKey(componentName, bindingName), null);
          continue;
        }
        try {
          assertListenMaterialKind({
            component: componentName,
            bindingName,
            options,
            sourceRef,
            material,
          });
        } catch (error) {
          if (error instanceof BindingResolutionError) {
            throw new InstallerPipelineError(
              "failed_precondition",
              error.message,
            );
          }
          throw error;
        }
        materials.set(listenMaterialKey(componentName, bindingName), material);
      }
    }
    return materials;
  }

  async #reservePublishPaths(input: {
    readonly installation: Installation;
    readonly deploymentId: string;
    readonly appSpec: AppSpec;
    readonly leaseExpiresAt: number;
  }): Promise<void> {
    const entries = pathfulPublishEntries(input.appSpec);
    if (entries.length === 0) return;
    await this.#assertPublishPathsAvailable({
      spaceId: input.installation.spaceId,
      installationId: input.installation.id,
      entries,
    });
    const updatedAt = this.#now();
    for (const [publishName, options] of entries) {
      await this.#publicationPaths.claim({
        spaceId: input.installation.spaceId,
        path: options.path,
        installationId: input.installation.id,
        deploymentId: input.deploymentId,
        publishName,
        updatedAt,
        leaseExpiresAt: input.leaseExpiresAt,
      });
    }
  }

  async #commitPublishPaths(input: {
    readonly installation: Installation;
    readonly deployment: Deployment;
    readonly appSpec: AppSpec;
  }): Promise<void> {
    const entries = pathfulPublishEntries(input.appSpec);
    if (entries.length === 0) return;
    const updatedAt = this.#now();
    for (const [publishName, options] of entries) {
      await this.#publicationPaths.claim({
        spaceId: input.installation.spaceId,
        path: options.path,
        installationId: input.installation.id,
        deploymentId: input.deployment.id,
        publishName,
        updatedAt,
      });
    }
  }

  async #commitDeploymentPublishPathClaims(input: {
    readonly installation: Installation;
    readonly deployment: Deployment;
  }): Promise<void> {
    const entries = deploymentPathfulPublications(input.deployment);
    if (entries.length === 0) return;
    const updatedAt = this.#now();
    for (const entry of entries) {
      await this.#publicationPaths.claim({
        spaceId: input.installation.spaceId,
        path: entry.path,
        installationId: input.installation.id,
        deploymentId: input.deployment.id,
        publishName: entry.name,
        updatedAt,
      });
    }
  }

  async #assertDeploymentPublishPathsAvailable(input: {
    readonly installation: Installation;
    readonly deployment: Deployment;
  }): Promise<void> {
    const entries = deploymentPathfulPublications(input.deployment).map(
      (entry) => [entry.name, { path: entry.path }] as const,
    );
    await this.#assertPublishPathsAvailable({
      spaceId: input.installation.spaceId,
      installationId: input.installation.id,
      entries,
    });
  }

  async #assertPublishPathsAvailable(input: {
    readonly spaceId: string;
    readonly installationId: string;
    readonly entries: readonly (readonly [
      string,
      { readonly path: string },
    ])[];
  }): Promise<void> {
    if (input.entries.length === 0) return;
    const existingPaths = await this.#collectActivePublishPaths({
      spaceId: input.spaceId,
      excludeInstallationId: input.installationId,
    });
    for (const [name, options] of input.entries) {
      const owner = existingPaths.get(options.path);
      if (owner !== undefined) {
        throw new InstallerPipelineError(
          "failed_precondition",
          `publish.${name}.path ${
            JSON.stringify(options.path)
          } conflicts with an active publication owned by installation ${
            JSON.stringify(owner)
          } (publish_path_conflict)`,
        );
      }
    }
  }

  /**
   * Collect the set of `publish.path` values already owned by active
   * Installations in the given Space. The map is keyed by path and points
   * at the owning Installation id so the pathful-publication conflict
   * guard in {@link #runDeployment} can produce a useful diagnostic.
   *
   * Siblings whose status is `ready` (settled owner) or `installing`
   * (in-flight sibling that still projects a prior current Deployment, e.g.
   * a redeploy in progress) are both counted so an in-flight sibling's
   * publication is not transiently invisible to a concurrent apply.
   *
   * Limitations:
   * - We snapshot the active publications via each Installation's
   *   `currentDeploymentId` projection. A *fresh* install in flight has no
   *   current Deployment yet, so it contributes no path here; the
   *   per-Space mutation chain (`#spaceMutationChains`) — not this scan — is
   *   what serializes two fresh pathful installs in the same Space within a
   *   process. That chain is in-process only; see its doc for the residual
   *   multi-replica caveat.
   * - Suspended Installations are ignored. `failed` Installations are
   *   ignored too — a failed apply does not own a publication.
   */
  async #collectActivePublishPaths(input: {
    readonly spaceId: string;
    readonly excludeInstallationId?: string;
  }): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (
      const publication of await this.#listActivePublications({
        spaceId: input.spaceId,
        excludeInstallationId: input.excludeInstallationId,
      })
    ) {
      if (publication.path && !result.has(publication.path)) {
        result.set(publication.path, publication.installationId);
      }
    }
    const now = this.#now();
    for (const claim of await this.#publicationPaths.list(input.spaceId)) {
      if (
        input.excludeInstallationId !== undefined &&
        claim.installationId === input.excludeInstallationId
      ) {
        continue;
      }
      if (await this.#isActivePublicationPathClaim(claim, now)) {
        if (!result.has(claim.path)) {
          result.set(claim.path, claim.installationId);
        }
      }
    }
    return result;
  }

  async #isActivePublicationPathClaim(
    claim: PublicationPathClaim,
    now: number,
  ): Promise<boolean> {
    const installation = await this.#installations.get(claim.installationId);
    if (!installation) return false;
    if (
      installation.status !== "ready" &&
      installation.status !== "installing"
    ) {
      return false;
    }
    if (claim.leaseExpiresAt !== undefined) {
      return claim.leaseExpiresAt > now;
    }
    const deployment = await this.#deployments.get(claim.deploymentId);
    if (!deployment || deployment.status !== "succeeded") return false;
    if (installation.currentDeploymentId === claim.deploymentId) return true;
    return installation.status === "installing" &&
      claim.updatedAt + PUBLISH_PATH_CLAIM_TTL_MS > now;
  }

  async #resolvePublishedMaterial(input: {
    readonly installation: Installation;
    readonly sourceRef: string;
    readonly options: ListenOptions;
  }): Promise<OutputMaterial | undefined> {
    const publications = await this.#listActivePublications({
      spaceId: input.installation.spaceId,
      excludeInstallationId: input.installation.id,
    });
    const matches = publications.filter((publication) =>
      publicationMatchesListen(publication, input.options)
    );
    if (matches.length === 0) return undefined;
    return normalizeResolvedPlatformService({
      sourceRef: input.sourceRef,
      many: input.options.many === true,
      resolved: matches.map((publication) => publication.material),
    });
  }

  async #listActivePublications(input: {
    readonly spaceId: string;
    readonly excludeInstallationId?: string;
  }): Promise<readonly ActivePublication[]> {
    const publications: ActivePublication[] = [];
    const installations = await this.#installations.list(input.spaceId);
    for (const installation of installations) {
      if (
        input.excludeInstallationId !== undefined &&
        installation.id === input.excludeInstallationId
      ) {
        continue;
      }
      if (
        installation.status !== "ready" &&
        installation.status !== "installing"
      ) {
        continue;
      }
      const deploymentId = installation.currentDeploymentId;
      if (deploymentId === null) continue;
      const deployment = await this.#deployments.get(deploymentId);
      if (!deployment || deployment.status !== "succeeded") continue;
      publications.push(
        ...deploymentPublications(deployment, installation.id),
      );
    }
    return publications;
  }

  async #resolvePlatformService(input: {
    readonly installation: Installation;
    readonly componentName: string;
    readonly component: Component;
    readonly bindingName: string;
    readonly sourceRef: string;
    readonly options: ListenOptions;
  }): Promise<OutputMaterial | undefined> {
    if (!this.#platformServices) return undefined;
    let resolved: OutputMaterial | readonly OutputMaterial[] | undefined;
    try {
      resolved = await this.#platformServices.resolve({
        installationId: input.installation.id,
        spaceId: input.installation.spaceId,
        appId: input.installation.appId,
        componentName: input.componentName,
        component: input.component,
        bindingName: input.bindingName,
        sourceRef: input.options.path,
        kind: input.options.kind,
        labels: input.options.labels,
        many: input.options.many,
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new InstallerPipelineError(
        "failed_precondition",
        `failed to resolve platform service ${
          JSON.stringify(input.sourceRef)
        }: ${cause}`,
      );
    }
    if (resolved === undefined) return undefined;
    const material = normalizeResolvedPlatformService({
      sourceRef: input.sourceRef,
      many: input.options.many === true,
      resolved,
    });
    if (material === undefined) return undefined;
    if (!isOutputMaterial(material)) {
      throw new InstallerPipelineError(
        "failed_precondition",
        `platform service ${JSON.stringify(input.sourceRef)} returned ` +
          "invalid material",
      );
    }
    return material;
  }

  async #fireInstallationHook(
    hook: "onInstallStart" | "onInstallComplete",
    ctx: { installation: Installation; deployment?: Deployment },
    options: { swallowErrors?: boolean } = {},
  ): Promise<void> {
    for (const plugin of this.#plugins) {
      const fn = plugin[hook];
      if (!fn) continue;
      try {
        await fn.call(plugin, ctx);
      } catch (error) {
        if (options.swallowErrors) {
          log.warn(`installer.${hook}.error`, {
            plugin: plugin.name,
            installationId: ctx.installation.id,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        throw new InstallerPipelineError(
          "internal_error",
          `plugin ${plugin.name} ${hook} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  async #fireDeploymentHook(
    hook: "onDeploymentStart" | "onDeploymentComplete",
    ctx: { installation: Installation; deployment: Deployment },
    options: { swallowErrors?: boolean } = {},
  ): Promise<void> {
    for (const plugin of this.#plugins) {
      const fn = plugin[hook];
      if (!fn) continue;
      try {
        await fn.call(plugin, ctx);
      } catch (error) {
        if (options.swallowErrors) {
          log.warn(`installer.${hook}.error`, {
            plugin: plugin.name,
            installationId: ctx.installation.id,
            deploymentId: ctx.deployment.id,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        throw new InstallerPipelineError(
          "internal_error",
          `plugin ${plugin.name} ${hook} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
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
        return {
          workingDirectory,
          cleanup: () => Promise.resolve(),
        };
      }
      if (!requested) {
        throw new InstallerPipelineError(
          "invalid_argument",
          "local source requires source.url or a configured localSourceRoot",
        );
      }
      return {
        workingDirectory: requested,
        cleanup: () => Promise.resolve(),
      };
    }
    if (source.kind === "git") {
      if (!source.url) {
        throw new InstallerPipelineError(
          "invalid_argument",
          "git source requires source.url",
        );
      }
      let result: Awaited<ReturnType<typeof fetchGitSource>>;
      try {
        result = await fetchGitSource({
          url: source.url,
          ref: source.ref,
          // Inject the kernel's runtime FS so the installer stages the checkout
          // through the RuntimeAdapter instead of the installer-local Deno
          // fallback. The git runner is injected only when the operator / bootstrap
          // supplied one; otherwise the installer's own default applies.
          fs: currentRuntime().fs,
          ...(this.#gitRunner ? { gitRunner: this.#gitRunner } : {}),
        });
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new InstallerPipelineError(
          classifySourceFetchError(cause),
          `failed to fetch git source: ${cause}`,
        );
      }
      return {
        workingDirectory: result.workingDirectory,
        commit: result.commit,
        cleanup: result.cleanup,
      };
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
          // Inject the kernel's runtime FS; the tar runner is injected only
          // when the operator / bootstrap supplied one.
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
}

interface ActivePublication {
  readonly installationId: string;
  readonly name: string;
  readonly output: string;
  readonly path?: string;
  readonly kind?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly material: OutputMaterial;
}

function pathfulPublishEntries(
  appSpec: AppSpec,
): readonly (readonly [
  string,
  PublishOptions & { readonly path: string },
])[] {
  const entries: Array<
    readonly [string, PublishOptions & { readonly path: string }]
  > = [];
  for (const [name, options] of Object.entries(appSpec.publish ?? {})) {
    if (typeof options.path === "string" && options.path.length > 0) {
      entries.push([
        name,
        { ...options, path: options.path },
      ]);
    }
  }
  return entries;
}

function deploymentPathfulPublications(
  deployment: Deployment,
): readonly { readonly name: string; readonly path: string }[] {
  return deploymentPublications(deployment, "").flatMap((publication) =>
    publication.path
      ? [{ name: publication.name, path: publication.path }]
      : []
  );
}

function deploymentPublications(
  deployment: Deployment,
  installationId: string,
): readonly ActivePublication[] {
  const exposures = deployment.outputs.extensions?.servicePathExposures;
  if (!isRecord(exposures)) return [];
  const publications: ActivePublication[] = [];
  for (const [name, value] of Object.entries(exposures)) {
    if (!isRecord(value)) continue;
    const material = value.material;
    if (!isOutputMaterial(material)) continue;
    const output = typeof value.output === "string" ? value.output : "";
    const path = typeof value.path === "string" && value.path.length > 0
      ? value.path
      : undefined;
    const kind = typeof value.kind === "string" && value.kind.length > 0
      ? value.kind
      : undefined;
    const labels = isStringRecord(value.labels) ? value.labels : undefined;
    publications.push({
      installationId,
      name,
      output,
      ...(path ? { path } : {}),
      ...(kind ? { kind } : {}),
      ...(labels ? { labels } : {}),
      material,
    });
  }
  return publications;
}

function publicationMatchesListen(
  publication: ActivePublication,
  options: ListenOptions,
): boolean {
  if (typeof options.path === "string") {
    return publication.path === options.path;
  }
  if (typeof options.kind !== "string" || options.kind.length === 0) {
    return false;
  }
  const actualKind = publication.kind ?? readOutputMaterialKind(
    publication.material,
    `publish.${publication.name}.material`,
  );
  if (actualKind !== options.kind) return false;
  return labelsInclude(publication.labels ?? {}, options.labels ?? {});
}

function labelsInclude(
  actual: Readonly<Record<string, string>>,
  selector: Readonly<Record<string, string>>,
): boolean {
  for (const [key, value] of Object.entries(selector)) {
    if (actual[key] !== value) return false;
  }
  return true;
}

function assertPublishMaterialKind(
  publishName: string,
  options: PublishOptions,
  material: OutputMaterial,
): void {
  if (typeof options.kind !== "string" || options.kind.length === 0) return;
  const actual = readOutputMaterialKind(
    material,
    `publish.${publishName}.material`,
  );
  if (actual === options.kind) return;
  throw new InstallerPipelineError(
    "failed_precondition",
    `publish.${publishName}.kind expects material kind ${
      JSON.stringify(options.kind)
    } but material advertises kind ${JSON.stringify(actual ?? "unknown")}`,
  );
}

function readOutputMaterialKind(
  material: OutputMaterial,
  context: string,
): string | undefined {
  const record = material as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : undefined;
  const materialKind = typeof record.materialKind === "string"
    ? record.materialKind
    : undefined;
  if (kind && materialKind && kind !== materialKind) {
    throw new InstallerPipelineError(
      "failed_precondition",
      `${context} has conflicting kind fields: kind ${JSON.stringify(kind)} ` +
        `and materialKind ${JSON.stringify(materialKind)}`,
    );
  }
  return materialKind ?? kind;
}

function isStringRecord(
  value: unknown,
): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

interface FetchedSource {
  readonly workingDirectory: string;
  readonly commit?: string;
  readonly sourceDigest?: string;
  readonly cleanup: () => Promise<void>;
}

class NoopProviderRegistry implements InstallerProviderRegistry {
  apply(context: ProviderApplyContext): Promise<ProviderApplyResult> {
    return Promise.resolve({
      resource: {
        component: context.componentName,
        kind: context.component.kind,
        provider: "noop",
        resourceHandle:
          `noop://${context.installationId}/${context.componentName}`,
      },
      outputs: {},
    });
  }
}

/**
 * Build an {@link InstallerProviderRegistry} that delegates to operator-
 * supplied `KernelPlugin` instances. For each component, the plugin whose
 * `provides[]` matches the normalized `Component.kind` URI is invoked.
 *
 * Throws when no plugin advertises the kind URI — the installer treats
 * this as a misconfiguration. Operators must either inject a plugin for
 * every kind in their AppSpec or supply a custom `providers` override.
 */
export function installerProviderRegistryFromPlugins(
  plugins: readonly KernelPlugin[],
  kindAliases?: KindAliasMap,
): InstallerProviderRegistry {
  return installerProviderRegistryFromPluginRegistry(
    createKernelPluginRegistry(plugins, { kindAliases }),
  );
}

function installerProviderRegistryFromPluginRegistry(
  registry: KernelPluginRegistry,
): InstallerProviderRegistry {
  return {
    async apply(context: ProviderApplyContext): Promise<ProviderApplyResult> {
      const kind = context.component.kind;
      const plugin = findPluginForKind(registry, kind);
      if (!plugin) {
        throw new InstallerPipelineError(
          "not_implemented",
          `no kernel plugin advertises kind ${kind} (component ${context.componentName})`,
        );
      }
      let result: Awaited<ReturnType<KernelPlugin["apply"]>>;
      try {
        result = await plugin.apply({
          installationId: context.installationId,
          componentName: context.componentName,
          component: context.component,
          source: context.source,
          sourceDirectory: context.sourceDirectory,
          inputMaterials: context.inputMaterials ?? context.listenedMaterials,
          listenedMaterials: context.listenedMaterials,
          resolvedBindings: context.resolvedBindings,
        });
      } catch (error) {
        throw new InstallerPipelineError(
          "failed_precondition",
          `plugin ${plugin.name} apply failed for component ${
            context.componentName
          }: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {
        resource: {
          component: context.componentName,
          kind: context.component.kind,
          provider: plugin.name,
          resourceHandle: result.resourceHandle,
        },
        outputs: result.outputs,
      };
    },
  };
}

/**
 * Sentinel publisher id recorded for operator-resolved platform-service
 * materials. Distinct from any `component.output` publisher (a component
 * name) so the registry can tell platform-service refs apart from local
 * output refs and reject shadowing / conflicting writes.
 */
const PLATFORM_SERVICE_PUBLISHER = " platform-service";

/**
 * In-memory material registry — owns the (source ref → publisher / material)
 * map for one Deployment apply. Component outputs use `component.output`;
 * platform service refs use `identity.primary.oidc`-style paths when an operator
 * pre-populates them.
 */
class MaterialRegistry {
  readonly #materials = new Map<string, OutputMaterial>();
  readonly #publishers = new Map<string, string>();

  publish(
    sourceRef: string,
    publisher: string,
    material: OutputMaterial,
  ): void {
    const existing = this.#publishers.get(sourceRef);
    if (existing !== undefined && existing !== publisher) {
      throw new InstallerPipelineError(
        "failed_precondition",
        `material ${JSON.stringify(sourceRef)} is already ` +
          `published by ${JSON.stringify(existing)}; cannot publish from ` +
          JSON.stringify(publisher),
      );
    }
    this.#publishers.set(sourceRef, publisher);
    this.#materials.set(sourceRef, material);
  }

  publishPlatformService(
    sourceRef: string,
    material: OutputMaterial,
  ): void {
    const existing = this.#publishers.get(sourceRef);
    if (existing !== undefined && existing !== PLATFORM_SERVICE_PUBLISHER) {
      // A local component output already owns this ref. A `listen.path`
      // string that collides with a `component.output` ref would otherwise
      // silently shadow the operator-resolved platform service (registry.get
      // is consulted before platform resolution). Reject the ambiguity.
      throw new InstallerPipelineError(
        "failed_precondition",
        `platform service path ${JSON.stringify(sourceRef)} collides with ` +
          `component output published by ${JSON.stringify(existing)}; ` +
          `rename the publish path or the component output so they do not ` +
          `share a ref`,
      );
    }
    this.#publishers.set(sourceRef, PLATFORM_SERVICE_PUBLISHER);
    this.#materials.set(sourceRef, material);
  }

  /**
   * True when `sourceRef` is already bound to a local component output (as
   * opposed to a platform-service resolution). Lets the listen path detect a
   * `listen.path` that would shadow a component output before consuming it.
   */
  isLocalOutput(sourceRef: string): boolean {
    const publisher = this.#publishers.get(sourceRef);
    return publisher !== undefined && publisher !== PLATFORM_SERVICE_PUBLISHER;
  }

  get(sourceRef: string): OutputMaterial | undefined {
    return this.#materials.get(sourceRef);
  }

  snapshot(): Readonly<Record<string, OutputMaterial>> {
    return Object.fromEntries(this.#materials.entries());
  }
}

function listenSourceRef(options: ListenOptions): string {
  if (typeof options.path === "string") {
    return options.path;
  }
  const selector = {
    kind: options.kind,
    labels: options.labels ?? {},
    many: options.many === true,
  };
  return `query:${JSON.stringify(selector)}`;
}

function listenMaterialKey(componentName: string, bindingName: string): string {
  return `${componentName}\0${bindingName}`;
}

function normalizeResolvedPlatformService(input: {
  readonly sourceRef: string;
  readonly many: boolean;
  readonly resolved: OutputMaterial | readonly OutputMaterial[];
}): OutputMaterial | undefined {
  if (!Array.isArray(input.resolved)) {
    return input.resolved as OutputMaterial;
  }
  if (input.resolved.length === 0) {
    if (input.many) {
      return {
        kind: "collection",
        items: [],
      };
    }
    throw new InstallerPipelineError(
      "failed_precondition",
      `platform service selector ${JSON.stringify(input.sourceRef)} ` +
        `matched 0 entries; expected exactly one`,
    );
  }
  if (!input.many) {
    if (input.resolved.length === 1) return input.resolved[0]!;
    throw new InstallerPipelineError(
      "failed_precondition",
      `platform service selector ${JSON.stringify(input.sourceRef)} matched ` +
        `${input.resolved.length} entries; expected exactly one or set many: true`,
    );
  }
  return {
    kind: "collection",
    items: input.resolved as unknown as JsonValue,
  };
}

function localOutputRef(
  componentName: string,
  outputName: string,
): string {
  return `${componentName}.${outputName}`;
}

function defaultOutputMaterial(
  outputName: OutputSlotName,
  outputs: Readonly<Record<string, JsonValue>>,
  options: { readonly allowEmpty?: boolean } = {},
): OutputMaterial {
  if (options.allowEmpty && Object.keys(outputs).length === 0) return {};
  const selected = outputs[outputName];
  if (selected !== undefined) {
    return { [outputName]: selected };
  }
  throw new InstallerPipelineError(
    "failed_precondition",
    `output ${outputName} requires the component materializer to ` +
      `project provider outputs into output material`,
  );
}

function validateOutputMaterial(input: {
  readonly componentName: string;
  readonly outputName: OutputSlotName;
  readonly material: OutputMaterial;
}): void {
  if (!isOutputMaterial(input.material)) {
    throw new InstallerPipelineError(
      "failed_precondition",
      `${input.componentName}.${input.outputName} produced invalid material`,
    );
  }
}

function materialToDeploymentOutput(
  material: OutputMaterial,
): Readonly<Record<string, JsonValue>> {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(material)) {
    if (isSecretRefMaterial(value)) {
      // Already a secret reference envelope — keep the indirection; the
      // raw secret never sits in the Deployment record.
      output[key] = { secretRef: value.secretRef };
      continue;
    }
    // Defense in depth: a materializer that violates the OutputMaterial
    // contract by emitting a plaintext secret under a sensitive-looking key
    // (instead of wrapping it in `{ secretRef }`) would otherwise persist
    // that plaintext into the Deployment record. Apply the SAME key-based
    // redaction the provider-output path uses so both persistence paths
    // scrub sensitive plaintext consistently.
    output[key] = isSensitiveKey(key)
      ? "[redacted]"
      : redactSensitiveJsonValue(value);
  }
  return output;
}

function providerOutputsToDeploymentOutput(
  outputs: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  return redactSensitiveOutputs(outputs);
}

/**
 * Redacts values whose keys look sensitive (token, secret, key, password,
 * credential, apikey, jwt — case-insensitive) before the provider outputs
 * are persisted into the Deployment record. The key remains visible so
 * Deployment outputs still describe shape, but the value is replaced with
 * the literal string `[redacted]`. Recurses into nested JSON objects /
 * arrays so structures like `{ db: { password: "..." } }` are scrubbed.
 */
function redactSensitiveOutputs(
  outputs: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(outputs)) {
    result[key] = isSensitiveKey(key)
      ? "[redacted]"
      : redactSensitiveJsonValue(value);
  }
  return result;
}

const SENSITIVE_KEY_RE = /token|secret|key|password|credential|apikey|jwt/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

function redactSensitiveJsonValue(value: JsonValue): JsonValue {
  if (value === null) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveJsonValue(entry));
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = isSensitiveKey(key)
        ? "[redacted]"
        : redactSensitiveJsonValue(nested as JsonValue);
    }
    return result;
  }
  return value;
}

function isSecretRefMaterial(
  value: OutputMaterial[string],
): value is { readonly secretRef: string } {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    typeof value.secretRef === "string";
}

function isOutputMaterial(value: unknown): value is OutputMaterial {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type InstallerPipelineErrorCode =
  | "invalid_argument"
  | "unauthenticated"
  | "permission_denied"
  | "not_found"
  | "failed_precondition"
  | "resource_exhausted"
  | "not_implemented"
  | "internal_error";

export class InstallerPipelineError extends Error {
  readonly code: InstallerPipelineErrorCode;
  constructor(code: InstallerPipelineErrorCode, message: string) {
    super(message);
    this.name = "InstallerPipelineError";
    this.code = code;
  }
}

async function readAppSpec(
  workingDirectory: string,
): Promise<{ appSpec: AppSpec; manifestDigest: string }> {
  const path = `${workingDirectory.replace(/\/+$/, "")}/.takosumi.yml`;
  let bytes: Uint8Array;
  try {
    bytes = await currentRuntime().fs.readFile(path);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new InstallerPipelineError(
      "failed_precondition",
      `failed to read .takosumi.yml at ${path}: ${cause}`,
    );
  }
  let appSpec: AppSpec;
  try {
    appSpec = parseAppSpec(bytes);
  } catch (err) {
    // `.takosumi.yml` content is client/source-controlled. The parser
    // rejects malformed manifests with an {@link AppSpecParseError} carrying
    // a `validationPhase`; surface it on the closed error envelope instead of
    // letting it bubble out as a generic 500 internal_error. Size-guard
    // phases (manifest / component-count limits) map to the documented
    // `resource_exhausted` (413) code per AGENTS.md; every other syntax /
    // schema / connection-resolution / metadata / forbidden-field /
    // connect-cycle phase maps to `invalid_argument` (400). The
    // AppSpecParseError message describes the operator's own source manifest
    // (validationPhase / validationPath), not server internals.
    if (err instanceof AppSpecParseError) {
      const code: InstallerPipelineErrorCode =
        err.validationPhase === "manifest-too-large" ||
          err.validationPhase === "too-many-components"
          ? "resource_exhausted"
          : "invalid_argument";
      throw new InstallerPipelineError(code, err.message);
    }
    throw err;
  }
  const manifestDigest = await sha256Hex(bytes);
  return { appSpec, manifestDigest };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view so subtle.digest accepts the
  // input on type signatures that exclude SharedArrayBuffer-backed views.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return `sha256:${
    Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  }`;
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
    digest: fetched.sourceDigest ?? source.digest,
  };
}

/**
 * Strip embedded credentials (`user:pass@host`) from a source URL before it is
 * surfaced in a dry-run response or persisted on a Deployment record. Inputs
 * that do not parse as URLs (for example absolute filesystem paths used by
 * `source.kind: "local"`) are returned unchanged.
 */
function stripUrlCredentials(value: string | undefined): string | undefined {
  if (value === undefined) return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  if (parsed.username === "" && parsed.password === "") {
    return value;
  }
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

function sourceFromSummary(summary: SourceSummary): Source {
  if (summary.kind === "git") {
    requireNonEmptyString(summary.url, "source.url");
    requireNonEmptyString(summary.commit, "source.commit");
    return {
      kind: "git",
      url: summary.url,
      ref: summary.commit,
    };
  }
  if (summary.kind === "prepared") {
    requireNonEmptyString(summary.url, "source.url");
    requireNonEmptyString(summary.digest, "source.digest");
    return {
      kind: "prepared",
      url: summary.url,
      digest: summary.digest,
    };
  }
  requireNonEmptyString(summary.url, "source.url");
  return {
    kind: "local",
    url: summary.url,
  };
}

function sourcePinFromSummary(
  summary: SourceSummary,
  manifestDigest: string,
): SourcePin {
  if (summary.kind === "git") {
    requireNonEmptyString(summary.commit, "source.commit");
    return {
      manifestDigest,
      commit: summary.commit,
    };
  }
  if (summary.kind === "prepared") {
    requireNonEmptyString(summary.digest, "source.digest");
    return {
      manifestDigest,
      sourceDigest: summary.digest,
    };
  }
  return { manifestDigest };
}

/**
 * True when the AppSpec declares one or more root `publish` entries that
 * carry a stable `path`. Pathful publications participate in the Space-level
 * uniqueness conflict guard, so applies that declare them are serialized per
 * Space; pathless publications can coexist freely and need no serialization.
 */
function hasPathfulPublish(appSpec: AppSpec): boolean {
  for (const options of Object.values(appSpec.publish ?? {})) {
    if (typeof options.path === "string" && options.path.length > 0) {
      return true;
    }
  }
  return false;
}

function computeFreshInstallChangeSet(
  appSpec: AppSpec,
): readonly ChangeEntry[] {
  const entries: ChangeEntry[] = [];
  for (const [name, component] of Object.entries(appSpec.components)) {
    entries.push({
      op: "create",
      component: name,
      kind: component.kind,
      reason: "fresh installation",
    });
  }
  return entries;
}

function collectNeededOutputSlots(
  appSpec: AppSpec,
): Map<string, Set<OutputSlotName>> {
  const needed = new Map<string, Set<OutputSlotName>>();
  const add = (ref: ComponentOutputRef) => {
    const [componentName, outputName] = ref.split(".");
    if (!componentName || !outputName) return;
    const slots = needed.get(componentName) ?? new Set<OutputSlotName>();
    slots.add(outputName);
    needed.set(componentName, slots);
  };
  for (const component of Object.values(appSpec.components)) {
    for (const options of Object.values(component.connect ?? {})) {
      add(options.output);
    }
  }
  return needed;
}

/**
 * Order components so every `connect` producer applies before its consumer,
 * rejecting `connect` cycles within a single AppSpec.
 *
 * SCOPE (honest limitation): this only covers same-AppSpec `connect` edges.
 * Cross-Installation dependencies expressed via `listen` -> root `publish`
 * across Installations in the same Space (Installation A publishes path X and
 * listens path Y while Installation B publishes Y and listens X) form a
 * dependency cycle this sort cannot see, because `listen` resolution is
 * delegated asynchronously to the operator {@link PlatformServiceResolver}
 * and the kernel keeps no Space-level dependency graph. Cross-Installation
 * ordering / cycle safety is therefore an operator / account-plane
 * responsibility; this function is NOT full dependency-cycle protection.
 */
function topologicalOrder(appSpec: AppSpec): readonly string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (node: string, stack: string[]) => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      const cycleStart = stack.indexOf(node);
      throw new InstallerPipelineError(
        "failed_precondition",
        `connect cycle detected: ${
          stack.slice(cycleStart).join(" → ")
        } → ${node}`,
      );
    }
    visiting.add(node);
    stack.push(node);
    const connect = appSpec.components[node]?.connect;
    if (connect) {
      for (const [bindingName, options] of Object.entries(connect)) {
        const [publisher] = options.output.split(".");
        if (publisher === undefined || !(publisher in appSpec.components)) {
          throw new InstallerPipelineError(
            "failed_precondition",
            `${node}.connect.${bindingName}.output refers to unknown ` +
              `component output ${JSON.stringify(options.output)}`,
          );
        }
        if (publisher === node) {
          throw new InstallerPipelineError(
            "failed_precondition",
            `${node} connects to its own output ` +
              `(${
                JSON.stringify(options.output)
              }); self-loops are not permitted`,
          );
        }
        visit(publisher, stack);
      }
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    order.push(node);
  };

  for (const name of Object.keys(appSpec.components)) {
    visit(name, []);
  }
  return order;
}

function checkExpectedPin(
  expected: SourcePin | undefined,
  source: SourceSummary,
  manifestDigest: string,
): void {
  if (!expected) return;
  validateExpectedPinShape(expected, source.kind);
  if (expected.manifestDigest !== manifestDigest) {
    throw new InstallerPipelineError(
      "failed_precondition",
      `expected manifestDigest ${expected.manifestDigest} but source resolved to ${manifestDigest}`,
    );
  }
  if (expected.commit && source.commit && expected.commit !== source.commit) {
    throw new InstallerPipelineError(
      "failed_precondition",
      `expected commit ${expected.commit} but source resolved to ${source.commit}`,
    );
  }
  if (expected.sourceDigest && expected.sourceDigest !== source.digest) {
    throw new InstallerPipelineError(
      "failed_precondition",
      `expected sourceDigest ${expected.sourceDigest} but source resolved to ${
        source.digest ?? "<none>"
      }`,
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
  if (sourceKind === "git") {
    if (expected.commit === undefined || expected.sourceDigest !== undefined) {
      throw new InstallerPipelineError(
        "invalid_argument",
        "git source expected guard must include expected.commit and must not include expected.sourceDigest",
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
      "local source expected guard must include only expected.manifestDigest",
    );
  }
}

function validateSourceDescriptor(source: Source): void {
  const raw = source as unknown as Record<string, unknown>;
  if (!isRecord(raw)) {
    throw new InstallerPipelineError(
      "invalid_argument",
      "source must be an object",
    );
  }
  if (
    source.kind !== "git" &&
    source.kind !== "prepared" &&
    source.kind !== "local"
  ) {
    throw new InstallerPipelineError(
      "invalid_argument",
      `source.kind must be one of git, prepared, or local`,
    );
  }
  rejectUnknownSourceFields(raw, allowedSourceKeys(source.kind));
  if (source.kind === "git") {
    if (source.ref === undefined || source.ref.length === 0) {
      throw new InstallerPipelineError(
        "invalid_argument",
        "git source must include source.ref",
      );
    }
    if (source.digest !== undefined) {
      throw new InstallerPipelineError(
        "invalid_argument",
        "git source must not include source.digest",
      );
    }
    if (source.commit !== undefined) {
      throw new InstallerPipelineError(
        "invalid_argument",
        "git source must not include source.commit",
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
    if (source.digest === undefined || source.digest.length === 0) {
      throw new InstallerPipelineError(
        "invalid_argument",
        "prepared source must include source.digest",
      );
    }
    if (source.ref !== undefined) {
      throw new InstallerPipelineError(
        "invalid_argument",
        "prepared source must not include source.ref",
      );
    }
  }
  if (source.kind === "local") {
    if (source.ref !== undefined) {
      throw new InstallerPipelineError(
        "invalid_argument",
        "local source must not include source.ref",
      );
    }
    if (source.digest !== undefined) {
      throw new InstallerPipelineError(
        "invalid_argument",
        "local source must not include source.digest",
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
  if (message.includes("digest mismatch")) {
    return "failed_precondition";
  }
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

/**
 * Resolve a `source.url: <relative-or-absolute>` against the configured
 * `localSourceRoot`. Rejects with a closed-envelope `invalid_argument` error
 * when the resolved path escapes the jail root (e.g. `../etc/passwd`).
 *
 * The check is purely lexical (`..` collapsing + prefix comparison); we do
 * not follow symlinks here. Operators that need stricter isolation should
 * mount the jail root on a path without symlinks pointing outside it.
 */
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
