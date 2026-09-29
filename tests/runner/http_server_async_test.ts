import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceForRun } from "../../runner/lib/artifacts.ts";
import { handleRunnerRequest } from "../../runner/lib/http_server.ts";

function asyncMutationRequest(runId: string, action = "apply") {
  return new Request(`http://runner/runs/${encodeURIComponent(runId)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      prefer: "respond-async",
    },
    body: JSON.stringify({
      action,
      runId,
      request: {
        applyRun: { id: `apply-${runId}` },
        privateSentinel: "must-not-be-returned-or-logged",
      },
    }),
  });
}

function resultAckRequest(
  runId: string,
  applyRunId: string,
  action: string,
  overrides: Record<string, unknown> = {},
) {
  return new Request(`http://runner/runs/${encodeURIComponent(runId)}/result/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.runner-mutation-result-ack@v1",
      runId,
      applyRunId,
      action,
      ...overrides,
    }),
  });
}

function mutationStopRequest(
  runId: string,
  applyRunId: string,
  action: string,
  overrides: Record<string, unknown> = {},
) {
  return new Request(`http://runner/runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.runner-mutation-stop@v1",
      runId,
      applyRunId,
      action,
      ...overrides,
    }),
  });
}

test("async mutation accepts once, exposes only bounded terminal result, and rejects replay", async () => {
  const runId = `async-mutation-${crypto.randomUUID()}`;
  const accepted = await handleRunnerRequest(asyncMutationRequest(runId));

  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toEqual({
    kind: "takosumi.runner-mutation-pending@v1",
    runId,
    applyRunId: `apply-${runId}`,
    action: "apply",
    status: "accepted",
  });

  const duplicate = await handleRunnerRequest(asyncMutationRequest(runId));
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toEqual({ error: "run already accepted" });

  let result: Response | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await handleRunnerRequest(new Request(
      `http://runner/runs/${encodeURIComponent(runId)}/result`,
    ));
    if (response.status !== 202) {
      result = response;
      break;
    }
    expect(await response.json()).toEqual({
      kind: "takosumi.runner-mutation-pending@v1",
      runId,
      applyRunId: `apply-${runId}`,
      action: "apply",
      status: "running",
    });
    await Bun.sleep(5);
  }
  expect(result).toBeDefined();
  expect(result!.status).toBe(500);
  const terminal = await result!.json();
  expect(terminal).toMatchObject({
    runId,
    action: "apply",
    status: "failed",
    exitCode: 1,
  });
  expect(JSON.stringify(terminal)).not.toContain("must-not-be-returned-or-logged");
  const stopAfterTerminal = await handleRunnerRequest(mutationStopRequest(
    runId,
    `apply-${runId}`,
    "apply",
  ));
  expect(stopAfterTerminal.status).toBe(409);
  expect(await stopAfterTerminal.json()).toEqual({
    kind: "takosumi.runner-mutation-stop-unavailable@v1",
    reason: "not_running",
  });

  // Reads are observations only: the terminal bytes remain available until
  // the DO acknowledges its exact durable receipt.
  const observedAgain = await handleRunnerRequest(new Request(
    `http://runner/runs/${encodeURIComponent(runId)}/result`,
  ));
  expect(observedAgain.status).toBe(500);
  expect(await observedAgain.json()).toEqual(terminal);

  const wrongRun = await handleRunnerRequest(resultAckRequest(
    runId,
    `apply-${runId}`,
    "apply",
    { runId: `other-${runId}` },
  ));
  const wrongApply = await handleRunnerRequest(resultAckRequest(
    runId,
    `other-apply-${runId}`,
    "apply",
  ));
  const wrongAction = await handleRunnerRequest(resultAckRequest(
    runId,
    `apply-${runId}`,
    "destroy",
  ));
  expect([wrongRun.status, wrongApply.status, wrongAction.status]).toEqual([409, 409, 409]);
  const stillAvailable = await handleRunnerRequest(new Request(
    `http://runner/runs/${encodeURIComponent(runId)}/result`,
  ));
  expect(await stillAvailable.json()).toEqual(terminal);

  const acknowledgement = await handleRunnerRequest(resultAckRequest(
    runId,
    `apply-${runId}`,
    "apply",
  ));
  expect(acknowledgement.status).toBe(200);
  expect(await acknowledgement.json()).toEqual({ ok: true });
  const lostAcknowledgementRetry = await handleRunnerRequest(resultAckRequest(
    runId,
    `apply-${runId}`,
    "apply",
  ));
  expect(lostAcknowledgementRetry.status).toBe(200);
  expect(await lostAcknowledgementRetry.json()).toEqual({ ok: true });
  const cleared = await handleRunnerRequest(new Request(
    `http://runner/runs/${encodeURIComponent(runId)}/result`,
  ));
  expect(cleared.status).toBe(410);
  const replay = await handleRunnerRequest(asyncMutationRequest(runId));
  expect(replay.status).toBe(409);
});

test("accepted async Apply outlives its submit request signal and keeps sync terminal shape", async () => {
  const runId = `async-mutation-detached-${crypto.randomUUID()}`;
  const applyRunId = `apply-${runId}`;
  const workspace = workspaceForRun(runId);
  const fakeBin = await mkdtemp(join(tmpdir(), "takosumi-async-runner-bin-"));
  const oldPath = Bun.env.PATH;
  const marker = join(fakeBin, "apply-finished");
  const planBytes = new TextEncoder().encode("async-reviewed-plan");
  const planDigest = `sha256:${Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", planBytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("")}`;
  const abortController = new AbortController();
  try {
    await mkdir(workspace.sourceRoot, { recursive: true });
    await writeFile(join(workspace.sourceRoot, "main.tf"), "terraform {}\n");
    const artifact = await handleRunnerRequest(new Request(
      `http://runner/runs/${encodeURIComponent(runId)}/artifacts/tfplan`,
      { method: "PUT", body: planBytes },
    ));
    expect(artifact.status).toBe(200);
    await writeFile(join(fakeBin, "tofu"), `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init|state|show) exit 0 ;;
  apply) sleep 0.25; touch ${JSON.stringify(marker)}; exit 0 ;;
  output) printf '{}' ;;
  *) exit 9 ;;
esac
`);
    await chmod(join(fakeBin, "tofu"), 0o755);
    Bun.env.PATH = `${fakeBin}:${oldPath ?? "/usr/bin:/bin"}`;

    const accepted = await handleRunnerRequest(new Request(
      `http://runner/runs/${encodeURIComponent(runId)}`,
      {
        method: "POST",
        signal: abortController.signal,
        headers: { "content-type": "application/json", prefer: "respond-async" },
        body: JSON.stringify({
          action: "apply",
          runId,
          request: {
            planRun: {
              id: runId,
              source: {
                kind: "git",
                url: "https://git.example.test/repo.git",
                commit: "1".repeat(40),
              },
              requiredProviders: [],
            },
            applyRun: { id: applyRunId },
            planArtifact: {
              kind: "runner-local",
              ref: `runner-local://${runId}/tfplan`,
              digest: planDigest,
            },
            runnerProfile: { allowedProviders: [], requireProviderBindings: false },
          },
        }),
      },
    ));
    expect(accepted.status).toBe(202);
    abortController.abort();

    const running = await handleRunnerRequest(new Request(
      `http://runner/runs/${encodeURIComponent(runId)}/result`,
    ));
    expect(running.status).toBe(202);
    expect(await running.json()).toEqual({
      kind: "takosumi.runner-mutation-pending@v1",
      runId,
      applyRunId,
      action: "apply",
      status: "running",
    });
    const prematureAck = await handleRunnerRequest(resultAckRequest(
      runId,
      applyRunId,
      "apply",
    ));
    expect(prematureAck.status).toBe(409);
    const stillRunning = await handleRunnerRequest(new Request(
      `http://runner/runs/${encodeURIComponent(runId)}/result`,
    ));
    expect(stillRunning.status).toBe(202);

    let terminal: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await handleRunnerRequest(new Request(
        `http://runner/runs/${encodeURIComponent(runId)}/result`,
      ));
      if (response.status !== 202) {
        terminal = response;
        break;
      }
      await Bun.sleep(5);
    }
    expect(terminal?.status).toBe(200);
    expect((await terminal!.json()).status).toBe("succeeded");
    await expect(Bun.file(marker).exists()).resolves.toBe(true);
  } finally {
    if (oldPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = oldPath;
    await rm(workspace.root, { recursive: true, force: true });
    await rm(workspace.depsDir, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("accepted async release outlives abort, rejects replay, and becomes unknown after process restart", async () => {
  const runId = `async-release-${crypto.randomUUID()}`;
  const applyRunId = `apply-${runId}`;
  const workspace = workspaceForRun(runId);
  const marker = join(workspace.sourceRoot, "release-finished.txt");
  const abortController = new AbortController();
  try {
    await mkdir(workspace.sourceRoot, { recursive: true });
    const body = {
      action: "release",
      runId,
      request: {
        release: {
          commands: [{
            id: "post-apply-delay",
            command: [
              globalThis.process.execPath,
              "-e",
              `await Bun.sleep(250); await (await import("node:fs/promises")).appendFile(${JSON.stringify(marker)}, "finished")`,
            ],
          }],
        },
        activation: {
          applyRunId,
          sourceSnapshotId: `snapshot-${runId}`,
          sourceCommit: "2".repeat(40),
        },
      },
    };
    const accepted = await handleRunnerRequest(new Request(
      `http://runner/runs/${encodeURIComponent(runId)}`,
      {
        method: "POST",
        signal: abortController.signal,
        headers: { "content-type": "application/json", prefer: "respond-async" },
        body: JSON.stringify(body),
      },
    ));
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({
      kind: "takosumi.runner-mutation-pending@v1",
      runId,
      applyRunId,
      action: "release",
      status: "accepted",
    });
    abortController.abort();

    const duplicate = await handleRunnerRequest(new Request(
      `http://runner/runs/${encodeURIComponent(runId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", prefer: "respond-async" },
        body: JSON.stringify(body),
      },
    ));
    expect(duplicate.status).toBe(409);

    const running = await handleRunnerRequest(new Request(
      `http://runner/runs/${encodeURIComponent(runId)}/result`,
    ));
    expect(running.status).toBe(202);
    expect(await running.json()).toEqual({
      kind: "takosumi.runner-mutation-pending@v1",
      runId,
      applyRunId,
      action: "release",
      status: "running",
    });

    let terminal: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await handleRunnerRequest(new Request(
        `http://runner/runs/${encodeURIComponent(runId)}/result`,
      ));
      if (response.status !== 202) {
        terminal = response;
        break;
      }
      await Bun.sleep(5);
    }
    expect(terminal?.status).toBe(200);
    expect(await terminal!.json()).toMatchObject({
      runId,
      action: "release",
      status: "succeeded",
      exitCode: 0,
      commandCount: 1,
    });
    expect(await Bun.file(marker).text()).toBe("finished");
    const releaseAck = await handleRunnerRequest(resultAckRequest(
      runId,
      applyRunId,
      "release",
    ));
    expect(releaseAck.status).toBe(200);
    expect(await releaseAck.json()).toEqual({ ok: true });
    const releaseAckRetry = await handleRunnerRequest(resultAckRequest(
      runId,
      applyRunId,
      "release",
    ));
    expect(releaseAckRetry.status).toBe(200);
    expect(await releaseAckRetry.json()).toEqual({ ok: true });

    const moduleUrl = new URL("../../runner/lib/http_server.ts", import.meta.url).href;
    const script = [
      `import { handleRunnerRequest } from ${JSON.stringify(moduleUrl)};`,
      `const response = await handleRunnerRequest(new Request(${JSON.stringify(`http://runner/runs/${runId}/result`)}));`,
      `console.log(JSON.stringify({ status: response.status, body: await response.json() }));`,
    ].join("\n");
    const child = Bun.spawn([globalThis.process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      status: 404,
      body: { error: "run result not found" },
    });
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
    await rm(workspace.depsDir, { recursive: true, force: true });
  }
});

test("stop requests abort only the exact live mutation slot and never clear its result", async () => {
  const runId = `async-stop-release-${crypto.randomUUID()}`;
  const applyRunId = `apply-${runId}`;
  const workspace = workspaceForRun(runId);
  const marker = join(workspace.sourceRoot, "release-should-not-finish.txt");
  try {
    await mkdir(workspace.sourceRoot, { recursive: true });
    const accepted = await handleRunnerRequest(new Request(
      `http://runner/runs/${encodeURIComponent(runId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", prefer: "respond-async" },
        body: JSON.stringify({
          action: "release",
          runId,
          request: {
            release: {
              commands: [{
                id: "long-release",
                command: [
                  globalThis.process.execPath,
                  "-e",
                  `await Bun.sleep(1500); await Bun.write(${JSON.stringify(marker)}, "unexpected")`,
                ],
              }],
            },
            activation: {
              applyRunId,
              sourceSnapshotId: `snapshot-${runId}`,
              sourceCommit: "3".repeat(40),
            },
          },
        }),
      },
    ));
    expect(accepted.status).toBe(202);

    const wrongIdentity = await handleRunnerRequest(mutationStopRequest(
      runId,
      `other-${applyRunId}`,
      "release",
    ));
    expect(wrongIdentity.status).toBe(409);
    expect(await wrongIdentity.json()).toEqual({
      kind: "takosumi.runner-mutation-stop-unavailable@v1",
      reason: "identity_mismatch",
    });
    const wrongAction = await handleRunnerRequest(mutationStopRequest(
      runId,
      applyRunId,
      "apply",
    ));
    expect(wrongAction.status).toBe(409);
    const stillRunning = await handleRunnerRequest(new Request(
      `http://runner/runs/${encodeURIComponent(runId)}/result`,
    ));
    expect(stillRunning.status).toBe(202);

    const stopped = await handleRunnerRequest(mutationStopRequest(
      runId,
      applyRunId,
      "release",
    ));
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ ok: true });

    let terminal: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await handleRunnerRequest(new Request(
        `http://runner/runs/${encodeURIComponent(runId)}/result`,
      ));
      if (response.status !== 202) {
        terminal = response;
        break;
      }
      await Bun.sleep(5);
    }
    expect(terminal?.status).toBe(500);
    expect((await terminal!.json()).status).toBe("failed");
    expect(await Bun.file(marker).exists()).toBe(false);

    const stopRetry = await handleRunnerRequest(mutationStopRequest(
      runId,
      applyRunId,
      "release",
    ));
    expect(stopRetry.status).toBe(200);
    expect(await stopRetry.json()).toEqual({ ok: true });
    const stillRetained = await handleRunnerRequest(new Request(
      `http://runner/runs/${encodeURIComponent(runId)}/result`,
    ));
    expect(stillRetained.status).toBe(500);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
    await rm(workspace.depsDir, { recursive: true, force: true });
  }
});

test("async mutation result for an unaccepted run is unknown", async () => {
  const runId = `async-mutation-unknown-${crypto.randomUUID()}`;
  const response = await handleRunnerRequest(new Request(
    `http://runner/runs/${encodeURIComponent(runId)}/result`,
  ));

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "run result not found" });
  const ack = await handleRunnerRequest(resultAckRequest(
    runId,
    `apply-${runId}`,
    "apply",
  ));
  expect(ack.status).toBe(404);
  const stop = await handleRunnerRequest(mutationStopRequest(
    runId,
    `apply-${runId}`,
    "apply",
  ));
  expect(stop.status).toBe(404);
  expect(await stop.json()).toEqual({
    kind: "takosumi.runner-mutation-stop-unavailable@v1",
    reason: "run_not_found",
  });
});

test("a replacement container process reports an accepted predecessor result as unknown", async () => {
  const runId = `async-mutation-restarted-${crypto.randomUUID()}`;
  const accepted = await handleRunnerRequest(asyncMutationRequest(runId));
  expect(accepted.status).toBe(202);

  const moduleUrl = new URL("../../runner/lib/http_server.ts", import.meta.url).href;
  const script = [
    `import { handleRunnerRequest } from ${JSON.stringify(moduleUrl)};`,
    `const response = await handleRunnerRequest(new Request(${JSON.stringify(`http://runner/runs/${runId}/result`)}));`,
    `console.log(JSON.stringify({ status: response.status, body: await response.json() }));`,
  ].join("\n");
  const process = Bun.spawn([globalThis.process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    status: 404,
    body: { error: "run result not found" },
  });
});

test("respond-async is limited to apply and destroy; synchronous plan stays synchronous", async () => {
  const runId = `async-plan-${crypto.randomUUID()}`;
  const response = await handleRunnerRequest(new Request(
    `http://runner/runs/${encodeURIComponent(runId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", prefer: "respond-async" },
      body: JSON.stringify({ action: "plan", runId, request: {} }),
    },
  ));

  expect(response.status).not.toBe(202);
});
