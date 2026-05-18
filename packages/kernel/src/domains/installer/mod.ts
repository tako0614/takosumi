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
import { fetchGitSource, parseAppSpec } from "takosumi-installer";
import {
  createKernelPluginRegistry,
  findPluginForKind,
  type KernelPluginRegistry,
} from "../../plugins/mod.ts";
import { log } from "../../shared/log.ts";
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
 * Phase B: `upstreamOutputs` is a compile-only placeholder retained for
 * the legacy adapter shim until Phase C replaces the pipeline with the
 * namespace pub/sub registry (`listenedMaterials`).
 */
export interface ProviderApplyContext {
  readonly installationId: string;
  readonly componentName: string;
  readonly component: Component;
  readonly buildOutput?: DeploymentBuildArtifact;
  /**
   * Outputs from previously-applied components, keyed by component name.
   * Replaced by `listenedMaterials` in Phase C; retained as a placeholder
   * so the kernel pipeline compiles against the new contract.
   */
  readonly upstreamOutputs: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
}

export interface ProviderApplyResult {
  readonly resource: DeploymentResource;
  /**
   * Outputs the plugin emits to the namespace pub/sub registry (Phase B
   * model). Replaces the prior `use:` edge outputs.
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
    this.#providers = dependencies.providers ??
      (dependencies.plugins && dependencies.plugins.length > 0
        ? installerProviderRegistryFromPlugins(dependencies.plugins)
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
    const upstreamOutputs: Record<string, Record<string, string>> = {};

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
        const applied = await this.#providers.apply({
          installationId: input.installation.id,
          componentName,
          component,
          buildOutput: buildArtifact,
          upstreamOutputs: { ...upstreamOutputs },
        });
        resources.push(applied.resource);
        upstreamOutputs[componentName] = { ...applied.outputs };
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
  const registry: KernelPluginRegistry = createKernelPluginRegistry(plugins);
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
      // Phase B: the namespace pub/sub model replaces use-edge outputs with
      // pre-resolved listened materials. The placeholder shim below maps
      // `upstreamOutputs` into an empty `listenedMaterials` record; Phase C
      // will resolve `Component.listen` against the registry properly.
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
        listenedMaterials: {},
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

  // Phase B: build a publisher index so the topology walks publish/listen
  // edges (listener → publisher). The yaml-parser has already rejected
  // cycles and duplicate publishers, but we re-check here so the
  // installer also surfaces a precise diagnostic if it is handed a
  // pre-parsed AppSpec from a non-canonical source.
  const publisherByPath = new Map<string, string>();
  for (const [name, component] of Object.entries(appSpec.components)) {
    if (!component.publish) continue;
    for (const nsPath of component.publish) {
      publisherByPath.set(nsPath, name);
    }
  }

  const visit = (node: string) => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      throw new InstallerPipelineError(
        "failed_precondition",
        `publish/listen cycle detected at component ${node}`,
      );
    }
    visiting.add(node);
    const listen = appSpec.components[node]?.listen;
    if (listen) {
      for (const nsPath of Object.keys(listen)) {
        const publisher = publisherByPath.get(nsPath);
        // External publisher (= no AppSpec component owns this path) is
        // a no-op edge in topology; Phase C resolves the listened
        // material from the registry directly.
        if (publisher === undefined) continue;
        visit(publisher);
      }
    }
    visiting.delete(node);
    visited.add(node);
    order.push(node);
  };

  for (const name of Object.keys(appSpec.components)) {
    visit(name);
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
