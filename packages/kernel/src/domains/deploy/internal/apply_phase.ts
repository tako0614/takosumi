// Apply phase — resolved → applied | failed transition.
//
// `executeApply` owns the canonical Phase 10D pipeline (Core spec § 13):
// approval gate, preflight validators, resolved→applying transition,
// provider operation dispatch, optional GroupHead CAS, ActivationCommitted
// finalisation, and the C1 reverse-order rollback of committed operations
// on partial failure. Extracted from `DeploymentService.#applyDeployment`
// so the orchestrator file no longer carries ~300 lines of apply-pipeline
// branching; the service now passes a small deps bundle (store,
// providerAdapter, clock) and delegates here.

import type {
  Deployment,
  DeploymentCondition,
  IsoTimestamp,
} from "takosumi-contract";
import {
  activationCommittedCondition,
  applyFailedCondition,
  applyRolledBackCondition,
  type DeploymentProviderAdapter,
  operationCondition,
  type OperationOutcome,
  operationRolledBackCondition,
  type PlannedOperation,
  planProviderOperations,
} from "../apply_orchestrator.ts";
import type {
  AdvanceGroupHeadInput,
  ApplyDeploymentInput,
  DeploymentStore,
} from "../deployment_service.ts";
import {
  appendCondition,
  applyingTransition,
  approvalRequiredCondition,
  isMissingOptionalStoreMethod,
  runPreflightValidator,
  validateDeploymentApproval,
} from "./deployment_conditions.ts";
import { deepFreeze } from "./hash.ts";

export interface ApplyPhaseDeps {
  readonly store: DeploymentStore;
  readonly providerAdapter: DeploymentProviderAdapter;
  readonly clock: () => Date;
}

export async function executeApply(
  deps: ApplyPhaseDeps,
  input: ApplyDeploymentInput,
): Promise<Deployment> {
  const current = await deps.store.getDeployment(input.deploymentId);
  if (!current) {
    throw new Error(`unknown deployment: ${input.deploymentId}`);
  }
  if (current.status !== "resolved" && current.status !== "applying") {
    // Finalized applies are rejected so callers (apply_worker, smoke tests)
    // see a clear stale-precondition error instead of silently re-running
    // provider operations. A prior crash may leave the record in `applying`;
    // that state is resumed below with the same operation keys.
    throw new Error(
      `deployment ${current.id} is not in 'resolved' status (got '${current.status}')`,
    );
  }

  const appliedAt = input.appliedAt ?? deps.clock().toISOString();

  // H4 — Approval gate. When the resolution carried at least one
  // `require-approval` policy decision, apply MUST receive an `approval`
  // payload (either via `input.approval` or already attached to the
  // resolved Deployment by `approveDeployment`). Missing approval finalises
  // the Deployment as `failed` with an `ApprovalRequired` condition rather
  // than letting the apply silently advance to provider materialisation.
  const requireApproval = (current.policy_decisions ?? []).some(
    (decision) => decision.decision === "require-approval",
  );
  const effectiveApproval = input.approval ?? current.approval ?? null;
  if (effectiveApproval) {
    validateDeploymentApproval(current, effectiveApproval, appliedAt);
  }
  if (requireApproval && !effectiveApproval) {
    const failedConditions = appendCondition(
      current.conditions,
      approvalRequiredCondition({
        observedGeneration: current.conditions.length + 1,
        observedAt: appliedAt,
        decisions: current.policy_decisions ?? [],
      }),
    );
    const failed: Deployment = {
      ...current,
      status: "failed",
      conditions: failedConditions,
      finalized_at: appliedAt,
    };
    return await deps.store.putDeployment(deepFreeze(failed));
  }

  // Phase 17D — preflight validators. Each hook is invoked against the
  // immutable `resolved` Deployment before any state transition. A
  // validator returning `ok=false` aborts apply with no committed state
  // change so the caller observes the stale read-set / drift / source
  // snapshot signal directly on the resolved record.
  await runPreflightValidator(
    "ReadSetStale",
    input.readSetValidator,
    current,
  );
  await runPreflightValidator(
    "DescriptorClosureDrift",
    input.descriptorClosureValidator,
    current,
  );
  await runPreflightValidator(
    "SourceSnapshotInvalid",
    input.sourceSnapshotValidator,
    current,
  );

  const implicitHeadPrecondition = "expectedCurrentDeploymentId" in input
    ? undefined
    : await deps.store.getGroupHead({
      spaceId: current.space_id,
      groupId: current.group_id,
    });

  // Step 1: transition resolved → applying so consumers observing the store
  // mid-apply see a progressing Deployment rather than a stuck `resolved`
  // record. The phase condition lives on conditions[] (scope=phase).
  const applyingDeployment = current.status === "applying"
    ? current
    : applyingTransition(current, appliedAt);
  if (current.status !== "applying") {
    await deps.store.putDeployment(deepFreeze(applyingDeployment));
  }

  // Step 2: plan provider operations from the resolved-graph projections.
  const operations = planProviderOperations(applyingDeployment);

  // Step 3: dispatch each operation through the provider adapter. Conditions
  // accumulate as we go so a partial failure leaves enough breadcrumbs on
  // the Deployment for downstream observability. C1 — successful operations
  // are recorded so a subsequent failure can revert them in reverse order.
  let conditions: readonly DeploymentCondition[] =
    applyingDeployment.conditions;
  let failure:
    | { operation: PlannedOperation; reason: string; message?: string }
    | undefined;
  const committed: PlannedOperation[] = [];
  for (const operation of operations) {
    let outcome: OperationOutcome;
    try {
      outcome = await deps.providerAdapter.materialize(
        applyingDeployment,
        operation,
      );
    } catch (error) {
      outcome = {
        success: false,
        reason: "ProviderMaterializationThrew",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    conditions = appendCondition(
      conditions,
      operationCondition({
        operation,
        outcome,
        observedGeneration: conditions.length + 1,
        observedAt: appliedAt,
      }),
    );
    if (!outcome.success) {
      failure = {
        operation,
        reason: outcome.reason,
        message: outcome.message,
      };
      break;
    }
    committed.push(operation);
  }

  // Step 4: terminate. On failure we mark the Deployment `failed` and skip
  // the GroupHead advance; on success we advance and record the
  // ActivationCommitted condition. Both branches finalize via a single
  // putDeployment write so the persisted state is internally consistent.
  if (failure) {
    // C1 — Multi-cloud partial-success cleanup. Revert each previously
    // committed operation in reverse order so a Cloudflare commit followed
    // by an AWS failure does not leave the CF side dangling. The terminal
    // condition records both the ApplyFailed reason and the rollback
    // outcome (RolledBack vs RolledBackPartial).
    const rollbackResult = await rollbackCommittedOperations(deps, {
      deployment: applyingDeployment,
      committed,
      observedAt: appliedAt,
      startingGeneration: conditions.length + 1,
    });
    conditions = [...conditions, ...rollbackResult.conditions];
    const failedConditions = appendCondition(
      appendCondition(
        conditions,
        applyFailedCondition({
          operation: failure.operation,
          outcome: {
            success: false,
            reason: failure.reason,
            message: failure.message,
          },
          observedGeneration: conditions.length + 1,
          observedAt: appliedAt,
        }),
      ),
      applyRolledBackCondition({
        observedGeneration: conditions.length + 2,
        observedAt: appliedAt,
        partial: rollbackResult.partial,
        revertedCount: rollbackResult.revertedCount,
        failedRevertCount: rollbackResult.failedRevertCount,
      }),
    );
    const failed: Deployment = {
      ...applyingDeployment,
      status: "failed",
      conditions: failedConditions,
      finalized_at: appliedAt,
    };
    return await deps.store.putDeployment(deepFreeze(failed));
  }

  // GroupHead CAS — Phase 17D. When the caller pins
  // `expectedCurrentDeploymentId`, the store rejects the commit if the
  // observed pointer differs. The reject path rolls back provider
  // operations and finalises this Deployment as `failed`; the head never
  // points at an `applying` Deployment.
  const advanceInput: AdvanceGroupHeadInput = {
    spaceId: applyingDeployment.space_id,
    groupId: applyingDeployment.group_id,
    currentDeploymentId: applyingDeployment.id,
    advancedAt: appliedAt,
    ...("expectedCurrentDeploymentId" in input
      ? {
        expectedCurrentDeploymentId: input.expectedCurrentDeploymentId ??
          undefined,
      }
      : {
        expectedCurrentDeploymentId: implicitHeadPrecondition
          ?.current_deployment_id,
        expectedGeneration: implicitHeadPrecondition?.generation ?? 0,
      }),
  };
  const successConditions = appendCondition(
    conditions,
    activationCommittedCondition({
      observedGeneration: conditions.length + 1,
      observedAt: appliedAt,
    }),
  );
  const applied: Deployment = {
    ...applyingDeployment,
    status: "applied",
    approval: input.approval ?? applyingDeployment.approval ?? null,
    applied_at: appliedAt,
    finalized_at: appliedAt,
    conditions: successConditions,
  };
  try {
    if (deps.store.commitAppliedDeployment) {
      try {
        const result = await deps.store.commitAppliedDeployment({
          ...advanceInput,
          deployment: deepFreeze(applied),
        });
        return result.deployment;
      } catch (error) {
        if (!isMissingOptionalStoreMethod(error, "commitAppliedDeployment")) {
          throw error;
        }
      }
    }
    await deps.store.putDeployment(deepFreeze(applied));
    await deps.store.advanceGroupHead(advanceInput);
    return applied;
  } catch (error) {
    const rollbackResult = await rollbackCommittedOperations(deps, {
      deployment: applyingDeployment,
      committed,
      observedAt: appliedAt,
      startingGeneration: conditions.length + 1,
    });
    const message = error instanceof Error ? error.message : String(error);
    const rolledBackConditions = [
      ...conditions,
      ...rollbackResult.conditions,
    ];
    const failedConditions = appendCondition(
      appendCondition(
        rolledBackConditions,
        applyFailedCondition({
          operation: {
            key: `${applyingDeployment.id}|activation.commit|stale-head`,
            kind: "activation.commit",
            objectAddress: applyingDeployment.desired.activation_envelope
              .primary_assignment.componentAddress,
            desiredDigest:
              applyingDeployment.desired.activation_envelope.envelopeDigest,
          },
          outcome: {
            success: false,
            reason: "GroupHeadStale",
            message,
          },
          observedGeneration: rolledBackConditions.length + 1,
          observedAt: appliedAt,
        }),
      ),
      applyRolledBackCondition({
        observedGeneration: rolledBackConditions.length + 2,
        observedAt: appliedAt,
        partial: rollbackResult.partial,
        revertedCount: rollbackResult.revertedCount,
        failedRevertCount: rollbackResult.failedRevertCount,
      }),
    );
    const failed: Deployment = {
      ...applyingDeployment,
      status: "failed",
      conditions: failedConditions,
      finalized_at: appliedAt,
    };
    await deps.store.putDeployment(deepFreeze(failed));
    throw error;
  }
}

/**
 * C1 — Multi-cloud partial-success cleanup. Iterates the previously
 * committed operations in reverse order and asks the provider adapter to
 * revert each one. Adapters that omit `rollback` (logically irreversible)
 * cause the result to flip to `partial=true` so the caller emits a
 * `RolledBackPartial` terminal condition. The per-operation revert outcome
 * is recorded as an `OperationRolledBack` / `OperationRollbackFailed`
 * condition on the failed Deployment for downstream observability.
 */
export async function rollbackCommittedOperations(
  deps: ApplyPhaseDeps,
  input: {
    readonly deployment: Deployment;
    readonly committed: readonly PlannedOperation[];
    readonly observedAt: IsoTimestamp;
    readonly startingGeneration: number;
  },
): Promise<{
  readonly conditions: readonly DeploymentCondition[];
  readonly partial: boolean;
  readonly revertedCount: number;
  readonly failedRevertCount: number;
}> {
  const conditions: DeploymentCondition[] = [];
  let generation = input.startingGeneration;
  let revertedCount = 0;
  let failedRevertCount = 0;
  // Reverse order so later commits unwind before earlier ones (Cloudflare
  // commit then AWS failure → revert AWS-shaped commits first if any, then
  // Cloudflare-shaped commits).
  for (let i = input.committed.length - 1; i >= 0; i--) {
    const operation = input.committed[i];
    let outcome: OperationOutcome;
    if (typeof deps.providerAdapter.rollback !== "function") {
      outcome = {
        success: false,
        reason: "RollbackUnsupported",
        message:
          "provider adapter does not implement rollback for this operation",
      };
      failedRevertCount += 1;
    } else {
      try {
        outcome = await deps.providerAdapter.rollback(
          input.deployment,
          operation,
        );
        if (outcome.success) revertedCount += 1;
        else failedRevertCount += 1;
      } catch (error) {
        outcome = {
          success: false,
          reason: "RollbackThrew",
          message: error instanceof Error ? error.message : String(error),
        };
        failedRevertCount += 1;
      }
    }
    conditions.push(operationRolledBackCondition({
      operation,
      outcome,
      observedGeneration: generation,
      observedAt: input.observedAt,
    }));
    generation += 1;
  }
  return {
    conditions,
    partial: failedRevertCount > 0,
    revertedCount,
    failedRevertCount,
  };
}
