/**
 * Binding domain — resolves `use:` edges into runtime injection.
 *
 * Wave 5 stub. The binding resolver:
 *   - reads AppSpec component graph + outputs
 *   - resolves `use: { env, envPrefix, mount, target }` per edge
 *   - injects env vars / secret refs into target component runtime
 *   - validates use-edge topology + cycles (delegated to yaml-parser)
 *   - persists secret store entries keyed by (installationId, componentName,
 *     edgeName)
 *
 * Replaces the prior placeholder resolver
 * (`${ref:...}` / `${secret-ref:...}` / `${bindings.*}` / `${secrets.*}` /
 * `${installation.*}` / `${artifacts.*}` / `${params.*}` substitution),
 * which is removed alongside the retired public ManifestResource contract.
 */

import type { AppSpec, UseEdge } from "takosumi-contract/app-spec";

export interface ResolvedBinding {
  readonly fromComponent: string;
  readonly toComponent: string;
  readonly edgeName: string;
  readonly envInjections: Readonly<
    Record<string, string | { secretRef: string }>
  >;
  readonly mountedAs?: string;
}

export interface BindingResolverDependencies {
  // future: SecretStore, ProviderOutputs lookup, etc.
  readonly _placeholder?: never;
}

export class BindingResolver {
  constructor(_dependencies: BindingResolverDependencies = {}) {
    // Wave 5 stub.
  }

  resolveAppSpec(
    _appSpec: AppSpec,
    _outputs: Readonly<
      Record<string, Readonly<Record<string, string | { secretRef: string }>>>
    >,
  ): readonly ResolvedBinding[] {
    throw new Error("BindingResolver.resolveAppSpec not implemented");
  }

  resolveEdge(
    _fromComponent: string,
    _edgeName: string,
    _edge: UseEdge,
    _targetOutputs: Readonly<
      Record<string, string | { secretRef: string }>
    >,
  ): ResolvedBinding {
    throw new Error("BindingResolver.resolveEdge not implemented");
  }
}
