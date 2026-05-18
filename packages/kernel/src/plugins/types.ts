/**
 * Kernel-internal re-exports for the canonical `KernelPlugin` contract.
 *
 * The contract itself lives in `@takos/takosumi-contract/plugin`. This
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
} from "takosumi-contract";
import type { KernelPlugin } from "takosumi-contract";

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
  /** Lookup by `name`. Returns `undefined` if not registered. */
  getByName(name: string): KernelPlugin | undefined;
}
