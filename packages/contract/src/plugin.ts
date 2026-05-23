/**
 * KernelPlugin contract — Vite-style plain-array plugin API for the
 * namespace pub/sub material model.
 *
 * A `KernelPlugin` advertises one or more component kind URIs in `provides`,
 * may expose short-name `aliases` for operator tooling,
 * materializes those components via `apply()`, publishes the resulting
 * material to the pub/sub registry via `publishMaterial()`, and surfaces
 * listened materials into the component runtime via `applyListen()`.
 *
 * Operators supply plugins as a plain array to `createPaaSApp({ kindAliases, plugins })`,
 * matching the Vite plugin authoring experience: no class hierarchy, no
 * manifest discovery file, no port catalog. The kind URI is the only
 * coupling point between AppSpec and plugin, which preserves Takosumi's
 * "ソフトウェアの民主化" property — operators publish a JSON-LD kind and a
 * matching plugin, and they own the rest.
 *
 * # Materializer abstraction
 *
 * A `KernelPlugin` is one packaging of a more general concept: a
 * **Materializer** is any code that turns a kind URI into a concrete
 * resource and emits / consumes namespace materials. Inline functions and
 * operator-defined raw code can attach to the same kernel surface as
 * full plugins via {@link InlineMaterializer}.
 */
import type { Component, ListenOptions, NamespacePath } from "./app-spec.ts";
import type { Deployment, Installation } from "./installer-api.ts";

export interface KernelPlugin {
  /** Plugin id, e.g. `"@takos/cloudflare-workers"`. */
  readonly name: string;
  readonly version: string;
  /**
   * Canonical URIs of the component kinds this plugin can materialize.
   * Must match the `@id` of the corresponding JSON-LD kind document.
   * The installer resolves `Component.kind` against `provides[]` to pick
   * the plugin for each component during `apply`.
   *
   * Examples:
   *   - `["https://takosumi.com/kinds/v1/worker"]` (Takos reference registry)
   *   - `["https://operator.example.com/kinds/lambda"]` (operator-defined)
   */
  readonly provides: readonly string[];

  /**
   * Short-name aliases a distribution may expose for `Component.kind` in
   * addition to the canonical URIs in `provides[]`. Alias resolution is
   * operator-owned; the Takosumi contract does not define contract-owned aliases.
   */
  readonly aliases?: readonly string[];

  /**
   * Free-form capability tags for operator introspection. Not interpreted
   * by the kernel — surface them via tooling / dashboards if useful.
   */
  readonly capabilities?: readonly string[];

  /**
   * Materialize a component into a concrete resource on the target
   * runtime. Called by `InstallerPipeline` during `apply` in publish /
   * listen topological order. Listened materials are made available via
   * `listenedMaterials`.
   */
  apply(ctx: KernelPluginApplyContext): Promise<KernelPluginApplyResult>;

  /**
   * Destroy a previously-materialized component. Called on Installation
   * deletion / rollback. Optional — plugins that have no destroyable
   * state can omit this hook.
   */
  destroy?(ctx: KernelPluginDestroyContext): Promise<void>;

  /**
   * Compute the {@link NamespaceMaterial} this component publishes to a
   * declared namespace path. Invoked once per entry in
   * `Component.publish` after `apply()` succeeds; the returned material
   * is registered with the pub/sub registry under that path.
   *
   * Optional — kinds that do not publish any material (e.g. pure
   * consumers) may omit this hook.
   */
  publishMaterial?(
    ctx: PublishMaterialContext,
  ): Promise<NamespaceMaterial>;

  /**
   * Surface a listened {@link NamespaceMaterial} into the component
   * runtime as an env injection / mount / target descriptor. Invoked
   * once per entry in `Component.listen` before `apply()` is called for
   * the listening component.
   *
   * Optional — kinds that do not consume listened material may omit
   * this hook (the installer treats absent hooks as no-op).
   */
  applyListen?(ctx: ApplyListenContext): Promise<EnvInjection>;

  // ---------------------------------------------------------------------
  // Lifecycle hooks — Vite-style optional callbacks. All are awaited
  // serially across the plugin array in registration order.
  // ---------------------------------------------------------------------

  /** Fires before the first Deployment of a brand-new Installation. */
  onInstallStart?(ctx: KernelPluginInstallationContext): Promise<void>;
  /** Fires after the first Deployment of a brand-new Installation succeeds. */
  onInstallComplete?(ctx: KernelPluginInstallationContext): Promise<void>;
  /** Fires before every Deployment apply (including the first one). */
  onDeploymentStart?(ctx: KernelPluginDeploymentContext): Promise<void>;
  /** Fires after every successful Deployment apply. */
  onDeploymentComplete?(ctx: KernelPluginDeploymentContext): Promise<void>;
}

/**
 * Materializer = arbitrary code that materializes a kind URI and
 * participates in the pub/sub namespace registry. {@link KernelPlugin} is
 * the conventional packaging — `name` / `version` / lifecycle hooks — but
 * inline functions and operator-defined raw code can attach to the same
 * kernel surface via {@link InlineMaterializer}.
 */
export type Materializer = KernelPlugin | InlineMaterializer;

/**
 * Minimal materializer surface — the smallest contract the installer
 * recognizes. Useful for inline materializers in tests, examples, and
 * operator-defined raw code. A `KernelPlugin` is structurally a superset
 * of `InlineMaterializer`.
 */
export interface InlineMaterializer {
  /** Canonical kind URIs this materializer handles. */
  readonly provides: readonly string[];
  /** Optional short-name aliases (mirror of JSON-LD `aliases`). */
  readonly aliases?: readonly string[];
  apply(ctx: KernelPluginApplyContext): Promise<KernelPluginApplyResult>;
  publishMaterial?(
    ctx: PublishMaterialContext,
  ): Promise<NamespaceMaterial>;
  applyListen?(ctx: ApplyListenContext): Promise<EnvInjection>;
}

/**
 * Payload published to the namespace pub/sub registry. Keys are
 * material field names (e.g. `url`, `host`, `port`) and values are
 * either literal strings or `{ secretRef }` references to entries in
 * the operator secret store.
 *
 * Treated as opaque by the kernel; consumers (= listening plugins'
 * `applyListen`) interpret the payload according to the listened kind's
 * JSON-LD `publishes[].material` declaration.
 */
export type NamespaceMaterial = Readonly<
  Record<string, string | { readonly secretRef: string }>
>;

/**
 * Result of `applyListen()`: the env / mount / target descriptor the
 * installer should attach to the listening component runtime.
 *
 *   - `env`    — env-var injections (literal strings or secretRefs).
 *   - `mounts` — filesystem-mount descriptors keyed by mount path.
 *   - `target` — free-form target descriptor used by router-style kinds
 *                (e.g. `custom-domain` reads the worker's `url` field).
 *
 * All fields are optional; an empty `EnvInjection` is a valid no-op
 * (the installer will treat it as "this listener took no action").
 */
export interface EnvInjection {
  readonly env?: Readonly<
    Record<string, string | { readonly secretRef: string }>
  >;
  readonly mounts?: Readonly<
    Record<string, string | { readonly secretRef: string }>
  >;
  readonly target?: NamespaceMaterial;
}

export interface ResolvedListenBinding {
  readonly listenerComponent: string;
  readonly namespacePath: NamespacePath;
  readonly options: ListenOptions;
  readonly envInjections: Readonly<
    Record<string, string | { readonly secretRef: string }>
  >;
  readonly mounts?: Readonly<
    Record<string, string | { readonly secretRef: string }>
  >;
  readonly target?: NamespaceMaterial;
  /** The raw material payload as published to the namespace path. */
  readonly material: NamespaceMaterial;
}

export interface KernelPluginApplyContext {
  readonly installationId: string;
  readonly componentName: string;
  readonly component: Component;
  readonly buildOutput?: {
    readonly digest: string;
    readonly uri: string;
  };
  /**
   * Materials this component listens to, keyed by the namespace path as
   * declared in `Component.listen`. Pre-resolved by the installer from
   * the pub/sub registry; the listening plugin's `applyListen` has
   * already been invoked and the resulting env / mount / target
   * descriptors are merged into the runtime environment.
   *
   * This map is for plugins that need access to the raw material payload
   * (e.g. to inspect specific fields beyond what `applyListen` emitted).
   */
  readonly listenedMaterials: Readonly<
    Record<NamespacePath, NamespaceMaterial>
  >;
  /**
   * Env / mount / target descriptors produced by `applyListen` for each
   * listen edge. Native KernelPlugin implementations should use this field
   * when they need the actual runtime injection plan instead of raw materials.
   */
  readonly resolvedBindings: readonly ResolvedListenBinding[];
}

export interface KernelPluginApplyResult {
  /**
   * Provider-side resource identifier. Stored on the Deployment record so
   * the kernel can call `destroy()` later. Treated as opaque by the
   * kernel; format is plugin-defined.
   */
  readonly providerResourceId: string;
  /**
   * Outputs surfaced to the namespace pub/sub registry via subsequent
   * `publishMaterial()` calls. Plugins MAY return any string-valued
   * map; the keys typically match the kind's JSON-LD `outputs[].name`.
   */
  readonly outputs: Readonly<Record<string, string>>;
}

export interface PublishMaterialContext {
  readonly installationId: string;
  readonly componentName: string;
  readonly component: Component;
  /** Namespace path this material is being published to. */
  readonly namespacePath: NamespacePath;
  /** Outputs from the preceding `apply()` call for this component. */
  readonly outputs: Readonly<Record<string, string>>;
}

export interface ApplyListenContext {
  readonly installationId: string;
  /** Name of the listening component (= the consumer). */
  readonly componentName: string;
  readonly component: Component;
  /** Namespace path being listened to. */
  readonly namespacePath: NamespacePath;
  /** Per-listen options as declared in AppSpec. */
  readonly options: ListenOptions;
  /** Material payload as published to the namespace path. */
  readonly material: NamespaceMaterial;
}

export interface KernelPluginDestroyContext {
  readonly installationId: string;
  readonly componentName: string;
  readonly providerResourceId: string;
}

export interface KernelPluginInstallationContext {
  readonly installation: Installation;
  readonly deployment?: Deployment;
}

export interface KernelPluginDeploymentContext {
  readonly installation: Installation;
  readonly deployment: Deployment;
}
