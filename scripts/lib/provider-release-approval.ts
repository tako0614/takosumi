import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SigstoreBlobSignatureVerifier } from "../../core/adapters/takoform/signature.ts";

const DEFAULT_POLICY_PATH = fileURLToPath(
  new URL(
    "../../provider/release/trust/provider-publisher-policy.json",
    import.meta.url,
  ),
);
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const RUN_ID = /^[1-9][0-9]*$/u;
const MAX_AUTHORITY_BYTES = 4 << 20;

interface ProviderPublisherPolicy {
  readonly schemaVersion: 1;
  readonly kind: "takosumi.provider-release-sigstore-policy@v1";
  readonly bundleMediaType: "application/vnd.dev.sigstore.bundle.v0.3+json";
  readonly oidcIssuer: string;
  readonly sourceRepository: string;
  readonly workflow: string;
  readonly refPattern: string;
  readonly trustedRoot: {
    readonly path: string;
    readonly sha256: string;
  };
}

interface CandidateAsset {
  readonly name: string;
  readonly digest: string;
}

interface ProviderCandidateManifest {
  readonly kind: "takos.release-candidate-manifest@v1";
  readonly surfaceId: "takosumi-provider";
  readonly repository: "https://github.com/tako0614/takosumi.git";
  readonly sourceCommit: string;
  readonly version: string;
  readonly tag: string;
  readonly workflowRunId: string;
  readonly builtAt: string;
  readonly ociImages: readonly never[];
  readonly releaseAssets: readonly CandidateAsset[];
  readonly artifactDigests: readonly string[];
  readonly sbomDigests: readonly string[];
  readonly provenanceDigests: readonly string[];
  readonly configDigest: string;
  readonly policyDigest: string;
  readonly toolchainDigest: string;
}

export interface ProviderReleaseApproval {
  readonly schemaVersion: 1;
  readonly kind: "takosumi.provider-release-approval@v1";
  readonly version: string;
  readonly tag: string;
  readonly sourceCommit: string;
  readonly candidateManifestDigest: string;
  readonly releaseManifestDigest: string;
  readonly sigstoreBundleDigest: string;
  readonly policyDigest: string;
  readonly trustedRootDigest: string;
  readonly oidcIssuer: string;
  readonly certificateIdentity: string;
  readonly workflowRunId: string;
  readonly verifiedAt: string;
}

interface LoadedPolicy {
  readonly policy: ProviderPublisherPolicy;
  readonly policyDigest: string;
  readonly trustedRoot: Uint8Array;
  readonly trustedRootDigest: string;
}

export async function verifyProviderReleaseSignature(options: {
  readonly subjectPath: string;
  readonly bundlePath: string;
  readonly expectedTag: string;
  readonly policyPath?: string;
}): Promise<{
  readonly releaseManifestDigest: string;
  readonly sigstoreBundleDigest: string;
  readonly policyDigest: string;
  readonly trustedRootDigest: string;
  readonly oidcIssuer: string;
  readonly certificateIdentity: string;
}> {
  assertTag(options.expectedTag);
  const subject = await readRegularFile(
    options.subjectPath,
    MAX_AUTHORITY_BYTES,
  );
  const bundleBytes = await readRegularFile(
    options.bundlePath,
    MAX_AUTHORITY_BYTES,
  );
  const bundle = parseJson(bundleBytes, "provider Sigstore bundle");
  const loaded = await loadPolicy(options.policyPath ?? DEFAULT_POLICY_PATH);
  if (
    !bundle ||
    typeof bundle !== "object" ||
    Array.isArray(bundle) ||
    (bundle as Record<string, unknown>).mediaType !==
      loaded.policy.bundleMediaType
  ) {
    throw new Error("provider Sigstore bundle media type is not admitted");
  }
  const verifier = new SigstoreBlobSignatureVerifier({
    trustedRootDigest: loaded.trustedRootDigest as `sha256:${string}`,
    loadTrustedRoot: async () => loaded.trustedRoot,
    publishers: [
      {
        oidcIssuer: loaded.policy.oidcIssuer,
        sourceRepository: loaded.policy.sourceRepository,
        workflow: loaded.policy.workflow,
        refPattern: loaded.policy.refPattern,
      },
    ],
  });
  const publisher = await verifier.verify(subject, bundle);
  const expectedRef = `refs/tags/${options.expectedTag}`;
  const expectedIdentity = `https://github.com/${loaded.policy.sourceRepository}/${loaded.policy.workflow}@${expectedRef}`;
  if (
    publisher.ref !== expectedRef ||
    publisher.certificateIdentity !== expectedIdentity ||
    publisher.oidcIssuer !== loaded.policy.oidcIssuer
  ) {
    throw new Error(
      "provider Sigstore identity does not match the exact release tag",
    );
  }
  return {
    releaseManifestDigest: sha256(subject),
    sigstoreBundleDigest: sha256(bundleBytes),
    policyDigest: loaded.policyDigest,
    trustedRootDigest: loaded.trustedRootDigest,
    oidcIssuer: publisher.oidcIssuer,
    certificateIdentity: publisher.certificateIdentity,
  };
}

export async function finalizeProviderReleaseApproval(options: {
  readonly candidateManifestPath: string;
  readonly subjectPath: string;
  readonly bundlePath: string;
  readonly workflowRunId: string;
  readonly outputPath: string;
  readonly verifiedAt?: string;
  readonly policyPath?: string;
}): Promise<ProviderReleaseApproval> {
  if (!RUN_ID.test(options.workflowRunId)) {
    throw new Error("provider approval workflowRunId must be decimal");
  }
  const candidateBytes = await readRegularFile(
    options.candidateManifestPath,
    MAX_AUTHORITY_BYTES,
  );
  const candidate = parseJson(
    candidateBytes,
    "provider release candidate manifest",
  ) as ProviderCandidateManifest;
  assertCandidate(candidate);
  const signature = await verifyProviderReleaseSignature({
    subjectPath: options.subjectPath,
    bundlePath: options.bundlePath,
    expectedTag: candidate.tag,
    policyPath: options.policyPath,
  });
  const releaseAsset = candidate.releaseAssets.filter(
    ({ name }) => name === "release-manifest.json",
  );
  if (
    releaseAsset.length !== 1 ||
    releaseAsset[0]!.digest !== signature.releaseManifestDigest
  ) {
    throw new Error(
      "candidate does not bind the signed provider release manifest",
    );
  }
  const verifiedAt = options.verifiedAt ?? new Date().toISOString();
  assertTimestamp(verifiedAt);
  const approval: ProviderReleaseApproval = {
    schemaVersion: 1,
    kind: "takosumi.provider-release-approval@v1",
    version: candidate.version,
    tag: candidate.tag,
    sourceCommit: candidate.sourceCommit,
    candidateManifestDigest: sha256(candidateBytes),
    releaseManifestDigest: signature.releaseManifestDigest,
    sigstoreBundleDigest: signature.sigstoreBundleDigest,
    policyDigest: signature.policyDigest,
    trustedRootDigest: signature.trustedRootDigest,
    oidcIssuer: signature.oidcIssuer,
    certificateIdentity: signature.certificateIdentity,
    workflowRunId: options.workflowRunId,
    verifiedAt,
  };
  await writeExclusiveJson(options.outputPath, approval);
  return approval;
}

export async function verifyProviderReleaseApproval(options: {
  readonly approvalPath: string;
  readonly candidateManifestPath: string;
  readonly subjectPath: string;
  readonly bundlePath: string;
  readonly policyPath?: string;
}): Promise<ProviderReleaseApproval> {
  const approvalBytes = await readRegularFile(
    options.approvalPath,
    MAX_AUTHORITY_BYTES,
  );
  const approval = parseJson(
    approvalBytes,
    "provider release approval",
  ) as ProviderReleaseApproval;
  assertApproval(approval);
  const candidateBytes = await readRegularFile(
    options.candidateManifestPath,
    MAX_AUTHORITY_BYTES,
  );
  const candidate = parseJson(
    candidateBytes,
    "provider release candidate manifest",
  ) as ProviderCandidateManifest;
  assertCandidate(candidate);
  const signature = await verifyProviderReleaseSignature({
    subjectPath: options.subjectPath,
    bundlePath: options.bundlePath,
    expectedTag: candidate.tag,
    policyPath: options.policyPath,
  });
  const expected = {
    schemaVersion: 1,
    kind: "takosumi.provider-release-approval@v1",
    version: candidate.version,
    tag: candidate.tag,
    sourceCommit: candidate.sourceCommit,
    candidateManifestDigest: sha256(candidateBytes),
    releaseManifestDigest: signature.releaseManifestDigest,
    sigstoreBundleDigest: signature.sigstoreBundleDigest,
    policyDigest: signature.policyDigest,
    trustedRootDigest: signature.trustedRootDigest,
    oidcIssuer: signature.oidcIssuer,
    certificateIdentity: signature.certificateIdentity,
    workflowRunId: approval.workflowRunId,
    verifiedAt: approval.verifiedAt,
  } satisfies ProviderReleaseApproval;
  if (stableJson(approval) !== stableJson(expected)) {
    throw new Error(
      "provider release approval does not match retained authority",
    );
  }
  return approval;
}

async function loadPolicy(path: string): Promise<LoadedPolicy> {
  if (!isAbsolute(path)) {
    throw new Error("provider publisher policy path must be absolute");
  }
  const resolved = resolve(path);
  const bytes = await readRegularFile(resolved, MAX_AUTHORITY_BYTES);
  const sidecar = new TextDecoder().decode(
    await readRegularFile(`${resolved}.sha256`, 512),
  );
  const digest = sha256(bytes);
  if (sidecar !== `${digest.slice(7)}  ${basename(resolved)}\n`) {
    throw new Error("provider publisher policy sidecar mismatch");
  }
  const policy = parseJson(
    bytes,
    "provider publisher policy",
  ) as ProviderPublisherPolicy;
  assertPolicy(policy);
  const trustedRootPath = join(dirname(resolved), policy.trustedRoot.path);
  if (basename(trustedRootPath) !== policy.trustedRoot.path) {
    throw new Error("provider trusted root path must be a local basename");
  }
  const trustedRoot = await readRegularFile(
    trustedRootPath,
    MAX_AUTHORITY_BYTES,
  );
  const trustedRootDigest = sha256(trustedRoot);
  if (trustedRootDigest !== `sha256:${policy.trustedRoot.sha256}`) {
    throw new Error("provider Sigstore TrustedRoot digest mismatch");
  }
  const trustedRootSidecar = new TextDecoder().decode(
    await readRegularFile(`${trustedRootPath}.sha256`, 512),
  );
  if (
    trustedRootSidecar !==
    `${policy.trustedRoot.sha256}  ${policy.trustedRoot.path}\n`
  ) {
    throw new Error("provider Sigstore TrustedRoot sidecar mismatch");
  }
  return {
    policy,
    policyDigest: digest,
    trustedRoot,
    trustedRootDigest,
  };
}

function assertPolicy(value: ProviderPublisherPolicy): void {
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "bundleMediaType",
    "oidcIssuer",
    "sourceRepository",
    "workflow",
    "refPattern",
    "trustedRoot",
  ]);
  assertExactKeys(value.trustedRoot, ["path", "sha256"]);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "takosumi.provider-release-sigstore-policy@v1" ||
    value.bundleMediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json" ||
    value.oidcIssuer !== "https://token.actions.githubusercontent.com" ||
    value.sourceRepository !== "tako0614/takosumi" ||
    value.workflow !== ".github/workflows/provider-release.yml" ||
    value.refPattern !== "refs/tags/provider/v*" ||
    value.trustedRoot.path !== "sigstore-trusted-root.json" ||
    !/^[0-9a-f]{64}$/u.test(value.trustedRoot.sha256)
  ) {
    throw new Error("provider publisher policy drifted");
  }
}

function assertCandidate(value: ProviderCandidateManifest): void {
  assertExactKeys(value, [
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
    value.kind !== "takos.release-candidate-manifest@v1" ||
    value.surfaceId !== "takosumi-provider" ||
    value.repository !== "https://github.com/tako0614/takosumi.git" ||
    !COMMIT.test(value.sourceCommit) ||
    !VERSION.test(value.version) ||
    value.tag !== `provider/v${value.version}` ||
    !RUN_ID.test(value.workflowRunId) ||
    !Array.isArray(value.ociImages) ||
    value.ociImages.length !== 0 ||
    !Array.isArray(value.releaseAssets)
  ) {
    throw new Error("invalid provider candidate identity");
  }
  const names = value.releaseAssets.map(({ name }) => name);
  if (
    names.filter((name) => name === "release-manifest.json").length !== 1 ||
    new Set(names).size !== names.length ||
    value.releaseAssets.some((asset) => {
      assertExactKeys(asset, ["name", "digest"]);
      return (
        !/^[A-Za-z0-9][A-Za-z0-9._-]+$/u.test(asset.name) ||
        !SHA256.test(asset.digest)
      );
    })
  ) {
    throw new Error("invalid provider candidate release assets");
  }
  assertTimestamp(value.builtAt);
  const releaseDigests = value.releaseAssets.map(({ digest }) => digest);
  if (
    JSON.stringify(value.artifactDigests) !== JSON.stringify(releaseDigests) ||
    !validDigestArray(value.sbomDigests) ||
    !validDigestArray(value.provenanceDigests) ||
    ![value.configDigest, value.policyDigest, value.toolchainDigest].every(
      (entry) => SHA256.test(entry),
    )
  ) {
    throw new Error("invalid provider candidate digest closure");
  }
}

function validDigestArray(value: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every((entry) => SHA256.test(entry))
  );
}

function assertApproval(value: ProviderReleaseApproval): void {
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "version",
    "tag",
    "sourceCommit",
    "candidateManifestDigest",
    "releaseManifestDigest",
    "sigstoreBundleDigest",
    "policyDigest",
    "trustedRootDigest",
    "oidcIssuer",
    "certificateIdentity",
    "workflowRunId",
    "verifiedAt",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "takosumi.provider-release-approval@v1" ||
    !VERSION.test(value.version) ||
    value.tag !== `provider/v${value.version}` ||
    !COMMIT.test(value.sourceCommit) ||
    !RUN_ID.test(value.workflowRunId) ||
    ![
      value.candidateManifestDigest,
      value.releaseManifestDigest,
      value.sigstoreBundleDigest,
      value.policyDigest,
      value.trustedRootDigest,
    ].every((digest) => SHA256.test(digest))
  ) {
    throw new Error("invalid provider release approval identity");
  }
  assertTimestamp(value.verifiedAt);
}

function assertTag(value: string): void {
  if (!/^provider\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error("provider release tag is invalid");
  }
}

function assertTimestamp(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("provider approval timestamp is invalid");
  }
}

function assertExactKeys(value: unknown, expected: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("provider release authority must be an object");
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error("provider release authority fields mismatch");
  }
}

async function readRegularFile(
  path: string,
  limit: number,
): Promise<Uint8Array> {
  if (!isAbsolute(path)) throw new Error("authority path must be absolute");
  const resolved = resolve(path);
  const status = await lstat(resolved);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.size <= 0 ||
    status.size > limit
  ) {
    throw new Error(
      `provider release authority is not a bounded regular file: ${resolved}`,
    );
  }
  if ((await realpath(resolved)) !== resolved) {
    throw new Error("provider release authority path must be canonical");
  }
  return readFile(resolved);
}

async function writeExclusiveJson(
  path: string,
  value: ProviderReleaseApproval,
): Promise<void> {
  if (!isAbsolute(path)) {
    throw new Error("provider approval output path must be absolute");
  }
  const resolved = resolve(path);
  const parentPath = dirname(resolved);
  const parent = await lstat(parentPath);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error("provider approval parent must be a real directory");
  }
  if ((await realpath(parentPath)) !== parentPath) {
    throw new Error("provider approval parent path must be canonical");
  }
  await writeFile(resolved, `${stableJson(value)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("provider release authority is not JSON serializable");
  }
  return encoded;
}
