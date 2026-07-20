import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import {
  parseDataOnlyTarMode,
  parseChecksums,
  parsePublisherIdentity,
  RetainedRoot,
} from "../../scripts/verify-takoform-published-package-host-proof.ts";

test("published package policy projects one exact protected workflow ref", () => {
  expect(
    parsePublisherIdentity(
      {
        format: "takoform.sigstore-publisher-policy@v1",
        oidcIssuer: "https://token.actions.githubusercontent.com",
        certificateIdentity:
          "https://github.com/tako0614/terraform-provider-takoform/.github/workflows/form-package-release.yml@refs/heads/main",
        bundleMediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      },
      "tako0614/terraform-provider-takoform",
    ),
  ).toEqual({
    oidcIssuer: "https://token.actions.githubusercontent.com",
    sourceRepository: "tako0614/terraform-provider-takoform",
    workflow: ".github/workflows/form-package-release.yml",
    refPattern: "refs/heads/main",
  });
});

test("published package policy rejects repository substitution", () => {
  expect(() =>
    parsePublisherIdentity(
      {
        format: "takoform.sigstore-publisher-policy@v1",
        oidcIssuer: "https://token.actions.githubusercontent.com",
        certificateIdentity:
          "https://github.com/attacker/provider/.github/workflows/release.yml@refs/heads/main",
        bundleMediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      },
      "tako0614/terraform-provider-takoform",
    ),
  ).toThrow("repository drifted");
});

test("SHA256SUMS parser is closed and duplicate-safe", () => {
  const digest = "a".repeat(64);
  expect(
    parseChecksums(`${digest}  release-manifest.json\n`).get(
      "release-manifest.json",
    ),
  ).toBe(digest);
  expect(() =>
    parseChecksums(
      `${digest}  release-manifest.json\n${digest}  release-manifest.json\n`,
    ),
  ).toThrow("duplicate");
  expect(() => parseChecksums(`${digest} *unsafe/path\n`)).toThrow("malformed");
});

test("retained tar modes are preserved while executable and special modes fail closed", () => {
  expect(parseDataOnlyTarMode("-rw-r--r--")).toBe(0o644);
  expect(parseDataOnlyTarMode("-r--------")).toBe(0o400);
  expect(() => parseDataOnlyTarMode("-rwxr-xr-x")).toThrow("executable");
  expect(() => parseDataOnlyTarMode("-rwSr--r--")).toThrow("special mode");
});

test("retained checkout boundary rejects commit, dirt, symlink, mode, path, and size drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-retained-root-test-"));
  const artifact = join(root, "artifact.json");
  try {
    await writeFile(artifact, '{"ok":true}', { mode: 0o644 });
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "test@example.invalid"]);
    await git(root, ["config", "user.name", "Takosumi test"]);
    await git(root, ["add", "artifact.json"]);
    await git(root, ["-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
    const commit = await git(root, ["rev-parse", "HEAD"]);
    const retained = await RetainedRoot.open(root);
    await retained.assertCleanCheckout(commit);
    expect(new TextDecoder().decode(await retained.read("artifact.json"))).toBe(
      '{"ok":true}',
    );
    await expect(retained.assertCleanCheckout("0".repeat(40))).rejects.toThrow(
      "commit mismatch",
    );

    await writeFile(artifact, '{"ok":false}');
    await expect(retained.assertCleanCheckout(commit)).rejects.toThrow("clean");
    await chmod(artifact, 0o664);
    await expect(retained.read("artifact.json")).rejects.toThrow(
      "private-write",
    );
    await chmod(artifact, 0o644);
    await writeFile(artifact, "");
    await expect(retained.read("artifact.json")).rejects.toThrow("bounded");
    await expect(retained.read("../escape.json")).rejects.toThrow("unsafe");

    const target = join(root, "target.json");
    await writeFile(target, '{"target":true}');
    await rm(artifact);
    await symlink(target, artifact);
    await expect(retained.read("artifact.json")).rejects.toThrow("symlink");
    const rootLink = `${root}-link`;
    await symlink(root, rootLink);
    try {
      await expect(RetainedRoot.open(rootLink)).rejects.toThrow(
        "real directory",
      );
    } finally {
      await rm(rootLink, { force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function git(root: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", root, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}
