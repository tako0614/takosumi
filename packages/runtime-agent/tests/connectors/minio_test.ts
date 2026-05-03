import assert from "node:assert/strict";
import { MinioConnector } from "../../src/connectors/selfhost/minio.ts";
import { recordingFetch } from "./_fetch_mock.ts";

Deno.test("MinioConnector.apply PUTs bucket against MinIO endpoint", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response("", { status: 200 })
  );
  const connector = new MinioConnector({
    endpoint: "http://minio.local:9000",
    fetch: mockFetch,
  });
  const res = await connector.apply({
    shape: "object-store@v1",
    provider: "minio",
    resourceName: "rs",
    spec: { name: "tenant-data" },
  }, {});
  assert.equal(res.handle, "tenant-data");
  assert.equal(res.outputs.bucket, "tenant-data");
  assert.equal(res.outputs.endpoint, "http://minio.local:9000/tenant-data");
  assert.equal(res.outputs.region, "local");
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].url, "http://minio.local:9000/tenant-data");
});

Deno.test("MinioConnector.describe returns missing on 404", async () => {
  const { fetch: mockFetch } = recordingFetch(() =>
    new Response("", { status: 404 })
  );
  const connector = new MinioConnector({
    endpoint: "http://minio.local:9000",
    fetch: mockFetch,
  });
  const res = await connector.describe({
    shape: "object-store@v1",
    provider: "minio",
    handle: "ghost",
  }, {});
  assert.equal(res.status, "missing");
});
