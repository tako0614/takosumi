/** Synthetic isolated data only. A real ephemeral ES256 status exchange is
 * performed by the shared test reconciler; no production issuer is qualified. */
import { identityContextFixture, acceptIsolatedIdentityContexts, isolatedContextReconciler } from "./identity-context-fixture.ts";
import { consentIdentityMerge, IdentityMergeConflict } from "../../../../accounts/service/src/identity-merge.ts";
import { HostedIdentityRecords, type IdentityRecordRepository } from "../../../../accounts/service/src/hosted-identity-records.ts";
import type { IdentityMergeMutation } from "../../../../accounts/service/src/identity-state.ts";

/** Capture an actual consent mutation without reserving/fencing either account.
 * Keep the opaque checkpoint itself: cloning it deliberately loses provenance. */
export type IsolatedExpiryBound = "operation" | "session-idle" | "session-absolute" | "proof" | "plan" | "context" | "email" | "email-max-age";
export async function prepareIsolatedReserveMutation(kind: "memory" | "native-d1" | "postgres", expiryBound?: IsolatedExpiryBound) {
  const originalMutation = HostedIdentityRecords.prototype.compareAndSetIdentityMerge;
  let repository: IdentityRecordRepository | undefined;
  HostedIdentityRecords.prototype.compareAndSetIdentityMerge = function (input) {
    repository = this.repository;
    return originalMutation.call(this, input);
  };
  let fixture: Awaited<ReturnType<typeof identityContextFixture>> | undefined;
  try {
    fixture = await identityContextFixture(kind);
    const f = fixture;
    let operation = await acceptIsolatedIdentityContexts(f.store, f.operation, f.now);
    let now = f.now;
    const deadline = now + 10;
    if (!repository) throw new Error("isolated_repository_not_captured");
    // Explicit synthetic clock fixtures shorten one actual captured evidence
    // bound before the real consent read/status exchange. No real data is used.
    if (expiryBound === "operation") {
      operation = { ...operation, expiresAt: deadline };
      await repository.put("identity_merge_operations", operation.operationId, operation);
    }
    if (expiryBound === "session-idle" || expiryBound === "session-absolute") {
      const session = f.session();
      if (expiryBound === "session-idle") session.expiresAt = deadline;
      else session.absoluteExpiresAt = deadline;
      await f.store.saveAccountSession(session);
    }
    if (expiryBound === "proof" || expiryBound === "operation") {
      const receipt = (await f.store.findIdentityOperationReceipt!(operation.sourceProof!.receiptId))!;
      await repository.put("identity_operation_receipts", receipt.receiptId, { ...receipt, expiresAt: deadline });
      if (expiryBound === "operation") {
        const targetReceipt = (await f.store.findIdentityOperationReceipt!(operation.targetProof!.receiptId))!;
        await repository.put("identity_operation_receipts", targetReceipt.receiptId, { ...targetReceipt, expiresAt: deadline });
      }
    }
    if (expiryBound === "plan" || expiryBound === "operation") {
      const plan = (await f.store.findIdentityMergeContextPlan!(operation.contextPlan!.planId))!;
      await repository.put("identity_merge_context_plans", plan.planId, { ...plan, expiresAt: deadline });
    }
    if (expiryBound === "context" || expiryBound === "operation") {
      const acceptance = (await f.store.findIdentityMergeContextReceipt!(operation.sourceContextAcceptance!.receiptId))!;
      await repository.put("identity_merge_context_receipts", acceptance.receiptId, { ...acceptance, expiresAt: deadline });
      if (expiryBound === "operation") {
        const targetAcceptance = (await f.store.findIdentityMergeContextReceipt!(operation.targetContextAcceptance!.receiptId))!;
        await repository.put("identity_merge_context_receipts", targetAcceptance.receiptId, { ...targetAcceptance, expiresAt: deadline });
      }
    }
    if (expiryBound === "email" || expiryBound === "email-max-age") {
      const proof = (await f.store.findAccountEmailProof!(operation.sourceSubject))!;
      await f.store.saveAccountEmailProof!({ ...proof, ...(expiryBound === "email" ? { validUntil: deadline } : { observedAt: deadline - 300000 - 1 }) });
    }
    const clock = () => now;
    const originalCompare = f.store.compareAndSetIdentityMerge!.bind(f.store);
    let mutation: IdentityMergeMutation | undefined;
    f.store.compareAndSetIdentityMerge = async (input) => { mutation = input; return false; };
    try {
      await consentIdentityMerge({ store: f.store, operation, session: f.session(), now, clock,
        consent: true, reconciler: isolatedContextReconciler(f.store, clock),
        retryCapability: { pendingCapacity: 100, assertAvailable: async () => {} } });
      throw new Error("isolated_consent_should_stop_before_reservation");
    } catch (error) {
      if (!(error instanceof IdentityMergeConflict) || error.message !== "merge_conflict") throw error;
    } finally { f.store.compareAndSetIdentityMerge = originalCompare; }
    if (!mutation || !repository) throw new Error("isolated_reservation_not_captured");
    const captured = mutation;
    return { ...f, operation, mutation: captured, repository, clock, deadline,
      time: (value: number) => { now = value; },
      execute: (input: IdentityMergeMutation = captured) => originalCompare(input) };
  } catch (error) {
    await fixture?.close();
    throw error;
  } finally { HostedIdentityRecords.prototype.compareAndSetIdentityMerge = originalMutation; }
}
