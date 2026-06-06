import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, test } from "bun:test";
import {
  assertSafeZstdTarArchive,
  type CommandContext,
} from "../../runner-image/entrypoint.ts";

// Real tar.zst extraction-safety proof. This exercises the SAME hardened
// validator the source-archive restore route runs before `tar -x --zstd`,
// against archives built with the SAME deterministic tar invocation source_sync
// uses. It needs `tar` + `zstd` on PATH; skip cleanly if unavailable.
const haveTools = Bun.which("tar") !== null && Bun.which("zstd") !== null;

// The validator lists the archive with `cwd: RUN_ROOT`; ensure that dir exists
// (in the real flow the restore handler creates the run workspace first).
const RUN_ROOT = Bun.env.TAKOSUMI_OPENTOFU_RUN_ROOT ?? "/tmp/takosumi-runs";
beforeAll(async () => {
  await mkdir(RUN_ROOT, { recursive: true });
});

const CONTEXT: CommandContext = {
  env: {
    PATH: Bun.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...(Bun.env.HOME ? { HOME: Bun.env.HOME } : {}),
  },
};

async function runIn(
  cwd: string,
  command: readonly string[],
): Promise<void> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(" ")} failed: ${stderr}`);
}

// Deterministic source archive, identical to createDeterministicArchive in the
// runner: sorted, numeric-owner, .git-excluded, gnu format, then zstd.
async function buildDeterministicArchive(
  subtree: string,
  out: string,
): Promise<void> {
  await runIn(subtree, [
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
    `${out}.tar`,
    ".",
  ]);
  await runIn(subtree, ["zstd", "-q", "-19", "-f", "-o", out, `${out}.tar`]);
}

test("assertSafeZstdTarArchive accepts a deterministic source archive with a ./ root", async () => {
  if (!haveTools) return;
  const dir = await mkdtemp(join(tmpdir(), "takosumi-zst-ok-"));
  try {
    const subtree = join(dir, "src");
    await runIn(dir, ["mkdir", "-p", join(subtree, "infra")]);
    await writeFile(join(subtree, "main.tf"), "terraform {}\n");
    await writeFile(join(subtree, "infra", "vars.tf"), "variable \"x\" {}\n");
    const archive = join(dir, "source.tar.zst");
    await buildDeterministicArchive(subtree, archive);
    // The deterministic archive carries a `./` root dir entry; the validator
    // must tolerate it and pass.
    await assertSafeZstdTarArchive(archive, CONTEXT);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("assertSafeZstdTarArchive rejects a tar.zst that escapes via ../", async () => {
  if (!haveTools) return;
  const dir = await mkdtemp(join(tmpdir(), "takosumi-zst-evil-"));
  try {
    // Build an archive whose entry name traverses out of the extraction root.
    const payload = join(dir, "evil.tf");
    await writeFile(payload, "x\n");
    const archive = join(dir, "evil.tar.zst");
    // -P preserves the leading path so the entry name literally contains ../.
    await runIn(dir, [
      "tar",
      "-P",
      "--format=gnu",
      "-cf",
      `${archive}.tar`,
      "--transform=s|evil.tf|../escape.tf|",
      "evil.tf",
    ]);
    await runIn(dir, ["zstd", "-q", "-f", "-o", archive, `${archive}.tar`]);
    await assert.rejects(() => assertSafeZstdTarArchive(archive, CONTEXT));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("assertSafeZstdTarArchive rejects a tar.zst containing a symlink entry", async () => {
  if (!haveTools) return;
  const dir = await mkdtemp(join(tmpdir(), "takosumi-zst-link-"));
  try {
    const subtree = join(dir, "src");
    await runIn(dir, ["mkdir", "-p", subtree]);
    await writeFile(join(subtree, "real.tf"), "x\n");
    // Add a symlink pointing outside; the validator forbids non file/dir types.
    await runIn(subtree, ["ln", "-s", "/etc/passwd", join(subtree, "link.tf")]);
    const archive = join(dir, "link.tar.zst");
    await runIn(subtree, [
      "tar",
      "--format=gnu",
      "-C",
      subtree,
      "-cf",
      `${archive}.tar`,
      ".",
    ]);
    await runIn(subtree, ["zstd", "-q", "-f", "-o", archive, `${archive}.tar`]);
    await assert.rejects(() => assertSafeZstdTarArchive(archive, CONTEXT));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
