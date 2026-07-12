/**
 * Guided provider setup registry.
 *
 * These records power Credential Recipe discovery and guided connection setup.
 * They never determine whether an OpenTofu provider may execute.
 */
import type { ProviderConnectionKind } from "takosumi-contract/connections";
import {
  allowedEnvNamesForProvider,
  providerCredentialArgs,
  type ProviderCredentialArg,
} from "takosumi-contract/provider-env-rules";
import type { GuidedProviderSetup } from "./types.ts";

const OPENTOFU = "registry.opentofu.org";

/**
 * Per-provider records WITHOUT the credential fields. The credential
 * (`credentialArgs` / `credentialEnvNames`) data is sourced from the
 * dependency-free `provider-env-rules` table (which the runner container also
 * reads) and folded into each {@link GuidedProviderSetup} below, so per-provider
 * credential data keeps a single source. The registry imports `provider-env-rules`
 * rather than the reverse because that table must stay import-free to resolve in
 * the slim runner build.
 */
type GuidedProviderSetupBase = Omit<
  GuidedProviderSetup,
  "credentialArgs" | "credentialEnvNames"
>;

const GUIDED_PROVIDER_SETUP_BASES: readonly GuidedProviderSetupBase[] = [
  {
    id: "cloudflare",
    displayName: "Cloudflare",
    providerAddresses: [`${OPENTOFU}/cloudflare/cloudflare`],
    connectionKinds: ["cloudflare_api_token", "cloudflare_oauth"],
  },
  {
    id: "aws",
    displayName: "AWS",
    providerAddresses: [`${OPENTOFU}/hashicorp/aws`],
    connectionKinds: ["aws_assume_role"],
  },
  {
    id: "gcp",
    displayName: "Google Cloud",
    providerAddresses: [
      `${OPENTOFU}/hashicorp/google`,
      `${OPENTOFU}/hashicorp/google-beta`,
    ],
    connectionKinds: [
      "gcp_service_account_json",
      "gcp_oauth_bootstrap",
      "gcp_service_account_impersonation",
    ],
  },
  {
    id: "azure",
    displayName: "Azure",
    providerAddresses: [`${OPENTOFU}/hashicorp/azurerm`],
    connectionKinds: ["generic_env_provider"],
  },
  {
    id: "kubernetes",
    displayName: "Kubernetes",
    providerAddresses: [
      `${OPENTOFU}/hashicorp/kubernetes`,
      `${OPENTOFU}/hashicorp/helm`,
    ],
    connectionKinds: ["generic_env_provider"],
  },
  {
    id: "github",
    displayName: "GitHub",
    providerAddresses: [`${OPENTOFU}/integrations/github`],
    connectionKinds: ["generic_env_provider"],
  },
  {
    id: "digitalocean",
    displayName: "DigitalOcean",
    providerAddresses: [`${OPENTOFU}/digitalocean/digitalocean`],
    connectionKinds: ["generic_env_provider"],
  },
  {
    id: "hcloud",
    displayName: "Hetzner Cloud",
    providerAddresses: [`${OPENTOFU}/hetznercloud/hcloud`],
    connectionKinds: ["generic_env_provider"],
  },
  {
    id: "vultr",
    displayName: "Vultr",
    providerAddresses: [`${OPENTOFU}/vultr/vultr`],
    connectionKinds: ["generic_env_provider"],
  },
  {
    id: "scaleway",
    displayName: "Scaleway",
    providerAddresses: [`${OPENTOFU}/scaleway/scaleway`],
    connectionKinds: ["generic_env_provider"],
  },
  {
    id: "openstack",
    displayName: "OpenStack",
    providerAddresses: [`${OPENTOFU}/terraform-provider-openstack/openstack`],
    connectionKinds: ["generic_env_provider"],
  },
  {
    id: "docker",
    displayName: "Docker",
    providerAddresses: [`${OPENTOFU}/kreuzwerker/docker`],
    connectionKinds: ["generic_env_provider"],
  },
];

/**
 * Resolve the credential env-name / arg data for a provider base from the
 * `provider-env-rules` table, keyed by its canonical OpenTofu provider address
 * (which `provider-env-rules` resolves through its short-name / registry-path
 * match). A provider whose address has no env-rule entry gets empty credential
 * data, preserving the credential-free behavior for providers without a mapping.
 */
function resolveProviderCredentials(base: GuidedProviderSetupBase): {
  credentialArgs: readonly ProviderCredentialArg[];
  credentialEnvNames: readonly string[];
} {
  const address = base.providerAddresses[0] ?? base.id;
  return {
    credentialArgs: providerCredentialArgs(address),
    credentialEnvNames: allowedEnvNamesForProvider(address),
  };
}

export const GUIDED_PROVIDER_SETUPS: readonly GuidedProviderSetup[] =
  GUIDED_PROVIDER_SETUP_BASES.map((base) => ({
    ...base,
    ...resolveProviderCredentials(base),
  }));

const BY_ADDRESS = new Map<string, GuidedProviderSetup>();
for (const provider of GUIDED_PROVIDER_SETUPS) {
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

const BY_CONNECTION_KIND = new Map<
  ProviderConnectionKind,
  GuidedProviderSetup
>();
for (const provider of GUIDED_PROVIDER_SETUPS) {
  for (const kind of provider.connectionKinds) {
    if (!BY_CONNECTION_KIND.has(kind)) BY_CONNECTION_KIND.set(kind, provider);
  }
}

/** Resolve guided setup by provider address; absence never blocks execution. */
export function guidedProviderSetupForAddress(
  address: string,
): GuidedProviderSetup | undefined {
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

export function guidedProviderSetupForConnectionKind(
  kind: ProviderConnectionKind,
): GuidedProviderSetup | undefined {
  return BY_CONNECTION_KIND.get(kind);
}
