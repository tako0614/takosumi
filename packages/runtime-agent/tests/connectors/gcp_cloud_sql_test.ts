import assert from "node:assert/strict";
import { CloudSqlConnector } from "../../src/connectors/gcp/cloud_sql.ts";
import { recordingFetch } from "./_fetch_mock.ts";

Deno.test("CloudSqlConnector.apply creates instance and emits descriptor", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response(
      JSON.stringify({
        ipAddresses: [{ ipAddress: "10.0.0.5", type: "PRIMARY" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  );
  const connector = new CloudSqlConnector({
    project: "my-proj",
    region: "us-central1",
    bearerToken: "tok",
    passwordGenerator: () => "fixed",
    fetch: mockFetch,
  });
  const res = await connector.apply({
    shape: "database-postgres@v1",
    provider: "cloud-sql",
    resourceName: "rs",
    spec: {
      version: "16",
      size: "small",
      storage: { sizeGiB: 10 },
      highAvailability: false,
    },
  }, {});
  assert.match(res.handle, /^projects\/my-proj\/instances\/pg-app-/);
  assert.equal(res.outputs.host, "10.0.0.5");
  assert.equal(res.outputs.port, 5432);
  assert.match(
    calls[0].url,
    /sqladmin\.googleapis\.com\/v1\/projects\/my-proj\/instances/,
  );
});
