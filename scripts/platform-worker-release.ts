import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  type BigIntStats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { lineageVerdict } from "./lib/deploy-lineage.ts";

const ROOT = resolve(import.meta.dir, "..");
const WRANGLER = resolve(ROOT, "node_modules/.bin/wrangler");
const MAX_OUTPUT = 64 * 1024 * 1024;
// Dashboard bundling can legitimately exceed three minutes on the production
// operator host while the portable suite and Wrangler share the same filesystem.
// Keep the release bounded, but do not turn a slow, otherwise successful build
// into an opaque pre-mutation refusal.
const COMMAND_TIMEOUT_MS = 600_000;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const VERSION = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/u;
const RUNNER_IMAGE =
  /^registry\.cloudflare\.com\/[0-9a-f]{32}\/takosumi-runner@sha256:[0-9a-f]{64}$/u;
const REQUIRED_BINDINGS = [
  "ASSETS",
  "TAKOSUMI_ACCOUNTS_DB",
  "TAKOSUMI_CONTROL_DB",
  "HOSTED",
  "TAKOSUMI_VERSION_METADATA",
  "TAKOSUMI_RUNTIME_BINDING_DERIVATION_KEY",
] as const;

export type DashboardAssetSeal = Readonly<{
  digest: string;
  entries: readonly Readonly<{
    path: string;
    size: number;
    sha256: string;
  }>[];
}>;

export type DashboardAssetSealRuntime = Readonly<{
  afterFileOpen?: (path: string) => void;
}>;

export type PlatformMutationFence = Readonly<{
  outcome: "unknown" | "accepted";
  versionId: string | null;
}>;

export type PlatformContainerState = Readonly<{
  id: string;
  name: string;
  state: string;
  image: string;
  version: string | number;
  hasActiveRollout: boolean;
  health: Readonly<{
    failed: number;
    starting: number;
    scheduling: number;
    errorCount: number;
  }>;
}>;

export function dashboardAssetTreeSeal(
  root: string,
  runtime: DashboardAssetSealRuntime = {},
): DashboardAssetSeal {
  const absoluteRoot = resolve(root);
  let rootInfo: ReturnType<typeof lstatSync>;
  try {
    rootInfo = lstatSync(absoluteRoot);
  } catch {
    throw new Error("platform_worker_release_asset_tree_invalid");
  }
  if (
    rootInfo.isSymbolicLink() ||
    !rootInfo.isDirectory() ||
    realpathSync(absoluteRoot) !== absoluteRoot
  ) {
    throw new Error("platform_worker_release_asset_tree_invalid");
  }
  const entries: Array<{
    path: string;
    size: number;
    sha256: string;
  }> = [];
  const visitDirectory = (directory: string): void => {
    const before = lstatSync(directory, { bigint: true });
    if (
      before.isSymbolicLink() ||
      !before.isDirectory() ||
      realpathSync(directory) !== directory
    ) {
      throw new Error("platform_worker_release_asset_tree_invalid");
    }
    const names = readdirSync(directory).sort(codePointCompare);
    for (const name of names) {
      const path = resolve(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        throw new Error("platform_worker_release_asset_tree_invalid");
      }
      if (info.isDirectory()) {
        visitDirectory(path);
        continue;
      }
      if (!info.isFile() || realpathSync(path) !== path) {
        throw new Error("platform_worker_release_asset_tree_invalid");
      }
      const bytes = readStablePhysicalAsset(path, runtime);
      entries.push({
        path: relative(absoluteRoot, path).replaceAll("\\", "/"),
        size: bytes.byteLength,
        sha256: digest(bytes),
      });
    }
    const after = lstatSync(directory, { bigint: true });
    if (!samePhysicalIdentity(before, after)) {
      throw new Error("platform_worker_release_asset_tree_invalid");
    }
  };
  visitDirectory(absoluteRoot);
  entries.sort((left, right) => codePointCompare(left.path, right.path));
  if (entries.length === 0) {
    throw new Error("platform_worker_release_asset_tree_invalid");
  }
  return {
    digest: digest(
      new TextEncoder().encode(
        JSON.stringify({
          kind: "takosumi.dashboard-asset-tree@v1",
          entries,
        }),
      ),
    ),
    entries,
  };
}

function readStablePhysicalAsset(
  path: string,
  runtime: DashboardAssetSealRuntime,
): Uint8Array {
  const pathBefore = lstatSync(path, { bigint: true });
  if (
    pathBefore.isSymbolicLink() ||
    !pathBefore.isFile() ||
    pathBefore.nlink !== 1n
  ) {
    throw new Error("platform_worker_release_asset_tree_invalid");
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const openedBefore = fstatSync(descriptor, { bigint: true });
    if (
      !openedBefore.isFile() ||
      !samePhysicalIdentity(pathBefore, openedBefore)
    ) {
      throw new Error("platform_worker_release_asset_tree_invalid");
    }
    runtime.afterFileOpen?.(path);
    const bytes = readFileSync(descriptor);
    const openedAfter = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      BigInt(bytes.byteLength) !== openedBefore.size ||
      !samePhysicalIdentity(openedBefore, openedAfter) ||
      !samePhysicalIdentity(openedAfter, pathAfter) ||
      realpathSync(path) !== path
    ) {
      throw new Error("platform_worker_release_asset_tree_invalid");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function samePhysicalIdentity(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseDeployedVersion(output: string): string {
  const matches = [
    ...output.matchAll(
      /(?:^|\n)Current Version ID:\s*([0-9a-f]{8}-[0-9a-f-]{27,})(?:\r?$)/gmu,
    ),
  ];
  if (
    matches.length !== 1 ||
    typeof matches[0]?.[1] !== "string" ||
    !VERSION.test(matches[0][1])
  ) {
    throw new Error("platform_worker_release_emitted_version_invalid");
  }
  return matches[0][1];
}

export function platformMutationAction(
  fence: PlatformMutationFence | null,
): "deploy" | "reconcile" {
  return fence === null ? "deploy" : "reconcile";
}

export function platformWorkerDeployArguments(
  configPath: string,
  releaseTag: string,
  releaseMessage: string,
  sealedEntrypointPath?: string,
): readonly string[] {
  const forwardIdentity =
    /^tks-(?:stg|prod)-[0-9a-f]{48}$/u.test(releaseTag) &&
    /^takosumi-platform-release sha256:[0-9a-f]{64}$/u.test(releaseMessage);
  const restoreIdentity =
    /^tks-rst-[0-9a-f]{48}$/u.test(releaseTag) &&
    /^takosumi-platform-restore sha256:[0-9a-f]{64}$/u.test(releaseMessage);
  if (
    !isAbsolute(configPath) ||
    (!forwardIdentity && !restoreIdentity) ||
    (sealedEntrypointPath !== undefined && !isAbsolute(sealedEntrypointPath))
  ) {
    throw new Error("platform_worker_release_deploy_identity_invalid");
  }
  return [
    WRANGLER,
    "deploy",
    ...(sealedEntrypointPath
      ? [sealedEntrypointPath, "--no-bundle"]
      : []),
    "--config",
    configPath,
    "--tag",
    releaseTag,
    "--message",
    releaseMessage,
    "--containers-rollout",
    "immediate",
    "--strict",
  ];
}

export function platformSealedConfigProjection(
  source: string,
  originalConfigPath: string,
  sealedConfigPath: string,
  sealedEntrypointPath: string,
  sealedAssetsPath: string,
): string {
  for (const path of [
    originalConfigPath,
    sealedConfigPath,
    sealedEntrypointPath,
    sealedAssetsPath,
  ]) {
    if (!isAbsolute(path)) {
      throw new Error("platform_worker_release_sealed_config_invalid");
    }
  }
  const replaceUnique = (
    input: string,
    name: "main" | "directory",
    value: string,
  ): string => {
    const expression = new RegExp(
      `^(${name}\\s*=\\s*)"[^"]+"(\\s*)$`,
      "gmu",
    );
    const matches = [...input.matchAll(expression)];
    if (matches.length !== 1) {
      throw new Error("platform_worker_release_sealed_config_invalid");
    }
    return input.replace(
      expression,
      `$1${JSON.stringify(value.replaceAll("\\", "/"))}$2`,
    );
  };
  const entry = relative(dirname(sealedConfigPath), sealedEntrypointPath);
  const assets = relative(dirname(sealedConfigPath), sealedAssetsPath);
  if (
    entry === "" ||
    assets === "" ||
    entry.startsWith("..") ||
    assets.startsWith("..") ||
    isAbsolute(entry) ||
    isAbsolute(assets)
  ) {
    throw new Error("platform_worker_release_sealed_config_invalid");
  }
  const withMain = replaceUnique(source, "main", entry);
  const projected = replaceUnique(withMain, "directory", assets);
  const originalMain = /^main\s*=\s*"([^"]+)"\s*$/mu.exec(source)?.[1];
  const originalAssets = /^directory\s*=\s*"([^"]+)"\s*$/mu.exec(source)?.[1];
  if (
    !originalMain ||
    !originalAssets ||
    !isAbsolute(resolve(dirname(originalConfigPath), originalMain)) ||
    !isAbsolute(resolve(dirname(originalConfigPath), originalAssets))
  ) {
    throw new Error("platform_worker_release_sealed_config_invalid");
  }
  return projected;
}

/** Project exactly one OpenTofuRunnerObject image literal for reviewed restore. */
export function platformRestoreConfigProjection(
  source: string,
  predecessorImage: string,
): string {
  if (!RUNNER_IMAGE.test(predecessorImage)) {
    throw new Error("platform_worker_release_restore_image_invalid");
  }
  const image = platformRunnerImageRange(source);
  return `${source.slice(0, image.valueStart)}${predecessorImage}${source.slice(image.valueEnd)}`;
}

function platformRunnerImageRange(source: string): Readonly<{
  valueStart: number;
  valueEnd: number;
  image: string;
}> {
  const headings = [...source.matchAll(/^\[\[?[^\]\r\n]+\]?\]\s*$/gmu)];
  const runners: Array<{ start: number; end: number; body: string }> = [];
  for (const [index, heading] of headings.entries()) {
    if (heading[0] !== "[[containers]]") continue;
    const start = heading.index!;
    const end = headings[index + 1]?.index ?? source.length;
    const body = source.slice(start, end);
    if (/^class_name\s*=\s*"OpenTofuRunnerObject"\s*$/mu.test(body)) {
      runners.push({ start, end, body });
    }
  }
  if (runners.length !== 1) {
    throw new Error("platform_worker_release_restore_image_invalid");
  }
  const imageMatches = [
    ...runners[0]!.body.matchAll(/^image\s*=\s*"([^"]+)"\s*$/gmu),
  ];
  if (
    imageMatches.length !== 1 ||
    !RUNNER_IMAGE.test(imageMatches[0]![1]!)
  ) {
    throw new Error("platform_worker_release_restore_image_invalid");
  }
  const image = imageMatches[0]!;
  const valueStart = runners[0]!.start + image.index! + image[0].indexOf('"') + 1;
  const valueEnd = valueStart + image[1]!.length;
  return { valueStart, valueEnd, image: image[1]! };
}

type PlatformMutationCheckpointRecord = Readonly<{
  kind: "takosumi.platform-worker-mutation-checkpoint@v1";
  planConfirmation: string;
  recordedAt: string;
  outcome: "unknown" | "accepted";
  versionId: string | null;
}>;

type PlatformRestoreCheckpointRecord = Readonly<{
  kind: "takosumi.platform-worker-restore-checkpoint@v1";
  planConfirmation: string;
  recordedAt: string;
  stage: "container" | "worker";
  outcome: "unknown" | "accepted";
  versionId: string | null;
}>;

export type PlatformRestoreFence = Readonly<{
  container?: PlatformMutationFence;
  worker?: PlatformMutationFence;
}>;

export function platformMutationCheckpointPath(
  planPath: string,
  confirmation: string,
): string {
  if (!isAbsolute(planPath) || !SHA256.test(confirmation)) {
    throw new Error("platform_worker_release_checkpoint_invalid");
  }
  const canonicalPlan = realpathSync(planPath);
  assertPrivateFile(canonicalPlan);
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        readStablePhysicalBytes(
          canonicalPlan,
          "platform_worker_release_checkpoint_invalid",
        ),
      ),
    ) as unknown;
  } catch {
    throw new Error("platform_worker_release_checkpoint_invalid");
  }
  if (
    !record(value) ||
    typeof value.checkpointPath !== "string" ||
    !isAbsolute(value.checkpointPath)
  ) {
    throw new Error("platform_worker_release_checkpoint_invalid");
  }
  const checkpoint = resolve(value.checkpointPath);
  if (insideRoot(checkpoint)) {
    throw new Error("platform_worker_release_checkpoint_invalid");
  }
  assertOutsideGitWorktree(checkpoint);
  return checkpoint;
}

export function platformRestoreCheckpointPath(
  planPath: string,
  confirmation: string,
): string {
  return `${platformMutationCheckpointPath(planPath, confirmation)}.restore`;
}

type PlatformRestoreLockIdentity = Readonly<{
  scope: string;
  directory: string;
  lockPath: string;
}>;

type PlatformRestoreLockFileIdentity = Readonly<{
  dev: string;
  ino: string;
  birthtimeNs: string;
}>;

type PlatformRestoreHostIdentity = Readonly<{
  machineIdSha256: string;
  pidNamespaceDev: string;
  pidNamespaceIno: string;
}>;

function platformRestoreLockIdentity(
  planPath: string,
  confirmation: string,
): PlatformRestoreLockIdentity {
  const checkpointPath = platformMutationCheckpointPath(planPath, confirmation);
  const scope = digest(
    new TextEncoder().encode(
      JSON.stringify({
        kind: "takosumi.platform-worker-restore-lock-scope@v1",
        checkpointPath,
        planConfirmation: confirmation,
      }),
    ),
  );
  return {
    scope,
    directory: dirname(checkpointPath),
    lockPath: `${checkpointPath}.restore-${scope.slice("sha256:".length)}.lock`,
  };
}

export function platformRestoreLockPath(
  planPath: string,
  confirmation: string,
): string {
  return platformRestoreLockIdentity(planPath, confirmation).lockPath;
}

/** Hold the plan-scoped restore authority across checkpoint and provider work. */
export async function withPlatformRestoreLock<T>(
  planPath: string,
  confirmation: string,
  operation: () => Promise<T>,
): Promise<T> {
  const identity = platformRestoreLockIdentity(planPath, confirmation);
  ensurePrivateCheckpointDirectory(identity.directory);
  const descriptor = acquirePlatformRestoreLock(identity, confirmation);
  const seal = fstatSync(descriptor, { bigint: true });
  try {
    return await operation();
  } finally {
    const opened = fstatSync(descriptor, { bigint: true });
    let linked: BigIntStats | null = null;
    try {
      linked = lstatSync(identity.lockPath, { bigint: true });
    } catch (error) {
      if (!fileSystemError(error, "ENOENT")) throw error;
    }
    closeSync(descriptor);
    if (
      linked === null ||
      !sameRestoreLockStatus(seal, opened) ||
      !sameRestoreLockStatus(opened, linked) ||
      opened.nlink !== 1n
    ) {
      throw new Error("platform_worker_restore_lock_invalid");
    }
    unlinkSync(identity.lockPath);
    syncDirectory(identity.directory);
  }
}

function acquirePlatformRestoreLock(
  identity: PlatformRestoreLockIdentity,
  confirmation: string,
): number {
  for (;;) {
    const pendingName = `${basename(identity.lockPath)}.pending-${process.pid}-${randomBytes(16).toString("hex")}`;
    const pendingPath = join(identity.directory, pendingName);
    const descriptor = openSync(
      pendingPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    let descriptorOpen = true;
    let canonicalLinked = false;
    let fileIdentity: PlatformRestoreLockFileIdentity | null = null;
    try {
      const processIdentity = platformRestoreProcessIdentity(process.pid);
      const hostIdentity = platformRestoreHostIdentity();
      fchmodSync(descriptor, 0o600);
      const prepared = fstatSync(descriptor, { bigint: true });
      fileIdentity = platformRestoreLockFileIdentity(prepared);
      writeFileSync(
        descriptor,
        new TextEncoder().encode(
          `${JSON.stringify({
            kind: "takosumi.platform-worker-restore-lock@v1",
            scope: identity.scope,
            planConfirmation: confirmation,
            lockPath: identity.lockPath,
            pendingName,
            fileIdentity,
            hostIdentity,
            pid: process.pid,
            bootId: processIdentity.bootId,
            processStartTicks: processIdentity.processStartTicks,
            acquiredAt: new Date().toISOString(),
          })}\n`,
        ),
      );
      fsyncSync(descriptor);
      const complete = fstatSync(descriptor, { bigint: true });
      assertPlatformRestoreLockFileIdentity(
        complete,
        fileIdentity,
        [1n],
      );
      try {
        linkSync(pendingPath, identity.lockPath);
        canonicalLinked = true;
      } catch (error) {
        if (!fileSystemError(error, "EEXIST")) throw error;
        closeSync(descriptor);
        descriptorOpen = false;
        unlinkSync(pendingPath);
        syncDirectory(identity.directory);
        if (reclaimStalePlatformRestoreLock(identity, confirmation)) continue;
        throw new Error("platform_worker_restore_locked");
      }
      // Publish only a complete, fsynced owner record. The hard link is the
      // single atomic no-overwrite transition into canonical lock ownership.
      syncDirectory(identity.directory);
      const canonical = lstatSync(identity.lockPath, { bigint: true });
      const pending = lstatSync(pendingPath, { bigint: true });
      if (
        !sameRestoreLockStatus(canonical, pending) ||
        canonical.nlink !== 2n
      ) {
        throw new Error("platform_worker_restore_lock_invalid");
      }
      unlinkSync(pendingPath);
      syncDirectory(identity.directory);
      const opened = fstatSync(descriptor, { bigint: true });
      const linked = lstatSync(identity.lockPath, { bigint: true });
      if (
        !sameRestoreLockStatus(opened, linked) ||
        opened.nlink !== 1n
      ) {
        throw new Error("platform_worker_restore_lock_invalid");
      }
      return descriptor;
    } catch (error) {
      if (descriptorOpen) closeSync(descriptor);
      if (canonicalLinked && fileIdentity) {
        const canonical = optionalBigIntLstat(identity.lockPath);
        if (
          canonical &&
          platformRestoreLockStatusMatchesIdentity(canonical, fileIdentity)
        ) {
          try {
            unlinkSync(identity.lockPath);
          } catch (unlinkError) {
            if (!fileSystemError(unlinkError, "ENOENT")) throw unlinkError;
          }
        }
      }
      try {
        unlinkSync(pendingPath);
      } catch (unlinkError) {
        if (!fileSystemError(unlinkError, "ENOENT")) throw unlinkError;
      }
      syncDirectory(identity.directory);
      throw error;
    }
  }
}

function reclaimStalePlatformRestoreLock(
  identity: PlatformRestoreLockIdentity,
  confirmation: string,
): boolean {
  let lock: Readonly<{ bytes: Uint8Array; status: BigIntStats }>;
  try {
    lock = readStablePlatformRestoreLock(identity.lockPath);
  } catch (error) {
    if (fileSystemError(error, "ENOENT")) return true;
    throw new Error("platform_worker_restore_lock_invalid", { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(lock.bytes),
    ) as unknown;
  } catch (error) {
    throw new Error("platform_worker_restore_lock_invalid", { cause: error });
  }
  if (
    !record(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(
        [
          "acquiredAt",
          "bootId",
          "fileIdentity",
          "hostIdentity",
          "kind",
          "lockPath",
          "pendingName",
          "pid",
          "planConfirmation",
          "processStartTicks",
          "scope",
        ].sort(),
      ) ||
    value.kind !== "takosumi.platform-worker-restore-lock@v1" ||
    value.scope !== identity.scope ||
    value.planConfirmation !== confirmation ||
    value.lockPath !== identity.lockPath ||
    typeof value.pendingName !== "string" ||
    !platformRestorePendingLockName(identity, value.pendingName) ||
    !validPlatformRestoreLockFileIdentity(value.fileIdentity) ||
    !validPlatformRestoreHostIdentity(value.hostIdentity) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.bootId !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(value.bootId) ||
    typeof value.processStartTicks !== "string" ||
    !/^[0-9]+$/u.test(value.processStartTicks) ||
    typeof value.acquiredAt !== "string" ||
    !Number.isFinite(Date.parse(value.acquiredAt))
  ) {
    throw new Error("platform_worker_restore_lock_invalid");
  }
  assertPlatformRestoreLockFileIdentity(
    lock.status,
    value.fileIdentity,
    [1n, 2n],
  );
  const currentHost = platformRestoreHostIdentity();
  const currentProcess = platformRestoreProcessIdentity(process.pid);
  if (!samePlatformRestoreHostIdentity(value.hostIdentity, currentHost)) {
    throw new Error("platform_worker_restore_lock_foreign_host");
  }
  if (value.bootId !== currentProcess.bootId) {
    throw new Error("platform_worker_restore_lock_foreign_boot");
  }
  assertPlatformRestorePendingLink(identity, value.pendingName, lock.status);
  if (
    platformRestoreProcessStillOwnsLock(
      value.pid as number,
      value.processStartTicks,
    )
  ) {
    return false;
  }
  const linked = optionalBigIntLstat(identity.lockPath);
  if (linked === null) return true;
  if (!sameRestoreLockStatus(lock.status, linked)) {
    throw new Error("platform_worker_restore_lock_invalid");
  }
  unlinkSync(identity.lockPath);
  const pendingPath = join(identity.directory, value.pendingName);
  const pending = optionalBigIntLstat(pendingPath);
  if (pending) {
    if (!platformRestoreLockStatusMatchesIdentity(pending, value.fileIdentity)) {
      throw new Error("platform_worker_restore_lock_invalid");
    }
    assertPlatformRestoreLockFile(pending, [1n]);
    unlinkSync(pendingPath);
  }
  syncDirectory(identity.directory);
  return true;
}

function readStablePlatformRestoreLock(
  path: string,
): Readonly<{ bytes: Uint8Array; status: BigIntStats }> {
  const before = lstatSync(path, { bigint: true });
  assertPlatformRestoreLockFile(before, [1n, 2n]);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameRestoreLockStatus(before, opened)) {
      throw new Error("platform_worker_restore_lock_invalid");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const linked = lstatSync(path, { bigint: true });
    if (
      !sameRestoreLockStatus(opened, after) ||
      !sameRestoreLockStatus(after, linked)
    ) {
      throw new Error("platform_worker_restore_lock_invalid");
    }
    return { bytes, status: after };
  } finally {
    closeSync(descriptor);
  }
}

function platformRestoreLockFileIdentity(
  status: BigIntStats,
): PlatformRestoreLockFileIdentity {
  assertPlatformRestoreLockFile(status, [1n]);
  return {
    dev: status.dev.toString(),
    ino: status.ino.toString(),
    birthtimeNs: status.birthtimeNs.toString(),
  };
}

function validPlatformRestoreLockFileIdentity(
  value: unknown,
): value is PlatformRestoreLockFileIdentity {
  return (
    record(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(["birthtimeNs", "dev", "ino"]) &&
    typeof value.dev === "string" &&
    /^[0-9]+$/u.test(value.dev) &&
    typeof value.ino === "string" &&
    /^[0-9]+$/u.test(value.ino) &&
    typeof value.birthtimeNs === "string" &&
    /^[0-9]+$/u.test(value.birthtimeNs)
  );
}

function assertPlatformRestoreLockFileIdentity(
  status: BigIntStats,
  expected: PlatformRestoreLockFileIdentity,
  allowedLinkCounts: readonly bigint[],
): void {
  assertPlatformRestoreLockFile(status, allowedLinkCounts);
  if (!platformRestoreLockStatusMatchesIdentity(status, expected)) {
    throw new Error("platform_worker_restore_lock_invalid");
  }
}

function platformRestoreLockStatusMatchesIdentity(
  status: BigIntStats,
  expected: PlatformRestoreLockFileIdentity,
): boolean {
  return (
    status.dev.toString() === expected.dev &&
    status.ino.toString() === expected.ino &&
    status.birthtimeNs.toString() === expected.birthtimeNs
  );
}

function assertPlatformRestoreLockFile(
  status: BigIntStats,
  allowedLinkCounts: readonly bigint[],
): void {
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    !allowedLinkCounts.includes(status.nlink) ||
    (process.getuid && status.uid !== BigInt(process.getuid())) ||
    (status.mode & 0o777n) !== 0o600n
  ) {
    throw new Error("platform_worker_restore_lock_invalid");
  }
}

function sameRestoreLockStatus(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.birthtimeNs === right.birthtimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function platformRestoreHostIdentity(): PlatformRestoreHostIdentity {
  const machineId = readFileSync("/etc/machine-id", "utf8").trim();
  const pidNamespace = statSync("/proc/self/ns/pid", { bigint: true });
  if (!/^[0-9a-f]{32}$/u.test(machineId) || !pidNamespace.isFile()) {
    throw new Error("platform_worker_restore_lock_host_identity_invalid");
  }
  return {
    machineIdSha256: digest(new TextEncoder().encode(machineId)),
    pidNamespaceDev: pidNamespace.dev.toString(),
    pidNamespaceIno: pidNamespace.ino.toString(),
  };
}

function validPlatformRestoreHostIdentity(
  value: unknown,
): value is PlatformRestoreHostIdentity {
  return (
    record(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(
        ["machineIdSha256", "pidNamespaceDev", "pidNamespaceIno"].sort(),
      ) &&
    typeof value.machineIdSha256 === "string" &&
    SHA256.test(value.machineIdSha256) &&
    typeof value.pidNamespaceDev === "string" &&
    /^[0-9]+$/u.test(value.pidNamespaceDev) &&
    typeof value.pidNamespaceIno === "string" &&
    /^[0-9]+$/u.test(value.pidNamespaceIno)
  );
}

function samePlatformRestoreHostIdentity(
  left: PlatformRestoreHostIdentity,
  right: PlatformRestoreHostIdentity,
): boolean {
  return (
    left.machineIdSha256 === right.machineIdSha256 &&
    left.pidNamespaceDev === right.pidNamespaceDev &&
    left.pidNamespaceIno === right.pidNamespaceIno
  );
}

function platformRestoreProcessIdentity(
  pid: number,
): Readonly<{ bootId: string; processStartTicks: string }> {
  const bootId = readFileSync(
    "/proc/sys/kernel/random/boot_id",
    "utf8",
  ).trim();
  const statSource = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = statSource.lastIndexOf(")");
  const fields =
    close === -1 ? [] : statSource.slice(close + 1).trim().split(/\s+/u);
  const processStartTicks = fields[19];
  if (
    !/^[0-9a-f-]{36}$/u.test(bootId) ||
    typeof processStartTicks !== "string" ||
    !/^[0-9]+$/u.test(processStartTicks)
  ) {
    throw new Error("platform_worker_restore_lock_process_invalid");
  }
  return { bootId, processStartTicks };
}

function platformRestoreProcessStillOwnsLock(
  pid: number,
  processStartTicks: string,
): boolean {
  let observed: Readonly<{ bootId: string; processStartTicks: string }>;
  try {
    observed = platformRestoreProcessIdentity(pid);
  } catch (error) {
    if (fileSystemError(error, "ENOENT")) return false;
    throw new Error("platform_worker_restore_lock_liveness_unknown", {
      cause: error,
    });
  }
  return observed.processStartTicks === processStartTicks;
}

function platformRestorePendingLockName(
  identity: PlatformRestoreLockIdentity,
  value: string,
): boolean {
  const prefix = `${basename(identity.lockPath)}.pending-`;
  return (
    value.startsWith(prefix) &&
    /^[0-9]+-[0-9a-f]{32}$/u.test(value.slice(prefix.length))
  );
}

function assertPlatformRestorePendingLink(
  identity: PlatformRestoreLockIdentity,
  pendingName: string,
  lockStatus: BigIntStats,
): void {
  if (lockStatus.nlink === 1n) return;
  if (lockStatus.nlink !== 2n) {
    throw new Error("platform_worker_restore_lock_invalid");
  }
  const pending = optionalBigIntLstat(join(identity.directory, pendingName));
  if (!pending || !sameRestoreLockStatus(lockStatus, pending)) {
    throw new Error("platform_worker_restore_lock_invalid");
  }
}

function optionalBigIntLstat(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (fileSystemError(error, "ENOENT")) return null;
    throw error;
  }
}

export function readPlatformRestoreFence(
  planPath: string,
  confirmation: string,
): PlatformRestoreFence {
  const path = platformRestoreCheckpointPath(planPath, confirmation);
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const bytes = readStablePhysicalBytes(
    path,
    "platform_worker_restore_checkpoint_invalid",
  );
  assertPrivateFile(path);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!source.endsWith("\n")) {
    throw new Error("platform_worker_restore_checkpoint_invalid");
  }
  const records = source
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line): PlatformRestoreCheckpointRecord => {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new Error("platform_worker_restore_checkpoint_invalid");
      }
      if (
        !record(value) ||
        value.kind !== "takosumi.platform-worker-restore-checkpoint@v1" ||
        value.planConfirmation !== confirmation ||
        typeof value.recordedAt !== "string" ||
        !Number.isFinite(Date.parse(value.recordedAt)) ||
        (value.stage !== "container" && value.stage !== "worker") ||
        (value.outcome !== "unknown" && value.outcome !== "accepted") ||
        (value.outcome === "unknown"
          ? value.versionId !== null
          : typeof value.versionId !== "string" || !VERSION.test(value.versionId))
      ) {
        throw new Error("platform_worker_restore_checkpoint_invalid");
      }
      return value as unknown as PlatformRestoreCheckpointRecord;
    });
  const expected = [
    ["container", "unknown"],
    ["container", "accepted"],
    ["worker", "unknown"],
    ["worker", "accepted"],
  ] as const;
  if (
    records.length > expected.length ||
    records.some(
      (entry, index) =>
        entry.stage !== expected[index]![0] ||
        entry.outcome !== expected[index]![1],
    )
  ) {
    throw new Error("platform_worker_restore_checkpoint_invalid");
  }
  const acceptedContainer = records.find(
    (entry) => entry.stage === "container" && entry.outcome === "accepted",
  );
  const acceptedWorker = records.find(
    (entry) => entry.stage === "worker" && entry.outcome === "accepted",
  );
  return {
    ...(records.some((entry) => entry.stage === "container")
      ? {
          container: acceptedContainer
            ? { outcome: "accepted" as const, versionId: acceptedContainer.versionId }
            : { outcome: "unknown" as const, versionId: null },
        }
      : {}),
    ...(records.some((entry) => entry.stage === "worker")
      ? {
          worker: acceptedWorker
            ? { outcome: "accepted" as const, versionId: acceptedWorker.versionId }
            : { outcome: "unknown" as const, versionId: null },
        }
      : {}),
  };
}

export function platformRestoreFailureState(
  planPath: string,
  confirmation: string,
): Readonly<{
  mutationOutcome: "not-started" | "unknown" | "accepted";
  failureBoundary:
    | "pre-mutation"
    | "post-mutation-unknown"
    | "post-mutation-readback";
}> {
  try {
    const fence = readPlatformRestoreFence(planPath, confirmation);
    const latest = fence.worker ?? fence.container;
    const outcome = latest?.outcome ?? "not-started";
    return {
      mutationOutcome: outcome,
      failureBoundary:
        outcome === "not-started"
          ? "pre-mutation"
          : outcome === "unknown"
            ? "post-mutation-unknown"
            : "post-mutation-readback",
    };
  } catch {
    // A malformed or torn staged checkpoint may be the durable pre-command
    // fence itself. It can never prove that restore did not touch the target.
    return {
      mutationOutcome: "unknown",
      failureBoundary: "post-mutation-unknown",
    };
  }
}

export function appendPlatformRestoreFence(
  planPath: string,
  confirmation: string,
  stage: "container" | "worker",
  fence: PlatformMutationFence,
): void {
  const current = readPlatformRestoreFence(planPath, confirmation);
  const validTransition =
    stage === "container"
      ? fence.outcome === "unknown"
        ? current.container === undefined && current.worker === undefined
        : current.container?.outcome === "unknown" && current.worker === undefined
      : fence.outcome === "unknown"
        ? current.container?.outcome === "accepted" && current.worker === undefined
        : current.container?.outcome === "accepted" &&
          current.worker?.outcome === "unknown";
  if (!validTransition) {
    throw new Error("platform_worker_restore_checkpoint_invalid");
  }
  const path = platformRestoreCheckpointPath(planPath, confirmation);
  ensurePrivateCheckpointDirectory(dirname(path));
  const recordValue: PlatformRestoreCheckpointRecord = {
    kind: "takosumi.platform-worker-restore-checkpoint@v1",
    planConfirmation: confirmation,
    recordedAt: new Date().toISOString(),
    stage,
    outcome: fence.outcome,
    versionId: fence.versionId,
  };
  const flags =
    stage === "container" && fence.outcome === "unknown"
      ? constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW
      : constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW;
  const descriptor = openSync(path, flags, 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new Error("platform_worker_restore_checkpoint_invalid");
    }
    writeFileSync(
      descriptor,
      new TextEncoder().encode(`${JSON.stringify(recordValue)}\n`),
    );
    fsyncSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const linked = lstatSync(path, { bigint: true });
    if (!sameInodeIdentity(before, after) || !samePhysicalIdentity(after, linked)) {
      throw new Error("platform_worker_restore_checkpoint_invalid");
    }
  } finally {
    closeSync(descriptor);
  }
  if (stage === "container" && fence.outcome === "unknown") {
    syncDirectory(dirname(path));
  }
}

export function readPlatformMutationFence(
  planPath: string,
  confirmation: string,
): PlatformMutationFence | null {
  const path = platformMutationCheckpointPath(planPath, confirmation);
  let status: ReturnType<typeof lstatSync>;
  try {
    status = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    status.uid !== process.getuid?.() ||
    (status.mode & 0o777) !== 0o600 ||
    realpathSync(path) !== path
  ) {
    throw new Error("platform_worker_release_checkpoint_invalid");
  }
  const lines = new TextDecoder("utf-8", { fatal: true })
    .decode(
      readStablePhysicalBytes(
        path,
        "platform_worker_release_checkpoint_invalid",
      ),
    );
  if (!lines.endsWith("\n")) {
    throw new Error("platform_worker_release_checkpoint_invalid");
  }
  const recordsSource = lines
    .split(/\r?\n/u)
    .filter(Boolean);
  if (recordsSource.length === 0) {
    throw new Error("platform_worker_release_checkpoint_invalid");
  }
  const records = recordsSource.map((line) => {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error("platform_worker_release_checkpoint_invalid");
    }
    if (
      !record(value) ||
      JSON.stringify(Object.keys(value).sort()) !==
        JSON.stringify(
          [
            "kind",
            "planConfirmation",
            "recordedAt",
            "outcome",
            "versionId",
          ].sort(),
        ) ||
      value.kind !== "takosumi.platform-worker-mutation-checkpoint@v1" ||
      value.planConfirmation !== confirmation ||
      typeof value.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(value.recordedAt)) ||
      (value.outcome !== "unknown" && value.outcome !== "accepted") ||
      (value.outcome === "unknown"
        ? value.versionId !== null
        : typeof value.versionId !== "string" || !VERSION.test(value.versionId))
    ) {
      throw new Error("platform_worker_release_checkpoint_invalid");
    }
    return value as PlatformMutationCheckpointRecord;
  });
  if (records[0]?.outcome !== "unknown") {
    throw new Error("platform_worker_release_checkpoint_invalid");
  }
  const accepted = records.slice(1);
  if (
    accepted.some((entry) => entry.outcome !== "accepted") ||
    new Set(accepted.map((entry) => entry.versionId)).size > 1
  ) {
    throw new Error("platform_worker_release_checkpoint_invalid");
  }
  return accepted.length === 0
    ? { outcome: "unknown", versionId: null }
    : { outcome: "accepted", versionId: accepted[0]!.versionId };
}

export function platformMutationFailureState(
  planPath: string,
  confirmation: string,
): Readonly<{
  mutationOutcome: "not-started" | "unknown" | "accepted";
  failureBoundary:
    | "pre-mutation"
    | "post-mutation-unknown"
    | "post-mutation-readback";
}> {
  try {
    const outcome = readPlatformMutationFence(planPath, confirmation)?.outcome ??
      "not-started";
    return {
      mutationOutcome: outcome,
      failureBoundary:
        outcome === "not-started"
          ? "pre-mutation"
          : outcome === "unknown"
            ? "post-mutation-unknown"
            : "post-mutation-readback",
    };
  } catch {
    // A malformed/torn checkpoint may itself be the remains of the durable
    // pre-command write. Treat it as post-touch ambiguity, never as proof that
    // mutation did not start.
    return {
      mutationOutcome: "unknown",
      failureBoundary: "post-mutation-unknown",
    };
  }
}

export function appendPlatformMutationFence(
  planPath: string,
  confirmation: string,
  fence: PlatformMutationFence,
  recordedAt = new Date().toISOString(),
): void {
  if (
    !Number.isFinite(Date.parse(recordedAt)) ||
    (fence.outcome === "unknown"
      ? fence.versionId !== null
      : typeof fence.versionId !== "string" || !VERSION.test(fence.versionId))
  ) {
    throw new Error("platform_worker_release_checkpoint_invalid");
  }
  const path = platformMutationCheckpointPath(planPath, confirmation);
  ensurePrivateCheckpointDirectory(dirname(path));
  const recordValue: PlatformMutationCheckpointRecord = {
    kind: "takosumi.platform-worker-mutation-checkpoint@v1",
    planConfirmation: confirmation,
    recordedAt,
    outcome: fence.outcome,
    versionId: fence.versionId,
  };
  const bytes = new TextEncoder().encode(`${JSON.stringify(recordValue)}\n`);
  if (fence.outcome === "unknown") {
    const descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    assertPrivateFile(path);
    syncDirectory(dirname(path));
    return;
  }
  const current = readPlatformMutationFence(planPath, confirmation);
  if (current?.outcome === "accepted") {
    if (current.versionId !== fence.versionId) {
      throw new Error("platform_worker_release_checkpoint_invalid");
    }
    return;
  }
  if (current?.outcome !== "unknown") {
    throw new Error("platform_worker_release_checkpoint_invalid");
  }
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new Error("platform_worker_release_checkpoint_invalid");
    }
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      !sameInodeIdentity(before, after) ||
      !samePhysicalIdentity(after, pathAfter)
    ) {
      throw new Error("platform_worker_release_checkpoint_invalid");
    }
  } finally {
    closeSync(descriptor);
  }
}

function sameInodeIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid
  );
}

function ensurePrivateCheckpointDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
    syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const status = lstatSync(path);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.uid !== process.getuid?.() ||
    (status.mode & 0o777) !== 0o700 ||
    realpathSync(path) !== path
  ) {
    throw new Error("platform_worker_release_checkpoint_invalid");
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export type PlatformEnvironment = "staging" | "production";

const TARGETS = {
  staging: {
    origin: "https://app-staging.takosumi.com",
    workerName: "takosumi-staging",
    hostedService: "takosumi-hosted-staging",
  },
  production: {
    origin: "https://app.takosumi.com",
    workerName: "takosumi",
    hostedService: "takosumi-hosted",
  },
} as const satisfies Record<
  PlatformEnvironment,
  {
    readonly origin: string;
    readonly workerName: string;
    readonly hostedService: string;
  }
>;

const DASHBOARD_STORE_ORIGINS = {
  staging: "https://store-staging.takosumi.com",
  production: "https://store.takosumi.com",
} as const satisfies Record<PlatformEnvironment, string>;

export function platformTargetForEnvironment(environment: PlatformEnvironment) {
  return TARGETS[environment];
}

/**
 * Official hosted builds pin one environment-matched discovery Store. The OSS
 * dashboard build remains neutral when it is invoked outside this owner
 * release path, and users may still add other TCS servers at runtime.
 */
export function platformDashboardBuildEnvironment(
  environment: PlatformEnvironment,
): Record<string, string> {
  return {
    ...childEnvironment(),
    VITE_TAKOSUMI_TCS_STORE_URL: DASHBOARD_STORE_ORIGINS[environment],
  };
}

interface PlatformReleasePlan {
  readonly kind: "takosumi.platform-worker-release-plan@v5";
  readonly createdAt: string;
  readonly environment: PlatformEnvironment;
  readonly sourceCommit: string;
  readonly releaseNonce: string;
  readonly configPath: string;
  readonly configSha256: string;
  readonly closurePath: string;
  readonly closure: DashboardAssetSeal;
  readonly sealedConfigPath: string;
  readonly sealedConfigSha256: string;
  readonly uploadEntrypointPath: string;
  readonly checkpointPath: string;
  readonly restoreClosurePath: string;
  readonly restoreClosure: DashboardAssetSeal;
  readonly restoreSealedConfigPath: string;
  readonly restoreSealedConfigSha256: string;
  readonly restoreUploadEntrypointPath: string;
  readonly restoreDryRun: DashboardAssetSeal;
  readonly dashboardAssets: DashboardAssetSeal;
  readonly dryRun: DashboardAssetSeal;
  readonly secretNamesSha256: string;
  readonly predecessorVersionId: string;
  readonly predecessorContainer: PlatformContainerState;
  readonly releaseTag: string;
  readonly confirmation: string;
}

type Options =
  | {
      readonly action: "plan";
      readonly config: string;
      readonly planOut: string;
    }
  | {
      readonly action: "execute";
      readonly plan: string;
      readonly confirmation: string;
      readonly reviewer: string;
      readonly evidence: string;
    }
  | {
      readonly action: "recover";
      readonly plan: string;
      readonly confirmation: string;
      readonly reviewer: string;
      readonly evidence: string;
    }
  | {
      readonly action: "restore";
      readonly plan: string;
      readonly confirmation: string;
      readonly reviewer: string;
      readonly evidence: string;
    };

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type PlatformReleaseCommand = (
  argv: readonly string[],
  stdin?: Uint8Array,
  cwd?: string,
  environment?: Record<string, string>,
) => Promise<CommandResult>;

export async function runPlatformWorkerRelease(
  argv: readonly string[],
  environment: PlatformEnvironment = "staging",
): Promise<void> {
  const options = parsePlatformWorkerReleaseArgs(argv);
  if (options.action === "plan") await plan(options, environment);
  else if (options.action === "execute") await execute(options, environment);
  else if (options.action === "recover") await recover(options, environment);
  else await restore(options, environment);
}

export function parsePlatformWorkerReleaseArgs(
  argv: readonly string[],
): Options {
  const [action, ...rest] = argv;
  if (
    action !== "plan" &&
    action !== "execute" &&
    action !== "recover" &&
    action !== "restore"
  ) {
    throw new Error("platform_worker_release_action_invalid");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (
      !key?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error("platform_worker_release_arguments_invalid");
    }
    if (values.has(key))
      throw new Error("platform_worker_release_argument_duplicate");
    values.set(key, value);
  }
  const allowed =
    action === "plan"
      ? ["--config", "--plan-out"]
      : ["--plan", "--confirm", "--review", "--evidence"];
  if (
    values.size !== allowed.length ||
    allowed.some((key) => !values.has(key)) ||
    [...values.keys()].some((key) => !allowed.includes(key))
  ) {
    throw new Error("platform_worker_release_arguments_invalid");
  }
  if (action === "plan") {
    return {
      action,
      config: absolute(values.get("--config")!),
      planOut: absolute(values.get("--plan-out")!),
    };
  }
  const common = {
    plan: absolute(values.get("--plan")!),
    confirmation: values.get("--confirm")!,
    reviewer: values.get("--review")!,
    evidence: absolute(values.get("--evidence")!),
  };
  return action === "execute"
    ? { ...common, action: "execute" }
    : action === "recover"
      ? { ...common, action: "recover" }
      : { ...common, action: "restore" };
}

export function platformWorkerRestoreVersionArguments(
  configPath: string,
  predecessorVersionId: string,
  message: string,
): readonly string[] {
  if (
    !isAbsolute(configPath) ||
    !VERSION.test(predecessorVersionId) ||
    message.length === 0 ||
    message.length > 256
  ) {
    throw new Error("platform_worker_release_restore_arguments_invalid");
  }
  return [
    WRANGLER,
    "versions",
    "deploy",
    `${predecessorVersionId}@100%`,
    "--config",
    configPath,
    "--message",
    message,
    "--yes",
  ];
}

async function plan(
  options: Extract<Options, { action: "plan" }>,
  environment: PlatformEnvironment,
): Promise<void> {
  await assertCleanAndPushed();
  assertReadableConfig(options.config);
  assertExternalAbsent(options.planOut);
  const closurePath = `${options.planOut}.closure`;
  const restoreClosurePath = `${options.planOut}.restore-closure`;
  const checkpointPath = `${options.planOut}.checkpoint.jsonl`;
  assertExternalAbsent(closurePath);
  assertExternalAbsent(restoreClosurePath);
  assertExternalAbsent(checkpointPath);
  assertExternalAbsent(`${checkpointPath}.restore`);
  const config = readStablePhysicalBytes(
    options.config,
    "platform_worker_release_config_invalid",
  );
  const configSource = new TextDecoder("utf-8", { fatal: true }).decode(config);
  assertConfigTargetsSource(
    configSource,
    options.config,
    environment,
  );
  const dashboardAssets = await buildDeterministicDashboard(environment);
  const sourceCommit = git(["rev-parse", "HEAD"]).trim();
  const predecessorVersionId = await readServingVersion(options.config);
  const predecessorContainer = await readPlatformContainer(
    options.config,
    environment,
  );
  assertPlatformContainerComplete(predecessorContainer);
  const restoreConfigSource = platformRestoreConfigProjection(
    configSource,
    predecessorContainer.image,
  );
  let sealed: Awaited<ReturnType<typeof createPlatformDeployClosure>>;
  let restoreSealed: Awaited<ReturnType<typeof createPlatformDeployClosure>>;
  let restoreDryRunConfig:
    | ReturnType<typeof createPlatformDryRunConfig>
    | undefined;
  try {
    const transientRestoreConfig = createPlatformDryRunConfig(
      restoreConfigSource,
      options.config,
    );
    restoreDryRunConfig = transientRestoreConfig;
    sealed = await createPlatformDeployClosure(
      closurePath,
      configSource,
      options.config,
      dashboardAssets,
      sourceCommit,
    );
    restoreSealed = await createPlatformDeployClosure(
      restoreClosurePath,
      restoreConfigSource,
      options.config,
      dashboardAssets,
      sourceCommit,
      transientRestoreConfig.path,
    );
  } catch (error) {
    rmSync(closurePath, { recursive: true, force: true });
    rmSync(restoreClosurePath, { recursive: true, force: true });
    throw error;
  } finally {
    restoreDryRunConfig?.dispose();
  }
  const secrets = await readSecretNames(sealed.configPath);
  await assertCleanAndPushed();

  const identity = {
    kind: "takosumi.platform-worker-release-plan@v5" as const,
    createdAt: new Date().toISOString(),
    environment,
    sourceCommit,
    releaseNonce: randomBytes(16).toString("hex"),
    configPath: options.config,
    configSha256: digest(config),
    closurePath,
    closure: sealed.closure,
    sealedConfigPath: sealed.configPath,
    sealedConfigSha256: sealed.configSha256,
    uploadEntrypointPath: sealed.uploadEntrypointPath,
    checkpointPath,
    restoreClosurePath,
    restoreClosure: restoreSealed.closure,
    restoreSealedConfigPath: restoreSealed.configPath,
    restoreSealedConfigSha256: restoreSealed.configSha256,
    restoreUploadEntrypointPath: restoreSealed.uploadEntrypointPath,
    restoreDryRun: restoreSealed.dryRun,
    dashboardAssets,
    dryRun: sealed.dryRun,
    secretNamesSha256: digest(
      new TextEncoder().encode(JSON.stringify(secrets)),
    ),
    predecessorVersionId,
    predecessorContainer,
  };
  const subject = {
    ...identity,
    releaseTag: platformReleaseTag(identity),
  };
  const releasePlan: PlatformReleasePlan = {
    ...subject,
    confirmation: digest(new TextEncoder().encode(JSON.stringify(subject))),
  };
  writePrivate(
    options.planOut,
    new TextEncoder().encode(`${JSON.stringify(releasePlan, null, 2)}\n`),
  );
  process.stdout.write(
    `${JSON.stringify({ kind: releasePlan.kind, status: "planned", confirmation: releasePlan.confirmation, predecessorVersionId })}\n`,
  );
}

async function execute(
  options: Extract<Options, { action: "execute" }>,
  environment: PlatformEnvironment,
): Promise<void> {
  assertExternalAbsent(options.evidence);
  let releasePlan: PlatformReleasePlan | undefined;
  try {
    await assertCleanAndPushed();
    assertPrivateFile(options.plan);
    if (!/^operator:[A-Za-z0-9._@-]{3,128}$/u.test(options.reviewer)) {
      throw new Error("platform_worker_release_reviewer_invalid");
    }
    releasePlan = parsePlan(
      readStablePhysicalBytes(
        options.plan,
        "platform_worker_release_plan_invalid",
      ),
      options.confirmation,
      environment,
    );
    if (git(["rev-parse", "HEAD"]).trim() !== releasePlan.sourceCommit) {
      throw new Error("platform_worker_release_source_drift");
    }
    await assertPlanClosure(releasePlan);
    await completeRelease(options, releasePlan, true);
  } catch (error) {
    writePlatformFailureIfAbsent(options, environment, releasePlan, error);
    throw error;
  }
}

async function recover(
  options: Extract<Options, { action: "recover" }>,
  environment: PlatformEnvironment,
): Promise<void> {
  assertExternalAbsent(options.evidence);
  let releasePlan: PlatformReleasePlan | undefined;
  try {
    await assertCleanAndPushed();
    assertPrivateFile(options.plan);
    if (!/^operator:[A-Za-z0-9._@-]{3,128}$/u.test(options.reviewer)) {
      throw new Error("platform_worker_release_reviewer_invalid");
    }
    releasePlan = parsePlan(
      readStablePhysicalBytes(
        options.plan,
        "platform_worker_release_plan_invalid",
      ),
      options.confirmation,
      environment,
    );
    const head = git(["rev-parse", "HEAD"]).trim();
    if (!isAncestor(releasePlan.sourceCommit, head)) {
      throw new Error("platform_worker_release_recovery_source_invalid");
    }
    await assertPlanClosure(releasePlan);
    await completeRelease(options, releasePlan, false, head);
  } catch (error) {
    writePlatformFailureIfAbsent(options, environment, releasePlan, error);
    throw error;
  }
}

async function restore(
  options: Extract<Options, { action: "restore" }>,
  environment: PlatformEnvironment,
): Promise<void> {
  assertExternalAbsent(options.evidence);
  let releasePlan: PlatformReleasePlan | undefined;
  try {
    await assertCleanAndPushed();
    assertPrivateFile(options.plan);
    if (!/^operator:[A-Za-z0-9._@-]{3,128}$/u.test(options.reviewer)) {
      throw new Error("platform_worker_release_reviewer_invalid");
    }
    releasePlan = parsePlan(
      readStablePhysicalBytes(
        options.plan,
        "platform_worker_release_plan_invalid",
      ),
      options.confirmation,
      environment,
    );
    const head = git(["rev-parse", "HEAD"]).trim();
    if (!isAncestor(releasePlan.sourceCommit, head)) {
      throw new Error("platform_worker_release_restore_source_invalid");
    }
    assertPlatformRestorePathGraph(options, releasePlan);
    await assertPlanClosure(releasePlan);
    await withPlatformRestoreLock(
      options.plan,
      releasePlan.confirmation,
      () => completeRestore(options, releasePlan!, head),
    );
  } catch (error) {
    const restoreState = releasePlan
      ? platformRestoreFailureState(options.plan, releasePlan.confirmation)
      : {
          mutationOutcome: "not-started" as const,
          failureBoundary: "pre-mutation" as const,
        };
    const evidence = {
      kind: "takosumi.platform-worker-restore-evidence@v1",
      status: "incomplete",
      completedAt: new Date().toISOString(),
      environment,
      ...(releasePlan
        ? {
            sourceCommit: releasePlan.sourceCommit,
            planConfirmation: releasePlan.confirmation,
            predecessorVersionId: releasePlan.predecessorVersionId,
            predecessorContainer: releasePlan.predecessorContainer,
          }
        : {}),
      reviewer: /^operator:[A-Za-z0-9._@-]{3,128}$/u.test(options.reviewer)
        ? options.reviewer
        : null,
      mutationOutcome: restoreState.mutationOutcome,
      failureBoundary: restoreState.failureBoundary,
      diagnostic: platformFailureDiagnostic(error),
      failureCode: "platform_worker_restore_incomplete",
    } as const;
    if (
      !(error instanceof Error) ||
      error.message !== "platform_worker_restore_path_alias"
    ) {
      try {
        writePrivate(
          options.evidence,
          new TextEncoder().encode(`${JSON.stringify(evidence, null, 2)}\n`),
        );
      } catch {
        // Preserve the primary restore failure when evidence itself is unusable.
      }
    }
    throw error;
  }
}

function writePlatformFailureIfAbsent(
  options: Extract<Options, { action: "execute" | "recover" }>,
  environment: PlatformEnvironment,
  plan: PlatformReleasePlan | undefined,
  error: unknown,
): void {
  try {
    lstatSync(options.evidence);
    return;
  } catch (readError) {
    if ((readError as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  let mutationOutcome: "not-started" | "unknown" | "accepted" = "not-started";
  let failureBoundary:
    | "pre-mutation"
    | "post-mutation-unknown"
    | "post-mutation-readback" = "pre-mutation";
  if (plan) {
    const state = platformMutationFailureState(
      options.plan,
      plan.confirmation,
    );
    mutationOutcome = state.mutationOutcome;
    failureBoundary = state.failureBoundary;
  }
  writePrivate(
    options.evidence,
    new TextEncoder().encode(
      `${JSON.stringify(
        {
          kind: "takosumi.platform-worker-release-evidence@v2",
          status: "incomplete",
          completedAt: new Date().toISOString(),
          environment,
          ...(plan
            ? {
                sourceCommit: plan.sourceCommit,
                configPath: plan.configPath,
                configSha256: plan.configSha256,
                sealedConfigSha256: plan.sealedConfigSha256,
                closureSha256: plan.closure.digest,
                planConfirmation: plan.confirmation,
              }
            : {}),
          reviewer: /^operator:[A-Za-z0-9._@-]{3,128}$/u.test(options.reviewer)
            ? options.reviewer
            : null,
          mutationOutcome,
          failureBoundary,
          diagnostic: platformFailureDiagnostic(error),
          failureCode: "platform_worker_release_incomplete",
        },
        null,
        2,
      )}\n`,
    ),
  );
}

async function buildDeterministicDashboard(
  environment: PlatformEnvironment,
): Promise<DashboardAssetSeal> {
  const build = async (): Promise<DashboardAssetSeal> => {
    await requiredCommand(
      ["bun", "run", "build"],
      undefined,
      resolve(ROOT, "dashboard"),
      platformDashboardBuildEnvironment(environment),
    );
    return dashboardAssetTreeSeal(resolve(ROOT, "dashboard/dist"));
  };
  const first = await build();
  const second = await build();
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("platform_worker_release_dashboard_nondeterministic");
  }
  return second;
}

type PlatformDryRunConfig = Readonly<{
  path: string;
  dispose: () => void;
}>;

export function createPlatformDryRunConfig(
  source: string,
  originalConfigPath: string,
): PlatformDryRunConfig {
  if (!isAbsolute(originalConfigPath)) {
    throw new Error("platform_worker_release_dry_run_config_invalid");
  }
  const workspace = createGlobalTransientDirectory(
    "takosumi-platform-dry-run-config-",
  );
  const path = join(workspace, "wrangler.toml");
  try {
    assertExternalAbsent(path);
    writePrivate(
      path,
      new TextEncoder().encode(
        platformDryRunConfigProjection(source, originalConfigPath),
      ),
    );
    let disposed = false;
    return {
      path,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        rmSync(workspace, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
}

function platformDryRunConfigProjection(
  source: string,
  originalConfigPath: string,
): string {
  const base = dirname(originalConfigPath);
  let projected = source;
  for (const name of ["main", "directory"] as const) {
    const expression = new RegExp(
      `^(${name}\\s*=\\s*)"([^"]+)"(\\s*)$`,
      "gmu",
    );
    const matches = [...projected.matchAll(expression)];
    if (matches.length !== 1) {
      throw new Error("platform_worker_release_dry_run_config_invalid");
    }
    projected = projected.replace(
      expression,
      (_match, prefix: string, value: string, suffix: string) =>
        `${prefix}${JSON.stringify(
          resolve(base, value).replaceAll("\\", "/"),
        )}${suffix}`,
    );
  }
  return projected;
}

async function createPlatformDeployClosure(
  closurePath: string,
  configSource: string,
  originalConfigPath: string,
  dashboardAssets: DashboardAssetSeal,
  sourceCommit: string,
  dryRunConfigPath = originalConfigPath,
): Promise<Readonly<{
  configPath: string;
  configSha256: string;
  uploadEntrypointPath: string;
  dryRun: DashboardAssetSeal;
  closure: DashboardAssetSeal;
}>> {
  mkdirSync(closurePath, { mode: 0o700 });
  const sourcePath = join(closurePath, "source");
  const dashboardPath = join(closurePath, "dashboard");
  const dryRunPath = join(closurePath, "dry-run");
  const configPath = join(closurePath, "wrangler.toml");
  mkdirSync(sourcePath, { mode: 0o700 });
  const archive = join(closurePath, "source.tar");
  await requiredCommand([
    "git",
    "archive",
    "--format=tar",
    `--output=${archive}`,
    sourceCommit,
  ]);
  await requiredCommand([
    "tar",
    "--extract",
    "--file",
    archive,
    "--directory",
    sourcePath,
    "--no-same-owner",
    "--no-same-permissions",
  ]);
  rmSync(archive);
  dashboardAssetTreeSeal(sourcePath);
  copyExactAssetTree(
    resolve(ROOT, "dashboard/dist"),
    dashboardPath,
    dashboardAssets,
  );
  const sealedSource = platformSealedConfigProjection(
    configSource,
    originalConfigPath,
    configPath,
    join(sourcePath, "deploy/platform/entry-worker.ts"),
    dashboardPath,
  );
  writePrivate(configPath, new TextEncoder().encode(sealedSource));
  mkdirSync(dryRunPath, { mode: 0o700 });
  const dryRun = await buildDryRunSeal(
    dryRunConfigPath,
    dryRunPath,
    true,
  );
  const entryCandidates = dryRun.entries.filter(
    (entry) => !entry.path.includes("/") && entry.path.endsWith(".js"),
  );
  if (entryCandidates.length !== 1) {
    throw new Error("platform_worker_release_dry_run_entrypoint_invalid");
  }
  const uploadEntrypointPath = join(
    dryRunPath,
    entryCandidates[0]!.path,
  );
  return {
    configPath,
    configSha256: digest(new TextEncoder().encode(sealedSource)),
    uploadEntrypointPath,
    dryRun,
    closure: dashboardAssetTreeSeal(closurePath),
  };
}

function copyExactAssetTree(
  sourceRoot: string,
  destinationRoot: string,
  expected: DashboardAssetSeal,
): void {
  mkdirSync(destinationRoot, { mode: 0o700 });
  for (const entry of expected.entries) {
    const source = resolve(sourceRoot, entry.path);
    const destination = resolve(destinationRoot, entry.path);
    if (
      !insideDirectory(source, sourceRoot) ||
      !insideDirectory(destination, destinationRoot)
    ) {
      throw new Error("platform_worker_release_asset_tree_invalid");
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const bytes = readStablePhysicalAsset(source, {});
    if (bytes.byteLength !== entry.size || digest(bytes) !== entry.sha256) {
      throw new Error("platform_worker_release_dashboard_drift");
    }
    writeFileSync(destination, bytes, { flag: "wx", mode: 0o400 });
    chmodSync(destination, 0o400);
  }
  if (
    JSON.stringify(dashboardAssetTreeSeal(destinationRoot)) !==
    JSON.stringify(expected)
  ) {
    throw new Error("platform_worker_release_dashboard_drift");
  }
}

export function createPlatformUploadCustody(
  closurePath: string,
  expected: DashboardAssetSeal,
  uploadEntrypointPath: string,
  parentPath: string,
): Readonly<{
  closurePath: string;
  configPath: string;
  uploadEntrypointPath: string;
  dispose: () => void;
}> {
  const sourceRoot = resolve(closurePath);
  const sourceEntrypoint = resolve(uploadEntrypointPath);
  const entryRelative = relative(sourceRoot, sourceEntrypoint).replaceAll(
    "\\",
    "/",
  );
  if (
    entryRelative === "" ||
    entryRelative.startsWith("../") ||
    isAbsolute(entryRelative) ||
    !expected.entries.some((entry) => entry.path === entryRelative) ||
    !expected.entries.some((entry) => entry.path === "wrangler.toml")
  ) {
    throw new Error("platform_worker_release_upload_custody_invalid");
  }
  const parent = resolve(parentPath);
  assertOutsideGitWorktree(join(parent, "upload-custody"));
  const parentInfo = lstatSync(parent);
  if (
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    parentInfo.uid !== process.getuid?.() ||
    (parentInfo.mode & 0o077) !== 0 ||
    realpathSync(parent) !== parent
  ) {
    throw new Error("platform_worker_release_upload_custody_invalid");
  }
  const workspace = mkdtempSync(join(parent, ".takosumi-platform-upload-"));
  chmodSync(workspace, 0o700);
  const destinationRoot = join(workspace, "closure");
  try {
    copyExactAssetTree(sourceRoot, destinationRoot, expected);
    if (
      JSON.stringify(dashboardAssetTreeSeal(destinationRoot)) !==
      JSON.stringify(expected)
    ) {
      throw new Error("platform_worker_release_upload_custody_invalid");
    }
    return {
      closurePath: destinationRoot,
      configPath: join(destinationRoot, "wrangler.toml"),
      uploadEntrypointPath: join(destinationRoot, entryRelative),
      dispose: () => rmSync(workspace, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
}

function assertPlatformUploadCustody(
  custody: Readonly<{ closurePath: string }>,
  expected: DashboardAssetSeal,
): void {
  if (
    JSON.stringify(dashboardAssetTreeSeal(custody.closurePath)) !==
    JSON.stringify(expected)
  ) {
    throw new Error("platform_worker_release_upload_custody_drift");
  }
}

export async function buildDryRunSeal(
  configPath: string,
  retainedOutput?: string,
  outputAlreadyExists = false,
  command: PlatformReleaseCommand = requiredCommand,
  buildRoot = ROOT,
): Promise<DashboardAssetSeal> {
  const output =
    retainedOutput ??
    createGlobalTransientDirectory("takosumi-platform-dry-run-");
  if (retainedOutput) assertOutsideGitWorktree(output);
  if (retainedOutput && !outputAlreadyExists) {
    mkdirSync(output, { mode: 0o700 });
  }
  try {
    const result = await command(
      [
        WRANGLER,
        "deploy",
        "--dry-run",
        "--outdir",
        output,
        "--containers-rollout",
        "immediate",
        "--strict",
        "--config",
        configPath,
      ],
      undefined,
      buildRoot,
    );
    if (result.exitCode !== 0) {
      throw new Error("platform_worker_release_dry_run_failed");
    }
    return dashboardAssetTreeSeal(output);
  } finally {
    if (!retainedOutput) rmSync(output, { recursive: true, force: true });
  }
}

function createGlobalTransientDirectory(prefix: string): string {
  const directory = mkdtempSync(join(resolve(tmpdir()), prefix));
  try {
    chmodSync(directory, 0o700);
    if (
      insideRoot(directory) ||
      realpathSync(directory) !== directory
    ) {
      throw new Error("platform_worker_release_output_must_be_globally_external");
    }
    assertOutsideGitWorktree(directory);
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function assertPlanClosure(plan: PlatformReleasePlan): Promise<void> {
  assertReadableConfig(plan.configPath);
  assertPrivateFile(plan.sealedConfigPath);
  const config = readStablePhysicalBytes(
    plan.configPath,
    "platform_worker_release_config_invalid",
  );
  const configSource = new TextDecoder("utf-8", { fatal: true }).decode(config);
  assertConfigTargetsSource(
    configSource,
    plan.configPath,
    plan.environment,
  );
  if (digest(config) !== plan.configSha256) {
    throw new Error("platform_worker_release_config_drift");
  }
  const expectedSealedSource = platformSealedConfigProjection(
    configSource,
    plan.configPath,
    plan.sealedConfigPath,
    join(plan.closurePath, "source/deploy/platform/entry-worker.ts"),
    join(plan.closurePath, "dashboard"),
  );
  const sealedConfig = readStablePhysicalBytes(
    plan.sealedConfigPath,
    "platform_worker_release_sealed_config_invalid",
  );
  if (
    digest(sealedConfig) !== plan.sealedConfigSha256 ||
    new TextDecoder("utf-8", { fatal: true }).decode(sealedConfig) !==
      expectedSealedSource ||
    JSON.stringify(dashboardAssetTreeSeal(plan.closurePath)) !==
      JSON.stringify(plan.closure)
  ) {
    throw new Error("platform_worker_release_sealed_closure_drift");
  }
  const expectedRestoreSource = platformSealedConfigProjection(
    platformRestoreConfigProjection(
      configSource,
      plan.predecessorContainer.image,
    ),
    plan.configPath,
    plan.restoreSealedConfigPath,
    join(plan.restoreClosurePath, "source/deploy/platform/entry-worker.ts"),
    join(plan.restoreClosurePath, "dashboard"),
  );
  const restoreConfig = readStablePhysicalBytes(
    plan.restoreSealedConfigPath,
    "platform_worker_release_restore_closure_invalid",
  );
  if (
    digest(restoreConfig) !== plan.restoreSealedConfigSha256 ||
    new TextDecoder("utf-8", { fatal: true }).decode(restoreConfig) !==
      expectedRestoreSource ||
    JSON.stringify(dashboardAssetTreeSeal(plan.restoreClosurePath)) !==
      JSON.stringify(plan.restoreClosure)
  ) {
    throw new Error("platform_worker_release_restore_closure_drift");
  }
  await assertSecretNamesUnchanged(
    plan.sealedConfigPath,
    plan.secretNamesSha256,
  );
  if (
    JSON.stringify(dashboardAssetTreeSeal(resolve(ROOT, "dashboard/dist"))) !==
    JSON.stringify(plan.dashboardAssets)
  ) {
    throw new Error("platform_worker_release_dashboard_drift");
  }
}

async function completeRelease(
  options: Extract<Options, { action: "execute" | "recover" }>,
  plan: PlatformReleasePlan,
  allowMutation: boolean,
  recoverySourceCommit?: string,
): Promise<void> {
  let fence = readPlatformMutationFence(options.plan, plan.confirmation);
  let mutationOutcome: "not-started" | "unknown" | "accepted" =
    fence?.outcome ?? "not-started";
  let lostAcknowledgement = false;
  let custody: ReturnType<typeof createPlatformUploadCustody> | null = null;
  try {
    custody = createPlatformUploadCustody(
      plan.closurePath,
      plan.closure,
      plan.uploadEntrypointPath,
      dirname(plan.checkpointPath),
    );
    if (fence === null) {
      if (!allowMutation) {
        throw new Error("platform_worker_release_recovery_not_started");
      }
      if (
        (await readServingVersion(custody.configPath)) !==
        plan.predecessorVersionId
      ) {
        throw new Error("platform_worker_release_predecessor_drift");
      }
      assertPlatformUploadCustody(custody, plan.closure);
      appendPlatformMutationFence(
        options.plan,
        plan.confirmation,
        { outcome: "unknown", versionId: null },
      );
      mutationOutcome = "unknown";
      assertPlatformUploadCustody(custody, plan.closure);
      const deployed = await requiredCommand(
        platformWorkerDeployArguments(
          custody.configPath,
          plan.releaseTag,
          platformReleaseMessage(plan),
          custody.uploadEntrypointPath,
        ),
      );
      assertPlatformUploadCustody(custody, plan.closure);
      const deployedVersionId = parseDeployedVersion(
        `${deployed.stdout}\n${deployed.stderr}`,
      );
      appendPlatformMutationFence(
        options.plan,
        plan.confirmation,
        { outcome: "accepted", versionId: deployedVersionId },
      );
      fence = { outcome: "accepted", versionId: deployedVersionId };
      mutationOutcome = "accepted";
    }

    let deployedVersionId: string;
    if (fence.outcome === "unknown") {
      const versions = await requiredCommand([
        WRANGLER,
        "versions",
        "list",
        "--config",
        custody.configPath,
        "--json",
      ]);
      deployedVersionId = selectRecoveredVersion(
        versions.stdout,
        plan.createdAt,
        plan.releaseTag,
      );
      appendPlatformMutationFence(
        options.plan,
        plan.confirmation,
        { outcome: "accepted", versionId: deployedVersionId },
      );
      mutationOutcome = "accepted";
      lostAcknowledgement = true;
    } else {
      deployedVersionId = fence.versionId!;
    }

    await waitForExactServingVersion(
      custody.configPath,
      deployedVersionId,
      plan.predecessorVersionId,
    );
    await verifyPublishedVersion(
      custody.configPath,
      deployedVersionId,
      plan.releaseTag,
      platformReleaseMessage(plan),
    );
    await verifyPublicReadback(plan.environment, deployedVersionId);
    const deployedContainer = await waitForPlatformContainer(
      custody.configPath,
      plan.environment,
      configuredRunnerImage(custody.configPath),
    );
    assertPlatformUploadCustody(custody, plan.closure);
    const evidence = {
      kind: "takosumi.platform-worker-release-evidence@v2",
      status: "ready",
      completedAt: new Date().toISOString(),
      environment: plan.environment,
      sourceCommit: plan.sourceCommit,
      ...(recoverySourceCommit && recoverySourceCommit !== plan.sourceCommit
        ? { recoverySourceCommit }
        : {}),
      configPath: plan.configPath,
      configSha256: plan.configSha256,
      sealedConfigSha256: plan.sealedConfigSha256,
      closureSha256: plan.closure.digest,
      dashboardAssetsSha256: plan.dashboardAssets.digest,
      dryRunSha256: plan.dryRun.digest,
      secretNamesSha256: plan.secretNamesSha256,
      predecessorVersionId: plan.predecessorVersionId,
      predecessorContainer: plan.predecessorContainer,
      deployedVersionId,
      deployedContainer,
      releaseTag: plan.releaseTag,
      planConfirmation: plan.confirmation,
      reviewer: options.reviewer,
      lostAcknowledgement,
      reversal: {
        surface:
          plan.environment === "staging"
            ? "takosumi-platform-staging"
            : "takosumi-platform",
        action: "restore",
        planConfirmation: plan.confirmation,
        predecessorVersionId: plan.predecessorVersionId,
        predecessorContainer: plan.predecessorContainer,
      },
    } as const;
    writePrivate(
      options.evidence,
      new TextEncoder().encode(`${JSON.stringify(evidence, null, 2)}\n`),
    );
    process.stdout.write(
      `${JSON.stringify({ kind: evidence.kind, status: evidence.status, deployedVersionId, lostAcknowledgement, evidence: options.evidence })}\n`,
    );
  } catch (error) {
    try {
      const observedFence = readPlatformMutationFence(
        options.plan,
        plan.confirmation,
      );
      mutationOutcome = observedFence?.outcome ?? mutationOutcome;
    } catch {
      // A torn checkpoint can only prove ambiguity after the durable
      // pre-command boundary, never that the target was untouched.
      mutationOutcome = "unknown";
    }
    const evidence = {
      kind: "takosumi.platform-worker-release-evidence@v2",
      status: "incomplete",
      completedAt: new Date().toISOString(),
      environment: plan.environment,
      sourceCommit: plan.sourceCommit,
      configPath: plan.configPath,
      configSha256: plan.configSha256,
      sealedConfigSha256: plan.sealedConfigSha256,
      closureSha256: plan.closure.digest,
      dashboardAssetsSha256: plan.dashboardAssets.digest,
      dryRunSha256: plan.dryRun.digest,
      secretNamesSha256: plan.secretNamesSha256,
      predecessorVersionId: plan.predecessorVersionId,
      releaseTag: plan.releaseTag,
      planConfirmation: plan.confirmation,
      reviewer: options.reviewer,
      mutationOutcome,
      failureBoundary:
        mutationOutcome === "not-started"
          ? "pre-mutation"
          : mutationOutcome === "unknown"
            ? "post-mutation-unknown"
            : "post-mutation-readback",
      diagnostic: platformFailureDiagnostic(error),
      failureCode: "platform_worker_release_incomplete",
    } as const;
    writePrivate(
      options.evidence,
      new TextEncoder().encode(`${JSON.stringify(evidence, null, 2)}\n`),
    );
    throw new Error("platform_worker_release_incomplete", { cause: error });
  } finally {
    custody?.dispose();
  }
}

function assertPlatformRestorePathGraph(
  options: Extract<Options, { action: "restore" }>,
  plan: PlatformReleasePlan,
): void {
  const lock = platformRestoreLockIdentity(options.plan, plan.confirmation);
  const requested = [
    { label: "plan", path: options.plan },
    { label: "evidence", path: options.evidence },
    { label: "config", path: plan.configPath },
    { label: "closure", path: plan.closurePath },
    { label: "sealed-config", path: plan.sealedConfigPath },
    { label: "upload-entrypoint", path: plan.uploadEntrypointPath },
    { label: "checkpoint", path: plan.checkpointPath },
    {
      label: "restore-checkpoint",
      path: `${plan.checkpointPath}.restore`,
    },
    { label: "restore-closure", path: plan.restoreClosurePath },
    { label: "restore-sealed-config", path: plan.restoreSealedConfigPath },
    {
      label: "restore-upload-entrypoint",
      path: plan.restoreUploadEntrypointPath,
    },
    { label: "restore-lock", path: lock.lockPath },
  ].map((entry) => {
    if (!isAbsolute(entry.path)) {
      throw new Error("platform_worker_release_path_invalid");
    }
    const absolute = resolve(entry.path);
    return {
      ...entry,
      absolute,
      canonical: canonicalFuturePath(absolute),
      status: optionalBigIntLstat(absolute),
    };
  });
  for (let leftIndex = 0; leftIndex < requested.length; leftIndex += 1) {
    const left = requested[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < requested.length;
      rightIndex += 1
    ) {
      const right = requested[rightIndex]!;
      if (
        left.canonical === right.canonical ||
        (left.status !== null &&
          right.status !== null &&
          left.status.dev === right.status.dev &&
          left.status.ino === right.status.ino)
      ) {
        throw new Error("platform_worker_restore_path_alias");
      }
    }
  }
  const canonicalLockDirectory = canonicalFuturePath(lock.directory);
  const pendingPrefix = `${basename(lock.lockPath)}.pending-`;
  if (
    requested.some(
      (entry) =>
        entry.label !== "restore-lock" &&
        dirname(entry.canonical) === canonicalLockDirectory &&
        basename(entry.canonical).startsWith(pendingPrefix),
    )
  ) {
    throw new Error("platform_worker_restore_path_alias");
  }
}

function canonicalFuturePath(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(cursor), ...missing);
    } catch (error) {
      if (!fileSystemError(error, "ENOENT")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

async function completeRestore(
  options: Extract<Options, { action: "restore" }>,
  plan: PlatformReleasePlan,
  restoreSourceCommit: string,
): Promise<void> {
  const forward = readPlatformMutationFence(options.plan, plan.confirmation);
  if (forward?.outcome !== "accepted" || !forward.versionId) {
    throw new Error("platform_worker_restore_forward_release_incomplete");
  }
  let custody: ReturnType<typeof createPlatformUploadCustody> | null = null;
  try {
    custody = createPlatformUploadCustody(
      plan.restoreClosurePath,
      plan.restoreClosure,
      plan.restoreUploadEntrypointPath,
      dirname(plan.checkpointPath),
    );
    const restoreTag = platformRestoreTag(plan);
    const restoreMessage = platformRestoreMessage(plan);
    let fence = readPlatformRestoreFence(options.plan, plan.confirmation);
    let restoreVersionId: string;
    if (fence.container === undefined) {
      const serving = await readServingVersion(custody.configPath);
      if (serving !== forward.versionId) {
        throw new Error("platform_worker_restore_concurrent_version");
      }
      const currentContainer = await readPlatformContainer(
        custody.configPath,
        plan.environment,
      );
      assertPlatformRestoreCandidate(
        currentContainer,
        plan.predecessorContainer,
        configuredRunnerImage(plan.sealedConfigPath),
      );
      assertPlatformUploadCustody(custody, plan.restoreClosure);
      appendPlatformRestoreFence(
        options.plan,
        plan.confirmation,
        "container",
        { outcome: "unknown", versionId: null },
      );
      const restored = await requiredCommand(
        platformWorkerDeployArguments(
          custody.configPath,
          restoreTag,
          restoreMessage,
          custody.uploadEntrypointPath,
        ),
      );
      assertPlatformUploadCustody(custody, plan.restoreClosure);
      restoreVersionId = parseDeployedVersion(
        `${restored.stdout}\n${restored.stderr}`,
      );
      appendPlatformRestoreFence(
        options.plan,
        plan.confirmation,
        "container",
        { outcome: "accepted", versionId: restoreVersionId },
      );
      fence = readPlatformRestoreFence(options.plan, plan.confirmation);
    } else if (fence.container.outcome === "unknown") {
      const versions = await requiredCommand([
        WRANGLER,
        "versions",
        "list",
        "--config",
        custody.configPath,
        "--json",
      ]);
      restoreVersionId = selectRecoveredVersion(
        versions.stdout,
        plan.createdAt,
        restoreTag,
      );
      appendPlatformRestoreFence(
        options.plan,
        plan.confirmation,
        "container",
        { outcome: "accepted", versionId: restoreVersionId },
      );
      fence = readPlatformRestoreFence(options.plan, plan.confirmation);
    } else {
      restoreVersionId = fence.container.versionId!;
    }

    await waitForServingTransition(
      custody.configPath,
      restoreVersionId,
      [forward.versionId, plan.predecessorVersionId],
    );
    await verifyPublishedVersion(
      custody.configPath,
      restoreVersionId,
      restoreTag,
      restoreMessage,
    );
    const restoredContainer = await waitForPlatformContainer(
      custody.configPath,
      plan.environment,
      plan.predecessorContainer.image,
    );
    assertPlatformRestoreCandidate(
      restoredContainer,
      plan.predecessorContainer,
      configuredRunnerImage(plan.sealedConfigPath),
    );
    assertPlatformContainerComplete(
      restoredContainer,
      plan.predecessorContainer.image,
    );

    if (fence.worker === undefined) {
      appendPlatformRestoreFence(
        options.plan,
        plan.confirmation,
        "worker",
        { outcome: "unknown", versionId: null },
      );
      await requiredCommand(
        platformWorkerRestoreVersionArguments(
          custody.configPath,
          plan.predecessorVersionId,
          restoreMessage,
        ),
      );
      appendPlatformRestoreFence(
        options.plan,
        plan.confirmation,
        "worker",
        { outcome: "accepted", versionId: plan.predecessorVersionId },
      );
    } else if (fence.worker.outcome === "unknown") {
      const serving = await readServingVersion(custody.configPath);
      if (serving !== plan.predecessorVersionId) {
        if (serving !== restoreVersionId) {
          throw new Error("platform_worker_restore_concurrent_version");
        }
        // This is an explicit reviewed recovery after authoritative readback
        // proved the exact predecessor is not serving. Re-issuing the exact
        // one-Version routing intent is idempotent; no upload is repeated.
        await requiredCommand(
          platformWorkerRestoreVersionArguments(
            custody.configPath,
            plan.predecessorVersionId,
            restoreMessage,
          ),
        );
      }
      appendPlatformRestoreFence(
        options.plan,
        plan.confirmation,
        "worker",
        { outcome: "accepted", versionId: plan.predecessorVersionId },
      );
    } else if (fence.worker.versionId !== plan.predecessorVersionId) {
      throw new Error("platform_worker_restore_checkpoint_invalid");
    }

    await waitForServingTransition(
      custody.configPath,
      plan.predecessorVersionId,
      [restoreVersionId],
    );
    await verifyPublicReadback(plan.environment, plan.predecessorVersionId);
    const finalContainer = await waitForPlatformContainer(
      custody.configPath,
      plan.environment,
      plan.predecessorContainer.image,
    );
    assertPlatformRestoreCandidate(
      finalContainer,
      plan.predecessorContainer,
      configuredRunnerImage(plan.sealedConfigPath),
    );
    assertPlatformContainerComplete(
      finalContainer,
      plan.predecessorContainer.image,
    );
    assertPlatformUploadCustody(custody, plan.restoreClosure);
    const evidence = {
      kind: "takosumi.platform-worker-restore-evidence@v1",
      status: "restored",
      completedAt: new Date().toISOString(),
      environment: plan.environment,
      sourceCommit: plan.sourceCommit,
      ...(restoreSourceCommit !== plan.sourceCommit
        ? { restoreSourceCommit }
        : {}),
      planConfirmation: plan.confirmation,
      reviewer: options.reviewer,
      deployedVersionId: forward.versionId,
      restoreVersionId,
      predecessorVersionId: plan.predecessorVersionId,
      predecessorContainer: plan.predecessorContainer,
      restoredContainer,
      finalContainer,
    } as const;
    writePrivate(
      options.evidence,
      new TextEncoder().encode(`${JSON.stringify(evidence, null, 2)}\n`),
    );
    process.stdout.write(
      `${JSON.stringify({ kind: evidence.kind, status: evidence.status, predecessorVersionId: evidence.predecessorVersionId, evidence: options.evidence })}\n`,
    );
  } finally {
    custody?.dispose();
  }
}

async function waitForServingTransition(
  configPath: string,
  expectedVersionId: string,
  allowedPriorVersionIds: readonly string[],
): Promise<void> {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const serving = await readServingVersion(configPath);
    if (serving === expectedVersionId) return;
    if (!allowedPriorVersionIds.includes(serving)) {
      throw new Error("platform_worker_restore_concurrent_version");
    }
    if (attempt < 8) await Bun.sleep(attempt * 1_000);
  }
  throw new Error("platform_worker_restore_readback_incomplete");
}

function platformReleaseMessage(plan: PlatformReleasePlan): string {
  return `takosumi-platform-release ${plan.confirmation}`;
}

function platformRestoreMessage(plan: PlatformReleasePlan): string {
  return `takosumi-platform-restore ${plan.confirmation}`;
}

function platformRestoreTag(plan: PlatformReleasePlan): string {
  return `tks-rst-${plan.confirmation.slice("sha256:".length, "sha256:".length + 48)}`;
}

function platformReleaseTag(identity: Readonly<Record<string, unknown>>): string {
  const environment = identity.environment;
  if (environment !== "staging" && environment !== "production") {
    throw new Error("platform_worker_release_plan_invalid");
  }
  const identityDigest = digest(
    new TextEncoder().encode(JSON.stringify(identity)),
  ).slice("sha256:".length);
  return `tks-${environment === "staging" ? "stg" : "prod"}-${identityDigest.slice(0, 48)}`;
}

function parsePlan(
  bytes: Uint8Array,
  confirmation: string,
  environment: PlatformEnvironment,
): PlatformReleasePlan {
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as unknown;
  if (!record(value)) throw new Error("platform_worker_release_plan_invalid");
  const { confirmation: recorded, releaseTag, ...identity } = value;
  const subject = { ...identity, releaseTag };
  if (
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(
        [
          "kind",
          "createdAt",
          "environment",
          "sourceCommit",
          "releaseNonce",
          "configPath",
          "configSha256",
          "closurePath",
          "closure",
          "sealedConfigPath",
          "sealedConfigSha256",
          "uploadEntrypointPath",
          "checkpointPath",
          "restoreClosurePath",
          "restoreClosure",
          "restoreSealedConfigPath",
          "restoreSealedConfigSha256",
          "restoreUploadEntrypointPath",
          "restoreDryRun",
          "dashboardAssets",
          "dryRun",
          "secretNamesSha256",
          "predecessorVersionId",
          "predecessorContainer",
          "releaseTag",
          "confirmation",
        ].sort(),
      ) ||
    value.kind !== "takosumi.platform-worker-release-plan@v5" ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    value.environment !== environment ||
    typeof value.sourceCommit !== "string" ||
    !COMMIT.test(value.sourceCommit) ||
    typeof value.releaseNonce !== "string" ||
    !/^[0-9a-f]{32}$/u.test(value.releaseNonce) ||
    typeof value.configPath !== "string" ||
    !isAbsolute(value.configPath) ||
    typeof value.configSha256 !== "string" ||
    !SHA256.test(value.configSha256) ||
    typeof value.closurePath !== "string" ||
    !isAbsolute(value.closurePath) ||
    typeof value.sealedConfigPath !== "string" ||
    value.sealedConfigPath !== join(value.closurePath, "wrangler.toml") ||
    typeof value.sealedConfigSha256 !== "string" ||
    !SHA256.test(value.sealedConfigSha256) ||
    typeof value.uploadEntrypointPath !== "string" ||
    !isAbsolute(value.uploadEntrypointPath) ||
    !insideDirectory(value.uploadEntrypointPath, join(value.closurePath, "dry-run")) ||
    typeof value.checkpointPath !== "string" ||
    !isAbsolute(value.checkpointPath) ||
    typeof value.restoreClosurePath !== "string" ||
    !isAbsolute(value.restoreClosurePath) ||
    typeof value.restoreSealedConfigPath !== "string" ||
    value.restoreSealedConfigPath !==
      join(value.restoreClosurePath, "wrangler.toml") ||
    typeof value.restoreSealedConfigSha256 !== "string" ||
    !SHA256.test(value.restoreSealedConfigSha256) ||
    typeof value.restoreUploadEntrypointPath !== "string" ||
    !isAbsolute(value.restoreUploadEntrypointPath) ||
    !insideDirectory(
      value.restoreUploadEntrypointPath,
      join(value.restoreClosurePath, "dry-run"),
    ) ||
    !validAssetSeal(value.closure) ||
    !validAssetSeal(value.restoreClosure) ||
    !validAssetSeal(value.dashboardAssets) ||
    !validAssetSeal(value.dryRun) ||
    !validAssetSeal(value.restoreDryRun) ||
    !value.dryRun.entries.some(
      (entry) =>
        entry.path ===
        relative(
          join(value.closurePath as string, "dry-run"),
          value.uploadEntrypointPath as string,
        ).replaceAll("\\", "/"),
    ) ||
    !value.restoreDryRun.entries.some(
      (entry) =>
        entry.path ===
        relative(
          join(value.restoreClosurePath as string, "dry-run"),
          value.restoreUploadEntrypointPath as string,
        ).replaceAll("\\", "/"),
    ) ||
    typeof value.secretNamesSha256 !== "string" ||
    !SHA256.test(value.secretNamesSha256) ||
    typeof value.predecessorVersionId !== "string" ||
    !VERSION.test(value.predecessorVersionId) ||
    !validPlatformContainerState(value.predecessorContainer) ||
    typeof releaseTag !== "string" ||
    releaseTag !== platformReleaseTag(identity) ||
    typeof recorded !== "string" ||
    !SHA256.test(recorded) ||
    confirmation !== recorded ||
    digest(new TextEncoder().encode(JSON.stringify(subject))) !== recorded
  ) {
    throw new Error("platform_worker_release_plan_invalid");
  }
  return value as unknown as PlatformReleasePlan;
}

function validAssetSeal(value: unknown): value is DashboardAssetSeal {
  if (
    !record(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(["digest", "entries"]) ||
    typeof value.digest !== "string" ||
    !SHA256.test(value.digest) ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0
  ) {
    return false;
  }
  const paths: string[] = [];
  for (const entry of value.entries) {
    if (
      !record(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !==
        JSON.stringify(["path", "sha256", "size"]) ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.includes("\\") ||
      isAbsolute(entry.path) ||
      entry.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== "string" ||
      !SHA256.test(entry.sha256)
    ) {
      return false;
    }
    paths.push(entry.path);
  }
  if (
    new Set(paths).size !== paths.length ||
    JSON.stringify(paths) !==
      JSON.stringify([...paths].sort(codePointCompare))
  ) {
    return false;
  }
  return (
    value.digest ===
    digest(
      new TextEncoder().encode(
        JSON.stringify({
          kind: "takosumi.dashboard-asset-tree@v1",
          entries: value.entries,
        }),
      ),
    )
  );
}

export function parseServingVersion(stdout: string): string {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("platform_worker_release_serving_version_invalid");
  }
  if (
    !record(value) ||
    !Array.isArray(value.versions) ||
    value.versions.length !== 1 ||
    !record(value.versions[0]) ||
    value.versions[0].percentage !== 100
  ) {
    throw new Error("platform_worker_release_serving_version_invalid");
  }
  const id = value.versions[0].version_id;
  if (typeof id !== "string" || !VERSION.test(id)) {
    throw new Error("platform_worker_release_serving_version_invalid");
  }
  return id;
}

export function assertServingVersion(
  stdout: string,
  expectedVersionId: string,
  predecessorVersionId: string,
): void {
  const current = parseServingVersion(stdout);
  if (current === predecessorVersionId) {
    throw new Error("platform_worker_release_predecessor_unchanged");
  }
  if (current !== expectedVersionId) {
    throw new Error("platform_worker_release_concurrent_version");
  }
}

export function selectRecoveredVersion(
  stdout: string,
  planCreatedAt: string,
  expectedTag: string,
): string {
  const value = JSON.parse(stdout) as unknown;
  if (!Array.isArray(value) || !Number.isFinite(Date.parse(planCreatedAt))) {
    throw new Error("platform_worker_release_versions_invalid");
  }
  const ids = value.flatMap((entry) => {
    if (!record(entry))
      throw new Error("platform_worker_release_versions_invalid");
    const metadata = entry.metadata;
    const annotations = entry.annotations;
    if (!record(metadata)) {
      throw new Error("platform_worker_release_versions_invalid");
    }
    const id = entry.id;
    const createdOn = metadata.created_on;
    if (
      typeof id !== "string" ||
      !VERSION.test(id) ||
      typeof createdOn !== "string" ||
      !Number.isFinite(Date.parse(createdOn))
    ) {
      throw new Error("platform_worker_release_versions_invalid");
    }
    return Date.parse(createdOn) >= Date.parse(planCreatedAt) &&
        record(annotations) &&
        annotations["workers/tag"] === expectedTag
      ? [id]
      : [];
  });
  if (ids.length !== 1) {
    throw new Error("platform_worker_release_recovery_version_ambiguous");
  }
  return ids[0]!;
}

export function bindingNames(stdout: string): readonly string[] {
  const value = JSON.parse(stdout) as unknown;
  if (
    !record(value) ||
    !record(value.resources) ||
    !Array.isArray(value.resources.bindings)
  ) {
    throw new Error("platform_worker_release_version_invalid");
  }
  const names = new Set<string>();
  for (const binding of value.resources.bindings) {
    if (!record(binding))
      throw new Error("platform_worker_release_version_invalid");
    for (const key of ["name", "binding"] as const) {
      const candidate = binding[key];
      if (typeof candidate === "string") names.add(candidate);
    }
  }
  return [...names].sort(codePointCompare);
}

export function secretNames(stdout: string): readonly string[] {
  const value = JSON.parse(stdout) as unknown;
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error("platform_worker_release_secret_list_invalid");
  }
  const names = value.map((entry) => {
    if (!record(entry) || typeof entry.name !== "string") {
      throw new Error("platform_worker_release_secret_list_invalid");
    }
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(entry.name)) {
      throw new Error("platform_worker_release_secret_list_invalid");
    }
    return entry.name;
  });
  if (new Set(names).size !== names.length) {
    throw new Error("platform_worker_release_secret_list_invalid");
  }
  return names.sort(codePointCompare);
}

export function assertPublishedVersion(
  stdout: string,
  expectedHostedService: string,
  expectedVersionId?: string,
  expectedTag?: string,
  expectedMessage?: string,
): void {
  const value = JSON.parse(stdout) as unknown;
  if (
    !record(value) ||
    !record(value.resources) ||
    !record(value.resources.script) ||
    !Array.isArray(value.resources.script.handlers) ||
    !Array.isArray(value.resources.bindings) ||
    value.resources.script.handlers.some(
      (handler) => typeof handler !== "string",
    )
  ) {
    throw new Error("platform_worker_release_version_invalid");
  }
  if (
    expectedVersionId !== undefined &&
    (value.id !== expectedVersionId ||
      !record(value.annotations) ||
      value.annotations["workers/tag"] !== expectedTag ||
      value.annotations["workers/message"] !== expectedMessage)
  ) {
    throw new Error("platform_worker_release_version_identity_invalid");
  }
  const bindings = value.resources.bindings;
  for (const required of REQUIRED_BINDINGS) {
    const matches = bindings.filter(
      (binding) =>
        record(binding) &&
        (binding.name === required || binding.binding === required),
    );
    const expectedType = {
      ASSETS: "assets",
      TAKOSUMI_ACCOUNTS_DB: "d1",
      TAKOSUMI_CONTROL_DB: "d1",
      HOSTED: "service",
      TAKOSUMI_VERSION_METADATA: "version_metadata",
      TAKOSUMI_RUNTIME_BINDING_DERIVATION_KEY: "secret_text",
    }[required];
    if (
      matches.length !== 1 ||
      !record(matches[0]) ||
      matches[0].type !== expectedType ||
      (required === "HOSTED" && matches[0].service !== expectedHostedService)
    ) {
      throw new Error("platform_worker_release_binding_invalid");
    }
  }
  const rawNamedHandlers = value.resources.script.named_handlers;
  if (rawNamedHandlers !== undefined && !Array.isArray(rawNamedHandlers)) {
    throw new Error("platform_worker_release_version_invalid");
  }
  const namedHandlers = (rawNamedHandlers ?? []).map((handler) => {
    if (!record(handler) || typeof handler.name !== "string") {
      throw new Error("platform_worker_release_version_invalid");
    }
    return handler.name;
  });
  const handlers = new Set([
    ...(value.resources.script.handlers as readonly string[]),
    ...namedHandlers,
  ]);
  if (!handlers.has("fetch")) {
    throw new Error("platform_worker_release_fetch_handler_missing");
  }
}

async function readSecretNames(config: string): Promise<readonly string[]> {
  const result = await requiredCommand([
    WRANGLER,
    "secret",
    "list",
    "--format",
    "json",
    "--config",
    config,
  ]);
  return secretNames(result.stdout);
}

async function assertSecretNamesUnchanged(
  config: string,
  expectedDigest: string,
): Promise<void> {
  const names = await readSecretNames(config);
  if (
    digest(new TextEncoder().encode(JSON.stringify(names))) !== expectedDigest
  ) {
    throw new Error("platform_worker_release_secret_list_drift");
  }
}

async function verifyPublishedVersion(
  config: string,
  versionId: string,
  releaseTag: string,
  releaseMessage: string,
): Promise<void> {
  const version = await requiredCommand([
    WRANGLER,
    "versions",
    "view",
    versionId,
    "--config",
    config,
    "--json",
  ]);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(
    readStablePhysicalBytes(
      config,
      "platform_worker_release_upload_custody_drift",
    ),
  );
  const configuredEnvironment =
    /^TAKOSUMI_ENVIRONMENT\s*=\s*"(staging|production)"\s*$/mu.exec(
      source,
    )?.[1];
  if (
    configuredEnvironment !== "staging" &&
    configuredEnvironment !== "production"
  ) {
    throw new Error("platform_worker_release_config_source_invalid");
  }
  assertPublishedVersion(
    version.stdout,
    platformTargetForEnvironment(configuredEnvironment).hostedService,
    versionId,
    releaseTag,
    releaseMessage,
  );
}

async function readServingVersion(config: string): Promise<string> {
  const result = await requiredCommand([
    WRANGLER,
    "deployments",
    "status",
    "--config",
    config,
    "--json",
  ]);
  return parseServingVersion(result.stdout);
}

function configuredRunnerImage(configPath: string): string {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(
    readStablePhysicalBytes(
      configPath,
      "platform_worker_release_config_source_invalid",
    ),
  );
  try {
    return platformRunnerImageRange(source).image;
  } catch {
    throw new Error("platform_worker_release_config_source_invalid");
  }
}

async function readPlatformContainer(
  configPath: string,
  environment: PlatformEnvironment,
): Promise<PlatformContainerState> {
  const expectedName = `${platformTargetForEnvironment(environment).workerName}-opentofurunnerobject`;
  const list = await requiredCommand([
    WRANGLER,
    "containers",
    "list",
    "--json",
    "--config",
    configPath,
  ]);
  let summaries: unknown;
  try {
    summaries = JSON.parse(list.stdout) as unknown;
  } catch {
    throw new Error("platform_worker_release_container_list_invalid");
  }
  if (!Array.isArray(summaries)) {
    throw new Error("platform_worker_release_container_list_invalid");
  }
  const matching = summaries.filter(
    (entry) => record(entry) && entry.name === expectedName,
  );
  if (
    matching.length !== 1 ||
    !record(matching[0]) ||
    !boundedString(matching[0].id, 256) ||
    !boundedString(matching[0].state, 64) ||
    !RUNNER_IMAGE.test(String(matching[0].image)) ||
    !platformContainerVersion(matching[0].version)
  ) {
    throw new Error("platform_worker_release_container_list_invalid");
  }
  const summary = matching[0];
  const info = await requiredCommand([
    WRANGLER,
    "containers",
    "info",
    summary.id as string,
    "--config",
    configPath,
  ]);
  let detail: unknown;
  try {
    detail = JSON.parse(info.stdout) as unknown;
  } catch {
    throw new Error("platform_worker_release_container_detail_invalid");
  }
  return parsePlatformContainerDetail(summary, detail);
}

export function parsePlatformContainerDetail(
  summary: Readonly<Record<string, unknown>>,
  detail: unknown,
): PlatformContainerState {
  if (!record(detail) || !record(detail.configuration)) {
    throw new Error("platform_worker_release_container_detail_invalid");
  }
  const image = detail.configuration.image;
  const hasState = Object.hasOwn(detail, "state");
  if (
    detail.id !== summary.id ||
    detail.name !== summary.name ||
    detail.version !== summary.version ||
    image !== summary.image ||
    (hasState &&
      (!boundedString(detail.state, 64) || detail.state !== summary.state)) ||
    !RUNNER_IMAGE.test(String(image))
  ) {
    throw new Error("platform_worker_release_container_list_detail_mismatch");
  }
  const health = platformContainerHealth(detail);
  return {
    id: detail.id as string,
    name: detail.name as string,
    state: summary.state as string,
    image: image as string,
    version: detail.version as string | number,
    hasActiveRollout:
      detail.active_rollout_id !== undefined &&
      detail.active_rollout_id !== null,
    health,
  };
}

function platformContainerHealth(
  detail: Record<string, unknown>,
): PlatformContainerState["health"] {
  const health = detail.health;
  const instances = record(health) ? health.instances : undefined;
  const errors = record(health) ? health.errors : undefined;
  const failed = record(instances) ? instances.failed : undefined;
  const starting = record(instances) ? instances.starting : undefined;
  const scheduling = record(instances) ? instances.scheduling : undefined;
  if (
    !nonNegativeInteger(failed) ||
    !nonNegativeInteger(starting) ||
    !nonNegativeInteger(scheduling) ||
    !Array.isArray(errors)
  ) {
    throw new Error("platform_worker_release_container_health_invalid");
  }
  return { failed, starting, scheduling, errorCount: errors.length };
}

function validPlatformContainerState(value: unknown): value is PlatformContainerState {
  return (
    record(value) &&
    boundedString(value.id, 256) &&
    boundedString(value.name, 256) &&
    boundedString(value.state, 64) &&
    RUNNER_IMAGE.test(String(value.image)) &&
    platformContainerVersion(value.version) &&
    typeof value.hasActiveRollout === "boolean" &&
    record(value.health) &&
    nonNegativeInteger(value.health.failed) &&
    nonNegativeInteger(value.health.starting) &&
    nonNegativeInteger(value.health.scheduling) &&
    nonNegativeInteger(value.health.errorCount)
  );
}

function platformContainerVersion(value: unknown): value is string | number {
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    boundedString(value, 128)
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function assertPlatformContainerComplete(
  state: PlatformContainerState,
  expectedImage = state.image,
): void {
  if (
    state.image !== expectedImage ||
    (state.state !== "active" && state.state !== "ready") ||
    state.hasActiveRollout ||
    state.health.failed !== 0 ||
    state.health.starting !== 0 ||
    state.health.scheduling !== 0 ||
    state.health.errorCount !== 0
  ) {
    throw new Error("platform_worker_release_container_not_ready");
  }
}

export function assertPlatformRestoreCandidate(
  state: PlatformContainerState,
  predecessor: PlatformContainerState,
  forwardImage: string,
): void {
  if (
    state.id !== predecessor.id ||
    state.name !== predecessor.name
  ) {
    throw new Error("platform_worker_restore_container_identity_changed");
  }
  if (
    !RUNNER_IMAGE.test(forwardImage) ||
    (state.image !== forwardImage && state.image !== predecessor.image)
  ) {
    throw new Error("platform_worker_restore_container_image_changed");
  }
}

async function waitForPlatformContainer(
  configPath: string,
  environment: PlatformEnvironment,
  expectedImage: string,
): Promise<PlatformContainerState> {
  return waitForPlatformContainerReadback(
    expectedImage,
    () => readPlatformContainer(configPath, environment),
  );
}

export async function waitForPlatformContainerReadback(
  expectedImage: string,
  read: () => Promise<PlatformContainerState>,
  wait: (milliseconds: number) => Promise<void> = Bun.sleep,
): Promise<PlatformContainerState> {
  for (let attempt = 1; attempt <= 36; attempt += 1) {
    try {
      const state = await read();
      assertPlatformContainerComplete(state, expectedImage);
      return state;
    } catch (error) {
      const retryable =
        error instanceof Error &&
        (error.message === "platform_worker_release_container_list_detail_mismatch" ||
          error.message === "platform_worker_release_container_not_ready");
      if (!retryable || attempt === 36) throw error;
      await wait(5_000);
    }
  }
  throw new Error("platform_worker_release_container_not_ready");
}

async function waitForExactServingVersion(
  config: string,
  expectedVersionId: string,
  predecessorVersionId: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const result = await requiredCommand([
      WRANGLER,
      "deployments",
      "status",
      "--config",
      config,
      "--json",
    ]);
    const current = parseServingVersion(result.stdout);
    if (current === expectedVersionId) return;
    if (current !== predecessorVersionId) {
      throw new Error("platform_worker_release_concurrent_version");
    }
    if (attempt < 8) await Bun.sleep(attempt * 1_000);
  }
  throw new Error("platform_worker_release_predecessor_unchanged");
}

async function verifyPublicReadback(
  environment: PlatformEnvironment,
  expectedVersionId: string,
): Promise<void> {
  const target = platformTargetForEnvironment(environment);
  for (const path of ["/", "/.well-known/takosumi"] as const) {
    let matched = false;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        const response = await fetch(`${target.origin}${path}`, {
          headers: { "cache-control": "no-cache" },
          redirect: "manual",
        });
        if (
          response.status === 200 &&
          response.headers.get("x-takosumi-version-id") === expectedVersionId
        ) {
          if (path === "/") matched = true;
          else
            matched = hasHostedDiscovery(
              (await response.json()) as unknown,
              target.origin,
            );
        }
        if (matched) break;
      } catch {
        // Readback retries only; the publication is never retried.
      }
      if (attempt < 8) await Bun.sleep(attempt * 1_000);
    }
    if (!matched)
      throw new Error("platform_worker_release_public_readback_invalid");
  }
}

function hasHostedDiscovery(value: unknown, origin: string): boolean {
  if (
    !record(value) ||
    !record(value.endpoints) ||
    !record(value.endpoints.extensions)
  ) {
    return false;
  }
  const extensions = value.endpoints.extensions;
  return (
    extensions["takosumi.account.subscription.v1"] ===
      `${origin}/api/v1/account/subscription` &&
    extensions["openai.chat-completions.v1"] === `${origin}/api/v1/ai`
  );
}

export function assertConfigTargetsSource(
  source: string,
  path: string,
  environment: PlatformEnvironment,
): void {
  const target = platformTargetForEnvironment(environment);
  const main = /^main\s*=\s*"([^"]+)"\s*$/mu.exec(source)?.[1];
  const assets = /^directory\s*=\s*"([^"]+)"\s*$/mu.exec(source)?.[1];
  const name = /^name\s*=\s*"([^"]+)"\s*$/mu.exec(source)?.[1];
  const configuredEnvironment =
    /^TAKOSUMI_ENVIRONMENT\s*=\s*"([^"]+)"\s*$/mu.exec(source)?.[1];
  const services = [
    ...source.matchAll(
      /\[\[services\]\]\s+binding\s*=\s*"([^"]+)"\s+service\s*=\s*"([^"]+)"/gmu,
    ),
  ];
  const hostedServices = services.filter((entry) => entry[1] === "HOSTED");
  let hostedRouteValid = false;
  let versionMetadataValid = false;
  let requestSignalEnabled = false;
  let publicOriginAnswerValid = false;
  let handlerKeysBound = false;
  try {
    const parsed = Bun.TOML.parse(source) as Record<string, unknown>;
    const compatibilityFlags = parsed.compatibility_flags;
    requestSignalEnabled =
      Array.isArray(compatibilityFlags) &&
      compatibilityFlags.some((flag) => flag === "enable_request_signal");
    const versionMetadata = parsed.version_metadata;
    versionMetadataValid =
      record(versionMetadata) &&
      versionMetadata.binding === "TAKOSUMI_VERSION_METADATA";
    const vars = parsed.vars as Record<string, unknown> | undefined;
    const descriptors = JSON.parse(
      String(vars?.TAKOSUMI_PLATFORM_EXTENSIONS),
    ) as unknown;
    if (Array.isArray(descriptors)) {
      const hosted = descriptors.filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>).handlerKey === "HOSTED",
      );
      hostedRouteValid =
        hosted.length === 2 &&
        hosted.some(matchesHostedSponsorshipRoute) &&
        hosted.some(matchesHostedAiRoute);
      // `capsulePublicOriginFromPlatformExtensions` throws when more than one
      // route answers the public-origin question, because a Capsule has one
      // public origin and array order is not an authority for splitting it. A
      // released Worker that throws there cannot plan any Capsule needing its
      // own origin, so the release refuses the composition instead.
      publicOriginAnswerValid =
        descriptors.filter((entry) => declaresPublicInputExchange(entry))
          .length === 1;
      // Every descriptor dispatches through a bound service. A handlerKey with
      // no `[[services]]` binding of that exact name is an unroutable route
      // that only fails on the first real request after the upload.
      const declaredBindings = new Set(services.map((entry) => entry[1]));
      handlerKeysBound = descriptors.every(
        (entry) =>
          record(entry) &&
          typeof entry.handlerKey === "string" &&
          declaredBindings.has(entry.handlerKey),
      );
    }
  } catch {
    hostedRouteValid = false;
    publicOriginAnswerValid = false;
    handlerKeysBound = false;
  }
  if (
    name !== target.workerName ||
    configuredEnvironment !== environment ||
    hostedServices.length !== 1 ||
    hostedServices[0]?.[2] !== target.hostedService ||
    !hostedRouteValid ||
    !publicOriginAnswerValid ||
    !handlerKeysBound ||
    !versionMetadataValid ||
    !requestSignalEnabled ||
    !main ||
    !assets ||
    resolve(dirname(path), main) !==
      resolve(ROOT, "deploy/platform/entry-worker.ts") ||
    resolve(dirname(path), assets) !== resolve(ROOT, "dashboard/dist")
  ) {
    throw new Error("platform_worker_release_config_source_invalid");
  }
}

/**
 * Whether a realized descriptor claims it can answer the Capsule public-origin
 * question. Mirrors `brokerAnswersPublicOrigin` in
 * `deploy/platform/platform_extension_provider_credentials.ts`: the declaration
 * is the presence of `publicInputExchangePath`, not the capability list.
 */
function declaresPublicInputExchange(value: unknown): boolean {
  if (!record(value)) return false;
  const broker = value.providerCredentialBroker;
  return record(broker) && typeof broker.publicInputExchangePath === "string";
}

function matchesHostedSponsorshipRoute(value: unknown): boolean {
  if (!record(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    JSON.stringify(keys) ===
      JSON.stringify(
        [
          "authDelivery",
          "basePath",
          "capabilities",
          "handlerKey",
          "id",
          "ownsPathSubtree",
          "contributions",
          "providerCredentialBroker",
          "requestScopeRules",
          "runCredential",
          "selfServicePatScopes",
          "workspaceContext",
        ].sort(),
      ) &&
    value.id === "takosumi-hosted-sponsorship" &&
    value.basePath === "/api/v1/account/subscription" &&
    value.handlerKey === "HOSTED" &&
    value.authDelivery === "context" &&
    value.ownsPathSubtree === true &&
    value.workspaceContext === "query-required" &&
    Array.isArray(value.selfServicePatScopes) &&
    value.selfServicePatScopes.length === 1 &&
    value.selfServicePatScopes[0] === "resources:read" &&
    matchesHostedInventoryScopeRules(value.requestScopeRules) &&
    Array.isArray(value.capabilities) &&
    JSON.stringify(value.capabilities) ===
      JSON.stringify([
        "takosumi.account.subscription.v1",
        "hosted-resource.inventory.v1",
      ]) &&
    matchesHostedInventoryContribution(value.contributions) &&
    matchesHostedRunCredential(value.runCredential) &&
    matchesHostedProviderCredentialBroker(value.providerCredentialBroker)
  );
}

function matchesHostedAiRoute(value: unknown): boolean {
  if (!record(value)) return false;
  return (
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(
        [
          "authDelivery",
          "basePath",
          "capabilities",
          "handlerKey",
          "id",
          "ownsPathSubtree",
          "requestScopeRules",
          "selfServicePatScopes",
          "workspaceContext",
        ].sort(),
      ) &&
    value.id === "takosumi-ai" &&
    value.basePath === "/api/v1/ai" &&
    value.handlerKey === "HOSTED" &&
    value.authDelivery === "context" &&
    value.ownsPathSubtree === true &&
    value.workspaceContext === "query-optional" &&
    JSON.stringify(value.selfServicePatScopes) ===
      JSON.stringify(["ai.models.read", "ai.chat"]) &&
    JSON.stringify(value.requestScopeRules) ===
      JSON.stringify([
        {
          path: "/models",
          methods: ["GET"],
          requiredScopes: ["ai.models.read"],
        },
        {
          path: "/chat/completions",
          methods: ["POST"],
          requiredScopes: ["ai.chat"],
        },
      ]) &&
    JSON.stringify(value.capabilities) ===
      JSON.stringify(["openai.models.v1", "openai.chat-completions.v1"])
  );
}

function matchesHostedInventoryScopeRules(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1 || !record(value[0])) {
    return false;
  }
  const rule = value[0];
  return (
    JSON.stringify(Object.keys(rule).sort()) ===
      JSON.stringify(["methods", "path", "requiredScopes"]) &&
    rule.path === "/resources" &&
    JSON.stringify(rule.methods) === JSON.stringify(["GET"]) &&
    JSON.stringify(rule.requiredScopes) === JSON.stringify(["resources:read"])
  );
}

function matchesHostedInventoryContribution(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1 || !record(value[0])) {
    return false;
  }
  const contribution = value[0];
  return (
    JSON.stringify(Object.keys(contribution).sort()) ===
      JSON.stringify(
        [
          "description",
          "descriptions",
          "href",
          "id",
          "label",
          "labels",
          "presentation",
          "slot",
        ].sort(),
      ) &&
    contribution.id === "takoserver-hosted-resources" &&
    contribution.slot === "workspace.hosted-resources" &&
    contribution.href === "/api/v1/account/subscription/resources" &&
    contribution.presentation === "native" &&
    contribution.label === "Hosted resources" &&
    contribution.description ===
      "Resources managed by Takoserver for this Workspace." &&
    record(contribution.labels) &&
    JSON.stringify(contribution.labels) ===
      JSON.stringify({ ja: "ホスト済みリソース" }) &&
    record(contribution.descriptions) &&
    JSON.stringify(contribution.descriptions) ===
      JSON.stringify({
        ja: "このワークスペースでTakoserverが管理するリソースです。",
      })
  );
}

function matchesHostedRunCredential(value: unknown): boolean {
  if (!record(value)) return false;
  return (
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(["audience", "requiredScopes"]) &&
    value.audience === "takosumi-hosted.takoform.v1" &&
    Array.isArray(value.requiredScopes) &&
    value.requiredScopes.length === 1 &&
    value.requiredScopes[0] === "takoform.run"
  );
}

/**
 * The realized sponsorship broker, pinned byte-for-byte.
 *
 * The three public-input/runtime-input fields are REQUIRED, not merely allowed.
 * `deploy/platform/platform_extension_provider_credentials.ts` learns a
 * Capsule's public origin only from a broker that declares
 * `publicInputExchangePath`, and `deploy/platform/platform_extensions.ts`
 * records that a broker without `runtimeInputs` cannot carry the Capsule's
 * runtime binding profile at all. A platform release without them ships a
 * Worker whose Capsules fail closed at plan, so the gate refuses it here rather
 * than after the irreversible upload.
 */
function matchesHostedProviderCredentialBroker(value: unknown): boolean {
  if (!record(value)) return false;
  return (
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(
        [
          "connectionId",
          "displayName",
          "envNames",
          "exchangePath",
          "providerSource",
          "publicInputCapabilities",
          "publicInputExchangePath",
          "recipeId",
          "runCredentialSettings",
          "runtimeInputs",
        ].sort(),
      ) &&
    value.publicInputExchangePath === "/public-inputs/http-endpoint" &&
    Array.isArray(value.publicInputCapabilities) &&
    JSON.stringify(value.publicInputCapabilities) ===
      JSON.stringify(["http_endpoint_url"]) &&
    matchesHostedRuntimeInputs(value.runtimeInputs) &&
    value.connectionId === "conn_takoserverTakoform01" &&
    value.recipeId === "takoserver-takoform-run-v1" &&
    value.providerSource === "registry.terraform.io/tako0614/takoform" &&
    value.displayName === "Takoserver" &&
    value.exchangePath === "/provider-credentials/takoform" &&
    record(value.runCredentialSettings) &&
    JSON.stringify(value.runCredentialSettings) ===
      JSON.stringify({ requiredAvailableMinor: 2300 }) &&
    Array.isArray(value.envNames) &&
    value.envNames.length === 3 &&
    value.envNames.every(
      (name) =>
        typeof name === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(name),
    ) &&
    new Set(value.envNames).size === value.envNames.length
  );
}

/**
 * The run-scoped sensitive-input protocol descriptor, pinned exactly.
 *
 * It is value-free by contract: it names only the two provider-block arguments
 * and the exact provider version floor at which they exist. Pinning it here
 * keeps the released platform's broker Connection and this repository's own
 * reference recipe catalog on one protocol; a drifted argument name would make
 * every runtime-input plan fail with `Unsupported argument` in production.
 */
function matchesHostedRuntimeInputs(value: unknown): boolean {
  if (!record(value)) return false;
  return (
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(
        [
          "contract",
          "mapArgument",
          "minimumProviderVersion",
          "nonceArgument",
        ].sort(),
      ) &&
    value.contract === "takosumi.provider-runtime-inputs/v1" &&
    value.nonceArgument === "runtime_input_nonce" &&
    value.mapArgument === "runtime_inputs" &&
    value.minimumProviderVersion === "4.0.0"
  );
}

export function remoteBranchContainsCommit(
  output: string,
  branch: string,
  commit: string,
): boolean {
  if (branch === "HEAD") return false;
  const expectedRef = `refs/heads/${branch}`;
  return output.split("\n").some((line) => {
    const fields = line.trim().split(/\s+/u);
    return fields.length === 2 && fields[0] === commit && fields[1] === expectedRef;
  });
}

/**
 * The shared `production-routine` lineage class, plus this surface's own
 * tightening.
 *
 * The shared predicate (scripts/lib/deploy-lineage.ts) is what control's
 * corpus is run against, and it closes the hole this function used to have:
 * it accepted ANY branch, so a production Worker release could be cut from a
 * feature branch that happened to be pushed. A surface may only tighten the
 * class it declares, and this one does: HEAD must be the EXACT freshly read
 * remote tip of its branch, not merely an ancestor of it.
 */
async function assertCleanAndPushed(): Promise<void> {
  const answer = await lineageVerdict("production-routine", { cwd: ROOT });
  if (answer.verdict !== "accept") {
    throw new Error(
      answer.reason === "dirty-worktree"
        ? "platform_worker_release_source_dirty"
        : "platform_worker_release_source_not_pushed",
    );
  }
  const commit = git(["rev-parse", "HEAD"]).trim();
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const remote = git([
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${branch}`,
  ]);
  if (!remoteBranchContainsCommit(remote, branch, commit)) {
    throw new Error("platform_worker_release_source_not_pushed");
  }
}

function assertReadableConfig(path: string): void {
  const status = lstatSync(path);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    realpathSync(path) !== path
  ) {
    throw new Error("platform_worker_release_config_invalid");
  }
}

function readStablePhysicalBytes(path: string, errorCode: string): Uint8Array {
  try {
    return readStablePhysicalAsset(path, {});
  } catch {
    throw new Error(errorCode);
  }
}

function assertPrivateFile(path: string): void {
  assertOutsideGitWorktree(path);
  const status = lstatSync(path);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    status.uid !== process.getuid?.() ||
    (status.mode & 0o777) !== 0o600 ||
    realpathSync(path) !== path
  ) {
    throw new Error("platform_worker_release_private_file_invalid");
  }
}

function assertExternalAbsent(path: string): void {
  if (insideRoot(path))
    throw new Error("platform_worker_release_output_must_be_external");
  assertOutsideGitWorktree(path);
  const parent = dirname(path);
  const status = lstatSync(parent);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.uid !== process.getuid?.() ||
    (status.mode & 0o077) !== 0 ||
    realpathSync(parent) !== parent
  ) {
    throw new Error("platform_worker_release_output_parent_invalid");
  }
  try {
    lstatSync(path);
    throw new Error("platform_worker_release_output_exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function assertOutsideGitWorktree(path: string): void {
  let cursor = dirname(resolve(path));
  for (;;) {
    try {
      lstatSync(join(cursor, ".git"));
      throw new Error("platform_worker_release_output_must_be_globally_external");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function writePrivate(path: string, bytes: Uint8Array): void {
  const descriptor = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new Error("platform_worker_release_private_file_invalid");
    }
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      !sameInodeIdentity(before, after) ||
      !samePhysicalIdentity(after, pathAfter)
    ) {
      throw new Error("platform_worker_release_private_file_invalid");
    }
  } finally {
    closeSync(descriptor);
  }
  const parent = openSync(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

async function requiredCommand(
  argv: readonly string[],
  stdin?: Uint8Array,
  cwd = ROOT,
  environment = childEnvironment(),
): Promise<CommandResult> {
  const child = Bun.spawn([...argv], {
    cwd,
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: environment,
  });
  if (stdin !== undefined) {
    if (!child.stdin)
      throw new Error("platform_worker_release_stdin_unavailable");
    child.stdin.write(stdin);
    child.stdin.end();
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, COMMAND_TIMEOUT_MS);
  const [exitCode, stdoutBuffer, stderrBuffer] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]).finally(() => clearTimeout(timer));
  const stdoutBytes = new Uint8Array(stdoutBuffer);
  const stderrBytes = new Uint8Array(stderrBuffer);
  if (
    stdoutBytes.byteLength > MAX_OUTPUT ||
    stderrBytes.byteLength > MAX_OUTPUT ||
    timedOut ||
    exitCode !== 0
  ) {
    throw platformCommandErrorFromBytes(
      argv,
      exitCode,
      timedOut,
      stdoutBytes,
      stderrBytes,
    );
  }
  return {
    exitCode,
    stdout: new TextDecoder("utf-8", { fatal: true }).decode(stdoutBytes),
    stderr: new TextDecoder("utf-8", { fatal: true }).decode(stderrBytes),
  };
}

class PlatformCommandError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number,
    readonly timedOut: boolean,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(
      timedOut
        ? `${command} timed out`
        : `${command} failed with exit ${exitCode}`,
    );
    this.name = "PlatformCommandError";
  }
}

/**
 * Build the bounded diagnostic used for a failed platform command.
 *
 * The release runner receives byte buffers from Bun, whose Response helpers
 * have returned both ArrayBuffer and Uint8Array across supported versions.
 * Keeping this seam byte-oriented makes that runtime variation observable in
 * tests without exposing the command runner itself.
 */
export function platformCommandFailureDiagnostic(
  argv: readonly string[],
  exitCode: number,
  timedOut: boolean,
  stdout: ArrayBuffer | Uint8Array,
  stderr: ArrayBuffer | Uint8Array,
): Readonly<{
  code: string;
  message: string;
  command: string | null;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> {
  return platformFailureDiagnostic(
    platformCommandErrorFromBytes(
      argv,
      exitCode,
      timedOut,
      normalizePlatformCommandBytes(stdout),
      normalizePlatformCommandBytes(stderr),
    ),
  );
}

function platformCommandErrorFromBytes(
  argv: readonly string[],
  exitCode: number,
  timedOut: boolean,
  stdoutBytes: Uint8Array,
  stderrBytes: Uint8Array,
): PlatformCommandError {
  return new PlatformCommandError(
    argv.slice(0, 4).join(" ").slice(0, 256),
    exitCode,
    timedOut,
    new TextDecoder("utf-8").decode(stdoutBytes.subarray(0, 2_048)),
    new TextDecoder("utf-8").decode(stderrBytes.subarray(0, 2_048)),
  );
}

function normalizePlatformCommandBytes(
  value: ArrayBuffer | Uint8Array,
): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function platformFailureDiagnostic(error: unknown): Readonly<{
  code: string;
  message: string;
  command: string | null;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> {
  const command = error instanceof PlatformCommandError ? error : null;
  return {
    code: error instanceof Error ? error.name : "UnknownError",
    message: boundedPlatformDiagnostic(
      error instanceof Error ? error.message : String(error),
    ),
    command: command?.command ?? null,
    exitCode: command?.exitCode ?? null,
    timedOut: command?.timedOut ?? false,
    stdout: boundedPlatformDiagnostic(command?.stdout ?? ""),
    stderr: boundedPlatformDiagnostic(command?.stderr ?? ""),
  };
}

function boundedPlatformDiagnostic(value: string): string {
  return value
    .replace(/\b(?:bearer|token|secret|password)\s*[=:]\s*\S+/giu, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_|sk_live_|AKIA)[0-9A-Za-z]{12,}/gu, "[REDACTED]")
    .slice(0, 2_048);
}

function git(args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnvironment(),
  });
  if (result.exitCode !== 0)
    throw new Error("platform_worker_release_git_failed");
  return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
}

function isAncestor(ancestor: string, descendant: string): boolean {
  const result = Bun.spawnSync(
    ["git", "merge-base", "--is-ancestor", ancestor, descendant],
    {
      cwd: ROOT,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: childEnvironment(),
    },
  );
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error("platform_worker_release_git_failed");
}

function childEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/root",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "true",
  };
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function absolute(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new Error("platform_worker_release_path_invalid");
  }
  return value;
}

function insideRoot(path: string): boolean {
  const child = relative(ROOT, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function insideDirectory(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileSystemError(
  value: unknown,
  code: string,
): value is NodeJS.ErrnoException {
  return (
    value instanceof Error &&
    "code" in value &&
    (value as NodeJS.ErrnoException).code === code
  );
}

function visit(
  value: unknown,
  callback: (entry: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
    return;
  }
  if (!record(value)) return;
  callback(value);
  for (const child of Object.values(value)) visit(child, callback);
}
