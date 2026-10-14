/**
 * Dormant SOURCE-only operator composition. This is not a route, CLI, or
 * production entrypoint. A private one-shot host must independently establish
 * the operator identity and exact authorization, and supply an operator-private
 * durable journal with no-overwrite writes and 0700/0600 storage permissions.
 * Neither this module nor the public Worker grants those capabilities.
 */
import { stableJsonDigest, stableStringify } from "../../core/adapters/source/digest.ts";
import {
  recoverFailedInitialCreateState,
  type VerifiedRecoveryArtifact,
} from "../../core/domains/deploy-control/operator_state_recovery.ts";
import { OpenTofuControllerError } from "../../core/domains/deploy-control/errors.ts";
import type { OpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
import {
  RECOVERY_STATE_MAX_BYTES,
  assertRecoveryArtifactMatchesAuthorizedScope,
  type RecoveryStateArtifactScope,
  type StageRecoveryStateInput,
  type StagedRecoveryStateArtifact,
} from "../../worker/src/state_recovery_artifact_store.ts";
import { digestBytes } from "../../worker/src/state_crypto.ts";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const JOURNAL_FORMAT = "takosumi.operator-source-recovery-journal@v1" as const;
const DECISION_FORMAT = "takosumi.verified-operator-source-recovery-decision@v1" as const;

/** The host must verify this complete binding independently of caller claims. */
export interface OperatorRecoveryBinding {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly failedApplyRunId: string;
  readonly recoveryRunId: string;
  readonly plaintextSha256: `sha256:${string}`;
  readonly custodyEvidenceDigest: `sha256:${string}`;
}

export interface VerifiedOperatorRecoveryDecision {
  readonly format: typeof DECISION_FORMAT;
  /** Digest of the exact binding presented to the verifier, not an audience wildcard. */
  readonly requestDigest: `sha256:${string}`;
  readonly actorId: string;
}

export interface OperatorRecoveryAuthorization {
  /** Host must return a fixed decision; mutation before resolution is indistinguishable from its own verified result. */
  verify(binding: OperatorRecoveryBinding): Promise<VerifiedOperatorRecoveryDecision>;
}

/** Exact private retry identity, persisted before plaintext is selected. */
export interface OperatorRecoveryJournalIntent extends OperatorRecoveryBinding {
  readonly format: typeof JOURNAL_FORMAT;
  readonly actorId: string;
  readonly timestamp: string;
  readonly requestDigest: `sha256:${string}`;
}

export interface OperatorRecoveryJournalStaged {
  readonly intent: OperatorRecoveryJournalIntent;
  readonly artifactHandle: string;
}

/**
 * Host obligation: durable operator-private storage, no overwrite of either
 * slot, atomic create/readback, and integrity/access protection. Returning an
 * existing record is allowed only so this module can compare it exactly.
 * A test double or ordinary repository file is not a production journal.
 */
export interface OperatorRecoveryJournal {
  read(failedApplyRunId: string): Promise<{
    readonly intent: OperatorRecoveryJournalIntent;
    readonly staged?: OperatorRecoveryJournalStaged;
  } | undefined>;
  putIntentIfAbsent(intent: OperatorRecoveryJournalIntent): Promise<OperatorRecoveryJournalIntent>;
  putStagedIfAbsent(staged: OperatorRecoveryJournalStaged): Promise<OperatorRecoveryJournalStaged>;
}

export interface OperatorRecoveryArtifactPort {
  stage(input: StageRecoveryStateInput): Promise<StagedRecoveryStateArtifact>;
  verify(input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly failedApplyRunId: string;
    readonly recoveryRunId: string;
    readonly artifactHandle: string;
  }): Promise<VerifiedRecoveryArtifact>;
}

export interface OperatorSourceRecoveryPorts {
  readonly store: OpenTofuControlStore;
  readonly authorization: OperatorRecoveryAuthorization;
  readonly journal: OperatorRecoveryJournal;
  /** Must return a new opaque ID only for a first attempt. */
  readonly newRecoveryRunId: () => string;
  readonly now: () => string;
  /** Must select state under the same independently verified custody. */
  readonly loadSelectedPlaintext: (binding: OperatorRecoveryBinding) => Promise<Uint8Array>;
  readonly artifacts: OperatorRecoveryArtifactPort;
}

export interface OperatorSourceRecoveryRequest {
  readonly failedApplyRunId: string;
  readonly plaintextSha256: `sha256:${string}`;
  readonly custodyEvidenceDigest: `sha256:${string}`;
}

export type OperatorSourceRecoveryResult =
  | { readonly status: "committed" | "replayed"; readonly recoveryRunId: string }
  | { readonly status: "conflict" | "needs_reconciliation"; readonly possibleOrphan: {
      readonly workspaceId: string;
      readonly capsuleId: string;
      readonly environment: string;
      readonly failedApplyRunId: string;
      readonly recoveryRunId: string;
      readonly artifactHandle: string;
    } };

function refuse(): never {
  // Never include a state byte, provider diagnostic, journal body or credential.
  throw new Error("operator SOURCE recovery refused; inspect private evidence and reconcile exact retry");
}

function exact(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 384 &&
    value.trim() === value && value !== "*" && !/[\x00-\x1f\x7f]/u.test(value);
}

async function authorize(
  port: OperatorRecoveryAuthorization,
  binding: OperatorRecoveryBinding,
  expectedActor?: string,
): Promise<VerifiedOperatorRecoveryDecision> {
  const requestDigest = await stableJsonDigest({ kind: "takosumi.operator-source-recovery-authorization@v1", binding });
  // The port receives an immutable *copy*. `readonly` alone is erased by JS;
  // a verifier must not turn its proof into authority for a later scope.
  const presented = Object.freeze({ ...binding });
  let decision: VerifiedOperatorRecoveryDecision;
  try { decision = await port.verify(presented); } catch { return refuse(); }
  if (!decision || Object.keys(decision).sort().join(",") !== "actorId,format,requestDigest") refuse();
  // Snapshot the port's return synchronously, before the next await gives a
  // retained mutable decision object a chance to change its actor.
  const resolved = Object.freeze({
    format: decision.format, requestDigest: decision.requestDigest, actorId: decision.actorId,
  });
  if (!exact(presented, binding) ||
    await stableJsonDigest({ kind: "takosumi.operator-source-recovery-authorization@v1", binding }) !== requestDigest) refuse();
  if (resolved.format !== DECISION_FORMAT || resolved.requestDigest !== requestDigest ||
    !validIdentifier(resolved.actorId) ||
    (expectedActor !== undefined && resolved.actorId !== expectedActor)) return refuse();
  return resolved;
}

function assertIntent(value: OperatorRecoveryJournalIntent, binding: OperatorRecoveryBinding,
  actorId: string, requestDigest: string): void {
  if (!value || Object.keys(value).sort().join(",") !==
    "actorId,capsuleId,custodyEvidenceDigest,environment,failedApplyRunId,format,plaintextSha256,recoveryRunId,requestDigest,timestamp,workspaceId" ||
    value.format !== JOURNAL_FORMAT || !exact({
      workspaceId: value.workspaceId, capsuleId: value.capsuleId,
      environment: value.environment, failedApplyRunId: value.failedApplyRunId,
      recoveryRunId: value.recoveryRunId, plaintextSha256: value.plaintextSha256,
      custodyEvidenceDigest: value.custodyEvidenceDigest,
    }, binding) || value.actorId !== actorId || value.requestDigest !== requestDigest ||
    !Number.isFinite(Date.parse(value.timestamp)) || new Date(value.timestamp).toISOString() !== value.timestamp) refuse();
}

function assertStaged(value: OperatorRecoveryJournalStaged, intent: OperatorRecoveryJournalIntent): void {
  if (!value || Object.keys(value).sort().join(",") !== "artifactHandle,intent" ||
    !exact(value.intent, intent) || typeof value.artifactHandle !== "string" ||
    value.artifactHandle.length === 0 || value.artifactHandle.length > 4096 ||
    /[\x00-\x1f\x7f]/u.test(value.artifactHandle)) refuse();
}

/**
 * Source-only; never infers provider success, creates Output, or cleans an
 * occupied artifact. Core owns final atomic quiescence/CAS and exact replay.
 */
export async function composeOperatorSourceRecovery(
  ports: OperatorSourceRecoveryPorts,
  request: OperatorSourceRecoveryRequest,
): Promise<OperatorSourceRecoveryResult> {
  const selectedRequest = Object.freeze({ ...request });
  if (!validIdentifier(selectedRequest.failedApplyRunId) || !SHA256.test(selectedRequest.plaintextSha256) ||
    !SHA256.test(selectedRequest.custodyEvidenceDigest)) refuse();
  let failed: Awaited<ReturnType<OpenTofuControlStore["getApplyRun"]>>;
  try { failed = await ports.store.getApplyRun(selectedRequest.failedApplyRunId); } catch { return refuse(); }
  if (!failed || failed.status !== "failed" || failed.operation !== "create" || !failed.capsuleId) refuse();
  let capsule: Awaited<ReturnType<OpenTofuControlStore["getCapsule"]>>;
  try { capsule = await ports.store.getCapsule(failed.capsuleId); } catch { return refuse(); }
  if (!capsule || capsule.workspaceId !== failed.workspaceId || !validIdentifier(capsule.environment)) refuse();

  let prior: Awaited<ReturnType<OperatorRecoveryJournal["read"]>>;
  try { prior = await ports.journal.read(failed.id); } catch { return refuse(); }
  if (prior && (!prior.intent || typeof prior.intent !== "object")) refuse();
  const priorIntent = prior?.intent && Object.freeze({ ...prior.intent });
  const priorStaged = prior?.staged && Object.freeze({
    intent: Object.freeze({ ...prior.staged.intent }), artifactHandle: prior.staged.artifactHandle,
  });
  let recoveryRunId: string;
  try { recoveryRunId = priorIntent?.recoveryRunId ?? ports.newRecoveryRunId(); } catch { return refuse(); }
  if (!validIdentifier(recoveryRunId)) refuse();
  const binding: OperatorRecoveryBinding = Object.freeze({
    workspaceId: capsule.workspaceId, capsuleId: capsule.id, environment: capsule.environment,
    failedApplyRunId: failed.id, recoveryRunId,
    plaintextSha256: selectedRequest.plaintextSha256,
    custodyEvidenceDigest: selectedRequest.custodyEvidenceDigest,
  });
  const decision = await authorize(ports.authorization, binding);
  let timestamp: string;
  try { timestamp = priorIntent?.timestamp ?? ports.now(); } catch { return refuse(); }
  if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) refuse();
  const proposedIntent: OperatorRecoveryJournalIntent = Object.freeze({
    format: JOURNAL_FORMAT, ...binding, actorId: decision.actorId,
    timestamp, requestDigest: decision.requestDigest,
  });
  if (priorIntent) assertIntent(priorIntent, binding, decision.actorId, decision.requestDigest);
  let intent: OperatorRecoveryJournalIntent;
  try { intent = Object.freeze({ ...await ports.journal.putIntentIfAbsent(proposedIntent) }); } catch { return refuse(); }
  assertIntent(intent, binding, decision.actorId, decision.requestDigest);
  if (!exact(intent, proposedIntent)) refuse();

  let staged = priorStaged;
  if (staged) assertStaged(staged, intent);
  if (!staged) {
    // An unresolved stage acknowledgement is reconciled by rerunning the
    // existing adapter at this same journaled coordinate, never by a new ID.
    let selected: Uint8Array;
    try { selected = await ports.loadSelectedPlaintext(binding); } catch { return refuse(); }
    if (!(selected instanceof Uint8Array) || selected.byteLength === 0 ||
      selected.byteLength > RECOVERY_STATE_MAX_BYTES) refuse();
    // The selection port may retain its buffer. Stage a bounded private copy,
    // not bytes it can change after the digest check.
    let plaintext: Uint8Array;
    try { plaintext = selected.slice(); } catch { return refuse(); }
    if (await digestBytes(plaintext) !== binding.plaintextSha256) refuse();
    const scope: RecoveryStateArtifactScope = Object.freeze({ ...binding, generation: 1 });
    let artifact: StagedRecoveryStateArtifact;
    try { artifact = await ports.artifacts.stage({ ...scope, plaintext }); } catch { return refuse(); }
    if (!artifact?.handle || artifact.artifact.plaintextSha256 !== binding.plaintextSha256 ||
      artifact.artifact.workspaceId !== binding.workspaceId ||
      artifact.artifact.capsuleId !== binding.capsuleId ||
      artifact.artifact.environment !== binding.environment ||
      artifact.artifact.recoveryRunId !== binding.recoveryRunId) refuse();
    const proposedStaged = Object.freeze({ intent, artifactHandle: artifact.handle });
    try {
      const stored = await ports.journal.putStagedIfAbsent(proposedStaged);
      staged = Object.freeze({ intent: Object.freeze({ ...stored.intent }), artifactHandle: stored.artifactHandle });
    } catch { return refuse(); }
    assertStaged(staged, intent);
    if (!exact(staged, proposedStaged)) refuse();
  }

  const handle = staged.artifactHandle;
  // The adapter verifies canonical allocation and encrypted readback, not a
  // caller-supplied URL or key. Core independently verifies once more.
  let verified: VerifiedRecoveryArtifact;
  try {
    verified = Object.freeze({ ...await ports.artifacts.verify({
      workspaceId: binding.workspaceId, capsuleId: binding.capsuleId,
      failedApplyRunId: binding.failedApplyRunId, recoveryRunId: binding.recoveryRunId,
      artifactHandle: handle,
    }) });
  } catch { return refuse(); }
  try {
    await assertRecoveryArtifactMatchesAuthorizedScope({
      scope: Object.freeze({ ...binding, generation: 1 }), artifactHandle: handle, artifact: verified,
    });
  } catch { return refuse(); }
  await authorize(ports.authorization, binding, intent.actorId);

  const possibleOrphan = {
    workspaceId: binding.workspaceId, capsuleId: binding.capsuleId,
    environment: binding.environment, failedApplyRunId: binding.failedApplyRunId,
    recoveryRunId: binding.recoveryRunId, artifactHandle: handle,
  };
  try {
    const result = await recoverFailedInitialCreateState({
      store: ports.store, verifier: ports.artifacts, artifactHandle: handle,
      failedApplyRunId: binding.failedApplyRunId, recoveryRunId: binding.recoveryRunId,
      createdBy: intent.actorId, now: intent.timestamp,
    });
    return result.status === "conflict"
      ? { status: "conflict", possibleOrphan }
      : { status: result.status, recoveryRunId: binding.recoveryRunId };
  } catch (error) {
    // The commit acknowledgement may be unknown. The exact journaled retry
    // reconciles Core; no cleanup or second Run is attempted here.
    return error instanceof OpenTofuControllerError &&
      (error.details as { reason?: unknown } | undefined)?.reason === "state_recovery_conflict"
      ? { status: "conflict", possibleOrphan }
      : { status: "needs_reconciliation", possibleOrphan };
  }
}
