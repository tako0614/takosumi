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
  });
  expect(routes[0]?.managedProviderProfile).toBe(
    "operator.example.provider.v1",
  );
  expect(
    matchPlatformExtensionRoute("/extensions/example/settings", routes),
  ).toBeDefined();
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
