/**
 * Provider runtime abstraction.
 *
 * Each provider implementation (Cloudflare, AWS, ...) is described by ONE
 * {@link ProviderRuntime} record so the provider-agnostic control plane (`core`)
 * never hardcodes a provider: it looks a provider up in the {@link
 * ProviderRuntimeRegistry} by its OpenTofu provider address or its Connection
 * kind, and reads its network policy / connection kinds / runner config
 * from there. The per-provider implementation code (credential mint/verify,
 * the first-party OpenTofu capsule modules) lives under `providers/<id>/`.
 *
 * This file is the leaf of the dependency graph: it imports only the public
 * contract types, so `core`, `worker`, `rootgen`, and the deploy targets can all
 * depend on the registry without a cycle.
 */
import type { ConnectionKind } from "takosumi-contract/connections";
import type { ProviderCredentialArg } from "takosumi-contract/provider-env-rules";

export interface ProviderNetworkPolicy {
  readonly mode: "egress-allowlist" | "operator-managed";
  /** Exact egress hosts the runner may reach for this provider. */
  readonly allowedHosts: readonly string[];
  /** Wildcard host patterns (region/service suffixes). */
  readonly allowedHostPatterns?: readonly string[];
}

export interface ProviderRuntime {
  /** Stable provider id and `providers/<id>/` folder name. */
  readonly id: string;
  readonly displayName: string;
  /** Fully-qualified OpenTofu provider source addresses this provider owns. */
  readonly providerAddresses: readonly string[];
  /** Connection kinds whose driver this provider implements. */
  readonly connectionKinds: readonly ConnectionKind[];
  /** Egress policy seeded onto this provider's runner profile. */
  readonly network: ProviderNetworkPolicy;
  /** First-party OpenTofu capsule module ids this provider ships. */
  readonly capsuleModuleIds?: readonly string[];
  /** Seeded runner profile id (stable, must not change). */
  readonly runnerProfileId: string;
  /**
   * Per-alias credential env-name -> OpenTofu provider-argument mapping for the
   * per-alias credential split (e.g. Cloudflare `CLOUDFLARE_API_TOKEN` ->
   * `api_token`). Empty for a provider that keeps a credential-free shared-env
   * alias. Sourced byte-for-byte from `PROVIDER_CREDENTIAL_ARG_MAP` in
   * `provider-env-rules` (the dependency-free table the runner container also
   * reads); the registry imports it so per-provider credential data has a single
   * source.
   */
  readonly credentialArgs: readonly ProviderCredentialArg[];
  /**
   * Every credential env name this provider may supply, from the
   * `provider-env-rules` table. Empty for a provider with no env-rule entry.
   */
  readonly credentialEnvNames: readonly string[];
}
