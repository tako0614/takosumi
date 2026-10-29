import { describe, expect, test } from "bun:test";
import type { AppAction } from "takosumi-contract/app-access";
import type { Run } from "takosumi-contract/runs";
import type { StateVersion } from "takosumi-contract/state-versions";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import type { AppOwnershipOperations } from "../../../../accounts/service/src/control/app-ownership.ts";
import type {
  AppAuthorizationFallbackReason,
  RequestPhaseObserver,
} from "../../../../accounts/service/src/request-phase-diagnostics.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { createInMemoryInterfaceStores } from "../../../../core/domains/interfaces/mod.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const ORIGIN = "https://app.takosumi.test";
const WORKSPACE = "ws_authz_cutover";
const CAPSULE = "cap_authz_cutover";
const OTHER_CAPSULE = "cap_authz_other";
/** seedCapsuleModel's Workspace owner; not an app member after the backfill here. */
const WORKSPACE_OWNER = "user_test";
const APP_OWNER = "acct_app_owner";
const APP_MEMBER = "acct_app_member";
const WORKSPACE_ADMIN = "acct_workspace_admin";
const WORKSPACE_MEMBER = "acct_workspace_member";
/** App member who is also a Workspace admin: still a member, never an owner. */
const DUAL = "acct_member_and_admin";
const FORMER_OWNER = "acct_former_owner";
const REMOVED = "acct_removed_member";
const RECIPIENT = "acct_recipient";
const NOW = "2026-10-29T00:00:00.000Z";

/** Domain stubs: reaching one proves the request passed authorization. */
function reached(): never {
  throw new OpenTofuControllerError("failed_precondition", "reached");
}

function stubbed<T extends object>(target: T, names: readonly string[]): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === "string" && names.includes(property)) return async () => reached();
      const value = Reflect.get(object, property, receiver);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

function runFixture(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id, workspaceId: WORKSPACE, capsuleId: CAPSULE, environment: "production",
    type: "plan", status: "waiting_approval", createdAt: NOW, updatedAt: NOW,
    ...overrides,
  } as unknown as Run;
}

async function fixture(options: { readonly owned?: boolean } = {}) {
  const ledger = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(ledger, {
    workspaceId: WORKSPACE,
    capsuleId: CAPSULE,
    sourceId: "src_authz",
    snapshotId: "snap_authz",
    installConfigId: "cfg_authz",
  });
  await ledger.putCapsule({ ...seeded.capsule, status: "active", currentStateGeneration: 1, updatedAt: NOW });
  for (const [accountId, role] of [
    [WORKSPACE_ADMIN, "admin"], [DUAL, "admin"], [WORKSPACE_MEMBER, "member"],
  ] as const) {
    await ledger.putWorkspaceMember({
      id: `wsm_${accountId}`, workspaceId: WORKSPACE, accountId, roles: [role],
      status: "active", createdAt: NOW, updatedAt: NOW,
    });
  }
  const { operations: core } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: ledger,
    interfaceStores: createInMemoryInterfaceStores({ workspaceManagementAuthority: ledger }),
  });
  const ownership = core.appOwnership;
  if (options.owned !== false) {
    // Transferred app: FORMER_OWNER created it, APP_OWNER accepted a transfer.
    expect(await ownership.initializeOwnershipIfMissing({
      capsuleId: CAPSULE, ownerAccountId: FORMER_OWNER, ownershipEpoch: 0,
      managementState: "active", managementEpoch: 0, storageRoot: `apps/${CAPSULE}`,
    })).toBe(true);
    expect(await ownership.putOwnership({
      capsuleId: CAPSULE, ownerAccountId: APP_OWNER, ownershipEpoch: 1,
      managementState: "active", managementEpoch: 0, storageRoot: `apps/${CAPSULE}`,
    }, 0)).toBe(true);
    for (const accountId of [APP_MEMBER, DUAL, REMOVED]) {
      expect(await ownership.putMember({
        capsuleId: CAPSULE, accountId, status: "active", addedBy: APP_OWNER, createdAt: NOW, updatedAt: NOW,
      })).toBe(true);
    }
    expect(await ownership.deleteMember(CAPSULE, REMOVED)).toBe(true);
  }
  const runs = new Map<string, Run>([
    ["run_plan", runFixture("run_plan", { origin: { kind: "update" } })],
    ["run_destroy", runFixture("run_destroy", { type: "destroy_plan" })],
    ["run_restore", runFixture("run_restore", { type: "restore" })],
    ["run_sync", runFixture("run_sync", { type: "source_sync", capsuleId: undefined, sourceId: "src_owned", status: "running" })],
    ["run_workspace", runFixture("run_workspace", { type: "source_sync", capsuleId: undefined, sourceId: "src_unowned", status: "running" })],
  ]);
  const sourceRecord = (id: string, ownerCapsuleId?: string) => ({
    id, workspaceId: WORKSPACE, name: id, url: "https://git.example.test/app.git", defaultRef: "main",
    defaultPath: ".", status: "active", autoSync: false, createdAt: NOW, updatedAt: NOW,
    ...(ownerCapsuleId ? { ownerCapsuleId } : {}),
  });
  const sources = new Map([
    ["src_owned", sourceRecord("src_owned", CAPSULE)],
    ["src_unowned", sourceRecord("src_unowned")],
  ]);
  const stateVersion: StateVersion = {
    id: "sv_authz", workspaceId: WORKSPACE, capsuleId: CAPSULE, environment: "production",
    generation: 1, createdByRunId: "run_plan", createdAt: NOW,
  } as unknown as StateVersion;
  const mutations: string[] = [];
  const appAuthorization: AppOwnershipOperations = {
    resolveAppAccess: (accountId, capsuleId) => core.appAccess.resolveAppAccess(accountId, capsuleId),
    listAccessibleApps: (accountId, page) => core.appAccess.listAccessibleApps(accountId, page),
    listMembers: async (capsuleId) => {
      const current = await ownership.getOwnership(capsuleId);
      return {
        ownerAccountId: current!.ownerAccountId,
        ownershipEpoch: current!.ownershipEpoch,
        members: (await ownership.listMembers(capsuleId)).map(({ accountId, status }) => ({ accountId, status })),
      };
    },
    addMember: async ({ accountId }) => { mutations.push("addMember"); return { accountId, status: "active" }; },
    removeMember: async () => { mutations.push("removeMember"); },
    createTransfer: async () => { mutations.push("createTransfer"); return { transferId: "tx_authz", state: "pending" }; },
    getTransfer: async () => undefined,
    listTransfers: async () => [],
    acceptTransfer: async ({ transferId }) => ({ transferId, state: "accepted" }),
    cancelTransfer: async () => {},
  };
  const coreOperations = core as unknown as ControlPlaneOperations;
  const operations = {
    ...coreOperations,
    appAuthorization,
    capsules: stubbed(coreOperations.capsules, [
      "setCapsuleAutoUpdate", "patchCapsuleStatus", "scheduleCapsuleUninstall",
      "cancelCapsuleUninstall", "abandonUnappliedCapsule",
    ]),
    runGroups: stubbed(coreOperations.runGroups, ["createWorkspaceUpdate", "createWorkspaceDriftCheck"]),
    createCapsulePlan: async () => reached(),
    createCapsuleDestroyPlan: async () => reached(),
    createStateVersionRollbackPlan: async () => reached(),
    approveRun: async () => reached(),
    cancelRun: async () => reached(),
    patchSource: async () => reached(),
    deleteSource: async () => reached(),
    getStateVersion: async (id: string) => {
      if (id !== stateVersion.id) throw new OpenTofuControllerError("not_found", "missing");
      return { stateVersion };
    },
    getRun: async (id: string) => {
      const run = runs.get(id);
      if (!run) throw new OpenTofuControllerError("not_found", "missing");
      return run;
    },
    getSource: async (id: string) => {
      const source = sources.get(id);
      return source ? { source } : await coreOperations.getSource(id);
    },
  } as unknown as ControlPlaneOperations;

  const accounts = new InMemoryAccountsStore();
  for (const subject of [
    WORKSPACE_OWNER, APP_OWNER, APP_MEMBER, WORKSPACE_ADMIN, WORKSPACE_MEMBER, DUAL, FORMER_OWNER, REMOVED,
  ]) {
    accounts.saveAccount({ subject, createdAt: Date.now(), updatedAt: Date.now() });
  }
  accounts.saveAccount({
    subject: RECIPIENT, email: "recipient@example.test", emailVerified: true,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  const headers = {
    session(subject: string): Record<string, string> {
      const sessionId = `sess_${subject}`;
      accounts.saveAccountSession({ sessionId, subject, createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
      return { cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}` };
    },
    pat(subject: string, appIds?: readonly string[]): Record<string, string> {
      const token = `fixture-pat-${subject}-${appIds?.join("-") ?? "account"}`;
      accounts.savePersonalAccessToken(token, {
        tokenId: `pat_${subject}_${appIds?.length ?? 0}`, tokenPrefix: "fixture", subject, name: "authz",
        scopes: ["read", "write"], ...(appIds ? { appIds: [...appIds] } : {}), createdAt: Date.now(),
      });
      return { authorization: `Bearer ${token}` };
    },
    /** An installed app's own OAuth token, bound to its Capsule and Workspace. */
    oauth(subject: string): Record<string, string> {
      const token = `fixture-oauth-${subject}`;
      accounts.saveAccessToken(token, {
        clientId: "client_authz", scope: "openid capsules:read capsules:write",
        subject: `pairwise_${subject}`, takosumiSubject: subject, capsuleId: CAPSULE,
        workspaceId: WORKSPACE, expiresAt: Date.now() + 60_000,
      });
      return { authorization: `Bearer ${token}` };
    },
  };
  async function call(
    method: string,
    path: string,
    credential: Record<string, string>,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    diagnostics?: RequestPhaseObserver,
  ): Promise<{ readonly status: number; readonly code?: string; readonly message?: string }> {
    const url = new URL(`${ORIGIN}/api/v1${path}`);
    const response = await handleControlRoute({
      request: new Request(url, {
        method,
        headers: {
          ...credential,
          ...extraHeaders,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      url,
      store: accounts,
      operations,
      ...(diagnostics ? { diagnostics } : {}),
    });
    expect(response).toBeDefined();
    const text = await response!.text();
    let parsed: { error?: { code?: string; message?: string } } = {};
    try { parsed = JSON.parse(text); } catch { /* streams and empty bodies */ }
    return { status: response!.status, code: parsed.error?.code, message: parsed.error?.message };
  }
  return { ledger, core, operations, ownership, mutations, headers, call, accounts };
}

type Harness = Awaited<ReturnType<typeof fixture>>;

const ACTION_REQUESTS: Readonly<Record<AppAction, (h: Harness, credential: Record<string, string>) => ReturnType<Harness["call"]>>> = {
  view: (h, c) => h.call("GET", `/capsules/${CAPSULE}`, c),
  change_settings: (h, c) => h.call("PATCH", `/capsules/${CAPSULE}`, c, { autoUpdate: true }),
  update: (h, c) => h.call("POST", `/capsules/${CAPSULE}/plan`, c, {}),
  rollback: (h, c) => h.call("POST", "/state-versions/sv_authz/rollback-plan", c, {}),
  choose_connection: (h, c) => h.call("POST", `/capsules/${CAPSULE}/configuration-plans`, c, {
    providerBindings: [{ provider: "registry.example/cloud", connectionId: "conn_owner" }],
  }, { "idempotency-key": "authz-cutover" }),
  change_interface_link: (h, c) => h.call("PUT", `/capsules/${CAPSULE}/interface-links/storage`, c, {
    expectedGeneration: 0, interfaceId: "iface_missing",
  }),
  uninstall: (h, c) => h.call("POST", `/capsules/${CAPSULE}/uninstall`, c),
  transfer_ownership: (h, c) => h.call("POST", `/capsules/${CAPSULE}/ownership-transfers`, c, { toAccountId: RECIPIENT }),
  manage_members: (h, c) => h.call("POST", `/capsules/${CAPSULE}/members`, c, {
    email: "recipient@example.test", consent: "connections_and_code",
  }),
};

const OWNER_ONLY: readonly AppAction[] = ["uninstall", "transfer_ownership", "manage_members"];
type Expectation = "allow" | "owner_only" | "deny" | "deny_any" | "unauthenticated";

const PRINCIPALS: readonly {
  readonly name: string;
  readonly credential: (h: Harness) => Record<string, string>;
  readonly expect: (action: AppAction) => Expectation;
}[] = [
  { name: "app owner (no Workspace membership)", credential: (h) => h.headers.session(APP_OWNER), expect: () => "allow" },
  { name: "app member (no Workspace membership)", credential: (h) => h.headers.session(APP_MEMBER),
    expect: (action) => OWNER_ONLY.includes(action) ? "owner_only" : "allow" },
  { name: "app member who is also a Workspace admin", credential: (h) => h.headers.session(DUAL),
    expect: (action) => OWNER_ONLY.includes(action) ? "owner_only" : "allow" },
  { name: "Workspace admin who is not an app member", credential: (h) => h.headers.session(WORKSPACE_ADMIN), expect: () => "deny" },
  { name: "Workspace owner who is not an app member", credential: (h) => h.headers.session(WORKSPACE_OWNER), expect: () => "deny" },
  { name: "former owner after a transfer", credential: (h) => h.headers.session(FORMER_OWNER), expect: () => "deny" },
  { name: "removed member", credential: (h) => h.headers.session(REMOVED), expect: () => "deny" },
  { name: "account-wide PAT of the owner", credential: (h) => h.headers.pat(APP_OWNER), expect: () => "allow" },
  { name: "owner PAT with this appId", credential: (h) => h.headers.pat(APP_OWNER, [CAPSULE]), expect: () => "allow" },
  { name: "member PAT with this appId", credential: (h) => h.headers.pat(APP_MEMBER, [CAPSULE]),
    expect: (action) => OWNER_ONLY.includes(action) ? "owner_only" : "allow" },
  { name: "owner PAT restricted to another app", credential: (h) => h.headers.pat(APP_OWNER, [OTHER_CAPSULE]), expect: () => "deny" },
  { name: "account-wide PAT of a Workspace admin", credential: (h) => h.headers.pat(WORKSPACE_ADMIN), expect: () => "deny" },
  // Installed-app OAuth tokens never gain authority they lacked before: the
  // Workspace limit still applies and account management stays refused.
  { name: "installed-app OAuth token of the owner outside the Workspace", credential: (h) => h.headers.oauth(APP_OWNER), expect: () => "deny" },
  { name: "installed-app OAuth token of a Workspace admin without app role", credential: (h) => h.headers.oauth(WORKSPACE_ADMIN), expect: () => "deny" },
  { name: "installed-app OAuth token of a member who is a Workspace admin", credential: (h) => h.headers.oauth(DUAL),
    expect: (action) => OWNER_ONLY.includes(action) ? "deny_any" : "allow" },
  { name: "unauthenticated", credential: () => ({}), expect: () => "unauthenticated" },
];

function assertOutcome(
  outcome: { readonly status: number; readonly code?: string; readonly message?: string },
  expected: Expectation,
  label: string,
): void {
  const detail = `${label}: ${outcome.status} ${outcome.code ?? ""} ${outcome.message ?? ""}`;
  switch (expected) {
    case "allow":
      expect([401, 403].includes(outcome.status), detail).toBe(false);
      return;
    case "owner_only":
      expect([outcome.status, outcome.code], detail).toEqual([403, "app_owner_only"]);
      return;
    case "deny":
      expect([outcome.status, outcome.code], detail).toEqual([403, "app_access_denied"]);
      return;
    case "deny_any":
      expect(outcome.status, detail).toBe(403);
      return;
    case "unauthenticated":
      expect(outcome.status, detail).toBe(401);
  }
}

describe("per-app authorization after the ownership row exists", () => {
  for (const principal of PRINCIPALS) {
    test(`${principal.name}: every AppAction`, async () => {
      const h = await fixture();
      for (const action of Object.keys(ACTION_REQUESTS) as AppAction[]) {
        const outcome = await ACTION_REQUESTS[action](h, principal.credential(h));
        assertOutcome(outcome, principal.expect(action), action);
      }
    }, 180_000);
  }

  test("allowed management actions reach the domain; refused ones do not", async () => {
    const h = await fixture();
    const owner = h.headers.session(APP_OWNER);
    expect(await ACTION_REQUESTS.change_settings(h, owner)).toMatchObject({ status: 409, message: "reached" });
    expect(await ACTION_REQUESTS.uninstall(h, owner)).toMatchObject({ status: 409, message: "reached" });
    expect((await ACTION_REQUESTS.transfer_ownership(h, owner)).status).toBe(201);
    expect((await ACTION_REQUESTS.transfer_ownership(h, h.headers.session(APP_MEMBER))).code).toBe("app_owner_only");
    expect((await ACTION_REQUESTS.manage_members(h, h.headers.session(WORKSPACE_ADMIN))).code).toBe("app_access_denied");
    expect(h.mutations).toEqual(["createTransfer"]);
  }, 180_000);
});

describe("resources addressed by their own id resolve their app first", () => {
  test("StateVersions decide on their Capsule", async () => {
    const h = await fixture();
    expect((await h.call("GET", "/state-versions/sv_authz", h.headers.session(APP_MEMBER))).status).toBe(200);
    expect(await h.call("GET", "/state-versions/sv_authz", h.headers.session(WORKSPACE_OWNER)))
      .toMatchObject({ status: 403, code: "app_access_denied" });
  }, 180_000);
});

describe("rollout fallback: a Capsule without an ownership row keeps the Workspace decision", () => {
  test("Workspace roles decide and the fallback is observable without ids", async () => {
    const h = await fixture({ owned: false });
    const reasons: AppAuthorizationFallbackReason[] = [];
    const diagnostics: RequestPhaseObserver = {
      async measure<T>(_phase: unknown, operation: () => T | Promise<T>) { return await operation(); },
      observeAppAuthorizationFallback(input) { reasons.push(input.reason); },
    };
    const call = (method: string, path: string, credential: Record<string, string>, body?: unknown) =>
      h.call(method, path, credential, body, {}, diagnostics);
    expect((await call("GET", `/capsules/${CAPSULE}`, h.headers.session(WORKSPACE_OWNER))).status).toBe(200);
    expect(await call("PATCH", `/capsules/${CAPSULE}`, h.headers.session(WORKSPACE_ADMIN), { autoUpdate: true }))
      .toMatchObject({ status: 409, message: "reached" });
    expect(await call("POST", `/capsules/${CAPSULE}/uninstall`, h.headers.session(WORKSPACE_OWNER)))
      .toMatchObject({ status: 409, message: "reached" });
    expect((await call("GET", `/capsules/${CAPSULE}`, h.headers.session(WORKSPACE_MEMBER))).status).toBe(200);
    expect(await call("PATCH", `/capsules/${CAPSULE}`, h.headers.session(WORKSPACE_MEMBER), { autoUpdate: true }))
      .toMatchObject({ status: 403, code: "forbidden" });
    expect(await call("GET", `/capsules/${CAPSULE}`, h.headers.session(APP_MEMBER)))
      .toMatchObject({ status: 403, code: "forbidden" });
    expect(reasons.length).toBeGreaterThan(0);
    expect(new Set(reasons)).toEqual(new Set(["capsule_not_backfilled"]));
  }, 180_000);
});

describe("installed-app OAuth tokens never perform owner-only actions", () => {
  for (const owned of [true, false]) {
    test(`even when the token's user owns the app (${owned ? "ownership row" : "rollout fallback"})`, async () => {
      const h = await fixture({ owned: false });
      if (owned) {
        expect(await h.ownership.initializeOwnershipIfMissing({
          capsuleId: CAPSULE, ownerAccountId: WORKSPACE_OWNER, ownershipEpoch: 0,
          managementState: "active", managementEpoch: 0, storageRoot: `apps/${CAPSULE}`,
        })).toBe(true);
      }
      const token = h.headers.oauth(WORKSPACE_OWNER);
      for (const [method, path] of [
        ["POST", `/capsules/${CAPSULE}/destroy-plan`], ["POST", `/capsules/${CAPSULE}/uninstall`],
        ["POST", `/capsules/${CAPSULE}/abandon`], ["POST", `/capsules/${CAPSULE}/cancel-uninstall`],
        ["DELETE", `/capsules/${CAPSULE}?immediate=true`], ["DELETE", `/capsules/${CAPSULE}`],
      ] as const) {
        expect(await h.call(method, path, token, method === "POST" ? {} : undefined), `${method} ${path}`)
          .toMatchObject({ status: 403, code: "app_access_denied" });
      }
      // Non-owner-only management by the same token is unchanged.
      expect(await h.call("PATCH", `/capsules/${CAPSULE}`, token, { autoUpdate: true })).toMatchObject({ status: 409, message: "reached" });
    }, 180_000);
  }
});

describe("Interface links are approved only by someone who may change the provider app", () => {
  const PROVIDER = "cap_authz_provider";
  const PROVIDER_OWNER = "acct_provider_owner";
  const requirement = { key: "tools", interface: { type: "mcp.server", version: "1" }, permissions: ["mcp.read"], delivery: { type: "oauth2" } } as const;

  async function linkFixture() {
    const h = await fixture();
    const consumer = (await h.ledger.getCapsule(CAPSULE))!;
    const config = await h.ledger.getInstallConfig(consumer.installConfigId);
    await h.ledger.putInstallConfig({ ...config!, requiredInterfaces: [requirement] });
    await h.ledger.putCapsule({ ...consumer, id: PROVIDER, name: "provider", slug: "provider", updatedAt: NOW });
    expect(await h.ownership.initializeOwnershipIfMissing({
      capsuleId: PROVIDER, ownerAccountId: PROVIDER_OWNER, ownershipEpoch: 0,
      managementState: "active", managementEpoch: 0, storageRoot: `apps/${PROVIDER}`,
    })).toBe(true);
    const iface = await h.core.interfaces.create({
      workspaceId: WORKSPACE, name: "provider-tools", ownerRef: { kind: "Capsule", id: PROVIDER },
      spec: { type: "mcp.server", version: "1", document: {}, inputs: { endpoint: { source: "literal", value: "https://provider.example.test/mcp" } }, access: { visibility: "workspace", resourceUriInput: "endpoint" } },
    });
    return { h, interfaceId: iface.metadata.id };
  }

  async function put(h: Harness, credential: Record<string, string>, interfaceId: string, expectedGeneration: number) {
    const url = new URL(`https://app.takosumi.test/api/v1/capsules/${CAPSULE}/interface-links/tools`);
    const response = await handleControlRoute({
      request: new Request(url, { method: "PUT", headers: { ...credential, "content-type": "application/json" }, body: JSON.stringify({ interfaceId, expectedGeneration }) }),
      url, store: h.accounts, operations: h.operations,
    });
    const body = await response!.json() as { link?: { state: string; generation: number; approval?: unknown } };
    return { status: response!.status, body };
  }

  test("a consumer manager without provider access creates a pending link", async () => {
    const { h, interfaceId } = await linkFixture();
    const pending = await put(h, h.headers.session(APP_OWNER), interfaceId, 0);
    expect(pending.status).toBe(200);
    expect(pending.body.link).toMatchObject({ state: "pending_approval" });
    expect(pending.body.link?.approval).toBeUndefined();
  }, 180_000);

  async function managesBoth() {
    const fixtureResult = await linkFixture();
    const { h } = fixtureResult;
    // The provider's owner joins the consumer app as a member and the Workspace.
    expect(await h.ownership.putMember({ capsuleId: CAPSULE, accountId: PROVIDER_OWNER, status: "active", createdAt: NOW, updatedAt: NOW })).toBe(true);
    await h.ledger.putWorkspaceMember({ id: "wsm_provider_owner", workspaceId: WORKSPACE, accountId: PROVIDER_OWNER, roles: ["admin"], status: "active", createdAt: NOW, updatedAt: NOW });
    h.accounts.saveAccount({ subject: PROVIDER_OWNER, createdAt: Date.now(), updatedAt: Date.now() });
    return fixtureResult;
  }

  test("a requester who manages both apps creates an active link", async () => {
    const { h, interfaceId } = await managesBoth();
    const viaSession = await put(h, h.headers.session(PROVIDER_OWNER), interfaceId, 0);
    expect(viaSession.body.link).toMatchObject({ state: "active", approval: { kind: "requester_manages_provider" } });
  }, 180_000);

  test("an app's own token never approves another app's Interface", async () => {
    const { h, interfaceId } = await managesBoth();
    const viaToken = await put(h, h.headers.oauth(PROVIDER_OWNER), interfaceId, 0);
    expect(viaToken.status).toBe(200);
    expect(viaToken.body.link).toMatchObject({ state: "pending_approval" });
  }, 180_000);

  test("an app token's candidate list omits apps it cannot view", async () => {
    const { h } = await linkFixture();
    const candidates = async (credential: Record<string, string>) => {
      const url = new URL(`https://app.takosumi.test/api/v1/capsules/${CAPSULE}/interface-links/tools/candidates`);
      const response = await handleControlRoute({ request: new Request(url, { headers: credential }), url, store: h.accounts, operations: h.operations });
      return ((await response!.json()) as { candidates: { providerCapsuleId: string }[] }).candidates.map((row) => row.providerCapsuleId);
    };
    expect(await candidates(h.headers.session(DUAL))).toEqual([PROVIDER]);
    expect(await candidates(h.headers.oauth(DUAL))).toEqual([]);
  }, 180_000);
});
