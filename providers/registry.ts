/**
 * Provider runtime registry — the single source of truth for per-provider data.
 *
 * The provider-agnostic control plane reads provider identity, connection kinds,
 * network policy, and runner config from here instead of inlining
 * per-provider literals (previously scattered across `runner_profiles.ts`,
 * `provider-env-rules.ts`, and generated-root wiring). Provider-specific
 * implementation code (credential mint/verify and OpenTofu capsule modules)
 * lives under `providers/<id>/` and is folded in here as each piece is
 * extracted.
 */
import type { ConnectionKind } from "takosumi-contract/connections";
import {
  allowedEnvNamesForProvider,
  providerCredentialArgs,
  type ProviderCredentialArg,
} from "takosumi-contract/provider-env-rules";
import type { ProviderRuntime } from "./types.ts";

const OPENTOFU = "registry.opentofu.org";

/**
 * Per-provider records WITHOUT the credential fields. The credential
 * (`credentialArgs` / `credentialEnvNames`) data is sourced from the
 * dependency-free `provider-env-rules` table (which the runner container also
 * reads) and folded into each {@link ProviderRuntime} below, so per-provider
 * credential data keeps a single source. The registry imports `provider-env-rules`
 * rather than the reverse because that table must stay import-free to resolve in
 * the slim runner build.
 */
type ProviderRuntimeBase = Omit<
  ProviderRuntime,
  "credentialArgs" | "credentialEnvNames"
>;

const PROVIDER_RUNTIME_BASES: readonly ProviderRuntimeBase[] = [
  {
    id: "cloudflare",
    displayName: "Cloudflare",
    providerAddresses: [`${OPENTOFU}/cloudflare/cloudflare`],
    connectionKinds: ["cloudflare_api_token", "cloudflare_oauth"],
    network: {
      mode: "egress-allowlist",
      allowedHosts: [OPENTOFU, "api.cloudflare.com"],
    },
    capsuleModuleIds: [
      "cloudflare-r2-storage",
      "cloudflare-static-site",
      "cloudflare-worker-service",
    ],
    runnerProfileId: "cloudflare-default",
  },
  {
    id: "aws",
    displayName: "AWS",
    providerAddresses: [`${OPENTOFU}/hashicorp/aws`],
    connectionKinds: ["aws_assume_role"],
    network: {
      mode: "egress-allowlist",
      allowedHosts: [
        OPENTOFU,
        "sts.amazonaws.com",
        "iam.amazonaws.com",
        "route53.amazonaws.com",
      ],
      allowedHostPatterns: ["*.amazonaws.com", "*.api.aws"],
    },
    capsuleModuleIds: ["aws-s3-storage"],
    runnerProfileId: "aws-provider-env-candidate",
  },
  {
    id: "gcp",
    displayName: "Google Cloud",
    providerAddresses: [`${OPENTOFU}/hashicorp/google`],
    connectionKinds: [
      "gcp_oauth_bootstrap",
      "gcp_service_account_impersonation",
    ],
    network: {
      mode: "egress-allowlist",
      allowedHosts: [
        OPENTOFU,
        "oauth2.googleapis.com",
        "cloudresourcemanager.googleapis.com",
        "serviceusage.googleapis.com",
        "iam.googleapis.com",
      ],
      allowedHostPatterns: ["*.googleapis.com"],
    },
    runnerProfileId: "gcp-reserved",
  },
  {
    id: "azure",
    displayName: "Azure",
    providerAddresses: [`${OPENTOFU}/hashicorp/azurerm`],
    connectionKinds: ["generic_env_provider"],
    network: {
      mode: "egress-allowlist",
      allowedHosts: [
        OPENTOFU,
        "login.microsoftonline.com",
        "management.azure.com",
        "graph.microsoft.com",
      ],
      allowedHostPatterns: [
        "*.azure.com",
        "*.windows.net",
        "*.microsoftonline.com",
      ],
    },
    runnerProfileId: "azure-provider-env-candidate",
  },
  {
    id: "kubernetes",
    displayName: "Kubernetes",
    providerAddresses: [
      `${OPENTOFU}/hashicorp/kubernetes`,
      `${OPENTOFU}/hashicorp/helm`,
    ],
    connectionKinds: ["generic_env_provider"],
    network: {
      mode: "operator-managed",
      allowedHosts: [OPENTOFU, "kubernetes.default.svc"],
      allowedHostPatterns: ["*.svc", "*.cluster.local"],
    },
    runnerProfileId: "kubernetes-provider-env-candidate",
  },
  {
    id: "github",
    displayName: "GitHub",
    providerAddresses: [`${OPENTOFU}/integrations/github`],
    connectionKinds: ["generic_env_provider"],
    network: {
      mode: "egress-allowlist",
      allowedHosts: [OPENTOFU, "api.github.com", "uploads.github.com"],
      allowedHostPatterns: ["*.githubusercontent.com"],
    },
    runnerProfileId: "github-provider-env-candidate",
  },
  {
    id: "digitalocean",
    displayName: "DigitalOcean",
    providerAddresses: [`${OPENTOFU}/digitalocean/digitalocean`],
    connectionKinds: ["generic_env_provider"],
    network: {
      mode: "egress-allowlist",
      allowedHosts: [OPENTOFU, "api.digitalocean.com"],
    },
    runnerProfileId: "digitalocean-provider-env-candidate",
  },
  {
    id: "docker",
    displayName: "Docker",
    providerAddresses: [`${OPENTOFU}/kreuzwerker/docker`],
    connectionKinds: ["generic_env_provider"],
    network: {
      mode: "operator-managed",
      allowedHosts: [OPENTOFU],
    },
    runnerProfileId: "docker-custom-example",
  },
];

/**
 * Resolve the credential env-name / arg data for a provider base from the
 * `provider-env-rules` table, keyed by its canonical OpenTofu provider address
 * (which `provider-env-rules` resolves through its short-name / registry-path
 * match). A provider whose address has no env-rule entry gets empty credential
 * data, preserving the credential-free behavior for providers without a mapping.
 */
function resolveProviderCredentials(base: ProviderRuntimeBase): {
  credentialArgs: readonly ProviderCredentialArg[];
  credentialEnvNames: readonly string[];
} {
  const address = base.providerAddresses[0] ?? base.id;
  return {
    credentialArgs: providerCredentialArgs(address),
    credentialEnvNames: allowedEnvNamesForProvider(address),
  };
}

export const PROVIDER_RUNTIMES: readonly ProviderRuntime[] =
  PROVIDER_RUNTIME_BASES.map((base) => ({
    ...base,
    ...resolveProviderCredentials(base),
  }));

const BY_ID = new Map(PROVIDER_RUNTIMES.map((p) => [p.id, p]));
const BY_ADDRESS = new Map<string, ProviderRuntime>();
for (const provider of PROVIDER_RUNTIMES) {
  for (const address of provider.providerAddresses) {
    BY_ADDRESS.set(address, provider);
    // Also index the short `<namespace>/<name>` and bare local-name forms so a
    // template's `cloudflare/cloudflare` or `cloudflare` resolves the same record.
    const short = address.replace(`${OPENTOFU}/`, "");
    BY_ADDRESS.set(short, provider);
    const local = short.split("/").pop();
    if (local) BY_ADDRESS.set(local, provider);
  }
}

const BY_CONNECTION_KIND = new Map<ConnectionKind, ProviderRuntime>();
for (const provider of PROVIDER_RUNTIMES) {
  for (const kind of provider.connectionKinds) {
    if (!BY_CONNECTION_KIND.has(kind)) BY_CONNECTION_KIND.set(kind, provider);
  }
}

export function providerById(id: string): ProviderRuntime | undefined {
  return BY_ID.get(id);
}

/** Resolve by OpenTofu provider address (fully-qualified, short, or local name). */
export function providerForAddress(
  address: string,
): ProviderRuntime | undefined {
  return BY_ADDRESS.get(address) ?? BY_ADDRESS.get(address.split("/").pop()!);
}

const SHORT_PROVIDER_ADDRESS = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u;

/**
 * Canonicalize an OpenTofu provider source to the fully-qualified
 * `registry.opentofu.org/<namespace>/<name>` form. A source that is already
 * fully qualified is returned unchanged; a short `<namespace>/<name>` source is
 * prefixed with the default registry host; anything else (a bare local name or a
 * non-registry address) is returned unchanged. The default registry host is the
 * registry's single source of truth, so `core` does not re-declare it.
 */
export function canonicalProviderAddress(source: string): string {
  if (source.startsWith(`${OPENTOFU}/`)) return source;
  if (SHORT_PROVIDER_ADDRESS.test(source)) return `${OPENTOFU}/${source}`;
  return source;
}

export function providerForConnectionKind(
  kind: ConnectionKind,
): ProviderRuntime | undefined {
  return BY_CONNECTION_KIND.get(kind);
}

/**
 * Per-alias credential env-name -> OpenTofu provider-argument mapping for a
 * provider, resolved through the registry by OpenTofu provider address (fully
 * qualified, short, or local name) or provider id. An unknown provider yields an
 * empty list. This is the registry-facing view of the `provider-env-rules`
 * credential-arg table (the single source the registry records also fold in).
 */
export function providerCredentialArgsFromRegistry(
  provider: string,
): readonly ProviderCredentialArg[] {
  return (
    providerForAddress(provider)?.credentialArgs ??
    providerById(provider)?.credentialArgs ??
    []
  );
}

export function gatewayCoverageForProvider(
  _provider: string,
): readonly [] {
  // Compatibility gateways are Takosumi Cloud-only. OSS Takosumi still exposes
  // this legacy helper for migration compatibility, but the OSS registry never
  // advertises gateway coverage.
  return [];
}

export function supportedGatewayResourceTypesForProvider(
  _provider: string,
): readonly string[] {
  return [];
}
