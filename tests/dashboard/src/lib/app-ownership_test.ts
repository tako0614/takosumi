import { afterEach, expect, test } from "bun:test";
import {
  acceptAppOwnershipTransfer, cancelAppOwnershipTransfer, ControlApiError,
  createConnection, createGitInstallAttempt, getAppConnectionChoices, getAppMembers, getCapsuleConfigurationContext,
  inviteAppMember, listAccessibleApps, listConnections, listPersonalUsagePage,
  removeAppMember, resolveStableSourceTag, transferAppOwnership,
  type CapsuleAppView,
} from "../../../../dashboard/src/lib/control-api.ts";
import { appPrimaryAllowed, resolveAppRole } from "../../../../dashboard/src/lib/app-access.ts";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const calls: { path: string; method: string; body: unknown; key: string | null }[] = [];
function stub(reply: (path: string, method: string, body: unknown) => Response) {
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
  stub(() => Response.json({}, { status: 404 }));
  expect(await listAccessibleApps()).toBeUndefined();
});
test("role is app-specific; only missing app routes consult legacy owner", async () => {
  stub((path) => Response.json(path === "/api/v1/apps" ? { apps: [{ capsuleId: "a", role: "member" }] } : { workspace: { ownerUserId: "me" } }));
  expect(await resolveAppRole({ capsuleId: "a", accountId: "me", workspaceId: "old" })).toBe("member");
  expect(calls).toHaveLength(1);
  stub((path) => path === "/api/v1/apps" ? Response.json({}, { status: 404 }) : Response.json({ workspace: { ownerUserId: "me" } }));
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
  stub(() => Response.json({}, { status: 404 })); expect(await getAppMembers("a")).toBeUndefined();
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
  stub(() => Response.json({}, { status: 404 })); expect(await getAppConnectionChoices("a", "owner")).toBeUndefined();
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
test("personal usage cursor and404 fallback preserve payer response without masking403", async () => {
  stub(() => Response.json({ usageEvents: [{ id: "mine" }], nextCursor: "more" }));
  expect(await listPersonalUsagePage(undefined, { limit: 5, cursor: "a" })).toEqual({ usageEvents: [{ id: "mine" }], nextCursor: "more" });
  expect(calls[0]?.path).toBe("/api/v1/usage?cursor=a&limit=5");
  stub((path) => path.startsWith("/api/v1/usage") ? Response.json({}, { status: 404 }) : Response.json({ usageEvents: [{ id: "legacy" }] }));
  expect((await listPersonalUsagePage("old")).usageEvents).toEqual([{ id: "legacy" }]);
  stub(() => Response.json({}, { status: 403 })); await expect(listPersonalUsagePage("old")).rejects.toMatchObject({ status: 403 }); expect(calls).toHaveLength(1);
});
test("workspace-less install preserves request/key on404 fallback and never falls back on403", async () => {
  const body = { mode: "attempt", source: { url: "https://example.test/app.git" } } as const;
  stub(() => Response.json({ installPlan: { id: "plan" } }));
  await createGitInstallAttempt(undefined, body, "key"); expect(calls[0]?.path).toBe("/api/v1/install-plans"); expect(calls[0]?.body).toEqual(body);
  stub((path) => path === "/api/v1/install-plans" ? Response.json({}, { status: 404 }) : Response.json({}));
  await createGitInstallAttempt("old", body, "key"); expect(calls.map((call) => [call.path, call.key, call.body])).toEqual([["/api/v1/install-plans", "key", body], ["/api/v1/workspaces/old/install-plans", "key", body]]);
  stub(() => Response.json({}, { status: 403 })); await expect(createGitInstallAttempt("old", body, "key")).rejects.toMatchObject({ status: 403 }); expect(calls).toHaveLength(1);
});
test("stable ref resolver tries account route before404 legacy fallback", async () => {
  stub((path) => path === "/api/v1/source-ref-resolutions/stable-semver" ? Response.json({}, { status: 404 }) : Response.json({ tag: "v1.0.0", commit: "a".repeat(40) }));
  expect((await resolveStableSourceTag("old", "https://example.test/app.git")).tag).toBe("v1.0.0");
  expect(calls.map((call) => call.path)).toEqual(["/api/v1/source-ref-resolutions/stable-semver", "/api/v1/workspaces/old/source-ref-resolutions/stable-semver"]);
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
  stub(() => Response.json({ error: { code: "source_not_found", message: "Repository unavailable" } }, { status: 404 }));
  await expect(createGitInstallAttempt("old", { mode: "attempt", source: { url: "https://example.test/app.git" } }, "key")).rejects.toMatchObject({ code: "source_not_found" });
  expect(calls).toHaveLength(1);
});

test("missing personal usage without legacy context stays unavailable rather than becoming zero usage", async () => {
  stub(() => Response.json({}, { status: 404 }));
  await expect(listPersonalUsagePage()).rejects.toMatchObject({ status: 404 });
  expect(calls).toHaveLength(2);
});

test("direct entry discovers an existing legacy context only after a new route404, without creating one", async () => {
  stub((path) => {
    if (path === "/api/v1/install-plans") return Response.json({}, { status: 404 });
    if (path.startsWith("/api/v1/workspaces?")) return Response.json({ workspaces: [{ id: "existing" }] });
    return Response.json({ installPlan: { id: "legacy" } });
  });
  await createGitInstallAttempt(undefined, { mode: "attempt", source: { url: "https://example.test/app.git" } }, "same-key");
  expect(calls.map((call) => [call.method, call.path])).toEqual([
    ["POST", "/api/v1/install-plans"], ["GET", "/api/v1/workspaces?limit=50&order=updated_desc"], ["POST", "/api/v1/workspaces/existing/install-plans"],
  ]);
  expect(calls[0]?.key).toBe(calls[2]?.key);
});

test("legacy viewer membership is not widened into app management", async () => {
  stub((path) => {
    if (path === "/api/v1/apps") return Response.json({}, { status: 404 });
    if (path.endsWith("/members")) return Response.json({ members: [{ accountId: "me", status: "active", roles: ["viewer"] }] });
    return Response.json({ workspace: { ownerUserId: "other" } });
  });
  expect(await resolveAppRole({ capsuleId: "a", accountId: "me", workspaceId: "old" })).toBeUndefined();
});
