import { expect, test } from "bun:test";

import {
  type AuditAttemptResult,
  isTransientAuditFailure,
  runBunAudit,
} from "../../scripts/run-bun-audit.ts";

function result(
  overrides: Partial<AuditAttemptResult> = {},
): AuditAttemptResult {
  return {
    exitCode: 0,
    stdout: "{}\n",
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

test("classifies only failed transport outcomes as transient", () => {
  expect(
    isTransientAuditFailure(result({ exitCode: 1, stderr: "ConnectionClosed" })),
  ).toBe(true);
  expect(
    isTransientAuditFailure(result({ exitCode: 1, timedOut: true })),
  ).toBe(true);
  expect(
    isTransientAuditFailure(result({ exitCode: 0, timedOut: true })),
  ).toBe(true);
  expect(
    isTransientAuditFailure(
      result({ exitCode: 1, stdout: '{"vulnerabilities":{"high":1}}' }),
    ),
  ).toBe(false);
  expect(
    isTransientAuditFailure(result({ exitCode: 0, stderr: "network error" })),
  ).toBe(false);
});

test("returns a successful audit without retrying", async () => {
  let calls = 0;
  const stdout: string[] = [];
  const outcome = await runBunAudit({
    cwd: "/workspace",
    execute: async () => {
      calls += 1;
      return result();
    },
    sleep: async () => {
      throw new Error("success must not sleep");
    },
    writeStdout: (text) => stdout.push(text),
    writeStderr: () => undefined,
  });

  expect(outcome).toEqual({ exitCode: 0, attempts: 1 });
  expect(calls).toBe(1);
  expect(stdout).toEqual(["{}\n"]);
});

test("retries a transport failure with bounded backoff", async () => {
  const attempts = [
    result({ exitCode: 1, stderr: "Timeout: audit request failed\n" }),
    result({ exitCode: 0, stdout: '{"ok":true}\n' }),
  ];
  const delays: number[] = [];
  const stderr: string[] = [];

  const outcome = await runBunAudit({
    cwd: "/workspace",
    retryDelayMs: 25,
    execute: async () => attempts.shift()!,
    sleep: async (delay) => {
      delays.push(delay);
    },
    writeStdout: () => undefined,
    writeStderr: (text) => stderr.push(text),
  });

  expect(outcome).toEqual({ exitCode: 0, attempts: 2 });
  expect(delays).toEqual([25]);
  expect(stderr).toEqual([
    "bun audit transport failure; retrying attempt 2/3\n",
  ]);
});

test("never retries an authoritative vulnerability result", async () => {
  let calls = 0;
  const stdout: string[] = [];
  const outcome = await runBunAudit({
    cwd: "/workspace",
    execute: async () => {
      calls += 1;
      return result({
        exitCode: 1,
        stdout: '{"vulnerabilities":{"critical":1}}\n',
      });
    },
    sleep: async () => {
      throw new Error("a vulnerability must not retry");
    },
    writeStdout: (text) => stdout.push(text),
    writeStderr: () => undefined,
  });

  expect(outcome).toEqual({ exitCode: 1, attempts: 1 });
  expect(calls).toBe(1);
  expect(stdout).toEqual(['{"vulnerabilities":{"critical":1}}\n']);
});

test("exhausted timeouts fail with 124 and never become green", async () => {
  let calls = 0;
  const delays: number[] = [];
  const stderr: string[] = [];
  const outcome = await runBunAudit({
    cwd: "/workspace",
    maxAttempts: 3,
    timeoutMs: 10,
    retryDelayMs: 5,
    execute: async () => {
      calls += 1;
      return result({ exitCode: 143, stdout: "", timedOut: true });
    },
    sleep: async (delay) => {
      delays.push(delay);
    },
    writeStdout: () => undefined,
    writeStderr: (text) => stderr.push(text),
  });

  expect(outcome).toEqual({ exitCode: 124, attempts: 3 });
  expect(calls).toBe(3);
  expect(delays).toEqual([5, 10]);
  expect(stderr.at(-1)).toBe(
    "bun audit timed out after 10ms (attempt 3/3)\n",
  );
});

test("a child that exits zero after the deadline is still a timeout", async () => {
  const stderr: string[] = [];
  const outcome = await runBunAudit({
    cwd: "/workspace",
    maxAttempts: 1,
    timeoutMs: 10,
    execute: async () => result({ exitCode: 0, timedOut: true }),
    writeStdout: () => undefined,
    writeStderr: (text) => stderr.push(text),
  });

  expect(outcome).toEqual({ exitCode: 124, attempts: 1 });
  expect(stderr.at(-1)).toBe(
    "bun audit timed out after 10ms (attempt 1/1)\n",
  );
});

test("invalid retry bounds are rejected before execution", async () => {
  let calls = 0;
  expect(
    runBunAudit({
      cwd: "/workspace",
      maxAttempts: 0,
      execute: async () => {
        calls += 1;
        return result();
      },
    }),
  ).rejects.toThrow("maxAttempts must be a positive integer");
  expect(calls).toBe(0);
});
