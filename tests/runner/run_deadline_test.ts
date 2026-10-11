import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleRunnerRequest, safeRunId } from "../../runner/entrypoint.ts";
import { RUN_ROOT } from "../../runner/lib/constants.ts";
import { runCommand } from "../../runner/lib/exec.ts";
import {
  parseRunBudgetMs,
  registerRunBudget,
  remainingRunBudgetMs,
  RUNNER_RUN_BUDGET_MS_HEADER,
} from "../../runner/lib/run_deadline.ts";
import { RUNNER_RUN_BUDGET_MS_HEADER as WORKER_RUNNER_RUN_BUDGET_MS_HEADER } from "../../worker/src/runner_protocol.ts";

test("the runner and its Durable Object name the same run budget header", () => {
  expect(RUNNER_RUN_BUDGET_MS_HEADER).toBe(WORKER_RUNNER_RUN_BUDGET_MS_HEADER);
});

test("only a plain non-negative integer is a run budget", () => {
  expect(parseRunBudgetMs("0")).toBe(0);
  expect(parseRunBudgetMs("659000")).toBe(659_000);
  for (const invalid of [null, "", "-1", "1.5", "1e3", " 10", "10ms", "0x10"]) {
    expect(parseRunBudgetMs(invalid)).toBeUndefined();
  }
  // Beyond a day is not a bound anyone forwards; treat it as absent.
  expect(parseRunBudgetMs(String(25 * 60 * 60 * 1000))).toBeUndefined();
});

test("a run budget is measured on the runner's own clock from registration", () => {
  const controller = new AbortController();
  expect(remainingRunBudgetMs(controller.signal)).toBeUndefined();
  registerRunBudget(controller.signal, "5000", 1_000);
  expect(remainingRunBudgetMs(controller.signal, 1_000)).toBe(5_000);
  expect(remainingRunBudgetMs(controller.signal, 5_500)).toBe(500);
  expect(remainingRunBudgetMs(controller.signal, 7_000)).toBe(-1_000);
  const unbounded = new AbortController();
  registerRunBudget(unbounded.signal, "not-a-budget", 1_000);
  expect(remainingRunBudgetMs(unbounded.signal, 9_999)).toBeUndefined();
});

test("the run deadline bounds a command tighter than its own profile timeout", async () => {
  const controller = new AbortController();
  registerRunBudget(controller.signal, "400");
  const startedAt = performance.now();
  const result = await runCommand(
    [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    {
      cwd: tmpdir(),
      context: {
        env: { PATH: Bun.env.PATH ?? "" },
        signal: controller.signal,
        timeoutMs: 60_000,
      },
      isolateProcessGroup: true,
    },
  );
  const elapsed = performance.now() - startedAt;
  expect(result.exitCode).toBe(124);
  expect(result.stderr).toContain("(run deadline)");
  expect(elapsed).toBeLessThan(5_000);
});

test("a command whose run deadline already passed never starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-run-deadline-"));
  const marker = join(root, "started");
  try {
    const controller = new AbortController();
    registerRunBudget(controller.signal, "0");
    const result = await runCommand(
      ["sh", "-c", `printf started > '${marker}'`],
      {
        cwd: root,
        context: { env: { PATH: Bun.env.PATH ?? "" }, signal: controller.signal },
      },
    );
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("run deadline reached before start");
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a timed-out command is interrupted before it is killed", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-run-interrupt-"));
  const marker = join(root, "interrupted");
  try {
    const startedAt = performance.now();
    const result = await runCommand(
      [
        process.execPath,
        "-e",
        `process.on("SIGINT", () => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "persisted"); process.exit(3); }); setInterval(() => {}, 1000);`,
      ],
      {
        cwd: root,
        context: { env: { PATH: Bun.env.PATH ?? "" }, timeoutMs: 2_000 },
        isolateProcessGroup: true,
      },
    );
    const elapsed = performance.now() - startedAt;
    // The interrupt lands inside the timeout (grace = a quarter of it here),
    // and the command's own exit status never turns it into anything else.
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("command timed out after 2000ms");
    expect(await readFile(marker, "utf8")).toBe("persisted");
    expect(elapsed).toBeLessThan(2_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a command that ignores the interrupt is still killed at its hard bound", async () => {
  const startedAt = performance.now();
  const result = await runCommand(
    [
      process.execPath,
      "-e",
      `process.on("SIGINT", () => {}); setInterval(() => {}, 1000);`,
    ],
    {
      cwd: tmpdir(),
      context: { env: { PATH: Bun.env.PATH ?? "" }, timeoutMs: 1_000 },
      isolateProcessGroup: true,
    },
  );
  const elapsed = performance.now() - startedAt;
  expect(result.exitCode).toBe(124);
  expect(result.stderr).toContain("command timed out after 1000ms");
  expect(elapsed).toBeGreaterThanOrEqual(950);
  expect(elapsed).toBeLessThan(4_000);
});

test("the runner applies the forwarded budget header to every command of the run", async () => {
  const runId = `run_deadline_release_${crypto.randomUUID().replaceAll("-", "")}`;
  const root = join(RUN_ROOT, safeRunId(runId));
  await mkdir(join(root, "source"), { recursive: true });
  try {
    const response = await handleRunnerRequest(
      new Request(`https://runner/runs/${encodeURIComponent(runId)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [RUNNER_RUN_BUDGET_MS_HEADER]: "500",
        },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          runId,
          action: "release",
          request: {
            release: {
              commands: [
                {
                  id: "slow-release",
                  command: [
                    process.execPath,
                    "-e",
                    "await new Promise((resolve) => setTimeout(resolve, 10000))",
                  ],
                  timeoutSeconds: 60,
                },
              ],
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      action: "release",
      status: "failed",
      failedCommandId: "slow-release",
    });
    expect(String(body.stderr)).toContain("(run deadline)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
