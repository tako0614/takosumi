import { expect, test } from "bun:test";

import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../../../worker/src/bindings.ts";

test("d1 store persists security findings and provider-neutral usage", async () => {
  const store = new CloudflareD1OpenTofuControlStore(new SqliteFakeD1());

  await store.putSecurityFinding({
    id: "sec_1",
    workspaceId: "ws_1",
    capsuleId: "capsule_1",
    runId: "run_1",
    severity: "error",
    type: "provider_install_denied",
    message: "provider mirror evidence is missing",
    metadata: { code: "provider_mirror_required" },
    createdAt: "2026-06-07T00:00:01.000Z",
  });
  await store.putSecurityFinding({
    id: "sec_2",
    workspaceId: "ws_1",
    runId: "run_2",
    severity: "warning",
    type: "policy_warning",
    message: "warning",
    metadata: {},
    createdAt: "2026-06-07T00:00:02.000Z",
  });

  expect(
    (await store.listSecurityFindings("ws_1")).map((row) => row.id),
  ).toEqual(["sec_2", "sec_1"]);
  expect(
    (await store.listSecurityFindings("ws_1", { runId: "run_1" })).map(
      (row) => row.id,
    ),
  ).toEqual(["sec_1"]);

  await store.putUsageEvent({
    id: "usage_1",
    workspaceId: "ws_1",
    capsuleId: "capsule_1",
    runId: "apply_1",
    kind: "opentofu.apply",
    quantity: 1,
    usdMicros: 750_000,
    ratingStatus: "rated",
    source: "runner",
    idempotencyKey: "apply_1:opentofu.apply",
    createdAt: "2026-06-07T00:00:03.000Z",
  });
  await store.putUsageEvent({
    id: "usage_duplicate",
    workspaceId: "ws_1",
    runId: "apply_1",
    kind: "opentofu.apply",
    quantity: 1,
    usdMicros: 999_000_000,
    ratingStatus: "rated",
    source: "runner",
    idempotencyKey: "apply_1:opentofu.apply",
    createdAt: "2026-06-07T00:00:04.000Z",
  });
  expect(await store.listUsageEvents("ws_1")).toEqual([
    {
      id: "usage_1",
      workspaceId: "ws_1",
      capsuleId: "capsule_1",
      runId: "apply_1",
      kind: "opentofu.apply",
      quantity: 1,
      usdMicros: 750_000,
      ratingStatus: "rated",
      source: "runner",
      idempotencyKey: "apply_1:opentofu.apply",
      createdAt: "2026-06-07T00:00:03.000Z",
    },
  ]);
});

test("d1 commitRunState writes the unit atomically and rolls back a guard conflict", async () => {
  const store = new CloudflareD1OpenTofuControlStore(new SqliteFakeD1());
  const TS = "2026-06-07T00:00:00.000Z";
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
  });
  const stateVersion = (gen: number, id: string) => ({
    id,
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    environment: "production",
    generation: gen,
    stateRef: `opaque-state-${gen}`,
    digest: "sha256:abc",
    createdByRunId: "run_apply_1",
    createdAt: TS,
  });
  const output = (id: string, gen: number) => ({
    id,
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    stateGeneration: gen,
    rawArtifactRef: `opaque-output-${gen}`,
    publicOutputs: { launch_url: "https://x.example" },
    workspaceOutputs: { launch_url: "https://x.example" },
    outputDigest: "sha256:out",
    createdAt: TS,
  });

  // Successful atomic commit: every record lands and the Capsule advances.
  const ok = await store.commitRunState({
    stateVersion: stateVersion(1, "state_ok"),
    output: output("out_ok", 1),
    capsulePatch: {
      id: seeded.capsule.id,
      patch: {
        currentStateVersionId: "state_ok",
        status: "active",
        currentStateGeneration: 1,
        currentOutputId: "out_ok",
        updatedAt: TS,
      },
      guard: { currentStateVersionId: undefined, status: "pending" },
    },
  });
  expect(ok.capsule?.currentStateVersionId).toBe("state_ok");
  expect(
    (await store.getLatestStateVersion(seeded.capsule.id, "production"))
      ?.generation,
  ).toBe(1);
  expect((await store.getOutput("out_ok"))?.stateGeneration).toBe(1);

  // Guard conflict: the cursor is now `state_ok`, so a stale `undefined` guard
  // loses. D1 evaluates the guard against a pre-batch read and throws BEFORE the
  // batch, so NO StateVersion / Output record is ever written (atomic: the
  // whole unit either commits in one batch or not at all).
  await expect(
    store.commitRunState({
      stateVersion: stateVersion(2, "state_torn"),
      output: output("out_torn", 2),
      capsulePatch: {
        id: seeded.capsule.id,
        patch: { currentStateVersionId: "state_torn", updatedAt: TS },
        guard: { currentStateVersionId: undefined },
      },
    }),
  ).rejects.toThrow();
  expect(await store.getStateVersion("state_torn")).toBeUndefined();
  expect(await store.getOutput("out_torn")).toBeUndefined();
  expect(
    (await store.getLatestStateVersion(seeded.capsule.id, "production"))
      ?.generation,
  ).toBe(1);
  expect((await store.getCapsule(seeded.capsule.id))?.currentStateVersionId).toBe(
    "state_ok",
  );
});

test("d1 commitRunState rolls back when the apply lease changes after the pre-read", async () => {
  const backing = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(
    new LeaseChangingD1(backing, "apply_interleave", "lease_taken"),
  );
  const TS = "2026-06-07T00:00:00.000Z";

  const seeded = await seedCapsuleModel(store, {
    workspaceId: "workspace_1",
    capsuleId: "capsule_interleave",
  });
  const planRun = {
    id: "plan_interleave",
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
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
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
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

  const committed = await store.commitRunState({
    stateVersion: {
      id: "state_interleave",
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      environment: "production",
      generation: 1,
      stateRef: "opaque-state-interleave",
      digest: "sha256:state",
      createdByRunId: "apply_interleave",
      createdAt: TS,
    },
    output: {
      id: "out_interleave",
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      stateGeneration: 1,
      rawArtifactRef: "opaque-output-interleave",
      publicOutputs: { launch_url: "https://x.example" },
      workspaceOutputs: { launch_url: "https://x.example" },
      outputDigest: "sha256:out",
      createdAt: TS,
    },
    capsulePatch: {
      id: seeded.capsule.id,
      patch: {
        currentStateVersionId: "state_interleave",
        status: "active",
        currentStateGeneration: 1,
        currentOutputId: "out_interleave",
        updatedAt: TS,
      },
      guard: { currentStateVersionId: undefined, status: "pending" },
    },
    applyRunTerminal: {
      ...applyRun,
      status: "succeeded",
      stateVersionId: "state_interleave",
    },
    applyRunLeaseToken: "lease_fresh",
    planRunApplied: {
      ...planRun,
      appliedApplyRunId: "apply_interleave",
    },
  });

  expect(committed.applyRunLeaseLost).toBe(true);
  expect(await store.getStateVersion("state_interleave")).toBeUndefined();
  expect(await store.getOutput("out_interleave")).toBeUndefined();
  expect(
    (await store.getLatestStateVersion(seeded.capsule.id, "production"))
      ?.generation,
  ).toBeUndefined();
  expect(
    (await store.getCapsule(seeded.capsule.id))?.currentStateVersionId,
  ).toBeUndefined();
  expect((await store.getApplyRun("apply_interleave"))?.status).toBe("running");
  expect(
    (await store.getPlanRun("plan_interleave"))?.appliedApplyRunId,
  ).toBeUndefined();
});

test("d1 store accepts operator-scoped connections without a Workspace id", async () => {
  const store = new CloudflareD1OpenTofuControlStore(new SqliteFakeD1());

  await store.putConnection({
    id: "conn_operator_cf",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    scope: "operator",
    credentialRecipe: {
      id: "generic-env",
      authMode: "env",
      secretPartition: "provider-credentials",
      declaredEnv: true,
    },
    secretPartition: "provider-credentials",
    kind: "generic_env_provider",
    status: "verified",
    materialization: "secret",
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
      lower.includes('from "runs"')
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
