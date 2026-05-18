/**
 * Binding domain — resolves namespace pub/sub listen edges into runtime
 * injection.
 *
 * Wave 5 stub. After Phase B, the binding resolver consumes the
 * namespace pub/sub model: for each `Component.listen[<namespacePath>]`
 * the resolver fetches the published material from the registry and
 * delegates to the listener plugin's `applyListen` to produce an
 * env / mount / target descriptor. The descriptor is then attached to
 * the listener's runtime by the installer pipeline.
 *
 * Phase C will replace this stub with the real implementation. The
 * stub exists here only so the kernel package compiles against the new
 * contract; calling the resolver throws.
 */

import type { AppSpec, ListenOptions } from "takosumi-contract/app-spec";
import type { NamespaceMaterial } from "takosumi-contract/plugin";

export interface ResolvedBinding {
  readonly listenerComponent: string;
  readonly namespacePath: string;
  readonly options: ListenOptions;
  readonly envInjections: Readonly<
    Record<string, string | { secretRef: string }>
  >;
  readonly mounts?: Readonly<
    Record<string, string | { secretRef: string }>
  >;
  readonly target?: NamespaceMaterial;
}

export interface BindingResolverDependencies {
  // Phase C will inject SecretStore, namespace registry, KernelPlugin
  // lookup, etc. The stub keeps a placeholder field so the interface
  // type-checks today.
  readonly _placeholder?: never;
}

export class BindingResolver {
  constructor(_dependencies: BindingResolverDependencies = {}) {
    // Phase C will fill this in.
  }

  resolveAppSpec(
    _appSpec: AppSpec,
    _materials: Readonly<Record<string, NamespaceMaterial>>,
  ): readonly ResolvedBinding[] {
    throw new Error("BindingResolver.resolveAppSpec not implemented");
  }

  resolveListen(
    _listenerComponent: string,
    _namespacePath: string,
    _options: ListenOptions,
    _material: NamespaceMaterial,
  ): ResolvedBinding {
    throw new Error("BindingResolver.resolveListen not implemented");
  }
}
