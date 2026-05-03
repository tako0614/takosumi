import assert from "node:assert/strict";
import { K3sDeploymentConnector } from "../../src/connectors/kubernetes/k3s_deployment.ts";
import { recordingFetch } from "./_fetch_mock.ts";

Deno.test("K3sDeploymentConnector.verify lists namespaces and reports ok on 200", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  const connector = new K3sDeploymentConnector({
    apiServerUrl: "https://k8s.local:6443",
    bearerToken: "k8s-token",
    namespace: "takos",
    fetch: mockFetch,
  });
  const res = await connector.verify({});
  assert.equal(res.ok, true);
  assert.equal(res.note, "credentials valid");
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].url, /\/api\/v1\/namespaces\?limit=1$/);
});

Deno.test("K3sDeploymentConnector.verify reports auth_failed on 401", async () => {
  const { fetch: mockFetch } = recordingFetch(() =>
    new Response("{}", {
      status: 401,
      headers: { "content-type": "application/json" },
    })
  );
  const connector = new K3sDeploymentConnector({
    apiServerUrl: "https://k8s.local:6443",
    bearerToken: "bad",
    namespace: "takos",
    fetch: mockFetch,
  });
  const res = await connector.verify({});
  assert.equal(res.ok, false);
  assert.equal(res.code, "auth_failed");
});

Deno.test("K3sDeploymentConnector.apply POSTs Deployment + Service to k8s API", async () => {
  const responses = [
    // Deployment create
    new Response("{}", { status: 201 }),
    // Service create (returns clusterIP)
    new Response(
      JSON.stringify({ spec: { clusterIP: "10.0.0.1" } }),
      { status: 201, headers: { "content-type": "application/json" } },
    ),
  ];
  let i = 0;
  const { fetch: mockFetch, calls } = recordingFetch(() => responses[i++]);
  const connector = new K3sDeploymentConnector({
    apiServerUrl: "https://k8s.local:6443",
    bearerToken: "k8s-token",
    namespace: "takos",
    fetch: mockFetch,
  });
  const res = await connector.apply({
    shape: "web-service@v1",
    provider: "k3s-deployment",
    resourceName: "rs",
    spec: {
      image: "registry/app:1",
      port: 8080,
      scale: { min: 2, max: 5 },
    },
  }, {});
  assert.equal(res.handle, "takos/app");
  assert.equal(
    res.outputs.url,
    "http://app.takos.svc.cluster.local:8080",
  );
  assert.match(
    calls[0].url,
    /\/apis\/apps\/v1\/namespaces\/takos\/deployments$/,
  );
  assert.match(calls[1].url, /\/api\/v1\/namespaces\/takos\/services$/);
  assert.equal(calls[0].headers.get("authorization"), "Bearer k8s-token");
});
