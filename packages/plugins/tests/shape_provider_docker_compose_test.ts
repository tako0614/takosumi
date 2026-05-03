import assert from "node:assert/strict";
import {
  createDockerComposeWebServiceProvider,
  InMemoryDockerComposeLifecycle,
} from "../src/shape-providers/web-service/docker-compose.ts";
import type { PlatformContext } from "takosumi-contract";

const ctx = {} as PlatformContext;

function newProvider() {
  const lifecycle = new InMemoryDockerComposeLifecycle();
  return {
    lifecycle,
    provider: createDockerComposeWebServiceProvider({
      lifecycle,
      hostBinding: "localhost",
      hostPortStart: 18080,
    }),
  };
}

Deno.test("docker-compose provider declares web-service@v1", () => {
  const { provider } = newProvider();
  assert.equal(provider.id, "@takos/selfhost-docker-compose");
  assert.deepEqual(provider.implements, { id: "web-service", version: "v1" });
});

Deno.test("docker-compose apply creates a service and returns http url", async () => {
  const { lifecycle, provider } = newProvider();
  const result = await provider.apply(
    {
      image: "ghcr.io/example/api:latest",
      port: 8080,
      scale: { min: 1, max: 1 },
      env: { LOG_LEVEL: "info" },
    },
    ctx,
  );
  assert.match(result.outputs.url, /^http:\/\/localhost:\d+$/);
  assert.equal(result.outputs.internalPort, 8080);
  assert.equal(lifecycle.size(), 1);
});

Deno.test("docker-compose merges bindings into env", async () => {
  const { lifecycle, provider } = newProvider();
  const apply = await provider.apply(
    {
      image: "ghcr.io/example/api:latest",
      port: 8080,
      scale: { min: 1, max: 1 },
      env: { A: "1" },
      bindings: { DB_URL: "postgresql://..." },
    },
    ctx,
  );
  const desc = lifecycle.get(apply.handle);
  assert.ok(desc, "service should exist");
  assert.equal(desc.env?.A, "1");
  assert.equal(desc.env?.DB_URL, "postgresql://...");
});

Deno.test("docker-compose status reports deleted after destroy", async () => {
  const { provider } = newProvider();
  const apply = await provider.apply(
    { image: "x", port: 80, scale: { min: 1, max: 1 } },
    ctx,
  );
  await provider.destroy(apply.handle, ctx);
  const status = await provider.status(apply.handle, ctx);
  assert.equal(status.kind, "deleted");
});

Deno.test("docker-compose capabilities cover always-on but not scale-to-zero", () => {
  const { provider } = newProvider();
  assert.ok(provider.capabilities.includes("always-on"));
  assert.ok(!provider.capabilities.includes("scale-to-zero"));
});
