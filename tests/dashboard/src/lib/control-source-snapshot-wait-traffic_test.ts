import { afterEach, expect, test } from "bun:test";
import {
  ControlApiError,
  waitForLatestSourceSnapshot,
  type SourceSnapshot,
} from "../../../../dashboard/src/lib/control-api.ts";

// The Source-sync wait is the longest wait an install performs: the Run that
// produces the Snapshot regularly takes more than 20 s in a hosted runner. The
// loop used to list the (paginated) Snapshot history on every iteration even
// though it refuses to accept a Snapshot listed before the Run reports
// `succeeded`. These tests count the requests the loop issues against a stub
// control plane and pin the accepted-Snapshot rules while doing so.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const commit = "a".repeat(40);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function snapshot(id: string, fetchedAt: string): SourceSnapshot {
  return {
    id,
    origin: "git",
    workspaceId: "workspace_1",
    sourceId: "source_1",
    url: "https://example.test/service.git",
    ref: "main",
    resolvedCommit: commit,
    path: ".",
    archiveRef: `sources/${id}.tar.zst`,
    archiveDigest: `sha256:${"c".repeat(64)}`,
    archiveSizeBytes: 1,
    fetchedByRunId: "run_1",
    fetchedAt,
  };
}

function run(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    workspaceId: "workspace_1",
    type: "source_sync",
    status,
    requestedBy: "user_1",
    createdAt: "2026-09-29T00:00:00.000Z",
    ...extra,
  };
}

interface StubInput {
  /** Run status per Run read, in order; the last entry repeats. */
  readonly runStatuses: readonly string[];
  /** Paginated Snapshot listing: one entry per page. */
  readonly snapshotPages: readonly (readonly SourceSnapshot[])[];
  readonly snapshotIdOnSuccess?: string;
}

function stubControlPlane(input: StubInput) {
  const requests: string[] = [];
  let runReads = 0;
  globalThis.fetch = (async (
    fetchInput: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(String(fetchInput), "http://dashboard.test");
    const path = url.pathname;
    if (path === "/api/v1/runs/run_1") {
      requests.push("run");
      const status =
        input.runStatuses[Math.min(runReads, input.runStatuses.length - 1)] ??
        "running";
      runReads += 1;
      return json({
        run: run(status, {
          ref: "main",
          ...(status === "succeeded" && input.snapshotIdOnSuccess
            ? { sourceSnapshotId: input.snapshotIdOnSuccess }
            : {}),
        }),
      });
    }
    if (path === "/api/v1/runs/run_1/logs") {
      requests.push("run_logs");
      return json({ diagnostics: [] });
    }
    if (path === "/api/v1/sources/source_1/snapshots") {
      requests.push("snapshots");
      const cursor = url.searchParams.get("cursor");
      const index = cursor === null ? 0 : Number(cursor);
      const page = input.snapshotPages[index] ?? [];
      const next = index + 1 < input.snapshotPages.length;
      return json({
        snapshots: page,
        ...(next ? { nextCursor: String(index + 1) } : {}),
      });
    }
    void init;
    return json({ error: "unexpected_request", path }, 500);
  }) as typeof fetch;
  return { requests };
}

test("a waiting Source sync polls the Run only, and resolves the named Snapshot once", async () => {
  const stub = stubControlPlane({
    runStatuses: ["queued", "running", "running", "running", "succeeded"],
    snapshotIdOnSuccess: "snap_1",
    // Three pages of history. The Run's own Snapshot is on the first page, so a
    // lookup that stops at the matching page reads one page, not three.
    snapshotPages: [
      [snapshot("snap_1", "2026-09-29T00:00:10.000Z")],
      [snapshot("snap_old", "2026-09-29T00:00:00.000Z")],
      [snapshot("snap_older", "2026-09-28T00:00:00.000Z")],
    ],
  });

  const resolved = await waitForLatestSourceSnapshot("source_1", {
    runId: "run_1",
    pollMs: 0,
    maxPollMs: 0,
    timeoutMs: 30_000,
  });

  expect(resolved.id).toBe("snap_1");
  expect(stub.requests.filter((entry) => entry === "run").length).toBe(5);
  expect(stub.requests.filter((entry) => entry === "snapshots").length).toBe(1);
  // The listing happens after the Run reported success, never while it was
  // still queued or running: a pre-existing Snapshot must not be accepted.
  expect(stub.requests.indexOf("snapshots")).toBe(5);
});

test("a failed Source sync keeps its diagnostics listing without polling it", async () => {
  const stub = stubControlPlane({
    runStatuses: ["running", "failed"],
    snapshotPages: [[snapshot("snap_old", "2026-09-29T00:00:00.000Z")]],
  });

  const failure = await waitForLatestSourceSnapshot("source_1", {
    runId: "run_1",
    pollMs: 0,
    maxPollMs: 0,
    timeoutMs: 30_000,
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(ControlApiError);
  const apiError = failure as ControlApiError;
  expect(apiError.status).toBe(409);
  expect(apiError.code).toBe("source_sync_failed");
  // ControlApiError carries the server payload as `body`, not `context`.
  const context = apiError.body as { snapshots?: readonly SourceSnapshot[] };
  expect(context.snapshots?.map((entry) => entry.id)).toEqual(["snap_old"]);
  expect(stub.requests.filter((entry) => entry === "snapshots").length).toBe(1);
});

test("without a Run the Snapshot listing is still the poll", async () => {
  const stub = stubControlPlane({
    runStatuses: ["running"],
    snapshotPages: [
      [snapshot("snap_old", "2026-09-28T00:00:00.000Z")],
      [snapshot("snap_new", "2026-09-29T00:00:00.000Z")],
    ],
  });

  const resolved = await waitForLatestSourceSnapshot("source_1", {
    pollMs: 0,
    maxPollMs: 0,
    timeoutMs: 30_000,
  });

  expect(resolved.id).toBe("snap_new");
  expect(stub.requests.filter((entry) => entry === "snapshots").length).toBe(2);
});
