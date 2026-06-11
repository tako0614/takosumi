/**
 * Default RunnerProfile seed data for the deploy-control domain.
 *
 * `createDefaultRunnerProfiles` returns the reference runner profiles seeded
 * into a fresh controller (provider allowlists, network policy, Cloudflare
 * Container execution defaults). Pure data + builders, no controller state.
 */

import type { RunnerProfile } from "@takosumi/internal/deploy-control-api";
import { providerById } from "@takosumi/providers";
import { log } from "../../shared/log.ts";

// Per-provider egress policy is owned by the managed-provider registry (single
// source of truth); a runner profile owns only its presentation + runtime. `id`
// is the provider id (e.g. "cloudflare"), not the runner profile id.
function networkFor(id: string): NonNullable<RunnerProfile["networkPolicy"]> {
  const provider = providerById(id);
  if (!provider) {
    throw new Error(`no managed provider registered for "${id}"`);
  }
  return provider.network;
}

/**
 * Resolve the operator-curated set of enabled runner profiles from a CSV env
 * value (`TAKOSUMI_ENABLED_RUNNER_PROFILES`, e.g.
 * `"cloudflare-default,aws-template,gcp-template"`).
 *
 * The returned list is the operator-curated provider surface: only the listed
 * profile ids appear (so `/v1/runner-profiles` and policy evaluation never see
 * an unlisted seed), and each listed profile is returned with
 * `labels["takosumi.com/profile-enabled"] = "true"` merged in so a template
 * seed passes the policy gate once the operator opts it in.
 *
 * Behavior:
 * - unset / empty / whitespace-only env -> defaults to `["cloudflare-default"]`.
 * - listed ids preserve the env's order; duplicates collapse to first wins.
 * - unknown ids (not present in `allProfiles`) are collected and warned, then
 *   skipped. This never throws — a typo in operator config degrades the surface
 *   rather than crashing the worker boot.
 */
export function resolveEnabledRunnerProfiles(
  allProfiles: readonly RunnerProfile[],
  envValue: string | undefined,
): readonly RunnerProfile[] {
  const byId = new Map(allProfiles.map((profile) => [profile.id, profile]));
  const requestedIds = parseEnabledRunnerProfileIds(envValue);
  const enabled: RunnerProfile[] = [];
  const unknownIds: string[] = [];
  for (const id of requestedIds) {
    const profile = byId.get(id);
    if (!profile) {
      unknownIds.push(id);
      continue;
    }
    enabled.push(withProfileEnabledLabel(profile));
  }
  if (unknownIds.length > 0) {
    log.warn("service.runner_profiles.unknown_enabled_ids", {
      unknownIds,
      knownIds: Array.from(byId.keys()),
    });
  }
  return enabled;
}

/**
 * Parse the CSV env value into a deduplicated, order-preserving list of profile
 * ids. Unset / empty / whitespace-only input defaults to `["cloudflare-default"]`.
 */
export function parseEnabledRunnerProfileIds(
  envValue: string | undefined,
): readonly string[] {
  const ids = (envValue ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (ids.length === 0) {
    return [DEFAULT_ENABLED_RUNNER_PROFILE_ID];
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  return deduped;
}

const DEFAULT_ENABLED_RUNNER_PROFILE_ID = "cloudflare-default";

function withProfileEnabledLabel(profile: RunnerProfile): RunnerProfile {
  return {
    ...profile,
    labels: {
      ...(profile.labels ?? {}),
      "takosumi.com/profile-enabled": "true",
    },
  };
}

export function createDefaultRunnerProfiles(
  now = Date.now(),
): readonly RunnerProfile[] {
  const cloudflareProvider = "registry.opentofu.org/cloudflare/cloudflare";
  const awsProvider = "registry.opentofu.org/hashicorp/aws";
  const gcpProvider = "registry.opentofu.org/hashicorp/google";
  const azureProvider = "registry.opentofu.org/hashicorp/azurerm";
  const kubernetesProvider = "registry.opentofu.org/hashicorp/kubernetes";
  const helmProvider = "registry.opentofu.org/hashicorp/helm";
  const dockerProvider = "registry.opentofu.org/kreuzwerker/docker";
  const githubProvider = "registry.opentofu.org/integrations/github";
  const digitalOceanProvider =
    "registry.opentofu.org/digitalocean/digitalocean";

  return [
    defaultProviderRunnerProfile(now, {
      id: "cloudflare-default",
      name: "Cloudflare default",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use Cloudflare resources.",
      allowedProviders: [cloudflareProvider],
      networkPolicy: networkFor("cloudflare"),
      cloudflareWorkersForPlatforms: {
        dispatchNamespace: providerById("cloudflare")!.hosting!.dispatchNamespace,
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
        apiProxy: providerById("cloudflare")!.hosting!.apiProxy,
      },
    }),
    defaultProviderRunnerProfile(now, {
      id: "aws-template",
      name: "AWS verified-space template",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use AWS resources.",
      allowedProviders: [awsProvider],
      labels: templateRunnerProfileLabels(),
      networkPolicy: networkFor("aws"),
    }),
    defaultProviderRunnerProfile(now, {
      id: "gcp-template",
      name: "GCP verified-space template",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use Google Cloud resources.",
      allowedProviders: [gcpProvider],
      labels: templateRunnerProfileLabels(),
      networkPolicy: networkFor("gcp"),
    }),
    defaultProviderRunnerProfile(now, {
      id: "azure-template",
      name: "Azure template",
      description:
        "Future/custom reference Cloudflare Container runner for OpenTofu modules that use Azure resources.",
      allowedProviders: [azureProvider],
      labels: templateRunnerProfileLabels(),
      networkPolicy: networkFor("azure"),
    }),
    defaultProviderRunnerProfile(now, {
      id: "kubernetes-template",
      name: "Kubernetes verified-space template",
      description:
        "Operator-managed OpenTofu runner for Kubernetes and Helm modules.",
      allowedProviders: [kubernetesProvider, helmProvider],
      labels: templateRunnerProfileLabels(),
      networkPolicy: networkFor("kubernetes"),
    }),
    defaultProviderRunnerProfile(now, {
      id: "github-template",
      name: "GitHub verified-space template",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use GitHub resources.",
      allowedProviders: [githubProvider],
      labels: templateRunnerProfileLabels(),
      networkPolicy: networkFor("github"),
    }),
    defaultProviderRunnerProfile(now, {
      id: "digitalocean-template",
      name: "DigitalOcean template",
      description:
        "Future/custom reference Cloudflare Container runner for OpenTofu modules that use DigitalOcean resources.",
      allowedProviders: [digitalOceanProvider],
      labels: templateRunnerProfileLabels(),
      networkPolicy: networkFor("digitalocean"),
    }),
    defaultProviderRunnerProfile(now, {
      id: "docker-custom-example",
      name: "Docker custom example",
      substrate: "local",
      description:
        "Provider env set example runner profile for OpenTofu modules that use a host Docker daemon.",
      allowedProviders: [dockerProvider],
      credentialRefs: [],
      cloudflareContainer: false,
      labels: templateRunnerProfileLabels(),
      networkPolicy: networkFor("docker"),
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
  queueName: "takosumi-runs",
  durableObjectBinding: "RUNNER",
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
  const credentialRefs =
    options.credentialRefs ??
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
          cloudflareContainer:
            options.cloudflareContainer ??
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
