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
  AppSpec,
  Component,
  ListenSourceRef,
  PublicationName,
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
import type { NamespaceMaterial } from "takosumi-contract/reference/plugin";
import {
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
import { BindingResolver, type ResolvedBinding } from "../binding/mod.ts";
import {
  type DeploymentStore,
  InMemoryDeploymentStore,
  InMemoryInstallationStore,
  type InstallationStore,
} from "./store.ts";

/**
 * Apply context passed to {@link InstallerProviderRegistry.apply}. The
 * canonical adapter, {@link installerProviderRegistryFromPlugins}, derives
 * one of these from each `Component` and forwards it to the plugin
 * resolved via `provides[]`.
 *
 * The local publication registry is materialized at apply time;
 * `listenedMaterials` carries the resolved upstream material payload for
 * each binding the component listens to.
 */
export interface ProviderApplyContext {
  readonly installationId: string;
  readonly componentName: string;
  readonly component: Component;
  readonly source: SourceSummary;
  readonly sourceDirectory: string;
  /**
   * Materials this component listens to, keyed by the local binding name as
   * declared in `Component.listen`. Pre-resolved by the installer from
   * local publications or external publication paths; the listener's
   * `applyListen` (or the kernel
   * default) has already emitted env / mount / target descriptors before
   * the plugin's `apply` is called.
   */
  readonly listenedMaterials: Readonly<
    Record<string, NamespaceMaterial>
  >;
  /**
   * Env / mount / target descriptors produced by `applyListen` for each
   * listen edge. Plugins may inspect these to apply runtime injection;
   * the descriptors are also persisted on the Deployment outputs.
   */
  readonly resolvedBindings: readonly ResolvedBinding[];
}

export interface ProviderApplyResult {
  readonly resource: ProviderResourceEvidence;
  /**
   * Outputs the plugin emits. Declared publications are projected into
   * namespace material by the component kind's materializer.
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

export interface ExternalPublicationResolveContext {
  readonly installationId: string;
  readonly spaceId: string;
  readonly appId: string;
  readonly componentName: string;
  readonly component: Component;
  readonly bindingName: string;
  readonly sourceRef: string;
}

export interface ExternalPublicationResolver {
  resolve(
    context: ExternalPublicationResolveContext,
  ): Promise<NamespaceMaterial | undefined> | NamespaceMaterial | undefined;
}

export interface InstallerPipelineDependencies {
  readonly installations?: InstallationStore;
  readonly deployments?: DeploymentStore;
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
   * Operator-owned resolver for Space-visible external publication paths such
   * as `operator.identity.oidc`. The kernel treats the returned material like
   * any other listened material; it does not assign special meaning to the
   * path.
   */
  readonly externalPublications?: ExternalPublicationResolver;
  /** Defaults to `crypto.randomUUID()`-based id generation. */
  readonly newId?: (prefix: string) => string;
  /** Defaults to `Date.now()`. */
  readonly now?: () => number;
  /**
   * Working tree base for `source.kind: "local"`. When unset, local sources
   * must supply `source.url` as an absolute path.
   */
  readonly localSourceRoot?: string;
}

export class InstallerPipeline {
  readonly #installations: InstallationStore;
  readonly #deployments: DeploymentStore;
  readonly #providers: InstallerProviderRegistry;
  readonly #plugins: readonly KernelPlugin[];
  readonly #pluginRegistry: KernelPluginRegistry;
  readonly #externalPublications?: ExternalPublicationResolver;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #localSourceRoot?: string;
  constructor(dependencies: InstallerPipelineDependencies = {}) {
    this.#installations = dependencies.installations ??
      new InMemoryInstallationStore();
    this.#deployments = dependencies.deployments ??
      new InMemoryDeploymentStore();
    this.#plugins = dependencies.plugins ?? [];
    this.#pluginRegistry = createKernelPluginRegistry(this.#plugins, {
      kindAliases: dependencies.kindAliases,
    });
    this.#providers = dependencies.providers ??
      (dependencies.plugins && dependencies.plugins.length > 0
        ? installerProviderRegistryFromPluginRegistry(this.#pluginRegistry)
        : new NoopProviderRegistry());
    this.#externalPublications = dependencies.externalPublications;
    this.#newId = dependencies.newId ??
      ((prefix: string) =>
        `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`);
    this.#now = dependencies.now ?? (() => Date.now());
    this.#localSourceRoot = dependencies.localSourceRoot;
  }

  /**
   * Compute the {@link NamespaceMaterial} for a single local publication.
   * Delegates to the plugin's `publishMaterial` hook when present; the
   * fallback is intentionally narrow and never selects arbitrary output paths.
   */
  async #publishMaterial(ctx: {
    readonly installationId: string;
    readonly componentName: string;
    readonly component: Component;
    readonly publicationName: PublicationName;
    readonly options: PublishOptions;
    readonly outputs: Readonly<Record<string, JsonValue>>;
  }): Promise<NamespaceMaterial> {
    const plugin = findPluginForKind(this.#pluginRegistry, ctx.component.kind);
    if (plugin && typeof plugin.publishMaterial === "function") {
      return await plugin.publishMaterial({
        installationId: ctx.installationId,
        componentName: ctx.componentName,
        component: ctx.component,
        publicationName: ctx.publicationName,
        options: ctx.options,
        outputs: ctx.outputs,
      });
    }
    return defaultPublishedMaterial(
      ctx.publicationName,
      ctx.outputs,
    );
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
    let deployment: Deployment;
    try {
      const { appSpec, manifestDigest } = await readAppSpec(
        fetched.workingDirectory,
      );
      const sourceSummary = summarizeSource(request.source, fetched);
      checkExpectedPin(request.expected, sourceSummary, manifestDigest);

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

  async deploymentApply(
    installationId: string,
    request: DeploymentApplyRequest,
  ): Promise<DeploymentApplyResponse> {
    const installation = await this.#requireInstallation(installationId);
    checkExpectedCurrentDeploymentId(request.expected, installation);
    const source = request.source ??
      await this.#sourceFromInstallation(installation);
    const fetched = await this.#fetchSource(source);
    let deployment: Deployment;
    try {
      const { appSpec, manifestDigest } = await readAppSpec(
        fetched.workingDirectory,
      );
      const sourceSummary = summarizeSource(source, fetched);
      checkExpectedPin(request.expected, sourceSummary, manifestDigest);
      deployment = await this.#runDeployment({
        installation,
        appSpec,
        manifestDigest,
        sourceSummary,
        workingDirectory: fetched.workingDirectory,
      });
      await this.#installations.patch(installation.id, {
        currentDeploymentId: deployment.id,
        status: deployment.status === "succeeded" ? "ready" : "failed",
      });
    } finally {
      await fetched.cleanup();
    }
    return { deployment };
  }

  async rollback(
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
    const rolledBackFrom = installation.currentDeploymentId;
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
    return {
      installation: updatedInstallation,
      deployment: previous,
      rollback: {
        rolledBackFrom,
        rolledBackTo: previous.id,
      },
    };
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

    // Material registry — single Installation-scoped store used for local
    // publications (`component.publication`) and external publication refs
    // (`publisher.area.name`). Built incrementally as each component applies in
    // topological order.
    const registry = new MaterialRegistry();
    const resolver = new BindingResolver({
      findMaterializer: (kind) => {
        if (!kind) return undefined;
        return findPluginForKind(this.#pluginRegistry, kind);
      },
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

    try {
      const order = topologicalOrder(input.appSpec);
      for (const componentName of order) {
        const component = input.appSpec.components[componentName];
        // Resolve listen bindings against the current registry. External
        // publication refs with no registered material are skipped unless the
        // AppSpec marks that binding as required; local refs are parser-
        // validated and must be present by topology.
        const listenedMaterials: Record<string, NamespaceMaterial> = {};
        const resolvedBindings: ResolvedBinding[] = [];
        if (component.listen) {
          for (
            const [bindingName, options] of Object.entries(component.listen)
          ) {
            const sourceRef = options.from;
            const material = registry.get(sourceRef) ??
              await this.#resolveExternalPublication({
                installation: input.installation,
                componentName,
                component,
                bindingName,
                sourceRef,
                registry,
              });
            if (!material) {
              if (
                isExternalPublicationRef(sourceRef) && options.required !== true
              ) {
                continue;
              }
              throw new InstallerPipelineError(
                isExternalPublicationRef(sourceRef)
                  ? "not_implemented"
                  : "invalid_argument",
                `${componentName}.listen.${bindingName}.from refers to ` +
                  `unresolved publication ${JSON.stringify(sourceRef)}`,
              );
            }
            const binding = await resolver.resolveEdge({
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

        const applied = await this.#providers.apply({
          installationId: input.installation.id,
          componentName,
          component,
          source: input.sourceSummary,
          sourceDirectory: input.workingDirectory,
          listenedMaterials,
          resolvedBindings,
        });
        // Publish flow: register material only for declared local
        // publications. There is no automatic external publication.
        for (
          const [publicationName, publishOptions] of Object.entries(
            component.publish ?? {},
          )
        ) {
          const publicationRef = localPublicationRef(
            componentName,
            publicationName,
          );
          const material = await this.#publishMaterial({
            installationId: input.installation.id,
            componentName,
            component,
            publicationName,
            options: publishOptions,
            outputs: applied.outputs,
          });
          registry.publish(publicationRef, componentName, material);
          componentOutputs[componentName] ??= {};
          componentOutputs[componentName][publicationName] =
            materialToDeploymentOutput(material);
        }
      }
      const outputs: DeploymentOutputs = {
        components: Object.keys(componentOutputs).length === 0
          ? undefined
          : componentOutputs,
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
      // After-apply hook: errors do not roll back the Deployment.
      await this.#fireDeploymentHook("onDeploymentComplete", {
        installation: input.installation,
        deployment: persisted,
      }, { swallowErrors: true });
      return persisted;
    } catch (err) {
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
        },
        createdAt: now,
      };
      await this.#deployments.put(failed);
      throw err;
    }
  }

  async #resolveExternalPublication(input: {
    readonly installation: Installation;
    readonly componentName: string;
    readonly component: Component;
    readonly bindingName: string;
    readonly sourceRef: string;
    readonly registry: MaterialRegistry;
  }): Promise<NamespaceMaterial | undefined> {
    if (!isExternalPublicationRef(input.sourceRef)) return undefined;
    if (!this.#externalPublications) return undefined;
    let material: NamespaceMaterial | undefined;
    try {
      material = await this.#externalPublications.resolve({
        installationId: input.installation.id,
        spaceId: input.installation.spaceId,
        appId: input.installation.appId,
        componentName: input.componentName,
        component: input.component,
        bindingName: input.bindingName,
        sourceRef: input.sourceRef,
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new InstallerPipelineError(
        "failed_precondition",
        `failed to resolve external publication ${
          JSON.stringify(input.sourceRef)
        }: ${cause}`,
      );
    }
    if (material === undefined) return undefined;
    if (!isNamespaceMaterial(material)) {
      throw new InstallerPipelineError(
        "failed_precondition",
        `external publication ${JSON.stringify(input.sourceRef)} returned ` +
          "invalid material",
      );
    }
    input.registry.publishExternal(input.sourceRef, material);
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
      const root = source.url ?? this.#localSourceRoot;
      if (!root) {
        throw new InstallerPipelineError(
          "invalid_argument",
          "local source requires source.url or a configured localSourceRoot",
        );
      }
      return {
        workingDirectory: root,
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
      const result = await fetchGitSource({
        url: source.url,
        ref: source.ref,
      });
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
        });
        return {
          workingDirectory: result.workingDirectory,
          sourceDigest: result.digest,
          cleanup: result.cleanup,
        };
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new InstallerPipelineError(
          "failed_precondition",
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
      const result = await plugin.apply({
        installationId: context.installationId,
        componentName: context.componentName,
        component: context.component,
        source: context.source,
        sourceDirectory: context.sourceDirectory,
        listenedMaterials: context.listenedMaterials,
        resolvedBindings: context.resolvedBindings,
      });
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
 * In-memory material registry — owns the (source ref → publisher / material)
 * map for one Deployment apply. Local publications use
 * `component.publication`; external publication refs use `publisher.area.name`
 * when an operator pre-populates them.
 */
class MaterialRegistry {
  readonly #materials = new Map<string, NamespaceMaterial>();
  readonly #publishers = new Map<string, string>();

  publish(
    sourceRef: string,
    publisher: string,
    material: NamespaceMaterial,
  ): void {
    const existing = this.#publishers.get(sourceRef);
    if (existing !== undefined && existing !== publisher) {
      throw new InstallerPipelineError(
        "failed_precondition",
        `publication ${JSON.stringify(sourceRef)} is already ` +
          `published by ${JSON.stringify(existing)}; cannot republish from ` +
          JSON.stringify(publisher),
      );
    }
    this.#publishers.set(sourceRef, publisher);
    this.#materials.set(sourceRef, material);
  }

  publishExternal(
    sourceRef: string,
    material: NamespaceMaterial,
  ): void {
    this.#materials.set(sourceRef, material);
  }

  get(sourceRef: string): NamespaceMaterial | undefined {
    return this.#materials.get(sourceRef);
  }

  snapshot(): Readonly<Record<string, NamespaceMaterial>> {
    return Object.fromEntries(this.#materials.entries());
  }
}

function localPublicationRef(
  componentName: string,
  publicationName: string,
): string {
  return `${componentName}.${publicationName}`;
}

function defaultPublishedMaterial(
  publicationName: PublicationName,
  outputs: Readonly<Record<string, JsonValue>>,
): NamespaceMaterial {
  if (Object.keys(outputs).length === 0) return {};
  const selected = outputs[publicationName];
  if (selected !== undefined) {
    return { [publicationName]: selected };
  }
  throw new InstallerPipelineError(
    "failed_precondition",
    `publish.${publicationName} requires the component materializer to ` +
      `project provider outputs into namespace material`,
  );
}

function materialToDeploymentOutput(
  material: NamespaceMaterial,
): Readonly<Record<string, JsonValue>> {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(material)) {
    output[key] = isSecretRefMaterial(value)
      ? { secretRef: value.secretRef }
      : value;
  }
  return output;
}

function isSecretRefMaterial(
  value: NamespaceMaterial[string],
): value is { readonly secretRef: string } {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    typeof value.secretRef === "string";
}

function isNamespaceMaterial(value: unknown): value is NamespaceMaterial {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value);
}

function isExternalPublicationRef(value: ListenSourceRef): boolean {
  const segments = value.split(".");
  if (segments.length < 3 || segments.length > 8) return false;
  return segments.every((segment, index) =>
    isValidPublicationSegment(segment) &&
    (segment !== "default" || index === segments.length - 1)
  );
}

function isValidPublicationSegment(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,62}$/.test(value);
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
  const appSpec = parseAppSpec(bytes);
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
    url: source.url,
    ref: source.ref,
    commit: fetched.commit,
    digest: fetched.sourceDigest ?? source.digest,
  };
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

function topologicalOrder(appSpec: AppSpec): readonly string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  // Build a publisher index. The yaml-parser has already rejected cycles
  // and unknown local refs; the installer re-checks at runtime so a
  // pre-parsed AppSpec from a non-canonical source still surfaces a precise
  // diagnostic.
  const publisherByRef = new Map<string, string>();
  for (const [name, component] of Object.entries(appSpec.components)) {
    if (!component.publish) continue;
    for (const publicationName of Object.keys(component.publish)) {
      publisherByRef.set(localPublicationRef(name, publicationName), name);
    }
  }

  const visit = (node: string, stack: string[]) => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      const cycleStart = stack.indexOf(node);
      throw new InstallerPipelineError(
        "failed_precondition",
        `publish/listen cycle detected: ${
          stack.slice(cycleStart).join(" → ")
        } → ${node}`,
      );
    }
    visiting.add(node);
    stack.push(node);
    const listen = appSpec.components[node]?.listen;
    if (listen) {
      for (const [bindingName, options] of Object.entries(listen)) {
        const from = options.from;
        if (isExternalPublicationRef(from)) continue;
        const publisher = publisherByRef.get(from);
        if (publisher === undefined) {
          throw new InstallerPipelineError(
            "failed_precondition",
            `${node}.listen.${bindingName}.from refers to unknown ` +
              `publication ${JSON.stringify(from)}`,
          );
        }
        if (publisher === node) {
          throw new InstallerPipelineError(
            "failed_precondition",
            `${node} listens to its own publication ` +
              `(${JSON.stringify(from)}); self-loops are not permitted`,
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
