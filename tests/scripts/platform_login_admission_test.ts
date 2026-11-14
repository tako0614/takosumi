import { expect, test } from "bun:test";
import {
  assertPlatformLoginAdmission,
  platformLoginAdmissionPredecessorSource,
  platformRateLimitBindings,
  verifyPlatformLoginStart,
} from "../../scripts/platform-login-admission.ts";

const origin = "https://app-staging.takosumi.com";
const issuer = "https://auth-staging.takos.jp";
const versionId = "44444444-4444-4444-8444-444444444444";
const baseline = 'name = "takosumi-staging"\n[vars]\nTAKOSUMI_SHARED_AUTH_PROFILE = "shared-account"\nTAKOSUMI_SHARED_AUTH_ORIGIN = "https://app-staging.takosumi.com"\n';
const source = baseline + '\n[[ratelimits]]\nname = "HOSTED_OIDC_LOGIN_GLOBAL_RATE_LIMITER"\nnamespace_id = "2026111401"\n[ratelimits.simple]\nlimit = 60\nperiod = 60\n[[ratelimits]]\nname = "HOSTED_OIDC_LOGIN_IP_RATE_LIMITER"\nnamespace_id = "2026111402"\n[ratelimits.simple]\nlimit = 10\nperiod = 60\n';

test("login admission projection removes exactly the reviewed two tuples, preserving every other value", () => {
  expect(Bun.TOML.parse(platformLoginAdmissionPredecessorSource(source, origin))).toEqual(Bun.TOML.parse(baseline));
  expect(assertPlatformLoginAdmission(source)).toBe(true);
  expect(assertPlatformLoginAdmission('name = "ordinary-oss"\n')).toBe(false);
  expect(() => assertPlatformLoginAdmission(baseline)).toThrow();
  for (const changed of [source.replace('"2026111402"', '"2026111401"'), source.replace("limit = 60", "limit = 61"), source.replace('namespace_id = "2026111401"', 'namespace_id = "0"'), source.replace("period = 60", "period = 30"), source + '\n[[ratelimits]]\nname = "EXTRA"\nnamespace_id = "3"\n[ratelimits.simple]\nlimit = 1\nperiod = 60\n']) {
    expect(() => platformLoginAdmissionPredecessorSource(changed, origin)).toThrow();
  }
  expect(() => platformRateLimitBindings({ ratelimits: [{ name: "EXTRA", namespace_id: "1", simple: { limit: 1, period: 60, future: true } }] })).toThrow();
});

test("fresh login-start smoke uses one anonymous manual GET and retains no redirect state", async () => {
  for (const status of [302, 303]) {
    let calls = 0;
    await verifyPlatformLoginStart({ origin, issuer, versionId, fetcher: async (url, init) => {
      calls++;
      expect(url).toBe(`${origin}/auth/oidc/login?return=%2F`);
      expect(init.redirect).toBe("manual");
      expect(new Headers(init.headers).has("cookie")).toBe(false);
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      return new Response(null, { status, headers: { location: `${issuer}/oauth/authorize?state=fixture-sensitive`, "x-takosumi-version-id": versionId } });
    } });
    expect(calls).toBe(1);
  }
});

test("fresh login-start smoke rejects unavailable, wrong origin/version/path and sanitizes failures", async () => {
  for (const response of [
    new Response(null, { status: 503 }), new Response(null, { status: 200 }),
    ...[
      ["https://foreign.test/oauth/authorize?state=fixture-sensitive", versionId],
      [`${issuer}/other?state=fixture-sensitive`, versionId],
      [`${issuer}/oauth/authorize?state=fixture-sensitive`, "different-version"],
    ].map(([location, version]) => new Response(null, { status: 302, headers: { location: location!, "x-takosumi-version-id": version! } })),
  ]) {
    let calls = 0;
    await expect(verifyPlatformLoginStart({ origin, issuer, versionId, fetcher: async () => { calls++; return response; } })).rejects.toThrow("platform_worker_login_start_readback_invalid");
    expect(calls).toBe(1);
  }
  await expect(verifyPlatformLoginStart({ origin, issuer, versionId, fetcher: async () => { throw new Error("fixture-sensitive-cookie"); } })).rejects.toThrow("platform_worker_login_start_readback_invalid");
});
