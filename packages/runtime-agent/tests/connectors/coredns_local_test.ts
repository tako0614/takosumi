import assert from "node:assert/strict";
import { CorednsLocalConnector } from "../../src/connectors/selfhost/coredns_local.ts";

Deno.test("CorednsLocalConnector.apply appends record to zone file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "coredns-" });
  const zoneFile = `${dir}/Corefile`;
  try {
    await Deno.writeTextFile(zoneFile, "");
    const connector = new CorednsLocalConnector({ zoneFile });
    const res = await connector.apply({
      shape: "custom-domain@v1",
      provider: "coredns-local",
      resourceName: "rs",
      spec: { name: "app.example.com", target: "10.0.0.5" },
    }, {});
    assert.match(res.handle, /^coredns-/);
    assert.equal(res.outputs.fqdn, "app.example.com");
    const text = await Deno.readTextFile(zoneFile);
    assert.match(text, /app\.example\.com\. IN A 10\.0\.0\.5/);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
