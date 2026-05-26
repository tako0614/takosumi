/**
 * KernelPlugin — the reference Takosumi kernel's Vite-style plain-array
 * materializer API for the local publication / listen material model.
 *
 * A `KernelPlugin` advertises one or more component kind URIs in `provides`,
 * may expose short-name `aliases` for operator tooling,
 * materializes those components via `apply()`, publishes the resulting
 * material to the publication registry via `publishMaterial()`, and surfaces
 * listened materials into the component runtime via `applyListen()`.
 *
 * The reference implementation wires plugins as a plain array to
 * `createPaaSApp({ kindAliases, plugins })`, matching the Vite plugin
 * authoring experience. A Takosumi-compatible implementation can bind the
 * same kind URI to materialization code through another mechanism. The kind
 * URI remains the coupling point between AppSpec and implementation.
 *
 * # Materializer abstraction
 *
 * A `KernelPlugin` is one packaging of a more general concept: a
 * **Materializer** is any code that turns a kind URI into a concrete
 * resource and emits / consumes materials. Inline functions and
 * operator-defined raw code can attach to the same kernel surface as
 * full plugins via {@link InlineMaterializer}.
 */
import type {
  BindingName,
  Component,
  ListenOptions,
  ListenSourceRef,
  PublicationName,
  PublishOptions,
} from "./app-spec.ts";
import type {
  Deployment,
  Installation,
  SourceSummary,
} from "./installer-api.ts";
import type { JsonValue } from "./types.ts";

export interface KernelPlugin {
  /** Plugin id, e.g. `"@takos/takosumi-kind-cloudflare-worker"`. */
  readonly name: string;
  readonly version: string;
  /**
   * Operator-resolved kind URIs this plugin can materialize.
   * The installer resolves `Component.kind` through the operator alias map
   * and matches the resulting URI against `provides[]` during `apply`.
   * JSON-LD is the takosumi.com reference descriptor metadata format, not a
   * required authority for every implementation.
   *
   * Examples:
   *   - `["https://takosumi.com/kinds/v1/worker"]` (takosumi.com reference descriptor)
   *   - `["https://operator.example.com/kinds/lambda"]` (operator-defined)
   */
  readonly provides: readonly string[];

  /**
   * Short-name aliases a distribution may expose for `Component.kind` in
   * addition to the canonical URIs in `provides[]`. Alias resolution is an
   * operator-owned map from author-friendly names to kind URIs.
   */
  readonly aliases?: readonly string[];

  /**
   * Free-form capability tags for operator introspection. Not interpreted
   * by the reference adapter API — surface them via tooling / dashboards if
   * useful.
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
   * Compute the {@link NamespaceMaterial} this component publishes through a
   * declared local publication. Invoked once per entry in `Component.publish`
   * after `apply()` succeeds; the returned material is registered under
   * `<componentName>.<publicationName>`.
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
 * participates in the publication/listen material registry. {@link KernelPlugin} is
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
  /** Optional short-name aliases supplied by operator tooling / alias maps. */
  readonly aliases?: readonly string[];
  apply(ctx: KernelPluginApplyContext): Promise<KernelPluginApplyResult>;
  publishMaterial?(
    ctx: PublishMaterialContext,
  ): Promise<NamespaceMaterial>;
  applyListen?(ctx: ApplyListenContext): Promise<EnvInjection>;
}

/**
 * Payload published through a local publication. Keys are material field names
 * (e.g. `targets`, `endpoints`, `host`) and values are non-secret JSON
 * material values or `{ secretRef }` references to entries in the operator
 * secret store.
 *
 * Treated as opaque by the kernel; consumers (= listening plugins'
 * `applyListen`) interpret the payload through the source material contract,
 * operator descriptor metadata, and implementation binding. JSON-LD is the
 * takosumi.com reference metadata form when an operator chooses to use it.
 */
export type NamespaceMaterial = Readonly<
  Record<string, JsonValue | { readonly secretRef: string }>
>;

/**
 * Result of `applyListen()`: the env / mount / target descriptor the
 * installer should attach to the listening component runtime.
 *
 *   - `env`    — env-var injections (literal strings or secretRefs).
 *   - `mounts` — filesystem-mount descriptors keyed by mount path.
 *   - `target` — free-form target descriptor used by router-style kinds
 *                (e.g. gateway-style materializers read an `http-endpoint`
 *                target or endpoint).
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
  readonly bindingName: BindingName;
  readonly sourceRef: ListenSourceRef;
  readonly options: ListenOptions;
  readonly envInjections: Readonly<
    Record<string, string | { readonly secretRef: string }>
  >;
  readonly mounts?: Readonly<
    Record<string, string | { readonly secretRef: string }>
  >;
  readonly target?: NamespaceMaterial;
  /** The raw material payload resolved from the source reference. */
  readonly material: NamespaceMaterial;
}

export interface KernelPluginApplyContext {
  readonly installationId: string;
  readonly componentName: string;
  readonly component: Component;
  /** Source summary for this Deployment, including prepared source digest when available. */
  readonly source: SourceSummary;
  /** Local directory containing the already-prepared source snapshot. */
  readonly sourceDirectory: string;
  /**
   * Materials this component listens to, keyed by the local binding name as
   * declared in `Component.listen`. Pre-resolved by the installer from
   * local publications or Space-visible external publications; the listening plugin's
   * `applyListen` has
   * already been invoked and the resulting env / mount / target
   * descriptors are merged into the runtime environment.
   *
   * This map is for plugins that need access to the raw material payload
   * (e.g. to inspect specific fields beyond what `applyListen` emitted).
   */
  readonly listenedMaterials: Readonly<
    Record<BindingName, NamespaceMaterial>
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
   * Backend-side resource handle. The kernel treats it as opaque
   * implementation evidence and passes it back to `destroy()` when needed.
   */
  readonly resourceHandle: string;
  /**
   * Outputs persisted on Deployment evidence and surfaced to the material
   * registry via subsequent `publishMaterial()` calls. Plugins may return any
   * JSON-valued map; the keys typically match the kind descriptor's
   * `outputs[].name`.
   */
  readonly outputs: Readonly<Record<string, JsonValue>>;
}

export interface PublishMaterialContext {
  readonly installationId: string;
  readonly componentName: string;
  readonly component: Component;
  /** Local publication this material is being published through. */
  readonly publicationName: PublicationName;
  /** Per-publication options as declared in AppSpec. */
  readonly options: PublishOptions;
  /** Outputs from the preceding `apply()` call for this component. */
  readonly outputs: Readonly<Record<string, JsonValue>>;
}

export interface ApplyListenContext {
  readonly installationId: string;
  /** Name of the listening component (= the consumer). */
  readonly componentName: string;
  readonly component: Component;
  /** Local binding name being resolved. */
  readonly bindingName: BindingName;
  /** Source publication or external publication path being listened to. */
  readonly sourceRef: ListenSourceRef;
  /** Per-listen options as declared in AppSpec. */
  readonly options: ListenOptions;
  /** Material payload resolved from the source reference. */
  readonly material: NamespaceMaterial;
}

export interface KernelPluginDestroyContext {
  readonly installationId: string;
  readonly componentName: string;
  readonly resourceHandle: string;
}

export interface KernelPluginInstallationContext {
  readonly installation: Installation;
  readonly deployment?: Deployment;
}

export interface KernelPluginDeploymentContext {
  readonly installation: Installation;
  readonly deployment: Deployment;
}
