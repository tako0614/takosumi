import type { ControlIdentityContextPlan } from "../../../contract/identity-reconciliation.ts";
import {
  prepareIdentityMergeContextPlan,
  acceptIdentityMergeContextPlan,
  readIdentityMergeContextEvidence,
} from "./identity-context.ts";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { AccountSessionRecord, AccountsStore } from "./store.ts";
import type {
  AccountEmailProofRecord,
  IdentityMergeAcknowledgements,
  IdentityMergeRecoveryAcknowledgements,
  IdentityMergeOperation,
  IdentityMergeProof,
  IdentityOperationReceiptRecord,
  IdentityMergeSessionRequirement,
} from "./identity-state.ts";
import { identityRecordsEqual } from "./hosted-identity-records.ts";
import { normalizeMergeEmail } from "./identity-state.ts";
import { sha256Text } from "./encoding.ts";
import { errorJson, json, readJsonObject } from "./http-helpers.ts";

const freshnessMs = 5 * 60_000;
const basePath = "/api/v1/account/identity-merges";
const unlinkPath = "/api/v1/account/identity-credentials/unlink";
const mergeBrowserCookie = "__Host-takosumi-merge-browser";
const policyVersion = "takosumi.hosted-identity-merge@v1";

export interface IdentityMergeReconciler {
  prepareContextPlan?(
    operation: IdentityMergeOperation,
  ): Promise<ControlIdentityContextPlan>;
  assertContextPlanCurrent?(
    operation: IdentityMergeOperation,
  ): Promise<ControlIdentityContextPlan>;
  assertReady?(operation: IdentityMergeOperation): Promise<void>;
  /** Owner-reviewed references, never a default acknowledgement. Retry uses the
   * same operation ID and immutable Workspace/Organization/intent pins. */
  reconcile(
    operation: IdentityMergeOperation,
  ): Promise<IdentityMergeAcknowledgements | undefined>;
  /** Separately reviewed owner reconciliation; absent by default. */
  reconcileRecovery?(
    operation: IdentityMergeOperation,
  ): Promise<IdentityMergeRecoveryAcknowledgements | undefined>;
  acknowledgeCredentialUnlink?(input: {
    operationId: string;
    subject: TakosumiSubject;
  }): Promise<boolean>;
}

export class IdentityMergeConflict extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function createIdentityMerge(input: {
  store: AccountsStore;
  actor: TakosumiSubject;
  sourceSubject: TakosumiSubject;
  targetSubject: TakosumiSubject;
  browserBindingHash: string;
  now: number;
}): Promise<IdentityMergeOperation> {
  const { store, sourceSubject, targetSubject, actor, now } = input;
  if (
    !store.createIdentityMergeOperation ||
    !store.findCanonicalAccount ||
    sourceSubject === targetSubject ||
    ![sourceSubject, targetSubject].includes(actor)
  )
    throw new IdentityMergeConflict("merge_unavailable");
  const [source, target] = await Promise.all([
    store.findCanonicalAccount(sourceSubject),
    store.findCanonicalAccount(targetSubject),
  ]);
  if (source?.subject !== sourceSubject || target?.subject !== targetSubject)
    throw new IdentityMergeConflict("merge_conflict");
  const evidence = await eligibleEvidence(
    store,
    sourceSubject,
    targetSubject,
    now,
  );
  const operation: IdentityMergeOperation = {
    operationId: `imrg_${crypto.randomUUID()}`,
    sourceSubject,
    targetSubject,
    actor,
    addressDigest: await identityMergeAddressDigest(
      evidence[0].normalizedAddress,
    ),
    browserBindingHash: input.browserBindingHash,
    policyVersion,
    status: "pending",
    revision: 0,
    mutationId: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    expiresAt: now + freshnessMs,
  };
  if (!(await store.createIdentityMergeOperation(operation)))
    throw new IdentityMergeConflict("merge_conflict");
  return operation;
}

export async function proveIdentityMerge(input: {
  store: AccountsStore;
  operation: IdentityMergeOperation;
  session: AccountSessionRecord;
  receiptId?: string;
  now: number;
}): Promise<IdentityMergeOperation> {
  const { store, operation, session, now } = input;
  if (
    (operation.status !== "pending" && operation.status !== "proved") ||
    operation.consentAt ||
    ![operation.sourceSubject, operation.targetSubject].includes(
      session.subject,
    ) ||
    !input.receiptId ||
    !store.findIdentityOperationReceipt
  )
    throw new IdentityMergeConflict("operation_receipt_required");
  const receipt = await store.findIdentityOperationReceipt(input.receiptId);
  if (!receipt) throw new IdentityMergeConflict("merge_conflict");
  const role = receipt.role === "source" ? "sourceProof" : "targetProof";
  const latest = await store.findIdentityMergeOperation?.(
    operation.operationId,
  );
  if (
    latest?.[role]?.receiptId === receipt.receiptId &&
    receipt.consumedByOperation === operation.operationId
  )
    return latest;
  if (operation[role]) throw new IdentityMergeConflict("merge_conflict");
  await validateOperationReceipt(store, operation, receipt, now, false, 0);
  const evidence = await eligibleEvidence(
    store,
    operation.sourceSubject,
    operation.targetSubject,
    now,
  );
  if (
    (await identityMergeAddressDigest(evidence[0].normalizedAddress)) !==
    operation.addressDigest
  )
    throw new IdentityMergeConflict("merge_conflict");
  const proof: IdentityMergeProof = {
    subject: receipt.subject,
    providerId: receipt.providerId,
    receiptId: receipt.receiptId,
    method: receipt.method,
    identityGeneration: receipt.identityGeneration,
    provedAt: receipt.completedAt,
    legConsentAt: receipt.legConsentAt,
  };
  const next = {
    ...operation,
    [role]: proof,
    revision: operation.revision + 1,
    mutationId: crypto.randomUUID(),
    updatedAt: now,
  };
  if (next.sourceProof && next.targetProof) next.status = "proved";
  if (
    !store.compareAndSetIdentityMerge ||
    !(await store.compareAndSetIdentityMerge({
      expectedRevision: operation.revision,
      next,
      now,
      receipt,
      emailProofs: evidence,
    }))
  )
    throw new IdentityMergeConflict("merge_conflict");
  return next;
}

export async function consentIdentityMerge(input: {
  store: AccountsStore;
  operation: IdentityMergeOperation;
  session: AccountSessionRecord;
  now: number;
  consent: boolean;
  retryCapability?: import("./identity-merge-retry.ts").IdentityMergeRetryCapability;
  clock?: () => number;
  reconciler?: IdentityMergeReconciler;
}): Promise<IdentityMergeOperation> {
  const { store, operation, session } = input;
  let now = input.now;
  if (
    !input.consent ||
    operation.status !== "proved" ||
    operation.consentAt ||
    session.subject !== operation.targetSubject ||
    !operation.sourceProof ||
    !operation.targetProof
  )
    throw new IdentityMergeConflict("merge_conflict");
  if (!input.reconciler)
    throw new IdentityMergeConflict("merge_reconciliation_unavailable");
  if (!input.retryCapability)
    throw new IdentityMergeConflict("merge_retry_unavailable");
  await input.retryCapability.assertAvailable(operation);
  now = input.clock?.() ?? input.now;
  const receipts = await consumedProofReceipts(store, operation, now, 0);
  if (
    session.policy !== "hosted" ||
    session.expiresAt <= now ||
    !session.absoluteExpiresAt ||
    session.absoluteExpiresAt <= now ||
    session.authTime === undefined ||
    (session.identityGeneration ?? 0) !==
      (await store.getAccountAuthenticationGeneration?.(session.subject))
  )
    throw new IdentityMergeConflict("authentication_required");
  const evidence = await eligibleEvidence(
    store,
    operation.sourceSubject,
    operation.targetSubject,
    now,
  );
  if (
    (await identityMergeAddressDigest(evidence[0].normalizedAddress)) !==
    operation.addressDigest
  )
    throw new IdentityMergeConflict("merge_conflict");
  if (
    !input.reconciler.assertReady ||
    !input.reconciler.assertContextPlanCurrent
  )
    throw new IdentityMergeConflict("merge_reconciliation_unavailable");
  await input.reconciler.assertReady(operation);
  const approved = await input.reconciler.assertContextPlanCurrent(operation);
  now = input.clock?.() ?? input.now;
  const context = await readIdentityMergeContextEvidence(
    store,
    operation,
    now,
    0,
  );
  if (approved.digest !== context.plan.planDigest)
    throw new IdentityMergeConflict("context_plan_conflict");
  const finalReceipts = await consumedProofReceipts(store, operation, now, 0);
  const finalEvidence = await eligibleEvidence(
    store,
    operation.sourceSubject,
    operation.targetSubject,
    now,
  );
  const next = {
    ...operation,
    consentAt: now,
    revision: operation.revision + 1,
    mutationId: crypto.randomUUID(),
    updatedAt: now,
  };
  const requirements = [
    {
      sessionId: session.sessionId,
      subject: session.subject,
      authTime: session.authTime,
      reauthentication: false,
    },
  ];
  if (
    !store.compareAndSetIdentityMerge ||
    !(await store.compareAndSetIdentityMerge({
      expectedRevision: operation.revision,
      next,
      now,
      sessions: requirements,
      emailProofs: finalEvidence,
      proofReceipts: finalReceipts,
      contextPlanRecord: context.plan,
      contextReceipts: context.receipts,
      reserve: true,
      retryCapacity: input.retryCapability.pendingCapacity,
    }))
  )
    throw new IdentityMergeConflict("merge_conflict");
  return next;
}

export async function activateIdentityMerge(input: {
  store: AccountsStore;
  operation: IdentityMergeOperation;
  reconciler?: IdentityMergeReconciler;
  now: number;
  clock?: () => number;
}): Promise<IdentityMergeOperation> {
  const { store, operation, reconciler } = input;
  let now = input.now;
  if (operation.status === "active") return operation;
  if (operation.conflict === "reviewed_recovery_required")
    throw new IdentityMergeConflict("recovery_review_required");
  if (
    (operation.status !== "proved" && operation.status !== "reconciled") ||
    !operation.consentAt ||
    !operation.sourceProof ||
    !operation.targetProof
  )
    throw new IdentityMergeConflict("merge_conflict");
  let receipts = await consumedProofReceipts(store, operation, now, 1);
  let context = await readIdentityMergeContextEvidence(
    store,
    operation,
    now,
    1,
  );
  if (!reconciler)
    throw new IdentityMergeConflict("merge_reconciliation_pending");
  const ack =
    operation.acknowledgements ?? (await reconciler.reconcile(operation));
  now = input.clock?.() ?? input.now;
  receipts = await consumedProofReceipts(store, operation, now, 1);
  context = await readIdentityMergeContextEvidence(store, operation, now, 1);
  if (!completeAcknowledgements(operation, ack, now))
    throw new IdentityMergeConflict("merge_reconciliation_pending");
  const evidence = await eligibleEvidence(
    store,
    operation.sourceSubject,
    operation.targetSubject,
    now,
  );
  if (
    (await identityMergeAddressDigest(evidence[0].normalizedAddress)) !==
    operation.addressDigest
  )
    throw new IdentityMergeConflict("merge_conflict");
  let current = operation;
  if (current.status !== "reconciled") {
    const reconciled = {
      ...current,
      status: "reconciled" as const,
      acknowledgements: ack,
      revision: current.revision + 1,
      mutationId: crypto.randomUUID(),
      updatedAt: now,
    };
    if (
      !store.compareAndSetIdentityMerge ||
      !(await store.compareAndSetIdentityMerge({
        expectedRevision: current.revision,
        next: reconciled,
        now,
        emailProofs: evidence,
        proofReceipts: receipts,
        contextPlanRecord: context.plan,
        contextReceipts: context.receipts,
      }))
    )
      throw new IdentityMergeConflict("merge_conflict");
    current = reconciled;
  }
  const active = {
    ...current,
    status: "active" as const,
    revision: current.revision + 1,
    mutationId: crypto.randomUUID(),
    updatedAt: now,
  };
  if (
    !store.compareAndSetIdentityMerge ||
    !(await store.compareAndSetIdentityMerge({
      expectedRevision: current.revision,
      next: active,
      now,
      emailProofs: evidence,
      proofReceipts: receipts,
      contextPlanRecord: context.plan,
      contextReceipts: context.receipts,
      activate: true,
    }))
  )
    throw new IdentityMergeConflict("merge_conflict");
  return active;
}

export async function quarantineIdentityMerge(input: {
  store: AccountsStore;
  operation: IdentityMergeOperation;
  now: number;
  reason: string;
}): Promise<IdentityMergeOperation> {
  const next = {
    ...input.operation,
    status: "quarantined" as const,
    conflict: input.reason,
    revision: input.operation.revision + 1,
    mutationId: crypto.randomUUID(),
    updatedAt: input.now,
  };
  if (
    !input.store.compareAndSetIdentityMerge ||
    !(await input.store.compareAndSetIdentityMerge({
      expectedRevision: input.operation.revision,
      next,
      now: input.now,
      quarantine: true,
    }))
  )
    throw new IdentityMergeConflict("merge_conflict");
  return next;
}

/** Operator/support service port, deliberately absent from browser routes.
 * Authentication access is restored only after Workspace/billing/consumer
 * owners acknowledge their reviewed reconciliation; no financial row is
 * synthesized, forked or rolled back by Accounts. */
export async function restoreIdentityMerge(input: {
  store: AccountsStore;
  operation: IdentityMergeOperation;
  reconciler?: IdentityMergeReconciler;
  now: number;
}): Promise<IdentityMergeOperation> {
  const { store, operation, now } = input;
  if (
    operation.status !== "quarantined" ||
    !input.reconciler?.reconcileRecovery
  )
    throw new IdentityMergeConflict("recovery_review_required");
  const ack = await input.reconciler.reconcileRecovery(operation);
  if (
    !completeAcknowledgements(operation, ack, now) ||
    !ack.undoOperationId ||
    ack.undoOperationId === operation.operationId ||
    !ack.reviewedRecoveryRef
  )
    throw new IdentityMergeConflict("recovery_review_required");
  const next = {
    ...operation,
    status: "restored" as const,
    undoOperationId: ack.undoOperationId,
    recoveryAcknowledgements: ack,
    revision: operation.revision + 1,
    mutationId: crypto.randomUUID(),
    updatedAt: now,
  };
  if (
    !store.compareAndSetIdentityMerge ||
    !(await store.compareAndSetIdentityMerge({
      expectedRevision: operation.revision,
      next,
      now,
      restore: true,
    }))
  )
    throw new IdentityMergeConflict("merge_conflict");
  return next;
}

/** Trusted owner-only recovery of a reserved merge that never activated. */
export async function abortPendingIdentityMerge(input: {
  store: AccountsStore;
  operation: IdentityMergeOperation;
  reconciler?: IdentityMergeReconciler;
  now: number;
  clock?: () => number;
}): Promise<IdentityMergeOperation> {
  const { store, operation } = input;
  if (operation.status === "aborted") return operation;
  if (
    !operation.consentAt ||
    !["proved", "reconciled", "quarantined"].includes(operation.status) ||
    !input.reconciler?.reconcileRecovery
  )
    throw new IdentityMergeConflict("recovery_review_required");
  const persisted = await store.findIdentityMergeOperation?.(
    operation.operationId,
  );
  if (
    !persisted ||
    persisted.revision !== operation.revision ||
    !identityRecordsEqual(persisted, operation)
  )
    throw new IdentityMergeConflict("merge_conflict");
  const ack = await input.reconciler.reconcileRecovery(operation);
  const now = input.clock?.() ?? input.now;
  const rollback = ack?.preActivationRollback;
  if (
    !completeAcknowledgements(operation, ack, now) ||
    !ack.undoOperationId ||
    ack.undoOperationId === operation.operationId ||
    !ack.reviewedRecoveryRef ||
    !rollback ||
    ![
      rollback.externalBindings,
      rollback.workspaceMembership,
      rollback.billingLedger,
      rollback.rpSessions,
      rollback.consumerIntentCustody,
    ].every((v) => typeof v === "string" && v.length > 0 && v.length <= 256)
  )
    throw new IdentityMergeConflict("recovery_review_required");
  const next = {
    ...operation,
    status: "aborted" as const,
    undoOperationId: ack.undoOperationId,
    recoveryAcknowledgements: ack,
    revision: operation.revision + 1,
    mutationId: crypto.randomUUID(),
    updatedAt: now,
  };
  if (
    !(await store.compareAndSetIdentityMerge?.({
      expectedRevision: operation.revision,
      next,
      now,
      abort: true,
    }))
  )
    throw new IdentityMergeConflict("merge_conflict");
  return next;
}

export async function unlinkCanonicalLoginCredential(input: {
  store: AccountsStore;
  session: AccountSessionRecord;
  identity: {
    providerId: string;
    upstreamIssuer: string;
    upstreamSubject: string;
  };
  operationId: string;
  consent: boolean;
  reconciler?: IdentityMergeReconciler;
  now: number;
}): Promise<void> {
  // The former caller-selected operation ID and credential row count are not
  // retained-credential ownership proof. The new server intent owner must
  // supply its guarded operation before this browser surface can mutate.
  throw new IdentityMergeConflict("unlink_intent_required");
}

/** Mounted by the Accounts owner. This handler accepts only an authenticated
 * issuer browser session; PATs and RP assertions never reach the proof path. */
export async function handleIdentityMergeRequest(input: {
  request: Request;
  store: AccountsStore;
  session?: AccountSessionRecord;
  browserBindingHash?: string;
  issuerOrigin: string;
  reconciler?: IdentityMergeReconciler;
  now?: number;
  retryCapability?: import("./identity-merge-retry.ts").IdentityMergeRetryCapability;
}): Promise<Response | undefined> {
  const url = new URL(input.request.url);
  if (
    url.pathname !== unlinkPath &&
    url.pathname !== basePath &&
    !url.pathname.startsWith(`${basePath}/`)
  )
    return undefined;
  const now = input.now ?? Date.now();
  const fail = (code: string, status: number) =>
    errorJson(code, "Identity operation unavailable", status, input.request);
  const presentedSession = readHostedOwnershipCookie(input.request);
  if (
    !input.session ||
    !presentedSession ||
    presentedSession !== input.session.sessionId
  )
    return fail("authentication_required", 401);
  // Re-resolve caller-owned session, so a forged record or a revoked cookie
  // cannot be promoted to ownership proof through an in-process adapter.
  const session = await input.store.findAccountSession(input.session.sessionId);
  if (
    !session ||
    session.subject !== input.session.subject ||
    session.expiresAt <= now ||
    session.policy !== "hosted" ||
    !session.absoluteExpiresAt ||
    session.absoluteExpiresAt <= now ||
    !input.store.getAccountAuthenticationGeneration ||
    (session.identityGeneration ?? 0) !==
      (await input.store.getAccountAuthenticationGeneration(session.subject)) ||
    (await input.store.isAccountAuthenticationFenced?.(session.subject)) ||
    (await input.store.findCanonicalAccount?.(session.subject))?.subject !==
      session.subject
  )
    return fail("authentication_required", 401);
  if (
    input.request.method !== "GET" &&
    input.request.headers.get("origin") !== new URL(input.issuerOrigin).origin
  )
    return fail("invalid_origin", 403);
  const browserCookie = readMergeBrowserCookie(input.request);
  let browserBindingHash =
    input.browserBindingHash ||
    (browserCookie
      ? await sha256Text(`merge-browser:${browserCookie}`)
      : undefined);
  let cookieHeader: string | undefined;
  if (
    !browserBindingHash &&
    url.pathname === basePath &&
    input.request.method === "POST"
  ) {
    const value = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    browserBindingHash = await sha256Text(`merge-browser:${value}`);
    cookieHeader = `${mergeBrowserCookie}=${value}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Lax`;
  }
  try {
    if (url.pathname === unlinkPath) {
      if (input.request.method !== "POST")
        return fail("method_not_allowed", 405);
      const body = await readJsonObject(input.request);
      if (
        typeof body?.providerId !== "string" ||
        typeof body?.upstreamIssuer !== "string" ||
        typeof body?.upstreamSubject !== "string" ||
        typeof body?.operationId !== "string"
      )
        return fail("invalid_request", 400);
      await unlinkCanonicalLoginCredential({
        store: input.store,
        session,
        identity: {
          providerId: body.providerId,
          upstreamIssuer: body.upstreamIssuer,
          upstreamSubject: body.upstreamSubject,
        },
        operationId: body.operationId,
        consent: body.consent === true,
        reconciler: input.reconciler,
        now,
      });
      return json(
        { operationId: body.operationId, status: "credential_unlinked" },
        200,
        { "cache-control": "no-store" },
      );
    }
    if (!browserBindingHash) return fail("invalid_browser_binding", 403);
    if (url.pathname === basePath) {
      if (input.request.method !== "POST")
        return fail("method_not_allowed", 405);
      const body = await readJsonObject(input.request);
      if (
        typeof body?.sourceSubject !== "string" ||
        typeof body?.targetSubject !== "string"
      )
        return fail("invalid_request", 400);
      const operation = await createIdentityMerge({
        store: input.store,
        actor: session.subject,
        sourceSubject: body.sourceSubject as TakosumiSubject,
        targetSubject: body.targetSubject as TakosumiSubject,
        browserBindingHash,
        now,
      });
      return json(publicOperation(operation), 201, {
        "cache-control": "no-store",
        ...(cookieHeader ? { "set-cookie": cookieHeader } : {}),
      });
    }
    const parts = url.pathname.slice(basePath.length + 1).split("/");
    if (parts.length > 2 || !/^imrg_[a-f0-9-]{36}$/.test(parts[0]!))
      return fail("not_found", 404);
    const operation = await input.store.findIdentityMergeOperation?.(parts[0]!);
    if (
      !operation ||
      operation.browserBindingHash !== browserBindingHash ||
      ![operation.sourceSubject, operation.targetSubject].includes(
        session.subject,
      )
    )
      return fail("not_found", 404);
    if (input.request.method === "GET" && parts.length === 1)
      return json(publicOperation(operation), 200, {
        "cache-control": "no-store",
      });
    if (input.request.method !== "POST") return fail("method_not_allowed", 405);
    let next: IdentityMergeOperation;
    if (parts[1] === "prove") {
      const body = await readJsonObject(input.request);
      if (
        !body ||
        typeof body.receiptId !== "string" ||
        Object.keys(body).some((key) => key !== "receiptId")
      )
        return fail("invalid_request", 400);
      next = await proveIdentityMerge({
        store: input.store,
        operation,
        session,
        receiptId:
          typeof body?.receiptId === "string" ? body.receiptId : undefined,
        now,
      });
    } else if (parts[1] === "context-plan") {
      const body = await readJsonObject(input.request);
      if (!body || Object.keys(body).length)
        return fail("invalid_request", 400);
      const prepared = await prepareIdentityMergeContextPlan({
        store: input.store,
        operation,
        reconciler: input.reconciler,
        now,
        clock: () => input.now ?? Date.now(),
      });
      return json(
        { operation: publicOperation(prepared.operation), plan: prepared.plan },
        200,
        { "cache-control": "no-store" },
      );
    } else if (parts[1] === "context-accept") {
      const body = await readJsonObject(input.request);
      if (
        !body ||
        Object.keys(body).some(
          (key) => !["planDigest", "consent"].includes(key),
        ) ||
        typeof body.planDigest !== "string" ||
        body.consent !== true
      )
        return fail("invalid_request", 400);
      next = await acceptIdentityMergeContextPlan({
        store: input.store,
        operation,
        session,
        browserBindingHash,
        planDigest: body.planDigest,
        consent: true,
        now,
      });
    } else if (parts[1] === "consent") {
      const body = await readJsonObject(input.request);
      if (!body || Object.keys(body).some((key) => key !== "consent"))
        return fail("invalid_request", 400);
      next = await consentIdentityMerge({
        retryCapability: input.retryCapability,
        clock: () => input.now ?? Date.now(),
        store: input.store,
        operation,
        session,
        now,
        consent: body?.consent === true,
        reconciler: input.reconciler,
      });
      if (input.reconciler) {
        try {
          next = await activateIdentityMerge({
            store: input.store,
            operation: next,
            reconciler: input.reconciler,
            now,
            clock:
              input.now === undefined ? () => Date.now() : () => input.now!,
          });
        } catch (error) {
          if (
            !(error instanceof IdentityMergeConflict) ||
            error.code !== "merge_reconciliation_pending"
          )
            throw error;
        }
      }
    } else if (parts[1] === "activate")
      next = await activateIdentityMerge({
        store: input.store,
        operation,
        reconciler: input.reconciler,
        now,
        clock: input.now === undefined ? () => Date.now() : () => input.now!,
      });
    else return fail("not_found", 404);
    return json(publicOperation(next), 200, { "cache-control": "no-store" });
  } catch (e) {
    if (e instanceof IdentityMergeConflict) return fail(e.code, 409);
    throw e;
  }
}

export async function eligibleEvidence(
  store: AccountsStore,
  source: TakosumiSubject,
  target: TakosumiSubject,
  now: number,
): Promise<readonly [AccountEmailProofRecord, AccountEmailProofRecord]> {
  if (!store.findAccountEmailProof || !store.findAccountsByEmailCandidate)
    throw new IdentityMergeConflict("merge_unavailable");
  const results = await Promise.all(
    [source, target].map(async (subject) => {
      const [account, proof] = await Promise.all([
        store.findAccount(subject),
        store.findAccountEmailProof!(subject),
      ]);
      if (
        !account ||
        account.emailVerified !== true ||
        !proof ||
        account.email !== proof.address ||
        proof.subject !== subject ||
        proof.observedAt > now ||
        now - proof.observedAt > freshnessMs ||
        proof.validUntil <= now ||
        normalizeMergeEmail(proof.address) !== proof.normalizedAddress ||
        (proof.authoritative !== true && proof.verification !== "mailbox")
      )
        throw new IdentityMergeConflict("merge_conflict");
      const binding = await store.findUpstreamIdentity(proof);
      const status = await store.findUpstreamIdentityStatus?.(proof);
      if (binding?.subject !== subject || status?.disabledAt !== undefined)
        throw new IdentityMergeConflict("merge_conflict");
      return proof;
    }),
  );
  const [a, b] = results as [AccountEmailProofRecord, AccountEmailProofRecord];
  if (a.normalizedAddress !== b.normalizedAddress)
    throw new IdentityMergeConflict("merge_conflict");
  const candidates = await store.findAccountsByEmailCandidate(
    a.normalizedAddress,
  );
  if (
    candidates.length !== 2 ||
    candidates.some(
      (c) =>
        ![source, target].includes(c.subject) ||
        normalizeMergeEmail(c.email ?? "") !== a.normalizedAddress,
    )
  )
    throw new IdentityMergeConflict("merge_conflict");
  return [a, b];
}

function freshSession(
  session: AccountSessionRecord,
  now: number,
): IdentityMergeSessionRequirement {
  const time = session.reauthenticatedAt;
  if (
    session.policy !== "hosted" ||
    time === undefined ||
    !Number.isSafeInteger(time) ||
    time * 1000 > now ||
    now - time * 1000 > freshnessMs ||
    session.expiresAt <= now ||
    !session.absoluteExpiresAt ||
    session.absoluteExpiresAt <= now
  )
    throw new IdentityMergeConflict("fresh_authentication_required");
  return {
    sessionId: session.sessionId,
    subject: session.subject,
    authTime: time,
  };
}
export async function consumedProofReceipts(
  store: AccountsStore,
  op: IdentityMergeOperation,
  now: number,
  generationOffset: number,
): Promise<readonly IdentityOperationReceiptRecord[]> {
  if (!op.sourceProof || !op.targetProof || !store.findIdentityOperationReceipt)
    throw new IdentityMergeConflict("merge_conflict");
  const receipts = await Promise.all(
    [op.sourceProof, op.targetProof].map((p) =>
      store.findIdentityOperationReceipt!(p.receiptId),
    ),
  );
  if (op.sourceProof.receiptId === op.targetProof.receiptId)
    throw new IdentityMergeConflict("merge_conflict");
  const out: IdentityOperationReceiptRecord[] = [];
  for (const [index, receipt] of receipts.entries()) {
    const proof = index === 0 ? op.sourceProof : op.targetProof;
    if (
      !receipt ||
      receipt.role !== (index === 0 ? "source" : "target") ||
      proof.subject !== receipt.subject ||
      proof.identityGeneration !== receipt.identityGeneration ||
      proof.provedAt !== receipt.completedAt ||
      proof.method !== receipt.method ||
      (proof.providerId !== undefined &&
        proof.providerId !== receipt.providerId)
    )
      throw new IdentityMergeConflict("merge_conflict");
    await validateOperationReceipt(
      store,
      op,
      receipt,
      now,
      true,
      generationOffset,
    );
    out.push(receipt);
  }
  return out;
}
async function validateOperationReceipt(
  store: AccountsStore,
  op: IdentityMergeOperation,
  r: IdentityOperationReceiptRecord,
  now: number,
  consumed: boolean,
  offset: number,
): Promise<void> {
  const subject = r.role === "source" ? op.sourceSubject : op.targetSubject;
  if (
    !Number.isSafeInteger(r.startedAt) ||
    !Number.isSafeInteger(r.completedAt) ||
    !Number.isSafeInteger(r.expiresAt) ||
    !Number.isSafeInteger(r.legConsentAt) ||
    !Number.isSafeInteger(r.identityGeneration) ||
    !["source", "target"].includes(r.role) ||
    r.operationId !== op.operationId ||
    r.sourceSubject !== op.sourceSubject ||
    r.targetSubject !== op.targetSubject ||
    r.subject !== subject ||
    r.browserBindingHash !== op.browserBindingHash ||
    r.policyVersion !== op.policyVersion ||
    r.emailDigest !== op.addressDigest ||
    r.legConsent !== true ||
    r.legConsentAt < r.startedAt ||
    r.legConsentAt > r.completedAt ||
    r.startedAt < op.createdAt ||
    r.completedAt < r.startedAt ||
    r.completedAt > now ||
    r.expiresAt <= now ||
    r.expiresAt > r.startedAt + freshnessMs ||
    !r.transactionDigest ||
    !r.issuerSessionHash.startsWith("sha256:") ||
    !["upstream-oauth-operation", "issuer-credential-reauth"].includes(
      r.method,
    ) ||
    (consumed
      ? r.consumedByOperation !== op.operationId
      : r.consumedByOperation !== undefined) ||
    r.identityGeneration + offset !==
      (await store.getAccountAuthenticationGeneration?.(subject)) ||
    !store.isHostedOidcSessionHashRevoked ||
    (await store.isHostedOidcSessionHashRevoked(r.issuerSessionHash))
  )
    throw new IdentityMergeConflict("merge_conflict");
  const binding = await store.findUpstreamIdentity(r);
  const canonical = await store.findCanonicalAccount?.(
    binding?.subject ?? subject,
  );
  const status = await store.findUpstreamIdentityStatus?.(r);
  if (
    binding?.subject !== subject ||
    canonical?.subject !== subject ||
    status?.disabledAt !== undefined
  )
    throw new IdentityMergeConflict("merge_conflict");
}
export function identityMergeAddressDigest(address: string): Promise<string> {
  return sha256Text(`identity-merge-address:${address}`);
}
function completeAcknowledgements(
  operation: IdentityMergeOperation,
  ack: IdentityMergeAcknowledgements | undefined,
  now: number,
): ack is IdentityMergeAcknowledgements {
  return (
    !!ack &&
    ack.operationId === operation.operationId &&
    ack.sourceSubject === operation.sourceSubject &&
    ack.targetSubject === operation.targetSubject &&
    ack.reconciledAt >= operation.createdAt &&
    ack.reconciledAt <= now &&
    [
      ack.externalBindings,
      ack.workspaceMembership,
      ack.billingLedger,
      ack.consumerIntentCustody,
      ack.rpSessions,
      ack.personalWorkspaceId,
    ].every((v) => typeof v === "string" && v.length > 0 && v.length <= 256)
  );
}
function publicOperation(operation: IdentityMergeOperation): unknown {
  return {
    operationId: operation.operationId,
    status: operation.status,
    revision: operation.revision,
    sourceSubject: operation.sourceSubject,
    targetSubject: operation.targetSubject,
    contextPlan: operation.contextPlan
      ? {
          planId: operation.contextPlan.planId,
          planDigest: operation.contextPlan.planDigest,
        }
      : undefined,
    sourceContextAccepted: !!operation.sourceContextAcceptance,
    targetContextAccepted: !!operation.targetContextAcceptance,
    sourceProviderId: operation.sourceProof?.providerId,
    targetProviderId: operation.targetProof?.providerId,
    sourceProved: !!operation.sourceProof,
    targetProved: !!operation.targetProof,
    consented: !!operation.consentAt,
    expiresAt: operation.expiresAt,
  };
}

function readMergeBrowserCookie(request: Request): string | undefined {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${mergeBrowserCookie}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]!.slice(mergeBrowserCookie.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

export async function readIdentityMergeBrowserBindingHash(
  request: Request,
): Promise<string | undefined> {
  const value = readMergeBrowserCookie(request);
  return value ? await sha256Text(`merge-browser:${value}`) : undefined;
}

function readHostedOwnershipCookie(request: Request): string | undefined {
  const prefix = "__Host-takosumi_session=";
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(prefix));
  return values.length === 1 ? values[0]!.slice(prefix.length) : undefined;
}
