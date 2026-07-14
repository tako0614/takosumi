/**
 * RunnerProfile policy engine for the deploy-control domain.
 *
 * `evaluatePolicy` derives a `PolicyDecision` from a runner profile and the
 * providers a plan declares/observes: template-disabled gating + the §25 layer-4
 * provider allowlist (delegated to `takosumi-policy`). Explicit ProviderBinding
 * requirements are enforced by connection resolution, not duplicated here as
 * RunnerProfile credential refs. This file is a thin adapter: the provider-allowlist core lives in
 * the policy package; here it is composed with the profile-specific concerns
 * (explicit lifecycle/availability, credential refs) into the contract
 * `PolicyDecision`.
 * Pure functions over contract types; no controller or store state.
 */

import type {
  PolicyDecision,
  RunnerProfile,
} from "@takosumi/internal/deploy-control-api";
import { evaluateProviderAllowlist, providerMatches } from "takosumi-policy";

export function evaluatePolicy(input: {
  readonly profile: RunnerProfile;
  readonly requiredProviders: readonly string[];
  readonly checkedAt: number;
  /**
   * Whether a run with zero required providers is intentional (skips the
   * "requiredProviders before OpenTofu init" gate). Set for a §10 provider-free
   * install — a template whose policy declares zero allowed providers, e.g.
   * `core`, which is pure value plumbing with no cloud resources. A raw cloud run
   * still must declare providers (the gate's original purpose).
   */
  readonly allowNoProviders?: boolean;
}): PolicyDecision {
  const reasons: string[] = [];
  reasons.push(...runnerProfileStateReasons(input.profile));
  // §25 layer 4 (provider allowlist) lives in the policy package. The
  // profile-scoped reason wording is rebuilt here so the contract reasons keep
  // naming the runner profile (the package is profile-agnostic).
  const provider = evaluateProviderAllowlist(input.requiredProviders, {
    allowed: input.profile.allowedProviders,
    denied: input.profile.deniedProviders ?? [],
    ...(input.allowNoProviders ? { allowNoProviders: true } : {}),
  });
  if (provider.missingProviders) {
    reasons.push(
      `runner profile ${input.profile.id} requires requiredProviders before OpenTofu init`,
    );
  }
  for (const denied of provider.denied) {
    reasons.push(
      `provider ${denied} is denied by runner profile ${input.profile.id}`,
    );
  }
  for (const notAllowed of provider.notAllowed) {
    reasons.push(
      `provider ${notAllowed} is not allowed by runner profile ${input.profile.id}`,
    );
  }
  return {
    status: reasons.length === 0 ? "passed" : "blocked",
    reasons,
    checkedAt: input.checkedAt,
  };
}

function runnerProfileStateReasons(profile: RunnerProfile): readonly string[] {
  const reasons: string[] = [];
  if (!profile.lifecycle || profile.lifecycle.state !== "active") {
    const state = profile.lifecycle?.state ?? "missing";
    reasons.push(
      `runner profile ${profile.id} lifecycle is ${state}; only active profiles can execute` +
        (profile.lifecycle?.reason ? `: ${profile.lifecycle.reason}` : ""),
    );
  }
  if (!profile.availability || profile.availability.state !== "available") {
    reasons.push(
      `runner profile ${profile.id} is unavailable` +
        (profile.availability?.reason
          ? `: ${profile.availability.reason}`
          : ""),
    );
  }
  if (!profile.executorId?.trim()) {
    reasons.push(`runner profile ${profile.id} has no executorId`);
  }
  return reasons;
}

export { providerMatches } from "takosumi-policy";
