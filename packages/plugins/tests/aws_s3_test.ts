import assert from "node:assert/strict";
import {
  type AwsObjectStorageClient,
  type AwsS3BucketDescriptor,
  type AwsS3LifecycleClient,
  AwsS3Provider,
} from "../src/providers/aws/mod.ts";

const noSleep = {
  maxAttempts: 3,
  baseDelayMs: 1,
  sleep: () => Promise.resolve(),
};

const baseBucket: AwsS3BucketDescriptor = {
  bucketName: "tenant-artifacts",
  arn: "arn:aws:s3:::tenant-artifacts",
  region: "us-east-1",
  versioningEnabled: true,
  publicAccessBlockEnabled: true,
  defaultEncryption: { algorithm: "AES256" },
};

function fakeLifecycle(
  overrides: Partial<AwsS3LifecycleClient> = {},
): AwsS3LifecycleClient {
  return {
    createBucket: () => Promise.resolve(baseBucket),
    describeBucket: () => Promise.resolve(baseBucket),
    deleteBucket: () => Promise.resolve(true),
    ...overrides,
  };
}

Deno.test("s3 createBucket happy path", async () => {
  const provider = new AwsS3Provider({
    lifecycle: fakeLifecycle(),
    retry: noSleep,
  });
  const result = await provider.createBucket({
    bucketName: "tenant-artifacts",
  });
  assert.equal(result.bucketName, "tenant-artifacts");
});

Deno.test("s3 describeBucket maps NoSuchBucket to undefined", async () => {
  const provider = new AwsS3Provider({
    lifecycle: fakeLifecycle({
      describeBucket: () => {
        const e = new Error("nope") as Error & { name: string };
        e.name = "NoSuchBucket";
        return Promise.reject(e);
      },
    }),
    retry: noSleep,
  });
  const result = await provider.describeBucket({ bucketName: "nope" });
  assert.equal(result, undefined);
});

Deno.test("s3 retries on 503 service unavailable", async () => {
  let attempts = 0;
  const provider = new AwsS3Provider({
    lifecycle: fakeLifecycle({
      createBucket: () => {
        attempts += 1;
        if (attempts < 3) {
          const e = new Error("503") as Error & { statusCode: number };
          e.statusCode = 503;
          return Promise.reject(e);
        }
        return Promise.resolve(baseBucket);
      },
    }),
    retry: noSleep,
  });
  await provider.createBucket({ bucketName: "tenant-artifacts" });
  assert.equal(attempts, 3);
});

Deno.test("s3 listAllObjects paginates via continuationToken", async () => {
  const head = (key: string) => ({
    bucket: "tenant-artifacts",
    key,
    contentLength: 1,
    contentType: "text/plain",
    metadata: {},
    digest: "sha256:abc" as const,
    etag: "etag",
    updatedAt: "2026-04-30T00:00:00.000Z",
  });
  const pages = [
    { objects: [head("a")], nextCursor: "p2" },
    { objects: [head("b"), head("c")], nextCursor: undefined },
  ];
  let pageIndex = 0;
  const objectStorage: AwsObjectStorageClient = {
    putObject: () => Promise.resolve(head("x")),
    getObject: () => Promise.resolve({ ...head("x"), body: new Uint8Array() }),
    headObject: () => Promise.resolve(head("x")),
    listObjects: () => Promise.resolve(pages[pageIndex++]),
    deleteObject: () => Promise.resolve(true),
  };
  const provider = new AwsS3Provider({
    lifecycle: fakeLifecycle(),
    objectStorage,
    retry: noSleep,
  });
  const all = await provider.listAllObjects({ bucketName: "tenant-artifacts" });
  assert.equal(all.length, 3);
  assert.equal(all[0]?.key, "a");
  assert.equal(all[2]?.key, "c");
});

Deno.test("s3 detectDrift reports versioning mismatch", async () => {
  const provider = new AwsS3Provider({
    lifecycle: fakeLifecycle({
      describeBucket: () =>
        Promise.resolve({ ...baseBucket, versioningEnabled: false }),
    }),
    retry: noSleep,
  });
  const drift = await provider.detectDrift({
    bucketName: "tenant-artifacts",
    region: "us-east-1",
    versioningEnabled: true,
    publicAccessBlockEnabled: true,
    defaultEncryption: { algorithm: "AES256" },
  });
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.path, "versioningEnabled");
});

Deno.test("s3 attachIamPolicy throws when client lacks support", () => {
  const provider = new AwsS3Provider({
    lifecycle: fakeLifecycle(),
    retry: noSleep,
  });
  assert.throws(
    () =>
      provider.attachIamPolicy({
        bucketName: "tenant-artifacts",
        principalArn: "arn:role",
        accessLevel: "read",
      }),
    /attachIamPolicy/,
  );
});
