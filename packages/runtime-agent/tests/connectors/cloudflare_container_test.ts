import assert from "node:assert/strict";
import { CloudflareContainerConnector } from "../../src/connectors/cloudflare/container.ts";
import { recordingFetch } from "./_fetch_mock.ts";

Deno.test("CloudflareContainerConnector.apply uses returned URL when present", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response(
      JSON.stringify({
        success: true,
        result: {
          id: "app-1",
          url: "https://app.cf-containers.com",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  );
  const connector = new CloudflareContainerConnector({
    accountId: "acct-1",
    apiToken: "cf-token",
    fetch: mockFetch,
  });
  const res = await connector.apply({
    shape: "web-service@v1",
    provider: "cloudflare-container",
    resourceName: "rs",
    spec: {
      image: "registry/app:1",
      port: 8080,
      scale: { min: 0, max: 5 },
    },
  }, {});
  assert.equal(res.handle, "acct-1/app");
  assert.equal(res.outputs.url, "https://app.cf-containers.com");
  assert.equal(res.outputs.internalPort, 8080);
  assert.match(calls[0].url, /\/accounts\/acct-1\/containers\/applications$/);
});
