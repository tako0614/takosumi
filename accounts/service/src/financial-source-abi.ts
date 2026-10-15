/** Accounts-owned ABI revision 1. Payload event/receipt v:1 and their existing
 * codec/vector are unchanged. Hashes provide integrity, never caller authority.
 * No key, registration, target or qualified deployment is created by this file. */
import {
  canonicalFinancialSourceJson, financialSourceDigest, financialSourceRef,
  financialSourceEventDigest, financialReceiptMatches, hashFinancialSourceValue,
  parseFinancialSourceEvent, parseFinancialSourceReceipt, parseFinancialSourceRegistration,
  parseFinancialIdentityChallenge,
  type FinancialSourceDigest, type FinancialSourceEvent, type FinancialSourceReceipt,
  type FinancialSourceReceiptRecord, type FinancialSourceReceiverRegistration,
  type FinancialSourceMaterialization,
} from "./financial-source-contract.ts";
import type { FinancialSourceProofRecord } from "./identity-state.ts";

export interface FinancialSourceApplyRequest { readonly v: 1; readonly event: FinancialSourceEvent; readonly eventDigest: FinancialSourceDigest; }
export interface FinancialSourceReadRequest { readonly v: 1; readonly registrationRef: string; readonly eventRef: string; readonly eventDigest: FinancialSourceDigest; }
export interface FinancialIdentityProofRequest { readonly v: 1; readonly proofRef: string; readonly challengeRef: string; }

/** A registration/incarnation may contain several original contexts. */
export interface FinancialSourceHeadKey { readonly registrationRef: string; readonly incarnation: string; readonly affectedRef: string; }
export interface FinancialSourceRegisteredHead {
  readonly v: 1;
  readonly head: FinancialSourceHeadKey;
  readonly genesisDigest: FinancialSourceDigest;
  readonly receivers: readonly FinancialSourceReceiverRegistration[];
  readonly sourceSchemaRef: string;
  /** Opaque actual owner custody reference, never key bytes or a new credential. */
  readonly sourceCredentialRef: string;
  readonly clockPolicyRef: string;
}
export interface FinancialSourceRegisteredHeadReader {
  /** Actual pre-enrolled owner state. Absence is unavailable, never auto-genesis. */
  readRegisteredHead(input: { readonly v: 1; readonly head: FinancialSourceHeadKey }): Promise<FinancialSourceRegisteredHead | undefined>;
}
export interface FinancialSourceCredentialContext {
  readonly credentialRef: string;
  readonly incarnationRef: string;
  readonly sourceSchemaRef: string;
  readonly receiverRef: string;
  readonly targetRef: string;
  readonly receiverSchemaRef: string;
  readonly clockPolicyRef: string;
  readonly purpose: "event-apply" | "receipt-read";
  readonly validUntil: number;
}
export interface FinancialSourceKeyCustody {
  /** Owning PRIVATE capability/credential reader. A metadata descriptor, CI,
   * method presence or a caller string cannot qualify the actual binding graph.
   * Historical receipt reads use their own current recovery capability; they
   * never resurrect a retired source for new admission. No default exists. */
  readCredentialContext(input: {
    readonly credentialRef: string; readonly receiverRef: string; readonly targetRef: string;
    readonly receiverSchemaRef: string; readonly purpose: "event-apply" | "receipt-read";
  }): Promise<FinancialSourceCredentialContext | undefined>;
}
export interface FinancialSourceClock { readonly policyRef: string; nowMilliseconds(): number; }
export interface FinancialSourceReceiverAbi {
  applySourceEvent(input: FinancialSourceApplyRequest): Promise<FinancialSourceReceipt>;
  readSourceEventReceipt(input: FinancialSourceReadRequest): Promise<FinancialSourceReceipt | undefined>;
}

export interface FinancialSourceReceiverAdapterOptions {
  readonly receiverRef: string;
  readonly targetRef: string;
  readonly receiverSchemaRef: string;
  readonly transport?: FinancialSourceReceiverAbi;
  readonly heads?: FinancialSourceRegisteredHeadReader;
  readonly credentials?: FinancialSourceKeyCustody;
  readonly clock?: FinancialSourceClock;
}

/** Implements the shared ABI at the existing local producer seam. This has no
 * public entrypoint, default target, key or enrollment. Qualification of the
 * actual private graph/primary is owned by the supplied owning composition,
 * and cannot be inferred from these consistent metadata projections. */
export function createFinancialSourceReceiverAdapter(options: FinancialSourceReceiverAdapterOptions) {
  const {receiverRef, targetRef, receiverSchemaRef} = options;
  if (![receiverRef, targetRef, receiverSchemaRef].every(financialSourceRef)) invalid();
  const transport = options.transport, heads = options.heads, credentials = options.credentials, clock = options.clock;
  const apply = transport?.applySourceEvent, read = transport?.readSourceEventReceipt;
  const readHead = heads?.readRegisteredHead, readCredential = credentials?.readCredentialContext;
  const readNow = clock?.nowMilliseconds, clockPolicyRef = clock?.policyRef;
  let previousTime = -1;
  function now(): number {
    if (!clock || !readNow) throw new FinancialSourceAbiError("unavailable");
    const value = Reflect.apply(readNow, clock, []);
    if (!instant(value) || value < previousTime) throw new FinancialSourceAbiError("unavailable");
    previousTime = value; return value;
  }
  async function authority(event: FinancialSourceEvent, purpose: "event-apply" | "receipt-read") {
    if (!transport || !apply || !read || !heads || !readHead || !credentials || !readCredential || !clock || !readNow)
      throw new FinancialSourceAbiError("unavailable");
    const key = {registrationRef: event.registrationRef, incarnation: event.incarnation, affectedRef: event.affectedRef};
    const registered = await Reflect.apply(readHead, heads, [{v: 1, head: structuredClone(key)}]);
    if (registered === undefined) throw new FinancialSourceAbiError("unregistered-source");
    const head = parseFinancialSourceRegisteredHead(registered);
    if (canonicalFinancialSourceJson(head.head) !== canonicalFinancialSourceJson(key) || head.clockPolicyRef !== clockPolicyRef ||
      !head.receivers.some((r) => r.receiverRef === receiverRef && r.targetRef === targetRef)) throw new FinancialSourceAbiError("unregistered-source");
    if (event.sequence === 1 && event.previousDigest !== head.genesisDigest) throw new FinancialSourceAbiError("conflict");
    const value = await Reflect.apply(readCredential, credentials, [{credentialRef: head.sourceCredentialRef,
      receiverRef, targetRef, receiverSchemaRef, purpose}]);
    if (!value) throw new FinancialSourceAbiError("unavailable");
    const context = object(value, ["credentialRef", "incarnationRef", "sourceSchemaRef", "receiverRef", "targetRef", "receiverSchemaRef", "clockPolicyRef", "purpose", "validUntil"]);
    if (context.credentialRef !== head.sourceCredentialRef || !financialSourceRef(context.incarnationRef) ||
      context.sourceSchemaRef !== head.sourceSchemaRef || context.receiverRef !== receiverRef || context.targetRef !== targetRef ||
      context.receiverSchemaRef !== receiverSchemaRef || context.clockPolicyRef !== clockPolicyRef || context.purpose !== purpose ||
      !instant(context.validUntil) || context.validUntil <= now()) throw new FinancialSourceAbiError("unavailable");
    return context.validUntil;
  }
  async function receipt(value: unknown, event: FinancialSourceEvent, digest: FinancialSourceDigest): Promise<FinancialSourceReceipt> {
    const parsed = parseFinancialSourceReceipt(value);
    const expected = await makeFinancialSourceReceipt({registrationRef: event.registrationRef, receiverRef, targetRef, event, eventDigest: digest});
    if (!financialReceiptMatches(event, digest, parsed) || canonicalFinancialSourceJson(parsed) !== canonicalFinancialSourceJson(expected))
      throw new FinancialSourceAbiError("conflict");
    // Recompute the separately domain-separated evidence digest as well. It is
    // available to actual owners via the exported recipe, not another wire key.
    await financialSourceReceiptRecordDigest({registrationRef: event.registrationRef, receiverRef, targetRef, receipt: parsed});
    return parsed;
  }
  return {
    receiverRef, targetRef,
    async deliver(materialization: FinancialSourceMaterialization): Promise<FinancialSourceReceipt> {
      const input = await verifyFinancialSourceApplyRequest({v: 1, event: materialization.event, eventDigest: materialization.eventDigest});
      const validUntil = await authority(input.event, "event-apply");
      if (validUntil <= now()) throw new FinancialSourceAbiError("unavailable");
      let value: unknown;
      try { value = await Reflect.apply(apply!, transport, [structuredClone(input)]); }
      catch (error) { throw closedError(error); }
      const result = await receipt(value, input.event, input.eventDigest);
      if (validUntil <= now()) throw new FinancialSourceAbiError("unavailable");
      return result;
    },
    async read(materialization: FinancialSourceMaterialization): Promise<FinancialSourceReceipt | undefined> {
      const input = await verifyFinancialSourceApplyRequest({v: 1, event: materialization.event, eventDigest: materialization.eventDigest});
      const validUntil = await authority(input.event, "receipt-read");
      const request = parseFinancialSourceReadRequest({v: 1, registrationRef: input.event.registrationRef,
        eventRef: input.event.eventRef, eventDigest: input.eventDigest});
      if (validUntil <= now()) throw new FinancialSourceAbiError("unavailable");
      let value: unknown;
      try { value = await Reflect.apply(read!, transport, [request]); }
      catch (error) { throw closedError(error); }
      if (validUntil <= now()) throw new FinancialSourceAbiError("unavailable");
      // Only actual undefined means not found. null, malformed data, failures
      // and mismatched original digest never become absence or a fresh event.
      if (value === undefined) return undefined;
      const result = await receipt(value, input.event, input.eventDigest);
      if (validUntil <= now()) throw new FinancialSourceAbiError("unavailable");
      return result;
    },
  };
}
export type FinancialSourceAbiErrorCode = "invalid-request" | "unregistered-source" | "conflict" | "unavailable";
export class FinancialSourceAbiError extends Error {
  constructor(readonly code: FinancialSourceAbiErrorCode) { super(code); }
}

export function parseFinancialSourceApplyRequest(value: unknown): FinancialSourceApplyRequest {
  const r = object(value, ["v", "event", "eventDigest"]);
  if (r.v !== 1 || !financialSourceDigest(r.eventDigest)) invalid();
  return {v: 1, event: parseFinancialSourceEvent(r.event), eventDigest: r.eventDigest};
}
export async function verifyFinancialSourceApplyRequest(value: unknown): Promise<FinancialSourceApplyRequest> {
  const input = parseFinancialSourceApplyRequest(value);
  if (await financialSourceEventDigest(input.event) !== input.eventDigest) invalid();
  return input;
}
export function parseFinancialSourceReadRequest(value: unknown): FinancialSourceReadRequest {
  const r = object(value, ["v", "registrationRef", "eventRef", "eventDigest"]);
  if (r.v !== 1 || !financialSourceRef(r.registrationRef) || !financialSourceRef(r.eventRef) || !financialSourceDigest(r.eventDigest)) invalid();
  return {v: 1, registrationRef: r.registrationRef, eventRef: r.eventRef, eventDigest: r.eventDigest};
}
export function parseFinancialIdentityProofRequest(value: unknown): FinancialIdentityProofRequest {
  const r = object(value, ["v", "proofRef", "challengeRef"]);
  if (r.v !== 1 || !financialSourceRef(r.proofRef) || !financialSourceRef(r.challengeRef)) invalid();
  return {v: 1, proofRef: r.proofRef, challengeRef: r.challengeRef};
}
export function parseFinancialSourceHeadKey(value: unknown): FinancialSourceHeadKey {
  const r = object(value, ["registrationRef", "incarnation", "affectedRef"]);
  if (![r.registrationRef, r.incarnation, r.affectedRef].every(financialSourceRef)) invalid();
  return {registrationRef: r.registrationRef as string, incarnation: r.incarnation as string, affectedRef: r.affectedRef as string};
}
export function parseFinancialSourceRegisteredHead(value: unknown): FinancialSourceRegisteredHead {
  const r = object(value, ["v", "head", "genesisDigest", "receivers", "sourceSchemaRef", "sourceCredentialRef", "clockPolicyRef"]);
  const head = parseFinancialSourceHeadKey(r.head);
  if (r.v !== 1 || !financialSourceDigest(r.genesisDigest) ||
    ![r.sourceSchemaRef, r.sourceCredentialRef, r.clockPolicyRef].every(financialSourceRef)) invalid();
  const registration = parseFinancialSourceRegistration({registrationRef: head.registrationRef, incarnation: head.incarnation,
    genesisDigest: r.genesisDigest, receivers: r.receivers});
  return {v: 1, head, genesisDigest: registration.genesisDigest, receivers: registration.receivers,
    sourceSchemaRef: r.sourceSchemaRef as string, sourceCredentialRef: r.sourceCredentialRef as string, clockPolicyRef: r.clockPolicyRef as string};
}

/** Deterministic original receipt identity. Only the receiver's actual committed
 * immutable row/readback may expose it as an ACK; computing it is not an ACK. */
export async function financialSourceReceiptRef(input: {
  readonly registrationRef: string; readonly receiverRef: string; readonly targetRef: string;
  readonly eventRef: string; readonly eventDigest: FinancialSourceDigest; readonly incarnation: string;
  readonly sequence: number; readonly state: FinancialSourceReceipt["state"];
}): Promise<string> {
  const r = object(input, ["registrationRef", "receiverRef", "targetRef", "eventRef", "eventDigest", "incarnation", "sequence", "state"]);
  if (![r.registrationRef, r.receiverRef, r.targetRef].every(financialSourceRef)) invalid();
  parseFinancialSourceReceipt({v: 1, receiptRef: "pending", eventRef: r.eventRef, eventDigest: r.eventDigest,
    incarnation: r.incarnation, sequence: r.sequence, state: r.state});
  const digest = await hashFinancialSourceValue("takosumi.financial-source-receipt-ref@v1", input);
  return `fsr_${digest.slice(7)}`;
}
export async function makeFinancialSourceReceipt(input: {
  readonly registrationRef: string; readonly receiverRef: string; readonly targetRef: string;
  readonly event: FinancialSourceEvent; readonly eventDigest: FinancialSourceDigest;
}): Promise<FinancialSourceReceipt> {
  const verified = await verifyFinancialSourceApplyRequest({v: 1, event: input.event, eventDigest: input.eventDigest});
  if (verified.event.registrationRef !== input.registrationRef) invalid();
  const fields = {eventRef: verified.event.eventRef, eventDigest: verified.eventDigest, incarnation: verified.event.incarnation,
    sequence: verified.event.sequence, state: verified.event.kind === "close" ? "admission-closed" as const : "advanced" as const};
  return {v: 1, ...fields, receiptRef: await financialSourceReceiptRef({registrationRef: input.registrationRef,
    receiverRef: input.receiverRef, targetRef: input.targetRef, ...fields})};
}
/** Exact local record digest domain/value. This is separate from eventDigest
 * and existing Customer/processor fingerprints and is not a signature. */
export async function financialSourceReceiptRecordDigest(value: FinancialSourceReceiptRecord): Promise<FinancialSourceDigest> {
  const r = object(value, ["registrationRef", "receiverRef", "targetRef", "receipt"]);
  if (![r.registrationRef, r.receiverRef, r.targetRef].every(financialSourceRef)) invalid();
  const receipt = parseFinancialSourceReceipt(r.receipt);
  const {v: _v, receiptRef, ...fields} = receipt;
  if (receiptRef !== await financialSourceReceiptRef({registrationRef: value.registrationRef,
    receiverRef: value.receiverRef, targetRef: value.targetRef, ...fields})) invalid();
  return hashFinancialSourceValue("takosumi.financial-source-receipt-record@v1", {registrationRef: value.registrationRef,
    receiverRef: value.receiverRef, targetRef: value.targetRef, receipt});
}

/** Public private-service projection excludes the token hash and internal scope
 * records. Transport remains route-less/unconfigured until its owner qualifies
 * the actual caller, source/target/schema/key custody and physical primary. */
export type FinancialIdentityProof = Omit<FinancialSourceProofRecord, "accessTokenHash" | "accessExpiresAt" | "parents"> & {
  readonly parents: { readonly [K in keyof FinancialSourceProofRecord["parents"]]: Omit<FinancialSourceProofRecord["parents"][K], "scope"> };
};
export type FinancialIdentityProofLoadResult = { readonly v: 1; readonly status: "found"; readonly proof: FinancialIdentityProof } |
  { readonly v: 1; readonly status: "not-found" };
export type FinancialIdentityProofCurrentResult = { readonly v: 1; readonly status: "current"; readonly proof: FinancialIdentityProof; readonly observedAt: number } |
  { readonly v: 1; readonly status: "not-current" };
export interface FinancialIdentityProofReaderAbi {
  loadFinancialIdentityProof(input: FinancialIdentityProofRequest): Promise<FinancialIdentityProofLoadResult>;
  verifyCurrentFinancialIdentityProof(input: FinancialIdentityProofRequest): Promise<FinancialIdentityProofCurrentResult>;
}
export function parseFinancialIdentityProofLoadResult(value: unknown): FinancialIdentityProofLoadResult {
  if (value && typeof value === "object" && "status" in value && value.status === "not-found") {
    const r = object(value, ["v", "status"]); if (r.v !== 1) invalid(); return {v: 1, status: "not-found"};
  }
  const r = object(value, ["v", "status", "proof"]);
  if (r.v !== 1 || r.status !== "found") invalid();
  return {v: 1, status: "found", proof: parseFinancialIdentityProof(r.proof)};
}
export function parseFinancialIdentityProofCurrentResult(value: unknown): FinancialIdentityProofCurrentResult {
  if (value && typeof value === "object" && "status" in value && value.status === "not-current") {
    const r = object(value, ["v", "status"]); if (r.v !== 1) invalid(); return {v: 1, status: "not-current"};
  }
  const r = object(value, ["v", "status", "proof", "observedAt"]);
  if (r.v !== 1 || r.status !== "current" || !instant(r.observedAt)) invalid();
  const proof = parseFinancialIdentityProof(r.proof);
  if (r.observedAt < proof.issuedAt || r.observedAt >= proof.expiresAt) invalid();
  return {v: 1, status: "current", proof, observedAt: r.observedAt};
}
export function projectFinancialIdentityProof(record: FinancialSourceProofRecord): FinancialIdentityProof {
  const {accessTokenHash: _hash, accessExpiresAt: _expiry, parents, ...proof} = record;
  const projected = {} as {-readonly [K in keyof typeof parents]: Omit<typeof parents[K], "scope">};
  for (const slot of ["grant", "issuerSession", "client", "accountGeneration"] as const) {
    const {scope: _scope, ...parent} = parents[slot]; projected[slot] = structuredClone(parent);
  }
  return parseFinancialIdentityProof({...structuredClone(proof), parents: projected});
}
export function parseFinancialIdentityProof(value: unknown): FinancialIdentityProof {
  const r = object(value, ["v", "proofRef", "challenge", "issuer", "subject", "clientId", "sid", "issuerSessionId", "identityGeneration", "control", "parents", "issuedAt", "expiresAt"]);
  if (r.v !== 1 || ![r.proofRef, r.subject, r.clientId, r.sid, r.issuerSessionId].every(financialSourceRef) ||
    typeof r.issuer !== "string" || r.issuer.length > 2_048 || !instant(r.identityGeneration) ||
    !instant(r.issuedAt) || !instant(r.expiresAt) || r.expiresAt <= r.issuedAt || r.expiresAt - r.issuedAt > 60_000) invalid();
  const challenge = parseFinancialIdentityChallenge(r.challenge);
  if (challenge.clientId !== r.clientId || r.issuedAt < challenge.createdAt || r.expiresAt > challenge.expiresAt) invalid();
  const control = object(r.control, ["evidenceRef", "evidenceDigest", "expiresAt", "source"]);
  if (!financialSourceRef(control.evidenceRef) || !financialSourceDigest(control.evidenceDigest) || !instant(control.expiresAt) || r.expiresAt > control.expiresAt) invalid();
  const source = object(control.source, ["registrationRef", "incarnation", "affectedRef", "sequence", "eventRef", "eventDigest", "receivers"]);
  parseFinancialSourceHeadKey({registrationRef: source.registrationRef, incarnation: source.incarnation, affectedRef: source.affectedRef});
  if (source.affectedRef !== challenge.workspaceId || !instant(source.sequence) || !financialSourceDigest(source.eventDigest) ||
    (source.sequence === 0 ? source.eventRef !== null : !financialSourceRef(source.eventRef))) invalid();
  parseFinancialSourceRegistration({registrationRef: source.registrationRef, incarnation: source.incarnation,
    genesisDigest: source.eventDigest, receivers: source.receivers});
  const parents = object(r.parents, ["grant", "issuerSession", "client", "accountGeneration"]);
  for (const parent of Object.values(parents)) {
    const p = object(parent, ["registrationRef", "incarnation", "affectedRef", "sequence", "eventRef", "eventDigest"]);
    parseFinancialSourceHeadKey({registrationRef: p.registrationRef, incarnation: p.incarnation, affectedRef: p.affectedRef});
    if (p.registrationRef !== challenge.registrationRef || !instant(p.sequence) || p.sequence < 1 || !financialSourceRef(p.eventRef) || !financialSourceDigest(p.eventDigest)) invalid();
  }
  // Enforce the existing bounded canonical JSON contract on the projection.
  canonicalFinancialSourceJson(value);
  return structuredClone(value) as FinancialIdentityProof;
}

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field) || !("value" in Object.getOwnPropertyDescriptor(value, field)!))) invalid();
  return value as Record<string, unknown>;
}
function instant(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function invalid(): never { throw new FinancialSourceAbiError("invalid-request"); }
function closedError(error: unknown): FinancialSourceAbiError {
  if (error instanceof FinancialSourceAbiError) return error;
  if (error instanceof Error && ["invalid-request", "unregistered-source", "conflict", "unavailable"].includes(error.message))
    return new FinancialSourceAbiError(error.message as FinancialSourceAbiErrorCode);
  return new FinancialSourceAbiError("unavailable");
}
