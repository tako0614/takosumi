import type {
  ControlIdentityAuthorityReader,
  ControlIdentityContextPlan,
  ControlIdentityReceipt,
  ControlIdentityReconciliationPort,
  ControlMergeAdmission,
  ControlRecoveryAdmission,
  ControlUnlinkAdmission,
} from "../../../contract/identity-reconciliation.ts";
import { CONTROL_IDENTITY_AUTHORITY_VERSION } from "../../../contract/identity-reconciliation.ts";
import type { AccountsStore } from "./store.ts";
import type {
  IdentityMergeOperation,
  IdentityMergeAcknowledgements,
  IdentityMergeRecoveryAcknowledgements,
} from "./identity-state.ts";
import { upstreamIdentityKey } from "./identity-state.ts";
import {
  consumedProofReceipts,
  IdentityMergeConflict,
  type IdentityMergeReconciler,
} from "./identity-merge.ts";
import {
  assertIdentityContextPlanning,
  readIdentityMergeContextEvidence,
  validateCoreIdentityContextPlan,
} from "./identity-context.ts";
import {
  assertCredentialUnlinkIntentCurrent,
  validateCredentialUnlinkReceipt,
} from "./identity-unlink.ts";
import type { CredentialUnlinkReconciler } from "./identity-unlink-state.ts";
import { identityRecordsEqual } from "./hosted-identity-records.ts";
import { sha256Text } from "./encoding.ts";

export interface IdentityReviewedRecoveryApproval {
  operationId: string;
  recoveryId: string;
  operationRevision: number;
  sourceAccountId: string;
  targetAccountId: string;
  planDigest: string;
  sourceIdentityGeneration: number;
  targetIdentityGeneration: number;
  mode: "abort-before-active" | "restore-after-active";
  reviewedApprovalRef: string;
  createdAt: number;
  expiresAt: number;
}
/** This is a real, separately authenticated owner approval reader. There is no
 * browser endpoint that creates approvals and no default affirmative adapter. */
export interface IdentityRecoveryApprovalAuthority {
  findForOperation(
    operationId: string,
  ): Promise<IdentityReviewedRecoveryApproval | undefined>;
  read(input: {
    operationId: string;
    recoveryId: string;
  }): Promise<IdentityReviewedRecoveryApproval | undefined>;
}

export function createAccountsIdentityReconciliationAuthority(input: {
  store: AccountsStore;
  now?: () => number;
  recoveryApprovals?: IdentityRecoveryApprovalAuthority;
}): ControlIdentityAuthorityReader {
  const { store } = input;
  const clock = input.now ?? Date.now;
  async function readMergeAdmission(request: {
    operationId: string;
    phase: "planning" | "reserved";
    planDigest?: string;
  }): Promise<ControlMergeAdmission | undefined> {
    try {
      if (!["planning", "reserved"].includes(request.phase)) return undefined;
      const now = clock();
      if (!Number.isSafeInteger(now)) return undefined;
      const op = await store.findIdentityMergeOperation?.(request.operationId);
      if (
        !op ||
        !op.sourceProof ||
        !op.targetProof ||
        op.expiresAt <= now ||
        op.conflict === "reviewed_recovery_required"
      )
        return undefined;
      if (request.phase === "planning")
        await assertIdentityContextPlanning(store, op, now);
      else {
        if (
          !op.consentAt ||
          !["proved", "reconciled"].includes(op.status) ||
          !op.contextPlan ||
          !store.findIdentityMergeLock
        )
          return undefined;
        await consumedProofReceipts(store, op, now, 1);
        await readIdentityMergeContextEvidence(store, op, now, 1);
        for (const subject of [op.sourceSubject, op.targetSubject]) {
          const lock = await store.findIdentityMergeLock(subject);
          if (
            lock?.operationId !== op.operationId ||
            lock.subject !== subject ||
            !(await store.isAccountAuthenticationFenced?.(subject)) ||
            (await store.findCanonicalAccount?.(subject))?.subject !== subject
          )
            return undefined;
        }
      }
      if (
        request.planDigest !== undefined &&
        request.planDigest !== op.contextPlan?.planDigest
      )
        return undefined;
      const planningRevision = op.contextPlan?.planningRevision ?? op.revision;
      const admission: ControlMergeAdmission = {
        operationId: op.operationId,
        operationRevision: op.revision,
        planningRevision,
        sourceAccountId: op.sourceSubject,
        targetAccountId: op.targetSubject,
        sourceProof: {
          receiptId: op.sourceProof.receiptId,
          identityGeneration: op.sourceProof.identityGeneration,
          provedAt: op.sourceProof.provedAt,
        },
        targetProof: {
          receiptId: op.targetProof.receiptId,
          identityGeneration: op.targetProof.identityGeneration,
          provedAt: op.targetProof.provedAt,
        },
        browserBindingHash: op.browserBindingHash,
        policyVersion: op.policyVersion,
        createdAt: op.createdAt,
        expiresAt: op.expiresAt,
        phase: request.phase,
        ...(op.contextPlan
          ? {
              contextPlan: {
                planId: op.contextPlan.planId,
                digest: op.contextPlan.planDigest,
                planningRevision: op.contextPlan.planningRevision,
                authorityVersion: op.contextPlan.authorityVersion,
              },
            }
          : {}),
        ...(op.sourceContextAcceptance && op.targetContextAcceptance
          ? {
              contextAcceptances: {
                source: op.sourceContextAcceptance,
                target: op.targetContextAcceptance,
              },
            }
          : {}),
        ...(op.consentAt ? { consentAt: op.consentAt } : {}),
      };
      const after = await store.findIdentityMergeOperation?.(op.operationId);
      if (!identityRecordsEqual(op, after)) return undefined;
      // Re-read generations after asynchronous authority reads, not just a stale
      // initial session snapshot. The Control writer repeats this admission check.
      for (const [subject, proof] of [
        [op.sourceSubject, op.sourceProof],
        [op.targetSubject, op.targetProof],
      ] as const)
        if (
          (await store.getAccountAuthenticationGeneration?.(subject)) !==
          proof.identityGeneration + (request.phase === "reserved" ? 1 : 0)
        )
          return undefined;
      return admission;
    } catch {
      return undefined;
    }
  }
  async function readUnlinkAdmission(request: {
    intentId: string;
  }): Promise<ControlUnlinkAdmission | undefined> {
    try {
      const now = clock();
      if (!Number.isSafeInteger(now)) return undefined;
      const intent = await store.findCredentialUnlinkIntent?.(request.intentId);
      const ticket = await store.findCredentialUnlinkAuthorityTicket?.(
        request.intentId,
      );
      if (
        !intent ||
        !ticket ||
        ticket.subject !== intent.subject ||
        ticket.identityGeneration !== intent.identityGeneration ||
        ticket.createdAt < intent.createdAt ||
        ticket.createdAt > now
      )
        return undefined;
      await assertCredentialUnlinkIntentCurrent(store, intent, now);
      const receipt = await store.findCredentialUnlinkReceipt?.(
        ticket.receiptId,
      );
      validateCredentialUnlinkReceipt(intent, receipt, now);
      const after = await store.findCredentialUnlinkIntent?.(request.intentId);
      if (
        !identityRecordsEqual(after, intent) ||
        (await store.getAccountAuthenticationGeneration?.(intent.subject)) !==
          intent.identityGeneration
      )
        return undefined;
      return {
        intentId: intent.operationId,
        intentRevision: intent.revision,
        accountId: intent.subject,
        removedIdentityDigest: await sha256Text(
          `credential-identity:${upstreamIdentityKey(intent.removedIdentity)}`,
        ),
        retainedIdentityDigest: await sha256Text(
          `credential-identity:${upstreamIdentityKey(intent.retainedIdentity)}`,
        ),
        retainedProofReceiptId: receipt.receiptId,
        identityGeneration: intent.identityGeneration,
        createdAt: intent.createdAt,
        expiresAt: Math.min(intent.expiresAt, receipt.expiresAt),
      };
    } catch {
      return undefined;
    }
  }
  async function readRecoveryAdmission(request: {
    operationId: string;
    recoveryId: string;
  }): Promise<ControlRecoveryAdmission | undefined> {
    try {
      if (!input.recoveryApprovals || !store.findIdentityMergeLock)
        return undefined;
      const now = clock();
      if (!Number.isSafeInteger(now)) return undefined;
      const op = await store.findIdentityMergeOperation?.(request.operationId);
      const approval = await input.recoveryApprovals.read(request);
      if (
        !op?.contextPlan ||
        !op.consentAt ||
        !approval ||
        !["abort-before-active", "restore-after-active"].includes(
          approval.mode,
        ) ||
        !Number.isSafeInteger(approval.createdAt) ||
        !Number.isSafeInteger(approval.expiresAt) ||
        !Number.isSafeInteger(approval.operationRevision) ||
        !Number.isSafeInteger(approval.sourceIdentityGeneration) ||
        !Number.isSafeInteger(approval.targetIdentityGeneration) ||
        approval.operationId !== op.operationId ||
        approval.recoveryId !== request.recoveryId ||
        approval.recoveryId === op.operationId ||
        approval.operationRevision !== op.revision ||
        approval.sourceAccountId !== op.sourceSubject ||
        approval.targetAccountId !== op.targetSubject ||
        approval.planDigest !== op.contextPlan.planDigest ||
        typeof approval.recoveryId !== "string" ||
        !approval.recoveryId ||
        approval.recoveryId.length > 256 ||
        typeof approval.reviewedApprovalRef !== "string" ||
        !approval.reviewedApprovalRef ||
        approval.reviewedApprovalRef.length > 256 ||
        approval.createdAt < op.createdAt ||
        approval.createdAt > now ||
        approval.expiresAt <= now ||
        approval.expiresAt > approval.createdAt + 300000
      )
        return undefined;
      if (
        approval.mode === "abort-before-active"
          ? !["proved", "reconciled", "quarantined"].includes(op.status)
          : op.status !== "quarantined"
      )
        return undefined;
      for (const [subject, generation] of [
        [op.sourceSubject, approval.sourceIdentityGeneration],
        [op.targetSubject, approval.targetIdentityGeneration],
      ] as const) {
        if (
          (await store.findIdentityMergeLock(subject))?.operationId !==
            op.operationId ||
          !(await store.isAccountAuthenticationFenced?.(subject)) ||
          (await store.getAccountAuthenticationGeneration?.(subject)) !==
            generation
        )
          return undefined;
      }
      const canonical = await store.findCanonicalAccount?.(op.sourceSubject);
      if (
        canonical?.subject !==
          (approval.mode === "abort-before-active"
            ? op.sourceSubject
            : op.targetSubject) ||
        !identityRecordsEqual(
          op,
          await store.findIdentityMergeOperation?.(op.operationId),
        )
      )
        return undefined;
      return {
        operationId: op.operationId,
        recoveryId: approval.recoveryId,
        sourceAccountId: op.sourceSubject,
        targetAccountId: op.targetSubject,
        planDigest: op.contextPlan.planDigest,
        mode: approval.mode,
        reviewedApprovalRef: approval.reviewedApprovalRef,
        expiresAt: approval.expiresAt,
      };
    } catch {
      return undefined;
    }
  }
  return { readMergeAdmission, readUnlinkAdmission, readRecoveryAdmission };
}

export type IdentityExternalOwnerKind =
  | "financial"
  | "hosted-intents"
  | "rp-sessions"
  | "resource-bindings";
export interface IdentityExternalOwnerContext {
  operationId: string;
  kind: "merge" | "unlink" | "abort-before-active" | "restore-after-active";
  sourceAccountId: string;
  targetAccountId: string;
  planDigest: string;
  authorityVersion: typeof CONTROL_IDENTITY_AUTHORITY_VERSION;
  /** Immutable original proof/context/intent binding, never a current RP grant. */
  admissionDigest: string;
  controlReceiptId?: string;
  contextPins?: ControlIdentityContextPlan["contexts"];
  personalWorkspaceId?: string;
  proofBindingDigest?: string;
}
export interface IdentityExternalOwnerReceipt
  extends IdentityExternalOwnerContext {
  receiptId: string;
  ownerId: string;
  ownerVersion: string;
  recordedAt: number;
}
/** Implementations authenticate their actual owning service, use the original
 * operation key, and read back durable unknown/pending results. Missing ports
 * are an unavailable capability, never a placeholder positive receipt. */
export interface IdentityExternalOwnerPort {
  readonly kind: IdentityExternalOwnerKind;
  readonly ownerId: string;
  readonly ownerVersion: string;
  assertReady(context?: IdentityExternalOwnerContext): Promise<boolean>;
  reconcile(
    context: IdentityExternalOwnerContext,
  ): Promise<IdentityExternalOwnerReceipt | undefined>;
  read(
    context: IdentityExternalOwnerContext,
  ): Promise<IdentityExternalOwnerReceipt | undefined>;
}
export type IdentityExternalOwnerPorts = Partial<
  Record<IdentityExternalOwnerKind, IdentityExternalOwnerPort>
>;
export interface ControlIdentityReconciler
  extends IdentityMergeReconciler,
    CredentialUnlinkReconciler {
  assertOwnerReadiness(operation?: IdentityMergeOperation): Promise<boolean>;
}
const ownerKinds = [
  "financial",
  "hosted-intents",
  "rp-sessions",
  "resource-bindings",
] as const;

export function createControlIdentityReconciler(input: {
  store: AccountsStore;
  control: ControlIdentityReconciliationPort;
  externalOwners?: IdentityExternalOwnerPorts;
  recoveryApprovals?: IdentityRecoveryApprovalAuthority;
  now?: () => number;
}): ControlIdentityReconciler {
  const clock = input.now ?? Date.now;
  const authority = createAccountsIdentityReconciliationAuthority(input);
  const ports = () => ownerKinds.map((kind) => input.externalOwners?.[kind]);
  async function assertSameOperation(
    op: IdentityMergeOperation,
    phase: "planning" | "reserved",
  ): Promise<ControlMergeAdmission> {
    const persisted = await input.store.findIdentityMergeOperation?.(
      op.operationId,
    );
    if (!identityRecordsEqual(persisted, op))
      throw new IdentityMergeConflict("merge_authority_unavailable");
    const admission = await authority.readMergeAdmission({
      operationId: op.operationId,
      phase,
      ...(op.contextPlan ? { planDigest: op.contextPlan.planDigest } : {}),
    });
    if (
      !admission ||
      admission.operationRevision !== op.revision ||
      admission.sourceAccountId !== op.sourceSubject ||
      admission.targetAccountId !== op.targetSubject
    )
      throw new IdentityMergeConflict("merge_authority_unavailable");
    return admission;
  }
  async function mergeContext(
    op: IdentityMergeOperation,
    phase: "planning" | "reserved",
  ): Promise<IdentityExternalOwnerContext> {
    op = structuredClone(op);
    const admission = await assertSameOperation(op, phase);
    if (!op.contextPlan)
      throw new IdentityMergeConflict("context_acceptance_required");
    // Current operationRevision intentionally changes at reservation/retry. Owner
    // custody binds the immutable original proof+plan, not a mutable request rev.
    const {
      operationRevision: _revision,
      phase: _phase,
      consentAt: _consent,
      ...immutable
    } = admission;
    const saved = await input.store.findIdentityMergeContextPlan?.(
      op.contextPlan.planId,
    );
    if (!saved || saved.planDigest !== op.contextPlan.planDigest)
      throw new IdentityMergeConflict("context_plan_conflict");
    return {
      contextPins: structuredClone(saved.controlPlan.contexts),
      personalWorkspaceId: saved.controlPlan.personalWorkspaceId,
      proofBindingDigest: saved.controlPlan.proofBindingDigest,
      operationId: op.operationId,
      kind: "merge",
      sourceAccountId: op.sourceSubject,
      targetAccountId: op.targetSubject,
      planDigest: op.contextPlan.planDigest,
      authorityVersion: CONTROL_IDENTITY_AUTHORITY_VERSION,
      admissionDigest: await sha256Text(
        `control-owner-admission:${canonicalJson(immutable)}`,
      ),
    };
  }
  async function ownersReady(
    context?: IdentityExternalOwnerContext,
  ): Promise<boolean> {
    const configured = ports();
    if (
      configured.some(
        (p, i) =>
          !p || p.kind !== ownerKinds[i] || !p.ownerId || !p.ownerVersion,
      )
    )
      return false;
    try {
      return (
        await Promise.all(
          configured.map((p) =>
            p!.assertReady(context && structuredClone(context)),
          ),
        )
      ).every((v) => v === true);
    } catch {
      return false;
    }
  }
  async function collect(
    context: IdentityExternalOwnerContext,
    notBefore: number,
  ): Promise<
    Record<IdentityExternalOwnerKind, IdentityExternalOwnerReceipt> | undefined
  > {
    if (!context.controlReceiptId || !(await ownersReady(context)))
      return undefined;
    const result = {} as Record<
      IdentityExternalOwnerKind,
      IdentityExternalOwnerReceipt
    >;
    for (const kind of ownerKinds) {
      const port = input.externalOwners![kind]!;
      try {
        // Unknown ACKs retain their original operation key. Read durable
        // custody first; never issue a replacement intent under canonical A.
        const prior = await port.read(structuredClone(context));
        const response =
          prior ?? (await port.reconcile(structuredClone(context)));
        if (!validOwnerReceipt(response, context, port, clock(), notBefore))
          return undefined;
        const durable = await port.read(structuredClone(context));
        if (
          !validOwnerReceipt(durable, context, port, clock(), notBefore) ||
          !identityRecordsEqual(response, durable)
        )
          return undefined;
        result[kind] = durable;
      } catch {
        return undefined;
      }
    }
    return result;
  }
  async function readCoreMerge(
    op: IdentityMergeOperation,
    receipt: ControlIdentityReceipt,
  ): Promise<ControlIdentityContextPlan> {
    const state = await input.control.read(op.operationId);
    if (
      !state?.plan ||
      !state.receipt ||
      state.receipt.receiptId !== receipt.receiptId ||
      !identityRecordsEqual(state.receipt, receipt)
    )
      throw new IdentityMergeConflict("merge_reconciliation_pending");
    validateCoreIdentityContextPlan(state.plan, op);
    if (
      receipt.kind !== "merge-applied" ||
      receipt.operationId !== op.operationId ||
      receipt.planDigest !== op.contextPlan?.planDigest ||
      !receipt.inventoryDigest ||
      receipt.authorityVersion !== CONTROL_IDENTITY_AUTHORITY_VERSION ||
      receipt.personalWorkspaceId !== state.plan.personalWorkspaceId ||
      !validTime(receipt.recordedAt, op.consentAt!, clock())
    )
      throw new IdentityMergeConflict("merge_reconciliation_pending");
    return state.plan;
  }
  const adapter: ControlIdentityReconciler = {
    async prepareContextPlan(op) {
      op = structuredClone(op);
      await assertSameOperation(op, "planning");
      try {
        return await input.control.prepareMerge({
          operationId: op.operationId,
        });
      } catch {
        throw new IdentityMergeConflict("context_plan_unavailable");
      }
    },
    async assertContextPlanCurrent(op) {
      op = structuredClone(op);
      await assertSameOperation(op, "planning");
      if (!op.contextPlan)
        throw new IdentityMergeConflict("context_acceptance_required");
      let plan: ControlIdentityContextPlan;
      try {
        plan = await input.control.assertMergePlanCurrent({
          operationId: op.operationId,
          planDigest: op.contextPlan.planDigest,
        });
      } catch {
        throw new IdentityMergeConflict("context_plan_conflict");
      }
      validateCoreIdentityContextPlan(plan, op);
      const saved = await input.store.findIdentityMergeContextPlan?.(
        op.contextPlan.planId,
      );
      if (!saved || !identityRecordsEqual(saved.controlPlan, plan))
        throw new IdentityMergeConflict("context_plan_conflict");
      return plan;
    },
    async assertReady(op) {
      const context = await mergeContext(op, "planning");
      if (!(await ownersReady(context)))
        throw new IdentityMergeConflict("merge_reconciliation_unavailable");
    },
    async assertOwnerReadiness(op) {
      try {
        if (!op) return ownersReady();
        const phase = op.consentAt ? "reserved" : "planning";
        return ownersReady(await mergeContext(op, phase));
      } catch {
        return false;
      }
    },
    async reconcile(op): Promise<IdentityMergeAcknowledgements | undefined> {
      op = structuredClone(op);
      const context = await mergeContext(op, "reserved");
      if (!(await ownersReady(context))) return undefined;
      const receipt = await input.control.applyMerge({
        operationId: op.operationId,
        planDigest: context.planDigest,
      });
      const plan = await readCoreMerge(op, receipt);
      await assertSameOperation(op, "reserved");
      const external = await collect(
        {
          ...context,
          controlReceiptId: receipt.receiptId,
        },
        Date.parse(receipt.recordedAt),
      );
      if (!external) return undefined;
      // External waits cannot refresh the approved roster. Replaying the exact
      // Core operation revalidates its retained AFTER census and same receipt.
      const revalidated = await input.control.applyMerge({
        operationId: op.operationId,
        planDigest: context.planDigest,
      });
      if (!identityRecordsEqual(receipt, revalidated)) return undefined;
      await readCoreMerge(op, revalidated);
      await assertSameOperation(op, "reserved");
      return {
        operationId: op.operationId,
        sourceSubject: op.sourceSubject,
        targetSubject: op.targetSubject,
        externalBindings: external["resource-bindings"].receiptId,
        workspaceMembership: receipt.receiptId,
        billingLedger: external.financial.receiptId,
        consumerIntentCustody: external["hosted-intents"].receiptId,
        rpSessions: external["rp-sessions"].receiptId,
        personalWorkspaceId: plan.personalWorkspaceId,
        reconciledAt: clock(),
      };
    },
    async acknowledgeCredentialUnlinkIntent(request) {
      request = structuredClone(request);
      const admission = await authority.readUnlinkAdmission({
        intentId: request.operationId,
      });
      if (
        !admission ||
        admission.accountId !== request.subject ||
        admission.retainedProofReceiptId !== request.receiptId ||
        admission.identityGeneration !== request.identityGeneration ||
        admission.removedIdentityDigest !==
          (await sha256Text(
            `credential-identity:${upstreamIdentityKey(request.removedIdentity)}`,
          )) ||
        admission.retainedIdentityDigest !==
          (await sha256Text(
            `credential-identity:${upstreamIdentityKey(request.retainedIdentity)}`,
          ))
      )
        return undefined;
      if (!(await ownersReady())) return undefined;
      const receipt = await input.control.acknowledgeUnlink({
        intentId: request.operationId,
      });
      const state = await input.control.read(request.operationId);
      if (
        receipt.kind !== "unlink-preserved" ||
        receipt.operationId !== request.operationId ||
        receipt.authorityVersion !== CONTROL_IDENTITY_AUTHORITY_VERSION ||
        !state?.receipt ||
        !identityRecordsEqual(state.receipt, receipt) ||
        !validTime(receipt.recordedAt, admission.createdAt, clock())
      )
        return undefined;
      const context: IdentityExternalOwnerContext = {
        operationId: request.operationId,
        kind: "unlink",
        sourceAccountId: request.subject,
        targetAccountId: request.subject,
        planDigest: receipt.planDigest,
        authorityVersion: CONTROL_IDENTITY_AUTHORITY_VERSION,
        admissionDigest: await sha256Text(
          `control-unlink-owner:${canonicalJson(admission)}`,
        ),
        controlReceiptId: receipt.receiptId,
      };
      const external = await collect(context, Date.parse(receipt.recordedAt));
      if (
        !external ||
        !identityRecordsEqual(
          admission,
          await authority.readUnlinkAdmission({
            intentId: request.operationId,
          }),
        )
      )
        return undefined;
      if (
        !identityRecordsEqual(
          receipt,
          await input.control.acknowledgeUnlink({
            intentId: request.operationId,
          }),
        )
      )
        return undefined;
      return {
        ...request,
        ownerRef: await sha256Text(
          `control-unlink-custody:${canonicalJson({ control: receipt.receiptId, external: ownerKinds.map((k) => external[k].receiptId) })}`,
        ),
        acknowledgedAt: clock(),
      };
    },
    async reconcileRecovery(
      op,
    ): Promise<IdentityMergeRecoveryAcknowledgements | undefined> {
      const persisted = await input.store.findIdentityMergeOperation?.(
        op.operationId,
      );
      if (!persisted || !identityRecordsEqual(persisted, op)) return undefined;
      op = structuredClone(persisted);
      const approval = await input.recoveryApprovals?.findForOperation(
        op.operationId,
      );
      if (!approval) return undefined;
      const admission = await authority.readRecoveryAdmission({
        operationId: op.operationId,
        recoveryId: approval.recoveryId,
      });
      if (!admission || !(await ownersReady())) return undefined;
      const receipt = await input.control.recover({
        operationId: op.operationId,
        recoveryId: approval.recoveryId,
      });
      const state = await input.control.read(op.operationId);
      if (
        receipt.operationId !== op.operationId ||
        receipt.kind !==
          (admission.mode === "abort-before-active"
            ? "merge-aborted"
            : "merge-restored") ||
        receipt.authorityVersion !== CONTROL_IDENTITY_AUTHORITY_VERSION ||
        receipt.planDigest !== admission.planDigest ||
        !state?.receipt ||
        !identityRecordsEqual(state.receipt, receipt) ||
        !validTime(receipt.recordedAt, op.createdAt, clock())
      )
        return undefined;
      const external = await collect(
        {
          operationId: op.operationId,
          kind: admission.mode,
          contextPins: state.plan?.contexts,
          personalWorkspaceId: state.plan?.personalWorkspaceId,
          proofBindingDigest: state.plan?.proofBindingDigest,
          sourceAccountId: op.sourceSubject,
          targetAccountId: op.targetSubject,
          planDigest: admission.planDigest,
          authorityVersion: CONTROL_IDENTITY_AUTHORITY_VERSION,
          admissionDigest: await sha256Text(
            `control-recovery-owner:${canonicalJson({ operationId: admission.operationId, recoveryId: admission.recoveryId, sourceAccountId: admission.sourceAccountId, targetAccountId: admission.targetAccountId, planDigest: admission.planDigest, mode: admission.mode })}`,
          ),
          controlReceiptId: receipt.receiptId,
        },
        Date.parse(receipt.recordedAt),
      );
      if (
        !external ||
        !identityRecordsEqual(
          admission,
          await authority.readRecoveryAdmission({
            operationId: op.operationId,
            recoveryId: approval.recoveryId,
          }),
        )
      )
        return undefined;
      if (
        !identityRecordsEqual(
          receipt,
          await input.control.recover({
            operationId: op.operationId,
            recoveryId: approval.recoveryId,
          }),
        )
      )
        return undefined;
      const ack = {
        operationId: op.operationId,
        sourceSubject: op.sourceSubject,
        targetSubject: op.targetSubject,
        externalBindings: external["resource-bindings"].receiptId,
        workspaceMembership: receipt.receiptId,
        billingLedger: external.financial.receiptId,
        consumerIntentCustody: external["hosted-intents"].receiptId,
        rpSessions: external["rp-sessions"].receiptId,
        personalWorkspaceId: op.contextPlan!.canonicalPersonalWorkspaceId,
        reconciledAt: clock(),
        undoOperationId: admission.recoveryId,
        reviewedRecoveryRef: admission.reviewedApprovalRef,
      };
      return {
        ...ack,
        ...(admission.mode === "abort-before-active"
          ? {
              preActivationRollback: {
                externalBindings: ack.externalBindings,
                workspaceMembership: ack.workspaceMembership,
                billingLedger: ack.billingLedger,
                rpSessions: ack.rpSessions,
                consumerIntentCustody: ack.consumerIntentCustody,
              },
            }
          : {}),
      };
    },
  };
  return adapter;
}
function validTime(value: string, minimum: number, now: number): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= minimum && timestamp <= now;
}
function validOwnerReceipt(
  receipt: IdentityExternalOwnerReceipt | undefined,
  context: IdentityExternalOwnerContext,
  port: IdentityExternalOwnerPort,
  now: number,
  notBefore: number,
): receipt is IdentityExternalOwnerReceipt {
  if (!receipt) return false;
  const {
    receiptId: _id,
    ownerId: _owner,
    ownerVersion: _version,
    recordedAt: _at,
    ...bound
  } = receipt;
  return (
    identityRecordsEqual(bound, context) &&
    receipt.operationId === context.operationId &&
    receipt.kind === context.kind &&
    receipt.sourceAccountId === context.sourceAccountId &&
    receipt.targetAccountId === context.targetAccountId &&
    receipt.planDigest === context.planDigest &&
    receipt.authorityVersion === context.authorityVersion &&
    receipt.admissionDigest === context.admissionDigest &&
    receipt.controlReceiptId === context.controlReceiptId &&
    receipt.ownerId === port.ownerId &&
    receipt.ownerVersion === port.ownerVersion &&
    typeof receipt.receiptId === "string" &&
    receipt.receiptId.length > 0 &&
    receipt.receiptId.length <= 256 &&
    Number.isSafeInteger(receipt.recordedAt) &&
    receipt.recordedAt >= notBefore &&
    receipt.recordedAt <= now
  );
}
function canonicalJson(value: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, sorted(v)]),
          )
        : v;
  return JSON.stringify(sorted(value));
}
