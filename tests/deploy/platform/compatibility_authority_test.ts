import { expect, test } from "bun:test";
import {
  createPlatformCompatibilityAuthority,
  handlePlatformExtensionRouteRequest,
  type PlatformCompatibilityReadyResourceEvidence,
} from "../../../deploy/platform/worker.ts";
import { TAKOSUMI_API_VERSION } from "../../../contract/capabilities.ts";

function resourceEvidence(
  phase: "Applying" | "Ready",
): PlatformCompatibilityReadyResourceEvidence {
  return {
    resource: {
      apiVersion: TAKOSUMI_API_VERSION,
      kind: "ObjectBucket",
      metadata: {
        name: "assets",
        space: "space_example",
        managedBy: "compat.example.v1",
      },
      spec: { name: "assets" },
      status: {
        phase,
        observedGeneration: phase === "Ready" ? 1 : 0,
      },
    },
    resourceGeneration: 1,
    nativeResources: [{ type: "bucket", id: "native-assets" }],
  };
}

test("control-plane compatibility handlers receive only canonical Resource and route Interface ports", async () => {
  const translated: string[] = [];
  const response = await handlePlatformExtensionRouteRequest(
    new Request("https://operator.example/compat/example/v1/buckets", {
      method: "POST",
    }),
    {
      EXAMPLE_COMPAT: {
        async fetchCompatibility(
          _request: Request,
          authority: Awaited<
            ReturnType<typeof createPlatformCompatibilityAuthority>
          >,
        ) {
          expect(Object.keys(authority.control ?? {})).toEqual([
            "resourceApi",
            "routeInterfaces",
          ]);
          expect(Object.keys(authority.control?.resourceApi ?? {})).toEqual([
            "fetch",
          ]);
          expect(authority).not.toHaveProperty("env");
          expect(authority).not.toHaveProperty("store");
          expect(authority).not.toHaveProperty("adapter");
          expect(authority).not.toHaveProperty("backend");
          return await authority.control!.resourceApi.fetch(
            new Request("https://internal.invalid/v1/resources/preview", {
              method: "POST",
              body: JSON.stringify({
                kind: "ObjectBucket",
                metadata: { name: "assets", space: "space_example" },
                spec: { name: "assets" },
              }),
            }),
          );
        },
      },
    } as never,
    {
      basePath: "/compat/example/v1",
      handlerKey: "EXAMPLE_COMPAT",
      compatibilityProfiles: [
        { profile: "compat.example.v1", planes: ["control"] },
      ],
    },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "account_example",
      workspaceId: "space_example",
    }),
    async (input) =>
      await createPlatformCompatibilityAuthority(input, {
        dispatchResourceRequest: async (request) => {
          translated.push(`${request.method} ${new URL(request.url).pathname}`);
          return Response.json({ translated: true });
        },
        routeInterfaces: routeInterfaceStub(),
      }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ translated: true });
  expect(translated).toEqual(["POST /v1/resources/preview"]);
});

test("route Interface compatibility port rejects a different Workspace before opening canonical services", async () => {
  const authority = await createPlatformCompatibilityAuthority({
    request: new Request("https://operator.example/compat/example/v1/routes"),
    env: {} as never,
    route: {
      basePath: "/compat/example/v1",
      handlerKey: "EXAMPLE_COMPAT",
      compatibilityProfiles: [
        { profile: "compat.example.v1", planes: ["control"] },
      ],
    },
    session: {
      authenticated: true,
      authKind: "session",
      subject: "account_example",
      workspaceId: "space_example",
    },
  });

  await expect(
    authority.control!.routeInterfaces.list({ workspaceId: "space_foreign" }),
  ).rejects.toMatchObject({ code: "forbidden" });
});

test("route Interface compatibility mutations reject read-only personal access scope", async () => {
  const authority = await createPlatformCompatibilityAuthority({
    request: new Request("https://operator.example/compat/example/v1/routes"),
    env: {} as never,
    route: {
      basePath: "/compat/example/v1",
      handlerKey: "EXAMPLE_COMPAT",
      compatibilityProfiles: [
        { profile: "compat.example.v1", planes: ["control"] },
      ],
    },
    session: {
      authenticated: true,
      authKind: "personal-access-token",
      subject: "account_example",
      workspaceId: "space_example",
      scopes: ["read"],
    },
  });

  await expect(
    authority.control!.routeInterfaces.ensure({
      workspaceId: "space_example",
      resourceName: "api",
      pathPattern: "/*",
      expectedEndpoint: "https://api.system.example/",
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
});

test("data-plane compatibility resolver rejects non-Ready evidence", async () => {
  const authority = await createPlatformCompatibilityAuthority(
    {
      request: new Request("https://operator.example/compat/example/v1/data"),
      env: {} as never,
      route: {
        basePath: "/compat/example/v1",
        handlerKey: "EXAMPLE_COMPAT",
        compatibilityProfiles: [
          { profile: "compat.example.v1", planes: ["data"] },
        ],
      },
      session: {
        authenticated: true,
        authKind: "session",
        subject: "account_example",
        workspaceId: "space_example",
      },
    },
    {
      resolveReadyResource: async () => resourceEvidence("Applying"),
    },
  );

  expect(Object.keys(authority.data ?? {})).toEqual(["resolveReadyResource"]);
  expect(
    await authority.data?.resolveReadyResource({
      space: "space_example",
      kind: "ObjectBucket",
      name: "assets",
    }),
  ).toBeUndefined();
});

test("compatibility profiles never fall back to the generic raw fetch handler", async () => {
  let rawFetchCalled = false;
  const response = await handlePlatformExtensionRouteRequest(
    new Request("https://operator.example/compat/example/v1/data"),
    {
      EXAMPLE_COMPAT: {
        fetch: async () => {
          rawFetchCalled = true;
          return Response.json({ unsafe: true });
        },
      },
    } as never,
    {
      basePath: "/compat/example/v1",
      handlerKey: "EXAMPLE_COMPAT",
      compatibilityProfiles: [
        { profile: "compat.example.v1", planes: ["data"] },
      ],
    },
  );

  expect(response.status).toBe(503);
  expect(rawFetchCalled).toBe(false);
});

function routeInterfaceStub() {
  return {
    async ensure(): Promise<never> {
      throw new Error("not used");
    },
    async list() {
      return [];
    },
    async get() {
      return undefined;
    },
    async update(): Promise<never> {
      throw new Error("not used");
    },
    async retire() {
      return undefined;
    },
  };
}
