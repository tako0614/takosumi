import { afterEach, expect, test } from "bun:test";
import { matchingInstalledApps } from "takosumi-contract";
import {
  listInstalledApps,
  listOpenGitInstallAttempts,
  resetAppOwnershipCache,
} from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const repository = "https://github.com/example/office.git";
const now = "2026-10-28T00:00:00.000Z";
const app = (id: string, state = "installed") => ({
  capsuleId: id, name: id, role: "owner", ownerDisplayName: "Owner",
  state, primaryAction: "open",
});
const capsule = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, name: id, slug: id, installConfigId: `cfg_${id}`,
  sourceId: `src_${id}`, environment: "production", currentStateGeneration: 1,
  status: "active", createdAt: now, updatedAt: now, ...overrides,
});
const config = (id: string, overrides: Record<string, unknown> = {}) => ({
  id: `cfg_${id}`, name: id,
  sourceSelector: { url: repository, path: "./src/" },
  modulePath: "./deploy/app/", ...overrides,
});

function stub(reply: (path: string) => Response | Promise<Response>) {
  resetAppOwnershipCache();
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    return await reply(path);
  }) as typeof fetch;
  return calls;
}

test("Store identity uses authorized app details and exact config coordinates without a Workspace", async () => {
  const calls = stub((path) => {
    if (path === "/api/v1/apps") return Response.json({ apps: [app("cap_a", "update_available")] });
    if (path === "/api/v1/capsules/cap_a") return Response.json({ capsule: capsule("cap_a") });
    if (path === "/api/v1/capsule-configs/cfg_cap_a") return Response.json({
      installConfig: config("cap_a", {
        store: { name: { ja: "オフィス", en: "Office" }, iconUrl: "https://example.test/icon.png" },
      }),
    });
    throw new Error(`unexpected ${path}`);
  });
  const result = await listInstalledApps();
  expect(result).toEqual({
    installedApps: [{
      capsuleId: "cap_a", name: "cap_a", displayName: { ja: "オフィス", en: "Office" },
      iconUrl: "https://example.test/icon.png", state: "installed",
      installedFrom: { url: repository, path: "src/deploy/app" },
    }],
    complete: true,
  });
  expect(matchingInstalledApps(result.installedApps, { url: `${repository}/`, path: "src/deploy/app" })).toHaveLength(1);
  expect(matchingInstalledApps(result.installedApps, { url: repository, path: "src/deploy/other" })).toHaveLength(0);
  expect(calls).toEqual([
    "/api/v1/apps", "/api/v1/capsules/cap_a", "/api/v1/capsule-configs/cfg_cap_a",
  ]);
});

test("partial detail failures keep proven rows and private source queries cannot match", async () => {
  const calls = stub((path) => {
    if (path === "/api/v1/apps") return Response.json({ apps: [app("good"), app("failed"), app("private")] });
    if (path.startsWith("/api/v1/capsules/")) return Response.json({ capsule: capsule(path.split("/").at(-1)!) });
    if (path === "/api/v1/capsule-configs/cfg_failed") return Response.json({}, { status: 503 });
    if (path === "/api/v1/capsule-configs/cfg_private") return Response.json({
      installConfig: config("private", { sourceSelector: { url: `${repository}?token=secret`, path: "src" } }),
    });
    if (path.startsWith("/api/v1/capsule-configs/")) return Response.json({ installConfig: config("good") });
    throw new Error(`unexpected ${path}`);
  });
  const result = await listInstalledApps();
  expect(result.complete).toBe(false);
  expect(result.installedApps.map((row) => row.capsuleId)).toEqual(["good", "private"]);
  expect(result.installedApps[1]?.installedFrom).toEqual({ url: repository, path: "src/deploy/app", matchable: false });
  expect(matchingInstalledApps(result.installedApps, { url: repository, path: "src/deploy/app" }).map((row) => row.capsuleId)).toEqual(["good"]);
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(calls.some((path) => path.startsWith("/api/v1/sources/"))).toBe(false);
});

test("legacy config falls back to authorized Source rather than Store presentation", async () => {
  const calls = stub((path) => {
    if (path === "/api/v1/apps") return Response.json({ apps: [app("legacy")] });
    if (path === "/api/v1/capsules/legacy") return Response.json({ capsule: capsule("legacy", { workspaceId: "ws_a" }) });
    if (path === "/api/v1/capsule-configs/cfg_legacy") return Response.json({ installConfig: config("legacy", { sourceSelector: undefined }) });
    if (path === "/api/v1/sources/src_legacy") return Response.json({ source: {
      id: "src_legacy", workspaceId: "ws_a", name: "legacy", url: repository,
      defaultRef: "main", defaultPath: "./legacy/", status: "active", autoSync: false,
      createdAt: now, updatedAt: now,
    } });
    throw new Error(`unexpected ${path}`);
  });
  const result = await listInstalledApps();
  expect(result).toMatchObject({ installedApps: [{ installedFrom: { url: repository, path: "legacy/deploy/app" } }], complete: true });
  expect(calls).toContain("/api/v1/sources/src_legacy");
});

test("a later app-list failure retains known identities and marks discovery incomplete", async () => {
  const calls = stub((path) => {
    if (path === "/api/v1/apps") return Response.json({ apps: [app("known")], nextCursor: "next" });
    if (path === "/api/v1/apps?cursor=next") return Response.json({}, { status: 503 });
    if (path === "/api/v1/capsules/known") return Response.json({ capsule: capsule("known") });
    if (path === "/api/v1/capsule-configs/cfg_known") return Response.json({ installConfig: config("known") });
    throw new Error(`unexpected ${path}`);
  });
  expect(await listInstalledApps()).toMatchObject({ installedApps: [{ capsuleId: "known" }], complete: false });
  expect(calls).toContain("/api/v1/apps?cursor=next");

  stub((path) => {
    if (path === "/api/v1/apps") return Response.json({ apps: [app("known"), { capsuleId: "broken" }] });
    if (path === "/api/v1/capsules/known") return Response.json({ capsule: capsule("known") });
    if (path === "/api/v1/capsule-configs/cfg_known") return Response.json({ installConfig: config("known") });
    throw new Error(`unexpected ${path}`);
  });
  await expect(listInstalledApps()).rejects.toMatchObject({ status: 502, code: "invalid_installed_apps_response" });

  stub((path) => {
    if (path === "/api/v1/apps") return Response.json({ apps: [app("known")], nextCursor: "next" });
    if (path === "/api/v1/apps?cursor=next") return Response.json({ apps: [{ capsuleId: "broken" }] });
    if (path === "/api/v1/capsules/known") return Response.json({ capsule: capsule("known") });
    if (path === "/api/v1/capsule-configs/cfg_known") return Response.json({ installConfig: config("known") });
    throw new Error(`unexpected ${path}`);
  });
  expect(await listInstalledApps()).toMatchObject({ installedApps: [{ capsuleId: "known" }], complete: false });
});

test("discovery caps at 200 apps and never exceeds four concurrent detail reads", async () => {
  let active = 0;
  let peak = 0;
  const calls = stub(async (path) => {
    if (path === "/api/v1/apps") return Response.json({ apps: Array.from({ length: 201 }, (_, i) => app(`cap_${i}`)) });
    if (path.startsWith("/api/v1/capsules/")) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return Response.json({ capsule: capsule(path.split("/").at(-1)!) });
    }
    if (path.startsWith("/api/v1/capsule-configs/")) return Response.json({ installConfig: config(path.slice("/api/v1/capsule-configs/cfg_".length)) });
    throw new Error(`unexpected ${path}`);
  });
  const result = await listInstalledApps();
  expect(result).toMatchObject({ complete: false });
  expect(result.installedApps).toHaveLength(200);
  expect(calls.filter((path) => path.startsWith("/api/v1/capsules/"))).toHaveLength(200);
  expect(peak).toBeLessThanOrEqual(4);
  expect(peak).toBe(4);
});

test("only missing /apps falls back to an existing authorized legacy Workspace", async () => {
  const calls = stub((path) => {
    if (path === "/api/v1/apps") return Response.json({ error: { code: "route_not_found" } }, { status: 404 });
    if (path.startsWith("/api/v1/workspaces?")) return Response.json({ workspaces: [{ id: "ws_a" }], returned: 1, limit: 50, truncated: false });
    if (path === "/api/v1/workspaces/ws_a/installed-apps") return Response.json({ installedApps: [{ capsuleId: "old" }], complete: true });
    if (path === "/api/v1/workspaces/ws_a/install-plans?open=1") return Response.json({ installPlans: [
      { installPlan: { id: "gip_1", workspaceId: "ws_a" } },
      { installPlan: { id: "gip_2", workspaceId: "ws_else" } },
    ] });
    throw new Error(`unexpected ${path}`);
  });
  expect(await listInstalledApps()).toEqual({ installedApps: [{ capsuleId: "old" }], complete: true });
  expect((await listOpenGitInstallAttempts()).map((row) => row.installPlan.id)).toEqual(["gip_1"]);
  expect(calls).toContain("/api/v1/workspaces/ws_a/installed-apps");
  expect(calls).toContain("/api/v1/workspaces/ws_a/install-plans?open=1");

  const absent = stub((path) => {
    if (path === "/api/v1/apps") return Response.json({ error: { code: "route_not_found" } }, { status: 404 });
    if (path.startsWith("/api/v1/workspaces?")) return Response.json({ workspaces: [], returned: 0, limit: 50, truncated: false });
    throw new Error(`unexpected ${path}`);
  });
  expect(await listInstalledApps()).toEqual({ installedApps: [], complete: false });
  expect(await listOpenGitInstallAttempts()).toEqual([]);
  expect(absent.some((path) => path.includes("/installed-apps") || path.includes("/install-plans"))).toBe(false);
});

test("first-page failures go to Retry and never fall back", async () => {
  for (const status of [401, 403, 503]) {
    const calls = stub(() => Response.json({}, { status }));
    await expect(listInstalledApps()).rejects.toMatchObject({ status });
    expect(calls).toEqual(["/api/v1/apps"]);
  }
  const calls = stub(() => Response.json({ unexpected: [] }));
  await expect(listInstalledApps()).rejects.toMatchObject({ status: 502, code: "invalid_installed_apps_response" });
  expect(calls).toEqual(["/api/v1/apps"]);
});
