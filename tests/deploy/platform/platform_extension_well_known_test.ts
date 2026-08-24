import { expect, test } from "bun:test";

import {
  platformExtensionRoutes,
} from "../../../deploy/platform/platform_extensions.ts";

test("retired Takoform well-known leaves cannot be configured", () => {
  for (const basePath of [
    "/.well-known/takoform/v1alpha1",
    "/.well-known/takoform/v1alpha2",
    "/.well-known/takoform/v1alpha3",
    "/.well-known/takoform/v1beta1",
  ]) {
    expect(() =>
      platformExtensionRoutes({
        TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
          {
            basePath,
            matchMode: "exact",
            handlerKey: "TAKOFORM_DISCOVERY",
          },
        ]),
      }),
    ).toThrow("overlaps a Takosumi core route prefix");
  }
});

test("retired Takoform Host leaves cannot be configured or advertised", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  for (const basePath of [
    "/.well-known/takoform/v1alpha1",
    "/.well-known/takoform/v1alpha2",
    "/.well-known/takoform/v1alpha3",
  ]) {
    expect(() =>
      platformExtensionRoutes({
        TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
          {
            basePath,
            matchMode: "exact",
            handlerKey: "TAKOFORM_DISCOVERY",
          },
        ]),
      }),
    ).toThrow("overlaps a Takosumi core route prefix");

    const discovery = await worker.fetch(
      new Request("https://app.takosumi.com/.well-known/takosumi"),
      {
        TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
          {
            basePath,
            matchMode: "exact",
            handlerKey: "TAKOFORM_DISCOVERY",
            capabilities: [`takoform.host.${basePath.split("/").at(-1)}`],
          },
        ]),
      } as never,
    );
    expect(discovery.status).toBe(200);
    expect((await discovery.json()).endpoints.extensions).toBeUndefined();
  }
});

test("retired Takoform Host root cannot be configured or dispatched", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  let dispatched = false;
  const env = {
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      {
        basePath: "/.well-known/takoform",
        matchMode: "exact",
        handlerKey: "TAKOFORM_DISCOVERY",
      },
    ]),
    TAKOFORM_DISCOVERY: {
      fetch: async () => {
        dispatched = true;
        return Response.json({ dispatched: true });
      },
    },
  } as never;

  expect(() => platformExtensionRoutes(env)).toThrow(
    "overlaps a Takosumi core route prefix",
  );
  const response = await worker.fetch(
    new Request("https://app.takosumi.com/.well-known/takoform"),
    env,
  );
  expect(response.status).toBe(404);
  expect(dispatched).toBe(false);
});

test("retired Takoform Host API lanes cannot be configured, advertised, or dispatched", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  for (const basePath of [
    "/apis/forms.takoform.com/v1alpha2",
    "/apis/forms.takoform.com/v1alpha3",
  ]) {
    let dispatched = false;
    const env = {
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath,
          handlerKey: "TAKOFORM_DISCOVERY",
        },
      ]),
      TAKOFORM_DISCOVERY: {
        fetch: async () => {
          dispatched = true;
          return Response.json({ dispatched: true });
        },
      },
    } as never;

    expect(() => platformExtensionRoutes(env)).toThrow(
      "overlaps a Takosumi core route prefix",
    );
    for (const requestPath of [basePath, `${basePath}/resources`]) {
      const response = await worker.fetch(
        new Request(`https://app.takosumi.com${requestPath}`),
        env,
      );
      expect(response.status).toBe(404);
    }
    expect(dispatched).toBe(false);

    const discovery = await worker.fetch(
      new Request("https://app.takosumi.com/.well-known/takosumi"),
      env,
    );
    expect(discovery.status).toBe(200);
    expect((await discovery.json()).endpoints.extensions).toBeUndefined();
  }
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

test("platform worker tombstones every Takoform well-known leaf", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const response = await worker.fetch(
    new Request("https://app.takosumi.com/.well-known/takoform/v1beta1"),
    {
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/.well-known/takoform/v1beta1",
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

  expect(response.status).toBe(404);
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
