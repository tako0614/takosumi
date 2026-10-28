import { expect, test } from "bun:test";
import { matchingInstalledApps, type ListInstalledAppsResponse } from "takosumi-contract";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { createInMemoryInterfaceStores } from "../../../../core/domains/interfaces/mod.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

async function fixture(withSelector = true, sourceUrl = "https://reader:private-password@git.example.test/team/app.git?token=private-token#private-fragment") {
  const ledger = new InMemoryOpenTofuControlStore();
  for (const [id, modulePath, status] of [
    ["cap_first", "deploy/app", "active"],
    ["cap_second", "deploy/app", "stale"],
    ["cap_other_module", "deploy/other", "active"],
    ["cap_removed", "deploy/app", "destroyed"],
  ] as const) {
    const seeded = await seedCapsuleModel(ledger, {
      workspaceId: "ws_installed", capsuleId: id, sourceId: `src_${id}`,
      snapshotId: `snap_${id}`, installConfigId: `cfg_${id}`, name: id,
      sourceUrl,
      installConfig: {
        sourceSelector: withSelector ? { url: sourceUrl, path: "subtree" } : undefined,
        modulePath,
      },
      requiredProviders: [],
    });
    await ledger.putCapsule({ ...seeded.capsule, status, currentStateGeneration: 1 });
  }
  const { operations } = await createTakosumiService({
    role: "takosumi-api", runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: ledger, interfaceStores: createInMemoryInterfaceStores(),
  });
  const accounts = new InMemoryAccountsStore();
  const now = Date.now();
  for (const subject of ["user_test", "stranger"]) {
    accounts.saveAccount({ subject, createdAt: now, updatedAt: now });
    accounts.saveAccountSession({ sessionId: `sess_${subject}`, subject, createdAt: now, expiresAt: now + 60_000 });
  }
  async function request(subject = "user_test", method = "GET") {
    const url = new URL("https://app.example.test/api/v1/workspaces/ws_installed/installed-apps");
    const response = await handleControlRoute({
      request: new Request(url, { method, headers: subject ? { cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=sess_${subject}` } : {} }),
      url, store: accounts, operations: operations as never,
    });
    expect(response).toBeDefined();
    return response!;
  }
  return { request };
}

test("installed-apps summarizes each live install by executable module without values", async () => {
  const h = await fixture();
  const response = await h.request();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json() as ListInstalledAppsResponse;
  expect(body.installedApps).toHaveLength(3);
  expect(body.installedApps.find((app) => app.capsuleId === "cap_first")).toEqual({
    capsuleId: "cap_first", name: "cap_first", state: "installed", primaryAction: "view_resources",
    installedFrom: { url: "https://git.example.test/team/app.git", path: "subtree/deploy/app" },
  });
  expect(body.installedApps.find((app) => app.capsuleId === "cap_second")?.installedFrom.path).toBe("subtree/deploy/app");
  expect(body.installedApps.find((app) => app.capsuleId === "cap_other_module")?.installedFrom.path).toBe("subtree/deploy/other");
  const encoded = JSON.stringify(body);
  for (const value of ["private-password", "private-token", "private-fragment", "outputs", "resolvedInputs", "installingPrincipalId", "screens", "links"]) {
    expect(encoded).not.toContain(value);
  }
});

test("installed-apps derives old configs from the Source and selected module", async () => {
  const h = await fixture(false);
  const body = await (await h.request()).json() as ListInstalledAppsResponse;
  expect(body.installedApps.find((app) => app.capsuleId === "cap_first")?.installedFrom).toEqual({
    url: "https://git.example.test/team/app.git", path: "deploy/app",
  });
});

test("value-free route summaries match queried HTTPS, SSH and scp Store coordinates", async () => {
  for (const url of [
    "https://git.example.test/team/app.git?variant=one",
    "ssh://git@git.example.test/team/app.git?token=private-token#private-fragment",
    "git@git.example.test:team/app.git?token=private-token#private-fragment",
  ]) {
    const h = await fixture(true, url);
    const body = await (await h.request()).json() as ListInstalledAppsResponse;
    expect(matchingInstalledApps(body.installedApps, { url, path: "subtree/deploy/app" })
      .map((app) => app.capsuleId).sort()).toEqual(["cap_first", "cap_second"]);
    const encoded = JSON.stringify(body);
    for (const value of ["git@", "private-token", "private-fragment", "variant=one"]) {
      expect(encoded).not.toContain(value);
    }
  }
});

test("installed-apps uses the normal Workspace membership and read-only method boundary", async () => {
  const h = await fixture();
  expect((await h.request("stranger")).status).toBe(403);
  expect((await h.request("")).status).toBe(401);
  expect((await h.request("user_test", "POST")).status).toBe(405);
});
