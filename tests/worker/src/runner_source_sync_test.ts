import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
  readRepositoryInstallMetadata,
  runSourceSync,
  shallowCloneAtCommit,
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
    "https://metadata.google.internal/acme/repo.git",
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

test("resolveSourceCommit falls back from implicit main to remote HEAD", async () => {
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
    const source = { url: repo, ref: "main", path: "." };

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

// ---------------------------------------------------------------------------
// archive object key safety (R2_SOURCE key layout).
// ---------------------------------------------------------------------------

test("assertSafeArchiveObjectKey accepts the agreed layout and rejects traversal", () => {
  expect(() =>
    assertSafeArchiveObjectKey(
      "spaces/spc_1/sources/src_1/snapshots/snap_1/source.tar.zst",
    ),
  ).not.toThrow();
  expect(() => assertSafeArchiveObjectKey("/abs/key")).toThrow();
  expect(() => assertSafeArchiveObjectKey("spaces/../etc/passwd")).toThrow();
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

test("runSourceSync reuses an unchanged snapshot without cloning or archiving", async () => {
  const runId = `source_reuse_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, runId);
  const previousFetch = globalThis.fetch;
  const resolvedCommit = "0123456789abcdef0123456789abcdef01234567";
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ Answer: [{ type: 1, data: "140.82.112.3" }] }),
        { headers: { "content-type": "application/dns-json" } },
      )) as typeof fetch;

    const result = await runSourceSync(runId, {
      action: "source_sync",
      source: {
        url: "https://github.com/acme/repo.git",
        ref: resolvedCommit,
        path: ".",
      },
      archiveObjectKey:
        "spaces/space_1/sources/src_new/snapshots/snap_new/source.tar.zst",
      reuseSnapshot: {
        id: "snap_prev",
        resolvedCommit,
        archiveObjectKey:
          "spaces/space_1/sources/src_prev/snapshots/snap_prev/source.tar.zst",
        archiveDigest: `sha256:${"b".repeat(64)}`,
        archiveSizeBytes: 2048,
      },
    });

    expect(result).toMatchObject({
      runId,
      action: "source_sync",
      status: "succeeded",
      exitCode: 0,
      resolvedCommit,
      archiveDigest: `sha256:${"b".repeat(64)}`,
      archiveSizeBytes: 2048,
      sourceArchive: {
        kind: "object-storage",
        archiveObjectKey:
          "spaces/space_1/sources/src_prev/snapshots/snap_prev/source.tar.zst",
        reusedFromSnapshotId: "snap_prev",
      },
    });
    expect(
      (result.phaseTimings as Array<{ phase: string }>).map(
        (timing) => timing.phase,
      ),
    ).toEqual([
      "source_host_policy",
      "source_git_credentials",
      "source_ref_resolve",
      "source_snapshot_reuse",
    ]);
    await expect(stat(join(root, "source.tar.zst"))).rejects.toThrow();
    await expect(stat(join(root, "source"))).rejects.toThrow();
  } finally {
    globalThis.fetch = previousFetch;
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
