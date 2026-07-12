/**
 * Cloudflare connection credential driver façade.
 *
 * A thin, self-contained object the vault can call to mint/verify Cloudflare provider
 * credentials. It does NOT open sealed blobs or touch the secret-boundary
 * crypto — the vault opens the connection's sealed values in core and hands the
 * already-decrypted values in. The driver only talks to the Cloudflare API
 * (token-vending mint + token verify).
 *
 * `isProvider` mirrors the inline vault `isCloudflareProvider` predicate
 * (`providerEnvRule(provider)?.shortName === "cloudflare"`) so the vault can
 * route a connection to this driver without duplicating address matching.
 */
import type { Connection } from "takosumi-contract/connections";
import { providerEnvRule } from "takosumi-contract/provider-env-rules";
import type { ProviderCredentialMintEvidence } from "takosumi-contract/security";
import {
  type CloudflareFetch,
  type CloudflareMintedProviderValues,
  type CloudflareVerifyResult,
  isCloudflareTokenVending,
  mintCloudflareProviderValues,
  verifyCloudflareToken,
} from "./credentials.ts";

/**
 * Whether a provider short-name/registry path resolves to Cloudflare. Mirrors
 * the inline vault `isCloudflareProvider` (env-rule short-name match), so the
 * registry/vault can detect a Cloudflare connection the same way.
 */
function isCloudflareProvider(provider: string): boolean {
  return providerEnvRule(provider)?.shortName === "cloudflare";
}

/**
 * Self-contained Cloudflare credential driver. Stateless: every entry point
 * takes an injected `fetch` (+ `now` for the mint) so it stays unit-testable
 * and never depends on the vault's internals. The vault delegates to this once
 * it has opened the connection's sealed values.
 */
export const cloudflareCredentialDriver = {
  /** Provider id this driver implements. */
  id: "cloudflare" as const,

  /** Whether a provider short-name / registry path is Cloudflare. */
  isProvider(provider: string): boolean {
    return isCloudflareProvider(provider);
  },

  /**
   * Whether this connection should mint through the token-vending path (it has
   * `scopeHints.cloudflareTokenVending`). When false, the vault returns the
   * static values as-is (no Cloudflare API call).
   */
  isTokenVending(connection: Connection): boolean {
    return isCloudflareTokenVending(connection);
  },

  /**
   * Mints the Cloudflare provider env map for a token-vending connection from
   * the already-opened values, returning the values with the minted
   * short-lived `CLOUDFLARE_API_TOKEN` plus mint evidence.
   */
  mint(input: {
    readonly connection: Connection;
    readonly values: Readonly<Record<string, string>>;
    readonly delivery: ProviderCredentialMintEvidence["delivery"];
    readonly fetch: CloudflareFetch;
    readonly now: () => Date;
  }): Promise<CloudflareMintedProviderValues> {
    return mintCloudflareProviderValues(input);
  },

  /** Verifies an already-opened Cloudflare API token against the CF API. */
  verify(input: {
    readonly token: string;
    readonly accountId?: string;
    readonly fetch: CloudflareFetch;
  }): Promise<CloudflareVerifyResult> {
    return verifyCloudflareToken(input);
  },
} as const;

export type CloudflareCredentialDriver = typeof cloudflareCredentialDriver;
