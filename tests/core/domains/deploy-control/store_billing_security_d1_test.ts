import { expect, test } from "bun:test";

import { CloudflareD1OpenTofuDeploymentStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../../../worker/src/bindings.ts";

test("d1 store persists security findings and billing ledger rows", async () => {
  const store = new CloudflareD1OpenTofuDeploymentStore(new SqliteFakeD1());

  await store.putSecurityFinding({
    id: "sec_1",
    spaceId: "space_1",
    installationId: "inst_1",
    runId: "run_1",
    severity: "error",
    type: "provider_install_denied",
    message: "provider mirror evidence is missing",
    metadata: { code: "provider_mirror_required" },
    createdAt: "2026-06-07T00:00:01.000Z",
  });
  await store.putSecurityFinding({
    id: "sec_2",
    spaceId: "space_1",
    runId: "run_2",
    severity: "warning",
    type: "policy_warning",
    message: "warning",
    metadata: {},
    createdAt: "2026-06-07T00:00:02.000Z",
  });

  expect(
    (await store.listSecurityFindings("space_1")).map((row) => row.id),
  ).toEqual(["sec_2", "sec_1"]);
  expect(
    (await store.listSecurityFindings("space_1", { runId: "run_1" })).map(
      (row) => row.id,
    ),
  ).toEqual(["sec_1"]);

  await store.putBillingAccount({
    id: "bill_1",
    ownerType: "space",
    ownerId: "space_1",
    provider: "stripe",
    stripeCustomerId: "cus_1",
    status: "active",
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  expect(
    await store.getBillingAccountForOwner("space", "space_1"),
  ).toMatchObject({ id: "bill_1", provider: "stripe" });

  await store.putBillingPlan({
    id: "pro",
    name: "Pro",
    monthlyBasePrice: 2000,
    includedCredits: 1000,
    limits: {
      maxEstimatedCreditsPerRun: 100,
      quota: { resources: 20 },
    },
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  expect(await store.getBillingPlan("pro")).toMatchObject({
    id: "pro",
    limits: {
      maxEstimatedCreditsPerRun: 100,
      quota: { resources: 20 },
    },
  });

  await store.putSpaceSubscription({
    id: "sub_1",
    spaceId: "space_1",
    billingAccountId: "bill_1",
    planId: "pro",
    status: "active",
    currentPeriodStart: "2026-06-01T00:00:00.000Z",
    currentPeriodEnd: "2026-07-01T00:00:00.000Z",
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  expect(await store.getSpaceSubscription("space_1")).toMatchObject({
    id: "sub_1",
    planId: "pro",
  });

  await store.putCreditBalance({
    spaceId: "space_1",
    availableCredits: 20,
    reservedCredits: 5,
    monthlyIncludedCredits: 10,
    purchasedCredits: 15,
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  expect(
    await store.reserveCredits("space_1", {
      credits: 7,
      updatedAt: "2026-06-07T00:00:01.000Z",
    }),
  ).toMatchObject({
    availableCredits: 13,
    reservedCredits: 12,
    updatedAt: "2026-06-07T00:00:01.000Z",
  });
  expect(
    await store.reserveCredits("space_1", {
      credits: 99,
      updatedAt: "2026-06-07T00:00:02.000Z",
    }),
  ).toBeUndefined();

  await store.putCreditReservation({
    id: "creditres_1",
    spaceId: "space_1",
    runId: "plan_1",
    estimatedCredits: 7,
    status: "reserved",
    mode: "enforce",
    createdAt: "2026-06-07T00:00:01.000Z",
    expiresAt: "2026-06-08T00:00:01.000Z",
  });
  expect(await store.getCreditReservationForRun("plan_1")).toMatchObject({
    id: "creditres_1",
    mode: "enforce",
  });
  expect(
    (await store.listCreditReservations("space_1")).map((row) => row.id),
  ).toEqual(["creditres_1"]);

  await store.putUsageEvent({
    id: "usage_1",
    spaceId: "space_1",
    installationId: "inst_1",
    runId: "apply_1",
    kind: "operation",
    quantity: 1,
    credits: 7,
    source: "runner",
    idempotencyKey: "apply_1:operation",
    createdAt: "2026-06-07T00:00:03.000Z",
  });
  await store.putUsageEvent({
    id: "usage_duplicate",
    spaceId: "space_1",
    runId: "apply_1",
    kind: "operation",
    quantity: 1,
    credits: 999,
    source: "runner",
    idempotencyKey: "apply_1:operation",
    createdAt: "2026-06-07T00:00:04.000Z",
  });
  expect(await store.listUsageEvents("space_1")).toEqual([
    {
      id: "usage_1",
      spaceId: "space_1",
      installationId: "inst_1",
      runId: "apply_1",
      kind: "operation",
      quantity: 1,
      credits: 7,
      source: "runner",
      idempotencyKey: "apply_1:operation",
      createdAt: "2026-06-07T00:00:03.000Z",
    },
  ]);
});

test("d1 commitAppliedDeployment writes the unit atomically and rolls back a guard conflict", async () => {
  const store = new CloudflareD1OpenTofuDeploymentStore(new SqliteFakeD1());
  const TS = "2026-06-07T00:00:00.000Z";
  await store.putInstallation({
    id: "inst_1",
    spaceId: "space_1",
    name: "shop",
    slug: "shop",
    sourceId: "src_1",
    installType: "opentofu_module",
    installConfigId: "cfg_1",
    environment: "production",
    currentStateGeneration: 0,
    status: "pending",
    createdAt: TS,
    updatedAt: TS,
  });
  const stateSnapshot = (gen: number, id: string) => ({
    id,
    spaceId: "space_1",
    installationId: "inst_1",
    environment: "production",
    generation: gen,
    objectKey: `spaces/space_1/installations/inst_1/envs/production/states/0000000${gen}.tfstate.enc`,
    digest: "sha256:abc",
    createdByRunId: "run_apply_1",
    createdAt: TS,
  });
  const deployment = (id: string, gen: number, out: string) => ({
    id,
    spaceId: "space_1",
    installationId: "inst_1",
    environment: "production",
    applyRunId: "run_apply_1",
    sourceSnapshotId: "snap_1",
    stateGeneration: gen,
    outputSnapshotId: out,
    outputsPublic: { launch_url: "https://x.example" },
    status: "active" as const,
    createdAt: TS,
  });
  const outputSnapshot = (id: string, gen: number) => ({
    id,
    spaceId: "space_1",
    installationId: "inst_1",
    stateGeneration: gen,
    rawOutputArtifactKey: "spaces/space_1/installations/inst_1/runs/run_apply_1/outputs.raw.json.enc",
    publicOutputs: { launch_url: "https://x.example" },
    spaceOutputs: { launch_url: "https://x.example" },
    outputDigest: "sha256:out",
    createdAt: TS,
  });

  // Successful atomic commit: every record lands and the installation advances.
  const ok = await store.commitAppliedDeployment({
    newDeployment: deployment("dep_ok", 1, "out_ok"),
    stateSnapshot: stateSnapshot(1, "state_ok"),
    outputSnapshot: outputSnapshot("out_ok", 1),
    installationPatch: {
      id: "inst_1",
      patch: {
        currentDeploymentId: "dep_ok",
        status: "active",
        currentStateGeneration: 1,
        currentOutputSnapshotId: "out_ok",
        updatedAt: TS,
      },
      guard: { currentDeploymentId: undefined, status: "pending" },
    },
  });
  expect(ok.installation?.currentDeploymentId).toBe("dep_ok");
  expect((await store.getDeployment("dep_ok"))?.status).toBe("active");
  expect(
    (await store.getLatestStateSnapshot("inst_1", "production"))?.generation,
  ).toBe(1);
  expect((await store.getOutputSnapshot("out_ok"))?.stateGeneration).toBe(1);

  // Guard conflict: the cursor is now `dep_ok`, so a stale `undefined` guard
  // loses. D1 evaluates the guard against a pre-batch read and throws BEFORE the
  // batch, so NO deployment / state / output record is ever written (atomic: the
  // whole unit either commits in one batch or not at all).
  await expect(
    store.commitAppliedDeployment({
      newDeployment: deployment("dep_torn", 2, "out_torn"),
      stateSnapshot: stateSnapshot(2, "state_torn"),
      outputSnapshot: outputSnapshot("out_torn", 2),
      installationPatch: {
        id: "inst_1",
        patch: { currentDeploymentId: "dep_torn", updatedAt: TS },
        guard: { currentDeploymentId: undefined },
      },
    }),
  ).rejects.toThrow();
  expect(await store.getDeployment("dep_torn")).toBeUndefined();
  expect(await store.getOutputSnapshot("out_torn")).toBeUndefined();
  expect(
    (await store.getLatestStateSnapshot("inst_1", "production"))?.generation,
  ).toBe(1);
  expect((await store.getInstallation("inst_1"))?.currentDeploymentId).toBe(
    "dep_ok",
  );
});

test("d1 commitAppliedDeployment rolls back when the apply lease changes after the pre-read", async () => {
  const backing = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuDeploymentStore(
    new LeaseChangingD1(backing, "apply_interleave", "lease_taken"),
  );
  const TS = "2026-06-07T00:00:00.000Z";

  await store.putInstallation({
    id: "inst_interleave",
    spaceId: "space_1",
    name: "shop",
    slug: "shop",
    sourceId: "src_1",
    installType: "opentofu_module",
    installConfigId: "cfg_1",
    environment: "production",
    currentStateGeneration: 0,
    status: "pending",
    createdAt: TS,
    updatedAt: TS,
  });
  const planRun = {
    id: "plan_interleave",
    spaceId: "space_1",
    installationId: "inst_interleave",
    source: { kind: "git" as const, url: "https://example.com/repo.git" },
    sourceDigest: "sha256:src",
    operation: "apply" as const,
    runnerProfileId: "rp_1",
    variablesDigest: "sha256:vars",
    requiredProviders: ["cloudflare"],
    status: "succeeded" as const,
    policy: { status: "passed" as const, reasons: [], checkedAt: 0 },
    policyDecisionDigest: "sha256:pol",
    auditEvents: [],
    createdAt: 1_000,
    updatedAt: 1_000,
  };
  const applyRun = {
    id: "apply_interleave",
    planRunId: "plan_interleave",
    spaceId: "space_1",
    installationId: "inst_interleave",
    operation: "apply" as const,
    runnerProfileId: "rp_1",
    status: "queued" as const,
    expected: {
      planRunId: "plan_interleave",
      runnerProfileId: "rp_1",
      sourceDigest: "sha256:src",
      variablesDigest: "sha256:vars",
      policyDecisionDigest: "sha256:pol",
      planDigest: "sha256:plan",
      planArtifactDigest: "sha256:art",
    },
    stateBackend: { kind: "encrypted-r2" as const },
    stateLock: { status: "not_required" as const, backendRef: "ref" },
    auditEvents: [],
    createdAt: 2_000,
    updatedAt: 2_000,
  };
  await store.putPlanRun(planRun);
  await store.putApplyRun(applyRun);
  const claim = await store.transitionRun({
    id: "apply_interleave",
    kind: "apply",
    expectFrom: ["queued"],
    run: { ...applyRun, status: "running" },
    setLeaseToken: "lease_fresh",
    heartbeatAt: 1,
  });
  expect(claim.won).toBe(true);

  const committed = await store.commitAppliedDeployment({
    newDeployment: {
      id: "dep_interleave",
      spaceId: "space_1",
      installationId: "inst_interleave",
      environment: "production",
      applyRunId: "apply_interleave",
      sourceSnapshotId: "snap_1",
      stateGeneration: 1,
      outputSnapshotId: "out_interleave",
      outputsPublic: { launch_url: "https://x.example" },
      status: "active",
      createdAt: TS,
    },
    stateSnapshot: {
      id: "state_interleave",
      spaceId: "space_1",
      installationId: "inst_interleave",
      environment: "production",
      generation: 1,
      objectKey:
        "spaces/space_1/installations/inst_interleave/envs/production/states/00000001.tfstate.enc",
      digest: "sha256:state",
      createdByRunId: "apply_interleave",
      createdAt: TS,
    },
    outputSnapshot: {
      id: "out_interleave",
      spaceId: "space_1",
      installationId: "inst_interleave",
      stateGeneration: 1,
      rawOutputArtifactKey:
        "spaces/space_1/installations/inst_interleave/runs/apply_interleave/outputs.raw.json.enc",
      publicOutputs: { launch_url: "https://x.example" },
      spaceOutputs: { launch_url: "https://x.example" },
      outputDigest: "sha256:out",
      createdAt: TS,
    },
    installationPatch: {
      id: "inst_interleave",
      patch: {
        currentDeploymentId: "dep_interleave",
        status: "active",
        currentStateGeneration: 1,
        currentOutputSnapshotId: "out_interleave",
        updatedAt: TS,
      },
      guard: { currentDeploymentId: undefined, status: "pending" },
    },
    applyRunTerminal: {
      ...applyRun,
      status: "succeeded",
      deploymentId: "dep_interleave",
    },
    applyRunLeaseToken: "lease_fresh",
    planRunApplied: {
      ...planRun,
      appliedApplyRunId: "apply_interleave",
    },
  });

  expect(committed.applyRunLeaseLost).toBe(true);
  expect(await store.getDeployment("dep_interleave")).toBeUndefined();
  expect(await store.getOutputSnapshot("out_interleave")).toBeUndefined();
  expect(
    (await store.getLatestStateSnapshot("inst_interleave", "production"))
      ?.generation,
  ).toBeUndefined();
  expect(
    (await store.getInstallation("inst_interleave"))?.currentDeploymentId,
  ).toBeUndefined();
  expect((await store.getApplyRun("apply_interleave"))?.status).toBe("running");
  expect(
    (await store.getPlanRun("plan_interleave"))?.appliedApplyRunId,
  ).toBeUndefined();
});

test("d1 store accepts operator-scoped connections without a space id", async () => {
  const store = new CloudflareD1OpenTofuDeploymentStore(new SqliteFakeD1());

  await store.putConnection({
    id: "conn_operator_cf",
    provider: "cloudflare",
    scope: "operator",
    owner: "operator",
    authMethod: "static_secret",
    status: "verified",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });

  expect((await store.listOperatorConnections()).map((row) => row.id)).toEqual([
    "conn_operator_cf",
  ]);
});

class LeaseChangingD1 implements D1Database {
  #changed = false;

  constructor(
    private readonly inner: D1Database,
    private readonly runId: string,
    private readonly newLeaseToken: string,
  ) {}

  prepare(query: string): D1PreparedStatement {
    const statement = this.inner.prepare(query);
    const lower = query.toLowerCase();
    if (
      !this.#changed &&
      lower.includes("select") &&
      lower.includes("lease_token") &&
      lower.includes("from \"runs\"")
    ) {
      return new LeaseChangingStatement(statement, async () => {
        if (this.#changed) return;
        this.#changed = true;
        await this.inner
          .prepare("update runs set lease_token = ? where id = ?")
          .bind(this.newLeaseToken, this.runId)
          .run();
      });
    }
    return statement;
  }

  batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    if (!this.inner.batch) {
      throw new Error("wrapped D1 binding does not support batch");
    }
    return this.inner.batch<T>(statements);
  }
}

class LeaseChangingStatement implements D1PreparedStatement {
  constructor(
    private readonly inner: D1PreparedStatement,
    private readonly afterFirst: () => Promise<void>,
  ) {}

  bind(...values: readonly unknown[]): D1PreparedStatement {
    this.inner.bind(...values);
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    const row = await this.inner.first<T>();
    await this.afterFirst();
    return row;
  }

  all<T = unknown>(): Promise<D1Result<T>> {
    return this.inner.all<T>();
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const statement = this.inner as D1PreparedStatement & {
      raw?: <TValue = unknown[]>() => Promise<TValue[]>;
    };
    const rows = statement.raw
      ? await statement.raw<T>()
      : ((await this.inner.all<T>()).results ?? []);
    await this.afterFirst();
    return rows as T[];
  }

  run<T = unknown>(): Promise<D1Result<T>> {
    return this.inner.run<T>();
  }
}
