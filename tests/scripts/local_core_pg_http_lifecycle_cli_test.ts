import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";

import {
  assertNoAdditionalRunnerDispatches,
  boundedRunnerFetch,
  reopenCoreRuntimeAfterRestart,
  runAndEmitAfterCleanup,
  type RunnerHttpProofEventPhase,
  type RunnerHttpProofLabel,
} from "../proofs/local-core-http-lifecycle.ts";
import { parsePgHttpProofArgs } from "../proofs/local-core-pg-http-lifecycle.ts";
import {
  createNativePostgresRestartContainer,
} from "../helpers/deploy-control/native_postgres_restart.ts";
import {
  formatNativePostgresProofFailure,
  formatCoreHttpLifecycleFailure,
  formatNativePostgresLifecycleFailure,
  NativePostgresCoreHttpFailure,
  recordRunnerHttpProofEvent,
  runWithNativePostgresCleanup,
  type RunnerHttpProofTrace,
} from "../proofs/local-core-pg-http-lifecycle.ts";

const IMAGE = `sha256:${"a".repeat(64)}`;

test("native PostgreSQL plus HTTP proof requires explicit opt-in and immutable runner image", () => {
  expect(() => parsePgHttpProofArgs(["--image", IMAGE], {})).toThrow(
    "TAKOSUMI_TEST_NATIVE_POSTGRES_RESTART=1",
  );
  expect(parsePgHttpProofArgs(["--image", IMAGE], {
    TAKOSUMI_TEST_NATIVE_POSTGRES_RESTART: "1",
  })).toEqual({ image: IMAGE });

  for (const args of [
    [],
    ["--image", "latest"],
    ["--image", `sha256:${"A".repeat(64)}`],
    ["--image", IMAGE, "--pull"],
  ]) {
    expect(() => parsePgHttpProofArgs(args, {
      TAKOSUMI_TEST_NATIVE_POSTGRES_RESTART: "1",
    })).toThrow("usage");
  }
});

test("runner replay evidence observes only actual POST dispatch routes", async () => {
  const dispatched: string[] = [];
  const wrappedFetch = boundedRunnerFetch(
    "http://runner.local",
    (async () => new Response("{}", {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch,
    undefined,
    undefined,
    (runId) => dispatched.push(runId),
  );

  await wrappedFetch("http://runner.local/runs/apply-1", { method: "POST" });
  await wrappedFetch("http://runner.local/runs/apply-1", { method: "GET" });
  await wrappedFetch("http://runner.local/runs/apply-1/completion", { method: "POST" });

  expect(dispatched).toEqual(["apply-1"]);
});

test("runner HTTP diagnostics record only fixed route labels and preserve the original failure", async () => {
  const failure = new Error("private request detail that must not be reported");
  const events: Array<{ label: RunnerHttpProofLabel; phase: RunnerHttpProofEventPhase; cause?: unknown }> = [];
  const trace: RunnerHttpProofTrace = {};
  const wrappedFetch = boundedRunnerFetch(
    "http://runner.local",
    (async (input: Parameters<typeof fetch>[0]) => {
      if (new URL(input instanceof Request ? input.url : String(input)).pathname === "/healthz") {
        return new Response("ok");
      }
      throw failure;
    }) as unknown as typeof fetch,
    undefined,
    undefined,
    undefined,
    (label, phase, cause) => {
      events.push({ label, phase, cause });
      recordRunnerHttpProofEvent(trace, label, phase);
    },
  );

  await wrappedFetch("http://runner.local/healthz");
  await expect(wrappedFetch("http://runner.local/runs/private-run-id?private=query-secret", {
    method: "POST",
    body: JSON.stringify({ action: "destroy", token: "private-body-secret" }),
  }))
    .rejects.toBe(failure);

  expect(events.map(({ label, phase }) => ({ label, phase }))).toEqual([
    { label: "runner.health", phase: "start" },
    { label: "runner.health", phase: "completed" },
    { label: "runner.dispatch", phase: "start" },
    { label: "runner.dispatch", phase: "failed" },
  ]);
  expect(events[3]?.cause).toBe(failure);
  const summary = formatCoreHttpLifecycleFailure(trace, failure);
  expect(summary).toContain("phase=core.http-lifecycle");
  expect(summary).toContain("runner-http-last-attempted=runner.dispatch");
  expect(summary).toContain("runner-http-last-completed=runner.health");
  expect(summary).toContain("runner-http-last-observed-failure=runner.dispatch");
  expect(summary).not.toContain("private request detail");
  expect(summary).not.toContain("private-run-id");
  expect(summary).not.toContain("query-secret");
  expect(summary).not.toContain("private-body-secret");
  expect(summary).not.toContain("runner.local");
});

test("HTTP completion is context only and does not relabel a later unrelated error", async () => {
  const dispatchFailure = new Error("private failed dispatch detail");
  const trace: RunnerHttpProofTrace = {};
  const wrappedFetch = boundedRunnerFetch(
    "http://runner.local",
    (async (
      input: Parameters<typeof fetch>[0],
      init: Parameters<typeof fetch>[1],
    ) => {
      const request = input instanceof Request ? input : new Request(String(input));
      if ((init?.method ?? request.method) === "POST") throw dispatchFailure;
      return new Response(JSON.stringify({ status: "absent" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
    undefined,
    undefined,
    undefined,
    (label, phase) => recordRunnerHttpProofEvent(trace, label, phase),
  );

  await expect(wrappedFetch("http://runner.local/runs/private-run-id", { method: "POST" }))
    .rejects.toBe(dispatchFailure);
  await wrappedFetch("http://runner.local/runs/private-run-id/completion");
  expect(trace).toMatchObject({
    attempted: "runner.completion-read",
    completed: "runner.completion-read",
  });
  expect(trace.failed).toBe("runner.dispatch");

  const unrelatedSqlFailure = new Error("later SQL assertion failure");
  const summary = formatCoreHttpLifecycleFailure(trace, unrelatedSqlFailure);
  expect(summary).toContain("phase=core.http-lifecycle");
  expect(summary).toContain("runner-http-last-observed-failure=runner.dispatch");
  expect(summary).toContain("failure=Error@");
  expect(summary).not.toContain("phase=runner.http");
  expect(summary).not.toContain("private failed dispatch detail");
  expect(summary).not.toContain("later SQL assertion failure");
});

test("replay evidence rejects an additional runner POST under a different Run ID", () => {
  expect(() => assertNoAdditionalRunnerDispatches(
    ["apply-1"],
    ["apply-1", "unexpected-run"],
  )).toThrow("replaying the applied Plan dispatched another real runner execution");
});

test("proof result is withheld when owned-resource cleanup fails", async () => {
  const cleanupError = new Error("fixture cleanup failed");
  let emitted = false;

  await expect(runAndEmitAfterCleanup(
    async () => "passed",
    async () => { throw cleanupError; },
    () => { emitted = true; },
  )).rejects.toBe(cleanupError);

  expect(emitted).toBe(false);
});

test("PostgreSQL cleanup failure preserves the primary lifecycle failure and reports both safely", async () => {
  const trace: RunnerHttpProofTrace = {
    attempted: "runner.dispatch",
    failed: "runner.dispatch",
  };
  const primaryFailure = new Error("private runner response detail");
  const cleanupFailure = new Error("private PostgreSQL cleanup detail");
  const primary = new NativePostgresCoreHttpFailure(trace, primaryFailure);

  let failure: unknown;
  try {
    await runWithNativePostgresCleanup(
      async () => { throw primary; },
      async () => { throw cleanupFailure; },
    );
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([primary, cleanupFailure]);
  expect((failure as Error).cause).toBe(primary);
  expect((primary as Error).cause).toBe(primaryFailure);
  const summary = formatNativePostgresLifecycleFailure(failure);
  expect(summary).toContain("phase=core.http-lifecycle");
  expect(summary).toContain("failure=primary-and-cleanup");
  expect(summary).toContain("cleanup-phase=postgres.cleanup cleanup=Error@");
  expect(summary).toContain("runner-http-last-observed-failure=runner.dispatch");
  expect(summary).not.toContain("private");
});

test("PostgreSQL cleanup failure is reported separately when lifecycle work succeeded", async () => {
  const cleanupFailure = new Error("private PostgreSQL cleanup detail");
  let failure: unknown;

  try {
    await runWithNativePostgresCleanup(
      async () => "completed",
      async () => { throw cleanupFailure; },
    );
  } catch (error) {
    failure = error;
  }

  const summary = formatNativePostgresLifecycleFailure(failure);
  expect(summary).toContain("phase=postgres.cleanup");
  expect(summary).toContain("failure=cleanup-only cleanup=Error@");
  expect(summary).not.toContain("private");
});

test("outer runner cleanup diagnostic preserves a nested PostgreSQL primary and cleanup", async () => {
  const primary = new Error("private Core HTTP cause");
  const postgresCleanup = new Error("private PostgreSQL cleanup detail");
  const runnerCleanup = new Error("private runner cleanup detail");
  let postgresFailure: unknown;
  try {
    await runWithNativePostgresCleanup(
      async () => { throw new NativePostgresCoreHttpFailure({}, primary); },
      async () => { throw postgresCleanup; },
    );
  } catch (error) {
    postgresFailure = error;
  }

  let outerFailure: unknown;
  try {
    await runAndEmitAfterCleanup(
      async () => { throw postgresFailure; },
      async () => { throw runnerCleanup; },
      () => { throw new Error("must not emit"); },
    );
  } catch (error) {
    outerFailure = error;
  }

  const summary = formatNativePostgresLifecycleFailure(outerFailure);
  expect((outerFailure as AggregateError).errors).toEqual([postgresFailure, runnerCleanup]);
  expect(summary).toContain("failure=primary-and-outer-cleanup");
  expect(summary).toContain("phase=core.http-lifecycle");
  expect(summary).toContain("cleanup-phase=postgres.cleanup");
  expect(summary).toContain("cleanup-phase=proof.cleanup");
  expect(summary).not.toContain("private");
});

test("proof result is emitted only after owned-resource cleanup succeeds", async () => {
  const events: string[] = [];

  await runAndEmitAfterCleanup(
    async () => {
      events.push("work");
      return "passed";
    },
    async () => { events.push("cleanup"); },
    () => { events.push("emit"); },
  );

  expect(events).toEqual(["work", "cleanup", "emit"]);
});

test("fresh Core factory runs only after the generation-one restart boundary", async () => {
  const events: string[] = [];
  const runtime = await reopenCoreRuntimeAfterRestart({
    afterInitialApply: async () => { events.push("close-and-restart"); },
    createRuntime: async () => {
      events.push("open-fresh-sql-core");
      return { generation: 1 };
    },
  });

  expect(runtime).toEqual({ generation: 1 });
  expect(events).toEqual(["close-and-restart", "open-fresh-sql-core"]);
});

test("failed restart boundary prevents opening another SQL Core runtime", async () => {
  const restartError = new Error("PostgreSQL restart failed");
  let opened = false;

  await expect(reopenCoreRuntimeAfterRestart({
    afterInitialApply: async () => { throw restartError; },
    createRuntime: async () => {
      opened = true;
      return {};
    },
  })).rejects.toBe(restartError);

  expect(opened).toBe(false);
});

test("fixture diagnostics preserve setup and cleanup locations without error details", async () => {
  const dataRoot = await mkdtemp("/dev/shm/takosumi-pg-http-diagnostic-");
  await chmod(dataRoot, 0o700);
  const containerId = "a".repeat(64);
  let containerName = "";
  let dataDirectory = "";
  let publishedPort = "";
  const labels: Record<string, string> = {};
  const runDocker = async (args: readonly string[]): Promise<string> => {
    if (args[0] === "image") {
      return "sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229";
    }
    if (args[0] === "version") return "29.1.3";
    if (args[0] === "run") {
      containerName = args[args.indexOf("--name") + 1]!;
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--label") {
          const [key, ...valueParts] = args[index + 1]!.split("=");
          labels[key!] = valueParts.join("=");
        }
      }
      dataDirectory = /source=([^,]+)/u.exec(args[args.indexOf("--mount") + 1]!)![1]!;
      publishedPort = /^127\.0\.0\.1:([0-9]+):5432$/u.exec(
        args[args.indexOf("--publish") + 1]!,
      )![1]!;
      return containerId;
    }
    if (args[0] === "inspect") {
      return JSON.stringify({
        Id: containerId,
        Name: `/${containerName}`,
        Config: {
          Image: "postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229",
          Labels: labels,
        },
        State: {
          Running: true,
          Status: "running",
          Pid: 42,
          Health: { Status: "healthy" },
        },
        NetworkSettings: {
          Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: publishedPort }] },
        },
        Mounts: [{
          Type: "bind",
          Source: dataDirectory,
          Destination: "/var/lib/postgresql/data",
          RW: true,
        }],
      });
    }
    if (args[0] === "exec") return "entrypoint";
    if (args[0] === "stop") throw new Error("cleanup failure includes an unreportable secret");
    throw new Error("unexpected fake Docker operation");
  };

  let failure: unknown;
  try {
    await createNativePostgresRestartContainer({ runDocker, dataRoot });
  } catch (error) {
    failure = error;
  } finally {
    await rm(dataRoot, { recursive: true, force: false });
  }

  expect(failure).toBeInstanceOf(AggregateError);
  const summary = formatNativePostgresProofFailure("postgres.fixture.create", failure);
  expect(summary).toMatch(/^phase=postgres\.fixture\.create failure=setup-and-cleanup/u);
  expect(summary).toMatch(/setup=Error@native_postgres_restart\.ts:[0-9]+/u);
  expect(summary).toMatch(/cleanup=Error@native_postgres_restart\.ts:[0-9]+/u);
  expect(summary).not.toContain("unreportable secret");
  expect(summary).not.toContain("postgres://");
  expect(summary).not.toContain(dataDirectory);

  const spoofed = formatNativePostgresProofFailure(
    "postgres.fixture.create",
    new Error("untrusted stderr mentions native_postgres_restart.ts:987654:1"),
  );
  expect(spoofed).toContain("source-location-unavailable");
  expect(spoofed).not.toContain("987654");
});
