import type { AccountsStore } from "./store.ts";
import type { IdentityMergeOperation } from "./identity-state.ts";
import {
  activateIdentityMerge,
  IdentityMergeConflict,
  type IdentityMergeReconciler,
} from "./identity-merge.ts";

const checkpointKey = "auth-staging.identity-merge-retry@v1";
const leaseDurationMs = 60_000;
const maximumBatchSize = 100;
const recoveryRequired = "reviewed_recovery_required";
const readinessTimeoutMs = 1_000;

/** Internal service capability. It is never accepted from browser JSON. The
 * owning stage entry injects the same service that its scheduled handler runs. */
export interface IdentityMergeRetryCapability {
  readonly pendingCapacity: number;
  assertAvailable(operation?: IdentityMergeOperation): Promise<void>;
}

interface RetryCheckpoint {
  revision: number;
  mutationId: string;
  cursor?: string;
  leaseId?: string;
  leaseExpiresAt?: number;
  nextPollAt?: number;
  updatedAt: number;
}

interface RetryStore extends AccountsStore {
  listIdentityMergeOperations(input: {
    after?: string;
    limit: number;
  }): Promise<{
    operations: readonly IdentityMergeOperation[];
    nextCursor?: string;
  }>;
  findIdentityMergeRetryCheckpoint(key: string): Promise<RetryCheckpoint | undefined>;
  compareAndSetIdentityMergeRetryCheckpoint(input: {
    key: string;
    expectedRevision?: number;
    next: RetryCheckpoint;
  }): Promise<boolean>;
}

export interface IdentityMergeRetryBatchResult {
  status: "completed" | "busy" | "unavailable";
  scanned: number;
  activated: number;
  pending: number;
  recoveryRequired: number;
  conflicts: number;
  failed: number;
  /** Bounded opaque operation references; no accounts, addresses or proofs. */
  operations: readonly {
    operationId: string;
    status: "activated" | "pending" | "reviewed_recovery_required" | "conflict" | "failed";
  }[];
}

export interface IdentityMergeRetryService extends IdentityMergeRetryCapability {
  runBatch(): Promise<IdentityMergeRetryBatchResult>;
}

/** Trusted scheduled/private stage composition only. All durable state remains
 * in the existing Accounts database. Owner readiness must check real configured
 * adapters; neither this runner nor a missing adapter can manufacture an ACK. */
export function createIdentityMergeRetryService(input: {
  store: AccountsStore;
  reconciler?: IdentityMergeReconciler;
  assertOwnerReadiness?: (operation?: IdentityMergeOperation) => Promise<boolean>;
  stage: {
    environment: string;
    issuerOrigin: string;
    hostedSessionPolicy: boolean;
    accountsSchemaHead: number;
    accountsSchemaMode: string;
  };
  now?: () => number;
  batchSize?: number;
  ownerAttemptTimeoutMs?: number;
  maxBatchDurationMs?: number;
}): IdentityMergeRetryService {
  const stage = { ...input.stage };
  if (
    stage.environment !== "staging" ||
    stage.issuerOrigin !== "https://auth-staging.takos.jp" ||
    stage.hostedSessionPolicy !== true ||
    stage.accountsSchemaHead !== 5 ||
    stage.accountsSchemaMode !== "predeployed"
  ) throw new TypeError("identity_merge_retry_stage_required");
  const batchSize = input.batchSize ?? 25;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > maximumBatchSize)
    throw new TypeError("invalid_identity_merge_retry_batch_size");
  const ownerAttemptTimeoutMs = input.ownerAttemptTimeoutMs ?? 5_000;
  const maxBatchDurationMs = input.maxBatchDurationMs ?? 30_000;
  if (!Number.isSafeInteger(ownerAttemptTimeoutMs) || ownerAttemptTimeoutMs < 1 || ownerAttemptTimeoutMs > 10_000 ||
    !Number.isSafeInteger(maxBatchDurationMs) || maxBatchDurationMs < ownerAttemptTimeoutMs + readinessTimeoutMs || maxBatchDurationMs > 45_000)
    throw new TypeError("invalid_identity_merge_retry_time_budget");
  const maximumAttempts = Math.min(batchSize, Math.floor(maxBatchDurationMs / (ownerAttemptTimeoutMs + readinessTimeoutMs)));
  // Three cadence turns leave a margin within the five-minute proof lifetime.
  // The reservation CAS enforces this same limit atomically before fencing.
  const pendingCapacity = Math.min(maximumBatchSize, maximumAttempts * 3);
  const clock = input.now ?? Date.now;
  const store = input.store;
  const reconciler = input.reconciler;
  const checkOwnerReadiness = input.assertOwnerReadiness;
  const boundedReconciler = reconciler && {
    reconcile: (operation: IdentityMergeOperation) => boundedAttempt(
      () => reconciler.reconcile(structuredClone(operation)),
      ownerAttemptTimeoutMs,
      "merge_reconciliation_pending",
    ),
  };

  async function ready(operation?: IdentityMergeOperation): Promise<boolean> {
    if (!hasRetryPorts(store) || !reconciler || !checkOwnerReadiness) return false;
    try {
      return await boundedAttempt(
        () => checkOwnerReadiness(operation && structuredClone(operation)),
        readinessTimeoutMs,
        "merge_retry_unavailable",
      ) === true;
    } catch {
      return false;
    }
  }

  return Object.freeze<IdentityMergeRetryService>({
    pendingCapacity,
    async assertAvailable(operation) {
      if (!await ready(operation)) throw new IdentityMergeConflict("merge_retry_unavailable");
      const page = await (store as RetryStore).listIdentityMergeOperations({ limit: pendingCapacity });
      if (page.nextCursor !== undefined || page.operations.length >= pendingCapacity)
        throw new IdentityMergeConflict("merge_retry_unavailable");
      if (operation) {
        const deadline = await retryDeadline(store, operation);
        const cadenceTurns = Math.ceil(pendingCapacity / maximumAttempts);
        if (deadline === undefined || deadline <= validNow(clock()) + cadenceTurns * leaseDurationMs + ownerAttemptTimeoutMs + readinessTimeoutMs)
          throw new IdentityMergeConflict("merge_retry_unavailable");
      }
    },
    async runBatch() {
      if (!hasRetryPorts(store)) return emptyResult("unavailable");
      const acquiredAt = validNow(clock());
      const prior = await store.findIdentityMergeRetryCheckpoint(checkpointKey);
      if ((prior?.leaseExpiresAt !== undefined && prior.leaseExpiresAt > acquiredAt) ||
        (prior?.nextPollAt !== undefined && prior.nextPollAt > acquiredAt))
        return emptyResult("busy");
      const leaseId = crypto.randomUUID();
      const checkpoint: RetryCheckpoint = {
        revision: (prior?.revision ?? -1) + 1,
        mutationId: crypto.randomUUID(),
        ...(prior?.cursor === undefined ? {} : { cursor: prior.cursor }),
        leaseId,
        leaseExpiresAt: acquiredAt + leaseDurationMs,
        nextPollAt: acquiredAt + leaseDurationMs,
        updatedAt: acquiredAt,
      };
      if (!await store.compareAndSetIdentityMergeRetryCheckpoint({
        key: checkpointKey,
        expectedRevision: prior?.revision,
        next: checkpoint,
      })) return emptyResult("busy");

      const result = emptyResult("completed");
      let nextCursor = checkpoint.cursor;
      let attempts = 0;
      try {
        const page = await store.listIdentityMergeOperations({
          ...(checkpoint.cursor === undefined ? {} : { after: checkpoint.cursor }),
          limit: batchSize,
        });
        if (page.operations.length > batchSize) throw new Error("identity_merge_retry_unbounded_page");
        let finishedPage = true;
        for (const listed of page.operations) {
          // Refresh persisted revision rather than trusting a caller DTO or an
          // earlier list snapshot. Every authority transition retains its CAS.
          const operation = await store.findIdentityMergeOperation!(listed.operationId);
          if (!operation || !retryable(operation)) {
            result.scanned++;
            nextCursor = listed.operationId;
            continue;
          }
          if (attempts >= maximumAttempts || validNow(clock()) + ownerAttemptTimeoutMs + readinessTimeoutMs > acquiredAt + maxBatchDurationMs) {
            finishedPage = false;
            break;
          }
          attempts++;
          result.scanned++;
          try {
            const now = validNow(clock());
            if (operation.conflict === recoveryRequired || await freshnessExpired(store, operation, now)) {
              await markRecoveryRequired(store, operation, now);
              result.recoveryRequired++;
              result.operations = [...result.operations, { operationId: operation.operationId, status: recoveryRequired }];
            } else if (!await ready(operation)) {
              result.pending++;
              result.operations = [...result.operations, { operationId: operation.operationId, status: "pending" }];
            } else {
              await activateIdentityMerge({ store, operation, reconciler: boundedReconciler, now: validNow(clock()), clock });
              result.activated++;
              result.operations = [...result.operations, { operationId: operation.operationId, status: "activated" }];
            }
          } catch (error) {
            if (error instanceof IdentityMergeConflict && error.code === "merge_reconciliation_pending") {
              result.pending++;
              result.operations = [...result.operations, { operationId: operation.operationId, status: "pending" }];
            } else if (error instanceof IdentityMergeConflict) {
              result.conflicts++;
              result.operations = [...result.operations, { operationId: operation.operationId, status: "conflict" }];
            } else {
              result.failed++;
              result.operations = [...result.operations, { operationId: operation.operationId, status: "failed" }];
            }
          }
          nextCursor = listed.operationId;
        }
        // A partial page advances only through visited operation references.
        // This prevents both skipping later work and starving it behind retries.
        if (finishedPage) nextCursor = page.nextCursor;
        return structuredClone(result);
      } finally {
        // A replacement lease wins its own revision; this stale invocation can
        // neither erase it nor move its cursor. No automatic replay on errors.
        await store.compareAndSetIdentityMergeRetryCheckpoint({
          key: checkpointKey,
          expectedRevision: checkpoint.revision,
          next: {
            revision: checkpoint.revision + 1,
            mutationId: crypto.randomUUID(),
            ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
            nextPollAt: checkpoint.nextPollAt,
            updatedAt: validNow(clock()),
          },
        });
      }
    },
  });
}

function hasRetryPorts(store: AccountsStore): store is RetryStore {
  const candidate = store as Partial<RetryStore>;
  return [
    candidate.listIdentityMergeOperations,
    candidate.findIdentityMergeRetryCheckpoint,
    candidate.compareAndSetIdentityMergeRetryCheckpoint,
    candidate.findIdentityMergeOperation,
    candidate.compareAndSetIdentityMerge,
    candidate.findIdentityOperationReceipt,
    candidate.findAccountEmailProof,
  ].every((port) => typeof port === "function");
}

function retryable(operation: IdentityMergeOperation): boolean {
  return (operation.status === "proved" || operation.status === "reconciled") &&
    operation.consentAt !== undefined && !!operation.sourceProof && !!operation.targetProof;
}

async function freshnessExpired(store: AccountsStore, operation: IdentityMergeOperation, now: number): Promise<boolean> {
  if (operation.expiresAt <= now) return true;
  const [sourceReceipt, targetReceipt, sourceEmail, targetEmail] = await Promise.all([
    store.findIdentityOperationReceipt!(operation.sourceProof!.receiptId),
    store.findIdentityOperationReceipt!(operation.targetProof!.receiptId),
    store.findAccountEmailProof!(operation.sourceSubject),
    store.findAccountEmailProof!(operation.targetSubject),
  ]);
  return [sourceReceipt?.expiresAt, targetReceipt?.expiresAt, sourceEmail?.validUntil, targetEmail?.validUntil]
    .some((expiry) => expiry !== undefined && expiry <= now);
}

async function retryDeadline(store: AccountsStore, operation: IdentityMergeOperation): Promise<number | undefined> {
  if (!operation.sourceProof || !operation.targetProof) return undefined;
  const [sourceReceipt, targetReceipt, sourceEmail, targetEmail] = await Promise.all([
    store.findIdentityOperationReceipt!(operation.sourceProof.receiptId),
    store.findIdentityOperationReceipt!(operation.targetProof.receiptId),
    store.findAccountEmailProof!(operation.sourceSubject),
    store.findAccountEmailProof!(operation.targetSubject),
  ]);
  const deadlines = [operation.expiresAt, sourceReceipt?.expiresAt, targetReceipt?.expiresAt, sourceEmail?.validUntil, targetEmail?.validUntil];
  if (deadlines.some((deadline) => deadline === undefined || !Number.isSafeInteger(deadline))) return undefined;
  return Math.min(...deadlines as number[]);
}

async function markRecoveryRequired(store: AccountsStore, operation: IdentityMergeOperation, now: number): Promise<void> {
  if (operation.conflict === recoveryRequired) return;
  if (!await store.compareAndSetIdentityMerge!({
    expectedRevision: operation.revision,
    next: {
      ...operation,
      conflict: recoveryRequired,
      revision: operation.revision + 1,
      mutationId: crypto.randomUUID(),
      updatedAt: now,
    },
    now,
    requireRecovery: true,
  })) throw new IdentityMergeConflict("merge_conflict");
}

function emptyResult(status: IdentityMergeRetryBatchResult["status"]): IdentityMergeRetryBatchResult {
  return { status, scanned: 0, activated: 0, pending: 0, recoveryRequired: 0, conflicts: 0, failed: 0, operations: [] };
}

function validNow(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("invalid_identity_merge_retry_clock");
  return now;
}

async function boundedAttempt<T>(attempt: () => Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(attempt),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new IdentityMergeConflict(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
