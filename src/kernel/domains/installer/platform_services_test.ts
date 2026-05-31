import { expect, test } from "bun:test";
import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { httpPlatformServiceResolver, InstallerPipelineError } from "./mod.ts";

test("httpPlatformServiceResolver posts context and returns material", async () => {
  const requests: Request[] = [];
  const resolver = httpPlatformServiceResolver({
    url:
      "https://cloud.example.test/internal/workload-platform-services/resolve",
    token: "resolver-token",
    fetch: (request, init) => {
      requests.push(new Request(request, init));
      return Promise.resolve(Response.json({
        material: {
          materialKind: "identity.oidc@v1",
          issuerUrl: "https://cloud.example.test",
          clientSecretRef: { secretRef: "secret://oidc/client-secret" },
        },
      }));
    },
  });

  const material = await resolver.resolve({
    installationId: "ins_1",
    spaceId: "space_1",
    appId: "app.example",
    componentName: "web",
    component: { kind: "worker" },
    bindingName: "oidc",
    sourceRef: "identity.primary.oidc",
  });

  expect(requests.length).toEqual(1);
  expect(requests[0].url).toEqual("https://cloud.example.test/internal/workload-platform-services/resolve");
  expect(requests[0].headers.get("authorization")).toEqual("Bearer resolver-token");
  expect(await requests[0].json()).toEqual({
    installationId: "ins_1",
    spaceId: "space_1",
    appId: "app.example",
    componentName: "web",
    component: { kind: "worker" },
    bindingName: "oidc",
    sourceRef: "identity.primary.oidc",
  });
  expect(material).toEqual({
    materialKind: "identity.oidc@v1",
    issuerUrl: "https://cloud.example.test",
    clientSecretRef: { secretRef: "secret://oidc/client-secret" },
  });
});

test("httpPlatformServiceResolver treats 404 as absent platform service", async () => {
  const resolver = httpPlatformServiceResolver({
    url:
      "https://cloud.example.test/internal/workload-platform-services/resolve",
    fetch: () =>
      Promise.resolve(Response.json({ error: "not_found" }, {
        status: 404,
      })),
  });

  expect(await resolver.resolve({
      installationId: "ins_1",
      spaceId: "space_1",
      appId: "app.example",
      componentName: "web",
      component: { kind: "worker" },
      bindingName: "oidc",
      sourceRef: "identity.missing.service",
    })).toEqual(undefined);
});

test("httpPlatformServiceResolver returns material collections", async () => {
  const resolver = httpPlatformServiceResolver({
    url:
      "https://cloud.example.test/internal/workload-platform-services/resolve",
    fetch: () =>
      Promise.resolve(Response.json({
        materials: [
          { materialKind: "mcp-server", url: "https://one.example.test/mcp" },
          { materialKind: "mcp-server", url: "https://two.example.test/mcp" },
        ],
      })),
  });

  expect(await resolver.resolve({
      installationId: "ins_1",
      spaceId: "space_1",
      appId: "app.example",
      componentName: "agent",
      component: { kind: "worker" },
      bindingName: "tools",
      kind: "mcp-server",
      many: true,
    })).toEqual([
      { materialKind: "mcp-server", url: "https://one.example.test/mcp" },
      { materialKind: "mcp-server", url: "https://two.example.test/mcp" },
    ]);
});

test("httpPlatformServiceResolver rejects non-material responses", async () => {
  const resolver = httpPlatformServiceResolver({
    url:
      "https://cloud.example.test/internal/workload-platform-services/resolve",
    fetch: () => Promise.resolve(Response.json(["not-material"])),
  });

  await assertRejects(
    async () => {
      await resolver.resolve({
        installationId: "ins_1",
        spaceId: "space_1",
        appId: "app.example",
        componentName: "web",
        component: { kind: "worker" },
        bindingName: "oidc",
        sourceRef: "identity.primary.oidc",
      });
    },
    InstallerPipelineError,
    "platform service resolver response must be a material object",
  );
});
