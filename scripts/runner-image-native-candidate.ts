import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import {
  githubRepositoryFromRemote,
  materializeRunnerSource,
  parseLocalRunnerImageIdentity,
  parseRunnerImageNativeCandidateRecord,
  proveRunnerImageHardenedNative,
  RUNNER_IMAGE_NATIVE_CANDIDATE_ARCHIVE_MAX_BYTES,
  RUNNER_IMAGE_NATIVE_CANDIDATE_KIND,
  RUNNER_IMAGE_NATIVE_PROOF_KIND,
  verifyRunnerOpenTofuSigstore,
  type LocalRunnerImageIdentity,
  type RunnerImageNativeCandidateRecord,
  type RunnerImageNativeCommand,
  type RunnerImageNativeCommandResult,
} from "./lib/runner-image-native-proof.ts";
import { platformReleaseSourceAuthorityDigest } from "./lib/platform-release-source.ts";
import { dashboardAssetTreeSeal } from "./platform-worker-release.ts";

export type RunnerImageNativeCandidateOptions = Readonly<{
  outputDir: string;
}>;

export type RunnerImageNativeCandidateRuntime = Readonly<{
  repositoryRoot?: string;
  now?: () => Date;
  command?: RunnerImageNativeCommand;
}>;

export const RUNNER_IMAGE_NATIVE_CANDIDATE_USAGE = `Takosumi runner native candidate producer

Usage:
  bun scripts/runner-image-native-candidate.ts --output-dir <absolute-external-fresh-directory>`;

export function parseRunnerImageNativeCandidateArgs(
  argv: readonly string[],
): RunnerImageNativeCandidateOptions {
  if (
    argv.length !== 2 ||
    argv[0] !== "--output-dir" ||
    argv[1] === undefined ||
    !isAbsolute(argv[1])
  ) {
    throw new Error(RUNNER_IMAGE_NATIVE_CANDIDATE_USAGE);
  }
  return { outputDir: argv[1] };
}

export async function runRunnerImageNativeCandidate(
  options: RunnerImageNativeCandidateOptions,
  runtime: RunnerImageNativeCandidateRuntime = {},
): Promise<RunnerImageNativeCandidateRecord> {
  const repositoryRoot = await canonicalDirectory(
    runtime.repositoryRoot ?? resolve(import.meta.dir, ".."),
    "repository root",
  );
  const command = runtime.command ?? nativeCandidateCommand;
  const source = await nativeCandidateSourceIdentity(repositoryRoot, command);
  const outputDir = await createFreshExternalOutputDirectory(
    options.outputDir,
    repositoryRoot,
  );
  const workspace = await mkdtemp(join(outputDir, ".work-"));
  await chmod(workspace, 0o700);
  let complete = false;
  try {
    const materialized = await materializeRunnerSource(
      repositoryRoot,
      source.commit,
      workspace,
      command,
    );
    await verifyRunnerOpenTofuSigstore(
      new TextDecoder("utf-8", { fatal: true }).decode(
        materialized.dockerfileSource,
      ),
      workspace,
      command,
      repositoryRoot,
    );
    const imageTag = `takosumi-runner-native-candidate:${source.commit}`;
    await checkedCommand(
      command,
      "docker",
      [
        "buildx",
        "build",
        "--load",
        "--provenance=false",
        "--platform",
        "linux/amd64",
        "--file",
        materialized.dockerfilePath,
        "--tag",
        imageTag,
        materialized.sourceRoot,
      ],
      workspace,
    );
    assertMaterializedSourceUnchanged(materialized);
    const identity = await inspectLocalImage(
      imageTag,
      command,
      workspace,
    );
    const hardenedProof = await proveRunnerImageHardenedNative(
      identity,
      `candidate-${source.commit.slice(0, 24)}`,
      command,
      workspace,
    );
    const harness = await checkedCommand(
      command,
      "bash",
      [join(materialized.sourceRoot, "scripts", "prove-runner-docker.sh")],
      materialized.sourceRoot,
      candidateChildEnvironment({
        TAKOSUMI_RUNNER_PROOF_IMAGE: identity.localImageId,
        TAKOSUMI_RUNNER_PROOF_SKIP_BUILD: "1",
      }),
    );
    if (
      harness.stdout
        .split(/\r?\n/u)
        .filter((line) => line === "RESULT: PASS").length !== 1
    ) {
      throw new Error("runner_image_native_candidate_http_proof_invalid");
    }
    assertMaterializedSourceUnchanged(materialized);
    assertSameLocalIdentity(
      identity,
      await inspectLocalImage(imageTag, command, workspace),
    );
    const archivePath = join(outputDir, "runner-image.tar");
    await checkedCommand(
      command,
      "docker",
      [
        "image",
        "save",
        "--platform",
        "linux/amd64",
        "--output",
        archivePath,
        imageTag,
      ],
      workspace,
    );
    await chmod(archivePath, 0o600);
    assertMaterializedSourceUnchanged(materialized);
    assertSameLocalIdentity(
      identity,
      await inspectLocalImage(imageTag, command, workspace),
    );
    const archive = await hashStableFile(
      archivePath,
      "candidate archive",
      RUNNER_IMAGE_NATIVE_CANDIDATE_ARCHIVE_MAX_BYTES,
    );
    const record: RunnerImageNativeCandidateRecord = {
      kind: RUNNER_IMAGE_NATIVE_CANDIDATE_KIND,
      observedAt: (runtime.now ?? (() => new Date()))().toISOString(),
      source: {
        repository: source.repository,
        commit: source.commit,
        authoritySha256: platformReleaseSourceAuthorityDigest({
          kind: "takosumi.platform-release-source@v1",
          repository: source.repository,
          commit: source.commit,
        }),
        treeSha256: materialized.buildContext.digest,
        dockerfileSha256: materialized.dockerfileSha256,
      },
      image: {
        tag: imageTag,
        localImageId: identity.localImageId,
        descriptorDigest: identity.descriptorDigest,
        descriptorMediaType: identity.descriptorMediaType,
        platform: identity.platform,
      },
      archive: {
        name: "runner-image.tar",
        size: archive.size,
        sha256: archive.sha256,
      },
      nativeProof: {
        kind: RUNNER_IMAGE_NATIVE_PROOF_KIND,
        descriptorDigest: hardenedProof.descriptorDigest,
        hardenedRuntimeInputPlan: hardenedProof.hardenedRuntimeInputPlan,
        fullHttpPlanApply: "passed",
      },
    };
    parseRunnerImageNativeCandidateRecord(JSON.stringify(record));
    const recordPath = join(outputDir, "candidate.json");
    const descriptor = await open(
      recordPath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await descriptor.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
    await syncDirectory(outputDir);
    complete = true;
    return record;
  } finally {
    await rm(workspace, { recursive: true, force: true });
    if (!complete) {
      await rm(outputDir, { recursive: true, force: true });
    }
  }
}

type NativeCandidateSourceIdentity = Readonly<{
  repository: string;
  commit: string;
}>;

async function nativeCandidateSourceIdentity(
  repositoryRoot: string,
  command: RunnerImageNativeCommand,
): Promise<NativeCandidateSourceIdentity> {
  const replaceRefs = await checkedCommand(
    command,
    "git",
    [
      "--no-replace-objects",
      "for-each-ref",
      "--format=%(refname)",
      "refs/replace",
    ],
    repositoryRoot,
  );
  if (replaceRefs.stdout.trim()) {
    throw new Error("runner_image_native_candidate_replace_refs_forbidden");
  }
  const status = await checkedCommand(
    command,
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    repositoryRoot,
  );
  if (status.stdout.trim()) {
    throw new Error("runner_image_native_candidate_source_not_clean");
  }
  const commit = (
    await checkedCommand(
      command,
      "git",
      ["--no-replace-objects", "rev-parse", "--verify", "HEAD^{commit}"],
      repositoryRoot,
    )
  ).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("runner_image_native_candidate_source_invalid");
  }
  const remote = (
    await checkedCommand(
      command,
      "git",
      ["remote", "get-url", "origin"],
      repositoryRoot,
    )
  ).stdout.trim();
  const githubRepository = githubRepositoryFromRemote(remote);
  const repository = `https://github.com/${githubRepository}.git`;
  if (process.env.GITHUB_ACTIONS === "true") {
    if (
      process.env.GITHUB_SHA !== commit ||
      process.env.GITHUB_REPOSITORY?.toLowerCase() !==
        githubRepository.toLowerCase()
    ) {
      throw new Error("runner_image_native_candidate_actions_source_mismatch");
    }
  }
  return { repository, commit };
}

function assertMaterializedSourceUnchanged(
  materialized: Awaited<ReturnType<typeof materializeRunnerSource>>,
): void {
  const current = dashboardAssetTreeSeal(materialized.sourceRoot);
  if (JSON.stringify(current) !== JSON.stringify(materialized.buildContext)) {
    throw new Error("runner_image_sealed_source_drift");
  }
}

async function inspectLocalImage(
  image: string,
  command: RunnerImageNativeCommand,
  cwd: string,
): Promise<LocalRunnerImageIdentity> {
  const inspected = await checkedCommand(
    command,
    "docker",
    ["image", "inspect", image, "--format", "{{json .}}"],
    cwd,
  );
  return parseLocalRunnerImageIdentity(inspected.stdout);
}

function assertSameLocalIdentity(
  expected: LocalRunnerImageIdentity,
  actual: LocalRunnerImageIdentity,
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("runner_image_native_candidate_local_identity_drift");
  }
}

async function createFreshExternalOutputDirectory(
  path: string,
  repositoryRoot: string,
): Promise<string> {
  if (!isAbsolute(path)) {
    throw new Error("runner_image_native_candidate_output_invalid");
  }
  const absolute = resolve(path);
  const future = await canonicalFuturePath(absolute);
  if (isInside(future, repositoryRoot)) {
    throw new Error("runner_image_native_candidate_output_must_be_external");
  }
  await assertOutsideEveryGitWorktree(future);
  try {
    await lstat(absolute);
    throw new Error("runner_image_native_candidate_output_must_be_fresh");
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(absolute));
  if (parent !== dirname(absolute)) {
    throw new Error("runner_image_native_candidate_output_invalid");
  }
  await mkdir(absolute, { mode: 0o700 });
  if ((await realpath(absolute)) !== absolute) {
    throw new Error("runner_image_native_candidate_output_invalid");
  }
  return absolute;
}

async function canonicalFuturePath(path: string): Promise<string> {
  let cursor = path;
  const missing: string[] = [];
  for (;;) {
    try {
      const canonical = await realpath(cursor);
      return resolve(canonical, ...missing);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

async function assertOutsideEveryGitWorktree(path: string): Promise<void> {
  let cursor = dirname(path);
  for (;;) {
    try {
      await lstat(join(cursor, ".git"));
      throw new Error("runner_image_native_candidate_output_must_be_external");
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const info = await lstat(path);
  const canonical = await realpath(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a physical directory`);
  }
  return canonical;
}

async function hashStableFile(
  path: string,
  label: string,
  maximumBytes: number,
): Promise<Readonly<{ size: number; sha256: string }>> {
  const pathBefore = await lstat(path, { bigint: true });
  if (
    pathBefore.isSymbolicLink() ||
    !pathBefore.isFile() ||
    pathBefore.nlink !== 1n ||
    pathBefore.size <= 0n ||
    pathBefore.size > BigInt(maximumBytes) ||
    (pathBefore.mode & 0o777n) !== 0o600n ||
    (process.getuid && pathBefore.uid !== BigInt(process.getuid()))
  ) {
    throw new Error(`${label} must be a single-link physical file`);
  }
  const descriptor = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await descriptor.stat({ bigint: true });
    if (!samePhysicalFile(pathBefore, before)) {
      throw new Error(`${label} changed while opening`);
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    for (;;) {
      const result = await descriptor.read(buffer, 0, buffer.byteLength, offset);
      if (result.bytesRead === 0) break;
      digest.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const after = await descriptor.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (
      BigInt(offset) !== before.size ||
      !samePhysicalFile(before, after) ||
      !samePhysicalFile(after, pathAfter) ||
      !Number.isSafeInteger(offset) ||
      offset <= 0
    ) {
      throw new Error(`${label} changed while reading`);
    }
    return { size: offset, sha256: `sha256:${digest.digest("hex")}` };
  } finally {
    await descriptor.close();
  }
}

async function checkedCommand(
  command: RunnerImageNativeCommand,
  executable: string,
  args: readonly string[],
  cwd: string,
  environment = candidateChildEnvironment(),
): Promise<RunnerImageNativeCommandResult> {
  const result = await command(executable, args, cwd, environment);
  if (result.exitCode !== 0) {
    throw new Error(
      `${[executable, ...args.slice(0, 3)].join(" ")} failed with exit ${result.exitCode}`,
    );
  }
  return result;
}

function candidateChildEnvironment(
  additions: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/root",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "true",
  };
  for (const key of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
    "BUILDX_BUILDER",
    "XDG_RUNTIME_DIR",
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...additions };
}

async function nativeCandidateCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment = candidateChildEnvironment(),
): Promise<RunnerImageNativeCommandResult> {
  const timeoutMilliseconds =
    executable === "docker" &&
    (args[0] === "run" || args[0] === "exec" || args[0] === "rm")
      ? 30_000
      : executable === "bash"
        ? 20 * 60_000
        : 30 * 60_000;
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let stopError: Error | null = null;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (signal: NodeJS.Signals) => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process group may already have exited.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // The direct child may also have exited.
      }
    };
    const stop = (error: Error) => {
      if (settled || stopError) return;
      stopError = error;
      terminate("SIGTERM");
      terminationTimer = setTimeout(() => terminate("SIGKILL"), 5_000);
    };
    const timeout = setTimeout(() => {
      stop(new Error("runner_image_native_candidate_command_timeout"));
    }, timeoutMilliseconds);
    const capture = (stream: "stdout" | "stderr", value: string) => {
      if (stopError) return;
      outputBytes += Buffer.byteLength(value, "utf8");
      if (outputBytes > 16 * 1024 * 1024) {
        stop(new Error("runner_image_native_candidate_output_limit_exceeded"));
        return;
      }
      if (stream === "stdout") stdout += value;
      else stderr += value;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => capture("stdout", value));
    child.stderr.on("data", (value: string) => capture("stderr", value));
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (settled) return;
      settled = true;
      reject(stopError ?? error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (settled) return;
      settled = true;
      if (stopError) {
        reject(stopError);
        return;
      }
      resolveResult({ exitCode: code ?? 1, stdout, stderr });
    });
  });
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

async function syncDirectory(path: string): Promise<void> {
  const descriptor = await open(path, fsConstants.O_RDONLY);
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

function isInside(path: string, root: string): boolean {
  const nested = relative(root, path);
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

function isFileSystemError(
  value: unknown,
  code: string,
): value is NodeJS.ErrnoException {
  return (
    value instanceof Error &&
    "code" in value &&
    (value as NodeJS.ErrnoException).code === code
  );
}

if (import.meta.main) {
  try {
    const record = await runRunnerImageNativeCandidate(
      parseRunnerImageNativeCandidateArgs(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
