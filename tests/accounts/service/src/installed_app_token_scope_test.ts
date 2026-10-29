import { describe, expect, test } from "bun:test";
import type { Run } from "takosumi-contract/runs";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
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
const MEMBER = "acct_app_member";
const DELEGATE_SOURCE: InstalledAppDelegationSource = {
  url: "https://git.example.test/first-party/takos", path: ".", refs: ["refs/heads/main", "refs/tags/v*"],
};

function reached(): never {
  throw new OpenTofuControllerError("failed_precondition", "reached");
}

async function fixture(options: {
  readonly owned?: boolean;
  readonly delegationSources?: readonly InstalledAppDelegationSource[];
  /** The delegate Capsule's adopted (applied) revision ref. */
  readonly delegateRef?: string;
  /** The full ref the runner resolved for the delegate's adopted snapshot; null: none recorded. */
  readonly delegateResolvedRef?: string | null;
} = {}) {
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
      expect(await core.appOwnership.putMember({ capsuleId, accountId: MEMBER, status: "active", createdAt: NOW, updatedAt: NOW })).toBe(true);
    }
  }
  // Every app's applied revision; the delegate's ref decides delegation.
  const adopted = new Map<string, { sourceSnapshotId: string; ref: string; path: string; resolvedCommit: string }>(
    [[THIRD_PARTY, "src_third_party"], [OTHER, "src_other"], [DELEGATE, "src_takos"]].map(([capsuleId, sourceId]) => [capsuleId!, {
      sourceSnapshotId: `snap_${sourceId}`, ref: capsuleId === DELEGATE ? options.delegateRef ?? "main" : "main", path: ".",
      resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
    }]),
  );
  // What the runner recorded on each adopted snapshot.
  const resolvedRefs = new Map<string, string | undefined>([
    ["src_third_party", "refs/heads/main"], ["src_other", "refs/heads/main"],
    ["src_takos", options.delegateResolvedRef === null ? undefined : options.delegateResolvedRef ?? "refs/heads/main"],
  ]);
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
    getCapsuleAdoptedSourceRevision: async (capsuleId: string) => adopted.get(capsuleId),
    getSourceSnapshot: async (id: string) => {
      const sourceId = id.replace(/^snap_/u, "");
      if (!sources.has(sourceId)) throw new OpenTofuControllerError("not_found", "missing");
      const resolvedRef = resolvedRefs.get(sourceId);
      return { id, sourceId, workspaceId: WORKSPACE, ...(resolvedRef !== undefined ? { resolvedRef } : {}) };
    },
    approveRun: async () => reached(),
    cancelRun: async () => reached(),
    createCapsuleDestroyPlan: async () => reached(),
    createStateVersionRollbackPlan: async () => reached(),
    getStateVersion: async (id: string) => {
      const capsuleId = id.replace(/^sv_/u, "");
      if (![THIRD_PARTY, OTHER, DELEGATE].includes(capsuleId)) throw new OpenTofuControllerError("not_found", "missing");
      return { stateVersion: { id, workspaceId: WORKSPACE, capsuleId, environment: "production", generation: 1, createdByRunId: "run_x", createdAt: NOW } };
    },
    createApplyRun: async () => reached(),
    patchSource: async () => reached(),
  } as unknown as ControlPlaneOperations;
  const accounts = new InMemoryAccountsStore();
  accounts.saveAccount({ subject: USER, createdAt: Date.now(), updatedAt: Date.now() });
  accounts.saveAccount({ subject: MEMBER, createdAt: Date.now(), updatedAt: Date.now() });
  function session(subject: string): Record<string, string> {
    accounts.saveAccountSession({ sessionId: `sess_${subject}`, subject, createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
    return { cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=sess_${subject}` };
  }
  function appToken(capsuleId: string, workspaceId = WORKSPACE, subject = USER): Record<string, string> {
    const token = `fixture-oauth-${capsuleId}-${workspaceId}-${subject}`;
    accounts.saveAccessToken(token, {
      clientId: `client_${capsuleId}`, scope: "openid capsules:read capsules:write",
      subject: `pairwise_${capsuleId}_${subject}`, takosumiSubject: subject, capsuleId, workspaceId,
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
  return { core, ledger, appToken, call, session, adopted, sources, runs, resolvedRefs };
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
      // Plan review stays with a person: its own Runs cannot be approved or applied by the app.
      expect(await h.call("POST", `/runs/run_${THIRD_PARTY}/approve`, token, {})).toMatchObject({ status: 403, code: "app_access_denied" });
      expect(await h.call("POST", `/runs/run_${THIRD_PARTY}/apply`, token, {})).toMatchObject({ status: 403, code: "app_access_denied" });
      expect(await h.call("POST", `/capsules/${THIRD_PARTY}/destroy-plan`, token, {})).toMatchObject({ status: 403, code: "app_access_denied" });
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
    const otherRepository = await fixture({ delegationSources: [{ url: "https://git.example.test/first-party/takos", path: "apps/other", refs: ["refs/heads/main"] }] });
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
      JSON.stringify([{ url: "http://git.example.test/a", path: ".", refs: ["refs/heads/main"] }]),
      JSON.stringify([{ url: "https://user:pw@git.example.test/a", path: ".", refs: ["refs/heads/main"] }]),
      JSON.stringify([{ url: "https://git.example.test/a", path: "../b", refs: ["refs/heads/main"] }]),
      JSON.stringify([{ url: "https://git.example.test/a", path: "/abs", refs: ["refs/heads/main"] }]),
      JSON.stringify([{ url: "https://git.example.test/a", path: ".", refs: ["refs/heads/main"], extra: true }]),
      JSON.stringify([{ url: "https://git.example.test/a" }]),
      JSON.stringify([{ url: "https://git.example.test/a", path: "." }]),
      JSON.stringify([{ url: "https://git.example.test/a", path: ".", refs: [] }]),
      JSON.stringify([{ url: "https://git.example.test/a", path: ".", refs: ["main"] }]),
      JSON.stringify([{ url: "https://git.example.test/a", path: ".", refs: ["refs/pull/1/head"] }]),
      JSON.stringify([{ url: "https://git.example.test/a", path: ".", refs: ["refs/tags/*v"] }]),
      JSON.stringify([{ url: "https://git.example.test/a", path: ".", refs: ["0123456789abcdef0123456789abcdef01234567"] }]),
    ]) {
      expect(() => parseInstalledAppDelegationSources(value)).toThrow(TypeError);
    }
  });
});

describe("delegation follows the deployed revision's ref", () => {
  /** `requested` is the ref as installed; `resolved` the full ref the runner recorded (null: none). */
  const delegated = async (requested: string, resolved: string | null, refs: readonly string[] = DELEGATE_SOURCE.refs) => {
    const h = await fixture({ delegationSources: [{ ...DELEGATE_SOURCE, refs }], delegateRef: requested, delegateResolvedRef: resolved });
    return (await h.call("GET", `/capsules/${OTHER}/provider-bindings`, h.appToken(DELEGATE))).status;
  };

  test("only the resolved full branch or tag name delegates", async () => {
    expect(await delegated("main", "refs/heads/main")).toBe(200);
    expect(await delegated("refs/heads/main", "refs/heads/main")).toBe(200);
    // An install without a ref records HEAD; the runner resolves it to the default branch.
    expect(await delegated("HEAD", "refs/heads/main")).toBe(200);
    expect(await delegated("v1.4.2", "refs/tags/v1.4.2")).toBe(200);
    expect(await delegated("refs/tags/v2.0.0", "refs/tags/v2.0.0")).toBe(200);
    expect(await delegated("feature", "refs/heads/feature")).toBe(403);
  }, 180_000);

  test("bare names that resolve to pull request refs, unresolved HEAD, raw commits and old snapshots never delegate", async () => {
    // The measured attack: bare names matched by ls-remote suffix while the
    // allow-list holds prefixes that their bare expansion would have matched.
    const wide = ["refs/heads/main", "refs/tags/1*", "refs/tags/2*", "refs/heads/h*"];
    expect(await delegated("1/head", "refs/pull/1/head", wide)).toBe(403);
    expect(await delegated("2/merge", "refs/pull/2/merge", wide)).toBe(403);
    expect(await delegated("head", "refs/pull/7/head", wide)).toBe(403);
    expect(await delegated("pull/999/head", "refs/pull/999/head")).toBe(403);
    expect(await delegated("HEAD", null)).toBe(403);
    expect(await delegated("main", null)).toBe(403);
    expect(await delegated("0123456789abcdef0123456789abcdef01234567", null)).toBe(403);
    expect(await delegated("main", "refs/heads/main ")).toBe(403);
  }, 180_000);

  test("the Source's default ref does not matter; a newly applied ref does", async () => {
    const h = await fixture({ delegationSources: [DELEGATE_SOURCE] });
    h.sources.get("src_takos")!.defaultRef = "refs/pull/999/head";
    expect((await h.call("GET", `/capsules/${OTHER}/provider-bindings`, h.appToken(DELEGATE))).status).toBe(200);
    h.adopted.set(DELEGATE, { ...h.adopted.get(DELEGATE)!, ref: "refs/pull/999/head" });
    h.resolvedRefs.set("src_takos", "refs/pull/999/head");
    expect((await h.call("GET", `/capsules/${OTHER}/provider-bindings`, h.appToken(DELEGATE, WORKSPACE))).status).toBe(403);
  }, 180_000);

  test("a disabled or uninstall-scheduled delegate app loses delegation", async () => {
    for (const patch of [{ status: "disabled" }, { status: "uninstalled", uninstall: { phase: "scheduled" } }]) {
      const h = await fixture({ delegationSources: [DELEGATE_SOURCE] });
      const current = (await h.ledger.getCapsule(DELEGATE))!;
      await h.ledger.putCapsule({ ...current, ...patch } as typeof current);
      expect((await h.call("GET", `/capsules/${OTHER}/provider-bindings`, h.appToken(DELEGATE))).status, JSON.stringify(patch)).toBe(403);
    }
  }, 180_000);

  test("a designated delegate approves, applies and cancels other apps' Runs; a non-delegated token cancels nothing", async () => {
    const h = await fixture({ delegationSources: [DELEGATE_SOURCE] });
    expect(await h.call("POST", `/runs/run_${OTHER}/approve`, h.appToken(DELEGATE), {})).toMatchObject({ status: 409, message: "reached" });
    expect(await h.call("POST", `/runs/run_${OTHER}/cancel`, h.appToken(DELEGATE), {})).toMatchObject({ status: 409, message: "reached" });
    // Runs record only the person (the token's user), not the client: even the
    // user's own Run of the token's own app is not cancellable by that token.
    for (const createdBy of [USER, MEMBER]) {
      h.runs.set(`run_${THIRD_PARTY}`, { ...h.runs.get(`run_${THIRD_PARTY}`)!, createdBy } as Run);
      expect(await h.call("POST", `/runs/run_${THIRD_PARTY}/cancel`, h.appToken(THIRD_PARTY), {}), createdBy).toMatchObject({ status: 403, code: "app_access_denied" });
    }
    expect(await h.call("POST", `/runs/run_${THIRD_PARTY}/cancel`, h.session(USER), {})).toMatchObject({ status: 409, message: "reached" });
  }, 180_000);
});

describe("changing what a delegate app deploys is owner-only", () => {
  test("members cannot change its ref, path or adopted config; the owner can", async () => {
    const h = await fixture({ delegationSources: [DELEGATE_SOURCE] });
    const member = h.session(MEMBER);
    expect(await h.call("POST", `/capsules/${DELEGATE}/revision-plans`, member, { ref: "refs/pull/1/head" })).toMatchObject({ status: 403, code: "app_owner_only" });
    expect(await h.call("POST", `/capsules/${DELEGATE}/install-config-re-adoptions`, member, {})).toMatchObject({ status: 403, code: "app_owner_only" });
    expect(await h.call("PATCH", "/sources/src_takos", member, { defaultRef: "refs/pull/1/head" })).toMatchObject({ status: 403, code: "app_owner_only" });
    expect(await h.call("PATCH", "/sources/src_takos", member, { autoSync: true })).toMatchObject({ status: 409, message: "reached" });
    expect(await h.call("PATCH", "/sources/src_takos", h.session(USER), { defaultRef: "main" })).toMatchObject({ status: 409, message: "reached" });
    expect((await h.call("POST", `/capsules/${DELEGATE}/revision-plans`, h.session(USER), {})).code).not.toBe("app_owner_only");
    // Ordinary apps keep member updates.
    expect(await h.call("PATCH", "/sources/src_other", member, { defaultRef: "dev" })).toMatchObject({ status: 409, message: "reached" });
  }, 180_000);
});

describe("an app token keeps its own Source connection and its own config", () => {
  test("no new Source connection, no Workspace InstallConfig and no other app's config", async () => {
    const h = await fixture();
    const token = h.appToken(THIRD_PARTY);
    expect(await h.call("PATCH", "/sources/src_third_party", token, { authConnectionId: "conn_owner_other" })).toMatchObject({ status: 403, code: "app_access_denied" });
    expect(await h.call("PATCH", "/sources/src_third_party", token, { autoSync: true })).toMatchObject({ status: 409, message: "reached" });
    expect(await h.call("POST", "/sources/src_third_party/compatibility-check", token, { compileInstallUx: true, capsuleName: "x" })).toMatchObject({ status: 403, code: "app_access_denied" });
    expect(await h.call("POST", "/sources/src_third_party/compatibility-check", token, { installConfigId: "cfg_someone_else" })).toMatchObject({ status: 403, code: "app_access_denied" });
  }, 180_000);
});

describe("review round 3: delegate uninstall, rollback and Interface approval", () => {
  test("a delegate token uninstalls another app its user owns, never its own app, and never transfers", async () => {
    const h = await fixture({ delegationSources: [DELEGATE_SOURCE] });
    expect(await h.call("POST", `/capsules/${OTHER}/destroy-plan`, h.appToken(DELEGATE), {})).toMatchObject({ status: 409, message: "reached" });
    expect(await h.call("POST", `/capsules/${DELEGATE}/destroy-plan`, h.appToken(DELEGATE), {})).toMatchObject({ status: 403, code: "app_access_denied" });
    // The token's user is only a member of OTHER: the app role refuses.
    expect(await h.call("POST", `/capsules/${OTHER}/destroy-plan`, h.appToken(DELEGATE, WORKSPACE, MEMBER), {})).toMatchObject({ status: 403 });
    expect(await h.call("POST", `/capsules/${OTHER}/ownership-transfers`, h.appToken(DELEGATE), { toAccountId: MEMBER })).toMatchObject({ status: 403, code: "app_access_denied" });
    // A token that is not a designated delegate stays refused.
    expect(await h.call("POST", `/capsules/${THIRD_PARTY}/destroy-plan`, h.appToken(THIRD_PARTY), {})).toMatchObject({ status: 403, code: "app_access_denied" });
    const undesignated = await fixture();
    expect(await undesignated.call("POST", `/capsules/${OTHER}/destroy-plan`, undesignated.appToken(DELEGATE), {})).toMatchObject({ status: 403, code: "app_access_denied" });
  }, 180_000);

  test("without ownership rows a delegate token uninstalls only for the Workspace owner", async () => {
    const h = await fixture({ delegationSources: [DELEGATE_SOURCE], owned: false });
    await h.ledger.putWorkspaceMember({ id: "wsm_member_admin", workspaceId: WORKSPACE, accountId: MEMBER, roles: ["admin"], status: "active", createdAt: NOW, updatedAt: NOW });
    expect(await h.call("POST", `/capsules/${OTHER}/destroy-plan`, h.appToken(DELEGATE), {})).toMatchObject({ status: 409, message: "reached" });
    expect(await h.call("POST", `/capsules/${OTHER}/destroy-plan`, h.appToken(DELEGATE, WORKSPACE, MEMBER), {})).toMatchObject({ status: 403, code: "app_owner_only" });
    expect(await h.call("POST", `/capsules/${DELEGATE}/destroy-plan`, h.appToken(DELEGATE), {})).toMatchObject({ status: 403, code: "app_access_denied" });
  }, 180_000);

  test("rolling a delegate app back is owner-only (the Workspace owner without ownership rows)", async () => {
    const owned = await fixture({ delegationSources: [DELEGATE_SOURCE] });
    expect(await owned.call("POST", `/state-versions/sv_${DELEGATE}/rollback-plan`, owned.session(MEMBER), {})).toMatchObject({ status: 403, code: "app_owner_only" });
    expect(await owned.call("POST", `/state-versions/sv_${DELEGATE}/rollback-plan`, owned.session(USER), {})).toMatchObject({ status: 409, message: "reached" });
    // Ordinary apps keep member rollbacks.
    expect(await owned.call("POST", `/state-versions/sv_${OTHER}/rollback-plan`, owned.session(MEMBER), {})).toMatchObject({ status: 409, message: "reached" });
    const fallback = await fixture({ delegationSources: [DELEGATE_SOURCE], owned: false });
    await fallback.ledger.putWorkspaceMember({ id: "wsm_member_admin", workspaceId: WORKSPACE, accountId: MEMBER, roles: ["admin"], status: "active", createdAt: NOW, updatedAt: NOW });
    expect(await fallback.call("POST", `/state-versions/sv_${DELEGATE}/rollback-plan`, fallback.session(MEMBER), {})).toMatchObject({ status: 403, code: "app_owner_only" });
    expect(await fallback.call("POST", `/capsules/${DELEGATE}/revision-plans`, fallback.session(MEMBER), {})).toMatchObject({ status: 403, code: "app_owner_only" });
    expect(await fallback.call("POST", `/state-versions/sv_${DELEGATE}/rollback-plan`, fallback.session(USER), {})).toMatchObject({ status: 409, message: "reached" });
    expect(await fallback.call("POST", `/state-versions/sv_${OTHER}/rollback-plan`, fallback.session(MEMBER), {})).toMatchObject({ status: 409, message: "reached" });
  }, 180_000);

  test("a delegate token approves an Interface link only when its user may change the provider app", async () => {
    const h = await fixture({ delegationSources: [DELEGATE_SOURCE] });
    const requirement = { key: "tools", interface: { type: "mcp.server", version: "1" }, permissions: ["mcp.read"], delivery: { type: "oauth2" } } as const;
    const consumer = (await h.ledger.getCapsule(OTHER))!;
    const config = (await h.ledger.getInstallConfig(consumer.installConfigId))!;
    await h.ledger.putInstallConfig({ ...config, requiredInterfaces: [requirement] });
    const STRANGER_APP = "cap_stranger_provider";
    await h.ledger.putCapsule({ ...consumer, id: STRANGER_APP, name: STRANGER_APP, slug: STRANGER_APP, updatedAt: NOW });
    expect(await h.core.appOwnership.initializeOwnershipIfMissing({
      capsuleId: STRANGER_APP, ownerAccountId: "acct_stranger", ownershipEpoch: 0, managementState: "active",
      managementEpoch: 0, storageRoot: `apps/${STRANGER_APP}`,
    })).toBe(true);
    const iface = async (owner: string) => (await h.core.interfaces.create({
      workspaceId: WORKSPACE, name: `${owner}-tools`, ownerRef: { kind: "Capsule", id: owner },
      spec: { type: "mcp.server", version: "1", document: {}, inputs: { endpoint: { source: "literal", value: `https://${owner}.example.test/mcp` } }, access: { visibility: "workspace", resourceUriInput: "endpoint" } },
    })).metadata.id;
    const owned = await iface(THIRD_PARTY);
    const stranger = await iface(STRANGER_APP);
    // The user owns THIRD_PARTY: the delegate token's link is approved.
    const approved = await h.call("PUT", `/capsules/${OTHER}/interface-links/tools`, h.appToken(DELEGATE), { interfaceId: owned, expectedGeneration: 0 });
    expect(approved.status).toBe(200);
    expect((await h.core.interfaces.getLatestCapsuleInterfaceLink(OTHER, "tools"))).toMatchObject({ state: "active", providerCapsuleId: THIRD_PARTY });
    // Re-pointing to an app the user has no role on would only be pending: refused, link kept.
    const repoint = await h.call("PUT", `/capsules/${OTHER}/interface-links/tools`, h.appToken(DELEGATE), { interfaceId: stranger, expectedGeneration: 1 });
    expect(repoint).toMatchObject({ status: 409, code: "interface_link_approval_required" });
    // The same app's own (non-delegate) token never approves: after an unlink, its new link is pending.
    const latest = (await h.core.interfaces.getLatestCapsuleInterfaceLink(OTHER, "tools"))!;
    expect((await h.call("DELETE", `/capsules/${OTHER}/interface-links/tools`, h.session(USER), { expectedGeneration: latest.generation })).status).toBe(200);
    const revoked = (await h.core.interfaces.getLatestCapsuleInterfaceLink(OTHER, "tools"))!;
    expect((await h.call("PUT", `/capsules/${OTHER}/interface-links/tools`, h.appToken(OTHER), { interfaceId: owned, expectedGeneration: revoked.generation })).status).toBe(200);
    expect((await h.core.interfaces.getLatestCapsuleInterfaceLink(OTHER, "tools"))).toMatchObject({ state: "pending_approval" });
  }, 180_000);
});
