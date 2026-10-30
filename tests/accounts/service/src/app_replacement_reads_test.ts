/**
 * Workspace-free replacement reads (TASK-0118 Phase 9.1, P9.1-a): every new
 * route authorizes by app ownership/membership only. The matrix covers the
 * app owner, an app member, an unrelated account, PATs with `appIds`, an
 * installed app's own OAuth token, and a legacy Workspace-scoped PAT.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderConnection } from "takosumi-contract/connections";
import type { ActivityEvent } from "takosumi-contract/activity";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import {
  createActivityCursorSealer,
  SEALED_ACTIVITY_CURSOR_PREFIX,
} from "../../../../accounts/service/src/control/activity-cursor.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import type { StoredGitInstallPlan } from "../../../../core/domains/install-plans/store.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const ORIGIN = "https://app.takosumi.test";
/** Test-only passphrase (not a secret) for sealing Activity cursors. */
const TEST_ACTIVITY_CURSOR_PASSPHRASE = "activity-cursor-test-passphrase-not-a-secret-0001";
const WORKSPACE = "ws_replacement_reads";
const CAPSULE = "cap_reads_mine";
const OTHER = "cap_reads_other";
/** seedCapsuleModel's Workspace owner, and CAPSULE's app owner here. */
const OWNER = "user_test";
const MEMBER = "acct_reads_member";
/** Member of both apps: sees events that name both. */
const DUAL = "acct_reads_dual";
const OTHER_OWNER = "acct_reads_other_owner";
const STRANGER = "acct_reads_stranger";
const NOW = "2026-10-30T00:00:00.000Z";

async function fixture() {
  const ledger = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(ledger, {
    workspaceId: WORKSPACE,
    capsuleId: CAPSULE,
    sourceId: "src_reads_mine",
    snapshotId: "snap_reads",
    installConfigId: "cfg_reads",
  });
  await ledger.putCapsule({ ...seeded.capsule, status: "active", currentStateGeneration: 1, updatedAt: NOW });
  await ledger.putSource({ ...seeded.source, id: "src_reads_other", ownerCapsuleId: OTHER });
  await ledger.putCapsule({
    ...seeded.capsule, id: OTHER, name: "other", slug: "other", sourceId: "src_reads_other",
    status: "active", currentStateGeneration: 1, updatedAt: NOW,
  });
  const { operations: core } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: ledger,
  });
  for (const [capsuleId, owner] of [[CAPSULE, OWNER], [OTHER, OTHER_OWNER]] as const) {
    expect(await core.appOwnership.initializeOwnershipIfMissing({
      capsuleId, ownerAccountId: owner, ownershipEpoch: 0,
      managementState: "active", managementEpoch: 0, storageRoot: `apps/${capsuleId}`,
    })).toBe(true);
  }
  for (const [capsuleId, accountId] of [[CAPSULE, MEMBER], [CAPSULE, DUAL], [OTHER, DUAL]] as const) {
    expect(await core.appOwnership.putMember({
      capsuleId, accountId, status: "active", addedBy: "owner", createdAt: NOW, updatedAt: NOW,
    })).toBe(true);
  }
  const operations = core as unknown as ControlPlaneOperations;
  const accounts = new InMemoryAccountsStore();
  for (const subject of [OWNER, MEMBER, DUAL, OTHER_OWNER, STRANGER]) {
    accounts.saveAccount({ subject, createdAt: Date.now(), updatedAt: Date.now() });
  }
  const headers = {
    session(subject: string): Record<string, string> {
      const sessionId = `sess_${subject}`;
      accounts.saveAccountSession({ sessionId, subject, createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
      return { cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}` };
    },
    pat(subject: string, restriction: { readonly appIds?: readonly string[]; readonly workspaceId?: string } = {}): Record<string, string> {
      const token = `fixture-pat-${subject}-${restriction.appIds?.join("-") ?? restriction.workspaceId ?? "account"}`;
      accounts.savePersonalAccessToken(token, {
        tokenId: `pat_${token}`, tokenPrefix: "fixture", subject, name: "reads",
        scopes: ["read", "write"],
        ...(restriction.appIds ? { appIds: [...restriction.appIds] } : {}),
        ...(restriction.workspaceId ? { workspaceId: restriction.workspaceId } : {}),
        createdAt: Date.now(),
      });
      return { authorization: `Bearer ${token}` };
    },
    /** An installed app's own OAuth token, bound to `capsuleId` and the Workspace. */
    oauth(subject: string, capsuleId: string): Record<string, string> {
      const token = `fixture-oauth-${subject}-${capsuleId}`;
      accounts.saveAccessToken(token, {
        clientId: `client_${capsuleId}`, scope: "openid capsules:read capsules:write",
        subject: `pairwise_${subject}`, takosumiSubject: subject, capsuleId,
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
  ): Promise<{ readonly status: number; readonly code?: string; readonly body: Record<string, unknown> }> {
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
      activityCursorSealer: createActivityCursorSealer(TEST_ACTIVITY_CURSOR_PASSPHRASE),
    });
    expect(response).toBeDefined();
    const text = await response!.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(text); } catch { /* empty body */ }
    const error = parsed.error as { code?: string } | undefined;
    return { status: response!.status, ...(error?.code ? { code: error.code } : {}), body: parsed };
  }
  async function record(event: Omit<ActivityEvent, "id" | "createdAt" | "workspaceId"> & { readonly workspaceId?: string }) {
    await core.activity.record({ workspaceId: WORKSPACE, ...event });
  }
  return { ledger, core, operations, accounts, headers, call, record, seeded };
}

type Harness = Awaited<ReturnType<typeof fixture>>;
type Expectation = "allow" | "deny" | "unauthenticated";

const APP_PRINCIPALS: readonly {
  readonly name: string;
  readonly credential: (h: Harness) => Record<string, string>;
  readonly expect: Expectation;
}[] = [
  { name: "app owner", credential: (h) => h.headers.session(OWNER), expect: "allow" },
  { name: "app member (no Workspace membership)", credential: (h) => h.headers.session(MEMBER), expect: "allow" },
  { name: "unrelated account", credential: (h) => h.headers.session(STRANGER), expect: "deny" },
  { name: "owner of another app in the same namespace", credential: (h) => h.headers.session(OTHER_OWNER), expect: "deny" },
  { name: "owner PAT with this appId", credential: (h) => h.headers.pat(OWNER, { appIds: [CAPSULE] }), expect: "allow" },
  { name: "member PAT with this appId", credential: (h) => h.headers.pat(MEMBER, { appIds: [CAPSULE] }), expect: "allow" },
  { name: "owner PAT restricted to another app", credential: (h) => h.headers.pat(OWNER, { appIds: [OTHER] }), expect: "deny" },
  { name: "installed-app token of this app", credential: (h) => h.headers.oauth(OWNER, CAPSULE), expect: "allow" },
  { name: "installed-app token of another app", credential: (h) => h.headers.oauth(OWNER, OTHER), expect: "deny" },
  { name: "unauthenticated", credential: () => ({}), expect: "unauthenticated" },
];

const APP_ROUTES: readonly { readonly name: string; readonly run: (h: Harness, c: Record<string, string>) => ReturnType<Harness["call"]> }[] = [
  { name: "GET capsule activity", run: (h, c) => h.call("GET", `/capsules/${CAPSULE}/activity`, c) },
  { name: "GET capsule backups", run: (h, c) => h.call("GET", `/capsules/${CAPSULE}/backups`, c) },
  { name: "GET capsule materialization failures", run: (h, c) => h.call("GET", `/capsules/${CAPSULE}/interface-materialization-failures`, c) },
  {
    name: "POST capsule materialization retry",
    run: (h, c) => h.call("POST", `/capsules/${CAPSULE}/interface-materialization-failures/cimi_missing/retries`, c, {
      failureDigest: `sha256:${"1".repeat(64)}`, stateVersionId: "sv_missing", stateGeneration: 1,
    }),
  },
  { name: "GET app Sources", run: (h, c) => h.call("GET", `/sources?capsuleId=${CAPSULE}`, c) },
  { name: "GET app capsule-configs", run: (h, c) => h.call("GET", `/capsule-configs?capsuleId=${CAPSULE}`, c) },
  { name: "GET app release-owned connections", run: (h, c) => h.call("GET", `/provider-connections?capsuleId=${CAPSULE}&projection=release-owned`, c) },
];

function assertOutcome(outcome: { readonly status: number; readonly code?: string }, expected: Expectation, label: string): void {
  const detail = `${label}: ${outcome.status} ${outcome.code ?? ""}`;
  if (expected === "allow") expect([401, 403].includes(outcome.status), detail).toBe(false);
  else if (expected === "deny") expect([outcome.status, outcome.code], detail).toEqual([403, "app_access_denied"]);
  else expect(outcome.status, detail).toBe(401);
}

describe("per-app replacement routes authorize by app role only", () => {
  for (const principal of APP_PRINCIPALS) {
    test(principal.name, async () => {
      const h = await fixture();
      for (const route of APP_ROUTES) {
        const outcome = await route.run(h, principal.credential(h));
        assertOutcome(outcome, principal.expect, route.name);
        if (principal.expect === "allow") {
          // The retry reaches the domain and finds no such failure.
          expect(outcome.status, route.name).toBe(route.name.startsWith("POST") ? 404 : 200);
        }
      }
    });
  }
});

describe("per-app replacement route contents", () => {
  test("backups list only this app's backups, newest first with a cursor", async () => {
    const h = await fixture();
    for (const [index, capsuleId] of [CAPSULE, OTHER, CAPSULE, undefined, CAPSULE].entries()) {
      await h.ledger.putBackupRecord({
        id: `bkp_${index}`, workspaceId: WORKSPACE, ...(capsuleId ? { capsuleId, environment: "production" } : {}),
        ref: `opaque-${index}`, digest: `sha256:${"b".repeat(64)}`, sizeBytes: 1,
        createdAt: `2026-10-30T00:00:0${index}.000Z`,
      });
    }
    const first = await h.call("GET", `/capsules/${CAPSULE}/backups?limit=2`, h.headers.session(MEMBER));
    expect((first.body.backups as { id: string }[]).map((row) => row.id)).toEqual(["bkp_4", "bkp_2"]);
    const second = await h.call("GET", `/capsules/${CAPSULE}/backups?limit=2&cursor=${first.body.nextCursor}`, h.headers.session(MEMBER));
    expect((second.body.backups as { id: string }[]).map((row) => row.id)).toEqual(["bkp_0"]);
    expect(second.body.nextCursor).toBeUndefined();
  });

  test("the app's Source and InstallConfig are returned; the legacy forms are untouched", async () => {
    const h = await fixture();
    const sources = await h.call("GET", `/sources?capsuleId=${CAPSULE}`, h.headers.session(MEMBER));
    expect((sources.body.sources as { id: string }[]).map((row) => row.id)).toEqual(["src_reads_mine"]);
    const configs = await h.call("GET", `/capsule-configs?capsuleId=${CAPSULE}`, h.headers.session(MEMBER));
    expect((configs.body.installConfigs as { id: string }[]).map((row) => row.id)).toEqual(["cfg_reads"]);
    expect((await h.call("GET", `/sources?capsuleId=${CAPSULE}&workspaceId=${WORKSPACE}`, h.headers.session(OWNER))).status).toBe(400);
    expect((await h.call("GET", "/sources?capsuleId=", h.headers.session(OWNER))).status).toBe(400);
    // Without capsuleId the legacy Workspace form still answers (and still requires workspaceId).
    expect((await h.call("GET", "/sources", h.headers.session(OWNER))).status).toBe(400);
    expect((await h.call("GET", `/sources?workspaceId=${WORKSPACE}`, h.headers.session(OWNER))).status).toBe(200);
  });

  test("the app release-owned projection requires projection=release-owned", async () => {
    const h = await fixture();
    const response = await h.call("GET", `/provider-connections?capsuleId=${CAPSULE}`, h.headers.session(OWNER));
    expect([response.status, response.code]).toEqual([400, "invalid_request"]);
  });
});

describe("account-level Activity", () => {
  async function seededActivity(h: Harness) {
    await h.record({ action: "capsule.updated", targetType: "capsule", targetId: CAPSULE, metadata: {} });
    await h.record({ action: "capsule.updated", targetType: "capsule", targetId: OTHER, metadata: {} });
    await h.record({ action: "interface_link.created", targetType: "interface_link", targetId: "link_x", metadata: { consumerCapsuleId: CAPSULE, providerCapsuleId: OTHER } });
    await h.record({ action: "workspace.updated", targetType: "workspace", targetId: WORKSPACE, metadata: {} });
    await h.record({ action: "connection.created", targetType: "connection", targetId: "conn_x", metadata: {} });
    await h.record({ action: "run.failed", targetType: "run", targetId: "run_missing", metadata: {} });
  }
  const shown = (body: Record<string, unknown>) =>
    (body.events as ActivityEvent[]).map((event) => `${event.action}:${event.targetId}`).sort();
  const MINE = [`capsule.updated:${CAPSULE}`];
  const THEIRS = [`capsule.updated:${OTHER}`];
  const LINK = ["interface_link.created:link_x"];

  const cases: readonly { readonly name: string; readonly credential: (h: Harness) => Record<string, string>; readonly expected: readonly string[] | "deny" }[] = [
    { name: "app owner", credential: (h) => h.headers.session(OWNER), expected: MINE },
    { name: "app member", credential: (h) => h.headers.session(MEMBER), expected: MINE },
    { name: "member of both apps sees the event that names both", credential: (h) => h.headers.session(DUAL), expected: [...MINE, ...THEIRS, ...LINK].sort() },
    { name: "owner of the other app", credential: (h) => h.headers.session(OTHER_OWNER), expected: THEIRS },
    { name: "unrelated account", credential: (h) => h.headers.session(STRANGER), expected: [] },
    { name: "PAT with this appId", credential: (h) => h.headers.pat(DUAL, { appIds: [CAPSULE] }), expected: MINE },
    { name: "PAT with an app the user does not manage", credential: (h) => h.headers.pat(OWNER, { appIds: [OTHER] }), expected: [] },
    { name: "installed-app token sees only its own app", credential: (h) => h.headers.oauth(OWNER, CAPSULE), expected: MINE },
    { name: "legacy Workspace-scoped PAT", credential: (h) => h.headers.pat(OWNER, { workspaceId: WORKSPACE }), expected: "deny" },
  ];
  for (const item of cases) {
    test(item.name, async () => {
      const h = await fixture();
      await seededActivity(h);
      const response = await h.call("GET", "/activity", item.credential(h));
      if (item.expected === "deny") {
        expect([response.status, response.code]).toEqual([403, "app_access_denied"]);
        return;
      }
      expect(response.status).toBe(200);
      // Workspace-level events and events whose app is unknown are never shown.
      expect(shown(response.body)).toEqual([...item.expected].sort());
    });
  }

  test("app Activity hides events that also name an app the caller cannot view", async () => {
    const h = await fixture();
    await seededActivity(h);
    const owner = await h.call("GET", `/capsules/${CAPSULE}/activity`, h.headers.session(OWNER));
    expect(shown(owner.body)).toEqual(MINE);
    const dual = await h.call("GET", `/capsules/${CAPSULE}/activity`, h.headers.session(DUAL));
    expect(shown(dual.body)).toEqual([...MINE, ...LINK].sort());
  });

  test("cursor paging returns every visible event once, newest first, past hidden events", async () => {
    const h = await fixture();
    const expected: string[] = [];
    for (let index = 0; index < 7; index++) {
      await h.record({ action: "capsule.updated", targetType: "capsule", targetId: CAPSULE, metadata: { index } });
      for (let hidden = 0; hidden < 3; hidden++) {
        await h.record({ action: "capsule.updated", targetType: "capsule", targetId: OTHER, metadata: { index, hidden } });
      }
      expected.unshift(String(index));
    }
    for (const path of ["/activity", `/capsules/${CAPSULE}/activity`]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const response = await h.call("GET", `${path}?limit=2${cursor ? `&cursor=${cursor}` : ""}`, h.headers.session(OWNER));
        expect(response.status, path).toBe(200);
        const events = response.body.events as ActivityEvent[];
        expect(events.length, path).toBeLessThanOrEqual(2);
        seen.push(...events.map((event) => String(event.metadata.index)));
        cursor = response.body.nextCursor as string | undefined;
        if (!cursor) break;
        expect(cursor.startsWith(SEALED_ACTIVITY_CURSOR_PREFIX), path).toBe(true);
      }
      expect(seen, path).toEqual(expected);
    }
  });
});

describe("account-level open install attempts", () => {
  async function seedAttempt(h: Harness, actor: string, id: string) {
    const authority = await h.core.workspaces.captureManagementAuthority(WORKSPACE);
    const plan: StoredGitInstallPlan = {
      id, workspaceId: WORKSPACE, workspaceManagementAuthority: authority,
      createdBy: actor, actorSubject: actor, idempotencyKeyHash: `key_${id}`, requestDigest: `digest_${id}`,
      source: { name: "repo", url: "https://github.com/takos/example.git", ref: "main", path: "." },
      capsule: { name: `app-${id}`, environment: "production" }, options: {},
      operation: "install", phase: "syncing_source", generation: 0, createdAt: NOW, updatedAt: NOW,
    };
    expect((await h.core.gitInstallPlans.create(plan, authority)).status).toBe("created");
  }
  const cases: readonly { readonly name: string; readonly credential: (h: Harness) => Record<string, string>; readonly expected: readonly string[] | "deny" }[] = [
    { name: "creator", credential: (h) => h.headers.session(OWNER), expected: ["gip_owner"] },
    { name: "app member does not see the owner's attempts", credential: (h) => h.headers.session(MEMBER), expected: ["gip_member"] },
    { name: "unrelated account", credential: (h) => h.headers.session(STRANGER), expected: [] },
    { name: "account-wide PAT of the creator", credential: (h) => h.headers.pat(OWNER), expected: ["gip_owner"] },
    { name: "PAT with appIds", credential: (h) => h.headers.pat(OWNER, { appIds: [CAPSULE] }), expected: "deny" },
    { name: "installed-app token", credential: (h) => h.headers.oauth(OWNER, CAPSULE), expected: "deny" },
    { name: "legacy Workspace-scoped PAT", credential: (h) => h.headers.pat(OWNER, { workspaceId: WORKSPACE }), expected: "deny" },
  ];
  for (const item of cases) {
    test(item.name, async () => {
      const h = await fixture();
      await seedAttempt(h, OWNER, "gip_owner");
      await seedAttempt(h, MEMBER, "gip_member");
      const response = await h.call("GET", "/install-plans?open=1", item.credential(h));
      if (item.expected === "deny") {
        expect([response.status, response.code]).toEqual([403, "app_access_denied"]);
        return;
      }
      expect(response.status).toBe(200);
      expect((response.body.installPlans as { installPlan: { id: string } }[]).map((entry) => entry.installPlan.id))
        .toEqual([...item.expected]);
    });
  }

  test("open=1 is required and other methods keep their routes", async () => {
    const h = await fixture();
    expect((await h.call("GET", "/install-plans", h.headers.session(OWNER))).status).toBe(400);
    // POST still reaches the workspace-less install route (and validates its body).
    expect((await h.call("POST", "/install-plans", h.headers.session(OWNER), {})).status).toBe(400);
  });
});

describe("account-level provider connections", () => {
  async function seedConnections(h: Harness) {
    const base = {
      provider: "registry.example/cloud", providerSource: "registry.example/cloud", status: "active",
      materialization: { kind: "env" }, envNames: ["TOKEN"], createdAt: NOW, updatedAt: NOW,
    };
    await h.ledger.putConnection({ ...base, id: "conn_owner", ownerAccountId: OWNER, scope: "personal", displayName: "mine" } as unknown as ProviderConnection);
    await h.ledger.putConnection({ ...base, id: "conn_owner_git", ownerAccountId: OWNER, scope: "personal", kind: "source_git_https_token" } as unknown as ProviderConnection);
    await h.ledger.putConnection({ ...base, id: "conn_stranger", ownerAccountId: STRANGER, scope: "personal" } as unknown as ProviderConnection);
  }
  const ids = (body: Record<string, unknown>) => (body.providerConnections as { id: string }[]).map((row) => row.id);

  test("the caller's own provider connections, never another account's or Source git ones", async () => {
    const h = await fixture();
    await seedConnections(h);
    expect(ids((await h.call("GET", "/provider-connections", h.headers.session(OWNER))).body)).toEqual(["conn_owner"]);
    expect(ids((await h.call("GET", "/provider-connections", h.headers.pat(OWNER))).body)).toEqual(["conn_owner"]);
    expect(ids((await h.call("GET", "/provider-connections", h.headers.session(MEMBER))).body)).toEqual([]);
    expect(ids((await h.call("GET", "/provider-connections?projection=release-owned", h.headers.session(OWNER))).body)).toEqual([]);
  });

  for (const [name, credential] of [
    ["PAT with appIds", (h: Harness) => h.headers.pat(OWNER, { appIds: [CAPSULE] })],
    ["installed-app token", (h: Harness) => h.headers.oauth(OWNER, CAPSULE)],
    ["legacy Workspace-scoped PAT", (h: Harness) => h.headers.pat(OWNER, { workspaceId: WORKSPACE })],
  ] as const) {
    test(`${name} cannot list account connections`, async () => {
      const h = await fixture();
      const response = await h.call("GET", "/provider-connections", credential(h));
      expect([response.status, response.code]).toEqual([403, "app_access_denied"]);
    });
  }
});

describe("dashboard bootstrap", () => {
  test("Workspaces are opt-in and notifications come from the caller's apps", async () => {
    const h = await fixture();
    await h.record({ action: "capsule.updated", targetType: "capsule", targetId: CAPSULE, metadata: {} });
    await h.record({ action: "capsule.updated", targetType: "capsule", targetId: OTHER, metadata: {} });
    await h.record({ action: "workspace.updated", targetType: "workspace", targetId: WORKSPACE, metadata: {} });
    const plain = await h.call("GET", "/dashboard/bootstrap", h.headers.session(OWNER));
    expect(plain.status).toBe(200);
    expect(plain.body).not.toHaveProperty("workspaces");
    expect(plain.body).not.toHaveProperty("notifications");
    const withWorkspaces = await h.call("GET", "/dashboard/bootstrap?includeWorkspaces=true", h.headers.session(OWNER));
    expect(withWorkspaces.body).toHaveProperty("workspaces");
    const notified = await h.call("GET", "/dashboard/bootstrap?includeNotifications=true", h.headers.session(OWNER));
    expect(notified.body).not.toHaveProperty("workspaces");
    expect(notified.body.notifications).toEqual([
      expect.objectContaining({
        capsuleId: CAPSULE,
        event: expect.objectContaining({ action: "capsule.updated", targetId: CAPSULE }),
      }),
    ]);
    const stranger = await h.call("GET", "/dashboard/bootstrap?includeNotifications=true", h.headers.session(STRANGER));
    expect(stranger.body.notifications).toEqual([]);
  });
});
