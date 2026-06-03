/**
 * Shared SSRF host blocklist for deploy control source fetchers.
 *
 * Both the git source fetcher and the prepared-source fetcher accept a
 * caller-supplied URL and reach out over the network on the operator's
 * behalf. To avoid the service being used as a confused deputy against
 * loopback / RFC1918 / link-local / cloud-metadata addresses, every IP
 * literal in a source URL is classified here and rejected before any
 * subprocess (`git clone`) or `fetch()` runs.
 *
 * Hostnames are deliberately NOT resolved here. DNS resolution would itself
 * be a network side-effect and is racy (DNS rebinding), so operators are
 * expected to constrain the service's network egress to trusted destinations.
 * This module only closes the literal-IP hole that egress policy alone is
 * awkward to express.
 */

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
    if (isBlockedIpv4(literal)) {
      throw new BlockedHostError(label, host);
    }
    return;
  }
  const groups = parseIpv6(literal);
  if (groups !== null) {
    if (isBlockedIpv6(groups)) {
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

function isIpv4Literal(value: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value);
}

function isBlockedIpv4(value: string): boolean {
  const parts = value.split(".").map((segment) => Number.parseInt(segment, 10));
  if (
    parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
  ) {
    // Malformed literal — treat as blocked to fail closed.
    return true;
  }
  const [a, b, c, d] = parts;
  // Loopback 127.0.0.0/8
  if (a === 127) return true;
  // RFC1918 private 10/8, 172.16/12, 192.168/16
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Link-local 169.254.0.0/16 (covers AWS/GCP metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8
  if (a === 0) return true;
  // Multicast / reserved high ranges
  if (a >= 224) return true;
  // Carrier-grade NAT 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) return true;
  // Broadcast
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;
  return false;
}

/**
 * Parse an IPv6 literal into its 8 16-bit groups, expanding `::` and folding
 * any trailing embedded IPv4 (`::ffff:1.2.3.4`). Returns null when `value` is
 * not a syntactically valid IPv6 literal (the caller then treats it as a DNS
 * hostname). This replaces textual shape-matching so equivalent forms
 * (`::1`, `0:0:0:0:0:0:0:1`, `0000:...:0001`) all classify identically.
 */
export function parseIpv6(value: string): readonly number[] | null {
  if (!value.includes(":")) return null;
  // Strip an optional zone id (`fe80::1%eth0`); it never affects classification.
  const zoneSplit = value.indexOf("%");
  let addr = zoneSplit === -1 ? value : value.slice(0, zoneSplit);

  // A literal may end with an embedded IPv4 dotted quad in its last 32 bits
  // (`::ffff:1.2.3.4`). Rewrite that quad into two hex groups so the rest of
  // the parse only deals with colon-separated hex groups.
  const lastColon = addr.lastIndexOf(":");
  const tail = addr.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!isIpv4Literal(tail)) return null;
    const octets = tail.split(".").map((o) => Number.parseInt(o, 10));
    if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null;
    const high = ((octets[0] << 8) | octets[1]) & 0xffff;
    const low = ((octets[2] << 8) | octets[3]) & 0xffff;
    addr = `${addr.slice(0, lastColon + 1)}${high.toString(16)}:${
      low.toString(16)
    }`;
  }

  const doubleColon = addr.indexOf("::");
  let leftPart: string;
  let rightPart: string;
  let hasDoubleColon = false;
  if (doubleColon !== -1) {
    if (addr.indexOf("::", doubleColon + 1) !== -1) return null; // only one `::`
    hasDoubleColon = true;
    leftPart = addr.slice(0, doubleColon);
    rightPart = addr.slice(doubleColon + 2);
  } else {
    leftPart = addr;
    rightPart = "";
  }

  const parseGroups = (part: string): number[] | null => {
    if (part.length === 0) return [];
    const out: number[] = [];
    for (const token of part.split(":")) {
      if (token.length === 0 || token.length > 4) return null;
      if (!/^[0-9a-f]+$/i.test(token)) return null;
      out.push(Number.parseInt(token, 16) & 0xffff);
    }
    return out;
  };

  const left = parseGroups(leftPart);
  const right = parseGroups(rightPart);
  if (left === null || right === null) return null;

  let groups: number[];
  if (hasDoubleColon) {
    const fill = 8 - (left.length + right.length);
    if (fill < 0) return null;
    groups = [...left, ...new Array<number>(fill).fill(0), ...right];
  } else {
    groups = [...left, ...right];
  }
  if (groups.length !== 8) return null;
  return groups;
}

function isBlockedIpv6(groups: readonly number[]): boolean {
  const [g0, g1, , , , g5, g6, g7] = groups;
  // Unspecified ::
  if (groups.every((g) => g === 0)) return true;
  // Loopback ::1
  if (
    g0 === 0 && g1 === 0 && groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0 && g5 === 0 && g6 === 0 && g7 === 1
  ) {
    return true;
  }
  // fc00::/7 unique local (fc.. or fd..)
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // ff00::/8 multicast
  if ((g0 & 0xff00) === 0xff00) return true;
  // IPv4-mapped ::ffff:a.b.c.d (g0..g4 == 0, g5 == 0xffff): re-check IPv4.
  if (
    g0 === 0 && g1 === 0 && groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0 && g5 === 0xffff
  ) {
    if (isBlockedIpv4(groupsToDotted(g6, g7))) return true;
  }
  // Deprecated IPv4-compatible ::a.b.c.d (top 96 bits zero). ::/96 is IANA
  // reserved, so rejecting the whole range on a blocked low quad is safe.
  if (
    g0 === 0 && g1 === 0 && groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0 && g5 === 0 && !(g6 === 0 && g7 <= 1)
  ) {
    if (isBlockedIpv4(groupsToDotted(g6, g7))) return true;
  }
  // NAT64 well-known prefix 64:ff9b::/96 wrapping an IPv4 — classify the
  // embedded address (e.g. 64:ff9b::169.254.169.254 -> metadata).
  if (
    g0 === 0x64 && g1 === 0xff9b && groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0 && g5 === 0
  ) {
    if (isBlockedIpv4(groupsToDotted(g6, g7))) return true;
  }
  // 6to4 2002:V4ADDR::/48 embeds an IPv4 in the next 32 bits after 2002.
  if (g0 === 0x2002) {
    if (isBlockedIpv4(groupsToDotted(g1, groups[2]))) return true;
  }
  return false;
}

function groupsToDotted(high: number, low: number): string {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${
    low & 0xff
  }`;
}
