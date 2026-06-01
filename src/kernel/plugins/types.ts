/**
 * Kernel-internal re-exports for the canonical `KernelPlugin` contract.
 *
 * The contract itself lives in `@takosjp/takosumi/contract/reference/plugin`. This
 * shim keeps existing kernel imports stable and adds the kernel-internal
 * `KernelPluginRegistry` interface used by `InstallerPipeline`.
 */
export type {
  KernelPlugin,
  KernelPluginApplyContext,
  KernelPluginApplyResult,
  KernelPluginDeploymentContext,
  KernelPluginDestroyContext,
  KernelPluginInstallationContext,
} from "takosumi-contract/reference/plugin";
import type { KernelPlugin } from "takosumi-contract/reference/plugin";

export interface KernelPluginRegistry {
  /** All registered plugins, in registration order. */
  list(): readonly KernelPlugin[];
  /**
   * Find the plugin that advertises `provides[]` containing `kindUri`.
   * Returns `undefined` if no plugin claims the kind. The first registered
   * plugin wins on conflict; the registry refuses conflicting registration
   * at construction time.
   */
  findByKindUri(kindUri: string): KernelPlugin | undefined;
  /**
   * Find a plugin by the exact operator-selected kind reference. Takosumi core
   * does not expand short aliases; operators pass the URI or opaque reference
   * they want the plugin registry to resolve.
   */
  findByKindRef(kind: string): KernelPlugin | undefined;
  /** Lookup by `name`. Returns `undefined` if not registered. */
  getByName(name: string): KernelPlugin | undefined;
}
