/**
 * Default OpenTofu runner profile seed data.
 *
 * Provider identity is deliberately not part of runner selection. Every valid
 * OpenTofu provider uses the same isolated execution surface; provider-specific
 * credential convenience belongs to Credential Recipes and Provider
 * Connections, while explicit operator deny policy remains the admission
 * boundary.
 */

import type { RunnerProfile } from "@takosumi/internal/deploy-control-api";
import { log } from "../../shared/log.ts";

export {
  CREDENTIAL_FREE_UTILITY_PROVIDER_ADDRESSES,
  isCredentialFreeUtilityProvider,
} from "takosumi-contract/provider-env-rules";

/** The provider-neutral runner selected for ordinary OpenTofu Capsules. */
export const DEFAULT_OPENTOFU_RUNNER_PROFILE_ID = "opentofu-default";

/**
 * Resolve the operator-configured execution profiles. The default is the one
 * provider-neutral OpenTofu profile. Additional profiles are operator-defined
 * execution capabilities (for example a private-network or host-agent runner),
 * never built-in provider brands.
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

/** Parse a deduplicated CSV profile list; an empty value selects the default. */
export function parseEnabledRunnerProfileIds(
  envValue: string | undefined,
): readonly string[] {
  const ids = (envValue ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (ids.length === 0) return [DEFAULT_OPENTOFU_RUNNER_PROFILE_ID];

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  return deduped;
}

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
  return [createDefaultOpenTofuRunnerProfile(now)];
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

function createDefaultOpenTofuRunnerProfile(now: number): RunnerProfile {
  const id = DEFAULT_OPENTOFU_RUNNER_PROFILE_ID;
  return {
    id,
    name: "OpenTofu default",
    substrate: "cloudflare-containers",
    description:
      "Isolated provider-neutral runner for plain OpenTofu modules. Provider packages use the configured mirror/cache when present and the OpenTofu registry path otherwise.",
    tofuVersion: "operator-managed",
    stateBackend: {
      kind: "operator-managed",
      ref: `state://takosumi/${id}`,
      lock: {
        kind: "operator",
        ref: `lock://takosumi/${id}`,
      },
    },
    allowedProviders: ["*"],
    requireCredentialRefs: false,
    resourceLimits: DEFAULT_RESOURCE_LIMITS,
    // The runner host enforces public-egress isolation. Private, link-local,
    // metadata, control-plane, or host-socket access requires a separate
    // operator-defined execution profile.
    networkPolicy: { mode: "operator-managed" },
    cloudflareContainer: DEFAULT_CLOUDFLARE_CONTAINER_EXECUTION,
    secretExposurePolicy: DEFAULT_SECRET_EXPOSURE_POLICY,
    labels: {
      "takosumi.com/opentofu-runner": "true",
      "takosumi.com/provider-installation": "direct-allowed",
    },
    createdAt: now,
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
