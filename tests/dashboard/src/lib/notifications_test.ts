import { describe, expect, test } from "bun:test";

import {
  attentionCount,
  type FeedEntry,
} from "../../../../dashboard/src/lib/notifications.ts";
import type { ActivityEvent } from "../../../../dashboard/src/lib/control-api.ts";

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
    entry("workspace_b", "installation.drift_detected"),
  ];

  test("counts only the CURRENT workspace's failures when scoped", () => {
    // The bell badge / 要対応 banner must not keep the previous Workspace's
    // count after a switch — the feed stays cross-Workspace, the COUNT does not.
    expect(attentionCount(feed, "workspace_a")).toBe(1);
    expect(attentionCount(feed, "workspace_b")).toBe(2);
    expect(attentionCount(feed, "workspace_c")).toBe(0);
  });

  test("no scope (no workspace selected) counts every workspace", () => {
    expect(attentionCount(feed)).toBe(3);
    expect(attentionCount(feed, undefined)).toBe(3);
    expect(attentionCount(feed, "")).toBe(3);
  });

  test("empty feed counts zero", () => {
    expect(attentionCount(undefined, "workspace_a")).toBe(0);
    expect(attentionCount([], "workspace_a")).toBe(0);
  });
});
