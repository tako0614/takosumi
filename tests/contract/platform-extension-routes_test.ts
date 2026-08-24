import { expect, test } from "bun:test";

import {
  PLATFORM_EXTENSION_RESERVED_EXACT_PATHS,
  PLATFORM_EXTENSION_RESERVED_PREFIXES,
  platformExtensionBasePathIsReserved,
  platformExtensionRouteMatchesPath,
} from "../../contract/platform-extension-routes.ts";

test("well-known reservation keeps core and retired leaves unclaimable", () => {
  expect(PLATFORM_EXTENSION_RESERVED_EXACT_PATHS).toEqual([
    "/.well-known",
    "/.well-known/openid-configuration",
    "/.well-known/takosumi",
    "/.well-known/takoform",
  ]);
  expect(PLATFORM_EXTENSION_RESERVED_PREFIXES).not.toContain("/.well-known");

  for (const path of PLATFORM_EXTENSION_RESERVED_EXACT_PATHS) {
    expect(platformExtensionBasePathIsReserved(path, "subtree")).toBe(true);
    expect(platformExtensionBasePathIsReserved(path, "exact")).toBe(true);
  }
});

test("unknown exact leaves can mount under well-known without opening its namespace", () => {
  const sibling = "/.well-known/social-server";

  expect(platformExtensionBasePathIsReserved(sibling, "subtree")).toBe(true);
  expect(platformExtensionBasePathIsReserved(sibling, "exact")).toBe(false);

  expect(
    platformExtensionRouteMatchesPath(sibling, sibling, "exact"),
  ).toBe(true);
  expect(
    platformExtensionRouteMatchesPath(`${sibling}/extra`, sibling, "exact"),
  ).toBe(false);
  expect(
    platformExtensionRouteMatchesPath(`${sibling}/extra`, sibling, "subtree"),
  ).toBe(true);
});

test("retired Takoform Host discovery leaves remain reserved", () => {
  expect(
    platformExtensionBasePathIsReserved("/.well-known/takoform", "exact"),
  ).toBe(true);
  for (const path of [
    "/.well-known/takoform/v1alpha1",
    "/.well-known/takoform/v1alpha2",
    "/.well-known/takoform/v1alpha3",
  ]) {
    for (const matchMode of ["subtree", "exact"] as const) {
      expect(platformExtensionBasePathIsReserved(path, matchMode)).toBe(true);
    }
  }
});

test("exact leaves cannot be nested below core well-known leaves", () => {
  for (const path of [
    "/.well-known/openid-configuration/extra",
    "/.well-known/takosumi/extra",
  ]) {
    expect(platformExtensionBasePathIsReserved(path, "exact")).toBe(true);
  }
});

test("retired /v1 families stay reserved without route-specific descriptors", () => {
  expect(PLATFORM_EXTENSION_RESERVED_PREFIXES).toContain("/v1");
  expect(
    PLATFORM_EXTENSION_RESERVED_PREFIXES.filter((prefix) =>
      prefix.startsWith("/v1/"),
    ),
  ).toEqual([]);

  for (const path of [
    "/v1/form-activations",
    "/v1/form-availability",
    "/v1/resources",
    "/v1/target-pools",
    "/v1/space-policies",
  ]) {
    for (const matchMode of ["subtree", "exact"] as const) {
      expect(platformExtensionBasePathIsReserved(path, matchMode)).toBe(true);
      expect(
        platformExtensionBasePathIsReserved(`${path}/child`, matchMode),
      ).toBe(true);
    }
  }
});

test("optional account subscription belongs to /api/v1 while account stays reserved", () => {
  expect(
    platformExtensionBasePathIsReserved("/api/v1/billing", "subtree"),
  ).toBe(false);
  expect(
    platformExtensionBasePathIsReserved("/api/v1/billing", "exact"),
  ).toBe(false);
  expect(
    platformExtensionBasePathIsReserved("/v1/billing", "subtree"),
  ).toBe(true);
  expect(
    platformExtensionBasePathIsReserved("/v1/billing", "exact"),
  ).toBe(true);
  expect(
    platformExtensionBasePathIsReserved("/api/v1/account", "subtree"),
  ).toBe(true);
  expect(
    platformExtensionBasePathIsReserved("/api/v1/cloud", "subtree"),
  ).toBe(true);
  expect(
    platformExtensionBasePathIsReserved(
      "/api/v1/account/subscription",
      "subtree",
    ),
  ).toBe(false);
  expect(
    platformExtensionBasePathIsReserved(
      "/api/v1/account/subscription",
      "exact",
    ),
  ).toBe(false);
  expect(
    platformExtensionBasePathIsReserved(
      "/api/v1/hosted/subscription",
      "subtree",
    ),
  ).toBe(true);
  expect(
    platformExtensionBasePathIsReserved(
      "/api/v1/hosted/subscription",
      "exact",
    ),
  ).toBe(true);
  expect(
    platformExtensionBasePathIsReserved("/api/v1/hosted", "subtree"),
  ).toBe(true);
  expect(
    platformExtensionBasePathIsReserved("/api/v1/ai", "subtree"),
  ).toBe(false);
  expect(
    platformExtensionBasePathIsReserved("/api/v1/ai", "exact"),
  ).toBe(false);
  expect(
    platformExtensionBasePathIsReserved("/api/v1/ai-shadow", "subtree"),
  ).toBe(true);
  expect(
    platformExtensionBasePathIsReserved("/api/v1/unlisted", "subtree"),
  ).toBe(true);
  for (const path of [
    "/v1",
    "/v1/account",
    "/v1/auth",
    "/v1/privacy",
    "/v1/billing",
    "/v1/cloud",
    "/v1/hosted/subscription",
  ]) {
    expect(platformExtensionBasePathIsReserved(path, "subtree")).toBe(true);
  }
});

test("retired Takoform Host API prefixes remain core-owned", () => {
  expect(PLATFORM_EXTENSION_RESERVED_PREFIXES).toContain(
    "/apis/forms.takoform.com",
  );
  for (const path of [
    "/apis/forms.takoform.com/v1alpha2",
    "/apis/forms.takoform.com/v1alpha3",
  ]) {
    for (const matchMode of ["subtree", "exact"] as const) {
      expect(platformExtensionBasePathIsReserved(path, matchMode)).toBe(true);
      expect(
        platformExtensionBasePathIsReserved(`${path}/resources`, matchMode),
      ).toBe(true);
    }
  }
});
