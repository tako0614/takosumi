import assert from "node:assert/strict";
import { CloudflareR2Connector } from "../../src/connectors/cloudflare/r2.ts";
import { recordingFetch } from "./_fetch_mock.ts";

Deno.test("CloudflareR2Connector.apply POSTs to R2 buckets endpoint", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response(
      JSON.stringify({
        success: true,
        result: { name: "tenant-data", location: "auto" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  );
  const connector = new CloudflareR2Connector({
    accountId: "acct-1",
    apiToken: "cf-token",
    fetch: mockFetch,
  });
  const res = await connector.apply({
    shape: "object-store@v1",
    provider: "cloudflare-r2",
    resourceName: "rs",
    spec: { name: "tenant-data" },
  }, {});
  assert.equal(res.handle, "cloudflare:r2:acct-1:tenant-data");
  assert.equal(res.outputs.bucket, "tenant-data");
  assert.equal(
    res.outputs.endpoint,
    "https://acct-1.r2.cloudflarestorage.com/tenant-data",
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/accounts\/acct-1\/r2\/buckets$/);
  assert.equal(calls[0].headers.get("authorization"), "Bearer cf-token");
});
