/** Explicit local capture staging; it never authorizes or commits recovery. */
import { isAbsolute, join } from "node:path";
import { sha256Digest, stableStringify } from "../../core/adapters/source/digest.ts";
import type { OpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
import { assertVerifiedRecoveryArtifact } from "../../core/domains/deploy-control/operator_state_recovery.ts";
import {
  LOCAL_RECOVERY_STATE_MAX_BYTES,
  LocalOpenTofuStateRecoveryArtifactStore,
} from "../../deploy/node-postgres/src/local-state-recovery-artifact-store.ts";
import { LocalStateRecoveryRefusal, type LocalRecoveryApprovalSelection } from "./local-operator-state-recovery.ts";
import {
  readOwnerPrivateApprovalBytesFile,
  readOwnerPrivateApprovalTextFile,
  writeNewPrivateEvidenceJson,
} from "./private-evidence-file.ts";

const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_PRIVATE_JSON_BYTES = 16 * 1024;

export interface LocalStateRecoveryStageApproval {
  readonly format: "takosumi.local-operator-state-stage/v1";
  readonly purpose: "stage-initial-create-state";
  readonly caseId: string;
  readonly approvedOperatorId: string;
  readonly selectedTargetId: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly failedApplyRunId: string;
  readonly recoveryRunId: string;
  readonly sourceSnapshotId: string;
  readonly commandTimestamp: string;
  readonly expiresAt: string;
  readonly plaintextSha256: `sha256:${string}`;
  /** Operator-confirmed capture provenance, not inferred from the state file. */
  readonly custodyEvidenceDigest: `sha256:${string}`;
}

export interface LocalStateRecoveryStageReceipt extends Omit<LocalStateRecoveryStageApproval,
  "format" | "purpose" | "expiresAt"> {
  readonly format: "takosumi.local-operator-state-stage-receipt/v1";
  readonly purpose: "staged-initial-create-state";
  readonly artifactHandle: string;
  readonly encryptedDigest: `sha256:${string}`;
  readonly evidenceDigest: `sha256:${string}`;
}

function operatorId(): string {
  const uid = process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0 || process.geteuid?.() !== uid) {
    throw new LocalStateRecoveryRefusal();
  }
  return `local-unix-account:${uid}`;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

async function readApproval(input: LocalRecoveryApprovalSelection) {
  const identity = operatorId();
  if (!CASE_ID.test(input.caseId) || !IDENTIFIER.test(input.selectedTargetId) || !isAbsolute(input.approvalDirectory)) {
    throw new LocalStateRecoveryRefusal();
  }
  const bytes = await readOwnerPrivateApprovalTextFile(join(input.approvalDirectory, `${input.caseId}.stage.json`), {
    sourceRoots: input.sourceRoots, maxBytes: MAX_PRIVATE_JSON_BYTES,
  });
  const value: unknown = JSON.parse(bytes);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalStateRecoveryRefusal();
  const row = value as Record<string, unknown>;
  const now = Date.now();
  if (Object.keys(row).sort().join(",") !== ["format", "purpose", "caseId", "approvedOperatorId", "selectedTargetId",
    "workspaceId", "capsuleId", "environment", "failedApplyRunId", "recoveryRunId", "sourceSnapshotId",
    "commandTimestamp", "expiresAt", "plaintextSha256", "custodyEvidenceDigest"].sort().join(",") ||
    row.format !== "takosumi.local-operator-state-stage/v1" || row.purpose !== "stage-initial-create-state" ||
    row.caseId !== input.caseId || row.approvedOperatorId !== identity || row.selectedTargetId !== input.selectedTargetId ||
    !["workspaceId", "capsuleId", "environment", "failedApplyRunId", "recoveryRunId", "sourceSnapshotId"]
      .every(key => typeof row[key] === "string" && IDENTIFIER.test(row[key])) ||
    !timestamp(row.commandTimestamp) || !timestamp(row.expiresAt) ||
    !Number.isFinite(now) || Date.parse(row.commandTimestamp) > now || now >= Date.parse(row.expiresAt) ||
    !["plaintextSha256", "custodyEvidenceDigest"].every(key => typeof row[key] === "string" && DIGEST.test(row[key])) ||
    operatorId() !== identity) throw new LocalStateRecoveryRefusal();
  return { profile: Object.freeze(row as unknown as LocalStateRecoveryStageApproval), bytes };
}

/** Before the standalone command opens SQL or reads keys/captured state. */
export async function checkLocalStateRecoveryStageApproval(input: LocalRecoveryApprovalSelection): Promise<void> {
  try { await readApproval(input); } catch { throw new LocalStateRecoveryRefusal(); }
}

/** Read-only admission, not an atomic ledger fence or a replacement for Core CAS. */
async function observeInitialFailure(store: OpenTofuControlStore, p: LocalStateRecoveryStageApproval): Promise<string> {
  const failed = await store.getApplyRun(p.failedApplyRunId);
  const capsule = await store.getCapsule(p.capsuleId);
  if (!failed || !capsule) throw new LocalStateRecoveryRefusal();
  const plan = await store.getPlanRun(failed.planRunId);
  if (!plan || plan.sourceSnapshotId !== p.sourceSnapshotId) throw new LocalStateRecoveryRefusal();
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
    })) throw new LocalStateRecoveryRefusal();
  // This bounded newest-first page rejects known incompatible later work. Its
  // incompleteness is not a new gate: the unchanged Core CAS checks all history,
  // full Plan/input/config authority, leases and storage identity at commit.
  return stableStringify({ failed, capsule, plan, snapshot, management, epoch,
    planAuthority, applyAuthority, history, state, recovery, ownership });
}

/** Stages only the approved raw capture, then publishes a private result receipt. */
export async function stageApprovedLocalStateRecovery(input: LocalRecoveryApprovalSelection & {
  readonly store: OpenTofuControlStore;
  readonly verifier: LocalOpenTofuStateRecoveryArtifactStore;
}): Promise<LocalStateRecoveryStageReceipt> {
  try {
    const approved = await readApproval(input);
    const p = approved.profile;
    const observed = await observeInitialFailure(input.store, p);
    const revalidate = async () => {
      const current = await observeInitialFailure(input.store, p);
      if ((await readApproval(input)).bytes !== approved.bytes || current !== observed) {
        throw new LocalStateRecoveryRefusal();
      }
    };
    const receiptPath = join(input.approvalDirectory, `${input.caseId}.staged.json`);
    let prior: LocalStateRecoveryStageReceipt | undefined;
    try {
      prior = JSON.parse(await readOwnerPrivateApprovalTextFile(receiptPath, {
        sourceRoots: input.sourceRoots, maxBytes: MAX_PRIVATE_JSON_BYTES,
      })) as LocalStateRecoveryStageReceipt;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let plaintext: Uint8Array | undefined;
    if (prior === undefined) {
      plaintext = await readOwnerPrivateApprovalBytesFile(join(input.approvalDirectory, `${input.caseId}.tfstate`), {
        sourceRoots: input.sourceRoots, maxBytes: LOCAL_RECOVERY_STATE_MAX_BYTES,
      });
      if (await sha256Digest(plaintext) !== p.plaintextSha256) throw new LocalStateRecoveryRefusal();
    }
    await revalidate();
    const scope = { workspaceId: p.workspaceId, capsuleId: p.capsuleId, failedApplyRunId: p.failedApplyRunId, recoveryRunId: p.recoveryRunId };
    // Receipt replay is read-only; missing/replaced custody cannot be restaged.
    const staged = prior === undefined ? await input.verifier.stage({ ...scope, environment: p.environment, generation: 1,
      plaintextSha256: p.plaintextSha256, custodyEvidenceDigest: p.custodyEvidenceDigest, plaintext: plaintext! }) :
      { handle: prior.artifactHandle, artifact: await input.verifier.verify({ ...scope, artifactHandle: prior.artifactHandle,
        plaintextSha256: p.plaintextSha256, custodyEvidenceDigest: p.custodyEvidenceDigest }) };
    assertVerifiedRecoveryArtifact(staged.artifact);
    const { format: _format, purpose: _purpose, expiresAt: _expires, ...binding } = p;
    const receipt: LocalStateRecoveryStageReceipt = { ...binding, format: "takosumi.local-operator-state-stage-receipt/v1",
      purpose: "staged-initial-create-state", artifactHandle: staged.handle,
      encryptedDigest: staged.artifact.encryptedDigest, evidenceDigest: staged.artifact.evidenceDigest };
    if (prior !== undefined && stableStringify(prior) !== stableStringify(receipt)) throw new LocalStateRecoveryRefusal();
    await revalidate();
    if (prior === undefined) {
      try { await writeNewPrivateEvidenceJson(receiptPath, receipt); }
      catch {
        // A lost publish ACK/concurrent exact attempt may already have linked it.
        const readback = JSON.parse(await readOwnerPrivateApprovalTextFile(receiptPath, {
          sourceRoots: input.sourceRoots, maxBytes: MAX_PRIVATE_JSON_BYTES,
        }));
        if (stableStringify(readback) !== stableStringify(receipt)) throw new LocalStateRecoveryRefusal();
      }
    }
    const readback = JSON.parse(await readOwnerPrivateApprovalTextFile(receiptPath, {
      sourceRoots: input.sourceRoots, maxBytes: MAX_PRIVATE_JSON_BYTES,
    }));
    if (stableStringify(readback) !== stableStringify(receipt)) throw new LocalStateRecoveryRefusal();
    await revalidate();
    return receipt;
  } catch { throw new LocalStateRecoveryRefusal(); }
}
