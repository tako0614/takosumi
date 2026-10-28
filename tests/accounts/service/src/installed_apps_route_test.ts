import { expect, test } from "bun:test";
import { matchingInstalledApps, type ListInstalledAppsResponse } from "takosumi-contract";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import { handleWorkspaceInstalledApps } from "../../../../accounts/service/src/control/installed-apps.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { createInMemoryInterfaceStores } from "../../../../core/domains/interfaces/mod.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

async function fixture(withSelector = true, sourceUrl = "https://reader:private-password@git.example.test/team/app.git?token=private-token#private-fragment", missingConfigFor?: string) {
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
    await ledger.putCapsule({ ...seeded.capsule, status, currentStateGeneration: 1,
      ...(id === missingConfigFor ? { installConfigId: "cfg_missing" } : {}),
    });
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
  expect(body.complete).toBe(true);
  expect(body.installedApps).toHaveLength(3);
  expect(body.installedApps.find((app) => app.capsuleId === "cap_first")).toEqual({
    capsuleId: "cap_first", name: "cap_first", state: "installed",
    installedFrom: { url: "https://git.example.test/team/app.git", path: "subtree/deploy/app", matchable: false },
  });
  expect(body.installedApps.find((app) => app.capsuleId === "cap_second")?.installedFrom.path).toBe("subtree/deploy/app");
  expect(body.installedApps.find((app) => app.capsuleId === "cap_other_module")?.installedFrom.path).toBe("subtree/deploy/other");
  const encoded = JSON.stringify(body);
  for (const value of ["private-password", "private-token", "private-fragment", "outputs", "resolvedInputs", "installingPrincipalId", "screens", "links"]) {
    expect(encoded).not.toContain(value);
  }
});

test("one unavailable app config does not hide the other installed apps", async () => {
  const h = await fixture(true, "https://git.example.test/team/app.git", "cap_other_module");
  const body = await (await h.request()).json() as ListInstalledAppsResponse;
  expect(body.installedApps.map((app) => app.capsuleId).sort()).toEqual(["cap_first", "cap_second"]);
});

test("installed-apps derives old configs from the Source and selected module", async () => {
  const h = await fixture(false);
  const body = await (await h.request()).json() as ListInstalledAppsResponse;
  expect(body.installedApps.find((app) => app.capsuleId === "cap_first")?.installedFrom).toEqual({
    url: "https://git.example.test/team/app.git", path: "deploy/app", matchable: false,
  });
});

test("queried Sources stay visible by id without matching queryless Store coordinates", async () => {
  for (const url of [
    "https://git.example.test/team/app.git?variant=one",
    "ssh://git@git.example.test/team/app.git?token=private-token#private-fragment",
    "git@git.example.test:team/app.git?token=private-token#private-fragment",
  ]) {
    const h = await fixture(true, url);
    const body = await (await h.request()).json() as ListInstalledAppsResponse;
    expect(body.installedApps.map((app) => app.capsuleId).sort()).toEqual(["cap_first", "cap_other_module", "cap_second"]);
    expect(body.installedApps.every((app) => app.installedFrom.matchable === false)).toBe(true);
    expect(matchingInstalledApps(body.installedApps, { url, path: "subtree/deploy/app" })).toEqual([]);
    expect(matchingInstalledApps(body.installedApps, { url: url.split("?")[0]!, path: "subtree/deploy/app" })).toEqual([]);
    const encoded = JSON.stringify(body);
    for (const value of ["git@", "private-token", "private-fragment", "variant=one"]) {
      expect(encoded).not.toContain(value);
    }
  }
});

test("queryless HTTPS, SSH and scp summaries keep their shape and match normally", async () => {
  for (const url of [
    "https://git.example.test/team/app.git",
    "ssh://git@git.example.test/team/app.git",
    "git@git.example.test:team/app.git",
  ]) {
    const h = await fixture(true, url);
    const body = await (await h.request()).json() as ListInstalledAppsResponse;
    expect(body.installedApps.every((app) => !("matchable" in app.installedFrom))).toBe(true);
    expect(matchingInstalledApps(body.installedApps, { url, path: "subtree/deploy/app" })
      .map((app) => app.capsuleId).sort()).toEqual(["cap_first", "cap_second"]);
  }
});

test("installed-apps uses the normal Workspace membership and read-only method boundary", async () => {
  const h = await fixture();
  expect((await h.request("stranger")).status).toBe(403);
  expect((await h.request("")).status).toBe(401);
  expect((await h.request("user_test", "POST")).status).toBe(405);
});

test("a large Store list uses one config batch and no per-app or Interface candidate reads", async () => {
  const capsules = Array.from({ length: 150 }, (_, index) => ({
    id: `cap_${index}`, workspaceId: "ws_installed", installConfigId: `cfg_${index}`,
    sourceId: `src_${index}`, name: `App ${index}`, status: "active",
    currentStateVersionId: `sv_${index}`, currentStateGeneration: 1,
  }));
  let batchCalls = 0;
  let exactReads = 0;
  let sourceReads = 0;
  const ctx = { operations: {
    capsules: {
      listCapsules: async () => capsules,
      getInstallConfigsByIds: async (ids: readonly string[]) => {
        batchCalls += 1;
        return ids.slice(1).map((id) => ({ id, workspaceId: "ws_installed",
          sourceSelector: { kind: "git", url: "https://git.example.test/team/app.git", path: "." },
        }));
      },
      getInstallConfig: async () => { exactReads += 1; throw new Error("unexpected config read"); },
    },
    listSources: async () => { sourceReads += 1; throw new Error("unexpected source list"); },
    getSource: async () => { sourceReads += 1; throw new Error("unexpected source read"); },
    interfaces: { listInterfaceLinkCandidates: async () => { throw new Error("unexpected candidate read"); } },
  } } as never;
  const response = await handleWorkspaceInstalledApps(ctx, "ws_installed", "GET");
  const body = await response.json() as ListInstalledAppsResponse;
  expect(response.status).toBe(200);
  expect(body.installedApps).toHaveLength(149);
  expect(body.installedApps.some((app) => app.capsuleId === "cap_0")).toBe(false);
  expect(batchCalls).toBe(1);
  expect(exactReads).toBe(0);
  expect(sourceReads).toBe(0);
});

test("a failed bulk config read marks the identity summary incomplete", async () => {
  const ctx = { operations: {
    capsules: {
      listCapsules: async () => [{ id: "cap_unknown", workspaceId: "ws_installed", installConfigId: "cfg_unknown", sourceId: "src_unknown", name: "Unknown app", status: "active", currentStateGeneration: 1 }],
      getInstallConfigsByIds: async () => { throw new Error("database unavailable"); },
    },
    listSources: async () => { throw new Error("must not read Sources without configs"); },
  } } as never;
  const response = await handleWorkspaceInstalledApps(ctx, "ws_installed", "GET");
  const body = await response.json() as ListInstalledAppsResponse;
  expect(body.installedApps).toEqual([]);
  expect(body.complete).toBe(false);
});

test("legacy Source lookup reports bounded pagination truncation", async () => {
  const capsule = { id: "cap_legacy", workspaceId: "ws_installed", installConfigId: "cfg_legacy", sourceId: "src_page_9", name: "Legacy app", status: "active", currentStateGeneration: 1 };
  let pageCalls = 0;
  const ctx = { operations: {
    capsules: {
      listCapsules: async () => [capsule],
      getInstallConfigsByIds: async () => [{ id: "cfg_legacy", workspaceId: "ws_installed", modulePath: "." }],
    },
    listSources: async (_workspaceId: string, options: { cursor?: string }) => {
      pageCalls += 1;
      const index = Number(options.cursor ?? "0");
      return { sources: index === 8 ? [{ id: "src_page_9", workspaceId: "ws_installed", url: "https://git.example.test/team/legacy.git", defaultPath: "." }] : [], nextCursor: String(index + 1) };
    },
  } } as never;
  const response = await handleWorkspaceInstalledApps(ctx, "ws_installed", "GET");
  const body = await response.json() as ListInstalledAppsResponse;
  expect(pageCalls).toBe(8);
  expect(body.installedApps).toEqual([]);
  expect(body.complete).toBe(false);
});
