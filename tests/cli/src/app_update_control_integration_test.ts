import { expect, test } from "bun:test";

import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../accounts/service/src/account-session.ts";
import { handleControlRoute } from "../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";
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
  const { operations } = await createTakosumiService({
    authorizeInterfaceBearer: () => undefined,
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: ledger,
    gitInstallPlanStore,
    opentofuRunner: runner,
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
  });
  const workspace = await operations.workspaces.createWorkspace({
    handle: "cli-revision", displayName: "CLI revision", type: "personal", ownerUserId: OWNER,
  });
  const accounts = new InMemoryAccountsStore();
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
    appIds: [appId], createdAt: now, expiresAt: now + 600_000,
  };
  accounts.savePersonalAccessToken(TOKEN, pat);
  return { accounts, pat, appId, ledger, operations, dispatch, runnerCalls };
}

test("Accounts Destroy Plan and CLI apply complete one no-provider uninstall with PAT fences", async () => {
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
  const created = await h.dispatch(new Request(`${ORIGIN}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: "{}",
  }));
  expect(created.status).toBe(201);
  const saved = (await created.json()).run as { id: string; type: string; status: string;
    capsuleId: string; workspaceId: string };
  expect(saved).toMatchObject({ type: "destroy_plan", status: "waiting_approval",
    capsuleId: h.appId });
  expect(saved.workspaceId).toBeString();
  expect((await h.operations.getRun(saved.id))?.id).toBe(saved.id);
  const beforeDestroy = { ...h.runnerCalls };

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

test("current uninstall review reads the same pending Accounts Destroy Plan after its acknowledgement is lost", async () => {
  const entered = Promise.withResolvers<OpenTofuPlanJob>();
  const release = Promise.withResolvers<void>();
  const h = await fixture({
    async beforePlan(job) {
      if (job.planRun.operation !== "destroy") return;
      entered.resolve(job);
      await release.promise;
    },
  });
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
      ["GET", `/api/v1/capsules/${h.appId}/app`],
      ["GET", `/api/v1/runs/${job.planRun.id}`],
      ["GET", `/api/v1/capsules/${h.appId}/app`],
    ];
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual(expectedReads);
    expect(h.runnerCalls).toEqual(beforeRead);
    expect(await h.ledger.getPlanRun(job.planRun.id)).toEqual(pending);
    expect(errors).toEqual([]);

    release.resolve();
    const completed = await originalCreate;
    expect(completed.status).toBe(201);
    expect((await completed.json()).run).toMatchObject({
      id: job.planRun.id, type: "destroy_plan", status: "waiting_approval", capsuleId: h.appId,
    });
    requests.length = 0;
    output.length = 0;
    expect(await main(currentReviewArgs, io)).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({
      status: "review_required", appId: h.appId, planRunId: job.planRun.id,
      reviewUrl: `${ORIGIN}/runs/${job.planRun.id}`,
      plan: { id: job.planRun.id, status: "waiting_approval" },
    });
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual(expectedReads);
    expect(requests.every(request => new URL(request.url).origin === ORIGIN)).toBe(true);
    expect(h.runnerCalls).toEqual(beforeRead);
    const history = await h.dispatch(new Request(`${ORIGIN}/api/v1/capsules/${h.appId}/runs?type=destroy_plan`, {
      headers: { authorization: `Bearer ${readToken}` },
    }));
    expect(history.status).toBe(200);
    expect((await history.json()).runs.map((run: { id: string }) => run.id)).toEqual([job.planRun.id]);
    expect((await h.operations.getRun(job.planRun.id))?.status).toBe("waiting_approval");
    expect(await h.ledger.getCapsule(h.appId)).toMatchObject({ status: "active", currentStateGeneration: 1 });
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

    const restored = await run("apply", h.appId, "--plan", recovered.result.planRunId, "--yes");
    expect(restored.code).toBe(0);
    expect(restored.result).toMatchObject({ status: "succeeded", planRunId: lostPlan });
    expect(h.runnerCalls.apply - before.apply).toBe(1);
    expect(await h.ledger.getCapsule(h.appId)).toMatchObject({ currentStateGeneration: 3 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("apps update resumes only the exact saved revision coordinator after a lost reconcile ACK", async () => {
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
  let loseFirstReconcileAck = true;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const response = await h.dispatch(request);
    const path = new URL(request.url).pathname;
    if (loseFirstReconcileAck && request.method === "POST" &&
      path === `/api/v1/revision-plans/${saved.id}/reconcile` && response.ok) {
      loseFirstReconcileAck = false;
      throw new Error("synthetic lost reconcile ACK after persisted Core progress");
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
    expect(await main(update(h.appId), io)).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      status: "unconfirmed", appId: h.appId, revisionPlanId: saved.id, ref: "release/v2",
    });
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", `/api/v1/revision-plans/${saved.id}`],
      ["POST", `/api/v1/revision-plans/${saved.id}/reconcile`],
    ]);

    output.length = 0;
    requests.length = 0;
    expect(await main(update(h.appId), io)).toBe(0);
    const review = JSON.parse(output[0]!);
    expect(review).toMatchObject({
      status: "review_required", appId: h.appId, revisionPlanId: saved.id,
      planRunId: expect.stringMatching(/^plan_/u), plan: { ref: "release/v2" },
    });
    expect(requests[0]?.method).toBe("GET");
    expect(new URL(requests[0]!.url).pathname).toBe(`/api/v1/revision-plans/${saved.id}`);
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
