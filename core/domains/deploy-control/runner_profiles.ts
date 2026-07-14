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
import { CAPSULE_LIFECYCLE_COMMAND_CAPABILITY } from "takosumi-contract/install-configs";
import { log } from "../../shared/log.ts";

/** The provider-neutral runner selected for ordinary OpenTofu Capsules. */
export const DEFAULT_OPENTOFU_RUNNER_PROFILE_ID = "opentofu-default";
/** Explicit registry key used by the reference OpenTofu executor adapter. */
export const DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID = "opentofu.default";

/**
 * Resolve the operator-configured execution profiles. The default is the one
 * provider-neutral OpenTofu profile. Additional profiles are operator-defined
 * execution capabilities (for example a private-network or host-agent runner),
 * never built-in provider brands.
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
    enabled.push(activateRequestedProfile(profile));
  }
  if (unknownIds.length > 0) {
    log.warn("service.runner_profiles.unknown_enabled_ids", {
      unknownIds,
      knownIds: Array.from(byId.keys()),
    });
  }
  return enabled;
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

function activateRequestedProfile(profile: RunnerProfile): RunnerProfile {
  assertRunnerProfileAvailable(profile);
  if (profile.lifecycle.state === "active") return profile;
  return {
    ...profile,
    lifecycle: { state: "active" },
  };
}

export function createDefaultRunnerProfiles(
  now = Date.now(),
): readonly RunnerProfile[] {
  return [createDefaultOpenTofuRunnerProfile(now)];
}

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
    substrate: "operator-managed",
    executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
    lifecycle: { state: "active" },
    availability: { state: "available" },
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
    capabilities: [CAPSULE_LIFECYCLE_COMMAND_CAPABILITY],
    allowedProviders: ["*"],
    requireProviderBindings: false,
    resourceLimits: DEFAULT_RESOURCE_LIMITS,
    // The runner host enforces public-egress isolation. Private, link-local,
    // metadata, control-plane, or host-socket access requires a separate
    // operator-defined execution profile.
    networkPolicy: { mode: "operator-managed" },
    secretExposurePolicy: DEFAULT_SECRET_EXPOSURE_POLICY,
    createdAt: now,
  };
}

function assertRunnerProfileAvailable(profile: RunnerProfile): void {
  if (!profile.executorId?.trim()) {
    throw new Error(`runner profile ${profile.id} requires executorId`);
  }
  if (!profile.lifecycle) {
    throw new Error(`runner profile ${profile.id} requires lifecycle`);
  }
  if (!profile.availability) {
    throw new Error(`runner profile ${profile.id} requires availability`);
  }
  if (
    profile.lifecycle.state !== "active" &&
    profile.lifecycle.state !== "candidate" &&
    profile.lifecycle.state !== "reserved"
  ) {
    throw new Error(
      `runner profile ${profile.id} has invalid lifecycle state ${String(profile.lifecycle.state)}`,
    );
  }
  if (profile.availability.state !== "available") {
    throw new Error(
      `runner profile ${profile.id} is unavailable` +
        (profile.availability.reason ? `: ${profile.availability.reason}` : ""),
    );
  }
  if (profile.lifecycle.state !== "reserved") return;
  throw new Error(
    `runner profile ${profile.id} is reserved and cannot be activated` +
      (profile.lifecycle.reason ? `: ${profile.lifecycle.reason}` : ""),
  );
}
