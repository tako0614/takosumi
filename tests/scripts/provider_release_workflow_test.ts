import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { join } from "node:path";
import { parse } from "yaml";

import { SigstoreBlobSignatureVerifier } from "../../core/adapters/takoform/signature.ts";
import {
  verifyProviderReleaseApproval,
  verifyProviderReleaseSignature,
} from "../../scripts/lib/provider-release-approval.ts";
import { verifyProviderReleaseTag } from "../../scripts/lib/provider-release.mjs";
import {
  main as candidateCli,
  verifyProviderReleaseCandidate,
} from "../../scripts/provider-release-candidate.mjs";

const repoRoot = new URL("../../", import.meta.url);
const temporaryRoots: string[] = [];
const digest = `sha256:${"a".repeat(64)}`;

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("provider release workflow authority", () => {
  test("is a pinned two-phase workflow with one protected mutation job", async () => {
    const source = await Bun.file(
      new URL("../../.github/workflows/provider-release.yml", import.meta.url),
    ).text();
    const workflow = parse(source) as Record<string, any>;
    const releaseDescriptor = (await Bun.file(
      new URL("../../provider/release/version.json", import.meta.url),
    ).json()) as Record<string, any>;

    const dispatchInputs = Object.keys(workflow.on.workflow_dispatch.inputs);
    expect(dispatchInputs.length).toBeLessThanOrEqual(25);
    expect(dispatchInputs).toEqual([
      "phase",
      "version",
      "release_id",
      "tag",
      "source_commit",
      "candidate_run_id",
      "candidate_manifest_digest",
      "envelope_digest",
      "controller_commit",
      "controller_digest",
      "adapter_digest",
      "authorization_digest",
      "artifact_digests_b64",
      "health_checks_b64",
      "target_fingerprint",
    ]);
    expect(Object.keys(workflow.jobs)).toEqual(["candidate", "promote"]);
    expect(workflow.jobs.candidate.if).toBe("inputs.phase == 'candidate'");
    expect(workflow.jobs.candidate.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.promote.if).toBe("inputs.phase == 'promote'");
    expect(workflow.jobs.promote.environment).toBe("provider-release");
    expect(workflow.jobs.promote.permissions).toEqual({
      actions: "read",
      attestations: "write",
      contents: "write",
      "id-token": "write",
    });
    expect(workflow.jobs.candidate["runs-on"]).toBe("ubuntu-26.04");
    expect(workflow.jobs.promote["runs-on"]).toBe("ubuntu-26.04");
    expect(workflow.env.BUN_VERSION).toBe("1.3.14");
    expect(workflow.env.GO_VERSION).toBe("1.26.5");
    expect(releaseDescriptor.toolchain.go.version).toBe(
      `go${workflow.env.GO_VERSION}`,
    );
    expect(releaseDescriptor.toolchain.go.distributionRoot).toBe(
      `/usr/lib/go-${workflow.env.GO_VERSION}`,
    );
    expect(workflow.env.COSIGN_VERSION).toBe("v3.0.6");
    expect(workflow.env.COSIGN_LINUX_AMD64_SHA256).toBe(
      "c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74",
    );
    expect(workflow.env.RELEASE_SAFETY_CONTROLLER_COMMIT).toBe(
      "856ec30dd6c1dbc16e20f4d401fc0b381b35a8e1",
    );
    expect(workflow.env.RELEASE_SAFETY_ADAPTER_DIGEST).toBe(
      "sha256:0f601ba59ae736fcd912b09580228365e8fc64885efbbc2dfa3622060730575f",
    );

    const actionReferences = [...source.matchAll(/uses:\s*([^\s#]+)/gu)].map(
      ([, reference]) => reference,
    );
    expect(actionReferences.length).toBeGreaterThan(0);
    expect(
      actionReferences.every((value) => /@[0-9a-f]{40}$/u.test(value!)),
    ).toBe(true);
    expect(source).toContain("release-safety:provider:");
    expect(source).toContain("cosign verify-blob");
    expect(source).toContain("--certificate-github-workflow-repository");
    expect(source).toContain("--certificate-github-workflow-ref");
    expect(source).toContain("--certificate-github-workflow-sha");
    expect(source).toContain("--certificate-github-workflow-trigger");
    expect(source).toContain('"workflow_dispatch"');
    expect(source).toContain("--trusted-root");
    expect(source).toContain("provider-release-approval.json");
    expect(source).toContain("release-manifest.sigstore.json");
    expect(source).toContain("release-safety-readback.json");
    expect(
      source.match(
        /golang\.org\/toolchain@v0\.0\.1-\$\{descriptor_go_version\}\.linux-amd64/gu,
      ),
    ).toHaveLength(2);
    expect(source.match(/go mod download -json/gu)).toHaveLength(2);
    expect(
      source.match(/GOTOOLCHAIN=local go mod download -json/gu),
    ).toHaveLength(2);
    expect(source.match(/value\.Path.*value\.Version/gu)).toHaveLength(2);
    expect(source).not.toContain('source_root="$(go env GOROOT)"');
    const verifyToolchainMarker =
      "bun scripts/provider-release.mjs verify-toolchain";
    const executeGoMarker = '"${target_root}/bin/go" version';
    let searchFrom = 0;
    for (let index = 0; index < 2; index += 1) {
      const verifyAt = source.indexOf(verifyToolchainMarker, searchFrom);
      const executeAt = source.indexOf(executeGoMarker, searchFrom);
      expect(verifyAt).toBeGreaterThanOrEqual(searchFrom);
      expect(executeAt).toBeGreaterThan(verifyAt);
      searchFrom = executeAt + executeGoMarker.length;
    }
    expect(source.indexOf(verifyToolchainMarker, searchFrom)).toBe(-1);
    expect(source.indexOf(executeGoMarker, searchFrom)).toBe(-1);
    expect(source).toContain("'$value | @uri'");
    expect(source).not.toContain("/releases/tags/${RELEASE_TAG}");
    expect(source).not.toContain("--clobber");
    expect(source).not.toMatch(/GPG_PRIVATE_KEY|PASSPHRASE|PRIVATE_KEY/);
  });
});

describe("provider candidate closure", () => {
  test("rejects unknown CLI options before touching release bytes", async () => {
    await expect(
      candidateCli(["verify", "--candidate", "/tmp/x", "--typo", "x"]),
    ).rejects.toThrow("unknown option --typo");
  });

  test("rejects path traversal from an otherwise digest-bound manifest", async () => {
    const root = await candidateFixture({ bundlePath: "../../escape" });
    await expect(
      verifyProviderReleaseCandidate({ candidateRoot: root }),
    ).rejects.toThrow("unsafe provider release bundle path");
  });

  test("reserves generated stable-release authority names", async () => {
    const root = await candidateFixture({
      extraAsset: "release-safety-readback.json",
    });
    await expect(
      verifyProviderReleaseCandidate({ candidateRoot: root }),
    ).rejects.toThrow("invalid provider candidate release asset set");
  });

  test("rejects symlinked candidate authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-candidate-symlink-"));
    temporaryRoots.push(root);
    const real = join(root, "real");
    const linked = join(root, "linked");
    await mkdir(real);
    await symlink(real, linked);
    await expect(
      verifyProviderReleaseCandidate({ candidateRoot: linked }),
    ).rejects.toThrow("provider candidate must be a real directory");
  });
});

describe("provider signature approval authority", () => {
  test("uses an independently named generic blob verifier", () => {
    const verifier = new SigstoreBlobSignatureVerifier({
      trustedRootDigest: digest,
      loadTrustedRoot: async () => new Uint8Array(),
      publishers: [
        {
          oidcIssuer: "https://token.actions.githubusercontent.com",
          sourceRepository: "tako0614/takosumi",
          workflow: ".github/workflows/provider-release.yml",
          refPattern: "refs/tags/provider/v*",
        },
      ],
    });
    expect(verifier.id).toBe("sigstore.keyless-blob.v1");
  });

  test("requires absolute regular-file authority paths", async () => {
    await expect(
      verifyProviderReleaseSignature({
        subjectPath: "release-manifest.json",
        bundlePath: "/tmp/release-manifest.sigstore.json",
        expectedTag: "provider/v1.1.0",
      }),
    ).rejects.toThrow("authority path must be absolute");
  });

  test("fails closed on a publisher policy sidecar mismatch", async () => {
    const fixture = await signatureFixture();
    await writeFile(
      `${fixture.policyPath}.sha256`,
      `${"0".repeat(64)}  provider-publisher-policy.json\n`,
    );
    await expect(
      verifyProviderReleaseSignature({
        subjectPath: fixture.subjectPath,
        bundlePath: fixture.bundlePath,
        expectedTag: "provider/v1.1.0",
        policyPath: fixture.policyPath,
      }),
    ).rejects.toThrow("provider publisher policy sidecar mismatch");
  });

  test("fails closed on a TrustedRoot sidecar mismatch", async () => {
    const fixture = await signatureFixture();
    await writeFile(
      join(fixture.root, "sigstore-trusted-root.json.sha256"),
      `${"0".repeat(64)}  sigstore-trusted-root.json\n`,
    );
    await expect(
      verifyProviderReleaseSignature({
        subjectPath: fixture.subjectPath,
        bundlePath: fixture.bundlePath,
        expectedTag: "provider/v1.1.0",
        policyPath: fixture.policyPath,
      }),
    ).rejects.toThrow("provider Sigstore TrustedRoot sidecar mismatch");
  });

  test("rejects unknown approval fields before reading secondary inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-approval-fields-"));
    temporaryRoots.push(root);
    const approvalPath = join(root, "approval.json");
    await writeFile(approvalPath, '{"unexpected":true}\n');
    await expect(
      verifyProviderReleaseApproval({
        approvalPath,
        candidateManifestPath: join(root, "missing-candidate.json"),
        subjectPath: join(root, "missing-subject.json"),
        bundlePath: join(root, "missing-bundle.json"),
      }),
    ).rejects.toThrow("provider release authority fields mismatch");
  });

  test("tag verification rejects non-commit identity before invoking tools", async () => {
    await expect(
      verifyProviderReleaseTag({
        repoRoot: new URL("../../", import.meta.url).pathname,
        sourceCommit: "not-a-commit",
        tag: "provider/v1.1.0",
      }),
    ).rejects.toThrow("exact source commit");
  });
});

async function candidateFixture(options: {
  readonly bundlePath?: string;
  readonly extraAsset?: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "provider-candidate-fixture-"));
  temporaryRoots.push(root);
  const releaseManifest = {
    supportArtifacts: [
      { path: options.bundlePath ?? "support/sbom.spdx.json" },
    ],
    mirror: {
      derivedIndex: { artifactPath: "mirror/index.json" },
      assets: [],
    },
  };
  const releaseManifestBytes = Buffer.from(
    `${JSON.stringify(releaseManifest)}\n`,
  );
  await writeFile(join(root, "release-manifest.json"), releaseManifestBytes);
  const releaseAssets = [
    {
      name: "release-manifest.json",
      digest: sha256(releaseManifestBytes),
    },
  ];
  if (options.extraAsset) {
    const bytes = Buffer.from("reserved\n");
    await writeFile(join(root, options.extraAsset), bytes);
    releaseAssets.push({ name: options.extraAsset, digest: sha256(bytes) });
  }
  const candidate = {
    kind: "takos.release-candidate-manifest@v1",
    surfaceId: "takosumi-provider",
    repository: "https://github.com/tako0614/takosumi.git",
    sourceCommit: "1".repeat(40),
    version: "1.1.0",
    tag: "provider/v1.1.0",
    workflowRunId: "123",
    builtAt: "2026-07-19T00:00:00.000Z",
    ociImages: [],
    releaseAssets,
    artifactDigests: releaseAssets.map(({ digest }) => digest),
    sbomDigests: [digest],
    provenanceDigests: [digest],
    configDigest: digest,
    policyDigest: digest,
    toolchainDigest: digest,
  };
  await writeFile(
    join(root, "release-candidate-manifest.json"),
    `${JSON.stringify(candidate, null, 2)}\n`,
  );
  return root;
}

async function signatureFixture(): Promise<{
  readonly root: string;
  readonly policyPath: string;
  readonly subjectPath: string;
  readonly bundlePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "provider-signature-fixture-"));
  temporaryRoots.push(root);
  for (const name of [
    "provider-publisher-policy.json",
    "provider-publisher-policy.json.sha256",
    "sigstore-trusted-root.json",
    "sigstore-trusted-root.json.sha256",
  ]) {
    await cp(
      new URL(`../../provider/release/trust/${name}`, import.meta.url),
      join(root, name),
    );
  }
  const subjectPath = join(root, "release-manifest.json");
  const bundlePath = join(root, "release-manifest.sigstore.json");
  const encodedSubject = await readFile(
    new URL(
      "../fixtures/takoform-sigstore/package-index.json.base64",
      import.meta.url,
    ),
    "utf8",
  );
  const encodedBundle = await readFile(
    new URL(
      "../fixtures/takoform-sigstore/package-index.sigstore.json.base64",
      import.meta.url,
    ),
    "utf8",
  );
  await writeFile(
    subjectPath,
    Buffer.from(encodedSubject.replace(/\s/gu, ""), "base64"),
  );
  await writeFile(
    bundlePath,
    Buffer.from(encodedBundle.replace(/\s/gu, ""), "base64"),
  );
  return {
    root,
    policyPath: join(root, "provider-publisher-policy.json"),
    subjectPath,
    bundlePath,
  };
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
