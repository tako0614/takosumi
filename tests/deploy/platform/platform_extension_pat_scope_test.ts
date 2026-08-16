import { expect, test } from "bun:test";

import {
  platformExtensionRoutes,
  platformExtensionSelfServicePatScopes,
} from "../../../deploy/platform/platform_extensions.ts";

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    basePath: "/v1/cloud/resource-instances",
    handlerKey: "CLOUD_RESOURCE_INSTANCES",
    requiredScopes: ["resources:read"],
    ...overrides,
  };
}

test("extension self-service PAT scopes require explicit metadata", () => {
  const inferred = platformExtensionRoutes({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([descriptor()]),
  });
  expect(inferred[0]?.selfServicePatScopes).toBeUndefined();
  expect(platformExtensionSelfServicePatScopes(inferred)).toEqual([]);

  const explicit = platformExtensionRoutes({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      descriptor({ selfServicePatScopes: ["resources:read"] }),
    ]),
  });
  expect(explicit[0]?.selfServicePatScopes).toEqual(["resources:read"]);
  expect(platformExtensionSelfServicePatScopes(explicit)).toEqual([
    "resources:read",
  ]);
});

test("extension self-service PAT metadata rejects unsafe, unknown, unreferenced, and oversize scopes", () => {
  for (const scope of [
    "admin",
    "takoform.host.invoke",
    "controls:write",
    "unknown:read",
    "resources:read".repeat(100),
  ]) {
    expect(() =>
      platformExtensionRoutes({
        TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
          descriptor({ selfServicePatScopes: [scope] }),
        ]),
      }),
    ).toThrow();
  }

  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        descriptor({
          requiredScopes: ["other:read"],
          selfServicePatScopes: ["resources:read"],
        }),
      ]),
    }),
  ).toThrow(/referenced/u);
});

test("conflicting extension self-service metadata is rejected", () => {
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        descriptor({ selfServicePatScopes: ["resources:read"] }),
        { ...descriptor(), selfServicePatScopes: undefined },
      ]),
    }),
  ).toThrow(/multiple owners/u);
});

test("handler-auth extensions cannot contribute platform PAT scopes", () => {
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        descriptor({
          authMode: "handler",
          selfServicePatScopes: ["resources:read"],
        }),
      ]),
    }),
  ).toThrow(/requires platform authentication/u);
});
