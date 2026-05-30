import assert from "node:assert/strict";
import {
  assertHostNotBlocked,
  BlockedHostError,
  parseIpv6,
} from "./host-blocklist.ts";

function isBlocked(host: string): boolean {
  try {
    assertHostNotBlocked(host, "test host");
    return false;
  } catch (err) {
    if (err instanceof BlockedHostError) return true;
    throw err;
  }
}

Deno.test("parseIpv6 expands compressed, full, and zero-padded loopback equally", () => {
  const a = parseIpv6("::1");
  const b = parseIpv6("0:0:0:0:0:0:0:1");
  const c = parseIpv6("0000:0000:0000:0000:0000:0000:0000:0001");
  assert.deepEqual(a, [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
});

Deno.test("parseIpv6 folds an embedded IPv4 tail", () => {
  assert.deepEqual(parseIpv6("::ffff:127.0.0.1"), [
    0,
    0,
    0,
    0,
    0,
    0xffff,
    0x7f00,
    0x0001,
  ]);
});

Deno.test("parseIpv6 returns null for non-IPv6 and rejects double '::'", () => {
  assert.equal(parseIpv6("example.test"), null);
  assert.equal(parseIpv6("1::2::3"), null);
  assert.equal(parseIpv6("12345::1"), null);
});

Deno.test("assertHostNotBlocked blocks loopback in every textual form", () => {
  assert.ok(isBlocked("127.0.0.1"));
  assert.ok(isBlocked("[::1]"));
  assert.ok(isBlocked("[0:0:0:0:0:0:0:1]"));
  assert.ok(isBlocked("[0000:0000:0000:0000:0000:0000:0000:0001]"));
});

Deno.test("assertHostNotBlocked blocks NAT64 and 6to4 wrapping internal IPv4", () => {
  // 64:ff9b::169.254.169.254 (metadata) and 2002:a00:1:: (10.0.0.1).
  assert.ok(isBlocked("[64:ff9b::a9fe:a9fe]"));
  assert.ok(isBlocked("[2002:0a00:0001::1]"));
});

Deno.test("assertHostNotBlocked blocks ULA, link-local, multicast, mapped, compat", () => {
  assert.ok(isBlocked("[fd00::1]"));
  assert.ok(isBlocked("[fe80::1]"));
  assert.ok(isBlocked("[ff02::1]"));
  assert.ok(isBlocked("[::ffff:169.254.169.254]"));
  assert.ok(isBlocked("[::127.0.0.1]"));
});

Deno.test("assertHostNotBlocked allows public IP literals and hostnames", () => {
  assert.ok(!isBlocked("93.184.216.34")); // example.com
  assert.ok(!isBlocked("[2606:2800:220:1:248:1893:25c8:1946]"));
  assert.ok(!isBlocked("github.com"));
});
