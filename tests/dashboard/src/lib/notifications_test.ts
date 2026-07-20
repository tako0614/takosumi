import { afterEach, describe, expect, test } from "bun:test";

import {
  attentionCount,
  type FeedEntry,
  refreshWorkspaceNotificationFeed,
  workspaceNotificationFeed,
} from "../../../../dashboard/src/lib/notifications.ts";
import type { ActivityEvent } from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function entry(
  workspaceId: string,
  action: string,
  handle = workspaceId,
): FeedEntry {
  const event: ActivityEvent = {
    id: `evt_${workspaceId}_${action}`,
    workspaceId,
    action,
    targetType: "run",
    targetId: "run_1",
    metadata: {},
    createdAt: "2026-07-01T00:00:00.000Z",
  };
  return { event, workspaceHandle: handle };
}

describe("attentionCount workspace scoping", () => {
  const feed: readonly FeedEntry[] = [
    entry("workspace_a", "run.failed"),
    entry("workspace_a", "run.applied"),
    entry("workspace_b", "run.failed"),
    entry("workspace_b", "capsule.drift_detected"),
    entry("workspace_b", "resource.drift_detected"),
  ];

  test("counts only the CURRENT workspace's failures when scoped", () => {
    // The bell badge / 要対応 banner must not keep the previous Workspace's
    // count after a switch — the feed stays cross-Workspace, the COUNT does not.
    expect(attentionCount(feed, "workspace_a")).toBe(1);
    expect(attentionCount(feed, "workspace_b")).toBe(3);
    expect(attentionCount(feed, "workspace_c")).toBe(0);
  });

  test("no scope (no workspace selected) counts every workspace", () => {
    expect(attentionCount(feed)).toBe(4);
    expect(attentionCount(feed, undefined)).toBe(4);
    expect(attentionCount(feed, "")).toBe(4);
  });

  test("empty feed counts zero", () => {
    expect(attentionCount(undefined, "workspace_a")).toBe(0);
    expect(attentionCount([], "workspace_a")).toBe(0);
  });
});

describe("Workspace-scoped TopBar notification feed", () => {
  test("uses one Activity request and never lists every Workspace", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      return new Response(
        JSON.stringify({
          events: [entry("workspace_badge", "run.failed").event],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const loaded = await refreshWorkspaceNotificationFeed("workspace_badge", {
      force: true,
    });

    expect(calls).toEqual([
      "/api/v1/workspaces/workspace_badge/activity?limit=50",
    ]);
    expect(loaded).toHaveLength(1);
    expect(workspaceNotificationFeed("workspace_badge")).toEqual(loaded);
  });

  test("shares a concurrent scoped Activity request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return new Response(JSON.stringify({ events: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const [first, second] = await Promise.all([
      refreshWorkspaceNotificationFeed("workspace_concurrent", {
        force: true,
      }),
      refreshWorkspaceNotificationFeed("workspace_concurrent", {
        force: true,
      }),
    ]);

    expect(calls).toBe(1);
    expect(first).toEqual(second);
  });
});
