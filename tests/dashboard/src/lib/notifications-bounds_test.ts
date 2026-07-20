import { afterEach, describe, expect, test } from "bun:test";
import {
  loadNotificationFeed,
  NOTIF_FANOUT_CONCURRENCY,
  NOTIF_WORKSPACE_LIMIT,
  notificationFeed,
  refreshNotificationFeed,
} from "../../../../dashboard/src/lib/notifications.ts";
import type { Workspace } from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function workspace(index: number): Workspace {
  const day = String(index + 1).padStart(2, "0");
  return {
    id: `ws_${index}`,
    handle: `workspace-${index}`,
    displayName: `Workspace ${index}`,
    type: "personal",
    ownerUserId: "user_1",
    createdAt: `2026-06-${day}T00:00:00.000Z`,
    updatedAt: `2026-06-${day}T00:00:00.000Z`,
  };
}

function installScopedFeedFetch(): string[] {
  const bootstrapRequests: string[] = [];
  const selected = (id: string): Workspace => ({
    ...workspace(id === "ws_a" ? 0 : 1),
    id,
    handle: id,
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.startsWith("/api/v1/dashboard/bootstrap?")) {
      const id = new URL(path, "https://dashboard.test").searchParams.get(
        "workspaceId",
      );
      if (id !== "ws_a" && id !== "ws_b") {
        throw new Error(`unexpected selected Workspace: ${id ?? "missing"}`);
      }
      bootstrapRequests.push(id);
      await new Promise((resolve) =>
        setTimeout(resolve, id === "ws_a" ? 10 : 1),
      );
      return Response.json({
        workspaces: [selected(id)],
        workspaceList: {
          returned: 1,
          limit: NOTIF_WORKSPACE_LIMIT,
          truncated: false,
        },
        notifications: [
          {
            workspaceHandle: id,
            event: {
              id: `act_${id}`,
              workspaceId: id,
              action: "run.applied",
              targetType: "run",
              targetId: `run_${id}`,
              metadata: {},
              createdAt: "2026-07-20T00:00:00.000Z",
            },
          },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  return bootstrapRequests;
}

describe("notification fan-out bounds", () => {
  test("loads only recent Workspaces plus current with capped concurrency", async () => {
    const requested: string[] = [];
    let active = 0;
    let maxActive = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      const match = path.match(/^\/api\/v1\/workspaces\/(ws_\d+)\/activity/);
      if (!match?.[1]) throw new Error(`unexpected fetch: ${path}`);
      requested.push(match[1]);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return new Response(
        JSON.stringify({
          events: [
            {
              id: `act_${match[1]}`,
              workspaceId: match[1],
              action: "run.applied",
              targetType: "run",
              targetId: `run_${match[1]}`,
              metadata: {},
              createdAt: "2026-07-20T00:00:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const workspaces = Array.from({ length: 20 }, (_, index) =>
      workspace(index),
    );
    const feed = await loadNotificationFeed(workspaces, {
      selectedWorkspaceId: "ws_0",
    });

    expect(requested).toHaveLength(NOTIF_WORKSPACE_LIMIT + 1);
    expect(new Set(requested)).toEqual(
      new Set([
        "ws_0",
        ...Array.from(
          { length: NOTIF_WORKSPACE_LIMIT },
          (_, offset) => `ws_${19 - offset}`,
        ),
      ]),
    );
    expect(maxActive).toBeLessThanOrEqual(NOTIF_FANOUT_CONCURRENCY);
    expect(feed).toHaveLength(NOTIF_WORKSPACE_LIMIT + 1);
  });

  test("does not share or publish an in-flight feed for a stale selected Workspace", async () => {
    installScopedFeedFetch();

    const stale = refreshNotificationFeed({
      force: true,
      selectedWorkspaceId: "ws_a",
    });
    await Promise.resolve();
    const current = refreshNotificationFeed({
      force: true,
      selectedWorkspaceId: "ws_b",
    });
    const [staleEntries, currentEntries] = await Promise.all([stale, current]);

    expect(staleEntries[0]?.event.workspaceId).toBe("ws_a");
    expect(currentEntries[0]?.event.workspaceId).toBe("ws_b");
    expect(notificationFeed()?.[0]?.event.workspaceId).toBe("ws_b");
  });

  test("A to B to A reuses A in-flight but publishes the latest A scope", async () => {
    const workspaceRequests = installScopedFeedFetch();
    const firstA = refreshNotificationFeed({
      force: true,
      selectedWorkspaceId: "ws_a",
    });
    await Promise.resolve();
    const middleB = refreshNotificationFeed({
      force: true,
      selectedWorkspaceId: "ws_b",
    });
    await Promise.resolve();
    const latestA = refreshNotificationFeed({
      force: true,
      selectedWorkspaceId: "ws_a",
    });

    const [, , latestEntries] = await Promise.all([firstA, middleB, latestA]);
    expect(workspaceRequests).toEqual(["ws_a", "ws_b"]);
    expect(latestEntries[0]?.event.workspaceId).toBe("ws_a");
    expect(notificationFeed()?.[0]?.event.workspaceId).toBe("ws_a");
  });
});
