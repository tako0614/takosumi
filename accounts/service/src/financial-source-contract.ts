/**
 * Accounts-owned private financial-source wire. These records describe owned
 * facts; parsing a descriptor never qualifies its caller, target or authority.
 * Hosted consumes the versioned wire independently. Core owns its local raw
 * store DTO and must not depend on this Accounts service module.
 */
export type FinancialSourceDigest = `sha256:${string}`;

export interface FinancialSourceReceiverRegistration {
  readonly receiverRef: string;
  readonly targetRef: string;
}

export interface FinancialSourceRegistration {
  readonly registrationRef: string;
  readonly incarnation: string;
  readonly genesisDigest: FinancialSourceDigest;
  /** Complete immutable receiver set, not a page or caller-selected subset. */
  readonly receivers: readonly FinancialSourceReceiverRegistration[];
}

export interface FinancialSourceEvent {
  readonly v: 1;
  readonly eventRef: string;
  readonly registrationRef: string;
  readonly incarnation: string;
  readonly sequence: number;
  readonly previousDigest: FinancialSourceDigest;
  readonly kind: "advance" | "close";
  readonly affectedRef: string;
  readonly evidenceRef: string;
}

/** Actual SQL captures these facts without assuming a SHA function in SQL. */
export interface FinancialSourceRawEvent
  extends Omit<FinancialSourceEvent, "previousDigest"> {
  readonly previousEventRef: string | null;
}

export interface FinancialSourceMaterialization {
  /** Portable raw metadata only; the owning store also CASes its full raw payload. */
  readonly rawEventDigest: FinancialSourceDigest;
  readonly event: FinancialSourceEvent;
  readonly eventDigest: FinancialSourceDigest;
}

export interface FinancialSourceReceipt {
  readonly v: 1;
  readonly eventRef: string;
  readonly eventDigest: FinancialSourceDigest;
  readonly receiptRef: string;
  readonly incarnation: string;
  readonly sequence: number;
  readonly state: "admission-closed" | "advanced";
}

/** Local receipt custody additionally pins the actual qualified receiver. */
export interface FinancialSourceReceiptRecord {
  readonly registrationRef: string;
  readonly receiverRef: string;
  readonly targetRef: string;
  readonly receipt: FinancialSourceReceipt;
}

/** Supplied by the real Financial challenge owner, never by a browser body. */
export interface FinancialIdentityChallenge {
  readonly v: 1;
  readonly challengeRef: string;
  readonly registrationRef: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly workspaceRef: string;
  /** Financial-defined pre-Customer public-request identity, not processor fingerprint. */
  readonly requestFingerprint: FinancialSourceDigest;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export const FINANCIAL_SOURCE_MAX_PAGE = 100;
export const FINANCIAL_SOURCE_MAX_RECEIVERS = 8;
export const FINANCIAL_SOURCE_MAX_WIRE_BYTES = 16_384;

export function financialSourceRef(value: unknown): value is string {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value);
}

export function financialSourceDigest(value: unknown): value is FinancialSourceDigest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Object.keys(value).sort().join("\n") === [...fields].sort().join("\n");
}

export function parseFinancialSourceRegistration(value: unknown): FinancialSourceRegistration {
  if (!exact(value, ["registrationRef", "incarnation", "genesisDigest", "receivers"]) ||
    !financialSourceRef(value.registrationRef) || !financialSourceRef(value.incarnation) ||
    !financialSourceDigest(value.genesisDigest) || !Array.isArray(value.receivers) ||
    value.receivers.length < 1 || !denseArray(value.receivers, FINANCIAL_SOURCE_MAX_RECEIVERS)) invalid();
  const receivers: FinancialSourceReceiverRegistration[] = [];
  for (let i = 0; i < value.receivers.length; i++) {
    const receiver: unknown = value.receivers[i];
    if (!exact(receiver, ["receiverRef", "targetRef"]) ||
      !financialSourceRef(receiver.receiverRef) || !financialSourceRef(receiver.targetRef)) invalid();
    receivers.push({ receiverRef: receiver.receiverRef, targetRef: receiver.targetRef });
  }
  if (new Set(receivers.map((r) => r.receiverRef)).size !== receivers.length) invalid();
  return { registrationRef: value.registrationRef, incarnation: value.incarnation,
    genesisDigest: value.genesisDigest, receivers };
}

export function parseFinancialSourceEvent(value: unknown): FinancialSourceEvent {
  if (!exact(value, ["v", "eventRef", "registrationRef", "incarnation", "sequence",
    "previousDigest", "kind", "affectedRef", "evidenceRef"]) || value.v !== 1 ||
    !financialSourceRef(value.eventRef) || !financialSourceRef(value.registrationRef) ||
    !financialSourceRef(value.incarnation) || !positive(value.sequence) ||
    !financialSourceDigest(value.previousDigest) || (value.kind !== "advance" && value.kind !== "close") ||
    !financialSourceRef(value.affectedRef) || !financialSourceRef(value.evidenceRef)) invalid();
  return structuredClone(value) as unknown as FinancialSourceEvent;
}

export function parseFinancialSourceRawEvent(value: unknown): FinancialSourceRawEvent {
  if (!exact(value, ["v", "eventRef", "registrationRef", "incarnation", "sequence",
    "previousEventRef", "kind", "affectedRef", "evidenceRef"]) ||
    !(value.previousEventRef === null || financialSourceRef(value.previousEventRef))) invalid();
  const { previousEventRef, ...fields } = value;
  const event = parseFinancialSourceEvent({ ...fields, previousDigest: `sha256:${"0".repeat(64)}` });
  if ((event.sequence === 1) !== (previousEventRef === null)) invalid();
  const { previousDigest: _previousDigest, ...raw } = event;
  return { ...raw, previousEventRef };
}

export function parseFinancialSourceReceipt(value: unknown): FinancialSourceReceipt {
  if (!exact(value, ["v", "eventRef", "eventDigest", "receiptRef", "incarnation", "sequence", "state"]) ||
    value.v !== 1 || !financialSourceRef(value.eventRef) || !financialSourceDigest(value.eventDigest) ||
    !financialSourceRef(value.receiptRef) || !financialSourceRef(value.incarnation) || !positive(value.sequence) ||
    (value.state !== "admission-closed" && value.state !== "advanced")) invalid();
  return structuredClone(value) as unknown as FinancialSourceReceipt;
}

export function financialReceiptMatches(
  event: FinancialSourceEvent,
  eventDigest: FinancialSourceDigest,
  receipt: FinancialSourceReceipt,
): boolean {
  return receipt.eventRef === event.eventRef && receipt.eventDigest === eventDigest &&
    receipt.incarnation === event.incarnation && receipt.sequence === event.sequence &&
    receipt.state === (event.kind === "close" ? "admission-closed" : "advanced");
}

export function parseFinancialIdentityChallenge(value: unknown): FinancialIdentityChallenge {
  if (!exact(value, ["v", "challengeRef", "registrationRef", "clientId", "workspaceId", "organizationId",
    "workspaceRef", "requestFingerprint", "createdAt", "expiresAt"]) || value.v !== 1 ||
    ![value.challengeRef, value.registrationRef, value.clientId, value.workspaceId, value.organizationId,
      value.workspaceRef].every(financialSourceRef) || !financialSourceDigest(value.requestFingerprint) ||
    !instant(value.createdAt) || !instant(value.expiresAt) || value.expiresAt <= value.createdAt ||
    value.expiresAt - value.createdAt > 300_000) invalid();
  return structuredClone(value) as unknown as FinancialIdentityChallenge;
}

/** Canonical JSON for this wire only. Existing fingerprint recipes are unchanged. */
export function canonicalFinancialSourceJson(value: unknown): string {
  return canonical(value, 0, new Set());
}

function canonical(value: unknown, depth: number, seen: Set<object>): string {
  if (depth > 16) invalid();
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    // Reject lone surrogates: UTF-8 replacement must not alias two input strings.
    if (value.length > FINANCIAL_SOURCE_MAX_WIRE_BYTES ||
      new TextDecoder().decode(new TextEncoder().encode(value)) !== value) invalid();
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (typeof value === "object" && value !== null &&
    (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    if (seen.has(value) || (Array.isArray(value) ? !denseArray(value, 100) : Object.keys(value).length > 100)) invalid();
    seen.add(value);
    let result: string;
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let i = 0; i < value.length; i++) entries.push(canonical(value[i], depth + 1, seen));
      result = `[${entries.join(",")}]`;
    } else {
      result = `{${Object.keys(value).sort().map((key) =>
        `${canonical(key, depth + 1, seen)}:${canonical((value as Record<string, unknown>)[key], depth + 1, seen)}`
      ).join(",")}}`;
    }
    seen.delete(value);
    return result;
  }
  return invalid();
}

export async function hashFinancialSourceValue(domain: string, value: unknown): Promise<FinancialSourceDigest> {
  return hashCanonical({ domain, value });
}

async function hashCanonical(value: unknown): Promise<FinancialSourceDigest> {
  const bytes = new TextEncoder().encode(canonicalFinancialSourceJson(value));
  if (bytes.byteLength > FINANCIAL_SOURCE_MAX_WIRE_BYTES) invalid();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** Never fills a missing predecessor with a guessed digest or an empty string. */
export async function materializeFinancialSourceEvent(input: {
  readonly registration: FinancialSourceRegistration;
  readonly raw: FinancialSourceRawEvent;
  readonly predecessor?: FinancialSourceMaterialization;
}): Promise<FinancialSourceMaterialization> {
  const registration = parseFinancialSourceRegistration(input.registration);
  const raw = parseFinancialSourceRawEvent(input.raw);
  if (raw.registrationRef !== registration.registrationRef || raw.incarnation !== registration.incarnation) invalid();
  let previousDigest = registration.genesisDigest;
  if (raw.sequence > 1) {
    const prior = input.predecessor;
    if (!prior || prior.event.eventRef !== raw.previousEventRef || prior.event.sequence !== raw.sequence - 1 ||
      prior.event.registrationRef !== raw.registrationRef || prior.event.incarnation !== raw.incarnation ||
      prior.event.affectedRef !== raw.affectedRef || prior.event.kind === "close" ||
      await financialSourceEventDigest(prior.event) !== prior.eventDigest) invalid();
    previousDigest = prior.eventDigest;
  } else if (input.predecessor !== undefined) invalid();
  const { previousEventRef: _previousEventRef, ...fields } = raw;
  const event = parseFinancialSourceEvent({ ...fields, previousDigest });
  return { rawEventDigest: await hashFinancialSourceValue("takosumi.financial-source-raw@v1", raw),
    event, eventDigest: await financialSourceEventDigest(event) };
}

export function financialSourceEventDigest(event: FinancialSourceEvent): Promise<FinancialSourceDigest> {
  return hashCanonical({ domain: "takosumi.financial-source-event@v1", event: parseFinancialSourceEvent(event) });
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function instant(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function denseArray(value: readonly unknown[], maximum: number): boolean {
  // Check length before enumerating or iterating. Every slot must be an own
  // data property; named/symbol properties and inherited holes are not wire.
  if (value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor)) return false;
  }
  return true;
}

function invalid(): never {
  throw new TypeError("invalid_financial_source_record");
}
