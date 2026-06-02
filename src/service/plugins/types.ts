/**
 * Service-internal re-exports for the canonical `TakosumiPlugin` contract.
 *
 * The contract itself lives in `@takosjp/takosumi/contract/reference/plugin`. This
 * shim keeps existing service imports stable and adds the service-internal
 * `TakosumiPluginRegistry` interface used by `InstallerPipeline`.
 */
export type {
  TakosumiPlugin,
  TakosumiPluginApplyContext,
  TakosumiPluginApplyResult,
  TakosumiPluginDeploymentContext,
  TakosumiPluginDestroyContext,
  TakosumiPluginInstallationContext,
} from "takosumi-contract/reference/plugin";
import type { TakosumiPlugin } from "takosumi-contract/reference/plugin";

export interface TakosumiPluginRegistry {
  /** All registered plugins, in registration order. */
  list(): readonly TakosumiPlugin[];
  /**
   * Find the plugin that advertises `provides[]` containing `kindUri`.
   * Returns `undefined` if no plugin claims the kind. The first registered
   * plugin wins on conflict; the registry refuses conflicting registration
   * at construction time.
   */
  findByKindUri(kindUri: string): TakosumiPlugin | undefined;
  /**
   * Find a plugin by the exact operator-selected kind reference. Takosumi
   * does not expand short aliases; operators pass the URI or opaque reference
   * they want the plugin registry to resolve.
   */
  findByKindRef(kind: string): TakosumiPlugin | undefined;
  /** Lookup by `name`. Returns `undefined` if not registered. */
  getByName(name: string): TakosumiPlugin | undefined;
}
