import type { ApplyRun } from "@takosumi/internal/deploy-control-api";
import type { StoredRunRecord } from "./store.ts";
import type { StateVersion } from "takosumi-contract/state-versions";
import type { CapsuleInterfaceMaterializationIntent } from "./interface_materialization_intent.ts";
import {
  applyRunBillingCapturePending,
  applyRunRuntimeSecretRetirementPending,
} from "./run_finalization.ts";

type RecordValue = Record<string, unknown>;

/** A synchronous view of the existing ledgers, not a separate work registry. */
export interface WorkspaceManagementLedgers {
  readonly runs: ReadonlyMap<string, StoredRunRecord>;
  readonly stateVersions: ReadonlyMap<string, StateVersion>;
  readonly interfaceIntents: ReadonlyMap<string, CapsuleInterfaceMaterializationIntent>;
}

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function absentOrText(value: unknown): boolean {
  return value === undefined || text(value);
}

function hasTerminalStatus(run: RecordValue): boolean {
  return run.status === "succeeded" || run.status === "failed" ||
    run.status === "cancelled" || run.status === "expired";
}

/** Unknown or contradictory families cannot become settled by default. */
function runFamily(run: RecordValue): "plan" | "apply" | "source_sync" | "backup" | "compatibility_check" | "restore" | undefined {
  const plan = "sourceDigest" in run || "variablesDigest" in run;
  const apply = "planRunId" in run || "expected" in run;
  const source = run.kind === "source_sync";
  if (Number(plan) + Number(apply) + Number(source) > 1) return undefined;
  if (plan || apply) {
    if (run.type !== undefined || run.kind !== undefined ||
      (run.operation !== "create" && run.operation !== "update" && run.operation !== "destroy")) return undefined;
    if (apply) return text(run.planRunId) && record(run.expected) ? "apply" : undefined;
    return text(run.sourceDigest) && text(run.variablesDigest) &&
        (run.driftCheck === undefined || run.driftCheck === true) &&
        !(run.driftCheck === true && run.operation !== "update")
      ? "plan" : undefined;
  }
  if (source) return run.type === undefined && text(run.sourceId) ? "source_sync" : undefined;
  if (run.kind !== undefined || run.operation !== undefined) return undefined;
  if (run.type === "backup" || run.type === "compatibility_check" || run.type === "restore") return run.type;
  return undefined;
}

function validAuditEvents(value: unknown): value is ApplyRun["auditEvents"] {
  return Array.isArray(value) && value.every((event) => {
    if (!record(event) || !text(event.type)) return false;
    const data = event.data;
    if (data === undefined) return true;
    if (!record(data)) return false;
    return ["providerDispatched", "lifecycleActionDispatched", "actionDispatched"].every(
      (key) => data[key] === undefined || typeof data[key] === "boolean",
    );
  });
}

function dispatched(run: ApplyRun): boolean {
  return run.auditEvents.some((event) =>
    event.data?.providerDispatched === true || event.data?.lifecycleActionDispatched === true ||
    (event.type.startsWith("lifecycle_action.") && event.data?.actionDispatched === true)
  );
}

function hasApplyEffects(run: RecordValue): boolean {
  return run.stateVersionId !== undefined || run.outputId !== undefined || run.executionEvidence !== undefined;
}

function matchingState(state: StateVersion | undefined, run: RecordValue): state is StateVersion {
  return state !== undefined && text(state.id) && text(state.createdByRunId) && state.workspaceId === run.workspaceId &&
    state.capsuleId === run.capsuleId && state.environment === run.environment && integer(state.generation, 1);
}

function restoreIsSettled(run: RecordValue, ledgers: WorkspaceManagementLedgers): boolean {
  if (!text(run.capsuleId) || !text(run.environment)) return false;
  if (run.status === "cancelled") {
    return run.startedAt === undefined && run.heartbeatAt === undefined &&
      run.restoredStateVersionId === undefined && run.restoredServiceData === undefined;
  }
  if (run.status !== "succeeded" || !text(run.restoredStateVersionId) || !text(run.restoredFromStateVersionId)) return false;
  const target = ledgers.stateVersions.get(run.restoredStateVersionId);
  const source = ledgers.stateVersions.get(run.restoredFromStateVersionId);
  if (!matchingState(target, run) || !matchingState(source, run) ||
    target.id !== run.restoredStateVersionId || source.id !== run.restoredFromStateVersionId ||
    target.createdByRunId !== run.id || source.generation !== run.restoreStateGeneration ||
    target.generation <= source.generation) return false;
  if (run.restoreServiceData !== undefined && typeof run.restoreServiceData !== "boolean") return false;
  if (run.restoreServiceData === true) {
    const receipt = run.restoredServiceData;
    if (!record(receipt) || receipt.status !== "restored" || !text(receipt.ref) || !text(receipt.digest)) return false;
  } else if (run.restoredServiceData !== undefined) return false;
  const intent = ledgers.interfaceIntents.get(`cimi_${source.createdByRunId}`) ??
    ledgers.interfaceIntents.get(`cimi_restore_${source.createdByRunId}`);
  if (intent) {
    const replacement = ledgers.interfaceIntents.get(`cimi_restore_${run.id}`);
    if (intent.workspaceId !== run.workspaceId || intent.capsuleId !== run.capsuleId ||
      intent.stateVersionId !== source.id || intent.stateGeneration !== source.generation ||
      !replacement || replacement.restoreRunId !== run.id || replacement.sourceIntentId !== intent.id ||
      replacement.workspaceId !== run.workspaceId || replacement.capsuleId !== run.capsuleId ||
      replacement.stateVersionId !== target.id || replacement.stateGeneration !== target.generation ||
      replacement.blueprintsDigest !== intent.blueprintsDigest) return false;
  }
  return true;
}

/** This is quiescence, not Run progress or whole-record business validation. */
export function runBlocksWorkspaceManagement(value: unknown, ledgers: WorkspaceManagementLedgers): boolean {
  if (!record(value) || !text(value.id) || !text(value.workspaceId) || !hasTerminalStatus(value)) return true;
  const family = runFamily(value);
  if (family === undefined || !absentOrText(value.capsuleId) || !absentOrText(value.sourceId) ||
    !absentOrText(value.environment) ||
    (value.heartbeatAt !== undefined && !integer(value.heartbeatAt))) return true;
  const internal = family === "plan" || family === "apply";
  if (internal ? !integer(value.createdAt) || !integer(value.updatedAt) : !text(value.createdAt)) return true;
  for (const field of ["startedAt", "finishedAt"] as const) {
    if (value[field] !== undefined && (internal ? !integer(value[field]) : !text(value[field]))) return true;
  }
  if (family === "source_sync") return value.status !== "succeeded" && value.status !== "failed";
  if (family === "restore") return !restoreIsSettled(value, ledgers);
  if (family === "plan") {
    if ((value.requiresApproval !== undefined && typeof value.requiresApproval !== "boolean") ||
      !absentOrText(value.appliedApplyRunId) ||
      (value.approval !== undefined && (!record(value.approval) || !integer(value.approval.approvedAt)))) return true;
    // RunQueryService also preserves this approval gate for historical rows
    // that persisted succeeded before waiting_approval became a stored status.
    return value.status === "succeeded" && value.driftCheck !== true &&
      (value.operation === "destroy" || value.requiresApproval === true) &&
      value.approval === undefined && value.appliedApplyRunId === undefined;
  }
  if (family !== "apply") return false;
  if (!validAuditEvents(value.auditEvents)) return true;
  const apply = value as unknown as ApplyRun;
  if (applyRunBillingCapturePending(apply) || applyRunRuntimeSecretRetirementPending(apply)) return true;
  if (apply.status === "succeeded") return false;
  if (dispatched(apply) || hasApplyEffects(value)) return true;
  if (apply.status === "failed") {
    // The queued/DLQ failure writer historically used apply.failed for destroy
    // too. Its explicit negative dispatch evidence remains valid under all the
    // no-effects/no-positive-dispatch checks above.
    return !apply.auditEvents.some((event) =>
      (event.type === "apply.failed" ||
        (apply.operation === "destroy" && event.type === "destroy.failed")) &&
      event.data?.providerDispatched === false
    );
  }
  return apply.startedAt !== undefined || apply.heartbeatAt !== undefined;
}

/** A completed intent cannot be claimed/retried; only its completion safety evidence is needed here. */
export function interfaceIntentBlocksWorkspaceManagement(value: unknown, ledgers: WorkspaceManagementLedgers): boolean {
  if (!record(value) || value.status !== "completed" ||
    value.leaseToken !== undefined || value.leaseExpiresAt !== undefined ||
    value.error !== undefined || value.deadLetteredAt !== undefined ||
    !["id", "workspaceId", "capsuleId", "installConfigId", "stateVersionId", "outputId", "completedAt"].every((key) => text(value[key])) ||
    !integer(value.stateGeneration, 1) || !integer(value.totalItems, 1) || !integer(value.nextItemIndex) ||
    value.nextItemIndex > value.totalItems || !integer(value.attempts) ||
    typeof value.blueprintsDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value.blueprintsDigest)) return true;
  const apply = text(value.applyRunId);
  const restore = text(value.restoreRunId);
  if (apply === restore ||
    (apply && (value.restoreRunId !== undefined || value.sourceIntentId !== undefined || value.id !== `cimi_${value.applyRunId}`)) ||
    (restore && (value.applyRunId !== undefined || !text(value.sourceIntentId) || value.id !== `cimi_restore_${value.restoreRunId}`))) return true;
  const origin = ledgers.runs.get(String(apply ? value.applyRunId : value.restoreRunId));
  if (!origin || origin.id !== (apply ? value.applyRunId : value.restoreRunId) ||
    origin.workspaceId !== value.workspaceId || !("capsuleId" in origin) || origin.capsuleId !== value.capsuleId ||
    origin.status !== "succeeded" ||
    (apply && "operation" in origin && origin.operation === "destroy") ||
    runFamily(origin as unknown as RecordValue) !== (apply ? "apply" : "restore")) return true;
  const state = ledgers.stateVersions.get(String(value.stateVersionId));
  if (!state || state.id !== value.stateVersionId || state.workspaceId !== value.workspaceId ||
    state.capsuleId !== value.capsuleId || state.generation !== value.stateGeneration ||
    state.createdByRunId !== origin.id) return true;
  if (restore) {
    const restoreRun = origin as unknown as RecordValue;
    if (!text(restoreRun.restoredFromStateVersionId)) return true;
    const sourceState = ledgers.stateVersions.get(restoreRun.restoredFromStateVersionId);
    if (!matchingState(sourceState, restoreRun)) return true;
    const sourceIntent = ledgers.interfaceIntents.get(`cimi_${sourceState.createdByRunId}`) ??
      ledgers.interfaceIntents.get(`cimi_restore_${sourceState.createdByRunId}`);
    if (!sourceIntent || sourceIntent.id !== value.sourceIntentId ||
      sourceIntent.workspaceId !== value.workspaceId || sourceIntent.capsuleId !== value.capsuleId ||
      sourceIntent.installConfigId !== value.installConfigId || sourceIntent.blueprintsDigest !== value.blueprintsDigest ||
      sourceIntent.stateVersionId !== restoreRun.restoredFromStateVersionId ||
      sourceIntent.stateGeneration !== sourceState.generation) return true;
  }
  const receipt = value.receipt;
  if (!record(receipt) || Object.keys(receipt).length !== 3 ||
    !["disposition", "blueprintsDigest", "completedAt"].every((key) => Object.hasOwn(receipt, key)) ||
    receipt.blueprintsDigest !== value.blueprintsDigest || receipt.completedAt !== value.completedAt) return true;
  if (receipt.disposition === "materialized") return value.nextItemIndex !== value.totalItems;
  return receipt.disposition !== "retired_before_materialization" && receipt.disposition !== "superseded_before_materialization";
}
