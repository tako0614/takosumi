import assert from "node:assert/strict";
import { pluginCommand } from "../src/commands/plugin.ts";

Deno.test("plugin marketplace fetch prints package summary", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    assert.equal(String(input), "https://market.example/index.json");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          schemaVersion: "takosumi.plugin-marketplace.v1",
          marketplaceId: "market:test",
          generatedAt: "2026-05-05T00:00:00.000Z",
          packages: [{
            packageRef: "takos.provider.remote",
            kind: "kernel-plugin",
            version: "1.0.0",
            manifestEnvelope: {
              manifest: {
                id: "takos.provider.remote",
                name: "Remote Provider",
                version: "1.0.0",
                kernelApiVersion: "2026-04-29",
                capabilities: [],
              },
              signature: {
                alg: "ECDSA-P256-SHA256",
                keyId: "publisher-key:test",
                value: "sig",
              },
            },
            module: {
              specifier: "https://market.example/provider.js",
              digest:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
          }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
  }) as typeof fetch;
  console.log = (...parts: unknown[]) => {
    output.push(parts.map((part) => String(part)).join(" "));
  };
  try {
    await pluginCommand.parse([
      "marketplace",
      "fetch",
      "--url",
      "https://market.example/index.json",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }

  const dump = output.join("\n");
  assert.match(dump, /market:test/);
  assert.match(dump, /takos\.provider\.remote/);
  assert.match(dump, /kernel-plugin/);
});
