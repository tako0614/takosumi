import { assertEquals } from "jsr:@std/assert@^1.0.5";
import { createApiApp } from "./app.ts";

Deno.test(
  "installer_public_routes — 5 endpoints respond with 501 not_implemented",
  async () => {
    const app = await createApiApp({
      registerInternalRoutes: false,
      registerInstallerPublicRoutes: true,
      installerPublicRouteOptions: {
        getInstallerToken: () => "installer-token",
      },
      requestCorrelation: false,
    });

    const endpoints = [
      ["/v1/installations/dry-run", {}],
      ["/v1/installations", {}],
      ["/v1/installations/ins_abc/deployments/dry-run", {}],
      ["/v1/installations/ins_abc/deployments", {}],
      ["/v1/installations/ins_abc/rollback", { deploymentId: "dep_x" }],
    ] as const;

    for (const [path, body] of endpoints) {
      const response = await app.request(path, {
        method: "POST",
        headers: {
          "authorization": "Bearer installer-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      assertEquals(response.status, 501, `expected 501 for ${path}`);
      const json = await response.json();
      assertEquals(
        json.error.code,
        "not_implemented",
        `expected not_implemented for ${path}`,
      );
      assertEquals(
        typeof json.error.message,
        "string",
        `expected error.message string for ${path}`,
      );
      assertEquals(
        typeof json.error.requestId,
        "string",
        `expected error.requestId string for ${path}`,
      );
    }
  },
);

Deno.test(
  "installer_public_routes — disabled without TAKOSUMI_INSTALLER_TOKEN",
  async () => {
    const app = await createApiApp({
      registerInternalRoutes: false,
      registerInstallerPublicRoutes: true,
      requestCorrelation: false,
    });

    const response = await app.request("/v1/installations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(response.status, 404);
    assertEquals((await response.json()).error.code, "not_found");
  },
);

Deno.test("installer_public_routes — rejects invalid bearer", async () => {
  const app = await createApiApp({
    registerInternalRoutes: false,
    registerInstallerPublicRoutes: true,
    installerPublicRouteOptions: {
      getInstallerToken: () => "installer-token",
    },
    requestCorrelation: false,
  });

  const response = await app.request("/v1/installations", {
    method: "POST",
    headers: {
      "authorization": "Bearer wrong-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  assertEquals(response.status, 401);
  assertEquals((await response.json()).error.code, "unauthenticated");
});
