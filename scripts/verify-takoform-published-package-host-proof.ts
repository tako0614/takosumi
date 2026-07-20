#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  canonicalJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from "../core/adapters/takoform/canonical_json.ts";
import {
  TAKOFORM_PACKAGE_ENVELOPE_MEDIA_TYPE,
  TakoformDataOnlyPackageVerifier,
} from "../core/adapters/takoform/package_verifier.ts";
import {
  SigstoreTakoformPackageSignatureVerifier,
  type TakoformPublisherPolicy,
} from "../core/adapters/takoform/signature.ts";
import {
  FormRegistryService,
  InMemoryFormRegistryStore,
} from "../core/domains/service-forms/mod.ts";

const HOST_PROOF_PINS_PATH = fileURLToPath(
  new URL(
    "../core/conformance/takoform-published-package-host-proof-v1.json",
    import.meta.url,
  ),
);
const MAX_METADATA_BYTES = 4 << 20;
const MAX_ARCHIVE_BYTES = 32 << 20;
const MAX_PAYLOAD_BYTES = 16 << 20;
const MAX_ARCHIVE_ENTRIES = 1_024;
const MAX_EXPANDED_ARCHIVE_BYTES = 64 << 20;
const PROCESS_TIMEOUT_MS = 15_000;
const MAX_STDERR_BYTES = 64 << 10;
export const REVIEWED_TAKOFORM_PACKAGE_KINDS = [
  "ContainerService",
  "DurableWorkflow",
  "EdgeWorker",
  "KVStore",
  "ObjectBucket",
  "Queue",
  "SQLDatabase",
  "Schedule",
  "StatefulActorNamespace",
  "VectorIndex",
] as const;

interface PublishedPackageSet {
  readonly format: "takoform.published-package-set@v1";
  readonly repository: string;
  readonly packageVersion: string;
  readonly definitionVersion: string;
  readonly publicationStatus: "published-immutable";
  readonly admissionStatus: "external-required";
  readonly revocationCheckpointStatus: "external-required" | "published";
  readonly trust: { readonly path: string; readonly digest: string };
  readonly entries: readonly PublishedPackageEntry[];
}

interface HostProofPins {
  readonly format: "takosumi.takoform-published-package-host-proof-pins@v1";
  readonly checkoutCommit: string;
  readonly repository: string;
  readonly packageVersion: string;
  readonly definitionVersion: string;
  readonly releaseCommit: string;
  readonly publishedSet: PinnedArtifact;
  readonly publishedTrust: PinnedArtifact;
  readonly trustedRoot: PinnedArtifact;
  readonly packageIndexPolicy: PinnedArtifact;
}

interface PinnedArtifact {
  readonly path: string;
  readonly digest: string;
}

interface PublishedPackageEntry {
  readonly kind: string;
  readonly immutable: true;
  readonly packageDigest: string;
  readonly formRef: FormRef;
  readonly checksumsPath: string;
  readonly checksumsDigest: string;
  readonly packageReleaseManifestPath: string;
  readonly packageReleaseManifestDigest: string;
  readonly packageIndexPath: string;
  readonly packageIndexSigstoreBundle: string;
  readonly releaseCommit: string;
  readonly releaseTag: string;
}

interface FormRef {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: string;
}

export interface ReviewedPublishedPackageInstallArtifact {
  readonly kind: string;
  readonly releaseTag: string;
  readonly packageDigest: string;
  readonly formRef: FormRef;
  readonly envelopeBytes: Uint8Array;
}

export interface ReviewedPublishedPackageInstallSet {
  readonly format: "takosumi.reviewed-takoform-package-install-set@v1";
  readonly repository: string;
  readonly checkoutCommit: string;
  readonly releaseCommit: string;
  readonly packageVersion: string;
  readonly definitionVersion: string;
  readonly publishedSet: PinnedArtifact;
  readonly publishedTrust: PinnedArtifact;
  readonly packageIndexPolicy: PinnedArtifact;
  readonly trustedRoot: PinnedArtifact & { readonly bytes: Uint8Array };
  readonly publisher: TakoformPublisherPolicy;
  readonly verifierId: string;
  readonly packages: readonly ReviewedPublishedPackageInstallArtifact[];
}

interface PublishedPackageTrust {
  readonly format: "takoform.published-package-trust@v1";
  readonly trustedRoot: { readonly path: string; readonly digest: string };
  readonly packageIndexPolicy: {
    readonly path: string;
    readonly digest: string;
  };
  readonly unsettledPublisherRoles: readonly string[];
}

interface PackageIndexPolicy {
  readonly format: "takoform.sigstore-publisher-policy@v1";
  readonly oidcIssuer: string;
  readonly certificateIdentity: string;
  readonly bundleMediaType: string;
}

interface PackageReleaseManifest {
  readonly releaseType: "form-package";
  readonly tag: string;
  readonly sourceCommit: string;
  readonly packageDigest: string;
  readonly formRef: FormRef;
  readonly signedSubject: string;
  readonly signatureBundle: string;
  readonly publicationReady: true;
  readonly publicationBlockers: readonly unknown[];
  readonly assets: readonly {
    readonly name: string;
    readonly mediaType: string;
    readonly size: number;
    readonly digest: string;
  }[];
}

interface PackageIndex {
  readonly formRef: FormRef;
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
    readonly digest: string;
  }[];
}

export interface PublishedPackageHostProofResult {
  readonly kind: "takosumi.takoform-published-package-host-proof@v1";
  readonly status: "passed";
  readonly evidenceLevel: "repo_regression";
  readonly packageCount: number;
  readonly kinds: readonly string[];
  readonly releaseCommits: readonly string[];
  readonly packageVersion: string;
  readonly definitionVersion: string;
  readonly publishedSetDigest: string;
  readonly verifierId: string;
  readonly transparencyTamperRejection: "passed";
  readonly installReplay: "passed";
  readonly serviceReconstructionReverification: "passed";
  readonly admissionStatus: "external-required";
  readonly unsettledPublisherRoles: readonly string[];
  readonly revocationCheckpointStatus: "external-required" | "published";
}

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  });
  process.exit(exitCode);
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseOptions(argv);
  const result = await verifyPublishedPackageHostProof(options.takoformRoot);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `Takoform published package host proof passed (${result.packageCount} packages; admission=${result.admissionStatus}).`,
    );
  }
  return 0;
}

export async function verifyPublishedPackageHostProof(
  takoformRoot: string,
): Promise<PublishedPackageHostProofResult> {
  const context = await loadReviewedPublishedPackageContext(takoformRoot);
  const {
    pins,
    retained,
    publishedSetBytes,
    publishedSet,
    trust,
    trustedRootPath,
    trustedRootBytes,
    publisher,
  } = context;
  const createSignatureVerifier = (rootBytes: Uint8Array) =>
    new SigstoreTakoformPackageSignatureVerifier({
      trustedRootDigest: trust.trustedRoot.digest as `sha256:${string}`,
      loadTrustedRoot: async () => rootBytes,
      publishers: [publisher],
    });
  const signatureVerifier = createSignatureVerifier(trustedRootBytes);
  const verifier = new TakoformDataOnlyPackageVerifier(signatureVerifier);
  const artifacts = new Map<string, Uint8Array>();
  const store = new InMemoryFormRegistryStore();
  const registry = new FormRegistryService({
    store,
    artifactReader: {
      read: async (artifactRef) => {
        const bytes = artifacts.get(artifactRef);
        if (!bytes) throw new Error("retained package artifact is unavailable");
        return bytes;
      },
    },
    verifier,
    now: () => "2026-07-19T00:00:00.000Z",
  });

  const prepared = await buildReviewedPublishedPackageInstallSet(context);
  for (const [position, entry] of prepared.packages.entries()) {
    const envelope = entry.envelopeBytes;
    if (position === 0) {
      await assertTransparencyTamperRejected(signatureVerifier, envelope);
    }
    const artifactRef = `retained:takoform/${entry.kind}/${prepared.packageVersion}`;
    artifacts.set(artifactRef, envelope);
    const installed = await registry.installPackage({
      artifactRef,
      expectedPackageDigest: entry.packageDigest,
      actorId: "operator:published-package-host-proof",
    });
    if (
      installed.packageDigest !== entry.packageDigest ||
      !sameJson(installed.definitionRefs, [entry.formRef])
    ) {
      throw new Error(`${entry.kind} installed identity drifted`);
    }
  }

  // Re-read trust bytes and construct fresh verifier/service objects. This is
  // deliberately repo-regression evidence, not a durable substrate restart.
  const reconstructedTrustedRoot = await retained.read(trustedRootPath);
  assertDigest(
    reconstructedTrustedRoot,
    pins.trustedRoot.digest,
    "reconstructed TrustedRoot",
  );
  const reconstructedVerifier = new TakoformDataOnlyPackageVerifier(
    createSignatureVerifier(reconstructedTrustedRoot),
  );
  const reconstructed = new FormRegistryService({
    store,
    artifactReader: {
      read: async (artifactRef) => {
        const bytes = artifacts.get(artifactRef);
        if (!bytes) throw new Error("retained package artifact is unavailable");
        return bytes;
      },
    },
    verifier: reconstructedVerifier,
    now: () => "2026-07-19T00:00:00.000Z",
  });
  for (const entry of prepared.packages) {
    const identity = {
      formRef: entry.formRef,
      packageDigest: entry.packageDigest,
    };
    await reconstructed.getRetainedIdentity(identity);
    await reconstructed.verifyRetainedIdentity(identity);
    await reconstructed.installPackage({
      artifactRef: `retained:takoform/${entry.kind}/${prepared.packageVersion}`,
      expectedPackageDigest: entry.packageDigest,
      actorId: "operator:published-package-host-proof",
    });
  }

  return {
    kind: "takosumi.takoform-published-package-host-proof@v1",
    status: "passed",
    evidenceLevel: "repo_regression",
    packageCount: publishedSet.entries.length,
    kinds: publishedSet.entries.map(({ kind }) => kind).sort(),
    releaseCommits: [
      ...new Set(
        publishedSet.entries.map(({ releaseCommit }) => releaseCommit),
      ),
    ].sort(),
    packageVersion: publishedSet.packageVersion,
    definitionVersion: publishedSet.definitionVersion,
    publishedSetDigest: sha256(publishedSetBytes),
    verifierId: verifier.id,
    transparencyTamperRejection: "passed",
    installReplay: "passed",
    serviceReconstructionReverification: "passed",
    admissionStatus: publishedSet.admissionStatus,
    unsettledPublisherRoles: [...trust.unsettledPublisherRoles].sort(),
    revocationCheckpointStatus: publishedSet.revocationCheckpointStatus,
  };
}

interface ReviewedPublishedPackageContext {
  readonly pins: HostProofPins;
  readonly retained: RetainedRoot;
  readonly publishedSetBytes: Uint8Array;
  readonly publishedSet: PublishedPackageSet;
  readonly trust: PublishedPackageTrust;
  readonly trustedRootPath: string;
  readonly trustedRootBytes: Uint8Array;
  readonly publisher: TakoformPublisherPolicy;
}

export async function loadReviewedPublishedPackageInstallSet(
  takoformRoot: string,
): Promise<ReviewedPublishedPackageInstallSet> {
  return await buildReviewedPublishedPackageInstallSet(
    await loadReviewedPublishedPackageContext(takoformRoot),
  );
}

async function loadReviewedPublishedPackageContext(
  takoformRoot: string,
): Promise<ReviewedPublishedPackageContext> {
  const pins = await loadHostProofPins();
  const retained = await RetainedRoot.open(takoformRoot);
  await retained.assertCleanCheckout(pins.checkoutCommit);
  const publishedSetBytes = await retained.read(pins.publishedSet.path);
  assertDigest(
    publishedSetBytes,
    pins.publishedSet.digest,
    "pinned published set",
  );
  const publishedSet = parseJson<PublishedPackageSet>(publishedSetBytes);
  assertPublishedSet(publishedSet, pins);

  const publishedTrustPath = `admission/v1/${publishedSet.trust.path}`;
  if (
    publishedTrustPath !== pins.publishedTrust.path ||
    publishedSet.trust.digest !== pins.publishedTrust.digest
  ) {
    throw new Error("published trust differs from Takosumi's reviewed pin");
  }
  const trustBytes = await retained.read(publishedTrustPath);
  assertDigest(trustBytes, publishedSet.trust.digest, "published trust");
  const trust = parseJson<PublishedPackageTrust>(trustBytes);
  if (trust.format !== "takoform.published-package-trust@v1") {
    throw new Error("unsupported published package trust format");
  }

  const trustedRootPath = `admission/v1/${trust.trustedRoot.path}`;
  if (
    trustedRootPath !== pins.trustedRoot.path ||
    trust.trustedRoot.digest !== pins.trustedRoot.digest
  ) {
    throw new Error("TrustedRoot differs from Takosumi's reviewed pin");
  }
  const trustedRootBytes = await retained.read(trustedRootPath);
  assertDigest(trustedRootBytes, trust.trustedRoot.digest, "TrustedRoot");
  const packageIndexPolicyPath = `admission/v1/${trust.packageIndexPolicy.path}`;
  if (
    packageIndexPolicyPath !== pins.packageIndexPolicy.path ||
    trust.packageIndexPolicy.digest !== pins.packageIndexPolicy.digest
  ) {
    throw new Error(
      "package index policy differs from Takosumi's reviewed pin",
    );
  }
  const policyBytes = await retained.read(packageIndexPolicyPath);
  assertDigest(
    policyBytes,
    trust.packageIndexPolicy.digest,
    "package index policy",
  );
  const packagePolicy = parseJson<PackageIndexPolicy>(policyBytes);
  return {
    pins,
    retained,
    publishedSetBytes,
    publishedSet,
    trust,
    trustedRootPath,
    trustedRootBytes,
    publisher: parsePublisherIdentity(packagePolicy, publishedSet.repository),
  };
}

async function buildReviewedPublishedPackageInstallSet(
  context: ReviewedPublishedPackageContext,
): Promise<ReviewedPublishedPackageInstallSet> {
  const { pins, retained, publishedSet, trust, trustedRootBytes, publisher } =
    context;
  const verifier = new TakoformDataOnlyPackageVerifier(
    new SigstoreTakoformPackageSignatureVerifier({
      trustedRootDigest: trust.trustedRoot.digest as `sha256:${string}`,
      loadTrustedRoot: async () => trustedRootBytes,
      publishers: [publisher],
    }),
  );
  const packages: ReviewedPublishedPackageInstallArtifact[] = [];
  for (const entry of [...publishedSet.entries].sort((left, right) =>
    left.kind.localeCompare(right.kind),
  )) {
    const envelopeBytes = await buildInstallEnvelope(retained, entry);
    const verified = await verifier.verify(envelopeBytes, entry.packageDigest);
    if (
      verified.packageDigest !== entry.packageDigest ||
      !sameJson(
        verified.definitions.map(({ formRef }) => formRef),
        [entry.formRef],
      )
    ) {
      throw new Error(`${entry.kind} verified identity drifted`);
    }
    packages.push({
      kind: entry.kind,
      releaseTag: entry.releaseTag,
      packageDigest: entry.packageDigest,
      formRef: entry.formRef,
      envelopeBytes,
    });
  }
  return {
    format: "takosumi.reviewed-takoform-package-install-set@v1",
    repository: pins.repository,
    checkoutCommit: pins.checkoutCommit,
    releaseCommit: pins.releaseCommit,
    packageVersion: pins.packageVersion,
    definitionVersion: pins.definitionVersion,
    publishedSet: pins.publishedSet,
    publishedTrust: pins.publishedTrust,
    packageIndexPolicy: pins.packageIndexPolicy,
    trustedRoot: { ...pins.trustedRoot, bytes: trustedRootBytes },
    publisher,
    verifierId: verifier.id,
    packages,
  };
}

async function assertTransparencyTamperRejected(
  verifier: SigstoreTakoformPackageSignatureVerifier,
  envelopeBytes: Uint8Array,
): Promise<void> {
  const envelope = parseJson<{
    readonly packageIndexBase64: string;
    readonly sigstoreBundle: Record<string, unknown>;
  }>(envelopeBytes);
  const packageIndex = Buffer.from(envelope.packageIndexBase64, "base64");
  for (const path of [
    [
      "verificationMaterial",
      "tlogEntries",
      0,
      "inclusionPromise",
      "signedEntryTimestamp",
    ],
    ["verificationMaterial", "tlogEntries", 0, "inclusionProof", "rootHash"],
  ] as const) {
    const tampered = structuredClone(envelope.sigstoreBundle);
    const encoded = getNestedString(tampered, path);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength === 0) throw new Error("empty transparency evidence");
    bytes[bytes.byteLength - 1] = bytes[bytes.byteLength - 1]! ^ 1;
    setNestedString(tampered, path, bytes.toString("base64"));
    let rejected = false;
    try {
      await verifier.verify(packageIndex, tampered);
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error(`transparency tamper was accepted at ${path.join(".")}`);
    }
  }
}

function getNestedString(
  value: Record<string, unknown>,
  path: readonly (string | number)[],
): string {
  const result = getNested(value, path);
  if (typeof result !== "string")
    throw new Error("evidence path is not a string");
  return result;
}

function setNestedString(
  value: Record<string, unknown>,
  path: readonly (string | number)[],
  replacement: string,
): void {
  const parent = getNested(value, path.slice(0, -1));
  const key = path[path.length - 1];
  if (typeof parent !== "object" || parent === null || key === undefined) {
    throw new Error("evidence path has no parent");
  }
  (parent as Record<string | number, unknown>)[key] = replacement;
}

function getNested(
  value: unknown,
  path: readonly (string | number)[],
): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) {
      throw new Error("evidence path is missing");
    }
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

async function buildInstallEnvelope(
  retained: RetainedRoot,
  entry: PublishedPackageEntry,
): Promise<Uint8Array> {
  const manifestBytes = await retained.read(
    `admission/v1/${entry.packageReleaseManifestPath}`,
  );
  assertDigest(
    manifestBytes,
    entry.packageReleaseManifestDigest,
    `${entry.kind} release manifest`,
  );
  const manifest = parseJson<PackageReleaseManifest>(manifestBytes);
  if (
    manifest.releaseType !== "form-package" ||
    manifest.publicationReady !== true ||
    manifest.publicationBlockers.length !== 0 ||
    manifest.tag !== entry.releaseTag ||
    manifest.sourceCommit !== entry.releaseCommit ||
    manifest.packageDigest !== entry.packageDigest ||
    !sameJson(manifest.formRef, entry.formRef)
  ) {
    throw new Error(`${entry.kind} release manifest does not match its root`);
  }

  const checksumsBytes = await retained.read(
    `admission/v1/${entry.checksumsPath}`,
  );
  assertDigest(
    checksumsBytes,
    entry.checksumsDigest,
    `${entry.kind} checksums`,
  );
  const checksums = parseChecksums(new TextDecoder().decode(checksumsBytes));
  const releaseDirectory = dirname(entry.packageReleaseManifestPath);
  if (checksums.get("release-manifest.json") !== sha256Hex(manifestBytes)) {
    throw new Error(
      `${entry.kind} checksums do not bind release-manifest.json`,
    );
  }

  for (const asset of manifest.assets) {
    const bytes = await retained.read(
      `admission/v1/${releaseDirectory}/${asset.name}`,
      asset.mediaType === "application/gzip"
        ? MAX_ARCHIVE_BYTES
        : MAX_METADATA_BYTES,
    );
    if (
      bytes.byteLength !== asset.size ||
      sha256(bytes) !== asset.digest ||
      checksums.get(asset.name) !== sha256Hex(bytes)
    ) {
      throw new Error(`${entry.kind} release asset ${asset.name} drifted`);
    }
  }
  if (checksums.size !== manifest.assets.length + 1) {
    throw new Error(`${entry.kind} checksums contain an unexpected asset`);
  }

  const indexBytes = await retained.read(
    `admission/v1/${entry.packageIndexPath}`,
  );
  assertDigest(indexBytes, entry.packageDigest, `${entry.kind} package index`);
  const index = parseJson<PackageIndex>(indexBytes);
  if (!sameJson(index.formRef, entry.formRef)) {
    throw new Error(`${entry.kind} package index FormRef drifted`);
  }
  const bundleBytes = await retained.read(
    `admission/v1/${entry.packageIndexSigstoreBundle}`,
  );
  const bundle = parseCanonicalJson(bundleBytes);

  const archiveAsset = manifest.assets.find(
    ({ mediaType }) => mediaType === "application/gzip",
  );
  if (!archiveAsset)
    throw new Error(`${entry.kind} package archive is missing`);
  const archivePath = await retained.path(
    `admission/v1/${releaseDirectory}/${archiveAsset.name}`,
  );
  const archiveEntries = await listTarEntries(archivePath);
  const archiveEntriesByPath = new Map(
    archiveEntries.map((archiveEntry) => [archiveEntry.path, archiveEntry]),
  );
  const expectedArchiveEntries = [
    { path: "package-index.json", size: indexBytes.byteLength },
    ...index.files.map(({ path, size }) => ({ path, size })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  if (
    !sameJson(
      archiveEntries.map(({ path, size }) => ({ path, size })),
      expectedArchiveEntries,
    )
  ) {
    throw new Error(`${entry.kind} archive payload closure drifted`);
  }
  const archivedIndex = await readTarPath(archivePath, "package-index.json");
  if (!Buffer.from(archivedIndex).equals(Buffer.from(indexBytes))) {
    throw new Error(
      `${entry.kind} archive package index differs from signed asset`,
    );
  }
  const files = [];
  for (const file of index.files) {
    const archiveEntry = archiveEntriesByPath.get(file.path);
    if (!archiveEntry) {
      throw new Error(`${entry.kind} package payload ${file.path} is missing`);
    }
    const content = await readTarPath(archivePath, file.path);
    if (content.byteLength !== file.size || sha256(content) !== file.digest) {
      throw new Error(`${entry.kind} package payload ${file.path} drifted`);
    }
    files.push({
      path: file.path,
      mode: archiveEntry.mode,
      contentBase64: Buffer.from(content).toString("base64"),
    });
  }
  return canonicalJsonBytes({
    mediaType: TAKOFORM_PACKAGE_ENVELOPE_MEDIA_TYPE,
    packageIndexBase64: Buffer.from(indexBytes).toString("base64"),
    files,
    sigstoreBundle: bundle,
  } as CanonicalJsonValue);
}

export function parsePublisherIdentity(
  policy: PackageIndexPolicy,
  repository: string,
): TakoformPublisherPolicy {
  if (
    policy.format !== "takoform.sigstore-publisher-policy@v1" ||
    policy.bundleMediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json"
  ) {
    throw new Error("unsupported package index publisher policy");
  }
  const prefix = `https://github.com/${repository}/`;
  if (!policy.certificateIdentity.startsWith(prefix)) {
    throw new Error(
      "package publisher certificate identity repository drifted",
    );
  }
  const identity = policy.certificateIdentity.slice(prefix.length);
  const separator = identity.lastIndexOf("@");
  if (separator <= 0 || separator === identity.length - 1) {
    throw new Error("package publisher certificate identity is malformed");
  }
  return {
    oidcIssuer: policy.oidcIssuer,
    sourceRepository: repository,
    workflow: identity.slice(0, separator),
    refPattern: identity.slice(separator + 1),
  };
}

export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9._-]+)$/u.exec(line);
    if (!match || checksums.has(match[2]!)) {
      throw new Error("SHA256SUMS is malformed or contains a duplicate");
    }
    checksums.set(match[2]!, match[1]!);
  }
  if (checksums.size === 0) throw new Error("SHA256SUMS is empty");
  return checksums;
}

export class RetainedRoot {
  private constructor(private readonly root: string) {}

  static async open(path: string): Promise<RetainedRoot> {
    if (!path.trim()) throw new Error("--takoform-root is required");
    const requestedRoot = resolve(path);
    const status = await lstat(requestedRoot);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error("Takoform retained root must be a real directory");
    }
    const root = await realpath(requestedRoot);
    if (root !== requestedRoot) {
      throw new Error("Takoform retained root must not traverse a symlink");
    }
    return new RetainedRoot(root);
  }

  async assertCleanCheckout(expectedCommit: string): Promise<void> {
    const head = new TextDecoder()
      .decode(
        await runProcess(
          ["git", "-C", this.root, "rev-parse", "HEAD"],
          MAX_METADATA_BYTES,
          "git rev-parse",
        ),
      )
      .trim();
    if (head !== expectedCommit) {
      throw new Error(
        `Takoform checkout commit mismatch: expected ${expectedCommit}, got ${head}`,
      );
    }
    const status = new TextDecoder().decode(
      await runProcess(
        ["git", "-C", this.root, "status", "--porcelain=v1"],
        MAX_METADATA_BYTES,
        "git status",
      ),
    );
    if (status.length !== 0) {
      throw new Error("Takoform retained checkout must be clean");
    }
  }

  async read(path: string, maxBytes = MAX_METADATA_BYTES): Promise<Uint8Array> {
    const absolute = await this.path(path);
    const status = await lstat(absolute);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      (status.mode & 0o7133) !== 0 ||
      status.size <= 0 ||
      status.size > maxBytes
    ) {
      throw new Error(
        `retained artifact ${path} is not a bounded non-executable private-write regular file`,
      );
    }
    const bytes = new Uint8Array(await readFile(absolute));
    if (bytes.byteLength !== status.size) {
      throw new Error(`retained artifact ${path} changed while reading`);
    }
    return bytes;
  }

  async path(path: string): Promise<string> {
    if (
      isAbsolute(path) ||
      path.includes("\\") ||
      path.includes("\0") ||
      path
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error(`retained artifact path is unsafe: ${path}`);
    }
    const absolute = resolve(this.root, path);
    const fromRoot = relative(this.root, absolute);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new Error(`retained artifact path escapes root: ${path}`);
    }
    let component = this.root;
    const parts = path.split("/");
    for (const [index, part] of parts.entries()) {
      component = resolve(component, part);
      const status = await lstat(component);
      if (status.isSymbolicLink()) {
        throw new Error(`retained artifact path contains a symlink: ${path}`);
      }
      if (index < parts.length - 1 && !status.isDirectory()) {
        throw new Error(
          `retained artifact path contains a non-directory: ${path}`,
        );
      }
    }
    const resolved = await realpath(absolute);
    const resolvedFromRoot = relative(this.root, resolved);
    if (resolvedFromRoot.startsWith("..") || isAbsolute(resolvedFromRoot)) {
      throw new Error(`retained artifact symlink escapes root: ${path}`);
    }
    if (resolved !== absolute) {
      throw new Error(`retained artifact path is not canonical: ${path}`);
    }
    return resolved;
  }
}

interface TarEntry {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
}

async function listTarEntries(
  archivePath: string,
): Promise<readonly TarEntry[]> {
  const output = new TextDecoder().decode(
    await runTar(
      [
        "--numeric-owner",
        "--full-time",
        "--quoting-style=escape",
        "-tvzf",
        archivePath,
      ],
      MAX_METADATA_BYTES,
    ),
  );
  const entries = output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const match =
        /^(-[rwxStTs-]{9})\s+\d+\/\d+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:\s+[+-]\d{4})?\s+(.+)$/u.exec(
          line,
        );
      if (!match) {
        throw new Error(
          "package archive contains a non-regular or malformed entry",
        );
      }
      const size = Number(match[2]);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("package archive entry size is invalid");
      }
      return {
        path: match[3]!,
        size,
        mode: parseDataOnlyTarMode(match[1]!),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const paths = entries.map(({ path }) => path);
  let expandedBytes = 0;
  for (const entry of entries) {
    if (entry.size > MAX_EXPANDED_ARCHIVE_BYTES - expandedBytes) {
      throw new Error("package archive expanded size exceeds its bound");
    }
    expandedBytes += entry.size;
  }
  if (
    entries.length === 0 ||
    entries.length > MAX_ARCHIVE_ENTRIES ||
    expandedBytes > MAX_EXPANDED_ARCHIVE_BYTES ||
    new Set(paths).size !== paths.length ||
    paths.some(
      (path) =>
        path.startsWith("/") ||
        path.includes("\\") ||
        path
          .split("/")
          .some((part) => part === "" || part === "." || part === ".."),
    )
  ) {
    throw new Error("package archive has an unsafe or duplicate path");
  }
  return entries;
}

export function parseDataOnlyTarMode(value: string): number {
  if (!/^-[rwxStTs-]{9}$/u.test(value)) {
    throw new Error("package archive permission mode is malformed");
  }
  if (/[sStT]/u.test(value)) {
    throw new Error("package archive entry has unsupported special mode bits");
  }
  const bits = [
    [1, "r", 0o400],
    [2, "w", 0o200],
    [3, "x", 0o100],
    [4, "r", 0o040],
    [5, "w", 0o020],
    [6, "x", 0o010],
    [7, "r", 0o004],
    [8, "w", 0o002],
    [9, "x", 0o001],
  ] as const;
  let mode = 0;
  for (const [position, marker, bit] of bits) {
    const actual = value[position];
    if (actual === marker) mode |= bit;
    else if (actual !== "-") {
      throw new Error("package archive permission mode is malformed");
    }
  }
  if ((mode & 0o111) !== 0) {
    throw new Error("package archive contains an executable payload");
  }
  return mode;
}

async function readTarPath(
  archivePath: string,
  path: string,
): Promise<Uint8Array> {
  return await runTar(["-xOzf", archivePath, "--", path], MAX_PAYLOAD_BYTES);
}

async function runTar(
  args: readonly string[],
  maxBytes: number,
): Promise<Uint8Array> {
  return await runProcess(["tar", ...args], maxBytes, "tar");
}

async function runProcess(
  command: readonly string[],
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const child = Bun.spawn(command, {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, PROCESS_TIMEOUT_MS);
  let stdout: Uint8Array;
  let stderr: Uint8Array;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      readBoundedStream(child.stdout, maxBytes, () => child.kill()),
      readBoundedStream(child.stderr, MAX_STDERR_BYTES, () => child.kill()),
      child.exited,
    ]);
  } finally {
    clearTimeout(timeout);
  }
  if (timedOut) {
    throw new Error(`${label} exceeded the ${PROCESS_TIMEOUT_MS}ms timeout`);
  }
  if (exitCode !== 0) {
    throw new Error(
      `${label} rejected retained input: ${new TextDecoder().decode(stderr).trim()}`,
    );
  }
  return stdout;
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onExceeded: () => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        onExceeded();
        throw new Error(
          "process output exceeds the published package proof bound",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function assertPublishedSet(
  value: PublishedPackageSet,
  pins: HostProofPins,
): void {
  if (
    value.format !== "takoform.published-package-set@v1" ||
    value.publicationStatus !== "published-immutable" ||
    value.admissionStatus !== "external-required" ||
    value.repository !== pins.repository ||
    value.packageVersion !== pins.packageVersion ||
    value.definitionVersion !== pins.definitionVersion ||
    value.entries.length !== REVIEWED_TAKOFORM_PACKAGE_KINDS.length ||
    !sameJson(
      value.entries.map(({ kind }) => kind).sort(),
      [...REVIEWED_TAKOFORM_PACKAGE_KINDS].sort(),
    ) ||
    value.entries.some(
      (entry) =>
        entry.immutable !== true ||
        entry.formRef.kind !== entry.kind ||
        entry.formRef.definitionVersion !== pins.definitionVersion ||
        entry.releaseCommit !== pins.releaseCommit ||
        !/^sha256:[a-f0-9]{64}$/u.test(entry.packageDigest),
    )
  ) {
    throw new Error("published package set is incomplete or not immutable");
  }
}

async function loadHostProofPins(): Promise<HostProofPins> {
  const bytes = new Uint8Array(await readFile(HOST_PROOF_PINS_PATH));
  const pins = parseJson<HostProofPins>(bytes);
  assertClosedObject(
    pins,
    [
      "checkoutCommit",
      "definitionVersion",
      "format",
      "packageIndexPolicy",
      "packageVersion",
      "publishedSet",
      "publishedTrust",
      "releaseCommit",
      "repository",
      "trustedRoot",
    ],
    "host proof pins",
  );
  for (const [name, artifact] of Object.entries({
    publishedSet: pins.publishedSet,
    publishedTrust: pins.publishedTrust,
    trustedRoot: pins.trustedRoot,
    packageIndexPolicy: pins.packageIndexPolicy,
  })) {
    assertClosedObject(artifact, ["digest", "path"], `${name} pin`);
  }
  if (
    pins.format !== "takosumi.takoform-published-package-host-proof-pins@v1" ||
    !/^[a-f0-9]{40}$/u.test(pins.checkoutCommit) ||
    !/^[a-f0-9]{40}$/u.test(pins.releaseCommit) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(pins.repository) ||
    !/^\d+\.\d+\.\d+$/u.test(pins.packageVersion) ||
    !/^\d+\.\d+\.\d+$/u.test(pins.definitionVersion) ||
    [
      pins.publishedSet,
      pins.publishedTrust,
      pins.trustedRoot,
      pins.packageIndexPolicy,
    ].some(
      (artifact) =>
        !artifact ||
        !artifact.path.startsWith("admission/v1/") ||
        !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest),
    )
  ) {
    throw new Error("Takosumi published-package host proof pins are invalid");
  }
  return pins;
}

function assertClosedObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (!sameJson(actual, expected)) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function parseOptions(argv: readonly string[]) {
  const allowed = new Set(["--takoform-root", "--json"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!allowed.has(arg)) throw new Error(`unexpected argument: ${arg}`);
    if (arg === "--takoform-root") index += 1;
  }
  const rootIndex = argv.indexOf("--takoform-root");
  const takoformRoot = rootIndex < 0 ? undefined : argv[rootIndex + 1];
  if (!takoformRoot || takoformRoot.startsWith("--")) {
    throw new Error("--takoform-root <retained-checkout> is required");
  }
  return { takoformRoot, json: argv.includes("--json") };
}

function parseJson<T>(bytes: Uint8Array): T {
  return parseCanonicalJson(bytes) as T;
}

function assertDigest(
  bytes: Uint8Array,
  expected: string,
  label: string,
): void {
  if (sha256(bytes) !== expected) {
    throw new Error(`${label} digest mismatch`);
  }
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return Buffer.from(canonicalJsonBytes(left as CanonicalJsonValue)).equals(
      Buffer.from(canonicalJsonBytes(right as CanonicalJsonValue)),
    );
  } catch {
    return false;
  }
}
