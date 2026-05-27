import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { httpPlatformServiceResolver, InstallerPipelineError } from "./mod.ts";

Deno.test("httpPlatformServiceResolver posts context and returns material", async () => {
  const requests: Request[] = [];
  const resolver = httpPlatformServiceResolver({
    url:
      "https://cloud.example.test/internal/workload-platform-services/resolve",
    token: "resolver-token",
    fetch: (request, init) => {
      requests.push(new Request(request, init));
      return Promise.resolve(Response.json({
        material: {
          materialContract: "identity.oidc@v1",
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

  assertEquals(requests.length, 1);
  assertEquals(
    requests[0].url,
    "https://cloud.example.test/internal/workload-platform-services/resolve",
  );
  assertEquals(
    requests[0].headers.get("authorization"),
    "Bearer resolver-token",
  );
  assertEquals(await requests[0].json(), {
    installationId: "ins_1",
    spaceId: "space_1",
    appId: "app.example",
    componentName: "web",
    component: { kind: "worker" },
    bindingName: "oidc",
    sourceRef: "identity.primary.oidc",
  });
  assertEquals(material, {
    materialContract: "identity.oidc@v1",
    issuerUrl: "https://cloud.example.test",
    clientSecretRef: { secretRef: "secret://oidc/client-secret" },
  });
});

Deno.test("httpPlatformServiceResolver treats 404 as absent platform service", async () => {
  const resolver = httpPlatformServiceResolver({
    url:
      "https://cloud.example.test/internal/workload-platform-services/resolve",
    fetch: () =>
      Promise.resolve(Response.json({ error: "not_found" }, {
        status: 404,
      })),
  });

  assertEquals(
    await resolver.resolve({
      installationId: "ins_1",
      spaceId: "space_1",
      appId: "app.example",
      componentName: "web",
      component: { kind: "worker" },
      bindingName: "oidc",
      sourceRef: "identity.missing.service",
    }),
    undefined,
  );
});

Deno.test("httpPlatformServiceResolver rejects non-material responses", async () => {
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
