/**
 * Run-slot ceiling of the standalone runner: a request past
 * TAKOSUMI_RUNNER_MAX_CONCURRENT_RUNS must be refused BEFORE any work starts,
 * with the `capacity_exhausted` envelope the control plane requeues on.
 */
import { afterEach, expect, test } from "bun:test";

import { handleRunnerRequest } from "../../runner/lib/http_server.ts";

const ENV_KEY = "TAKOSUMI_RUNNER_MAX_CONCURRENT_RUNS";
const previous = Bun.env[ENV_KEY];

afterEach(() => {
  if (previous === undefined) delete Bun.env[ENV_KEY];
  else Bun.env[ENV_KEY] = previous;
});

function planRequest(runId: string): Request {
  return new Request(`https://runner.test/runs/${runId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action: "plan",
      runId,
      requestedAt: "2026-08-23T00:00:00.000Z",
      request: {},
    }),
  });
}

test("drain mode (limit 0) refuses a run with the capacity_exhausted envelope", async () => {
  Bun.env[ENV_KEY] = "0";
  const response = await handleRunnerRequest(planRequest("run_capacity_1"));
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("30");
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.errorCode).toBe("capacity_exhausted");
  // The Cloudflare-side classifier matches this phrase; keep them aligned.
  expect(String(body.error)).toMatch(
    /maximum number of running container instances exceeded/i,
  );
});

test("non-run routes stay reachable in drain mode", async () => {
  Bun.env[ENV_KEY] = "0";
  const response = await handleRunnerRequest(
    new Request("https://runner.test/healthz"),
  );
  expect(response.status).toBe(200);
});
