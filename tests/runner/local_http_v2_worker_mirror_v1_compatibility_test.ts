import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startRunnerHttpServer } from "../../runner/entrypoint.ts";
import { mutationRequestDigest } from "../../runner/lib/run_completion.ts";
import { digestBytes } from "../../runner/lib/util.ts";
import {
  acquireRunRootOwnership,
  adoptRunRootOwnershipFromStdin,
  type RunRootOwnership,
} from "../../runner/lib/run_root_ownership.ts";
import { PreparationV2ChildSupervisor } from "../../runner/lib/preparation_v2_child_supervisor.ts";

const mode = Bun.argv[2];

if (import.meta.main && mode === "--worker-mirror-v1-supervisor") {
  await runSupervisorFixture(Bun.argv[3] ?? "", Bun.argv[4] ?? "");
} else if (import.meta.main && mode === "--worker-mirror-v1-http-child") {
  await runHttpChildFixture(Bun.argv[3] ?? "", Bun.argv[4] ?? "");
}

if (mode !== "--worker-mirror-v1-supervisor" &&
  mode !== "--worker-mirror-v1-http-child") test.skipIf(
  process.platform !== "linux" ||
    (process.arch !== "x64" && process.arch !== "arm64"),
)(
  "selected v2 Runner preserves the local Worker-mirror v1 reservation and dispatch contract",
  async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "takosumi-v1-v2-http-"));
    await chmod(fixtureRoot, 0o700);
    const runRoot = join(fixtureRoot, "run-root");
    const fakeBin = join(fixtureRoot, "fake-bin");
    const portFile = join(fixtureRoot, "server-port");
    const applyCalls = join(fixtureRoot, "apply-calls");
    await mkdir(runRoot, { mode: 0o700 });
    await mkdir(fakeBin, { mode: 0o700 });
    await writeFile(join(fakeBin, "tofu"), fakeTofu(applyCalls), { mode: 0o700 });

    const successRunId = newRunId("success");
    const failedRunId = newRunId("failed");
    const unknownRunId = newRunId("unknown");
    for (const runId of [successRunId, failedRunId, unknownRunId]) {
      const sourceRoot = join(runRoot, runId, "source");
      await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(sourceRoot, "main.tf"), "terraform {}\n");
    }
    await writeFile(
      join(runRoot, failedRunId, "source", ".test-fail-apply"),
      "fixture\n",
    );

    const env = {
      PATH: `${fakeBin}:/usr/bin:/bin`,
      HOME: fixtureRoot,
      TMPDIR: fixtureRoot,
      PORT: "0",
      TAKOSUMI_OPENTOFU_RUN_ROOT: runRoot,
      TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE: "local-http",
    };
    const supervisor = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        import.meta.path,
        "--worker-mirror-v1-supervisor",
        runRoot,
        portFile,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore", env },
    );
    const lines = lineReader(supervisor.stdout);
    let supervisorClosed = false;
    try {
      const ready = await lines.next();
      expect(ready).toMatch(/^ready:\d+$/u);
      const base = `http://127.0.0.1:${ready.slice("ready:".length)}`;
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      const healthBody = await health.json() as {
        readonly capabilities?: readonly string[];
        readonly mutationCustodyMode?: string;
      };
      expect(healthBody.mutationCustodyMode).toBe("local-http");
      expect(healthBody.capabilities).toContain(
        "takosumi.local-mutation-preparation@v2",
      );

      const successRequest = await applyRequest(successRunId, "plan-bytes-success");
      const successResult = await runWorkerMirrorV1Apply(
        base,
        successRunId,
        successRequest,
        "plan-bytes-success",
      );
      expect(successResult.response.status).toBe(200);
      expect(successResult.body.status).toBe("succeeded");

      // V1's successful POST response remains the result. A completion GET does
      // not silently adopt it as a v2 result or publish v2 success fields.
      const successReadback = await completionGet(
        base,
        successRunId,
        successRequest,
      );
      expect(successReadback.status).toBe(409);
      expect(await successReadback.json()).toMatchObject({
        errorCode: "runner_mutation_indeterminate",
        retryable: false,
      });
      expect((await postV1Apply(base, successRunId, successRequest, successResult.token)).status)
        .toBe(409);

      const failedRequest = await applyRequest(failedRunId, "plan-bytes-failed");
      const failedResult = await runWorkerMirrorV1Apply(
        base,
        failedRunId,
        failedRequest,
        "plan-bytes-failed",
      );
      expect(failedResult.response.status).toBe(500);
      expect(failedResult.body.providerExecutionFailure).toEqual({
        kind: "provider_execution_failed",
      });
      const failedReadback = await completionGet(
        base,
        failedRunId,
        failedRequest,
      );
      expect(failedReadback.status).toBe(500);
      expect(await failedReadback.json()).toMatchObject({
        status: "failed",
        providerExecutionFailure: { kind: "provider_execution_failed" },
      });
      expect((await postV1Apply(base, failedRunId, failedRequest, failedResult.token)).status)
        .toBe(409);

      // The reservation is consumed before apply preflight. A digest mismatch
      // creates an unknown/indeterminate outcome, not a retryable v2 claim.
      const unknownRequest = await applyRequest(unknownRunId, "wrong-plan-digest-bytes");
      const unknownResult = await runWorkerMirrorV1Apply(
        base,
        unknownRunId,
        unknownRequest,
        "uploaded-plan-bytes",
      );
      expect(unknownResult.response.status).toBe(500);
      const unknownReadback = await completionGet(
        base,
        unknownRunId,
        unknownRequest,
      );
      expect(unknownReadback.status).toBe(409);
      expect(await unknownReadback.json()).toMatchObject({
        errorCode: "runner_mutation_indeterminate",
        retryable: false,
      });
      expect((await postV1Apply(base, unknownRunId, unknownRequest, unknownResult.token)).status)
        .toBe(409);

      const calls = (await readFile(applyCalls, "utf8")).trim().split("\n");
      expect(calls).toHaveLength(2);
      expect(calls.filter((path) => path.includes(successRunId))).toHaveLength(1);
      expect(calls.filter((path) => path.includes(failedRunId))).toHaveLength(1);
      expect(calls.some((path) => path.includes(unknownRunId))).toBe(false);
    } finally {
      if (supervisor.exitCode === null) {
        supervisor.stdin.write("stop\n");
        expect(await lines.next()).toBe("stop-received");
        expect(await lines.next()).toBe("runner-settled");
        expect(await lines.next()).toBe("supervisor-closed");
        const closed = await lines.next();
        supervisorClosed = closed.startsWith("closed:0:");
        const exitCode = await supervisor.exited;
        if (supervisorClosed) expect(exitCode).toBe(0);
      }
      if (supervisorClosed) {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    }
  },
);

function newRunId(label: string): string {
  return `v1v2_${label}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function applyRequest(runId: string, planBytes: string) {
  const bytes = new TextEncoder().encode(planBytes);
  return {
    request: {
      applyRun: { id: runId },
      planRun: {
        id: runId,
        operation: "create",
        source: {
          kind: "git",
          url: "https://git.example.test/capsule.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
        },
        requiredProviders: [],
      },
      planArtifact: {
        kind: "runner-local",
        ref: `runner-local://${runId}/tfplan`,
        digest: await digestBytes(bytes),
      },
      runnerProfile: { id: "worker-mirror-v1-fixture", allowedProviders: [] },
      variables: {},
    },
    planBytes,
  };
}

async function runWorkerMirrorV1Apply(
  base: string,
  runId: string,
  prepared: Awaited<ReturnType<typeof applyRequest>>,
  uploadedPlanBytes: string,
) {
  const uploaded = await fetch(`${base}/runs/${runId}/artifacts/tfplan`, {
    method: "PUT",
    headers: { "content-type": "application/vnd.opentofu.plan" },
    body: uploadedPlanBytes,
  });
  expect(uploaded.status).toBe(200);

  const reservation = await fetch(
    `${base}/runs/${runId}/mutation-reservation`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "apply", runId, request: prepared.request }),
    },
  );
  expect(reservation.status).toBe(201);
  const reservationBody = await reservation.json() as { readonly token?: string };
  expect(reservationBody.token).toMatch(/^[0-9a-f-]{36}$/u);

  const response = await postV1Apply(base, runId, prepared, reservationBody.token!);
  return {
    response,
    body: await response.json() as Record<string, unknown>,
    token: reservationBody.token!,
  };
}

function postV1Apply(
  base: string,
  runId: string,
  prepared: Awaited<ReturnType<typeof applyRequest>>,
  token: string,
): Promise<Response> {
  return fetch(`${base}/runs/${runId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-takosumi-mutation-reservation": token,
    },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action: "apply",
      runId,
      requestedAt: "2026-01-01T00:00:00.000Z",
      request: prepared.request,
    }),
  });
}

async function completionGet(
  base: string,
  runId: string,
  prepared: Awaited<ReturnType<typeof applyRequest>>,
): Promise<Response> {
  return await fetch(`${base}/runs/${runId}/completion`, {
    headers: {
      "x-takosumi-mutation-action": "apply",
      "x-takosumi-mutation-digest": await mutationRequestDigest(
        runId,
        "apply",
        prepared.request,
      ),
    },
  });
}

function fakeTofu(callsFile: string): string {
  const quotedCalls = `'${callsFile.replaceAll("'", "'\\''")}'`;
  return `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init) exit 0 ;;
  apply)
    printf '%s\\n' "$PWD" >> ${quotedCalls}
    printf '%s\\n' '{"version":4,"terraform_version":"1.10.0","serial":1,"lineage":"v1-compat","outputs":{"fixture":{"value":"ok","type":"string","sensitive":false}},"resources":[]}' > terraform.tfstate
    if [ -f .test-fail-apply ]; then
      printf '%s\\n' 'fixture provider failure' >&2
      exit 1
    fi
    exit 0
    ;;
  output) printf '%s' '{"fixture":{"value":"ok","type":"string","sensitive":false}}' ;;
  *) exit 97 ;;
esac
`;
}

async function runSupervisorFixture(runRoot: string, portFile: string): Promise<void> {
  let owner: RunRootOwnership | undefined;
  let supervisor: PreparationV2ChildSupervisor | undefined;
  try {
    owner = await acquireRunRootOwnership(runRoot);
    supervisor = new PreparationV2ChildSupervisor(runRoot, owner);
    const env = Object.fromEntries(
      Object.entries(Bun.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const run = supervisor.runRunnerUntilDrained(
      process.execPath,
      [
        "--no-env-file",
        import.meta.path,
        "--worker-mirror-v1-http-child",
        runRoot,
        portFile,
      ],
      { env, drainTimeoutMs: 5_000, retryIntervalMs: 20 },
    );
    const settled = run.then(
      (result) => ({ ok: true as const, result }),
      () => ({ ok: false as const }),
    );
    const port = await waitForPort(portFile, settled);
    process.stdout.write(`ready:${port}\n`);
    await waitForStopCommand();
    process.stdout.write("stop-received\n");
    if (!supervisor.signalRunner("SIGTERM")) throw new Error("runner stop refused");
    const outcome = await settled;
    process.stdout.write("runner-settled\n");
    if (!outcome.ok || outcome.result.exitCode !== 0 || outcome.result.signalCode !== null) {
      throw new Error("runner fixture did not exit cleanly");
    }
    await supervisor.close();
    process.stdout.write("supervisor-closed\n");
    supervisor = undefined;
    await owner.close();
    process.stdout.write("closed:0:drained\n");
  } catch {
    // A failed or uncertain child tree must keep its run-root lease. The outer
    // test consequently retains its private fixture directory on this path.
    process.stdout.write("fixture-failed\n");
    process.exitCode = 1;
  }
}

async function runHttpChildFixture(runRoot: string, portFile: string): Promise<void> {
  let owner: RunRootOwnership | undefined;
  try {
    owner = await adoptRunRootOwnershipFromStdin(runRoot);
    const running = await startRunnerHttpServer({
      hostname: "127.0.0.1",
      port: 0,
      localPreparationV2: true,
      runRootOwnership: owner,
    });
    owner = undefined;
    await writeFile(portFile, String(running.server.port), { flag: "wx" });
    process.on("SIGTERM", () => {
      void running.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
    await new Promise<void>(() => {});
  } catch {
    await owner?.close().catch(() => {});
    process.exitCode = 1;
  }
}

async function waitForPort(
  path: string,
  settled: Promise<{ readonly ok: true } | { readonly ok: false }>,
): Promise<number> {
  const deadline = performance.now() + 5_000;
  for (;;) {
    try {
      const text = await readFile(path, "utf8");
      const port = Number(text);
      if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) return port;
    } catch {
      // The child writes this only after the v2 HTTP server is listening.
    }
    const result = await Promise.race([
      settled,
      Bun.sleep(10).then(() => undefined),
    ]);
    if (result && !result.ok) throw new Error("Runner child failed before listen");
    if (performance.now() >= deadline) throw new Error("Runner child listen timed out");
  }
}

function waitForStopCommand(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      if (!chunk.includes("stop\n")) return;
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve();
    };
    process.stdin.on("data", onData);
  });
}

function lineReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async next(): Promise<string> {
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          return line;
        }
        const { done, value } = await reader.read();
        if (done) throw new Error("supervisor fixture exited before status");
        buffered += decoder.decode(value, { stream: true });
      }
    },
  };
}
