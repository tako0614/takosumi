import { afterEach, describe, expect, test } from "bun:test";

import {
  attentionCount,
  attentionEvents,
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

/** One recorded event about an app, as the Activity trail stores it. */
function appEvent(
  id: string,
  action: string,
  capsuleId: string,
  createdAt: string,
  metadata: Record<string, unknown> = {},
  workspaceId = "workspace_a",
): FeedEntry {
  // Run events name the app in metadata; app lifecycle events target it.
  const capsuleTarget = action.startsWith("capsule.");
  const event: ActivityEvent = {
    id,
    workspaceId,
    action,
    targetType: capsuleTarget ? "capsule" : "run",
    targetId: capsuleTarget ? capsuleId : `run_${id}`,
    metadata: capsuleTarget ? metadata : { capsuleId, ...metadata },
    createdAt,
  };
  return { event, workspaceHandle: workspaceId };
}

function openIds(feed: readonly FeedEntry[]): string[] {
  const open = attentionEvents(feed);
  return feed.filter((item) => open.has(item.event)).map((item) => item.event.id);
}

describe("attention settles with later Activity of the same app", () => {
  test("a failed review of an app that was uninstalled since is history, not 要対応", () => {
    // Observed on production: eight never-applied apps were removed, yet the
    // page still said 要対応 7 件 and the bell 6 件 for their old review failures.
    const feed: readonly FeedEntry[] = [
      appEvent("abandon_a", "capsule.abandoned", "cap_a", "2026-10-29T03:00:00.000Z"),
      appEvent("abandon_b", "capsule.abandoned", "cap_b", "2026-10-29T03:00:01.000Z"),
      appEvent("fail_a", "run.failed", "cap_a", "2026-10-28T10:00:00.000Z", { phase: "plan", operation: "create" }),
      appEvent("fail_b", "run.failed", "cap_b", "2026-10-28T10:00:00.000Z", { phase: "plan", operation: "create" }),
      appEvent("fail_b2", "run.failed", "cap_b", "2026-10-28T11:00:00.000Z", { phase: "plan", operation: "create" }),
      appEvent("fail_live", "run.failed", "cap_live", "2026-10-28T12:00:00.000Z", { phase: "plan", operation: "create" }),
    ];
    expect(openIds(feed)).toEqual(["fail_live"]);
    expect(attentionCount(feed, "workspace_a")).toBe(1);
    // The settled failures stay in the feed itself.
    expect(feed.map((item) => item.event.id)).toContain("fail_a");
  });

  test("a destroyed app settles every failure about it, including ones after it was scheduled", () => {
    const feed: readonly FeedEntry[] = [
      appEvent("destroyed", "run.destroyed", "cap_a", "2026-10-29T03:00:00.000Z"),
      appEvent("blocked", "capsule.uninstall_blocked", "cap_a", "2026-10-29T02:00:00.000Z"),
      appEvent("drift", "capsule.drift_detected", "cap_a", "2026-10-29T01:00:00.000Z"),
      appEvent("dead", "interface_materialization.dead_lettered", "cap_a", "2026-10-29T00:00:00.000Z"),
    ];
    expect(openIds(feed)).toEqual([]);
    expect(attentionCount(feed)).toBe(0);
  });

  test("a later successful apply replaces a failed review, apply, drift or auto-update", () => {
    const feed: readonly FeedEntry[] = [
      appEvent("applied", "run.applied", "cap_a", "2026-10-29T03:00:00.000Z"),
      appEvent("plan", "run.failed", "cap_a", "2026-10-29T02:00:00.000Z", { phase: "plan", operation: "update" }),
      appEvent("apply", "run.failed", "cap_a", "2026-10-29T01:00:00.000Z", { phase: "apply", operation: "update" }),
      appEvent("drift", "capsule.drift_detected", "cap_a", "2026-10-29T00:30:00.000Z"),
      appEvent("auto", "capsule.auto_update_apply_failed", "cap_a", "2026-10-29T00:10:00.000Z"),
    ];
    expect(openIds(feed)).toEqual([]);
  });

  test("a failure after the last successful apply still needs attention", () => {
    const feed: readonly FeedEntry[] = [
      appEvent("plan_again", "run.failed", "cap_a", "2026-10-29T04:00:00.000Z", { phase: "plan", operation: "update" }),
      appEvent("applied", "run.applied", "cap_a", "2026-10-29T03:00:00.000Z"),
      appEvent("old_plan", "run.failed", "cap_a", "2026-10-29T02:00:00.000Z", { phase: "plan", operation: "update" }),
    ];
    expect(openIds(feed)).toEqual(["plan_again"]);
  });

  test("an apply does not settle a failed removal, a revoked connection or another app's failure", () => {
    const feed: readonly FeedEntry[] = [
      appEvent("applied", "run.applied", "cap_a", "2026-10-29T03:00:00.000Z"),
      appEvent("destroy_plan", "run.failed", "cap_a", "2026-10-29T02:00:00.000Z", { phase: "plan", operation: "destroy" }),
      appEvent("destroy_apply", "run.failed", "cap_a", "2026-10-29T01:30:00.000Z", { phase: "destroy_apply", operation: "destroy" }),
      appEvent("blocked", "capsule.uninstall_blocked", "cap_a", "2026-10-29T01:00:00.000Z"),
      appEvent("other_app", "run.failed", "cap_b", "2026-10-29T00:30:00.000Z", { phase: "apply" }),
      // The same app id in another Workspace is never mixed in.
      appEvent("other_ws", "run.failed", "cap_a", "2026-10-29T00:20:00.000Z", { phase: "apply" }, "workspace_b"),
      {
        event: {
          id: "revoked", workspaceId: "workspace_a", action: "connection.revoked", targetType: "connection",
          targetId: "pc_1", metadata: { provider: "cloudflare" }, createdAt: "2026-10-29T00:10:00.000Z",
        },
        workspaceHandle: "workspace_a",
      },
    ];
    expect(openIds(feed)).toEqual(["destroy_plan", "destroy_apply", "blocked", "other_app", "other_ws", "revoked"]);
  });

  test("cancelling a stopped uninstall settles the earlier stop, not a later one", () => {
    const feed: readonly FeedEntry[] = [
      appEvent("blocked_again", "capsule.uninstall_blocked", "cap_a", "2026-10-29T04:00:00.000Z"),
      appEvent("cancelled", "capsule.uninstall_cancelled", "cap_a", "2026-10-29T03:00:00.000Z"),
      appEvent("blocked", "capsule.uninstall_blocked", "cap_a", "2026-10-29T02:00:00.000Z"),
    ];
    expect(openIds(feed)).toEqual(["blocked_again"]);
  });

  test("events without an app keep the plain failure rule", () => {
    const feed: readonly FeedEntry[] = [
      entry("workspace_a", "run.applied"),
      entry("workspace_a", "run.failed"),
    ];
    // Neither event names an app, so the apply cannot settle the failure.
    expect(attentionCount(feed, "workspace_a")).toBe(1);
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
