/** Explicit private composition only; no session/admin permission or default mount. */
import { sha256Digest, stableStringify } from "../../core/adapters/source/digest.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../core/adapters/storage/artifact-references.ts";
import { SECRET_STORE_KEY_ENV_KEYS, SECRET_STORE_PARTITION_KEYS_ENV, type SecretCryptoEnvLike } from "../../core/adapters/secret-store/memory.ts";
import { assertVerifiedRecoveryArtifact, recoverFailedInitialCreateState, type VerifiedRecoveryArtifact } from "../../core/domains/deploy-control/operator_state_recovery.ts";
import { observeInitialStateRecoveryFailure } from "../../core/domains/deploy-control/state_recovery_stage_admission.ts";
import type { OpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
import type { D1Database, R2Bucket } from "./bindings.ts";
import type { ArtifactStorageUsagePort } from "./artifact-storage-usage.ts";
import type { StoredServiceComposition } from "./stored-service-usage.ts";
import { createCloudflareD1OpenTofuControlStore, initializeD1OpenTofuLedgerSchemaBinding } from "./d1_opentofu_store.ts";
import { RECOVERY_STATE_MAX_BYTES, R2RecoveryStateArtifactStore } from "./state_recovery_artifact_store.ts";
import { StateArtifactCrypto } from "./state_crypto.ts";

const APPROVAL_FORMAT = "takosumi.private-worker-state-recovery-approval/v1";
const STAGE = "stage-initial-create-state";
const COMMIT = "commit-staged-initial-create-state";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const BASE_KEYS = ["format", "purpose", "approvedOperatorId", "selectedTargetId", "workspaceId",
  "capsuleId", "environment", "failedApplyRunId", "recoveryRunId", "sourceSnapshotId",
  "commandTimestamp", "expiresAt", "plaintextSha256", "custodyEvidenceDigest"] as const;
type Digest = VerifiedRecoveryArtifact["plaintextSha256"];
interface ApprovalBinding {
  readonly format: typeof APPROVAL_FORMAT;
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
  readonly plaintextSha256: Digest;
  readonly custodyEvidenceDigest: Digest;
}
export interface PrivateStateStageApproval extends ApprovalBinding { readonly purpose: typeof STAGE }
export interface PrivateStateCommitApproval extends ApprovalBinding {
  readonly purpose: typeof COMMIT;
  readonly artifactHandle: string;
  readonly encryptedDigest: Digest;
  readonly evidenceDigest: Digest;
}
export type PrivateStateRecoveryApproval = PrivateStateStageApproval | PrivateStateCommitApproval;
/**
 * A qualified authority verifies the private proof's current effect, purpose,
 * holder/channel and revocation before returning its exact approved record.
 * A public case-ID lookup, named-RPC caller, role or boolean is not this port.
 * No production issuer is supplied by this module.
 */
export interface QualifiedStateRecoveryApprovalPort {
  readApprovedStateRecovery(input: {
    readonly approvalRef: string;
    readonly purpose: typeof STAGE | typeof COMMIT;
    readonly selectedTargetId: string;
  }): Promise<unknown>;
}
export interface PrivateStateStageReceipt extends Omit<PrivateStateStageApproval, "format" | "purpose" | "expiresAt"> {
  readonly format: "takosumi.private-worker-state-stage-receipt/v1";
  readonly purpose: "staged-initial-create-state";
  readonly artifactHandle: string;
  readonly encryptedDigest: Digest;
  readonly evidenceDigest: Digest;
}
export class PrivateStateRecoveryRefusal extends Error {
  readonly code = "private_state_recovery_refused";
  constructor() { super("private state recovery approval or custody is unavailable"); }
}
export interface PrivateStateRecoveryResources {
  readonly store: OpenTofuControlStore;
  readonly artifacts: R2RecoveryStateArtifactStore;
}
interface PrivateStateRecoveryComposition {
  readonly selectedTargetId: string;
  readonly approvals: QualifiedStateRecoveryApprovalPort;
  /** Trusted selected-target factory; never constructed from RPC fields. */
  readonly openResources: () => Promise<PrivateStateRecoveryResources>;
  readonly now?: () => number;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function assertApproval(value: unknown, purpose: typeof STAGE | typeof COMMIT, target: string, now: number): asserts value is PrivateStateRecoveryApproval {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PrivateStateRecoveryRefusal();
  const row = value as Record<string, unknown>;
  const keys = purpose === STAGE ? BASE_KEYS : [...BASE_KEYS, "artifactHandle", "encryptedDigest", "evidenceDigest"];
  if (!exactKeys(row, keys) || row.format !== APPROVAL_FORMAT || row.purpose !== purpose ||
    row.selectedTargetId !== target ||
    !["approvedOperatorId", "selectedTargetId", "workspaceId", "capsuleId", "environment",
      "failedApplyRunId", "recoveryRunId", "sourceSnapshotId"]
      .every(key => typeof row[key] === "string" && IDENTIFIER.test(row[key])) ||
    !timestamp(row.commandTimestamp) || !timestamp(row.expiresAt) ||
    !Number.isFinite(now) || Date.parse(row.commandTimestamp) > now || now >= Date.parse(row.expiresAt) ||
    !["plaintextSha256", "custodyEvidenceDigest", ...(purpose === COMMIT ? ["encryptedDigest", "evidenceDigest"] : [])]
      .every(key => typeof row[key] === "string" && DIGEST.test(row[key])) ||
    (purpose === COMMIT && (typeof row.artifactHandle !== "string" || row.artifactHandle.length > 4096 ||
      !row.artifactHandle.startsWith("recovery-state-v1.")))) throw new PrivateStateRecoveryRefusal();
}
function request(value: unknown, stage: boolean): { readonly approvalRef: string; readonly plaintext?: Uint8Array } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PrivateStateRecoveryRefusal();
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, stage ? ["approvalRef", "plaintext"] : ["approvalRef"]) ||
    typeof row.approvalRef !== "string" || !row.approvalRef || row.approvalRef.length > 512) throw new PrivateStateRecoveryRefusal();
  if (stage && (!(row.plaintext instanceof Uint8Array) || row.plaintext.byteLength === 0 ||
    row.plaintext.byteLength > RECOVERY_STATE_MAX_BYTES)) throw new PrivateStateRecoveryRefusal();
  // Snapshot caller-owned buffers before any await; hashes and storage see these bytes.
  return { approvalRef: row.approvalRef, ...(stage ? { plaintext: new Uint8Array(row.plaintext as Uint8Array) } : {}) };
}
function artifactMatches(p: ApprovalBinding, artifact: VerifiedRecoveryArtifact): boolean {
  return artifact.workspaceId === p.workspaceId && artifact.capsuleId === p.capsuleId &&
    artifact.environment === p.environment && artifact.generation === 1 &&
    artifact.recoveryRunId === p.recoveryRunId && artifact.plaintextSha256 === p.plaintextSha256;
}
async function checkPinnedFailure(store: OpenTofuControlStore, p: ApprovalBinding): Promise<void> {
  const failed = await store.getApplyRun(p.failedApplyRunId);
  const plan = failed && await store.getPlanRun(failed.planRunId);
  const capsule = await store.getCapsule(p.capsuleId);
  const finished: unknown = failed?.finishedAt;
  const terminalAt = typeof finished === "number" && Number.isSafeInteger(finished) && finished >= 0
    ? finished : timestamp(finished) ? Date.parse(finished) : undefined;
  if (!failed || !plan || !capsule || failed.id !== p.failedApplyRunId || failed.status !== "failed" ||
    failed.workspaceId !== p.workspaceId || failed.capsuleId !== p.capsuleId || failed.operation !== "create" ||
    capsule.id !== p.capsuleId || capsule.workspaceId !== p.workspaceId || capsule.environment !== p.environment ||
    plan.workspaceId !== p.workspaceId || plan.capsuleId !== p.capsuleId || plan.sourceSnapshotId !== p.sourceSnapshotId ||
    terminalAt === undefined || Date.parse(p.commandTimestamp) < terminalAt) throw new PrivateStateRecoveryRefusal();
}
/** Portable private logic. Only the trusted owner may provide this composition. */
export function createPrivateStateRecoveryOperator(input: PrivateStateRecoveryComposition) {
  const { selectedTargetId, approvals, openResources } = input;
  const now = input.now ?? Date.now;
  const approval = async (ref: string, purpose: typeof STAGE | typeof COMMIT) => {
    if (!IDENTIFIER.test(selectedTargetId) || typeof approvals?.readApprovedStateRecovery !== "function" ||
      typeof openResources !== "function") throw new PrivateStateRecoveryRefusal();
    const value = await approvals.readApprovedStateRecovery({ approvalRef: ref, purpose, selectedTargetId });
    assertApproval(value, purpose, selectedTargetId, now());
    // Only closed scalar fields survive the authority await boundary.
    return Object.freeze({ ...value });
  };
  return Object.freeze({
    async stageRecoveryState(value: unknown): Promise<PrivateStateStageReceipt> {
      try {
        const held = request(value, true);
        const p = await approval(held.approvalRef, STAGE);
        if (p.purpose !== STAGE) throw new PrivateStateRecoveryRefusal();
        const revalidate = async () => {
          if (stableStringify(await approval(held.approvalRef, STAGE)) !== stableStringify(p)) throw new PrivateStateRecoveryRefusal();
        };
        if (await sha256Digest(held.plaintext!) !== p.plaintextSha256) throw new PrivateStateRecoveryRefusal();
        await revalidate();
        const { store, artifacts } = await openResources();
        const observed = await observeInitialStateRecoveryFailure(store, p);
        const current = async () => {
          await revalidate();
          if (await observeInitialStateRecoveryFailure(store, p) !== observed) throw new PrivateStateRecoveryRefusal();
        };
        await current();
        const staged = await artifacts.stage({ workspaceId: p.workspaceId, capsuleId: p.capsuleId,
          environment: p.environment, generation: 1, failedApplyRunId: p.failedApplyRunId, recoveryRunId: p.recoveryRunId,
          plaintextSha256: p.plaintextSha256, custodyEvidenceDigest: p.custodyEvidenceDigest, plaintext: held.plaintext! });
        assertVerifiedRecoveryArtifact(staged.artifact);
        if (!artifactMatches(p, staged.artifact)) throw new PrivateStateRecoveryRefusal();
        await current();
        const { format: _format, purpose: _purpose, expiresAt: _expires, ...binding } = p;
        return { ...binding, format: "takosumi.private-worker-state-stage-receipt/v1",
          purpose: "staged-initial-create-state", artifactHandle: staged.handle,
          encryptedDigest: staged.artifact.encryptedDigest, evidenceDigest: staged.artifact.evidenceDigest };
      } catch { throw new PrivateStateRecoveryRefusal(); }
    },
    async commitRecoveryState(value: unknown) {
      try {
        const held = request(value, false);
        const p = await approval(held.approvalRef, COMMIT);
        if (p.purpose !== COMMIT) throw new PrivateStateRecoveryRefusal();
        const revalidate = async () => {
          if (stableStringify(await approval(held.approvalRef, COMMIT)) !== stableStringify(p)) throw new PrivateStateRecoveryRefusal();
        };
        await revalidate();
        const { store, artifacts } = await openResources();
        await checkPinnedFailure(store, p);
        const existing = await store.getStateRecoveryRun(p.recoveryRunId);
        const initial = existing === undefined ? await observeInitialStateRecoveryFailure(store, p) : undefined;
        await revalidate();
        const result = await recoverFailedInitialCreateState({ store, artifactHandle: p.artifactHandle,
          failedApplyRunId: p.failedApplyRunId, recoveryRunId: p.recoveryRunId,
          createdBy: p.approvedOperatorId, now: p.commandTimestamp,
          verifier: { async verify(scope) {
            await revalidate();
            await checkPinnedFailure(store, p);
            if (scope.workspaceId !== p.workspaceId || scope.capsuleId !== p.capsuleId ||
              scope.failedApplyRunId !== p.failedApplyRunId || scope.recoveryRunId !== p.recoveryRunId ||
              scope.artifactHandle !== p.artifactHandle) throw new PrivateStateRecoveryRefusal();
            const artifact = await artifacts.verify({ ...scope, plaintextSha256: p.plaintextSha256,
              custodyEvidenceDigest: p.custodyEvidenceDigest, encryptedDigest: p.encryptedDigest, evidenceDigest: p.evidenceDigest });
            assertVerifiedRecoveryArtifact(artifact);
            if (!artifactMatches(p, artifact) || artifact.encryptedDigest !== p.encryptedDigest ||
              artifact.evidenceDigest !== p.evidenceDigest) throw new PrivateStateRecoveryRefusal();
            await checkPinnedFailure(store, p);
            if (initial !== undefined && await observeInitialStateRecoveryFailure(store, p) !== initial) throw new PrivateStateRecoveryRefusal();
            await revalidate();
            return artifact;
          } } });
        await revalidate();
        return result.status === "conflict" ? { status: "conflict" as const } :
          { status: result.status, recoveryRunId: result.run.id, stateVersionId: result.stateVersion.id, capsuleId: result.capsule.id };
      } catch { throw new PrivateStateRecoveryRefusal(); }
    },
  });
}
export type PrivateStateRecoveryOperator = ReturnType<typeof createPrivateStateRecoveryOperator>;
/** No implicit financial/storage profile or development encryption fallback. */
export type PrivateRecoveryStorageProfile =
  | { readonly kind: "oss-r2" }
  | { readonly kind: "artifact-retention"; readonly storageUsage: ArtifactStorageUsagePort }
  | { readonly kind: "stored-service"; readonly storedService: StoredServiceComposition };
/** Named-only host factory. Existing schema is verified; bootstrap/migration is never selected. */
export function createPrivateR2StateRecoveryOperator(input: {
  readonly selectedTargetId: string;
  readonly approvals: QualifiedStateRecoveryApprovalPort;
  readonly openBindings: () => {
    readonly database: D1Database;
    readonly bucket: R2Bucket;
    readonly cryptoEnv: SecretCryptoEnvLike;
    readonly storageProfile: PrivateRecoveryStorageProfile;
  };
}) {
  const { selectedTargetId, approvals, openBindings } = input;
  return createPrivateStateRecoveryOperator({ selectedTargetId, approvals,
    openResources: async () => {
      const { database, bucket, cryptoEnv: suppliedCrypto, storageProfile: profile } = openBindings();
      if (!profile || (profile.kind !== "oss-r2" && profile.kind !== "artifact-retention" && profile.kind !== "stored-service") ||
        (profile.kind === "artifact-retention" && !profile.storageUsage) ||
        (profile.kind === "stored-service" && !profile.storedService)) throw new PrivateStateRecoveryRefusal();
      const cryptoEnv: Record<string, string | undefined> = {};
      const storageUsage = profile.kind === "artifact-retention" ? profile.storageUsage : undefined;
      const storedService = profile.kind === "stored-service" ? profile.storedService : undefined;
      for (const key of [...SECRET_STORE_KEY_ENV_KEYS, SECRET_STORE_PARTITION_KEYS_ENV]) cryptoEnv[key] = suppliedCrypto[key];
      const crypto = StateArtifactCrypto.fromEnv(cryptoEnv);
      await initializeD1OpenTofuLedgerSchemaBinding(database, "predeployed");
      const store = createCloudflareD1OpenTofuControlStore(database, { schemaMode: "predeployed" });
      const artifacts = new R2RecoveryStateArtifactStore({ bucket, crypto,
        allocator: new ObjectKeyArtifactReferenceAllocator(), capsules: store,
        ...(storageUsage ? { storageUsage } : storedService ? { storedService } : {}) });
      return { store, artifacts };
    } });
}
