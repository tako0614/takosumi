import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyRuntimeArtifacts } from "../../scripts/verify-standard-form-runtime-artifacts.ts";

const ROOT = new URL("../..", import.meta.url).pathname;

test("committed standard Form runtime fixtures have an exact closed artifact set", async () => {
  const manifest = await verifyRuntimeArtifacts(ROOT);
  expect(manifest.version).toBe("1.0.3");
  expect(manifest.assets.map(({ name }) => name)).toEqual([
    "durable-workflow.mjs",
    "edge-worker.mjs",
  ]);
  expect(manifest.externalArtifacts[0]?.platform).toBe("linux/amd64");
});

test("runtime 1.0.3 preserves the previous executable fixture bytes", async () => {
  for (const name of ["durable-workflow.mjs", "edge-worker.mjs"]) {
    expect(
      await readFile(
        join(ROOT, "conformance", "standard-form-runtime", "v1.0.3", name),
      ),
    ).toEqual(
      await readFile(
        join(ROOT, "conformance", "standard-form-runtime", "v1.0.2", name),
      ),
    );
  }
});

test("runtime fixture verification rejects changed executable bytes", async () => {
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
    "v1.0.3",
    "edge-worker.mjs",
  );
  await writeFile(path, `${await readFile(path, "utf8")}\n`);
  await expect(verifyRuntimeArtifacts(root)).rejects.toThrow(
    "bytes do not match the manifest",
  );
});
