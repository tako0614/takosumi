import { expect, test } from "bun:test";
import { httpPlatformServiceResolver, InstallerPipelineError } from "./mod.ts";

const CONTEXT = {
  installationId: "ins_1",
  spaceId: "space_1",
  appId: "app.example",
  source: { kind: "local" as const, url: "/tmp/app" },
  repo: { id: "app.example", name: "app" },
  binding: {
    name: "oidc",
    servicePath: "identity.primary.oidc",
  },
};

test("httpPlatformServiceResolver posts context and returns a platform service", async () => {
  const requests: Request[] = [];
  const resolver = httpPlatformServiceResolver({
    url:
      "https://cloud.example.test/internal/workload-platform-services/resolve",
    token: "resolver-token",
    fetch: (request, init) => {
      requests.push(new Request(request, init));
      return Promise.resolve(Response.json({
        service: {
          path: "identity.primary.oidc",
          kind: "identity.oidc@v1",
          material: {
            issuerUrl: "https://cloud.example.test",
            clientSecretRef: { secretRef: "secret://oidc/client-secret" },
          },
        },
      }));
    },
  });

  const service = await resolver.resolve(CONTEXT);

  expect(requests.length).toEqual(1);
  expect(requests[0].url).toEqual(
    "https://cloud.example.test/internal/workload-platform-services/resolve",
  );
  expect(requests[0].headers.get("authorization")).toEqual(
    "Bearer resolver-token",
  );
  expect(await requests[0].json()).toEqual(CONTEXT);
  expect(service).toEqual({
    path: "identity.primary.oidc",
    kind: "identity.oidc@v1",
    material: {
      issuerUrl: "https://cloud.example.test",
      clientSecretRef: { secretRef: "secret://oidc/client-secret" },
    },
  });
});

test("httpPlatformServiceResolver treats 404 as absent platform service", async () => {
  const resolver = httpPlatformServiceResolver({
    url:
      "https://cloud.example.test/internal/workload-platform-services/resolve",
    fetch: () =>
      Promise.resolve(Response.json({ error: "not_found" }, { status: 404 })),
  });

  expect(await resolver.resolve(CONTEXT)).toEqual(undefined);
});

test("httpPlatformServiceResolver returns service collections", async () => {
  const resolver = httpPlatformServiceResolver({
    url:
      "https://cloud.example.test/internal/workload-platform-services/resolve",
    fetch: () =>
      Promise.resolve(Response.json({
        services: [
          { kind: "mcp-server", path: "tools.one" },
          { kind: "mcp-server", path: "tools.two" },
        ],
      })),
  });

  expect(await resolver.resolve({
    ...CONTEXT,
    binding: { name: "tools", serviceKind: "mcp-server", many: true },
  })).toEqual([
    { kind: "mcp-server", path: "tools.one" },
    { kind: "mcp-server", path: "tools.two" },
  ]);
});

test("httpPlatformServiceResolver rejects non-service responses", async () => {
  const resolver = httpPlatformServiceResolver({
    url:
      "https://cloud.example.test/internal/workload-platform-services/resolve",
    fetch: () => Promise.resolve(Response.json(["not-service"])),
  });

  const rejection = resolver.resolve(CONTEXT);
  await expect(rejection).rejects.toThrow(InstallerPipelineError);
  await expect(rejection).rejects.toThrow(
    "operator catalog returned a non-object platform service",
  );
});
