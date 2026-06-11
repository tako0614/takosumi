import { describe, expect, test } from "bun:test";
import {
  ACCOUNTS_API_PREFIXES,
  isAccountsApiPath,
  isWorkerLocalPath,
} from "./routes.ts";
import { ACCOUNTS_API_PREFIXES as NODE_POSTGRES_API_PREFIXES } from "../../node-postgres/src/static-assets.ts";

describe("isAccountsApiPath", () => {
  // Every non-`/dashboard` path the accounts/service handler routes must be
  // claimed here, or `not_found_handling = single-page-application` would
  // shadow it with the dashboard SPA's index.html.
  test("claims every API namespace the handler owns", () => {
    const apiPaths = [
      "/.well-known/openid-configuration",
      "/api/v1/spaces",
      "/api/v1/installations/inst_1/plan",
      "/oauth/authorize",
      "/oauth/token",
      "/oauth/jwks",
      "/start",
      "/v1/account/session/me",
      "/v1/account/tokens",
      "/v1/billing/stripe/webhook",
      "/v1/auth/upstream/callback",
      "/v1/auth/passkeys/register/options",
      "/v1/installations",
      "/v1/installations/plan-runs",
      "/internal/workload-platform-services/resolve",
    ];
    for (const path of apiPaths) {
      expect(isAccountsApiPath(path)).toBe(true);
    }
  });

  test("leaves SPA-owned routes to the static assets layer", () => {
    // Root, deep links, and the (retired) server-HTML dashboard paths now
    // belong to the SPA, so they must NOT be claimed as API paths.
    for (
      const path of [
        "/",
        "/apps",
        "/install",
        "/dashboard",
        "/dashboard/installations",
        "/takos/start",
        "/assets/app.js",
        "/favicon.ico",
      ]
    ) {
      expect(isAccountsApiPath(path)).toBe(false);
    }
  });

  test("matches a prefix exactly and as a path boundary, not as a substring", () => {
    expect(isAccountsApiPath("/v1")).toBe(true);
    expect(isAccountsApiPath("/v1/")).toBe(true);
    // A path that merely starts with the prefix string but is a different
    // segment must not match.
    expect(isAccountsApiPath("/v1foo")).toBe(false);
    expect(isAccountsApiPath("/internalize")).toBe(false);
    expect(isAccountsApiPath("/startup")).toBe(false);
  });

  test("the prefix set is exactly the documented surface", () => {
    expect([...ACCOUNTS_API_PREFIXES].sort()).toEqual(
      ["/.well-known", "/api/v1", "/internal", "/oauth", "/start", "/v1"],
    );
  });

  test("the node-postgres profile uses the same API allowlist (no drift)", () => {
    // Both deploy profiles must classify API-vs-SPA identically; this guards the
    // hand-duplicated ACCOUNTS_API_PREFIXES in node-postgres static-assets.ts.
    expect([...NODE_POSTGRES_API_PREFIXES].sort()).toEqual(
      [...ACCOUNTS_API_PREFIXES].sort(),
    );
  });
});

describe("isWorkerLocalPath", () => {
  test("only matches /healthz", () => {
    expect(isWorkerLocalPath("/healthz")).toBe(true);
    expect(isWorkerLocalPath("/healthz/")).toBe(true);
    expect(isWorkerLocalPath("/")).toBe(false);
    expect(isWorkerLocalPath("/v1/installations")).toBe(false);
  });
});
