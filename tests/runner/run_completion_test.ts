import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ensureCustodyDirectory } from "../../runner/lib/run_completion.ts";

test("existing custody directories still sync both parent entries before use", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "takosumi-custody-sync-"));
  const runRoot = join(temporaryRoot, "runs");
  const custodyRoot = join(runRoot, ".mutation-custody");
  await mkdir(custodyRoot, { recursive: true, mode: 0o700 });
  const synced: string[] = [];

  try {
    expect(
      await ensureCustodyDirectory(true, runRoot, async (path) => {
        synced.push(path);
      }),
    ).toBe(true);

    expect(synced).toEqual([dirname(runRoot), runRoot]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("missing run-root parent is refused before recursive mkdir creates ancestors", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "takosumi-custody-parent-"));
  const missingParent = join(temporaryRoot, "missing-parent");
  const runRoot = join(missingParent, "runs");

  try {
    await expect(ensureCustodyDirectory(true, runRoot)).rejects.toThrow(
      "local mutation run root parent must already exist",
    );
    expect(await readdir(temporaryRoot)).toEqual([]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
