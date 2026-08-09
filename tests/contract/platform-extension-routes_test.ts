import { expect, test } from "bun:test";

import {
  PLATFORM_EXTENSION_RESERVED_EXACT_PATHS,
  PLATFORM_EXTENSION_RESERVED_PREFIXES,
  platformExtensionBasePathIsReserved,
  platformExtensionRouteMatchesPath,
} from "../../contract/platform-extension-routes.ts";

test("well-known reservation keeps core leaves and root unclaimable", () => {
  expect(PLATFORM_EXTENSION_RESERVED_EXACT_PATHS).toEqual([
    "/.well-known",
    "/.well-known/openid-configuration",
    "/.well-known/takosumi",
  ]);
  expect(PLATFORM_EXTENSION_RESERVED_PREFIXES).not.toContain("/.well-known");

  for (const path of PLATFORM_EXTENSION_RESERVED_EXACT_PATHS) {
    expect(platformExtensionBasePathIsReserved(path, "subtree")).toBe(true);
    expect(platformExtensionBasePathIsReserved(path, "exact")).toBe(true);
  }
});

test("exact leaves can mount under well-known without opening its namespace", () => {
  const takoform = "/.well-known/takoform/v1alpha3";
  const sibling = "/.well-known/social-server";

  expect(platformExtensionBasePathIsReserved(takoform, "subtree")).toBe(true);
  expect(platformExtensionBasePathIsReserved(takoform, "exact")).toBe(false);
  expect(platformExtensionBasePathIsReserved(sibling, "subtree")).toBe(true);
  expect(platformExtensionBasePathIsReserved(sibling, "exact")).toBe(false);

  expect(platformExtensionRouteMatchesPath(takoform, takoform, "exact")).toBe(
    true,
  );
  expect(
    platformExtensionRouteMatchesPath(`${takoform}/extra`, takoform, "exact"),
  ).toBe(false);
  expect(
    platformExtensionRouteMatchesPath(`${takoform}/extra`, takoform, "subtree"),
  ).toBe(true);
});

test("exact leaves cannot be nested below core well-known leaves", () => {
  for (const path of [
    "/.well-known/openid-configuration/extra",
    "/.well-known/takosumi/extra",
  ]) {
    expect(platformExtensionBasePathIsReserved(path, "exact")).toBe(true);
  }
});
