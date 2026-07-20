import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  buildRuntimeRelease,
  verifyBuiltRuntimeRelease,
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
  const secondOutput = await mkdtemp(
    join(tmpdir(), "takosumi-runtime-release-repeat-"),
  );
  await buildRuntimeRelease(ROOT, "a".repeat(40), output);
  await buildRuntimeRelease(ROOT, "a".repeat(40), secondOutput);
  const manifest = JSON.parse(
    await readFile(join(output, "release-manifest.json"), "utf8"),
  );
  expect(manifest.sourceCommit).toBe("a".repeat(40));
  expect(manifest.publicationStatus).toBe("pending-immutable-publication");
  expect(manifest.assets.map(({ name }: { name: string }) => name)).toEqual([
    "durable-workflow.mjs",
    "edge-worker.mjs",
    "runtime-manifest.json",
    "runtime-sbom.spdx.json",
  ]);
  const sbom = JSON.parse(
    await readFile(join(output, "runtime-sbom.spdx.json"), "utf8"),
  );
  expect(sbom.spdxVersion).toBe("SPDX-2.3");
  expect(
    sbom.files.map(({ fileName }: { fileName: string }) => fileName),
  ).toEqual(["durable-workflow.mjs", "edge-worker.mjs"]);
  expect(sbom.packages[0].externalRefs[0].referenceLocator).toBe(
    "docker.io/library/nginx@sha256:845b5424415de5f77dd5753cbb7c1be8bd8e44cc81f20f9705783a02f8848317",
  );
  expect(await readFile(join(output, "runtime-sbom.spdx.json"), "utf8")).toBe(
    await readFile(join(secondOutput, "runtime-sbom.spdx.json"), "utf8"),
  );
  await verifyBuiltRuntimeRelease(ROOT, output, "a".repeat(40));
});

test("release verification rejects SBOM byte tampering and concealed inventory drift", async () => {
  const output = await mkdtemp(join(tmpdir(), "takosumi-runtime-sbom-tamper-"));
  const commit = "b".repeat(40);
  await buildRuntimeRelease(ROOT, commit, output);
  const sbomPath = join(output, "runtime-sbom.spdx.json");
  await writeFile(sbomPath, `${await readFile(sbomPath, "utf8")}\n`);
  await expect(verifyBuiltRuntimeRelease(ROOT, output, commit)).rejects.toThrow(
    "bytes do not match the manifest",
  );

  const sbom = JSON.parse(await readFile(sbomPath, "utf8"));
  sbom.packages = [];
  const sbomBytes = Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`);
  await writeFile(sbomPath, sbomBytes);
  const releasePath = join(output, "release-manifest.json");
  const release = JSON.parse(await readFile(releasePath, "utf8"));
  const sbomAsset = release.assets.find(
    ({ name }: { name: string }) => name === "runtime-sbom.spdx.json",
  );
  sbomAsset.size = sbomBytes.byteLength;
  sbomAsset.sha256 = `sha256:${createHash("sha256").update(sbomBytes).digest("hex")}`;
  await writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`);
  await expect(verifyBuiltRuntimeRelease(ROOT, output, commit)).rejects.toThrow(
    "SBOM inventory",
  );
});
