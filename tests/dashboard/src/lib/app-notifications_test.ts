import { afterEach, expect, test } from "bun:test";
import {
  notificationFeed,
  refreshNotificationFeed,
} from "../../../../dashboard/src/lib/notifications.ts";
import {
  clearSession,
  refreshSession,
} from "../../../../dashboard/src/views/account/lib/session.ts";

const realFetch = globalThis.fetch;
const sessionPath = "/api/v1/dashboard/bootstrap?includeWorkspaces=false";
const notificationsPath = `${sessionPath}&includeNotifications=true`;

afterEach(() => {
  clearSession();
  globalThis.fetch = realFetch;
});

function entry(subject: string) {
  return {
    workspaceHandle: "internal-partition",
    event: {
      id: `event_${subject}`, workspaceId: "internal-partition",
      action: "run.failed", targetType: "run", targetId: `run_${subject}`,
      metadata: { capsuleId: `app_${subject}` }, createdAt: "2026-11-04T00:00:00Z",
    },
  };
}

test("app notifications load without listing Workspaces", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path === notificationsPath) return Response.json({ notifications: [entry("a")] });
    return Response.json({ error: "legacy_listing_unavailable" }, { status: 503 });
  }) as typeof fetch;
  expect(await refreshNotificationFeed({ force: true })).toEqual([entry("a")]);
  expect(calls).toEqual([notificationsPath]);
});

test("changing the signed-in account drops the previous notification snapshot", async () => {
  let subject = "a";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === sessionPath) return Response.json({ session: { subject } });
    if (path.startsWith("/api/v1/dashboard/bootstrap?")) {
      return Response.json({ notifications: [entry(subject)] });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  await refreshSession();
  await refreshNotificationFeed({ force: true });
  expect(notificationFeed()).toEqual([entry("a")]);
  subject = "b";
  await refreshSession();
  expect(notificationFeed()).toBeUndefined();
  expect(await refreshNotificationFeed()).toEqual([entry("b")]);
});

test("a delayed previous-account response cannot repopulate the feed after sign-out", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { release = resolve; });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/v1/dashboard/bootstrap?")) return pending;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const stale = refreshNotificationFeed({ force: true });
  clearSession();
  release(Response.json({ notifications: [entry("a")] }));
  await stale;
  expect(notificationFeed()).toBeUndefined();
});

test("the next account never shares a pending notification request with the previous one", async () => {
  let subject = "a";
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { release = resolve; });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === sessionPath) return Response.json({ session: { subject } });
    if (path === notificationsPath) {
      return subject === "a" ? pending : Response.json({ notifications: [entry("b")] });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  await refreshSession();
  const stale = refreshNotificationFeed({ force: true });
  subject = "b";
  await refreshSession();
  expect(await refreshNotificationFeed()).toEqual([entry("b")]);
  release(Response.json({ notifications: [entry("a")] }));
  await stale;
  expect(notificationFeed()).toEqual([entry("b")]);
});

test("a failed notification read remains an error rather than an empty feed", async () => {
  globalThis.fetch = (async () => Response.json({ error: "unavailable" }, { status: 503 })) as typeof fetch;
  await expect(refreshNotificationFeed({ force: true })).rejects.toMatchObject({ status: 503 });
  expect(notificationFeed()).toBeUndefined();
});
