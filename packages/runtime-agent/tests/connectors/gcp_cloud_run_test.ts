import assert from "node:assert/strict";
import { CloudRunConnector } from "../../src/connectors/gcp/cloud_run.ts";
import { recordingFetch } from "./_fetch_mock.ts";

Deno.test("CloudRunConnector.apply creates service and uses returned uri", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response(
      JSON.stringify({ uri: "https://app-xxxx-uc.a.run.app" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  );
  const connector = new CloudRunConnector({
    project: "my-proj",
    region: "us-central1",
    bearerToken: "tok",
    fetch: mockFetch,
  });
  const res = await connector.apply({
    shape: "web-service@v1",
    provider: "cloud-run",
    resourceName: "rs",
    spec: {
      image: "us-docker.pkg.dev/proj/app:1",
      port: 8080,
      scale: { min: 0, max: 5 },
    },
  });
  assert.equal(res.handle, "my-proj/us-central1/app");
  assert.equal(res.outputs.url, "https://app-xxxx-uc.a.run.app");
  assert.equal(res.outputs.internalPort, 8080);
  assert.equal(calls.length, 1);
  assert.match(
    calls[0].url,
    /v2\/projects\/my-proj\/locations\/us-central1\/services\?serviceId=app/,
  );
});
