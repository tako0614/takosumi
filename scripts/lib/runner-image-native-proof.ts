import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

import { dashboardAssetTreeSeal } from "../platform-worker-release.ts";
import { platformReleaseSourceAuthorityDigest } from "./platform-release-source.ts";

export const RUNNER_IMAGE_NATIVE_CANDIDATE_KIND =
  "takosumi.runner-image-native-candidate@v1" as const;
export const RUNNER_IMAGE_NATIVE_PROOF_KIND =
  "takosumi.runner-image-native-proof@v1" as const;

export const DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE =
  "application/vnd.docker.distribution.manifest.v2+json" as const;
export const OCI_IMAGE_MANIFEST_MEDIA_TYPE =
  "application/vnd.oci.image.manifest.v1+json" as const;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const GITHUB_REPOSITORY_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]+)\.git$/u;
const GITHUB_REPOSITORY_SLUG =
  /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]+)$/u;
export const RUNNER_IMAGE_NATIVE_CANDIDATE_ARCHIVE_MAX_BYTES =
  8 * 1024 * 1024 * 1024;
export const RUNNER_BOOT_SMOKE_OUTPUT_MAX_BYTES = 4_096;
export const RUNNER_BOOT_SMOKE_MARKER = "takosumi-runner-boot-ok" as const;
const RUNNER_RUNTIME_INPUT_PLAN_VARIABLE = "takosumi_runtime_inputs__probe";
const RUNNER_RUNTIME_INPUT_PLAN_NAME = "PROBE_TOKEN";

export type RunnerImageNativeCommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type RunnerImageNativeCommand = (
  executable: string,
  args: readonly string[],
  cwd: string,
  environment?: NodeJS.ProcessEnv,
) => Promise<RunnerImageNativeCommandResult>;

export type MaterializedRunnerSource = Readonly<{
  sourceRoot: string;
  dockerfilePath: string;
  dockerfileSource: Uint8Array;
  dockerfileSha256: string;
  buildContext: ReturnType<typeof dashboardAssetTreeSeal>;
}>;

export type LocalRunnerImageIdentity = Readonly<{
  localImageId: string;
  descriptorDigest: string;
  descriptorMediaType:
    | typeof DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE
    | typeof OCI_IMAGE_MANIFEST_MEDIA_TYPE;
  platform: { os: "linux"; architecture: "amd64" };
}>;

export type RunnerImageHardenedNativeProof = Readonly<{
  descriptorDigest: string;
  hardenedRuntimeInputPlan: "passed";
}>;

export type RunnerImageNativeCandidateRecord = Readonly<{
  kind: typeof RUNNER_IMAGE_NATIVE_CANDIDATE_KIND;
  observedAt: string;
  source: {
    repository: string;
    commit: string;
    authoritySha256: string;
    treeSha256: string;
    dockerfileSha256: string;
  };
  image: {
    tag: string;
    localImageId: string;
    descriptorDigest: string;
    descriptorMediaType:
      | typeof DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE
      | typeof OCI_IMAGE_MANIFEST_MEDIA_TYPE;
    platform: { os: "linux"; architecture: "amd64" };
  };
  archive: {
    name: "runner-image.tar";
    size: number;
    sha256: string;
  };
  nativeProof: {
    kind: typeof RUNNER_IMAGE_NATIVE_PROOF_KIND;
    descriptorDigest: string;
    hardenedRuntimeInputPlan: "passed";
    fullHttpPlanApply: "passed";
  };
}>;

export function parseRunnerImageNativeCandidateRecord(
  source: string,
): RunnerImageNativeCandidateRecord {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error("runner_image_native_candidate_record_invalid");
  }
  if (!isRunnerImageNativeCandidateRecord(value)) {
    throw new Error("runner_image_native_candidate_record_invalid");
  }
  return value;
}

export function isRunnerImageNativeCandidateRecord(
  value: unknown,
): value is RunnerImageNativeCandidateRecord {
  if (
    !record(value) ||
    !exactKeys(value, [
      "archive",
      "image",
      "kind",
      "nativeProof",
      "observedAt",
      "source",
    ]) ||
    value.kind !== RUNNER_IMAGE_NATIVE_CANDIDATE_KIND ||
    typeof value.observedAt !== "string" ||
    !isCanonicalTimestamp(value.observedAt) ||
    !record(value.source) ||
    !exactKeys(value.source, [
      "authoritySha256",
      "commit",
      "dockerfileSha256",
      "repository",
      "treeSha256",
    ]) ||
    typeof value.source.repository !== "string" ||
    !isCanonicalGithubRepositoryUrl(value.source.repository) ||
    typeof value.source.commit !== "string" ||
    !COMMIT.test(value.source.commit) ||
    typeof value.source.authoritySha256 !== "string" ||
    !SHA256.test(value.source.authoritySha256) ||
    value.source.authoritySha256 !==
      platformReleaseSourceAuthorityDigest({
        kind: "takosumi.platform-release-source@v1",
        repository: value.source.repository,
        commit: value.source.commit,
      }) ||
    typeof value.source.treeSha256 !== "string" ||
    !SHA256.test(value.source.treeSha256) ||
    typeof value.source.dockerfileSha256 !== "string" ||
    !SHA256.test(value.source.dockerfileSha256) ||
    !record(value.image) ||
    !exactKeys(value.image, [
      "descriptorDigest",
      "descriptorMediaType",
      "localImageId",
      "platform",
      "tag",
    ]) ||
    value.image.tag !==
      `takosumi-runner-native-candidate:${value.source.commit}` ||
    typeof value.image.localImageId !== "string" ||
    !SHA256.test(value.image.localImageId) ||
    typeof value.image.descriptorDigest !== "string" ||
    !SHA256.test(value.image.descriptorDigest) ||
    (value.image.descriptorMediaType !==
      DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE &&
      value.image.descriptorMediaType !== OCI_IMAGE_MANIFEST_MEDIA_TYPE) ||
    !record(value.image.platform) ||
    !exactKeys(value.image.platform, ["architecture", "os"]) ||
    value.image.platform.os !== "linux" ||
    value.image.platform.architecture !== "amd64" ||
    !record(value.archive) ||
    !exactKeys(value.archive, ["name", "sha256", "size"]) ||
    value.archive.name !== "runner-image.tar" ||
    typeof value.archive.size !== "number" ||
    !Number.isSafeInteger(value.archive.size) ||
    value.archive.size <= 0 ||
    value.archive.size > RUNNER_IMAGE_NATIVE_CANDIDATE_ARCHIVE_MAX_BYTES ||
    typeof value.archive.sha256 !== "string" ||
    !SHA256.test(value.archive.sha256) ||
    !record(value.nativeProof) ||
    !exactKeys(value.nativeProof, [
      "descriptorDigest",
      "fullHttpPlanApply",
      "hardenedRuntimeInputPlan",
      "kind",
    ]) ||
    value.nativeProof.kind !== RUNNER_IMAGE_NATIVE_PROOF_KIND ||
    value.nativeProof.descriptorDigest !== value.image.descriptorDigest ||
    value.nativeProof.hardenedRuntimeInputPlan !== "passed" ||
    value.nativeProof.fullHttpPlanApply !== "passed"
  ) {
    return false;
  }
  return true;
}

export function githubRepositoryFromRemote(remote: string): string {
  const normalized = remote
    .trim()
    .replace(/^git\+https:\/\//u, "https://")
    .replace(/^ssh:\/\/git@github\.com\//u, "https://github.com/")
    .replace(/^git@github\.com:/u, "https://github.com/")
    .replace(/\.git$/u, "");
  const match = GITHUB_REPOSITORY_SLUG.exec(
    normalized.replace(/^https:\/\/github\.com\//u, ""),
  );
  if (!match || !validGithubRepositoryName(match[2]!)) {
    throw new Error("runner_image_native_candidate_repository_invalid");
  }
  return `${match[1]!}/${match[2]!}`;
}

function isCanonicalGithubRepositoryUrl(value: string): boolean {
  const match = GITHUB_REPOSITORY_URL.exec(value);
  return match !== null && validGithubRepositoryName(match[2]!);
}

function validGithubRepositoryName(value: string): boolean {
  return value !== "." && value !== "..";
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export async function materializeRunnerSource(
  repositoryRoot: string,
  commit: string,
  workspace: string,
  command: RunnerImageNativeCommand,
  materializeSource?: (
    repositoryRoot: string,
    commit: string,
    destination: string,
  ) => Promise<void>,
): Promise<MaterializedRunnerSource> {
  if (!COMMIT.test(commit)) {
    throw new Error("runner_image_sealed_source_mismatch");
  }
  const sourceRoot = join(workspace, "source");
  await mkdir(sourceRoot, { mode: 0o700 });
  if (materializeSource) {
    await materializeSource(repositoryRoot, commit, sourceRoot);
  } else {
    const archive = join(workspace, "source.tar");
    await checkedNativeCommand(
      command,
      "git",
      [
        "--no-replace-objects",
        "archive",
        "--format=tar",
        `--output=${archive}`,
        commit,
      ],
      repositoryRoot,
    );
    await checkedNativeCommand(
      command,
      "tar",
      [
        "--extract",
        "--file",
        archive,
        "--directory",
        sourceRoot,
        "--no-same-owner",
        "--no-same-permissions",
      ],
      workspace,
    );
    await rm(archive);
  }
  const dockerfilePath = join(sourceRoot, "runner", "Dockerfile");
  const dockerfileSource = await readStablePhysicalFile(
    dockerfilePath,
    "sealed Dockerfile",
  );
  return {
    sourceRoot,
    dockerfilePath,
    dockerfileSource,
    dockerfileSha256: sha256(dockerfileSource),
    buildContext: dashboardAssetTreeSeal(sourceRoot),
  };
}

export async function verifyRunnerOpenTofuSigstore(
  dockerfileSource: string,
  workspace: string,
  command: RunnerImageNativeCommand,
  cwd: string,
): Promise<void> {
  const versionMatches = [
    ...dockerfileSource.matchAll(/^ARG OPENTOFU_VERSION=([^\s]+)$/gmu),
  ];
  const checksumMatches = [
    ...dockerfileSource.matchAll(/^ARG OPENTOFU_SHA256=([0-9a-f]{64})$/gmu),
  ];
  if (
    versionMatches.length !== 1 ||
    checksumMatches.length !== 1 ||
    !/^\d+\.\d+\.\d+$/u.test(versionMatches[0]![1]!)
  ) {
    throw new Error("runner_image_opentofu_identity_invalid");
  }
  const version = versionMatches[0]![1]!;
  const expectedChecksum = checksumMatches[0]![1]!;
  const majorMinor = version.split(".").slice(0, 2).join(".");
  const base = `https://github.com/opentofu/opentofu/releases/download/v${version}`;
  const upstream = join(workspace, "opentofu-upstream");
  await mkdir(upstream, { mode: 0o700 });
  const sums = join(upstream, `tofu_${version}_SHA256SUMS`);
  const signature = `${sums}.sig`;
  const certificate = `${sums}.pem`;
  for (const [url, output] of [
    [`${base}/tofu_${version}_SHA256SUMS`, sums],
    [`${base}/tofu_${version}_SHA256SUMS.sig`, signature],
    [`${base}/tofu_${version}_SHA256SUMS.pem`, certificate],
  ] as const) {
    await checkedNativeCommand(
      command,
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--output",
        output,
        url,
      ],
      cwd,
    );
  }
  await checkedNativeCommand(
    command,
    "cosign",
    [
      "verify-blob",
      "--certificate-identity",
      `https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/heads/v${majorMinor}`,
      "--signature",
      signature,
      "--certificate",
      certificate,
      "--certificate-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      sums,
    ],
    cwd,
  );
  const sumsSource = new TextDecoder("utf-8", { fatal: true }).decode(
    await readStablePhysicalFile(sums, "OpenTofu checksums"),
  );
  const asset = `tofu_${version}_linux_amd64.zip`;
  const matching = sumsSource
    .split(/\r?\n/u)
    .filter((line) => line === `${expectedChecksum}  ${asset}`);
  if (matching.length !== 1) {
    throw new Error("runner_image_opentofu_checksum_invalid");
  }
}

export function parseLocalRunnerImageIdentity(
  source: string,
): LocalRunnerImageIdentity {
  let value: unknown;
  try {
    value = JSON.parse(source.trim()) as unknown;
  } catch {
    throw new Error("runner_image_local_identity_invalid");
  }
  if (
    !record(value) ||
    typeof value.Id !== "string" ||
    !SHA256.test(value.Id) ||
    !record(value.Descriptor) ||
    typeof value.Descriptor.digest !== "string" ||
    !SHA256.test(value.Descriptor.digest) ||
    (value.Descriptor.mediaType !== DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE &&
      value.Descriptor.mediaType !== OCI_IMAGE_MANIFEST_MEDIA_TYPE) ||
    value.Os !== "linux" ||
    value.Architecture !== "amd64"
  ) {
    throw new Error("runner_image_local_identity_invalid");
  }
  return {
    localImageId: value.Id,
    descriptorDigest: value.Descriptor.digest,
    descriptorMediaType: value.Descriptor.mediaType,
    platform: { os: "linux", architecture: "amd64" },
  };
}

export async function proveRunnerImageHardenedNative(
  identity: LocalRunnerImageIdentity,
  proofToken: string,
  command: RunnerImageNativeCommand,
  cwd: string,
): Promise<RunnerImageHardenedNativeProof> {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(proofToken)) {
    throw new Error("runner_image_boot_smoke_identity_invalid");
  }
  const containerName = `takosumi-runner-boot-${proofToken}`;
  const runId = `runner-release-proof-${proofToken}`;
  const planRequest = runnerRuntimeInputPlanRequest(runId);
  const childModuleSource =
    'output "message" {\n  value = "runtime-input-plan-proof"\n}\n';
  const smokeScript = [
    `const marker=${JSON.stringify(RUNNER_BOOT_SMOKE_MARKER)};`,
    `const runId=${JSON.stringify(runId)};`,
    `const request=${JSON.stringify(planRequest)};`,
    `const moduleSource=${JSON.stringify(childModuleSource)};`,
    "let exitCode=1;",
    "const controller=new AbortController();",
    "const timer=setTimeout(()=>{controller.abort();process.exit(1);},25000);",
    "try{",
    'if(typeof process.getuid!=="function"||process.getuid()===0)throw new Error("nonprivileged runner required");',
    "let response;",
    "while(!controller.signal.aborted){",
    'try{response=await fetch("http://127.0.0.1:8080/healthz",{signal:controller.signal});break;}catch{await Bun.sleep(25);}',
    "}",
    'if(!response)throw new Error("health unavailable");',
    'if(response.status!==200)throw new Error("health status");',
    "const body=await response.json();",
    'if(!body||body.ok!==true||body.runner!=="opentofu")throw new Error("health payload");',
    'const runRoot=(Bun.env.TAKOSUMI_OPENTOFU_RUN_ROOT||"/tmp/takosumi-runs")+"/"+runId+"/source";',
    'const mkdir=Bun.spawn(["mkdir","-p",runRoot],{stdout:"ignore",stderr:"ignore"});',
    'if(await mkdir.exited!==0)throw new Error("source preparation");',
    'if(await Bun.write(runRoot+"/main.tf",moduleSource)!==new TextEncoder().encode(moduleSource).byteLength)throw new Error("source write");',
    'const plan=await fetch("http://127.0.0.1:8080/runs/"+encodeURIComponent(runId),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(request),signal:controller.signal});',
    'if(plan.status!==200)throw new Error("plan status");',
    "const result=await plan.json();",
    'if(!result||result.status!=="succeeded"||result.exitCode!==0||typeof result.planDigest!=="string"||result.planDigest.length===0)throw new Error("plan payload");',
    "process.stdout.write(marker+'\\n');",
    "exitCode=0;",
    "}catch{}finally{clearTimeout(timer);}",
    "process.exit(exitCode);",
  ].join(" ");
  let failure: unknown | null = null;
  try {
    await checkedNativeCommand(
      command,
      "docker",
      [
        "run",
        "--detach",
        "--pull=never",
        "--rm",
        "--network=none",
        "--read-only",
        "--name",
        containerName,
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=16m",
        "--cap-drop=ALL",
        "--security-opt",
        "no-new-privileges",
        identity.localImageId,
      ],
      cwd,
    );
    const result = await checkedNativeCommand(
      command,
      "docker",
      ["exec", containerName, "/usr/local/bin/bun", "-e", smokeScript],
      cwd,
    );
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (
      Buffer.byteLength(output, "utf8") > RUNNER_BOOT_SMOKE_OUTPUT_MAX_BYTES ||
      output.split(/\r?\n/u).at(-1) !== RUNNER_BOOT_SMOKE_MARKER
    ) {
      throw new Error("runner_image_boot_smoke_output_invalid");
    }
  } catch (error) {
    failure = error;
  }
  const cleanupError = await cleanupRunnerImageBootSmoke(
    containerName,
    command,
    cwd,
  );
  if (cleanupError !== null) {
    throw new Error("runner_image_boot_smoke_cleanup_failed", {
      cause: cleanupError,
    });
  }
  if (failure !== null) {
    throw new Error("runner_image_boot_smoke_failed", { cause: failure });
  }
  return {
    descriptorDigest: identity.descriptorDigest,
    hardenedRuntimeInputPlan: "passed",
  };
}

function runnerRuntimeInputPlanRequest(
  runId: string,
): Readonly<Record<string, unknown>> {
  return {
    kind: "takosumi.opentofu-run@v1",
    action: "plan",
    runId,
    requestedAt: "2026-09-05T00:00:00.000Z",
    request: {
      planRun: {
        id: runId,
        operation: "create",
        source: {
          kind: "git",
          url: "https://proof.invalid/runner-runtime-input-plan.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
        },
      },
      generatedRoot: {
        files: {
          "versions.tf": "terraform {}\n",
          "variables.tf": [
            `variable "${RUNNER_RUNTIME_INPUT_PLAN_VARIABLE}" {`,
            "  type      = map(string)",
            "  sensitive = true",
            "  ephemeral = true",
            "}",
            "",
          ].join("\n"),
          "main.tf": 'module "child" {\n  source = "./module"\n}\n',
          "outputs.tf":
            'output "message" {\n  value = module.child.message\n}\n',
        },
      },
      requiredProviders: [],
      runnerProfile: {
        id: "runner-release-runtime-input-plan-proof",
        allowedProviders: [],
        deniedProviders: [],
        requireProviderBindings: false,
      },
      outputAllowlist: { message: { from: "message" } },
      credentials: {
        env: { [RUNNER_RUNTIME_INPUT_PLAN_NAME]: "runner-release-proof" },
        manifest: {
          bindings: [
            {
              providerSource: "registry.opentofu.org/example/probe",
              connectionId: "conn_runner_release_probe",
              recipeId: "runner-release-probe",
              authMode: "token",
              envNames: [RUNNER_RUNTIME_INPUT_PLAN_NAME],
              fileEnvNames: [],
              requiredEnvGroups: [[RUNNER_RUNTIME_INPUT_PLAN_NAME]],
            },
          ],
        },
        runtimeInputs: [
          {
            variableName: RUNNER_RUNTIME_INPUT_PLAN_VARIABLE,
            names: [RUNNER_RUNTIME_INPUT_PLAN_NAME],
            values: {},
          },
        ],
      },
    },
  };
}

async function cleanupRunnerImageBootSmoke(
  containerName: string,
  command: RunnerImageNativeCommand,
  cwd: string,
): Promise<unknown | null> {
  try {
    const result = await command(
      "docker",
      ["rm", "--force", containerName],
      cwd,
    );
    if (result.exitCode === 0 || runnerBootSmokeContainerAbsent(result, containerName)) {
      return null;
    }
    return new RunnerImageNativeCommandError(
      nativeCommandLabel("docker", ["rm", "--force", containerName]),
      result,
    );
  } catch (error) {
    return error;
  }
}

function runnerBootSmokeContainerAbsent(
  result: RunnerImageNativeCommandResult,
  containerName: string,
): boolean {
  if (result.exitCode !== 1) return false;
  const diagnostic = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    diagnostic.includes(containerName.toLowerCase()) &&
    (diagnostic.includes("no such container") ||
      diagnostic.includes("no such object"))
  );
}

async function checkedNativeCommand(
  command: RunnerImageNativeCommand,
  executable: string,
  args: readonly string[],
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Promise<RunnerImageNativeCommandResult> {
  const result = await command(executable, args, cwd, environment);
  if (result.exitCode !== 0) {
    throw new RunnerImageNativeCommandError(
      nativeCommandLabel(executable, args),
      result,
    );
  }
  return result;
}

export class RunnerImageNativeCommandError extends Error {
  readonly result: RunnerImageNativeCommandResult;
  readonly commandLabel: string;

  constructor(commandLabel: string, result: RunnerImageNativeCommandResult) {
    super(`${commandLabel} failed with exit ${result.exitCode}`);
    this.name = "RunnerImageNativeCommandError";
    this.commandLabel = commandLabel;
    this.result = result;
  }
}

function nativeCommandLabel(
  executable: string,
  args: readonly string[],
): string {
  return [executable, ...args.slice(0, 3)].join(" ").slice(0, 160);
}

async function readStablePhysicalFile(
  path: string,
  label: string,
): Promise<Uint8Array> {
  let pathBefore: BigIntStats;
  try {
    pathBefore = await lstat(path, { bigint: true });
  } catch {
    throw new Error(`${label} must be a single-link physical file`);
  }
  if (
    pathBefore.isSymbolicLink() ||
    !pathBefore.isFile() ||
    pathBefore.nlink !== 1n
  ) {
    throw new Error(`${label} must be a single-link physical file`);
  }
  const descriptor = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const openedBefore = await descriptor.stat({ bigint: true });
    if (!samePhysicalFile(pathBefore, openedBefore)) {
      throw new Error(`${label} changed while opening`);
    }
    const bytes = await descriptor.readFile();
    const openedAfter = await descriptor.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (
      BigInt(bytes.byteLength) !== openedBefore.size ||
      !samePhysicalFile(openedBefore, openedAfter) ||
      !samePhysicalFile(openedAfter, pathAfter)
    ) {
      throw new Error(`${label} changed while reading`);
    }
    return bytes;
  } finally {
    await descriptor.close();
  }
}

function samePhysicalFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === required.length &&
    keys.every((key) => required.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
