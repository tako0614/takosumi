/**
 * RunnerProfile policy engine for the deploy-control domain.
 *
 * `evaluatePolicy` derives a `PolicyDecision` from a runner profile and the
 * providers a plan declares/observes: template-disabled gating, required
 * providers, allow/deny lists, and credential-reference presence. Pure
 * functions over contract types; no controller or store state.
 */

import type {
  PolicyDecision,
  RunnerProfile,
} from "takosumi-contract/deploy-control-api";

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
  const templateReason = templateProfileDisabledReason(input.profile);
  if (templateReason) reasons.push(templateReason);
  if (
    input.profile.allowedProviders.length > 0 &&
    input.requiredProviders.length === 0 &&
    input.allowNoProviders !== true
  ) {
    reasons.push(
      `runner profile ${input.profile.id} requires requiredProviders before OpenTofu init`,
    );
  }
  for (const provider of input.requiredProviders) {
    if (providerDenied(provider, input.profile.deniedProviders ?? [])) {
      reasons.push(`provider ${provider} is denied by runner profile ${input.profile.id}`);
      continue;
    }
    if (!providerAllowed(provider, input.profile.allowedProviders)) {
      reasons.push(`provider ${provider} is not allowed by runner profile ${input.profile.id}`);
    }
    if (
      input.profile.requireCredentialRefs === true &&
      !credentialRefPresent(provider, input.profile.credentialRefs ?? [])
    ) {
      reasons.push(
        `credential reference for provider ${provider} is missing from runner profile ${input.profile.id}`,
      );
    }
  }
  return {
    status: reasons.length === 0 ? "passed" : "blocked",
    reasons,
    checkedAt: input.checkedAt,
  };
}

function templateProfileDisabledReason(profile: RunnerProfile): string | undefined {
  if (profile.labels?.["takosumi.com/profile-state"] !== "template") {
    return undefined;
  }
  if (profile.labels?.["takosumi.com/profile-enabled"] === "true") {
    return undefined;
  }
  return `runner profile ${profile.id} is a disabled template; clone it or set takosumi.com/profile-enabled=true after operator validation`;
}

function credentialRefPresent(
  provider: string,
  refs: NonNullable<RunnerProfile["credentialRefs"]>,
): boolean {
  return refs.some((ref) => providerMatches(provider, ref.provider));
}

function providerAllowed(
  provider: string,
  allowedProviders: readonly string[],
): boolean {
  return allowedProviders.some((allowed) =>
    allowed === "*" || providerMatches(provider, allowed)
  );
}

function providerDenied(
  provider: string,
  deniedProviders: readonly string[],
): boolean {
  return deniedProviders.some((denied) => providerMatches(provider, denied));
}

export function providerMatches(provider: string, rule: string): boolean {
  // Hierarchical, one-directional: a fully-qualified provider address
  // (`registry/namespace/type`) matches a short allowlist rule (its trailing
  // type), e.g. `registry.opentofu.org/cloudflare/cloudflare` matches rule
  // `cloudflare`. The reverse must NOT hold — a specific fully-qualified RULE
  // must not admit an ambiguous bare provider name (e.g. rule
  // `registry.opentofu.org/hashicorp/aws` must not match provider `aws`), which
  // would silently widen the allowlist (and inconsistently narrow the denylist).
  return provider === rule || provider.endsWith(`/${rule}`);
}
