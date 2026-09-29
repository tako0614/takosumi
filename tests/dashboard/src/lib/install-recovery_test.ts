import { expect, test } from "bun:test";
import type { GitInstallPlanResponse } from "takosumi-contract";
import {
  hasInstallRecoveryLocator,
  installRecoveryId,
  installRecoveryMatches,
  installRecoveryRouteMatches,
  installRecoverySearch,
} from "../../../../dashboard/src/lib/install-recovery.ts";

const response = {
  installPlan: {
    id: "gip_0123456789abcdef",
    workspaceId: "ws_one",
    createdBy: "user_one",
  },
} as GitInstallPlanResponse;

test("recovery locator carries one validated opaque ID only", () => {
  expect(installRecoverySearch(response.installPlan.id)).toBe("?installPlan=gip_0123456789abcdef");
  expect(installRecoveryId("?installPlan=gip_0123456789abcdef")).toBe(response.installPlan.id);
  expect(installRecoveryId("?installPlan=gip_0123456789abcdef&installPlan=gip_0123456789abcdef")).toBeUndefined();
  expect(installRecoveryId("?installPlan=bad")).toBeUndefined();
  expect(hasInstallRecoveryLocator("?installPlan=bad")).toBe(true);
  expect(() => installRecoverySearch("bad")).toThrow();
});

test("readback requires exact ID, workspace and principal", () => {
  expect(installRecoveryMatches(response, response.installPlan.id, "ws_one", "user_one")).toBe(true);
  expect(installRecoveryMatches(response, "gip_ffffffffffffffff", "ws_one", "user_one")).toBe(false);
  expect(installRecoveryMatches(response, response.installPlan.id, "ws_other", "user_one")).toBe(false);
  expect(installRecoveryMatches(response, response.installPlan.id, "ws_one", "user_other")).toBe(false);
});

test("a delayed response cannot promote across a changed route or locator", () => {
  const id = response.installPlan.id;
  expect(installRecoveryRouteMatches("/new", "?git=original", "/new", "?git=original", id)).toBe(true);
  expect(installRecoveryRouteMatches("/new", installRecoverySearch(id), "/new", "?git=original", id)).toBe(true);
  expect(installRecoveryRouteMatches("/other", installRecoverySearch(id), "/new", "?git=original", id)).toBe(false);
  expect(installRecoveryRouteMatches("/new", "?git=other", "/new", "?git=original", id)).toBe(false);
  expect(installRecoveryRouteMatches("/new", "?installPlan=gip_ffffffffffffffff", "/new", "?git=original", id)).toBe(false);
});
