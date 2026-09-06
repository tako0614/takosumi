import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  parseRunnerImageNativeCandidateArgs,
  runRunnerImageNativeCandidate,
} from "../../scripts/runner-image-native-candidate.ts";
import {
  parseLocalRunnerImageIdentity,
  parseRunnerImageNativeCandidateRecord,
  RUNNER_IMAGE_NATIVE_CANDIDATE_KIND,
  RUNNER_IMAGE_NATIVE_PROOF_KIND,
} from "../../scripts/lib/runner-image-native-proof.ts";
import { platformReleaseSourceAuthorityDigest } from "../../scripts/lib/platform-release-source.ts";

const COMMIT = "a".repeat(40);
const REPOSITORY = "https://github.com/tako0614/takosumi.git";
// Exact values from the Docker 29 default-builder/containerd reproduction.
// Default provenance produces an OCI index; disabling provenance produces the
// single Docker schema-2 manifest required by the release contract.
const DEFAULT_PROVENANCE_LOCAL_IMAGE_ID =
  "sha256:545554bafc859f22db83ee44ae7a18323bfd937460c39aae012935388b4f89c5";
const LOCAL_IMAGE_ID =
  "sha256:aadeb8bcd4a034e70bb181f1bf617c5d9b2e07485eb19fc04cc17c69e1977c50";
const DESCRIPTOR_DIGEST = LOCAL_IMAGE_ID;
const OCI_CONFIG_DIGEST =
  "sha256:eb0c0591f6405bc3109d8afe43459edc0733a1e71ef26c674c2d1ea4495de9dd";
const OPENTOFU_SHA256 = "9".repeat(64);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function candidateRecord() {
  return {
    kind: RUNNER_IMAGE_NATIVE_CANDIDATE_KIND,
    observedAt: "2026-09-06T00:00:00.000Z",
    source: {
      repository: REPOSITORY,
      commit: COMMIT,
      authoritySha256: platformReleaseSourceAuthorityDigest({
        kind: "takosumi.platform-release-source@v1",
        repository: REPOSITORY,
        commit: COMMIT,
      }),
      treeSha256: `sha256:${"b".repeat(64)}`,
      dockerfileSha256: `sha256:${"c".repeat(64)}`,
    },
    image: {
      tag: `takosumi-runner-native-candidate:${COMMIT}`,
      localImageId: LOCAL_IMAGE_ID,
      descriptorDigest: DESCRIPTOR_DIGEST,
      descriptorMediaType:
        "application/vnd.docker.distribution.manifest.v2+json",
      platform: { os: "linux", architecture: "amd64" },
    },
    archive: {
      name: "runner-image.tar",
      size: 123_456,
      sha256: `sha256:${"f".repeat(64)}`,
    },
    nativeProof: {
      kind: RUNNER_IMAGE_NATIVE_PROOF_KIND,
      descriptorDigest: DESCRIPTOR_DIGEST,
      hardenedRuntimeInputPlan: "passed",
      fullHttpPlanApply: "passed",
    },
  } as const;
}

test("native candidate producer accepts only one absolute fresh output directory", () => {
  expect(
    parseRunnerImageNativeCandidateArgs([
      "--output-dir",
      "/tmp/takosumi-runner-native-candidate",
    ]),
  ).toEqual({ outputDir: "/tmp/takosumi-runner-native-candidate" });

  for (const argv of [
    [],
    ["--output-dir"],
    ["--output-dir", "relative"],
    ["--output-dir", "/tmp/one", "--output-dir", "/tmp/two"],
    ["--unknown", "/tmp/one"],
  ]) {
    expect(() => parseRunnerImageNativeCandidateArgs(argv)).toThrow();
  }
});

test("native candidate producer builds once, runs both exact proofs, and exports one descriptor-bound archive", async () => {
  const fixture = nativeCandidateFixture();
  const observed: Array<{
    executable: string;
    args: readonly string[];
    environment?: NodeJS.ProcessEnv;
  }> = [];
  const archiveBytes = Buffer.from("authenticated docker archive\n", "utf8");
  const priorAppArmor = process.env.TAKOSUMI_RUNNER_PROOF_APPARMOR_UNCONFINED;
  const priorCloudflareToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.TAKOSUMI_RUNNER_PROOF_APPARMOR_UNCONFINED = "1";
  process.env.CLOUDFLARE_API_TOKEN = "x";
  let buildHasNoProvenance = false;
  let record: Awaited<ReturnType<typeof runRunnerImageNativeCandidate>>;
  try {
    record = await runRunnerImageNativeCandidate(
      parseRunnerImageNativeCandidateArgs([
        "--output-dir",
        fixture.outputDir,
      ]),
      {
        repositoryRoot: fixture.repository,
        now: () => new Date("2026-09-06T01:02:03.000Z"),
        command: async (executable, args, cwd, environment) => {
          observed.push({ executable, args: [...args], environment });
          if (executable === "git" || executable === "tar") {
            return realCommand(executable, args, cwd, environment);
          }
          if (executable === "curl") {
            const output = args[args.indexOf("--output") + 1]!;
            const url = args.at(-1)!;
            writeFileSync(
              output,
              url.endsWith("_SHA256SUMS")
                ? `${OPENTOFU_SHA256}  tofu_1.12.5_linux_amd64.zip\n`
                : "sigstore material\n",
            );
            return success();
          }
          if (executable === "cosign") return success("Verified OK\n");
          if (executable === "bash") {
            return success("plan: PASS\napply: PASS\nRESULT: PASS\n");
          }
          if (executable === "docker" && args[0] === "buildx") {
            buildHasNoProvenance = args.includes("--provenance=false");
            return success();
          }
          if (
            executable === "docker" &&
            args[0] === "image" &&
            args[1] === "inspect"
          ) {
            return success(
              buildHasNoProvenance
                ? localImageInspect()
                : defaultProvenanceLocalImageInspect(),
            );
          }
          if (executable === "docker" && args[0] === "run") return success();
          if (executable === "docker" && args[0] === "exec") {
            return success("takosumi-runner-boot-ok\n");
          }
          if (executable === "docker" && args[0] === "rm") return success();
          if (
            executable === "docker" &&
            args[0] === "image" &&
            args[1] === "save"
          ) {
            const output = args[args.indexOf("--output") + 1]!;
            writeFileSync(output, archiveBytes);
            return success();
          }
          throw new Error(`unexpected command: ${executable} ${args.join(" ")}`);
        },
      },
    );
  } finally {
    restoreEnvironment(
      "TAKOSUMI_RUNNER_PROOF_APPARMOR_UNCONFINED",
      priorAppArmor,
    );
    restoreEnvironment("CLOUDFLARE_API_TOKEN", priorCloudflareToken);
  }

  expect(record).toMatchObject({
    kind: RUNNER_IMAGE_NATIVE_CANDIDATE_KIND,
    observedAt: "2026-09-06T01:02:03.000Z",
    source: {
      repository: REPOSITORY,
      commit: fixture.commit,
    },
    image: {
      tag: `takosumi-runner-native-candidate:${fixture.commit}`,
      localImageId: LOCAL_IMAGE_ID,
      descriptorDigest: DESCRIPTOR_DIGEST,
      platform: { os: "linux", architecture: "amd64" },
    },
    archive: {
      name: "runner-image.tar",
      size: archiveBytes.byteLength,
      sha256: `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`,
    },
    nativeProof: {
      descriptorDigest: DESCRIPTOR_DIGEST,
      hardenedRuntimeInputPlan: "passed",
      fullHttpPlanApply: "passed",
    },
  });
  expect(
    parseRunnerImageNativeCandidateRecord(
      readFileSync(join(fixture.outputDir, "candidate.json"), "utf8"),
    ),
  ).toEqual(record);
  expect(readFileSync(join(fixture.outputDir, "runner-image.tar"))).toEqual(
    archiveBytes,
  );
  expect(readdirSync(fixture.outputDir).sort()).toEqual([
    "candidate.json",
    "runner-image.tar",
  ]);
  expect(statSync(join(fixture.outputDir, "candidate.json")).mode & 0o777).toBe(
    0o600,
  );
  expect(statSync(fixture.outputDir).mode & 0o777).toBe(0o700);
  expect(
    statSync(join(fixture.outputDir, "runner-image.tar")).mode & 0o777,
  ).toBe(0o600);
  expect(
    observed.filter(
      ({ executable, args }) => executable === "docker" && args[0] === "buildx",
    ),
  ).toHaveLength(1);
  const build = observed.find(
    ({ executable, args }) => executable === "docker" && args[0] === "buildx",
  )!;
  expect(build.args).toContain("--load");
  expect(build.args).toContain("--provenance=false");
  expect(build.args).toContain("linux/amd64");
  const save = observed.find(
    ({ executable, args }) =>
      executable === "docker" && args[0] === "image" && args[1] === "save",
  )!;
  expect(save.args).toContain("--platform");
  expect(save.args).toContain("linux/amd64");
  expect(save.args).toContain(join(fixture.outputDir, "runner-image.tar"));
  const harness = observed.find(({ executable }) => executable === "bash");
  expect(harness?.environment).toMatchObject({
    TAKOSUMI_RUNNER_PROOF_IMAGE: LOCAL_IMAGE_ID,
    TAKOSUMI_RUNNER_PROOF_SKIP_BUILD: "1",
  });
  expect(harness?.environment).not.toHaveProperty(
    "TAKOSUMI_RUNNER_PROOF_APPARMOR_UNCONFINED",
  );
  expect(harness?.environment).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
  const hardenedRun = observed.find(
    ({ executable, args }) => executable === "docker" && args[0] === "run",
  );
  expect(hardenedRun?.args).toContain("--network=none");
  expect(hardenedRun?.args).toContain("--read-only");
  expect(hardenedRun?.args).not.toContain("apparmor=unconfined");
});

test("native candidate producer rejects dirty or mismatched Actions source before creating output", async () => {
  for (const scenario of ["dirty", "actions SHA"] as const) {
    const fixture = nativeCandidateFixture();
    if (scenario === "dirty") {
      writeFileSync(join(fixture.repository, "untracked.txt"), "dirty\n");
    }
    const priorActions = process.env.GITHUB_ACTIONS;
    const priorSha = process.env.GITHUB_SHA;
    const priorRepository = process.env.GITHUB_REPOSITORY;
    if (scenario === "actions SHA") {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_SHA = "f".repeat(40);
      process.env.GITHUB_REPOSITORY = "tako0614/takosumi";
    }
    try {
      await expect(
        runRunnerImageNativeCandidate(
          { outputDir: fixture.outputDir },
          { repositoryRoot: fixture.repository, command: realCommand },
        ),
      ).rejects.toThrow();
    } finally {
      restoreEnvironment("GITHUB_ACTIONS", priorActions);
      restoreEnvironment("GITHUB_SHA", priorSha);
      restoreEnvironment("GITHUB_REPOSITORY", priorRepository);
    }
    expect(existsSync(fixture.outputDir), scenario).toBeFalse();
  }
});

function nativeCandidateFixture(): Readonly<{
  repository: string;
  outputDir: string;
  commit: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "runner-native-candidate-test-"));
  roots.push(root);
  const repository = join(root, "takosumi");
  mkdirSync(join(repository, "runner"), { recursive: true });
  mkdirSync(join(repository, "scripts"), { recursive: true });
  writeFileSync(
    join(repository, "runner", "Dockerfile"),
    [
      "FROM scratch",
      "ARG OPENTOFU_VERSION=1.12.5",
      `ARG OPENTOFU_SHA256=${OPENTOFU_SHA256}`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(repository, "scripts", "prove-runner-docker.sh"),
    "#!/usr/bin/env bash\nexit 1\n",
  );
  chmodSync(join(repository, "scripts", "prove-runner-docker.sh"), 0o755);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Candidate Test"], {
    cwd: repository,
  });
  execFileSync("git", ["config", "user.email", "candidate@example.invalid"], {
    cwd: repository,
  });
  execFileSync("git", ["add", "."], { cwd: repository });
  execFileSync("git", ["commit", "-m", "candidate source"], {
    cwd: repository,
  });
  execFileSync("git", ["remote", "add", "origin", REPOSITORY], {
    cwd: repository,
  });
  return {
    repository,
    outputDir: join(root, "operator", "runner-native-candidate"),
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
  };
}

async function realCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment?: NodeJS.ProcessEnv,
) {
  const process = Bun.spawn([executable, ...args], {
    cwd,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function success(stdout = "") {
  return { exitCode: 0, stdout, stderr: "" };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function localImageInspect(): string {
  return JSON.stringify({
    Id: LOCAL_IMAGE_ID,
    Descriptor: {
      digest: DESCRIPTOR_DIGEST,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    },
    Os: "linux",
    Architecture: "amd64",
  });
}

function defaultProvenanceLocalImageInspect(): string {
  return JSON.stringify({
    Id: DEFAULT_PROVENANCE_LOCAL_IMAGE_ID,
    Descriptor: {
      digest: DEFAULT_PROVENANCE_LOCAL_IMAGE_ID,
      mediaType: "application/vnd.oci.image.index.v1+json",
    },
    Os: "linux",
    Architecture: "amd64",
  });
}

test("Docker 29 provenance indexes stay refused while the single manifest keeps local and config identities distinct", () => {
  expect(() =>
    parseLocalRunnerImageIdentity(defaultProvenanceLocalImageInspect()),
  ).toThrow("runner_image_local_identity_invalid");
  const identity = parseLocalRunnerImageIdentity(localImageInspect());
  expect(identity).toEqual({
    localImageId: LOCAL_IMAGE_ID,
    descriptorDigest: DESCRIPTOR_DIGEST,
    descriptorMediaType:
      "application/vnd.docker.distribution.manifest.v2+json",
    platform: { os: "linux", architecture: "amd64" },
  });
  expect(identity.localImageId).not.toBe(OCI_CONFIG_DIGEST);
  expect(identity).not.toHaveProperty("configDigest");
});

test("native candidate record is closed and binds both native proofs to one linux amd64 descriptor", () => {
  const expected = candidateRecord();
  expect(
    parseRunnerImageNativeCandidateRecord(`${JSON.stringify(expected)}\n`),
  ).toEqual(expected);

  for (const invalid of [
    { ...expected, unexpected: true },
    { ...expected, observedAt: "2026-09-06" },
    {
      ...expected,
      source: {
        ...expected.source,
        repository: "https://github.com/../takosumi.git",
      },
    },
    {
      ...expected,
      image: {
        ...expected.image,
        platform: { os: "linux", architecture: "arm64" },
      },
    },
    {
      ...expected,
      nativeProof: {
        ...expected.nativeProof,
        descriptorDigest: `sha256:${"0".repeat(64)}`,
      },
    },
    {
      ...expected,
      archive: { ...expected.archive, name: "forged.tar" },
    },
  ]) {
    expect(() =>
      parseRunnerImageNativeCandidateRecord(JSON.stringify(invalid)),
    ).toThrow("runner_image_native_candidate_record_invalid");
  }
});
