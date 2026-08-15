import { describe, expect, test } from "bun:test";
import {
  resolveCanonicalCapsuleRunCredentialContext,
  type CapsuleRunCredentialLedger,
} from "../../../../core/domains/deploy-control/run_credential_context.ts";

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
    ).toMatchObject({ ok: true, context: { phase: "apply" } });

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
    ).toMatchObject({ ok: true, context: { phase: "destroy" } });

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
    ).toMatchObject({ ok: true, context: { phase: "plan" } });

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
    readonly safety?: Record<string, unknown>;
  } = {},
): CapsuleRunCredentialLedger {
  const capsule = overrides.capsule ?? CAPSULE;
  const plan = overrides.plan ?? PLAN;
  const apply = overrides.apply ?? APPLY;
  const priorApply = overrides.priorApply;
  return {
    getCapsule: async (id) => (id === capsule.id ? capsule : undefined) as never,
    getPlanRun: async (id) => (id === plan.id ? plan : undefined) as never,
    getApplyRun: async (id) =>
      (id === apply.id ? apply : id === priorApply?.id ? priorApply : undefined) as never,
    getCapsuleRuntimeSafety: async () => overrides.safety as never,
  };
}
