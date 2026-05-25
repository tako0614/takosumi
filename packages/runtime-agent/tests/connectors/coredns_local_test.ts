import assert from "node:assert/strict";
import { CorednsLocalConnector } from "../../src/connectors/selfhost/coredns_local.ts";

Deno.test("CorednsLocalConnector.verify returns ok when corefile exists", async () => {
  const dir = await Deno.makeTempDir({ prefix: "coredns-verify-" });
  const zoneFile = `${dir}/Corefile`;
  try {
    await Deno.writeTextFile(zoneFile, "");
    const connector = new CorednsLocalConnector({ zoneFile });
    const res = await connector.verify({});
    assert.equal(res.ok, true);
    assert.match(`${res.note}`, /Corefile present/);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CorednsLocalConnector.verify returns ok=false when corefile missing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "coredns-verify-" });
  const zoneFile = `${dir}/Corefile`;
  try {
    const connector = new CorednsLocalConnector({ zoneFile });
    const res = await connector.verify({});
    assert.equal(res.ok, false);
    assert.equal(res.code, "network_error");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CorednsLocalConnector.apply appends record to zone file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "coredns-" });
  const zoneFile = `${dir}/Corefile`;
  try {
    await Deno.writeTextFile(zoneFile, "");
    const connector = new CorednsLocalConnector({ zoneFile });
    const res = await connector.apply({
      shape: "gateway@v1",
      provider: "@takos/selfhost-coredns",
      spaceId: "space_test",
      resourceName: "rs",
      spec: gatewaySpec("app.example.com", "10.0.0.5"),
    }, {});
    assert.match(res.handle, /^coredns-/);
    assert.equal(res.outputs.host, "app.example.com");
    const text = await Deno.readTextFile(zoneFile);
    assert.match(text, /app\.example\.com\. IN A 10\.0\.0\.5/);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

function gatewaySpec(host: string, target: string) {
  return {
    listeners: {
      public: { protocol: "https", host, tls: "auto" },
    },
    routes: [{ listener: "public", path: "/", to: "upstream" }],
    target,
  };
}
