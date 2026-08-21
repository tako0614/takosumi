import { expect, test } from "bun:test";

import {
  platformExtensionRoutes,
  platformExtensionSelfServicePatScopes,
} from "../../../deploy/platform/platform_extensions.ts";

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    basePath: "/extensions/cloud/resource-instances",
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

test("AI request scopes are self-service only when the owning route declares them", () => {
  const aiDescriptor = {
    basePath: "/gateway/ai/v1",
    handlerKey: "CLOUD_AI_GATEWAY",
    requestScopeRules: [
      {
        path: "/models",
        methods: ["GET"],
        requiredScopes: ["ai.models.read"],
      },
      {
        path: "/chat/completions",
        methods: ["POST"],
        requiredScopes: ["ai.chat"],
      },
      {
        path: "/embeddings",
        methods: ["POST"],
        requiredScopes: ["ai.embeddings"],
      },
    ],
  };
  const implicit = platformExtensionRoutes({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([aiDescriptor]),
  });
  expect(platformExtensionSelfServicePatScopes(implicit)).toEqual([]);

  const explicit = platformExtensionRoutes({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      {
        ...aiDescriptor,
        selfServicePatScopes: [
          "ai.models.read",
          "ai.chat",
          "ai.embeddings",
        ],
      },
    ]),
  });
  expect(platformExtensionSelfServicePatScopes(explicit)).toEqual([
    "ai.models.read",
    "ai.chat",
    "ai.embeddings",
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
