import assert from "node:assert/strict";
import { MinioConnector } from "../../src/connectors/selfhost/minio.ts";
import { recordingFetch } from "./_fetch_mock.ts";

Deno.test("MinioConnector.verify hits /minio/health/live and reports ok on 200", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response("", { status: 200 })
  );
  const connector = new MinioConnector({
    endpoint: "http://minio.local:9000",
    fetch: mockFetch,
  });
  const res = await connector.verify({});
  assert.equal(res.ok, true);
  assert.equal(res.note, "credentials valid");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, "http://minio.local:9000/minio/health/live");
});

Deno.test("MinioConnector.verify reports network_error on 500", async () => {
  const { fetch: mockFetch } = recordingFetch(() =>
    new Response("oops", { status: 500 })
  );
  const connector = new MinioConnector({
    endpoint: "http://minio.local:9000",
    fetch: mockFetch,
  });
  const res = await connector.verify({});
  assert.equal(res.ok, false);
  assert.equal(res.code, "network_error");
});

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
    provider: "@takos/selfhost-minio",
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
    provider: "@takos/selfhost-minio",
    handle: "ghost",
  }, {});
  assert.equal(res.status, "missing");
});
