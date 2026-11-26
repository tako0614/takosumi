import { expect, test } from "bun:test";

import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../accounts/service/src/account-session.ts";
import { handleControlRoute } from "../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";
import { validateUninstallRequester } from "../../../accounts/service/src/uninstall-requester.ts";
import { main } from "../../../cli/src/main.ts";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { InMemoryGitInstallPlanStore } from "../../../core/domains/install-plans/store.ts";
import type { OpenTofuPlanJob, OpenTofuRunner } from "../../../core/domains/deploy-control/mod.ts";
import {
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  fixtureExecutionEvidence,
} from "../../helpers/deploy-control/model_fixture.ts";

const ORIGIN = "https://app.takosumi.test";
const OWNER = "tsub_cli_revision_owner";
const SESSION = "sess_cli_revision_owner";
const TOKEN = "synthetic-cli-revision-pat";
const INSTALL_COMMIT = "a17e4f883cb90a1b2c3d4e5f60718293a4b5c6d7";
const UPDATE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PLAN_DIGEST = `sha256:${"1".repeat(64)}`;
const LOCK_DIGEST = `sha256:${"2".repeat(64)}`;
const STATE_DIGEST = `sha256:${"3".repeat(64)}`;

// Identity, policy and Git/OpenTofu transport below are synthetic. The HTTP
// handler, Accounts authorization, Core ledger and revision coordinator are real.
async function fixture(options: {
  readonly beforePlan?: (job: OpenTofuPlanJob) => Promise<void>;
  readonly patExpiresAt?: number;
} = {}) {
  const runnerCalls = { sync: 0, plan: 0, apply: 0, destroy: 0 };
  const runner: OpenTofuRunner = {
    sourceSync: async (job) => {
      runnerCalls.sync += 1;
      const resolvedCommit = job.source.ref === "release/v2" ? UPDATE_COMMIT
        : job.source.ref === INSTALL_COMMIT ? INSTALL_COMMIT : undefined;
      if (!resolvedCommit) throw new Error("unexpected synthetic Git ref");
      return {
        resolvedCommit,
        archiveDigest: `sha256:${resolvedCommit.slice(0, 16).padEnd(64, "0")}`,
        archiveSizeBytes: 64,
        repositoryInstallMetadata: { status: "absent" },
        repositoryManifest: { status: "absent" },
        repositoryModules: {
          status: "ready",
          scopePath: ".",
          modules: [{ path: ".", providerPackages: [], rootProviderRequirements: [] }],
        },
      };
    },
    cleanupUnusedSourceArchive: async () => {},
    readCapsuleSourceFiles: async () => [{
      path: "main.tf", text: "output \"ready\" { value = \"yes\" }\n",
    }],
    plan: async (job) => {
      runnerCalls.plan += 1;
      await options.beforePlan?.(job);
      return {
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local", ref: "runner-local://plan/tfplan",
          digest: PLAN_DIGEST, contentType: "application/vnd.opentofu.plan",
        },
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [], providerInstallation: [], planResourceChanges: [],
        summary: { add: 0, change: 0, destroy: 0 },
      };
    },
    apply: async (job) => {
      runnerCalls.apply += 1;
      return {
        outputs: {} as never,
        stateDigest: STATE_DIGEST,
        rawOutputRef: job.rawOutputRef,
        providerInstallation: [],
        executionEvidence: fixtureExecutionEvidence(job, "apply"),
      };
    },
    destroy: async (job) => {
      runnerCalls.destroy += 1;
      return {
        stateDigest: STATE_DIGEST,
        providerInstallation: [],
        executionEvidence: fixtureExecutionEvidence(job, "destroy"),
      };
    },
  };
  const ledger = new InMemoryOpenTofuControlStore();
  const gitInstallPlanStore = new InMemoryGitInstallPlanStore(ledger);
  ledger.attachGitInstallPlanStore(gitInstallPlanStore);
  const accounts = new InMemoryAccountsStore();
  const { operations } = await createTakosumiService({
    authorizeInterfaceBearer: () => undefined,
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: ledger,
    gitInstallPlanStore,
    opentofuRunner: runner,
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    validateUninstallRequesterAt: (requester, workspaceId, validAtMs) =>
      validateUninstallRequester(accounts, requester, workspaceId, validAtMs),
  });
  const workspace = await operations.workspaces.createWorkspace({
    handle: "cli-revision", displayName: "CLI revision", type: "personal", ownerUserId: OWNER,
  });
  const now = Date.now();
  accounts.saveAccount({ subject: OWNER, createdAt: now, updatedAt: now });
  accounts.saveAccountSession({
    sessionId: SESSION, subject: OWNER, createdAt: now, expiresAt: now + 600_000,
  });
  const dispatch = async (request: Request) => {
    if (new URL(request.url).origin !== ORIGIN) throw new Error("unexpected external request");
    const response = await handleControlRoute({
      request, url: new URL(request.url), store: accounts, operations,
    });
    if (!response) throw new Error(`unhandled public route: ${new URL(request.url).pathname}`);
    return response;
  };
  const sessionRoute = async (method: string, path: string, body?: unknown, key?: string) =>
    dispatch(new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${SESSION}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(key === undefined ? {} : { "idempotency-key": key }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

  // First install is fixture setup, through the same public coordinator. It
  // gives the revision an applied base and an app-owned Source.
  const created = await sessionRoute(
    "POST", `/api/v1/workspaces/${workspace.id}/install-plans`,
    {
      source: { name: "cli-revision", url: "https://github.com/example/cli-revision.git", ref: INSTALL_COMMIT, path: "." },
      capsule: { name: "cli-revision", environment: "production" },
      options: { modulePath: ".", providerBindings: [] },
    },
    "synthetic-initial-install",
  );
  expect(created.status).toBe(201);
  const installPlanId = (await created.json()).installPlan.id as string;
  let installPlan: { phase?: string; planRunId?: string; capsuleId?: string } = {};
  for (let step = 0; step < 10 && !installPlan.planRunId; step += 1) {
    const response = await sessionRoute("POST", `/api/v1/install-plans/${installPlanId}/reconcile`);
    expect(response.status).toBe(200);
    installPlan = (await response.json()).installPlan;
  }
  expect(installPlan.planRunId).toMatch(/^plan_/u);
  expect(installPlan.capsuleId).toBeString();
  const applied = await sessionRoute("POST", `/api/v1/runs/${installPlan.planRunId}/apply`);
  expect(applied.status).toBe(201);
  expect((await applied.json()).run.status).toBe("succeeded");
  const appId = installPlan.capsuleId!;
  expect(await ledger.getCapsule(appId)).toMatchObject({ status: "active", currentStateGeneration: 1 });

  const pat = {
    tokenId: "pat_cli_revision", tokenPrefix: "synthetic", subject: OWNER,
    name: "CLI revision", scopes: ["read", "write"] as const,
    appIds: [appId], createdAt: now, expiresAt: options.patExpiresAt ?? now + 600_000,
  };
  accounts.savePersonalAccessToken(TOKEN, pat);
  return { accounts, pat, appId, ledger, operations, dispatch, runnerCalls };
}

test("CLI reads the existing uninstall reservation after a lost reply without another write", async () => {
  const { appId, ledger, dispatch, runnerCalls } = await fixture({
    patExpiresAt: Date.now() + 30 * 86_400_000,
  });
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) };
  const args = ["apps", "uninstall", appId, "--url", ORIGIN, "--token", TOKEN, "--json"];
  const initialRunnerCalls = { ...runnerCalls };
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    const response = await dispatch(request);
    if (request.method === "POST") {
      expect(response.status).toBe(202);
      throw new Error("fixture: reply lost after scheduling");
    }
    return response;
  }) as typeof fetch;
  try {
    expect(await main([...args, "--status"], io)).toBe(0);
    expect(JSON.parse(stdout.pop()!)).toEqual({ capsuleId: appId, status: "active", uninstall: null });
    expect(await main([...args, "--yes"], io)).toBe(1);
    const scheduled = await ledger.getCapsule(appId);
    expect(scheduled).toMatchObject({ status: "uninstalled", uninstall: { phase: "scheduled" } });
    expect(stderr.join("\n")).toContain("--status");
    expect(stdout).toEqual([]);
    expect(await main([...args, "--status", "--yes"], io)).toBe(2);
    expect(await main([...args, "--status=false", "--yes"], io)).toBe(2);
    expect(await main([...args, "--status"], io)).toBe(0);
    expect(JSON.parse(stdout[0]!)).toEqual({
      capsuleId: appId, status: "uninstalled", uninstall: {
        id: scheduled!.uninstall!.id, phase: "scheduled",
        requestedAt: scheduled!.uninstall!.requestedAt,
        scheduledDestroyAt: scheduled!.uninstall!.scheduledDestroyAt,
      },
    });
    expect(requests).toEqual([
      `GET /api/v1/capsules/${appId}`,
      `POST /api/v1/capsules/${appId}/uninstall`,
      `GET /api/v1/capsules/${appId}`,
    ]);
    expect(await ledger.getCapsule(appId)).toEqual(scheduled);
    expect(runnerCalls).toEqual(initialRunnerCalls);
  } finally { globalThis.fetch = originalFetch; }
});

test("Accounts refuses a CLI original Connection selection without partial Destroy evidence", async () => {
  const h = await fixture();
  const before = { ...h.runnerCalls };
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  const output: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return h.dispatch(request);
  }) as typeof fetch;
  try {
    const pairs = [{ connectionId: "conn_original", replacementConnectionId: "conn_original" }];
    expect(await main(["apps", "recover-uninstall", h.appId, "--connections", JSON.stringify(pairs),
      "--token", TOKEN, "--url", ORIGIN, "--json"], { stdout: line => output.push(line), stderr() {} })).toBe(1);
    expect(requests.map(request => [request.method, new URL(request.url).pathname]))
      .toEqual([["POST", `/api/v1/capsules/${h.appId}/destroy-plan`]]);
    expect(JSON.parse(output[0]!)).toEqual({ status: "refused", appId: h.appId, code: "invalid_argument" });
    expect(h.runnerCalls).toEqual(before);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CLI prepares and applies one manual uninstall with the existing Accounts PAT fences", async () => {
  const h = await fixture();
  const path = `/api/v1/capsules/${h.appId}/destroy-plan`;
  for (const [token, changes] of [
    ["synthetic-destroy-wrong-app", { appIds: ["cap_other"] }],
    ["synthetic-destroy-read-only", { scopes: ["read"] }],
  ] as const) {
    h.accounts.savePersonalAccessToken(token, {
      ...h.pat, tokenId: `pat_${token}`, ...changes,
    });
    const before = { ...h.runnerCalls };
    const denied = await h.dispatch(new Request(`${ORIGIN}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    }));
    expect(denied.status).toBe(403);
    expect(h.runnerCalls).toEqual(before);
  }
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return h.dispatch(request);
  }) as typeof fetch;
  const output: string[] = [];
  const errors: string[] = [];
  const io = { stdout: (line: string) => output.push(line), stderr: (line: string) => errors.push(line) };
  try {
    const beforePrepare = { ...h.runnerCalls };
    expect(await main(["apps", "recover-uninstall", h.appId, "--prepare",
      "--token", TOKEN, "--url", ORIGIN, "--json"], io)).toBe(0);
    const prepared = JSON.parse(output[0]!);
    expect(prepared).toMatchObject({
      status: "review_required", appId: h.appId,
      plan: { status: "waiting_approval", baseStateGeneration: 1 },
    });
    expect(prepared.planRunId).toMatch(/^plan_/u);
    expect(prepared.plan.providerConnections).toBeUndefined();
    expect(requests.map(request => [request.method, new URL(request.url).pathname]))
      .toEqual([["POST", path]]);
    expect(await requests[0]!.json()).toEqual({});
    expect(h.runnerCalls).toEqual({ ...beforePrepare, plan: beforePrepare.plan + 1 });
    expect(await h.ledger.getCapsule(h.appId)).toMatchObject({ status: "active", currentStateGeneration: 1 });
    const saved = await h.operations.getRun(prepared.planRunId);
    if (!saved) throw new Error("missing saved Destroy Plan");
    expect(saved).toMatchObject({ type: "destroy_plan", status: "waiting_approval", capsuleId: h.appId });
    expect(saved.workspaceId).toBeString();
    const beforeDestroy = { ...h.runnerCalls };
    requests.length = 0;
    output.length = 0;

    const reviewArgs = ["apps", "recover-uninstall", h.appId, "--destroy-plan", saved.id,
      "--token", "synthetic-destroy-read-only", "--url", ORIGIN, "--json"];
    expect(await main(reviewArgs, io)).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({
      status: "review_required", planRunId: saved.id, plan: { id: saved.id, status: "waiting_approval" },
    });
    expect(await main(reviewArgs.map(value =>
      value === "synthetic-destroy-read-only" ? "synthetic-destroy-wrong-app" : value), io)).toBe(1);
    expect(JSON.parse(output[1]!)).toMatchObject({ status: "refused", planRunId: saved.id });
    expect(requests.map(request => [request.method, new URL(request.url).pathname]))
      .toEqual([["GET", `/api/v1/runs/${saved.id}`], ["GET", `/api/v1/runs/${saved.id}`]]);
    expect(h.runnerCalls).toEqual(beforeDestroy);
    expect((await h.operations.getRun(saved.id))?.status).toBe("waiting_approval");

    const savedReview = JSON.parse(output[0]!);
    const currentReviewArgs = ["apps", "recover-uninstall", h.appId, "--current-review",
      "--token", "synthetic-destroy-read-only", "--url", ORIGIN, "--json"];
    requests.length = 0;
    output.length = 0;
    errors.length = 0;
    expect(await main(currentReviewArgs, io)).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({
      status: "review_required", appId: h.appId, planRunId: saved.id,
    });
    expect(JSON.parse(output[0]!).plan).toEqual(savedReview.plan);
    expect(requests.map(request => [request.method, new URL(request.url).pathname]))
      .toEqual([
        ["GET", `/api/v1/capsules/${h.appId}/app`],
        ["GET", `/api/v1/runs/${saved.id}`],
        ["GET", `/api/v1/capsules/${h.appId}/app`],
      ]);
    expect(requests.every(request => new URL(request.url).origin === ORIGIN)).toBe(true);
    expect(requests.some(request => request.method === "POST")).toBe(false);
    expect(h.runnerCalls).toEqual(beforeDestroy);
    expect((await h.operations.getRun(saved.id))?.status).toBe("waiting_approval");

    requests.length = 0;
    output.length = 0;
    const beforeCurrentReviewRefusal = { ...h.runnerCalls };
    expect(await main(currentReviewArgs.map(value =>
      value === "synthetic-destroy-read-only" ? "synthetic-destroy-wrong-app" : value), io)).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ status: "refused", appId: h.appId });
    expect(requests.map(request => [request.method, new URL(request.url).pathname]))
      .toEqual([["GET", `/api/v1/capsules/${h.appId}/app`]]);
    expect(h.runnerCalls).toEqual(beforeCurrentReviewRefusal);
    expect((await h.operations.getRun(saved.id))?.status).toBe("waiting_approval");

    const args = ["apps", "apply", h.appId, "--destroy-plan", saved.id,
      "--yes", "--token", TOKEN, "--url", ORIGIN, "--json"];
    for (const deniedToken of ["synthetic-destroy-wrong-app", "synthetic-destroy-read-only"]) {
      output.length = 0;
      errors.length = 0;
      expect(await main(args.map(value => value === TOKEN ? deniedToken : value), io)).toBe(1);
      expect(h.runnerCalls.destroy).toBe(beforeDestroy.destroy);
      expect((await h.operations.getRun(saved.id))?.status).toBe("waiting_approval");
    }
    const beforeValidRequests = requests.length;
    output.length = 0;
    errors.length = 0;
    expect(await main(args, io)).toBe(0);
    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0]!)).toMatchObject({
      status: "applying_reviewed_plan", appId: h.appId,
      reviewUrl: `${ORIGIN}/runs/${saved.id}`,
    });
    const result = JSON.parse(output[0]!);
    expect(result).toMatchObject({ status: "succeeded", appId: h.appId,
      planRunId: saved.id, runId: expect.any(String), runStatus: "succeeded" });
    expect(h.runnerCalls.destroy - beforeDestroy.destroy).toBe(1);
    expect(h.runnerCalls.apply - beforeDestroy.apply).toBe(0);
    expect(await h.ledger.getCapsule(h.appId)).toMatchObject({ status: "destroyed" });
    expect(requests.slice(beforeValidRequests).filter(r => r.method === "POST").map(r => new URL(r.url).pathname)).toEqual([
      `/api/v1/runs/${saved.id}/approve`, `/api/v1/runs/${saved.id}/apply`,
    ]);
    const history = requests.slice(beforeValidRequests)
      .filter(r => new URL(r.url).pathname === `/api/v1/capsules/${h.appId}/runs`);
    expect(history.length).toBeGreaterThan(0);
    expect(history.every(r => new URL(r.url).searchParams.getAll("type").join(",") === "destroy_apply")).toBe(true);
    expect(history.every(r => new URL(r.url).searchParams.get("planRunId") === saved.id)).toBe(true);

    const afterApply = { ...h.runnerCalls };
    const beforeClosedReview = requests.length;
    output.length = 0;
    errors.length = 0;
    expect(await main(currentReviewArgs, io)).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ status: "refused", appId: h.appId });
    expect(requests.slice(beforeClosedReview).map(request => [request.method, new URL(request.url).pathname]))
      .toEqual([["GET", `/api/v1/capsules/${h.appId}/app`]]);
    expect(requests.slice(beforeClosedReview).some(request =>
      new URL(request.url).pathname === `/api/v1/runs/${saved.id}`)).toBe(false);
    expect(h.runnerCalls).toEqual(afterApply);

    const beforeObserve = requests.length;
    output.length = 0;
    errors.length = 0;
    expect(await main(["apps", "apply", h.appId, "--destroy-plan", saved.id,
      "--observe-only", "--token", TOKEN, "--url", ORIGIN, "--json"], io)).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ status: "succeeded", runId: result.runId });
    expect(requests.slice(beforeObserve).every(r => r.method === "GET")).toBe(true);
    expect(h.runnerCalls.destroy - beforeDestroy.destroy).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.each([
  ["waiting for review", "waiting_approval", false],
  ["failed", "failed", false],
  ["failed during a reservation", "failed", true],
] as const)("current uninstall review finds the same Accounts Destroy Plan after a lost acknowledgement (%s)", async (_case, finalStatus, scheduled) => {
  const entered = Promise.withResolvers<OpenTofuPlanJob>();
  const release = Promise.withResolvers<void>();
  const h = await fixture({
    async beforePlan(job) {
      if (job.planRun.operation !== "destroy") return;
      entered.resolve(job);
      await release.promise;
      if (finalStatus === "failed") throw new Error("synthetic Destroy Plan failure");
    },
  });
  const appPath = `/api/v1/capsules/${h.appId}`;
  const beforeSchedule = { ...h.runnerCalls };
  if (scheduled) {
    const response = await h.dispatch(new Request(`${ORIGIN}${appPath}/uninstall`, {
      method: "POST", headers: { cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${SESSION}` },
    }));
    expect({ status: response.status, body: await response.json() }).toMatchObject({
      status: 202, body: { capsule: { uninstall: { phase: "scheduled" } } },
    });
    expect(h.runnerCalls).toEqual(beforeSchedule);
  }
  const readToken = "synthetic-pending-destroy-read-only";
  h.accounts.savePersonalAccessToken(readToken, {
    ...h.pat, tokenId: "pat_pending_destroy_read_only", scopes: ["read"],
  });
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return h.dispatch(request);
  }) as typeof fetch;
  const output: string[] = [];
  const errors: string[] = [];
  const io = { stdout: (line: string) => output.push(line), stderr: (line: string) => errors.push(line) };
  const currentReviewArgs = ["apps", "recover-uninstall", h.appId, "--current-review",
    "--token", readToken, "--url", ORIGIN, "--json"];
  const beforeCreate = { ...h.runnerCalls };
  let originalCreate: Promise<Response> | undefined;
  try {
    originalCreate = h.dispatch(new Request(`${ORIGIN}/api/v1/capsules/${h.appId}/destroy-plan`, {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{}",
    }));
    // Retain the actual Accounts/Core operation. Only its caller-facing reply
    // is lost after the persisted Run reaches the synthetic Runner boundary.
    const lostAcknowledgement = await Promise.race([
      originalCreate,
      entered.promise.then(() => Response.json({ error: "fixture_ack_unavailable" }, { status: 503 })),
    ]);
    expect(lostAcknowledgement.status).toBe(503);
    const job = await entered.promise;
    const pending = await h.ledger.getPlanRun(job.planRun.id);
    expect(pending).toMatchObject({
      id: job.planRun.id, capsuleId: h.appId, operation: "destroy", status: "running", createdBy: OWNER,
    });
    const beforeRead = { ...h.runnerCalls };
    expect(beforeRead.plan - beforeCreate.plan).toBe(1);
    expect(await main(currentReviewArgs, io)).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({
      status: "plan_pending", appId: h.appId, planRunId: job.planRun.id,
      planStatus: "running", reviewUrl: `${ORIGIN}/runs/${job.planRun.id}`,
    });
    const expectedReads = [
      `${appPath}/app`,
      ...(scheduled ? [appPath] : []),
      `/api/v1/runs/${job.planRun.id}`,
      `${appPath}/app`,
    ].map(path => ["GET", path]);
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual(expectedReads);
    expect(h.runnerCalls).toEqual(beforeRead);
    expect(await h.ledger.getPlanRun(job.planRun.id)).toEqual(pending);
    expect(errors).toEqual([]);

    release.resolve();
    const completed = await originalCreate;
    expect(completed.status).toBe(201);
    const { run: finishedRun } = await completed.json();
    expect(finishedRun).toMatchObject({
      id: job.planRun.id, type: "destroy_plan", status: finalStatus, capsuleId: h.appId,
    });
    requests.length = 0;
    output.length = 0;
    expect(await main(currentReviewArgs, io)).toBe(finalStatus === "failed" ? 1 : 0);
    const observation = JSON.parse(output[0]!);
    expect(observation).toMatchObject({
      appId: h.appId, planRunId: job.planRun.id, planStatus: finalStatus,
      reviewUrl: `${ORIGIN}/runs/${job.planRun.id}`,
    });
    if (finalStatus === "failed") {
      expect(finishedRun.errorCode).toBe("plan_failed");
      expect(observation).toMatchObject({ status: "failed", code: finishedRun.errorCode });
      expect(observation.plan).toBeUndefined();
    } else {
      expect(observation).toMatchObject({
        status: "review_required", plan: { id: job.planRun.id, status: "waiting_approval" },
      });
    }
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual(expectedReads);
    expect(requests.every(request => new URL(request.url).origin === ORIGIN)).toBe(true);
    expect(h.runnerCalls).toEqual(beforeRead);
    const history = await h.dispatch(new Request(`${ORIGIN}/api/v1/capsules/${h.appId}/runs?type=destroy_plan`, {
      headers: { authorization: `Bearer ${readToken}` },
    }));
    expect(history.status).toBe(200);
    expect((await history.json()).runs.map((run: { id: string }) => run.id)).toEqual([job.planRun.id]);
    expect((await h.operations.getRun(job.planRun.id))?.status).toBe(finalStatus);
    expect(await h.ledger.getCapsule(h.appId)).toMatchObject({
      status: scheduled ? "uninstalled" : "active", currentStateGeneration: 1,
      ...(scheduled ? { uninstall: { phase: "scheduled" } } : {}),
    });
    expect(errors).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
    release.resolve();
    await originalCreate?.catch(() => undefined);
  }
});

test("apps update saves a reviewable revision Plan; apps apply separately reaches a terminal Run", async () => {
  const h = await fixture();
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return h.dispatch(request);
  }) as typeof fetch;
  const output: string[] = [];
  const errors: string[] = [];
  const io = { stdout: (line: string) => output.push(line), stderr: (line: string) => errors.push(line) };
  try {
    const before = { ...h.runnerCalls };
    const updateExit = await main([
      "apps", "update", h.appId, "--ref", "release/v2",
      "--idempotency-key", "cli-revision-fixed-1",
      "--token", TOKEN, "--url", ORIGIN, "--json",
    ], io);
    expect(updateExit).toBe(0);
    expect(errors).toEqual([]);
    const review = JSON.parse(output.join("\n"));
    const planRunId: unknown = review.planRunId;
    expect(typeof planRunId).toBe("string");
    expect(planRunId).toMatch(/^plan_/u);
    expect(review).toMatchObject({
      status: "review_required", appId: h.appId,
      revisionPlanId: expect.stringMatching(/^grp_/u),
      planRunId: expect.stringMatching(/^plan_/u),
      reviewUrl: expect.any(String), plan: expect.any(Object),
    });
    expect(requests[0]?.method).toBe("POST");
    expect(new URL(requests[0]!.url).pathname).toBe(`/api/v1/capsules/${h.appId}/revision-plans`);
    expect(requests[0]?.headers.get("idempotency-key")).toBe("cli-revision-fixed-1");
    expect(requests.every((request) => request.headers.get("authorization") === `Bearer ${TOKEN}`)).toBe(true);
    expect(h.runnerCalls.sync - before.sync).toBe(1);
    expect(h.runnerCalls.plan - before.plan).toBe(1);
    expect(h.runnerCalls.apply - before.apply).toBe(0);
    // The public Run lookup is the coordinator's read model for a saved Plan.
    // A private PlanRun accessor is not the CLI/API contract.
    const planBeforeApply = await h.operations.getRun(planRunId as string);
    expect(planBeforeApply).toMatchObject({ id: planRunId, type: "plan", capsuleId: h.appId });
    expect(await h.ledger.getCapsule(h.appId)).toMatchObject({ currentStateGeneration: 1 });

    output.length = 0;
    const applyExit = await main([
      "apps", "apply", h.appId, "--plan", planRunId as string,
      "--yes", "--token", TOKEN, "--url", ORIGIN, "--json",
    ], io);
    expect(applyExit).toBe(0);
    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0]!)).toMatchObject({
      status: "applying_reviewed_plan", appId: h.appId,
      reviewUrl: expect.any(String), plan: expect.any(Object),
    });
    const result = JSON.parse(output.join("\n"));
    expect(result).toMatchObject({
      status: "succeeded", appId: h.appId, planRunId,
      runId: expect.any(String), runStatus: "succeeded",
    });
    expect(h.runnerCalls.apply - before.apply).toBe(1);
    expect(await h.ledger.getCapsule(h.appId)).toMatchObject({
      status: "active", currentStateGeneration: 2,
    });
    const approvalPosts = requests.filter((request) =>
      request.method === "POST" && /\/api\/v1\/runs\/[^/]+\/approve$/u.test(new URL(request.url).pathname)
    );
    expect(approvalPosts).toHaveLength(planBeforeApply?.status === "waiting_approval" ? 1 : 0);

    // The real Accounts handler must refuse a PAT for another app and a PAT
    // lacking write scope before it can create a revision or trigger a Run.
    for (const [token, changes] of [
      ["synthetic-cli-wrong-app", { appIds: ["cap_other"] }],
      ["synthetic-cli-read-only", { scopes: ["read"] }],
    ] as const) {
      h.accounts.savePersonalAccessToken(token, {
        ...h.pat, tokenId: `pat_${token}`, ...changes,
      });
      const calls = { ...h.runnerCalls };
      output.length = 0;
      errors.length = 0;
      expect(await main([
        "apps", "update", h.appId, "--ref", "release/v3",
        "--idempotency-key", `denied-${token}`,
        "--token", token, "--url", ORIGIN, "--json",
      ], io)).toBe(1);
      expect(output).toHaveLength(1);
      expect(JSON.parse(output[0]!)).toMatchObject({ status: "refused", appId: h.appId });
      expect(errors).toEqual([]);
      expect(h.runnerCalls).toEqual(calls);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CLI app history finds the rollback target and the exact Plan survives a lost ACK", async () => {
  const h = await fixture();
  const previousVersion = (await h.ledger.getCapsule(h.appId))?.currentStateVersionId;
  expect(previousVersion).toBeString();
  const readToken = "synthetic-cli-history-read-pat";
  const otherAppToken = "synthetic-cli-history-other-app-pat";
  h.accounts.savePersonalAccessToken(readToken, { ...h.pat, tokenId: "pat_cli_history", scopes: ["read"] });
  h.accounts.savePersonalAccessToken(otherAppToken, { ...h.pat, tokenId: "pat_cli_history_other", scopes: ["read"], appIds: ["cap_other"] });
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  const output: string[] = [];
  const io = { stdout: (line: string) => output.push(line), stderr: () => {} };
  const rollbackPath = `/api/v1/state-versions/${previousVersion}/rollback-plan`;
  let lostPlan: string | undefined;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const response = await h.dispatch(request);
    if (request.method === "POST" && new URL(request.url).pathname === rollbackPath && lostPlan === undefined) {
      expect(response.status).toBe(201);
      lostPlan = (await response.json()).run.id;
      throw new TypeError("fixture dropped the rollback acknowledgement");
    }
    return response;
  }) as typeof fetch;
  const invokeCli = async (token: string, args: string[]) => {
    output.length = 0;
    const code = await main(["apps", ...args, "--token", token, "--url", ORIGIN, "--json"], io);
    expect(output).toHaveLength(1);
    return { code, result: JSON.parse(output[0]!) };
  };
  const run = (...args: string[]) => invokeCli(TOKEN, args);
  try {
    const revision = await run("update", h.appId, "--ref", "release/v2", "--idempotency-key", "cli-before-rollback");
    expect(revision.code).toBe(0);
    expect((await run("apply", h.appId, "--plan", revision.result.planRunId, "--yes")).code).toBe(0);
    expect(await h.ledger.getCapsule(h.appId)).toMatchObject({ currentStateGeneration: 2 });
    const before = { ...h.runnerCalls };
    requests.length = 0;
    const history = ["history", h.appId, "--limit", "1"];
    expect(await invokeCli(otherAppToken, history)).toMatchObject({ code: 1, result: { status: "refused" } });
    const older = await invokeCli(readToken, history);
    expect(older).toEqual({ code: 0, result: { appId: h.appId, stateVersions: [{
      id: previousVersion, generation: 1, environment: expect.any(String), createdAt: expect.any(String), createdByRunId: expect.any(String),
    }], nextCursor: expect.any(String) } });
    const current = await invokeCli(readToken, [...history, "--cursor", older.result.nextCursor]);
    expect(current).toMatchObject({ code: 0, result: { stateVersions: [{ generation: 2 }] } });
    expect(current.result.nextCursor).toBeUndefined();
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual(
      Array.from({ length: 3 }, () => ["GET", `/api/v1/capsules/${h.appId}/state-versions`]));
    expect(h.runnerCalls).toEqual(before);
    const target = older.result.stateVersions[0].id;
    const args = ["rollback", h.appId, "--state-version", target, "--idempotency-key", "cli-exact-state-rollback"];
    const first = await run(...args);
    expect(first.code).toBe(1);
    expect(first.result).toMatchObject({ status: "unconfirmed", stateVersionId: target });
    expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
    expect(lostPlan).toMatch(/^plan_/u);

    const recovered = await run(...args);
    expect(recovered).toMatchObject({ code: 0, result: { status: "review_required", appId: h.appId,
      stateVersionId: target, planRunId: lostPlan, plan: { stateVersionId: target, baseStateGeneration: 2 } } });
    const posts = requests.filter(request => request.method === "POST");
    expect(posts.map(request => new URL(request.url).pathname)).toEqual([rollbackPath, rollbackPath]);
    expect(posts.map(request => request.headers.get("idempotency-key"))).toEqual(["cli-exact-state-rollback", "cli-exact-state-rollback"]);
    expect(h.runnerCalls.plan - before.plan).toBe(1);
    expect(h.runnerCalls.sync - before.sync).toBe(0);
    expect(h.runnerCalls.apply - before.apply).toBe(0);
    expect(await h.ledger.getCapsule(h.appId)).toMatchObject({ currentStateGeneration: 2 });

    const observedArgs = ["rollback", h.appId, "--state-version", target, "--rollback-plan", recovered.result.planRunId];
    requests.length = 0;
    expect(await invokeCli(otherAppToken, observedArgs)).toMatchObject({ code: 1, result: { status: "refused" } });
    expect(requests.map(request => request.method)).toEqual(["GET"]);
    requests.length = 0;
    const stable = { ...h.runnerCalls };
    expect(await invokeCli(readToken, observedArgs)).toEqual(recovered);
    expect(requests.map(request => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      `GET /api/v1/state-versions/${target}`, `GET /api/v1/runs/${lostPlan}`,
    ]);
    expect(h.runnerCalls).toEqual(stable);
    expect(await h.ledger.getCapsule(h.appId)).toMatchObject({ currentStateGeneration: 2 });

    const restored = await run("apply", h.appId, "--plan", recovered.result.planRunId, "--yes");
    expect(restored.code).toBe(0);
    expect(restored.result).toMatchObject({ status: "succeeded", planRunId: lostPlan });
    expect(h.runnerCalls.apply - before.apply).toBe(1);
    expect(await h.ledger.getCapsule(h.appId)).toMatchObject({ currentStateGeneration: 3 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const stage of ["apply", "approve"] as const) test(`CLI explains a stale rollback when another Apply advances the app before ${stage}`, async () => {
  const h = await fixture();
  const target = (await h.ledger.getCapsule(h.appId))!.currentStateVersionId!;
  const request = (method: string, path: string, headers?: Record<string, string>) => h.dispatch(new Request(`${ORIGIN}${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, ...headers },
  }));
  const plans = [];
  for (const key of ["stale-rollback", "concurrent-rollback"]) {
    const response = await request("POST", `/api/v1/state-versions/${target}/rollback-plan`, { "idempotency-key": key });
    expect(response.status).toBe(201);
    plans.push((await response.json()).run.id as string);
  }
  const [staleId, concurrentId] = plans;
  expect(staleId).not.toBe(concurrentId);
  if (stage === "approve") {
    const saved = (await h.ledger.getPlanRun(staleId!))!;
    expect((await h.ledger.transitionRun({ id: saved.id, kind: "plan", expectFrom: ["succeeded"],
      run: { ...saved, status: "waiting_approval", requiresApproval: true } })).won).toBe(true);
  }
  const stalePostPath = `/api/v1/runs/${staleId}/${stage}`;
  const before = { ...h.runnerCalls };
  const calls: string[] = [];
  const output: string[] = [];
  let refusal: Response | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    calls.push(`${req.method} ${path}`);
    if (req.method === "POST" && path === stalePostPath) {
      const concurrent = await request("POST", `/api/v1/runs/${concurrentId}/apply`);
      expect(concurrent.status).toBe(201);
      expect((await concurrent.json()).run.status).toBe("succeeded");
      const response = await h.dispatch(req);
      refusal = response.clone();
      return response;
    }
    return await h.dispatch(req);
  }) as typeof fetch;
  try {
    expect(await main(["apps", "apply", h.appId, "--plan", staleId!, "--yes", "--token", TOKEN, "--url", ORIGIN, "--json"], {
      stdout: line => output.push(line), stderr() {},
    })).toBe(1);
    expect(refusal?.status).toBe(409);
    expect(await refusal?.json()).toMatchObject({ error: { code: "failed_precondition", details: { reason: "state_version_mismatch" } } });
    expect(calls).toEqual([
      `GET /api/v1/runs/${staleId}`, `GET /api/v1/capsules/${h.appId}/runs`, `GET /api/v1/capsules/${h.appId}`,
      `POST ${stalePostPath}`, `GET /api/v1/runs/${staleId}`, `GET /api/v1/capsules/${h.appId}/runs`,
    ]);
    expect(h.runnerCalls).toEqual({ ...before, apply: before.apply + 1 });
    expect(await h.ledger.getCapsule(h.appId)).toMatchObject({ currentStateGeneration: 2 });
    const stale = await h.ledger.getPlanRun(staleId!);
    expect(stale).not.toHaveProperty("appliedApplyRunId");
    expect(stale).not.toHaveProperty("approval");
    const result = JSON.parse(output[0]!);
    expect(result).toMatchObject({ status: "refused", reason: "state_version_mismatch", planRunId: staleId,
      lastObservedPlanStatus: stage === "approve" ? "waiting_approval" : "succeeded" });
    expect(result.recovery).toContain("apps history");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CLI rollback reports a save timeout as unconfirmed and the same key recovers the Plan", async () => {
  const h = await fixture();
  const target = (await h.ledger.getCapsule(h.appId))!.currentStateVersionId!;
  const args = ["apps", "rollback", h.appId, "--state-version", target,
    "--idempotency-key", "save-timeout-key", "--token", TOKEN, "--url", ORIGIN, "--json"];
  const originalFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  const prepare = h.ledger.preparePlanRun.bind(h.ledger);
  const entered = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const saved = Promise.withResolvers<void>();
  const receipts: { method: string; status: number; body: unknown }[] = [];
  const output: string[] = [];
  const io = { stdout: (line: string) => output.push(line), stderr: () => {} };
  const before = { ...h.runnerCalls };
  let deadline: (() => void) | undefined;
  globalThis.setTimeout = ((callback: TimerHandler, milliseconds?: number, ...params: unknown[]) => {
    if (milliseconds !== 25_000 || typeof callback !== "function") return realSetTimeout(callback, milliseconds, ...params);
    deadline = () => callback(...params);
    return realSetTimeout(() => undefined, 60_000);
  }) as typeof globalThis.setTimeout;
  h.ledger.preparePlanRun = async (input) => {
    entered.resolve(input.run.id);
    await release.promise;
    try { return await prepare(input); }
    finally { saved.resolve(); }
  };
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const response = await h.dispatch(request);
    receipts.push({ method: request.method, status: response.status, body: await response.clone().json() });
    return response;
  }) as typeof fetch;
  let planId: string | undefined;
  try {
    const pending = main(args, io);
    planId = await Promise.race([
      entered.promise, pending.then(() => { throw new Error("rollback returned before saving the Plan"); }),
    ]);
    expect(await h.ledger.getPlanRun(planId)).toBeUndefined();
    expect(deadline).toBeFunction();
    deadline!();
    expect(await pending).toBe(1);
    expect(receipts.map(({ method, status }) => [method, status])).toEqual([["GET", 200], ["POST", 409]]);
    expect(receipts[1]?.body).toMatchObject({ error: { code: "failed_precondition", details: {
      reason: "capsule_plan_creation_timeout", stage: "plan_run_create",
    } } });
    expect(output).toHaveLength(1);
    const unconfirmed = JSON.parse(output.pop()!);
    expect(unconfirmed).toMatchObject({ status: "unconfirmed", stateVersionId: target });
    expect(unconfirmed.planRunId).toBeUndefined();
    expect(unconfirmed.recovery).toContain("idempotency key");
    expect(h.runnerCalls).toEqual(before);

    release.resolve();
    await saved.promise;
    expect((await h.ledger.getPlanRun(planId))?.status).toBe("queued");
    expect(await main(args, io)).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ status: "review_required", planRunId: planId });
    expect(h.runnerCalls).toEqual({ ...before, plan: before.plan + 1 });
    expect((await h.ledger.getCapsule(h.appId))?.currentStateVersionId).toBe(target);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = realSetTimeout;
    h.ledger.preparePlanRun = prepare;
    release.resolve();
    if (planId) await saved.promise;
  }
});

test("a competing CLI update reads the Plan completed by another reconciler without advancing it again", async () => {
  const planning = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const h = await fixture({ async beforePlan(job) {
    if (job.planRun.origin?.kind !== "revision") return;
    planning.resolve();
    await release.promise;
  } });
  const observerToken = "synthetic-competing-cli-update";
  h.accounts.savePersonalAccessToken(observerToken, { ...h.pat, tokenId: "pat_cli_competing_update" });
  const before = { ...h.runnerCalls };
  const originalFetch = globalThis.fetch;
  const priorOutput: string[] = [];
  const observedOutput: string[] = [];
  const observedCalls: string[] = [];
  let coordinatorId: string | undefined;
  let conflictingPosts = 0;
  let prior: Promise<number> | undefined;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const response = await h.dispatch(request);
    if (request.headers.get("authorization") === `Bearer ${observerToken}`) {
      observedCalls.push(`${request.method} ${path}`);
      if (request.method === "POST" && path.endsWith("/reconcile")) {
        expect(response.status).toBe(409);
        expect(await response.clone().json()).toMatchObject({ error: { code: "reconcile_in_progress" } });
        conflictingPosts++;
        release.resolve();
        expect(await prior).toBe(0);
      }
    } else if (request.method === "POST" && path.endsWith("/revision-plans")) {
      coordinatorId = (await response.clone().json()).revisionPlan.id;
    }
    return response;
  }) as typeof fetch;
  const args = ["apps", "update", h.appId, "--ref", "release/v2", "--url", ORIGIN, "--json"];
  try {
    prior = main([...args, "--idempotency-key", "cli-competing-update-create", "--token", TOKEN], {
      stdout: line => priorOutput.push(line), stderr: () => {},
    });
    expect(await Promise.race([planning.promise.then(() => "entered"), prior.then(() => "finished")])).toBe("entered");
    expect(coordinatorId).toMatch(/^grp_/u);
    const status = await main([...args, "--revision-plan", coordinatorId!, "--token", observerToken], {
      stdout: line => observedOutput.push(line), stderr: () => {},
    });
    expect(status).toBe(0);
    expect(observedOutput).toEqual(priorOutput);
    const result = JSON.parse(observedOutput[0]!);
    expect(result).toMatchObject({ status: "review_required", revisionPlanId: coordinatorId });
    const self = `/api/v1/revision-plans/${coordinatorId}`;
    expect(observedCalls).toEqual([`GET ${self}`, `POST ${self}/reconcile`, `GET ${self}`, `GET /api/v1/runs/${result.planRunId}`]);
    expect(conflictingPosts).toBe(1);
    expect(h.runnerCalls).toEqual({ ...before, sync: before.sync + 1, plan: before.plan + 1 });
    expect(await h.ledger.getCapsule(h.appId)).toMatchObject({ currentStateGeneration: 1 });
  } finally {
    release.resolve();
    try { await prior; } finally { globalThis.fetch = originalFetch; }
  }
});

test.each(["preparing", "reviewable"] as const)("apps update reads the exact saved %s revision after a lost reconcile ACK", async lossAt => {
  const h = await fixture();
  const originalFetch = globalThis.fetch;
  const created = await h.dispatch(new Request(`${ORIGIN}/api/v1/capsules/${h.appId}/revision-plans`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "idempotency-key": "cli-revision-resume-retained-create",
    },
    body: JSON.stringify({ ref: "release/v2" }),
  }));
  expect(created.status).toBe(201);
  const saved = (await created.json()).revisionPlan as {
    id: string; capsuleId: string; operation: string; revision: { targetRef: string };
  };
  expect(saved).toMatchObject({
    capsuleId: h.appId, operation: "revision", revision: { targetRef: "release/v2" },
  });

  h.accounts.savePersonalAccessToken("synthetic-cli-revision-read-only", {
    ...h.pat, tokenId: "pat_cli_revision_read_only", scopes: ["read"],
  });
  const requests: Request[] = [];
  let loseReconcileAck = true;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const response = await h.dispatch(request);
    const path = new URL(request.url).pathname;
    if (loseReconcileAck && request.method === "POST" &&
      path === `/api/v1/revision-plans/${saved.id}/reconcile` && response.ok) {
      const { nextAction } = await response.clone().json();
      if (lossAt === "preparing" || nextAction === "review_run") {
        loseReconcileAck = false;
        throw new TypeError("synthetic lost reconcile ACK after persisted Core progress");
      }
    }
    return response;
  }) as typeof fetch;
  const output: string[] = [];
  const errors: string[] = [];
  const io = { stdout: (line: string) => output.push(line), stderr: (line: string) => errors.push(line) };
  const update = (appId: string, token = TOKEN, ref = "release/v2") => [
    "apps", "update", appId, "--ref", ref, "--revision-plan", saved.id,
    "--token", token, "--url", ORIGIN, "--json",
  ];
  try {
    const beforeRefusals = { ...h.runnerCalls };
    expect(await main(update("cap_another_app"), io)).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ status: "refused", code: "revision_identity_mismatch" });
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", `/api/v1/revision-plans/${saved.id}`],
    ]);
    expect(h.runnerCalls).toEqual(beforeRefusals);

    output.length = 0;
    requests.length = 0;
    expect(await main(update(h.appId, TOKEN, "release/v3"), io)).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ status: "refused", code: "revision_identity_mismatch" });
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", `/api/v1/revision-plans/${saved.id}`],
    ]);
    expect(h.runnerCalls).toEqual(beforeRefusals);

    output.length = 0;
    requests.length = 0;
    expect(await main(update(h.appId, "synthetic-cli-revision-read-only"), io)).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ status: "unconfirmed", code: "insufficient_scope" });
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", `/api/v1/revision-plans/${saved.id}`],
      ["POST", `/api/v1/revision-plans/${saved.id}/reconcile`],
    ]);
    expect(h.runnerCalls).toEqual(beforeRefusals);

    output.length = 0;
    requests.length = 0;
    const beforeResume = { ...h.runnerCalls };
    const self = `/api/v1/revision-plans/${saved.id}`;
    if (lossAt === "preparing") {
      expect(await main(update(h.appId), io)).toBe(1);
      expect(JSON.parse(output[0]!)).toMatchObject({
        status: "unconfirmed", appId: h.appId, revisionPlanId: saved.id, ref: "release/v2",
      });
      expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
        ["GET", self], ["POST", `${self}/reconcile`], ["GET", self],
      ]);
      output.length = 0;
      requests.length = 0;
    }
    expect(await main(update(h.appId), io)).toBe(0);
    expect(loseReconcileAck).toBe(false);
    const review = JSON.parse(output[0]!);
    const returnedPlanId = review.planRunId;
    expect(review).toMatchObject({
      status: "review_required", appId: h.appId, revisionPlanId: saved.id,
      planRunId: expect.stringMatching(/^plan_/u), plan: { ref: "release/v2" },
    });
    expect(requests[0]?.method).toBe("GET");
    expect(new URL(requests[0]!.url).pathname).toBe(`/api/v1/revision-plans/${saved.id}`);
    if (lossAt === "reviewable") {
      expect(requests.slice(-3).map(request => [request.method, new URL(request.url).pathname])).toEqual([
        ["POST", `${self}/reconcile`], ["GET", self], ["GET", `/api/v1/runs/${returnedPlanId}`],
      ]);
    }
    const posts = requests.filter(request => request.method === "POST");
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every(request => new URL(request.url).pathname ===
      `/api/v1/revision-plans/${saved.id}/reconcile`)).toBe(true);
    expect(posts.every(request => request.headers.get("authorization") === `Bearer ${TOKEN}`)).toBe(true);
    expect(requests.some(request => new URL(request.url).pathname ===
      `/api/v1/capsules/${h.appId}/revision-plans`)).toBe(false);
    expect(requests.some(request => /\/approve$|\/apply$/u.test(new URL(request.url).pathname))).toBe(false);
    expect(h.runnerCalls.plan - beforeResume.plan).toBe(1);
    expect(h.runnerCalls.apply - beforeResume.apply).toBe(0);
    expect(await h.ledger.getCapsule(h.appId)).toMatchObject({ status: "active", currentStateGeneration: 1 });
    expect(errors).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("actual coordinator replays the retained create key and lost Apply ACK observes one Core execution", async () => {
  const h = await fixture(); const originalFetch = globalThis.fetch;
  const requests: Request[] = []; let loseCreate = true; let loseApply = true; let createdId: string | undefined; let revokeAfterHistory = false; let revoked = false; let currentReadStatus: number | undefined;
  globalThis.fetch = (async (input, init) => {
    const req = new Request(input, init); requests.push(req.clone());
    const response = await h.dispatch(req); const path = new URL(req.url).pathname;
    if (req.method === "POST" && path.endsWith("/revision-plans") && loseCreate && response.ok) {
      loseCreate = false; createdId = (await response.clone().json()).revisionPlan.id;
      throw Error("synthetic lost create response after actual commit");
    }
    if (req.method === "POST" && path.endsWith("/apply") && loseApply && response.ok) {
      loseApply = false; throw Error("synthetic lost Apply response after actual commit");
    }
    if (req.method === "GET" && path === `/api/v1/capsules/${h.appId}/runs` && revokeAfterHistory && response.ok) {
      revokeAfterHistory = false; revoked = true;
      h.accounts.revokePersonalAccessToken({ subject: OWNER, tokenId: h.pat.tokenId, revokedAt: Date.now() });
    }
    if (revoked && req.method === "GET" && path.startsWith("/api/v1/runs/")) currentReadStatus = response.status;
    return response;
  }) as typeof fetch;
  const output: string[] = []; const io = { stdout: (s: string) => output.push(s), stderr() {} };
  const update = ["apps", "update", h.appId, "--ref", "release/v2", "--idempotency-key", "actual-retained-key", "--url", ORIGIN, "--token", TOKEN, "--json"];
  try {
    const before = { ...h.runnerCalls };
    expect(await main(update, io)).toBe(1);
    expect(JSON.parse(output[0]!).status).toBe("unconfirmed");
    expect(h.runnerCalls).toEqual(before);
    output.length = 0;
    expect(await main(update, io)).toBe(0);
    const prepared = JSON.parse(output[0]!);
    const planId = prepared.planRunId as string;
    expect(prepared.revisionPlanId).toBe(createdId);
    const createRequests = requests.filter(r => r.method === "POST" && new URL(r.url).pathname.endsWith("/revision-plans"));
    expect(createRequests).toHaveLength(2);
    expect(createRequests.map(r => r.headers.get("idempotency-key"))).toEqual(["actual-retained-key", "actual-retained-key"]);
    expect(h.runnerCalls.plan - before.plan).toBe(1);
    output.length = 0;
    expect(await main(["apps", "apply", h.appId, "--plan", planId, "--yes", "--url", ORIGIN, "--token", TOKEN, "--json"], io)).toBe(0);
    const result = JSON.parse(output[0]!); const runId = result.runId as string;
    expect(result.status).toBe("succeeded"); expect(result.runStatus).toBe("succeeded");
    expect(h.runnerCalls.apply - before.apply).toBe(1);
    expect((await h.ledger.getCapsule(h.appId))?.currentStateGeneration).toBe(2);
    expect(requests.filter(r => r.method === "POST" && new URL(r.url).pathname.endsWith("/apply"))).toHaveLength(1);
    const history = requests
      .map(req => new URL(req.url))
      .filter(url => url.pathname === `/api/v1/capsules/${h.appId}/runs`);
    expect(history.map(url => url.searchParams.get("planRunId"))).toEqual([planId, planId]);
    const beforeObservation = requests.length;
    output.length = 0;
    expect(await main(["apps", "apply", h.appId, "--plan", planId, "--observe-only", "--url", ORIGIN, "--token", TOKEN, "--json"], io)).toBe(0);
    expect(JSON.parse(output[0]!).runId).toBe(runId);
    expect(requests.slice(beforeObservation).every(r => r.method === "GET")).toBe(true);
    expect(h.runnerCalls.apply - before.apply).toBe(1);

    // Listing a completed Apply is only its locator. Current individual Run
    // authority is re-evaluated after the list response has been produced.
    const beforeRevokedRead = requests.length;
    const completedCalls = { ...h.runnerCalls };
    revokeAfterHistory = true;
    output.length = 0;
    expect(await main(["apps", "apply", h.appId, "--plan", planId, "--observe-only", "--url", ORIGIN, "--token", TOKEN, "--json"], io)).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ status: "indeterminate", runId });
    expect(JSON.parse(output[0]!).runStatus).toBeUndefined();
    expect(currentReadStatus).toBe(401);
    expect(requests.slice(beforeRevokedRead).map(r => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      `GET /api/v1/runs/${planId}`,
      `GET /api/v1/capsules/${h.appId}/runs`,
      `GET /api/v1/runs/${runId}`,
    ]);
    expect(h.runnerCalls).toEqual(completedCalls);
    expect((await h.ledger.getCapsule(h.appId))?.currentStateGeneration).toBe(2);
  } finally { globalThis.fetch = originalFetch; }
});

test("current Accounts PAT revocation after coordinator creation blocks reconciliation before runner work", async () => {
  const h = await fixture(); const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const req = new Request(input, init); const response = await h.dispatch(req);
    if (req.method === "POST" && new URL(req.url).pathname.endsWith("/revision-plans") && response.ok) {
      h.accounts.revokePersonalAccessToken({ subject: OWNER, tokenId: h.pat.tokenId, revokedAt: Date.now() });
    }
    return response;
  }) as typeof fetch;
  const output: string[] = [];
  try {
    const before = { ...h.runnerCalls };
    expect(await main(["apps", "update", h.appId, "--ref", "release/v2", "--idempotency-key", "revoked-before-reconcile",
      "--url", ORIGIN, "--token", TOKEN, "--json"], { stdout: s => output.push(s), stderr() {} })).toBe(1);
    expect(JSON.parse(output[0]!).status).toBe("unconfirmed");
    expect(h.runnerCalls).toEqual(before);
    expect((await h.ledger.getCapsule(h.appId))?.currentStateGeneration).toBe(1);
  } finally { globalThis.fetch = originalFetch; }
});
