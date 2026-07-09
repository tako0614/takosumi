/**
 * Install readiness — can a store listing be installed with one tap?
 *
 * Derived client-side from the TCS listing plus the workspace's provider
 * connections; the TCS wire contract stays untouched. Three levels:
 *
 *   - "oneTap": no user input needed (every required input has a derivable
 *     default) and the provider credential is already covered (credential-free
 *     provider, an existing connection, or the operator-managed Cloudflare
 *     fallback).
 *   - "needsInput": at least one required input must be typed by the user.
 *   - "needsConnection": the provider is a credential boundary with no usable
 *     connection — the harder blocker, reported over "needsInput".
 */
import {
  installExperiencePublicEndpoint,
  installExperienceServiceNameVariable,
} from "takosumi-contract";
import { isCredentialFreeUtilityProvider } from "takosumi-contract/provider-env-rules";
import type { TcsListing } from "./tcs-client.ts";
import type { ProviderConnection } from "./control-api.ts";

export type InstallReadiness = "oneTap" | "needsInput" | "needsConnection";

/**
 * Well-known credential-free OpenTofu providers (by short name / tail) that are
 * NOT a credential boundary, so an install must not force a Provider Connection
 * for them. `isCredentialFreeUtilityProvider` already covers the canonical
 * http / random / tls; this set adds the other common credential-free providers
 * and also matches bare local-name declarations (e.g. `null`, `local`).
 */
export const CREDENTIAL_FREE_PROVIDER_TAILS: ReadonlySet<string> = new Set([
  "http",
  "random",
  "tls",
  "null",
  "local",
  "time",
  "external",
  "archive",
  "cloudinit",
  "template",
]);

export function providerTail(provider: string): string {
  const normalized = provider.toLowerCase().trim();
  return normalized.split("/").at(-1) ?? normalized;
}

export function providerRequiresConnection(provider: string): boolean {
  return (
    !isCredentialFreeUtilityProvider(provider) &&
    !CREDENTIAL_FREE_PROVIDER_TAILS.has(providerTail(provider))
  );
}

/**
 * An operator-managed provider connection usable as the zero-config credential
 * fallback (mirrors the run engine's managed-fallback recognition).
 */
export function isUsableManagedProviderConnection(
  connection: ProviderConnection,
): boolean {
  return (
    connection.status === "pending" &&
    connection.scope === "operator" &&
    connection.scopeHints?.managedProvider === true &&
    typeof connection.scopeHints.providerBaseUrl === "string" &&
    connection.scopeHints.providerBaseUrl.trim().length > 0
  );
}

/** Connection-scoped inputs are auto-filled from the connection's scope hints,
 * never typed by the user (mirrors NewAppView's scope-hint mapping). */
const CONNECTION_SCOPED_INPUT_NAMES: ReadonlySet<string> = new Set([
  "accountid",
  "account_id",
  "cloudflare_account_id",
  "zoneid",
  "zone_id",
  "cloudflare_zone_id",
  "cloudflare_route_zone_id",
  "region",
  "aws_region",
  "workerssubdomain",
  "workers_subdomain",
  "cloudflare_workers_subdomain",
]);

function isConnectionScopedInputName(name: string): boolean {
  return CONNECTION_SCOPED_INPUT_NAMES.has(
    name.trim().replace(/[^A-Za-z0-9]+/gu, "_").toLowerCase(),
  );
}

/** True when a required listing input resolves without the user typing:
 * a declared default, the auto-slugged service name / public endpoint, or a
 * connection scope hint. Mirrors `storeDefaultInputValue` in the add flow. */
function requiredInputHasDerivableValue(
  listing: TcsListing,
  input: NonNullable<TcsListing["inputs"]>[number],
): boolean {
  if (input.defaultValue !== undefined && input.defaultValue !== "") {
    return true;
  }
  const endpoint = installExperiencePublicEndpoint(listing.installExperience);
  if (
    input.name === endpoint?.subdomainVariable ||
    input.name === endpoint?.urlVariable ||
    input.name === endpoint?.routePatternVariable
  ) {
    return true;
  }
  if (
    input.name ===
    installExperienceServiceNameVariable(listing.installExperience)
  ) {
    return true;
  }
  return isConnectionScopedInputName(input.name);
}

export interface InstallReadinessContext {
  /** Provider tails with a ready (verified) workspace connection. */
  readonly connectedProviderTails: ReadonlySet<string>;
  /** An operator-managed Cloudflare connection is available as fallback. */
  readonly managedCloudflareAvailable: boolean;
}

export function deriveInstallReadiness(
  listing: TcsListing,
  context: InstallReadinessContext,
): InstallReadiness {
  const tail = providerTail(listing.provider);
  const credentialCovered =
    !providerRequiresConnection(listing.provider) ||
    context.connectedProviderTails.has(tail) ||
    (tail === "cloudflare" && context.managedCloudflareAvailable);
  if (!credentialCovered) return "needsConnection";
  const needsInput = (listing.inputs ?? []).some(
    (input) =>
      input.required === true &&
      !requiredInputHasDerivableValue(listing, input),
  );
  return needsInput ? "needsInput" : "oneTap";
}

/** Build the readiness context from the workspace's provider connections. */
export function installReadinessContext(
  connections: readonly ProviderConnection[],
): InstallReadinessContext {
  const connectedProviderTails = new Set<string>();
  let managedCloudflareAvailable = false;
  for (const connection of connections) {
    const usable =
      connection.status === "verified" ||
      isUsableManagedProviderConnection(connection);
    if (!usable) continue;
    const tail = providerTail(connection.providerSource);
    connectedProviderTails.add(tail);
    if (
      tail === "cloudflare" &&
      connection.scopeHints?.managedProvider === true
    ) {
      managedCloudflareAvailable = true;
    }
  }
  return { connectedProviderTails, managedCloudflareAvailable };
}
