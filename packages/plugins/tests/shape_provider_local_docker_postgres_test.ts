import assert from "node:assert/strict";
import {
  createLocalDockerPostgresProvider,
  InMemoryLocalDockerPostgresLifecycle,
} from "../src/shape-providers/database-postgres/local-docker.ts";
import type { PlatformContext } from "takosumi-contract";

const ctx = {} as PlatformContext;

function newProvider() {
  const lifecycle = new InMemoryLocalDockerPostgresLifecycle();
  return {
    lifecycle,
    provider: createLocalDockerPostgresProvider({
      lifecycle,
      hostBinding: "localhost",
      hostPortStart: 15432,
      passwordGenerator: () => "deterministic-password",
    }),
  };
}

Deno.test("local-docker provider declares database-postgres@v1", () => {
  const { provider } = newProvider();
  assert.equal(provider.id, "@takos/selfhost-postgres");
  assert.deepEqual(provider.implements, {
    id: "database-postgres",
    version: "v1",
  });
});

Deno.test("local-docker apply provisions an instance and returns connection", async () => {
  const { lifecycle, provider } = newProvider();
  const result = await provider.apply({ version: "16", size: "small" }, ctx);
  assert.equal(result.outputs.host, "localhost");
  assert.equal(result.outputs.username, "app");
  assert.equal(result.outputs.database, "app");
  assert.match(
    result.outputs.connectionString,
    /^postgresql:\/\/app@localhost:\d+\/app$/,
  );
  assert.equal(lifecycle.size(), 1);
});

Deno.test("local-docker password is recorded by lifecycle", async () => {
  const { lifecycle, provider } = newProvider();
  const apply = await provider.apply({ version: "16", size: "small" }, ctx);
  assert.equal(lifecycle.password(apply.handle), "deterministic-password");
});

Deno.test("local-docker destroy removes the instance", async () => {
  const { lifecycle, provider } = newProvider();
  const apply = await provider.apply({ version: "16", size: "small" }, ctx);
  await provider.destroy(apply.handle, ctx);
  assert.equal(lifecycle.size(), 0);
  const status = await provider.status(apply.handle, ctx);
  assert.equal(status.kind, "deleted");
});
