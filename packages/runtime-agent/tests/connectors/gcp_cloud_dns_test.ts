import assert from "node:assert/strict";
import { CloudDnsConnector } from "../../src/connectors/gcp/cloud_dns.ts";
import { recordingFetch } from "./_fetch_mock.ts";

Deno.test("CloudDnsConnector.verify lists managedZones and reports ok on 200", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response(JSON.stringify({ managedZones: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  const connector = new CloudDnsConnector({
    project: "my-proj",
    zoneName: "tenant-zone",
    bearerToken: "tok",
    fetch: mockFetch,
  });
  const res = await connector.verify({});
  assert.equal(res.ok, true);
  assert.equal(res.note, "credentials valid");
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].url, /\/projects\/my-proj\/managedZones\?maxResults=1/);
});

Deno.test("CloudDnsConnector.verify reports auth_failed on 401", async () => {
  const { fetch: mockFetch } = recordingFetch(() =>
    new Response("{}", {
      status: 401,
      headers: { "content-type": "application/json" },
    })
  );
  const connector = new CloudDnsConnector({
    project: "my-proj",
    zoneName: "tenant-zone",
    bearerToken: "tok",
    fetch: mockFetch,
  });
  const res = await connector.verify({});
  assert.equal(res.ok, false);
  assert.equal(res.code, "auth_failed");
});

Deno.test("CloudDnsConnector.apply POSTs CNAME RRSet to managed zone", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response("{}", { status: 200 })
  );
  const connector = new CloudDnsConnector({
    project: "my-proj",
    zoneName: "tenant-zone",
    bearerToken: "tok",
    fetch: mockFetch,
  });
  const res = await connector.apply({
    shape: "custom-domain@v1",
    provider: "@takos/gcp-cloud-dns",
    resourceName: "rs",
    spec: { name: "app.example.com", target: "lb.example.com" },
  }, {});
  assert.equal(res.handle, "tenant-zone|app.example.com|lb.example.com");
  assert.equal(res.outputs.fqdn, "app.example.com");
  assert.match(
    calls[0].url,
    /\/projects\/my-proj\/managedZones\/tenant-zone\/rrsets/,
  );
  assert.match(calls[0].body ?? "", /"type":"CNAME"/);
});
