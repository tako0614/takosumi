/**
 * KernelPlugin contract — Vite-style plain-array plugin API.
 *
 * A `KernelPlugin` advertises one or more component kind URIs in `provides`,
 * materializes those components via `apply()`, and may participate in the
 * Installation / Deployment lifecycle via optional hooks.
 *
 * Operators supply plugins as a plain array to `createPaaSApp({ plugins })`,
 * matching the Vite plugin authoring experience: no class hierarchy, no
 * manifest discovery file, no port catalog. The kind URI is the only
 * coupling point between AppSpec and plugin, which preserves Takosumi's
 * "ソフトウェアの民主化" property — operators publish a JSON-LD kind and a
 * matching plugin, and they own the rest.
 */
import type { Component } from "./app-spec.ts";
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
   *   - `["https://takosumi.com/kinds/v1/worker"]` (built-in)
   *   - `["https://operator.example.com/kinds/lambda"]` (operator-defined)
   */
  readonly provides: readonly string[];

  /**
   * Free-form capability tags for operator introspection. Not interpreted
   * by the kernel — surface them via tooling / dashboards if useful.
   */
  readonly capabilities?: readonly string[];

  /**
   * Materialize a component into a concrete resource on the target
   * runtime. Called by `InstallerPipeline` during `apply` in
   * use-edge topological order. Outputs are made available to
   * downstream components via `upstreamOutputs`.
   */
  apply(ctx: KernelPluginApplyContext): Promise<KernelPluginApplyResult>;

  /**
   * Destroy a previously-materialized component. Called on Installation
   * deletion / rollback. Optional — plugins that have no destroyable
   * state can omit this hook.
   */
  destroy?(ctx: KernelPluginDestroyContext): Promise<void>;

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

export interface KernelPluginApplyContext {
  readonly installationId: string;
  readonly componentName: string;
  readonly component: Component;
  readonly buildOutput?: {
    readonly digest: string;
    readonly uri: string;
  };
  /**
   * Outputs from upstream components (= components named on the `use:`
   * edges of the current component). Keyed by upstream component name,
   * then by output key.
   */
  readonly upstreamOutputs: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
}

export interface KernelPluginApplyResult {
  /**
   * Provider-side resource identifier. Stored on the Deployment record so
   * the kernel can call `destroy()` later. Treated as opaque by the
   * kernel; format is plugin-defined.
   */
  readonly providerResourceId: string;
  /**
   * Outputs surfaced to downstream components via `use:` edges. For an
   * `oidc` component this might be `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID`
   * etc.; for a `postgres` component this might be `host` / `port` /
   * `database` etc.
   */
  readonly outputs: Readonly<Record<string, string>>;
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
