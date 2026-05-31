import { expect, test } from "bun:test";

import { createApiApp } from "./app.ts";

test("installer_public_routes — 5 endpoints respond with 501 not_implemented",
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
      expect(response.status).toEqual(501);
      const json = await response.json();
      expect(json.error.code).toEqual("not_implemented");
      expect(typeof json.error.message).toEqual("string");
      expect(typeof json.error.requestId).toEqual("string");
    }
  },
);

test("installer_public_routes — disabled without TAKOSUMI_INSTALLER_TOKEN",
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
    expect(response.status).toEqual(404);
    expect((await response.json()).error.code).toEqual("not_found");
  },
);

test("installer_public_routes — rejects invalid bearer", async () => {
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
  expect(response.status).toEqual(401);
  expect((await response.json()).error.code).toEqual("unauthenticated");
});
