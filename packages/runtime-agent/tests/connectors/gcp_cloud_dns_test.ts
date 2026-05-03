import assert from "node:assert/strict";
import { CloudDnsConnector } from "../../src/connectors/gcp/cloud_dns.ts";
import { recordingFetch } from "./_fetch_mock.ts";

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
    provider: "cloud-dns",
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
