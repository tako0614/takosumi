import { afterEach, expect, test } from "bun:test";
import {
  acceptAppOwnershipTransfer, cancelAppOwnershipTransfer, ControlApiError,
  createConnection, createGitInstallAttempt, getAppConnectionChoices, getAppMembers, getCapsuleConfigurationContext,
  inviteAppMember, listAccessibleApps, listConnections, listPersonalUsagePage,
  removeAppMember, resolveStableSourceTag, transferAppOwnership, resetAppOwnershipCache,
  appOwnershipAvailable, legacyInstallWorkspaceId, startConnectionOAuth, isMissingControlRoute,
  listAppOwnershipTransfers, listIncomingOwnershipTransfers,
  type CapsuleAppView,
} from "../../../../dashboard/src/lib/control-api.ts";
import { appPrimaryAllowed, resolveAppRole } from "../../../../dashboard/src/lib/app-access.ts";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const calls: { path: string; method: string; body: unknown; key: string | null }[] = [];
function stub(reply: (path: string, method: string, body: unknown) => Response) {
  resetAppOwnershipCache();
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body, key: new Headers(init?.headers).get("idempotency-key") });
    return reply(path, method, body);
  }) as typeof fetch;
}
test("apps follows pagination without workspace and propagates authorization/service errors", async () => {
  stub((path) => Response.json(path.includes("cursor=") ? { apps: [{ capsuleId: "member-app", role: "member" }] } : { apps: [{ capsuleId: "owned-app", role: "owner" }], nextCursor: "page two" }));
  expect((await listAccessibleApps())?.map((app) => app.capsuleId)).toEqual(["owned-app", "member-app"]);
  expect(calls.map((call) => call.path)).toEqual(["/api/v1/apps", "/api/v1/apps?cursor=page%20two"]);
  for (const status of [403, 503]) {
    stub(() => Response.json({ error: { code: "app_access_denied" } }, { status }));
    await expect(listAccessibleApps()).rejects.toMatchObject({ status });
    expect(calls).toHaveLength(1);
  }
  stub(() => Response.json({ error: { code: "route_not_found" } }, { status: 404 }));
  expect(await listAccessibleApps()).toBeUndefined();
});
test("role is app-specific; only missing app routes consult legacy owner", async () => {
  stub((path) => Response.json(path === "/api/v1/apps" ? { apps: [{ capsuleId: "a", role: "member" }] } : { workspace: { ownerUserId: "me" } }));
  expect(await resolveAppRole({ capsuleId: "a", accountId: "me", workspaceId: "old" })).toBe("member");
  expect(calls).toHaveLength(1);
  stub((path) => path === "/api/v1/apps" ? Response.json({ error: { code: "route_not_found" } }, { status: 404 }) : Response.json({ workspace: { ownerUserId: "me" } }));
  expect(await resolveAppRole({ capsuleId: "a", principalId: "me", workspaceId: "old" })).toBe("owner");
  stub(() => Response.json({}, { status: 403 }));
  await expect(resolveAppRole({ capsuleId: "a", workspaceId: "old" })).rejects.toBeInstanceOf(ControlApiError);
  expect(calls).toHaveLength(1);
});
test("sharing reads hide only on404 and sends explicit connection/code consent", async () => {
  stub(() => Response.json({ transferId: "tr_one", state: "pending" }));
  await inviteAppMember("app /a", "member@example.test", "connections_and_code");
  await removeAppMember("app /a", "account /b");
  await transferAppOwnership("app /a", "account /b");
  await acceptAppOwnershipTransfer("transfer /a");
  await cancelAppOwnershipTransfer("transfer /a");
  expect(calls.map(({ path, method, body }) => ({ path, method, body }))).toEqual([
    { path: "/api/v1/capsules/app%20%2Fa/members", method: "POST", body: { email: "member@example.test", consent: "connections_and_code" } },
    { path: "/api/v1/capsules/app%20%2Fa/members/account%20%2Fb", method: "DELETE", body: undefined },
    { path: "/api/v1/capsules/app%20%2Fa/ownership-transfers", method: "POST", body: { toAccountId: "account /b" } },
    { path: "/api/v1/ownership-transfers/transfer%20%2Fa/accept", method: "POST", body: undefined },
    { path: "/api/v1/ownership-transfers/transfer%20%2Fa", method: "DELETE", body: undefined },
  ]);
  stub(() => Response.json({ error: { code: "route_not_found" } }, { status: 404 })); expect(await getAppMembers("a")).toBeUndefined();
  stub(() => Response.json({}, { status: 403 })); await expect(getAppMembers("a")).rejects.toMatchObject({ status: 403 });
});
test("member choices accept only marked owner labels and explicitly bindable operator labels", async () => {
  const rows = [
    { id: "owner", displayName: "Owner cloud", providerSource: "p", scope: "personal", ownerAccountId: "owner", secretMetadata: "excluded" },
    { id: "member", displayName: "Member cloud", providerSource: "p", scope: "personal", ownerAccountId: "member" },
    { id: "unknown", displayName: "Unknown", providerSource: "p", scope: "personal" },
    { id: "operator", displayName: "Provided", providerSource: "p", scope: "operator", operatorBindable: true },
    { id: "unbound", displayName: "Unbound", providerSource: "p", scope: "operator" },
  ];
  stub(() => Response.json({ projection: "app-owner-connection-labels", ownerAccountId: "owner", connections: rows }));
  expect(await getAppConnectionChoices("a", "owner")).toEqual([
    { id: "owner", displayName: "Owner cloud", providerSource: "p", scope: "personal" },
    { id: "operator", displayName: "Provided", providerSource: "p", scope: "operator" },
  ]);
  for (const body of [{ connections: rows }, { projection: "app-owner-connection-labels", ownerAccountId: "other", connections: rows }]) {
    stub(() => Response.json(body)); expect(await getAppConnectionChoices("a", "owner")).toBeUndefined();
  }
  stub(() => Response.json({ error: { code: "route_not_found" } }, { status: 404 })); expect(await getAppConnectionChoices("a", "owner")).toBeUndefined();
});
test("personal connections omit legacy workspace scope;403 cannot select legacy connections", async () => {
  stub((path) => Response.json(path === "/api/v1/apps" ? { apps: [] } : { connections: [{ id: "personal" }] }));
  expect(await listConnections("old")).toEqual([{ id: "personal" }]);
  expect(calls.at(-1)?.path).toBe("/api/v1/connections");
  await createConnection({ workspaceId: "old", provider: "p", credentialRecipe: { id: "r", authMode: "key", secretPartition: "p" }, values: {} });
  expect(calls.at(-1)?.body).not.toHaveProperty("workspaceId");
  stub(() => Response.json({}, { status: 403 }));
  await expect(listConnections("old")).rejects.toMatchObject({ status: 403 }); expect(calls).toHaveLength(1);
});
test("personal usage preserves the payer response and never substitutes legacy workspace usage", async () => {
  stub(() => Response.json({ usageEvents: [{ id: "mine" }], nextCursor: "more" }));
  expect(await listPersonalUsagePage(undefined, { limit: 5, cursor: "a" })).toEqual({ usageEvents: [{ id: "mine" }], nextCursor: "more" });
  expect(calls[0]?.path).toBe("/api/v1/usage?cursor=a&limit=5");
  stub((path) => path.startsWith("/api/v1/usage") ? Response.json({ error: { code: "route_not_found" } }, { status: 404 }) : Response.json({ usageEvents: [{ id: "legacy" }] }));
  await expect(listPersonalUsagePage("old")).rejects.toMatchObject({ status: 404 });
  expect(calls.map((call) => call.path)).toEqual(["/api/v1/usage"]);
  stub(() => Response.json({}, { status: 403 })); await expect(listPersonalUsagePage("old")).rejects.toMatchObject({ status: 403 }); expect(calls).toHaveLength(1);
});
test("install capability selects the personal or legacy path and preserves the request/key", async () => {
  const body = { mode: "attempt", source: { url: "https://example.test/app.git" } } as const;
  stub((path) => Response.json(path === "/api/v1/apps" ? { apps: [] } : { installPlan: { id: "plan" } }));
  await createGitInstallAttempt(undefined, body, "key"); expect(calls[1]?.path).toBe("/api/v1/install-plans"); expect(calls[1]?.body).toEqual(body);
  stub((path) => ["/api/v1/install-plans", "/api/v1/apps"].includes(path) ? Response.json({ error: { code: "route_not_found" } }, { status: 404 }) : Response.json({}));
  await createGitInstallAttempt("old", body, "key"); expect(calls.map((call) => [call.path, call.key, call.body])).toEqual([["/api/v1/apps", null, undefined], ["/api/v1/workspaces/old/install-plans", "key", body]]);
  stub(() => Response.json({}, { status: 403 })); await expect(createGitInstallAttempt("old", body, "key")).rejects.toMatchObject({ status: 403 }); expect(calls).toHaveLength(1);
});
test("stable ref resolver tries account route before404 legacy fallback", async () => {
  stub((path) => path === "/api/v1/apps" ? Response.json({ apps: [] }) : path === "/api/v1/source-ref-resolutions/stable-semver" ? Response.json({ error: { code: "route_not_found" } }, { status: 404 }) : Response.json({ tag: "v1.0.0", commit: "a".repeat(40) }));
  expect((await resolveStableSourceTag("old", "https://example.test/app.git")).tag).toBe("v1.0.0");
  expect(calls.map((call) => call.path)).toEqual(["/api/v1/apps", "/api/v1/source-ref-resolutions/stable-semver", "/api/v1/workspaces/old/source-ref-resolutions/stable-semver"]);
});
test("members cannot open any uninstall action disguised as retry or review", () => {
  for (const app of [
    { primaryAction: "uninstall_now", problems: [], progress: {} },
    { primaryAction: "cancel_uninstall", problems: [], progress: {} },
    { primaryAction: "retry", problems: [{ severity: "error", code: "uninstall_failed", runType: "destroy_plan" }], progress: {} },
    { primaryAction: "review", problems: [], progress: { review: { runType: "destroy_apply" } } },
  ] as unknown as CapsuleAppView[]) {
    expect(appPrimaryAllowed("member", app)).toBe(false); expect(appPrimaryAllowed(undefined, app)).toBe(false); expect(appPrimaryAllowed("owner", app)).toBe(true);
  }
  expect(appPrimaryAllowed("member", { primaryAction: "retry", problems: [{ severity: "error", code: "run_failed", runType: "plan" }], progress: {} } as unknown as CapsuleAppView)).toBe(true);
});

test("app detail accepts capsule authority without a legacy workspace", async () => {
  const capsule = { id: "a", name: "app", slug: "app", installConfigId: "ic", environment: "production", currentStateGeneration: 0, status: "pending", createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" };
  stub(() => Response.json({ capsule, installConfigReAdoption: { authorityGuard: "guard" } }));
  expect(await getCapsuleConfigurationContext("a")).toEqual({ capsule, authorityGuard: "guard" });
});

test("a semantic404 from install does not create a legacy attempt", async () => {
  stub((path) => path === "/api/v1/apps" ? Response.json({ apps: [] }) : Response.json({ error: { code: "source_not_found", message: "Repository unavailable" } }, { status: 404 }));
  await expect(createGitInstallAttempt("old", { mode: "attempt", source: { url: "https://example.test/app.git" } }, "key")).rejects.toMatchObject({ code: "source_not_found" });
  expect(calls).toHaveLength(2);
});

test("missing personal usage without legacy context stays unavailable rather than becoming zero usage", async () => {
  stub(() => Response.json({ error: { code: "route_not_found" } }, { status: 404 }));
  await expect(listPersonalUsagePage()).rejects.toMatchObject({ status: 404 });
  expect(calls).toHaveLength(1);
});

test("direct entry discovers an existing legacy context only after a new route404, without creating one", async () => {
  stub((path) => {
    if (["/api/v1/install-plans", "/api/v1/apps"].includes(path)) return Response.json({ error: { code: "route_not_found" } }, { status: 404 });
    if (path.startsWith("/api/v1/workspaces?")) return Response.json({ workspaces: [{ id: "existing" }] });
    return Response.json({ installPlan: { id: "legacy" } });
  });
  await createGitInstallAttempt(undefined, { mode: "attempt", source: { url: "https://example.test/app.git" } }, "same-key");
  expect(calls.map((call) => [call.method, call.path])).toEqual([
    ["GET", "/api/v1/apps"], ["GET", "/api/v1/workspaces?limit=50&order=updated_desc"], ["POST", "/api/v1/workspaces/existing/install-plans"],
  ]);
  expect(calls[2]?.key).toBe("same-key");
});

test("legacy viewer membership is not widened into app management", async () => {
  stub((path) => {
    if (path === "/api/v1/apps") return Response.json({ error: { code: "route_not_found" } }, { status: 404 });
    if (path.endsWith("/members")) return Response.json({ members: [{ accountId: "me", status: "active", roles: ["viewer"] }] });
    return Response.json({ workspace: { ownerUserId: "other" } });
  });
  expect(await resolveAppRole({ capsuleId: "a", accountId: "me", workspaceId: "old" })).toBeUndefined();
});

test("one account app read serves roles, providers, OAuth, and connection creation until reset", async () => {
  stub((path) => {
    if (path === "/api/v1/apps") return Response.json({ apps: [{ capsuleId: "a", role: "member" }] });
    if (path === "/api/v1/connections") return Response.json({ connections: [], connection: { id: "created" } });
    return Response.json({ authorizationUrl: "https://provider.example.test/authorize", state: "state" });
  });
  expect(await resolveAppRole({ capsuleId: "a", workspaceId: "stale" })).toBe("member");
  expect(await appOwnershipAvailable()).toBe(true);
  await listConnections("stale");
  await createConnection({ workspaceId: "stale", provider: "p", credentialRecipe: { id: "r", authMode: "key", secretPartition: "p" }, values: {} });
  await startConnectionOAuth({ helperId: "helper", workspaceId: "stale" });
  expect(calls.filter((call) => call.path === "/api/v1/apps")).toHaveLength(1);
  expect(calls.filter((call) => call.method === "POST").every((call) => !Object.hasOwn(call.body as object, "workspaceId"))).toBe(true);
  resetAppOwnershipCache();
  await appOwnershipAvailable();
  expect(calls.filter((call) => call.path === "/api/v1/apps")).toHaveLength(2);
});

test("aborting one app reader leaves the shared capability request available to other views", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { finish = resolve; });
  resetAppOwnershipCache();
  let reads = 0;
  globalThis.fetch = (async () => { reads += 1; return await pending; }) as typeof fetch;
  const abort = new AbortController();
  const abandoned = listAccessibleApps(abort.signal);
  const active = appOwnershipAvailable();
  abort.abort();
  await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
  finish(Response.json({ apps: [] }));
  expect(await active).toBe(true);
  expect(await appOwnershipAvailable()).toBe(true);
  expect(reads).toBe(1);
});

test("app data expires after ten seconds while provider availability remains session-cached", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    stub((path) => path === "/api/v1/apps" ? Response.json({ apps: [] }) : Response.json({ connections: [] }));
    await appOwnershipAvailable();
    now += 10_001;
    await listConnections("stale");
    expect(calls.filter((call) => call.path === "/api/v1/apps")).toHaveLength(1);
    await listAccessibleApps();
    expect(calls.filter((call) => call.path === "/api/v1/apps")).toHaveLength(2);
    await inviteAppMember("app", "member@example.test", "connections_and_code");
    await listAccessibleApps();
    expect(calls.filter((call) => call.path === "/api/v1/apps")).toHaveLength(3);
  } finally {
    Date.now = realNow;
  }
});

test("route absence uses machine-readable markers; generic business not_found never falls back", async () => {
  for (const body of [
    { error: { code: "not_found", details: { reason: "source_not_found" } } },
    {},
  ]) {
    stub(() => Response.json(body, { status: 404 }));
    await expect(listAccessibleApps()).rejects.toMatchObject({ status: 404 });
    await expect(createGitInstallAttempt("old", { mode: "attempt", source: { url: "https://example.test/app.git" } }, "key")).rejects.toMatchObject({ status: 404 });
    expect(calls.every((call) => !call.path.includes("workspaces"))).toBe(true);
  }
  expect(isMissingControlRoute(new ControlApiError(404, "not_found", "Source not found", { error: { code: "not_found", details: { reason: "source_not_found" } } }))).toBe(false);
  expect(isMissingControlRoute(new ControlApiError(404, "not_found", "ignored", { error: "not_found" }))).toBe(true);
  expect(isMissingControlRoute(new ControlApiError(404, "not_found", "ignored", { error: { code: "not_found", details: { reason: "route_not_found" } } }))).toBe(true);
});

test("only missing apps may create a legacy personal install context for a zero-workspace account", async () => {
  stub((path, method) => {
    // Actual legacy dispatcher envelope, scoped to the GET /apps probe.
    if (path === "/api/v1/apps") return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    if (method === "POST") return Response.json({ workspace: { id: "created" } });
    return Response.json({ workspaces: [] });
  });
  const contexts = await Promise.all([legacyInstallWorkspaceId(), legacyInstallWorkspaceId()]);
  expect(contexts).toEqual(["created", "created"]);
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({ type: "personal" });

  stub(() => Response.json({ apps: [] }));
  expect(await legacyInstallWorkspaceId("stale")).toBeUndefined();
  expect(calls.map((call) => call.path)).toEqual(["/api/v1/apps"]);
});

test("a modern install business not_found never selects the legacy install route", async () => {
  stub((path) => path === "/api/v1/apps" ? Response.json({ apps: [] }) : Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 }));
  await expect(createGitInstallAttempt("stale", { mode: "attempt", source: { url: "https://example.test/app.git" } }, "key")).rejects.toMatchObject({ code: "not_found" });
  expect(calls.map((call) => call.path)).toEqual(["/api/v1/apps", "/api/v1/install-plans"]);
});

test("an absent later app page cannot downgrade the present account API to legacy", async () => {
  stub((path) => path === "/api/v1/apps" ? Response.json({ apps: [], nextCursor: "next" }) : Response.json({ error: { code: "route_not_found" } }, { status: 404 }));
  await expect(appOwnershipAvailable()).rejects.toMatchObject({ status: 502, code: "invalid_apps_response" });
  expect(calls.every((call) => !call.path.includes("workspaces"))).toBe(true);
});

test("personal OAuth starts without workspace and falls back only on an absent route", async () => {
  stub((path, _method, body) => {
    if (path === "/api/v1/apps") return Response.json({ apps: [] });
    if (!(body as { workspaceId?: string })?.workspaceId) return Response.json({ error: { code: "route_not_found" } }, { status: 404 });
    return Response.json({ authorizationUrl: "https://provider.example.test/authorize", state: "state" });
  });
  expect(await startConnectionOAuth({ helperId: "helper", workspaceId: "old" })).toMatchObject({ state: "state", legacyWorkspaceId: "old" });
  expect(calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([{}, { workspaceId: "old" }]);

  for (const body of [{ error: { code: "not_found", message: "Unknown helper" } }, { error: { code: "permission_denied" } }]) {
    stub((path) => path === "/api/v1/apps" ? Response.json({ apps: [] }) : Response.json(body, { status: 404 }));
    await expect(startConnectionOAuth({ helperId: "helper", workspaceId: "old" })).rejects.toMatchObject({ status: 404 });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  }
});

test("ownership transfer lists are pending-only and keep app and incoming routes separate", async () => {
  const transfer = { transferId: "tr_1", capsuleId: "app /a", fromAccountId: "owner", toAccountId: "member", state: "pending" };
  stub(() => Response.json({ transfers: [transfer] }));
  expect(await listAppOwnershipTransfers("app /a")).toEqual([transfer]);
  expect(await listIncomingOwnershipTransfers()).toEqual([transfer]);
  expect(calls.map((call) => call.path)).toEqual([
    "/api/v1/capsules/app%20%2Fa/ownership-transfers?state=pending", "/api/v1/ownership-transfers?state=pending",
  ]);
  stub(() => Response.json({ error: { code: "route_not_found" } }, { status: 404 }));
  expect(await listIncomingOwnershipTransfers()).toBeUndefined();
  stub(() => Response.json({ error: { code: "not_found", message: "App not found" } }, { status: 404 }));
  await expect(listAppOwnershipTransfers("a")).rejects.toMatchObject({ code: "not_found" });
});
