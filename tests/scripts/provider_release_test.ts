import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  PROVIDER_QUARANTINE_PATH,
  PROVIDER_REGISTRY_PATH,
  PROVIDER_RELEASE_ROOT,
  PROVIDER_VERSION_PATH,
  buildProviderRelease,
  loadProviderReleaseRegistry,
  materializeProviderMirror,
  readJson,
  sha256,
  stableJson,
  validateQuarantineManifest,
  validateProviderReleaseRegistry,
  validateReleaseManifest,
  validateVersionDescriptor,
  verifyLocalProviderMirrorSources,
  verifyManifestSidecar,
  verifyNetworkMirrorLayout,
  verifyProviderReleaseBundle,
  verifyProviderPrepublication,
  verifyProviderReleaseSource,
} from "../../scripts/lib/provider-release.mjs";
import { runProviderReleaseCli } from "../../scripts/provider-release.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("provider release source", () => {
  test("uses an independent 1.0.1 candidate lane and immutable historical quarantine", async () => {
    const packageJson = await readJson(
      join(PROVIDER_RELEASE_ROOT, "package.json"),
    );
    const descriptor = validateVersionDescriptor(
      await readJson(PROVIDER_VERSION_PATH),
    );
    const quarantine = validateQuarantineManifest(
      await readJson(PROVIDER_QUARANTINE_PATH),
    );

    expect(descriptor.version).toBe("1.0.1");
    expect(descriptor.version).not.toBe(packageJson.version);
    expect(descriptor.tag).toBe("provider/v1.0.1");
    expect(descriptor.publishable).toBe(false);
    expect(quarantine.version).toBe("1.0.0");
    expect(quarantine.publishable).toBe(false);
    expect(quarantine.reproducible).toBe(false);
    expect(quarantine.source.providerReportedVersion).toBe("dev");
    expect(quarantine.source.vcsModified).toBe(true);
    expect(quarantine.source.provenance).toBe("unknown-dirty");
    expect(
      quarantine.mirror.assets
        .filter((asset: { kind: string }) => asset.kind === "archive")
        .map((asset: { sha256: string }) => asset.sha256)
        .sort(),
    ).toEqual(
      [
        "9de3e6e582a01bd497c15f1c32a8e6ffc777bf8d9c01da6947f79de1bdc0f412",
        "82cf01961f8fc6f2e9dfd36cfecc733033231a2809472cbdc99f98b09faed209",
        "3433cb34ec1bb79f1d9757e97806554e3c4384ae3dca4e282610b1e853330f5d",
        "9eca47380699751e41bc71cc585daeeba2c2fd5c72f50a847b7f4aea08ab33cc",
      ].sort(),
    );
  });

  test("pins the quarantine manifest digest and rejects public source drift", async () => {
    expect(await verifyManifestSidecar(PROVIDER_QUARANTINE_PATH)).toBe(
      "2d7313612f827336b6bb2d0e4155c4af04f4717f18760f87ee18cd5f4c2dcad3",
    );
    const result = await verifyProviderReleaseSource();
    expect(result.providerVersion).toBe("1.0.1");
    expect(result.quarantineVersion).toBe("1.0.0");
    expect(
      result.localAssets.every(
        (asset) => asset.classification === "exact-public",
      ),
    ).toBe(true);
  });

  test("keeps every known provider version in the exact release registry", async () => {
    const loaded = await loadProviderReleaseRegistry(PROVIDER_REGISTRY_PATH);
    expect(loaded.registry.versions.map((entry) => entry.version)).toEqual([
      "1.0.0",
    ]);
    expect(() =>
      validateProviderReleaseRegistry({
        ...loaded.registry,
        unreviewedExtension: true,
      }),
    ).toThrow("fields mismatch");
  });

  test("rejects unknown CLI options", async () => {
    await expect(
      runProviderReleaseCli(["verify-source", "--typo", "ignored"]),
    ).rejects.toThrow("unknown option --typo");
  });

  test("fails before dev/build when public contains wrong provider bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-public-source-test-"));
    temporaryRoots.push(root);
    const manifest = await readJson(PROVIDER_QUARANTINE_PATH);
    const asset = manifest.mirror.assets[0];
    const localPath = join(root, asset.path);
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, "rejected-local-provider-bytes");

    await expect(
      verifyLocalProviderMirrorSources({
        localMirrorRoot: root,
        manifest,
        checkTracked: false,
      }),
    ).rejects.toThrow("rejected or unreviewed bytes");
  });

  test("rejects release output inside the tracked source repository", async () => {
    await expect(
      buildProviderRelease({
        repoRoot: PROVIDER_RELEASE_ROOT,
        outputRoot: join(PROVIDER_RELEASE_ROOT, ".forbidden-provider-release"),
        sourceCommit: "a".repeat(40),
        tag: "provider/v1.0.1",
      }),
    ).rejects.toThrow("outside the tracked source repository");
  });

  test("rejects an existing release output path before any build", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-existing-output-"));
    temporaryRoots.push(root);
    await expect(
      buildProviderRelease({
        repoRoot: PROVIDER_RELEASE_ROOT,
        outputRoot: root,
        sourceCommit: "a".repeat(40),
        tag: "provider/v1.0.1",
      }),
    ).rejects.toThrow("provider release output already exists");
  });

  test("rejects a lightweight unsigned production tag", async () => {
    const fixture = await makeTaggedSourceFixture();
    await expect(
      buildProviderRelease({
        repoRoot: fixture.repoRoot,
        outputRoot: fixture.outputRoot,
        sourceCommit: fixture.sourceCommit,
        tag: "provider/v1.0.1",
      }),
    ).rejects.toThrow("must be annotated and signed");
  });

  test("the explicit unsigned test seam still enforces executable digest pins", async () => {
    const fixture = await makeTaggedSourceFixture({ wrongGoDigest: true });
    const previous =
      process.env.TAKOSUMI_PROVIDER_RELEASE_TEST_ALLOW_UNSIGNED_TAG;
    process.env.TAKOSUMI_PROVIDER_RELEASE_TEST_ALLOW_UNSIGNED_TAG = "1";
    try {
      await expect(
        buildProviderRelease({
          repoRoot: fixture.repoRoot,
          outputRoot: fixture.outputRoot,
          sourceCommit: fixture.sourceCommit,
          tag: "provider/v1.0.1",
          testOnlyAllowUnsignedTag: true,
        }),
      ).rejects.toThrow("go toolchain digest mismatch");
    } finally {
      if (previous === undefined) {
        delete process.env.TAKOSUMI_PROVIDER_RELEASE_TEST_ALLOW_UNSIGNED_TAG;
      } else {
        process.env.TAKOSUMI_PROVIDER_RELEASE_TEST_ALLOW_UNSIGNED_TAG =
          previous;
      }
    }
  });

  test("builds twice and verifies a complete unsigned test-only bundle", async () => {
    const fixture = await makeCompleteTaggedSourceFixture();
    const previous =
      process.env.TAKOSUMI_PROVIDER_RELEASE_TEST_ALLOW_UNSIGNED_TAG;
    process.env.TAKOSUMI_PROVIDER_RELEASE_TEST_ALLOW_UNSIGNED_TAG = "1";
    try {
      const result = await buildProviderRelease({
        repoRoot: fixture.repoRoot,
        outputRoot: fixture.outputRoot,
        sourceCommit: fixture.sourceCommit,
        tag: "provider/v1.0.1",
        testOnlyAllowUnsignedTag: true,
      });
      expect(result.bundleVerification.releaseEligibility).toBe("test-only");
      expect(result.manifest.moduleInventory.length).toBeGreaterThan(1);
      expect(result.manifest.runtimeTrust.files.length).toBeGreaterThan(1);
      expect(
        result.manifest.mirror.assets
          .filter((asset) => asset.kind === "archive")
          .every((asset) => /^[a-f0-9]{64}$/.test(asset.binaryBuildInfoSha256)),
      ).toBe(true);
      const prepublication = await verifyProviderPrepublication({
        bundleRoot: fixture.outputRoot,
        testOnlyAllowUnsignedManifest: true,
        fetchImpl: async (url) => {
          expect(String(url)).toBe(
            "https://app.takosumi.com/opentofu/providers/registry.opentofu.org/takosjp/takosumi/1.0.1.json",
          );
          return new Response("not found", { status: 404 });
        },
      });
      expect(prepublication.publicVersionPathAvailable).toBe(true);
      expect(prepublication.publicationReady).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.TAKOSUMI_PROVIDER_RELEASE_TEST_ALLOW_UNSIGNED_TAG;
      } else {
        process.env.TAKOSUMI_PROVIDER_RELEASE_TEST_ALLOW_UNSIGNED_TAG =
          previous;
      }
    }
  }, 120_000);
});

describe("immutable mirror materializer", () => {
  test("never admits a candidate manifest through the normal materializer", async () => {
    const fixture = await makeReleaseFixture();
    await expect(
      materializeProviderMirror({
        outputRoot: fixture.outputRoot,
        manifestPath: fixture.manifestPath,
        cacheRoot: fixture.cacheRoot,
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow("hosted mirrors require the approved registry");
  });

  test("rejects unknown release-manifest fields", async () => {
    const fixture = await makeReleaseFixture();
    expect(() =>
      validateReleaseManifest({
        ...fixture.manifest,
        unreviewedExtension: true,
      }),
    ).toThrow("fields mismatch");
  });

  test("copies reviewed bytes unchanged and verifies network-mirror layout", async () => {
    const fixture = await makeReleaseFixture();
    await mkdir(fixture.outputRoot, { recursive: true });
    await writeFile(join(fixture.outputRoot, "README.md"), "preserve me\n");
    const result = await materializeUnapproved({
      outputRoot: fixture.outputRoot,
      manifestPath: fixture.manifestPath,
      cacheRoot: fixture.cacheRoot,
      fetchImpl: fixture.fetchImpl,
    });

    expect(result.manifestDigests).toEqual([fixture.manifestDigest]);
    await expect(
      readFile(join(fixture.outputRoot, "README.md"), "utf8"),
    ).rejects.toThrow();
    for (const asset of fixture.manifest.mirror.assets) {
      const bytes = await readFile(join(fixture.outputRoot, asset.path));
      expect(sha256(bytes)).toBe(asset.sha256);
    }
    expect(fixture.requested.sort()).toEqual(
      fixture.manifest.mirror.assets
        .map(
          (asset) =>
            `https://app.takosumi.com/opentofu/providers/${asset.path}`,
        )
        .sort(),
    );
  });

  test("fails closed on a digest mismatch", async () => {
    const fixture = await makeReleaseFixture();
    fixture.manifest.mirror.assets[0].sha256 = "f".repeat(64);
    await writeManifest(fixture.manifestPath, fixture.manifest);

    await expect(
      materializeUnapproved({
        outputRoot: fixture.outputRoot,
        manifestPath: fixture.manifestPath,
        cacheRoot: fixture.cacheRoot,
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow("sha256 mismatch");
  });

  test("rejects an incomplete or downgraded release manifest", async () => {
    const fixture = await makeReleaseFixture();
    fixture.manifest.sourceCommit = "unknown";
    await writeManifest(fixture.manifestPath, fixture.manifest);

    expect(() => validateReleaseManifest(fixture.manifest)).toThrow(
      "exact source commit",
    );
    await expect(
      materializeUnapproved({
        outputRoot: fixture.outputRoot,
        manifestPath: fixture.manifestPath,
        cacheRoot: fixture.cacheRoot,
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow("exact source commit");
  });

  test("rejects duplicate versioned mirror paths", async () => {
    const fixture = await makeReleaseFixture();
    fixture.manifest.mirror.assets[2].path =
      fixture.manifest.mirror.assets[1].path;
    fixture.manifest.mirror.assets[2].artifactPath =
      fixture.manifest.mirror.assets[1].artifactPath;
    await writeManifest(fixture.manifestPath, fixture.manifest);

    await expect(
      materializeUnapproved({
        outputRoot: fixture.outputRoot,
        manifestPath: fixture.manifestPath,
        cacheRoot: fixture.cacheRoot,
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow("duplicate provider mirror path");
  });

  test("deterministically merges a new version without changing old immutable assets", async () => {
    const oldRelease = await makeReleaseFixture("1.0.0");
    const newRelease = await makeReleaseFixture("1.0.1");
    const singleOutput = join(oldRelease.root, "single-mirror");
    await materializeUnapproved({
      outputRoot: singleOutput,
      manifestPath: oldRelease.manifestPath,
      cacheRoot: join(oldRelease.root, "single-cache"),
      fetchImpl: oldRelease.fetchImpl,
    });
    const oldVersionPath = `${oldRelease.manifest.providerAddress}/1.0.0.json`;
    const oldDigestBefore = sha256(
      await readFile(join(singleOutput, oldVersionPath)),
    );

    const mergedOutput = join(oldRelease.root, "merged-mirror");
    await materializeUnapproved({
      outputRoot: mergedOutput,
      manifestPaths: [oldRelease.manifestPath, newRelease.manifestPath],
      cacheRoot: join(oldRelease.root, "merged-cache"),
      fetchImpl: async (url) => {
        const first = await oldRelease.fetchImpl(url);
        return first.status === 404 ? newRelease.fetchImpl(url) : first;
      },
    });
    const oldDigestAfter = sha256(
      await readFile(join(mergedOutput, oldVersionPath)),
    );
    expect(oldDigestAfter).toBe(oldDigestBefore);
    const index = await readJson(
      join(mergedOutput, oldRelease.manifest.providerAddress, "index.json"),
    );
    expect(Object.keys(index.versions)).toEqual(["1.0.0", "1.0.1"]);
  });

  test("rejects duplicate provider versions while merging", async () => {
    const fixture = await makeReleaseFixture("1.0.1");
    await expect(
      materializeUnapproved({
        outputRoot: fixture.outputRoot,
        manifestPaths: [fixture.manifestPath, fixture.manifestPath],
        cacheRoot: fixture.cacheRoot,
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow("duplicate provider version 1.0.1");
  });

  test("rejects extra files from a materialized provider inventory", async () => {
    const fixture = await makeReleaseFixture();
    await materializeUnapproved({
      outputRoot: fixture.outputRoot,
      manifestPath: fixture.manifestPath,
      cacheRoot: fixture.cacheRoot,
      fetchImpl: fixture.fetchImpl,
    });
    const providerRoot = join(
      fixture.outputRoot,
      fixture.manifest.providerAddress,
    );
    await writeFile(join(providerRoot, "unindexed-provider.zip"), "unexpected");

    await expect(
      verifyNetworkMirrorLayout(fixture.outputRoot, fixture.manifest),
    ).rejects.toThrow("exact file inventory");
  });

  test("rejects a release bundle whose support bytes drift from the manifest", async () => {
    const fixture = await makeReleaseFixture();
    const bundleRoot = join(fixture.root, "bundle");
    const manifestPath = join(bundleRoot, "release-manifest.json");
    await mkdir(bundleRoot);
    await materializeUnapproved({
      outputRoot: join(bundleRoot, "mirror"),
      manifestPath: fixture.manifestPath,
      cacheRoot: fixture.cacheRoot,
      fetchImpl: fixture.fetchImpl,
    });
    for (const artifact of fixture.manifest.supportArtifacts) {
      await writeFile(join(bundleRoot, artifact.path), "drifted-support-byte");
    }
    await writeManifest(manifestPath, fixture.manifest);

    await expect(verifyProviderReleaseBundle({ bundleRoot })).rejects.toThrow(
      "mismatch",
    );
  });

  test("rejects symlink ancestors for output and cache writes", async () => {
    const fixture = await makeReleaseFixture();
    const realRoot = join(fixture.root, "real-target");
    const linkedRoot = join(fixture.root, "linked-target");
    await mkdir(realRoot);
    await symlink(realRoot, linkedRoot, "dir");

    await expect(
      materializeUnapproved({
        outputRoot: join(linkedRoot, "mirror"),
        manifestPath: fixture.manifestPath,
        cacheRoot: fixture.cacheRoot,
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow("output contains a symlink component");
    await expect(
      materializeUnapproved({
        outputRoot: fixture.outputRoot,
        manifestPath: fixture.manifestPath,
        cacheRoot: join(linkedRoot, "cache"),
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow("cache contains a symlink component");
  });
});

async function makeReleaseFixture(version = "1.0.1") {
  const root = await mkdtemp(join(tmpdir(), "provider-release-test-"));
  temporaryRoots.push(root);
  const providerAddress = "registry.opentofu.org/takosjp/takosumi";
  const descriptor = await readJson(PROVIDER_VERSION_PATH);
  const platforms = [
    { os: "linux", arch: "amd64" },
    { os: "linux", arch: "arm64" },
    { os: "darwin", arch: "amd64" },
    { os: "darwin", arch: "arm64" },
  ];
  const archiveFixtures = platforms.map((platform) => {
    const key = `${platform.os}_${platform.arch}`;
    const name = `terraform-provider-takosumi_${version}_${key}.zip`;
    const bytes = Buffer.from(`deterministic-provider-${version}-${key}`);
    return { key, name, bytes, digest: sha256(bytes) };
  });
  const indexBytes = Buffer.from(
    `${JSON.stringify(
      {
        versions: {
          [version]: {
            protocols: ["5.0"],
            platforms,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const versionBytes = Buffer.from(
    `${JSON.stringify(
      {
        archives: Object.fromEntries(
          archiveFixtures.map((archive) => [
            archive.key,
            { url: archive.name, hashes: [`zh:${archive.digest}`] },
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  const bytesByUrl = new Map<string, Buffer>();
  const makeAsset = (
    kind: "version" | "archive",
    path: string,
    bytes: Buffer,
    platform?: string,
  ) => {
    const url = `https://app.takosumi.com/opentofu/providers/${path}`;
    bytesByUrl.set(url, bytes);
    return {
      kind,
      ...(platform ? { platform } : {}),
      ...(kind === "archive"
        ? {
            binaryVersion: version,
            binaryBuildInfoSha256: "9".repeat(64),
          }
        : {}),
      path,
      artifactPath: `mirror/${path}`,
      size: bytes.length,
      sha256: sha256(bytes),
      cacheControl: "public, max-age=31536000, immutable",
    };
  };
  const manifest = {
    schemaVersion: 1,
    kind: "takosumi.provider-release@v1",
    providerAddress,
    modulePath: "github.com/takosjp/terraform-provider-takosumi",
    version,
    tag: `provider/v${version}`,
    sourceCommit: "a".repeat(40),
    sourceTime: "2026-01-01T00:00:00.000Z",
    sourceInputs: {
      goModSha256: "2".repeat(64),
      goSumSha256: "3".repeat(64),
    },
    moduleInventory: [
      {
        path: "github.com/takosjp/terraform-provider-takosumi",
        version: "source",
        sum: null,
        main: true,
      },
    ],
    protocols: ["5.0"],
    status: "candidate",
    publishable: false,
    releaseEligibility: "candidate-review-required",
    tagVerification: {
      kind: "signed-annotated",
      verified: true,
      tagObjectType: "tag",
      tagObjectId: "f".repeat(40),
      signerFingerprint: "A".repeat(40),
      verificationCommand: `gpgv --keyring <pinned> ${"f".repeat(40)}`,
      verificationOutputSha256: "1".repeat(64),
    },
    reproducible: true,
    deterministicBuildsCompared: 2,
    toolchain: descriptor.toolchain,
    runtimeTrust: descriptor.runtimeTrust,
    build: {
      flags: ["-trimpath", "-buildvcs=false", "-mod=readonly"],
      ldflags: `-buildid= -X main.version=${version}`,
      cgoEnabled: false,
      archiveTimestampUtc: "1980-01-01T00:00:00Z",
    },
    mirror: {
      indexEntry: {
        protocols: ["5.0"],
        platforms,
      },
      derivedIndex: {
        kind: "derived-index",
        immutableAuthority: false,
        path: `${providerAddress}/index.json`,
        artifactPath: `mirror/${providerAddress}/index.json`,
        size: indexBytes.length,
        sha256: sha256(indexBytes),
        cacheControl: "no-cache",
      },
      assets: [
        makeAsset(
          "version",
          `${providerAddress}/${version}.json`,
          versionBytes,
        ),
        ...archiveFixtures.map((archive) =>
          makeAsset(
            "archive",
            `${providerAddress}/${archive.name}`,
            archive.bytes,
            archive.key,
          ),
        ),
      ],
    },
    supportArtifacts: [
      { path: "checksums.txt", size: 1, sha256: "c".repeat(64) },
      { path: "sbom.spdx.json", size: 1, sha256: "d".repeat(64) },
      { path: "provenance.intoto.json", size: 1, sha256: "e".repeat(64) },
    ],
    attestations: {
      sbom: "sbom.spdx.json",
      provenance: "provenance.intoto.json",
      signature: null,
      transparencyLog: null,
    },
  };
  const manifestPath = join(root, "release-manifest.json");
  const manifestDigest = await writeManifest(manifestPath, manifest);
  const requested: string[] = [];
  return {
    root,
    outputRoot: join(root, "mirror"),
    cacheRoot: join(root, "cache"),
    manifestPath,
    manifestDigest,
    manifest,
    requested,
    fetchImpl: async (url: string | URL | Request) => {
      const key = String(url);
      requested.push(key);
      const bytes = bytesByUrl.get(key);
      if (!bytes) return new Response("not found", { status: 404 });
      const asset = manifest.mirror.assets.find(
        (entry) =>
          `https://app.takosumi.com/opentofu/providers/${entry.path}` === key,
      )!;
      return new Response(bytes, {
        status: 200,
        headers: { "cache-control": asset.cacheControl },
      });
    },
  };
}

async function makeTaggedSourceFixture({ wrongGoDigest = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "provider-tag-source-test-"));
  temporaryRoots.push(root);
  const repoRoot = join(root, "repo");
  await mkdir(join(repoRoot, "provider", "release"), { recursive: true });
  const descriptor = await readJson(PROVIDER_VERSION_PATH);
  if (wrongGoDigest) descriptor.toolchain.go.sha256 = "0".repeat(64);
  await writeManifest(
    join(repoRoot, "provider", "release", "version.json"),
    descriptor,
  );
  await mkdir(join(repoRoot, "provider", "release", "keys"));
  await writeFile(
    join(repoRoot, "provider", "release", "keys", "provider-signers.gpg"),
    "",
  );
  runGit(repoRoot, ["init", "-q"]);
  runGit(repoRoot, ["config", "user.email", "provider-test@takosumi.invalid"]);
  runGit(repoRoot, ["config", "user.name", "Provider Release Test"]);
  runGit(repoRoot, ["add", "."]);
  runGit(repoRoot, ["commit", "-q", "-m", "provider fixture"]);
  runGit(repoRoot, ["tag", "provider/v1.0.1"]);
  return {
    repoRoot,
    outputRoot: join(root, "output"),
    sourceCommit: runGit(repoRoot, ["rev-parse", "HEAD"]),
  };
}

async function makeCompleteTaggedSourceFixture() {
  const root = await mkdtemp(join(tmpdir(), "provider-complete-source-test-"));
  temporaryRoots.push(root);
  const repoRoot = join(root, "repo");
  await mkdir(repoRoot);
  await cp(
    join(PROVIDER_RELEASE_ROOT, "provider"),
    join(repoRoot, "provider"),
    {
      recursive: true,
    },
  );
  runGit(repoRoot, ["init", "-q"]);
  runGit(repoRoot, ["config", "user.email", "provider-test@takosumi.invalid"]);
  runGit(repoRoot, ["config", "user.name", "Provider Release Test"]);
  runGit(repoRoot, ["add", "."]);
  runGit(repoRoot, ["commit", "-q", "-m", "complete provider fixture"]);
  runGit(repoRoot, ["tag", "provider/v1.0.1"]);
  return {
    repoRoot,
    outputRoot: join(root, "output"),
    sourceCommit: runGit(repoRoot, ["rev-parse", "HEAD"]),
  };
}

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function materializeUnapproved(
  options: Parameters<typeof materializeProviderMirror>[0],
) {
  const previous =
    process.env.TAKOSUMI_PROVIDER_RELEASE_TEST_ALLOW_UNAPPROVED_MANIFEST;
  process.env.TAKOSUMI_PROVIDER_RELEASE_TEST_ALLOW_UNAPPROVED_MANIFEST = "1";
  try {
    return await materializeProviderMirror({
      ...options,
      testOnlyAllowUnapprovedManifest: true,
    });
  } finally {
    if (previous === undefined) {
      delete process.env
        .TAKOSUMI_PROVIDER_RELEASE_TEST_ALLOW_UNAPPROVED_MANIFEST;
    } else {
      process.env.TAKOSUMI_PROVIDER_RELEASE_TEST_ALLOW_UNAPPROVED_MANIFEST =
        previous;
    }
  }
}

async function writeManifest(path: string, manifest: unknown) {
  const bytes = stableJson(manifest);
  await writeFile(path, bytes);
  const digest = sha256(Buffer.from(bytes));
  await writeFile(`${path}.sha256`, `${digest}  ${basename(path)}\n`);
  return digest;
}
