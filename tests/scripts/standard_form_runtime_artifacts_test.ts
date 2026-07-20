import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildRuntimeRelease,
  verifyRuntimeArtifacts,
} from "../../scripts/verify-standard-form-runtime-artifacts.ts";

const ROOT = new URL("../..", import.meta.url).pathname;

test("committed standard Form runtime candidate has an exact closed artifact set", async () => {
  const manifest = await verifyRuntimeArtifacts(ROOT);
  expect(manifest.version).toBe("1.0.1");
  expect(manifest.assets.map(({ name }) => name)).toEqual([
    "durable-workflow.mjs",
    "edge-worker.mjs",
  ]);
  expect(manifest.externalArtifacts[0]?.platform).toBe("linux/amd64");
});

test("runtime verification rejects changed executable bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-runtime-tamper-"));
  await cp(
    join(ROOT, "conformance", "standard-form-runtime"),
    join(root, "conformance", "standard-form-runtime"),
    { recursive: true },
  );
  const path = join(
    root,
    "conformance",
    "standard-form-runtime",
    "v1.0.1",
    "edge-worker.mjs",
  );
  await writeFile(path, `${await readFile(path, "utf8")}\n`);
  await expect(verifyRuntimeArtifacts(root)).rejects.toThrow(
    "bytes do not match the manifest",
  );
});

test("release builder binds the exact source commit without signing or publishing", async () => {
  const output = await mkdtemp(join(tmpdir(), "takosumi-runtime-release-"));
  await buildRuntimeRelease(ROOT, "a".repeat(40), output);
  const manifest = JSON.parse(
    await readFile(join(output, "release-manifest.json"), "utf8"),
  );
  expect(manifest.sourceCommit).toBe("a".repeat(40));
  expect(manifest.publicationStatus).toBe("pending-immutable-publication");
  expect(manifest.assets.map(({ name }: { name: string }) => name)).toEqual([
    "durable-workflow.mjs",
    "edge-worker.mjs",
    "runtime-manifest.json",
  ]);
});
