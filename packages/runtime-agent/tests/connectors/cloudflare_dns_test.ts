import assert from "node:assert/strict";
import { CloudflareDnsConnector } from "../../src/connectors/cloudflare/dns.ts";
import { recordingFetch } from "./_fetch_mock.ts";

Deno.test("CloudflareDnsConnector.apply creates record and returns id handle", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response(
      JSON.stringify({
        success: true,
        result: { id: "rec-123" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  );
  const connector = new CloudflareDnsConnector({
    zoneId: "zone-1",
    apiToken: "cf-token",
    fetch: mockFetch,
  });
  const res = await connector.apply({
    shape: "custom-domain@v1",
    provider: "cloudflare-dns",
    resourceName: "rs",
    spec: { name: "app.example.com", target: "lb.example.com" },
  }, {});
  assert.equal(res.handle, "rec-123");
  assert.equal(res.outputs.fqdn, "app.example.com");
  assert.match(calls[0].url, /\/zones\/zone-1\/dns_records$/);
  assert.match(calls[0].body ?? "", /"type":"CNAME"/);
  assert.match(calls[0].body ?? "", /"proxied":true/);
});
