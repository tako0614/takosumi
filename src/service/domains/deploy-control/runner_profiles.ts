/**
 * Default RunnerProfile seed data for the deploy-control domain.
 *
 * `createDefaultRunnerProfiles` returns the reference runner profiles seeded
 * into a fresh controller (provider allowlists, network policy, Cloudflare
 * Container execution defaults). Pure data + builders, no controller state.
 */

import type { RunnerProfile } from "takosumi-contract/deploy-control-api";

export function createDefaultRunnerProfiles(now = Date.now()): readonly RunnerProfile[] {
  const cloudflareProvider = "registry.opentofu.org/cloudflare/cloudflare";
  const awsProvider = "registry.opentofu.org/hashicorp/aws";
  const gcpProvider = "registry.opentofu.org/hashicorp/google";
  const azureProvider = "registry.opentofu.org/hashicorp/azurerm";
  const kubernetesProvider = "registry.opentofu.org/hashicorp/kubernetes";
  const helmProvider = "registry.opentofu.org/hashicorp/helm";
  const dockerProvider = "registry.opentofu.org/kreuzwerker/docker";
  const githubProvider = "registry.opentofu.org/integrations/github";
  const digitalOceanProvider = "registry.opentofu.org/digitalocean/digitalocean";

  return [
    defaultProviderRunnerProfile(now, {
      id: "cloudflare-default",
      name: "Cloudflare default",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use Cloudflare resources.",
      allowedProviders: [cloudflareProvider],
      networkPolicy: {
        mode: "egress-allowlist",
        allowedHosts: [
          "registry.opentofu.org",
          "api.cloudflare.com",
        ],
      },
      cloudflareWorkersForPlatforms: {
        dispatchNamespace: "takosumi-tenants",
        dispatchWorkerBinding: "TAKOSUMI_TENANT_DISPATCH",
        outboundWorker: {
          serviceBinding: "TAKOSUMI_OUTBOUND_WORKER",
          enforceNetworkPolicy: true,
        },
        userWorkerBindings: {
          mode: "tenant-scoped-only",
          allowedBindingKinds: [
            "kv_namespace",
            "durable_object_namespace",
            "queue",
            "r2_bucket",
            "d1_database",
          ],
        },
      },
    }),
    defaultProviderRunnerProfile(now, {
      id: "aws-default",
      name: "AWS default",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use AWS resources.",
      allowedProviders: [awsProvider],
      labels: templateRunnerProfileLabels(),
      networkPolicy: {
        mode: "egress-allowlist",
        allowedHosts: [
          "registry.opentofu.org",
          "sts.amazonaws.com",
          "iam.amazonaws.com",
          "route53.amazonaws.com",
        ],
        allowedHostPatterns: [
          "*.amazonaws.com",
          "*.api.aws",
        ],
      },
    }),
    defaultProviderRunnerProfile(now, {
      id: "gcp-default",
      name: "GCP default",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use Google Cloud resources.",
      allowedProviders: [gcpProvider],
      labels: templateRunnerProfileLabels(),
      networkPolicy: {
        mode: "egress-allowlist",
        allowedHosts: [
          "registry.opentofu.org",
          "oauth2.googleapis.com",
          "cloudresourcemanager.googleapis.com",
          "serviceusage.googleapis.com",
          "iam.googleapis.com",
        ],
        allowedHostPatterns: [
          "*.googleapis.com",
        ],
      },
    }),
    defaultProviderRunnerProfile(now, {
      id: "azure-default",
      name: "Azure default",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use Azure resources.",
      allowedProviders: [azureProvider],
      labels: templateRunnerProfileLabels(),
      networkPolicy: {
        mode: "egress-allowlist",
        allowedHosts: [
          "registry.opentofu.org",
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
    }),
    defaultProviderRunnerProfile(now, {
      id: "kubernetes-default",
      name: "Kubernetes default",
      description:
        "Operator-managed OpenTofu runner for Kubernetes and Helm modules.",
      allowedProviders: [kubernetesProvider, helmProvider],
      labels: templateRunnerProfileLabels(),
      networkPolicy: {
        mode: "operator-managed",
        allowedHosts: [
          "registry.opentofu.org",
          "kubernetes.default.svc",
        ],
        allowedHostPatterns: [
          "*.svc",
          "*.cluster.local",
        ],
      },
    }),
    defaultProviderRunnerProfile(now, {
      id: "github-default",
      name: "GitHub default",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use GitHub resources.",
      allowedProviders: [githubProvider],
      labels: templateRunnerProfileLabels(),
      networkPolicy: {
        mode: "egress-allowlist",
        allowedHosts: [
          "registry.opentofu.org",
          "api.github.com",
          "uploads.github.com",
        ],
        allowedHostPatterns: [
          "*.githubusercontent.com",
        ],
      },
    }),
    defaultProviderRunnerProfile(now, {
      id: "digitalocean-default",
      name: "DigitalOcean default",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use DigitalOcean resources.",
      allowedProviders: [digitalOceanProvider],
      labels: templateRunnerProfileLabels(),
      networkPolicy: {
        mode: "egress-allowlist",
        allowedHosts: [
          "registry.opentofu.org",
          "api.digitalocean.com",
        ],
      },
    }),
    defaultProviderRunnerProfile(now, {
      id: "docker-local",
      name: "Docker local",
      substrate: "local",
      description:
        "Local runner profile for OpenTofu modules that use a host Docker daemon.",
      allowedProviders: [dockerProvider],
      credentialRefs: [],
      cloudflareContainer: false,
      labels: templateRunnerProfileLabels(),
      networkPolicy: {
        mode: "operator-managed",
        allowedHosts: [
          "registry.opentofu.org",
        ],
      },
    }),
  ];
}

interface DefaultProviderRunnerProfileOptions {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly allowedProviders: readonly string[];
  readonly substrate?: string;
  readonly credentialRefs?: RunnerProfile["credentialRefs"];
  readonly cloudflareContainer?: RunnerProfile["cloudflareContainer"] | false;
  readonly cloudflareWorkersForPlatforms?: RunnerProfile["cloudflareWorkersForPlatforms"];
  readonly networkPolicy: NonNullable<RunnerProfile["networkPolicy"]>;
  readonly labels?: RunnerProfile["labels"];
}

const DEFAULT_CLOUDFLARE_CONTAINER_EXECUTION: NonNullable<
  RunnerProfile["cloudflareContainer"]
> = {
  image: "ghcr.io/takosjp/takosumi-opentofu-runner:1",
  queueName: "takosumi-opentofu-runs",
  durableObjectBinding: "TAKOS_OPENTOFU_RUNNER",
  workDir: "/workspace",
};

const DEFAULT_RESOURCE_LIMITS: NonNullable<RunnerProfile["resourceLimits"]> = {
  maxRunSeconds: 900,
  maxSourceArchiveBytes: 100 * 1024 * 1024,
  maxSourceDecompressedBytes: 1000 * 1024 * 1024,
  cpu: "1",
  memoryMb: 1024,
};

const DEFAULT_SECRET_EXPOSURE_POLICY: NonNullable<
  RunnerProfile["secretExposurePolicy"]
> = {
  providerCredentials: "runner-only",
  tenantWorkerOperatorSecrets: "forbidden",
  redactLogs: true,
  blockSensitiveOutputs: true,
};

function defaultProviderRunnerProfile(
  now: number,
  options: DefaultProviderRunnerProfileOptions,
): RunnerProfile {
  const credentialRefs = options.credentialRefs ??
    credentialRefsForProfile(options.id, options.allowedProviders);
  return {
    id: options.id,
    name: options.name,
    substrate: options.substrate ?? "cloudflare-containers",
    description: options.description,
    tofuVersion: "operator-managed",
    stateBackend: {
      kind: "operator-managed",
      ref: `state://takosumi/${options.id}`,
      lock: {
        kind: "operator",
        ref: `lock://takosumi/${options.id}`,
      },
    },
    allowedProviders: options.allowedProviders,
    ...(credentialRefs.length > 0 ? { credentialRefs } : {}),
    requireCredentialRefs: credentialRefs.length > 0,
    resourceLimits: DEFAULT_RESOURCE_LIMITS,
    networkPolicy: options.networkPolicy,
    ...(options.cloudflareContainer === false
      ? {}
      : {
        cloudflareContainer: options.cloudflareContainer ??
          DEFAULT_CLOUDFLARE_CONTAINER_EXECUTION,
      }),
    ...(options.cloudflareWorkersForPlatforms
      ? { cloudflareWorkersForPlatforms: options.cloudflareWorkersForPlatforms }
      : {}),
    secretExposurePolicy: DEFAULT_SECRET_EXPOSURE_POLICY,
    ...(options.labels ? { labels: options.labels } : {}),
    createdAt: now,
  };
}

function templateRunnerProfileLabels(): Readonly<Record<string, string>> {
  return {
    "takosumi.com/profile-state": "template",
  };
}

function credentialRefsForProfile(
  profileId: string,
  providers: readonly string[],
): NonNullable<RunnerProfile["credentialRefs"]> {
  return providers.map((provider) => ({
    provider,
    ref: `secret://takosumi/${profileId}`,
    required: true,
  }));
}
