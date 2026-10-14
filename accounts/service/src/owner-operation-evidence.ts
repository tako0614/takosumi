import type {
  OwnerOperationContextEvidence,
  OwnerOperationReceiptEvidence,
  OwnerOperationTarget,
} from "./owner-operation-contract.ts";
import { CONTROL_IDENTITY_AUTHORITY_VERSION } from "../../../contract/identity-reconciliation.ts";
import { sha256Text, base64UrlEncodeBytes } from "./encoding.ts";

export interface OwnerOperationContextEvidenceLookup {
  operationId: string;
  kind: OwnerOperationContextEvidence["context"]["kind"];
  planDigest: string;
  target: OwnerOperationTarget;
}
export interface OwnerOperationReceiptEvidenceLookup {
  contextEvidenceId: string;
  ownerKind: OwnerOperationReceiptEvidence["ownerKind"];
}
export class OwnerOperationEvidenceConflict extends Error {
  constructor() { super("owner_operation_evidence_conflict"); }
}

export const ownerContextBucket = "owner_operation_context_evidence";
export const ownerReceiptBucket = "owner_operation_receipt_evidence";
export const reviewedApprovalBucket = "reviewed_recovery_approvals";
export const reviewedApprovalCurrentBucket = "reviewed_recovery_current";
export const reviewedApprovalRefBucket = "reviewed_recovery_refs";
export function reviewedApprovalRefKey(value: {operationId:string;recoveryId:string;reviewedApprovalRef:string}): string {
  if (![value.operationId, value.recoveryId, value.reviewedApprovalRef].every(boundedText)) throw new TypeError("invalid_reviewed_approval_ref");
  return JSON.stringify([value.operationId, value.recoveryId, value.reviewedApprovalRef]);
}

export function canonicalOwnerJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalOwnerJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalOwnerJson(object[key])}`).join(",")}}`;
}
export function ownerOperationContextEvidenceId(value: Omit<OwnerOperationContextEvidence, "evidenceId">): Promise<string> {
  return sha256Text(`takosumi.accounts.owner-context-id@v1:${canonicalOwnerJson(value)}`);
}
export function ownerContextKey(value: Pick<OwnerOperationContextEvidenceLookup, "operationId" | "kind" | "planDigest">): string {
  if (!boundedText(value.operationId) || !boundedText(value.planDigest) || !["merge", "unlink", "abort-before-active", "restore-after-active"].includes(value.kind)) throw new TypeError("invalid_owner_context_lookup");
  return JSON.stringify([value.operationId, value.kind, value.planDigest]);
}
export function ownerReceiptKey(value: OwnerOperationReceiptEvidenceLookup): string {
  if (!digest(value.contextEvidenceId) || !["financial", "hosted-intents", "rp-sessions", "resource-bindings"].includes(value.ownerKind)) throw new TypeError("invalid_owner_receipt_lookup");
  return JSON.stringify([value.contextEvidenceId, value.ownerKind]);
}
export function boundedText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256; }
export function digest(value: unknown): value is string {
  if (typeof value !== "string" || !/^sha256:[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  try {
    const encoded = value.slice(7);
    const bytes = Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/") + "="), (c) => c.charCodeAt(0));
    return bytes.byteLength === 32 && base64UrlEncodeBytes(bytes) === encoded;
  } catch { return false; }
}
export function validOwnerTarget(value: unknown): value is OwnerOperationTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as OwnerOperationTarget;
  return Object.keys(target).sort().join(",") === "ownerClientId,ownerKind,targetBindingDigest" && target.ownerKind === "hosted-intents" && boundedText(target.ownerClientId) && digest(target.targetBindingDigest);
}
function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}
const contextRequired = ["operationId", "kind", "sourceAccountId", "targetAccountId", "planDigest", "authorityVersion", "admissionDigest"];
const contextOptional = ["controlReceiptId", "contextPins", "personalWorkspaceId", "proofBindingDigest"];
export async function validOwnerContextEvidence(value: OwnerOperationContextEvidence): Promise<boolean> {
  try {
    if (!exactKeys(value, ["version", "evidenceId", "context", "coreReceipt", "target", "capturedOperationRevision", "capturedAt"], ["recovery"]) || JSON.stringify(value).length > 65536 || value.version !== "takosumi.accounts.owner-context@v1" || !validOwnerTarget(value.target) || !Number.isSafeInteger(value.capturedAt) || value.capturedAt < 0 || !Number.isSafeInteger(value.capturedOperationRevision) || value.capturedOperationRevision < 0) return false;
    const { evidenceId, ...body } = value;
    if (!digest(evidenceId) || evidenceId !== await ownerOperationContextEvidenceId(body)) return false;
    const c = value.context, r = value.coreReceipt;
    if (!exactKeys(c, contextRequired, contextOptional) || !exactKeys(r, ["receiptId", "operationId", "authorityVersion", "kind", "planDigest", "inventoryDigest", "revision", "recordedAt"], ["personalWorkspaceId"])) return false;
    ownerContextKey(c);
    if (!boundedText(c.sourceAccountId) || !boundedText(c.targetAccountId) || c.authorityVersion !== CONTROL_IDENTITY_AUTHORITY_VERSION || !digest(c.admissionDigest) || c.controlReceiptId !== r.receiptId || c.operationId !== r.operationId || c.planDigest !== r.planDigest || r.authorityVersion !== CONTROL_IDENTITY_AUTHORITY_VERSION || !boundedText(r.receiptId) || !boundedText(r.inventoryDigest) || !Number.isSafeInteger(r.revision) || r.revision < 0 || !Number.isFinite(Date.parse(r.recordedAt)) || Date.parse(r.recordedAt) > value.capturedAt) return false;
    const expected = { merge: "merge-applied", unlink: "unlink-preserved", "abort-before-active": "merge-aborted", "restore-after-active": "merge-restored" } as const;
    if (r.kind !== expected[c.kind]) return false;
    if ([c.personalWorkspaceId, c.proofBindingDigest, r.personalWorkspaceId].some((v) => v !== undefined && !boundedText(v))) return false;
    if (c.contextPins && (!Array.isArray(c.contextPins) || c.contextPins.length > 2 || c.contextPins.some((pin) => !exactKeys(pin, ["workspaceId", "workspaceRef", "billingAuthority", "organizationRef", "originalOwnerAccountId", "canonicalAccountId", "roles", "disposition"]) || ![pin.workspaceId, pin.workspaceRef, pin.organizationRef, pin.billingAuthority, pin.originalOwnerAccountId, pin.canonicalAccountId].every(boundedText) || !["retain-personal-anchor", "insert-additional-membership"].includes(pin.disposition) || !Array.isArray(pin.roles) || pin.roles.length < 1 || pin.roles.length > 16 || new Set(pin.roles).size !== pin.roles.length || pin.roles.some((role: unknown) => typeof role !== "string" || role.length < 1 || role.length > 64)))) return false;
    if (value.recovery && (!exactKeys(value.recovery, ["recoveryId", "reviewedApprovalRef", "approvalDigest", "decisionDigest", "ownerEvidenceDigest"]) || !boundedText(value.recovery.recoveryId) || !boundedText(value.recovery.reviewedApprovalRef) || ![value.recovery.approvalDigest, value.recovery.decisionDigest, value.recovery.ownerEvidenceDigest].every(digest))) return false;
    if (["abort-before-active", "restore-after-active"].includes(c.kind) !== !!value.recovery) return false;
    return true;
  } catch { return false; }
}

export function validOwnerReceiptEvidence(value: OwnerOperationReceiptEvidence, parent: OwnerOperationContextEvidence): boolean {
  try {
    ownerReceiptKey(value);
    const r = value.receipt;
    if (!exactKeys(value, ["contextEvidenceId", "ownerKind", "receipt", "observedAt"]) || !exactKeys(r, [...contextRequired, "receiptId", "ownerId", "ownerVersion", "recordedAt"], contextOptional) || JSON.stringify(value).length > 65536 || value.contextEvidenceId !== parent.evidenceId || !Number.isSafeInteger(value.observedAt) || value.observedAt < parent.capturedAt || !Number.isSafeInteger(r.recordedAt) || r.recordedAt < parent.capturedAt || r.recordedAt > value.observedAt || !boundedText(r.receiptId) || !boundedText(r.ownerId) || !boundedText(r.ownerVersion)) return false;
    const { receiptId: _receipt, ownerId: _owner, ownerVersion: _version, recordedAt: _time, ...context } = r;
    return canonicalOwnerJson(context) === canonicalOwnerJson(parent.context);
  } catch { return false; }
}
