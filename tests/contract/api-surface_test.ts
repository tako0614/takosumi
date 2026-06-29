import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  ACCOUNTS_IDENTITY_PREFIX,
  API_V1_PREFIX,
  EXTERNAL_STANDARD_PREFIXES,
  HEALTH_PATHS,
  INTERNAL_V1_PREFIX,
  TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
  TAKOSUMI_WELL_KNOWN_PATH,
  isAccountsIdentityPath,
  isApiV1Path,
  isExternalStandardPath,
  isHealthPath,
  isInternalV1Path,
} from "../../contract/api-surface.ts";

test("prefix constants are the canonical taxonomy values", () => {
  assert.equal(API_V1_PREFIX, "/api/v1");
  assert.equal(INTERNAL_V1_PREFIX, "/internal/v1");
  assert.equal(ACCOUNTS_IDENTITY_PREFIX, "/v1");
  assert.deepEqual(
    [...EXTERNAL_STANDARD_PREFIXES],
    ["/oauth", "/.well-known", "/hooks"],
  );
  assert.deepEqual([...HEALTH_PATHS], ["/healthz", "/readyz", "/livez"]);
  assert.equal(TAKOSUMI_WELL_KNOWN_PATH, "/.well-known/takosumi");
  assert.equal(TAKOSUMI_PRODUCT_CAPABILITIES_PATH, "/v1/capabilities");
});

test("isApiV1Path matches the prefix and nested paths only", () => {
  assert.ok(isApiV1Path("/api/v1"));
  assert.ok(isApiV1Path("/api/v1/workspaces"));
  assert.ok(isApiV1Path("/api/v1/capsules/inst_1/plan"));
  assert.ok(!isApiV1Path("/api/v1x"));
  // A path under /api/ that is NOT /api/v1 must not match the edge surface.
  assert.ok(!isApiV1Path("/api/internal/runtime/agents"));
  assert.ok(!isApiV1Path("/v1/account/session/me"));
});

test("isInternalV1Path matches the internal seam", () => {
  assert.ok(isInternalV1Path("/internal/v1"));
  assert.ok(isInternalV1Path("/internal/v1/plan-runs"));
  assert.ok(!isInternalV1Path("/api/v1/workspaces"));
});

test("isAccountsIdentityPath matches /v1 but the caller must test /api/v1 first", () => {
  assert.ok(isAccountsIdentityPath("/v1/account/session/me"));
  assert.ok(isAccountsIdentityPath("/v1/auth/providers"));
  // /api/v1 is NOT under /v1, so identity matching never shadows the edge API.
  assert.ok(!isAccountsIdentityPath("/api/v1/workspaces"));
});

test("isExternalStandardPath matches OIDC / webhook surfaces", () => {
  assert.ok(isExternalStandardPath("/oauth/token"));
  assert.ok(isExternalStandardPath("/.well-known/openid-configuration"));
  assert.ok(!isExternalStandardPath("/start"));
  assert.ok(isExternalStandardPath("/hooks/sources/src_1"));
  // /install is a plain SPA path — the external install link is client-handled.
  assert.ok(!isExternalStandardPath("/install"));
  assert.ok(!isExternalStandardPath("/api/v1/workspaces"));
});

test("isHealthPath matches only exact probe paths", () => {
  assert.ok(isHealthPath("/healthz"));
  assert.ok(isHealthPath("/readyz"));
  assert.ok(isHealthPath("/livez"));
  assert.ok(!isHealthPath("/health"));
  assert.ok(!isHealthPath("/healthz/extra"));
});
