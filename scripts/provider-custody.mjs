#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = join(ROOT, "provider", "release");
export const PROVIDER_QUARANTINE_PATH = join(
  RELEASE,
  "quarantine",
  "1.0.0.json",
);
const PROVIDER_ADDRESS = "registry.opentofu.org/takosjp/takosumi";
const PUBLIC_MIRROR_BASE = "https://app.takosumi.com/opentofu/providers/";
const REQUIRED_PLATFORMS = [
  "darwin_amd64",
  "darwin_arm64",
  "linux_amd64",
  "linux_arm64",
];
const SHA256 = /^[a-f0-9]{64}$/u;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function digest(path) {
  return sha256(await readFile(path));
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function verifyManifestSidecar(path) {
  const sidecar = await readFile(`${path}.sha256`, "utf8");
  const match = /^([a-f0-9]{64})  ([^/\n]+)\n?$/u.exec(sidecar);
  assert(match, `invalid digest sidecar ${relative(ROOT, path)}.sha256`);
  assert(
    match[2] === basename(path),
    `wrong sidecar filename for ${relative(ROOT, path)}`,
  );
  assert(
    match[1] === (await digest(path)),
    `digest mismatch for ${relative(ROOT, path)}`,
  );
  return match[1];
}

export function validateQuarantineManifest(manifest) {
  exactKeys(
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
  assert(
    manifest.schemaVersion === 1 &&
      manifest.kind === "takosumi.provider-release-quarantine@v1" &&
      manifest.providerAddress === PROVIDER_ADDRESS &&
      manifest.version === "1.0.0" &&
      manifest.state === "historical-quarantine" &&
      manifest.publishable === false &&
      manifest.reproducible === false,
    "invalid provider quarantine identity",
  );
  exactKeys(
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
    "provider quarantine source observation",
  );
  assert(
    manifest.source.providerReportedVersion === "dev" &&
      manifest.source.vcsModified === true &&
      manifest.source.provenance === "unknown-dirty" &&
      manifest.source.provenanceVerified === false,
    "served 1.0.0 source provenance must remain unresolved",
  );
  exactKeys(
    manifest.mirror,
    ["baseUrl", "providerPath", "indexEntry", "indexObservation", "assets"],
    "provider quarantine mirror observation",
  );
  assert(
    manifest.mirror.baseUrl === PUBLIC_MIRROR_BASE &&
      manifest.mirror.providerPath === PROVIDER_ADDRESS,
    "provider quarantine mirror identity drifted",
  );
  assert(
    Array.isArray(manifest.mirror.assets) &&
      manifest.mirror.assets.length === 5,
    "provider quarantine must inventory one version document and four archives",
  );
  const paths = [];
  const platforms = [];
  for (const asset of manifest.mirror.assets) {
    const expectedKeys =
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
          ];
    exactKeys(asset, expectedKeys, `provider quarantine ${asset.kind} asset`);
    validateObservedAsset(asset);
    assert(
      asset.cacheControl === "public, max-age=31536000, immutable",
      `provider quarantine asset is not immutable: ${asset.path}`,
    );
    paths.push(asset.path);
    if (asset.kind === "archive") platforms.push(asset.platform);
  }
  assert(
    new Set(paths).size === paths.length,
    "provider quarantine contains duplicate asset paths",
  );
  assert(
    manifest.mirror.assets.filter((asset) => asset.kind === "version")
      .length === 1,
    "provider quarantine requires exactly one version document",
  );
  sameSet(platforms, REQUIRED_PLATFORMS, "provider quarantine platforms");
  const index = manifest.mirror.indexObservation;
  exactKeys(
    index,
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
    "provider quarantine index observation",
  );
  validateObservedAsset(index);
  assert(
    index.kind === "derived-index-observation" &&
      index.immutableAuthority === false &&
      index.cacheControl === "no-cache",
    "provider index must remain a mutable observation rather than retained authority",
  );
  exactKeys(
    manifest.rejectedLocalRebuild,
    ["description", "assets"],
    "rejected local rebuild",
  );
  const rejected = manifest.rejectedLocalRebuild.assets;
  assert(
    rejected && typeof rejected === "object" && !Array.isArray(rejected),
    "rejected local rebuild assets must be an object",
  );
  sameSet(
    Object.keys(rejected),
    [...paths, index.path],
    "rejected local rebuild paths",
  );
  for (const value of Object.values(rejected)) {
    assert(SHA256.test(value), "invalid rejected local rebuild digest");
  }
  return manifest;
}

function validateObservedAsset(asset) {
  assert(
    typeof asset.path === "string" &&
      asset.path.startsWith(`${PROVIDER_ADDRESS}/`) &&
      !asset.path.includes("..") &&
      asset.url === `${PUBLIC_MIRROR_BASE}${asset.path}` &&
      Number.isSafeInteger(asset.size) &&
      asset.size > 0 &&
      SHA256.test(asset.sha256 ?? "") &&
      typeof asset.etag === "string" &&
      /^"[a-f0-9]+"$/u.test(asset.etag) &&
      typeof asset.observedAt === "string" &&
      !Number.isNaN(Date.parse(asset.observedAt)),
    `invalid provider quarantine asset ${String(asset.path)}`,
  );
}

function exactKeys(value, expected, label) {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  sameSet(Object.keys(value), expected, `${label} fields`);
}

function sameSet(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  assert(
    actual.length === expected.length &&
      JSON.stringify(left) === JSON.stringify(right),
    `${label} mismatch`,
  );
}

async function listJsonAuthorities(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await listJsonAuthorities(path)));
    if (entry.isFile() && entry.name.endsWith(".json")) result.push(path);
  }
  return result.sort();
}

async function absent(path, label) {
  try {
    await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} must be absent`);
}

async function containsFile(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && (await containsFile(join(root, entry.name)))) {
      return true;
    }
  }
  return false;
}

async function findForbiddenActiveProviderAuthority(
  root,
  needles,
  result = [],
) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await findForbiddenActiveProviderAuthority(path, needles, result);
      continue;
    }
    if (!entry.isFile() || !/\.(?:[cm]?[jt]sx?|ya?ml)$/u.test(entry.name)) {
      continue;
    }
    const source = await readFile(path, "utf8");
    for (const needle of needles) {
      if (source.includes(needle)) {
        result.push(`${relative(ROOT, path)}:${needle}`);
      }
    }
  }
  return result;
}

export async function verifyProviderCustody() {
  const descriptorPath = join(RELEASE, "version.json");
  const registryPath = join(RELEASE, "registry.json");
  const deltaPath = join(RELEASE, "compatibility", "1.1.4-delta-policy.json");
  const removalPath = join(
    RELEASE,
    "compatibility",
    "service-form-removal-policy.json",
  );
  const [descriptor, registry, delta, removal, packageJson, dashboardPackage] =
    await Promise.all([
      readJson(descriptorPath),
      readJson(registryPath),
      readJson(deltaPath),
      readJson(removalPath),
      readJson(join(ROOT, "package.json")),
      readJson(join(ROOT, "dashboard", "package.json")),
    ]);

  assert(descriptor.version === "1.1.4", "custody snapshot must remain 1.1.4");
  assert(descriptor.tag === "provider/v1.1.4", "custody tag drifted");
  assert(
    descriptor.status === "discontinued",
    "provider must remain discontinued",
  );
  assert(
    descriptor.publishable === false,
    "discontinued provider cannot be publishable",
  );
  assert(
    descriptor.newVersionsAllowed === false,
    "new provider versions must be forbidden",
  );
  assert(
    descriptor.publicationPolicy?.mode === "disabled",
    "provider publication must remain disabled",
  );
  assert(
    descriptor.publicationPolicy?.status === "cancelled-discontinued",
    "provider publication status drifted",
  );
  assert(
    descriptor.replacement?.portableFormsAndResourceInterfaceDescriptors ===
      "registry.terraform.io/tako0614/takoform",
    "portable Form/Resource Interface descriptor replacement must remain Takoform",
  );

  assert(
    registry.providerAddress === descriptor.providerAddress,
    "registry address drifted",
  );
  assert(
    Array.isArray(registry.versions) && registry.versions.length === 1,
    "registry must retain only historical 1.0.0",
  );
  assert(
    registry.versions[0]?.version === "1.0.0" &&
      registry.versions[0]?.classification === "historical-quarantine",
    "1.0.0 must remain historical quarantine",
  );
  assert(
    !registry.versions.some((entry) => entry.classification === "approved"),
    "discontinued provider cannot admit mirror releases",
  );

  assert(
    delta.kind === "takosumi.provider-cancelled-delta-record@v1" &&
      delta.releaseEligibility === "cancelled-discontinued",
    "1.1.4 must remain cancelled custody evidence",
  );
  assert(
    removal.supportWindow?.minimumDays === 365,
    "legacy state support window must remain at least 365 days",
  );
  assert(
    removal.supportWindow?.startedAt === null,
    "legacy state removal window must not start implicitly",
  );

  const failures = (await readdir(join(RELEASE, "failures")))
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert(
    JSON.stringify(failures) ===
      JSON.stringify(["1.1.0.json", "1.1.1.json", "1.1.2.json", "1.1.3.json"]),
    "failed candidate custody set drifted",
  );
  await absent(
    join(ROOT, ".github", "workflows", "provider-release.yml"),
    "provider publication workflow",
  );
  for (const path of [
    "scripts/build-provider-assets.mjs",
    "scripts/provider-release.mjs",
    "scripts/lib/provider-release.mjs",
    "scripts/provider-release-candidate.mjs",
    "scripts/provider-release-approval.ts",
    "scripts/lib/provider-release-approval.ts",
    "tests/proofs/provider-mirror-quarantine-exclusion.ts",
  ]) {
    await absent(join(ROOT, path), `provider mutation path ${path}`);
  }
  await absent(
    join(ROOT, "tests", "proofs", "resource-shape-opentofu-provider.ts"),
    "active Takosumi provider lifecycle proof",
  );
  await absent(
    join(ROOT, "core", "shared", "capsule_run_tokens.ts"),
    "retired Takosumi provider Capsule run-token authority",
  );
  await absent(
    join(ROOT, "tests", "core", "api", "interface_capsule_actor_test.ts"),
    "retired Capsule provider-authoring route proof",
  );
  assert(
    !(await containsFile(join(ROOT, "provider", "examples"))),
    "active Takosumi provider examples must be absent",
  );
  const activeAuthority = [];
  for (const root of ["contract", "core", "deploy", "runner"]) {
    await findForbiddenActiveProviderAuthority(
      join(ROOT, root),
      [
        "TAKOSUMI_RUN_INTERFACE_API_URL",
        "TAKOSUMI_RUN_TOKEN_SECRET",
        "capsuleRunMutable",
        "capsule-run-token",
        "takrun_",
      ],
      activeAuthority,
    );
  }
  assert(
    activeAuthority.length === 0,
    `retired Takosumi provider authority returned: ${activeAuthority.join(", ")}`,
  );
  const mutationAuthority = (
    await findForbiddenActiveProviderAuthority(join(ROOT, "scripts"), [
      "buildProviderRelease",
      "materializeProviderMirror",
      "verifyProviderPrepublication",
      "finalizeProviderReleaseApproval",
      "takosumi.provider-release-candidate-preparation@v1",
      "takosumi.provider-release-prepublication@v1",
    ])
  ).filter((entry) => !entry.startsWith("scripts/provider-custody.mjs:"));
  const workflowAuthority = await findForbiddenActiveProviderAuthority(
    join(ROOT, ".github", "workflows"),
    ["terraform-provider-takosumi", "provider-release"],
  );
  assert(
    mutationAuthority.length === 0 && workflowAuthority.length === 0,
    `provider mutation authority returned: ${[
      ...mutationAuthority,
      ...workflowAuthority,
    ].join(", ")}`,
  );

  const forbiddenScripts = [
    "opentofu:resource-shape-provider-proof",
    "opentofu:takos-shape-provider-proof",
    "opentofu:yurucommu-shape-provider-proof",
    "provider:assets",
    "provider:compatibility:check",
    "provider:compatibility:release-check",
    "provider:compatibility:state-proof",
    "provider:release:build",
    "provider:release:verify",
    "provider:release:verify-tag",
    "provider:release:candidate",
    "provider:release:approval",
    "provider:release:prepublish",
    "provider:mirror:materialize",
    "provider:mirror:proof",
    "provider:custody:mirror-proof",
  ];
  for (const name of forbiddenScripts) {
    assert(
      !(name in packageJson.scripts),
      `active provider publication script remains: ${name}`,
    );
  }
  assert(
    packageJson.scripts["provider:custody:check"] ===
      "bun scripts/provider-custody.mjs",
    "provider custody check must remain wired",
  );
  assert(
    packageJson.scripts["provider:custody:compatibility-check"] ===
      "bun scripts/provider-custody-compatibility.mjs check" &&
      packageJson.scripts["provider:custody:state-proof"] ===
        "bun scripts/provider-custody-compatibility.mjs state-proof",
    "provider compatibility commands must remain custody-only",
  );
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    if (!name.startsWith("provider:")) continue;
    assert(
      !/(?:release|publish|prepublish|candidate|approval|materialize|sign|promote|upload|mirror-proof)/u.test(
        `${name} ${command}`,
      ),
      `provider mutation command remains: ${name}`,
    );
  }
  for (const name of ["dev", "build"]) {
    const command = dashboardPackage.scripts[name];
    assert(
      !command.includes("provider-release"),
      `dashboard ${name} must not invoke provider release tooling`,
    );
    assert(
      !command.includes("materialize"),
      `dashboard ${name} must not materialize the discontinued provider mirror`,
    );
  }

  const authorities = await listJsonAuthorities(RELEASE);
  const digests = {};
  for (const path of authorities) {
    digests[relative(RELEASE, path)] = await verifyManifestSidecar(path);
  }
  validateQuarantineManifest(await readJson(PROVIDER_QUARANTINE_PATH));

  return {
    kind: "takosumi.provider-custody@v1",
    status: "discontinued",
    publishable: false,
    newVersionsAllowed: false,
    retainedVersion: "1.0.0",
    cancelledSnapshot: "1.1.4",
    sourceProvenance: "unresolved",
    releaseWorkflow: "absent",
    mutationPaths: "absent",
    defaultMirrorVersions: [],
    authorityDigests: digests,
  };
}

if (import.meta.main) {
  process.stdout.write(
    `${JSON.stringify(await verifyProviderCustody(), null, 2)}\n`,
  );
}
