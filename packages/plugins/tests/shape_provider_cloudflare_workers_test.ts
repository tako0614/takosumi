import assert from "node:assert/strict";
import {
  createCloudflareWorkersProvider,
  InMemoryCloudflareWorkersLifecycle,
} from "../src/shape-providers/worker/cloudflare-workers.ts";
import type { PlatformContext } from "takosumi-contract";

const ctx = {} as PlatformContext;

function newProvider() {
  const lifecycle = new InMemoryCloudflareWorkersLifecycle("acct-1");
  return {
    lifecycle,
    provider: createCloudflareWorkersProvider({
      lifecycle,
      accountId: "acct-1",
    }),
  };
}

const validSpec = () => ({
  artifact: { kind: "js-bundle", hash: "sha256:abcdef0123" },
  compatibilityDate: "2025-01-01",
});

Deno.test("cloudflare-workers provider declares worker@v1", () => {
  const { provider } = newProvider();
  assert.equal(provider.id, "@takos/cloudflare-workers");
  assert.deepEqual(provider.implements, { id: "worker", version: "v1" });
  assert.ok(provider.capabilities.includes("scale-to-zero"));
});

Deno.test("cloudflare-workers apply uploads script and returns worker outputs", async () => {
  const { lifecycle, provider } = newProvider();
  const result = await provider.apply(validSpec(), ctx);
  assert.ok(result.outputs.url.startsWith("https://worker-"));
  assert.ok(result.outputs.url.endsWith(".acct-1.workers.dev"));
  assert.ok(result.outputs.scriptName.startsWith("worker-"));
  assert.equal(lifecycle.size(), 1);
});

Deno.test("cloudflare-workers status returns deleted after destroy", async () => {
  const { provider } = newProvider();
  const apply = await provider.apply(validSpec(), ctx);
  await provider.destroy(apply.handle, ctx);
  const status = await provider.status(apply.handle, ctx);
  assert.equal(status.kind, "deleted");
});

Deno.test("cloudflare-workers status returns ready after apply", async () => {
  const { provider } = newProvider();
  const apply = await provider.apply(validSpec(), ctx);
  const status = await provider.status(apply.handle, ctx);
  assert.equal(status.kind, "ready");
  assert.ok(status.outputs?.url);
});
