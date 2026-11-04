import { afterEach, expect, test } from "bun:test";
import {
  listCapsuleActivity,
  listRecentCapsuleRuns,
} from "../../../../dashboard/src/lib/control-api.ts";
import { clearSharedAuthSessionPreflight } from "../../../../dashboard/src/lib/shared-auth-session-preflight.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearSharedAuthSessionPreflight();
});

function run(index: number) {
  return {
    id: `run_${index}`, capsuleId: "cap_shared", workspaceId: "ws_internal",
    type: "apply", status: "failed", planRunId: "plan_shared",
    createdBy: "member", createdAt: "2026-11-04T00:00:00Z",
  };
}

test("a shared app's 200-row approval window follows its app pages without Workspace membership", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path === "/api/v1/capsules/cap_shared/runs?limit=100") {
      return Response.json({ runs: Array.from({ length: 100 }, (_, i) => run(i)), nextCursor: "older" });
    }
    if (path === "/api/v1/capsules/cap_shared/runs?limit=100&cursor=older") {
      return Response.json({ runs: Array.from({ length: 100 }, (_, i) => run(i + 100)) });
    }
    return Response.json({ error: "forbidden" }, { status: 403 });
  }) as typeof fetch;
  expect(await listRecentCapsuleRuns("cap_shared", 200)).toHaveLength(200);
  expect(calls).toEqual([
    "/api/v1/capsules/cap_shared/runs?limit=100",
    "/api/v1/capsules/cap_shared/runs?limit=100&cursor=older",
  ]);
});

test("Apply timeout recovery requests only its app's newest 30 Runs", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return Response.json({ runs: [run(1)] });
  }) as typeof fetch;
  expect((await listRecentCapsuleRuns("cap_shared", 30))[0]?.planRunId).toBe("plan_shared");
  expect(calls).toEqual(["/api/v1/capsules/cap_shared/runs?limit=30"]);
});

test("an incomplete or non-advancing run window fails rather than claiming approval is open", async () => {
  let reads = 0;
  globalThis.fetch = (async () => {
    reads++;
    return Response.json({ runs: [], nextCursor: "unchanged" });
  }) as typeof fetch;
  await expect(listRecentCapsuleRuns("cap_shared", 200)).rejects.toMatchObject({ status: 502 });
  expect(reads).toBeLessThanOrEqual(2);
});

test("app Activity uses its authorized route and never falls back after a denial", async () => {
  const calls: string[] = [];
  let denied = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (denied) return Response.json({ error: "forbidden" }, { status: 403 });
    return Response.json({ events: [{
      id: "act_release", workspaceId: "ws_internal", action: "release_activation.succeeded",
      metadata: { capsuleId: "cap_shared" }, createdAt: "2026-11-04T00:00:00Z",
    }] });
  }) as typeof fetch;
  expect((await listCapsuleActivity("cap_shared", 100))[0]?.action).toBe("release_activation.succeeded");
  denied = true;
  await expect(listCapsuleActivity("cap_shared", 100)).rejects.toMatchObject({ status: 403 });
  expect(calls).toEqual(Array(2).fill("/api/v1/capsules/cap_shared/activity?limit=100"));
});

test("a malformed Activity response remains unreadable instead of empty", async () => {
  globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;
  await expect(listCapsuleActivity("cap_shared", 100)).rejects.toMatchObject({ status: 502 });
});

test("app Activity follows sparse pages before deciding release activation", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    return Response.json(calls.length === 1
      ? { events: [], nextCursor: "hidden_rows" }
      : { events: [{ id: "act_pending", action: "release_activation.pending" }] });
  }) as typeof fetch;
  expect((await listCapsuleActivity("cap_shared", 100))[0]?.action).toBe("release_activation.pending");
  expect(calls).toEqual([
    "/api/v1/capsules/cap_shared/activity?limit=100",
    "/api/v1/capsules/cap_shared/activity?limit=100&cursor=hidden_rows",
  ]);
});

test("a failed Activity page never exposes its partial window as ready", async () => {
  let reads = 0;
  globalThis.fetch = (async () => ++reads === 1
    ? Response.json({ events: [], nextCursor: "more" })
    : Response.json({ error: "unavailable" }, { status: 503 })
  ) as typeof fetch;
  await expect(listCapsuleActivity("cap_shared", 100)).rejects.toMatchObject({ status: 503 });
  expect(reads).toBe(2);
});

test("unbounded sparse Activity and explicitly incomplete coverage stay unavailable", async () => {
  let reads = 0;
  globalThis.fetch = (async () => Response.json({ events: [], nextCursor: `cursor_${++reads}` })) as typeof fetch;
  await expect(listCapsuleActivity("cap_shared", 100)).rejects.toMatchObject({ status: 502 });
  expect(reads).toBe(10);
  globalThis.fetch = (async () => Response.json({ events: [], incomplete: true })) as typeof fetch;
  await expect(listCapsuleActivity("cap_shared", 100)).rejects.toMatchObject({ status: 502 });
});
