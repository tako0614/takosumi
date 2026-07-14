/**
 * Canonical SSRF host blocklist shared across source fetchers.
 *
 * Source validation accepts a caller-supplied URL that the OpenTofu Runner may
 * fetch on the operator's behalf. To avoid the service being used as a
 * confused deputy against loopback / RFC1918 / link-local / cloud-metadata
 * addresses, every IP literal in a source URL is classified here and rejected
 * before any subprocess (`git clone`) or `fetch()` runs.
 *
 * The IPv4/IPv6 range checks are NOT re-derived here: they delegate to the
 * single canonical classifier `contract/reference/ip-classification.ts`, the
 * lowest module both the deploy-control domain and `takos` import. A
 * security-critical classifier replicated by hand drifts (this copy used to
 * miss the TEST-NET / benchmark / 192.0.0.0/24 ranges that worker egress
 * blocked); folding onto the shared classifier closes that drift. This module
 * keeps only the host-specific concern: stripping IPv6 brackets and throwing
 * the typed {@link BlockedHostError} that callers map to a 4xx.
 *
 * Hostnames are deliberately NOT resolved here. DNS resolution would itself
 * be a network side-effect and is racy (DNS rebinding), so operators are
 * expected to constrain the service's network egress to trusted destinations.
 * This module only closes the literal-IP hole that egress policy alone is
 * awkward to express.
 */

import {
  isIpv4Literal,
  isPrivateIpv4,
  isPrivateIpv6Groups,
  parseIpv6,
} from "./ip-classification.ts";

export class BlockedHostError extends Error {
  constructor(label: string, host: string) {
    super(`${label} is not allowed: ${host}`);
    this.name = "BlockedHostError";
  }
}

/**
 * Reject `host` (which may be a bracketed IPv6 literal, an IPv4 literal, or a
 * DNS hostname) when it parses to a blocked IP literal. Hostnames pass
 * through. Throws {@link BlockedHostError} with `label` for diagnostics.
 */
export function assertHostNotBlocked(host: string, label: string): void {
  const literal = stripIpv6Brackets(host);
  if (isIpv4Literal(literal)) {
    if (isPrivateIpv4(literal)) {
      throw new BlockedHostError(label, host);
    }
    return;
  }
  const groups = parseIpv6(literal);
  if (groups !== null) {
    if (isPrivateIpv6Groups(groups)) {
      throw new BlockedHostError(label, host);
    }
    return;
  }
  // Not an IP literal: a DNS hostname. Operators control egress.
}

function stripIpv6Brackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}
