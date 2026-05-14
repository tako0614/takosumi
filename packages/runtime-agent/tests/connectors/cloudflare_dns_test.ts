import assert from "node:assert/strict";
import { CloudflareDnsConnector } from "../../src/connectors/cloudflare/dns.ts";
import { recordingFetch } from "./_fetch_mock.ts";

Deno.test("CloudflareDnsConnector.verify GETs zone metadata and reports ok on 200", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response(
      JSON.stringify({ success: true, result: { id: "zone-1" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  );
  const connector = new CloudflareDnsConnector({
    zoneId: "zone-1",
    apiToken: "cf-token",
    fetch: mockFetch,
  });
  const res = await connector.verify({});
  assert.equal(res.ok, true);
  assert.equal(res.note, "credentials valid");
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].url, /\/zones\/zone-1$/);
});

Deno.test("CloudflareDnsConnector.verify reports auth_failed on 401", async () => {
  const { fetch: mockFetch } = recordingFetch(() =>
    new Response(JSON.stringify({ success: false, errors: [] }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })
  );
  const connector = new CloudflareDnsConnector({
    zoneId: "zone-1",
    apiToken: "cf-token",
    fetch: mockFetch,
  });
  const res = await connector.verify({});
  assert.equal(res.ok, false);
  assert.equal(res.code, "auth_failed");
});

Deno.test("CloudflareDnsConnector.apply rejects malformed result.id in API response", async () => {
  // CF DNS API contract: `result.id` is a string. A numeric id means the
  // upstream envelope broke; the connector must refuse to derive a handle.
  const { fetch: mockFetch } = recordingFetch(() =>
    new Response(
      JSON.stringify({ success: true, result: { id: 42 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  );
  const connector = new CloudflareDnsConnector({
    zoneId: "zone-1",
    apiToken: "cf-token",
    fetch: mockFetch,
  });
  await assert.rejects(
    () =>
      connector.apply({
        shape: "custom-domain@v1",
        provider: "@takos/cloudflare-dns",
        resourceName: "rs",
        spec: { name: "app.example.com", target: "lb.example.com" },
      }, {}),
    /\$\.result\.id/,
  );
});

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
    provider: "@takos/cloudflare-dns",
    resourceName: "rs",
    spec: { name: "app.example.com", target: "lb.example.com" },
  }, {});
  assert.equal(res.handle, "rec-123");
  assert.equal(res.outputs.fqdn, "app.example.com");
  assert.match(calls[0].url, /\/zones\/zone-1\/dns_records$/);
  assert.match(calls[0].body ?? "", /"type":"CNAME"/);
  assert.match(calls[0].body ?? "", /"proxied":true/);
});
