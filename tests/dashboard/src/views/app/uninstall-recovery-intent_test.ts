import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { setImmediate as realSetImmediate } from "node:timers";
import { appUninstallRecoveryMode } from "../../../../../dashboard/src/lib/capsule-uninstall.ts";
import { ControlApiError, createCapsuleDestroyRecoveryPlan, extractRunId, getCapsuleAppWithSignal, getCapsuleProviderBindingSet, isRevisionAlreadyCurrent, listProviderConnectionsWithSignal, resetAppOwnershipCache } from "../../../../../dashboard/src/lib/control-api.ts";

const source = readFileSync(new URL("../../../../../dashboard/src/views/app/AppManagePage.tsx", import.meta.url), "utf8");
function between(start: string, end: string): string {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error("actual uninstall controller boundary changed");
  return source.slice(from, to);
}
const start = between("  const startReview = async (", "\n  // After a review ends");
const replacement = between("  const reviewUninstallWithConnection = (", "\n\n  // --- the one primary action");
const transpile = (body: string) => new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(body);
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const pairs = [{ connectionId: "old", replacementConnectionId: "new" }];
const flush = () => new Promise<void>(yes => realSetImmediate(yes));

test("actual replacement transport refuses retired dispatch and suppresses late 401 while current 401 still signs in", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  const redirects: string[] = [];
  Object.defineProperty(globalThis, "location", { configurable: true, value: {
    pathname: "/apps/app", search: "", hash: "", assign: (href: string) => { redirects.push(href); },
  } });
  try {
    const observed: number[][] = [];
    for (const mode of ["retired", "current", "late"]) {
      let current = mode !== "retired", posts = 0;
      const before = redirects.length;
      globalThis.fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe("POST"); posts++;
        if (mode === "late") current = false;
        return Response.json({ error: "invalid_token" }, { status: 401 });
      }, { preconnect: realFetch.preconnect });
      await createCapsuleDestroyRecoveryPlan("app", pairs, { isCurrent: () => current }).catch(() => {});
      observed.push([posts, redirects.length - before]);
    }
    expect(observed).toEqual([[0, 0], [1, 1], [1, 0]]);
    expect(redirects[0]).toBe("/sign-in?return=%2Fapps%2Fapp");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "location", descriptor);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

test.each(["bindings", "paged", "legacy"] as const)("retiring the chooser suppresses a late 401 from %s", async (endpoint) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  const redirects: string[] = [];
  Object.defineProperty(globalThis, "location", { configurable: true, value: {
    pathname: "/apps/another", search: "", hash: "", assign: (href: string) => { redirects.push(href); },
  } });
  resetAppOwnershipCache();
  let current = true;
  const staleResponses: string[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/api/v1/apps") {
      return endpoint === "legacy"
        ? Response.json({ error: "route_not_found" }, { status: 404 })
        : Response.json({ apps: [] });
    }
    if (path === "/api/v1/connections") return Response.json({ connections: [], nextCursor: "next" });
    current = false;
    staleResponses.push(path);
    return Response.json({ error: "invalid_token" }, { status: 401 });
  }, { preconnect: realFetch.preconnect });
  try {
    const isCurrent = () => current;
    const read = endpoint === "bindings"
      ? getCapsuleProviderBindingSet("app", { isCurrent })
      : listProviderConnectionsWithSignal("workspace", undefined, { isCurrent });
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    expect(staleResponses).toEqual([{
      bindings: "/api/v1/capsules/app/provider-bindings",
      paged: "/api/v1/connections?cursor=next",
      legacy: "/api/v1/provider-connections?workspaceId=workspace",
    }[endpoint]]);
    expect(redirects).toEqual([]);
  } finally {
    resetAppOwnershipCache();
    if (descriptor) Object.defineProperty(globalThis, "location", descriptor);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

function controller(uninstallMode: "scheduled" | "none" = "scheduled") {
  const state = { capsuleId: "app", workspaceId: "workspace", accountId: "account", principalId: "person", owner: true,
    starting: undefined as unknown, review: undefined as { planRunId: string } | undefined, errors: [] as unknown[], reads: 0 };
  const script = `let disposed = false; let uninstallEpoch = 0;\n${start}\n${replacement}\nreturn {
    send: reviewUninstallWithConnection,
    retire: () => { uninstallEpoch++; },
    dispose: () => { disposed = true; },
  };`;
  const actual = new Function("capsuleId", "capsule", "props", "reviewBusy", "appRole", "isOwner", "starting", "setStarting", "setSectionError", "setNotice", "setReview", "setReAdoptionRevisionId", "reAdoptionRevisionFromError", "isRevisionAlreadyCurrent", "friendlyError", "t", "queueMicrotask", "ControlApiError", "refetchApp", "app", "review", "appUninstallRecoveryMode", "createCapsuleDestroyRecoveryPlan", "extractRunId", "uninstallScope", transpile(script))(
    () => state.capsuleId, () => ({ sourceId: "source" }), state, () => Boolean(state.starting), () => state.owner ? "owner" : undefined, () => state.owner,
    () => state.starting, (value: unknown) => { state.starting = value; }, (value: unknown) => { if (value) state.errors.push(value); }, () => {},
    (value: { planRunId: string }) => { state.review = value; }, () => {}, () => undefined, isRevisionAlreadyCurrent, () => ({ message: "fixture error" }), (key: string) => key, () => {}, ControlApiError,
    async (options?: { isCurrent?: () => boolean }) => { state.reads++; return await getCapsuleAppWithSignal(state.capsuleId, undefined, options); },
    () => ({
      capsuleId: state.capsuleId, workspaceId: state.workspaceId, progress: {},
      uninstall: { mode: uninstallMode, scheduled: { blocked: true } },
      problems: [{ code: "connection_unavailable", connectionId: "old", provider: "registry.opentofu.org/cloudflare/cloudflare", connectionStatus: "revoked" }],
    }), () => state.review, appUninstallRecoveryMode,
    createCapsuleDestroyRecoveryPlan, extractRunId,
    () => JSON.stringify([state.capsuleId, state.workspaceId, state.accountId, state.principalId]),
  ) as { send: (answer: typeof pairs) => void; retire: () => void; dispose: () => void };
  return { state, ...actual };
}

test("actual replacement controller drops retired success and rejection without clearing a replacement action", async () => {
  const observations: unknown[] = [];
  for (const outcome of ["success", "rejected"]) {
    const c = controller(); let release!: (value: Response) => void; let posts = 0;
    globalThis.fetch = Object.assign(async () => { posts++; return await new Promise<Response>(yes => { release = yes; }); }, { preconnect: realFetch.preconnect });
    c.send(pairs); await flush();
    c.state.accountId = "other-account"; c.state.principalId = "other-person"; c.retire();
    const fresh = { section: "version" }; c.state.starting = fresh;
    release(outcome === "success" ? Response.json({ run: { id: "old-review" } }) : Response.json({ error: "forbidden" }, { status: 403 }));
    await flush();
    observations.push({ posts, review: c.state.review, errors: c.state.errors.length, heldFresh: c.state.starting === fresh, reads: c.state.reads });
  }
  expect(observations).toEqual(Array.from({ length: 2 }, () => ({ posts: 1, review: undefined, errors: 0, heldFresh: true, reads: 0 })));
});

test("normal selection opens only its review and an unknown answer keeps the existing read-only app recovery", async () => {
  const c = controller(); const calls: { method: string; path: string; body?: unknown }[] = [];
  let lose = false;
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", path: String(input), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (init?.method === "POST") {
      if (lose) throw new TypeError("synthetic answer lost");
      return Response.json({ run: { id: "exact-review" } });
    }
    return Response.json({ app: { kind: "takosumi.capsule-app@v1", capsuleId: "app", workspaceId: "workspace", state: "uninstalling", primaryAction: "review", problems: [], screens: [], version: {}, progress: { review: { runId: "existing", runType: "destroy_plan" } }, uninstall: {} } });
  }, { preconnect: realFetch.preconnect });
  c.send(pairs); await flush();
  expect(c.state.review?.planRunId).toBe("exact-review"); expect(c.state.starting).toBeUndefined();
  expect(calls).toEqual([{ method: "POST", path: "/api/v1/capsules/app/destroy-plan", body: { destroyProviderConnectionReplacements: pairs } }]);
  c.state.review = undefined; lose = true;
  c.send(pairs); await flush();
  expect(c.state.review).toBeUndefined(); expect(c.state.starting).toBeUndefined(); expect(c.state.reads).toBe(1);
  expect(calls.map(call => call.method)).toEqual(["POST", "POST", "GET"]);
  expect(calls.at(-1)?.path).toBe("/api/v1/capsules/app/app");
  expect(calls.some(call => /\/(approve|apply)$/u.test(call.path))).toBe(false);
});

test("an existing blocked uninstall can still be reviewed when new reservations are disabled", async () => {
  const c = controller("none");
  const methods: (string | undefined)[] = [];
  globalThis.fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method);
    return Response.json({ run: { id: "blocked-uninstall-review" } });
  }, { preconnect: realFetch.preconnect });
  c.send(pairs);
  await flush();
  expect(methods).toEqual(["POST"]);
  expect(c.state.review?.planRunId).toBe("blocked-uninstall-review");
});

test("ABA, disposal, workspace and owner retirement keep the replacement result out of the current action", async () => {
  for (const mode of ["ABA", "dispose", "workspace", "owner"]) {
    const c = controller(); let release!: (value: Response) => void;
    globalThis.fetch = Object.assign(async () => await new Promise<Response>(yes => { release = yes; }), { preconnect: realFetch.preconnect });
    c.send(pairs); await flush();
    if (mode === "ABA") c.retire();
    if (mode === "dispose") c.dispose();
    if (mode === "workspace") c.state.workspaceId = "other-workspace";
    if (mode === "owner") c.state.owner = false;
    const fresh = { section: "settings" }; c.state.starting = fresh;
    release(Response.json({ run: { id: "retired-review" } })); await flush();
    expect(c.state.review).toBeUndefined(); expect(c.state.errors).toEqual([]); expect(c.state.reads).toBe(0);
    expect(c.state.starting).toBe(fresh);
  }
});

test("a replacement's unknown-response app read cannot sign out a later page", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  const redirects: string[] = [];
  Object.defineProperty(globalThis, "location", { configurable: true, value: { pathname: "/apps/app", search: "", hash: "", assign: (href: string) => { redirects.push(href); } } });
  let release!: (value: Response) => void;
  const c = controller(); const calls: string[] = [];
  globalThis.fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push(init?.method ?? "GET");
    if (init?.method === "POST") throw new TypeError("synthetic answer lost");
    return await new Promise<Response>(yes => { release = yes; });
  }, { preconnect: realFetch.preconnect });
  try {
    c.send(pairs); await flush(); expect(calls).toEqual(["POST", "GET"]);
    c.dispose(); release(Response.json({ error: "invalid_token" }, { status: 401 })); await flush();
    expect(redirects).toEqual([]); expect(calls).toEqual(["POST", "GET"]);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "location", descriptor);
    else Reflect.deleteProperty(globalThis, "location");
  }
});
