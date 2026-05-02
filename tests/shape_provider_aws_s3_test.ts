import assert from "node:assert/strict";
import {
  createAwsS3ObjectStoreProvider,
  InMemoryAwsS3Lifecycle,
} from "../src/shape-providers/object-store/aws-s3.ts";
import type { PlatformContext } from "takosumi-contract";

const ctx = {} as PlatformContext;

function newProvider() {
  const lifecycle = new InMemoryAwsS3Lifecycle("us-east-1");
  return {
    lifecycle,
    provider: createAwsS3ObjectStoreProvider({
      lifecycle,
      defaultRegion: "us-east-1",
    }),
  };
}

Deno.test("aws-s3 provider declares object-store@v1", () => {
  const { provider } = newProvider();
  assert.equal(provider.id, "aws-s3");
  assert.deepEqual(provider.implements, { id: "object-store", version: "v1" });
});

Deno.test("aws-s3 apply creates a bucket and returns ObjectStore outputs", async () => {
  const { lifecycle, provider } = newProvider();
  const result = await provider.apply(
    { name: "test-bucket", region: "us-east-1", versioning: true },
    ctx,
  );
  assert.equal(result.outputs.bucket, "test-bucket");
  assert.equal(result.outputs.region, "us-east-1");
  assert.equal(
    result.outputs.endpoint,
    "https://s3.us-east-1.amazonaws.com/test-bucket",
  );
  assert.equal(lifecycle.size(), 1);
});

Deno.test("aws-s3 status returns deleted after destroy", async () => {
  const { provider } = newProvider();
  const apply = await provider.apply({ name: "ephemeral" }, ctx);
  await provider.destroy(apply.handle, ctx);
  const status = await provider.status(apply.handle, ctx);
  assert.equal(status.kind, "deleted");
});

Deno.test("aws-s3 status returns ready outputs after apply", async () => {
  const { provider } = newProvider();
  const apply = await provider.apply({ name: "live-bucket" }, ctx);
  const status = await provider.status(apply.handle, ctx);
  assert.equal(status.kind, "ready");
  assert.equal(status.outputs?.bucket, "live-bucket");
});
