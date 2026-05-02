import assert from "node:assert/strict";
import { ObjectStoreShape } from "../src/shapes/object-store.ts";
import {
  createAwsS3ObjectStoreProvider,
  InMemoryAwsS3Lifecycle,
} from "../src/shape-providers/object-store/aws-s3.ts";
import {
  createCloudflareR2ObjectStoreProvider,
  InMemoryCloudflareR2Lifecycle,
} from "../src/shape-providers/object-store/cloudflare-r2.ts";
import {
  createFilesystemObjectStoreProvider,
  InMemoryFilesystemLifecycle,
} from "../src/shape-providers/object-store/filesystem.ts";
import type { PlatformContext, ShapeValidationIssue } from "takosumi-contract";

const ctx = {} as PlatformContext;

const SAME_SPEC = {
  name: "portable-bucket",
  public: false,
  versioning: false,
};

Deno.test("ObjectStore portability: identical spec produces identical output keys across providers", async () => {
  const s3 = createAwsS3ObjectStoreProvider({
    lifecycle: new InMemoryAwsS3Lifecycle("us-east-1"),
  });
  const r2 = createCloudflareR2ObjectStoreProvider({
    lifecycle: new InMemoryCloudflareR2Lifecycle("acct"),
    accountId: "acct",
  });
  const fs = createFilesystemObjectStoreProvider({
    lifecycle: new InMemoryFilesystemLifecycle("/var/data"),
    rootDir: "/var/data",
  });

  const s3Result = await s3.apply(SAME_SPEC, ctx);
  const r2Result = await r2.apply(SAME_SPEC, ctx);
  const fsResult = await fs.apply(SAME_SPEC, ctx);

  const expectedKeys = [
    "bucket",
    "endpoint",
    "region",
    "accessKeyRef",
    "secretKeyRef",
  ].sort();

  assert.deepEqual(Object.keys(s3Result.outputs).sort(), expectedKeys);
  assert.deepEqual(Object.keys(r2Result.outputs).sort(), expectedKeys);
  assert.deepEqual(Object.keys(fsResult.outputs).sort(), expectedKeys);

  assert.equal(s3Result.outputs.bucket, "portable-bucket");
  assert.equal(r2Result.outputs.bucket, "portable-bucket");
  assert.equal(fsResult.outputs.bucket, "portable-bucket");
});

Deno.test("ObjectStore portability: outputs validate against ObjectStore shape outputSchema", async () => {
  const s3 = createAwsS3ObjectStoreProvider({
    lifecycle: new InMemoryAwsS3Lifecycle("us-east-1"),
  });
  const r2 = createCloudflareR2ObjectStoreProvider({
    lifecycle: new InMemoryCloudflareR2Lifecycle("acct"),
    accountId: "acct",
  });

  const s3Result = await s3.apply(SAME_SPEC, ctx);
  const r2Result = await r2.apply(SAME_SPEC, ctx);

  const s3Issues: ShapeValidationIssue[] = [];
  ObjectStoreShape.validateOutputs(s3Result.outputs, s3Issues);
  assert.deepEqual(s3Issues, [], "S3 outputs must satisfy ObjectStore shape");

  const r2Issues: ShapeValidationIssue[] = [];
  ObjectStoreShape.validateOutputs(r2Result.outputs, r2Issues);
  assert.deepEqual(r2Issues, [], "R2 outputs must satisfy ObjectStore shape");
});

Deno.test("ObjectStore portability: provider differs but shape contract holds", () => {
  const s3 = createAwsS3ObjectStoreProvider({
    lifecycle: new InMemoryAwsS3Lifecycle("us-east-1"),
  });
  const r2 = createCloudflareR2ObjectStoreProvider({
    lifecycle: new InMemoryCloudflareR2Lifecycle("acct"),
    accountId: "acct",
  });

  assert.equal(s3.implements.id, r2.implements.id);
  assert.equal(s3.implements.version, r2.implements.version);
  assert.notEqual(s3.id, r2.id);
});
