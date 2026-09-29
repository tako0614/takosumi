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

test("async mutation result for an unaccepted run is unknown", async () => {
  const runId = `async-mutation-unknown-${crypto.randomUUID()}`;
  const response = await handleRunnerRequest(new Request(
    `http://runner/runs/${encodeURIComponent(runId)}/result`,
  ));

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "run result not found" });
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
