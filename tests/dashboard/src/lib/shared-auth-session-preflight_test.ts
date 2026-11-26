import { afterEach, expect, jest, test } from "bun:test";
import {
  controlFetch,
  createApplyRun,
  getCapsuleConfigurationContext,
  getCapsuleProviderBindingSet,
  getInstallConfig,
  getRun,
  getRunCostInfo,
  getRunLogs,
  getRunWithOptions,
  listAccessibleAppsPage,
  listIncomingOwnershipTransfers,
  listProviderConnectionsWithSignal,
} from "../../../../dashboard/src/lib/control-api.ts";
import { apiFetch } from "../../../../dashboard/src/views/account/lib/http.ts";
import { loadCommercialBillingTransactions } from "../../../../dashboard/src/lib/commercial-billing.ts";
import { listWorkspacesCached, clearWorkspaceListCache } from "../../../../dashboard/src/lib/workspace-list.ts";
import { listAuthorizedUiSurfaces } from "../../../../dashboard/src/lib/ui-surface-interfaces.ts";
import {
  listHostedResourceInventoryPage,
  loadHostedResourceContribution,
} from "../../../../dashboard/src/lib/hosted-resources.ts";
import {
  clearDashboardBootstrapCache,
  fetchDashboardBootstrap,
  fetchDashboardWorkspaceBootstrap,
} from "../../../../dashboard/src/lib/dashboard-bootstrap.ts";
import {
  canReuseRecentSharedAuthProbe,
  clearSharedAuthSessionPreflight,
  probeInitialSharedAuthSession,
  SharedAuthSessionPreflightError,
} from "../../../../dashboard/src/lib/shared-auth-session-preflight.ts";

const realFetch = globalThis.fetch;
const healthPath = "/auth/oidc/session";
const bootstrapPath =
  "/api/v1/dashboard/bootstrap?includeWorkspaces=true&workspaceLimit=50";
const workspacePath = "/api/v1/workspaces/ws_current";
const absence = {
  "cache-control": "no-store",
  "x-takosumi-shared-auth-absent": "1",
};

afterEach(() => {
  clearSharedAuthSessionPreflight();
  clearDashboardBootstrapCache();
  clearWorkspaceListCache();
  globalThis.fetch = realFetch;
});

test("known-route unknown health blocks workspace fallback, billing, Interface, and native inventory", async () => {
  const calls: string[] = [];
  let reads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path === healthPath) {
      return ++reads === 1
        ? Response.json({ authenticated: true })
        : Response.json({ error: "authentication_unavailable" }, { status: 503 });
    }
    throw new Error(`business dispatched: ${path}`);
  }) as typeof fetch;
  await probeInitialSharedAuthSession();
  await expect(listWorkspacesCached()).rejects.toBeInstanceOf(
    SharedAuthSessionPreflightError,
  );
  await expect(loadCommercialBillingTransactions({
    basePath: "/commercial", workspaceId: "ws_current",
  })).rejects.toBeInstanceOf(SharedAuthSessionPreflightError);
  await expect(listAuthorizedUiSurfaces("ws_current")).rejects.toBeInstanceOf(
    SharedAuthSessionPreflightError,
  );
  await expect(loadHostedResourceContribution()).rejects.toMatchObject({ status: 0 });
  await expect(listHostedResourceInventoryPage(
    "/extensions/inventory", "ws_current",
  )).rejects.toBeInstanceOf(SharedAuthSessionPreflightError);
  expect(calls).toEqual(Array(6).fill(healthPath));
});

test("ordinary route absence sends the canonical request", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path === healthPath) {
      return Response.json({ error: "not_found" }, {
        status: 404,
        headers: absence,
      });
    }
    if (path === workspacePath) return Response.json({ workspace: { id: "ws_current" } });
    throw new Error(`unexpected request: ${path}`);
  }) as typeof fetch;
  expect((await probeInitialSharedAuthSession()).route).toBe("absent");
  expect(await controlFetch(workspacePath)).toEqual({ workspace: { id: "ws_current" } });
  expect(calls).toEqual([healthPath, workspacePath]);
});

test("a failed initial probe cannot later be mistaken for ordinary route absence", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path === healthPath) {
      return Response.json({ error: "authentication_unavailable" }, { status: 503 });
    }
    throw new Error("business dispatched after unknown initial probe");
  }) as typeof fetch;
  await expect(probeInitialSharedAuthSession()).rejects.toBeInstanceOf(
    SharedAuthSessionPreflightError,
  );
  await expect(controlFetch(workspacePath)).rejects.toBeInstanceOf(
    SharedAuthSessionPreflightError,
  );
  await expect(fetchDashboardWorkspaceBootstrap()).rejects.toBeInstanceOf(
    SharedAuthSessionPreflightError,
  );
  expect(calls).toEqual([healthPath]);
});

test("an explicit retry after initial 503 rechecks health before mandatory canonical bootstrap", async () => {
  const calls: string[] = [];
  let healthReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path === healthPath) {
      return ++healthReads === 1
        ? Response.json({ error: "authentication_unavailable" }, { status: 503 })
        : Response.json({ authenticated: true });
    }
    if (path === bootstrapPath) {
      return Response.json({
        session: { subject: "tsub_recovered" },
        workspaces: [{ id: "ws_current", handle: "current" }],
      });
    }
    throw new Error(`unexpected request: ${path}`);
  }) as typeof fetch;
  await expect(probeInitialSharedAuthSession()).rejects.toBeInstanceOf(
    SharedAuthSessionPreflightError,
  );
  await expect(controlFetch(workspacePath)).rejects.toBeInstanceOf(
    SharedAuthSessionPreflightError,
  );
  expect(calls).toEqual([healthPath]);
  const retry = await probeInitialSharedAuthSession();
  expect(retry.route).toBe("present");
  expect((await fetchDashboardWorkspaceBootstrap({
    initialHealthTicket: retry.ticket,
  }))?.session?.subject).toBe("tsub_recovered");
  expect(calls).toEqual([healthPath, healthPath, bootstrapPath]);
});

const hostedSessionUnavailable = () =>
  Response.json({ error: { code: "oidc_unavailable" } }, { status: 503 });

test("a transient Hosted session check recovers on open before dispatching canonical reads", async () => {
  const calls: string[] = [];
  let checks = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path === healthPath) {
      return ++checks < 3
        ? hostedSessionUnavailable()
        : Response.json({ authenticated: true });
    }
    if (path === workspacePath) return Response.json({ ok: true });
    throw new Error(`unexpected request: ${path}`);
  }) as typeof fetch;
  const opening = probeInitialSharedAuthSession();
  const canonical = controlFetch(workspacePath);
  const [health, response] = await Promise.all([opening, canonical]);
  expect(health.route).toBe("present");
  expect(response).toEqual({ ok: true });
  expect(calls).toEqual([healthPath, healthPath, healthPath, workspacePath]);
});

test("a retry after Hosted unavailability cannot turn an absent route into an OSS fallback", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path !== healthPath) throw new Error("canonical request escaped");
    return calls.length === 1
      ? hostedSessionUnavailable()
      : Response.json({ error: "not_found" }, { status: 404, headers: absence });
  }) as typeof fetch;
  await expect(probeInitialSharedAuthSession()).rejects.toMatchObject({ status: 503 });
  await expect(controlFetch(workspacePath)).rejects.toMatchObject({ status: 503 });
  expect(calls).toEqual([healthPath, healthPath]);
});

test("persistent Hosted unavailability stops retrying and never dispatches the protected request", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path !== healthPath) throw new Error("canonical request escaped");
    return hostedSessionUnavailable();
  }) as typeof fetch;
  await expect(probeInitialSharedAuthSession()).rejects.toMatchObject({ status: 503 });
  await expect(controlFetch(workspacePath)).rejects.toMatchObject({ status: 503 });
  expect(calls).toEqual(Array(4).fill(healthPath));
});

test("an established Hosted route cannot be downgraded by a later initial 404", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path !== healthPath) throw new Error("business dispatched after downgrade");
    return calls.length === 1
      ? Response.json({ authenticated: true })
      : Response.json({ error: "not_found" }, { status: 404, headers: absence });
  }) as typeof fetch;
  expect((await probeInitialSharedAuthSession()).route).toBe("present");
  await expect(probeInitialSharedAuthSession()).rejects.toBeInstanceOf(
    SharedAuthSessionPreflightError,
  );
  await expect(controlFetch(workspacePath)).rejects.toBeInstanceOf(
    SharedAuthSessionPreflightError,
  );
  expect(calls).toEqual([healthPath, healthPath]);
});

test("a business read waiting on the downgraded probe also refuses dispatch", async () => {
  const calls: string[] = [];
  let release!: (response: Response) => void;
  const second = new Promise<Response>((resolve) => { release = resolve; });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path !== healthPath) throw new Error("business dispatched after downgrade");
    return calls.length === 1 ? Response.json({ authenticated: true }) : second;
  }) as typeof fetch;
  await probeInitialSharedAuthSession();
  const reprobe = probeInitialSharedAuthSession();
  const reprobeOutcome = reprobe.then(
    () => "accepted" as const,
    (error: unknown) => error,
  );
  const business = controlFetch(workspacePath);
  const businessOutcome = business.then(
    () => "dispatched" as const,
    (error: unknown) => error,
  );
  expect(calls).toEqual([healthPath, healthPath]);
  release(Response.json({ error: "not_found" }, {
    status: 404, headers: absence,
  }));
  expect(await reprobeOutcome).toBeInstanceOf(SharedAuthSessionPreflightError);
  expect(await businessOutcome).toBeInstanceOf(SharedAuthSessionPreflightError);
  expect(calls).toEqual([healthPath, healthPath]);
});

test("a held initial ticket cannot bypass a later failed probe", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path === healthPath) {
      return calls.length === 1
        ? Response.json({ authenticated: true })
        : Response.json({ error: "authentication_unavailable" }, { status: 503 });
    }
    throw new Error("canonical request escaped a failed probe");
  }) as typeof fetch;
  const held = await probeInitialSharedAuthSession();
  await expect(probeInitialSharedAuthSession()).rejects.toBeInstanceOf(
    SharedAuthSessionPreflightError,
  );
  await expect(fetchDashboardWorkspaceBootstrap({
    initialHealthTicket: held.ticket,
  })).rejects.toBeInstanceOf(SharedAuthSessionPreflightError);
  expect(calls).toEqual([healthPath, healthPath]);
});

test("a concurrent business read waits for initial route knowledge without a second health read", async () => {
  const calls: string[] = [];
  let release!: (response: Response) => void;
  const health = new Promise<Response>((resolve) => { release = resolve; });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path === healthPath) return health;
    if (path === workspacePath) return Response.json({ ok: true });
    throw new Error(`unexpected request: ${path}`);
  }) as typeof fetch;
  const initial = probeInitialSharedAuthSession();
  const business = controlFetch(workspacePath);
  expect(calls).toEqual([healthPath]);
  release(Response.json({ authenticated: true }));
  expect((await initial).route).toBe("present");
  expect(await business).toEqual({ ok: true });
  expect(calls).toEqual([healthPath, workspacePath]);
});

test("known Hosted route rejects 503, forged absence, and malformed health without business dispatch", async () => {
  for (const unhealthy of [
    Response.json({ error: "authentication_unavailable" }, { status: 503 }),
    Response.json({ error: "not_found" }, { status: 404, headers: absence }),
    Response.json({ authenticated: true, subject: "forged" }),
  ]) {
    clearSharedAuthSessionPreflight();
    const calls: string[] = [];
    let healthReads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      calls.push(path);
      if (path !== healthPath) throw new Error("business request was dispatched");
      return ++healthReads === 1
        ? Response.json({ authenticated: true })
        : unhealthy;
    }) as typeof fetch;
    expect((await probeInitialSharedAuthSession()).route).toBe("present");
    await expect(controlFetch(workspacePath)).rejects.toBeInstanceOf(
      SharedAuthSessionPreflightError,
    );
    expect(calls).toEqual([healthPath, healthPath]);
  }
});

test("a failed health read never enters apply's bounded POST retry", async () => {
  let healthReads = 0;
  let businessReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === healthPath) {
      return ++healthReads === 1
        ? Response.json({ authenticated: true })
        : Response.json({ error: "authentication_unavailable" }, { status: 503 });
    }
    businessReads += 1;
    throw new Error("apply was dispatched");
  }) as typeof fetch;
  await probeInitialSharedAuthSession();
  await expect(createApplyRun({ id: "plan_current", type: "plan", capsuleId: "cap_current", workspaceId: "ws_current" })).rejects.toBeInstanceOf(
    SharedAuthSessionPreflightError,
  );
  expect(healthReads).toBe(2);
  expect(businessReads).toBe(0);
});

test("two callers share one original health read and one abort cannot cancel the other", async () => {
  const calls: string[] = [];
  let reads = 0;
  let sharedHealthSignal: AbortSignal | undefined;
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { release = resolve; });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(path);
    if (path === healthPath) {
      sharedHealthSignal = init?.signal ?? undefined;
      return ++reads === 1 ? Response.json({ authenticated: true }) : pending;
    }
    if (path === workspacePath) return Response.json({ ok: true });
    throw new Error(`unexpected request: ${path}`);
  }) as typeof fetch;
  await probeInitialSharedAuthSession();
  const controller = new AbortController();
  const canceled = controlFetch(workspacePath, { signal: controller.signal });
  const survivor = controlFetch(workspacePath);
  expect(calls).toEqual([healthPath, healthPath]);
  controller.abort();
  await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
  expect(sharedHealthSignal?.aborted).toBe(false);
  expect(calls).toEqual([healthPath, healthPath]);
  release(Response.json({ authenticated: true }));
  expect(await survivor).toEqual({ ok: true });
  expect(calls).toEqual([healthPath, healthPath, workspacePath]);
});

test("the POST original is serialized once before health and unknown health sends no POST", async () => {
  const input = { command: "unchanged" };
  let reads = 0;
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { release = resolve; });
  const sent: string[] = [];
  globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const path = String(request);
    if (path === healthPath) {
      return ++reads === 1 ? Response.json({ authenticated: true }) : pending;
    }
    sent.push(String(init?.body));
    return Response.json({ ok: true });
  }) as typeof fetch;
  await probeInitialSharedAuthSession();
  const request = controlFetch("/api/v1/commands", { method: "POST", body: input });
  input.command = "mutated";
  release(Response.json({ authenticated: true }));
  expect(await request).toEqual({ ok: true });
  expect(sent).toEqual(['{"command":"unchanged"}']);

  let business = 0;
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    if (String(request) === healthPath) {
      return Response.json({ error: "authentication_unavailable" }, { status: 503 });
    }
    business += 1;
    return Response.json({ ok: true });
  }) as typeof fetch;
  await expect(controlFetch("/api/v1/commands", {
    method: "POST", body: input,
  })).rejects.toBeInstanceOf(SharedAuthSessionPreflightError);
  expect(business).toBe(0);
});

test("account auth:false bypasses health but authenticated transport waits for it", async () => {
  let healthReads = 0;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path === healthPath) {
      healthReads += 1;
      return healthReads === 1
        ? Response.json({ authenticated: false }, { status: 401 })
        : Response.json({ error: "authentication_unavailable" }, { status: 503 });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  await probeInitialSharedAuthSession();
  expect(await apiFetch("/api/v1/public", { auth: false })).toEqual({ ok: true });
  await expect(apiFetch("/api/v1/account/profile")).rejects.toBeInstanceOf(
    SharedAuthSessionPreflightError,
  );
  expect(calls).toEqual([healthPath, "/api/v1/public", healthPath]);
});

test("a known Hosted route completes the original health read before an ordinary Workspace read", async () => {
  const calls: string[] = [];
  let healthReads = 0;
  let quietHealthCompleted = false;
  let releaseHealth!: (response: Response) => void;
  const delayedHealth = new Promise<Response>((resolve) => {
    releaseHealth = (response) => {
      quietHealthCompleted = true;
      resolve(response);
    };
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    calls.push(path);
    if (path === healthPath) {
      expect(init?.method).toBe("GET");
      expect(init?.credentials).toBe("include");
      expect(init?.cache).toBe("no-store");
      healthReads += 1;
      return healthReads === 1
        ? Response.json({ authenticated: true })
        : await delayedHealth;
    }
    if (path === bootstrapPath) {
      return Response.json({
        session: { subject: "tsub_current" },
        workspaces: [{ id: "ws_current", handle: "current" }],
      });
    }
    if (path === workspacePath) {
      return !quietHealthCompleted
        ? Response.json({ error: "authentication_unavailable" }, { status: 503 })
        : Response.json({ workspace: { id: "ws_current" } });
    }
    throw new Error(`unexpected request: ${path}`);
  }) as typeof fetch;

  const initial = await probeInitialSharedAuthSession();
  expect(initial.route).toBe("present");
  expect((await fetchDashboardWorkspaceBootstrap({
    initialHealthTicket: initial.ticket,
  }))?.session?.subject).toBe("tsub_current");
  const result = controlFetch<{ workspace: { id: string } }>(workspacePath)
    .then((value) => ({ kind: "ok" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }));
  try {
    expect(calls).toEqual([healthPath, bootstrapPath, healthPath]);
    releaseHealth(Response.json({ authenticated: true }));
    expect(await result).toEqual({
      kind: "ok",
      value: { workspace: { id: "ws_current" } },
    });
    expect(calls).toEqual([
      healthPath,
      bootstrapPath,
      healthPath,
      workspacePath,
    ]);
  } finally {
    releaseHealth(Response.json({ authenticated: true }));
    await result;
  }
});

test("session bootstrap and app list reads share a recent availability observation but send each canonical GET", async () => {
  const calls: string[] = [];
  const guarded: string[] = [];
  let now = 10_000;
  const time = jest.spyOn(Date, "now").mockImplementation(() => now);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(path);
    if (path === healthPath) return Response.json({ authenticated: true });
    const header = new Headers(init?.headers).get("x-takosumi-shared-auth-read");
    const headers = header ? { "x-takosumi-shared-auth-read": header } : undefined;
    if (header === "1") {
      guarded.push(path);
      expect(init?.cache).toBe("no-store");
    }
    if (path.startsWith("/api/v1/dashboard/bootstrap?")) {
      return Response.json({ session: { subject: "tsub_fixture" }, notifications: [] }, { headers });
    }
    const query = new URL(path, "https://dashboard.invalid").searchParams.get("q");
    return Response.json({ apps: [], appliedQuery: query }, { headers });
  }) as typeof fetch;
  try {
    const initial = await probeInitialSharedAuthSession();
    await expect(fetchDashboardBootstrap({ initialHealthTicket: initial.ticket })).resolves.toMatchObject({
      session: { subject: "tsub_fixture" },
    });
    now += 4_999;
    await expect(listAccessibleAppsPage(undefined, undefined, "office")).resolves.toMatchObject({
      apps: [], appliedQuery: "office",
    });
    await expect(fetchDashboardBootstrap({ includeNotifications: true })).resolves.toMatchObject({
      notifications: [],
    });
    expect(calls).toEqual([
      healthPath,
      "/api/v1/dashboard/bootstrap?includeWorkspaces=false",
      "/api/v1/apps?q=office",
      "/api/v1/dashboard/bootstrap?includeWorkspaces=false&includeNotifications=true",
    ]);
    expect(guarded).toEqual([calls[2], calls[3]]);
    now += 1;
    await expect(listAccessibleAppsPage(undefined, undefined, "storage")).resolves.toMatchObject({
      apps: [], appliedQuery: "storage",
    });
    expect(calls.slice(-2)).toEqual([healthPath, "/api/v1/apps?q=storage"]);
  } finally {
    time.mockRestore();
  }
});

test("reused availability rejects an unmarked legacy success after a Worker rollback", async () => {
  for (const read of [
    fetchDashboardBootstrap,
    () => listAccessibleAppsPage(undefined, undefined, "office"),
    listIncomingOwnershipTransfers,
    () => getCapsuleProviderBindingSet("cap_test", { reuseRecentSharedAuthProbe: true }),
    () => getRun("run_test", { reuseRecentSharedAuthProbe: true }),
    () => listAuthorizedUiSurfaces("ws_current", { capsuleId: "cap_test", reuseRecentSharedAuthProbe: true }),
  ]) {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push(path);
      if (path === healthPath) return Response.json({ authenticated: true });
      expect(new Headers(init?.headers).get("x-takosumi-shared-auth-read")).toBe("1");
      return Response.json({ session: { subject: "tsub_ordinary" }, apps: [] });
    }) as typeof fetch;
    await probeInitialSharedAuthSession();
    await expect(read()).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(2);
  }
});

test("an unproved app launcher 404 never enters the legacy Workspace route", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    calls.push(path);
    if (path === healthPath) return Response.json({ authenticated: true });
    expect(new Headers(init?.headers).get("x-takosumi-shared-auth-read")).toBe("1");
    expect(init?.cache).toBe("no-store");
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;
  await probeInitialSharedAuthSession();
  await expect(listAuthorizedUiSurfaces("ws_current", {
    capsuleId: "cap_test", reuseRecentSharedAuthProbe: true,
  })).rejects.toMatchObject({ status: 503 });
  expect(calls).toEqual([healthPath, "/api/v1/ui-surfaces?capsuleId=cap_test"]);
  expect(canReuseRecentSharedAuthProbe()).toBe(false);
});

test("an app launcher 401 retires the current shared observation only for its active screen", async () => {
  for (const retire of [false, true]) {
    const pending = Promise.withResolvers<Response>();
    let isCurrent = true;
    globalThis.fetch = (async (input) => String(input) === healthPath
      ? Response.json({ authenticated: true })
      : pending.promise) as typeof fetch;
    await probeInitialSharedAuthSession();
    const read = listAuthorizedUiSurfaces("ws_current", {
      capsuleId: "cap_test", reuseRecentSharedAuthProbe: true, isCurrent: () => isCurrent,
    });
    isCurrent = !retire;
    pending.resolve(Response.json({ error: "unauthenticated" }, { status: 401 }));
    if (retire) await expect(read).rejects.toMatchObject({ name: "AbortError" });
    else await expect(read).rejects.toMatchObject({ status: 401 });
    expect(canReuseRecentSharedAuthProbe()).toBe(retire);
  }
});

test("settings, Run detail and transfers use one availability read and each protected GET", async () => {
  const capsule = {
    id: "cap_test", name: "Office", slug: "office", installConfigId: "conf_test",
    environment: "test", currentStateGeneration: 1, status: "active",
    createdAt: "2026-11-26T00:00:00Z", updatedAt: "2026-11-26T00:00:00Z",
  };
  const run = { id: "run_test", status: "succeeded" };
  const protectedReads = new Map<string, object>([
    ["/api/v1/capsules/cap_test", { capsule, installConfigReAdoption: { authorityGuard: "guard_test" } }],
    ["/api/v1/capsules/cap_test/provider-bindings", { providerBindingSet: null }],
    ["/api/v1/capsule-configs/conf_test", { installConfig: { id: "conf_test" } }],
    ["/api/v1/apps", { apps: [] }],
    ["/api/v1/connections", { connections: [] }],
    ["/api/v1/runs/run_test", { run }],
    ["/api/v1/runs/run_test/logs", { lines: [] }],
    ["/api/v1/runs/run_test/cost", { cost: { estimate: null } }],
    ["/api/v1/ownership-transfers?state=pending", { ownershipTransfers: [] }],
  ]);
  const calls: Array<{ path: string; marked: boolean }> = [];
  const time = jest.spyOn(Date, "now").mockReturnValue(20_000);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const marked = new Headers(init?.headers).get("x-takosumi-shared-auth-read") === "1";
    expect(init?.method).toBe("GET");
    calls.push({ path, marked });
    if (path === healthPath) return Response.json({ authenticated: true });
    const body = protectedReads.get(path);
    if (!body) throw new Error(`Unexpected read ${path}`);
    const headers = marked ? { "x-takosumi-shared-auth-read": "1" } : undefined;
    return Response.json(body, { headers });
  }) as typeof fetch;
  try {
    await probeInitialSharedAuthSession();
    const display = { reuseRecentSharedAuthProbe: true };
    expect(await getCapsuleConfigurationContext("cap_test", display)).toMatchObject({ capsule });
    expect(await getCapsuleProviderBindingSet("cap_test", display)).toBeNull();
    expect(await getInstallConfig("conf_test", display)).toMatchObject({ id: "conf_test" });
    expect(await listProviderConnectionsWithSignal(undefined, undefined, {
      ...display, isCurrent: () => true,
    })).toEqual([]);
    expect(await getRun("run_test", display)).toMatchObject(run);
    expect(await getRunLogs("run_test", display)).toMatchObject({ lines: [] });
    expect(await getRunCostInfo("run_test")).toMatchObject({ estimate: null });
    expect(await listIncomingOwnershipTransfers()).toEqual([]);
    expect(calls).toEqual([
      { path: healthPath, marked: false },
      ...[...protectedReads.keys()].map((path) => ({ path, marked: true })),
    ]);
    await getRunWithOptions("run_test", { cache: "no-store" });
    expect(calls.slice(-2)).toEqual([
      { path: healthPath, marked: false },
      { path: "/api/v1/runs/run_test", marked: false },
    ]);
  } finally {
    time.mockRestore();
  }
});

test("canonical 401 retires shared availability and mutations still require a fresh probe", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  let available = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, method: init?.method ?? "GET" });
    if (path === healthPath) return available
      ? Response.json({ authenticated: true })
      : Response.json({ error: "authentication_unavailable" }, { status: 503 });
    if (path === "/api/v1/apps?q=office") {
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    }
    throw new Error(`unexpected canonical request ${path}`);
  }) as typeof fetch;
  await probeInitialSharedAuthSession();
  await expect(listAccessibleAppsPage(undefined, undefined, "office")).rejects.toMatchObject({ status: 401 });
  available = false;
  await expect(listAccessibleAppsPage(undefined, undefined, "storage")).rejects.toMatchObject({ status: 503 });
  available = true;
  await probeInitialSharedAuthSession();
  available = false;
  await expect(controlFetch("/api/v1/capsules", { method: "POST", reuseRecentSharedAuthProbe: true }))
    .rejects.toMatchObject({ status: 503 });
  expect(calls.map(({ path }) => path)).toEqual([
    healthPath, "/api/v1/apps?q=office", healthPath, healthPath, healthPath,
  ]);
  expect(calls.every(({ method }) => method === "GET")).toBe(true);
});
