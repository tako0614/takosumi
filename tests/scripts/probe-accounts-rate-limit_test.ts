import { expect, test } from "bun:test";
import {
  ACCOUNTS_RATE_LIMIT_PROBE_KIND,
  resolveOptions,
  runAccountsRateLimitProbe,
} from "../../scripts/probe-accounts-rate-limit.ts";

test("accounts rate-limit probe stops at first 429 and summarizes safely", async () => {
  let calls = 0;
  const fakeFetch = (async (url: string | URL | Request) => {
    calls += 1;
    const requestUrl = new URL(String(url));
    expect(requestUrl.pathname).toBe("/oauth/authorize");
    expect(requestUrl.searchParams.get("client_id")).toBe(
      "takosumi-readiness-rate-limit-probe",
    );
    const status = calls === 4 ? 429 : 400;
    return new Response("{}", {
      status,
      headers:
        status === 429
          ? { "retry-after": "57", "content-type": "application/json" }
          : { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const options = resolveOptions(
    {
      url: "https://app.takosumi.com",
      maxRequests: "10",
      intervalMs: "1",
    },
    {},
  );

  const result = await runAccountsRateLimitProbe(options, fakeFetch);
  const serialized = JSON.stringify(result);

  expect(result.kind).toBe(ACCOUNTS_RATE_LIMIT_PROBE_KIND);
  expect(result.status).toBe("passed");
  expect(result.requestCount).toBe(4);
  expect(result.statusCounts).toEqual({ "400": 3, "429": 1 });
  expect(result.firstRateLimited).toMatchObject({
    attempt: 4,
    status: 429,
    retryAfter: "57",
  });
  expect(serialized).not.toMatch(/bearer\s+[A-Za-z0-9._-]{10,}/i);
  expect(serialized).not.toContain("cookie=");
});

test("accounts rate-limit probe reports failure when limit is not reached", async () => {
  const fakeFetch = (async () =>
    new Response("{}", {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const options = resolveOptions(
    {
      url: "https://app.takosumi.com",
      maxRequests: "3",
      intervalMs: "1",
    },
    {},
  );

  const result = await runAccountsRateLimitProbe(options, fakeFetch);

  expect(result.status).toBe("failed");
  expect(result.requestCount).toBe(3);
  expect(result.firstRateLimited).toBeUndefined();
});
