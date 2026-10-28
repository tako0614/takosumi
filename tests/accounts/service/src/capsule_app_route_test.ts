import { expect, test } from "bun:test";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { CapsuleAppView } from "takosumi-contract/capsules";
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
import { createInMemoryInterfaceStores } from "../../../../core/domains/interfaces/mod.ts";
import {
  FIXTURE_CLOUDFLARE_PROVIDER,
  seedCapsuleModel,
} from "../../../helpers/deploy-control/model_fixture.ts";

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
  ) {
    const url = new URL(`${ORIGIN}/api/v1/capsules/${CAPSULE}${path}`);
    const response = await handleControlRoute({
      request: new Request(url, {
        method,
        headers: {
          cookie,
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
  return { ledger, core, seeded, request, app, owner, stranger };
}

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
  expect(app.incomplete).toEqual(["screen_problems", "screens"]);
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
          installConfigId: "cfg_app_route",
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
  // is at generation 1): their reconcile can only fail on the moved base.
  for (const updatedAt of [new Date().toISOString(), new Date(Date.now() - 20 * 60 * 1000).toISOString()]) {
    const h = await fixture();
    await putRevisionRow(h, updatedAt, 0);
    const app = await h.app();
    expect(app).toMatchObject({ state: "installed", progress: { revisionPreparing: false } });
    expect(app.progress.revisionPlanId).toBeUndefined();
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
