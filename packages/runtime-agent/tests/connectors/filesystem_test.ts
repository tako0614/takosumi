import assert from "node:assert/strict";
import { FilesystemConnector } from "../../src/connectors/selfhost/filesystem.ts";

Deno.test("FilesystemConnector.apply creates a directory and returns its path as handle", async () => {
  const root = await Deno.makeTempDir({ prefix: "fs-connector-" });
  try {
    const connector = new FilesystemConnector({ rootDir: root });
    const res = await connector.apply({
      shape: "object-store@v1",
      provider: "filesystem",
      resourceName: "rs",
      spec: { name: "tenant-data" },
    });
    assert.equal(res.handle, `${root}/tenant-data`);
    assert.equal(res.outputs.bucket, "tenant-data");
    assert.equal(res.outputs.endpoint, `file://${root}/tenant-data`);
    const stat = await Deno.stat(`${root}/tenant-data`);
    assert.ok(stat.isDirectory);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("FilesystemConnector.describe returns missing for non-existent dir", async () => {
  const root = await Deno.makeTempDir({ prefix: "fs-connector-" });
  try {
    const connector = new FilesystemConnector({ rootDir: root });
    const res = await connector.describe({
      shape: "object-store@v1",
      provider: "filesystem",
      handle: `${root}/missing`,
    });
    assert.equal(res.status, "missing");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("FilesystemConnector.destroy removes the directory", async () => {
  const root = await Deno.makeTempDir({ prefix: "fs-connector-" });
  try {
    const connector = new FilesystemConnector({ rootDir: root });
    const apply = await connector.apply({
      shape: "object-store@v1",
      provider: "filesystem",
      resourceName: "rs",
      spec: { name: "x" },
    });
    const res = await connector.destroy({
      shape: "object-store@v1",
      provider: "filesystem",
      handle: apply.handle,
    });
    assert.equal(res.ok, true);
    await assert.rejects(() => Deno.stat(apply.handle));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
