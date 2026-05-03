import assert from "node:assert/strict";
import { CloudflareContainerConnector } from "../../src/connectors/cloudflare/container.ts";
import { recordingFetch } from "./_fetch_mock.ts";

Deno.test("CloudflareContainerConnector.verify lists applications and reports ok on 200", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response(
      JSON.stringify({ success: true, result: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  );
  const connector = new CloudflareContainerConnector({
    accountId: "acct-1",
    apiToken: "cf-token",
    fetch: mockFetch,
  });
  const res = await connector.verify({});
  assert.equal(res.ok, true);
  assert.equal(res.note, "credentials valid");
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].url, /\/accounts\/acct-1\/containers\/applications$/);
});

Deno.test("CloudflareContainerConnector.verify reports auth_failed on 401", async () => {
  const { fetch: mockFetch } = recordingFetch(() =>
    new Response(JSON.stringify({ success: false, errors: [] }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })
  );
  const connector = new CloudflareContainerConnector({
    accountId: "acct-1",
    apiToken: "cf-token",
    fetch: mockFetch,
  });
  const res = await connector.verify({});
  assert.equal(res.ok, false);
  assert.equal(res.code, "auth_failed");
});

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
    provider: "@takos/cloudflare-container",
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
