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

async function fixture(options: { readonly owned?: boolean; readonly legacy?: boolean } = {}) {
  const ledger = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(ledger, {
    workspaceId: WORKSPACE,
    capsuleId: CAPSULE,
    sourceId: "src_authz",
    snapshotId: "snap_authz",
    installConfigId: "cfg_authz",
    // Production Sources predate owner claims: the app references an ownerless Source.
    ...(options.legacy ? { legacySharedSource: true } : {}),
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
    ["run_legacy_sync", runFixture("run_legacy_sync", { type: "source_sync", capsuleId: undefined, sourceId: "src_authz", status: "running" })],
    ["run_gone", runFixture("run_gone", { type: "source_sync", capsuleId: undefined, sourceId: "src_retired", status: "succeeded" })],
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
    // Historical RunGroups (creation is retired), each naming its member Runs.
    runGroups: {
      getRunGroup: async (id: string) => {
        const members: Record<string, readonly string[]> = {
          rg_app: ["run_plan", "run_destroy"],
          rg_empty: [],
          rg_appless: ["run_workspace"],
          rg_mixed: ["run_plan", "run_workspace"],
        };
        const ids = members[id];
        return ids === undefined ? undefined : {
          runGroup: { id, workspaceId: WORKSPACE },
          runs: ids.map((runId) => runs.get(runId)!),
        };
      },
    },
    createCapsulePlan: async () => reached(),
    createCapsuleDestroyPlan: async () => reached(),
    createStateVersionRollbackPlan: async () => reached(),
    approveRun: async () => reached(),
    cancelRun: async () => reached(),
    patchSource: async () => reached(),
    createSourceSync: async () => reached(),
    listRunsPage: async () => ({ runs: [...runs.values()] }),
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
  test("Runs decide on their Capsule, destroy work is owner-only and restore is rollback", async () => {
    const h = await fixture();
    const member = h.headers.session(APP_MEMBER);
    const owner = h.headers.session(APP_OWNER);
    const admin = h.headers.session(WORKSPACE_ADMIN);
    expect((await h.call("GET", "/runs/run_plan", member)).status).toBe(200);
    expect(await h.call("GET", "/runs/run_plan", admin)).toMatchObject({ status: 403, code: "app_access_denied" });
    expect(await h.call("POST", "/runs/run_plan/approve", member, {})).toMatchObject({ status: 409, message: "reached" });
    expect(await h.call("POST", "/runs/run_destroy/approve", member, {})).toMatchObject({ status: 403, code: "app_owner_only" });
    expect(await h.call("POST", "/runs/run_destroy/cancel", member, {})).toMatchObject({ status: 403, code: "app_owner_only" });
    expect(await h.call("POST", "/runs/run_destroy/approve", owner, {})).toMatchObject({ status: 409, message: "reached" });
    expect(await h.call("POST", "/runs/run_restore/approve", member, {})).toMatchObject({ status: 409, message: "reached" });
    expect(await h.call("POST", "/runs/run_plan/approve", admin, {})).toMatchObject({ status: 403, code: "app_access_denied" });
  }, 180_000);

  test("a Source-scoped Run of an app's own Source belongs to that app", async () => {
    const h = await fixture();
    expect((await h.call("GET", "/runs/run_sync", h.headers.session(APP_MEMBER))).status).toBe(200);
    expect(await h.call("GET", "/runs/run_sync", h.headers.session(WORKSPACE_ADMIN)))
      .toMatchObject({ status: 403, code: "app_access_denied" });
    // A Run of an unowned preflight Source stays on the Workspace decision.
    expect((await h.call("GET", "/runs/run_workspace", h.headers.session(WORKSPACE_ADMIN))).status).toBe(200);
    expect(await h.call("GET", "/runs/run_workspace", h.headers.session(APP_MEMBER)))
      .toMatchObject({ status: 403, code: "forbidden" });
  }, 180_000);

  test("StateVersions decide on their Capsule", async () => {
    const h = await fixture();
    expect((await h.call("GET", "/state-versions/sv_authz", h.headers.session(APP_MEMBER))).status).toBe(200);
    expect(await h.call("GET", "/state-versions/sv_authz", h.headers.session(WORKSPACE_OWNER)))
      .toMatchObject({ status: 403, code: "app_access_denied" });
  }, 180_000);

  test("an app's own Source is the app's; an unowned preflight Source stays Workspace-scoped", async () => {
    const h = await fixture();
    const member = h.headers.session(APP_MEMBER);
    const admin = h.headers.session(WORKSPACE_ADMIN);
    expect((await h.call("GET", "/sources/src_owned", member)).status).toBe(200);
    expect(await h.call("GET", "/sources/src_owned", admin)).toMatchObject({ status: 403, code: "app_access_denied" });
    expect(await h.call("PATCH", "/sources/src_owned", member, {})).toMatchObject({ status: 409, message: "reached" });
    expect(await h.call("DELETE", "/sources/src_owned", member)).toMatchObject({ status: 403, code: "app_owner_only" });
    expect((await h.call("DELETE", "/sources/src_owned", h.headers.session(APP_OWNER))).code).not.toMatch(/^app_|forbidden/u);
    expect((await h.call("GET", "/sources/src_unowned", admin)).status).toBe(200);
    expect(await h.call("GET", "/sources/src_unowned", member)).toMatchObject({ status: 403, code: "forbidden" });
  }, 180_000);

  test("Workspace bulk actions are retired for every caller with a typed 410", async () => {
    const h = await fixture();
    for (const subject of [WORKSPACE_OWNER, WORKSPACE_ADMIN, DUAL, APP_OWNER, APP_MEMBER, RECIPIENT]) {
      for (const leaf of ["plan-update", "drift-check"]) {
        expect(await h.call("POST", `/workspaces/${WORKSPACE}/${leaf}`, h.headers.session(subject), {}), `${subject} ${leaf}`)
          .toMatchObject({ status: 410, code: "run_group_retired" });
      }
    }
    // An unknown Workspace answers the same: nothing about it is read.
    expect(await h.call("POST", "/workspaces/ws_unknown/plan-update", h.headers.session(RECIPIENT)))
      .toMatchObject({ status: 410, code: "run_group_retired" });
    expect(await h.call("GET", `/workspaces/${WORKSPACE}/plan-update`, h.headers.session(APP_OWNER)))
      .toMatchObject({ status: 405 });
    // Workspace lists stay Workspace compat until Phase 9.
    expect((await h.call("GET", `/workspaces/${WORKSPACE}/capsules`, h.headers.session(WORKSPACE_ADMIN))).status).toBe(200);
  }, 180_000);

  test("a historical RunGroup reads only when every member app is viewable; approval is retired", async () => {
    const h = await fixture();
    for (const subject of [APP_OWNER, APP_MEMBER, DUAL]) {
      expect((await h.call("GET", "/run-groups/rg_app", h.headers.session(subject))).status, subject).toBe(200);
    }
    // Workspace roles grant nothing on an owned app.
    expect(await h.call("GET", "/run-groups/rg_app", h.headers.session(WORKSPACE_OWNER)))
      .toMatchObject({ status: 403, code: "app_access_denied" });
    expect(await h.call("GET", "/run-groups/rg_app", h.headers.session(WORKSPACE_ADMIN)))
      .toMatchObject({ status: 403, code: "app_access_denied" });
    // Fail closed: no members, a member without an app, or a missing group.
    for (const id of ["rg_empty", "rg_appless", "rg_mixed", "rg_missing"]) {
      expect(await h.call("GET", `/run-groups/${id}`, h.headers.session(APP_OWNER)), id)
        .toMatchObject({ status: 404, code: "not_found" });
      expect(await h.call("GET", `/run-groups/${id}`, h.headers.session(WORKSPACE_OWNER)), id)
        .toMatchObject({ status: 404, code: "not_found" });
    }
    for (const id of ["rg_app", "rg_missing"]) {
      expect(await h.call("POST", `/run-groups/${id}/approve`, h.headers.session(APP_OWNER)), id)
        .toMatchObject({ status: 410, code: "run_group_retired" });
    }
    expect(await h.call("GET", "/run-groups/rg_app/approve", h.headers.session(APP_OWNER)))
      .toMatchObject({ status: 405 });
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
    expect(await call("POST", `/workspaces/${WORKSPACE}/plan-update`, h.headers.session(WORKSPACE_OWNER)))
      .toMatchObject({ status: 410, code: "run_group_retired" });
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

  test("a re-point that would only be pending is refused with 409 and the active link is kept", async () => {
    const { h, interfaceId } = await managesBoth();
    const active = await put(h, h.headers.session(PROVIDER_OWNER), interfaceId, 0);
    expect(active.body.link).toMatchObject({ state: "active" });
    // A second provider app the consumer's owner cannot manage.
    const OTHER_PROVIDER = "cap_authz_provider_two";
    const consumer = (await h.ledger.getCapsule(CAPSULE))!;
    await h.ledger.putCapsule({ ...consumer, id: OTHER_PROVIDER, name: "provider-two", slug: "provider-two", updatedAt: NOW });
    expect(await h.ownership.initializeOwnershipIfMissing({
      capsuleId: OTHER_PROVIDER, ownerAccountId: "acct_other_provider_owner", ownershipEpoch: 0,
      managementState: "active", managementEpoch: 0, storageRoot: `apps/${OTHER_PROVIDER}`,
    })).toBe(true);
    const other = await h.core.interfaces.create({
      workspaceId: WORKSPACE, name: "provider-two-tools", ownerRef: { kind: "Capsule", id: OTHER_PROVIDER },
      spec: { type: "mcp.server", version: "1", document: {}, inputs: { endpoint: { source: "literal", value: "https://provider-two.example.test/mcp" } }, access: { visibility: "workspace", resourceUriInput: "endpoint" } },
    });
    const url = new URL(`https://app.takosumi.test/api/v1/capsules/${CAPSULE}/interface-links/tools`);
    const response = await handleControlRoute({
      request: new Request(url, { method: "PUT", headers: { ...h.headers.session(APP_OWNER), "content-type": "application/json" }, body: JSON.stringify({ interfaceId: other.metadata.id, expectedGeneration: active.body.link!.generation }) }),
      url, store: h.accounts, operations: h.operations,
    });
    expect(response!.status).toBe(409);
    expect(((await response!.json()) as { error: { code: string } }).error.code).toBe("interface_link_approval_required");
    expect(await h.core.interfaces.getLatestCapsuleInterfaceLink(CAPSULE, "tools")).toMatchObject({
      state: "active", providerCapsuleId: PROVIDER, generation: active.body.link!.generation,
    });
  }, 180_000);

  async function provider(h: Harness, credential: Record<string, string>, method: "GET" | "POST", path: string, body?: unknown, providerId = PROVIDER) {
    const url = new URL(`https://app.takosumi.test/api/v1/capsules/${providerId}/interface-links/${path}`);
    const response = await handleControlRoute({
      request: new Request(url, { method, headers: { ...credential, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      url, store: h.accounts, operations: h.operations,
    });
    const text = await response!.text();
    const parsed = JSON.parse(text) as { error?: { code: string; message: string }; link?: { id: string; state: string; generation: number; approvedPermissions: string[]; approval?: unknown }; requests?: Record<string, unknown>[] };
    return { status: response!.status, code: parsed.error?.code, message: parsed.error?.message, body: parsed, text };
  }

  test("only the provider app's owner or a member lists and approves a pending link", async () => {
    const { h, interfaceId } = await linkFixture();
    h.accounts.saveAccount({ subject: APP_OWNER, displayName: "Consumer Owner", createdAt: Date.now(), updatedAt: Date.now() });
    h.accounts.saveAccount({ subject: PROVIDER_OWNER, createdAt: Date.now(), updatedAt: Date.now() });
    const pending = (await put(h, h.headers.session(APP_OWNER), interfaceId, 0)).body.link!;
    const linkId = (await h.core.interfaces.getLatestCapsuleInterfaceLink(CAPSULE, "tools"))!.id;
    expect(pending.state).toBe("pending_approval");
    // Managing the consumer app gives nothing on the provider app.
    expect(await provider(h, h.headers.session(APP_OWNER), "GET", "requests")).toMatchObject({ status: 403, code: "app_access_denied" });
    expect(await provider(h, h.headers.session(APP_OWNER), "POST", `${linkId}/approve`, { expectedGeneration: pending.generation })).toMatchObject({ status: 403, code: "app_access_denied" });
    expect(await provider(h, h.headers.session(APP_MEMBER), "POST", `${linkId}/decline`, { expectedGeneration: pending.generation })).toMatchObject({ status: 403, code: "app_access_denied" });
    // An installed app's own token never decides, whoever it acts for.
    expect(await provider(h, h.headers.oauth(PROVIDER_OWNER), "POST", `${linkId}/approve`, { expectedGeneration: pending.generation })).toMatchObject({ status: 403, code: "app_access_denied" });
    expect(await provider(h, h.headers.oauth(PROVIDER_OWNER), "GET", "requests")).toMatchObject({ status: 403, code: "app_access_denied" });

    const listed = await provider(h, h.headers.session(PROVIDER_OWNER), "GET", "requests");
    expect(listed.status).toBe(200);
    expect(listed.body.requests).toEqual([{
      linkId, generation: pending.generation, consumerApp: expect.objectContaining({ capsuleId: CAPSULE }), requirementKey: "tools",
      providerInterfaceId: interfaceId, interfaceType: "mcp.server", interfaceVersion: "1", requestedPermissions: ["mcp.read"],
      requestedByDisplayName: "Consumer Owner", createdAt: expect.any(String),
    }]);
    expect(listed.text).not.toContain("provider.example.test");

    expect(await provider(h, h.headers.session(PROVIDER_OWNER), "POST", `${linkId}/approve`, { expectedGeneration: pending.generation + 1 })).toMatchObject({ status: 409, code: "conflict" });
    // Partial (or widened) approval is refused for now; the link stays pending.
    for (const approvedPermissions of [[], ["mcp.admin"], ["mcp.read", "mcp.admin"]]) {
      expect(await provider(h, h.headers.session(PROVIDER_OWNER), "POST", `${linkId}/approve`, { expectedGeneration: pending.generation, approvedPermissions }))
        .toMatchObject({ status: 400, code: "invalid_request", message: expect.stringContaining("Partial approval is not supported yet") });
    }
    expect(await provider(h, h.headers.session(PROVIDER_OWNER), "POST", `${linkId}/approve`, { expectedGeneration: pending.generation, approvedPermissions: "mcp.read" })).toMatchObject({ status: 400, code: "invalid_request" });
    expect(await provider(h, h.headers.session(PROVIDER_OWNER), "POST", `${linkId}/approve`, { expectedGeneration: pending.generation, note: "x" })).toMatchObject({ status: 400, code: "invalid_request" });
    expect(await provider(h, h.headers.session(PROVIDER_OWNER), "GET", `${linkId}/approve`)).toMatchObject({ status: 405 });
    const approved = await provider(h, h.headers.pat(PROVIDER_OWNER, [PROVIDER]), "POST", `${linkId}/approve`, { expectedGeneration: pending.generation });
    expect(approved.status).toBe(200);
    expect(approved.body.link).toMatchObject({ id: linkId, state: "active", generation: pending.generation + 1, approvedPermissions: ["mcp.read"], approval: { kind: "provider_approved", approvedBy: PROVIDER_OWNER } });
    expect((await provider(h, h.headers.session(PROVIDER_OWNER), "GET", "requests")).body.requests).toEqual([]);
    // The consumer's people get their grants on their next sign-in.
    await h.core.interfaces.ensureCapsuleRequiredInterfaces({ workspaceId: WORKSPACE, capsuleId: CAPSULE, principalId: "pairwise_alice", requirements: [requirement] });
    expect((await h.core.interfaces.listBindings(interfaceId)).map((binding) => [binding.spec.subjectRef.id, binding.metadata.materializedFrom?.source === "capsule_required_interface" ? binding.metadata.materializedFrom.linkId : undefined])).toEqual([["pairwise_alice", linkId]]);
    expect(await provider(h, h.headers.session(PROVIDER_OWNER), "POST", `${linkId}/decline`, { expectedGeneration: approved.body.link!.generation })).toMatchObject({ status: 409, code: "conflict" });
  }, 180_000);

  test("the request list names the requester by display name only, never an email or account id", async () => {
    const { h, interfaceId } = await linkFixture();
    h.accounts.saveAccount({ subject: PROVIDER_OWNER, createdAt: Date.now(), updatedAt: Date.now() });
    await put(h, h.headers.session(APP_OWNER), interfaceId, 0);
    const requester = async (account: { displayName?: string; email?: string }) => {
      h.accounts.saveAccount({ subject: APP_OWNER, ...account, createdAt: Date.now(), updatedAt: Date.now() });
      const listed = await provider(h, h.headers.session(PROVIDER_OWNER), "GET", "requests");
      expect(listed.status).toBe(200);
      expect(listed.text).not.toContain(APP_OWNER);
      expect(listed.text).not.toContain("owner@example.test");
      return (listed.body.requests as { requestedByDisplayName?: string }[])[0]!.requestedByDisplayName;
    };
    expect(await requester({ displayName: "Consumer Owner", email: "owner@example.test" })).toBe("Consumer Owner");
    expect(await requester({ displayName: "owner@example.test", email: "owner@example.test" })).toBeUndefined();
    expect(await requester({ displayName: "someone@else.example", email: "owner@example.test" })).toBeUndefined();
    expect(await requester({ displayName: APP_OWNER })).toBeUndefined();
    expect(await requester({ email: "owner@example.test" })).toBeUndefined();
  }, 180_000);

  test("a provider member declines; the consumer may select again; a requirement named requests keeps PUT", async () => {
    const { h, interfaceId } = await linkFixture();
    const PROVIDER_MEMBER = "acct_provider_member";
    h.accounts.saveAccount({ subject: PROVIDER_MEMBER, createdAt: Date.now(), updatedAt: Date.now() });
    expect(await h.ownership.putMember({ capsuleId: PROVIDER, accountId: PROVIDER_MEMBER, status: "active", createdAt: NOW, updatedAt: NOW })).toBe(true);
    const pending = (await put(h, h.headers.session(APP_OWNER), interfaceId, 0)).body.link!;
    const linkId = (await h.core.interfaces.getLatestCapsuleInterfaceLink(CAPSULE, "tools"))!.id;
    expect(await provider(h, h.headers.session(PROVIDER_MEMBER), "POST", `${linkId}/decline`, { expectedGeneration: pending.generation, approvedPermissions: ["mcp.read"] })).toMatchObject({ status: 400, code: "invalid_request" });
    const declined = await provider(h, h.headers.session(PROVIDER_MEMBER), "POST", `${linkId}/decline`, { expectedGeneration: pending.generation });
    expect(declined.status).toBe(200);
    expect(declined.body.link).toMatchObject({ state: "declined", approvedPermissions: [] });
    const again = await put(h, h.headers.session(APP_OWNER), interfaceId, declined.body.link!.generation);
    expect(again).toMatchObject({ status: 200, body: { link: { state: "pending_approval" } } });
    // `requests` is only the provider listing for GET; PUT still addresses a requirement key.
    const url = new URL(`https://app.takosumi.test/api/v1/capsules/${CAPSULE}/interface-links/requests`);
    const response = await handleControlRoute({
      request: new Request(url, { method: "PUT", headers: { ...h.headers.session(APP_OWNER), "content-type": "application/json" }, body: JSON.stringify({ interfaceId, expectedGeneration: 0 }) }),
      url, store: h.accounts, operations: h.operations,
    });
    expect(response!.status).toBe(404);
    expect(((await response!.json()) as { error: { message: string } }).error.message).toBe("Capsule Interface requirement not found");
  }, 180_000);

  test("an uninstall-scheduled provider or consumer app refuses decisions and keeps the link pending", async () => {
    const { h, interfaceId } = await linkFixture();
    h.accounts.saveAccount({ subject: PROVIDER_OWNER, createdAt: Date.now(), updatedAt: Date.now() });
    const pending = (await put(h, h.headers.session(APP_OWNER), interfaceId, 0)).body.link!;
    const linkId = (await h.core.interfaces.getLatestCapsuleInterfaceLink(CAPSULE, "tools"))!.id;
    const providerCapsule = (await h.ledger.getCapsule(PROVIDER))!;
    await h.ledger.putCapsule({ ...providerCapsule, status: "uninstalled", updatedAt: NOW });
    expect(await provider(h, h.headers.session(PROVIDER_OWNER), "POST", `${linkId}/approve`, { expectedGeneration: pending.generation })).toMatchObject({ status: 412, code: "failed_precondition" });
    expect((await h.core.interfaces.getLatestCapsuleInterfaceLink(CAPSULE, "tools"))?.state).toBe("pending_approval");
    // The same for a consumer scheduled for uninstall.
    await h.ledger.putCapsule({ ...providerCapsule, updatedAt: NOW });
    const consumerCapsule = (await h.ledger.getCapsule(CAPSULE))!;
    await h.ledger.putCapsule({ ...consumerCapsule, status: "uninstalled", updatedAt: NOW });
    expect(await provider(h, h.headers.session(PROVIDER_OWNER), "POST", `${linkId}/approve`, { expectedGeneration: pending.generation })).toMatchObject({ status: 412, code: "failed_precondition", message: "consumer app is not accepting Interface links" });
    expect((await h.core.interfaces.getLatestCapsuleInterfaceLink(CAPSULE, "tools"))?.state).toBe("pending_approval");
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

describe("ownerless (pre-claim) Sources belong to the apps built from them", () => {
  test("a Workspace admin without an app role cannot read or change the app's Source", async () => {
    const h = await fixture({ legacy: true });
    const capsule = (await h.ledger.getCapsule(CAPSULE))!;
    expect((await h.ledger.getSource(capsule.sourceId) as { ownerCapsuleId?: string } | undefined)?.ownerCapsuleId).toBeUndefined();
    const source = capsule.sourceId;
    const admin = h.headers.session(WORKSPACE_ADMIN);
    for (const [method, path, body] of [
      ["GET", `/sources/${source}`, undefined], ["GET", `/sources/${source}/snapshots`, undefined],
      ["PATCH", `/sources/${source}`, { defaultRef: "evil" }], ["POST", `/sources/${source}/sync`, {}],
    ] as const) {
      expect(await h.call(method, path, admin, body), `${method} ${path}`).toMatchObject({ status: 403, code: "app_access_denied" });
    }
    expect((await h.call("GET", `/sources/${source}`, h.headers.session(APP_MEMBER))).status).toBe(200);
    expect(await h.call("POST", `/sources/${source}/sync`, h.headers.session(APP_MEMBER), {})).toMatchObject({ status: 409, message: "reached" });
    expect((await h.call("GET", `/sources/${source}`, h.headers.session(APP_OWNER))).status).toBe(200);
    expect(await h.call("DELETE", `/sources/${source}`, h.headers.session(APP_MEMBER))).toMatchObject({ status: 403, code: "app_owner_only" });
  }, 180_000);

  test("source_sync Runs of such a Source follow the app; a retired Source falls back to the Workspace", async () => {
    const h = await fixture({ legacy: true });
    expect(await h.call("GET", "/runs/run_legacy_sync", h.headers.session(WORKSPACE_ADMIN))).toMatchObject({ status: 403, code: "app_access_denied" });
    expect((await h.call("GET", "/runs/run_legacy_sync", h.headers.session(APP_MEMBER))).status).toBe(200);
    expect((await h.call("GET", "/runs/run_gone", h.headers.session(WORKSPACE_OWNER))).status).toBe(200);
    expect(await h.call("GET", "/runs/run_gone", h.headers.session(APP_MEMBER))).toMatchObject({ status: 403, code: "forbidden" });
  }, 180_000);
});

describe("Workspace compatibility lists omit apps the caller cannot view", () => {
  async function list(h: Harness, path: string, credential: Record<string, string>) {
    const url = new URL(`https://app.takosumi.test/api/v1${path}`);
    const response = await handleControlRoute({ request: new Request(url, { headers: credential }), url, store: h.accounts, operations: h.operations });
    expect(response!.status, path).toBe(200);
    return await response!.json() as Record<string, unknown>;
  }
  const ids = (rows: unknown, key = "id") => (rows as Record<string, unknown>[]).map((row) => row[key]);
  /** List routes read the ledger with the store-side filter; seed the Runs there. */
  async function seedListRuns(h: Harness): Promise<void> {
    for (const run of [
      runFixture("run_plan", { createdAt: "2026-10-28T00:00:03.000Z" }),
      runFixture("run_legacy_sync", { capsuleId: undefined, sourceId: "src_authz", createdAt: "2026-10-28T00:00:02.000Z" }),
      runFixture("run_workspace", { capsuleId: undefined, sourceId: "src_unowned", createdAt: "2026-10-28T00:00:01.000Z" }),
    ]) await h.ledger.putBackupRun({ ...run, type: "backup", status: "succeeded" } as Run);
  }

  test("Workspace roles without an app role see no rows of the owned app", async () => {
    const h = await fixture({ legacy: true });
    await seedListRuns(h);
    for (const subject of [WORKSPACE_OWNER, WORKSPACE_ADMIN, WORKSPACE_MEMBER]) {
      const credential = h.headers.session(subject);
      expect(ids((await list(h, `/workspaces/${WORKSPACE}/capsules`, credential)).capsules), subject).not.toContain(CAPSULE);
      expect(ids((await list(h, `/workspaces/${WORKSPACE}/current-state-versions`, credential)).stateVersions, "capsuleId"), subject).not.toContain(CAPSULE);
      const runs = ids((await list(h, `/workspaces/${WORKSPACE}/runs`, credential)).runs);
      expect(runs, subject).not.toContain("run_plan");
      expect(runs, subject).not.toContain("run_legacy_sync");
      expect(runs, subject).toContain("run_workspace");
      expect(ids((await list(h, `/sources?workspaceId=${WORKSPACE}`, credential)).sources), subject).not.toContain("src_authz");
      expect(ids((await list(h, `/dashboard/overview?workspaceId=${WORKSPACE}`, credential)).capsules), subject).not.toContain(CAPSULE);
    }
  }, 180_000);

  test("an app member who is also in the Workspace sees the app's rows", async () => {
    const h = await fixture({ legacy: true });
    await seedListRuns(h);
    const credential = h.headers.session(DUAL);
    expect(ids((await list(h, `/workspaces/${WORKSPACE}/capsules`, credential)).capsules)).toContain(CAPSULE);
    const runs = ids((await list(h, `/workspaces/${WORKSPACE}/runs`, credential)).runs);
    expect(runs).toContain("run_plan");
    expect(runs).toContain("run_legacy_sync");
    expect(ids((await list(h, `/sources?workspaceId=${WORKSPACE}`, credential)).sources)).toContain("src_authz");
    expect(ids((await list(h, `/dashboard/overview?workspaceId=${WORKSPACE}`, credential)).capsules)).toContain(CAPSULE);
  }, 180_000);

  test("apps without an ownership row keep the Workspace decision", async () => {
    const h = await fixture({ owned: false, legacy: true });
    await seedListRuns(h);
    const credential = h.headers.session(WORKSPACE_MEMBER);
    expect(ids((await list(h, `/workspaces/${WORKSPACE}/capsules`, credential)).capsules)).toContain(CAPSULE);
    expect(ids((await list(h, `/workspaces/${WORKSPACE}/runs`, credential)).runs)).toContain("run_plan");
  }, 180_000);
});

describe("review round 3: shared Sources, cursors and Activity", () => {
  async function get(h: Harness, path: string, credential: Record<string, string>) {
    const url = new URL(`https://app.takosumi.test/api/v1${path}`);
    const response = await handleControlRoute({ request: new Request(url, { headers: credential }), url, store: h.accounts, operations: h.operations });
    expect(response!.status, path).toBe(200);
    return await response!.json() as Record<string, unknown>;
  }

  test("a Source shared by an owned and an unowned app needs every app's own decision", async () => {
    const h = await fixture({ legacy: true });
    await seedCapsuleModel(h.ledger, {
      workspaceId: WORKSPACE, capsuleId: OTHER_CAPSULE, sourceId: "src_authz", snapshotId: "snap_other",
      installConfigId: "cfg_other", legacySharedSource: true, name: "other-app",
    });
    expect(await h.ownership.getOwnership(OTHER_CAPSULE)).toBeUndefined();
    for (const [method, path, body] of [["PATCH", "/sources/src_authz", {}], ["POST", "/sources/src_authz/sync", {}]] as const) {
      // App member without a Workspace role: the unowned app's legacy rule refuses.
      expect((await h.call(method, path, h.headers.session(APP_MEMBER), body)).status, `member ${method}`).toBe(403);
      // Workspace admin without an app role: the owned app refuses.
      expect(await h.call(method, path, h.headers.session(WORKSPACE_ADMIN), body), `admin ${method}`).toMatchObject({ status: 403, code: "app_access_denied" });
      // Both rules satisfied.
      expect(await h.call(method, path, h.headers.session(DUAL), body), `dual ${method}`).toMatchObject({ status: 409, message: "reached" });
    }
  }, 180_000);

  async function hiddenAndVisibleApps() {
    const h = await fixture();
    const visible = ["cap_b_visible", "cap_d_visible", "cap_f_visible", "cap_h_visible"];
    const hidden = [CAPSULE, "cap_a_hidden", "cap_c_hidden", "cap_e_hidden", "cap_g_hidden"];
    for (const capsuleId of [...visible, ...hidden.slice(1)]) {
      await seedCapsuleModel(h.ledger, {
        workspaceId: WORKSPACE, capsuleId, sourceId: `src_${capsuleId}`, snapshotId: `snap_${capsuleId}`,
        installConfigId: `cfg_${capsuleId}`, name: capsuleId.replaceAll("_", "-"),
      });
    }
    for (const capsuleId of hidden.slice(1)) {
      expect(await h.ownership.initializeOwnershipIfMissing({
        capsuleId, ownerAccountId: APP_OWNER, ownershipEpoch: 0,
        managementState: "active", managementEpoch: 0, storageRoot: `apps/${capsuleId}`,
      })).toBe(true);
    }
    return { h, visible, hidden };
  }

  const decoded = (cursor: string) => Buffer.from(cursor, "base64url").toString("utf8");

  test("filtered list cursors never point at a hidden app and paging visits each visible row once", async () => {
    const { h, visible, hidden } = await hiddenAndVisibleApps();
    const admin = h.headers.session(WORKSPACE_ADMIN);
    const hiddenTimes = new Set<string>();
    for (const id of hidden) hiddenTimes.add((await h.ledger.getCapsule(id))!.createdAt);
    const visibleTimes = new Set<string>();
    for (const id of visible) visibleTimes.add((await h.ledger.getCapsule(id))!.createdAt);
    for (const [path, key, idOf] of [
      [`/workspaces/${WORKSPACE}/capsules`, "capsules", (row: Record<string, unknown>) => row.id as string],
      [`/workspaces/${WORKSPACE}/current-state-versions`, "stateVersions", (row: Record<string, unknown>) => row.capsuleId as string],
    ] as const) {
      for (const limit of [1, 2, 3]) {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
          const body = await get(h, `${path}?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, admin);
          seen.push(...(body[key] as Record<string, unknown>[]).map(idOf));
          cursor = body.nextCursor as string | undefined;
          if (!cursor) break;
          const position = JSON.parse(decoded(cursor)) as { c: string; i: string };
          expect(hidden, `${path} limit=${limit}`).not.toContain(position.i);
          expect(visible).toContain(position.i);
          // Every capsule here shares one timestamp source; the cursor's is a visible row's.
          expect(visibleTimes.has(position.c)).toBe(true);
          for (const id of hidden) expect(decoded(cursor)).not.toContain(id);
        }
        if (key === "capsules") expect([...seen].sort(), `${path} limit=${limit}`).toEqual([...visible].sort());
        else expect(seen.every((id) => visible.includes(id))).toBe(true);
        expect(new Set(seen).size).toBe(seen.length);
      }
    }
    expect(hiddenTimes.size).toBeGreaterThan(0);
    // Sources of hidden apps are omitted and never anchor the Source cursor.
    const sourceIds: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 30; page++) {
      const body = await get(h, `/sources?workspaceId=${WORKSPACE}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, admin);
      sourceIds.push(...(body.sources as { id: string }[]).map((source) => source.id));
      cursor = body.nextCursor as string | undefined;
      if (!cursor) break;
      for (const id of hidden) expect(decoded(cursor)).not.toContain(`src_${id}`);
    }
    for (const id of hidden.slice(1)) expect(sourceIds).not.toContain(`src_${id}`);
    for (const id of visible) expect(sourceIds.filter((source) => source === `src_${id}`)).toHaveLength(1);
  }, 180_000);

  test("the Workspace Run list cursor only points at Runs the caller may view", async () => {
    const { h, visible, hidden } = await hiddenAndVisibleApps();
    const all = [...visible, ...hidden].sort().map((capsuleId, index) => runFixture(`run_${String(index).padStart(2, "0")}_${capsuleId}`, {
      capsuleId, type: "backup", status: "succeeded", createdAt: new Date(Date.parse(NOW) + index * 1000).toISOString(),
    }));
    for (const run of all) await h.ledger.putBackupRun(run);
    const admin = h.headers.session(WORKSPACE_ADMIN);
    for (const limit of [1, 2]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const body = await get(h, `/workspaces/${WORKSPACE}/runs?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, admin);
        seen.push(...(body.runs as { capsuleId: string }[]).map((run) => run.capsuleId));
        cursor = body.nextCursor as string | undefined;
        if (!cursor) break;
        for (const id of hidden) expect(decoded(cursor)).not.toContain(id);
      }
      expect([...seen].sort()).toEqual([...visible].sort());
    }
  }, 180_000);

  test("Activity and bootstrap notifications attribute every app-scoped event and fail closed", async () => {
    const h = await fixture();
    const record = (event: Record<string, unknown>) => (h.operations as unknown as {
      activity: { record(input: Record<string, unknown>): Promise<unknown> };
    }).activity.record({ workspaceId: WORKSPACE, actorId: APP_OWNER, metadata: {}, ...event });
    await record({ action: "interface.created", targetType: "interface", targetId: "iface_x", metadata: { name: "storage", ownerKind: "Capsule", ownerId: CAPSULE } });
    const provided = await h.core.interfaces.create({
      workspaceId: WORKSPACE, name: "app-tools", ownerRef: { kind: "Capsule", id: CAPSULE },
      spec: { type: "mcp.server", version: "1", document: {}, inputs: { endpoint: { source: "literal", value: "https://app.example.test/mcp" } }, access: { visibility: "workspace", resourceUriInput: "endpoint" } },
    });
    // Attributed through the Interface's provider app (the subject is a principal).
    await record({ action: "interface_binding.created", targetType: "interface_binding", targetId: "ifb_x", metadata: { interfaceId: provided.metadata.id, subjectKind: "Principal", subjectId: "pairwise_x" } });
    await record({ action: "run_group.created", targetType: "run_group", targetId: "rg_x", metadata: { memberCapsuleIds: [CAPSULE] } });
    await record({ action: "backup.created", targetType: "backup", targetId: "bk_run", metadata: { ref: "r", runId: "run_plan" } });
    await record({ action: "backup.created", targetType: "backup", targetId: "bk_wide", metadata: { ref: "r" } });
    await record({ action: "capsule.updated", targetType: "capsule", targetId: CAPSULE });
    // Cannot be attributed: a missing Run and a missing Interface.
    await record({ action: "run.failed", targetType: "run", targetId: "run_missing", metadata: {} });
    await record({ action: "interface.retired", targetType: "interface", targetId: "iface_missing", metadata: { name: "gone" } });
    // Workspace-level, and a Run of a Source no app uses.
    await record({ action: "workspace.updated", targetType: "workspace", targetId: WORKSPACE, metadata: { fields: ["name"] } });
    await record({ action: "connection.created", targetType: "connection", targetId: "conn_x", metadata: { provider: "x" } });
    await record({ action: "run.applied", targetType: "run", targetId: "run_workspace", metadata: {} });
    const workspaceLevel = ["connection.created", "run.applied", "workspace.updated"];
    // interface.created is recorded twice: by the probe and by the Interface create above.
    const appScoped = ["backup.created", "backup.created", "capsule.updated", "interface.created", "interface.created", "interface_binding.created", "run_group.created"];
    const actions = async (credential: Record<string, string>) => [
      ((await get(h, `/workspaces/${WORKSPACE}/activity`, credential)).events as { action: string }[]).map((event) => event.action).sort(),
      ((await get(h, `/dashboard/bootstrap?includeNotifications=true&workspaceId=${WORKSPACE}`, credential)).notifications as { event: { action: string } }[] ?? [])
        .map((entry) => entry.event.action).sort(),
    ];
    // The Workspace list keeps the Workspace decision for Workspace-level
    // events. Bootstrap notifications are built from the caller's apps
    // (TASK-0118 9.1): only app-scoped events of apps the caller manages.
    const [adminList, adminNotifications] = await actions(h.headers.session(WORKSPACE_ADMIN));
    expect(adminList).toEqual(workspaceLevel);
    expect(adminNotifications).toEqual([]);
    const [dualList, dualNotifications] = await actions(h.headers.session(DUAL));
    expect(dualList).toEqual([...appScoped, ...workspaceLevel].sort());
    expect(dualNotifications).toEqual([...appScoped].sort());
  }, 180_000);

  test("Activity reads nothing more without owned apps and caps Run lookups with them", async () => {
    for (const owned of [false, true]) {
      const h = await fixture({ owned });
      const counts = { runs: 0, sources: 0 };
      const operations = h.operations as unknown as {
        getRun(id: string): Promise<Run>; getSource(id: string): Promise<unknown>;
        activity: { record(input: Record<string, unknown>): Promise<unknown> };
      };
      const getRun = operations.getRun.bind(operations);
      const getSource = operations.getSource.bind(operations);
      operations.getRun = async (id) => { counts.runs++; return await getRun(id); };
      operations.getSource = async (id) => { counts.sources++; return await getSource(id); };
      for (let index = 0; index < 80; index++) {
        // 80 events naming 70 distinct unattributed Runs (duplicates read once).
        await operations.activity.record({ workspaceId: WORKSPACE, actorId: APP_OWNER, action: "run.failed", targetType: "run", targetId: `run_unknown_${index % 70}`, metadata: {} });
      }
      const events = (await get(h, `/workspaces/${WORKSPACE}/activity?limit=100`, h.headers.session(WORKSPACE_OWNER))).events as unknown[];
      if (!owned) {
        expect(counts).toEqual({ runs: 0, sources: 0 });
        expect(events).toHaveLength(80);
      } else {
        expect(counts.runs).toBeLessThanOrEqual(50);
        expect(counts.runs + counts.sources).toBeLessThanOrEqual(50);
        // Their app cannot be determined while the Workspace has an owned app.
        expect(events).toHaveLength(0);
      }
    }
  }, 180_000);
});

describe("post-6b follow-ups: store-filtered lists, usage, Activity and uninstalled apps", () => {
  async function get(h: Harness, path: string, credential: Record<string, string>, operations = h.operations) {
    const url = new URL(`${ORIGIN}/api/v1${path}`);
    const response = await handleControlRoute({ request: new Request(url, { headers: credential }), url, store: h.accounts, operations });
    return { status: response!.status, body: await response!.json() as Record<string, unknown> };
  }
  const at = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString();
  const APP_B = "cap_b_member_app";
  /** App B: WORKSPACE_MEMBER is its member; it has no role in CAPSULE (app A). */
  async function withAppB(h: Harness): Promise<void> {
    await seedCapsuleModel(h.ledger, {
      workspaceId: WORKSPACE, capsuleId: APP_B, sourceId: "src_app_b", snapshotId: "snap_app_b",
      installConfigId: "cfg_app_b", name: "app-b",
    });
    expect(await h.ownership.initializeOwnershipIfMissing({
      capsuleId: APP_B, ownerAccountId: APP_OWNER, ownershipEpoch: 0,
      managementState: "active", managementEpoch: 0, storageRoot: `apps/${APP_B}`,
    })).toBe(true);
    expect(await h.ownership.putMember({
      capsuleId: APP_B, accountId: WORKSPACE_MEMBER, status: "active", addedBy: APP_OWNER, createdAt: NOW, updatedAt: NOW,
    })).toBe(true);
  }
  const backupRun = (id: string, seconds: number, overrides: Partial<Run> = {}) =>
    runFixture(id, { type: "backup", status: "succeeded", createdAt: at(seconds), ...overrides });
  const record = (h: Harness, event: Record<string, unknown>) => (h.operations as unknown as {
    activity: { record(input: Record<string, unknown>): Promise<unknown> };
  }).activity.record({ workspaceId: WORKSPACE, actorId: APP_OWNER, metadata: {}, ...event });

  test("a reader who is a member of app B reaches B's Runs behind 1,100 hidden Runs of app A", async () => {
    const h = await fixture();
    await withAppB(h);
    await h.ledger.putBackupRun(backupRun("run_b_1", 1, { capsuleId: APP_B }));
    await h.ledger.putBackupRun(backupRun("run_b_2", 2, { capsuleId: APP_B }));
    for (let index = 0; index < 1_100; index++) await h.ledger.putBackupRun(backupRun(`run_a_${index}`, 100 + index));
    const reader = h.headers.session(WORKSPACE_MEMBER);
    const first = await get(h, `/workspaces/${WORKSPACE}/runs?limit=2`, reader);
    expect(first.status).toBe(200);
    expect((first.body.runs as { id: string }[]).map((run) => run.id)).toEqual(["run_b_2", "run_b_1"]);
    // One per page: the cursor points at B's Run and the next page continues.
    const one = await get(h, `/workspaces/${WORKSPACE}/runs?limit=1`, reader);
    expect((one.body.runs as { id: string }[]).map((run) => run.id)).toEqual(["run_b_2"]);
    const cursor = one.body.nextCursor as string;
    expect(Buffer.from(cursor, "base64url").toString("utf8")).not.toContain("run_a_");
    const two = await get(h, `/workspaces/${WORKSPACE}/runs?limit=1&cursor=${encodeURIComponent(cursor)}`, reader);
    expect((two.body.runs as { id: string }[]).map((run) => run.id)).toEqual(["run_b_1"]);
    expect(two.body.nextCursor).toBeUndefined();
    // App A's member (no role in B) sees A's newest Runs.
    const member = await get(h, `/workspaces/${WORKSPACE}/runs?limit=2`, h.headers.session(DUAL));
    expect((member.body.runs as { id: string }[]).map((run) => run.id)).toEqual(["run_a_1099", "run_a_1098"]);
  }, 180_000);

  test("Workspace usage and backups omit apps the caller cannot view", async () => {
    const h = await fixture();
    await withAppB(h);
    await h.ledger.putBackupRun(backupRun("run_usage_a", 1));
    const event = (id: string, seconds: number, fields: { capsuleId?: string; runId?: string } = {}) => ({
      id, workspaceId: WORKSPACE, ...fields, kind: "operation" as const, quantity: 1, usdMicros: 0,
      ratingStatus: "unrated" as const, source: "runner" as const, idempotencyKey: `${id}:operation`, createdAt: at(seconds),
    });
    for (const usage of [
      event("u_a", 5, { capsuleId: CAPSULE }), event("u_a_run", 4, { runId: "run_usage_a" }),
      event("u_b", 3, { capsuleId: APP_B }), event("u_gone_run", 2, { runId: "run_missing" }), event("u_workspace", 1),
    ]) await h.ledger.putUsageEvent(usage);
    const usageIds = async (subject: string) => {
      const response = await get(h, `/workspaces/${WORKSPACE}/usage`, h.headers.session(subject));
      expect(response.status, subject).toBe(200);
      return (response.body.usageEvents as { id: string }[]).map((row) => row.id);
    };
    // Usage of an app is its Capsule's or its Run's; usage whose Run is gone
    // cannot be attributed and stays hidden while owned apps exist.
    expect(await usageIds(WORKSPACE_MEMBER)).toEqual(["u_b", "u_workspace"]);
    expect(await usageIds(WORKSPACE_OWNER)).toEqual(["u_workspace"]);
    expect(await usageIds(DUAL)).toEqual(["u_a", "u_a_run", "u_workspace"]);
    for (const backup of [
      { id: "bk_a", capsuleId: CAPSULE, createdAt: at(3) }, { id: "bk_b", capsuleId: APP_B, createdAt: at(2) },
      { id: "bk_wide", createdAt: at(1) },
    ]) {
      await h.ledger.putBackupRecord({ workspaceId: WORKSPACE, ref: `opaque-${backup.id}`, digest: `sha256:${"b".repeat(64)}`, sizeBytes: 1, ...backup });
    }
    const backupIds = async (subject: string) =>
      ((await get(h, `/workspaces/${WORKSPACE}/backups`, h.headers.session(subject))).body.backups as { id: string }[]).map((row) => row.id);
    // A Workspace-wide backup carries every live app: hidden unless all are visible.
    expect(await backupIds(WORKSPACE_MEMBER)).toEqual(["bk_b"]);
    expect(await backupIds(DUAL)).toEqual(["bk_a"]);
  }, 180_000);

  test("a host that wires ownership without the filtered reads is refused instead of listing unfiltered", async () => {
    const h = await fixture();
    const { viewerLists: _dropped, ...rest } = h.operations as unknown as Record<string, unknown>;
    void _dropped;
    const operations = rest as unknown as ControlPlaneOperations;
    const owner = h.headers.session(WORKSPACE_OWNER);
    for (const path of [
      `/workspaces/${WORKSPACE}/capsules`, `/workspaces/${WORKSPACE}/current-state-versions`, `/workspaces/${WORKSPACE}/runs`,
      `/workspaces/${WORKSPACE}/backups`, `/workspaces/${WORKSPACE}/usage`, `/sources?workspaceId=${WORKSPACE}`,
      `/dashboard/overview?workspaceId=${WORKSPACE}`,
    ]) {
      expect((await get(h, path, owner, operations)).status, path).toBe(503);
    }
  }, 180_000);

  test("Activity naming a Capsule this Workspace does not have stays hidden while owned apps exist", async () => {
    const h = await fixture();
    await h.ledger.putSource({
      id: "src_unused", workspaceId: WORKSPACE, name: "unused", url: "https://git.example.test/unused.git",
      defaultRef: "main", defaultPath: ".", status: "active", autoSync: false, hookSecretHash: "fixture-hash",
      createdAt: NOW, updatedAt: NOW,
    });
    // Before: the unknown Capsule id was dropped and the unused Source made it Workspace-level.
    await record(h, { action: "source.updated", targetType: "source", targetId: "src_unused", metadata: { capsuleId: "cap_elsewhere" } });
    await record(h, { action: "source.created", targetType: "source", targetId: "src_unused", metadata: {} });
    const actions = async (subject: string) =>
      ((await get(h, `/workspaces/${WORKSPACE}/activity`, h.headers.session(subject))).body.events as { action: string }[])
        .map((event) => event.action).sort();
    expect(await actions(WORKSPACE_OWNER)).toEqual(["source.created"]);
    expect(await actions(DUAL)).toEqual(["source.created"]);
  }, 180_000);

  test("the retained owner and members of an uninstalled app still see it and its history in Workspace lists", async () => {
    const h = await fixture();
    await h.ledger.putCapsule({ ...(await h.ledger.getCapsule(CAPSULE))!, status: "destroyed", updatedAt: NOW });
    await record(h, { action: "capsule.uninstalled", targetType: "capsule", targetId: CAPSULE });
    const view = async (subject: string) => ({
      capsules: ((await get(h, `/workspaces/${WORKSPACE}/capsules`, h.headers.session(subject))).body.capsules as { id: string }[])
        .map((row) => row.id),
      activity: ((await get(h, `/workspaces/${WORKSPACE}/activity`, h.headers.session(subject))).body.events as { action: string }[])
        .map((event) => event.action),
    });
    // DUAL is an app member (and a Workspace admin, so it may open the Workspace lists).
    expect(await view(DUAL)).toEqual({ capsules: [CAPSULE], activity: ["capsule.uninstalled"] });
    expect(await view(WORKSPACE_ADMIN)).toEqual({ capsules: [], activity: [] });
  }, 180_000);
});
