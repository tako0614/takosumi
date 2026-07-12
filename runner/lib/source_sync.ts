// runner/lib/source_sync.ts
//
// Source sync (LANE M1): git clone/archive/subtree, deterministic zstd, source/dep-state restore handlers, source materialization.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
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
  DEFAULT_PREPARED_SOURCE_MAX_BYTES,
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
import {
  readResponseBytesWithCap,
  runRequiredCommand,
  runCommand,
} from "./exec.ts";
import {
  assertSourceUrlPolicy,
  normalizeSourceSubtreePath,
  assertSafeArchiveObjectKey,
  assertSafeCredentialFileName,
  assertSafeCredentialFileMode,
  safeDepName,
  assertSafeZstdTarArchive,
  assertSafeTarArchive,
  assertHttpsSourceUrl,
  assertResolvedHostNotBlocked,
  assertSafeGitSelector,
  assertFullGitObjectId,
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
import type { RepositoryInstallMetadataSnapshot } from "takosumi-contract/sources";

const REPOSITORY_INSTALL_METADATA_PATH = ".well-known/tcs.json";

export async function ensureSourceAvailable(
  source: OpenTofuModuleSource,
  sourceRoot: string,
  context: CommandContext,
): Promise<void> {
  try {
    await assertDirectory(sourceRoot, "source root");
    if ((await readdir(sourceRoot)).length > 0) return;
  } catch {
    // Materialize below.
  }
  await rm(sourceRoot, { recursive: true, force: true });
  await materializeSource(source, sourceRoot, context);
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
  readonly archiveObjectKey: string;
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
  const archiveObjectKey = requiredStringField(snapshot, "archiveObjectKey");
  const archiveDigest = requiredStringField(snapshot, "archiveDigest");
  const archiveSizeBytes = snapshot.archiveSizeBytes;
  assertSafeArchiveObjectKey(archiveObjectKey);
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
    archiveObjectKey,
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
  // archiveObjectKey may sit at the request root or alongside source; accept
  // either so the service lane can place it wherever the run record holds it.
  const archiveObjectKey =
    stringField(request, "archiveObjectKey") ??
    stringField(recordField(request, "source"), "archiveObjectKey");
  if (!archiveObjectKey) throw new Error("archiveObjectKey is required");
  assertSafeArchiveObjectKey(archiveObjectKey);
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
    // network, resolve the source host (DoH) and reject if ANY resolved address
    // is private/loopback/link-local — the same DNS-rebinding protection the
    // plan/apply git path gets via assertHttpsSourceUrl. Fails closed when the
    // host cannot be resolved.
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
          sourceArchive: {
            kind: "object-storage",
            archiveObjectKey: reuseSnapshot.archiveObjectKey,
            digest: reuseSnapshot.archiveDigest,
            contentType: "application/zstd",
            sizeBytes: reuseSnapshot.archiveSizeBytes,
            reusedFromSnapshotId: reuseSnapshot.id,
          },
        },
        timer,
      );
    }
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
    const subtree = await timer.measure("source_subtree", () =>
      resolveSourceSubtree(workspace.sourceRoot, source.path),
    );
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
    // archiveObjectKey (mirrors the tfplan pull-then-persist protocol). The key
    // is echoed back so the DO knows where to write.
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
        sourceArchive: {
          kind: "runner-local",
          ref: `runner-local://${runId}/source-archive`,
          archiveObjectKey,
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

const IMPLICIT_DEFAULT_REF = "main";

// Resolve the requested ref to a full commit sha. A full 40/64-hex ref is taken
// verbatim (it is a commit id already); otherwise ls-remote resolves the
// branch/tag. The ref is passed as a literal arg (never interpolated into a
// shell string) and is validated by assertSafeGitSelector. When Takosumi's
// implicit default `main` does not exist, fall back to the remote default HEAD
// so older repositories with `master` still install without source metadata.
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
  if (!commit) {
    if (source.ref === IMPLICIT_DEFAULT_REF) {
      const head = await runCommand(
        ["git", "ls-remote", "--symref", "--", source.url, "HEAD"],
        { cwd: RUN_ROOT, context: git.context },
      );
      if (head.exitCode !== 0) {
        throw new Error(
          `git ls-remote HEAD fallback failed: ${redactCredentialOutput(
            head.stderr || head.stdout,
            git.context,
          )}`,
        );
      }
      const headCommit = parseLsRemoteCommit(head.stdout, "HEAD");
      if (headCommit) return headCommit;
    }
    throw new Error(`source ref did not resolve to a commit: ${source.ref}`);
  }
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
  if (fetchRef.exitCode !== 0 && source.ref === IMPLICIT_DEFAULT_REF) {
    const fetchHead = await runCommand(
      ["git", "fetch", "--depth", "1", "--no-tags", "origin", "--", "HEAD"],
      { cwd: sourceRoot, context: git.context },
    );
    if (fetchHead.exitCode !== 0) {
      throw new Error(
        `git fetch failed with ${fetchHead.exitCode}: ${redactCredentialOutput(
          fetchHead.stderr ||
            fetchHead.stdout ||
            fetchRef.stderr ||
            fetchRef.stdout,
          git.context,
        )}`,
      );
    }
  } else if (fetchRef.exitCode !== 0) {
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

// Build a deterministic tar of the subtree (sorted entries, numeric owners,
// excluding .git) and compress with zstd. Determinism makes the digest stable
// across two runs of the same commit.
export async function createDeterministicArchive(
  subtree: string,
  archivePath: string,
  git: SourceGitContext,
): Promise<void> {
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
// hardening used for prepared sources, then extract into /work/source as the
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

export async function materializeSource(
  source: OpenTofuModuleSource,
  sourceRoot: string,
  context: CommandContext,
): Promise<void> {
  switch (source.kind) {
    case "git":
      await assertHttpsSourceUrl(source.url, "git source url");
      if (source.ref) assertSafeGitSelector(source.ref, "git source ref");
      if (source.commit)
        assertFullGitObjectId(source.commit, "git source commit");
      await runRequiredCommand(["git", "clone", source.url, sourceRoot], {
        cwd: RUN_ROOT,
        context,
      });
      if (source.ref) {
        await runRequiredCommand(["git", "checkout", source.ref], {
          cwd: sourceRoot,
          context,
        });
      }
      if (source.commit) {
        await runRequiredCommand(["git", "checkout", source.commit], {
          cwd: sourceRoot,
          context,
        });
      }
      return;
    case "prepared": {
      await assertHttpsSourceUrl(source.url, "prepared source url");
      const response = await fetch(source.url, { redirect: "error" });
      if (!response.ok) {
        throw new Error(`prepared source fetch failed: ${response.status}`);
      }
      const bytes = await readResponseBytesWithCap(
        response,
        context.sourceArchiveMaxBytes ?? DEFAULT_PREPARED_SOURCE_MAX_BYTES,
        "prepared source archive",
      );
      const digest = await digestBytes(bytes);
      if (digest !== source.digest) {
        throw new Error(`prepared source digest mismatch: ${digest}`);
      }
      const archivePath = join(sourceRoot, "..", "source.tar.gz");
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(archivePath, bytes);
      await assertSafeTarArchive(archivePath, context);
      await runRequiredCommand(
        [
          "tar",
          "-x",
          "-z",
          "-f",
          archivePath,
          "--no-same-owner",
          "--keep-old-files",
          "-C",
          sourceRoot,
        ],
        { cwd: RUN_ROOT, context },
      );
      return;
    }
    case "local":
      await cp(source.path, sourceRoot, { recursive: true });
      return;
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
