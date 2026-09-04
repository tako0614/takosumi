import { expect, test } from "bun:test";
import { resolve } from "node:path";

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
    isTransientAuditFailure(
      result({ exitCode: 1, stdout: "", stderr: "ConnectionClosed" }),
    ),
  ).toBe(true);
  expect(
    isTransientAuditFailure(
      result({ exitCode: 1, stdout: "", timedOut: true }),
    ),
  ).toBe(true);
  expect(
    isTransientAuditFailure(
      result({ exitCode: 0, stdout: "", timedOut: true }),
    ),
  ).toBe(true);
  expect(
    isTransientAuditFailure(
      result({ exitCode: 1, stdout: '{"vulnerabilities":{"high":1}}' }),
    ),
  ).toBe(false);
  expect(
    isTransientAuditFailure(
      result({
        exitCode: 1,
        stdout:
          '{"vulnerabilities":{"high":1},"advisory":"network error in package text"}',
      }),
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
    result({
      exitCode: 1,
      stdout: "",
      stderr: "Timeout: audit request failed\n",
    }),
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

test("never retries vulnerability JSON containing transport vocabulary", async () => {
  let calls = 0;
  const outcome = await runBunAudit({
    cwd: "/workspace",
    execute: async () => {
      calls += 1;
      if (calls === 1) {
        return result({
          exitCode: 1,
          stdout:
            '{"vulnerabilities":{"high":1},"advisory":"network error"}\n',
        });
      }
      return result();
    },
    sleep: async () => {
      throw new Error("authoritative JSON must not retry");
    },
    writeStdout: () => undefined,
    writeStderr: () => undefined,
  });

  expect(outcome).toEqual({ exitCode: 1, attempts: 1 });
  expect(calls).toBe(1);
});

test("never retries complete vulnerability JSON emitted before a timeout", async () => {
  let calls = 0;
  const outcome = await runBunAudit({
    cwd: "/workspace",
    execute: async () => {
      calls += 1;
      if (calls === 1) {
        return result({
          exitCode: 143,
          stdout: '{"vulnerabilities":{"high":1}}\n',
          timedOut: true,
        });
      }
      return result();
    },
    sleep: async () => {
      throw new Error("complete vulnerability JSON must not retry");
    },
    writeStdout: () => undefined,
    writeStderr: () => undefined,
  });

  expect(outcome).toEqual({ exitCode: 124, attempts: 1 });
  expect(calls).toBe(1);
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

test("keeps registry audits on dependency changes and scheduled cadence", async () => {
  const repositoryRoot = resolve(import.meta.dir, "../..");
  const qualityWorkflow = await Bun.file(
    resolve(repositoryRoot, ".github/workflows/quality.yml"),
  ).text();
  const dependencyWorkflow = await Bun.file(
    resolve(repositoryRoot, ".github/workflows/dependency-audit.yml"),
  ).text();

  expect(qualityWorkflow).toContain("bun run check");
  expect(qualityWorkflow).not.toContain("run-bun-audit.ts");
  expect(qualityWorkflow).not.toContain("npm audit");
  expect(qualityWorkflow).not.toContain("audit:public-sites");

  expect(dependencyWorkflow).toContain('cron: "17 3 * * *"');
  expect(dependencyWorkflow).not.toContain("\n    paths:");
  expect(dependencyWorkflow).toContain("fetch-depth: 0");
  expect(dependencyWorkflow).toContain("Determine dependency audit scope");
  expect(dependencyWorkflow).toContain(
    'git diff --name-only -z --no-renames "$range"',
  );
  expect(dependencyWorkflow).toContain(
    "package.json|bun.lock|package-lock.json|npm-shrinkwrap.json|bunfig.toml|.npmrc|*/package.json|*/bun.lock|*/package-lock.json|*/npm-shrinkwrap.json|*/bunfig.toml|*/.npmrc|scripts/run-bun-audit.ts|.github/workflows/dependency-audit.yml",
  );
  expect(
    dependencyWorkflow.match(
      /if: steps\.scope\.outputs\.required == 'true'/gu,
    )?.length,
  ).toBe(6);
  expect(dependencyWorkflow).toContain("workflow_dispatch:");
  expect(dependencyWorkflow).toContain("bun scripts/run-bun-audit.ts\n");
  expect(dependencyWorkflow).toContain(
    "bun scripts/run-bun-audit.ts --cwd dashboard",
  );
  expect(dependencyWorkflow).toContain(
    "npm audit --prefix docs --audit-level=moderate",
  );
  expect(dependencyWorkflow).toContain(
    "npm audit --prefix website --audit-level=moderate",
  );
});
