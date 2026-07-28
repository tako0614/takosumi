import { expect, test } from "bun:test";
import {
  matchPlatformExtensionRoute,
  platformExtensionRoutes,
} from "../../../deploy/platform/platform_extensions.ts";

test("generic extension descriptors accept localized UI contributions", () => {
  const routes = platformExtensionRoutes({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      {
        basePath: "/extensions/example",
        handlerKey: "EXAMPLE_EXTENSION",
        managedProviderProfile: "operator.example.provider.v1",
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
  expect(routes[0]?.managedProviderProfile).toBe(
    "operator.example.provider.v1",
  );
  expect(
    matchPlatformExtensionRoute("/extensions/example/settings", routes),
  ).toBeDefined();
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

test("one extension route cannot accept two managed-provider profiles", () => {
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/extensions/example",
          handlerKey: "EXAMPLE_EXTENSION",
          managedProviderProfile: "operator.example.a.v1",
        },
        {
          basePath: "/extensions/example",
          handlerKey: "EXAMPLE_EXTENSION",
          managedProviderProfile: "operator.example.b.v1",
        },
      ]),
    }),
  ).toThrow("basePath /extensions/example has multiple owners");
});

test("one managed-provider profile has one extension route owner", () => {
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/extensions/example-a",
          handlerKey: "EXAMPLE_A",
          managedProviderProfile: "operator.example.provider.v1",
        },
        {
          basePath: "/extensions/example-b",
          handlerKey: "EXAMPLE_B",
          managedProviderProfile: "operator.example.provider.v1",
        },
      ]),
    }),
  ).toThrow(
    "managed provider profile operator.example.provider.v1 has multiple route owners",
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
