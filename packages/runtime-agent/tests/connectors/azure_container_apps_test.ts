import assert from "node:assert/strict";
import { AzureContainerAppsConnector } from "../../src/connectors/azure/container_apps.ts";
import { recordingFetch } from "./_fetch_mock.ts";

Deno.test("AzureContainerAppsConnector.verify GETs resource group and reports ok on 200", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response(
      JSON.stringify({ id: "/subscriptions/sub-1/resourceGroups/rg-1" }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )
  );
  const connector = new AzureContainerAppsConnector({
    subscriptionId: "sub-1",
    resourceGroup: "rg-1",
    region: "eastus",
    environmentName: "takosumi",
    environmentResourceId:
      "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.App/managedEnvironments/takosumi",
    bearerToken: "az-token",
    fetch: mockFetch,
  });
  const res = await connector.verify({});
  assert.equal(res.ok, true);
  assert.equal(res.note, "credentials valid");
  assert.equal(calls[0].method, "GET");
  assert.match(
    calls[0].url,
    /\/subscriptions\/sub-1\/resourceGroups\/rg-1\?api-version=/,
  );
});

Deno.test("AzureContainerAppsConnector.verify reports auth_failed on 401", async () => {
  const { fetch: mockFetch } = recordingFetch(() =>
    new Response("{}", {
      status: 401,
      headers: { "content-type": "application/json" },
    })
  );
  const connector = new AzureContainerAppsConnector({
    subscriptionId: "sub-1",
    resourceGroup: "rg-1",
    region: "eastus",
    environmentName: "takosumi",
    environmentResourceId:
      "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.App/managedEnvironments/takosumi",
    bearerToken: "bad-token",
    fetch: mockFetch,
  });
  const res = await connector.verify({});
  assert.equal(res.ok, false);
  assert.equal(res.code, "auth_failed");
});

Deno.test("AzureContainerAppsConnector.apply PUTs Container App and reads FQDN from describe", async () => {
  // PUT response empty 200; subsequent GET returns FQDN
  const responses = [
    new Response("", { status: 200 }),
    new Response(
      JSON.stringify({
        properties: {
          configuration: {
            ingress: { fqdn: "app.eastus.azurecontainerapps.io" },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  ];
  let i = 0;
  const { fetch: mockFetch, calls } = recordingFetch(() => responses[i++]);
  const connector = new AzureContainerAppsConnector({
    subscriptionId: "sub-1",
    resourceGroup: "rg-1",
    region: "eastus",
    environmentName: "takosumi",
    environmentResourceId:
      "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.App/managedEnvironments/takosumi",
    bearerToken: "az-token",
    fetch: mockFetch,
  });
  const res = await connector.apply({
    shape: "web-service@v1",
    provider: "@takos/azure-container-apps",
    resourceName: "rs",
    spec: {
      image: "registry/app:1",
      port: 8080,
      scale: { min: 1, max: 3 },
    },
  }, {});
  assert.equal(
    res.handle,
    "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.App/containerApps/app",
  );
  assert.equal(res.outputs.url, "https://app.eastus.azurecontainerapps.io");
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[1].method, "GET");
});
