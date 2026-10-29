import { describe, expect, test } from "bun:test";
import type { Run } from "takosumi-contract/runs";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import {
  parseInstalledAppDelegationSources,
  type InstalledAppDelegationSource,
} from "../../../../accounts/service/src/installed-app-delegation.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const ORIGIN = "https://app.takosumi.test";
const WORKSPACE = "ws_token_scope";
/** seedCapsuleModel's Workspace owner; also the owner of every app here. */
const USER = "user_test";
const NOW = "2026-10-29T00:00:00.000Z";
const THIRD_PARTY = "cap_third_party";
const OTHER = "cap_other_app";
const DELEGATE = "cap_takos_like";
const DELEGATE_SOURCE: InstalledAppDelegationSource = { url: "https://git.example.test/first-party/takos", path: "." };

function reached(): never {
  throw new OpenTofuControllerError("failed_precondition", "reached");
}

async function fixture(options: { readonly owned?: boolean; readonly delegationSources?: readonly InstalledAppDelegationSource[] } = {}) {
  const ledger = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(ledger, {
    workspaceId: WORKSPACE, capsuleId: THIRD_PARTY, sourceId: "src_third_party",
    snapshotId: "snap_token_scope", installConfigId: "cfg_token_scope",
  });
  const sources = new Map<string, Record<string, unknown>>();
  for (const [capsuleId, sourceId, url] of [
    [THIRD_PARTY, "src_third_party", "https://git.example.test/third-party/app"],
    [OTHER, "src_other", "https://git.example.test/someone/other"],
    // A third-party fork of the delegate repository is not the delegate.
    [DELEGATE, "src_takos", "https://git.example.test/first-party/takos.git"],
  ] as const) {
    await ledger.putCapsule({
      ...seeded.capsule, id: capsuleId, name: capsuleId, slug: capsuleId, sourceId,
      status: "active", currentStateGeneration: 1, updatedAt: NOW,
    });
    sources.set(sourceId, {
      id: sourceId, workspaceId: WORKSPACE, ownerCapsuleId: capsuleId, name: sourceId, url,
      defaultRef: "main", defaultPath: ".", status: "active", autoSync: false, createdAt: NOW, updatedAt: NOW,
    });
  }
  const { operations: core } = await createTakosumiService({
    role: "takosumi-api", runtimeEnv: { TAKOSUMI_DEV_MODE: "1" }, opentofuControlStore: ledger,
  });
  if (options.owned !== false) {
    for (const capsuleId of [THIRD_PARTY, OTHER, DELEGATE]) {
      expect(await core.appOwnership.initializeOwnershipIfMissing({
        capsuleId, ownerAccountId: USER, ownershipEpoch: 0, managementState: "active",
        managementEpoch: 0, storageRoot: `apps/${capsuleId}`,
      })).toBe(true);
    }
  }
  const runs = new Map<string, Run>(
    [THIRD_PARTY, OTHER].map((capsuleId) => [`run_${capsuleId}`, {
      id: `run_${capsuleId}`, workspaceId: WORKSPACE, capsuleId, environment: "production", type: "plan",
      status: "waiting_approval", origin: { kind: "update" }, createdAt: NOW, updatedAt: NOW,
    } as unknown as Run]),
  );
  const coreOperations = core as unknown as ControlPlaneOperations;
  const operations = {
    ...coreOperations,
    getSource: async (id: string) => {
      const source = sources.get(id);
      if (!source) throw new OpenTofuControllerError("not_found", "missing");
      return { source };
    },
    getRun: async (id: string) => {
      const run = runs.get(id);
      if (!run) throw new OpenTofuControllerError("not_found", "missing");
      return run;
    },
    getPlanRun: async (id: string) => {
      const run = runs.get(id);
      if (!run) throw new OpenTofuControllerError("not_found", "missing");
      return { planRun: { ...run, operation: "update" } };
    },
    approveRun: async () => reached(),
    createApplyRun: async () => reached(),
  } as unknown as ControlPlaneOperations;
  const accounts = new InMemoryAccountsStore();
  accounts.saveAccount({ subject: USER, createdAt: Date.now(), updatedAt: Date.now() });
  function appToken(capsuleId: string, workspaceId = WORKSPACE): Record<string, string> {
    const token = `fixture-oauth-${capsuleId}-${workspaceId}`;
    accounts.saveAccessToken(token, {
      clientId: `client_${capsuleId}`, scope: "openid capsules:read capsules:write",
      subject: `pairwise_${capsuleId}`, takosumiSubject: USER, capsuleId, workspaceId,
      expiresAt: Date.now() + 60_000,
    });
    return { authorization: `Bearer ${token}` };
  }
  async function call(method: string, path: string, credential: Record<string, string>, body?: unknown) {
    const url = new URL(`${ORIGIN}/api/v1${path}`);
    const response = await handleControlRoute({
      request: new Request(url, {
        method,
        headers: { ...credential, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      url,
      store: accounts,
      operations,
      ...(options.delegationSources ? { installedAppDelegationSources: options.delegationSources } : {}),
    });
    expect(response).toBeDefined();
    const text = await response!.text();
    let parsed: { error?: { code?: string; message?: string } } = {};
    try { parsed = JSON.parse(text); } catch { /* empty body */ }
    return { status: response!.status, code: parsed.error?.code, message: parsed.error?.message };
  }
  return { core, ledger, appToken, call };
}

const WORKSPACE_ROUTES = (h: Awaited<ReturnType<typeof fixture>>, token: Record<string, string>) => [
  () => h.call("GET", `/capsules/${OTHER}/provider-bindings`, token),
  () => h.call("GET", `/capsules/${OTHER}`, token),
  () => h.call("GET", `/workspaces/${WORKSPACE}/capsules`, token),
  () => h.call("POST", `/workspaces/${WORKSPACE}/install-plans`, token, {}),
  () => h.call("GET", `/runs/run_${OTHER}`, token),
  () => h.call("POST", `/runs/run_${OTHER}/approve`, token, {}),
  () => h.call("POST", `/runs/run_${OTHER}/apply`, token, {}),
];

describe("an installed app's own OAuth token is confined to its own app", () => {
  for (const owned of [true, false]) {
    test(`third-party app token cannot reach other apps or Workspace routes (${owned ? "ownership rows" : "rollout fallback"})`, async () => {
      const h = await fixture({ owned, delegationSources: [DELEGATE_SOURCE] });
      const token = h.appToken(THIRD_PARTY);
      for (const route of WORKSPACE_ROUTES(h, token)) {
        expect((await route()).status).toBe(403);
      }
      // Its own app keeps working as before.
      expect((await h.call("GET", `/capsules/${THIRD_PARTY}/provider-bindings`, token)).status).toBe(200);
      expect((await h.call("GET", `/capsules/${THIRD_PARTY}`, token)).status).toBe(200);
      expect((await h.call("GET", `/runs/run_${THIRD_PARTY}`, token)).status).toBe(200);
      expect(await h.call("POST", `/runs/run_${THIRD_PARTY}/approve`, token, {})).toMatchObject({ status: 409, message: "reached" });
    }, 180_000);
  }

  test("install attempts of other apps cannot be read or rewritten by a third-party app token", async () => {
    const h = await fixture({ delegationSources: [DELEGATE_SOURCE] });
    const now = new Date().toISOString();
    const plan = {
      id: "gip_token_scope", workspaceId: WORKSPACE, createdBy: USER, actorSubject: USER, operation: "install",
      mode: "attempt", requestDigest: "sha256:x", source: { url: "https://git.example.test/x" },
      capsule: { name: "x" }, options: {}, phase: "awaiting_input", generation: 1, idempotencyKeyHash: "x",
      createdAt: now, updatedAt: now,
    };
    const store = (h.core as unknown as ControlPlaneOperations).gitInstallPlans as unknown as {
      get(id: string): Promise<unknown>;
    };
    const original = store.get.bind(store);
    store.get = async (id: string) => id === plan.id ? plan : await original(id);
    const token = h.appToken(THIRD_PARTY);
    expect((await h.call("GET", `/install-plans/${plan.id}`, token)).status).toBe(403);
    expect((await h.call("PATCH", `/install-plans/${plan.id}`, token, {})).status).toBe(403);
    expect((await h.call("PATCH", `/install-plans/${plan.id}`, h.appToken(DELEGATE), {})).status).not.toBe(403);
  }, 180_000);

  test("an operator-designated app keeps Workspace delegation end to end", async () => {
    const h = await fixture({ delegationSources: [DELEGATE_SOURCE] });
    const token = h.appToken(DELEGATE);
    expect((await h.call("GET", `/workspaces/${WORKSPACE}/capsules`, token)).status).toBe(200);
    // Install-plan creation passes authorization and reaches body validation.
    const created = await h.call("POST", `/workspaces/${WORKSPACE}/install-plans`, token, {});
    expect([401, 403]).not.toContain(created.status);
    expect((await h.call("GET", `/capsules/${OTHER}/provider-bindings`, token)).status).toBe(200);
    expect((await h.call("GET", `/runs/run_${OTHER}`, token)).status).toBe(200);
    expect(await h.call("POST", `/runs/run_${OTHER}/approve`, token, {})).toMatchObject({ status: 409, message: "reached" });
    expect(await h.call("POST", `/runs/run_${OTHER}/apply`, token, {})).toMatchObject({ status: 409, message: "reached" });
    // Account management stays refused for every app token.
    expect((await h.call("POST", `/capsules/${OTHER}/ownership-transfers`, token, { toAccountId: "acct_x" })).status).toBe(403);
    expect((await h.call("POST", `/capsules/${OTHER}/uninstall`, token)).status).toBe(403);
  }, 180_000);

  test("delegation needs the server-side operator designation and the token's own Workspace", async () => {
    const unconfigured = await fixture();
    for (const route of WORKSPACE_ROUTES(unconfigured, unconfigured.appToken(DELEGATE))) {
      expect((await route()).status).toBe(403);
    }
    const otherRepository = await fixture({ delegationSources: [{ url: "https://git.example.test/first-party/takos", path: "apps/other" }] });
    expect((await otherRepository.call("GET", `/workspaces/${WORKSPACE}/capsules`, otherRepository.appToken(DELEGATE))).status).toBe(403);
    const configured = await fixture({ delegationSources: [DELEGATE_SOURCE] });
    // A token bound to another Workspace is not this app's delegation.
    expect((await configured.call("GET", `/capsules/${OTHER}`, configured.appToken(DELEGATE, "ws_elsewhere"))).status).toBe(403);
  }, 180_000);
});

describe("delegation source configuration", () => {
  test("parses exact repository coordinates and fails closed on anything else", () => {
    expect(parseInstalledAppDelegationSources(undefined)).toEqual([]);
    expect(parseInstalledAppDelegationSources(" ")).toEqual([]);
    expect(parseInstalledAppDelegationSources(JSON.stringify([DELEGATE_SOURCE]))).toEqual([DELEGATE_SOURCE]);
    for (const value of [
      "not json",
      JSON.stringify({ url: DELEGATE_SOURCE.url, path: "." }),
      JSON.stringify([{ url: "http://git.example.test/a", path: "." }]),
      JSON.stringify([{ url: "https://user:pw@git.example.test/a", path: "." }]),
      JSON.stringify([{ url: "https://git.example.test/a", path: "../b" }]),
      JSON.stringify([{ url: "https://git.example.test/a", path: "/abs" }]),
      JSON.stringify([{ url: "https://git.example.test/a", path: ".", extra: true }]),
      JSON.stringify([{ url: "https://git.example.test/a" }]),
    ]) {
      expect(() => parseInstalledAppDelegationSources(value)).toThrow(TypeError);
    }
  });
});
