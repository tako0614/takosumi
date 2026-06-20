import { expect, test } from "bun:test";
import {
  assertHostNotBlocked,
  BlockedHostError,
} from "../../../contract/reference/host-blocklist.ts";

function isBlocked(host: string): boolean {
  try {
    assertHostNotBlocked(host, "test host");
    return false;
  } catch (error) {
    if (error instanceof BlockedHostError) return true;
    throw error;
  }
}

test("assertHostNotBlocked blocks private / metadata IPv4 literals", () => {
  for (
    const host of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254", // link-local cloud metadata
      "0.0.0.0",
      "100.64.0.1", // carrier-grade NAT
      "224.0.0.1", // multicast
      "255.255.255.255", // limited broadcast
    ]
  ) {
    expect(isBlocked(host)).toEqual(true);
  }
});

// The classifier now delegates to the canonical
// `contract/reference/ip-classification` superset. Before that collapse this
// blocklist missed these special-use ranges while worker egress blocked them —
// a live SSRF drift on the deploy-control / runtime-agent fetchers. Lock in the
// stronger classification so the drift cannot silently return.
test("assertHostNotBlocked blocks previously-missed special-use IPv4 ranges", () => {
  for (
    const host of [
      "192.0.0.1", // IETF protocol assignments (192.0.0.0/24)
      "192.0.2.5", // TEST-NET-1
      "198.18.0.1", // benchmarking (198.18.0.0/15)
      "198.51.100.7", // TEST-NET-2
      "203.0.113.9", // TEST-NET-3
    ]
  ) {
    expect(isBlocked(host)).toEqual(true);
  }
});

test("assertHostNotBlocked blocks private / metadata IPv6 forms", () => {
  for (
    const host of [
      "::1",
      "[::1]",
      "::",
      "fc00::1",
      "fd00::1",
      "fe80::1",
      "ff02::1",
      "::ffff:169.254.169.254", // IPv4-mapped metadata
      "64:ff9b::169.254.169.254", // NAT64 metadata
      "2002:a9fe:a9fe::1", // 6to4 wrapping 169.254.169.254
    ]
  ) {
    expect(isBlocked(host)).toEqual(true);
  }
});

test("assertHostNotBlocked passes public addresses and DNS hostnames", () => {
  for (
    const host of [
      "8.8.8.8",
      "2001:4860:4860::8888",
      "example.com",
      "github.com",
    ]
  ) {
    expect(isBlocked(host)).toEqual(false);
  }
});
