/**
 * Managed-provider registry — the single source of truth for per-provider data.
 *
 * The provider-agnostic control plane reads provider identity, connection kinds,
 * network policy, and managed-hosting config from here instead of inlining
 * per-provider literals (previously scattered across `runner_profiles.ts`,
 * `provider-env-rules.ts`, and the cf-proxy/rootgen wiring). Provider-specific
 * implementation code (credential mint/verify, the cf-proxy/WfP hosting worker,
 * the OpenTofu capsule modules) lives under `providers/<id>/` and is folded in
 * here as each piece is extracted.
 */
import type { ConnectionKind } from "takosumi-contract/connections";
import type { ManagedProvider } from "./types.ts";

const OPENTOFU = "registry.opentofu.org";

export const MANAGED_PROVIDERS: readonly ManagedProvider[] = [
  {
    id: "cloudflare",
    displayName: "Cloudflare",
    providerAddresses: [`${OPENTOFU}/cloudflare/cloudflare`],
    connectionKinds: ["cloudflare_api_token", "cloudflare_oauth"],
    network: {
      mode: "egress-allowlist",
      allowedHosts: [OPENTOFU, "api.cloudflare.com"],
    },
    hosting: {
      dispatchNamespace: "takosumi-tenants",
      apiProxy: {
        origin: "https://app.takosumi.com",
        route: "/internal/cf-proxy",
      },
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
    runnerProfileId: "aws-template",
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
    runnerProfileId: "gcp-template",
  },
  {
    id: "azure",
    displayName: "Azure",
    providerAddresses: [`${OPENTOFU}/hashicorp/azurerm`],
    connectionKinds: ["provider_env_set"],
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
    runnerProfileId: "azure-template",
  },
  {
    id: "kubernetes",
    displayName: "Kubernetes",
    providerAddresses: [
      `${OPENTOFU}/hashicorp/kubernetes`,
      `${OPENTOFU}/hashicorp/helm`,
    ],
    connectionKinds: ["provider_env_set"],
    network: {
      mode: "operator-managed",
      allowedHosts: [OPENTOFU, "kubernetes.default.svc"],
      allowedHostPatterns: ["*.svc", "*.cluster.local"],
    },
    runnerProfileId: "kubernetes-template",
  },
  {
    id: "github",
    displayName: "GitHub",
    providerAddresses: [`${OPENTOFU}/integrations/github`],
    connectionKinds: ["provider_env_set"],
    network: {
      mode: "egress-allowlist",
      allowedHosts: [OPENTOFU, "api.github.com", "uploads.github.com"],
      allowedHostPatterns: ["*.githubusercontent.com"],
    },
    runnerProfileId: "github-template",
  },
  {
    id: "digitalocean",
    displayName: "DigitalOcean",
    providerAddresses: [`${OPENTOFU}/digitalocean/digitalocean`],
    connectionKinds: ["provider_env_set"],
    network: {
      mode: "egress-allowlist",
      allowedHosts: [OPENTOFU, "api.digitalocean.com"],
    },
    runnerProfileId: "digitalocean-template",
  },
  {
    id: "docker",
    displayName: "Docker",
    providerAddresses: [`${OPENTOFU}/kreuzwerker/docker`],
    connectionKinds: ["provider_env_set"],
    network: {
      mode: "operator-managed",
      allowedHosts: [OPENTOFU],
    },
    runnerProfileId: "docker-custom-example",
  },
];

const BY_ID = new Map(MANAGED_PROVIDERS.map((p) => [p.id, p]));
const BY_ADDRESS = new Map<string, ManagedProvider>();
for (const provider of MANAGED_PROVIDERS) {
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

const BY_CONNECTION_KIND = new Map<ConnectionKind, ManagedProvider>();
for (const provider of MANAGED_PROVIDERS) {
  for (const kind of provider.connectionKinds) {
    if (!BY_CONNECTION_KIND.has(kind)) BY_CONNECTION_KIND.set(kind, provider);
  }
}

export function providerById(id: string): ManagedProvider | undefined {
  return BY_ID.get(id);
}

/** Resolve by OpenTofu provider address (fully-qualified, short, or local name). */
export function providerForAddress(
  address: string,
): ManagedProvider | undefined {
  return BY_ADDRESS.get(address) ?? BY_ADDRESS.get(address.split("/").pop()!);
}

export function providerForConnectionKind(
  kind: ConnectionKind,
): ManagedProvider | undefined {
  return BY_CONNECTION_KIND.get(kind);
}
