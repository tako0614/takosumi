import { afterEach, describe, expect, test } from "bun:test";
import {
  planCapsuleUpdate,
  waitForLatestSourceSnapshot,
} from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const OLD_SNAPSHOT = {
  id: "snap_old",
  origin: "git",
  workspaceId: "workspace_1",
  sourceId: "src_1",
  url: "https://example.test/app.git",
  ref: "main",
  resolvedCommit: "a".repeat(40),
  path: ".",
  archiveObjectKey: "sources/snap_old.tar.zst",
  archiveDigest: `sha256:${"a".repeat(64)}`,
  archiveSizeBytes: 1,
  fetchedByRunId: "ssr_old",
  fetchedAt: "2026-07-10T00:00:00.000Z",
} as const;

const NEW_SNAPSHOT = {
  ...OLD_SNAPSHOT,
  id: "snap_new",
  resolvedCommit: "b".repeat(40),
  archiveObjectKey: "sources/snap_new.tar.zst",
  archiveDigest: `sha256:${"b".repeat(64)}`,
  fetchedByRunId: "ssr_new",
  fetchedAt: "2026-07-10T00:01:00.000Z",
} as const;

describe("SourceSnapshot update pinning", () => {
  test("waits for the requested sync instead of accepting an older snapshot", async () => {
    let runReads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/runs/ssr_new") {
        runReads += 1;
        return json({
          run:
            runReads === 1
              ? {
                  id: "ssr_new",
                  type: "source_sync",
                  status: "running",
                  workspaceId: "workspace_1",
                  createdAt: "2026-07-10T00:00:30.000Z",
                }
              : {
                  id: "ssr_new",
                  type: "source_sync",
                  status: "succeeded",
                  workspaceId: "workspace_1",
                  sourceSnapshotId: "snap_new",
                  createdAt: "2026-07-10T00:00:30.000Z",
                },
        });
      }
      if (url === "/api/v1/sources/src_1/snapshots") {
        return json({
          snapshots:
            runReads === 1 ? [OLD_SNAPSHOT] : [OLD_SNAPSHOT, NEW_SNAPSHOT],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const snapshot = await waitForLatestSourceSnapshot("src_1", {
      runId: "ssr_new",
      timeoutMs: 1_000,
      pollMs: 1,
      maxPollMs: 1,
    });

    expect(snapshot.id).toBe("snap_new");
    expect(runReads).toBe(2);
  });

  test("manual update runs sync, exact compatibility, then plan in order", async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, ...(body === undefined ? {} : { body }) });

      if (url === "/api/v1/capsules/cap_1") {
        return json({
          capsule: {
            id: "cap_1",
            workspaceId: "workspace_1",
            name: "app",
            slug: "app",
            sourceId: "src_1",
            installConfigId: "cfg_1",
            environment: "production",
            currentStateGeneration: 1,
            status: "active",
            autoUpdate: true,
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z",
          },
        });
      }
      if (url === "/api/v1/sources/src_1/sync") {
        return json({ run: { id: "ssr_new" } }, 201);
      }
      if (url === "/api/v1/runs/ssr_new") {
        return json({
          run: {
            id: "ssr_new",
            type: "source_sync",
            status: "succeeded",
            workspaceId: "workspace_1",
            sourceSnapshotId: "snap_new",
            createdAt: "2026-07-10T00:00:30.000Z",
          },
        });
      }
      if (url === "/api/v1/sources/src_1/snapshots") {
        return json({ snapshots: [OLD_SNAPSHOT, NEW_SNAPSHOT] });
      }
      if (url === "/api/v1/sources/src_1/compatibility-check") {
        return json({ report: { id: "caprep_new" } }, 201);
      }
      if (url === "/api/v1/capsules/cap_1/plan") {
        return json({ run: { id: "plan_new" } }, 201);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    expect(await planCapsuleUpdate("cap_1")).toEqual({
      run: { id: "plan_new" },
    });
    expect(calls).toEqual([
      { url: "/api/v1/capsules/cap_1", method: "GET" },
      {
        url: "/api/v1/sources/src_1/sync",
        method: "POST",
        body: { intent: "manual_plan" },
      },
      { url: "/api/v1/runs/ssr_new", method: "GET" },
      { url: "/api/v1/sources/src_1/snapshots", method: "GET" },
      {
        url: "/api/v1/sources/src_1/compatibility-check",
        method: "POST",
        body: { sourceSnapshotId: "snap_new", capsuleId: "cap_1" },
      },
      {
        url: "/api/v1/capsules/cap_1/plan",
        method: "POST",
        body: { compatibilityReportId: "caprep_new" },
      },
    ]);
  });
});
