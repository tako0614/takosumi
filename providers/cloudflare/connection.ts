/**
 * Cloudflare connection credential driver façade.
 *
 * A thin, self-contained object the vault can call to mint/verify Cloudflare provider
 * credentials. It does NOT open sealed blobs or touch the secret-boundary
 * crypto — the vault opens the connection's sealed values in core and hands the
 * already-decrypted values in. The driver only talks to the Cloudflare API
 * (token-vending mint + token verify).
 *
 * Selection is performed by the explicit CredentialRecipe driver registry.
 */
import type { ProviderConnection } from "takosumi-contract/connections";
import {
  type CloudflareFetch,
  type CloudflareMintedProviderValues,
  type CloudflareVerifyResult,
  isCloudflareTokenVending,
  mintCloudflareProviderValues,
  verifyCloudflareToken,
} from "./credentials.ts";

/**
 * Self-contained Cloudflare credential driver. Stateless: every entry point
 * takes an injected `fetch` (+ `now` for the mint) so it stays unit-testable
 * and never depends on the Vault's internals. The Vault delegates to this once
 * it has opened the connection's sealed values.
 */
export const cloudflareCredentialDriver = {
  /** Provider id this driver implements. */
  id: "cloudflare" as const,

  /**
   * Whether this connection should mint through the token-vending path (it has
 * `scopeHints.cloudflareTokenVending`). When false, the Vault returns the
   * static values as-is (no Cloudflare API call).
   */
  isTokenVending(connection: ProviderConnection): boolean {
    return isCloudflareTokenVending(connection);
  },

  /**
   * Mints the Cloudflare provider env map for a token-vending connection from
   * the already-opened values, returning the values with the minted
   * short-lived `CLOUDFLARE_API_TOKEN` plus mint evidence.
   */
  mint(input: {
    readonly connection: ProviderConnection;
    readonly values: Readonly<Record<string, string>>;
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
