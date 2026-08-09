import { expect, test } from "bun:test";

import {
  matchPlatformExtensionRoute,
  platformExtensionRoutes,
} from "../../../deploy/platform/platform_extensions.ts";

test("platform descriptors parse exact well-known leaves and reject subtree claims", () => {
  const [route] = platformExtensionRoutes({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      {
        basePath: "/.well-known/takoform/v1alpha3",
        matchMode: "exact",
        handlerKey: "TAKOFORM_DISCOVERY",
        authMode: "handler",
      },
    ]),
  });

  expect(route).toMatchObject({
    basePath: "/.well-known/takoform/v1alpha3",
    matchMode: "exact",
    handlerKey: "TAKOFORM_DISCOVERY",
  });
  expect(
    matchPlatformExtensionRoute(
      "/.well-known/takoform/v1alpha3",
      [route!],
    ),
  ).toBe(route);
  expect(
    matchPlatformExtensionRoute(
      "/.well-known/takoform/v1alpha3/extra",
      [route!],
    ),
  ).toBeUndefined();

  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/.well-known/takoform/v1alpha3",
          handlerKey: "UNSAFE_SUBTREE",
        },
      ]),
    }),
  ).toThrow("overlaps a Takosumi core route prefix");
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/.well-known/takoform/v1alpha3",
          matchMode: "exact",
          ownsPathSubtree: true,
          handlerKey: "UNSAFE_OWNERSHIP",
        },
      ]),
    }),
  ).toThrow("cannot enable ownsPathSubtree");
});

test("core well-known leaves and root remain unclaimable in either match mode", () => {
  for (const basePath of [
    "/.well-known",
    "/.well-known/openid-configuration",
    "/.well-known/takosumi",
  ]) {
    for (const matchMode of ["subtree", "exact"] as const) {
      expect(() =>
        platformExtensionRoutes({
          TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
            { basePath, matchMode, handlerKey: "UNSAFE_CORE" },
          ]),
        }),
      ).toThrow("overlaps a Takosumi core route prefix");
    }
  }
});

test("platform worker dispatches an exact extension leaf before the retired host drain", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const response = await worker.fetch(
    new Request("https://app.takosumi.com/.well-known/takoform/v1alpha3"),
    {
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/.well-known/takoform/v1alpha3",
          matchMode: "exact",
          handlerKey: "TAKOFORM_DISCOVERY",
          authMode: "handler",
        },
      ]),
      TAKOFORM_DISCOVERY: {
        fetch: async (request: Request) =>
          Response.json({ path: new URL(request.url).pathname }),
      },
    } as never,
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    path: "/.well-known/takoform/v1alpha3",
  });
});

test("malformed optional extension configuration cannot break product discovery", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const response = await worker.fetch(
    new Request("https://app.takosumi.com/.well-known/takosumi"),
    { TAKOSUMI_PLATFORM_EXTENSIONS: "{" } as never,
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ product: "takosumi" });
});
