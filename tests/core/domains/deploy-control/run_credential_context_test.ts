import { describe, expect, test } from "bun:test";
import {
  resolveCanonicalCapsuleRunCredentialContext,
  type CapsuleRunCredentialLedger,
} from "../../../../core/domains/deploy-control/run_credential_context.ts";
import { stateVersionIdForRecoveryRun } from "../../../../core/domains/deploy-control/operator_state_recovery.ts";

const CAPSULE = {
  id: "capsule_1",
  workspaceId: "workspace_1",
  installingPrincipalId: "principal_installer",
  status: "active",
};
const PLAN = {
  id: "plan_1",
  workspaceId: "workspace_1",
  capsuleId: "capsule_1",
  operation: "update",
  status: "running",
  capsuleContext: {
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    environment: "production",
  },
};
const APPLY = {
  id: "apply_1",
  planRunId: "plan_1",
  workspaceId: "workspace_1",
  capsuleId: "capsule_1",
  operation: "update",
  status: "running",
};

describe("canonical Capsule Run credential context", () => {
  test("returns only store-revalidated PlanRun and installer authority", async () => {
    const result = await resolveCanonicalCapsuleRunCredentialContext(
      ledger(),
      {
        workspaceId: "workspace_1",
        capsuleId: "capsule_1",
        runId: "plan_1",
        phase: "plan",
      },
    );
    expect(result).toEqual({
      ok: true,
      context: {
        workspaceId: "workspace_1",
        capsuleId: "capsule_1",
        runId: "plan_1",
        installingPrincipalId: "principal_installer",
        phase: "plan",
        lifecycleIntent: "provision",
      },
    });
  });

  test("rejects missing installer, destroyed Capsule, stale Run, and cross-Workspace lookup", async () => {
    for (const [overrides, reason] of [
      [{ capsule: { ...CAPSULE, installingPrincipalId: undefined } }, "capsule_unavailable"],
      [{ capsule: { ...CAPSULE, status: "destroyed" } }, "capsule_unavailable"],
      [{ plan: { ...PLAN, status: "succeeded" } }, "plan_run_mismatch"],
      [{ plan: { ...PLAN, workspaceId: "workspace_other" } }, "plan_run_mismatch"],
    ] as const) {
      expect(
        await resolveCanonicalCapsuleRunCredentialContext(
          ledger(overrides),
          {
            workspaceId: "workspace_1",
            capsuleId: "capsule_1",
            runId: "plan_1",
            phase: "plan",
          },
        ),
      ).toEqual({ ok: false, reason });
    }
  });

  test("requires ApplyRun destroy parity and the exact linked PlanRun", async () => {
    expect(
      await resolveCanonicalCapsuleRunCredentialContext(ledger(), {
        workspaceId: "workspace_1",
        capsuleId: "capsule_1",
        runId: "apply_1",
        phase: "apply",
      }),
    ).toMatchObject({
      ok: true,
      context: { phase: "apply", lifecycleIntent: "provision" },
    });

    expect(
      await resolveCanonicalCapsuleRunCredentialContext(ledger(), {
        workspaceId: "workspace_1",
        capsuleId: "capsule_1",
        runId: "apply_1",
        phase: "destroy",
      }),
    ).toEqual({ ok: false, reason: "apply_run_mismatch" });

    expect(
      await resolveCanonicalCapsuleRunCredentialContext(
        ledger({ plan: { ...PLAN, operation: "destroy" } }),
        {
          workspaceId: "workspace_1",
          capsuleId: "capsule_1",
          runId: "apply_1",
          phase: "apply",
        },
      ),
    ).toEqual({ ok: false, reason: "apply_plan_mismatch" });
  });

  test("keeps the exact running apply credential valid after provider dispatch", async () => {
    const safety = {
      phase: "unknown" as const,
      runId: "apply_1",
      runType: "apply" as const,
    };

    expect(
      await resolveCanonicalCapsuleRunCredentialContext(
        ledger({ safety }),
        {
          workspaceId: "workspace_1",
          capsuleId: "capsule_1",
          runId: "apply_1",
          phase: "apply",
        },
      ),
    ).toMatchObject({ ok: true, context: { runId: "apply_1", phase: "apply" } });

    expect(
      await resolveCanonicalCapsuleRunCredentialContext(
        ledger({ safety }),
        {
          workspaceId: "workspace_1",
          capsuleId: "capsule_1",
          runId: "plan_1",
          phase: "plan",
        },
      ),
    ).toEqual({ ok: false, reason: "runtime_safety_mismatch" });

    expect(
      await resolveCanonicalCapsuleRunCredentialContext(
        ledger({
          safety: { ...safety, runId: "apply_other" },
        }),
        {
          workspaceId: "workspace_1",
          capsuleId: "capsule_1",
          runId: "apply_1",
          phase: "apply",
        },
      ),
    ).toEqual({ ok: false, reason: "runtime_safety_mismatch" });
  });

  test("rejects unknown, terminating, and retired runtime safety for plan or apply", async () => {
    for (const safety of [
      { phase: "unknown", runId: "restore_1", runType: "restore" },
      {
        phase: "terminating",
        runId: "destroy_apply_other",
        runType: "destroy_apply",
      },
      {
        phase: "retired",
        runId: "destroy_apply_done",
        runType: "destroy_apply",
      },
    ] as const) {
      expect(
        await resolveCanonicalCapsuleRunCredentialContext(
          ledger({ safety }),
          {
            workspaceId: "workspace_1",
            capsuleId: "capsule_1",
            runId: "plan_1",
            phase: "plan",
          },
        ),
      ).toEqual({ ok: false, reason: "runtime_safety_mismatch" });
      expect(
        await resolveCanonicalCapsuleRunCredentialContext(
          ledger({ safety }),
          {
            workspaceId: "workspace_1",
            capsuleId: "capsule_1",
            runId: "apply_1",
            phase: "apply",
          },
        ),
      ).toEqual({ ok: false, reason: "runtime_safety_mismatch" });
    }
  });

  test("allows only the current terminating destroy Run for destroy issuance", async () => {
    const destroyPlan = { ...PLAN, operation: "destroy" };
    const destroyApply = { ...APPLY, operation: "destroy" };
    expect(
      await resolveCanonicalCapsuleRunCredentialContext(
        ledger({
          plan: destroyPlan,
          apply: destroyApply,
          safety: {
            phase: "terminating",
            runId: "apply_1",
            runType: "destroy_apply",
          },
        }),
        {
          workspaceId: "workspace_1",
          capsuleId: "capsule_1",
          runId: "apply_1",
          phase: "destroy",
        },
      ),
    ).toMatchObject({
      ok: true,
      context: { phase: "destroy", lifecycleIntent: "destroy" },
    });

    expect(
      await resolveCanonicalCapsuleRunCredentialContext(
        ledger({
          plan: destroyPlan,
          apply: destroyApply,
          safety: {
            phase: "terminating",
            runId: "apply_competing",
            runType: "destroy_apply",
          },
        }),
        {
          workspaceId: "workspace_1",
          capsuleId: "capsule_1",
          runId: "apply_1",
          phase: "destroy",
        },
      ),
    ).toEqual({ ok: false, reason: "runtime_safety_mismatch" });
  });

  test("allows a destroy Plan to inspect persisted partial state while ordinary Plans remain blocked", async () => {
    const unknown = {
      phase: "unknown" as const,
      runId: "apply_failed_partial",
      runType: "apply" as const,
    };

    expect(
      await resolveCanonicalCapsuleRunCredentialContext(
        ledger({ plan: { ...PLAN, operation: "destroy" }, safety: unknown }),
        {
          workspaceId: "workspace_1",
          capsuleId: "capsule_1",
          runId: "plan_1",
          phase: "plan",
        },
      ),
    ).toMatchObject({
      ok: true,
      context: { phase: "plan", lifecycleIntent: "destroy" },
    });

    expect(
      await resolveCanonicalCapsuleRunCredentialContext(
        ledger({ plan: { ...PLAN, operation: "update" }, safety: unknown }),
        {
          workspaceId: "workspace_1",
          capsuleId: "capsule_1",
          runId: "plan_1",
          phase: "plan",
        },
      ),
    ).toEqual({ ok: false, reason: "runtime_safety_mismatch" });
  });

  test("allows only an exact fresh plan and apply to reconcile persisted ordinary apply state", async () => {
    const capsule = {
      ...CAPSULE,
      currentStateVersionId: "state_partial_1",
    };
    const plan = {
      ...PLAN,
      capsuleCurrentStateVersionId: "state_partial_1",
    };
    const safety = {
      phase: "unknown" as const,
      runId: "apply_failed_partial",
      runType: "apply" as const,
    };
    const priorApply = {
      ...APPLY,
      id: "apply_failed_partial",
      status: "failed",
      stateVersionId: "state_partial_1",
      auditEvents: [{
        type: "apply.failed",
        data: {
          providerDispatched: true,
          providerApplySucceeded: false,
          statePersistence: "persisted",
          stateVersionId: "state_partial_1",
        },
      }],
    };

    for (const phase of ["plan", "apply"] as const) {
      expect(
        await resolveCanonicalCapsuleRunCredentialContext(
          ledger({ capsule, plan, priorApply, safety }),
          {
            workspaceId: "workspace_1",
            capsuleId: "capsule_1",
            runId: phase === "plan" ? "plan_1" : "apply_1",
            phase,
          },
        ),
      ).toMatchObject({ ok: true, context: { phase } });
    }

    for (const overrides of [
      {
        capsule: { ...capsule, currentStateVersionId: "state_other" },
      },
      {
        plan: { ...plan, capsuleCurrentStateVersionId: "state_other" },
      },
      {
        priorApply: { ...priorApply, stateVersionId: undefined },
      },
      {
        priorApply: {
          ...priorApply,
          auditEvents: [{
            type: "apply.failed",
            data: {
              providerDispatched: true,
              statePersistence: "unavailable",
            },
          }],
        },
      },
    ]) {
      expect(
        await resolveCanonicalCapsuleRunCredentialContext(
          ledger({ capsule, plan, priorApply, safety, ...overrides }),
          {
            workspaceId: "workspace_1",
            capsuleId: "capsule_1",
            runId: "plan_1",
            phase: "plan",
          },
        ),
      ).toEqual({ ok: false, reason: "runtime_safety_mismatch" });
    }
  });

  test("Destroy issuance accepts only the exact persisted partial-state predecessor", async () => {
    const capsule = { ...CAPSULE, currentStateVersionId: "state_partial_1" };
    const plan = {
      ...PLAN,
      operation: "destroy",
      capsuleCurrentStateVersionId: "state_partial_1",
    };
    const apply = { ...APPLY, operation: "destroy" };
    const safety = {
      phase: "terminating",
      runId: "apply_1",
      runType: "destroy_apply",
    };
    const priorSafety = {
      phase: "unknown",
      runId: "apply_failed_partial",
      runType: "apply",
    };
    const priorApply = {
      ...APPLY,
      id: "apply_failed_partial",
      status: "failed",
      stateVersionId: "state_partial_1",
      auditEvents: [{
        type: "apply.failed",
        data: {
          providerDispatched: true,
          providerApplySucceeded: false,
          statePersistence: "persisted",
          stateVersionId: "state_partial_1",
        },
      }],
    };
    const input = {
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      runId: "apply_1",
      phase: "destroy" as const,
    };
    expect(await resolveCanonicalCapsuleRunCredentialContext(
      ledger({ capsule, plan, apply, safety, priorSafety, priorApply }), input,
    )).toMatchObject({ ok: true, context: { lifecycleIntent: "destroy" } });
    expect(await resolveCanonicalCapsuleRunCredentialContext(
      ledger({
        capsule, plan, apply, safety, priorSafety,
        priorApply: { ...priorApply, stateVersionId: "state_other" },
      }), input,
    )).toEqual({ ok: false, reason: "runtime_safety_mismatch" });
    expect(await resolveCanonicalCapsuleRunCredentialContext(
      ledger({
        capsule, plan, apply, safety, priorSafety,
        priorApply: { ...priorApply, auditEvents: [] },
      }), input,
    )).toEqual({ ok: false, reason: "runtime_safety_mismatch" });
  });

  test("only exact recovered initial-create state admits a newly reviewed destroy", async () => {
    const stateId = await stateVersionIdForRecoveryRun("recovery_1");
    const digest = `sha256:${"a".repeat(64)}`;
    const capsule = {
      ...CAPSULE,
      status: "error",
      sourceId: "source_1",
      environment: "production",
      currentStateVersionId: stateId,
      currentStateGeneration: 1,
    };
    const plan = {
      ...PLAN,
      operation: "destroy",
      status: "succeeded",
      baseStateGeneration: 1,
      capsuleCurrentStateVersionId: stateId,
      capsuleExecutionAuthorityEpoch: 2,
      approval: { approvedAt: 2 },
    };
    const apply = {
      ...APPLY,
      operation: "destroy",
      expected: { currentStateVersionId: stateId, capsuleExecutionAuthorityEpoch: 2 },
    };
    const originalPlan = {
      ...PLAN,
      id: "plan_initial",
      operation: "create",
      status: "succeeded",
      sourceSnapshotId: "snapshot_initial",
      source: { kind: "git", url: "https://example.test/repo.git", commit: "a".repeat(40) },
    };
    const failed = {
      ...APPLY,
      id: "apply_failed_initial",
      planRunId: originalPlan.id,
      operation: "create",
      status: "failed",
      auditEvents: [{ type: "apply.failed", data: { providerDispatched: true, statePersistence: "unavailable" } }],
    };
    const recovery = {
      id: "recovery_1",
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      environment: "production",
      type: "state_recovery",
      status: "succeeded",
      finishedAt: "2026-09-30T00:00:00.000Z",
      planRunId: originalPlan.id,
      sourceSnapshotId: "snapshot_initial",
      stateRecovery: {
        failedApplyRunId: failed.id,
        recoveredStateVersionId: stateId,
        sourceSnapshotId: "snapshot_initial",
        plaintextSha256: digest,
      },
    };
    const stateVersion = {
      id: stateId,
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      environment: "production",
      generation: 1,
      digest,
      createdByRunId: recovery.id,
      createdAt: "2026-09-30T00:00:00.000Z",
    };
    const snapshot = {
      id: "snapshot_initial",
      workspaceId: "workspace_1",
      sourceId: "source_1",
      origin: "git",
      url: "https://example.test/repo.git",
      resolvedCommit: "a".repeat(40),
    };
    const safety = { phase: "terminating", runId: apply.id, runType: "destroy_apply" };
    const priorSafety = { phase: "unknown", runId: failed.id, runType: "apply" };
    const rows = { capsule, plan, apply, originalPlan, priorApply: failed, recovery, stateVersion, snapshot, safety, priorSafety };
    const input = { workspaceId: "workspace_1", capsuleId: "capsule_1", runId: apply.id, phase: "destroy" as const };

    expect(await resolveCanonicalCapsuleRunCredentialContext(ledger(rows), input))
      .toMatchObject({ ok: true, context: { lifecycleIntent: "destroy" } });

    for (const overrides of [
      { priorSafety: { ...priorSafety, runId: "apply_other" } },
      { priorSafety: { ...priorSafety, runType: "restore" } },
      { recovery: { ...recovery, status: "failed" } },
      { recovery: { ...recovery, executionEvidence: {} } },
      { recovery: { ...recovery, stateRecovery: { ...recovery.stateRecovery, failedApplyRunId: "apply_other" } } },
      { recovery: { ...recovery, stateRecovery: { ...recovery.stateRecovery, recoveredStateVersionId: "state_other" } } },
      { stateVersion: { ...stateVersion, id: "state_other" } },
      { stateVersion: { ...stateVersion, digest: `sha256:${"b".repeat(64)}` } },
      { stateVersion: { ...stateVersion, workspaceId: "workspace_other" } },
      { stateVersion: { ...stateVersion, createdByRunId: "recovery_other" } },
      { stateVersion: { ...stateVersion, createdAt: "2026-09-30T00:00:01.000Z" } },
      {
        capsule: { ...capsule, currentStateVersionId: "state_forged" },
        stateVersion: { ...stateVersion, id: "state_forged" },
        plan: { ...plan, capsuleCurrentStateVersionId: "state_forged" },
        apply: { ...apply, expected: { ...apply.expected, currentStateVersionId: "state_forged" } },
        recovery: {
          ...recovery,
          stateRecovery: { ...recovery.stateRecovery, recoveredStateVersionId: "state_forged" },
        },
      },
      { capsule: { ...capsule, currentStateGeneration: 2 } },
      { capsule: { ...capsule, currentOutputId: "output_other" } },
      { plan: { ...plan, baseStateGeneration: 0 } },
      { plan: { ...plan, approval: undefined } },
      { plan: { ...plan, capsuleExecutionAuthorityEpoch: 1 } },
      { plan: { ...plan, capsuleCurrentStateVersionId: "state_other" } },
      { apply: { ...apply, expected: { currentStateVersionId: "state_other" } } },
      { originalPlan: { ...originalPlan, sourceSnapshotId: "snapshot_other" } },
      { originalPlan: { ...originalPlan, capsuleId: "capsule_other" } },
      { priorApply: { ...failed, stateVersionId: stateId } },
      { priorApply: { ...failed, workspaceId: "workspace_other" } },
      { priorApply: { ...failed, executionEvidence: {} } },
      { snapshot: { ...snapshot, sourceId: "source_other" } },
    ]) {
      expect(await resolveCanonicalCapsuleRunCredentialContext(ledger({ ...rows, ...overrides }), input))
        .toEqual({ ok: false, reason: "runtime_safety_mismatch" });
    }

    const ordinaryPlan = { ...plan, operation: "update", status: "running" };
    const ordinaryApply = { ...apply, operation: "update" };
    expect(await resolveCanonicalCapsuleRunCredentialContext(
      ledger({ ...rows, plan: ordinaryPlan, apply: ordinaryApply, safety: priorSafety }),
      { ...input, runId: plan.id, phase: "plan" },
    )).toEqual({ ok: false, reason: "runtime_safety_mismatch" });
    expect(await resolveCanonicalCapsuleRunCredentialContext(
      ledger({ ...rows, plan: ordinaryPlan, apply: ordinaryApply, safety: priorSafety }),
      { ...input, phase: "apply" },
    )).toEqual({ ok: false, reason: "runtime_safety_mismatch" });
  });

  test("allows a fresh plan and apply after an exact committed post-apply failure", async () => {
    const capsule = {
      ...CAPSULE,
      status: "error",
      environment: "production",
      currentStateVersionId: "state_applied_1",
      currentStateGeneration: 7,
      currentOutputId: "output_applied_1",
    };
    const plan = {
      ...PLAN,
      capsuleCurrentStateVersionId: "state_applied_1",
    };
    const safety = {
      phase: "unknown" as const,
      runId: "apply_failed_post_apply",
      runType: "apply" as const,
    };
    const completedAudit = (
      dataOverrides: Record<string, unknown> = {},
    ) => [{
      type: "apply.completed",
      data: {
        stateVersionId: "state_applied_1",
        outputId: "output_applied_1",
        ...dataOverrides,
      },
    }];
    const failedAudit = (
      dataOverrides: Record<string, unknown> = {},
      type = "apply.failed",
    ) => [{
      type,
      data: {
        providerDispatched: true,
        providerApplySucceeded: true,
        lifecycleActionPhase: "post_apply",
        lifecycleActionStatus: "failed",
        ...dataOverrides,
      },
    }];
    const priorApply = {
      ...APPLY,
      id: "apply_failed_post_apply",
      status: "failed",
      stateVersionId: "state_applied_1",
      outputId: "output_applied_1",
      auditEvents: [...completedAudit(), ...failedAudit()],
    };
    const stateVersion = {
      id: "state_applied_1",
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      environment: "production",
      generation: 7,
      stateRef: "state/ref/7",
      digest: "sha256:state",
      createdByRunId: "apply_failed_post_apply",
      createdAt: "2026-08-26T00:00:00.000Z",
    };
    const output = {
      id: "output_applied_1",
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      stateGeneration: 7,
      rawArtifactRef: "output/ref/7",
      publicOutputs: {},
      workspaceOutputs: {},
      outputDigest: "sha256:output",
      createdAt: "2026-08-26T00:00:00.000Z",
    };

    for (const phase of ["plan", "apply"] as const) {
      expect(
        await resolveCanonicalCapsuleRunCredentialContext(
          ledger({ capsule, plan, priorApply, stateVersion, output, safety }),
          {
            workspaceId: "workspace_1",
            capsuleId: "capsule_1",
            runId: phase === "plan" ? "plan_1" : "apply_1",
            phase,
          },
        ),
      ).toMatchObject({ ok: true, context: { phase } });
    }

    const destroyPlan = { ...plan, operation: "destroy" };
    const destroyInput = {
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      runId: "apply_1",
      phase: "destroy" as const,
    };
    const destroyRows = {
      capsule,
      plan: destroyPlan,
      apply: { ...APPLY, operation: "destroy" },
      priorApply,
      stateVersion,
      output,
      safety: { phase: "terminating", runId: "apply_1", runType: "destroy_apply" },
      priorSafety: safety,
    };
    expect(
      await resolveCanonicalCapsuleRunCredentialContext(
        ledger(destroyRows), destroyInput,
      ),
    ).toMatchObject({ ok: true, context: { lifecycleIntent: "destroy" } });
    for (const staleRows of [
      { capsule: { ...capsule, currentStateVersionId: "state_other" } },
      { capsule: { ...capsule, currentOutputId: "output_other" } },
      { stateVersion: { ...stateVersion, createdByRunId: "apply_other" } },
      { output: { ...output, stateGeneration: 8 } },
      {
        capsule: {
          ...capsule,
          currentStateVersionId: undefined,
          currentOutputId: undefined,
        },
        plan: { ...destroyPlan, capsuleCurrentStateVersionId: undefined },
      },
    ]) {
      expect(
        await resolveCanonicalCapsuleRunCredentialContext(
          ledger({ ...destroyRows, ...staleRows }), destroyInput,
        ),
      ).toEqual({ ok: false, reason: "runtime_safety_mismatch" });
    }

    for (const lifecycleActionStatus of [
      "failed",
      "skipped",
      "unavailable",
      "error",
    ]) {
      expect(
        await resolveCanonicalCapsuleRunCredentialContext(
          ledger({
            capsule,
            plan,
            priorApply: {
              ...priorApply,
              auditEvents: [
                ...completedAudit(),
                ...failedAudit({ lifecycleActionStatus }),
              ],
            },
            stateVersion,
            output,
            safety,
          }),
          {
            workspaceId: "workspace_1",
            capsuleId: "capsule_1",
            runId: "plan_1",
            phase: "plan",
          },
        ),
      ).toMatchObject({ ok: true, context: { phase: "plan" } });
    }

    for (const overrides of [
      { capsule: { ...capsule, status: "active" } },
      {
        capsule: { ...capsule, currentStateVersionId: "state_other" },
      },
      {
        capsule: { ...capsule, currentStateVersionId: undefined },
        plan: { ...plan, capsuleCurrentStateVersionId: undefined },
      },
      { capsule: { ...capsule, currentOutputId: "output_other" } },
      {
        capsule: { ...capsule, currentOutputId: undefined },
        priorApply: { ...priorApply, outputId: undefined },
      },
      { priorApply: { ...priorApply, operation: "destroy" } },
      { priorApply: { ...priorApply, status: "succeeded" } },
      { priorApply: { ...priorApply, stateVersionId: "state_other" } },
      { priorApply: { ...priorApply, outputId: "output_other" } },
      { stateVersion: null },
      {
        stateVersion: { ...stateVersion, workspaceId: "workspace_other" },
      },
      {
        stateVersion: { ...stateVersion, capsuleId: "capsule_other" },
      },
      {
        stateVersion: { ...stateVersion, environment: "staging" },
      },
      {
        stateVersion: { ...stateVersion, generation: 8 },
      },
      {
        stateVersion: {
          ...stateVersion,
          createdByRunId: "apply_succeeded_other",
        },
      },
      { output: null },
      { output: { ...output, workspaceId: "workspace_other" } },
      { output: { ...output, capsuleId: "capsule_other" } },
      { output: { ...output, stateGeneration: 8 } },
      {
        priorApply: {
          ...priorApply,
          auditEvents: failedAudit(),
        },
      },
      {
        priorApply: {
          ...priorApply,
          auditEvents: completedAudit(),
        },
      },
      {
        priorApply: {
          ...priorApply,
          auditEvents: [
            ...completedAudit(),
            ...completedAudit(),
            ...failedAudit(),
          ],
        },
      },
      {
        priorApply: {
          ...priorApply,
          auditEvents: [
            ...completedAudit(),
            ...failedAudit(),
            ...failedAudit({ providerApplySucceeded: false }),
          ],
        },
      },
      {
        priorApply: {
          ...priorApply,
          auditEvents: [...failedAudit(), ...completedAudit()],
        },
      },
      {
        priorApply: {
          ...priorApply,
          auditEvents: [
            ...completedAudit({ stateVersionId: "state_other" }),
            ...failedAudit(),
          ],
        },
      },
      {
        priorApply: {
          ...priorApply,
          auditEvents: [
            ...completedAudit({ outputId: "output_other" }),
            ...failedAudit(),
          ],
        },
      },
      {
        priorApply: {
          ...priorApply,
          auditEvents: [
            ...completedAudit({ outputId: undefined }),
            ...failedAudit(),
          ],
        },
      },
      {
        priorApply: {
          ...priorApply,
          auditEvents: [
            ...completedAudit(),
            ...failedAudit({ providerDispatched: false }),
          ],
        },
      },
      {
        priorApply: {
          ...priorApply,
          auditEvents: [
            ...completedAudit(),
            ...failedAudit({ providerApplySucceeded: false }),
          ],
        },
      },
      {
        priorApply: {
          ...priorApply,
          auditEvents: [
            ...completedAudit(),
            ...failedAudit({ lifecycleActionPhase: "pre_apply" }),
          ],
        },
      },
      ...["succeeded", "pending", "not_applicable", "indeterminate"].map(
        (lifecycleActionStatus) => ({
          priorApply: {
            ...priorApply,
            auditEvents: [
              ...completedAudit(),
              ...failedAudit({ lifecycleActionStatus }),
            ],
          },
        }),
      ),
      {
        safety: { ...safety, runId: "apply_failed_other" },
      },
    ]) {
      expect(
        await resolveCanonicalCapsuleRunCredentialContext(
          ledger({
            capsule,
            plan,
            priorApply,
            stateVersion,
            output,
            safety,
            ...overrides,
          }),
          {
            workspaceId: "workspace_1",
            capsuleId: "capsule_1",
            runId: "plan_1",
            phase: "plan",
          },
        ),
      ).toEqual({ ok: false, reason: "runtime_safety_mismatch" });
    }
  });

  test("fails closed on a runtime phase outside the public union", async () => {
    expect(
      await resolveCanonicalCapsuleRunCredentialContext(ledger(), {
        workspaceId: "workspace_1",
        capsuleId: "capsule_1",
        runId: "apply_1",
        phase: "source",
      } as never),
    ).toEqual({ ok: false, reason: "invalid_context" });
  });
});

function ledger(
  overrides: {
    readonly capsule?: Record<string, unknown>;
    readonly plan?: Record<string, unknown>;
    readonly apply?: Record<string, unknown>;
    readonly priorApply?: Record<string, unknown>;
    readonly originalPlan?: Record<string, unknown>;
    readonly recovery?: Record<string, unknown>;
    readonly snapshot?: Record<string, unknown>;
    readonly stateVersion?: Record<string, unknown> | null;
    readonly output?: Record<string, unknown> | null;
    readonly safety?: Record<string, unknown>;
    readonly priorSafety?: Record<string, unknown>;
  } = {},
): CapsuleRunCredentialLedger {
  const capsule = overrides.capsule ?? CAPSULE;
  const plan = overrides.plan ?? PLAN;
  const apply = overrides.apply ?? APPLY;
  const priorApply = overrides.priorApply;
  const stateVersion = overrides.stateVersion ?? undefined;
  const output = overrides.output ?? undefined;
  return {
    getCapsule: async (id) => (id === capsule.id ? capsule : undefined) as never,
    getPlanRun: async (id) =>
      (id === plan.id ? plan : id === overrides.originalPlan?.id ? overrides.originalPlan : undefined) as never,
    getApplyRun: async (id) =>
      (id === apply.id ? apply : id === priorApply?.id ? priorApply : undefined) as never,
    getStateVersion: async (id) =>
      (id === stateVersion?.id ? stateVersion : undefined) as never,
    getStateRecoveryRun: async (id) =>
      (id === overrides.recovery?.id ? overrides.recovery : undefined) as never,
    getSourceSnapshot: async (id) =>
      (id === overrides.snapshot?.id ? overrides.snapshot : undefined) as never,
    getOutput: async (id) => (id === output?.id ? output : undefined) as never,
    getCapsuleRuntimeSafety: async (_capsuleId, options) =>
      (options?.excludeRunId === overrides.safety?.runId
        ? overrides.priorSafety
        : overrides.safety) as never,
  };
}
