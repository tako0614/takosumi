import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  clearNotificationFeeds,
  notificationFeed,
  refreshNotificationFeed,
  refreshWorkspaceNotificationFeed,
  workspaceNotificationFeed,
} from "../../../dashboard/src/lib/notifications.ts";
import { clearSession, onSessionStateChange } from "../../../dashboard/src/views/account/lib/session.ts";

// Loaded by the parent test with --conditions=browser so production imports
// and this root use Solid's real reactive runtime, not its inert SSR build.
const solid = await import(resolve(import.meta.dir, "../../../dashboard/node_modules/solid-js/dist/solid.js"));
const realFetch = globalThis.fetch;
afterEach(() => {
  clearNotificationFeeds();
  globalThis.fetch = realFetch;
});

for (const legacy of [false, true]) {
  test(`sign-out never restarts the ${legacy ? "legacy" : "app"} feed through a navigation effect`, async () => {
    clearNotificationFeeds();
    let calls = 0;
    const event = {
      id: "old_event", workspaceId: "ws_old", action: "run.failed",
      targetType: "run", targetId: "old_run", metadata: {},
      createdAt: "2026-11-04T00:00:00Z",
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/account/session/me") return new Response(null, { status: 204 });
      calls++;
      return Response.json(legacy
        ? { events: [event] }
        : { notifications: [{ workspaceHandle: "old", event }] });
    }) as typeof fetch;
    const refresh = () => legacy
      ? refreshWorkspaceNotificationFeed("ws_old")
      : refreshNotificationFeed();
    await refresh();
    let dispose!: () => void;
    solid.createRoot((stop: () => void) => {
      dispose = stop;
      solid.createEffect(() => { void refresh().catch(() => {}); });
    });
    const off = onSessionStateChange((state) => {
      if (state.kind === "unauthenticated") dispose();
    });
    try {
      expect(calls).toBe(1);
      clearSession();
      await new Promise((done) => setTimeout(done, 0));
      expect(calls).toBe(1);
      expect(notificationFeed()).toBeUndefined();
      expect(workspaceNotificationFeed("ws_old")).toBeUndefined();
    } finally {
      off();
      dispose();
    }
  });
}
