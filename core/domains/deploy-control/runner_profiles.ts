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

// Per-provider egress policy is owned by the provider runtime registry (single
// source of truth); a runner profile owns only its presentation + runtime. `id`
// is the provider id (e.g. "cloudflare"), not the runner profile id.
function networkFor(id: string): NonNullable<RunnerProfile["networkPolicy"]> {
  return requireProvider(id).network;
}

// The provider source addresses are likewise owned by the registry: a runner
// profile's allowedProviders list is just the provider's OpenTofu provider
// addresses, not a re-declared literal. `id` is the provider id (the
// kubernetes provider already carries both its kubernetes + helm addresses).
function providerAddressesFor(id: string): readonly string[] {
  return requireProvider(id).providerAddresses;
}

function requireProvider(id: string) {
  const provider = providerById(id);
  if (!provider) {
    throw new Error(`no provider runtime registered for "${id}"`);
  }
  return provider;
}

/**
 * Resolve the operator-curated set of enabled runner profiles from a CSV env
 * value (`TAKOSUMI_ENABLED_RUNNER_PROFILES`, e.g.
 * `"cloudflare-default,aws-provider-env-candidate,gcp-provider-env-candidate"`).
 *
 * The returned list is the operator-curated provider surface: only the listed
 * profile ids appear (so `/v1/runner-profiles` and policy evaluation never see
 * an unlisted seed), and each listed profile is returned with
 * `labels["takosumi.com/profile-enabled"] = "true"` merged in so a candidate
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
  options: RunnerProfileEnablementOptions = {},
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
    enabled.push(withProfileEnabledLabel(profile, options));
  }
  if (unknownIds.length > 0) {
    log.warn("service.runner_profiles.unknown_enabled_ids", {
      unknownIds,
      knownIds: Array.from(byId.keys()),
    });
  }
  return enabled;
}

export interface RunnerProfileEnablementOptions {
  readonly requireGatewayEgressEvidence?: boolean;
  readonly egressEnforcementEvidenceRef?: string;
  readonly egressEnforcementEvidenceDigest?: string;
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

function withProfileEnabledLabel(
  profile: RunnerProfile,
  _options: RunnerProfileEnablementOptions,
): RunnerProfile {
  assertRunnerProfileAvailable(profile);
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
  return [
    defaultProviderRunnerProfile(now, {
      id: "cloudflare-default",
      name: "Cloudflare default",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use Cloudflare resources.",
      allowedProviders: providerAddressesFor("cloudflare"),
      networkPolicy: networkFor("cloudflare"),
      labels: providerRunnerProfileLabels(),
    }),
    defaultProviderRunnerProfile(now, {
      id: "aws-provider-env-candidate",
      name: "AWS Provider Env candidate",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use AWS resources.",
      allowedProviders: providerAddressesFor("aws"),
      labels: candidateRunnerProfileLabels(),
      networkPolicy: networkFor("aws"),
    }),
    defaultProviderRunnerProfile(now, {
      id: "gcp-provider-env-candidate",
      name: "GCP Provider Env candidate",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use Google Cloud resources with service-account JSON Provider Connections.",
      allowedProviders: providerAddressesFor("gcp"),
      labels: candidateRunnerProfileLabels(),
      networkPolicy: networkFor("gcp"),
    }),
    defaultProviderRunnerProfile(now, {
      id: "azure-provider-env-candidate",
      name: "Azure Provider Env candidate",
      description:
        "Future/custom reference Cloudflare Container runner for OpenTofu modules that use Azure resources.",
      allowedProviders: providerAddressesFor("azure"),
      labels: candidateRunnerProfileLabels(),
      networkPolicy: networkFor("azure"),
    }),
    defaultProviderRunnerProfile(now, {
      id: "kubernetes-provider-env-candidate",
      name: "Kubernetes Provider Env candidate",
      description:
        "Operator-managed OpenTofu runner for Kubernetes and Helm modules.",
      allowedProviders: providerAddressesFor("kubernetes"),
      labels: candidateRunnerProfileLabels(),
      networkPolicy: networkFor("kubernetes"),
    }),
    defaultProviderRunnerProfile(now, {
      id: "github-provider-env-candidate",
      name: "GitHub Provider Env candidate",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use GitHub resources.",
      allowedProviders: providerAddressesFor("github"),
      labels: candidateRunnerProfileLabels(),
      networkPolicy: networkFor("github"),
    }),
    defaultProviderRunnerProfile(now, {
      id: "digitalocean-provider-env-candidate",
      name: "DigitalOcean Provider Env candidate",
      description:
        "Future/custom reference Cloudflare Container runner for OpenTofu modules that use DigitalOcean resources.",
      allowedProviders: providerAddressesFor("digitalocean"),
      labels: candidateRunnerProfileLabels(),
      networkPolicy: networkFor("digitalocean"),
    }),
    defaultProviderRunnerProfile(now, {
      id: "docker-custom-example",
      name: "Docker custom example",
      substrate: "local",
      description:
        "Generic-env provider example runner profile for OpenTofu modules that use a host Docker daemon.",
      allowedProviders: providerAddressesFor("docker"),
      credentialRefs: [],
      cloudflareContainer: false,
      labels: candidateRunnerProfileLabels(),
      networkPolicy: networkFor("docker"),
    }),
    defaultProviderRunnerProfile(now, {
      id: "generic-opentofu-provider",
      name: "Generic OpenTofu provider",
      description:
        "Operator-enabled runner profile for arbitrary OpenTofu providers using explicit generic-env Provider Connections.",
      allowedProviders: ["*"],
      credentialRefs: [],
      labels: {
        ...candidateRunnerProfileLabels(),
        "takosumi.com/provider-surface": "generic",
      },
      networkPolicy: {
        mode: "operator-managed",
      },
    }),
  ];
}

function providerRunnerProfileLabels(): Readonly<Record<string, string>> {
  return {
    "takosumi.com/provider-runner": "true",
  };
}

interface DefaultProviderRunnerProfileOptions {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly allowedProviders: readonly string[];
  readonly substrate?: string;
  readonly credentialRefs?: RunnerProfile["credentialRefs"];
  readonly cloudflareContainer?: RunnerProfile["cloudflareContainer"] | false;
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
    secretExposurePolicy: DEFAULT_SECRET_EXPOSURE_POLICY,
    ...(options.labels ? { labels: options.labels } : {}),
    createdAt: now,
  };
}

function candidateRunnerProfileLabels(): Readonly<Record<string, string>> {
  return {
    "takosumi.com/profile-state": "candidate",
  };
}

function assertRunnerProfileAvailable(profile: RunnerProfile): void {
  if (profile.labels?.["takosumi.com/profile-state"] !== "reserved") return;
  const reason = profile.labels["takosumi.com/profile-reserved-reason"];
  throw new Error(
    `runner profile ${profile.id} is reserved and cannot be enabled` +
      (reason ? `: ${reason}` : ""),
  );
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
