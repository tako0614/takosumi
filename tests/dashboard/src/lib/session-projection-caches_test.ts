import { afterEach, expect, test } from "bun:test";
import { clearSession, refreshSession } from "../../../../dashboard/src/views/account/lib/session.ts";
import { listCapsulesCached } from "../../../../dashboard/src/lib/capsule-list.ts";
import { listInstallConfigsCached } from "../../../../dashboard/src/lib/install-config-list.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  clearSession();
  globalThis.fetch = realFetch;
});

test("an identity switch fences old app and install-config reads without discarding same-account caches", async () => {
  let subject = "a";
  let releaseApps!: (value: Response) => void;
  let releaseConfigs!: (value: Response) => void;
  const apps = new Promise<Response>((resolve) => { releaseApps = resolve; });
  const configs = new Promise<Response>((resolve) => { releaseConfigs = resolve; });
  let appReads = 0;
  let configReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=false") {
      return Response.json({ session: { subject } });
    }
    if (path.includes("/capsules")) {
      appReads++;
      return subject === "a" ? apps : Response.json({ capsules: [{ id: "app_b" }] });
    }
    if (path.includes("/capsule-configs")) {
      configReads++;
      return subject === "a" ? configs : Response.json({ installConfigs: [{ id: "config_b" }] });
    }
    throw new Error(`unexpected read: ${path}`);
  }) as typeof fetch;
  await refreshSession();
  const staleApps = listCapsulesCached("ws_shared");
  const staleConfigs = listInstallConfigsCached("ws_shared");
  subject = "b";
  await refreshSession();
  expect((await listCapsulesCached("ws_shared"))[0]?.id).toBe("app_b");
  expect((await listInstallConfigsCached("ws_shared"))[0]?.id).toBe("config_b");
  releaseApps(Response.json({ capsules: [{ id: "app_a" }] }));
  releaseConfigs(Response.json({ installConfigs: [{ id: "config_a" }] }));
  await Promise.all([staleApps, staleConfigs]);
  await refreshSession();
  expect((await listCapsulesCached("ws_shared"))[0]?.id).toBe("app_b");
  expect((await listInstallConfigsCached("ws_shared"))[0]?.id).toBe("config_b");
  expect(appReads).toBe(2);
  expect(configReads).toBe(2);
});
