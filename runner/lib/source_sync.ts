// runner/lib/source_sync.ts
//
// Source sync (LANE M1): git clone/archive/subtree, deterministic zstd, source/dep-state restore handlers, source materialization.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type {
  JsonRecord,
  OpenTofuModuleSource,
  RunWorkspace,
  CommandContext,
  SourceSyncSource,
  SourceCredentialFile,
  SourceCredentials,
  SourceGitContext,
} from "./types.ts";
import {
  RUN_ROOT,
  CAPSULE_COMPATIBILITY_MAX_FILE_BYTES,
  DEFAULT_SOURCE_ARCHIVE_MAX_BYTES,
  SOURCE_CREDENTIAL_ENV_NAMES,
} from "./constants.ts";
import {
  isRecord,
  recordField,
  stringField,
  requiredStringField,
  digestBytes,
  assertDirectory,
  assertRealPathInsideSourceRoot,
  shredCredentialDir,
} from "./util.ts";
import { redactCredentialOutput } from "./redaction.ts";
import { runRequiredCommand, runCommand } from "./exec.ts";
import {
  assertSourceUrlPolicy,
  normalizeSourceSubtreePath,
  assertSafeArchiveObjectKey,
  assertSafeCredentialFileName,
  assertSafeCredentialFileMode,
  safeDepName,
  assertSafeZstdTarArchive,
  assertResolvedHostNotBlocked,
  assertSafeGitSelector,
} from "./policy.ts";
import {
  sourceCredentialRedactionValues,
  baseCommandEnv,
} from "./credentials.ts";
import { workspaceForRun, writeModuleInfo } from "./artifacts.ts";
import { RunnerPhaseTimer, withPhaseTimings } from "./timing.ts";
import {
  parseRunnerProfile,
  positiveIntegerLimitFromProfile,
} from "./parsing.ts";
import {
  parseRepositoryModulesSnapshot,
  TAKOSUMI_SOURCE_SNAPSHOT_MAX_MODULES,
  type RepositoryInstallMetadataSnapshot,
  type RepositoryManifestSnapshot,
  type RepositoryModulesInvalidReason,
  type RepositoryModulesSnapshot,
} from "../../contract/sources.ts";
import {
  parseRepositoryManifestText,
  TAKOSUMI_REPOSITORY_MANIFEST_MAX_BYTES,
  TAKOSUMI_REPOSITORY_MANIFEST_PATH,
} from "../../contract/repository-manifest.ts";
import {
  DEFAULT_OPENTOFU_CONFIGURATION_LIMITS,
  discoverOpenTofuModules,
  openTofuConfigurationFileKind,
  type OpenTofuSourceFile,
} from "../../lib/opentofu-configuration/src/mod.ts";

const REPOSITORY_INSTALL_METADATA_PATH = ".well-known/tcs.json";
const STABLE_TAG_DISCOVERY_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const STABLE_TAG_DISCOVERY_MAX_CANDIDATES = 10_000;
const REPOSITORY_MODULE_SCAN_MAX_DEPTH = 64;
const SOURCE_SNAPSHOT_UNSUPPORTED_TRACKED_SYMLINK =
  "source snapshot contains unsupported tracked symlink";
const SOURCE_SNAPSHOT_UNSUPPORTED_TRACKED_GITLINK =
  "source snapshot contains unsupported tracked gitlink";
const SOURCE_SNAPSHOT_TREE_METADATA_SCAN_FAILED =
  "source snapshot tree metadata scan failed";

/** Stable machine reason for a Git selector that resolved to no commit. */
export const SOURCE_REF_NOT_FOUND_CODE = "source_ref_not_found" as const;

/**
 * Typed source-sync failure emitted when Git returned no commit for the
 * requested selector. The message remains useful to the runner log boundary,
 * while adapters use {@link code} instead of parsing it.
 */
export class SourceRefNotFoundError extends Error {
  readonly code = SOURCE_REF_NOT_FOUND_CODE;

  constructor(readonly ref: string) {
    super(`source ref did not resolve to a commit: ${ref}`);
    this.name = "SourceRefNotFoundError";
  }
}

export async function ensureSourceAvailable(
  source: OpenTofuModuleSource,
  sourceRoot: string,
): Promise<void> {
  try {
    await assertDirectory(sourceRoot, "source root");
    if ((await readdir(sourceRoot)).length > 0) return;
  } catch {
    // Report the immutable transport requirement below.
  }
  throw new Error(
    "Git SourceSnapshot archive must be restored before OpenTofu execution",
  );
}

// ===========================================================================
// SOURCE SYNC (LANE M1)
//
// A source_sync job resolves a Git ref to a commit, makes a deterministic
// archive of `source.path`, uploads it to the DO (which persists to R2_SOURCE),
// and returns { resolvedCommit, archiveDigest, archiveSizeBytes }. Git
// credentials, when present, are minted by the Vault for the `source` phase and
// arrive as { env, files }. The runner writes credential files to a per-run temp
// dir with the given mode, uses them via GIT_ASKPASS / GIT_SSH_COMMAND, and
// shreds them afterward. Credentials are NEVER embedded in the URL and NEVER
// logged.
// ===========================================================================

export function isSourceSyncRequest(request: unknown): boolean {
  return stringField(request, "action") === "source_sync";
}

export function isStableSemverTagRequest(request: unknown): boolean {
  return stringField(request, "action") === "stable_semver_tag";
}

/**
 * Resolve the highest public stable SemVer Git tag without consulting a forge
 * API or a mutable default branch. Both `vX.Y.Z` and `X.Y.Z` are accepted, but
 * two tags that normalize to the same version are deliberately ambiguous.
 */
export async function runStableSemverTagResolution(
  runId: string,
  request: unknown,
): Promise<JsonRecord> {
  const url = requiredStringField(request, "url");
  assertSourceUrlPolicy(url);
  if (sourceUrlScheme(url) !== "https") {
    throw new Error("stable tag resolution requires a public HTTPS Git URL");
  }
  await assertResolvedHostNotBlocked(sourceUrlHost(url), "source URL host");
  const context: CommandContext = {
    env: { ...baseCommandEnv(), GIT_TERMINAL_PROMPT: "0" },
  };
  const result = await runCommand(["git", "ls-remote", "--tags", "--", url], {
    cwd: RUN_ROOT,
    context,
  });
  if (result.exitCode !== 0) {
    throw new Error("public Git tag discovery failed");
  }
  if (
    new TextEncoder().encode(result.stdout).byteLength >
    STABLE_TAG_DISCOVERY_MAX_OUTPUT_BYTES
  ) {
    throw new Error("public Git tag discovery output exceeds the safe limit");
  }
  const resolved = resolveHighestStableSemverTag(result.stdout);
  return {
    runId,
    action: "stable_semver_tag",
    status: "succeeded",
    exitCode: 0,
    ...resolved,
  };
}

export interface StableSemverTagResolution {
  readonly tag: string;
  readonly commit: string;
}

export function resolveHighestStableSemverTag(
  stdout: string,
): StableSemverTagResolution {
  const refs = new Map<string, { direct?: string; peeled?: string }>();
  for (const line of stdout.split(/\r?\n/u)) {
    const [rawCommit, rawRef] = line.trim().split(/\s+/u, 2);
    if (
      !rawCommit ||
      !rawRef ||
      !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/iu.test(rawCommit)
    ) {
      continue;
    }
    const match =
      /^refs\/tags\/(v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))(\^\{\})?$/u.exec(
        rawRef,
      );
    if (!match) continue;
    if (
      refs.size >= STABLE_TAG_DISCOVERY_MAX_CANDIDATES &&
      !refs.has(match[1]!)
    ) {
      throw new Error("repository has too many stable SemVer tags");
    }
    const tag = match[1]!;
    const current = refs.get(tag) ?? {};
    if (match[5]) current.peeled = rawCommit.toLowerCase();
    else current.direct = rawCommit.toLowerCase();
    refs.set(tag, current);
  }
  const candidates = [...refs.entries()].map(([tag, commits]) => {
    const match = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(
      tag,
    )!;
    return {
      tag,
      version: [
        BigInt(match[1]!),
        BigInt(match[2]!),
        BigInt(match[3]!),
      ] as const,
      commit: commits.peeled ?? commits.direct!,
    };
  });
  if (candidates.length === 0) {
    throw new Error("repository has no stable SemVer tag");
  }
  const normalized = new Map<string, string[]>();
  for (const candidate of candidates) {
    const key = candidate.version.join(".");
    const tags = normalized.get(key) ?? [];
    tags.push(candidate.tag);
    normalized.set(key, tags);
  }
  const ambiguous = [...normalized.entries()].find(
    ([, tags]) => tags.length > 1,
  );
  if (ambiguous) {
    throw new Error(
      `stable SemVer is ambiguous (${ambiguous[1].sort().join(", ")})`,
    );
  }
  candidates.sort((left, right) => compareSemver(right.version, left.version));
  const highest = candidates[0]!;
  return { tag: highest.tag, commit: highest.commit };
}

function compareSemver(
  left: readonly [bigint, bigint, bigint],
  right: readonly [bigint, bigint, bigint],
): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
}

export function parseSourceSyncSource(request: unknown): SourceSyncSource {
  const source = recordField(request, "source");
  if (!isRecord(source)) throw new Error("source_sync.source is required");
  const url = requiredStringField(source, "url");
  const ref = requiredStringField(source, "ref");
  // Defense in depth: re-check the URL policy locally (the service already
  // validated it). The rules are small and duplicated intentionally so a runner
  // never clones a forbidden scheme even if a malformed job reaches it.
  assertSourceUrlPolicy(url);
  assertSafeGitSelector(ref, "source_sync.source.ref");
  const rawPath = stringField(source, "path") ?? ".";
  const path = normalizeSourceSubtreePath(rawPath);
  return { url, ref, path };
}

export function parseSourceCredentials(request: unknown): SourceCredentials {
  const credentials = recordField(request, "credentials");
  if (!isRecord(credentials)) return { env: {}, files: [] };
  const env: Record<string, string> = {};
  const rawEnv = recordField(credentials, "env");
  if (isRecord(rawEnv)) {
    for (const [name, value] of Object.entries(rawEnv)) {
      if (typeof value === "string" && SOURCE_CREDENTIAL_ENV_NAMES.has(name)) {
        env[name] = value;
      }
    }
  }
  const files: SourceCredentialFile[] = [];
  const rawFiles = recordField(credentials, "files");
  if (Array.isArray(rawFiles)) {
    for (const entry of rawFiles) {
      if (!isRecord(entry)) continue;
      const path = stringField(entry, "path");
      const content = entry.content;
      const mode = entry.mode;
      if (
        typeof path !== "string" ||
        typeof content !== "string" ||
        typeof mode !== "number"
      ) {
        throw new Error("source_sync credential file is malformed");
      }
      assertSafeCredentialFileName(path);
      assertSafeCredentialFileMode(mode);
      files.push({ path, mode: Math.floor(mode), content });
    }
  }
  return { env, files };
}

interface ReusableSourceSnapshot {
  readonly id: string;
  readonly resolvedCommit: string;
  readonly archiveRef: string;
  readonly archiveDigest: string;
  readonly archiveSizeBytes: number;
}

function parseReusableSourceSnapshot(
  request: unknown,
): ReusableSourceSnapshot | undefined {
  const snapshot = recordField(request, "reuseSnapshot");
  if (!isRecord(snapshot)) return undefined;
  const id = requiredStringField(snapshot, "id");
  const resolvedCommit = requiredStringField(snapshot, "resolvedCommit");
  const archiveRef = requiredStringField(snapshot, "archiveRef");
  const archiveDigest = requiredStringField(snapshot, "archiveDigest");
  const archiveSizeBytes = snapshot.archiveSizeBytes;
  assertSafeArchiveObjectKey(archiveRef);
  if (!/^[0-9a-f]{7,64}$/iu.test(resolvedCommit)) {
    throw new Error(
      "reuseSnapshot.resolvedCommit must be a hex git object prefix",
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/iu.test(archiveDigest)) {
    throw new Error("reuseSnapshot.archiveDigest must be a sha256 digest");
  }
  if (
    typeof archiveSizeBytes !== "number" ||
    !Number.isSafeInteger(archiveSizeBytes) ||
    archiveSizeBytes <= 0
  ) {
    throw new Error(
      "reuseSnapshot.archiveSizeBytes must be a positive integer",
    );
  }
  return {
    id,
    resolvedCommit: resolvedCommit.toLowerCase(),
    archiveRef,
    archiveDigest: archiveDigest.toLowerCase(),
    archiveSizeBytes,
  };
}

export async function runSourceSync(
  runId: string,
  request: unknown,
): Promise<JsonRecord> {
  const source = parseSourceSyncSource(request);
  const credentials = parseSourceCredentials(request);
  const reuseSnapshot = parseReusableSourceSnapshot(request);
  const runnerProfile = parseRunnerProfile(request);
  const archiveRef = stringField(request, "archiveRef");
  if (!archiveRef) throw new Error("archiveRef is required");
  assertSafeArchiveObjectKey(archiveRef);
  const maxArchiveBytes =
    positiveIntegerLimitFromProfile(runnerProfile, "maxSourceArchiveBytes") ??
    DEFAULT_SOURCE_ARCHIVE_MAX_BYTES;

  const workspace = workspaceForRun(runId);
  await rm(workspace.root, { recursive: true, force: true });
  await mkdir(workspace.root, { recursive: true });
  const credentialDir = join(workspace.root, "source-credentials");
  const timer = new RunnerPhaseTimer();

  try {
    // SECURITY (SSRF): assertSourceUrlPolicy (run in parseSourceSyncSource) only
    // rejects IP *literals*. Before the credentialed git phase touches the
    // network, resolve the source host and reject if ANY resolved address is
    // private/loopback/link-local. This fails closed when the host cannot be
    // resolved.
    await timer.measure("source_host_policy", () =>
      assertResolvedHostNotBlocked(
        sourceUrlHost(source.url),
        "source URL host",
      ),
    );
    const gitContext = await timer.measure("source_git_credentials", () =>
      prepareSourceGitContext(source, credentials, credentialDir),
    );
    const resolvedCommit = await timer.measure("source_ref_resolve", () =>
      resolveSourceCommit(source, gitContext),
    );
    await timer.measure("source_clone", () =>
      shallowCloneAtCommit(
        source,
        resolvedCommit,
        workspace.sourceRoot,
        gitContext,
      ),
    );
    const repositoryInstallMetadata = await timer.measure(
      "source_repository_metadata",
      () => readRepositoryInstallMetadata(workspace.sourceRoot),
    );
    const repositoryManifest = await timer.measure(
      "source_repository_manifest",
      () => readRepositoryManifest(workspace.sourceRoot),
    );
    const subtree = await timer.measure("source_subtree", async () => {
      const resolvedSubtree = await resolveSourceSubtree(
        workspace.sourceRoot,
        source.path,
      );
      // The restore policy accepts only regular files and directories. Check
      // the immutable Git tree before either reusing an existing archive or
      // creating a new one so a successful source_sync can never publish an
      // archive that a later restore must reject.
      await assertTrackedSourceSnapshotArchiveable({
        repositoryRoot: workspace.sourceRoot,
        scopePath: source.path,
        git: gitContext,
      });
      return resolvedSubtree;
    });
    // Archive bytes may be reused for an exact commit, but module discovery is
    // a derived observation whose scanner semantics can change independently.
    // Until snapshots carry an explicit scanner-version identity, recompute it
    // from the freshly cloned tracked tree on every sync.
    const repositoryModules = await timer.measure(
      "source_repository_modules",
      () =>
        readRepositoryModules({
          repositoryRoot: workspace.sourceRoot,
          subtree,
          scopePath: source.path,
          git: gitContext,
        }),
    );
    if (reuseSnapshot?.resolvedCommit === resolvedCommit) {
      await timer.measure("source_snapshot_reuse", async () => undefined);
      return withPhaseTimings(
        {
          runId,
          action: "source_sync",
          status: "succeeded",
          exitCode: 0,
          resolvedCommit,
          archiveDigest: reuseSnapshot.archiveDigest,
          archiveSizeBytes: reuseSnapshot.archiveSizeBytes,
          repositoryInstallMetadata,
          repositoryManifest,
          repositoryModules,
          sourceArchive: {
            kind: "object-storage",
            ref: reuseSnapshot.archiveRef,
            digest: reuseSnapshot.archiveDigest,
            contentType: "application/zstd",
            sizeBytes: reuseSnapshot.archiveSizeBytes,
            reusedFromSnapshotId: reuseSnapshot.id,
          },
        },
        timer,
      );
    }
    const archivePath = sourceArchivePath(workspace);
    await timer.measure("source_archive", () =>
      createDeterministicArchive(subtree, archivePath, gitContext),
    );
    const archiveBytes = await timer.measure("source_archive_read", () =>
      readFile(archivePath),
    );
    if (archiveBytes.byteLength > maxArchiveBytes) {
      throw new Error(
        `source archive ${archiveBytes.byteLength} bytes exceeds limit ${maxArchiveBytes}`,
      );
    }
    const archiveDigest = await timer.measure("source_archive_digest", () =>
      digestBytes(archiveBytes),
    );
    // The archive is left at sourceArchivePath; the DO pulls it via
    // GET /runs/{runId}/artifacts/source-archive and persists to R2_SOURCE under
    // the host-allocated archiveRef (mirrors the tfplan pull-then-persist
    // protocol). The ref is echoed so the storage adapter knows where to write.
    return withPhaseTimings(
      {
        runId,
        action: "source_sync",
        status: "succeeded",
        exitCode: 0,
        resolvedCommit,
        archiveDigest,
        archiveSizeBytes: archiveBytes.byteLength,
        repositoryInstallMetadata,
        repositoryManifest,
        repositoryModules,
        sourceArchive: {
          kind: "runner-local",
          ref: archiveRef,
          digest: archiveDigest,
          contentType: "application/zstd",
          sizeBytes: archiveBytes.byteLength,
        },
      },
      timer,
    );
  } finally {
    await shredCredentialDir(credentialDir);
  }
}

/**
 * Observes repository-root presentation metadata without making it part of
 * the executable OpenTofu module archive. Symlinks and oversized documents are
 * recorded as invalid so an ordinary Git Source can still sync while a
 * Store-backed install fails closed with an actionable metadata error.
 */
export async function readRepositoryInstallMetadata(
  repositoryRoot: string,
): Promise<RepositoryInstallMetadataSnapshot> {
  const metadataPath = join(repositoryRoot, REPOSITORY_INSTALL_METADATA_PATH);
  try {
    const info = await lstat(metadataPath);
    if (!info.isFile()) {
      return { status: "invalid", reason: "not_regular_file" };
    }
    if (info.size > CAPSULE_COMPATIBILITY_MAX_FILE_BYTES) {
      return { status: "invalid", reason: "too_large" };
    }
    return { status: "present", text: await readFile(metadataPath, "utf8") };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { readonly code?: unknown }).code)
        : "";
    if (code === "ENOENT") return { status: "absent" };
    throw error;
  }
}

/**
 * Captures and validates the optional repository-owned general manifest.
 *
 * The document is observed before selecting the module subtree, from the exact
 * checked-out commit used for the archive. A bad optional document never turns
 * a Git Source into an alternate source or blocks source capture: its bounded
 * invalid status is persisted for the compatibility/compiler layer to report.
 * The current API version exposes only the install section to that compiler.
 */
export async function readRepositoryManifest(
  repositoryRoot: string,
): Promise<RepositoryManifestSnapshot> {
  const manifestPath = join(
    repositoryRoot,
    TAKOSUMI_REPOSITORY_MANIFEST_PATH,
  );
  try {
    const info = await lstat(manifestPath);
    if (!info.isFile()) {
      return { status: "invalid", reason: "not_regular_file" };
    }
    if (info.size > TAKOSUMI_REPOSITORY_MANIFEST_MAX_BYTES) {
      return { status: "invalid", reason: "too_large" };
    }
    const bytes = await readFile(manifestPath);
    const digest = await digestBytes(bytes);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { status: "invalid", reason: "invalid_utf8", digest };
    }
    const parsed = parseRepositoryManifestText(text);
    if (!parsed.ok) {
      return {
        status: "invalid",
        reason: "invalid_document",
        digest,
        diagnostic: parsed.error,
      };
    }
    return { status: "present", digest, document: parsed.document };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { readonly code?: unknown }).code)
        : "";
    if (code === "ENOENT") return { status: "absent" };
    throw error;
  }
}

class RepositoryModuleScanError extends Error {
  constructor(readonly reason: RepositoryModulesInvalidReason) {
    super(reason);
  }
}

/**
 * Build a bounded module index from tracked regular OpenTofu files in the
 * exact subtree that will be archived. This observation is advisory for the
 * chooser; compatibility still re-reads and compiles the selected module.
 */
export async function readRepositoryModules(input: {
  readonly repositoryRoot: string;
  readonly subtree: string;
  readonly scopePath: string;
  readonly git: SourceGitContext;
}): Promise<RepositoryModulesSnapshot> {
  try {
    const candidates = await trackedOpenTofuSourceFiles(input);
    const discovery = discoverOpenTofuModules({
      files: candidates,
      maxModules: TAKOSUMI_SOURCE_SNAPSHOT_MAX_MODULES,
    });
    if (!discovery.complete) {
      return {
        status: "invalid",
        scopePath: input.scopePath,
        reason: repositoryModuleDiscoveryReason(discovery.diagnostics),
      };
    }
    const parsed = parseRepositoryModulesSnapshot({
      status: "ready",
      scopePath: input.scopePath,
      modules: discovery.modules,
    });
    return parsed ?? {
      status: "invalid",
      scopePath: input.scopePath,
      reason: "configuration_invalid",
    };
  } catch (error) {
    return {
      status: "invalid",
      scopePath: input.scopePath,
      reason:
        error instanceof RepositoryModuleScanError
          ? error.reason
          : "scan_failed",
    };
  }
}

async function trackedOpenTofuSourceFiles(input: {
  readonly repositoryRoot: string;
  readonly subtree: string;
  readonly git: SourceGitContext;
}): Promise<readonly OpenTofuSourceFile[]> {
  const limits = DEFAULT_OPENTOFU_CONFIGURATION_LIMITS;
  const paths: Array<{
    readonly absolute: string;
    readonly repositoryRelative: string;
    readonly subtreeRelative: string;
    readonly size: number;
  }> = [];
  let totalBytes = 0;
  const tracked = await runCommand(
    [
      "git",
      "ls-files",
      "-z",
      "--",
      "*.tf",
      "*.tofu",
      "*.tf.json",
      "*.tofu.json",
    ],
    { cwd: input.repositoryRoot, context: input.git.context },
  );
  if (tracked.exitCode !== 0) {
    throw new RepositoryModuleScanError("scan_failed");
  }
  for (const repositoryRelative of tracked.stdout.split("\0")) {
    if (repositoryRelative.length === 0) continue;
    const absolute = resolve(input.repositoryRoot, repositoryRelative);
    const subtreeRelative = relative(input.subtree, absolute).replace(/\\/gu, "/");
    if (
      subtreeRelative === "" ||
      subtreeRelative === ".." ||
      subtreeRelative.startsWith("../")
    ) {
      continue;
    }
    if (subtreeRelative.split("/").length > REPOSITORY_MODULE_SCAN_MAX_DEPTH) {
      throw new RepositoryModuleScanError("file_limit_exceeded");
    }
    if (openTofuConfigurationFileKind(subtreeRelative) === undefined) continue;
    const info = await lstat(absolute);
    // Git may track a symlink or submodule path with a configuration suffix;
    // neither is an executable regular file in this immutable observation.
    if (!info.isFile()) continue;
    await assertRealPathInsideSourceRoot(
      absolute,
      input.subtree,
      "OpenTofu source file",
    );
    if (paths.length >= limits.maxFiles) {
      throw new RepositoryModuleScanError("file_limit_exceeded");
    }
    if (info.size > limits.maxFileBytes) {
      throw new RepositoryModuleScanError("file_too_large");
    }
    totalBytes += info.size;
    if (totalBytes > limits.maxTotalBytes) {
      throw new RepositoryModuleScanError("total_bytes_exceeded");
    }
    paths.push({
      absolute,
      repositoryRelative,
      subtreeRelative,
      size: info.size,
    });
  }
  paths.sort((left, right) =>
    left.subtreeRelative < right.subtreeRelative
      ? -1
      : left.subtreeRelative > right.subtreeRelative
        ? 1
        : 0,
  );
  const files: OpenTofuSourceFile[] = [];
  for (const path of paths) {
    const bytes = await readFile(path.absolute);
    if (bytes.byteLength !== path.size) {
      throw new RepositoryModuleScanError("scan_failed");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new RepositoryModuleScanError("configuration_invalid");
    }
    files.push({ path: path.subtreeRelative, text });
  }
  return files;
}

function repositoryModuleDiscoveryReason(
  diagnostics: readonly { readonly code: string }[],
): RepositoryModulesInvalidReason {
  const codes = new Set(diagnostics.map((diagnostic) => diagnostic.code));
  if (codes.has("file_limit_exceeded")) return "file_limit_exceeded";
  if (codes.has("file_too_large")) return "file_too_large";
  if (codes.has("total_bytes_exceeded")) return "total_bytes_exceeded";
  if (codes.has("module_candidate_limit_exceeded")) {
    return "module_limit_exceeded";
  }
  return "configuration_invalid";
}

// Writes any minted credential files to the per-run credential dir and builds
// the command env that wires git to use them WITHOUT ever putting a secret in
// the URL or process arg list. https token flow uses GIT_ASKPASS; ssh-key flow
// uses GIT_SSH_COMMAND with StrictHostKeyChecking=yes against the minted
// known_hosts (StrictHostKeyChecking=no is forbidden).
export async function prepareSourceGitContext(
  source: SourceSyncSource,
  credentials: SourceCredentials,
  credentialDir: string,
): Promise<SourceGitContext> {
  const env: Record<string, string> = {
    ...baseCommandEnv(),
    GIT_TERMINAL_PROMPT: "0",
    // Minted env (e.g. GIT_HTTPS_TOKEN, or a username) is threaded through but
    // is consumed by the askpass script, never written to the URL.
    ...credentials.env,
  };

  let wroteKeyFile = false;
  let keyFilePath = "";
  let knownHostsPath = "";
  let askpassPath = "";

  if (credentials.files.length > 0) {
    await mkdir(credentialDir, { recursive: true, mode: 0o700 });
    for (const file of credentials.files) {
      const target = join(credentialDir, file.path);
      await writeFile(target, file.content, { mode: file.mode });
      // writeFile honors umask on some platforms; force the requested mode.
      await chmod(target, file.mode);
      if (/known_hosts/i.test(file.path)) knownHostsPath = target;
      else if (/askpass/i.test(file.path)) askpassPath = target;
      else {
        keyFilePath = target;
        wroteKeyFile = true;
      }
    }
  }

  const scheme = sourceUrlScheme(source.url);
  if (scheme === "ssh") {
    // SECURITY INVARIANT: an ssh source ALWAYS requires a minted known_hosts
    // entry so host verification runs with StrictHostKeyChecking=yes. Without
    // it the job cannot verify the host and we fail closed rather than fall back
    // to a permissive default (StrictHostKeyChecking=no is forbidden). A key is
    // also required in practice; reject when neither is minted.
    if (!knownHostsPath) {
      throw new Error(
        wroteKeyFile
          ? "ssh source requires a known_hosts entry; StrictHostKeyChecking=no is forbidden"
          : "ssh source requires a minted ssh key and known_hosts (StrictHostKeyChecking=yes)",
      );
    }
    const sshParts = [
      "ssh",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${shellQuote(knownHostsPath)}`,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
    ];
    if (wroteKeyFile) {
      sshParts.push("-i", shellQuote(keyFilePath));
    }
    env.GIT_SSH_COMMAND = sshParts.join(" ");
  } else if (askpassPath) {
    // https token flow: GIT_ASKPASS points at the minted script which echoes
    // the token (and optional username). GIT_TERMINAL_PROMPT=0 ensures git never
    // falls back to an interactive prompt.
    await chmod(askpassPath, 0o500);
    env.GIT_ASKPASS = askpassPath;
  }

  return {
    context: {
      env,
      redactionValues: sourceCredentialRedactionValues(credentials),
    },
  };
}

export function sourceUrlScheme(url: string): "https" | "ssh" {
  const lower = url.toLowerCase();
  if (lower.startsWith("ssh://")) return "ssh";
  if (lower.startsWith("https://")) return "https";
  // scp-like git@host:path is ssh transport.
  if (/^[^@/\s]+@[^:/\s]+:.+$/.test(url) && !url.includes("://")) return "ssh";
  return "https";
}

// Extract the host from an already-policy-validated source URL (https://, ssh://,
// or scp-like git@host:path) so it can be DoH-resolved for SSRF validation. Uses
// the same parsing assertSourceUrlPolicy applies.
export function sourceUrlHost(url: string): string {
  const scpLike = /^([^@/\s]+)@([^:/\s]+):(.+)$/.exec(url);
  if (scpLike && !url.includes("://")) {
    return scpLike[2]!;
  }
  return new URL(url).hostname;
}

// Resolve the requested ref to a full commit sha. A full 40/64-hex ref is taken
// verbatim (it is a commit id already); otherwise ls-remote resolves the
// branch/tag. The ref is passed as a literal arg (never interpolated into a
// shell string) and is validated by assertSafeGitSelector. An omitted Source
// ref is persisted as Git's symbolic `HEAD`, so this function never guesses a
// provider- or convention-specific branch name.
export async function resolveSourceCommit(
  source: SourceSyncSource,
  git: SourceGitContext,
): Promise<string> {
  if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(source.ref)) {
    return source.ref.toLowerCase();
  }
  const result = await runCommand(
    ["git", "ls-remote", "--", source.url, source.ref, `${source.ref}^{}`],
    { cwd: RUN_ROOT, context: git.context },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-remote failed: ${redactCredentialOutput(result.stderr || result.stdout, git.context)}`,
    );
  }
  const commit = parseLsRemoteCommit(result.stdout, source.ref);
  if (!commit) throw new SourceRefNotFoundError(source.ref);
  return commit;
}

// Parse `git ls-remote` output ("<sha>\t<refname>") and pick the commit for the
// requested ref. Prefers an exact refs/heads|refs/tags match, then a peeled tag
// (^{}), then the bare ref, then a single-line fallback.
export function parseLsRemoteCommit(
  stdout: string,
  ref: string,
): string | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const rows = lines.flatMap((line) => {
    const [sha, name] = line.split(/\s+/, 2);
    if (!sha || !name || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(sha)) return [];
    return [{ sha: sha.toLowerCase(), name }];
  });
  if (rows.length === 0) return undefined;
  const candidates = [
    `refs/heads/${ref}`,
    `refs/tags/${ref}^{}`,
    `refs/tags/${ref}`,
    ref,
  ];
  for (const candidate of candidates) {
    const match = rows.find((row) => row.name === candidate);
    if (match) return match.sha;
  }
  // Annotated-tag peel: prefer the peeled object when both forms are present.
  const peeled = rows.find((row) => row.name.endsWith("^{}"));
  if (peeled) return peeled.sha;
  return rows.length === 1 ? rows[0]!.sha : undefined;
}

export async function shallowCloneAtCommit(
  source: SourceSyncSource,
  commit: string,
  sourceRoot: string,
  git: SourceGitContext,
): Promise<void> {
  await mkdir(sourceRoot, { recursive: true });
  await runRequiredCommand(["git", "init", "-q"], {
    cwd: sourceRoot,
    context: git.context,
  });
  await runRequiredCommand(
    ["git", "remote", "add", "origin", "--", source.url],
    { cwd: sourceRoot, context: git.context },
  );
  // Fetch exactly the resolved commit at depth 1. Server must allow fetching by
  // sha (uploadpack.allowReachableSHA1InWant / allowAnySHA1InWant); most hosts
  // (GitHub/GitLab) do. Fall back to a shallow fetch of the ref then checkout.
  const fetchSha = await runCommand(
    ["git", "fetch", "--depth", "1", "--no-tags", "origin", commit],
    { cwd: sourceRoot, context: git.context },
  );
  if (fetchSha.exitCode === 0) {
    await runRequiredCommand(["git", "checkout", "-q", "--detach", commit], {
      cwd: sourceRoot,
      context: git.context,
    });
    return;
  }
  const fetchRef = await runCommand(
    ["git", "fetch", "--depth", "1", "--no-tags", "origin", "--", source.ref],
    { cwd: sourceRoot, context: git.context },
  );
  if (fetchRef.exitCode !== 0) {
    throw new Error(
      `git fetch failed with ${fetchRef.exitCode}: ${redactCredentialOutput(
        fetchRef.stderr || fetchRef.stdout,
        git.context,
      )}`,
    );
  }
  await runRequiredCommand(["git", "checkout", "-q", "--detach", commit], {
    cwd: sourceRoot,
    context: git.context,
  });
}

export async function resolveSourceSubtree(
  sourceRoot: string,
  path: string,
): Promise<string> {
  const subtree = path === "." ? sourceRoot : resolve(sourceRoot, path);
  await assertDirectory(subtree, "source subtree");
  await assertRealPathInsideSourceRoot(subtree, sourceRoot, "source subtree");
  return subtree;
}

/**
 * Reject tracked symlink entries from the exact Git tree that backs a source
 * snapshot. Git records symlinks as mode 120000; checking tree metadata avoids
 * following a link or relying on the host filesystem's checkout behavior.
 * Diagnostics are intentionally fixed and path-free because tree paths can
 * contain repository-controlled or secret-looking values.
 */
export async function assertTrackedSourceSnapshotArchiveable(input: {
  readonly repositoryRoot: string;
  readonly scopePath: string;
  readonly git: SourceGitContext;
}): Promise<void> {
  // `:(literal)` prevents a repository path containing glob characters from
  // changing the Git pathspec. The normalized `.` scope still selects the
  // complete tree.
  const pathspec = `:(literal)${input.scopePath}`;
  const tree = await runCommand(
    [
      "git",
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      "HEAD",
      "--",
      pathspec,
    ],
    { cwd: input.repositoryRoot, context: input.git.context },
  );
  if (tree.exitCode !== 0) {
    throw new Error(SOURCE_SNAPSHOT_TREE_METADATA_SCAN_FAILED);
  }
  for (const record of tree.stdout.split("\0")) {
    if (record.length === 0) continue;
    const separator = record.indexOf("\t");
    if (separator <= 0) {
      throw new Error(SOURCE_SNAPSHOT_TREE_METADATA_SCAN_FAILED);
    }
    const metadata = record.slice(0, separator).split(/\s+/u);
    const mode = metadata[0];
    if (!mode || !/^\d{6}$/u.test(mode)) {
      throw new Error(SOURCE_SNAPSHOT_TREE_METADATA_SCAN_FAILED);
    }
    if (mode === "120000") {
      throw new Error(SOURCE_SNAPSHOT_UNSUPPORTED_TRACKED_SYMLINK);
    }
    if (mode === "160000") {
      throw new Error(SOURCE_SNAPSHOT_UNSUPPORTED_TRACKED_GITLINK);
    }
  }
}

/**
 * Keep the archive format aligned with the restore validator even when this
 * helper is called outside `runSourceSync`: a source archive may contain only
 * regular files and directories, never a symlink entry.
 */
async function assertArchiveTreeHasNoSymlinks(
  directory: string,
): Promise<void> {
  if ((await lstat(directory)).isSymbolicLink()) {
    throw new Error(SOURCE_SNAPSHOT_UNSUPPORTED_TRACKED_SYMLINK);
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // `.git` is excluded by the tar invocation and is not part of the source
    // snapshot payload. Do not inspect it or let its internal metadata affect
    // archive eligibility.
    if (entry.name === ".git") continue;
    if (entry.isSymbolicLink()) {
      throw new Error(SOURCE_SNAPSHOT_UNSUPPORTED_TRACKED_SYMLINK);
    }
    if (entry.isDirectory()) {
      await assertArchiveTreeHasNoSymlinks(join(directory, entry.name));
    }
  }
}

// Build a deterministic tar of the subtree (sorted entries, numeric owners,
// excluding .git) and compress with zstd. Determinism makes the digest stable
// across two runs of the same commit.
export async function createDeterministicArchive(
  subtree: string,
  archivePath: string,
  git: SourceGitContext,
): Promise<void> {
  await assertArchiveTreeHasNoSymlinks(subtree);
  await runRequiredCommand(
    [
      "tar",
      "--sort=name",
      "--numeric-owner",
      "--owner=0",
      "--group=0",
      "--mtime=@0",
      "--exclude=.git",
      "--format=gnu",
      "-C",
      subtree,
      "-cf",
      `${archivePath}.tar`,
      ".",
    ],
    { cwd: RUN_ROOT, context: git.context },
  );
  await runRequiredCommand(
    [
      "zstd",
      "-q",
      `-${sourceArchiveZstdLevel()}`,
      "-f",
      "-o",
      archivePath,
      `${archivePath}.tar`,
    ],
    { cwd: RUN_ROOT, context: git.context },
  );
  await rm(`${archivePath}.tar`, { force: true });
}

export function sourceArchiveZstdLevel(): number {
  const raw = Bun.env.TAKOSUMI_SOURCE_ARCHIVE_ZSTD_LEVEL;
  if (raw === undefined || raw.trim() === "") return 3;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= 1 && value <= 19) return value;
  return 3;
}

export function sourceArchivePath(workspace: RunWorkspace): string {
  return join(workspace.root, "source.tar.zst");
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Stores the uploaded source archive bytes under the run root so the DO can GET
// them; in practice the DO PUTs and immediately persists to R2, so this route is
// the relay seam. The bytes are kept until the next run wipes the workspace.
export async function handleSourceArchiveArtifactRequest(
  runId: string,
  request: Request,
): Promise<Response> {
  const workspace = workspaceForRun(runId);
  const archivePath = sourceArchivePath(workspace);
  if (request.method === "GET") {
    try {
      const bytes = await readFile(archivePath);
      return new Response(bytes, {
        headers: {
          "content-type": "application/zstd",
          "content-length": String(bytes.byteLength),
        },
      });
    } catch {
      return Response.json(
        { error: "source archive artifact not found" },
        { status: 404 },
      );
    }
  }
  if (request.method === "PUT") {
    await mkdir(workspace.root, { recursive: true });
    const bytes = new Uint8Array(await request.arrayBuffer());
    await writeFile(archivePath, bytes);
    return Response.json({
      runId,
      artifact: "source-archive",
      digest: await digestBytes(bytes),
      sizeBytes: bytes.byteLength,
    });
  }
  return Response.json(
    { error: "method not allowed" },
    { status: 405, headers: { allow: "GET, PUT" } },
  );
}

// M2 SOURCE-ARCHIVE RESTORE: the DO streams the snapshotted source archive
// (deterministic tar.zst produced by a prior source_sync) to this route. We
// write the bytes, list+validate the archive metadata with the SAME tar-slip
// hardening used for all SourceSnapshot archives, then extract into /work/source as the
// source tree for the generated-root and OpenTofu phases. The archive already
// contains the snapshot subtree (source_sync archived `source.path`), so it is
// extracted at the source root with no path remap.
export async function handleSourceArchiveRestoreRequest(
  runId: string,
  request: Request,
): Promise<Response> {
  if (request.method !== "PUT") {
    return Response.json(
      { error: "method not allowed" },
      { status: 405, headers: { allow: "PUT" } },
    );
  }
  const workspace = workspaceForRun(runId);
  try {
    await rm(workspace.root, { recursive: true, force: true });
    await mkdir(workspace.sourceRoot, { recursive: true });
    const bytes = new Uint8Array(await request.arrayBuffer());
    const archivePath = join(workspace.root, "restore-source.tar.zst");
    await writeFile(archivePath, bytes);
    const context: CommandContext = { env: baseCommandEnv() };
    await assertSafeZstdTarArchive(archivePath, context);
    await runRequiredCommand(
      [
        "tar",
        "-x",
        "--zstd",
        "-f",
        archivePath,
        "--no-same-owner",
        "--keep-old-files",
        "-C",
        workspace.sourceRoot,
      ],
      { cwd: RUN_ROOT, context },
    );
    await rm(archivePath, { force: true });
    // Record the source root as the state moduleDir default; a template/raw
    // dispatch overwrites module-info.json before plan, but this keeps the state
    // GET route resolvable if the dispatch omits it.
    await writeModuleInfo(workspace, workspace.sourceRoot);
    return Response.json({
      runId,
      artifact: "source-archive-restore",
      digest: await digestBytes(bytes),
      sizeBytes: bytes.byteLength,
    });
  } catch (error) {
    return Response.json(
      {
        error: "source archive restore failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

// remote_state DEPENDENCY STATE RESTORE (spec §15): the DO streams a decrypted
// producer tfstate to this route. We write the bytes READ-ONLY (0444) as
// <depsDir>/<name>.tfstate so the consumer's `terraform_remote_state` data
// sources can read it during init/plan/apply. The dep name is path-jailed to a
// single safe filename segment (no traversal, no separators) so the write stays
// inside the deps dir. Read-only blocks any accidental write-back to a producer's
// state (a remote_state read is one-directional).
export async function handleDepStateRestoreRequest(
  runId: string,
  name: string,
  request: Request,
): Promise<Response> {
  if (request.method !== "PUT") {
    return Response.json(
      { error: "method not allowed" },
      { status: 405, headers: { allow: "PUT" } },
    );
  }
  const workspace = workspaceForRun(runId);
  try {
    const safeName = safeDepName(name);
    const target = join(workspace.depsDir, `${safeName}.tfstate`);
    // Path-jail: the resolved target MUST stay inside the deps dir.
    const resolvedTarget = resolve(target);
    const resolvedDepsDir = resolve(workspace.depsDir);
    if (
      resolvedTarget !== join(resolvedDepsDir, `${safeName}.tfstate`) ||
      !resolvedTarget.startsWith(`${resolvedDepsDir}/`)
    ) {
      throw new Error(`dependency state name escapes deps dir: ${name}`);
    }
    await mkdir(workspace.depsDir, { recursive: true });
    const bytes = new Uint8Array(await request.arrayBuffer());
    // Remove any prior (read-only) file from a re-restore of the same dep name in
    // this run, then write + chmod 0444. writeFile honors umask on some
    // platforms, so force the read-only mode after the bytes land.
    await rm(target, { force: true });
    await writeFile(target, bytes);
    await chmod(target, 0o444);
    return Response.json({
      runId,
      artifact: "dep-state-restore",
      name: safeName,
      digest: await digestBytes(bytes),
      sizeBytes: bytes.byteLength,
    });
  } catch (error) {
    return Response.json(
      {
        error: "dependency state restore failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export async function gitRevParseHead(
  cwd: string,
  context: CommandContext,
): Promise<string | undefined> {
  const result = await runCommand(["git", "rev-parse", "HEAD"], {
    cwd,
    context,
  });
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}
