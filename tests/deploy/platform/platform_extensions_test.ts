import { expect, test } from "bun:test";
import {
  matchPlatformExtensionRoute,
  platformExtensionRoutes,
  resolvePlatformExtensionRequestScopeRoute,
} from "../../../deploy/platform/platform_extensions.ts";

test("generic extension descriptors accept localized UI contributions", () => {
  const routes = platformExtensionRoutes({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      {
        basePath: "/extensions/example",
        handlerKey: "EXAMPLE_EXTENSION",
        authDelivery: "context",
        runCredential: {
          audience: "operator.example.provider.v1",
          requiredScopes: ["example.invoke"],
        },
        providerCredentialBroker: {
          connectionId: "conn_exampleProvider01",
          recipeId: "example-provider-run",
          providerSource: "registry.terraform.io/example/provider",
          displayName: "Example Provider",
          exchangePath: "/provider-credentials/example",
          envNames: ["EXAMPLE_ENDPOINT", "EXAMPLE_TOKEN"],
        },
        capabilities: ["example.v1"],
        contributions: [
          {
            id: "example-settings",
            slot: "navigation.manage",
            href: "/extensions/example/settings",
            presentation: "inline-frame",
            label: "Example settings",
            labels: { ja: "拡張設定" },
          },
        ],
      },
    ]),
  });
  expect(routes[0]?.contributions?.[0]).toMatchObject({
    id: "example-settings",
    slot: "navigation.manage",
    href: "/extensions/example/settings",
    presentation: "inline-frame",
  });
  expect(routes[0]?.runCredential).toEqual({
    audience: "operator.example.provider.v1",
    requiredScopes: ["example.invoke"],
  });
  expect(routes[0]?.providerCredentialBroker).toEqual({
    connectionId: "conn_exampleProvider01",
    recipeId: "example-provider-run",
    providerSource: "registry.terraform.io/example/provider",
    displayName: "Example Provider",
    exchangePath: "/provider-credentials/example",
    envNames: ["EXAMPLE_ENDPOINT", "EXAMPLE_TOKEN"],
  });
  expect(
    matchPlatformExtensionRoute("/extensions/example/settings", routes),
  ).toBeDefined();
});

test("run credential route descriptors cannot grant admin", () => {
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([{
        basePath: "/extensions/example",
        handlerKey: "EXAMPLE_EXTENSION",
        authDelivery: "context",
        runCredential: {
          audience: "operator.example.provider.v1",
          requiredScopes: ["example.invoke", "admin"],
        },
      }]),
    })
  ).toThrow("cannot grant admin");
});

test("extension descriptors parse exact request scope rules without changing the audience base", () => {
  const [route] = platformExtensionRoutes({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      {
        basePath: "/gateway/ai/v1",
        handlerKey: "AI_GATEWAY",
        requestScopeRules: [
          {
            path: "/models",
            methods: ["GET", "HEAD"],
            requiredScopes: ["ai.models.read"],
          },
          {
            path: "/models",
            methods: ["OPTIONS"],
            requiredScopes: [],
          },
          {
            path: "/chat/completions",
            methods: ["POST"],
            requiredScopes: ["ai.chat"],
          },
        ],
      },
    ]),
  });

  expect(route).toMatchObject({
    basePath: "/gateway/ai/v1",
    requestScopeRules: [
      {
        path: "/models",
        methods: ["GET", "HEAD"],
        requiredScopes: ["ai.models.read"],
      },
      {
        path: "/models",
        methods: ["OPTIONS"],
        requiredScopes: [],
      },
      {
        path: "/chat/completions",
        methods: ["POST"],
        requiredScopes: ["ai.chat"],
      },
    ],
  });

  const models = resolvePlatformExtensionRequestScopeRoute(
    new Request("https://app.takosumi.com/gateway/ai/v1/models", {
      method: "GET",
    }),
    route!,
  );
  expect(models).toMatchObject({
    basePath: "/gateway/ai/v1",
    requiredScopes: ["ai.models.read"],
  });
  const preflight = resolvePlatformExtensionRequestScopeRoute(
    new Request("https://app.takosumi.com/gateway/ai/v1/models", {
      method: "OPTIONS",
    }),
    route!,
  );
  expect(preflight).toMatchObject({
    basePath: "/gateway/ai/v1",
    requiredScopes: [],
  });
  expect(
    resolvePlatformExtensionRequestScopeRoute(
      new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions", {
        method: "GET",
      }),
      route!,
    ),
  ).toBeUndefined();
  expect(
    resolvePlatformExtensionRequestScopeRoute(
      new Request("https://app.takosumi.com/gateway/ai/v1/unknown", {
        method: "GET",
      }),
      route!,
    ),
  ).toBeUndefined();
});

test("request scope rules reject ambiguous or unsafe descriptors", () => {
  const descriptor = (requestScopeRules: unknown) => ({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      {
        basePath: "/extensions/example",
        handlerKey: "EXAMPLE_EXTENSION",
        requestScopeRules,
      },
    ]),
  });

  expect(() =>
    platformExtensionRoutes(
      descriptor([
        {
          path: "/models",
          methods: ["GET"],
          requiredScopes: ["read"],
        },
        {
          path: "/models",
          methods: ["GET"],
          requiredScopes: ["write"],
        },
      ]),
    ),
  ).toThrow("duplicate path/method");
  expect(() =>
    platformExtensionRoutes(
      descriptor([
        {
          path: "/models/../admin",
          methods: ["GET"],
          requiredScopes: ["read"],
        },
      ]),
    ),
  ).toThrow("canonical relative absolute path");
  expect(() =>
    platformExtensionRoutes(
      descriptor([
        {
          path: "/models",
          methods: ["get"],
          requiredScopes: ["read"],
        },
      ]),
    ),
  ).toThrow("uppercase HTTP methods");
});

test("extension contributions reject unknown presentation modes", () => {
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/extensions/example",
          handlerKey: "EXAMPLE_EXTENSION",
          contributions: [
            {
              id: "unsafe-presentation",
              slot: "navigation.manage",
              href: "/extensions/example/settings",
              presentation: "script",
              label: "Example settings",
            },
          ],
        },
      ]),
    }),
  ).toThrow("presentation must be link, inline-frame, or native");
});

test("extension contributions accept a host-native slot renderer", () => {
  const routes = platformExtensionRoutes({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      {
        basePath: "/extensions/billing",
        handlerKey: "BILLING_EXTENSION",
        contributions: [
          {
            id: "billing",
            slot: "workspace.billing",
            href: "/extensions/billing",
            presentation: "native",
            label: "Credits and billing",
          },
        ],
      },
    ]),
  });
  expect(routes[0]?.contributions?.[0]).toMatchObject({
    href: "/extensions/billing",
    presentation: "native",
    slot: "workspace.billing",
  });
});

test("extension contributions cannot escape their delegated path", () => {
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/extensions/example",
          handlerKey: "EXAMPLE_EXTENSION",
          contributions: [
            {
              id: "escape",
              slot: "navigation.manage",
              href: "/operator/admin",
              label: "Escape",
            },
          ],
        },
      ]),
    }),
  ).toThrow("must stay under /extensions/example");
});

test("extension paths reject dot-segment and encoded traversal", () => {
  for (const basePath of [
    "/extensions/../v1/billing",
    "/extensions/%2e%2e/v1/billing",
    "/extensions/example/",
    String.raw`/extensions\\example`,
  ]) {
    expect(() =>
      platformExtensionRoutes({
        TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
          { basePath, handlerKey: "UNSAFE_EXTENSION" },
        ]),
      }),
    ).toThrow("must be a canonical absolute path prefix");
  }

  for (const href of [
    "/extensions/example/../operator",
    "/extensions/example/%2e%2e/operator",
    String.raw`/extensions/example\\operator`,
  ]) {
    expect(() =>
      platformExtensionRoutes({
        TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
          {
            basePath: "/extensions/example",
            handlerKey: "EXAMPLE_EXTENSION",
            contributions: [
              {
                id: "unsafe",
                slot: "navigation.manage",
                href,
                label: "Unsafe",
              },
            ],
          },
        ]),
      }),
    ).toThrow("must stay under /extensions/example");
  }
});

test("one extension base path has one owner", () => {
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        { basePath: "/extensions/example", handlerKey: "EXAMPLE_A" },
        { basePath: "/extensions/example", handlerKey: "EXAMPLE_B" },
      ]),
    }),
  ).toThrow("basePath /extensions/example has multiple owners");
});

test("extension auth delivery and subtree ownership validate closed fields with safe defaults", () => {
  const [defaultRoute, explicitRoute] = platformExtensionRoutes({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      { basePath: "/extensions/default", handlerKey: "DEFAULT" },
      {
        basePath: "/extensions/explicit",
        handlerKey: "EXPLICIT",
        authDelivery: "headers",
        ownsPathSubtree: false,
      },
    ]),
  });
  expect(defaultRoute?.authDelivery ?? "headers").toBe("headers");
  expect(defaultRoute?.ownsPathSubtree ?? false).toBe(false);
  expect(explicitRoute).toMatchObject({
    authDelivery: "headers",
    ownsPathSubtree: false,
  });

  for (const authDelivery of ["query", true, null]) {
    expect(() =>
      platformExtensionRoutes({
        TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
          {
            basePath: "/extensions/invalid-delivery",
            handlerKey: "INVALID",
            authDelivery,
          },
        ]),
      }),
    ).toThrow("authDelivery must be headers or context");
  }
  for (const ownsPathSubtree of ["true", 1, null]) {
    expect(() =>
      platformExtensionRoutes({
        TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
          {
            basePath: "/extensions/invalid-ownership",
            handlerKey: "INVALID",
            ownsPathSubtree,
          },
        ]),
      }),
    ).toThrow("ownsPathSubtree must be a boolean");
  }
});

test("context delivery rejects handler-auth and compatibility routes", () => {
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/extensions/protocol",
          handlerKey: "PROTOCOL",
          authMode: "handler",
          authDelivery: "context",
        },
      ]),
    }),
  ).toThrow("authDelivery=context requires platform authentication");
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/compat/example/v1",
          handlerKey: "COMPAT",
          authDelivery: "context",
          compatibilityProfiles: [
            { profile: "compat.example.v1", planes: ["data"] },
          ],
        },
      ]),
    }),
  ).toThrow("authDelivery=context is not supported for compatibilityProfiles");
});

test("subtree ownership rejects parent/child route collisions in either order", () => {
  const descriptors = [
    {
      basePath: "/extensions/example",
      handlerKey: "ROOT",
      ownsPathSubtree: true,
    },
    {
      basePath: "/extensions/example/admin",
      handlerKey: "ADMIN",
    },
  ];
  for (const order of [descriptors, [...descriptors].reverse()]) {
    expect(() =>
      platformExtensionRoutes({
        TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify(order),
      }),
    ).toThrow("subtree ownership overlaps");
  }
});

test("one extension may narrow an exact leaf below its owned subtree", () => {
  const routes = platformExtensionRoutes({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      {
        basePath: "/extensions/example",
        handlerKey: "EXAMPLE",
        authDelivery: "context",
        ownsPathSubtree: true,
        requiredScopes: ["example.session"],
      },
      {
        basePath: "/extensions/example/resources",
        matchMode: "exact",
        handlerKey: "EXAMPLE",
        authDelivery: "context",
        requiredScopes: ["resources:read"],
      },
    ]),
  });

  expect(
    matchPlatformExtensionRoute("/extensions/example/wallet", routes),
  ).toMatchObject({
    basePath: "/extensions/example",
    requiredScopes: ["example.session"],
  });
  expect(
    matchPlatformExtensionRoute("/extensions/example/resources", routes),
  ).toMatchObject({
    basePath: "/extensions/example/resources",
    matchMode: "exact",
    requiredScopes: ["resources:read"],
  });
});

test("owned subtrees still reject exact leaves from another handler", () => {
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/extensions/example",
          handlerKey: "EXAMPLE",
          ownsPathSubtree: true,
        },
        {
          basePath: "/extensions/example/resources",
          matchMode: "exact",
          handlerKey: "ATTACKER",
        },
      ]),
    }),
  ).toThrow("subtree ownership overlaps");
});

test("one extension route cannot accept two Run credential audiences", () => {
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/extensions/example",
          handlerKey: "EXAMPLE_EXTENSION",
          authDelivery: "context",
          runCredential: {
            audience: "operator.example.a.v1",
            requiredScopes: ["invoke"],
          },
        },
        {
          basePath: "/extensions/example",
          handlerKey: "EXAMPLE_EXTENSION",
          authDelivery: "context",
          runCredential: {
            audience: "operator.example.b.v1",
            requiredScopes: ["invoke"],
          },
        },
      ]),
    }),
  ).toThrow("basePath /extensions/example has multiple owners");
});

test("one Run credential audience has one extension route owner", () => {
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/extensions/example-a",
          handlerKey: "EXAMPLE_A",
          authDelivery: "context",
          runCredential: {
            audience: "operator.example.provider.v1",
            requiredScopes: ["invoke"],
          },
        },
        {
          basePath: "/extensions/example-b",
          handlerKey: "EXAMPLE_B",
          authDelivery: "context",
          runCredential: {
            audience: "operator.example.provider.v1",
            requiredScopes: ["invoke"],
          },
        },
      ]),
    }),
  ).toThrow(
    "run credential audience operator.example.provider.v1 has multiple route owners",
  );
});

test("nested extension routes select the most specific owner", () => {
  const routes = platformExtensionRoutes({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      { basePath: "/extensions/example", handlerKey: "EXAMPLE_ROOT" },
      {
        basePath: "/extensions/example/admin",
        handlerKey: "EXAMPLE_ADMIN",
      },
    ]),
  });

  expect(
    matchPlatformExtensionRoute("/extensions/example/admin/settings", routes)
      ?.handlerKey,
  ).toBe("EXAMPLE_ADMIN");
});

test("core route prefixes cannot be delegated to extensions", () => {
  for (const basePath of [
    "/v1/resources",
    "/v1/resources/preview",
    "/v1/form-activations",
    "/v1/form-activations/activation_1",
    "/v1/capabilities",
    "/.well-known/takosumi",
    "/api/v1/workspaces",
    "/v1/account/session",
    "/internal/v1/runs",
  ]) {
    expect(() =>
      platformExtensionRoutes({
        TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
          { basePath, handlerKey: "UNSAFE_EXTENSION" },
        ]),
      }),
    ).toThrow("overlaps a Takosumi core route prefix");
  }

  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        { basePath: "/v1", handlerKey: "TOO_BROAD" },
      ]),
    }),
  ).toThrow("overlaps a Takosumi core route prefix");
});

test("compatibility routes require explicit control and data planes", () => {
  const [route] = platformExtensionRoutes({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      {
        basePath: "/compat/example/v1",
        handlerKey: "EXAMPLE_COMPAT",
        compatibilityProfiles: [
          {
            profile: "compat.example.v1",
            planes: ["control", "data", "control"],
          },
        ],
      },
    ]),
  });
  expect(route?.compatibilityProfiles).toEqual([
    {
      profile: "compat.example.v1",
      planes: ["control", "data"],
    },
  ]);
  expect(route?.capabilities).toEqual(["compat.example.v1"]);

  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/compat/example/v1",
          handlerKey: "EXAMPLE_COMPAT",
          capabilities: ["compat.example.v1"],
        },
      ]),
    }),
  ).toThrow(
    "requires an explicit compatibilityProfiles control/data declaration",
  );

  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/compat/example/unversioned",
          handlerKey: "EXAMPLE_COMPAT",
          compatibilityProfiles: [
            { profile: "compat.example", planes: ["data"] },
          ],
        },
      ]),
    }),
  ).toThrow("must be a scoped compat.* version token");
});
