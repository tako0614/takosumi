import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { PUBLIC_SESSION_CONTROL_ENDPOINTS } from "../../../../accounts/service/src/control-route-inventory.ts";
import {
  CONTROL_DISPATCH_RESOURCE_KEYS,
  controlInventoryResourceKey,
} from "../../../../accounts/service/src/control-routes.ts";

// The session-authed `/api/v1` control surface dispatches by its public first
// path segment (a resource key) to a per-resource `control/<resource>.ts`
// handler that then matches method + sub-path internally. These tests keep the
// dispatch table (`RESOURCE_HANDLERS`, surfaced as
// `CONTROL_DISPATCH_RESOURCE_KEYS`) in lockstep with the public route inventory
// (`control-route-inventory.ts`) so a new inventory route cannot be declared
// without a registered handler, and a registered handler cannot linger after
// its routes are removed.

test("every inventory route maps to a registered dispatch handler (no missing)", () => {
  const registered = new Set(CONTROL_DISPATCH_RESOURCE_KEYS);
  for (const endpoint of PUBLIC_SESSION_CONTROL_ENDPOINTS) {
    const key = controlInventoryResourceKey(endpoint.path);
    expect(
      key,
      `inventory path ${endpoint.path} did not resolve to a dispatch resource key`,
    ).toBeDefined();
    expect(
      registered.has(key as string),
      `inventory route ${endpoint.method} ${endpoint.path} (resource "${key}") has no registered handler`,
    ).toBe(true);
  }
});

test("every registered dispatch handler is exercised by the inventory (no orphans)", () => {
  const used = new Set(
    PUBLIC_SESSION_CONTROL_ENDPOINTS.map((endpoint) =>
      controlInventoryResourceKey(endpoint.path),
    ),
  );
  for (const key of CONTROL_DISPATCH_RESOURCE_KEYS) {
    expect(
      used.has(key),
      `registered dispatch handler "${key}" has no corresponding inventory route (orphan)`,
    ).toBe(true);
  }
});

test("inventory resource keys use the public vocabulary directly", () => {
  expect(controlInventoryResourceKey("/api/v1/workspaces")).toBe("workspaces");
  expect(controlInventoryResourceKey("/api/v1/workspaces/w1/capsules")).toBe(
    "workspaces",
  );
  expect(controlInventoryResourceKey("/api/v1/capsules/c1")).toBe("capsules");
  expect(controlInventoryResourceKey("/api/v1/capsule-configs")).toBe(
    "capsule-configs",
  );
  expect(controlInventoryResourceKey("/api/v1/state-versions/s1")).toBe(
    "state-versions",
  );
  expect(controlInventoryResourceKey("/api/v1/provider-connections")).toBe(
    "provider-connections",
  );
  expect(controlInventoryResourceKey("/api/v1/views/workspaces.v1")).toBe(
    "views",
  );
  // Non-control paths are not owned by this surface.
  expect(controlInventoryResourceKey("/v1/account/session/me")).toBeUndefined();
});

test("Capsule ProviderBindings use the canonical route without a legacy alias", () => {
  const paths = PUBLIC_SESSION_CONTROL_ENDPOINTS.map(
    (endpoint) => endpoint.path,
  );
  expect(paths).toContain("/api/v1/capsules/{capsuleId}/provider-bindings");
  expect(paths).not.toContain(
    "/api/v1/capsules/{capsuleId}/provider-connections",
  );
});

test("retired Capsule mutation paths expose GET descriptors only", () => {
  for (const path of [
    "/api/v1/workspaces/{workspaceId}/capsules",
    "/api/v1/capsules/{capsuleId}/provider-bindings",
    "/api/v1/capsule-configs/{capsuleConfigId}",
  ]) {
    expect(
      PUBLIC_SESSION_CONTROL_ENDPOINTS.filter(
        (endpoint) => endpoint.path === path,
      ).map((endpoint) => endpoint.method),
    ).toEqual(["GET"]);
  }
});

test("OSS Accounts does not publish a commercial plan catalog", () => {
  expect(
    PUBLIC_SESSION_CONTROL_ENDPOINTS.some(
      (endpoint) => endpoint.path === "/api/v1/billing/plans",
    ),
  ).toBe(false);
  expect(CONTROL_DISPATCH_RESOURCE_KEYS).not.toContain("billing");
});

test("public session inventory does not publish backup restore", () => {
  expect(
    PUBLIC_SESSION_CONTROL_ENDPOINTS.some(
      (endpoint) =>
        endpoint.path ===
        "/api/v1/workspaces/{workspaceId}/backups/{backupId}/restores",
    ),
  ).toBe(false);
});

test("account Workspace inventory is published exactly once", () => {
  const inventoryRoutes = PUBLIC_SESSION_CONTROL_ENDPOINTS.filter(
    (endpoint) => endpoint.path === "/api/v1/views/workspaces.v1",
  );
  expect(inventoryRoutes).toEqual([
    {
      method: "GET",
      path: "/api/v1/views/workspaces.v1",
      summary: "Read the account Workspace inventory projection",
      auth: "account-session",
    },
  ]);
});

test("documentation route counts match the runtime inventory", () => {
  const endpointCount = PUBLIC_SESSION_CONTROL_ENDPOINTS.length;
  const japanese = readFileSync(
    new URL("../../../../docs/reference/api.md", import.meta.url),
    "utf8",
  );
  const english = readFileSync(
    new URL("../../../../docs/en/reference/api.md", import.meta.url),
    "utf8",
  );
  const japaneseCount = japanese.match(/次の\s+(\d+)\s+件です。/u)?.[1];
  const englishCount = english.match(
    /currently contains\s+(\d+)\s+public route descriptors/u,
  )?.[1];
  expect(japaneseCount).toBe(String(endpointCount));
  expect(englishCount).toBe(String(endpointCount));
});
