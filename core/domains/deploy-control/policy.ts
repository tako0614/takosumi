/**
 * RunnerProfile policy engine for the deploy-control domain.
 *
 * `evaluatePolicy` derives a `PolicyDecision` from a runner profile and the
 * providers a plan declares/observes: template-disabled gating + the §25 layer-4
 * provider allowlist (delegated to `takosumi-policy`) + credential-reference
 * presence. This file is a thin adapter: the provider-allowlist core lives in
 * the policy package; here it is composed with the profile-specific concerns
 * (template-disabled state, credential refs) into the contract `PolicyDecision`.
 * Pure functions over contract types; no controller or store state.
 */

import type {
  PolicyDecision,
  RunnerProfile,
} from "@takosumi/internal/deploy-control-api";
import { evaluateProviderAllowlist, providerMatches } from "takosumi-policy";
import { isCredentialFreeUtilityProvider } from "./runner_profiles.ts";

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
  const candidateReason = candidateProfileDisabledReason(input.profile);
  if (candidateReason) reasons.push(candidateReason);
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
  // Credential-reference presence is a profile concern (the package evaluates
  // only the allow/deny verdict): a denied provider is skipped (its credential
  // is moot), a not-allowed provider is still checked to surface a complete set.
  if (input.profile.requireCredentialRefs === true) {
    for (const provider2 of input.requiredProviders) {
      if (providerDenied(provider2, input.profile.deniedProviders ?? []))
        continue;
      if (isCredentialFreeUtilityProvider(provider2)) continue;
      if (
        !credentialRefPresent(provider2, input.profile.credentialRefs ?? [])
      ) {
        reasons.push(
          `credential reference for provider ${provider2} is missing from runner profile ${input.profile.id}`,
        );
      }
    }
  }
  return {
    status: reasons.length === 0 ? "passed" : "blocked",
    reasons,
    checkedAt: input.checkedAt,
  };
}

function candidateProfileDisabledReason(
  profile: RunnerProfile,
): string | undefined {
  if (profile.labels?.["takosumi.com/profile-state"] !== "candidate") {
    return undefined;
  }
  if (profile.labels?.["takosumi.com/profile-enabled"] === "true") {
    return undefined;
  }
  return `runner profile ${profile.id} is a disabled candidate; set takosumi.com/profile-enabled=true after operator validation`;
}

function credentialRefPresent(
  provider: string,
  refs: NonNullable<RunnerProfile["credentialRefs"]>,
): boolean {
  return refs.some((ref) => providerMatches(provider, ref.provider));
}

function providerDenied(
  provider: string,
  deniedProviders: readonly string[],
): boolean {
  return deniedProviders.some((denied) => providerMatches(provider, denied));
}

export { providerMatches } from "takosumi-policy";
