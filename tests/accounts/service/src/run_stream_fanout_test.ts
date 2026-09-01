/**
 * Shared SSE fan-out (B-W4): one poll loop per run serves every subscribed
 * viewer, replacing the per-viewer controller read loop; a terminal run
 * closes immediately with one snapshot frame.
 */
import { expect, test } from "bun:test";

import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { handleRuns } from "../../../../accounts/service/src/control/runs.ts";
import type { ControlDispatchContext } from "../../../../accounts/service/src/control/shared.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

const WORKSPACE = {
  id: "ws_stream",
  handle: "stream",
  displayName: "Stream",
  type: "personal" as const,
  ownerUserId: "tsub_owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function streamOperations(input: {
  readonly status: () => string;
  readonly onGetRun?: () => void;
}): ControlPlaneOperations {
  return {
    getRun: async (runId: string) => {
      input.onGetRun?.();
      return {
        id: runId,
        workspaceId: WORKSPACE.id,
        status: input.status(),
        operation: "update",
        createdAt: 1,
        updatedAt: 1,
      };
    },
    workspaces: {
      getWorkspace: async () => WORKSPACE,
    },
    members: {
      listMembers: async () => [],
    },
  } as unknown as ControlPlaneOperations;
}

function streamContext(
  operations: ControlPlaneOperations,
  abort?: AbortSignal,
): ControlDispatchContext {
  const url = new URL("https://app.example.test/api/v1/runs/run_s1/stream");
  return {
    request: new Request(url, {
      ...(abort ? { signal: abort } : {}),
    }),
    url,
    operations,
    store: new InMemoryAccountsStore(),
    session: { subject: "tsub_owner", requiredAccess: "read" },
  };
}

async function readFrames(
  response: Response,
  maxMs: number,
): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), deadline - Date.now()),
      ),
    ]);
    if (next === "timeout") break;
    if (next.done) break;
    frames.push(decoder.decode(next.value));
  }
  await reader.cancel().catch(() => undefined);
  return frames;
}

test("a terminal run streams one snapshot frame and closes", async () => {
  const operations = streamOperations({ status: () => "succeeded" });
  const response = await handleRuns(
    streamContext(operations),
    ["runs", "run_s1", "stream"],
    "GET",
  );
  expect(response?.headers.get("content-type")).toContain("text/event-stream");
  const frames = await readFrames(response!, 500);
  expect(frames.join("")).toContain('"status":"succeeded"');
});

test("concurrent viewers share ONE poll loop instead of polling per viewer", async () => {
  let reads = 0;
  const operations = streamOperations({
    status: () => "running",
    onGetRun: () => {
      reads += 1;
    },
  });
  const abortA = new AbortController();
  const abortB = new AbortController();
  const [responseA, responseB] = await Promise.all([
    handleRuns(
      streamContext(operations, abortA.signal),
      ["runs", "run_s1", "stream"],
      "GET",
    ),
    handleRuns(
      streamContext(operations, abortB.signal),
      ["runs", "run_s1", "stream"],
      "GET",
    ),
  ]);
  const [framesA, framesB] = await Promise.all([
    readFrames(responseA!, 3200),
    readFrames(responseB!, 3200),
  ]);
  abortA.abort();
  abortB.abort();
  // Both viewers got the initial snapshot.
  expect(framesA.join("")).toContain('"status":"running"');
  expect(framesB.join("")).toContain('"status":"running"');
  // ~3.2s covers the 2 handleRuns pre-reads + at most ONE shared hub tick.
  // The per-viewer loop would have produced 2 hub-tick reads here.
  expect(reads).toBeLessThanOrEqual(3);
});
