import { afterEach, beforeAll, expect, jest, test } from "bun:test";
import {
  createTakosumiProductCapabilities,
  createTakosumiWellKnownDocument,
  TAKOSUMI_SHARED_DASHBOARD_SESSION_CAPABILITY as capability,
  TAKOSUMI_SHARED_DASHBOARD_SESSION_PATH as coldPath,
  TAKOSUMI_SHARED_DASHBOARD_SESSION_PROOF_HEADER as proof,
} from "takosumi-contract";
import { initializeTakosumiRuntimeCapabilities } from "../../../../dashboard/src/lib/runtime-capabilities.ts";
import { fetchDashboardBootstrap } from "../../../../dashboard/src/lib/dashboard-bootstrap.ts";
import { controlFetch } from "../../../../dashboard/src/lib/control-api.ts";
import {
  canReuseRecentSharedAuthProbe,
  isHostedSessionUnavailable,
} from "../../../../dashboard/src/lib/shared-auth-session-preflight.ts";
import {
  clearSession,
  initialSessionOptions,
  readSession,
  refreshSessionState,
  signOutSession,
} from "../../../../dashboard/src/views/account/lib/session.ts";

const realFetch = globalThis.fetch;
const health = "/auth/oidc/session";
const ordinary = "/api/v1/dashboard/bootstrap?includeWorkspaces=false";
const notifications = ordinary + "&includeNotifications=true";
const marked = { [proof]: "1" };
const session = { session: { subject: "tsub_fixture" } };
const unavailable = { error: { code: "oidc_unavailable" } };
const absent = {
  "cache-control": "no-store",
  "x-takosumi-shared-auth-absent": "1",
};

beforeAll(async () => {
  const options = { origin: "https://app.example.test", extensions: [capability] };
  await initializeTakosumiRuntimeCapabilities(async (input) => Response.json(
    new URL(String(input)).pathname === "/.well-known/takosumi"
      ? createTakosumiWellKnownDocument(options)
      : createTakosumiProductCapabilities(options),
  ), options.origin);
});

afterEach(() => {
  clearSession();
  globalThis.fetch = realFetch;
});

function stub(handle: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    calls.push(path);
    return handle(path, init);
  }) as typeof fetch;
  return calls;
}

test("the advertised cold route supplies the shared session once and leaves notifications optional", async () => {
  const calls = stub((path, init) => {
    if (path === coldPath) {
      expect(init?.method).toBe("GET");
      expect(init?.credentials).toBe("include");
      expect(init?.cache).toBe("no-store");
      expect(init?.redirect).toBe("error");
      return Response.json(session, { headers: marked });
    }
    if (path === notifications) return Response.json({ error: "unavailable" }, { status: 503 });
    if (path === health) return Response.json({ error: "unavailable" }, { status: 503 });
    throw new Error(`unexpected ${path}`);
  });
  const [first, duplicate] = await Promise.all([
    refreshSessionState(initialSessionOptions), refreshSessionState(initialSessionOptions),
  ]);
  expect(first).toMatchObject({ kind: "authenticated", ...session });
  expect(duplicate).toEqual(first);
  expect(calls).toEqual([coldPath]);
  expect(canReuseRecentSharedAuthProbe()).toBe(true);
  await expect(fetchDashboardBootstrap({ includeNotifications: true })).rejects.toMatchObject({ status: 503 });
  expect(readSession()).toMatchObject(session.session);
  expect(calls).toEqual([coldPath, notifications]);
  await expect(controlFetch("/api/v1/capsules", { method: "POST", reuseRecentSharedAuthProbe: true }))
    .rejects.toMatchObject({ status: 503 });
  expect(calls).toEqual([coldPath, notifications, health]);
});

test("rollback with a stale capability only uses the old health-to-bootstrap flow after the reserved 404", async () => {
  const calls = stub((path) => {
    if (path === coldPath) return Response.json({ error: "not found" }, { status: 404 });
    if (path === health) return Response.json({ authenticated: true });
    if (path === ordinary) return Response.json(session);
    throw new Error(`unexpected ${path}`);
  });
  expect(await refreshSessionState(initialSessionOptions)).toMatchObject({ kind: "authenticated", ...session });
  expect(calls).toEqual([coldPath, health, ordinary]);
});

test("a proved 401 retires the cold availability and does not read the ordinary session", async () => {
  const calls = stub(() => Response.json({ error: "unauthenticated" }, { status: 401, headers: marked }));
  expect(await refreshSessionState(initialSessionOptions)).toEqual({ kind: "unauthenticated" });
  expect(calls).toEqual([coldPath]);
  expect(canReuseRecentSharedAuthProbe()).toBe(false);
});

test("cold bootstrap retries an explicit Hosted unavailable result before the successful read", async () => {
  let attempts = 0;
  const calls = stub(() => ++attempts === 1
    ? Response.json(unavailable, { status: 503, headers: marked })
    : Response.json(session, { headers: marked }));
  expect(await refreshSessionState(initialSessionOptions)).toMatchObject({ kind: "authenticated", ...session });
  expect(calls).toEqual([coldPath, coldPath]);
});

test.each([undefined, "7"])("explicit Hosted unavailable retains recovery and honors Retry-After %s", async (retryAfter) => {
  const calls = stub(() => Response.json(unavailable, {
    status: 503, headers: retryAfter ? { ...marked, "retry-after": retryAfter } : marked,
  }));
  const state = await refreshSessionState(initialSessionOptions);
  expect(state.kind).toBe("error");
  if (state.kind !== "error") return;
  expect(isHostedSessionUnavailable(state.error.cause)).toBe(true);
  expect(state.error.headers.get("retry-after")).toBe(retryAfter ?? null);
  expect(calls).toEqual(Array.from({ length: retryAfter ? 1 : 4 }, () => coldPath));
});

test("a cold contention retry may not use a later reserved-path absence to fall back", async () => {
  let attempts = 0;
  const calls = stub(() => ++attempts === 1
    ? Response.json(unavailable, { status: 503, headers: marked })
    : Response.json({ error: "not found" }, { status: 404 }));
  expect(await refreshSessionState(initialSessionOptions)).toMatchObject({ kind: "error", error: { status: 503, body: unavailable } });
  expect(calls).toEqual([coldPath, coldPath]);
});

test("logout prevents a scheduled cold contention retry", async () => {
  const started = Promise.withResolvers<void>();
  const calls = stub(() => {
    started.resolve();
    return Response.json(unavailable, { status: 503, headers: marked });
  });
  const pending = refreshSessionState(initialSessionOptions);
  await started.promise;
  expect(await signOutSession()).toBe(true);
  expect(await pending).toEqual({ kind: "unauthenticated" });
  expect(calls).toEqual([coldPath]);
});

test.each(["retry", "fallback"])("the cold %s shares the original forty-second deadline", async (mode) => {
  const first = Promise.withResolvers<Response>();
  const firstEntered = Promise.withResolvers<void>();
  const second = Promise.withResolvers<Response>();
  const secondEntered = Promise.withResolvers<void>();
  const signals: Array<AbortSignal | null | undefined> = [];
  jest.useFakeTimers();
  try {
    const calls = stub((_path, init) => {
      signals.push(init?.signal);
      if (signals.length === 1) {
        firstEntered.resolve();
        return first.promise;
      }
      secondEntered.resolve();
      return second.promise;
    });
    const pending = refreshSessionState(initialSessionOptions);
    await firstEntered.promise;
    jest.advanceTimersByTime(39_000);
    first.resolve(mode === "retry" ? Response.json(unavailable, { status: 503, headers: marked })
      : Response.json({ error: "not found" }, { status: 404 }));
    if (mode === "retry") {
      for (let index = 0; index < 12; index++) await Promise.resolve();
      jest.advanceTimersByTime(300);
    }
    await secondEntered.promise;
    expect(signals[1]).toBe(signals[0]);
    expect(signals[0]?.aborted).toBe(false);
    jest.advanceTimersByTime(mode === "retry" ? 700 : 1_000);
    expect(await pending).toMatchObject({ kind: "error", error: { message: "Hosted session probe timed out." } });
    expect(signals[0]?.aborted).toBe(true);
    second.resolve(Response.json(mode === "retry" ? session : { authenticated: true }, { headers: marked }));
    for (let index = 0; index < 12; index++) await Promise.resolve();
    expect(calls).toEqual([coldPath, mode === "retry" ? coldPath : health]);
    expect(canReuseRecentSharedAuthProbe()).toBe(false);
  } finally {
    second.resolve(Response.json({ error: "fixture complete" }, { status: 503 }));
    jest.useRealTimers();
  }
});

test.each([
  ["controlled maintenance", 503, { error: { code: "schema_maintenance" } }, marked, "maintenance"],
  ["unmarked success", 200, session, undefined, "error"],
  ["unmarked 401", 401, { error: "unauthenticated" }, undefined, "error"],
  ["unmarked 503", 503, { error: "unavailable" }, undefined, "error"],
  ["unmarked Hosted code", 503, unavailable, undefined, "error"],
  ["marked 404", 404, { error: "not found" }, marked, "error"],
  ["redirect", 302, { error: "redirect" }, { location: ordinary }, "error"],
] as const)("cold %s neither grants a session nor starts a fallback read", async (_name, status, body, headers, kind) => {
  const calls = stub(() => Response.json(body, { status, headers: { ...headers, "retry-after": "7" } }));
  expect(await refreshSessionState(initialSessionOptions)).toMatchObject({ kind, error: { status, body } });
  expect(calls).toEqual([coldPath]);
  expect(canReuseRecentSharedAuthProbe()).toBe(false);
});

test("an older gateway's unverified health response after rollback cannot start ordinary bootstrap", async () => {
  const calls = stub((path) => {
    if (path === coldPath) return Response.json({ error: "not found" }, { status: 404 });
    if (path === health) return Response.json({ error: "not_found" }, { status: 404 });
    throw new Error(`unexpected ${path}`);
  });
  expect(await refreshSessionState(initialSessionOptions)).toMatchObject({ kind: "error" });
  expect(calls).toEqual([coldPath, health]);
});

test("rollback to stock uses ordinary bootstrap only after the explicit absence response", async () => {
  const calls = stub((path) => {
    if (path === coldPath) return Response.json({ error: "not found" }, { status: 404 });
    if (path === health) return Response.json({ error: "not_found" }, { status: 404, headers: absent });
    if (path === ordinary) return Response.json(session);
    throw new Error(`unexpected ${path}`);
  });
  expect(await refreshSessionState(initialSessionOptions)).toMatchObject({ kind: "authenticated", ...session });
  expect(calls).toEqual([coldPath, health, ordinary]);
});

test.each([200, 404])("logout invalidates a delayed cold status %i before it can publish or fall back", async (status) => {
  const held = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const calls = stub((path) => {
    if (path === coldPath) {
      started.resolve();
      return held.promise;
    }
    throw new Error(`unexpected ${path}`);
  });
  const pending = refreshSessionState(initialSessionOptions);
  await started.promise;
  expect(await signOutSession()).toBe(true);
  held.resolve(status === 200 ? Response.json(session, { headers: marked })
    : Response.json({ error: "not found" }, { status }));
  expect(await pending).toEqual({ kind: "unauthenticated" });
  expect(canReuseRecentSharedAuthProbe()).toBe(false);
  expect(calls).toEqual([coldPath]);
});
