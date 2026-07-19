#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  constants,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { verifyProviderReleaseBundle } from "./lib/provider-release.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPOSITORY = "https://github.com/tako0614/takosumi.git";
const MAX_FILE_BYTES = 64 << 20;
const GENERATED_RELEASE_ASSETS = new Set([
  "provider-release-approval.json",
  "release-candidate-manifest.json",
  "release-manifest.sigstore.json",
  "release-safety-readback.json",
]);

if (import.meta.main) {
  const code = await main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  });
  process.exit(code);
}

export async function main(argv) {
  const command = argv[0];
  const options = parseOptions(argv.slice(1));
  if (command === "prepare") {
    requireOnly(options, ["bundle", "output", "workflow-run-id", "built-at"]);
    const result = await prepareProviderReleaseCandidate({
      bundleRoot: required(options, "bundle"),
      outputRoot: required(options, "output"),
      workflowRunId: required(options, "workflow-run-id"),
      builtAt: required(options, "built-at"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  if (command === "verify") {
    requireOnly(options, ["candidate"]);
    const result = await verifyProviderReleaseCandidate({
      candidateRoot: required(options, "candidate"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  throw new Error(
    "usage: bun scripts/provider-release-candidate.mjs <prepare|verify> [options]",
  );
}

export async function prepareProviderReleaseCandidate({
  bundleRoot,
  outputRoot,
  workflowRunId,
  builtAt,
}) {
  assertRunId(workflowRunId);
  assertTimestamp(builtAt);
  const sourceRoot = resolve(bundleRoot);
  const destination = resolve(outputRoot);
  await assertRealDirectory(sourceRoot, "provider bundle");
  const parent = dirname(destination);
  await assertRealDirectory(parent, "provider candidate parent");
  await mkdir(destination, { mode: 0o700 });
  let prepared = false;
  try {
    const verification = await verifyProviderReleaseBundle({
      bundleRoot: sourceRoot,
    });
    const releaseManifest = JSON.parse(
      await readFile(join(sourceRoot, "release-manifest.json"), "utf8"),
    );
    if (
      verification.releaseEligibility !== "candidate-review-required" ||
      releaseManifest.tagVerification?.kind !== "signed-annotated"
    ) {
      throw new Error(
        "provider candidate requires a verified signed tag bundle",
      );
    }
    const paths = expectedBundlePaths(releaseManifest);
    const flatNames = paths.map((path) => basename(path));
    if (new Set(flatNames).size !== flatNames.length) {
      throw new Error(
        "provider release bundle cannot be flattened without collision",
      );
    }
    const releaseAssets = [];
    for (const [index, path] of paths.entries()) {
      const source = join(sourceRoot, path);
      const bytes = await readBoundedRegularFile(source);
      const name = flatNames[index];
      await copyFile(source, join(destination, name), constants.COPYFILE_EXCL);
      releaseAssets.push({ name, digest: sha256(bytes) });
    }
    const candidate = buildCandidateManifest({
      releaseManifest,
      releaseAssets,
      workflowRunId,
      builtAt,
    });
    await writeFile(
      join(destination, "release-candidate-manifest.json"),
      `${JSON.stringify(candidate, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    prepared = true;
    return {
      kind: "takosumi.provider-release-candidate-preparation@v1",
      candidateRoot: destination,
      candidate,
      manifestDigest: sha256(
        await readFile(join(destination, "release-candidate-manifest.json")),
      ),
    };
  } finally {
    if (!prepared) await rm(destination, { recursive: true, force: true });
  }
}

export async function verifyProviderReleaseCandidate({ candidateRoot }) {
  const root = resolve(candidateRoot);
  await assertRealDirectory(root, "provider candidate");
  const manifestBytes = await readBoundedRegularFile(
    join(root, "release-candidate-manifest.json"),
  );
  const candidate = JSON.parse(new TextDecoder().decode(manifestBytes));
  assertCandidate(candidate);
  const expectedFiles = [
    "release-candidate-manifest.json",
    ...candidate.releaseAssets.map(({ name }) => name),
  ].sort();
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("provider candidate contains a non-regular entry");
  }
  const actualFiles = entries.map(({ name }) => name).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("provider candidate exact file inventory mismatch");
  }
  for (const asset of candidate.releaseAssets) {
    const bytes = await readBoundedRegularFile(join(root, asset.name));
    if (sha256(bytes) !== asset.digest) {
      throw new Error(
        `provider candidate asset digest mismatch: ${asset.name}`,
      );
    }
  }

  const releaseManifest = JSON.parse(
    await readFile(join(root, "release-manifest.json"), "utf8"),
  );
  const paths = expectedBundlePaths(releaseManifest);
  if (
    JSON.stringify(paths.map((path) => basename(path))) !==
    JSON.stringify(candidate.releaseAssets.map(({ name }) => name))
  ) {
    throw new Error("provider candidate release asset order drifted");
  }
  const reconstructed = await mkdtemp(
    join(tmpdir(), "takosumi-provider-reconstructed-"),
  );
  await chmod(reconstructed, 0o700);
  try {
    for (const path of paths) {
      const target = join(reconstructed, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(
        join(root, basename(path)),
        target,
        constants.COPYFILE_EXCL,
      );
    }
    const verification = await verifyProviderReleaseBundle({
      bundleRoot: reconstructed,
    });
    const expected = buildCandidateManifest({
      releaseManifest,
      releaseAssets: candidate.releaseAssets,
      workflowRunId: candidate.workflowRunId,
      builtAt: candidate.builtAt,
    });
    if (JSON.stringify(candidate) !== JSON.stringify(expected)) {
      throw new Error("provider candidate authority fields drifted");
    }
    return {
      kind: "takosumi.provider-release-candidate-verification@v1",
      version: candidate.version,
      tag: candidate.tag,
      sourceCommit: candidate.sourceCommit,
      manifestDigest: sha256(manifestBytes),
      artifactDigests: candidate.artifactDigests,
      releaseManifestDigest: verification.manifestDigest,
    };
  } finally {
    await rm(reconstructed, { recursive: true, force: true });
  }
}

function buildCandidateManifest({
  releaseManifest,
  releaseAssets,
  workflowRunId,
  builtAt,
}) {
  const byName = new Map(releaseAssets.map((asset) => [asset.name, asset]));
  const descriptorDigest = sha256FileSync(
    join(REPO_ROOT, "provider/release/version.json"),
  );
  const policyDigest = sha256FileSync(
    join(REPO_ROOT, "provider/release/compatibility/1.1.1-delta-policy.json"),
  );
  return {
    kind: "takos.release-candidate-manifest@v1",
    surfaceId: "takosumi-provider",
    repository: REPOSITORY,
    sourceCommit: releaseManifest.sourceCommit,
    version: releaseManifest.version,
    tag: releaseManifest.tag,
    workflowRunId,
    builtAt,
    ociImages: [],
    releaseAssets,
    artifactDigests: releaseAssets.map(({ digest }) => digest),
    sbomDigests: [requiredAsset(byName, "sbom.spdx.json").digest],
    provenanceDigests: [requiredAsset(byName, "provenance.intoto.json").digest],
    configDigest: descriptorDigest,
    policyDigest,
    toolchainDigest: sha256(
      Buffer.from(
        stableJson({
          toolchain: releaseManifest.toolchain,
          runtimeTrust: releaseManifest.runtimeTrust,
          build: releaseManifest.build,
        }),
      ),
    ),
  };
}

function expectedBundlePaths(manifest) {
  const paths = [
    "release-manifest.json",
    "release-manifest.json.sha256",
    ...manifest.supportArtifacts.map(({ path }) => path),
    manifest.mirror.derivedIndex.artifactPath,
    ...manifest.mirror.assets.map(({ artifactPath }) => artifactPath),
  ];
  for (const path of paths) assertSafeRelativePath(path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("provider release bundle contains duplicate paths");
  }
  return paths;
}

function assertCandidate(candidate) {
  assertExactKeys(candidate, [
    "kind",
    "surfaceId",
    "repository",
    "sourceCommit",
    "version",
    "tag",
    "workflowRunId",
    "builtAt",
    "ociImages",
    "releaseAssets",
    "artifactDigests",
    "sbomDigests",
    "provenanceDigests",
    "configDigest",
    "policyDigest",
    "toolchainDigest",
  ]);
  if (
    candidate.kind !== "takos.release-candidate-manifest@v1" ||
    candidate.surfaceId !== "takosumi-provider" ||
    candidate.repository !== REPOSITORY ||
    !/^[0-9a-f]{40}$/.test(candidate.sourceCommit) ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(candidate.version) ||
    candidate.tag !== `provider/v${candidate.version}` ||
    !Array.isArray(candidate.ociImages) ||
    candidate.ociImages.length !== 0 ||
    !Array.isArray(candidate.releaseAssets) ||
    candidate.releaseAssets.length === 0
  ) {
    throw new Error("invalid provider release candidate identity");
  }
  assertRunId(candidate.workflowRunId);
  assertTimestamp(candidate.builtAt);
  const names = candidate.releaseAssets.map(({ name }) => name);
  for (const asset of candidate.releaseAssets) {
    assertExactKeys(asset, ["name", "digest"]);
  }
  if (
    new Set(names).size !== names.length ||
    names.some((name) => GENERATED_RELEASE_ASSETS.has(name)) ||
    candidate.releaseAssets.some(
      ({ name, digest }) =>
        !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(name) || !isDigest(digest),
    )
  ) {
    throw new Error("invalid provider candidate release asset set");
  }
  if (
    JSON.stringify(candidate.artifactDigests) !==
      JSON.stringify(candidate.releaseAssets.map(({ digest }) => digest)) ||
    !validDigestArray(candidate.sbomDigests) ||
    !validDigestArray(candidate.provenanceDigests) ||
    ![
      candidate.configDigest,
      candidate.policyDigest,
      candidate.toolchainDigest,
    ].every(isDigest)
  ) {
    throw new Error("provider candidate digest closure is invalid");
  }
}

function validDigestArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every(isDigest)
  );
}

function assertExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("provider candidate authority must be an object");
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error("provider candidate authority fields mismatch");
  }
}

async function assertRealDirectory(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const resolved = resolve(path);
  const status = await lstat(resolved);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  if ((await realpath(resolved)) !== resolved) {
    throw new Error(`${label} path must be canonical`);
  }
}

async function readBoundedRegularFile(path) {
  if (!isAbsolute(path)) {
    throw new Error("provider candidate file path must be absolute");
  }
  const resolved = resolve(path);
  const status = await lstat(resolved);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.size <= 0 ||
    status.size > MAX_FILE_BYTES
  ) {
    throw new Error(`provider candidate file is invalid: ${resolved}`);
  }
  if ((await realpath(resolved)) !== resolved) {
    throw new Error("provider candidate file path must be canonical");
  }
  return readFile(resolved);
}

function assertSafeRelativePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\0") ||
    path
      .split(/[\\/]/u)
      .some((part) => part === "" || part === "." || part === "..") ||
    path.includes(`..${sep}`)
  ) {
    throw new Error(`unsafe provider release bundle path: ${String(path)}`);
  }
}

function requiredAsset(assets, name) {
  const asset = assets.get(name);
  if (!asset) throw new Error(`provider candidate omits ${name}`);
  return asset;
}

function sha256FileSync(path) {
  return sha256(readFileSync(path));
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isDigest(value) {
  return /^sha256:[0-9a-f]{64}$/.test(value ?? "");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("provider candidate value is not JSON serializable");
  }
  return encoded;
}

function assertRunId(value) {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) {
    throw new Error("provider candidate workflow run id must be decimal");
  }
}

function assertTimestamp(value) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value ?? "") ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("provider candidate builtAt must be exact UTC ISO-8601");
  }
}

function parseOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      !option?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(
        `invalid provider candidate option near ${option ?? "<end>"}`,
      );
    }
    const name = option.slice(2);
    if (options.has(name)) throw new Error(`duplicate option --${name}`);
    options.set(name, value);
  }
  return options;
}

function required(options, name) {
  const value = options.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function requireOnly(options, allowed) {
  for (const name of options.keys()) {
    if (!allowed.includes(name)) throw new Error(`unknown option --${name}`);
  }
}
