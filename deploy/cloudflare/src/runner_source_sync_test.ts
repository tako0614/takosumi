import { expect, test } from "bun:test";
import {
  assertSafeArchiveObjectKey,
  assertSourceUrlPolicy,
  isSourceSyncRequest,
  parseLsRemoteCommit,
  parseSourceCredentials,
  parseSourceSyncSource,
} from "../runner/server.ts";

// ---------------------------------------------------------------------------
// URL policy (spec 7.1) — defense-in-depth re-check inside the runner.
// ---------------------------------------------------------------------------

test("assertSourceUrlPolicy allows https, ssh, and git@host:path", () => {
  expect(() => assertSourceUrlPolicy("https://github.com/octocat/Hello-World.git"))
    .not.toThrow();
  expect(() => assertSourceUrlPolicy("https://example.com/team/repo")).not.toThrow();
  expect(() => assertSourceUrlPolicy("ssh://git@github.com/octocat/Hello-World.git"))
    .not.toThrow();
  expect(() => assertSourceUrlPolicy("git@github.com:octocat/Hello-World.git"))
    .not.toThrow();
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
  expect(() => assertSourceUrlPolicy("https://user:pass@github.com/x/y.git"))
    .toThrow();
  expect(() => assertSourceUrlPolicy("https://token@github.com/x/y.git")).toThrow();
  // scp-like with a password-style user (user:pass@host:path) is rejected.
  expect(() => assertSourceUrlPolicy("git:secret@github.com:x/y.git")).toThrow();
});

test("assertSourceUrlPolicy rejects control characters", () => {
  expect(() => assertSourceUrlPolicy("https://github.com/x/y\n.git")).toThrow();
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
      source: { url: "https://github.com/x/y.git", ref: "v1.2.3", path: "./infra/" },
    }),
  ).toEqual({ url: "https://github.com/x/y.git", ref: "v1.2.3", path: "infra" });
});

test("parseSourceSyncSource rejects traversal paths and dangerous refs", () => {
  expect(() =>
    parseSourceSyncSource({
      source: { url: "https://github.com/x/y.git", ref: "main", path: "../escape" },
    })
  ).toThrow();
  expect(() =>
    parseSourceSyncSource({
      source: { url: "https://github.com/x/y.git", ref: "main", path: "/abs" },
    })
  ).toThrow();
  expect(() =>
    parseSourceSyncSource({
      source: { url: "https://github.com/x/y.git", ref: "-flag-injection" },
    })
  ).toThrow();
  expect(() =>
    parseSourceSyncSource({
      source: { url: "git://github.com/x/y.git", ref: "main" },
    })
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
    parseLsRemoteCommit("abcdef0123456789abcdef0123456789abcdef01\tHEAD\n", "HEAD"),
  ).toBe("abcdef0123456789abcdef0123456789abcdef01");
});

test("parseLsRemoteCommit returns undefined when no commit matches", () => {
  expect(parseLsRemoteCommit("", "main")).toBeUndefined();
  expect(parseLsRemoteCommit("not-a-sha\trefs/heads/main\n", "main"))
    .toBeUndefined();
});

// ---------------------------------------------------------------------------
// archive object key safety (R2_SOURCE key layout).
// ---------------------------------------------------------------------------

test("assertSafeArchiveObjectKey accepts the agreed layout and rejects traversal", () => {
  expect(() =>
    assertSafeArchiveObjectKey(
      "spaces/spc_1/sources/src_1/snapshots/snap_1/source.tar.zst",
    )
  ).not.toThrow();
  expect(() => assertSafeArchiveObjectKey("/abs/key")).toThrow();
  expect(() => assertSafeArchiveObjectKey("spaces/../etc/passwd")).toThrow();
  expect(() => assertSafeArchiveObjectKey("other/prefix/key")).toThrow();
  expect(() => assertSafeArchiveObjectKey("")).toThrow();
});

// ---------------------------------------------------------------------------
// credential parsing — env name shape + file path safety.
// ---------------------------------------------------------------------------

test("parseSourceCredentials admits only valid env names and safe file paths", () => {
  const parsed = parseSourceCredentials({
    credentials: {
      env: {
        GIT_HTTPS_TOKEN: "tok",
        "lower-case": "ignored",
      },
      files: [
        { path: "askpass.sh", mode: 0o500, content: "#!/bin/sh\necho tok" },
        { path: "known_hosts", mode: 0o600, content: "github.com ssh-ed25519 AAA" },
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
    })
  ).toThrow();
  expect(() =>
    parseSourceCredentials({
      credentials: { files: [{ path: "sub/key", mode: 0o600, content: "x" }] },
    })
  ).toThrow();
  expect(() =>
    parseSourceCredentials({
      credentials: { files: [{ path: "key", content: "x" }] },
    })
  ).toThrow();
});

test("parseSourceCredentials returns empty for an absent credentials field", () => {
  expect(parseSourceCredentials({ action: "source_sync" })).toEqual({
    env: {},
    files: [],
  });
});
