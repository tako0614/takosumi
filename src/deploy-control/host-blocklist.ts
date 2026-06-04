/**
 * Deploy-control re-export of the canonical SSRF host blocklist.
 *
 * The blocklist logic now lives in `takosumi-contract/reference/host-blocklist`
 * so the single IPv4/IPv6 classifier is shared, byte-identical, with the
 * runtime-agent prepared-source reader and cannot drift between the two SSRF
 * call sites. This module stays as the deploy-control import surface
 * (git-fetch / prepared-source / service validation all import `./host-blocklist.ts`).
 */

export {
  assertHostNotBlocked,
  BlockedHostError,
  parseIpv6,
} from "takosumi-contract/reference/host-blocklist";
