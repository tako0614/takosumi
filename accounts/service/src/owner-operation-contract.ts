import type { ControlIdentityReceipt } from "../../../contract/identity-reconciliation.ts";
import type {
  IdentityExternalOwnerContext,
  IdentityExternalOwnerKind,
  IdentityExternalOwnerReceipt,
} from "./control-identity-reconciler.ts";

/** Private service protocol; this is not an OAuth client or a public route. */
export const OWNER_OPERATION_PROTOCOL = "takosumi.accounts.owner-operation@v1";
export const OWNER_OPERATION_OWNER = "hosted-intents";
export const OWNER_OPERATION_ENTRYPOINT = "AccountsOwnerAdmission";

export type OwnerOperationKind = IdentityExternalOwnerContext["kind"];
export type OwnerOperationPurpose = "readiness" | "reconcile" | "readback" | "release";
export interface OwnerOperationRequest {
  readonly operationId: string;
  readonly kind: OwnerOperationKind;
  /** Core-owned opaque digest; retain its exact existing representation. */
  readonly planDigest: string;
  readonly purpose: OwnerOperationPurpose;
}

/** Captured by the trusted callee composition. These strings describe an
 * identity; neither a descriptor nor this DTO qualifies a deployment graph. */
export interface OwnerOperationTarget {
  readonly ownerKind: typeof OWNER_OPERATION_OWNER;
  /** Private service identity supplied by trusted composition, not an RP ID. */
  readonly ownerClientId: string;
  readonly targetBindingDigest: string;
}

export interface OwnerOperationCurrentState {
  readonly sourceGeneration: number;
  readonly targetGeneration: number;
  readonly sourceCanonical: string;
  readonly targetCanonical: string;
  readonly sourceFenced: boolean;
  readonly targetFenced: boolean;
  readonly sourceLockOperationId?: string;
  readonly targetLockOperationId?: string;
}

/** PRE-review owner subject digest excludes the root approval and the outer
 * owner envelope. The approval binds this digest; the envelope binds both. */
export interface OwnerOperationRecoveryEvidence {
  readonly recoveryId: string;
  readonly reviewedApprovalRef: string;
  readonly approvalDigest: string;
  readonly decisionDigest: string;
  readonly ownerEvidenceDigest: string;
}

/** The fresh method checks the current approved pointer and expiry. The
 * historical method verifies an exact retained signed record for readback;
 * it cannot supply fresh approval or move any operation out of its fence. */
export interface OwnerOperationRecoveryEvidenceReader {
  readRecoveryEvidence(input: {
    readonly operationId: string;
    readonly recoveryId: string;
  }): Promise<OwnerOperationRecoveryEvidence | undefined>;
  readHistoricalRecoveryEvidence(input: {
    readonly operationId: string;
    readonly recoveryId: string;
    readonly approvalDigest: string;
  }): Promise<OwnerOperationRecoveryEvidence | undefined>;
  readHistoricalRecoveryEvidenceByReviewRef(input: {
    readonly operationId: string;
    readonly recoveryId: string;
    readonly reviewedApprovalRef: string;
  }): Promise<OwnerOperationRecoveryEvidence | undefined>;
}

/** Recorded after actual Core readback and before the first durable external call.
 * It preserves original ancestry when Core's latest receipt later changes. */
export interface OwnerOperationContextEvidence {
  readonly version: "takosumi.accounts.owner-context@v1";
  readonly evidenceId: string;
  readonly context: IdentityExternalOwnerContext;
  readonly coreReceipt: ControlIdentityReceipt;
  readonly target: OwnerOperationTarget;
  readonly capturedOperationRevision: number;
  readonly capturedAt: number;
  readonly recovery?: OwnerOperationRecoveryEvidence;
}

/** Only an actual validated durable owner readback may create this record. */
export interface OwnerOperationReceiptEvidence {
  readonly contextEvidenceId: string;
  readonly ownerKind: IdentityExternalOwnerKind;
  readonly receipt: IdentityExternalOwnerReceipt;
  readonly observedAt: number;
}

export interface OwnerOperationTerminalEvidence {
  readonly outcome: "active" | "unlink-completed" | "aborted" | "restored";
  /** The terminal recovery context may differ from the requested original
   * merge context. Never substitute its receipt for the original ancestry. */
  readonly contextEvidence: OwnerOperationContextEvidence;
  readonly ownerReceipts: Readonly<Record<IdentityExternalOwnerKind, OwnerOperationReceiptEvidence>>;
  readonly receiptSetDigest: string;
  readonly recovery?: OwnerOperationRecoveryEvidence;
}

interface OwnerOperationObservation {
  readonly protocol: typeof OWNER_OPERATION_PROTOCOL;
  readonly target: OwnerOperationTarget;
  readonly context: IdentityExternalOwnerContext;
  readonly operationRevision: number;
  readonly current: OwnerOperationCurrentState;
  readonly accountsStateDigest: string;
  readonly observedAt: number;
}

export type OwnerOperationAdmission =
  | (OwnerOperationObservation & {
    readonly admission: "fresh";
    readonly purpose: "readiness" | "reconcile";
    readonly lifecyclePhase: "planning" | "reserved" | "unlink-pending" | "recovery-pending";
    readonly freshUntil: number;
    readonly contextEvidence?: OwnerOperationContextEvidence;
    readonly recovery?: OwnerOperationRecoveryEvidence;
  })
  | (OwnerOperationObservation & {
    readonly admission: "historical";
    readonly purpose: "readback";
    readonly lifecyclePhase: "reserved" | "active" | "unlink-pending" | "unlink-completed" | "recovery-pending" | "aborted" | "restored";
    readonly contextEvidence: OwnerOperationContextEvidence;
  })
  | (OwnerOperationObservation & {
    readonly admission: "terminal-release";
    readonly purpose: "release";
    readonly lifecyclePhase: "active" | "unlink-completed" | "aborted" | "restored";
    readonly contextEvidence: OwnerOperationContextEvidence;
    readonly terminal: OwnerOperationTerminalEvidence;
  });

/** Undefined is an unavailable admission, never permission to repair, release
 * a barrier, activate an account or substitute another owner receipt. */
export interface OwnerOperationReader {
  readOwnerOperation(input: unknown): Promise<OwnerOperationAdmission | undefined>;
}
