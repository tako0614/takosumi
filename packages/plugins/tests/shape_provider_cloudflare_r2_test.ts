import assert from "node:assert/strict";
import {
  createCloudflareR2ObjectStoreProvider,
  InMemoryCloudflareR2Lifecycle,
} from "../src/shape-providers/object-store/cloudflare-r2.ts";
import type { PlatformContext } from "takosumi-contract";

const ctx = {} as PlatformContext;

function newProvider() {
  const lifecycle = new InMemoryCloudflareR2Lifecycle("acct-123");
  return {
    lifecycle,
    provider: createCloudflareR2ObjectStoreProvider({
      lifecycle,
      accountId: "acct-123",
    }),
  };
}

Deno.test("cloudflare-r2 provider declares object-store@v1", () => {
  const { provider } = newProvider();
  assert.equal(provider.id, "@takos/cloudflare-r2");
  assert.deepEqual(provider.implements, { id: "object-store", version: "v1" });
});

Deno.test("cloudflare-r2 apply creates a bucket and returns ObjectStore outputs", async () => {
  const { lifecycle, provider } = newProvider();
  const result = await provider.apply({ name: "assets" }, ctx);
  assert.equal(result.outputs.bucket, "assets");
  assert.equal(result.outputs.region, "auto");
  assert.equal(
    result.outputs.endpoint,
    "https://acct-123.r2.cloudflarestorage.com/assets",
  );
  assert.equal(lifecycle.size(), 1);
});

Deno.test("cloudflare-r2 status reports deleted after destroy", async () => {
  const { provider } = newProvider();
  const apply = await provider.apply({ name: "ephemeral" }, ctx);
  await provider.destroy(apply.handle, ctx);
  const status = await provider.status(apply.handle, ctx);
  assert.equal(status.kind, "deleted");
});

Deno.test("cloudflare-r2 capability set excludes versioning and encryption", () => {
  const { provider } = newProvider();
  assert.ok(!provider.capabilities.includes("versioning"));
  assert.ok(!provider.capabilities.includes("server-side-encryption"));
  assert.ok(provider.capabilities.includes("presigned-urls"));
});
