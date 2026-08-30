import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  assertSafeArchiveObjectKey,
  assertSourceUrlPolicy,
  isSourceSyncRequest,
  parseLsRemoteCommit,
  parseSourceCredentials,
  parseSourceSyncSource,
} from "../../../runner/entrypoint.ts";
import { RUN_ROOT } from "../../../runner/lib/constants.ts";
import {
  resolveSourceCommit,
  assertTrackedSourceSnapshotArchiveable,
  createDeterministicArchive,
  readRepositoryInstallMetadata,
  readRepositoryManifest,
  readRepositoryModules,
  runSourceSync,
  shellQuote,
  shallowCloneAtCommit,
  SOURCE_REF_NOT_FOUND_CODE,
  SourceRefNotFoundError,
} from "../../../runner/lib/source_sync.ts";

const decoder = new TextDecoder();

function commandEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function git(cwd: string, args: readonly string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: commandEnv(),
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${decoder.decode(proc.stderr)}`,
    );
  }
  return decoder.decode(proc.stdout).trim();
}

// ---------------------------------------------------------------------------
// URL policy (spec 7.1) — defense-in-depth re-check inside the runner.
// ---------------------------------------------------------------------------

test("assertSourceUrlPolicy allows https, ssh, and git@host:path", () => {
  expect(() =>
    assertSourceUrlPolicy("https://github.com/octocat/Hello-World.git"),
  ).not.toThrow();
  expect(() =>
    assertSourceUrlPolicy("https://example.com/team/repo"),
  ).not.toThrow();
  expect(() =>
    assertSourceUrlPolicy("ssh://git@github.com/octocat/Hello-World.git"),
  ).not.toThrow();
  expect(() =>
    assertSourceUrlPolicy("git@github.com:octocat/Hello-World.git"),
  ).not.toThrow();
});

test("assertSourceUrlPolicy forbids file://, git://, ext::, and paths", () => {
  expect(() => assertSourceUrlPolicy("file:///etc/passwd")).toThrow();
  expect(() => assertSourceUrlPolicy("git://github.com/x/y.git")).toThrow();
  expect(() => assertSourceUrlPolicy("ext::sh -c whoami")).toThrow();
  expect(() => assertSourceUrlPolicy("/absolute/path")).toThrow();
  expect(() => assertSourceUrlPolicy("./relative/path")).toThrow();
  expect(() => assertSourceUrlPolicy("../escape")).toThrow();
});

test("assertSourceUrlPolicy forbids embedded credentials", () => {
  expect(() =>
    assertSourceUrlPolicy("https://user:pass@github.com/x/y.git"),
  ).toThrow();
  expect(() =>
    assertSourceUrlPolicy("https://token@github.com/x/y.git"),
  ).toThrow();
  // scp-like with a password-style user (user:pass@host:path) is rejected.
  expect(() =>
    assertSourceUrlPolicy("git:secret@github.com:x/y.git"),
  ).toThrow();
});

test("assertSourceUrlPolicy rejects control characters", () => {
  expect(() => assertSourceUrlPolicy("https://github.com/x/y\n.git")).toThrow();
});

test("assertSourceUrlPolicy rejects private and metadata hosts", () => {
  for (const raw of [
    "https://127.0.0.1/acme/repo.git",
    "https://10.0.0.5/acme/repo.git",
    "https://192.168.1.10/acme/repo.git",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/acme/repo.git",
    "https://[fc00::1]/acme/repo.git",
    "https://[fe80::1]/acme/repo.git",
    "https://[::ffff:169.254.169.254]/acme/repo.git",
    "https://localhost/acme/repo.git",
    "https://git.localhost/acme/repo.git",
    "ssh://git@127.0.0.1/acme/repo.git",
    "git@127.0.0.1:acme/repo.git",
  ]) {
    expect(() => assertSourceUrlPolicy(raw)).toThrow(
      "source url host is blocked",
    );
  }
});

// ---------------------------------------------------------------------------
// parseSourceSyncSource — ref + path validation.
// ---------------------------------------------------------------------------

test("parseSourceSyncSource normalizes the subtree path and defaults to '.'", () => {
  expect(
    parseSourceSyncSource({
      action: "source_sync",
      source: { url: "https://github.com/x/y.git", ref: "main" },
    }),
  ).toEqual({ url: "https://github.com/x/y.git", ref: "main", path: "." });

  expect(
    parseSourceSyncSource({
      source: {
        url: "https://github.com/x/y.git",
        ref: "v1.2.3",
        path: "./infra/",
      },
    }),
  ).toEqual({
    url: "https://github.com/x/y.git",
    ref: "v1.2.3",
    path: "infra",
  });
});

test("parseSourceSyncSource rejects traversal paths and dangerous refs", () => {
  expect(() =>
    parseSourceSyncSource({
      source: {
        url: "https://github.com/x/y.git",
        ref: "main",
        path: "../escape",
      },
    }),
  ).toThrow();
  expect(() =>
    parseSourceSyncSource({
      source: { url: "https://github.com/x/y.git", ref: "main", path: "/abs" },
    }),
  ).toThrow();
  expect(() =>
    parseSourceSyncSource({
      source: { url: "https://github.com/x/y.git", ref: "-flag-injection" },
    }),
  ).toThrow();
  expect(() =>
    parseSourceSyncSource({
      source: { url: "git://github.com/x/y.git", ref: "main" },
    }),
  ).toThrow();
});

test("isSourceSyncRequest only matches the source_sync action", () => {
  expect(isSourceSyncRequest({ action: "source_sync" })).toBe(true);
  expect(isSourceSyncRequest({ action: "plan" })).toBe(false);
  expect(isSourceSyncRequest({})).toBe(false);
  expect(isSourceSyncRequest(null)).toBe(false);
});

// ---------------------------------------------------------------------------
// parseLsRemoteCommit — ref resolution across branch/tag/peeled/sha forms.
// ---------------------------------------------------------------------------

test("parseLsRemoteCommit resolves an exact branch ref", () => {
  const out = parseLsRemoteCommit(
    "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d\trefs/heads/master\n",
    "master",
  );
  expect(out).toBe("7fd1a60b01f91b314f59955a4e4d4e80d8edf11d");
});

test("parseLsRemoteCommit prefers the peeled annotated tag object", () => {
  const stdout = [
    "1111111111111111111111111111111111111111\trefs/tags/v1.0.0",
    "2222222222222222222222222222222222222222\trefs/tags/v1.0.0^{}",
  ].join("\n");
  expect(parseLsRemoteCommit(stdout, "v1.0.0")).toBe(
    "2222222222222222222222222222222222222222",
  );
});

test("parseLsRemoteCommit falls back to a single-line result", () => {
  expect(
    parseLsRemoteCommit(
      "abcdef0123456789abcdef0123456789abcdef01\tHEAD\n",
      "HEAD",
    ),
  ).toBe("abcdef0123456789abcdef0123456789abcdef01");
});

test("parseLsRemoteCommit returns undefined when no commit matches", () => {
  expect(parseLsRemoteCommit("", "main")).toBeUndefined();
  expect(
    parseLsRemoteCommit("not-a-sha\trefs/heads/main\n", "main"),
  ).toBeUndefined();
});

test("resolveSourceCommit resolves an explicit remote HEAD without guessing main", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-source-sync-"));
  try {
    git(root, ["init", "-b", "master", "repo"]);
    const repo = join(root, "repo");
    await writeFile(join(repo, "main.tf"), "terraform {}\n");
    git(repo, ["add", "main.tf"]);
    git(repo, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Takosumi Test",
      "commit",
      "-m",
      "initial",
    ]);
    const expectedCommit = git(repo, ["rev-parse", "HEAD"]);
    const context = { env: commandEnv() };
    const source = { url: repo, ref: "HEAD", path: "." };

    await expect(resolveSourceCommit(source, { context })).resolves.toBe(
      expectedCommit,
    );

    const clone = join(root, "clone");
    await shallowCloneAtCommit(source, expectedCommit, clone, { context });
    expect(git(clone, ["rev-parse", "HEAD"])).toBe(expectedCommit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveSourceCommit keeps an explicit branch exact", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-source-sync-exact-"));
  try {
    git(root, ["init", "-b", "master", "repo"]);
    const repo = join(root, "repo");
    await writeFile(join(repo, "main.tf"), "terraform {}\n");
    git(repo, ["add", "main.tf"]);
    git(repo, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Takosumi Test",
      "commit",
      "-m",
      "initial",
    ]);

    await expect(
      resolveSourceCommit(
        { url: repo, ref: "main", path: "." },
        { context: { env: commandEnv() } },
      ),
    ).rejects.toThrow("source ref did not resolve to a commit: main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveSourceCommit bypasses remote lookup for an exact 40-character commit", async () => {
  const commit = "A".repeat(40);
  await expect(
    resolveSourceCommit(
      { url: "https://github.com/acme/repo.git", ref: commit, path: "." },
      { context: { env: commandEnv() } },
    ),
  ).resolves.toBe(commit.toLowerCase());
});

test("resolveSourceCommit reports an unresolved selector with a stable code", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-source-sync-missing-"));
  try {
    git(root, ["init", "-b", "main", "repo"]);
    const repo = join(root, "repo");
    await writeFile(join(repo, "main.tf"), "terraform {}\n");
    git(repo, ["add", "main.tf"]);
    git(repo, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Takosumi Test",
      "commit",
      "-m",
      "initial",
    ]);
    const expectedCommit = git(repo, ["rev-parse", "HEAD"]);
    const legalHexBranch = "b".repeat(41);
    git(repo, ["branch", legalHexBranch]);
    await expect(
      resolveSourceCommit(
        { url: repo, ref: legalHexBranch, path: "." },
        { context: { env: commandEnv() } },
      ),
    ).resolves.toBe(expectedCommit);

    const missingRef = "a".repeat(41);
    await expect(
      resolveSourceCommit(
        { url: repo, ref: missingRef, path: "." },
        { context: { env: commandEnv() } },
      ),
    ).rejects.toBeInstanceOf(SourceRefNotFoundError);
    try {
      await resolveSourceCommit(
        { url: repo, ref: missingRef, path: "." },
        { context: { env: commandEnv() } },
      );
    } catch (error) {
      expect(error).toMatchObject({
        code: SOURCE_REF_NOT_FOUND_CODE,
        ref: missingRef,
      });
      expect(error).toHaveProperty(
        "message",
        `source ref did not resolve to a commit: ${missingRef}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveSourceCommit peels an annotated tag to its commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-source-sync-tag-"));
  try {
    git(root, ["init", "-b", "main", "repo"]);
    const repo = join(root, "repo");
    await writeFile(join(repo, "main.tf"), "terraform {}\n");
    git(repo, ["add", "main.tf"]);
    git(repo, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Takosumi Test",
      "commit",
      "-m",
      "initial",
    ]);
    git(repo, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Takosumi Test",
      "tag",
      "-a",
      "v1.0.0",
      "-m",
      "release",
    ]);

    const expectedCommit = git(repo, ["rev-parse", "v1.0.0^{}"]);
    const tagObject = git(repo, ["rev-parse", "v1.0.0"]);
    expect(tagObject).not.toBe(expectedCommit);

    const source = { url: repo, ref: "v1.0.0", path: "." };
    await expect(
      resolveSourceCommit(source, { context: { env: commandEnv() } }),
    ).resolves.toBe(expectedCommit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// archive ref safety for the R2_SOURCE adapter layout.
// ---------------------------------------------------------------------------

test("assertSafeArchiveObjectKey accepts the agreed layout and rejects traversal", () => {
  expect(() =>
    assertSafeArchiveObjectKey(
      "workspaces/spc_1/sources/src_1/snapshots/snap_1/source.tar.zst",
    ),
  ).not.toThrow();
  expect(() => assertSafeArchiveObjectKey("/abs/key")).toThrow();
  expect(() =>
    assertSafeArchiveObjectKey("workspaces/../etc/passwd"),
  ).toThrow();
  expect(() => assertSafeArchiveObjectKey("other/prefix/key")).toThrow();
  expect(() => assertSafeArchiveObjectKey("")).toThrow();
});

// ---------------------------------------------------------------------------
// credential parsing — source credential allowlist + file path safety.
// ---------------------------------------------------------------------------

test("parseSourceCredentials admits only source env names and safe file paths", () => {
  const parsed = parseSourceCredentials({
    credentials: {
      env: {
        GIT_HTTPS_TOKEN: "tok",
        AWS_SECRET_ACCESS_KEY: "ignored-provider-secret",
        "lower-case": "ignored",
      },
      files: [
        { path: "askpass.sh", mode: 0o500, content: "#!/bin/sh\necho tok" },
        {
          path: "known_hosts",
          mode: 0o600,
          content: "github.com ssh-ed25519 AAA",
        },
      ],
    },
  });
  expect(parsed.env).toEqual({ GIT_HTTPS_TOKEN: "tok" });
  expect(parsed.files.map((f) => f.path).sort()).toEqual([
    "askpass.sh",
    "known_hosts",
  ]);
});

test("parseSourceCredentials rejects files with path separators or traversal", () => {
  expect(() =>
    parseSourceCredentials({
      credentials: { files: [{ path: "../key", mode: 0o600, content: "x" }] },
    }),
  ).toThrow();
  expect(() =>
    parseSourceCredentials({
      credentials: { files: [{ path: "sub/key", mode: 0o600, content: "x" }] },
    }),
  ).toThrow();
  expect(() =>
    parseSourceCredentials({
      credentials: { files: [{ path: "key", content: "x" }] },
    }),
  ).toThrow();
});

test("parseSourceCredentials rejects unsafe credential file modes", () => {
  expect(() =>
    parseSourceCredentials({
      credentials: { files: [{ path: "key", mode: 0o644, content: "x" }] },
    }),
  ).toThrow(/group\/world-readable/);
  expect(() =>
    parseSourceCredentials({
      credentials: { files: [{ path: "key", mode: 0o777, content: "x" }] },
    }),
  ).toThrow(/unsafe/);
  expect(() =>
    parseSourceCredentials({
      credentials: {
        files: [{ path: "key", mode: 0o600 + 0.5, content: "x" }],
      },
    }),
  ).toThrow(/unsafe/);
});

test("parseSourceCredentials returns empty for an absent credentials field", () => {
  expect(parseSourceCredentials({ action: "source_sync" })).toEqual({
    env: {},
    files: [],
  });
});

test("runSourceSync recomputes module discovery while reusing an unchanged archive", async () => {
  const runId = `source_reuse_${crypto.randomUUID().replace(/-/g, "")}`;
  const workspaceRoot = join(RUN_ROOT, runId);
  const fixtureRoot = await mkdtemp(join(tmpdir(), "takosumi-source-reuse-"));
  const previousPath = Bun.env.PATH;
  try {
    const repositoryRoot = join(fixtureRoot, "repo");
    git(fixtureRoot, ["init", "-b", "main", "repo"]);
    await mkdir(join(repositoryRoot, ".well-known"), { recursive: true });
    const repositoryInstallMetadata = JSON.stringify({
      schemaVersion: "tcs.repo/v1",
      modulePath: "deploy/opentofu",
    });
    const repositoryManifest = JSON.stringify({
      apiVersion: "takosumi.com/v1",
      kind: "Repository",
      install: { modules: { ".": { inputs: [] } } },
    });
    await writeFile(
      join(repositoryRoot, ".well-known", "tcs.json"),
      repositoryInstallMetadata,
    );
    await writeFile(
      join(repositoryRoot, ".well-known", "takosumi.json"),
      repositoryManifest,
    );
    await writeFile(join(repositoryRoot, "main.tf"), "terraform {}\n");
    git(repositoryRoot, ["add", "."]);
    git(repositoryRoot, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Takosumi Test",
      "commit",
      "-m",
      "initial",
    ]);
    const resolvedCommit = git(repositoryRoot, ["rev-parse", "HEAD"]);

    // Keep the source URL policy and runner clone path under test while
    // rewriting the public-looking URL to the local fixture for this test.
    const fakeBin = join(fixtureRoot, "bin");
    await mkdir(fakeBin, { recursive: true });
    const gitWrapper = join(fakeBin, "git");
    await writeFile(
      gitWrapper,
      [
        "#!/bin/sh",
        "set -eu",
        'if [ "$1" = "fetch" ]; then',
        `/usr/bin/git remote set-url origin ${shellQuote(repositoryRoot)}`,
        "fi",
        '/usr/bin/git "$@"',
        "",
      ].join("\n"),
    );
    await chmod(gitWrapper, 0o755);
    Bun.env.PATH = `${fakeBin}:${previousPath ?? ""}`;

    const result = await runSourceSync(runId, {
      action: "source_sync",
      source: {
        url: "https://github.com/acme/repo.git",
        ref: resolvedCommit,
        path: ".",
      },
      archiveRef:
        "workspaces/space_1/sources/src_new/snapshots/snap_new/source.tar.zst",
      reuseSnapshot: {
        id: "snap_prev",
        resolvedCommit,
        archiveRef:
          "workspaces/space_1/sources/src_prev/snapshots/snap_prev/source.tar.zst",
        archiveDigest: `sha256:${"b".repeat(64)}`,
        archiveSizeBytes: 2048,
        // This stale pre-scanner observation is intentionally ignored. The
        // current cloned tree is scanned again before the archive is reused.
        repositoryModules: {
          status: "ready",
          scopePath: ".",
          modules: [],
        },
      },
    });
    const sourceRoot = join(workspaceRoot, "source");

    expect(result).toMatchObject({
      runId,
      action: "source_sync",
      status: "succeeded",
      exitCode: 0,
      resolvedCommit,
      archiveDigest: `sha256:${"b".repeat(64)}`,
      archiveSizeBytes: 2048,
      repositoryModules: {
        status: "ready",
        scopePath: ".",
        modules: [
          {
            path: ".",
            providerPackages: [],
            rootProviderRequirements: [],
          },
        ],
      },
      sourceArchive: {
        kind: "object-storage",
        ref: "workspaces/space_1/sources/src_prev/snapshots/snap_prev/source.tar.zst",
        reusedFromSnapshotId: "snap_prev",
      },
      repositoryInstallMetadata: {
        status: "present",
        text: repositoryInstallMetadata,
      },
      repositoryManifest: {
        status: "present",
        document: {
          apiVersion: "takosumi.com/v1",
          kind: "Repository",
          install: { modules: { ".": { inputs: [] } } },
        },
      },
    });
    expect((result.repositoryManifest as { digest?: unknown }).digest).toEqual(
      expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    );
    expect(
      (result.phaseTimings as Array<{ phase: string }>).map(
        (timing) => timing.phase,
      ),
    ).toEqual([
      "source_host_policy",
      "source_git_credentials",
      "source_ref_resolve",
      "source_clone",
      "source_repository_metadata",
      "source_repository_manifest",
      "source_subtree",
      "source_repository_modules",
      "source_snapshot_reuse",
    ]);
    expect(git(sourceRoot, ["rev-parse", "HEAD"])).toBe(resolvedCommit);
    await expect(stat(join(workspaceRoot, "source.tar.zst"))).rejects.toThrow();
  } finally {
    if (previousPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = previousPath;
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("runSourceSync rejects a tracked symlink before archive creation or reuse", async () => {
  const runId = `source_symlink_${crypto.randomUUID().replace(/-/g, "")}`;
  const workspaceRoot = join(RUN_ROOT, runId);
  const fixtureRoot = await mkdtemp(join(tmpdir(), "takosumi-source-symlink-"));
  const previousPath = Bun.env.PATH;
  const secretTarget = "tracked symlink target must not enter diagnostics";
  try {
    const repositoryRoot = join(fixtureRoot, "repo");
    git(fixtureRoot, ["init", "-b", "main", "repo"]);
    await writeFile(join(repositoryRoot, "main.tf"), "terraform {}\n");
    await writeFile(join(repositoryRoot, "target.tf"), secretTarget);
    await symlink("target.tf", join(repositoryRoot, "tracked-link.tf"));
    git(repositoryRoot, ["add", "."]);
    git(repositoryRoot, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Takosumi Test",
      "commit",
      "-m",
      "initial",
    ]);
    const resolvedCommit = git(repositoryRoot, ["rev-parse", "HEAD"]);

    // Keep the source URL policy and runner clone path under test while
    // rewriting the public-looking URL to this local fixture.
    const fakeBin = join(fixtureRoot, "bin");
    await mkdir(fakeBin, { recursive: true });
    const gitWrapper = join(fakeBin, "git");
    await writeFile(
      gitWrapper,
      [
        "#!/bin/sh",
        "set -eu",
        'if [ "$1" = "fetch" ]; then',
        `/usr/bin/git remote set-url origin ${shellQuote(repositoryRoot)}`,
        "fi",
        '/usr/bin/git "$@"',
        "",
      ].join("\n"),
    );
    await chmod(gitWrapper, 0o755);
    Bun.env.PATH = `${fakeBin}:${previousPath ?? ""}`;

    const request = {
      action: "source_sync",
      source: {
        url: "https://github.com/acme/repo.git",
        ref: resolvedCommit,
        path: ".",
      },
      archiveRef:
        "workspaces/space_1/sources/src_new/snapshots/snap_new/source.tar.zst",
      // The rejection must also happen before an unchanged archive can be
      // reused; a legacy snapshot may predate this invariant.
      reuseSnapshot: {
        id: "snap_prev",
        resolvedCommit,
        archiveRef:
          "workspaces/space_1/sources/src_prev/snapshots/snap_prev/source.tar.zst",
        archiveDigest: `sha256:${"b".repeat(64)}`,
        archiveSizeBytes: 2048,
      },
    };

    let failure: unknown;
    try {
      await runSourceSync(runId, request);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const errorText = failure instanceof Error ? failure.message : String(failure);
    expect(errorText).toBe(
      "source snapshot contains unsupported tracked symlink",
    );
    await expect(stat(join(workspaceRoot, "source.tar.zst"))).rejects.toThrow();
    expect(errorText).not.toContain(secretTarget);
    expect(errorText).not.toContain("tracked-link.tf");
  } finally {
    if (previousPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = previousPath;
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("assertTrackedSourceSnapshotArchiveable rejects Git tree symlink metadata without path details", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-source-tree-link-"));
  try {
    git(root, ["init", "-b", "main"]);
    await writeFile(join(root, "target.tf"), "target contents");
    await symlink("target.tf", join(root, "link-with-secret.tf"));
    git(root, ["add", "."]);
    git(root, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Takosumi Test",
      "commit",
      "-m",
      "initial",
    ]);

    await expect(
      assertTrackedSourceSnapshotArchiveable({
        repositoryRoot: root,
        scopePath: ".",
        git: { context: { env: commandEnv() } },
      }),
    ).rejects.toThrow("source snapshot contains unsupported tracked symlink");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertTrackedSourceSnapshotArchiveable rejects a tracked gitlink before archive reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-source-tree-gitlink-"));
  try {
    const nested = join(root, "nested-module");
    await mkdir(nested, { recursive: true });
    git(nested, ["init", "-b", "main"]);
    await writeFile(join(nested, "main.tf"), "terraform {}\n");
    git(nested, ["add", "."]);
    git(nested, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Takosumi Test",
      "commit",
      "-m",
      "nested",
    ]);

    git(root, ["init", "-b", "main"]);
    git(root, ["add", "nested-module"]);
    git(root, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Takosumi Test",
      "commit",
      "-m",
      "initial",
    ]);

    await expect(
      assertTrackedSourceSnapshotArchiveable({
        repositoryRoot: root,
        scopePath: ".",
        git: { context: { env: commandEnv() } },
      }),
    ).rejects.toThrow("source snapshot contains unsupported tracked gitlink");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createDeterministicArchive rejects symlink entries and archives regular files", async () => {
  if (Bun.which("tar") === null || Bun.which("zstd") === null) return;
  const root = await mkdtemp(join(tmpdir(), "takosumi-source-archive-tree-"));
  try {
    const subtree = join(root, "src");
    await mkdir(join(subtree, "nested"), { recursive: true });
    await writeFile(join(subtree, "main.tf"), "terraform {}\n");
    await writeFile(join(subtree, "nested", "vars.tf"), "variable \"x\" {}\n");
    const regularArchive = join(root, "regular.tar.zst");
    await createDeterministicArchive(
      subtree,
      regularArchive,
      { context: { env: commandEnv() } },
    );
    expect((await stat(regularArchive)).isFile()).toBe(true);

    await symlink("main.tf", join(subtree, "tracked-link.tf"));
    const symlinkArchive = join(root, "symlink.tar.zst");
    await expect(
      createDeterministicArchive(
        subtree,
        symlinkArchive,
        { context: { env: commandEnv() } },
      ),
    ).rejects.toThrow("source snapshot contains unsupported tracked symlink");
    await expect(stat(symlinkArchive)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readRepositoryInstallMetadata captures repository-root metadata independently of a nested module", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-repo-metadata-"));
  try {
    await mkdir(join(root, ".well-known"), { recursive: true });
    await mkdir(join(root, "deploy", "opentofu"), { recursive: true });
    const text = JSON.stringify({
      schemaVersion: "tcs.repo/v1",
      modulePath: "deploy/opentofu",
    });
    await writeFile(join(root, ".well-known", "tcs.json"), text);

    await expect(readRepositoryInstallMetadata(root)).resolves.toEqual({
      status: "present",
      text,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readRepositoryInstallMetadata records an absent optional document", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-repo-metadata-"));
  try {
    await expect(readRepositoryInstallMetadata(root)).resolves.toEqual({
      status: "absent",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readRepositoryManifest captures a validated document and exact digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-repo-install-ux-"));
  try {
    await mkdir(join(root, ".well-known"), { recursive: true });
    const text = JSON.stringify({
      apiVersion: "takosumi.com/v1",
      kind: "Repository",
      install: { modules: { ".": { inputs: [] } } },
    });
    await writeFile(join(root, ".well-known", "takosumi.json"), text);

    const captured = await readRepositoryManifest(root);
    expect(captured).toMatchObject({
      status: "present",
      document: {
        apiVersion: "takosumi.com/v1",
        kind: "Repository",
        install: { modules: { ".": { inputs: [] } } },
      },
    });
    expect(captured.status === "present" ? captured.digest : "").toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readRepositoryManifest records absent, oversized, symlink, and invalid documents without adopting them", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-repo-install-ux-"));
  try {
    expect(await readRepositoryManifest(root)).toEqual({ status: "absent" });

    await mkdir(join(root, ".well-known"), { recursive: true });
    const path = join(root, ".well-known", "takosumi.json");
    await writeFile(path, "x".repeat(128 * 1024 + 1));
    expect(await readRepositoryManifest(root)).toEqual({
      status: "invalid",
      reason: "too_large",
    });

    await rm(path);
    await writeFile(join(root, "outside.json"), "{}");
    await symlink(join(root, "outside.json"), path);
    expect(await readRepositoryManifest(root)).toEqual({
      status: "invalid",
      reason: "not_regular_file",
    });

    await rm(path);
    await writeFile(
      path,
      '{"apiVersion":"takosumi.com/v1","kind":"Repository","install":{}}',
    );
    const invalid = await readRepositoryManifest(root);
    expect(invalid).toMatchObject({
      status: "invalid",
      reason: "invalid_document",
      diagnostic: "install.modules must be an object",
    });
    expect(invalid.status === "invalid" ? invalid.digest : "").toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readRepositoryModules indexes tracked real roots and exact provider tuples", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-module-index-"));
  try {
    git(root, ["init", "-b", "main"]);
    await mkdir(join(root, "modules", "child"), { recursive: true });
    await mkdir(join(root, "deploy", "takoform"), { recursive: true });
    await writeFile(
      join(root, "main.tf"),
      `module "child" { source = "./modules/child" }`,
    );
    await writeFile(
      join(root, "modules", "child", "providers.tf"),
      `terraform { required_providers { random = { source = "hashicorp/random" } } }`,
    );
    await writeFile(
      join(root, "deploy", "takoform", "providers.tf"),
      `terraform { required_providers { takoform = { source = "takos/takoform" } } }`,
    );
    git(root, ["add", "."]);
    await writeFile(
      join(root, "untracked.tf"),
      `terraform { required_providers { evil = { source = "attacker/evil" } } }`,
    );
    await mkdir(join(root, "untracked-noise"));
    await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        writeFile(
          join(root, "untracked-noise", `noise-${index}.tf`),
          `resource "evil_noise" "n${index}" {}`,
        )
      ),
    );

    const result = await readRepositoryModules({
      repositoryRoot: root,
      subtree: root,
      scopePath: ".",
      git: { context: { env: commandEnv() } },
    });

    expect(result).toEqual({
      status: "ready",
      scopePath: ".",
      modules: [
        {
          path: ".",
          providerPackages: [
            { source: "registry.opentofu.org/hashicorp/random" },
          ],
          // The root only reaches random through its child module; it does not
          // declare a root provider requirement of its own.
          rootProviderRequirements: [],
        },
        {
          path: "deploy/takoform",
          providerPackages: [
            { source: "registry.opentofu.org/takos/takoform" },
          ],
          rootProviderRequirements: [
            {
              source: "registry.opentofu.org/takos/takoform",
              moduleLocalName: "takoform",
            },
          ],
        },
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readRepositoryModules keeps Source scope separate from subtree-relative module paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-module-scope-"));
  try {
    git(root, ["init", "-b", "main"]);
    const subtree = join(root, "apps", "service");
    await mkdir(join(subtree, "worker"), { recursive: true });
    await writeFile(join(root, "main.tf"), `resource "root_only" "ignored" {}`);
    await writeFile(
      join(subtree, "main.tf"),
      `resource "aws_s3_bucket" "app" {}`,
    );
    await writeFile(
      join(subtree, "worker", "main.tf"),
      `resource "random_id" "worker" { byte_length = 8 }`,
    );
    git(root, ["add", "."]);

    const result = await readRepositoryModules({
      repositoryRoot: root,
      subtree,
      scopePath: "apps/service",
      git: { context: { env: commandEnv() } },
    });

    expect(result).toEqual({
      status: "ready",
      scopePath: "apps/service",
      modules: [
        {
          path: ".",
          providerPackages: [
            { source: "registry.opentofu.org/hashicorp/aws" },
          ],
          rootProviderRequirements: [{
            source: "registry.opentofu.org/hashicorp/aws",
            moduleLocalName: "aws",
          }],
        },
        {
          path: "worker",
          providerPackages: [
            { source: "registry.opentofu.org/hashicorp/random" },
          ],
          rootProviderRequirements: [{
            source: "registry.opentofu.org/hashicorp/random",
            moduleLocalName: "random",
          }],
        },
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
