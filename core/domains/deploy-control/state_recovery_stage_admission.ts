/** Shared read-only stage admission; the commit primitive retains full ledger CAS. */
import { stableStringify } from "../../adapters/source/digest.ts";
import type { OpenTofuControlStore } from "./store.ts";

export interface InitialStateRecoverySelection {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly failedApplyRunId: string;
  readonly recoveryRunId: string;
  readonly sourceSnapshotId: string;
  readonly commandTimestamp: string;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** Read-only admission, not an atomic ledger fence or a replacement for Core CAS. */
export async function observeInitialStateRecoveryFailure(store: OpenTofuControlStore, p: InitialStateRecoverySelection): Promise<string> {
  const failed = await store.getApplyRun(p.failedApplyRunId);
  const capsule = await store.getCapsule(p.capsuleId);
  if (!failed || !capsule) throw new TypeError("initial state recovery admission is unavailable");
  const plan = await store.getPlanRun(failed.planRunId);
  if (!plan || plan.sourceSnapshotId !== p.sourceSnapshotId) throw new TypeError("initial state recovery admission is unavailable");
  const [snapshot, management, epoch, planAuthority, applyAuthority, history, state, recovery, ownership] = await Promise.all([
    store.getSourceSnapshot(p.sourceSnapshotId), store.getWorkspaceManagement(p.workspaceId),
    store.getCapsuleExecutionAuthorityEpoch(p.capsuleId),
    store.getRunManagementAuthority({ id: plan.id, workspaceId: p.workspaceId, kind: "plan" }),
    store.getRunManagementAuthority({ id: failed.id, workspaceId: p.workspaceId, kind: "apply" }),
    store.listRunsByCapsulePage(p.capsuleId, { workspaceId: p.workspaceId, limit: 200 }),
    store.getLatestStateVersion(p.capsuleId, p.environment), store.getStateRecoveryRun(p.recoveryRunId),
    store.getAppBillingOwnership(p.capsuleId),
  ]);
  const finished: unknown = failed.finishedAt;
  const terminalAt = typeof finished === "number" && Number.isSafeInteger(finished) && finished >= 0
    ? finished : timestamp(finished) ? Date.parse(finished) : undefined;
  if (capsule.id !== p.capsuleId || capsule.workspaceId !== p.workspaceId || capsule.environment !== p.environment ||
    capsule.status !== "error" || capsule.currentStateGeneration !== 0 || capsule.currentStateVersionId !== undefined ||
    capsule.currentOutputId !== undefined || !snapshot || snapshot.workspaceId !== p.workspaceId ||
    snapshot.sourceId !== capsule.sourceId || snapshot.origin !== "git" ||
    plan.source.kind !== "git" || plan.source.url !== snapshot.url ||
    plan.source.commit?.toLowerCase() !== snapshot.resolvedCommit.toLowerCase() ||
    plan.workspaceId !== p.workspaceId || plan.capsuleId !== p.capsuleId || plan.operation !== "create" ||
    plan.status !== "succeeded" || plan.baseStateGeneration !== 0 || plan.capsuleCurrentStateVersionId != null ||
    (plan.appliedApplyRunId !== undefined && plan.appliedApplyRunId !== failed.id) ||
    failed.id !== p.failedApplyRunId || failed.workspaceId !== p.workspaceId || failed.capsuleId !== p.capsuleId ||
    failed.operation !== "create" || failed.status !== "failed" || failed.stateVersionId !== undefined ||
    failed.outputId !== undefined || failed.executionEvidence !== undefined || terminalAt === undefined ||
    Date.parse(p.commandTimestamp) < terminalAt ||
    (failed.auditEvents.some(event => event.data?.providerDispatched === false) &&
      !failed.auditEvents.some(event => event.data?.providerDispatched === true)) ||
    p.recoveryRunId === failed.id || p.recoveryRunId === plan.id ||
    !Number.isSafeInteger(epoch) || epoch! < 1 || epoch! >= Number.MAX_SAFE_INTEGER ||
    plan.capsuleExecutionAuthorityEpoch !== epoch || failed.expected.capsuleExecutionAuthorityEpoch !== epoch ||
    management?.workspaceId !== p.workspaceId || management.managementState !== "active" ||
    !Number.isSafeInteger(management.managementEpoch) || management.managementEpoch < 1 ||
    (planAuthority !== undefined && stableStringify(planAuthority) !== stableStringify(management)) ||
    (applyAuthority !== undefined && stableStringify(applyAuthority) !== stableStringify(management)) ||
    (plan.ownershipEpoch !== undefined && plan.ownershipEpoch !== ownership?.ownershipEpoch) ||
    state !== undefined || recovery !== undefined || history.rows.some(row => {
      if (row.id === plan.id || row.id === failed.id) return false;
      const at = typeof row.createdAt === "number" ? row.createdAt : Date.parse(row.createdAt);
      return row.id === p.recoveryRunId || !Number.isFinite(at) || at >= failed.createdAt ||
        row.status === "queued" || row.status === "running" || row.status === "waiting_approval";
    })) throw new TypeError("initial state recovery admission is unavailable");
  // This bounded newest-first page rejects known incompatible later work. Its
  // incompleteness is not a new gate: the unchanged Core CAS checks all history,
  // full Plan/input/config authority, leases and storage identity at commit.
  return stableStringify({ failed, capsule, plan, snapshot, management, epoch,
    planAuthority, applyAuthority, history, state, recovery, ownership });
}
