import { expect, test } from "bun:test";

import { PUBLIC_SESSION_CONTROL_ENDPOINTS } from "../../../../accounts/service/src/control-route-inventory.ts";
import {
  CONTROL_DISPATCH_RESOURCE_KEYS,
  controlInventoryResourceKey,
} from "../../../../accounts/service/src/control-routes.ts";

// The session-authed `/api/v1` control surface dispatches by NORMALIZED first
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

test("inventory resource key normalization mirrors the public vocabulary", () => {
  // Spot-check the public Workspace/Capsule/StateVersion vocabulary collapses
  // onto the legacy dispatch keys, matching `normalizePublicControlSegments`.
  expect(controlInventoryResourceKey("/api/v1/workspaces")).toBe("spaces");
  expect(controlInventoryResourceKey("/api/v1/workspaces/w1/capsules")).toBe(
    "spaces",
  );
  expect(controlInventoryResourceKey("/api/v1/capsules/c1")).toBe(
    "installations",
  );
  expect(controlInventoryResourceKey("/api/v1/capsule-configs")).toBe(
    "install-configs",
  );
  expect(controlInventoryResourceKey("/api/v1/state-versions/s1")).toBe(
    "deployments",
  );
  expect(controlInventoryResourceKey("/api/v1/provider-connections")).toBe(
    "provider-connections",
  );
  // Non-control paths are not owned by this surface.
  expect(controlInventoryResourceKey("/v1/account/session/me")).toBeUndefined();
});
