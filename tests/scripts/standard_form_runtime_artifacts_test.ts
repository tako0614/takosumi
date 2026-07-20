import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  buildRuntimeCandidateManifest,
  buildRuntimeReleaseReadback,
  buildRuntimeRelease,
  decodePromotionHealthChecks,
  verifyBuiltRuntimeRelease,
  verifyRuntimeCandidateManifest,
  verifyRuntimeArtifacts,
} from "../../scripts/verify-standard-form-runtime-artifacts.ts";

const ROOT = new URL("../..", import.meta.url).pathname;

test("committed standard Form runtime candidate has an exact closed artifact set", async () => {
  const manifest = await verifyRuntimeArtifacts(ROOT);
  expect(manifest.version).toBe("1.0.2");
  expect(manifest.assets.map(({ name }) => name)).toEqual([
    "durable-workflow.mjs",
    "edge-worker.mjs",
  ]);
  expect(manifest.externalArtifacts[0]?.platform).toBe("linux/amd64");
});

test("runtime 1.0.2 preserves the unpublished Form Package 1.0.1 executable fixture bytes", async () => {
  for (const name of ["durable-workflow.mjs", "edge-worker.mjs"]) {
    expect(
      await readFile(
        join(ROOT, "conformance", "standard-form-runtime", "v1.0.2", name),
      ),
    ).toEqual(
      await readFile(
        join(ROOT, "conformance", "standard-form-runtime", "v1.0.1", name),
      ),
    );
  }
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
    "v1.0.2",
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

test("release verification rejects source asset changes concealed by an updated release manifest", async () => {
  for (const [index, name] of [
    "edge-worker.mjs",
    "durable-workflow.mjs",
    "runtime-manifest.json",
  ].entries()) {
    const output = await mkdtemp(
      join(tmpdir(), `takosumi-runtime-source-tamper-${index}-`),
    );
    const commit = String(index + 3).repeat(40);
    await buildRuntimeRelease(ROOT, commit, output);
    const path = join(output, name);
    const changed = Buffer.from(`${await readFile(path, "utf8")}\n`);
    await writeFile(path, changed);
    const releasePath = join(output, "release-manifest.json");
    const release = JSON.parse(await readFile(releasePath, "utf8"));
    const asset = release.assets.find(
      (candidate: { name: string }) => candidate.name === name,
    );
    asset.size = changed.byteLength;
    asset.sha256 = `sha256:${createHash("sha256").update(changed).digest("hex")}`;
    await writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`);
    await expect(
      verifyBuiltRuntimeRelease(ROOT, output, commit),
    ).rejects.toThrow("does not match the source closure");
  }
});

test("release-safety candidate binds the closed stable byte set and envelope ordering", async () => {
  const sourceCommit = "c".repeat(40);
  const output = await preparedCandidateDirectory(sourceCommit);
  const workflowRunId = "123456789";
  const candidate = await buildRuntimeCandidateManifest(
    ROOT,
    output,
    sourceCommit,
    workflowRunId,
    "2026-07-20T12:34:56.000Z",
  );
  expect(candidate.kind).toBe("takos.release-candidate-manifest@v1");
  expect(candidate.repository).toBe("https://github.com/tako0614/takosumi.git");
  expect(candidate.ociImages).toEqual([]);
  expect(candidate.releaseAssets.map(({ name }) => name)).toEqual([
    "SHA256SUMS",
    "durable-workflow.mjs",
    "edge-worker.mjs",
    "release-manifest.json",
    "release-manifest.sigstore.json",
    "runtime-manifest.json",
    "runtime-sbom.spdx.json",
  ]);
  expect(candidate.artifactDigests).toEqual(
    candidate.releaseAssets.map(({ digest }) => digest),
  );
  await verifyRuntimeCandidateManifest(ROOT, output, {
    sourceCommit,
    workflowRunId,
    artifactDigests: candidate.artifactDigests,
    manifestDigest: sha256(
      await readFile(join(output, "release-candidate-manifest.json")),
    ),
  });
});

test("candidate verification rejects a post-build stable byte substitution", async () => {
  const sourceCommit = "d".repeat(40);
  const output = await preparedCandidateDirectory(sourceCommit);
  const candidate = await buildRuntimeCandidateManifest(
    ROOT,
    output,
    sourceCommit,
    "987654321",
    "2026-07-20T12:34:56.000Z",
  );
  await writeFile(
    join(output, "release-manifest.sigstore.json"),
    '{"forged":true}\n',
  );
  await expect(
    verifyRuntimeCandidateManifest(ROOT, output, {
      sourceCommit,
      workflowRunId: "987654321",
      artifactDigests: candidate.artifactDigests,
    }),
  ).rejects.toThrow("SHA256SUMS");
});

test("release readback converts only the fixed envelope checks to passed", () => {
  const bindingDigest = `sha256:${"e".repeat(64)}`;
  const encodedChecks = Buffer.from(
    JSON.stringify([
      {
        name: "stable GitHub release asset readback",
        status: "required",
        bindingDigest,
      },
      {
        name: "Sigstore bundle and transparency readback",
        status: "required",
        bindingDigest: `sha256:${"f".repeat(64)}`,
      },
    ]),
  ).toString("base64url");
  const healthChecks = decodePromotionHealthChecks(encodedChecks);
  const readback = buildRuntimeReleaseReadback({
    sourceCommit: "a".repeat(40),
    controllerCommit: "b".repeat(40),
    controllerDigest: `sha256:${"1".repeat(64)}`,
    adapterDigest: `sha256:${"2".repeat(64)}`,
    artifactDigests: Array.from(
      { length: 7 },
      (_, index) => `sha256:${String(index + 3).repeat(64)}`,
    ),
    healthChecks,
    targetFingerprint: `sha256:${"a".repeat(64)}`,
    attestationDigest: `sha256:${"b".repeat(64)}`,
    workflowRunId: "456789123",
    readbackAt: "2026-07-20T12:35:56.000Z",
  });
  expect(readback.status).toBe("promoted");
  expect(readback.healthChecks.map(({ status }) => status)).toEqual([
    "passed",
    "passed",
  ]);
  expect(readback.releaseUrl).toBe(
    "https://github.com/tako0614/takosumi/releases/tag/standard-form-runtime-v1.0.2",
  );
});

test("runtime release workflow is fixed-controller-bound and promotion cannot rebuild", async () => {
  const workflow = await readFile(
    join(ROOT, ".github", "workflows", "standard-form-runtime-release.yml"),
    "utf8",
  );
  expect(workflow).toContain(
    'RELEASE_SAFETY_CONTROLLER_COMMIT: "cd9b8b74672e3f436cc467ca8359738a232599fc"',
  );
  expect(workflow).toContain(
    'RELEASE_SAFETY_ADAPTER_DIGEST: "sha256:c25918640423a52c014ad903a57cefa8208b29348d60fc76084ea13e57bc1f3f"',
  );
  expect(workflow).toContain("release-safety:standard-form-runtime:");
  expect(workflow).toContain("candidate_run_id:");
  expect(workflow).toContain("release-safety-readback.json");
  expect(workflow).toContain("secrets.RELEASE_SAFETY_AUTHORIZATION_DIGEST");
  expect(workflow).toContain("secrets.RELEASE_SAFETY_RULESET_AUDIT_TOKEN");
  expect(workflow).toContain("age_seconds > 300");
  expect(workflow).toContain("standard-form-runtime-release-tags");
  expect(workflow).toContain(".bypass_actors == []");
  expect(workflow).toContain('test "${VERSION}" = "1.0.2"');
  const qualityGate = workflow.slice(
    workflow.indexOf("- name: Run the complete source quality gate"),
    workflow.indexOf("- name: Build the exact runtime release bytes once"),
  );
  expect(qualityGate).toContain("bun install --frozen-lockfile");
  expect(qualityGate).toContain(
    "(cd dashboard && bun install --frozen-lockfile)",
  );
  expect(qualityGate.indexOf("bun install --frozen-lockfile")).toBeLessThan(
    qualityGate.indexOf("(cd dashboard && bun install --frozen-lockfile)"),
  );
  expect(
    qualityGate.indexOf("(cd dashboard && bun install --frozen-lockfile)"),
  ).toBeLessThan(qualityGate.indexOf("bun run check"));
  expect(workflow).not.toContain("--clobber");
  const promote = workflow.slice(workflow.indexOf("\n  promote:"));
  expect(promote).not.toContain("build-release");
  expect(promote).not.toContain("build-candidate");
  expect(
    promote.indexOf(
      "Verify candidate Sigstore identity and GitHub attestation before mutation",
    ),
  ).toBeLessThan(promote.indexOf("Create an exact draft release"));
});

async function preparedCandidateDirectory(
  sourceCommit: string,
): Promise<string> {
  const output = await mkdtemp(join(tmpdir(), "takosumi-runtime-candidate-"));
  await buildRuntimeRelease(ROOT, sourceCommit, output);
  await writeFile(join(output, "release-manifest.sigstore.json"), "{}\n");
  const names = [
    "durable-workflow.mjs",
    "edge-worker.mjs",
    "release-manifest.json",
    "release-manifest.sigstore.json",
    "runtime-manifest.json",
    "runtime-sbom.spdx.json",
  ];
  const checksums = await Promise.all(
    names.map(async (name) => {
      const value = sha256(await readFile(join(output, name))).slice(7);
      return `${value}  ${name}`;
    }),
  );
  await writeFile(join(output, "SHA256SUMS"), `${checksums.join("\n")}\n`);
  return output;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
