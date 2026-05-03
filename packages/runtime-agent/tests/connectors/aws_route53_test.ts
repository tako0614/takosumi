import assert from "node:assert/strict";
import { Route53Connector } from "../../src/connectors/aws/route53.ts";
import { recordingFetch } from "./_fetch_mock.ts";

const credentials = { accessKeyId: "AKIA", secretAccessKey: "s" };

Deno.test("Route53Connector.apply UPSERTs CNAME via ChangeResourceRecordSets", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response("<ok/>", { status: 200 })
  );
  const connector = new Route53Connector({
    credentials,
    hostedZoneId: "ZONE-1",
    fetch: mockFetch,
  });
  const res = await connector.apply({
    shape: "custom-domain@v1",
    provider: "route53",
    resourceName: "rs",
    spec: { name: "app.example.com", target: "lb.example.com" },
  }, {});
  assert.equal(
    res.handle,
    "ZONE-1|CNAME|app.example.com|lb.example.com",
  );
  assert.equal(res.outputs.fqdn, "app.example.com");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/hostedzone\/ZONE-1\/rrset/);
  assert.match(calls[0].body ?? "", /<Action>UPSERT<\/Action>/);
  assert.match(calls[0].body ?? "", /<Name>app\.example\.com<\/Name>/);
});
