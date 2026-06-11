/**
 * Managed-provider abstraction.
 *
 * Each takosumi-managed cloud (Cloudflare, AWS, …) is described by ONE
 * {@link ManagedProvider} record so the provider-agnostic control plane (`core`)
 * never hardcodes a provider: it looks a provider up in the {@link
 * ManagedProviderRegistry} by its OpenTofu provider address or its Connection
 * kind, and reads its network policy / connection kinds / managed-hosting config
 * from there. The per-provider implementation code (credential mint/verify,
 * the cf-proxy/WfP hosting worker, the first-party OpenTofu capsule modules)
 * lives under `providers/<id>/`.
 *
 * This file is the leaf of the dependency graph: it imports only the public
 * contract types, so `core`, `worker`, `rootgen`, and the deploy targets can all
 * depend on the registry without a cycle.
 */
import type { ConnectionKind } from "takosumi-contract/connections";

export interface ProviderNetworkPolicy {
  readonly mode: "egress-allowlist" | "operator-managed";
  /** Exact egress hosts the runner may reach for this provider. */
  readonly allowedHosts: readonly string[];
  /** Wildcard host patterns (region/service suffixes). */
  readonly allowedHostPatterns?: readonly string[];
}

/**
 * Managed-hosting mechanism: present only for a provider that hosts tenant
 * resources in the OPERATOR's account behind a redirect/proxy (Cloudflare today,
 * via the cf-proxy + Workers-for-Platforms dispatch namespace). Absent => the
 * provider has no operator-account hosting redirect.
 */
export interface ManagedProviderHosting {
  /** The dispatch namespace tenant scripts are published into. */
  readonly dispatchNamespace: string;
  /** cf-proxy the managed run's provider `base_url` is redirected to. */
  readonly apiProxy: { readonly origin: string; readonly route: string };
}

export interface ManagedProvider {
  /** Stable provider id and `providers/<id>/` folder name. */
  readonly id: string;
  readonly displayName: string;
  /** Fully-qualified OpenTofu provider source addresses this provider owns. */
  readonly providerAddresses: readonly string[];
  /** Connection kinds whose driver this provider implements. */
  readonly connectionKinds: readonly ConnectionKind[];
  /** Egress policy seeded onto this provider's runner profile. */
  readonly network: ProviderNetworkPolicy;
  /** Operator-account hosting redirect (Cloudflare only for now). */
  readonly hosting?: ManagedProviderHosting;
  /** First-party OpenTofu capsule module ids this provider ships. */
  readonly capsuleModuleIds?: readonly string[];
  /** Seeded runner profile id (stable, must not change). */
  readonly runnerProfileId: string;
}
