import { expect, jest, test } from "bun:test";
import { handleSharedAuthRouteRequest } from "../../../worker/src/shared_auth_rpc.ts";

const origin = "https://hosted.staging.example.test";
function fixture(globalSuccess = true, clientSuccess = true) {
  const calls: { kind: string; key: string }[] = [];
  let rpcCalls = 0;
  const env = {
    TAKOSUMI_SHARED_AUTH_PROFILE: "shared-account",
    TAKOSUMI_SHARED_AUTH_ORIGIN: origin,
    TAKOSUMI_ENVIRONMENT: "staging",
    HOSTED_OIDC_LOGIN_GLOBAL_RATE_LIMITER: { limit: async ({ key }: { key: string }) => {
      calls.push({ kind: "global", key });
      return { success: globalSuccess };
    } },
    HOSTED_OIDC_LOGIN_IP_RATE_LIMITER: { limit: async ({ key }: { key: string }) => {
      calls.push({ kind: "client", key });
      return { success: clientSuccess };
    } },
    HOSTED: {
      fetchSharedAuth: async (request: Request) => {
        rpcCalls++;
        return new Response(null, { status: new URL(request.url).pathname === "/auth/oidc/login" ? 303 : 204 });
      },
      authenticateSharedAuth: async () => ({ kind: "unauthenticated" as const }),
      resolveSharedAuthWorkspace: async () => ({ kind: "forbidden" as const }),
    },
  };
  return { env, calls, rpcCalls: () => rpcCalls };
}
const request = (path = "/auth/oidc/login", init: RequestInit = {}) =>
  new Request(origin + path, init);

test("shared login refuses either missing limiter before private RPC", async () => {
  const f = fixture();
  for (const missing of ["HOSTED_OIDC_LOGIN_GLOBAL_RATE_LIMITER", "HOSTED_OIDC_LOGIN_IP_RATE_LIMITER"] as const) {
    const env = { ...f.env, [missing]: undefined };
    expect((await handleSharedAuthRouteRequest(request(), env))?.status).toBe(503);
  }
  expect(f.rpcCalls()).toBe(0);
  expect(f.calls).toEqual([]);
});

test("shared login global refusal stops before client budget and private RPC", async () => {
  const f = fixture(false);
  const response = await handleSharedAuthRouteRequest(request(), f.env);
  expect(response?.status).toBe(429);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(response?.headers.get("retry-after")).toBe("60");
  expect(await response?.json()).toEqual({ error: "rate_limited" });
  expect(f.calls).toEqual([{ kind: "global", key: "hosted-oidc-login:global" }]);
  expect(f.rpcCalls()).toBe(0);
});

test("shared login client refusal follows global admission without private RPC", async () => {
  const f = fixture(true, false);
  expect((await handleSharedAuthRouteRequest(request(undefined, { headers: { "cf-connecting-ip": "192.0.2.1" } }), f.env))?.status).toBe(429);
  expect(f.calls).toEqual([
    { kind: "global", key: "hosted-oidc-login:global" },
    { kind: "client", key: "ipv4:192.0.2.1" },
  ]);
  expect(f.rpcCalls()).toBe(0);
});

test("shared login groups IPv6 within one64 and keeps invalid input in one conservative cohort", async () => {
  const f = fixture();
  for (const value of ["2001:db8:1234:5678::1", "2001:0DB8:1234:5678::2", "2001:db8:1234:5679::1", "bad-address", "", "192.000.2.01"]) {
    expect((await handleSharedAuthRouteRequest(request(undefined, { headers: { "cf-connecting-ip": value } }), f.env))?.status).toBe(303);
  }
  const keys = f.calls.filter((call) => call.kind === "client").map((call) => call.key);
  expect(keys).toEqual([
    "ipv6:2001:db8:1234:5678::/64", "ipv6:2001:db8:1234:5678::/64",
    "ipv6:2001:db8:1234:5679::/64", "unknown", "unknown", "ipv4:192.0.2.1",
  ]);
  expect(f.rpcCalls()).toBe(6);
});

test("shared login admission preserves callback session logout and stock OSS behavior", async () => {
  const f = fixture();
  expect((await handleSharedAuthRouteRequest(request(), f.env))?.status).toBe(303);
  expect(f.calls).toHaveLength(2);
  for (const path of ["/auth/oidc/callback", "/auth/oidc/session", "/auth/oidc/logout"]) {
    expect((await handleSharedAuthRouteRequest(request(path), f.env))?.status).toBe(204);
  }
  expect(f.calls).toHaveLength(2);
  expect(f.rpcCalls()).toBe(4);
  expect(await handleSharedAuthRouteRequest(request(), { HOSTED: f.env.HOSTED })).toBeUndefined();
  expect(f.calls).toHaveLength(2);
});

test("shared login keeps credential origin and CSRF guards before admission and fails closed on invalid limiter results", async () => {
  const f = fixture();
  expect((await handleSharedAuthRouteRequest(request(undefined, { headers: { authorization: "Bearer rejected" } }), f.env))?.status).toBe(401);
  expect((await handleSharedAuthRouteRequest(new Request("https://other.example.test/auth/oidc/login"), f.env))?.status).toBe(404);
  expect((await handleSharedAuthRouteRequest(request(undefined, { method: "POST", headers: { origin: "https://other.example.test" } }), f.env))?.status).toBe(403);
  expect(f.calls).toEqual([]);
  for (const limit of [async () => { throw new Error("synthetic unavailable binding"); }, async () => JSON.parse('{"success":"true"}'), async () => JSON.parse("null")]) {
    expect((await handleSharedAuthRouteRequest(request(), {
      ...f.env, HOSTED_OIDC_LOGIN_GLOBAL_RATE_LIMITER: { limit },
    }))?.status).toBe(503);
  }
  expect(f.rpcCalls()).toBe(0);
});

test("shared login admission remains inside the existing browser route wait bound", async () => {
  jest.useFakeTimers();
  try {
    const f = fixture();
    const settled: { response?: Response } = {};
    let complete: ((value: { success: boolean }) => void) | undefined;
    const pending = handleSharedAuthRouteRequest(request(), {
      ...f.env, HOSTED_OIDC_LOGIN_GLOBAL_RATE_LIMITER: { limit: async () => await new Promise<{ success: boolean }>((resolve) => { complete = resolve; }) },
    }).then((value) => { settled.response = value; });
    jest.advanceTimersByTime(39_999);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(settled.response).toBeUndefined();
    jest.advanceTimersByTime(1);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(settled.response?.status).toBe(503);
    await pending;
    complete?.({ success: true });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(f.rpcCalls()).toBe(0);
    expect(f.calls).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});
