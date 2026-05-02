import assert from "node:assert/strict";
import {
  MemoryObjectStorage,
  ObjectStorageDigestMismatchError,
  sha256ObjectDigest,
} from "./mod.ts";

Deno.test("memory object storage supports put/get/head/list/delete with digest verification", async () => {
  const storage = new MemoryObjectStorage({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
  const expectedDigest = await sha256ObjectDigest("hello takos");

  const head = await storage.putObject({
    bucket: "artifacts",
    key: "tenant-a/release.txt",
    body: "hello takos",
    contentType: "text/plain",
    metadata: { tenant: "tenant-a" },
    expectedDigest,
  });

  assert.equal(head.digest, expectedDigest);
  assert.equal(head.contentLength, 11);
  assert.equal(head.updatedAt, "2026-04-27T00:00:00.000Z");
  assert.deepEqual(
    await storage.headObject({
      bucket: "artifacts",
      key: "tenant-a/release.txt",
    }),
    head,
  );

  const object = await storage.getObject({
    bucket: "artifacts",
    key: "tenant-a/release.txt",
    expectedDigest,
  });
  assert.equal(new TextDecoder().decode(object?.body), "hello takos");

  await storage.putObject({
    bucket: "artifacts",
    key: "tenant-a/manifest.json",
    body: "{}",
  });
  await storage.putObject({
    bucket: "artifacts",
    key: "tenant-b/manifest.json",
    body: "{}",
  });

  const listed = await storage.listObjects({
    bucket: "artifacts",
    prefix: "tenant-a/",
    limit: 1,
  });
  assert.deepEqual(listed.objects.map((item) => item.key), [
    "tenant-a/manifest.json",
  ]);
  assert.equal(listed.nextCursor, "tenant-a/manifest.json");

  const nextPage = await storage.listObjects({
    bucket: "artifacts",
    prefix: "tenant-a/",
    cursor: listed.nextCursor,
  });
  assert.deepEqual(nextPage.objects.map((item) => item.key), [
    "tenant-a/release.txt",
  ]);

  assert.equal(
    await storage.deleteObject({
      bucket: "artifacts",
      key: "tenant-a/release.txt",
    }),
    true,
  );
  assert.equal(
    await storage.getObject({
      bucket: "artifacts",
      key: "tenant-a/release.txt",
    }),
    undefined,
  );
});

Deno.test("memory object storage rejects mismatched content digest", async () => {
  const storage = new MemoryObjectStorage();
  await assert.rejects(
    () =>
      storage.putObject({
        bucket: "artifacts",
        key: "bad.txt",
        body: "actual",
        expectedDigest:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ObjectStorageDigestMismatchError,
  );
});
