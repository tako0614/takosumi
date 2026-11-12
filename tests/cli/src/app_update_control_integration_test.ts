import { expect, test } from "bun:test";

import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../accounts/service/src/account-session.ts";
import { handleControlRoute } from "../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";
import { main } from "../../../cli/src/main.ts";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { InMemoryGitInstallPlanStore } from "../../../core/domains/install-plans/store.ts";
import type { OpenTofuRunner } from "../../../core/domains/deploy-control/mod.ts";
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
async function fixture() {
  const runnerCalls = { sync: 0, plan: 0, apply: 0 };
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
    plan: async () => {
      runnerCalls.plan += 1;
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

test("actual coordinator replays the retained create key and lost Apply ACK observes one Core execution", async () => {
  const h = await fixture(); const originalFetch = globalThis.fetch;
  const requests: Request[] = []; let loseCreate = true; let loseApply = true; let createdId: string | undefined;
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
    const beforeObservation = requests.length;
    output.length = 0;
    expect(await main(["apps", "apply", h.appId, "--plan", planId, "--observe-only", "--url", ORIGIN, "--token", TOKEN, "--json"], io)).toBe(0);
    expect(JSON.parse(output[0]!).runId).toBe(runId);
    expect(requests.slice(beforeObservation).every(r => r.method === "GET")).toBe(true);
    expect(h.runnerCalls.apply - before.apply).toBe(1);
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
