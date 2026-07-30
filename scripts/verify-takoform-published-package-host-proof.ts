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
import { portableTypeForShapeKind } from "takosumi-contract";
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
    "../core/conformance/takoform-published-package-host-proof-v2.json",
    import.meta.url,
  ),
);
const CURRENT_TAKOFORM_REPOSITORY =
  "tako0614/terraform-provider-takoform";
const HISTORICAL_PUBLICATION_REPOSITORY =
  "tako0614/terraform-provider-takoform";
const MAX_METADATA_BYTES = 4 << 20;
const MAX_ARCHIVE_BYTES = 32 << 20;
const MAX_PAYLOAD_BYTES = 16 << 20;
const MAX_ARCHIVE_ENTRIES = 1_024;
const MAX_EXPANDED_ARCHIVE_BYTES = 64 << 20;
const PROCESS_TIMEOUT_MS = 15_000;
const MAX_STDERR_BYTES = 64 << 10;
export const REVIEWED_TAKOFORM_PACKAGE_KINDS = [
  "ContainerService",
  "EdgeWorker",
  "KeyValueStore",
  "ObjectBucket",
  "Queue",
  "RelationalDatabase",
  "Schedule",
  "StatefulEntity",
  "VectorIndex",
] as const;

const STANDARD_ADMISSION_PACKAGE_KINDS = [
  ...REVIEWED_TAKOFORM_PACKAGE_KINDS,
  "ModelEndpoint",
] as const;

interface FormPackagePublicationSet {
  readonly format: "takoform.form-package-publication-set@v1";
  readonly generation: "portable-v1";
  readonly repository: string;
  readonly protectedMainCommit: string;
  readonly publicationStatus: "published-immutable";
  readonly admissionStatus: "external-required";
  readonly revocationCheckpointStatus: "external-required" | "published";
  readonly verificationPolicy: {
    readonly bundleMediaType: string;
    readonly certificateIdentity: string;
    readonly oidcIssuer: string;
    readonly trustedRoot: {
      readonly path: string;
      readonly sha256: string;
      readonly sourcePath: string;
    };
  };
  readonly entries: readonly PublicationEntry[];
}

interface StandardAdmissionSet {
  readonly format: "takoform.standard-admission-set@v3";
  readonly generation: "ga-core-v2";
  readonly admissionReleaseTag: string;
  readonly entries: readonly StandardAdmissionEntry[];
}

interface AdmissionVersion {
  readonly format: "takoform.standard-admission-checkpoint@v1";
  readonly version: string;
  readonly tag: string;
  readonly generation: "ga-core-v2";
  readonly retainedRoot: "admission/v4";
}

interface HostProofPins {
  readonly format: "takosumi.takoform-published-package-host-proof-pins@v2";
  readonly checkoutRepository: typeof CURRENT_TAKOFORM_REPOSITORY;
  readonly checkoutCommit: string;
  readonly checkoutVersion: string;
  readonly checkoutTag: string;
  readonly admissionRoot: "admission/v4";
  readonly admissionCheckpoint: {
    readonly version: string;
    readonly tag: string;
    readonly commit: string;
    readonly tree: string;
  };
  readonly historicalPublicationRepository: typeof HISTORICAL_PUBLICATION_REPOSITORY;
  readonly standardAdmissionSet: PinnedArtifact;
  readonly publicationSet: PinnedArtifact;
  readonly admissionVersion: PinnedArtifact;
  readonly publishedTrust: PinnedArtifact;
  readonly trustedRoot: PinnedArtifact;
  readonly packageIndexPolicy: PinnedArtifact;
}

interface PinnedArtifact {
  readonly path: string;
  readonly digest: string;
}

interface StandardAdmissionEntry {
  readonly kind: string;
  readonly admissionStatus: "portable-standard";
  readonly packageDigest: string;
  readonly formRef: FormRef;
  readonly packageReleaseManifestPath: string;
  readonly packageReleaseManifestDigest: string;
  readonly packageIndexPath: string;
  readonly packageIndexSigstoreBundle: string;
  readonly releaseCommit: string;
  readonly releaseTag: string;
}

interface PublicationEntry {
  readonly kind: string;
  readonly immutable: true;
  readonly packageDigest: string;
  readonly formRef: FormRef;
  readonly sourceCommit: string;
  readonly toolingCommit: string;
  readonly tag: string;
  readonly sourcePath: string;
  readonly assets: readonly ReleaseAsset[];
}

interface FormRef {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: string;
}

export interface ReviewedPublishedPackageInstallArtifact {
  readonly kind: string;
  readonly releaseCommit: string;
  readonly releaseTag: string;
  readonly packageDigest: string;
  readonly formRef: FormRef;
  readonly hostFormRef: HostFormRef;
  readonly envelopeBytes: Uint8Array;
}

interface HostFormRef {
  readonly type: string;
  readonly version: string;
  readonly schemaDigest: string;
}

export interface ReviewedPublishedPackageInstallSet {
  readonly format: "takosumi.reviewed-takoform-package-install-set@v2";
  readonly repository: typeof CURRENT_TAKOFORM_REPOSITORY;
  readonly checkoutCommit: string;
  readonly checkoutVersion: string;
  readonly admission: {
    readonly root: "admission/v4";
    readonly version: string;
    readonly tag: string;
    readonly commit: string;
    readonly tree: string;
  };
  readonly historicalPublication: {
    readonly repository: typeof HISTORICAL_PUBLICATION_REPOSITORY;
    readonly publicationSet: PinnedArtifact;
  };
  readonly standardAdmissionSet: PinnedArtifact;
  readonly admissionVersion: PinnedArtifact;
  readonly publishedTrust: PinnedArtifact;
  readonly packageIndexPolicy: PinnedArtifact;
  readonly trustedRoot: PinnedArtifact & { readonly bytes: Uint8Array };
  readonly publisher: TakoformPublisherPolicy;
  readonly verifierId: string;
  readonly packages: readonly ReviewedPublishedPackageInstallArtifact[];
}

interface PublishedPackageTrust {
  readonly format: "takoform.published-package-trust@v2";
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
  readonly toolingCommit: string;
  readonly sourceRepository: string;
  readonly packageVersion: string;
  readonly packageDigest: string;
  readonly formRef: FormRef;
  readonly signedSubject: string;
  readonly signatureBundle: string;
  readonly publicationReady: true;
  readonly publicationBlockers: readonly unknown[];
  readonly assets: readonly ReleaseAsset[];
}

interface ReleaseAsset {
  readonly name: string;
  readonly mediaType?: string;
  readonly size: number;
  readonly digest?: string;
  readonly sha256?: string;
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
  readonly kind: "takosumi.takoform-published-package-host-proof@v2";
  readonly status: "passed";
  readonly evidenceLevel: "repo_regression";
  readonly packageCount: number;
  readonly kinds: readonly string[];
  readonly releaseCommits: readonly string[];
  readonly definitionVersions: readonly string[];
  readonly checkoutRepository: typeof CURRENT_TAKOFORM_REPOSITORY;
  readonly checkoutCommit: string;
  readonly checkoutVersion: string;
  readonly admissionCheckpointVersion: string;
  readonly admissionReleaseTag: string;
  readonly standardAdmissionSetDigest: string;
  readonly publicationSetDigest: string;
  readonly verifierId: string;
  readonly transparencyTamperRejection: "passed";
  readonly installReplay: "passed";
  readonly serviceReconstructionReverification: "passed";
  readonly admissionStatus: "portable-standard";
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
    standardAdmissionSetBytes,
    publicationSetBytes,
    publicationSet,
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
    const artifactRef = retainedArtifactRef(entry);
    artifacts.set(artifactRef, envelope);
    const installed = await registry.installPackage({
      artifactRef,
      expectedPackageDigest: entry.packageDigest,
      actorId: "operator:published-package-host-proof",
    });
    if (
      installed.packageDigest !== entry.packageDigest ||
      !sameJson(installed.definitionRefs, [entry.hostFormRef])
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
      ...entry.hostFormRef,
      packageDigest: entry.packageDigest,
    };
    await reconstructed.getRetainedIdentity(identity);
    await reconstructed.verifyRetainedIdentity(identity);
    await reconstructed.installPackage({
      artifactRef: retainedArtifactRef(entry),
      expectedPackageDigest: entry.packageDigest,
      actorId: "operator:published-package-host-proof",
    });
  }

  return {
    kind: "takosumi.takoform-published-package-host-proof@v2",
    status: "passed",
    evidenceLevel: "repo_regression",
    packageCount: prepared.packages.length,
    kinds: prepared.packages.map(({ kind }) => kind).sort(),
    releaseCommits: [
      ...new Set(
        prepared.packages.map(({ releaseCommit }) => releaseCommit),
      ),
    ].sort(),
    definitionVersions: [
      ...new Set(
        prepared.packages.map(({ formRef }) => formRef.definitionVersion),
      ),
    ].sort(),
    checkoutRepository: pins.checkoutRepository,
    checkoutCommit: pins.checkoutCommit,
    checkoutVersion: pins.checkoutVersion,
    admissionCheckpointVersion: pins.admissionCheckpoint.version,
    admissionReleaseTag: pins.admissionCheckpoint.tag,
    standardAdmissionSetDigest: sha256(standardAdmissionSetBytes),
    publicationSetDigest: sha256(publicationSetBytes),
    verifierId: verifier.id,
    transparencyTamperRejection: "passed",
    installReplay: "passed",
    serviceReconstructionReverification: "passed",
    admissionStatus: "portable-standard",
    unsettledPublisherRoles: [...trust.unsettledPublisherRoles].sort(),
    revocationCheckpointStatus: publicationSet.revocationCheckpointStatus,
  };
}

function retainedArtifactRef(
  entry: ReviewedPublishedPackageInstallArtifact,
): string {
  return `retained:takoform/${entry.kind}/${entry.formRef.definitionVersion}/${entry.packageDigest}`;
}

interface ReviewedPublishedPackageContext {
  readonly pins: HostProofPins;
  readonly retained: RetainedRoot;
  readonly standardAdmissionSetBytes: Uint8Array;
  readonly standardAdmissionSet: StandardAdmissionSet;
  readonly publicationSetBytes: Uint8Array;
  readonly publicationSet: FormPackagePublicationSet;
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
  await retained.assertOriginRepository(pins.checkoutRepository);
  await retained.assertCleanCheckout(pins.checkoutCommit);
  await retained.assertRefCommit(pins.checkoutTag, pins.checkoutCommit);
  await retained.assertRefCommit(
    pins.admissionCheckpoint.tag,
    pins.admissionCheckpoint.commit,
  );
  await retained.assertTree(
    pins.checkoutCommit,
    pins.admissionRoot,
    pins.admissionCheckpoint.tree,
  );
  await retained.assertTree(
    pins.admissionCheckpoint.commit,
    pins.admissionRoot,
    pins.admissionCheckpoint.tree,
  );

  const admissionVersionBytes = await retained.read(pins.admissionVersion.path);
  assertDigest(
    admissionVersionBytes,
    pins.admissionVersion.digest,
    "pinned admission version",
  );
  assertAdmissionVersion(
    parseJson<AdmissionVersion>(admissionVersionBytes),
    pins,
  );

  const standardAdmissionSetBytes = await retained.read(
    pins.standardAdmissionSet.path,
  );
  assertDigest(
    standardAdmissionSetBytes,
    pins.standardAdmissionSet.digest,
    "pinned Standard admission set",
  );
  const standardAdmissionSet = parseJson<StandardAdmissionSet>(
    standardAdmissionSetBytes,
  );
  assertStandardAdmissionSet(standardAdmissionSet, pins);
  for (const entry of standardAdmissionSet.entries) {
    if (
      (REVIEWED_TAKOFORM_PACKAGE_KINDS as readonly string[]).includes(
        entry.kind,
      )
    ) {
      await retained.assertRefCommit(entry.releaseTag, entry.releaseCommit);
    }
  }

  const publicationSetBytes = await retained.read(pins.publicationSet.path);
  assertDigest(
    publicationSetBytes,
    pins.publicationSet.digest,
    "pinned Form Package publication set",
  );
  const publicationSet = parseJson<FormPackagePublicationSet>(
    publicationSetBytes,
  );
  assertPublicationSet(publicationSet, standardAdmissionSet, pins);

  const trustBytes = await retained.read(pins.publishedTrust.path);
  assertDigest(trustBytes, pins.publishedTrust.digest, "published trust");
  const trust = parseJson<PublishedPackageTrust>(trustBytes);
  if (trust.format !== "takoform.published-package-trust@v2") {
    throw new Error("unsupported published package trust format");
  }

  const trustedRootPath = admissionPath(pins, trust.trustedRoot.path);
  if (
    trustedRootPath !== pins.trustedRoot.path ||
    trust.trustedRoot.digest !== pins.trustedRoot.digest
  ) {
    throw new Error("TrustedRoot differs from Takosumi's reviewed pin");
  }
  const trustedRootBytes = await retained.read(trustedRootPath);
  assertDigest(trustedRootBytes, trust.trustedRoot.digest, "TrustedRoot");
  if (
    publicationSet.verificationPolicy.trustedRoot.path !==
      trust.trustedRoot.path ||
    publicationSet.verificationPolicy.trustedRoot.sha256 !==
      trust.trustedRoot.digest
  ) {
    throw new Error(
      "publication set TrustedRoot differs from Takosumi's reviewed pin",
    );
  }
  const packageIndexPolicyPath = admissionPath(
    pins,
    trust.packageIndexPolicy.path,
  );
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
  if (
    packagePolicy.oidcIssuer !==
      publicationSet.verificationPolicy.oidcIssuer ||
    packagePolicy.certificateIdentity !==
      publicationSet.verificationPolicy.certificateIdentity ||
    packagePolicy.bundleMediaType !==
      publicationSet.verificationPolicy.bundleMediaType
  ) {
    throw new Error(
      "package index policy differs from the immutable publication set",
    );
  }
  return {
    pins,
    retained,
    standardAdmissionSetBytes,
    standardAdmissionSet,
    publicationSetBytes,
    publicationSet,
    trust,
    trustedRootPath,
    trustedRootBytes,
    publisher: parsePublisherIdentity(
      packagePolicy,
      pins.historicalPublicationRepository,
    ),
  };
}

async function buildReviewedPublishedPackageInstallSet(
  context: ReviewedPublishedPackageContext,
): Promise<ReviewedPublishedPackageInstallSet> {
  const {
    pins,
    retained,
    standardAdmissionSet,
    publicationSet,
    trust,
    trustedRootBytes,
    publisher,
  } = context;
  const verifier = new TakoformDataOnlyPackageVerifier(
    new SigstoreTakoformPackageSignatureVerifier({
      trustedRootDigest: trust.trustedRoot.digest as `sha256:${string}`,
      loadTrustedRoot: async () => trustedRootBytes,
      publishers: [publisher],
    }),
  );
  const packages: ReviewedPublishedPackageInstallArtifact[] = [];
  const admissionEntries = standardAdmissionSet.entries
    .filter(({ kind }) =>
      (REVIEWED_TAKOFORM_PACKAGE_KINDS as readonly string[]).includes(kind),
    )
    .sort((left, right) => left.kind.localeCompare(right.kind));
  for (const entry of admissionEntries) {
    const publicationEntry = publicationSet.entries.find(
      ({ kind }) => kind === entry.kind,
    );
    if (!publicationEntry) {
      throw new Error(`${entry.kind} publication entry is missing`);
    }
    const envelopeBytes = await buildInstallEnvelope(
      retained,
      pins,
      entry,
      publicationEntry,
    );
    const verified = await verifier.verify(envelopeBytes, entry.packageDigest);
    if (
      verified.packageDigest !== entry.packageDigest ||
      !sameJson(
        verified.definitions.map(({ formRef }) => formRef),
        [projectTakoformFormRef(entry.formRef)],
      )
    ) {
      throw new Error(`${entry.kind} verified identity drifted`);
    }
    packages.push({
      kind: entry.kind,
      releaseCommit: entry.releaseCommit,
      releaseTag: entry.releaseTag,
      packageDigest: entry.packageDigest,
      formRef: entry.formRef,
      hostFormRef: projectTakoformFormRef(entry.formRef),
      envelopeBytes,
    });
  }
  return {
    format: "takosumi.reviewed-takoform-package-install-set@v2",
    repository: pins.checkoutRepository,
    checkoutCommit: pins.checkoutCommit,
    checkoutVersion: pins.checkoutVersion,
    admission: {
      root: pins.admissionRoot,
      version: pins.admissionCheckpoint.version,
      tag: pins.admissionCheckpoint.tag,
      commit: pins.admissionCheckpoint.commit,
      tree: pins.admissionCheckpoint.tree,
    },
    historicalPublication: {
      repository: pins.historicalPublicationRepository,
      publicationSet: pins.publicationSet,
    },
    standardAdmissionSet: pins.standardAdmissionSet,
    admissionVersion: pins.admissionVersion,
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
  pins: HostProofPins,
  entry: StandardAdmissionEntry,
  publicationEntry: PublicationEntry,
): Promise<Uint8Array> {
  const releaseDirectory = dirname(entry.packageReleaseManifestPath);
  if (
    publicationEntry.immutable !== true ||
    publicationEntry.kind !== entry.kind ||
    publicationEntry.packageDigest !== entry.packageDigest ||
    publicationEntry.sourceCommit !== entry.releaseCommit ||
    publicationEntry.tag !== entry.releaseTag ||
    !sameJson(publicationEntry.formRef, entry.formRef) ||
    dirname(entry.packageIndexPath) !== releaseDirectory ||
    dirname(entry.packageIndexSigstoreBundle) !== releaseDirectory
  ) {
    throw new Error(`${entry.kind} publication identity drifted`);
  }
  const manifestBytes = await retained.read(
    admissionPath(pins, entry.packageReleaseManifestPath),
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
    manifest.toolingCommit !== publicationEntry.toolingCommit ||
    manifest.sourceRepository !==
      `github.com/${pins.historicalPublicationRepository}` ||
    manifest.packageVersion !== entry.formRef.definitionVersion ||
    manifest.packageDigest !== entry.packageDigest ||
    !sameJson(manifest.formRef, entry.formRef) ||
    manifest.signedSubject !==
      entry.packageIndexPath.slice(
        `${dirname(entry.packageIndexPath)}/`.length,
      ) ||
    manifest.signatureBundle !==
      entry.packageIndexSigstoreBundle.slice(
        `${dirname(entry.packageIndexSigstoreBundle)}/`.length,
      )
  ) {
    throw new Error(`${entry.kind} release manifest does not match its root`);
  }

  const publicationAssets = new Map(
    publicationEntry.assets.map((asset) => [asset.name, asset]),
  );
  if (
    publicationAssets.size !== publicationEntry.assets.length ||
    publicationEntry.assets.length !== manifest.assets.length + 2
  ) {
    throw new Error(`${entry.kind} publication asset closure drifted`);
  }
  const manifestAsset = publicationAssets.get("release-manifest.json");
  if (
    !manifestAsset ||
    manifestAsset.size !== manifestBytes.byteLength ||
    releaseAssetDigest(manifestAsset) !== sha256(manifestBytes)
  ) {
    throw new Error(`${entry.kind} publication manifest binding drifted`);
  }

  const checksumsPath = `${releaseDirectory}/SHA256SUMS`;
  const checksumsAsset = publicationAssets.get("SHA256SUMS");
  if (!checksumsAsset) {
    throw new Error(`${entry.kind} published checksums are missing`);
  }
  const checksumsBytes = await retained.read(
    admissionPath(pins, checksumsPath),
  );
  if (
    checksumsBytes.byteLength !== checksumsAsset.size ||
    sha256(checksumsBytes) !== releaseAssetDigest(checksumsAsset)
  ) {
    throw new Error(`${entry.kind} published checksums drifted`);
  }
  const checksums = parseChecksums(new TextDecoder().decode(checksumsBytes));
  if (checksums.get("release-manifest.json") !== sha256Hex(manifestBytes)) {
    throw new Error(
      `${entry.kind} checksums do not bind release-manifest.json`,
    );
  }

  for (const asset of manifest.assets) {
    const publicationAsset = publicationAssets.get(asset.name);
    if (
      !publicationAsset ||
      publicationAsset.size !== asset.size ||
      releaseAssetDigest(publicationAsset) !== releaseAssetDigest(asset)
    ) {
      throw new Error(
        `${entry.kind} release asset ${asset.name} publication binding drifted`,
      );
    }
    const bytes = await retained.read(
      admissionPath(pins, `${releaseDirectory}/${asset.name}`),
      asset.mediaType === "application/gzip"
        ? MAX_ARCHIVE_BYTES
        : MAX_METADATA_BYTES,
    );
    if (
      bytes.byteLength !== asset.size ||
      sha256(bytes) !== releaseAssetDigest(asset) ||
      checksums.get(asset.name) !== sha256Hex(bytes)
    ) {
      throw new Error(`${entry.kind} release asset ${asset.name} drifted`);
    }
  }
  if (checksums.size !== manifest.assets.length + 1) {
    throw new Error(`${entry.kind} checksums contain an unexpected asset`);
  }

  const indexBytes = await retained.read(
    admissionPath(pins, entry.packageIndexPath),
  );
  assertDigest(indexBytes, entry.packageDigest, `${entry.kind} package index`);
  const index = parseJson<PackageIndex>(indexBytes);
  if (!sameJson(index.formRef, entry.formRef)) {
    throw new Error(`${entry.kind} package index FormRef drifted`);
  }
  const bundleBytes = await retained.read(
    admissionPath(pins, entry.packageIndexSigstoreBundle),
  );
  const bundle = parseCanonicalJson(bundleBytes);

  const archiveAsset = manifest.assets.find(
    ({ mediaType }) => mediaType === "application/gzip",
  );
  if (!archiveAsset)
    throw new Error(`${entry.kind} package archive is missing`);
  const archivePath = await retained.path(
    admissionPath(pins, `${releaseDirectory}/${archiveAsset.name}`),
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

function releaseAssetDigest(asset: ReleaseAsset): string {
  const digest = asset.digest ?? asset.sha256;
  if (!digest || !/^sha256:[a-f0-9]{64}$/u.test(digest)) {
    throw new Error(`release asset ${asset.name} digest is invalid`);
  }
  return digest;
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

  async assertOriginRepository(expectedRepository: string): Promise<void> {
    const remote = new TextDecoder()
      .decode(
        await runProcess(
          ["git", "-C", this.root, "remote", "get-url", "origin"],
          MAX_METADATA_BYTES,
          "git origin readback",
        ),
      )
      .trim();
    const observedRepository = githubRepositoryFromRemote(remote);
    if (observedRepository !== expectedRepository) {
      throw new Error(
        `Takoform checkout origin mismatch: expected ${expectedRepository}, got ${observedRepository ?? "unsupported remote"}`,
      );
    }
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

  async assertRefCommit(ref: string, expectedCommit: string): Promise<void> {
    const observed = new TextDecoder()
      .decode(
        await runProcess(
          [
            "git",
            "-C",
            this.root,
            "rev-parse",
            "--verify",
            `${ref}^{commit}`,
          ],
          MAX_METADATA_BYTES,
          "git ref readback",
        ),
      )
      .trim();
    if (observed !== expectedCommit) {
      throw new Error(
        `Takoform ref ${ref} commit mismatch: expected ${expectedCommit}, got ${observed}`,
      );
    }
  }

  async assertTree(
    commit: string,
    path: string,
    expectedTree: string,
  ): Promise<void> {
    if (
      !/^[a-f0-9]{40}$/u.test(commit) ||
      !/^[A-Za-z0-9._/-]+$/u.test(path) ||
      path.startsWith("/") ||
      path.includes("..")
    ) {
      throw new Error("Takoform retained tree pin is invalid");
    }
    const observed = new TextDecoder()
      .decode(
        await runProcess(
          [
            "git",
            "-C",
            this.root,
            "rev-parse",
            "--verify",
            `${commit}:${path}`,
          ],
          MAX_METADATA_BYTES,
          "git tree readback",
        ),
      )
      .trim();
    if (observed !== expectedTree) {
      throw new Error(
        `Takoform ${path} tree mismatch: expected ${expectedTree}, got ${observed}`,
      );
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

function githubRepositoryFromRemote(remote: string): string | undefined {
  const prefixes = [
    "https://github.com/",
    "git@github.com:",
    "ssh://git@github.com/",
  ] as const;
  const prefix = prefixes.find((candidate) => remote.startsWith(candidate));
  if (!prefix) return undefined;
  const remainder = remote.slice(prefix.length);
  const repository = remainder.endsWith(".git")
    ? remainder.slice(0, -".git".length)
    : remainder;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
    ? repository
    : undefined;
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

function assertAdmissionVersion(
  value: AdmissionVersion,
  pins: HostProofPins,
): void {
  if (
    value.format !== "takoform.standard-admission-checkpoint@v1" ||
    value.generation !== "ga-core-v2" ||
    value.retainedRoot !== pins.admissionRoot ||
    value.version !== pins.admissionCheckpoint.version ||
    value.tag !== pins.admissionCheckpoint.tag
  ) {
    throw new Error("Standard admission checkpoint differs from its pin");
  }
}

function assertStandardAdmissionSet(
  value: StandardAdmissionSet,
  pins: HostProofPins,
): void {
  if (
    value.format !== "takoform.standard-admission-set@v3" ||
    value.generation !== "ga-core-v2" ||
    value.admissionReleaseTag !== pins.admissionCheckpoint.tag ||
    value.entries.length !== STANDARD_ADMISSION_PACKAGE_KINDS.length ||
    !sameJson(
      value.entries.map(({ kind }) => kind).sort(),
      [...STANDARD_ADMISSION_PACKAGE_KINDS].sort(),
    ) ||
    value.entries.some(
      (entry) =>
        entry.admissionStatus !== "portable-standard" ||
        entry.formRef.kind !== entry.kind ||
        !isFormRef(entry.formRef) ||
        !/^sha256:[a-f0-9]{64}$/u.test(entry.packageDigest) ||
        !/^sha256:[a-f0-9]{64}$/u.test(
          entry.packageReleaseManifestDigest,
        ) ||
        !/^[a-f0-9]{40}$/u.test(entry.releaseCommit) ||
        !/^forms\/k-[a-z0-9]+\/v\d+\.\d+\.\d+$/u.test(entry.releaseTag) ||
        !isAdmissionRelativePath(entry.packageReleaseManifestPath) ||
        !isAdmissionRelativePath(entry.packageIndexPath) ||
        !isAdmissionRelativePath(entry.packageIndexSigstoreBundle),
    )
  ) {
    throw new Error("Standard admission set is incomplete or invalid");
  }
}

function assertPublicationSet(
  value: FormPackagePublicationSet,
  standard: StandardAdmissionSet,
  pins: HostProofPins,
): void {
  const publicationByKind = new Map(
    value.entries.map((entry) => [entry.kind, entry]),
  );
  if (
    value.format !== "takoform.form-package-publication-set@v1" ||
    value.generation !== "portable-v1" ||
    value.publicationStatus !== "published-immutable" ||
    value.admissionStatus !== "external-required" ||
    value.repository !== pins.historicalPublicationRepository ||
    value.repository !== HISTORICAL_PUBLICATION_REPOSITORY ||
    !/^[a-f0-9]{40}$/u.test(value.protectedMainCommit) ||
    publicationByKind.size !== value.entries.length ||
    standard.entries.some((entry) => {
      const published = publicationByKind.get(entry.kind);
      return (
        !published ||
        published.immutable !== true ||
        published.packageDigest !== entry.packageDigest ||
        published.sourceCommit !== entry.releaseCommit ||
        published.tag !== entry.releaseTag ||
        !sameJson(published.formRef, entry.formRef) ||
        published.assets.length === 0
      );
    })
  ) {
    throw new Error(
      "Form Package publication set is incomplete or not immutable",
    );
  }
}

async function loadHostProofPins(): Promise<HostProofPins> {
  const bytes = new Uint8Array(await readFile(HOST_PROOF_PINS_PATH));
  const pins = parseJson<HostProofPins>(bytes);
  assertClosedObject(
    pins,
    [
      "admissionCheckpoint",
      "admissionRoot",
      "admissionVersion",
      "checkoutCommit",
      "checkoutRepository",
      "checkoutTag",
      "checkoutVersion",
      "format",
      "historicalPublicationRepository",
      "packageIndexPolicy",
      "publicationSet",
      "publishedTrust",
      "standardAdmissionSet",
      "trustedRoot",
    ],
    "host proof pins",
  );
  assertClosedObject(
    pins.admissionCheckpoint,
    ["commit", "tag", "tree", "version"],
    "admission checkpoint pin",
  );
  for (const [name, artifact] of Object.entries({
    admissionVersion: pins.admissionVersion,
    standardAdmissionSet: pins.standardAdmissionSet,
    publicationSet: pins.publicationSet,
    publishedTrust: pins.publishedTrust,
    trustedRoot: pins.trustedRoot,
    packageIndexPolicy: pins.packageIndexPolicy,
  })) {
    assertClosedObject(artifact, ["digest", "path"], `${name} pin`);
  }
  if (
    pins.format !== "takosumi.takoform-published-package-host-proof-pins@v2" ||
    pins.checkoutRepository !== CURRENT_TAKOFORM_REPOSITORY ||
    pins.historicalPublicationRepository !==
      HISTORICAL_PUBLICATION_REPOSITORY ||
    !/^[a-f0-9]{40}$/u.test(pins.checkoutCommit) ||
    !/^\d+\.\d+\.\d+$/u.test(pins.checkoutVersion) ||
    pins.checkoutTag !== `v${pins.checkoutVersion}` ||
    pins.admissionRoot !== "admission/v4" ||
    !/^\d+\.\d+\.\d+$/u.test(pins.admissionCheckpoint.version) ||
    pins.admissionCheckpoint.tag !==
      `forms/admissions/v${pins.admissionCheckpoint.version}` ||
    !/^[a-f0-9]{40}$/u.test(pins.admissionCheckpoint.commit) ||
    !/^[a-f0-9]{40}$/u.test(pins.admissionCheckpoint.tree) ||
    [
      pins.admissionVersion,
      pins.standardAdmissionSet,
      pins.publicationSet,
      pins.publishedTrust,
      pins.trustedRoot,
      pins.packageIndexPolicy,
    ].some(
      (artifact) =>
        !artifact ||
        !artifact.path.startsWith(`${pins.admissionRoot}/`) ||
        !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest),
    )
  ) {
    throw new Error("Takosumi published-package host proof pins are invalid");
  }
  return pins;
}

function admissionPath(pins: HostProofPins, path: string): string {
  if (!isAdmissionRelativePath(path)) {
    throw new Error(`admission-relative path is invalid: ${path}`);
  }
  return `${pins.admissionRoot}/${path}`;
}

function isAdmissionRelativePath(path: string): boolean {
  return (
    typeof path === "string" &&
    !path.startsWith("/") &&
    !path.startsWith("admission/") &&
    !path.includes("\\") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function isFormRef(value: FormRef): boolean {
  return (
    value.apiVersion === "forms.takoform.com/v1alpha1" &&
    typeof value.kind === "string" &&
    /^\d+\.\d+\.\d+$/u.test(value.definitionVersion) &&
    /^sha256:[a-f0-9]{64}$/u.test(value.schemaDigest)
  );
}

export function projectTakoformFormRef(value: FormRef): HostFormRef {
  const type = portableTypeForShapeKind(value.kind);
  if (type === undefined || !isFormRef(value)) {
    throw new Error(`Takoform FormRef ${value.kind} cannot be hosted`);
  }
  return {
    type,
    version: value.definitionVersion,
    schemaDigest: value.schemaDigest,
  };
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
