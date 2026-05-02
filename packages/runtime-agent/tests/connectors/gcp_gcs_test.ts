import assert from "node:assert/strict";
import { GcpGcsConnector } from "../../src/connectors/gcp/gcs.ts";
import { recordingFetch } from "./_fetch_mock.ts";

Deno.test("GcpGcsConnector.apply POSTs to storage.googleapis.com with project query", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response(
      JSON.stringify({ name: "tenant-data", location: "us-central1" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  );
  const connector = new GcpGcsConnector({
    project: "my-proj",
    defaultLocation: "us-central1",
    bearerToken: "token-123",
    fetch: mockFetch,
  });
  const res = await connector.apply({
    shape: "object-store@v1",
    provider: "gcp-gcs",
    resourceName: "rs",
    spec: { name: "tenant-data" },
  });
  assert.equal(res.handle, "projects/my-proj/buckets/tenant-data");
  assert.equal(res.outputs.bucket, "tenant-data");
  assert.equal(res.outputs.region, "us-central1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.match(
    calls[0].url,
    /storage\.googleapis\.com\/storage\/v1\/b\?project=my-proj/,
  );
  assert.equal(calls[0].headers.get("authorization"), "Bearer token-123");
});
