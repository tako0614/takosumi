import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  constants as fsConstants,
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  readlink,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { loadCompatibilityAuthorities } from "./provider-release-compatibility.mjs";

export const PROVIDER_RELEASE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const PROVIDER_VERSION_PATH = join(
  PROVIDER_RELEASE_ROOT,
  "provider",
  "release",
  "version.json",
);
export const PROVIDER_QUARANTINE_PATH = join(
  PROVIDER_RELEASE_ROOT,
  "provider",
  "release",
  "quarantine",
  "1.0.0.json",
);
export const PROVIDER_REGISTRY_PATH = join(
  PROVIDER_RELEASE_ROOT,
  "provider",
  "release",
  "registry.json",
);
export const GENERATED_PUBLIC_MIRROR_ROOT = join(
  PROVIDER_RELEASE_ROOT,
  "dashboard",
  "public",
  "opentofu",
  "providers",
);

const SHA256 = /^[a-f0-9]{64}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const PROVIDER_ADDRESS = "registry.opentofu.org/takosjp/takosumi";
const PUBLIC_MIRROR_ORIGIN = "https://app.takosumi.com";
const PUBLIC_MIRROR_PREFIX = "/opentofu/providers/";
const MAX_PROVIDER_ASSET_BYTES = 64 * 1024 * 1024;
const PROVIDER_FETCH_TIMEOUT_MS = 30_000;
const REQUIRED_PLATFORMS = [
  "linux_amd64",
  "linux_arm64",
  "darwin_amd64",
  "darwin_arm64",
];

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readFileSnapshot(path, label = "release file") {
  await assertNoSymlinkPathComponents(dirname(resolve(path)), label);
  const handle = await open(
    resolve(path),
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.length !== before.size
    ) {
      throw new Error(`${label} changed while it was being read`);
    }
    return { bytes, sha256: sha256(bytes), stat: after };
  } finally {
    await handle.close();
  }
}

function parseJsonSnapshot(snapshot, label) {
  try {
    return JSON.parse(snapshot.bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function readAuthorityJsonWithSidecar(path, label) {
  const manifestSnapshot = await readFileSnapshot(path, label);
  const sidecarSnapshot = await readFileSnapshot(
    `${path}.sha256`,
    `${label} digest sidecar`,
  );
  const sidecar = sidecarSnapshot.bytes.toString("utf8").trim();
  const match = /^([a-f0-9]{64})\s{2}([^/]+)$/.exec(sidecar);
  if (!match || match[2] !== basename(path)) {
    throw new Error(`invalid manifest digest sidecar ${path}.sha256`);
  }
  if (match[1] !== manifestSnapshot.sha256) {
    throw new Error(
      `manifest digest mismatch for ${path}: expected ${match[1]}, got ${manifestSnapshot.sha256}`,
    );
  }
  return {
    value: parseJsonSnapshot(manifestSnapshot, label),
    bytes: manifestSnapshot.bytes,
    sha256: manifestSnapshot.sha256,
    sidecarBytes: sidecarSnapshot.bytes,
  };
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function stableJson(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

export async function manifestDigest(path) {
  return (await readFileSnapshot(path, "provider manifest")).sha256;
}

export async function verifyManifestSidecar(path) {
  return (await readAuthorityJsonWithSidecar(path, "provider manifest")).sha256;
}

export function validateVersionDescriptor(descriptor) {
  assertObject(descriptor, "provider release descriptor");
  assertExactObjectKeys(
    descriptor,
    [
      "schemaVersion",
      "providerAddress",
      "modulePath",
      "version",
      "tag",
      "status",
      "publishable",
      "protocols",
      "platforms",
      "toolchain",
      "runtimeTrust",
      "publicationPolicy",
      "releasePolicy",
    ],
    "provider release descriptor",
  );
  if (descriptor.schemaVersion !== 1) {
    throw new Error("provider release descriptor schemaVersion must be 1");
  }
  if (descriptor.providerAddress !== PROVIDER_ADDRESS) {
    throw new Error(`providerAddress must be ${PROVIDER_ADDRESS}`);
  }
  if (!SEMVER.test(descriptor.version ?? "")) {
    throw new Error(`invalid provider semver ${String(descriptor.version)}`);
  }
  compareSemver(descriptor.version, descriptor.version);
  if (descriptor.tag !== `provider/v${descriptor.version}`) {
    throw new Error("provider tag must be provider/v<exact version>");
  }
  if (
    descriptor.modulePath !== "github.com/takosjp/terraform-provider-takosumi"
  ) {
    throw new Error("unexpected provider modulePath");
  }
  if (descriptor.status !== "candidate" || descriptor.publishable !== false) {
    throw new Error(
      "an unreviewed descriptor must remain a non-publishable candidate",
    );
  }
  if (JSON.stringify(descriptor.protocols) !== JSON.stringify(["5.0"])) {
    throw new Error("provider release protocol must be exactly 5.0");
  }
  const platformKeys = descriptor.platforms?.map(platformKey) ?? [];
  assertExactSet(platformKeys, REQUIRED_PLATFORMS, "provider platforms");
  for (const platform of descriptor.platforms) {
    assertExactObjectKeys(platform, ["os", "arch"], "provider platform");
  }
  if (descriptor.toolchain?.go?.version !== "go1.26.0") {
    throw new Error("provider release Go toolchain must be pinned to go1.26.0");
  }
  if (descriptor.toolchain?.zip?.version !== "Info-ZIP 3.0") {
    throw new Error(
      "provider release zip toolchain must be pinned to Info-ZIP 3.0",
    );
  }
  if (descriptor.toolchain?.unzip?.version !== "Info-ZIP UnZip 6.00") {
    throw new Error(
      "provider release unzip toolchain must be pinned to Info-ZIP UnZip 6.00",
    );
  }
  assertExactObjectKeys(
    descriptor.toolchain,
    ["go", "zip", "unzip", "git", "gpgv"],
    "provider release toolchain",
  );
  for (const [name, executable] of Object.entries(descriptor.toolchain)) {
    const expectedKeys =
      name === "go"
        ? [
            "version",
            "path",
            "sha256",
            "distributionRoot",
            "distributionSha256",
          ]
        : ["version", "path", "sha256"];
    assertExactObjectKeys(
      executable,
      expectedKeys,
      `provider release ${name} toolchain`,
    );
    if (!isAbsolute(executable.path ?? "") || !SHA256.test(executable.sha256)) {
      throw new Error(
        `provider release ${name} toolchain requires an absolute path and SHA-256`,
      );
    }
  }
  if (
    descriptor.toolchain.git.version !== "git version 2.53.0" ||
    descriptor.toolchain.gpgv.version !== "gpgv (GnuPG) 2.4.8" ||
    !isAbsolute(descriptor.toolchain.go.distributionRoot ?? "") ||
    !SHA256.test(descriptor.toolchain.go.distributionSha256 ?? "")
  ) {
    throw new Error("provider Git/GPG/Go distribution trust must be pinned");
  }
  assertObject(descriptor.runtimeTrust, "provider runtime trust");
  assertExactObjectKeys(
    descriptor.runtimeTrust,
    ["files"],
    "provider runtime trust",
  );
  if (
    !Array.isArray(descriptor.runtimeTrust.files) ||
    descriptor.runtimeTrust.files.length === 0
  ) {
    throw new Error("provider runtime trust requires shared-library pins");
  }
  const runtimePaths = [];
  for (const file of descriptor.runtimeTrust.files) {
    assertExactObjectKeys(file, ["path", "sha256"], "provider runtime file");
    if (!isAbsolute(file.path ?? "") || !SHA256.test(file.sha256 ?? "")) {
      throw new Error(
        "provider runtime file requires absolute path and SHA-256",
      );
    }
    runtimePaths.push(file.path);
  }
  if (new Set(runtimePaths).size !== runtimePaths.length) {
    throw new Error("provider runtime trust contains duplicate paths");
  }
  if (descriptor.releasePolicy?.deterministicBuilds !== 2) {
    throw new Error("provider releases must build twice");
  }
  if (descriptor.releasePolicy?.oldVersionOverwrite !== "forbidden") {
    throw new Error("provider old-version overwrite must be forbidden");
  }
  if (descriptor.releasePolicy?.signedAnnotatedTagRequired !== true) {
    throw new Error("provider releases require a signed annotated tag");
  }
  const publication = descriptor.publicationPolicy;
  assertExactObjectKeys(
    publication,
    [
      "mode",
      "status",
      "reviewedSignerFingerprints",
      "signerKeyring",
      "publicExistingVersionReadbackRequired",
      "artifactSignatureRequired",
      "transparencyLogRequired",
    ],
    "provider publication policy",
  );
  assertExactObjectKeys(
    publication?.signerKeyring,
    ["path", "sha256", "format"],
    "provider signer keyring",
  );
  if (
    publication?.mode !== "candidate-only" ||
    publication.status !== "blocked-external-review" ||
    !Array.isArray(publication.reviewedSignerFingerprints) ||
    publication.reviewedSignerFingerprints.some(
      (fingerprint) => !/^[A-F0-9]{40,64}$/.test(fingerprint),
    ) ||
    publication.signerKeyring?.format !== "openpgp-keyring" ||
    isAbsolute(publication.signerKeyring?.path ?? "") ||
    !SHA256.test(publication.signerKeyring?.sha256 ?? "") ||
    publication.publicExistingVersionReadbackRequired !== true ||
    publication.artifactSignatureRequired !== true ||
    publication.transparencyLogRequired !== true
  ) {
    throw new Error("provider publication must remain explicitly blocked");
  }
  assertExactObjectKeys(
    descriptor.releasePolicy,
    [
      "sourceMustBeClean",
      "tagAndCommitMustMatch",
      "signedAnnotatedTagRequired",
      "oldVersionOverwrite",
      "deterministicBuilds",
      "buildFlags",
      "ldflags",
      "archiveTimestampUtc",
    ],
    "provider release policy",
  );
  return descriptor;
}

export function validateQuarantineManifest(manifest) {
  assertObject(manifest, "provider quarantine manifest");
  assertExactObjectKeys(
    manifest,
    [
      "schemaVersion",
      "kind",
      "providerAddress",
      "version",
      "state",
      "publishable",
      "reproducible",
      "observedAt",
      "reason",
      "source",
      "mirror",
      "rejectedLocalRebuild",
    ],
    "provider quarantine manifest",
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "takosumi.provider-release-quarantine@v1"
  ) {
    throw new Error("invalid provider quarantine manifest identity");
  }
  assertExactObjectKeys(
    manifest.source,
    [
      "modulePath",
      "sourceCommit",
      "sourceCommitTime",
      "goVersion",
      "vcsModified",
      "providerReportedVersion",
      "archiveClaimedVersion",
      "provenance",
      "provenanceVerified",
    ],
    "historical provider source",
  );
  assertExactObjectKeys(
    manifest.mirror,
    ["baseUrl", "providerPath", "indexEntry", "indexObservation", "assets"],
    "historical provider mirror",
  );
  if (
    manifest.mirror.baseUrl !==
      `${PUBLIC_MIRROR_ORIGIN}${PUBLIC_MIRROR_PREFIX}` ||
    manifest.mirror.providerPath !== PROVIDER_ADDRESS
  ) {
    throw new Error("historical provider mirror origin/path changed");
  }
  if (
    manifest.providerAddress !== PROVIDER_ADDRESS ||
    manifest.version !== "1.0.0"
  ) {
    throw new Error(
      "the historical quarantine must identify the Takosumi provider 1.0.0",
    );
  }
  if (
    manifest.state !== "historical-quarantine" ||
    manifest.publishable !== false ||
    manifest.reproducible !== false
  ) {
    throw new Error(
      "historical 1.0.0 must remain non-publishable and non-reproducible",
    );
  }
  if (
    manifest.source?.providerReportedVersion !== "dev" ||
    manifest.source?.vcsModified !== true ||
    manifest.source?.provenance !== "unknown-dirty" ||
    manifest.source?.provenanceVerified !== false
  ) {
    throw new Error("historical 1.0.0 dirty/dev provenance must stay explicit");
  }
  const assets = manifest.mirror?.assets;
  if (!Array.isArray(assets) || assets.length !== 5) {
    throw new Error(
      "historical 1.0.0 immutable authority must inventory version metadata and four archives",
    );
  }
  const paths = new Set();
  const platforms = [];
  for (const asset of assets) {
    assertExactObjectKeys(
      asset,
      asset.kind === "archive"
        ? [
            "kind",
            "platform",
            "path",
            "url",
            "size",
            "sha256",
            "etag",
            "cacheControl",
            "observedAt",
          ]
        : [
            "kind",
            "path",
            "url",
            "size",
            "sha256",
            "etag",
            "cacheControl",
            "observedAt",
          ],
      `historical provider ${asset.kind} asset`,
    );
    validateManifestAsset(asset);
    if (paths.has(asset.path))
      throw new Error(`duplicate mirror path ${asset.path}`);
    paths.add(asset.path);
    if (asset.kind === "archive") platforms.push(asset.platform);
    if (asset.cacheControl !== "public, max-age=31536000, immutable") {
      throw new Error(
        `${asset.path} must retain immutable one-year cache policy`,
      );
    }
  }
  assertExactSet(platforms, REQUIRED_PLATFORMS, "historical archive platforms");
  if (assets.filter((asset) => asset.kind === "version").length !== 1) {
    throw new Error("historical manifest requires exactly one version asset");
  }
  const indexObservation = manifest.mirror?.indexObservation;
  assertExactObjectKeys(
    indexObservation,
    [
      "kind",
      "immutableAuthority",
      "path",
      "url",
      "size",
      "sha256",
      "etag",
      "cacheControl",
      "observedAt",
    ],
    "historical provider index observation",
  );
  validateManifestAsset(indexObservation);
  if (
    indexObservation.kind !== "derived-index-observation" ||
    indexObservation.immutableAuthority !== false ||
    indexObservation.cacheControl !== "no-cache" ||
    basename(indexObservation.path) !== "index.json"
  ) {
    throw new Error(
      "network mirror index must be a mutable derived observation",
    );
  }
  validateIndexEntry(manifest);
  const rejected = manifest.rejectedLocalRebuild?.assets;
  assertExactObjectKeys(
    manifest.rejectedLocalRebuild,
    ["description", "assets"],
    "rejected local provider rebuild",
  );
  assertObject(rejected, "rejected local rebuild assets");
  assertExactSet(
    Object.keys(rejected),
    [...paths, indexObservation.path],
    "rejected local rebuild paths",
  );
  for (const [path, digest] of Object.entries(rejected)) {
    if (!SHA256.test(digest))
      throw new Error(`invalid rejected digest for ${path}`);
  }
  return manifest;
}

export function validateProviderReleaseRegistry(registry) {
  assertExactObjectKeys(
    registry,
    ["schemaVersion", "kind", "providerAddress", "retentionPolicy", "versions"],
    "provider release registry",
  );
  if (
    registry.schemaVersion !== 1 ||
    registry.kind !== "takosumi.provider-release-registry@v1" ||
    registry.providerAddress !== PROVIDER_ADDRESS ||
    registry.retentionPolicy !== "all-known-versions-required" ||
    !Array.isArray(registry.versions) ||
    registry.versions.length === 0
  ) {
    throw new Error("invalid provider release registry");
  }
  const versions = [];
  for (const entry of registry.versions) {
    assertExactObjectKeys(
      entry,
      ["version", "classification", "manifest", "sha256"],
      "provider release registry entry",
    );
    compareSemver(entry.version, entry.version);
    if (
      !["historical-quarantine", "approved"].includes(entry.classification) ||
      safeRelativePath(entry.manifest) !== entry.manifest ||
      !SHA256.test(entry.sha256 ?? "")
    ) {
      throw new Error(
        `invalid provider registry entry ${String(entry.version)}`,
      );
    }
    versions.push(entry.version);
  }
  if (new Set(versions).size !== versions.length) {
    throw new Error("provider release registry contains duplicate versions");
  }
  if (
    !registry.versions.some(
      (entry) =>
        entry.version === "1.0.0" &&
        entry.classification === "historical-quarantine",
    )
  ) {
    throw new Error("provider release registry must retain historical 1.0.0");
  }
  return registry;
}

export async function loadProviderReleaseRegistry(
  registryPath = PROVIDER_REGISTRY_PATH,
) {
  const registrySnapshot = await readAuthorityJsonWithSidecar(
    resolve(registryPath),
    "provider release registry",
  );
  const registry = validateProviderReleaseRegistry(registrySnapshot.value);
  const registryRoot = dirname(resolve(registryPath));
  const manifests = [];
  const manifestPaths = [];
  const manifestDigests = [];
  for (const entry of registry.versions) {
    const manifestPath = join(registryRoot, safeRelativePath(entry.manifest));
    const snapshot = await readAuthorityJsonWithSidecar(
      manifestPath,
      `provider ${entry.version} ${entry.classification} manifest`,
    );
    if (snapshot.sha256 !== entry.sha256) {
      throw new Error(
        `provider registry digest mismatch for ${entry.version}: expected ${entry.sha256}, got ${snapshot.sha256}`,
      );
    }
    if (entry.classification === "historical-quarantine") {
      validateQuarantineManifest(snapshot.value);
    } else {
      throw new Error(
        `approved provider ${entry.version} requires the not-yet-configured artifact-signature/transparency verifier`,
      );
    }
    if (snapshot.value.version !== entry.version) {
      throw new Error(
        `provider registry version mismatch for ${entry.version}`,
      );
    }
    manifests.push(snapshot.value);
    manifestPaths.push(manifestPath);
    manifestDigests.push(snapshot.sha256);
  }
  return {
    registry,
    registryPath: resolve(registryPath),
    registryDigest: registrySnapshot.sha256,
    manifests,
    manifestPaths,
    manifestDigests,
  };
}

export function validateReleaseManifest(manifest) {
  assertObject(manifest, "provider release manifest");
  assertExactObjectKeys(
    manifest,
    [
      "schemaVersion",
      "kind",
      "providerAddress",
      "modulePath",
      "version",
      "tag",
      "sourceCommit",
      "sourceTime",
      "sourceInputs",
      "moduleInventory",
      "protocols",
      "status",
      "publishable",
      "releaseEligibility",
      "tagVerification",
      "reproducible",
      "deterministicBuildsCompared",
      "toolchain",
      "runtimeTrust",
      "build",
      "mirror",
      "supportArtifacts",
      "attestations",
    ],
    "provider release manifest",
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "takosumi.provider-release@v1"
  ) {
    throw new Error("invalid provider release manifest identity");
  }
  if (
    manifest.providerAddress !== PROVIDER_ADDRESS ||
    manifest.modulePath !== "github.com/takosjp/terraform-provider-takosumi"
  ) {
    throw new Error("unexpected provider release identity");
  }
  compareSemver(manifest.version, manifest.version);
  if (manifest.tag !== `provider/v${manifest.version}`) {
    throw new Error("provider release manifest tag/version mismatch");
  }
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? "")) {
    throw new Error(
      "provider release manifest requires an exact source commit",
    );
  }
  if (
    typeof manifest.sourceTime !== "string" ||
    Number.isNaN(Date.parse(manifest.sourceTime)) ||
    new Date(manifest.sourceTime).toISOString() !== manifest.sourceTime
  ) {
    throw new Error("provider release manifest requires sourceTime");
  }
  if (
    manifest.status !== "candidate" ||
    manifest.publishable !== false ||
    manifest.reproducible !== true ||
    manifest.deterministicBuildsCompared !== 2
  ) {
    throw new Error(
      "unreviewed provider artifacts must remain reproducible, non-publishable candidates built twice",
    );
  }
  const tagVerification = manifest.tagVerification;
  assertObject(tagVerification, "provider tag verification");
  if (
    tagVerification.kind === "signed-annotated" &&
    tagVerification.verified === true
  ) {
    if (
      manifest.releaseEligibility !== "candidate-review-required" ||
      tagVerification.tagObjectType !== "tag" ||
      !/^[a-f0-9]{40}$/.test(tagVerification.tagObjectId ?? "") ||
      !/^[A-F0-9]{40,64}$/.test(tagVerification.signerFingerprint ?? "") ||
      !SHA256.test(tagVerification.verificationOutputSha256 ?? "") ||
      tagVerification.verificationCommand !==
        `gpgv --keyring <pinned> ${tagVerification.tagObjectId}`
    ) {
      throw new Error("signed candidate still requires release review");
    }
    assertExactObjectKeys(
      tagVerification,
      [
        "kind",
        "verified",
        "tagObjectType",
        "tagObjectId",
        "signerFingerprint",
        "verificationCommand",
        "verificationOutputSha256",
      ],
      "signed provider tag verification",
    );
  } else if (
    tagVerification.kind === "test-only-unsigned" &&
    tagVerification.verified === false
  ) {
    if (
      manifest.releaseEligibility !== "test-only" ||
      !["commit", "tag"].includes(tagVerification.tagObjectType) ||
      !/^[a-f0-9]{40}$/.test(tagVerification.tagObjectId ?? "")
    ) {
      throw new Error("unsigned provider artifacts must remain test-only");
    }
    assertExactObjectKeys(
      tagVerification,
      ["kind", "verified", "tagObjectType", "tagObjectId"],
      "unsigned provider tag verification",
    );
  } else {
    throw new Error(
      "provider source tag is not verified by an accepted policy",
    );
  }

  validateManifestToolchain(manifest.toolchain);
  validateRuntimeTrust(manifest.runtimeTrust);
  assertExactObjectKeys(
    manifest.sourceInputs,
    ["goModSha256", "goSumSha256"],
    "provider source inputs",
  );
  if (
    !SHA256.test(manifest.sourceInputs?.goModSha256 ?? "") ||
    !SHA256.test(manifest.sourceInputs?.goSumSha256 ?? "")
  ) {
    throw new Error("provider source input digests are invalid");
  }
  validateModuleInventory(manifest.moduleInventory, manifest.modulePath);
  assertExactObjectKeys(
    manifest.build,
    ["flags", "ldflags", "cgoEnabled", "archiveTimestampUtc"],
    "provider build contract",
  );
  if (
    JSON.stringify(manifest.build?.flags) !==
      JSON.stringify(["-trimpath", "-buildvcs=false", "-mod=readonly"]) ||
    manifest.build?.ldflags !==
      `-buildid= -X main.version=${manifest.version}` ||
    manifest.build?.cgoEnabled !== false ||
    manifest.build?.archiveTimestampUtc !== "1980-01-01T00:00:00Z"
  ) {
    throw new Error("provider release manifest has an invalid build contract");
  }
  const protocols = manifest.protocols;
  if (JSON.stringify(protocols) !== JSON.stringify(["5.0"])) {
    throw new Error("provider release manifest protocol must be exactly 5.0");
  }
  const indexEntry = validateIndexEntry(manifest);
  if (JSON.stringify(protocols) !== JSON.stringify(indexEntry.protocols)) {
    throw new Error("provider release protocol/index mismatch");
  }

  const assets = manifest.mirror?.assets;
  assertExactObjectKeys(
    manifest.mirror,
    ["indexEntry", "derivedIndex", "assets"],
    "provider release mirror",
  );
  if (!Array.isArray(assets) || assets.length !== 5) {
    throw new Error("provider release requires one version and four archives");
  }
  const paths = new Set();
  const platforms = [];
  for (const asset of assets) {
    assertObject(asset, "provider release asset");
    assertExactObjectKeys(
      asset,
      asset.kind === "archive"
        ? [
            "kind",
            "platform",
            "path",
            "artifactPath",
            "size",
            "sha256",
            "cacheControl",
            "binaryVersion",
            "binaryBuildInfoSha256",
          ]
        : ["kind", "path", "artifactPath", "size", "sha256", "cacheControl"],
      "provider release asset",
    );
    safeRelativePath(asset.path);
    safeRelativePath(asset.artifactPath);
    if (
      !asset.path.startsWith(`${PROVIDER_ADDRESS}/`) ||
      asset.artifactPath !== `mirror/${asset.path}` ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      !SHA256.test(asset.sha256 ?? "") ||
      asset.cacheControl !== "public, max-age=31536000, immutable"
    ) {
      throw new Error(`invalid provider release asset ${String(asset.path)}`);
    }
    if (paths.has(asset.path)) {
      throw new Error(`duplicate provider mirror path ${asset.path}`);
    }
    paths.add(asset.path);
    if (asset.kind === "version") {
      if (asset.path !== `${PROVIDER_ADDRESS}/${manifest.version}.json`) {
        throw new Error("provider version document path/version mismatch");
      }
    } else if (asset.kind === "archive") {
      const platform =
        asset.platform ?? platformFromArchive(asset.path, manifest.version);
      if (
        asset.binaryVersion !== manifest.version ||
        !SHA256.test(asset.binaryBuildInfoSha256 ?? "") ||
        basename(asset.path) !==
          `terraform-provider-takosumi_${manifest.version}_${platform}.zip`
      ) {
        throw new Error(`provider archive version mismatch ${asset.path}`);
      }
      platforms.push(platform);
    } else {
      throw new Error(`invalid provider release asset kind ${asset.kind}`);
    }
  }
  if (assets.filter((asset) => asset.kind === "version").length !== 1) {
    throw new Error("provider release requires exactly one version document");
  }
  assertExactSet(platforms, REQUIRED_PLATFORMS, "provider release platforms");

  const derivedIndex = manifest.mirror?.derivedIndex;
  assertObject(derivedIndex, "provider derived index");
  assertExactObjectKeys(
    derivedIndex,
    [
      "kind",
      "immutableAuthority",
      "path",
      "artifactPath",
      "size",
      "sha256",
      "cacheControl",
    ],
    "provider derived index",
  );
  if (
    derivedIndex.kind !== "derived-index" ||
    derivedIndex.immutableAuthority !== false ||
    derivedIndex.path !== `${PROVIDER_ADDRESS}/index.json` ||
    derivedIndex.artifactPath !== `mirror/${derivedIndex.path}` ||
    !Number.isSafeInteger(derivedIndex.size) ||
    derivedIndex.size <= 0 ||
    !SHA256.test(derivedIndex.sha256 ?? "") ||
    derivedIndex.cacheControl !== "no-cache"
  ) {
    throw new Error("invalid provider derived index evidence");
  }
  verifyDerivedIndexEvidence(manifest);

  const supportArtifacts = manifest.supportArtifacts;
  if (!Array.isArray(supportArtifacts)) {
    throw new Error("provider release requires support artifacts");
  }
  assertExactSet(
    supportArtifacts.map((artifact) => artifact.path),
    ["checksums.txt", "sbom.spdx.json", "provenance.intoto.json"],
    "provider support artifacts",
  );
  for (const artifact of supportArtifacts) {
    assertExactObjectKeys(
      artifact,
      ["path", "size", "sha256"],
      "provider support artifact",
    );
    safeRelativePath(artifact.path);
    if (
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0 ||
      !SHA256.test(artifact.sha256 ?? "")
    ) {
      throw new Error(`invalid provider support artifact ${artifact.path}`);
    }
  }
  if (
    manifest.attestations?.sbom !== "sbom.spdx.json" ||
    manifest.attestations?.provenance !== "provenance.intoto.json" ||
    manifest.attestations?.signature !== null ||
    manifest.attestations?.transparencyLog !== null
  ) {
    throw new Error(
      "candidate provider attestations must expose unsigned review seams",
    );
  }
  assertExactObjectKeys(
    manifest.attestations,
    ["sbom", "provenance", "signature", "transparencyLog"],
    "provider attestations",
  );
  return manifest;
}

function validateRuntimeTrust(runtimeTrust) {
  assertObject(runtimeTrust, "provider runtime trust");
  assertExactObjectKeys(runtimeTrust, ["files"], "provider runtime trust");
  if (!Array.isArray(runtimeTrust.files) || runtimeTrust.files.length === 0) {
    throw new Error("provider runtime trust requires pinned files");
  }
  const paths = [];
  for (const file of runtimeTrust.files) {
    assertExactObjectKeys(file, ["path", "sha256"], "provider runtime file");
    if (!isAbsolute(file.path ?? "") || !SHA256.test(file.sha256 ?? "")) {
      throw new Error("invalid provider runtime trust file");
    }
    paths.push(file.path);
  }
  if (new Set(paths).size !== paths.length) {
    throw new Error("provider runtime trust contains duplicate paths");
  }
}

function validateModuleInventory(modules, modulePath) {
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new Error("provider module inventory is empty");
  }
  const paths = [];
  for (const module of modules) {
    assertExactObjectKeys(
      module,
      ["path", "version", "sum", "main"],
      "provider module inventory entry",
    );
    if (
      typeof module.path !== "string" ||
      !module.path ||
      typeof module.version !== "string" ||
      !module.version ||
      ![true, false].includes(module.main) ||
      !(module.sum === null || /^h1:[A-Za-z0-9+/=]+$/.test(module.sum))
    ) {
      throw new Error(
        `invalid provider module inventory entry ${String(module.path)}`,
      );
    }
    paths.push(module.path);
  }
  if (new Set(paths).size !== paths.length) {
    throw new Error("provider module inventory contains duplicate paths");
  }
  if (
    modules.filter((module) => module.main).length !== 1 ||
    !modules.some(
      (module) =>
        module.main &&
        module.path === modulePath &&
        module.version === "source" &&
        module.sum === null,
    )
  ) {
    throw new Error("provider module inventory has an invalid main module");
  }
  const sorted = [...paths].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(paths) !== JSON.stringify(sorted)) {
    throw new Error("provider module inventory must be sorted");
  }
}

function validateManifestToolchain(toolchain) {
  assertObject(toolchain, "provider release toolchain");
  assertExactObjectKeys(
    toolchain,
    ["go", "zip", "unzip", "git", "gpgv"],
    "provider release toolchain",
  );
  for (const [name, version] of [
    ["go", "go1.26.0"],
    ["zip", "Info-ZIP 3.0"],
    ["unzip", "Info-ZIP UnZip 6.00"],
    ["git", "git version 2.53.0"],
    ["gpgv", "gpgv (GnuPG) 2.4.8"],
  ]) {
    const executable = toolchain[name];
    assertExactObjectKeys(
      executable,
      name === "go"
        ? [
            "version",
            "path",
            "sha256",
            "distributionRoot",
            "distributionSha256",
          ]
        : ["version", "path", "sha256"],
      `provider ${name} toolchain evidence`,
    );
    if (
      executable?.version !== version ||
      !isAbsolute(executable.path ?? "") ||
      !SHA256.test(executable.sha256 ?? "")
    ) {
      throw new Error(`invalid provider ${name} toolchain evidence`);
    }
  }
  if (
    !isAbsolute(toolchain.go.distributionRoot ?? "") ||
    !SHA256.test(toolchain.go.distributionSha256 ?? "")
  ) {
    throw new Error("invalid Go distribution evidence");
  }
}

function validateManifestAsset(asset) {
  assertObject(asset, "provider mirror asset");
  safeRelativePath(asset.path);
  if (!asset.path.startsWith(`${PROVIDER_ADDRESS}/`)) {
    throw new Error(`mirror asset escapes provider address: ${asset.path}`);
  }
  const expectedUrl = `https://app.takosumi.com/opentofu/providers/${asset.path}`;
  if (asset.url !== expectedUrl)
    throw new Error(`unexpected source URL for ${asset.path}`);
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error(`invalid size for ${asset.path}`);
  }
  if (!SHA256.test(asset.sha256 ?? "")) {
    throw new Error(`invalid sha256 for ${asset.path}`);
  }
  if (typeof asset.etag !== "string" || !/^"[a-f0-9]+"$/.test(asset.etag)) {
    throw new Error(`missing observed ETag for ${asset.path}`);
  }
  if (
    typeof asset.observedAt !== "string" ||
    Number.isNaN(Date.parse(asset.observedAt))
  ) {
    throw new Error(`invalid observedAt for ${asset.path}`);
  }
}

export async function verifyProviderReleaseSource({
  repoRoot = PROVIDER_RELEASE_ROOT,
  descriptorPath = join(repoRoot, "provider", "release", "version.json"),
  quarantinePath = join(
    repoRoot,
    "provider",
    "release",
    "quarantine",
    "1.0.0.json",
  ),
  registryPath = join(repoRoot, "provider", "release", "registry.json"),
} = {}) {
  const descriptorSnapshot = await readAuthorityJsonWithSidecar(
    descriptorPath,
    "provider release descriptor",
  );
  const descriptor = validateVersionDescriptor(descriptorSnapshot.value);
  const compatibility = await loadCompatibilityAuthorities();
  if (compatibility.policy.candidate.version !== descriptor.version) {
    throw new Error(
      "provider compatibility policy candidate does not match release descriptor",
    );
  }
  const loadedRegistry = await loadProviderReleaseRegistry(registryPath);
  const quarantineIndex = loadedRegistry.manifestPaths.indexOf(
    resolve(quarantinePath),
  );
  if (quarantineIndex < 0) {
    throw new Error(
      "provider registry does not retain the canonical quarantine path",
    );
  }
  const quarantine = loadedRegistry.manifests[quarantineIndex];
  const quarantineDigest = loadedRegistry.manifestDigests[quarantineIndex];
  const packageVersion = String(
    (await readJson(join(repoRoot, "package.json"))).version ?? "",
  );
  if (descriptor.version === quarantine.version) {
    throw new Error(
      "corrected provider candidate must not reuse historical 1.0.0",
    );
  }

  const localMirrorRoot = join(
    repoRoot,
    "dashboard",
    "public",
    "opentofu",
    "providers",
  );
  const localAssets = await verifyLocalProviderMirrorSources({
    repoRoot,
    localMirrorRoot,
    manifest: quarantine,
  });

  const retiredBuilder = await readFile(
    join(repoRoot, "scripts", "build-provider-assets.mjs"),
    "utf8",
  );
  if (/\bgo\s+build\b/.test(retiredBuilder)) {
    throw new Error("the normal provider:assets path must not invoke go build");
  }

  return {
    providerVersion: descriptor.version,
    providerTag: descriptor.tag,
    descriptorDigest: descriptorSnapshot.sha256,
    registryDigest: loadedRegistry.registryDigest,
    packageVersion,
    quarantineVersion: quarantine.version,
    quarantineManifestDigest: quarantineDigest,
    publicationStatus: descriptor.publicationPolicy.status,
    publicationReady: false,
    publicationBlockers: [
      "reviewed signer fingerprint and key custody",
      "artifact signature and transparency log",
      "public version-path nonexistence or exact-byte readback",
      "OpenTofu/Terraform provider address proof",
    ],
    compatibilityPolicy: {
      identityDigest: compatibility.identityDigest,
      policyDigest: compatibility.policyDigest,
      patchFeatureDecision: compatibility.policy.patchFeatureDecision.status,
      releaseEligibility: compatibility.policy.releaseEligibility,
    },
    localAssets,
  };
}

export async function verifyLocalProviderMirrorSources({
  repoRoot = PROVIDER_RELEASE_ROOT,
  localMirrorRoot = join(
    repoRoot,
    "dashboard",
    "public",
    "opentofu",
    "providers",
  ),
  manifest,
  checkTracked = true,
}) {
  const localAssets = [];
  if (!(await exists(localMirrorRoot))) return localAssets;
  const approvedAssets = new Map(
    [manifest.mirror.indexObservation ?? manifest.mirror.derivedIndex]
      .filter(Boolean)
      .concat(manifest.mirror.assets)
      .map((asset) => [asset.path, asset]),
  );
  for (const path of await listTree(localMirrorRoot)) {
    const normalizedPath = path.split(sep).join("/");
    if (normalizedPath === "README.md") continue;
    const asset = approvedAssets.get(normalizedPath);
    if (!asset) {
      throw new Error(
        `provider public source contains an unreviewed mirror path: ${normalizedPath}`,
      );
    }
    const localPath = join(localMirrorRoot, path);
    if (checkTracked) {
      const tracked = command(
        "git",
        ["ls-files", "--", relative(repoRoot, localPath)],
        {
          cwd: repoRoot,
        },
      ).stdout.trim();
      if (tracked) {
        throw new Error(
          `versioned provider mirror bytes must not be tracked: ${tracked}`,
        );
      }
    }
    const bytes = await readFile(localPath);
    const digest = sha256(bytes);
    if (bytes.length !== asset.size || digest !== asset.sha256) {
      throw new Error(
        `provider public source contains rejected or unreviewed bytes at ${asset.path}: ${digest}`,
      );
    }
    localAssets.push({
      path: asset.path,
      digest,
      classification: "exact-public",
    });
  }
  return localAssets;
}

export async function materializeProviderMirror({
  outputRoot,
  registryPath = PROVIDER_REGISTRY_PATH,
  manifestPath,
  manifestPaths,
  artifactRoot,
  cacheRoot = join(tmpdir(), "takosumi-provider-artifact-cache-v1"),
  fetchImpl = fetch,
  testOnlyAllowUnsignedManifest = false,
  testOnlyAllowUnapprovedManifest = false,
} = {}) {
  if (!outputRoot) throw new Error("materialize requires outputRoot");
  let selectedManifestPaths;
  let manifests;
  let manifestDigests;
  let registryDigest;
  if (manifestPath || manifestPaths) {
    if (
      !testOnlyAllowUnapprovedManifest ||
      process.env.TAKOSUMI_PROVIDER_RELEASE_TEST_ALLOW_UNAPPROVED_MANIFEST !==
        "1"
    ) {
      throw new Error(
        "candidate manifests are review bundles only; hosted mirrors require the approved registry",
      );
    }
    selectedManifestPaths = (manifestPaths ?? [manifestPath]).map((path) =>
      resolve(path),
    );
    manifests = [];
    manifestDigests = [];
    for (const path of selectedManifestPaths) {
      const snapshot = await readAuthorityJsonWithSidecar(
        path,
        "test-only provider manifest",
      );
      manifestDigests.push(snapshot.sha256);
      const manifest = normalizeManifest(snapshot.value);
      if (
        manifest.releaseEligibility === "test-only" &&
        !testOnlyAllowUnsignedManifest
      ) {
        throw new Error("test-only unsigned provider manifest was not enabled");
      }
      manifests.push(manifest);
    }
  } else {
    const loaded = await loadProviderReleaseRegistry(registryPath);
    selectedManifestPaths = loaded.manifestPaths;
    manifests = loaded.manifests;
    manifestDigests = loaded.manifestDigests;
    registryDigest = loaded.registryDigest;
  }
  if (manifests.length === 0) {
    throw new Error(
      "materialize requires at least one registered provider version",
    );
  }
  rejectDuplicateVersions(manifests);
  if (artifactRoot) {
    const releaseManifestEntries = manifests
      .map((manifest, index) => ({
        manifest,
        path: selectedManifestPaths[index],
      }))
      .filter(
        ({ manifest }) => manifest.kind === "takosumi.provider-release@v1",
      );
    if (releaseManifestEntries.length > 1) {
      throw new Error(
        "one artifact root cannot supply multiple release bundles",
      );
    }
    if (releaseManifestEntries.length === 1) {
      const verification = await verifyProviderReleaseBundle({
        bundleRoot: resolve(artifactRoot),
        testOnlyAllowUnsignedManifest,
      });
      const selectedIndex = selectedManifestPaths.indexOf(
        releaseManifestEntries[0].path,
      );
      if (verification.manifestDigest !== manifestDigests[selectedIndex]) {
        throw new Error(
          "provider artifact root manifest does not match the selected manifest",
        );
      }
    }
  }
  const providerAddresses = [
    ...new Set(manifests.map((manifest) => manifest.providerAddress)),
  ];
  if (providerAddresses.length !== 1) {
    throw new Error(
      "one materialization may contain only one provider address",
    );
  }
  const assets = manifests.flatMap(normalizeManifestAssets);
  rejectDuplicateAssets(assets);
  const resolvedOutput = resolve(outputRoot);
  const resolvedCache = resolve(cacheRoot);
  await assertNoSymlinkPathComponents(resolvedOutput, "provider mirror output");
  await assertNoSymlinkPathComponents(resolvedCache, "provider mirror cache");
  await mkdir(dirname(resolvedOutput), { recursive: true });
  const stagingOutput = await mkdtemp(
    join(dirname(resolvedOutput), `.${basename(resolvedOutput)}.staging-`),
  );
  await chmod(stagingOutput, 0o700);
  await mkdir(resolvedCache, { recursive: true });
  let promoted = false;
  try {
    for (const asset of assets) {
      const destination = join(stagingOutput, safeRelativePath(asset.path));
      await mkdir(dirname(destination), { recursive: true });
      let source;
      if (artifactRoot && asset.artifactPath) {
        source = join(
          resolve(artifactRoot),
          safeRelativePath(asset.artifactPath),
        );
        await verifyFile(source, asset);
      } else {
        const cachePath = join(resolvedCache, asset.sha256);
        if (await exists(cachePath)) {
          try {
            await verifyFile(cachePath, asset);
            source = cachePath;
          } catch {
            await rm(cachePath, { force: true });
          }
        }
        if (!source) {
          if (!asset.url) {
            throw new Error(
              `${asset.path} has no reviewed URL and no local artifact root`,
            );
          }
          const bytes = await fetchReviewedProviderAsset({
            asset,
            fetchImpl,
            testOnlyAllowArbitraryOrigin: testOnlyAllowUnapprovedManifest,
          });
          verifyBytes(bytes, asset);
          await writeFile(cachePath, bytes, { flag: "wx" }).catch(
            async (error) => {
              if (error?.code !== "EEXIST") throw error;
              await verifyFile(cachePath, asset);
            },
          );
          source = cachePath;
        }
      }
      await copyFile(source, destination);
      await verifyFile(destination, asset);
    }

    const indexPath = join(stagingOutput, providerAddresses[0], "index.json");
    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, derivedIndexBytes(manifests), { flag: "wx" });
    await verifyNetworkMirrorLayout(stagingOutput, manifests);
    if (await exists(resolvedOutput)) {
      const info = await lstat(resolvedOutput);
      if (info.isSymbolicLink())
        throw new Error(`refusing symlink output root ${resolvedOutput}`);
      await rm(resolvedOutput, { recursive: true, force: true });
    }
    await rename(stagingOutput, resolvedOutput);
    promoted = true;
    return {
      outputRoot: resolvedOutput,
      registryPath:
        manifestPath || manifestPaths ? null : resolve(registryPath),
      registryDigest: registryDigest ?? null,
      manifestPaths: selectedManifestPaths,
      manifestDigests,
      versions: manifests.map((manifest) => manifest.version),
      assets: assets.map(({ path, size, sha256: digest }) => ({
        path,
        size,
        sha256: digest,
      })),
    };
  } finally {
    if (!promoted) await rm(stagingOutput, { recursive: true, force: true });
  }
}

function normalizeManifest(manifest) {
  validateIndexEntry(manifest);
  verifyDerivedIndexEvidence(manifest);
  normalizeManifestAssets(manifest);
  return manifest;
}

async function fetchReviewedProviderAsset({
  asset,
  fetchImpl,
  testOnlyAllowArbitraryOrigin,
}) {
  let currentUrl = new URL(asset.url);
  const validateUrl = (url) => {
    if (url.protocol !== "https:") {
      throw new Error(`provider asset URL must use HTTPS: ${url}`);
    }
    if (
      !testOnlyAllowArbitraryOrigin &&
      (url.origin !== PUBLIC_MIRROR_ORIGIN ||
        !url.pathname.startsWith(PUBLIC_MIRROR_PREFIX))
    ) {
      throw new Error(
        `provider asset URL is outside the reviewed mirror: ${url}`,
      );
    }
  };
  validateUrl(currentUrl);
  let response;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    response = await fetchImpl(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
      headers: { "user-agent": "takosumi-provider-mirror-materializer/1" },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location || redirects === 3) {
      throw new Error(
        `provider asset redirect was not bounded for ${asset.path}`,
      );
    }
    currentUrl = new URL(location, currentUrl);
    validateUrl(currentUrl);
  }
  if (!response?.ok) {
    throw new Error(
      `provider asset fetch failed ${response?.status ?? "unknown"} for ${currentUrl}`,
    );
  }
  if (response.url) validateUrl(new URL(response.url));
  const cacheControl = response.headers.get("cache-control");
  if (asset.cacheControl && cacheControl !== asset.cacheControl) {
    throw new Error(
      `cache policy mismatch for ${asset.path}: expected ${asset.cacheControl}, got ${cacheControl}`,
    );
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) !== asset.size)
  ) {
    throw new Error(`content-length mismatch for ${asset.path}`);
  }
  if (asset.size > MAX_PROVIDER_ASSET_BYTES) {
    throw new Error(`${asset.path} exceeds the provider asset size ceiling`);
  }
  if (!response.body)
    throw new Error(`provider asset response has no body: ${asset.path}`);
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > asset.size || total > MAX_PROVIDER_ASSET_BYTES) {
      await reader.cancel("provider asset exceeded reviewed size");
      throw new Error(
        `${asset.path} exceeded its reviewed size while streaming`,
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function normalizeManifestAssets(manifest) {
  if (manifest.kind === "takosumi.provider-release-quarantine@v1") {
    validateQuarantineManifest(manifest);
    return manifest.mirror.assets;
  }
  if (manifest.kind === "takosumi.provider-release@v1") {
    return validateReleaseManifest(manifest).mirror.assets.map((asset) => ({
      ...asset,
      url: `${PUBLIC_MIRROR_ORIGIN}${PUBLIC_MIRROR_PREFIX}${asset.path}`,
    }));
  }
  throw new Error(
    `unsupported provider manifest kind ${String(manifest.kind)}`,
  );
}

function validateIndexEntry(manifest) {
  const entry = manifest.mirror?.indexEntry;
  assertObject(entry, `provider ${manifest.version} indexEntry`);
  assertExactObjectKeys(
    entry,
    ["protocols", "platforms"],
    `provider ${manifest.version} indexEntry`,
  );
  if (!Array.isArray(entry.protocols) || entry.protocols.length === 0) {
    throw new Error(
      `provider ${manifest.version} indexEntry requires protocols`,
    );
  }
  if (!Array.isArray(entry.platforms) || entry.platforms.length === 0) {
    throw new Error(
      `provider ${manifest.version} indexEntry requires platforms`,
    );
  }
  const indexedPlatforms = entry.platforms.map(platformKey);
  for (const platform of entry.platforms) {
    assertExactObjectKeys(
      platform,
      ["os", "arch"],
      `provider ${manifest.version} index platform`,
    );
  }
  const archivePlatforms = (manifest.mirror?.assets ?? [])
    .filter((asset) => asset.kind === "archive")
    .map(
      (asset) =>
        asset.platform ?? platformFromArchive(asset.path, manifest.version),
    );
  assertExactSet(
    indexedPlatforms,
    archivePlatforms,
    `provider ${manifest.version} indexEntry/archive platforms`,
  );
  return entry;
}

function verifyDerivedIndexEvidence(manifest) {
  const evidence =
    manifest.mirror?.indexObservation ?? manifest.mirror?.derivedIndex;
  if (!evidence) return;
  const bytes = derivedIndexBytes([manifest]);
  if (evidence.size !== bytes.length || evidence.sha256 !== sha256(bytes)) {
    throw new Error(
      `derived index evidence mismatch for provider ${manifest.version}`,
    );
  }
  if (evidence.cacheControl !== "no-cache") {
    throw new Error("derived provider index must remain revalidated");
  }
}

function derivedIndexBytes(manifests) {
  const versions = {};
  for (const manifest of [...manifests].sort((a, b) =>
    compareSemver(a.version, b.version),
  )) {
    const entry = manifest.mirror.indexEntry;
    versions[manifest.version] = {
      protocols: [...entry.protocols],
      platforms: entry.platforms.map((platform) => ({
        os: platform.os,
        arch: platform.arch,
      })),
    };
  }
  return Buffer.from(`${JSON.stringify({ versions }, null, 2)}\n`);
}

function rejectDuplicateVersions(manifests) {
  const versions = new Set();
  for (const manifest of manifests) {
    if (versions.has(manifest.version)) {
      throw new Error(`duplicate provider version ${manifest.version}`);
    }
    versions.add(manifest.version);
  }
}

function rejectDuplicateAssets(assets) {
  const paths = new Set();
  for (const asset of assets) {
    if (paths.has(asset.path))
      throw new Error(`duplicate provider mirror path ${asset.path}`);
    paths.add(asset.path);
  }
}

export async function verifyNetworkMirrorLayout(root, manifestOrManifests) {
  const manifests = Array.isArray(manifestOrManifests)
    ? manifestOrManifests
    : [manifestOrManifests];
  rejectDuplicateVersions(manifests);
  const providerAddress = manifests[0]?.providerAddress;
  if (!providerAddress)
    throw new Error("mirror verification requires a manifest");
  if (
    manifests.some((manifest) => manifest.providerAddress !== providerAddress)
  ) {
    throw new Error("mirror verification provider addresses differ");
  }
  const normalizedAssets = manifests.map(normalizeManifestAssets);
  const providerRoot = join(root, providerAddress);
  const actualFiles = await listTree(root);
  const expectedFiles = [
    `${providerAddress}/index.json`,
    ...normalizedAssets.flat().map((asset) => asset.path),
  ];
  assertExactSet(
    actualFiles,
    expectedFiles,
    "provider network mirror exact file inventory",
  );
  for (const asset of normalizedAssets.flat()) {
    await verifyFile(join(root, asset.path), asset);
  }
  const indexPath = join(providerRoot, "index.json");
  const index = await readJson(indexPath);
  const expectedIndexBytes = derivedIndexBytes(manifests);
  const actualIndexBytes = await readFile(indexPath);
  if (!actualIndexBytes.equals(expectedIndexBytes)) {
    throw new Error(
      "network mirror index is not the deterministic manifest merge",
    );
  }

  const versions = [];
  for (const [manifestIndex, manifest] of manifests.entries()) {
    const version = manifest.version;
    const versionMetadata = await readJson(
      join(providerRoot, `${version}.json`),
    );
    const indexVersion = index.versions?.[version];
    if (!indexVersion) {
      throw new Error(`mirror index omits provider version ${version}`);
    }
    if (
      JSON.stringify(indexVersion.protocols) !==
      JSON.stringify(manifest.mirror.indexEntry.protocols)
    ) {
      throw new Error(`mirror index protocol mismatch for ${version}`);
    }
    const indexedPlatforms = indexVersion.platforms?.map(platformKey) ?? [];
    const archiveAssets = normalizedAssets[manifestIndex].filter(
      (asset) => asset.kind === "archive",
    );
    const archivePlatforms = archiveAssets.map(
      (asset) => asset.platform ?? platformFromArchive(asset.path, version),
    );
    assertExactSet(
      indexedPlatforms,
      archivePlatforms,
      `${version} index/archive platforms`,
    );
    const metadataPlatforms = Object.keys(versionMetadata.archives ?? {});
    assertExactSet(
      metadataPlatforms,
      archivePlatforms,
      `${version} version/archive platforms`,
    );
    for (const asset of archiveAssets) {
      const platform =
        asset.platform ?? platformFromArchive(asset.path, version);
      const expectedName = `terraform-provider-takosumi_${version}_${platform}.zip`;
      if (basename(asset.path) !== expectedName) {
        throw new Error(`archive version/path mismatch: ${asset.path}`);
      }
      const metadata = versionMetadata.archives[platform];
      if (
        metadata.url !== expectedName ||
        JSON.stringify(metadata.hashes) !==
          JSON.stringify([`zh:${asset.sha256}`])
      ) {
        throw new Error(`version metadata mismatch for ${platform}`);
      }
      await verifyFile(join(providerRoot, expectedName), asset);
    }
    versions.push({ version, platforms: archivePlatforms });
  }
  return { providerAddress, versions };
}

export async function verifyProviderReleaseBundle({
  bundleRoot,
  manifestPath,
  testOnlyAllowUnsignedManifest = false,
} = {}) {
  if (!bundleRoot)
    throw new Error("provider bundle verification requires root");
  const root = resolve(bundleRoot);
  await assertNoSymlinkPathComponents(root, "provider release bundle");
  const expectedManifestPath = join(root, "release-manifest.json");
  if (manifestPath && resolve(manifestPath) !== expectedManifestPath) {
    throw new Error("provider release manifest must be at the bundle root");
  }
  const authority = await readAuthorityJsonWithSidecar(
    expectedManifestPath,
    "provider release manifest",
  );
  const manifest = validateReleaseManifest(authority.value);
  const expectedFiles = [
    "release-manifest.json",
    "release-manifest.json.sha256",
    ...manifest.supportArtifacts.map((artifact) => artifact.path),
    "mirror/" + manifest.mirror.derivedIndex.path,
    ...manifest.mirror.assets.map((asset) => asset.artifactPath),
  ];
  const initialInventory = await listTree(root);
  assertExactSet(
    initialInventory,
    expectedFiles,
    "provider release bundle exact file inventory",
  );
  const snapshotRoot = await mkdtemp(
    join(tmpdir(), "takosumi-provider-bundle-snapshot-"),
  );
  await chmod(snapshotRoot, 0o700);
  try {
    await writePrivateSnapshot(
      snapshotRoot,
      "release-manifest.json",
      authority.bytes,
    );
    await writePrivateSnapshot(
      snapshotRoot,
      "release-manifest.json.sha256",
      authority.sidecarBytes,
    );
    for (const path of expectedFiles.slice(2)) {
      const snapshot = await readFileSnapshot(
        join(root, path),
        `provider release bundle ${path}`,
      );
      await writePrivateSnapshot(snapshotRoot, path, snapshot.bytes);
    }
    const finalInventory = await listTree(root);
    if (JSON.stringify(initialInventory) !== JSON.stringify(finalInventory)) {
      throw new Error(
        "provider release bundle inventory changed while snapshotting",
      );
    }
    return await verifyPrivateProviderReleaseBundle({
      root: snapshotRoot,
      manifest,
      manifestDigestValue: authority.sha256,
      testOnlyAllowUnsignedManifest,
    });
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true });
  }
}

async function writePrivateSnapshot(root, path, bytes) {
  const destination = join(root, safeRelativePath(path));
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
}

async function verifyPrivateProviderReleaseBundle({
  root,
  manifest,
  manifestDigestValue,
  testOnlyAllowUnsignedManifest,
}) {
  if (
    manifest.releaseEligibility === "test-only" &&
    !testOnlyAllowUnsignedManifest
  ) {
    throw new Error("test-only unsigned provider bundle is not releasable");
  }
  for (const artifact of manifest.supportArtifacts) {
    await verifyFile(join(root, artifact.path), artifact);
  }
  await verifyNetworkMirrorLayout(join(root, "mirror"), manifest);

  const expectedChecksums = manifest.mirror.assets
    .map((asset) => `${asset.sha256}  ${basename(asset.path)}`)
    .sort()
    .join("\n");
  const checksums = (
    await readFile(join(root, "checksums.txt"), "utf8")
  ).trim();
  if (checksums !== expectedChecksums) {
    throw new Error(
      "provider release checksums.txt does not match the manifest",
    );
  }

  const sbom = await readJson(join(root, manifest.attestations.sbom));
  const expectedSbom = createSbom({
    descriptor: manifest,
    sourceCommit: manifest.sourceCommit,
    sourceTime: manifest.sourceTime,
    modules: manifest.moduleInventory,
  });
  if (stableJson(sbom) !== stableJson(expectedSbom)) {
    throw new Error(
      "provider release SBOM does not exactly match the reviewed module inventory",
    );
  }

  const provenance = await readJson(
    join(root, manifest.attestations.provenance),
  );
  const expectedProvenance = createProvenance({
    descriptor: {
      ...manifest,
      platforms: manifest.mirror.indexEntry.platforms,
      releasePolicy: {
        buildFlags: manifest.build.flags,
        ldflags: manifest.build.ldflags,
      },
    },
    sourceCommit: manifest.sourceCommit,
    sourceTime: manifest.sourceTime,
    toolchain: manifest.toolchain,
    mirrorAssets: manifest.mirror.assets,
    sourceInputs: manifest.sourceInputs,
  });
  if (stableJson(provenance) !== stableJson(expectedProvenance)) {
    throw new Error(
      "provider release provenance does not exactly bind the reviewed inputs and artifacts",
    );
  }

  verifyToolchainExecutableDigests(manifest.toolchain, manifest.runtimeTrust);
  const extractRoot = await mkdtemp(join(tmpdir(), "takosumi-provider-check-"));
  try {
    for (const asset of manifest.mirror.assets.filter(
      (entry) => entry.kind === "archive",
    )) {
      const binaryName = `terraform-provider-takosumi_v${manifest.version}`;
      const archivePath = join(root, asset.artifactPath);
      const entries = command(
        manifest.toolchain.unzip.path,
        ["-Z1", archivePath],
        { cwd: root },
      )
        .stdout.trim()
        .split("\n")
        .filter(Boolean);
      assertExactSet(entries, [binaryName], `${asset.path} archive entries`);
      const binaryPath = join(extractRoot, `${asset.platform}-${binaryName}`);
      await writeFile(
        binaryPath,
        binaryCommand(manifest.toolchain.unzip.path, [
          "-p",
          archivePath,
          binaryName,
        ]),
        { flag: "wx", mode: 0o600 },
      );
      const reportedVersion = command(
        manifest.toolchain.go.path,
        [
          "run",
          join(
            PROVIDER_RELEASE_ROOT,
            "provider",
            "release",
            "inspect-version.go",
          ),
          binaryPath,
        ],
        {
          cwd: root,
          env: hermeticGoEnvironment(process.env),
        },
      ).stdout.trim();
      if (reportedVersion !== manifest.version) {
        throw new Error(
          `${asset.path} binary reports ${reportedVersion}, expected ${manifest.version}`,
        );
      }
      const buildInfo = normalizeGoBuildInfo(
        command(manifest.toolchain.go.path, ["version", "-m", binaryPath], {
          cwd: root,
          env: hermeticToolEnvironment(extractRoot),
        }).stdout,
      );
      if (sha256(Buffer.from(buildInfo)) !== asset.binaryBuildInfoSha256) {
        throw new Error(`${asset.path} binary build metadata digest mismatch`);
      }
      validateGoBuildInfo(buildInfo, manifest, asset);
    }
  } finally {
    await rm(extractRoot, { recursive: true, force: true });
  }

  return {
    manifestDigest: manifestDigestValue,
    version: manifest.version,
    releaseEligibility: manifest.releaseEligibility,
    publicationReady: false,
    publicationBlockers: [
      "artifact signature review",
      "transparency log",
      "public version-path nonexistence or exact-byte readback",
    ],
  };
}

export async function verifyProviderPrepublication({
  bundleRoot,
  fetchImpl = fetch,
  testOnlyAllowUnsignedManifest = false,
} = {}) {
  const bundle = await verifyProviderReleaseBundle({
    bundleRoot,
    testOnlyAllowUnsignedManifest,
  });
  const manifestSnapshot = await readAuthorityJsonWithSidecar(
    join(resolve(bundleRoot), "release-manifest.json"),
    "provider prepublication manifest",
  );
  const manifest = validateReleaseManifest(manifestSnapshot.value);
  const publicUrl = new URL(
    `${PUBLIC_MIRROR_PREFIX}${PROVIDER_ADDRESS}/${manifest.version}.json`,
    PUBLIC_MIRROR_ORIGIN,
  );
  let url = publicUrl;
  let response;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    assertPublicProviderUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      PROVIDER_FETCH_TIMEOUT_MS,
    );
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location || redirects === 3) {
      throw new Error("provider public version-path redirect is invalid");
    }
    url = new URL(location, url);
  }
  if (response.status !== 404) {
    if (response.ok) {
      const bytes = await readBoundedResponse(
        response,
        MAX_PROVIDER_ASSET_BYTES,
      );
      throw new Error(
        `provider version ${manifest.version} already exists publicly (${bytes.length} bytes, sha256 ${sha256(bytes)}); overwrite is forbidden`,
      );
    }
    throw new Error(
      `provider public version-path returned ${response.status}, expected 404`,
    );
  }
  return {
    ...bundle,
    publicVersionUrl: publicUrl.toString(),
    publicVersionPathAvailable: true,
    publicationReady: false,
  };
}

function assertPublicProviderUrl(url) {
  if (
    url.protocol !== "https:" ||
    url.origin !== PUBLIC_MIRROR_ORIGIN ||
    !url.pathname.startsWith(PUBLIC_MIRROR_PREFIX) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error(
      `provider public URL is outside the reviewed mirror: ${url}`,
    );
  }
}

async function readBoundedResponse(response, limit) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
      throw new Error("provider public response has an invalid content length");
    }
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit)
      throw new Error("provider public response is too large");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("provider public response is too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

async function verifySourceTag({
  sourceRepo,
  tag,
  tagRef,
  descriptor,
  testOnlyAllowUnsignedTag,
  authorityRoot,
}) {
  const tagObjectType = gitCommand(
    descriptor.toolchain,
    ["cat-file", "-t", tagRef],
    { cwd: sourceRepo, home: authorityRoot },
  ).stdout.trim();
  const tagObjectId = gitCommand(descriptor.toolchain, ["rev-parse", tagRef], {
    cwd: sourceRepo,
    home: authorityRoot,
  }).stdout.trim();
  if (testOnlyAllowUnsignedTag) {
    if (process.env.TAKOSUMI_PROVIDER_RELEASE_TEST_ALLOW_UNSIGNED_TAG !== "1") {
      throw new Error(
        "unsigned provider tags are allowed only through the explicit test environment seam",
      );
    }
    return {
      kind: "test-only-unsigned",
      verified: false,
      tagObjectType,
      tagObjectId,
    };
  }
  if (tagObjectType !== "tag") {
    throw new Error(`provider release tag ${tag} must be annotated and signed`);
  }
  const reviewedFingerprints =
    descriptor.publicationPolicy.reviewedSignerFingerprints;
  if (reviewedFingerprints.length === 0) {
    throw new Error(
      "provider publication is blocked until a reviewed tag signer fingerprint is configured",
    );
  }
  const keyringPath = join(
    sourceRepo,
    safeRelativePath(descriptor.publicationPolicy.signerKeyring.path),
  );
  const keyringSnapshot = await readFileSnapshot(
    keyringPath,
    "provider signer keyring",
  );
  if (
    keyringSnapshot.sha256 !== descriptor.publicationPolicy.signerKeyring.sha256
  ) {
    throw new Error("provider signer keyring digest mismatch");
  }
  const tagBytes = binaryGitCommand(
    descriptor.toolchain,
    ["cat-file", "tag", tagRef],
    { cwd: sourceRepo, home: authorityRoot },
  );
  const signatureMarker = Buffer.from("-----BEGIN PGP SIGNATURE-----");
  const signatureOffset = tagBytes.indexOf(signatureMarker);
  if (signatureOffset <= 0) {
    throw new Error(
      `provider release tag ${tag} has no detached OpenPGP signature`,
    );
  }
  const signedPayload = tagBytes.subarray(0, signatureOffset);
  const signature = tagBytes.subarray(signatureOffset);
  const verificationRoot = await mkdtemp(
    join(authorityRoot, "tag-verification-"),
  );
  await chmod(verificationRoot, 0o700);
  const payloadPath = join(verificationRoot, "tag.payload");
  const signaturePath = join(verificationRoot, "tag.signature.asc");
  const stagedKeyringPath = join(verificationRoot, "provider-signers.gpg");
  await writeFile(payloadPath, signedPayload, { flag: "wx", mode: 0o600 });
  await writeFile(signaturePath, signature, { flag: "wx", mode: 0o600 });
  await writeFile(stagedKeyringPath, keyringSnapshot.bytes, {
    flag: "wx",
    mode: 0o600,
  });
  const verification = command(
    descriptor.toolchain.gpgv.path,
    [
      "--homedir",
      verificationRoot,
      "--keyring",
      stagedKeyringPath,
      "--status-fd",
      "1",
      signaturePath,
      payloadPath,
    ],
    {
      cwd: verificationRoot,
      env: hermeticToolEnvironment(verificationRoot),
    },
  );
  const verificationOutput = `${verification.stdout}\n${verification.stderr}`;
  const fingerprint = /\[GNUPG:\] VALIDSIG ([A-F0-9]{40,64})\b/.exec(
    verificationOutput,
  )?.[1];
  if (!fingerprint || !reviewedFingerprints.includes(fingerprint)) {
    throw new Error(
      `provider tag signer is not reviewed: ${fingerprint ?? "unknown"}`,
    );
  }
  return {
    kind: "signed-annotated",
    verified: true,
    tagObjectType,
    tagObjectId,
    signerFingerprint: fingerprint,
    verificationCommand: `gpgv --keyring <pinned> ${tagObjectId}`,
    verificationOutputSha256: sha256(Buffer.from(verificationOutput)),
  };
}

export async function buildProviderRelease({
  repoRoot = PROVIDER_RELEASE_ROOT,
  outputRoot,
  sourceCommit,
  tag,
  testOnlyAllowUnsignedTag = false,
} = {}) {
  if (!outputRoot) throw new Error("provider release build requires --output");
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? "")) {
    throw new Error(
      "provider release build requires an exact 40-character --source-commit",
    );
  }
  const sourceRepo = await realpath(repoRoot);
  const destination = resolve(outputRoot);
  await assertNoSymlinkPathComponents(destination, "provider release output");
  if (
    destination === sourceRepo ||
    destination.startsWith(`${sourceRepo}${sep}`)
  ) {
    throw new Error(
      "provider release output must be outside the tracked source repository",
    );
  }
  if (await exists(destination)) {
    throw new Error(`provider release output already exists: ${destination}`);
  }
  const descriptorPath = join(
    sourceRepo,
    "provider",
    "release",
    "version.json",
  );
  const descriptorSnapshot = await readAuthorityJsonWithSidecar(
    descriptorPath,
    "provider release descriptor",
  );
  const descriptor = validateVersionDescriptor(descriptorSnapshot.value);
  if (tag !== descriptor.tag) {
    throw new Error(`--tag must equal descriptor tag ${descriptor.tag}`);
  }
  verifyToolchainExecutableDigests(
    descriptor.toolchain,
    descriptor.runtimeTrust,
  );
  const authorityRoot = await mkdtemp(
    join(tmpdir(), "takosumi-provider-authority-"),
  );
  await chmod(authorityRoot, 0o700);
  const worktree = await mkdtemp(join(tmpdir(), "takosumi-provider-source-"));
  const buildOne = await mkdtemp(join(tmpdir(), "takosumi-provider-build-a-"));
  const buildTwo = await mkdtemp(join(tmpdir(), "takosumi-provider-build-b-"));
  await rm(worktree, { recursive: true, force: true });
  let worktreeAdded = false;
  try {
    const callerDirty = gitCommand(
      descriptor.toolchain,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: sourceRepo, home: authorityRoot },
    ).stdout;
    if (callerDirty.trim()) {
      throw new Error(
        "provider release source checkout is dirty or has untracked inputs",
      );
    }
    const tagRef = `refs/tags/${tag}`;
    const taggedCommit = gitCommand(
      descriptor.toolchain,
      ["rev-parse", `${tagRef}^{commit}`],
      { cwd: sourceRepo, home: authorityRoot },
    ).stdout.trim();
    if (taggedCommit !== sourceCommit) {
      throw new Error(
        `tag ${tag} resolves to ${taggedCommit}, not ${sourceCommit}`,
      );
    }
    const tagVerification = await verifySourceTag({
      sourceRepo,
      tag,
      tagRef,
      descriptor,
      testOnlyAllowUnsignedTag,
      authorityRoot,
    });
    const commitObject = gitCommand(
      descriptor.toolchain,
      ["cat-file", "-t", sourceCommit],
      { cwd: sourceRepo, home: authorityRoot },
    ).stdout.trim();
    if (commitObject !== "commit") {
      throw new Error(`${sourceCommit} is not a commit`);
    }
    gitCommand(
      descriptor.toolchain,
      ["worktree", "add", "--detach", worktree, sourceCommit],
      { cwd: sourceRepo, home: authorityRoot },
    );
    worktreeAdded = true;
    const worktreeDirty = gitCommand(
      descriptor.toolchain,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: worktree, home: authorityRoot },
    ).stdout;
    if (worktreeDirty.trim())
      throw new Error("detached provider source worktree is not clean");
    const worktreeDescriptorSnapshot = await readAuthorityJsonWithSidecar(
      join(worktree, "provider", "release", "version.json"),
      "tagged provider release descriptor",
    );
    const worktreeDescriptor = validateVersionDescriptor(
      worktreeDescriptorSnapshot.value,
    );
    if (stableJson(worktreeDescriptor) !== stableJson(descriptor)) {
      throw new Error(
        "release descriptor differs between caller and tagged source",
      );
    }
    if (worktreeDescriptorSnapshot.sha256 !== descriptorSnapshot.sha256) {
      throw new Error("tagged provider descriptor digest differs from caller");
    }
    await rejectExistingVersion(worktree, descriptor.version);
    const toolchain = verifyToolchain(worktree, descriptor);
    const modules = listGoModules(worktree, toolchain);
    const sourceTime = new Date(
      gitCommand(
        descriptor.toolchain,
        ["show", "-s", "--format=%cI", sourceCommit],
        { cwd: worktree, home: authorityRoot },
      ).stdout.trim(),
    ).toISOString();

    await buildReleaseOnce({
      worktree,
      outputRoot: buildOne,
      descriptor,
      sourceCommit,
      sourceTime,
      toolchain,
      modules,
      tagVerification,
    });
    await buildReleaseOnce({
      worktree,
      outputRoot: buildTwo,
      descriptor,
      sourceCommit,
      sourceTime,
      toolchain,
      modules,
      tagVerification,
    });
    await compareTrees(buildOne, buildTwo);
    const afterBuildDirty = gitCommand(
      descriptor.toolchain,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: worktree, home: authorityRoot },
    ).stdout;
    if (afterBuildDirty.trim()) {
      throw new Error("provider build modified its clean source worktree");
    }
    await mkdir(destination, { recursive: false });
    await cp(buildOne, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    const bundleVerification = await verifyProviderReleaseBundle({
      bundleRoot: destination,
      testOnlyAllowUnsignedManifest: testOnlyAllowUnsignedTag,
    });
    return {
      outputRoot: destination,
      version: descriptor.version,
      tag,
      sourceCommit,
      manifestDigest: await manifestDigest(
        join(destination, "release-manifest.json"),
      ),
      manifest: await readJson(join(destination, "release-manifest.json")),
      bundleVerification,
    };
  } finally {
    if (worktreeAdded) {
      gitCommand(
        descriptor.toolchain,
        ["worktree", "remove", "--force", worktree],
        { cwd: sourceRepo, home: authorityRoot, allowFailure: true },
      );
    }
    await rm(authorityRoot, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
    await rm(buildOne, { recursive: true, force: true });
    await rm(buildTwo, { recursive: true, force: true });
  }
}

async function buildReleaseOnce({
  worktree,
  outputRoot,
  descriptor,
  sourceCommit,
  sourceTime,
  toolchain,
  modules,
  tagVerification,
}) {
  const providerRoot = join(worktree, "provider");
  const mirrorRelativeRoot = join("mirror", descriptor.providerAddress);
  const mirrorRoot = join(outputRoot, mirrorRelativeRoot);
  await mkdir(mirrorRoot, { recursive: true });
  const goEnv = cleanBuildEnvironment(
    worktree,
    outputRoot,
    sourceTime,
    toolchain,
  );
  const archives = {};
  const mirrorAssets = [];

  for (const platform of descriptor.platforms) {
    const key = platformKey(platform);
    const binaryName = `terraform-provider-takosumi_v${descriptor.version}`;
    const archiveName = `terraform-provider-takosumi_${descriptor.version}_${key}.zip`;
    const platformDir = join(outputRoot, ".build", key);
    const binaryPath = join(platformDir, binaryName);
    const archivePath = join(mirrorRoot, archiveName);
    await mkdir(platformDir, { recursive: true });
    command(
      toolchain.go.path,
      [
        "build",
        "-trimpath",
        "-buildvcs=false",
        "-mod=readonly",
        "-ldflags",
        `-buildid= -X main.version=${descriptor.version}`,
        "-o",
        binaryPath,
        ".",
      ],
      {
        cwd: providerRoot,
        env: {
          ...goEnv,
          GOOS: platform.os,
          GOARCH: platform.arch,
          CGO_ENABLED: "0",
          GOCACHE: join(outputRoot, ".gocache", key),
        },
      },
    );
    const reportedVersion = command(
      toolchain.go.path,
      [
        "run",
        join(worktree, "provider", "release", "inspect-version.go"),
        binaryPath,
      ],
      { cwd: worktree, env: goEnv },
    ).stdout.trim();
    if (reportedVersion !== descriptor.version) {
      throw new Error(
        `${key} binary reports ${reportedVersion}, expected ${descriptor.version}`,
      );
    }
    const buildInfo = command(
      toolchain.go.path,
      ["version", "-m", binaryPath],
      {
        cwd: worktree,
        env: goEnv,
      },
    ).stdout;
    if (
      !buildInfo.includes("-trimpath=true") ||
      buildInfo.includes("vcs.modified=true")
    ) {
      throw new Error(`${key} binary build metadata is not clean/trimmed`);
    }
    const epoch = new Date("1980-01-01T00:00:00Z");
    await utimes(binaryPath, epoch, epoch);
    command(toolchain.zip.path, ["-X", "-q", "-9", archivePath, binaryName], {
      cwd: platformDir,
      env: { ...goEnv, TZ: "UTC" },
    });
    const bytes = await readFile(archivePath);
    const digest = sha256(bytes);
    archives[key] = { url: archiveName, hashes: [`zh:${digest}`] };
    mirrorAssets.push({
      kind: "archive",
      platform: key,
      path: `${descriptor.providerAddress}/${archiveName}`,
      artifactPath: `${mirrorRelativeRoot}/${archiveName}`,
      size: bytes.length,
      sha256: digest,
      cacheControl: "public, max-age=31536000, immutable",
      binaryVersion: reportedVersion,
      binaryBuildInfoSha256: sha256(
        Buffer.from(normalizeGoBuildInfo(buildInfo)),
      ),
    });
  }

  const indexEntry = {
    protocols: [...descriptor.protocols],
    platforms: descriptor.platforms.map((platform) => ({
      os: platform.os,
      arch: platform.arch,
    })),
  };
  const index = {
    versions: {
      [descriptor.version]: indexEntry,
    },
  };
  const versionMetadata = { archives };
  const indexPath = join(mirrorRoot, "index.json");
  const versionPath = join(mirrorRoot, `${descriptor.version}.json`);
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, {
    flag: "wx",
  });
  await writeFile(
    versionPath,
    `${JSON.stringify(versionMetadata, null, 2)}\n`,
    {
      flag: "wx",
    },
  );
  const indexBytes = await readFile(indexPath);
  const versionBytes = await readFile(versionPath);
  mirrorAssets.push({
    kind: "version",
    path: `${descriptor.providerAddress}/${basename(versionPath)}`,
    artifactPath: `${mirrorRelativeRoot}/${basename(versionPath)}`,
    size: versionBytes.length,
    sha256: sha256(versionBytes),
    cacheControl: "public, max-age=31536000, immutable",
  });
  mirrorAssets.sort((a, b) => a.path.localeCompare(b.path));

  const checksumLines = mirrorAssets
    .map((asset) => `${asset.sha256}  ${basename(asset.path)}`)
    .sort();
  await writeFile(
    join(outputRoot, "checksums.txt"),
    `${checksumLines.join("\n")}\n`,
    {
      flag: "wx",
    },
  );

  const sbom = createSbom({ descriptor, sourceCommit, sourceTime, modules });
  await writeFile(join(outputRoot, "sbom.spdx.json"), stableJson(sbom), {
    flag: "wx",
  });
  const sourceInputs = {
    goModSha256: sha256FileSync(join(worktree, "provider", "go.mod")),
    goSumSha256: sha256FileSync(join(worktree, "provider", "go.sum")),
  };
  const provenance = createProvenance({
    descriptor,
    sourceCommit,
    sourceTime,
    toolchain,
    mirrorAssets,
    sourceInputs,
  });
  await writeFile(
    join(outputRoot, "provenance.intoto.json"),
    stableJson(provenance),
    {
      flag: "wx",
    },
  );

  const supportArtifacts = [];
  for (const name of [
    "checksums.txt",
    "sbom.spdx.json",
    "provenance.intoto.json",
  ]) {
    const bytes = await readFile(join(outputRoot, name));
    supportArtifacts.push({
      path: name,
      size: bytes.length,
      sha256: sha256(bytes),
    });
  }
  const manifest = {
    schemaVersion: 1,
    kind: "takosumi.provider-release@v1",
    providerAddress: descriptor.providerAddress,
    modulePath: descriptor.modulePath,
    version: descriptor.version,
    tag: descriptor.tag,
    sourceCommit,
    sourceTime,
    sourceInputs,
    moduleInventory: modules,
    protocols: descriptor.protocols,
    status: "candidate",
    publishable: false,
    releaseEligibility:
      tagVerification.kind === "signed-annotated"
        ? "candidate-review-required"
        : "test-only",
    tagVerification,
    reproducible: true,
    deterministicBuildsCompared: 2,
    toolchain,
    runtimeTrust: descriptor.runtimeTrust,
    build: {
      flags: descriptor.releasePolicy.buildFlags,
      ldflags: descriptor.releasePolicy.ldflags.replace(
        "${version}",
        descriptor.version,
      ),
      cgoEnabled: false,
      archiveTimestampUtc: descriptor.releasePolicy.archiveTimestampUtc,
    },
    mirror: {
      indexEntry,
      derivedIndex: {
        kind: "derived-index",
        immutableAuthority: false,
        path: `${descriptor.providerAddress}/index.json`,
        artifactPath: `${mirrorRelativeRoot}/index.json`,
        size: indexBytes.length,
        sha256: sha256(indexBytes),
        cacheControl: "no-cache",
      },
      assets: mirrorAssets,
    },
    supportArtifacts,
    attestations: {
      sbom: "sbom.spdx.json",
      provenance: "provenance.intoto.json",
      signature: null,
      transparencyLog: null,
    },
  };
  const manifestPath = join(outputRoot, "release-manifest.json");
  await writeFile(manifestPath, stableJson(manifest), { flag: "wx" });
  const digest = await manifestDigest(manifestPath);
  await writeFile(
    `${manifestPath}.sha256`,
    `${digest}  release-manifest.json\n`,
    { flag: "wx" },
  );
  await rm(join(outputRoot, ".build"), { recursive: true, force: true });
  await rm(join(outputRoot, ".gocache"), { recursive: true, force: true });
  await rm(join(outputRoot, ".tmp"), { recursive: true, force: true });
  await verifyNetworkMirrorLayout(join(outputRoot, "mirror"), manifest);
}

function verifyToolchain(worktree, descriptor) {
  verifyToolchainExecutableDigests(
    descriptor.toolchain,
    descriptor.runtimeTrust,
  );
  const go = command(descriptor.toolchain.go.path, ["env", "GOVERSION"], {
    cwd: join(worktree, "provider"),
    env: hermeticGoEnvironment(process.env),
  }).stdout.trim();
  if (go !== descriptor.toolchain.go.version) {
    throw new Error(
      `Go toolchain mismatch: expected ${descriptor.toolchain.go.version}, got ${go}`,
    );
  }
  const zipOutput = command(descriptor.toolchain.zip.path, ["-v"], {
    cwd: worktree,
  }).stdout;
  const zipMatch = /This is Zip ([0-9.]+)/.exec(zipOutput);
  const zip = zipMatch ? `Info-ZIP ${zipMatch[1]}` : "unknown";
  if (zip !== descriptor.toolchain.zip.version) {
    throw new Error(
      `zip toolchain mismatch: expected ${descriptor.toolchain.zip.version}, got ${zip}`,
    );
  }
  const unzipOutput = command(descriptor.toolchain.unzip.path, ["-v"], {
    cwd: worktree,
  }).stdout;
  const unzipMatch = /^UnZip ([0-9.]+)/.exec(unzipOutput);
  const unzip = unzipMatch ? `Info-ZIP UnZip ${unzipMatch[1]}` : "unknown";
  if (unzip !== descriptor.toolchain.unzip.version) {
    throw new Error(
      `unzip toolchain mismatch: expected ${descriptor.toolchain.unzip.version}, got ${unzip}`,
    );
  }
  const git = command(descriptor.toolchain.git.path, ["--version"], {
    cwd: worktree,
    env: hermeticToolEnvironment(worktree),
  }).stdout.trim();
  const gpgv = command(descriptor.toolchain.gpgv.path, ["--version"], {
    cwd: worktree,
    env: hermeticToolEnvironment(worktree),
  })
    .stdout.split("\n")[0]
    .trim();
  if (
    git !== descriptor.toolchain.git.version ||
    gpgv !== descriptor.toolchain.gpgv.version
  ) {
    throw new Error("Git/GPG verification toolchain version mismatch");
  }
  command(descriptor.toolchain.go.path, ["mod", "verify"], {
    cwd: join(worktree, "provider"),
    env: hermeticGoEnvironment(process.env),
  });
  return {
    go: { ...descriptor.toolchain.go },
    zip: { ...descriptor.toolchain.zip },
    unzip: { ...descriptor.toolchain.unzip },
    git: { ...descriptor.toolchain.git },
    gpgv: { ...descriptor.toolchain.gpgv },
  };
}

function verifyToolchainExecutableDigests(toolchain, runtimeTrust) {
  for (const [name, expected] of Object.entries(toolchain)) {
    const actualPath = realpathSync(expected.path);
    if (actualPath !== expected.path) {
      throw new Error(
        `${name} toolchain path must be canonical: ${expected.path} -> ${actualPath}`,
      );
    }
    const digest = sha256(readFileSync(actualPath));
    if (digest !== expected.sha256) {
      throw new Error(
        `${name} toolchain digest mismatch: expected ${expected.sha256}, got ${digest}`,
      );
    }
  }
  const distributionDigest = digestTreeSync(toolchain.go.distributionRoot);
  if (distributionDigest !== toolchain.go.distributionSha256) {
    throw new Error(
      `Go distribution digest mismatch: expected ${toolchain.go.distributionSha256}, got ${distributionDigest}`,
    );
  }
  if (!runtimeTrust?.files) {
    throw new Error("provider runtime trust evidence is absent");
  }
  for (const expected of runtimeTrust.files) {
    const actualPath = realpathSync(expected.path);
    if (actualPath !== expected.path) {
      throw new Error(
        `runtime trust path must be canonical: ${expected.path} -> ${actualPath}`,
      );
    }
    const digest = sha256(readFileSync(actualPath));
    if (digest !== expected.sha256) {
      throw new Error(
        `runtime trust digest mismatch for ${actualPath}: expected ${expected.sha256}, got ${digest}`,
      );
    }
  }
}

function digestTreeSync(root) {
  const hash = createHash("sha256");
  const walk = (filesystemPath, logicalPath, seen) => {
    const entries = readdirSyncSorted(filesystemPath);
    for (const entry of entries) {
      const path = join(filesystemPath, entry.name);
      const logical = logicalPath ? `${logicalPath}/${entry.name}` : entry.name;
      const info = lstatSyncSafe(path);
      if (info.isSymbolicLink()) {
        const target = readlinkSync(path);
        const resolved = realpathSync(path);
        hash.update(`L\0${logical}\0${target}\0`);
        const targetInfo = lstatSyncSafe(resolved);
        if (targetInfo.isDirectory()) {
          if (seen.has(resolved))
            throw new Error(`toolchain symlink cycle at ${logical}`);
          walk(resolved, logical, new Set([...seen, resolved]));
        } else if (targetInfo.isFile()) {
          hash.update(readFileSync(resolved)).update("\0");
        } else {
          throw new Error(`unsupported toolchain symlink target ${logical}`);
        }
      } else if (info.isDirectory()) {
        walk(path, logical, seen);
      } else if (info.isFile()) {
        hash.update(`F\0${logical}\0`).update(readFileSync(path)).update("\0");
      } else {
        throw new Error(`unsupported toolchain entry ${logical}`);
      }
    }
  };
  const canonicalRoot = realpathSync(root);
  if (canonicalRoot !== root) {
    throw new Error(`Go distribution root must be canonical: ${root}`);
  }
  walk(root, "", new Set([canonicalRoot]));
  return hash.digest("hex");
}

function readdirSyncSorted(path) {
  return readdirSync(path, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

function lstatSyncSafe(path) {
  return lstatSync(path);
}

function hermeticToolEnvironment(home) {
  return {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GNUPGHOME: home,
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function listGoModules(worktree, toolchain) {
  const output = command(
    toolchain.go.path,
    [
      "list",
      "-mod=readonly",
      "-m",
      "-f",
      "{{.Path}}\t{{.Version}}\t{{.Sum}}\t{{.Main}}\t{{if .Replace}}{{.Replace.Path}}{{end}}",
      "all",
    ],
    {
      cwd: join(worktree, "provider"),
      env: hermeticGoEnvironment(process.env),
    },
  ).stdout;
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [path, version, sum, main, replacement, extra] = line.split("\t");
      if (!path || extra !== undefined) {
        throw new Error(`invalid go module inventory row ${line}`);
      }
      if (replacement) {
        throw new Error(`provider release rejects replaced module ${path}`);
      }
      const isMain = main === "true";
      if (isMain && path !== "github.com/takosjp/terraform-provider-takosumi") {
        throw new Error(`unexpected main Go module ${path}`);
      }
      return {
        path,
        version: version || (isMain ? "source" : "unknown"),
        sum: sum || null,
        main: isMain,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function cleanBuildEnvironment(worktree, outputRoot, sourceTime, toolchain) {
  const allowed = [
    "PATH",
    "HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
  ];
  const env = {};
  for (const key of allowed) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const goPath = command(toolchain.go.path, ["env", "GOPATH"], {
    cwd: join(worktree, "provider"),
    env: hermeticGoEnvironment(process.env),
  }).stdout.trim();
  const moduleCache = command(toolchain.go.path, ["env", "GOMODCACHE"], {
    cwd: join(worktree, "provider"),
    env: hermeticGoEnvironment(process.env),
  }).stdout.trim();
  return {
    ...hermeticGoEnvironment(env),
    GOPATH: goPath,
    GOMODCACHE: moduleCache,
    GOFLAGS: "",
    SOURCE_DATE_EPOCH: String(Math.floor(Date.parse(sourceTime) / 1000)),
    TMPDIR: join(outputRoot, ".tmp"),
  };
}

function hermeticGoEnvironment(base) {
  return {
    ...base,
    GOWORK: "off",
    GOENV: "off",
    GOPROXY: "off",
    GOSUMDB: "off",
  };
}

function normalizeGoBuildInfo(output) {
  const lines = output.replace(/\r\n/g, "\n").trimEnd().split("\n");
  if (lines.length === 0 || !/:\s+go\d/.test(lines[0])) {
    throw new Error("provider binary has invalid Go build metadata");
  }
  lines[0] = `<binary>${lines[0].slice(lines[0].indexOf(":"))}`;
  return `${lines.join("\n")}\n`;
}

function validateGoBuildInfo(buildInfo, manifest, asset) {
  const [os, arch, extra] = String(asset.platform).split("_");
  if (extra || !os || !arch || !REQUIRED_PLATFORMS.includes(asset.platform)) {
    throw new Error(`${asset.path} has an invalid binary platform`);
  }
  const platform = { os, arch };
  const required = [
    `: ${manifest.toolchain.go.version}`,
    `\tpath\t${manifest.modulePath}\n`,
    "\tbuild\t-trimpath=true\n",
    "\tbuild\tCGO_ENABLED=0\n",
    `\tbuild\tGOOS=${platform.os}\n`,
    `\tbuild\tGOARCH=${platform.arch}\n`,
  ];
  for (const evidence of required) {
    if (!buildInfo.includes(evidence)) {
      throw new Error(
        `${asset.path} binary build metadata omits ${evidence.trim()}`,
      );
    }
  }
  if (
    !buildInfo.includes(`\tmod\t${manifest.modulePath}\t(devel)\t\n`) &&
    !buildInfo.includes(`\tmod\t${manifest.modulePath}\t(devel)\n`)
  ) {
    throw new Error(`${asset.path} binary main-module evidence is invalid`);
  }
  if (/\tbuild\tvcs\./.test(buildInfo)) {
    throw new Error(`${asset.path} binary unexpectedly contains VCS metadata`);
  }
  const inventory = new Map(
    manifest.moduleInventory.map((module) => [module.path, module]),
  );
  for (const line of buildInfo.split("\n")) {
    if (!line.startsWith("\tdep\t")) continue;
    const [, , path, version, sum = ""] = line.split("\t");
    const reviewed = inventory.get(path);
    if (
      !reviewed ||
      reviewed.version !== version ||
      (reviewed.sum ?? "") !== sum
    ) {
      throw new Error(`${asset.path} contains an unreviewed module ${path}`);
    }
  }
}

function createSbom({ descriptor, sourceCommit, sourceTime, modules }) {
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `terraform-provider-takosumi-${descriptor.version}`,
    documentNamespace: `https://takosumi.com/spdx/provider/${descriptor.version}/${sourceCommit}`,
    creationInfo: {
      created: sourceTime,
      creators: ["Tool: takosumi-provider-release-builder/1"],
    },
    packages: modules.map((module, index) => ({
      SPDXID: `SPDXRef-Package-${index + 1}`,
      name: module.path,
      versionInfo: module.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: `pkg:golang/${module.path}@${module.version}`,
        },
      ],
    })),
  };
}

function createProvenance({
  descriptor,
  sourceCommit,
  sourceTime,
  toolchain,
  mirrorAssets,
  sourceInputs,
}) {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: mirrorAssets
      .filter((asset) => asset.kind === "archive")
      .map((asset) => ({ name: asset.path, digest: { sha256: asset.sha256 } })),
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://takosumi.com/build/provider-release/v1",
        externalParameters: {
          providerAddress: descriptor.providerAddress,
          version: descriptor.version,
          tag: descriptor.tag,
          platforms: descriptor.platforms,
        },
        internalParameters: {
          toolchain,
          flags: descriptor.releasePolicy.buildFlags,
          ldflags: descriptor.releasePolicy.ldflags.replace(
            "${version}",
            descriptor.version,
          ),
        },
        resolvedDependencies: [
          {
            uri: descriptor.modulePath,
            digest: { gitCommit: sourceCommit },
          },
          {
            uri: "provider/go.mod",
            digest: { sha256: sourceInputs.goModSha256 },
          },
          {
            uri: "provider/go.sum",
            digest: { sha256: sourceInputs.goSumSha256 },
          },
        ],
      },
      runDetails: {
        builder: { id: "https://takosumi.com/builders/provider-release/v1" },
        metadata: {
          invocationId: `${descriptor.version}-${sourceCommit}`,
          startedOn: sourceTime,
          finishedOn: sourceTime,
        },
      },
    },
  };
}

function sha256FileSync(path) {
  return sha256(readFileSync(path));
}

async function rejectExistingVersion(worktree, version) {
  for (const directory of [
    join(worktree, "provider", "release", "quarantine"),
    join(worktree, "provider", "release", "approved"),
  ]) {
    if (!(await exists(directory))) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const manifest = await readJson(join(directory, entry.name));
      if (manifest.version === version) {
        throw new Error(
          `provider version ${version} already exists in immutable manifest ${join(directory, entry.name)}`,
        );
      }
    }
  }
}

async function compareTrees(leftRoot, rightRoot) {
  const left = await listTree(leftRoot);
  const right = await listTree(rightRoot);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(
      "independent provider builds produced a different file set",
    );
  }
  for (const path of left) {
    const leftBytes = await readFile(join(leftRoot, path));
    const rightBytes = await readFile(join(rightRoot, path));
    if (!leftBytes.equals(rightBytes)) {
      throw new Error(`independent provider builds differ at ${path}`);
    }
  }
}

async function listTree(root, prefix = "") {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) result.push(...(await listTree(root, path)));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`release output contains unsupported entry ${path}`);
  }
  return result;
}

async function verifyFile(path, asset) {
  const bytes = await readFile(path);
  verifyBytes(bytes, asset);
}

function verifyBytes(bytes, asset) {
  if (bytes.length !== asset.size) {
    throw new Error(
      `${asset.path} size mismatch: expected ${asset.size}, got ${bytes.length}`,
    );
  }
  const digest = sha256(bytes);
  if (digest !== asset.sha256) {
    throw new Error(
      `${asset.path} sha256 mismatch: expected ${asset.sha256}, got ${digest}`,
    );
  }
}

function platformKey(platform) {
  assertObject(platform, "platform");
  if (
    !/^[a-z0-9]+$/.test(platform.os ?? "") ||
    !/^[a-z0-9]+$/.test(platform.arch ?? "")
  ) {
    throw new Error(`invalid provider platform ${JSON.stringify(platform)}`);
  }
  return `${platform.os}_${platform.arch}`;
}

function platformFromArchive(path, version) {
  const match = new RegExp(
    `^terraform-provider-takosumi_${escapeRegExp(version)}_([a-z0-9]+_[a-z0-9]+)\\.zip$`,
  ).exec(basename(path));
  if (!match) throw new Error(`invalid provider archive name ${path}`);
  return match[1];
}

function compareSemver(left, right) {
  const parse = (value) => {
    const match = SEMVER.exec(value);
    if (!match) throw new Error(`invalid provider semver ${value}`);
    const prerelease = match[4]?.split(".") ?? [];
    if (
      prerelease.some(
        (identifier) => /^\d+$/.test(identifier) && /^0\d+/.test(identifier),
      )
    ) {
      throw new Error(`invalid provider semver ${value}`);
    }
    return [Number(match[1]), Number(match[2]), Number(match[3]), prerelease];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  const aPrerelease = a[3];
  const bPrerelease = b[3];
  if (aPrerelease.length === 0 || bPrerelease.length === 0) {
    return aPrerelease.length === bPrerelease.length
      ? 0
      : aPrerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(aPrerelease.length, bPrerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aIdentifier = aPrerelease[index];
    const bIdentifier = bPrerelease[index];
    if (aIdentifier === undefined || bIdentifier === undefined) {
      return aIdentifier === bIdentifier
        ? 0
        : aIdentifier === undefined
          ? -1
          : 1;
    }
    if (aIdentifier === bIdentifier) continue;
    const aNumeric = /^\d+$/.test(aIdentifier);
    const bNumeric = /^\d+$/.test(bIdentifier);
    if (aNumeric && bNumeric) return Number(aIdentifier) - Number(bIdentifier);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aIdentifier.localeCompare(bIdentifier);
  }
  return 0;
}

function safeRelativePath(path) {
  if (
    typeof path !== "string" ||
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`unsafe relative path ${String(path)}`);
  }
  return path;
}

function assertExactSet(actual, expected, label) {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  if (
    JSON.stringify(left) !== JSON.stringify(right) ||
    actual.length !== expected.length
  ) {
    throw new Error(
      `${label} mismatch: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
    );
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactObjectKeys(value, expected, label) {
  assertObject(value, label);
  assertExactSet(Object.keys(value), expected, `${label} fields`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertNoSymlinkPathComponents(path, label) {
  const absolute = resolve(path);
  const components = [];
  let current = absolute;
  while (true) {
    components.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const component of components.reverse()) {
    if (!(await exists(component))) continue;
    const info = await lstat(component);
    if (info.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink component: ${component}`);
    }
    if (component !== absolute && !info.isDirectory()) {
      throw new Error(
        `${label} contains a non-directory ancestor: ${component}`,
      );
    }
  }
}

const HERMETIC_GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
];

function gitCommand(toolchain, args, options = {}) {
  return command(toolchain.git.path, [...HERMETIC_GIT_CONFIG, ...args], {
    ...options,
    env: hermeticToolEnvironment(options.home ?? options.cwd ?? tmpdir()),
  });
}

function binaryGitCommand(toolchain, args, options = {}) {
  return binaryCommand(toolchain.git.path, [...HERMETIC_GIT_CONFIG, ...args], {
    ...options,
    env: hermeticToolEnvironment(options.home ?? options.cwd ?? tmpdir()),
  });
}

function command(program, args, options = {}) {
  if (options.env?.TMPDIR) {
    // Go and zip both require the explicit isolated temp root to exist.
    mkdirSync(options.env.TMPDIR, { recursive: true });
  }
  const result = spawnSync(program, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${program} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function binaryCommand(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${program} ${args.join(" ")} failed (${result.status}): ${result.stderr.toString("utf8").trim()}`,
    );
  }
  return result.stdout;
}
