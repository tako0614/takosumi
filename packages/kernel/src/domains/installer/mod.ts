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
 *        - runs component.build
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

import type { KernelPlugin } from "takosumi-contract";
import type { AppSpec, Component } from "takosumi-contract/app-spec";
import type {
  ChangeEntry,
  Deployment,
  DeploymentApplyRequest,
  DeploymentApplyResponse,
  DeploymentBuildArtifact,
  DeploymentDryRunRequest,
  DeploymentDryRunResponse,
  DeploymentOutputs,
  DeploymentResource,
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
import type { NamespaceMaterial } from "takosumi-contract/plugin";
import { fetchGitSource, parseAppSpec } from "takosumi-installer";
import {
  createKernelPluginRegistry,
  findPluginForKind,
  type KernelPluginRegistry,
} from "../../plugins/mod.ts";
import { log } from "../../shared/log.ts";
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
 * Phase C: the namespace pub/sub registry is materialized at apply time;
 * `listenedMaterials` carries the resolved upstream material payload for
 * each path the component listens to.
 */
export interface ProviderApplyContext {
  readonly installationId: string;
  readonly componentName: string;
  readonly component: Component;
  readonly buildOutput?: DeploymentBuildArtifact;
  /**
   * Materials this component listens to, keyed by the namespace path as
   * declared in `Component.listen`. Pre-resolved by the installer from
   * the pub/sub registry; the listener's `applyListen` (or the kernel
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
  readonly resource: DeploymentResource;
  /**
   * Outputs the plugin emits — surfaced as the input to
   * {@link NamespaceMaterial} construction in
   * `KernelPlugin.publishMaterial` (or the kernel default that registers
   * `outputs` verbatim).
   */
  readonly outputs: Readonly<Record<string, string>>;
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
   * Build runner — invoked when a component declares `component.build`.
   * Defaults to spawning `Deno.Command` with the recipe `command` in the
   * source working directory and pinning the resulting `output` artifact
   * with a sha256 digest of its bytes.
   */
  readonly runBuild?: (input: BuildRunnerInput) => Promise<BuildRunnerResult>;
  /** Cost estimator — defaults to a placeholder `0 JPY/month` value. */
  readonly estimateCost?: (
    appSpec: AppSpec,
  ) => { readonly currency: string; readonly monthly: number };
}

export interface BuildRunnerInput {
  readonly workingDirectory: string;
  readonly componentName: string;
  readonly command: string;
  readonly outputPath: string;
}

export interface BuildRunnerResult {
  readonly digest: string;
  readonly uri: string;
}

export class InstallerPipeline {
  readonly #installations: InstallationStore;
  readonly #deployments: DeploymentStore;
  readonly #providers: InstallerProviderRegistry;
  readonly #plugins: readonly KernelPlugin[];
  readonly #pluginRegistry: KernelPluginRegistry;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #localSourceRoot?: string;
  readonly #runBuild: (input: BuildRunnerInput) => Promise<BuildRunnerResult>;
  readonly #estimateCost: (
    appSpec: AppSpec,
  ) => { readonly currency: string; readonly monthly: number };

  constructor(dependencies: InstallerPipelineDependencies = {}) {
    this.#installations = dependencies.installations ??
      new InMemoryInstallationStore();
    this.#deployments = dependencies.deployments ??
      new InMemoryDeploymentStore();
    this.#plugins = dependencies.plugins ?? [];
    this.#pluginRegistry = createKernelPluginRegistry(this.#plugins);
    this.#providers = dependencies.providers ??
      (dependencies.plugins && dependencies.plugins.length > 0
        ? installerProviderRegistryFromPluginRegistry(this.#pluginRegistry)
        : new NoopProviderRegistry());
    this.#newId = dependencies.newId ??
      ((prefix: string) =>
        `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`);
    this.#now = dependencies.now ?? (() => Date.now());
    this.#localSourceRoot = dependencies.localSourceRoot;
    this.#runBuild = dependencies.runBuild ?? defaultRunBuild;
    this.#estimateCost = dependencies.estimateCost ??
      (() => ({ currency: "JPY", monthly: 0 }));
  }

  /**
   * Compute the {@link NamespaceMaterial} for a single publish edge.
   * Delegates to the plugin's `publishMaterial` hook when present;
   * otherwise the kernel default registers the plugin's `outputs` map
   * verbatim (every output value becomes a string-valued material
   * field).
   */
  async #publishMaterial(ctx: {
    readonly installationId: string;
    readonly componentName: string;
    readonly component: Component;
    readonly namespacePath: string;
    readonly outputs: Readonly<Record<string, string>>;
  }): Promise<NamespaceMaterial> {
    const plugin = findPluginForKind(this.#pluginRegistry, ctx.component.kind);
    if (plugin && typeof plugin.publishMaterial === "function") {
      return await plugin.publishMaterial({
        installationId: ctx.installationId,
        componentName: ctx.componentName,
        component: ctx.component,
        namespacePath: ctx.namespacePath,
        outputs: ctx.outputs,
      });
    }
    // Kernel default: surface plugin.outputs as the material payload.
    const material: Record<string, string> = {};
    for (const [key, value] of Object.entries(ctx.outputs)) {
      material[key] = value;
    }
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
        estimatedCost: this.#estimateCost(appSpec),
        expected: {
          commit: sourceSummary.commit ?? "",
          manifestDigest,
        },
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
        accountId: deriveAccountId(request.spaceId),
        spaceId: request.spaceId,
        appId: appSpec.metadata.id,
        currentDeploymentId: null,
        status: "running",
        createdAt: now,
      };
      await this.#installations.put(installation);

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
        status: deployment.status === "succeeded" ? "running" : "failed",
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
    return await this.installationDryRun({
      spaceId: installation.spaceId,
      source,
    });
  }

  async deploymentApply(
    installationId: string,
    request: DeploymentApplyRequest,
  ): Promise<DeploymentApplyResponse> {
    const installation = await this.#requireInstallation(installationId);
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
        status: deployment.status === "succeeded" ? "running" : "failed",
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
    const rollbackSource = sourceFromSummary(previous.source);
    const fetched = await this.#fetchSource(rollbackSource);
    let deployment: Deployment;
    try {
      const { appSpec, manifestDigest } = await readAppSpec(
        fetched.workingDirectory,
      );
      const sourceSummary = summarizeSource(rollbackSource, fetched);
      // Source digest must match the target deployment's manifestDigest;
      // otherwise the target source has drifted and rollback is unsafe.
      if (manifestDigest !== previous.manifestDigest) {
        throw new InstallerPipelineError(
          "failed_precondition",
          "source manifestDigest does not match target deployment; " +
            "source has drifted since the original deployment",
        );
      }
      const rolledBack = await this.#runDeployment({
        installation,
        appSpec,
        manifestDigest,
        sourceSummary,
        workingDirectory: fetched.workingDirectory,
      });
      deployment = {
        ...rolledBack,
        rolledBackFrom: installation.currentDeploymentId ?? undefined,
        rolledBackTo: previous.id,
      };
      await this.#deployments.put(deployment);
      await this.#installations.patch(installation.id, {
        currentDeploymentId: deployment.id,
        status: deployment.status === "succeeded" ? "running" : "failed",
      });
    } finally {
      await fetched.cleanup();
    }
    return { deployment };
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
    const builds: DeploymentBuildArtifact[] = [];
    const resources: DeploymentResource[] = [];

    // Namespace registry — single Installation-scoped pub/sub store used
    // for both publish (= component.publish + auto-namespace) and listen
    // (= component.listen) flows. Built incrementally as each component
    // applies in topological order.
    const registry = new NamespaceRegistry();
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
      const appId = input.appSpec.metadata.id;
      for (const componentName of order) {
        const component = input.appSpec.components[componentName];
        let buildArtifact: DeploymentBuildArtifact | undefined;
        if (component.build) {
          const built = await this.#runBuild({
            workingDirectory: input.workingDirectory,
            componentName,
            command: component.build.command,
            outputPath: component.build.output,
          });
          buildArtifact = {
            component: componentName,
            digest: built.digest,
            uri: built.uri,
          };
          builds.push(buildArtifact);
        }

        // Resolve listen edges against the current registry. Listens to
        // paths with no registered publisher are skipped here — they may
        // be supplied by external systems and surfaced via the plugin's
        // own machinery (e.g. an OIDC client provider that publishes to
        // a takosumi-accounts.* namespace).
        const listenedMaterials: Record<string, NamespaceMaterial> = {};
        const resolvedBindings: ResolvedBinding[] = [];
        if (component.listen) {
          for (const [nsPath, options] of Object.entries(component.listen)) {
            const material = registry.get(nsPath);
            if (!material) continue;
            const binding = await resolver.resolveEdge({
              installationId: input.installation.id,
              listenerComponent: componentName,
              listenerKind: component.kind,
              listenerComponentRef: component,
              namespacePath: nsPath,
              options,
              material,
            });
            listenedMaterials[nsPath] = material;
            resolvedBindings.push(binding);
          }
        }

        const applied = await this.#providers.apply({
          installationId: input.installation.id,
          componentName,
          component,
          buildOutput: buildArtifact,
          listenedMaterials,
          resolvedBindings,
        });
        resources.push(applied.resource);

        // Publish flow: register material to (a) the auto-namespace
        // `<app-id>.<component-name>` and (b) any explicit `publish:`
        // entries on the component. If a KernelPlugin exposes
        // `publishMaterial`, call it once per path; otherwise the kernel
        // default materializes the plugin's `outputs` map verbatim.
        const publishPaths = collectPublishPaths(
          appId,
          componentName,
          component,
        );
        for (const nsPath of publishPaths) {
          const material = await this.#publishMaterial({
            installationId: input.installation.id,
            componentName,
            component,
            namespacePath: nsPath,
            outputs: applied.outputs,
          });
          registry.publish(nsPath, componentName, material);
        }
      }
      const outputs: DeploymentOutputs = {
        builds: builds.length === 0 ? undefined : builds,
        resources: resources.length === 0 ? undefined : resources,
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
          builds: builds.length === 0 ? undefined : builds,
          resources: resources.length === 0 ? undefined : resources,
        },
        createdAt: now,
      };
      await this.#deployments.put(failed);
      throw err;
    }
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
      if (current) return sourceFromSummary(current.source);
    }
    throw new InstallerPipelineError(
      "failed_precondition",
      "installation has no current deployment; supply a source explicitly",
    );
  }

  async #fetchSource(source: Source): Promise<FetchedSource> {
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
        commit: source.commit ?? "",
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
    throw new InstallerPipelineError(
      "not_implemented",
      `source.kind=${source.kind} is not yet supported`,
    );
  }
}

interface FetchedSource {
  readonly workingDirectory: string;
  readonly commit: string;
  readonly cleanup: () => Promise<void>;
}

class NoopProviderRegistry implements InstallerProviderRegistry {
  apply(context: ProviderApplyContext): Promise<ProviderApplyResult> {
    return Promise.resolve({
      resource: {
        component: context.componentName,
        kind: context.component.kind,
        provider: "noop",
        providerResourceId:
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
): InstallerProviderRegistry {
  return installerProviderRegistryFromPluginRegistry(
    createKernelPluginRegistry(plugins),
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
          "failed_precondition",
          `no kernel plugin advertises kind ${kind} (component ${context.componentName})`,
        );
      }
      const result = await plugin.apply({
        installationId: context.installationId,
        componentName: context.componentName,
        component: context.component,
        buildOutput: context.buildOutput
          ? {
            digest: context.buildOutput.digest,
            uri: context.buildOutput.uri,
          }
          : undefined,
        listenedMaterials: context.listenedMaterials,
      });
      return {
        resource: {
          component: context.componentName,
          kind: context.component.kind,
          provider: plugin.name,
          providerResourceId: result.providerResourceId,
        },
        outputs: result.outputs,
      };
    },
  };
}

/**
 * In-memory namespace registry — owns the (path → publisher / material)
 * map for one Deployment apply. Single-publisher invariant is enforced by
 * the AppSpec parser, but the registry guards against runtime duplicates
 * (e.g. operator plugins that register additional paths via plugin-side
 * publish hooks).
 */
class NamespaceRegistry {
  readonly #materials = new Map<string, NamespaceMaterial>();
  readonly #publishers = new Map<string, string>();

  publish(
    namespacePath: string,
    publisher: string,
    material: NamespaceMaterial,
  ): void {
    const existing = this.#publishers.get(namespacePath);
    if (existing !== undefined && existing !== publisher) {
      throw new InstallerPipelineError(
        "failed_precondition",
        `namespace path ${JSON.stringify(namespacePath)} is already ` +
          `published by ${JSON.stringify(existing)}; cannot republish from ` +
          JSON.stringify(publisher),
      );
    }
    this.#publishers.set(namespacePath, publisher);
    this.#materials.set(namespacePath, material);
  }

  get(namespacePath: string): NamespaceMaterial | undefined {
    return this.#materials.get(namespacePath);
  }

  snapshot(): Readonly<Record<string, NamespaceMaterial>> {
    return Object.fromEntries(this.#materials.entries());
  }
}

/**
 * Compute the set of namespace paths a component publishes to. The kernel
 * always auto-registers `<app-id>.<component-name>` so sibling listeners
 * can resolve the component without operator boilerplate, plus any
 * explicit `Component.publish` entries (deduplicated).
 */
function collectPublishPaths(
  appId: string,
  componentName: string,
  component: Component,
): readonly string[] {
  const autoPath = `${appId}.${componentName}`;
  const explicit = component.publish ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of [autoPath, ...explicit]) {
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
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
    bytes = await Deno.readFile(path);
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
    commit: fetched.commit || source.commit,
  };
}

function sourceFromSummary(summary: SourceSummary): Source {
  return {
    kind: summary.kind,
    url: summary.url,
    ref: summary.ref,
    commit: summary.commit,
  };
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

  // Build a publisher index. Two publisher kinds resolve here:
  //   1. Explicit `Component.publish` entries
  //   2. Kernel auto-namespace `<app-id>.<component-name>` (so sibling
  //      listens like `my-app.db` route to `my-app`'s `db` component
  //      without operator boilerplate).
  //
  // The yaml-parser has already rejected cycles and duplicate publishers
  // among explicit edges; the installer re-checks at runtime so a
  // pre-parsed AppSpec from a non-canonical source still surfaces a
  // precise diagnostic.
  const appId = appSpec.metadata.id;
  const publisherByPath = new Map<string, string>();
  for (const [name, component] of Object.entries(appSpec.components)) {
    publisherByPath.set(`${appId}.${name}`, name);
    if (!component.publish) continue;
    for (const nsPath of component.publish) {
      const prior = publisherByPath.get(nsPath);
      if (prior !== undefined && prior !== name) {
        throw new InstallerPipelineError(
          "failed_precondition",
          `namespace path ${JSON.stringify(nsPath)} is published by both ` +
            `${JSON.stringify(prior)} and ${JSON.stringify(name)}`,
        );
      }
      publisherByPath.set(nsPath, name);
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
      for (const nsPath of Object.keys(listen)) {
        const publisher = publisherByPath.get(nsPath);
        // External publisher (= no AppSpec component owns this path) is
        // a no-op edge in topology; the installer resolves such
        // materials from the registry directly (or skips when absent).
        if (publisher === undefined) continue;
        if (publisher === node) {
          throw new InstallerPipelineError(
            "failed_precondition",
            `${node} listens to a namespace path it publishes itself ` +
              `(${JSON.stringify(nsPath)}); self-loops are not permitted`,
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

function deriveAccountId(spaceId: string): string {
  // Wave 5 placeholder: real account resolution is the Takosumi Accounts
  // operator-plane responsibility; the kernel just echoes spaceId until
  // the account-resolver plug-point lands.
  return `acc_for_${spaceId}`;
}

function checkExpectedPin(
  expected: SourcePin | undefined,
  source: SourceSummary,
  manifestDigest: string,
): void {
  if (!expected) return;
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

async function defaultRunBuild(
  input: BuildRunnerInput,
): Promise<BuildRunnerResult> {
  const cmd = new Deno.Command("sh", {
    args: ["-c", input.command],
    cwd: input.workingDirectory,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  if (code !== 0) {
    throw new InstallerPipelineError(
      "internal_error",
      `build command for component ${input.componentName} failed: ${
        new TextDecoder().decode(stderr)
      }`,
    );
  }
  const outputPath = input.outputPath.startsWith("/")
    ? input.outputPath
    : `${input.workingDirectory.replace(/\/+$/, "")}/${input.outputPath}`;
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(outputPath);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new InstallerPipelineError(
      "internal_error",
      `build output ${outputPath} for component ${input.componentName} was not produced: ${cause}`,
    );
  }
  const digest = await sha256Hex(bytes);
  return { digest, uri: `file://${outputPath}` };
}
