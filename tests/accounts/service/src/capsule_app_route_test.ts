import { expect, test } from "bun:test";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { CapsuleAppView } from "takosumi-contract/capsules";
import type { CapsuleRequiredInterface, Interface, InterfaceLink } from "takosumi-contract/interfaces";
import { TAKOSUMI_API_VERSION } from "takosumi-contract/capabilities";
import type { ListRunsResponse } from "takosumi-contract/runs";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import type { CapsuleInterfaceMaterializationFailure } from "../../../../core/domains/interfaces/materialization_intent_failures.ts";
import type { CapsulesService } from "../../../../core/domains/capsules/mod.ts";
import { SCHEDULED_DESTROY_BLOCKED_REASONS } from "../../../../core/domains/capsules/uninstall_finalize.ts";
import { createInMemoryInterfaceStores, type InterfaceService } from "../../../../core/domains/interfaces/mod.ts";
import {
  FIXTURE_CLOUDFLARE_PROVIDER,
  seedCapsuleModel,
  transitionProviderBindingSetForFixture,
} from "../../../helpers/deploy-control/model_fixture.ts";
import type { ProviderBindingSet } from "takosumi-contract/connections";

const ORIGIN = "https://app.takosumi.test";
const OWNER = "user_test";
const STRANGER = "user_stranger";
const WORKSPACE = "ws_app_route";
const CAPSULE = "cap_app_route";

function session(store: InMemoryAccountsStore, subject: string): string {
  const now = Date.now();
  store.saveAccount({ subject, createdAt: now, updatedAt: now });
  const sessionId = `sess_${subject}`;
  store.saveAccountSession({
    sessionId,
    subject,
    createdAt: now,
    expiresAt: now + 60_000,
  });
  return `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}`;
}

async function fixture(options: {
  readonly requiredProviders?: readonly string[];
  readonly sourceUrl?: string;
  readonly overrides?: Partial<ControlPlaneOperations>;
  readonly currentStateVersionId?: string;
  readonly requiredInterfaces?: readonly CapsuleRequiredInterface[];
} = {}) {
  const ledger = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(ledger, {
    workspaceId: WORKSPACE,
    capsuleId: CAPSULE,
    sourceId: "src_app_route",
    snapshotId: "snap_app_route",
    installConfigId: "cfg_app_route",
    ...(options.requiredProviders ? { requiredProviders: options.requiredProviders } : {}),
    ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
    ...(options.requiredInterfaces ? { installConfig: { requiredInterfaces: options.requiredInterfaces } } : {}),
  });
  await ledger.putCapsule({
    ...seeded.capsule,
    status: "active",
    currentStateGeneration: 1,
    ...(options.currentStateVersionId
      ? { currentStateVersionId: options.currentStateVersionId }
      : {}),
    updatedAt: new Date().toISOString(),
  });
  const interfaceStores = createInMemoryInterfaceStores();
  const { operations: core } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: ledger,
    interfaceStores,
  });
  const accounts = new InMemoryAccountsStore();
  const owner = session(accounts, OWNER);
  const stranger = session(accounts, STRANGER);
  const operations = {
    ...(core as unknown as ControlPlaneOperations),
    ...options.overrides,
  } as ControlPlaneOperations;
  async function request(
    path: string,
    cookie = owner,
    method = "GET",
    body?: unknown,
    authorization?: string,
  ) {
    const url = new URL(`${ORIGIN}/api/v1/capsules/${CAPSULE}${path}`);
    const response = await handleControlRoute({
      request: new Request(url, {
        method,
        headers: {
          cookie,
          ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      url,
      store: accounts,
      operations,
    });
    expect(response).toBeDefined();
    return response!;
  }
  async function app(cookie = owner): Promise<CapsuleAppView> {
    const response = await request("/app", cookie);
    expect(response.status).toBe(200);
    return ((await response.json()) as { app: CapsuleAppView }).app;
  }
  return { ledger, core, seeded, request, app, owner, stranger, interfaceStores, accounts, operations };
}

test("destroyed Capsule GET and Workspace list survive retired Source row with a retained state cursor", async () => {
  const h = await fixture({ currentStateVersionId: "sv_retained_destroy" });
  await h.ledger.putCapsule({
    ...h.seeded.capsule,
    status: "destroyed",
    currentStateVersionId: "sv_retained_destroy",
    currentStateGeneration: 2,
  });
  expect(await h.ledger.deleteSource(h.seeded.capsule.sourceId)).toBe(true);

  const get = await h.request("");
  expect(get.status).toBe(200);
  const got = (await get.json()) as { capsule: Record<string, unknown> };
  expect(got.capsule.status).toBe("destroyed");
  expect(got.capsule.adoptedSourceRevision).toBeUndefined();

  const url = new URL(`${ORIGIN}/api/v1/workspaces/${WORKSPACE}/capsules`);
  const list = await handleControlRoute({
    request: new Request(url, { headers: { cookie: h.owner } }),
    url,
    store: h.accounts,
    operations: h.operations,
  });
  expect(list?.status).toBe(200);
  const listed = (await list!.json()) as { capsules: readonly Record<string, unknown>[] };
  expect(listed.capsules[0]?.status).toBe("destroyed");
  expect(listed.capsules[0]?.adoptedSourceRevision).toBeUndefined();
  const app = await h.app();
  expect(app.version).toEqual({ uninstalled: true, updateAvailable: false, stale: false, autoUpdate: false });
  expect(app.incomplete ?? []).not.toContain("version");
});

function planRun(id: string, createdAt: number, over: Partial<PlanRun> = {}): PlanRun {
  return {
    id,
    workspaceId: WORKSPACE,
    capsuleId: CAPSULE,
    source: { kind: "git", url: "https://git.example.com/example/app.git", ref: "main", path: "." },
    sourceDigest: "sha256:source",
    operation: "update",
    runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:variables",
    requiredProviders: [],
    status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: createdAt },
    policyDecisionDigest: "sha256:policy",
    capsuleContext: { workspaceId: WORKSPACE, capsuleId: CAPSULE, environment: "production" },
    auditEvents: [],
    createdAt,
    updatedAt: createdAt,
    ...over,
  };
}

function applyRun(id: string, planRunId: string, createdAt: number, over: Partial<ApplyRun> = {}): ApplyRun {
  return {
    id,
    planRunId,
    workspaceId: WORKSPACE,
    capsuleId: CAPSULE,
    operation: "update",
    runnerProfileId: "opentofu-default",
    status: "succeeded",
    expected: {
      planRunId,
      runnerProfileId: "opentofu-default",
      sourceDigest: "sha256:source",
      variablesDigest: "sha256:variables",
      policyDecisionDigest: "sha256:policy",
      planDigest: "sha256:plan",
      planArtifactDigest: "sha256:artifact",
    },
    stateBackend: { kind: "managed", ref: "state" } as never,
    stateLock: { status: "recorded", backendRef: "state" },
    auditEvents: [],
    createdAt,
    updatedAt: createdAt,
    ...over,
  };
}

test("an installed app reports its state, uninstall grace before scheduling and its repository", async () => {
  const h = await fixture({
    sourceUrl: "https://reader:hunter2@git.example.com/example/app.git?token=abc#frag",
  });
  const response = await h.request("/app");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const app = ((await response.json()) as { app: CapsuleAppView }).app;
  expect(app).toMatchObject({
    kind: "takosumi.capsule-app@v1",
    capsuleId: CAPSULE,
    workspaceId: WORKSPACE,
    name: "app",
    status: "active",
    applied: true,
    state: "installed",
    primaryAction: "view_resources",
    problems: [],
    screens: [],
    progress: { revisionPreparing: false },
    uninstall: { mode: "scheduled", graceDays: 7 },
    version: {
      repository: { url: "https://git.example.com/example/app.git", defaultRef: "main" },
      updateAvailable: false,
      stale: false,
      autoUpdate: false,
    },
  });
  expect(app.uninstall.scheduled).toBeUndefined();
  expect(app.incomplete).toBeUndefined();
  const text = JSON.stringify(app);
  expect(text).not.toContain("hunter2");
  expect(text).not.toContain("token=abc");
  expect(text).not.toContain("test-hook-hash");
  expect(text).not.toContain("installingPrincipalId");
});

test("scheduling an uninstall turns the app into a cancellable grace period with its deadline", async () => {
  const h = await fixture();
  const scheduled = await h.request("", h.owner, "DELETE");
  expect(scheduled.status).toBe(202);
  const capsule = (await scheduled.json()).capsule;
  const app = await h.app();
  expect(app).toMatchObject({
    status: "uninstalled",
    state: "uninstall_scheduled",
    primaryAction: "cancel_uninstall",
    problems: [{ code: "uninstall_scheduled", severity: "warning" }],
    uninstall: {
      mode: "scheduled",
      graceDays: 7,
      scheduled: {
        phase: "scheduled",
        requestedAt: capsule.uninstall.requestedAt,
        deleteAfter: capsule.uninstall.scheduledDestroyAt,
        cancellable: true,
        blocked: false,
      },
    },
  });
  expect(JSON.stringify(app)).not.toContain("requester");
});

test("a failed newest lifecycle Run needs attention and names the Run to retry", async () => {
  const h = await fixture();
  await h.ledger.putPlanRun(planRun("plan_ok", Date.now() - 3_000));
  await h.ledger.putApplyRun(
    applyRun("apply_failed", "plan_ok", Date.now() - 2_000, {
      status: "failed",
      diagnostics: [{ severity: "error", code: "provider_apply_failed", message: "boom" }],
    }),
  );
  // A newer drift check is not a lifecycle Run and must not hide the failure.
  await h.ledger.putPlanRun(planRun("drift_later", Date.now() - 1_000, { driftCheck: true }));
  const app = await h.app();
  expect(app.state).toBe("needs_attention");
  expect(app.primaryAction).toBe("retry");
  expect(app.problems).toEqual([
    {
      code: "run_failed",
      severity: "error",
      runId: "apply_failed",
      runType: "apply",
      errorCode: "provider_apply_failed",
    },
  ]);
  expect(app.latestRun).toMatchObject({ id: "apply_failed", type: "apply", status: "failed" });
  expect(JSON.stringify(app)).not.toContain("boom");
});

test("a policy-denied plan asks for review and the Run list projects structured reasons", async () => {
  const h = await fixture();
  await h.ledger.putPlanRun(
    planRun("plan_denied", Date.now() - 1_000, {
      status: "failed",
      policy: {
        status: "blocked",
        reasons: [
          `provider ${FIXTURE_CLOUDFLARE_PROVIDER} is not allowed by policy`,
          "resource type cloudflare_r2_bucket is not allowed by policy",
        ],
        checkedAt: 1,
      },
    }),
  );
  const app = await h.app();
  expect(app).toMatchObject({
    state: "needs_attention",
    primaryAction: "review",
    problems: [{ code: "policy_blocked", runId: "plan_denied", runType: "plan" }],
  });
  const runs = (await (await h.request("/runs")).json()) as ListRunsResponse;
  expect(runs.runs[0]).toMatchObject({
    id: "plan_denied",
    policyStatus: "deny",
    policyReasons: [
      { code: "provider_not_allowed", layer: "provider", provider: FIXTURE_CLOUDFLARE_PROVIDER },
      { code: "resource_type_not_allowed", layer: "resource", resourceType: "cloudflare_r2_bucket" },
    ],
  });
});

test("a binding without a usable connection asks the person to fix it", async () => {
  const h = await fixture({ requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER] });
  const missing = await h.app();
  expect(missing).toMatchObject({
    state: "needs_attention",
    primaryAction: "fix_connection",
    problems: [
      {
        code: "connection_unavailable",
        provider: FIXTURE_CLOUDFLARE_PROVIDER,
        connectionStatus: "missing",
      },
    ],
  });
  const connectionId = missing.problems[0]!.connectionId!;
  await h.ledger.putConnection({
    id: connectionId,
    workspaceId: WORKSPACE,
    scope: "workspace",
    provider: FIXTURE_CLOUDFLARE_PROVIDER,
    providerSource: FIXTURE_CLOUDFLARE_PROVIDER,
    status: "revoked",
    materialization: "secret",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
  } as never);
  expect((await h.app()).problems[0]).toMatchObject({
    code: "connection_unavailable",
    connectionId,
    connectionStatus: "revoked",
  });
});

test("app connection issues include the canonical owner's personal connections", async () => {
  const connectionId = "personal_cf_owner_connection";
  const personal = {
    id: connectionId,
    scope: "personal",
    ownerAccountId: "canonical_owner",
    provider: FIXTURE_CLOUDFLARE_PROVIDER,
    providerSource: FIXTURE_CLOUDFLARE_PROVIDER,
    status: "verified",
    materialization: "secret",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
  };
  const h = await fixture({
    requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
    overrides: {
      appOwnership: {
        getOwnership: async () => ({
          capsuleId: CAPSULE,
          ownerAccountId: "canonical_owner",
          ownershipEpoch: 1,
          managementState: "active",
          managementEpoch: 1,
          storageRoot: "app://canonical_owner",
        }),
      } as NonNullable<ControlPlaneOperations["appOwnership"]>,
      // Per-app authorization: the viewing Workspace owner is a member of
      // the canonical owner's app, not its owner.
      appAccess: {
        resolveAppAccess: async (accountId: string, capsuleId: string) =>
          accountId === OWNER && capsuleId === CAPSULE
            ? { capsuleId, role: "member" as const, ownerAccountId: "canonical_owner", ownershipEpoch: 1 }
            : undefined,
        listAccessibleApps: async () => ({ apps: [] }),
      },
      accountResources: {
        listConnections: async (accountId: string) => ({
          items: accountId === "canonical_owner" ? [personal] : [],
        }),
      } as NonNullable<ControlPlaneOperations["accountResources"]>,
    },
  });
  const environment = h.seeded.capsule.environment;
  const current = await h.ledger.getProviderBindingSetByCapsule(CAPSULE, environment);
  expect(current).toBeDefined();
  await transitionProviderBindingSetForFixture(h.ledger, {
    ...current!,
    bindings: [{ provider: FIXTURE_CLOUDFLARE_PROVIDER, connectionId }],
    updatedAt: new Date().toISOString(),
  } satisfies ProviderBindingSet);
  const app = await h.app();
  expect(app.problems).not.toContainEqual(expect.objectContaining({ code: "connection_unavailable" }));
});

test("every authorized screen is listed in display order with only display data and a safe URL", async () => {
  const h = await fixture();
  const interfaces = (h.core as unknown as {
    interfaces: {
      create(input: unknown): Promise<{ metadata: { id: string } }>;
      createBinding(id: string, input: unknown): Promise<unknown>;
    };
  }).interfaces;
  const surface = async (name: string, url: string, display: Record<string, unknown>) => {
    const created = await interfaces.create({
      workspaceId: WORKSPACE,
      name,
      ownerRef: { kind: "Capsule", id: CAPSULE },
      spec: {
        type: "interface.ui.surface",
        version: "1",
        document: { launcher: true, display },
        inputs: { url: { source: "literal", value: url } },
        access: { visibility: "workspace" },
      },
    });
    await interfaces.createBinding(created.metadata.id, {
      subjectRef: { kind: "Principal", id: OWNER },
      permissions: ["ui.open"],
      delivery: { type: "none" },
    });
    return created.metadata.id;
  };
  const admin = await surface("admin", "https://admin.example.test/", { title: "Admin", sortOrder: 2 });
  const home = await surface("home", "https://home.example.test/app", { title: "Home", sortOrder: 1, icon: "🏠" });
  await surface("leaky", "https://leaky.example.test/?access_token=secret-value", { title: "Leaky" });

  const app = await h.app();
  expect(app.state).toBe("installed");
  expect(app.primaryAction).toBe("open");
  expect(app.screens).toEqual([
    {
      interfaceId: home,
      name: "home",
      title: "Home",
      icon: { kind: "glyph", glyph: "🏠" },
      sortOrder: 1,
      url: "https://home.example.test/app",
    },
    {
      interfaceId: admin,
      name: "admin",
      title: "Admin",
      sortOrder: 2,
      url: "https://admin.example.test/",
    },
  ]);
  expect(JSON.stringify(app)).not.toContain("secret-value");
  // The stranger is refused before any screen is read.
  expect((await h.request("/app", h.stranger)).status).toBe(403);
});

test("another account cannot read the app view or the Run list of this Workspace", async () => {
  const h = await fixture();
  await h.ledger.putPlanRun(planRun("plan_private", Date.now()));
  for (const path of ["/app", "/runs"]) {
    const response = await h.request(path, h.stranger);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("plan_private");
  }
  expect((await h.request("/app", "")).status).toBe(401);
  expect((await h.request("/app", h.owner, "POST")).status).toBe(405);
  expect((await h.request("/runs", h.owner, "POST")).status).toBe(405);
});

test("the Run list pages newest first with a bounded limit, type filter and strict parameters", async () => {
  const h = await fixture();
  const base = Date.now() - 10_000;
  await h.ledger.putPlanRun(planRun("plan_1", base + 1));
  await h.ledger.putApplyRun(applyRun("apply_1", "plan_1", base + 2));
  await h.ledger.putPlanRun(planRun("drift_1", base + 3, { driftCheck: true }));
  await h.ledger.putPlanRun(planRun("plan_2", base + 4));
  await h.ledger.putPlanRun(
    planRun("plan_other_capsule", base + 5, {
      capsuleId: "cap_someone_else",
      capsuleContext: { workspaceId: WORKSPACE, capsuleId: "cap_someone_else", environment: "production" },
    }),
  );

  const first = (await (await h.request("/runs?limit=2")).json()) as ListRunsResponse;
  expect(first.runs.map((run) => run.id)).toEqual(["plan_2", "drift_1"]);
  expect(first.nextCursor).toBeString();
  const second = (await (
    await h.request(`/runs?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)
  ).json()) as ListRunsResponse;
  expect(second.runs.map((run) => run.id)).toEqual(["apply_1", "plan_1"]);
  expect(second.nextCursor).toBeUndefined();
  expect(second.runs[0]).toMatchObject({ capsuleId: CAPSULE, planRunId: "plan_1" });

  const lifecycle = (await (
    await h.request("/runs?type=plan&type=apply")
  ).json()) as ListRunsResponse;
  expect(lifecycle.runs.map((run) => run.id)).toEqual(["plan_2", "apply_1", "plan_1"]);

  const clamped = await h.request("/runs?limit=100000");
  expect(clamped.status).toBe(200);
  expect(((await clamped.json()) as ListRunsResponse).runs).toHaveLength(4);
  for (const query of ["limit=0", "limit=-1", "limit=two", "type=bogus", "cursor=not-a-cursor"]) {
    expect((await h.request(`/runs?${query}`)).status, query).toBe(400);
  }
});

test("version facts compare the adopted commit with the newest snapshot of the same ref", async () => {
  const commit = "abcdef0123456789abcdef0123456789abcdef01";
  const h = await fixture({
    currentStateVersionId: "sv_app_route",
    overrides: {
      getCapsuleAdoptedSourceRevision: async () => ({
        sourceSnapshotId: "snap_app_route",
        ref: "main",
        path: ".",
        resolvedCommit: commit,
      }),
    },
  });
  const current = await h.ledger.getSourceSnapshot("snap_app_route");
  const snapshot = (id: string, ref: string, resolvedCommit: string, fetchedAt: string) => ({
    ...current!,
    id,
    ref,
    resolvedCommit,
    fetchedAt,
  });
  await h.ledger.putSourceSnapshot(
    snapshot("snap_older_main", "main", "0".repeat(40), "2026-06-01T00:00:00.000Z"),
  );
  await h.ledger.putSourceSnapshot({
    ...snapshot("snap_newer_other_path", "main", "9".repeat(40), "2026-06-09T00:00:00.000Z"),
    path: "another/app",
  });
  const unchanged = await h.app();
  expect(unchanged.version).toMatchObject({
    current: { sourceSnapshotId: "snap_app_route", ref: "main", path: ".", commit },
    latest: { sourceSnapshotId: "snap_app_route", commit },
    updateAvailable: false,
  });

  await h.ledger.putSourceSnapshot(
    snapshot("snap_newer_main", "main", "1".repeat(40), "2026-06-07T00:00:00.000Z"),
  );
  await h.ledger.putSourceSnapshot(
    snapshot("snap_newest_dev", "dev", "2".repeat(40), "2026-06-08T00:00:00.000Z"),
  );
  const capsule = await h.ledger.getCapsule(CAPSULE);
  await h.ledger.putCapsule({ ...capsule!, status: "stale", autoUpdate: true });
  const app = await h.app();
  expect(app.state).toBe("installed");
  expect(app.version).toEqual({
    repository: { url: "https://git.example.com/example/app.git", defaultRef: "main" },
    current: { sourceSnapshotId: "snap_app_route", ref: "main", path: ".", commit },
    latest: {
      sourceSnapshotId: "snap_newer_main",
      ref: "main",
      commit: "1".repeat(40),
      fetchedAt: "2026-06-07T00:00:00.000Z",
    },
    updateAvailable: true,
    stale: true,
    autoUpdate: true,
  });
  expect(app.incomplete).toBeUndefined();
});

test("a supporting read that fails is reported as incomplete instead of silently empty", async () => {
  const h = await fixture({
    overrides: {
      interfaces: {
        listAuthorizedUiSurfaceCandidatesForPrincipalPage: async () => {
          throw new Error("interface store unavailable");
        },
      } as unknown as ControlPlaneOperations["interfaces"],
      listInterfaceMaterializationFailures: async () => {
        throw new Error("intent ledger unavailable");
      },
    },
  });
  const app = await h.app();
  expect(app.state).toBe("installed");
  // An unread screen list must not downgrade Open to "view resources".
  expect(app.primaryAction).toBe("open");
  expect(app.screens).toEqual([]);
  expect(app.incomplete).toEqual(["links", "screen_problems", "screens"]);
});

const LINK_REQUIREMENT: CapsuleRequiredInterface = {
  key: "data",
  interface: { type: "data", version: "1" },
  permissions: ["data.read"],
  delivery: { type: "none" },
};

async function linkedFixture(requirement = LINK_REQUIREMENT, consent = LINK_REQUIREMENT.permissions) {
  const h = await fixture({ requiredInterfaces: [requirement] });
  const provider = await seedCapsuleModel(h.ledger, {
    workspaceId: WORKSPACE,
    capsuleId: "cap_link_provider",
    sourceId: "src_link_provider",
    snapshotId: "snap_link_provider",
    installConfigId: "cfg_link_provider",
    name: "database",
    installConfig: {
      store: {
        order: 1,
        surface: "app",
        kind: "data",
        provider: "test",
        suggestedName: "database",
        badge: { ja: "データ", en: "Data" },
        name: { ja: "データベース", en: "Database" },
        description: { ja: "データ保管", en: "Data storage" },
        iconUrl: "https://assets.example.com/database.svg",
      },
    },
  });
  await h.ledger.putCapsule({ ...provider.capsule, status: "active", currentStateGeneration: 1 });
  const now = new Date().toISOString();
  const iface: Interface = {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "Interface",
    metadata: {
      id: "if_link_data",
      workspaceId: WORKSPACE,
      name: "data",
      ownerRef: { kind: "Capsule", id: provider.capsule.id },
      generation: 1,
      createdAt: now,
      updatedAt: now,
    },
    spec: {
      type: "data",
      version: "1",
      document: { privateConfig: "must-not-be-projected" },
      access: { visibility: "workspace" },
    },
    status: {
      phase: "Resolved",
      observedGeneration: 1,
      resolvedRevision: 1,
      resolvedInputs: { password: "must-not-be-projected" },
    },
  };
  expect(await h.interfaceStores.interfaces.create(iface)).toBe(true);
  const link: InterfaceLink = {
    id: "ifl_app_data",
    generation: 1,
    consumerCapsuleId: CAPSULE,
    requirementKey: LINK_REQUIREMENT.key,
    interface: LINK_REQUIREMENT.interface,
    requestedPermissions: consent,
    approvedPermissions: consent,
    deliveryType: "none",
    providerInterfaceId: iface.metadata.id,
    providerCapsuleId: provider.capsule.id,
    state: "active",
    selection: "explicit",
    approval: { kind: "requester_manages_provider", approvedBy: OWNER, approvedAt: now },
    requestedBy: OWNER,
    createdAt: now,
    updatedAt: now,
  };
  expect(await h.interfaceStores.links.create(link)).toBe(true);
  return { ...h, provider, iface, link };
}

test("app links show exact current providers, permissions and value-free display metadata", async () => {
  const h = await linkedFixture();
  h.core.interfaces!.listInterfaceLinkCandidates = async () => { throw new Error("App view must not enumerate candidates"); };
  const app = await h.app();
  expect(app.links).toEqual({
    uses: [{
      linkId: h.link.id,
      requirementKey: "data",
      consumerCapsuleId: CAPSULE,
      providerCapsuleId: h.provider.capsule.id,
      providerInterfaceId: h.iface.metadata.id,
      interfaceType: "data",
      interfaceVersion: "1",
      permissions: ["data.read"],
      state: "active",
      generation: 1,
      health: "ok",
      otherApp: {
        capsuleId: h.provider.capsule.id,
        name: "database",
        displayName: { ja: "データベース", en: "Database" },
        iconUrl: "https://assets.example.com/database.svg",
      },
      canManage: true,
    }],
    usedBy: [],
  });
  expect(app.uninstall.impact).toEqual({ usedBy: [] });
  expect(app.problems).toEqual([]);
  expect(JSON.stringify(app)).not.toContain("must-not-be-projected");
  expect(JSON.stringify(app)).not.toContain("requestedBy");
  expect(JSON.stringify(app)).not.toContain("approvedBy");
});

test("link health accepts reordered and reduced permission sets and identifies an increase", async () => {
  for (const permissions of [["data.write", "data.read"], ["data.read"]]) {
    const h = await linkedFixture({ ...LINK_REQUIREMENT, permissions }, ["data.read", "data.write"]);
    const app = await h.app();
    expect(app.links.uses[0]).toMatchObject({ health: "ok", permissions });
    expect(app.problems).toEqual([]);
  }
  const increased = await linkedFixture({
    ...LINK_REQUIREMENT, permissions: ["data.read", "data.write"],
  });
  const app = await increased.app();
  expect(app.links.uses[0].health).toBe("reapproval_required");
  expect(app.problems).toMatchObject([{ code: "interface_link_unavailable", severity: "warning" }]);
});

test("a provider uninstall degrades its link without changing consent, and removal requires repair", async () => {
  const h = await linkedFixture();
  const provider = (await h.ledger.getCapsule(h.provider.capsule.id))!;
  await h.ledger.putCapsule({ ...provider, status: "uninstalled" });
  const scheduled = await h.app();
  expect(scheduled.links.uses[0]).toMatchObject({ state: "active", health: "provider_uninstall_scheduled" });
  expect(scheduled.state).toBe("installed");
  expect(scheduled.problems).toMatchObject([{ code: "interface_link_degraded", severity: "warning", requirementKey: "data" }]);
  await h.ledger.putCapsule({ ...provider, status: "destroyed" });
  const removed = await h.app();
  expect(removed.links.uses[0]).toMatchObject({ state: "active", health: "provider_removed" });
  expect(removed.state).toBe("needs_attention");
  expect(removed.primaryAction).toBe("fix_interface_link");
  expect(removed.problems).toMatchObject([{ code: "interface_link_unavailable", severity: "error", requirementKey: "data" }]);
  expect((await h.interfaceStores.links.get(h.link.id))?.state).toBe("active");
});

test("incoming current consumers are included in uninstall impact while revoked history is omitted", async () => {
  const h = await linkedFixture();
  const capsule = (await h.ledger.getCapsule(CAPSULE))!;
  await h.ledger.putCapsule({ ...capsule, id: "cap_link_consumer", name: "consumer", slug: "consumer" });
  const incoming: InterfaceLink = {
    ...h.link,
    id: "ifl_incoming",
    consumerCapsuleId: "cap_link_consumer",
    providerCapsuleId: CAPSULE,
    providerInterfaceId: "if_incoming",
  };
  expect(await h.interfaceStores.interfaces.create({
    ...h.iface,
    metadata: { ...h.iface.metadata, id: incoming.providerInterfaceId, ownerRef: { kind: "Capsule", id: CAPSULE } },
  })).toBe(true);
  expect(await h.interfaceStores.links.create(incoming)).toBe(true);
  const retained = {
    ...incoming,
    id: "ifl_revoked",
    requirementKey: "retired",
  };
  expect(await h.interfaceStores.links.create(retained)).toBe(true);
  expect(await h.interfaceStores.links.compareAndSet({
    ...retained,
    state: "revoked",
    generation: 2,
    revoked: { revokedBy: OWNER, revokedAt: incoming.updatedAt },
  }, 1)).toBe(true);
  const app = await h.app();
  expect(app.links.usedBy).toHaveLength(1);
  expect(app.links.usedBy[0]).toMatchObject({
    linkId: incoming.id,
    consumerCapsuleId: incoming.consumerCapsuleId,
    otherApp: { capsuleId: incoming.consumerCapsuleId, name: "consumer" },
    canManage: true,
    health: "ok",
  });
  expect(app.uninstall.impact.usedBy).toEqual(app.links.usedBy);
});

test("a pending incoming link offers approval to the provider as an info problem that never takes the primary action", async () => {
  const h = await linkedFixture();
  const capsule = (await h.ledger.getCapsule(CAPSULE))!;
  await h.ledger.putCapsule({ ...capsule, id: "cap_link_consumer", name: "consumer", slug: "consumer" });
  const { approval: _approval, ...base } = h.link;
  const incoming: InterfaceLink = {
    ...base,
    id: "ifl_pending_incoming",
    consumerCapsuleId: "cap_link_consumer",
    providerCapsuleId: CAPSULE,
    providerInterfaceId: "if_pending_incoming",
    state: "pending_approval",
    approvedPermissions: [],
  };
  expect(await h.interfaceStores.interfaces.create({
    ...h.iface,
    metadata: { ...h.iface.metadata, id: incoming.providerInterfaceId, ownerRef: { kind: "Capsule", id: CAPSULE } },
  })).toBe(true);
  expect(await h.interfaceStores.links.create(incoming)).toBe(true);
  const before = await linkedFixture();
  const baseline = await before.app();
  const app = await h.app();
  expect(app.links.usedBy).toHaveLength(1);
  expect(app.links.usedBy[0]).toMatchObject({ linkId: incoming.id, state: "pending_approval", canApprove: true, permissions: ["data.read"], otherApp: { capsuleId: "cap_link_consumer" } });
  expect(app.links.uses[0]?.canApprove).toBeUndefined();
  expect(app.problems).toEqual([{ code: "interface_link_approval_pending", severity: "info", requirementKey: incoming.requirementKey, interfaceLinkId: incoming.id, consumerCapsuleId: "cap_link_consumer" }]);
  expect(app.state).toBe(baseline.state);
  expect(app.primaryAction).toBe(baseline.primaryAction);

  // A read-only credential sees the request without the decision.
  h.accounts.savePersonalAccessToken("pat_pending_read", {
    tokenId: "pat_pending_read_id", tokenPrefix: "read", subject: OWNER,
    name: "read only", scopes: ["read"], workspaceId: WORKSPACE, createdAt: Date.now(),
  });
  const readOnly = ((await (await h.request("/app", "", "GET", undefined, "pat_pending_read")).json()) as { app: CapsuleAppView }).app;
  expect(readOnly.links.usedBy[0]).toMatchObject({ state: "pending_approval", canApprove: false });
  expect(readOnly.problems).toEqual([]);

  // A request from a consumer scheduled for uninstall cannot be approved.
  const requester = (await h.ledger.getCapsule("cap_link_consumer"))!;
  await h.ledger.putCapsule({ ...requester, status: "uninstalled" });
  const leaving = await h.app();
  expect(leaving.links.usedBy[0]).toMatchObject({ state: "pending_approval", canApprove: false });
  expect(leaving.problems).toEqual([]);
  await h.ledger.putCapsule(requester);

  // A provider scheduled for uninstall no longer accepts links.
  await h.ledger.putCapsule({ ...capsule, status: "uninstalled" });
  const scheduled = await h.app();
  expect(scheduled.links.usedBy[0]).toMatchObject({ state: "pending_approval", canApprove: false });
  expect(scheduled.problems.some((problem) => problem.code === "interface_link_approval_pending")).toBe(false);
});

test("a provider-approved link is healthy for the consumer; partial approval is refused so no lasting reapproval warning appears", async () => {
  const permissions = ["data.read", "data.write"];
  const h = await linkedFixture({ ...LINK_REQUIREMENT, permissions }, permissions);
  // The consumer unlinked and asked again: a pending link waits for the provider.
  const revoked: InterfaceLink = { ...h.link, state: "revoked", generation: 2, revoked: { revokedBy: OWNER, revokedAt: h.link.updatedAt } };
  expect(await h.interfaceStores.links.compareAndSet(revoked, 1)).toBe(true);
  const { approval: _approval, ...base } = h.link;
  const pending: InterfaceLink = { ...base, id: "ifl_app_data_request", generation: 3, state: "pending_approval", approvedPermissions: [] };
  expect(await h.interfaceStores.links.replace({ record: pending, expected: revoked })).toBe(true);
  const waiting = await h.app();
  expect(waiting.links.uses[0]).toMatchObject({ state: "pending_approval" });
  const service = h.core.interfaces as unknown as InterfaceService;
  const decision = { providerCapsuleId: h.provider.capsule.id, linkId: pending.id, expectedGeneration: pending.generation };
  await expect(service.approveInterfaceLink({ ...decision, approvedPermissions: ["data.read"] }, { actorAccountId: OWNER, roles: [], requestId: "partial" })).rejects.toMatchObject({ code: "invalid_argument" });
  expect(await h.interfaceStores.links.get(pending.id)).toEqual(pending);
  // The record a full approval writes (core tests drive the service write;
  // this fixture's in-memory stores have no management validator for it).
  const approved: InterfaceLink = { ...pending, state: "active", generation: 4, approvedPermissions: [...pending.requestedPermissions], approval: { kind: "provider_approved", approvedBy: OWNER, approvedAt: pending.updatedAt } };
  expect(await h.interfaceStores.links.compareAndSet(approved, pending.generation)).toBe(true);
  const app = await h.app();
  expect(app.links.uses[0]).toMatchObject({ linkId: pending.id, state: "active", health: "ok", permissions });
  expect(app.problems).toEqual([]);
});

test("an unset requirement is visible and a link read failure is explicitly incomplete", async () => {
  const h = await fixture({ requiredInterfaces: [LINK_REQUIREMENT] });
  const unset = await h.app();
  expect(unset.links.uses[0]).toMatchObject({
    requirementKey: "data", state: "unset", generation: 0,
  });
  expect(unset.problems).toMatchObject([{ code: "interface_link_unset", severity: "warning" }]);
  expect(unset.state).toBe("installed");
  h.interfaceStores.links.listByConsumerCapsule = async () => { throw new Error("link store unavailable"); };
  const failed = await h.app();
  expect(failed.links).toEqual({ uses: [], usedBy: [] });
  expect(failed.incomplete).toContain("links");
  expect(failed.problems).toEqual([]);
  expect(failed.state).toBe("installed");
});

test("read-only members see link requirements without management authority", async () => {
  const member = { workspaceId: WORKSPACE, accountId: STRANGER, status: "active", roles: ["viewer"] } as const;
  const h = await fixture({
    requiredInterfaces: [LINK_REQUIREMENT],
    overrides: {
      members: {
        getMember: async () => member,
        listMembers: async () => [member],
      } as unknown as ControlPlaneOperations["members"],
    },
  });
  const app = await h.app(h.stranger);
  expect(app.links.uses[0].canManage).toBe(false);
});

test("read-only delegated credentials cannot manage links even for the Workspace owner", async () => {
  const h = await linkedFixture();
  const token = {
    tokenId: "pat_link_read_id", tokenPrefix: "read", subject: OWNER,
    name: "read only", scopes: ["read"], workspaceId: WORKSPACE, createdAt: Date.now(),
  } as const;
  h.accounts.savePersonalAccessToken("pat_link_read", token);
  const response = await h.request("/app", "", "GET", undefined, "pat_link_read");
  expect(response.status).toBe(200);
  const app = ((await response.json()) as { app: CapsuleAppView }).app;
  expect(app.links.uses[0].canManage).toBe(false);
  expect(app.incomplete).toBeUndefined();
  expect(app.state).toBe("installed");
  h.accounts.savePersonalAccessToken("pat_link_read", { ...token, scopes: ["read", "write"] });
  const writable = await h.request("/app", "", "GET", undefined, "pat_link_read");
  expect(writable.status).toBe(200);
  expect(((await writable.json()) as { app: CapsuleAppView }).app.links.uses[0].canManage).toBe(true);
});

test("an Interface that becomes NotReady is unavailable without exposing its inputs", async () => {
  const h = await linkedFixture();
  expect(await h.interfaceStores.interfaces.compareAndSet({
    ...h.iface,
    status: { ...h.iface.status, phase: "NotReady" },
  }, { generation: 1, resolvedRevision: 1, record: h.iface })).toBe(true);
  const app = await h.app();
  expect(app.links.uses[0].health).toBe("provider_not_ready");
  expect(app.primaryAction).toBe("view_resources");
  expect(app.state).toBe("installed");
  expect(app.problems).toMatchObject([{ code: "interface_link_unavailable", severity: "warning" }]);
  expect(JSON.stringify(app)).not.toContain("must-not-be-projected");
});

test("app links choose the latest lineage generation after a provider replacement", async () => {
  const h = await linkedFixture();
  const next: InterfaceLink = { ...h.link, id: "ifl_app_replacement", generation: 3 };
  expect(await h.interfaceStores.links.replace({
    expected: h.link,
    revoked: {
      ...h.link, state: "revoked", generation: 2,
      revoked: { revokedBy: OWNER, revokedAt: h.link.updatedAt },
    },
    record: next,
  })).toBe(true);
  const app = await h.app();
  expect(app.links.uses).toHaveLength(1);
  expect(app.links.uses[0]).toMatchObject({ linkId: next.id, state: "active", generation: 3, health: "ok" });
});

// --- review fixes: real uninstall records, real admission, real run shapes ----

/** The finalizer's own record transition (same call `block()` makes). */
async function advanceUninstall(
  h: Awaited<ReturnType<typeof fixture>>,
  changes: Parameters<CapsulesService["advanceCapsuleUninstall"]>[2],
) {
  const capsules = (h.core as unknown as { capsules: CapsulesService }).capsules;
  const current = await h.ledger.getCapsule(CAPSULE);
  const record = current!.uninstall!;
  return await capsules.advanceCapsuleUninstall(
    CAPSULE,
    { uninstallId: record.id, revision: record.revision },
    changes,
  );
}

/** An ApplyRun exactly as the run engine records a provider-reached failure. */
function providerFailedApply(
  id: string,
  planRunId: string,
  createdAt: number,
  operation: "update" | "destroy",
): ApplyRun {
  const action = operation === "destroy" ? "destroy" : "apply";
  return applyRun(id, planRunId, createdAt, {
    operation,
    status: "failed",
    diagnostics: [
      {
        severity: "error",
        code: "apply_failed",
        message: "OpenTofu provider execution failed after dispatch",
      },
    ],
    auditEvents: [
      {
        id: `${id}_failed`,
        type: `${action}.failed`,
        at: createdAt,
        data: {
          message: "OpenTofu provider execution failed after dispatch",
          providerDispatched: true,
          ...(operation === "destroy"
            ? { providerDestroySucceeded: false }
            : { providerApplySucceeded: false }),
          statePersistence: "unavailable",
        },
      },
    ],
    finishedAt: createdAt,
  });
}

test("a scheduled uninstall the finalizer blocked before teardown needs the person and can be cancelled", async () => {
  const h = await fixture();
  expect((await h.request("", h.owner, "DELETE")).status).toBe(202);
  await advanceUninstall(h, { preDestroyExportStartedAt: new Date().toISOString() });
  await advanceUninstall(h, {
    blockedReason: SCHEDULED_DESTROY_BLOCKED_REASONS.exportIncomplete,
  });
  const app = await h.app();
  expect(app).toMatchObject({
    status: "uninstalled",
    state: "needs_attention",
    primaryAction: "cancel_uninstall",
    problems: [
      { code: "uninstall_blocked", severity: "error", reason: "pre_destroy_export_incomplete" },
    ],
    uninstall: {
      scheduled: { phase: "scheduled", blocked: true, cancellable: true },
    },
  });
  // The view's "cancellable" is the cancel command's own answer.
  expect((await h.request("/cancel-uninstall", h.owner, "POST")).status).toBe(200);
  expect((await h.app()).state).toBe("installed");
});

test("a teardown blocked after the runtime became unsafe offers uninstall now, and cancel is refused", async () => {
  const h = await fixture();
  const base = Date.now() - 10_000;
  await h.ledger.putPlanRun(planRun("plan_changed", base));
  await h.ledger.putApplyRun(providerFailedApply("apply_unsafe", "plan_changed", base + 1, "update"));
  expect((await h.request("", h.owner, "DELETE")).status).toBe(202);
  await advanceUninstall(h, { phase: "destroying", destroyStartedAt: new Date().toISOString() });
  await advanceUninstall(h, { blockedReason: SCHEDULED_DESTROY_BLOCKED_REASONS.applyRefused });
  const app = await h.app();
  expect(app).toMatchObject({
    state: "needs_attention",
    primaryAction: "uninstall_now",
    problems: [{ code: "uninstall_blocked", reason: "destroy_apply_refused" }],
    uninstall: { scheduled: { phase: "destroying", blocked: true, cancellable: false } },
  });
  const cancel = await h.request("/cancel-uninstall", h.owner, "POST");
  expect(cancel.status).toBe(409);
  expect(JSON.stringify(await cancel.json())).toContain("capsule_uninstall_destroy_started");
});

test("a failed provider teardown follows its retries and stops counting once a normal change happens", async () => {
  const h = await fixture();
  expect((await h.request("", h.owner, "DELETE")).status).toBe(202);
  await advanceUninstall(h, { phase: "destroying", destroyStartedAt: new Date().toISOString() });
  const base = Date.now() - 60_000;
  // The run engine's commit after a provider-reached destroy failure.
  const capsule = await h.ledger.getCapsule(CAPSULE);
  await h.ledger.putCapsule({ ...capsule!, status: "error" });
  await h.ledger.putPlanRun(planRun("destroy_plan_1", base, { operation: "destroy" }));
  await h.ledger.putApplyRun(providerFailedApply("destroy_apply_1", "destroy_plan_1", base + 1, "destroy"));

  let app = await h.app();
  expect(app).toMatchObject({
    status: "error",
    state: "needs_attention",
    primaryAction: "retry",
    problems: [{ code: "uninstall_failed", runId: "destroy_apply_1", runType: "destroy_apply" }],
    uninstall: { mode: "scheduled", scheduled: { phase: "destroying", cancellable: false } },
  });

  // "Uninstall now" created a destroy plan that waits for approval.
  await h.ledger.putPlanRun(
    planRun("destroy_plan_2", base + 2, { operation: "destroy", status: "waiting_approval" }),
  );
  app = await h.app();
  expect(app).toMatchObject({
    state: "uninstalling",
    primaryAction: "review",
    progress: { review: { runId: "destroy_plan_2", runType: "destroy_plan" } },
  });

  // Its approved apply is running.
  await h.ledger.putApplyRun(
    applyRun("destroy_apply_2", "destroy_plan_2", base + 3, { operation: "destroy", status: "running" }),
  );
  expect(await h.app()).toMatchObject({ state: "uninstalling", primaryAction: "none" });

  // A later ordinary plan failure is not an uninstall failure.
  await h.ledger.putPlanRun(planRun("plan_after", base + 4, { status: "failed" }));
  app = await h.app();
  expect(app.problems.map((problem) => problem.code)).toEqual(["run_failed"]);
  expect(app.uninstall.scheduled).toBeUndefined();
});

test("a Capsule restored to active after a failed teardown is not stuck uninstalling", async () => {
  const h = await fixture();
  expect((await h.request("", h.owner, "DELETE")).status).toBe(202);
  await advanceUninstall(h, { phase: "destroying", destroyStartedAt: new Date().toISOString() });
  const base = Date.now() - 60_000;
  const capsule = await h.ledger.getCapsule(CAPSULE);
  await h.ledger.putCapsule({ ...capsule!, status: "error" });
  await h.ledger.putPlanRun(planRun("destroy_plan_1", base, { operation: "destroy" }));
  await h.ledger.putApplyRun(providerFailedApply("destroy_apply_1", "destroy_plan_1", base + 1, "destroy"));
  // The public PATCH accepts `active` from `error`; the record stays as evidence.
  const patched = await h.request("", h.owner, "PATCH", { status: "active" });
  expect(patched.status).toBe(200);
  expect((await h.ledger.getCapsule(CAPSULE))?.uninstall?.phase).toBe("destroying");
  let app = await h.app();
  // Not "uninstalling": the newest Run is the failed removal, reported as such.
  expect(app).toMatchObject({
    status: "active",
    state: "needs_attention",
    primaryAction: "retry",
    problems: [{ code: "run_failed", runId: "destroy_apply_1", runType: "destroy_apply" }],
  });
  expect(app.uninstall.scheduled).toBeUndefined();
  // A later successful change returns the app to installed.
  await h.ledger.putPlanRun(planRun("plan_fix", base + 2));
  await h.ledger.putApplyRun(applyRun("apply_fix", "plan_fix", base + 3));
  app = await h.app();
  expect(app).toMatchObject({ state: "installed", primaryAction: "view_resources" });
});

/** An install coordinator row bound to the fixture Capsule. */
async function putInstallAttempt(
  h: Awaited<ReturnType<typeof fixture>>,
  over: {
    readonly phase?: "awaiting_input" | "planning";
    readonly planRunId?: string;
    readonly updatedAt?: string;
    readonly actorSubject?: string;
  } = {},
): Promise<void> {
  const at = over.updatedAt ?? new Date().toISOString();
  const authority = {
    workspaceId: WORKSPACE,
    managementState: "active" as const,
    managementEpoch: 1,
  };
  const phase = over.phase ?? "awaiting_input";
  const created = await h.core.gitInstallPlans.create(
    {
      id: "ip_app_route",
      workspaceId: WORKSPACE,
      workspaceManagementAuthority: authority,
      createdBy: over.actorSubject ?? OWNER,
      actorSubject: over.actorSubject ?? OWNER,
      idempotencyKeyHash: "key_app_route",
      requestDigest: "digest_app_route",
      source: { name: "app", url: "https://git.example.com/example/app.git", ref: "main", path: "." },
      capsule: { name: "app", environment: "production" },
      options: {},
      operation: "install",
      mode: "attempt",
      phase,
      ...(phase === "awaiting_input" ? { awaitingInput: "inputs" as const } : {}),
      generation: 0,
      sourceId: "src_app_route",
      installConfigId: "cfg_app_route",
      capsuleId: CAPSULE,
      creationAttempted: true,
      ...(over.planRunId ? { planRunId: over.planRunId } : {}),
      expiresAt: at,
      createdAt: at,
      updatedAt: at,
    },
    authority,
  );
  expect(created.status).toBe("created");
}

/** Makes the fixture Capsule a first install that never applied. */
async function makeUnapplied(h: Awaited<ReturnType<typeof fixture>>, updatedAgoMs: number): Promise<void> {
  const seeded = await h.ledger.getCapsule(CAPSULE);
  const { currentStateVersionId: _currentStateVersionId, ...unapplied } = seeded!;
  await h.ledger.putCapsule({
    ...unapplied,
    status: "pending",
    currentStateGeneration: 0,
    updatedAt: new Date(Date.now() - updatedAgoMs).toISOString(),
  });
}

test("a first install whose attempt is still preparing is installing, and a stalled attempt is continued through it", async () => {
  const h = await fixture();
  await makeUnapplied(h, 2 * 60 * 60 * 1000);
  // With no coordinator working on it, the person is asked to continue.
  expect(await h.app()).toMatchObject({
    applied: false,
    state: "needs_attention",
    primaryAction: "continue_install",
    problems: [{ code: "install_incomplete" }],
    progress: { revisionPreparing: false },
  });
  expect((await h.app()).progress.installPlanId).toBeUndefined();
  // The install attempt that created this Capsule is waiting for input: it
  // owns the next plan, so the app must not offer one of its own.
  await putInstallAttempt(h);
  const app = await h.app();
  expect(app).toMatchObject({
    applied: false,
    state: "installing",
    primaryAction: "none",
    // Only the person who started the attempt can answer it.
    progress: { revisionPreparing: true, installPlanId: "ip_app_route", installPlanAwaitingInput: "viewer" },
  });
  expect(app.problems.map((problem) => problem.code)).not.toContain("install_incomplete");
});

test("an attempt someone else started waits for them, and never stalls into a continue that cannot advance", async () => {
  const h = await fixture();
  await makeUnapplied(h, 3 * 60 * 60 * 1000);
  await putInstallAttempt(h, {
    actorSubject: "user_teammate",
    updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  });
  expect(await h.app()).toMatchObject({
    state: "installing",
    primaryAction: "none",
    progress: { revisionPreparing: true, installPlanId: "ip_app_route", installPlanAwaitingInput: "other" },
  });
});

test("an install attempt that stopped moving offers continue_install through that attempt", async () => {
  const h = await fixture();
  await makeUnapplied(h, 3 * 60 * 60 * 1000);
  await putInstallAttempt(h, { phase: "planning", updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() });
  expect(await h.app()).toMatchObject({
    state: "needs_attention",
    primaryAction: "continue_install",
    problems: [{ code: "install_incomplete" }],
    progress: { revisionPreparing: false, installPlanId: "ip_app_route" },
  });
});

test("an install attempt left in planning after its Plan Run exists does not hold the app", async () => {
  const h = await fixture();
  await makeUnapplied(h, 2 * 60 * 60 * 1000);
  // The client stopped reconciling once the Plan Run existed (deadline,
  // closed tab): the row stays `planning` with its Plan Run id.
  await putInstallAttempt(h, { phase: "planning", planRunId: "plan_first" });
  await h.ledger.putPlanRun(planRun("plan_first", Date.now() - 60_000, { status: "succeeded" }));
  // The Run's real state: a first install waiting for review.
  expect(await h.app()).toMatchObject({
    state: "installing",
    primaryAction: "review",
    progress: { revisionPreparing: false, review: { runId: "plan_first", runType: "plan" } },
  });
  // A failed plan with the stale row needs attention.
  await h.ledger.putPlanRun(planRun("plan_first", Date.now() - 60_000, {
    status: "failed",
    diagnostics: [{ severity: "error", code: "plan_failed", message: "boom" }],
  }));
  expect(await h.app()).toMatchObject({
    state: "needs_attention",
    primaryAction: "retry",
    problems: [{ code: "run_failed", runId: "plan_first" }],
    progress: { revisionPreparing: false },
  });
});

/** A revision coordinator row for the applied fixture Capsule. */
async function putRevisionRow(
  h: Awaited<ReturnType<typeof fixture>>,
  updatedAt: string,
  baseGeneration = 1,
  baseInstallConfigId = "cfg_app_route",
): Promise<void> {
  const authority = { workspaceId: WORKSPACE, managementState: "active" as const, managementEpoch: 1 };
  const created = await h.core.gitInstallPlans.create(
    {
      id: "rp_app_route",
      workspaceId: WORKSPACE,
      workspaceManagementAuthority: authority,
      createdBy: OWNER,
      actorSubject: OWNER,
      idempotencyKeyHash: "key_revision_route",
      requestDigest: "digest_revision_route",
      operation: "revision",
      source: { name: "app", url: "https://git.example.com/example/app.git", ref: "v2", path: "." },
      capsule: { name: "app", environment: "production" },
      options: {},
      revision: {
        targetRef: "v2",
        base: {
          capsuleStateGeneration: baseGeneration,
          installConfigId: baseInstallConfigId,
          installConfigDigest: "sha256:config",
          sourceDefaultRef: "main",
          sourceDefaultPath: ".",
        },
      },
      sourceId: "src_app_route",
      capsuleId: CAPSULE,
      installConfigId: "cfg_app_route",
      installConfigBaseId: "cfg_app_route",
      installConfigBaseDigest: "sha256:config",
      installModulePath: ".",
      phase: "syncing_source",
      generation: 0,
      createdAt: updatedAt,
      updatedAt,
    },
    authority,
  );
  expect(created.status).toBe("created");
}

test("a version change being prepared holds the app; one that stopped moving is offered to continue", async () => {
  const fresh = await fixture();
  await putRevisionRow(fresh, new Date().toISOString());
  expect(await fresh.app()).toMatchObject({ state: "updating", primaryAction: "none", progress: { revisionPreparing: true } });
  expect((await fresh.app()).progress.revisionPlanId).toBeUndefined();
  // The client's deadline passed during the Source sync: the row stays
  // without a Plan Run. The app reads as installed and names the row.
  const stalled = await fixture();
  await putRevisionRow(stalled, new Date(Date.now() - 20 * 60 * 1000).toISOString());
  expect(await stalled.app()).toMatchObject({
    state: "installed",
    progress: { revisionPreparing: false, revisionPlanId: "rp_app_route" },
  });
});

test("a version change pinned to an older state is neither preparing nor offered to continue", async () => {
  // Another change was applied after these rows started (the fixture Capsule
  // is at generation 1 on cfg_app_route), or a settings change rebound the
  // Capsule to another InstallConfig without a new generation: their
  // reconcile can only fail on the moved base.
  for (const [baseGeneration, baseInstallConfigId] of [[0, "cfg_app_route"], [1, "cfg_before_settings"]] as const) {
    for (const updatedAt of [new Date().toISOString(), new Date(Date.now() - 20 * 60 * 1000).toISOString()]) {
      const h = await fixture();
      await putRevisionRow(h, updatedAt, baseGeneration, baseInstallConfigId);
      const app = await h.app();
      expect(app).toMatchObject({ state: "installed", progress: { revisionPreparing: false } });
      expect(app.progress.revisionPlanId).toBeUndefined();
    }
  }
});

test("an applied app is never held by an install row", async () => {
  const h = await fixture();
  // The fixture Capsule is applied; an install attempt that never got past
  // `awaiting_input` (or a stale row) is not this app's work any more.
  await putInstallAttempt(h);
  const app = await h.app();
  expect(app).toMatchObject({ applied: true, state: "installed", progress: { revisionPreparing: false } });
  expect(app.progress.installPlanId).toBeUndefined();
});

test("a disabled app is not offered a scheduled uninstall the command would refuse", async () => {
  const h = await fixture();
  const capsule = await h.ledger.getCapsule(CAPSULE);
  await h.ledger.putCapsule({ ...capsule!, status: "disabled" });
  const app = await h.app();
  expect(app).toMatchObject({ state: "stopped", uninstall: { mode: "none" } });
  expect(app.uninstall.graceDays).toBeUndefined();
  expect((await h.request("", h.owner, "DELETE")).status).toBe(409);
});

test("a full Workspace failure window without this app's entry is reported as incomplete", async () => {
  const failure = (index: number): CapsuleInterfaceMaterializationFailure => ({
    id: `intent_other_${index}`,
    capsuleId: `cap_other_${index}`,
    stateVersionId: `sv_other_${index}`,
    outputId: `out_other_${index}`,
    stateGeneration: 1,
    blueprintsDigest: `sha256:${"b".repeat(64)}`,
    totalItems: 1,
    nextItemIndex: 0,
    attempts: 5,
    error: {
      code: "interface_materialization_failed",
      detailDigest: `sha256:${"c".repeat(64)}`,
      recordedAt: "2026-10-27T00:00:00.000Z",
    },
    deadLetteredAt: "2026-10-27T00:00:00.000Z",
    failureDigest: `sha256:${"d".repeat(64)}`,
  });
  const full = await fixture({
    overrides: {
      listInterfaceMaterializationFailures: async (_workspaceId, options) =>
        Array.from({ length: options?.limit ?? 100 }, (_, index) => failure(index)),
    },
  });
  expect((await full.app()).incomplete).toEqual(["screen_problems"]);
  const partial = await fixture({
    overrides: {
      listInterfaceMaterializationFailures: async () => [failure(1), failure(2)],
    },
  });
  expect((await partial.app()).incomplete).toBeUndefined();
});

test("a destroyed app renders after its Source has retired", async () => {
  const h = await fixture({ currentStateVersionId: "historical_state" });
  const capsule = (await h.ledger.getCapsule(CAPSULE))!;
  await h.ledger.putCapsule({ ...capsule, status: "destroyed" });
  await h.ledger.deleteSource(capsule.sourceId);
  expect((await h.request("")).status).toBe(200);
  const app = await h.app();
  expect(app.status).toBe("destroyed");
  expect(app.version.current).toBeUndefined();
  expect(app.version.updateAvailable).toBe(false);
});
