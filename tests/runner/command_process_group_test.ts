import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCommand } from "../../runner/lib/exec.ts";

// Every runner command runs in its own process group. A descendant inherits
// the output pipes, so a command whose descendants survived the direct child
// would keep the caller reading those pipes: its timeout, the run deadline and
// cancellation would stop nothing, and the descendant would outlive the run.

const PATH_ONLY = { PATH: Bun.env.PATH ?? "" };

test("a command's own timeout stops a shell whose foreground child holds the output pipes", async () => {
  const startedAt = performance.now();
  const result = await runCommand(["sh", "-c", "sleep 30; echo late"], {
    cwd: tmpdir(),
    context: { env: PATH_ONLY, timeoutMs: 300 },
  });
  const elapsed = performance.now() - startedAt;
  expect(result.exitCode).toBe(124);
  expect(result.stdout).not.toContain("late");
  expect(result.stderr).toContain("command timed out after 300ms");
  expect(elapsed).toBeLessThan(5_000);
});

test("cancellation stops a shell whose foreground child holds the output pipes", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const startedAt = performance.now();
  const result = await runCommand(["sh", "-c", "sleep 30; echo late"], {
    cwd: tmpdir(),
    context: { env: PATH_ONLY, signal: controller.signal },
  });
  const elapsed = performance.now() - startedAt;
  expect(result.exitCode).toBe(130);
  expect(result.stderr).toContain("command aborted");
  expect(elapsed).toBeLessThan(5_000);
});

test("a command returns at its direct exit and its background descendants do not outlive it", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-command-group-"));
  try {
    const startedAt = performance.now();
    const result = await runCommand(
      ["sh", "-c", `(sleep 4; : > '${join(root, "descendant.marker")}') & echo ok`],
      { cwd: root, context: { env: PATH_ONLY, timeoutMs: 60_000 } },
    );
    const elapsed = performance.now() - startedAt;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok\n");
    expect(elapsed).toBeLessThan(3_000);
    // The descendant was killed with the group, so it never writes its marker.
    await Bun.sleep(Math.max(0, 4_500 - elapsed));
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
