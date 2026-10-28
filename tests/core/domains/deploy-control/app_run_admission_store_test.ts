import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";
import {
  CapsuleApplyRunAdmissionConflictError,
  CapsulePlanCreationFenceConflictError,
  capsuleApplyRunAdmissionFence,
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

setDefaultTimeout(30_000);
const clients: PGliteSqlClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const client = await PGliteSqlClient.create();
  clients.push(client);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

function plan(capsule: Capsule, id: string, ownershipEpoch = 0, appManagementEpoch = 0): PlanRun {
  return {
    id, workspaceId: capsule.workspaceId, capsuleId: capsule.id,
    createdBy: "owner", ownershipEpoch, appManagementEpoch,
    source: { kind: "git", url: "https://git.example.test/app.git", commit: "0123456789abcdef0123456789abcdef01234567" },
    sourceDigest: "sha256:source", operation: "update", runnerProfileId: "runner",
    variablesDigest: "sha256:variables", executionInputsDigest: "sha256:inputs",
    requiredProviders: [], requiredProviderRequirements: [], status: "queued",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy", auditEvents: [], createdAt: 1, updatedAt: 1,
  };
}

function apply(planRun: PlanRun, capsule: Capsule, id: string): ApplyRun {
  return {
    id, planRunId: planRun.id, workspaceId: capsule.workspaceId, capsuleId: capsule.id,
    operation: "update", runnerProfileId: "runner", status: "queued",
    expected: {
      planRunId: planRun.id, capsuleId: capsule.id, currentStateVersionId: capsule.currentStateVersionId ?? null,
      capsuleExecutionAuthorityEpoch: 1, runnerProfileId: "runner", sourceDigest: planRun.sourceDigest,
      variablesDigest: planRun.variablesDigest, policyDecisionDigest: "sha256:policy",
      planDigest: "sha256:plan", planArtifactDigest: "sha256:artifact",
    },
    stateBackend: { kind: "operator-managed", ref: "state" },
    stateLock: { status: "pending", backendRef: "state" },
    auditEvents: [], createdAt: 1, updatedAt: 1,
  };
}

function workspaceAuthority(capsule: Capsule): WorkspaceManagementAuthority {
  return { workspaceId: capsule.workspaceId, managementState: "active", managementEpoch: 1 };
}

async function prepare(store: OpenTofuControlStore, run: PlanRun, authority: WorkspaceManagementAuthority) {
  return await store.preparePlanRun({ run, inputs: { planRunId: run.id, variables: {} },
    expectedWorkspaceManagementAuthority: authority });
}

async function claim(store: OpenTofuControlStore, run: PlanRun | ApplyRun,
  kind: "plan" | "apply", stale = false, heartbeatAt = 2) {
  return await store.transitionRun({
    id: run.id, kind, expectFrom: [stale ? "running" : "queued"],
    ...(stale ? { expectHeartbeatAt: run.heartbeatAt ?? null } : {}),
    setLeaseToken: `lease-${run.id}-${heartbeatAt}`, heartbeatAt,
    run: { ...run, status: "running", startedAt: run.startedAt ?? 1, heartbeatAt },
  });
}

test("owned app Run admission fences new Plan, Apply, queued claim, and drain ABA in every store", async () => {
  for (const [label, store] of await stores()) {
    const { capsule: legacy } = await seedCapsuleModel(store, { capsuleId: `cap_app_run_${label}` });
    const authority = workspaceAuthority(legacy);
    const capsule: Capsule = { ...legacy, ownerAccountId: "owner", ownershipEpoch: 0,
      managementState: "active", managementEpoch: 0 };
    await store.putCapsule(capsule);
    await expect(prepare(store, plan(capsule, `plan_owner_epoch_${label}`, 1, 0), authority), label)
      .rejects.toBeInstanceOf(CapsulePlanCreationFenceConflictError);
    await expect(prepare(store, plan(capsule, `plan_management_epoch_${label}`, 0, 1), authority), label)
      .rejects.toBeInstanceOf(CapsulePlanCreationFenceConflictError);
    const queued = plan(capsule, `plan_queued_${label}`);
    expect((await prepare(store, queued, authority)).status, label).toBe("created");
    const activePlan = plan(capsule, `plan_running_${label}`);
    await prepare(store, activePlan, authority);
    const claimed = await claim(store, activePlan, "plan");
    expect(claimed.won, label).toBe(true);
    const applyRow = apply(activePlan, capsule, `apply_queued_${label}`);
    expect((await store.beginApplyRun(applyRow, authority, capsuleApplyRunAdmissionFence(capsule, 1))).status, label)
      .toBe("created");
    const activeApply = apply(activePlan, capsule, `apply_running_${label}`);
    await store.beginApplyRun(activeApply, authority, capsuleApplyRunAdmissionFence(capsule, 1));
    const claimedApply = await claim(store, activeApply, "apply");
    expect(claimedApply.won, label).toBe(true);

    const draining: Capsule = { ...capsule, managementState: "draining", managementEpoch: 1 };
    await store.putCapsule(draining);
    expect((await prepare(store, queued, authority)).status, label).toBe("existing");
    await expect(prepare(store, plan(capsule, `plan_drain_${label}`), authority), label)
      .rejects.toBeInstanceOf(CapsulePlanCreationFenceConflictError);
    expect((await claim(store, queued, "plan")).won, label).toBe(false);
    expect((await claim(store, applyRow, "apply")).won, label).toBe(false);
    await expect(store.beginApplyRun(apply(queued, capsule, `apply_drain_${label}`), authority,
      capsuleApplyRunAdmissionFence(capsule, 1)), label)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
    const continuation = await claim(store, claimed.run as PlanRun, "plan", true, 3);
    expect(continuation.won, label).toBe(true);
    const applyContinuation = await claim(store, claimedApply.run as ApplyRun, "apply", true, 3);
    expect(applyContinuation.won, label).toBe(true);
    const settled = { ...(continuation.run as PlanRun), status: "failed" as const, updatedAt: 4 };
    expect((await store.transitionRun({ id: settled.id, kind: "plan", expectFrom: ["running"],
      expectLeaseToken: `lease-${settled.id}-3`, clearLeaseToken: true, run: settled })).won, label).toBe(true);
    await store.putCapsule({ ...draining, managementState: "frozen" });
    expect((await claim(store, applyContinuation.run as ApplyRun, "apply", true, 4)).won, label)
      .toBe(false);

    const resumed: Capsule = { ...capsule, managementEpoch: 2 };
    await store.putCapsule(resumed);
    expect((await claim(store, queued, "plan")).won, label).toBe(false);
    await expect(store.beginApplyRun(apply(queued, resumed, `apply_aba_${label}`), authority,
      capsuleApplyRunAdmissionFence(resumed, 1)), label)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
    expect((await prepare(store, plan(resumed, `plan_fresh_${label}`, 0, 2), authority)).status, label)
      .toBe("created");

    const transferred: Capsule = { ...resumed, ownerAccountId: "recipient", ownershipEpoch: 1,
      managementEpoch: 3 };
    await store.putCapsule(transferred);
    expect((await claim(store, queued, "plan")).won, label).toBe(false);
    await expect(store.beginApplyRun(apply(queued, transferred, `apply_transfer_${label}`), authority,
      capsuleApplyRunAdmissionFence(transferred, 1)), label)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
    expect((await claim(store, applyContinuation.run as ApplyRun, "apply", true, 4)).won, label)
      .toBe(false);
    // Losing the Capsule's owner tags must not turn a pinned Plan into a
    // legacy Plan that can be dispatched or applied.
    await store.putCapsule(legacy);
    expect((await claim(store, queued, "plan")).won, label).toBe(false);
    await expect(store.beginApplyRun(apply(queued, legacy, `apply_tags_lost_${label}`), authority,
      capsuleApplyRunAdmissionFence(legacy, 1)), label)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
  }
});

test("owned app incomplete metadata fails closed while legacy provider-free Plan apply remains valid", async () => {
  for (const [label, store] of await stores()) {
    const { capsule: legacy } = await seedCapsuleModel(store, { capsuleId: `cap_app_partial_${label}` });
    const authority = workspaceAuthority(legacy);
    const oldPlan = plan(legacy, `plan_legacy_${label}`);
    const { ownershipEpoch: _owner, appManagementEpoch: _management, ...legacyPlan } = oldPlan;
    await store.putPlanRun(legacyPlan);
    expect((await store.beginApplyRun(apply(legacyPlan, legacy, `apply_legacy_${label}`), authority,
      capsuleApplyRunAdmissionFence(legacy, 1))).status, label).toBe("created");
    await store.putCapsule({ ...legacy, ownerAccountId: "owner" });
    await expect(prepare(store, plan(legacy, `plan_partial_${label}`), authority), label)
      .rejects.toBeInstanceOf(CapsulePlanCreationFenceConflictError);
    await expect(store.beginApplyRun(apply(legacyPlan, legacy, `apply_partial_${label}`), authority,
      capsuleApplyRunAdmissionFence(legacy, 1)), label)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
  }
});
