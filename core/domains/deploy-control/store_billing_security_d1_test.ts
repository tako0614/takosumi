import { expect, test } from "bun:test";

import { CloudflareD1OpenTofuDeploymentStore } from "../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "./sqlite_fake_d1.ts";

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
