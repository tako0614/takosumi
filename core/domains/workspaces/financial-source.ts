/**
 * Canonical Control permission-source custody. These are private, in-process
 * raw-store types, not the Accounts financial wire or a payer grant. Accounts
 * owns wire materialization above this facade and authenticates its actor from
 * the actual client-bound grant before and after awaiting a capture.
 */
import type { Workspace, WorkspaceMember } from "takosumi-contract/workspaces";
import type { WorkspaceBillingBinding } from "takosumi-contract";
import type { WorkspaceManagement } from "../deploy-control/store.ts";
import { stableStringify } from "../../adapters/source/digest.ts";

export const WORKSPACE_FINANCIAL_SOURCE_PAGE_LIMIT = 64;

export interface WorkspaceFinancialEnrollmentCandidate {
  readonly workspace: Workspace;
  readonly management: WorkspaceManagement;
  readonly binding: WorkspaceBillingBinding;
  /** Complete bounded roster, not a page presented as a complete census. */
  readonly members: readonly WorkspaceMember[];
}

/** Only an independently qualified owner enrollment may supply this record.
 * Missing state or an ordinary request never creates a registration/genesis. */
export interface WorkspaceFinancialRegistration {
  readonly sourceRef: string;
  readonly incarnation: string;
  readonly genesisDigest: string;
  readonly requiredReceivers: readonly { readonly receiverRef: string; readonly targetRef: string }[];
}

export interface WorkspaceFinancialSourceHead extends WorkspaceFinancialRegistration {
  readonly workspaceId: string;
  readonly workspaceCreatedAt: string;
  readonly organizationRef: string;
  readonly workspaceRef: string;
  readonly bindingIntentId: string;
  readonly bindingJson: string;
  /** Independent of managementEpoch, including actual membership mutations. */
  readonly permissionSequence: number;
  readonly lastEventRef: string | null;
  readonly managementState: WorkspaceManagement["managementState"];
  readonly closed: boolean;
  readonly materializedSequence: number;
  readonly materializedDigest: string;
  readonly enrolledAt: string;
}

export type WorkspaceFinancialRawEventKind =
  | "member-insert" | "member-update" | "member-delete"
  | "workspace-update" | "workspace-delete" | "management-update";

export interface WorkspaceFinancialRawEvent {
  readonly eventRef: string;
  readonly sourceRef: string;
  readonly incarnation: string;
  readonly workspaceId: string;
  readonly permissionSequence: number;
  readonly previousEventRef: string | null;
  readonly kind: WorkspaceFinancialRawEventKind;
  /** Actual immutable local before/after facts; no assumed SQL SHA function. */
  readonly payloadJson: string;
  readonly closed: boolean;
  readonly recordedAt: string;
}

/** Upper-owned canonical wire bytes are frozen once against the exact raw
 * event and original predecessor. Core never reimplements that wire codec. */
export interface WorkspaceFinancialMaterialization {
  readonly eventRef: string;
  readonly sourceRef: string;
  readonly incarnation: string;
  readonly permissionSequence: number;
  readonly rawPayloadJson: string;
  readonly previousDigest: string;
  readonly wireJson: string;
  readonly digest: string;
}

export interface WorkspaceFinancialReceipt {
  readonly eventRef: string;
  readonly sourceRef: string;
  readonly incarnation: string;
  readonly permissionSequence: number;
  readonly receiverRef: string;
  readonly targetRef: string;
  readonly digest: string;
  readonly receiptRef: string;
  readonly receiptJson: string;
}

export interface WorkspaceFinancialSourceSnapshot {
  readonly workspace: Workspace;
  readonly member: WorkspaceMember;
  readonly binding: WorkspaceBillingBinding;
  readonly management: WorkspaceManagement;
  readonly head: WorkspaceFinancialSourceHead;
}

/** Historical custody only. This is not a current head, actor grant or ACK. */
export interface WorkspaceFinancialEnrollmentOriginal {
  readonly workspaceId: string;
  readonly sourceRef: string;
  readonly incarnation: string;
  readonly registrationJson: string;
  readonly enrollmentJson: string;
  readonly identityJson: string;
  readonly enrolledAt: string;
}

export type WorkspaceFinancialEnrollmentOriginalQuery = Pick<
  WorkspaceFinancialEnrollmentOriginal, "workspaceId" | "sourceRef" | "incarnation"
>;

export class WorkspaceFinancialOriginalReadError extends Error {
  constructor(readonly code: "invalid_request" | "conflict" | "unavailable") {
    super(`Workspace financial original ${code}`);
    this.name = "WorkspaceFinancialOriginalReadError";
  }
}

export interface WorkspaceFinancialSourceStore {
  /** All enrollment predicates and the original census are rechecked INSIDE
   * the head insert transaction. Unknown ACK retries this exact registration. */
  prepareWorkspaceFinancialEnrollment(workspaceId: string): Promise<WorkspaceFinancialEnrollmentCandidate | undefined>;
  enrollWorkspaceFinancialSource(input: {
    readonly original: WorkspaceFinancialEnrollmentCandidate;
    readonly registration: WorkspaceFinancialRegistration;
    readonly enrolledAt: string;
  }): Promise<WorkspaceFinancialSourceHead | undefined>;
  getWorkspaceFinancialSourceHead(workspaceId: string): Promise<WorkspaceFinancialSourceHead | undefined>;
  readWorkspaceFinancialEnrollmentOriginal(
    input: WorkspaceFinancialEnrollmentOriginalQuery,
  ): Promise<WorkspaceFinancialEnrollmentOriginal | undefined>;
  /** One current primary snapshot, including actual active membership and
   * complete enrolled receiver acknowledgement; missing/pending denies. */
  captureWorkspaceFinancialSourceSnapshot(input: {
    readonly workspaceId: string;
    readonly actorAccountId: string;
  }): Promise<WorkspaceFinancialSourceSnapshot | undefined>;
  listWorkspaceFinancialRawEvents(input: {
    readonly workspaceId: string;
    readonly afterSequence: number;
    readonly limit: number;
  }): Promise<readonly WorkspaceFinancialRawEvent[]>;
  getWorkspaceFinancialMaterialization(eventRef: string): Promise<WorkspaceFinancialMaterialization | undefined>;
  /** One actual local transaction advances event materialization and the
   * durable contiguous progress CAS, or changes neither. */
  materializeWorkspaceFinancialEvent(input: WorkspaceFinancialMaterializationInput): Promise<boolean>;
  recordWorkspaceFinancialReceipt(input: WorkspaceFinancialReceipt): Promise<boolean>;
  listWorkspaceFinancialPendingEvents(input: {
    readonly workspaceId: string;
    readonly receiverRef: string;
    readonly afterSequence: number;
    readonly limit: number;
  }): Promise<readonly WorkspaceFinancialMaterialization[]>;
}

export function workspaceFinancialReference(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value))
    throw new TypeError("Exact Workspace financial source reference required");
  return value;
}

export function workspaceFinancialPage(input: { readonly afterSequence: number; readonly limit: number }): void {
  if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0 ||
    !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > WORKSPACE_FINANCIAL_SOURCE_PAGE_LIMIT)
    throw new TypeError("Bounded Workspace financial source cursor required");
}

export function workspaceFinancialRegistration(input: WorkspaceFinancialRegistration): WorkspaceFinancialRegistration {
  workspaceFinancialReference(input.sourceRef);
  if(input.sourceRef.length>220)throw new TypeError("Bounded original source/event reference required");
  workspaceFinancialReference(input.incarnation);
  const receivers = input.requiredReceivers;
  if (!/^[a-f0-9]{64}$/u.test(input.genesisDigest) || !Array.isArray(receivers) ||
    receivers.length < 1 || receivers.length > 8 ||
    Reflect.ownKeys(receivers).length !== receivers.length + 1)
    throw new TypeError("Qualified original source genesis/complete receiver set required");
  const result: { receiverRef: string; targetRef: string }[] = [];
  for (let i = 0; i < receivers.length; i++) {
    const slot = Object.getOwnPropertyDescriptor(receivers, String(i));
    if (!slot || !("value" in slot) || !slot.value) throw new TypeError("Dense original receiver set required");
    const { receiverRef, targetRef } = slot.value;
    result.push({ receiverRef: workspaceFinancialReference(receiverRef), targetRef: workspaceFinancialReference(targetRef) });
  }
  if (new Set(result.map((row) => row.receiverRef)).size !== result.length)
    throw new TypeError("Distinct original receiver set required");
  return { sourceRef: input.sourceRef, incarnation: input.incarnation, genesisDigest: input.genesisDigest,
    requiredReceivers: result };
}

/** Snapshot all three own data properties before the first await. A caller's
 * DTO never supplies any returned enrollment fact or a currentness claim. */
function originalQuery(input: WorkspaceFinancialEnrollmentOriginalQuery): WorkspaceFinancialEnrollmentOriginalQuery {
  try {
    if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype ||
      !sameKeys(input, ["workspaceId", "sourceRef", "incarnation"]))
      throw new Error();
    const values = ["workspaceId", "sourceRef", "incarnation"].map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") throw new Error();
      return workspaceFinancialReference(descriptor.value);
    });
    if (values[1]!.length > 220) throw new Error();
    return { workspaceId: values[0]!, sourceRef: values[1]!, incarnation: values[2]! };
  } catch {
    throw new WorkspaceFinancialOriginalReadError("invalid_request");
  }
}

function sameKeys(value: object, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function originalJson(value: unknown, maximumBytes: number): unknown {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > maximumBytes) throw new Error();
  const parsed: unknown = JSON.parse(value);
  // The actual enrollment writer stores JSON.stringify bytes. Reject changed
  // whitespace, duplicate keys and non-writer serialization rather than
  // silently manufacturing a different Financial original.
  if (JSON.stringify(parsed) !== value) throw new Error();
  return parsed;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Validate actual retained bytes and their immutable identity, without
 * consulting live Workspace, membership, management or current source head. */
function retainedOriginal(raw: WorkspaceFinancialEnrollmentOriginal): WorkspaceFinancialEnrollmentOriginal {
  try {
    const registrationValue = originalJson(raw.registrationJson, 16_384);
    const enrollmentValue = originalJson(raw.enrollmentJson, 262_144);
    if (!record(registrationValue) || !sameKeys(registrationValue,
      ["sourceRef", "incarnation", "genesisDigest", "requiredReceivers"]) ||
      !Array.isArray(registrationValue.requiredReceivers) ||
      !registrationValue.requiredReceivers.every((receiver: unknown) =>
        record(receiver) && sameKeys(receiver, ["receiverRef", "targetRef"])) ||
      !record(enrollmentValue) || !sameKeys(enrollmentValue,
        ["workspace", "management", "binding", "members"]) ||
      !record(enrollmentValue.workspace) || !record(enrollmentValue.management) ||
      !record(enrollmentValue.binding) || !Array.isArray(enrollmentValue.members)) throw new Error();
    const registration = workspaceFinancialRegistration(registrationValue as unknown as WorkspaceFinancialRegistration);
    const enrollment = enrollmentValue as unknown as WorkspaceFinancialEnrollmentCandidate;
    if (!candidateAllowed(enrollment) ||
      !enrollment.members.every((member) => record(member) &&
        typeof member.id === "string" && typeof member.accountId === "string" &&
        typeof member.createdAt === "string" && typeof member.updatedAt === "string" &&
        (member.status === "active" || member.status === "invited" || member.status === "suspended") &&
        Array.isArray(member.roles) && member.roles.every((role) =>
          role === "owner" || role === "admin" || role === "member" || role === "viewer")) ||
      new Set(enrollment.members.map((member) => member.accountId)).size !== enrollment.members.length ||
      enrollment.workspace.id !== raw.workspaceId ||
      enrollment.management.workspaceId !== raw.workspaceId ||
      enrollment.binding.workspaceId !== raw.workspaceId ||
      typeof enrollment.workspace.createdAt !== "string" ||
      enrollment.binding.workspaceCreatedAt !== enrollment.workspace.createdAt ||
      !Number.isSafeInteger(enrollment.management.managementEpoch) ||
      enrollment.management.managementEpoch < 0 ||
      !Number.isSafeInteger(enrollment.binding.managementEpoch) ||
      enrollment.binding.managementEpoch < 0 ||
      typeof enrollment.binding.billingAuthority !== "string" ||
      typeof enrollment.binding.actorAccountId !== "string" ||
      typeof enrollment.binding.ownerAcknowledgementRef !== "string" ||
      typeof enrollment.binding.boundAt !== "string" ||
      typeof enrollment.binding.organizationRef !== "string" ||
      typeof enrollment.binding.workspaceRef !== "string" ||
      typeof enrollment.binding.intentId !== "string" ||
      registration.sourceRef !== raw.sourceRef || registration.incarnation !== raw.incarnation ||
      JSON.stringify(registration) !== raw.registrationJson ||
      typeof raw.enrolledAt !== "string" || raw.enrolledAt.length > 35 ||
      !raw.enrolledAt.endsWith("Z") || new Date(raw.enrolledAt).toISOString() !== raw.enrolledAt) throw new Error();
    const identity = headIdentity(newHead(enrollment, registration, raw.enrolledAt));
    if (typeof raw.identityJson !== "string" ||
      new TextEncoder().encode(raw.identityJson).length > 262_144 ||
      raw.identityJson !== identity) throw new Error();
    return { workspaceId: raw.workspaceId, sourceRef: raw.sourceRef, incarnation: raw.incarnation,
      registrationJson: raw.registrationJson, enrollmentJson: raw.enrollmentJson,
      identityJson: raw.identityJson, enrolledAt: raw.enrolledAt };
  } catch {
    throw new WorkspaceFinancialOriginalReadError("unavailable");
  }
}

export interface WorkspaceFinancialMaterializationInput {
  /** FULL original local raw payload, never only the portable raw digest. */
  readonly original: WorkspaceFinancialRawEvent;
  /** Exact head captured before upper-owned asynchronous SHA work. */
  readonly expectedHead: WorkspaceFinancialSourceHead;
  readonly materialization: WorkspaceFinancialMaterialization;
}

function receiptKey(eventRef:string,receiverRef:string):string { return JSON.stringify([eventRef,receiverRef]); }
function same(a: unknown, b: unknown): boolean { return stableStringify(a) === stableStringify(b); }
function copy<T>(value: T): T { return structuredClone(value); }
function digest(value: string): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function materializationMatches(input: WorkspaceFinancialMaterializationInput): boolean {
  const { original: e, expectedHead: h, materialization: m } = input;
  return Number.isSafeInteger(e.permissionSequence) && e.permissionSequence > 0 &&
    m.eventRef === e.eventRef && m.sourceRef === e.sourceRef && m.incarnation === e.incarnation &&
    m.permissionSequence === e.permissionSequence && m.rawPayloadJson === e.payloadJson &&
    h.workspaceId === e.workspaceId && h.sourceRef === e.sourceRef && h.incarnation === e.incarnation &&
    h.materializedSequence === e.permissionSequence - 1 && m.previousDigest === h.materializedDigest &&
    digest(m.digest) && digest(m.previousDigest) && typeof m.wireJson === "string" &&
    new TextEncoder().encode(m.wireJson).length <= 16384;
}
function newHead(original: WorkspaceFinancialEnrollmentCandidate, registration: WorkspaceFinancialRegistration, enrolledAt: string): WorkspaceFinancialSourceHead {
  return { ...registration, workspaceId: original.workspace.id, workspaceCreatedAt: original.workspace.createdAt,
    organizationRef: original.binding.organizationRef, workspaceRef: original.binding.workspaceRef,
    bindingIntentId: original.binding.intentId, bindingJson: JSON.stringify(original.binding),
    permissionSequence: 0, lastEventRef: null, managementState: original.management.managementState,
    closed: false, materializedSequence: 0, materializedDigest: registration.genesisDigest, enrolledAt };
}
function headIdentity(head:WorkspaceFinancialSourceHead):string {
  return JSON.stringify({sourceRef:head.sourceRef,incarnation:head.incarnation,genesisDigest:head.genesisDigest,requiredReceivers:head.requiredReceivers,
    workspaceId:head.workspaceId,workspaceCreatedAt:head.workspaceCreatedAt,organizationRef:head.organizationRef,workspaceRef:head.workspaceRef,
    bindingIntentId:head.bindingIntentId,bindingJson:head.bindingJson,enrolledAt:head.enrolledAt});
}
function candidateAllowed(c: WorkspaceFinancialEnrollmentCandidate | undefined): c is WorkspaceFinancialEnrollmentCandidate {
  return !!c && c.management.managementState === "active" && !c.workspace.archivedAt &&
    c.members.length > 0 && c.members.length <= WORKSPACE_FINANCIAL_SOURCE_PAGE_LIMIT &&
    c.binding.workspaceId === c.workspace.id && c.members.every((m) => m.workspaceId === c.workspace.id);
}

/** Same synchronous memory commit as the actual canonical Maps. No alternate
 * live roster is stored here. Store mutation calls record BEFORE publishing. */
export class MemoryWorkspaceFinancialSource {
  readonly heads = new Map<string, WorkspaceFinancialSourceHead>();
  readonly enrollments = new Map<string, WorkspaceFinancialEnrollmentCandidate>();
  readonly events = new Map<string, WorkspaceFinancialRawEvent>();
  readonly materializations = new Map<string, WorkspaceFinancialMaterialization>();
  readonly receipts = new Map<string, WorkspaceFinancialReceipt>();
  readonly materializationHeads = new Map<string, WorkspaceFinancialSourceHead>();

  enroll(current: WorkspaceFinancialEnrollmentCandidate | undefined, input: {
    original: WorkspaceFinancialEnrollmentCandidate; registration: WorkspaceFinancialRegistration; enrolledAt: string;
  }): WorkspaceFinancialSourceHead | undefined {
    const registration = workspaceFinancialRegistration(input.registration);
    const existing = this.heads.get(input.original.workspace.id);
    if (existing) return same(this.enrollments.get(existing.workspaceId), input.original) &&
      same({ sourceRef: existing.sourceRef, incarnation: existing.incarnation, genesisDigest: existing.genesisDigest,
        requiredReceivers: existing.requiredReceivers }, registration) ? copy(existing) : undefined;
    if (!candidateAllowed(current) || !same(current, input.original) || [...this.heads.values()].some((h) => h.sourceRef === registration.sourceRef)) return undefined;
    const head = newHead(input.original, registration, input.enrolledAt);
    this.enrollments.set(head.workspaceId, copy(input.original)); this.heads.set(head.workspaceId, head);
    return copy(head);
  }

  readOriginal(input: WorkspaceFinancialEnrollmentOriginalQuery): WorkspaceFinancialEnrollmentOriginal | undefined {
    input = originalQuery(input);
    let head: WorkspaceFinancialSourceHead | undefined;
    for (const candidate of this.heads.values()) {
      if (candidate.workspaceId !== input.workspaceId && candidate.sourceRef !== input.sourceRef) continue;
      if (head) throw new WorkspaceFinancialOriginalReadError("conflict");
      head = candidate;
    }
    if (!head) {
      if (this.enrollments.has(input.workspaceId)) throw new WorkspaceFinancialOriginalReadError("unavailable");
      return undefined;
    }
    if (head.workspaceId !== input.workspaceId || head.sourceRef !== input.sourceRef ||
      head.incarnation !== input.incarnation) throw new WorkspaceFinancialOriginalReadError("conflict");
    const enrollment = this.enrollments.get(head.workspaceId);
    if (!enrollment) throw new WorkspaceFinancialOriginalReadError("unavailable");
    try {
      const registration: WorkspaceFinancialRegistration = {
        sourceRef: head.sourceRef, incarnation: head.incarnation,
        genesisDigest: head.genesisDigest, requiredReceivers: head.requiredReceivers,
      };
      const result = retainedOriginal({ workspaceId: head.workspaceId, sourceRef: head.sourceRef,
        incarnation: head.incarnation, registrationJson: JSON.stringify(registration),
        enrollmentJson: JSON.stringify(enrollment), identityJson: headIdentity(head),
        enrolledAt: head.enrolledAt });
      return copy(result);
    } catch {
      throw new WorkspaceFinancialOriginalReadError("unavailable");
    }
  }

  record(workspaceId: string, kind: WorkspaceFinancialRawEventKind, before: unknown, after: unknown,
    managementState?: WorkspaceManagement["managementState"]): void {
    const head = this.heads.get(workspaceId);
    if (!head || same(before, after)) return;
    // Cleanup after the already-recorded terminal Workspace deletion is allowed;
    // creation/update must never resurrect the retained original incarnation.
    if (head.closed) { if (kind === "member-delete") return; throw new Error("Financial source is permanently closed"); }
    if (!Number.isSafeInteger(head.permissionSequence + 1)) throw new Error("Financial source sequence exhausted");
    const sequence = head.permissionSequence + 1;
    const eventRef = `${head.sourceRef}/event/${sequence}`;
    const event: WorkspaceFinancialRawEvent = { eventRef, sourceRef: head.sourceRef, incarnation: head.incarnation,
      workspaceId, permissionSequence: sequence, previousEventRef: head.lastEventRef, kind,
      payloadJson: JSON.stringify({ before: before ?? null, after: after ?? null }),
      closed: kind === "workspace-delete", recordedAt: new Date().toISOString() };
    this.events.set(eventRef, event); this.heads.set(workspaceId, { ...head, permissionSequence: sequence,
      lastEventRef: eventRef, closed: event.closed, managementState: managementState ?? head.managementState });
  }

  snapshot(candidate: WorkspaceFinancialEnrollmentCandidate | undefined, actorAccountId: string): WorkspaceFinancialSourceSnapshot | undefined {
    const head = candidate && this.heads.get(candidate.workspace.id);
    const member = candidate?.members.find((m) => m.accountId === actorAccountId && m.status === "active");
    if (!candidateAllowed(candidate) || !member || !head || head.closed ||
      head.workspaceCreatedAt !== candidate.workspace.createdAt || head.bindingJson !== JSON.stringify(candidate.binding) ||
      head.permissionSequence !== head.materializedSequence || !this.acknowledged(head)) return undefined;
    return copy({ workspace: candidate.workspace, member, binding: candidate.binding, management: candidate.management, head });
  }
  acknowledged(head: WorkspaceFinancialSourceHead): boolean {
    if (head.permissionSequence === 0) return true; // qualified genesis is distinct from event receipt
    return head.lastEventRef!==null && head.requiredReceivers.every((r) => this.hasReceipt(head.lastEventRef!,r.receiverRef));
  }
  hasReceipt(eventRef:string,receiverRef:string):boolean { return this.receipts.has(receiptKey(eventRef,receiverRef)); }
  materialize(input: WorkspaceFinancialMaterializationInput): boolean {
    input = copy(input);
    if (!materializationMatches(input) || !same(this.events.get(input.original.eventRef), input.original)) return false;
    const existing = this.materializations.get(input.original.eventRef);
    if (existing) return same(existing, input.materialization) && same(this.materializationHeads.get(input.original.eventRef),input.expectedHead);
    const head = this.heads.get(input.original.workspaceId);
    if (!same(head, input.expectedHead)) return false;
    const predecessor = input.original.previousEventRef === null ? undefined : this.materializations.get(input.original.previousEventRef);
    if (input.original.permissionSequence > 1 && (!predecessor || predecessor.permissionSequence !== input.original.permissionSequence - 1 ||
      predecessor.digest !== input.materialization.previousDigest)) return false;
    this.materializations.set(input.original.eventRef, input.materialization);
    this.materializationHeads.set(input.original.eventRef,input.expectedHead);
    this.heads.set(head!.workspaceId, { ...head!, materializedSequence: input.original.permissionSequence, materializedDigest: input.materialization.digest });
    return true;
  }
  receipt(input: WorkspaceFinancialReceipt): boolean {
    input = copy(input);
    const event = this.events.get(input.eventRef), materialization = this.materializations.get(input.eventRef);
    const head = event && this.heads.get(event.workspaceId);
    if (!event || !head || !materialization || event.sourceRef !== input.sourceRef || event.incarnation !== input.incarnation ||
      event.permissionSequence !== input.permissionSequence || materialization.digest !== input.digest ||
      !head.requiredReceivers.some((r) => r.receiverRef === input.receiverRef && r.targetRef === input.targetRef)) return false;
    if(event.permissionSequence>1){
      if(event.previousEventRef===null)return false;
      const prior=this.receipts.get(receiptKey(event.previousEventRef,input.receiverRef));
      if(!prior||prior.targetRef!==input.targetRef||prior.permissionSequence!==event.permissionSequence-1||prior.incarnation!==input.incarnation)return false;
    }
    const key = receiptKey(input.eventRef,input.receiverRef), existing = this.receipts.get(key);
    if (existing) return same(existing, input);
    this.receipts.set(key, input); return true;
  }
}

export interface FinancialSourceSqlPort {
  readonly dialect: "d1" | "postgres";
  /** Actual same-primary storage adapter. Params use portable ? positions. */
  query(sql: string, parameters?: readonly (string | number | null)[]): Promise<readonly Record<string, unknown>[]>;
  /** PostgreSQL locks the actual Workspace before taking the census statement;
   * D1 serializes the single guarded insert, without a second transaction. */
  enroll<T>(workspaceId: string, action: (port: FinancialSourceSqlPort) => Promise<T>): Promise<T>;
}

/** Shared raw-store mechanics. Each write below is ONE guarded SQL statement;
 * actual database triggers atomically retain progression and rollback failures. */
export class SqlWorkspaceFinancialSource implements WorkspaceFinancialSourceStore {
  constructor(readonly port: FinancialSourceSqlPort) {}
  table(suffix: string): string { return `${this.port.dialect === "postgres" ? "takosumi_" : ""}${suffix}`; }
  json(column: string): string { return this.port.dialect === "postgres" ? `${column}::jsonb` : `json(${column})`; }
  value(column: string, key: string): string { return this.port.dialect === "postgres" ? `(${column}::jsonb ->> '${key}')` : `json_extract(${column}, '$.${key}')`; }
  equalsJson(left: string, right: string): string {
    // D1 JSON text equality is byte-strict intentionally: unknown ACK must not
    // substitute a recanonicalized raw payload for original stored bytes.
    return this.port.dialect === "postgres" ? `(${left})::jsonb = (${right})::jsonb` : `${left} = ${right}`;
  }
  candidateSql(workspaceId: string): { sql: string; parameters: readonly string[] } {
    const pg = this.port.dialect === "postgres", object = pg ? "jsonb_build_object" : "json_object";
    const w = pg ? "w.space_json" : "w.record_json", m = pg ? "m.member_json" : "m.record_json";
    const members = pg ? `(select coalesce(jsonb_agg(items.member_json order by items.created_at, items.id), '[]'::jsonb) from ${this.table("workspace_members")} items where items.workspace_id=w.id)` :
      `(select json_group_array(json(record_json)) from (select record_json from workspace_members where workspace_id=w.id order by created_at, id))`;
    return { sql: `select ${object}('workspace', ${this.json(w)}, 'management', ${object}('workspaceId',w.id,'managementState',w.management_state,'managementEpoch',w.management_epoch),
      'binding', ${this.json("b.record_json")}, 'members', ${members}) as candidate_json
      from ${this.table("workspaces")} w join ${this.table("workspace_billing_bindings")} b on b.workspace_id=w.id
      where w.id=? and (select count(*) from (select 1 from ${this.table("workspace_members")} where workspace_id=w.id limit 65) bounded)<=64`, parameters: [workspaceId] };
  }
  async prepareWorkspaceFinancialEnrollment(workspaceId: string) {
    const q = this.candidateSql(workspaceId), rows = await this.port.query(q.sql, q.parameters);
    const candidate = rows[0] ? parseJson<WorkspaceFinancialEnrollmentCandidate>(rows[0].candidate_json) : undefined;
    return candidateAllowed(candidate) ? candidate : undefined;
  }
  async enrollWorkspaceFinancialSource(input: { original: WorkspaceFinancialEnrollmentCandidate; registration: WorkspaceFinancialRegistration; enrolledAt: string }) {
    input = copy(input); input.registration = workspaceFinancialRegistration(input.registration);
    if (!candidateAllowed(input.original)) return undefined;
    const id = input.original.workspace.id;
    return this.port.enroll(id, async (port) => {
      const q = this.candidateSql(id);
      // Compare the actual primary snapshot inside INSERT, including the entire
      // bounded original census; no missing row auto-enrollment or phantom page.
      await port.query(`insert into ${this.table("workspace_financial_sources")} (workspace_id,source_ref,incarnation,registration_json,enrollment_json,identity_json,
        permission_sequence,last_event_ref,management_state,closed,materialized_sequence,materialized_digest,enrolled_at)
        select ?,?,?,?, ?,?,0,null,?,0,0,?,? from (${q.sql}) original
        where ${this.equalsJson("original.candidate_json", "?")} on conflict do nothing`, [id,input.registration.sourceRef,input.registration.incarnation,
        JSON.stringify(input.registration),JSON.stringify(input.original),headIdentity(newHead(input.original,input.registration,input.enrolledAt)),input.original.management.managementState,input.registration.genesisDigest,input.enrolledAt,
        ...q.parameters,JSON.stringify(input.original)]);
      const row = (await port.query(`select * from ${this.table("workspace_financial_sources")} where workspace_id=?`, [id]))[0];
      if (!row || !same(parseJson(row.registration_json),input.registration) || !same(parseJson(row.enrollment_json),input.original)) return undefined;
      return this.head(row);
    });
  }
  head(row: Record<string, unknown>): WorkspaceFinancialSourceHead {
    const original = parseJson<WorkspaceFinancialEnrollmentCandidate>(row.enrollment_json);
    const registration = parseJson<WorkspaceFinancialRegistration>(row.registration_json);
    return { ...newHead(original,registration,String(row.enrolled_at)), permissionSequence:Number(row.permission_sequence), lastEventRef:row.last_event_ref as string|null,
      managementState:row.management_state as WorkspaceManagement["managementState"],closed:Number(row.closed)===1,
      materializedSequence:Number(row.materialized_sequence),materializedDigest:String(row.materialized_digest) };
  }
  async getWorkspaceFinancialSourceHead(workspaceId: string) {
    const row = (await this.port.query(`select * from ${this.table("workspace_financial_sources")} where workspace_id=?`,[workspaceId]))[0];
    return row ? this.head(row) : undefined;
  }
  async readWorkspaceFinancialEnrollmentOriginal(input: WorkspaceFinancialEnrollmentOriginalQuery) {
    const query = originalQuery(input);
    let rows: readonly Record<string, unknown>[];
    try {
      rows = await this.port.query(`select workspace_id,source_ref,incarnation,registration_json,enrollment_json,identity_json,enrolled_at
        from ${this.table("workspace_financial_sources")} where workspace_id=? or source_ref=? limit 3`,
        [query.workspaceId, query.sourceRef]);
    } catch {
      throw new WorkspaceFinancialOriginalReadError("unavailable");
    }
    if (!Array.isArray(rows) || rows.length > 2) throw new WorkspaceFinancialOriginalReadError("unavailable");
    if (rows.length === 0) return undefined;
    if (rows.length !== 1) throw new WorkspaceFinancialOriginalReadError("conflict");
    try {
      const row = rows[0]!;
      if (typeof row.workspace_id !== "string" || typeof row.source_ref !== "string" ||
        typeof row.incarnation !== "string" || typeof row.registration_json !== "string" ||
        typeof row.enrollment_json !== "string" || typeof row.identity_json !== "string" ||
        typeof row.enrolled_at !== "string") throw new WorkspaceFinancialOriginalReadError("unavailable");
      if (row.workspace_id !== query.workspaceId || row.source_ref !== query.sourceRef ||
        row.incarnation !== query.incarnation) throw new WorkspaceFinancialOriginalReadError("conflict");
      return retainedOriginal({ workspaceId: query.workspaceId, sourceRef: query.sourceRef,
        incarnation: query.incarnation, registrationJson: row.registration_json,
        enrollmentJson: row.enrollment_json, identityJson: row.identity_json,
        enrolledAt: row.enrolled_at });
    } catch (error) {
      if (error instanceof WorkspaceFinancialOriginalReadError) throw error;
      throw new WorkspaceFinancialOriginalReadError("unavailable");
    }
  }
  async captureWorkspaceFinancialSourceSnapshot(input: { workspaceId:string;actorAccountId:string }) {
    const pg=this.port.dialect==="postgres",w=pg?"w.space_json":"w.record_json",m=pg?"m.member_json":"m.record_json";
    const receiver = pg ? "jsonb_array_elements(h.registration_json::jsonb -> 'requiredReceivers') receiver" : "json_each(h.registration_json, '$.requiredReceivers') receiver";
    const receiverValue=pg?"receiver":"receiver.value";
    const row=(await this.port.query(`select h.*,${w} as workspace_json,${m} as member_json,b.record_json as binding_json,w.management_epoch as current_management_epoch
      from ${this.table("workspace_financial_sources")} h join ${this.table("workspaces")} w on w.id=h.workspace_id
      join ${this.table("workspace_billing_bindings")} b on b.workspace_id=w.id
      join ${this.table("workspace_members")} m on m.workspace_id=w.id and m.account_id=? and m.status='active'
      where w.id=? and h.closed=0 and w.management_state='active' and h.permission_sequence=h.materialized_sequence
      and w.created_at=${this.value("h.enrollment_json","workspace.createdAt").replace("->> 'workspace.createdAt'", "-> 'workspace' ->> 'createdAt'")}
      and ${this.equalsJson("b.record_json",pg?"h.enrollment_json::jsonb -> 'binding'":"json_extract(h.enrollment_json,'$.binding')")}
      and not exists (select 1 from ${receiver} where h.permission_sequence>0 and not exists (
        select 1 from ${this.table("workspace_financial_receipts")} r where r.event_ref=h.last_event_ref and
        r.receiver_ref=${this.value(receiverValue,"receiverRef")} and r.target_ref=${this.value(receiverValue,"targetRef")}))`,[input.actorAccountId,input.workspaceId]))[0];
    if(!row)return undefined;
    const workspace=parseJson<Workspace>(row.workspace_json),member=parseJson<WorkspaceMember>(row.member_json),binding=parseJson<WorkspaceBillingBinding>(row.binding_json),head=this.head(row);
    if(workspace.archivedAt||workspace.id!==input.workspaceId||workspace.createdAt!==head.workspaceCreatedAt||member.workspaceId!==workspace.id||
      member.accountId!==input.actorAccountId||member.status!=="active"||!Array.isArray(member.roles)||
      binding.workspaceId!==workspace.id||binding.organizationRef!==head.organizationRef||binding.workspaceRef!==head.workspaceRef||binding.intentId!==head.bindingIntentId)return undefined;
    return {workspace,member,binding,
      management:{workspaceId:workspace.id,managementState:"active" as const,managementEpoch:Number(row.current_management_epoch)},head:this.head(row)};
  }
  raw(row:Record<string,unknown>):WorkspaceFinancialRawEvent{return {eventRef:String(row.event_ref),sourceRef:String(row.source_ref),incarnation:String(row.incarnation),
    workspaceId:String(row.workspace_id),permissionSequence:Number(row.sequence),previousEventRef:row.previous_event_ref as string|null,
    kind:row.kind as WorkspaceFinancialRawEventKind,payloadJson:String(row.payload_json),closed:Number(row.closed)===1,recordedAt:String(row.recorded_at)};}
  async listWorkspaceFinancialRawEvents(input:{workspaceId:string;afterSequence:number;limit:number}){
    workspaceFinancialPage(input);
    return (await this.port.query(`select * from ${this.table("workspace_financial_events")} where workspace_id=? and sequence>? order by sequence limit ?`,
      [input.workspaceId,input.afterSequence,input.limit])).map(row=>this.raw(row));
  }
  async getWorkspaceFinancialMaterialization(eventRef:string){
    const row=(await this.port.query(`select record_json from ${this.table("workspace_financial_materializations")} where event_ref=?`,[eventRef]))[0];
    return row?parseJson<WorkspaceFinancialMaterialization>(row.record_json):undefined;
  }
  async materializeWorkspaceFinancialEvent(input:WorkspaceFinancialMaterializationInput){
    input=copy(input); if(!materializationMatches(input))return false;
    const {original:e,expectedHead:h,materialization:m}=input;
    const registration={sourceRef:h.sourceRef,incarnation:h.incarnation,genesisDigest:h.genesisDigest,requiredReceivers:h.requiredReceivers};
    await this.port.query(`insert into ${this.table("workspace_financial_materializations")} (event_ref,source_ref,incarnation,sequence,previous_digest,digest,expected_head_json,record_json)
      select e.event_ref,e.source_ref,e.incarnation,e.sequence,?,?,?,? from ${this.table("workspace_financial_events")} e
      join ${this.table("workspace_financial_sources")} h on h.workspace_id=e.workspace_id
      where e.event_ref=? and e.source_ref=? and e.incarnation=? and e.workspace_id=? and e.sequence=? and
      ${this.port.dialect==="postgres"?"e.previous_event_ref is not distinct from ?":"e.previous_event_ref is ?"} and e.kind=? and e.payload_json=? and e.closed=? and e.recorded_at=?
      and h.permission_sequence=? and ${this.port.dialect==="postgres"?"h.last_event_ref is not distinct from ?":"h.last_event_ref is ?"} and h.closed=? and h.management_state=?
      and h.materialized_sequence=? and h.materialized_digest=? and h.registration_json=? and h.enrolled_at=? and h.identity_json=?
      and ${this.value("h.enrollment_json","workspace.createdAt").replace("->> 'workspace.createdAt'","-> 'workspace' ->> 'createdAt'")}=?
      and ${this.value("h.enrollment_json","binding.organizationRef").replace("->> 'binding.organizationRef'","-> 'binding' ->> 'organizationRef'")}=?
      and ${this.value("h.enrollment_json","binding.workspaceRef").replace("->> 'binding.workspaceRef'","-> 'binding' ->> 'workspaceRef'")}=?
      and ${this.value("h.enrollment_json","binding.intentId").replace("->> 'binding.intentId'","-> 'binding' ->> 'intentId'")}=?
      and ${this.equalsJson(this.port.dialect==="postgres"?"h.enrollment_json::jsonb -> 'binding'":"json_extract(h.enrollment_json,'$.binding')","?")}
      on conflict do nothing`,[m.previousDigest,m.digest,JSON.stringify(h),JSON.stringify(m),e.eventRef,e.sourceRef,e.incarnation,e.workspaceId,e.permissionSequence,e.previousEventRef,
      e.kind,e.payloadJson,e.closed?1:0,e.recordedAt,h.permissionSequence,h.lastEventRef,h.closed?1:0,h.managementState,h.materializedSequence,h.materializedDigest,JSON.stringify(registration),h.enrolledAt,headIdentity(h),h.workspaceCreatedAt,h.organizationRef,h.workspaceRef,h.bindingIntentId,h.bindingJson]);
    // Read-back is unknown-ACK/replay recovery only, never an extra publication transaction.
    const row=(await this.port.query(`select m.record_json,m.expected_head_json,e.* from ${this.table("workspace_financial_materializations")} m
      join ${this.table("workspace_financial_events")} e on e.event_ref=m.event_ref where m.event_ref=?`,[e.eventRef]))[0];
    return !!row && same(this.raw(row),e) && same(parseJson(row.expected_head_json),h) && same(parseJson(row.record_json),m);
  }
  async recordWorkspaceFinancialReceipt(input:WorkspaceFinancialReceipt){
    input=copy(input);workspaceFinancialReference(input.receiptRef);
    const pg=this.port.dialect==="postgres",receiver=pg?"jsonb_array_elements(h.registration_json::jsonb -> 'requiredReceivers') receiver":"json_each(h.registration_json,'$.requiredReceivers') receiver";
    const rv=pg?"receiver":"receiver.value";
    await this.port.query(`insert into ${this.table("workspace_financial_receipts")} (event_ref,receiver_ref,target_ref,record_json)
      select e.event_ref,?,?,? from ${this.table("workspace_financial_events")} e
      join ${this.table("workspace_financial_sources")} h on h.workspace_id=e.workspace_id
      join ${this.table("workspace_financial_materializations")} m on m.event_ref=e.event_ref
      where e.event_ref=? and e.source_ref=? and e.incarnation=? and e.sequence=? and m.digest=? and (e.sequence=1 or exists(select 1 from ${this.table("workspace_financial_receipts")} prior
        where prior.event_ref=e.previous_event_ref and prior.receiver_ref=? and prior.target_ref=?)) and exists(select 1 from ${receiver}
        where ${this.value(rv,"receiverRef") }=? and ${this.value(rv,"targetRef") }=?) on conflict do nothing`,
      [input.receiverRef,input.targetRef,JSON.stringify(input),input.eventRef,input.sourceRef,input.incarnation,input.permissionSequence,input.digest,input.receiverRef,input.targetRef,input.receiverRef,input.targetRef]);
    const row=(await this.port.query(`select record_json from ${this.table("workspace_financial_receipts")} where event_ref=? and receiver_ref=?`,[input.eventRef,input.receiverRef]))[0];
    return !!row && same(parseJson(row.record_json),input);
  }
  async listWorkspaceFinancialPendingEvents(input:{workspaceId:string;receiverRef:string;afterSequence:number;limit:number}){
    workspaceFinancialPage(input);
    return (await this.port.query(`select m.record_json from ${this.table("workspace_financial_materializations")} m
      join ${this.table("workspace_financial_events")} e on e.event_ref=m.event_ref where e.workspace_id=? and e.sequence>?
      and not exists(select 1 from ${this.table("workspace_financial_receipts")} r where r.event_ref=e.event_ref and r.receiver_ref=?)
      order by e.sequence limit ?`,[input.workspaceId,input.afterSequence,input.receiverRef,input.limit])).map(row=>parseJson<WorkspaceFinancialMaterialization>(row.record_json));
  }
}
function parseJson<T>(value:unknown):T{return (typeof value==="string"?JSON.parse(value):value) as T;}

/** Route-less facade over the SAME canonical store. No alternate Directory,
 * financial actor source, remote closure serialization or ordinary enrollment. */
export class WorkspaceFinancialSourceService {
  constructor(readonly store: WorkspaceFinancialSourceStore, readonly now: () => Date = () => new Date()) {}

  prepareEnrollment(input: { readonly workspaceId: string }) {
    workspaceFinancialReference(input.workspaceId);
    return this.store.prepareWorkspaceFinancialEnrollment(input.workspaceId);
  }

  enroll(input: { readonly original: WorkspaceFinancialEnrollmentCandidate; readonly registration: WorkspaceFinancialRegistration }) {
    const original = structuredClone(input.original);
    if (!original || original.members.length > WORKSPACE_FINANCIAL_SOURCE_PAGE_LIMIT)
      throw new TypeError("Original complete financial enrollment census required");
    const registration = workspaceFinancialRegistration(input.registration);
    return this.store.enrollWorkspaceFinancialSource({ original, registration, enrolledAt: this.now().toISOString() });
  }

  readHead(workspaceId: string) {
    workspaceFinancialReference(workspaceId);
    return this.store.getWorkspaceFinancialSourceHead(workspaceId);
  }

  /** GET-only historical original. No Clock, reenrollment or currentness. */
  readEnrollmentOriginal(input: WorkspaceFinancialEnrollmentOriginalQuery) {
    return this.store.readWorkspaceFinancialEnrollmentOriginal(originalQuery(input));
  }

  captureFinancialSourceSnapshot(input: { readonly workspaceId: string; readonly actorAccountId: string }) {
    workspaceFinancialReference(input.workspaceId);
    workspaceFinancialReference(input.actorAccountId);
    // The Accounts owner supplies the actor from its actual validated grant.
    // This private lookup does not assert that an arbitrary string is a grant.
    return this.store.captureWorkspaceFinancialSourceSnapshot({ ...input });
  }

  async assertFinancialSourceSnapshotCurrent(snapshot: WorkspaceFinancialSourceSnapshot): Promise<boolean> {
    const original = structuredClone(snapshot);
    const current = await this.captureFinancialSourceSnapshot({
      workspaceId: original.workspace.id, actorAccountId: original.member.accountId,
    });
    return current !== undefined && stableStringify(current) === stableStringify(original);
  }

  listRawEvents(input: { readonly workspaceId: string; readonly afterSequence: number; readonly limit: number }) {
    workspaceFinancialReference(input.workspaceId);
    workspaceFinancialPage(input);
    return this.store.listWorkspaceFinancialRawEvents({ ...input });
  }
  readMaterialization(eventRef:string){workspaceFinancialReference(eventRef);return this.store.getWorkspaceFinancialMaterialization(eventRef);}
  materializeEvent(input:WorkspaceFinancialMaterializationInput){return this.store.materializeWorkspaceFinancialEvent(structuredClone(input));}
  recordReceipt(input:WorkspaceFinancialReceipt){return this.store.recordWorkspaceFinancialReceipt(structuredClone(input));}
  listPendingEvents(input:{readonly workspaceId:string;readonly receiverRef:string;readonly afterSequence:number;readonly limit:number}){
    workspaceFinancialReference(input.workspaceId);workspaceFinancialReference(input.receiverRef);workspaceFinancialPage(input);
    return this.store.listWorkspaceFinancialPendingEvents({...input});
  }

}
