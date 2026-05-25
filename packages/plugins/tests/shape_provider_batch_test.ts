import assert from "node:assert/strict";
import {
  type JsonObject,
  type PlatformContext,
  registerShape,
  type Shape,
  unregisterShape,
} from "takosumi-contract/reference/compat";
import { TAKOSUMI_REFERENCE_KINDS } from "../src/kinds/mod.ts";
import { createInMemoryTakosumiProviders } from "../src/shape-providers/mod.ts";

// `web-service` is now part of the external reference registry. Keep this
// local list explicit so the provider batch test also protects that export.
const TEST_BUNDLED_SHAPES: readonly Shape[] = [
  ...TAKOSUMI_REFERENCE_KINDS,
];

const ctx = {} as PlatformContext;

const SAMPLE_SPECS: Record<string, JsonObject> = {
  "object-store@v1": { name: "test-bucket" },
  "web-service@v1": {
    image: "oci://example/api:latest",
    port: 8080,
    scale: { min: 1, max: 1 },
  },
  "postgres@v1": { version: "16", size: "small" },
  "gateway@v1": {
    listeners: {
      public: { protocol: "https", host: "api.example.com", tls: "auto" },
    },
    routes: [{ listener: "public", path: "/", to: "upstream" }],
    target: "https://internal.example.com",
  },
  "worker@v1": {
    entrypoint: "dist/worker.mjs",
    compatibilityDate: "2025-01-01",
  },
};

Deno.test("all bundled providers apply with a sample spec for their shape", async () => {
  for (const shape of TEST_BUNDLED_SHAPES) registerShape(shape);
  try {
    const providers = createInMemoryTakosumiProviders();
    assert.equal(providers.length, 20);

    for (const provider of providers) {
      const shapeRef =
        `${provider.implements.id}@${provider.implements.version}`;
      const spec = SAMPLE_SPECS[shapeRef];
      assert.ok(spec, `no sample spec for ${shapeRef}`);

      const result = await provider.apply(spec, ctx);
      assert.ok(
        typeof result.handle === "string" && result.handle.length > 0,
        `${provider.id} returned empty handle`,
      );
      assert.ok(
        result.outputs && typeof result.outputs === "object",
        `${provider.id} returned no outputs`,
      );

      const status = await provider.status(result.handle, ctx);
      assert.equal(
        status.kind,
        "ready",
        `${provider.id} status not ready after apply`,
      );

      await provider.destroy(result.handle, ctx);
      const afterDestroy = await provider.status(result.handle, ctx);
      assert.equal(
        afterDestroy.kind,
        "deleted",
        `${provider.id} status not deleted after destroy`,
      );
    }
  } finally {
    for (const shape of TEST_BUNDLED_SHAPES) {
      unregisterShape(shape.id, shape.version);
    }
  }
});

Deno.test("bundled provider set covers all 5 shapes", () => {
  const providers = createInMemoryTakosumiProviders();
  const shapeIds = new Set(providers.map((p) => p.implements.id));
  assert.deepEqual(
    Array.from(shapeIds).sort(),
    [
      "gateway",
      "object-store",
      "postgres",
      "web-service",
      "worker",
    ],
  );
});

Deno.test("each shape has at least 2 providers (true portability)", () => {
  const providers = createInMemoryTakosumiProviders();
  const counts = new Map<string, number>();
  for (const p of providers) {
    counts.set(
      p.implements.id,
      (counts.get(p.implements.id) ?? 0) + 1,
    );
  }
  for (const [shape, count] of counts) {
    assert.ok(
      count >= 2,
      `shape ${shape} has only ${count} provider(s); portability requires >= 2`,
    );
  }
});
