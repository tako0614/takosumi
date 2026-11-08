/** A purpose-specific local OS-account approval, never an app or bearer permission. */
import { isAbsolute, join } from "node:path";
import type { OpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
import {
  assertVerifiedRecoveryArtifact,
  recoverFailedInitialCreateState,
  type CommitRecoveredStateResult,
  type RecoveryArtifactVerifier,
  type VerifiedRecoveryArtifact,
} from "../../core/domains/deploy-control/operator_state_recovery.ts";
import { LocalOpenTofuStateRecoveryArtifactStore } from "../../deploy/node-postgres/src/local-state-recovery-artifact-store.ts";
import { readOwnerPrivateApprovalTextFile } from "./private-evidence-file.ts";

const FORMAT = "takosumi.local-operator-state-recovery/v1";
const PURPOSE = "commit-staged-initial-create-state";
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_APPROVAL_BYTES = 16 * 1024;

export interface LocalStateRecoveryApproval {
  readonly format: typeof FORMAT;
  readonly purpose: typeof PURPOSE;
  readonly caseId: string;
  /** Kernel OS account, not a human identity or a Takosumi account. */
  readonly approvedOperatorId: string;
  readonly selectedTargetId: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly failedApplyRunId: string;
  readonly recoveryRunId: string;
  /** Stable across every identical retry, including an unknown commit ACK. */
  readonly commandTimestamp: string;
  readonly expiresAt: string;
  readonly artifactHandle: string;
  readonly plaintextSha256: `sha256:${string}`;
  readonly encryptedDigest: `sha256:${string}`;
  readonly evidenceDigest: `sha256:${string}`;
}

export interface LocalRecoveryApprovalSelection {
  /** Trusted host bootstrap input; the command accepts only a case ID. */
  readonly approvalDirectory: string;
  readonly selectedTargetId: string;
  readonly caseId: string;
  readonly sourceRoots: readonly string[];
}

export class LocalStateRecoveryRefusal extends Error {
  readonly code = "local_state_recovery_refused";
  constructor() { super("local operator state recovery approval or custody is unavailable"); }
}

interface ApprovalSnapshot {
  readonly profile: LocalStateRecoveryApproval;
  readonly bytes: string;
}

function operatorId(): string {
  const uid = process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0 || process.geteuid?.() !== uid) {
    throw new LocalStateRecoveryRefusal();
  }
  return `local-unix-account:${uid}`;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function profileValidNow(profile: LocalStateRecoveryApproval): boolean {
  const now = Date.now();
  return Number.isFinite(now) && Date.parse(profile.commandTimestamp) <= now && now < Date.parse(profile.expiresAt);
}

async function readApproval(input: LocalRecoveryApprovalSelection): Promise<ApprovalSnapshot> {
  try {
    const identity = operatorId();
    if (!CASE_ID.test(input.caseId) || !IDENTIFIER.test(input.selectedTargetId) || !isAbsolute(input.approvalDirectory)) {
      throw new LocalStateRecoveryRefusal();
    }
    const bytes = await readOwnerPrivateApprovalTextFile(join(input.approvalDirectory, `${input.caseId}.json`), {
      sourceRoots: input.sourceRoots, maxBytes: MAX_APPROVAL_BYTES,
    });
    const value: unknown = JSON.parse(bytes);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalStateRecoveryRefusal();
    const record = value as Record<string, unknown>;
    if (!exactKeys(record, ["format", "purpose", "caseId", "approvedOperatorId", "selectedTargetId",
      "workspaceId", "capsuleId", "environment", "failedApplyRunId", "recoveryRunId", "commandTimestamp",
      "expiresAt", "artifactHandle", "plaintextSha256", "encryptedDigest", "evidenceDigest"]) ||
      record.format !== FORMAT || record.purpose !== PURPOSE || record.caseId !== input.caseId ||
      record.approvedOperatorId !== identity || record.selectedTargetId !== input.selectedTargetId ||
      !["workspaceId", "capsuleId", "environment", "failedApplyRunId", "recoveryRunId"]
        .every(key => typeof record[key] === "string" && IDENTIFIER.test(record[key])) ||
      !canonicalTimestamp(record.commandTimestamp) || !canonicalTimestamp(record.expiresAt) ||
      typeof record.artifactHandle !== "string" || record.artifactHandle.length > 4096 ||
      !record.artifactHandle.startsWith("local-recovery-state-v1.") ||
      !["plaintextSha256", "encryptedDigest", "evidenceDigest"].every(key => typeof record[key] === "string" && DIGEST.test(record[key]))) {
      throw new LocalStateRecoveryRefusal();
    }
    const profile = record as unknown as LocalStateRecoveryApproval;
    if (!profileValidNow(profile) || identity !== operatorId()) throw new LocalStateRecoveryRefusal();
    return { profile: Object.freeze(profile), bytes };
  } catch {
    // Path, handle, database and private approval details are not diagnostics.
    throw new LocalStateRecoveryRefusal();
  }
}

/** Authorization preflight for the standalone entry, before opening a database. */
export async function checkLocalStateRecoveryApproval(input: LocalRecoveryApprovalSelection): Promise<void> {
  await readApproval(input);
}

function matchesArtifact(profile: LocalStateRecoveryApproval, artifact: VerifiedRecoveryArtifact): boolean {
  return artifact.workspaceId === profile.workspaceId && artifact.capsuleId === profile.capsuleId &&
    artifact.environment === profile.environment && artifact.recoveryRunId === profile.recoveryRunId &&
    artifact.generation === 1 && artifact.plaintextSha256 === profile.plaintextSha256 &&
    artifact.encryptedDigest === profile.encryptedDigest && artifact.evidenceDigest === profile.evidenceDigest;
}

/**
 * Commits only an already staged, exactly approved artifact. No stage, runner,
 * Host request, inferred state, new Run identity, or default bearer grant.
 */
export async function commitApprovedLocalStateRecovery(input: LocalRecoveryApprovalSelection & {
  readonly store: OpenTofuControlStore;
  readonly verifier: LocalOpenTofuStateRecoveryArtifactStore;
}): Promise<CommitRecoveredStateResult> {
  const approved = await readApproval(input);
  const { profile } = approved;
  const checkFailedTermination = async () => {
    const failed = await input.store.getApplyRun(profile.failedApplyRunId);
    const finished: unknown = failed?.finishedAt;
    const terminalAt = typeof finished === "number" && Number.isSafeInteger(finished) && finished >= 0
      ? finished : canonicalTimestamp(finished) ? Date.parse(finished) : undefined;
    if (!failed || failed.id !== profile.failedApplyRunId || failed.status !== "failed" ||
      failed.workspaceId !== profile.workspaceId || failed.capsuleId !== profile.capsuleId ||
      terminalAt === undefined || Date.parse(profile.commandTimestamp) < terminalAt) {
      throw new LocalStateRecoveryRefusal();
    }
  };
  // Fixed retry timestamps must still describe recovery after actual failure.
  await checkFailedTermination();
  const revalidate = async () => {
    const current = await readApproval(input);
    if (current.bytes !== approved.bytes) throw new LocalStateRecoveryRefusal();
  };
  const verifier: RecoveryArtifactVerifier = {
    async verify(scope) {
      await revalidate();
      if (scope.workspaceId !== profile.workspaceId || scope.capsuleId !== profile.capsuleId ||
        scope.failedApplyRunId !== profile.failedApplyRunId || scope.recoveryRunId !== profile.recoveryRunId ||
        scope.artifactHandle !== profile.artifactHandle) throw new LocalStateRecoveryRefusal();
      const artifact = await input.verifier.verify(scope);
      assertVerifiedRecoveryArtifact(artifact);
      if (!matchesArtifact(profile, artifact)) throw new LocalStateRecoveryRefusal();
      await checkFailedTermination();
      await revalidate();
      return artifact;
    },
  };
  return await recoverFailedInitialCreateState({ store: input.store, verifier,
    artifactHandle: profile.artifactHandle, failedApplyRunId: profile.failedApplyRunId,
    recoveryRunId: profile.recoveryRunId, createdBy: profile.approvedOperatorId, now: profile.commandTimestamp });
}
