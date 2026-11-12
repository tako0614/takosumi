import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SOURCE_ARCHIVE_MAX_BYTES, RUN_ROOT } from "../../runner/lib/constants.ts";
import { readResponseBytesWithCap, runCommand } from "../../runner/lib/exec.ts";
import { assertSafeZstdTarArchive, sourceArchiveEntryLimit } from "../../runner/lib/policy.ts";
import {
  assertTrackedSourceSnapshotArchiveable,
  createDeterministicArchive,
  handleSourceArchiveArtifactRequest,
  handleSourceArchiveRestoreRequest,
} from "../../runner/lib/source_sync.ts";
import type { CommandContext } from "../../runner/lib/types.ts";

const env = { PATH: Bun.env.PATH ?? "/usr/bin:/bin" };

async function fixture(run: (root: string, tree: string, archive: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "takosumi-source-limits-"));
  const tree = join(root, "tree");
  try {
    await mkdir(RUN_ROOT, { recursive: true });
    await mkdir(tree);
    await writeFile(join(tree, "one.txt"), "one\n");
    await writeFile(join(tree, "two.txt"), "two\n");
    await run(root, tree, join(root, "source.tar.zst"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("command metadata accepts its exact output budget", async () => {
  const result = await runCommand(["printf", "abc"], {
    cwd: tmpdir(), context: { env }, outputLimitBytes: 3,
  });
  expect(result).toEqual({ exitCode: 0, stdout: "abc", stderr: "" });
});

test("command metadata shares its budget across stdout and stderr and stops its child", async () => {
  let pid = 0;
  const result = await runCommand(["sh", "-c", "printf ab; printf cd >&2; sleep 30"], {
    cwd: tmpdir(), context: { env, timeoutMs: 1_000 }, outputLimitBytes: 3,
    onSpawn: child => { pid = child.pid; },
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("command output exceeds 3 bytes");
  expect(result.stdout).toBe("");
  expect(() => process.kill(pid, 0)).toThrow();
});

test("archive entry budget includes its root and accepts the exact boundary", async () => {
  expect(sourceArchiveEntryLimit({ env, sourceArchiveMaxEntries: 50_001 })).toBe(50_000);
  await fixture(async (_root, tree, archive) => {
    await createDeterministicArchive(tree, archive, { context: { env } });
    await assertSafeZstdTarArchive(archive, { env, sourceArchiveMaxEntries: 3 });
    await expect(assertSafeZstdTarArchive(archive, { env, sourceArchiveMaxEntries: 2 })).rejects.toThrow("entry limit");
  });
});

test("bounded archive body accepts its exact byte budget and cancels beyond a forged smaller length", async () => {
  expect(await readResponseBytesWithCap(new Response("abc"), 3, "source archive")).toEqual(new TextEncoder().encode("abc"));
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { reads += 1; controller.enqueue(new Uint8Array(2)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await expect(readResponseBytesWithCap(new Response(body, { headers: { "content-length": "1" } }), 3, "source archive")).rejects.toThrow("exceeds 3 bytes");
  expect(reads).toBe(2);
  expect(cancelled).toBe(true);
});

test("archive creation refuses one entry over budget before producing an archive", async () => {
  await fixture(async (_root, tree, archive) => {
    const context: CommandContext = { env, sourceArchiveMaxEntries: 2 };
    await expect(createDeterministicArchive(tree, archive, { context })).rejects.toThrow("entry limit");
    await expect(stat(archive)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${archive}.tar`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("archive entry budgets count nested empty directories and exclude Git metadata", async () => {
  await fixture(async (_root, tree, archive) => {
    await mkdir(join(tree, "nested", "empty"), { recursive: true });
    await mkdir(join(tree, ".git"));
    await writeFile(join(tree, ".git", "config"), "fixture metadata");
    const context: CommandContext = { env, sourceArchiveMaxEntries: 5 };
    await createDeterministicArchive(tree, archive, { context });
    await assertSafeZstdTarArchive(archive, context);
    await expect(assertSafeZstdTarArchive(archive, { env, sourceArchiveMaxEntries: 4 })).rejects.toThrow("entry limit");
    const refused = `${archive}.refused`;
    await expect(createDeterministicArchive(tree, refused, {
      context: { env, sourceArchiveMaxEntries: 4 },
    })).rejects.toThrow("entry limit");
    await expect(stat(refused)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("tracked source metadata refuses an over-budget tree before archive creation", async () => {
  await fixture(async (_root, tree) => {
    for (const args of [
      ["init", "-q"], ["add", "."],
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"],
    ]) {
      const result = await runCommand(["git", ...args], { cwd: tree, context: { env } });
      expect(result.exitCode).toBe(0);
    }
    await expect(assertTrackedSourceSnapshotArchiveable({
      repositoryRoot: tree, scopePath: ".", git: { context: { env, sourceArchiveMaxEntries: 2 } },
    })).rejects.toThrow("entry limit");
  });
});

test("generated archive compressed bytes are checked before publication", async () => {
  await fixture(async (_root, tree, archive) => {
    await expect(createDeterministicArchive(tree, archive, { context: { env } }, 1_024, 1)).rejects.toThrow("exceeds limit");
    await expect(stat(archive)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${archive}.tar`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function oversizedDeclaration() {
  let reads = 0;
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { reads += 1; controller.close(); },
    cancel() { cancellations += 1; },
  }, { highWaterMark: 0 });
  return {
    request: new Request("http://fixture.test", {
      method: "PUT", body,
      headers: { "content-length": String(DEFAULT_SOURCE_ARCHIVE_MAX_BYTES + 1) },
    }),
    counts: () => ({ reads, cancellations }),
  };
}

test("restore rejects an oversized declaration without reading or clearing its workspace", async () => {
  const id = `archive_limit_${crypto.randomUUID().replaceAll("-", "")}`;
  const root = join(RUN_ROOT, id);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "retained.txt"), "retained");
  try {
    const input = oversizedDeclaration();
    const response = await handleSourceArchiveRestoreRequest(id, input.request);
    expect(response.status).toBe(500);
    expect((await response.json() as { detail: string }).detail).toContain("cap is");
    expect(input.counts()).toEqual({ reads: 0, cancellations: 1 });
    expect(await readFile(join(root, "retained.txt"), "utf8")).toBe("retained");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("archive relay rejects an oversized declaration before writing", async () => {
  const id = `archive_limit_${crypto.randomUUID().replaceAll("-", "")}`;
  const root = join(RUN_ROOT, id);
  try {
    const input = oversizedDeclaration();
    await expect(handleSourceArchiveArtifactRequest(id, input.request)).rejects.toThrow("cap is");
    expect(input.counts()).toEqual({ reads: 0, cancellations: 1 });
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("restore metadata rejection preserves the existing workspace", async () => {
  const id = `archive_limit_${crypto.randomUUID().replaceAll("-", "")}`;
  const root = join(RUN_ROOT, id);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "retained.txt"), "retained");
  try {
    const response = await handleSourceArchiveRestoreRequest(id, new Request("http://fixture.test", {
      method: "PUT", body: "unrecognized fixture format",
    }));
    expect(response.status).toBe(500);
    expect((await response.json() as { detail: string }).detail).toContain("metadata list failed");
    expect(await readFile(join(root, "retained.txt"), "utf8")).toBe("retained");
  } finally { await rm(root, { recursive: true, force: true }); }
});
