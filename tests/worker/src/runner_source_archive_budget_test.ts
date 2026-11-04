import { expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SOURCE_ARCHIVE_MAX_DECOMPRESSED_BYTES, RUN_ROOT } from "../../../runner/lib/constants.ts";
import { createDeterministicArchive, handleSourceArchiveRestoreRequest, runSourceSync, shellQuote } from "../../../runner/lib/source_sync.ts";

const main = "terraform {}\n";
const payload = "x".repeat(4096);
const byteSize = Buffer.byteLength(main) + Buffer.byteLength(payload);
const archiveRef = "workspaces/test/sources/source/snapshots/snapshot/source.tar.zst";

async function repositoryFixture() {
  for (const tool of ["git", "tar", "zstd"]) {
    if (!Bun.which(tool)) throw new Error(`source archive test requires ${tool}`);
  }
  const root = await mkdtemp(join(tmpdir(), "takosumi-archive-budget-"));
  const repository = join(root, "repo");
  await mkdir(repository);
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["/usr/bin/git", ...args], { cwd: repository, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  git(["init", "-b", "main"]);
  await writeFile(join(repository, "main.tf"), main);
  await writeFile(join(repository, "payload.txt"), payload);
  git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
  const commit = git(["rev-parse", "HEAD"]);
  const bin = join(root, "bin");
  await mkdir(bin);
  // A literal public IP needs no DNS resolution. Every fetch is redirected to
  // this real local Git repository before Git runs; no remote Git is contacted.
  await writeFile(join(bin, "git"), [
    "#!/bin/sh", "set -eu",
    `if [ "$1" = fetch ]; then /usr/bin/git remote set-url origin ${shellQuote(repository)}; fi`,
    'exec /usr/bin/git "$@"', "",
  ].join("\n"));
  await chmod(join(bin, "git"), 0o755);
  const previousPath = Bun.env.PATH;
  Bun.env.PATH = `${bin}:${previousPath ?? "/usr/bin:/bin"}`;
  const runs: string[] = [];
  return {
    commit,
    runId() { const id = `archive_budget_${crypto.randomUUID().replaceAll("-", "")}`; runs.push(id); return id; },
    request(limit: number) {
      return {
        action: "source_sync", archiveRef,
        source: { url: "https://1.1.1.1/fixture.git", ref: commit, path: "." },
        runnerProfile: { resourceLimits: { maxSourceArchiveBytes: 1024, maxSourceDecompressedBytes: limit } },
      };
    },
    async close() {
      if (previousPath === undefined) delete Bun.env.PATH;
      else Bun.env.PATH = previousPath;
      for (const id of runs) await rm(join(RUN_ROOT, id), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const reuse of [false, true]) {
  test(`source_sync refuses over-budget expanded source before ${reuse ? "reusing" : "publishing"} its archive`, async () => {
    const f = await repositoryFixture();
    try {
      const runId = f.runId();
      const request = {
        ...f.request(1024),
        ...(reuse ? { reuseSnapshot: {
          id: "previous", resolvedCommit: f.commit, archiveRef,
          archiveDigest: `sha256:${"b".repeat(64)}`, archiveSizeBytes: 128,
        } } : {}),
      };
      await expect(runSourceSync(runId, request)).rejects.toThrow(/source snapshot.*(budget|limit|validation)/u);
      await expect(stat(join(RUN_ROOT, runId, "source.tar.zst"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(RUN_ROOT, runId, "source.tar.zst.tar"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await f.close(); }
  });
}

test("a source at the exact expanded budget is published, restored and reused", async () => {
  const f = await repositoryFixture();
  try {
    const runId = f.runId();
    const result = await runSourceSync(runId, f.request(byteSize));
    expect(result.status).toBe("succeeded");
    const bytes = await readFile(join(RUN_ROOT, runId, "source.tar.zst"));
    expect(bytes.length).toBeLessThan(1024);
    const restoredId = f.runId();
    const restored = await handleSourceArchiveRestoreRequest(restoredId, new Request("http://runner/source-archive/restore", { method: "PUT", body: bytes }));
    expect(restored.status).toBe(200);
    expect(await readFile(join(RUN_ROOT, restoredId, "source", "main.tf"), "utf8")).toBe(main);
    expect(await readFile(join(RUN_ROOT, restoredId, "source", "payload.txt"), "utf8")).toBe(payload);
    const reusedId = f.runId();
    const reused = await runSourceSync(reusedId, {
      ...f.request(byteSize), reuseSnapshot: {
        id: "previous", resolvedCommit: f.commit, archiveRef,
        archiveDigest: result.archiveDigest, archiveSizeBytes: result.archiveSizeBytes,
      },
    });
    expect(reused.sourceArchive).toMatchObject({ reusedFromSnapshotId: "previous", digest: result.archiveDigest });
    await expect(stat(join(RUN_ROOT, reusedId, "source.tar.zst"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.close(); }
});

test("a profile cannot raise the fixed restore ceiling even for highly compressible source", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-archive-ceiling-"));
  try {
    const subtree = join(root, "source");
    await mkdir(subtree);
    const largeFile = join(subtree, "large.txt");
    await writeFile(largeFile, "");
    // Sparse apparent bytes exercise the real filesystem bound without
    // allocating or compressing a half-gigabyte test payload.
    await truncate(largeFile, DEFAULT_SOURCE_ARCHIVE_MAX_DECOMPRESSED_BYTES + 1);
    const archive = join(root, "source.tar.zst");
    await expect(createDeterministicArchive(subtree, archive, { context: { env: { PATH: Bun.env.PATH! } } }, DEFAULT_SOURCE_ARCHIVE_MAX_DECOMPRESSED_BYTES * 2)).rejects.toThrow("source snapshot exceeds decompressed byte limit");
    await expect(stat(archive)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(archive + ".tar")).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("post-compression restore validation removes unsafe archives and tar intermediates", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-archive-hardlink-"));
  try {
    await mkdir(RUN_ROOT, { recursive: true });
    const subtree = join(root, "source");
    await mkdir(subtree);
    await writeFile(join(subtree, "private-source-name.tf"), main);
    await link(join(subtree, "private-source-name.tf"), join(subtree, "other.tf"));
    const archive = join(root, "source.tar.zst");
    await expect(createDeterministicArchive(subtree, archive, { context: { env: { PATH: Bun.env.PATH! } } })).rejects.toThrow("source snapshot archive failed restore safety validation");
    await expect(stat(archive)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(archive + ".tar")).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
