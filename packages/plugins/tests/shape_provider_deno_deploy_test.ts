import assert from "node:assert/strict";
import {
  createDenoDeployProvider,
  InMemoryDenoDeployLifecycle,
} from "../src/shape-providers/worker/deno-deploy.ts";
import type { PlatformContext } from "takosumi-contract";

const ctx = {} as PlatformContext;

function newProvider() {
  const lifecycle = new InMemoryDenoDeployLifecycle("org-1");
  return {
    lifecycle,
    provider: createDenoDeployProvider({
      lifecycle,
      organizationId: "org-1",
    }),
  };
}

const validSpec = () => ({
  artifact: { kind: "js-bundle", hash: "sha256:abcdef0123" },
  compatibilityDate: "2025-01-01",
});

Deno.test("deno-deploy provider declares worker@v1", () => {
  const { provider } = newProvider();
  assert.equal(provider.id, "@takos/deno-deploy");
  assert.deepEqual(provider.implements, { id: "worker", version: "v1" });
  assert.ok(provider.capabilities.includes("scale-to-zero"));
});

Deno.test("deno-deploy apply creates a deployment and returns worker outputs", async () => {
  const { lifecycle, provider } = newProvider();
  const result = await provider.apply(validSpec(), ctx);
  assert.ok(result.outputs.url.endsWith(".deno.dev"));
  assert.ok(result.outputs.scriptName.startsWith("worker-"));
  assert.ok(result.outputs.version?.startsWith("dpl_"));
  assert.equal(lifecycle.size(), 1);
});

Deno.test("deno-deploy status returns deleted after destroy", async () => {
  const { provider } = newProvider();
  const apply = await provider.apply(validSpec(), ctx);
  await provider.destroy(apply.handle, ctx);
  const status = await provider.status(apply.handle, ctx);
  assert.equal(status.kind, "deleted");
});

Deno.test("deno-deploy status returns ready after apply", async () => {
  const { provider } = newProvider();
  const apply = await provider.apply(validSpec(), ctx);
  const status = await provider.status(apply.handle, ctx);
  assert.equal(status.kind, "ready");
  assert.ok(status.outputs?.url);
});
