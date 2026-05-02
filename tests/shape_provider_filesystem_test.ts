import assert from "node:assert/strict";
import {
  createFilesystemObjectStoreProvider,
  InMemoryFilesystemLifecycle,
} from "../src/shape-providers/object-store/filesystem.ts";
import type { PlatformContext } from "takosumi-contract";

const ctx = {} as PlatformContext;
const ROOT = "/var/lib/takos/object-store";

function newProvider() {
  const lifecycle = new InMemoryFilesystemLifecycle(ROOT);
  return {
    lifecycle,
    provider: createFilesystemObjectStoreProvider({
      lifecycle,
      rootDir: ROOT,
    }),
  };
}

Deno.test("filesystem provider declares object-store@v1", () => {
  const { provider } = newProvider();
  assert.equal(provider.id, "filesystem");
  assert.deepEqual(provider.implements, { id: "object-store", version: "v1" });
});

Deno.test("filesystem apply creates a bucket and returns file:// endpoint", async () => {
  const { lifecycle, provider } = newProvider();
  const result = await provider.apply({ name: "media" }, ctx);
  assert.equal(result.outputs.bucket, "media");
  assert.equal(result.outputs.region, "local");
  assert.equal(
    result.outputs.endpoint,
    `file://${ROOT}/media`,
  );
  assert.equal(lifecycle.size(), 1);
});

Deno.test("filesystem status round-trips apply -> destroy", async () => {
  const { provider } = newProvider();
  const apply = await provider.apply({ name: "ephemeral" }, ctx);
  let status = await provider.status(apply.handle, ctx);
  assert.equal(status.kind, "ready");
  await provider.destroy(apply.handle, ctx);
  status = await provider.status(apply.handle, ctx);
  assert.equal(status.kind, "deleted");
});
