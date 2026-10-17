/** Private Accounts producer. No HTTP route, payer grant or deployment readiness
 * is created here. The owning composition supplies the actual challenge owner,
 * Control facade and receiver capabilities; absent capabilities fail closed. */
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { AccountsStore, TokenRecord } from "./store.ts";
import type { OidcClientRegistration } from "./mod.ts";
import type {
  FinancialSourceProtectedMutation, FinancialSourcePrecommitCheckpoint,
  FinancialSourceAuthoritySnapshot, FinancialSourceParentScope,
  FinancialSourceParentVector, FinancialSourceParentHead,
  FinancialSourceParentReference, FinancialSourceProofRecord,
  FinancialSourceMaterializationRecord, FinancialSourceRawRecord,
  FinancialSourceControlEvidence,
} from "./identity-state.ts";
import {
  canonicalFinancialSourceJson, financialSourceRef, financialSourceDigest,
  financialSourceEventDigest, hashFinancialSourceValue, parseFinancialSourceEvent,
  materializeFinancialSourceEvent, parseFinancialIdentityChallenge,
  parseFinancialSourceRegistration, parseFinancialSourceReceipt,
  financialReceiptMatches, FINANCIAL_SOURCE_MAX_PAGE,
  type FinancialSourceRegistration, type FinancialSourceDigest,
  type FinancialSourceMaterialization, type FinancialSourceReceipt, type FinancialSourceEvent,
} from "./financial-source-contract.ts";
import { hostedGrantIsActive, hostedOpaqueId } from "./hosted-oidc-profile.ts";
import { sha256Text } from "./encoding.ts";
import {
  parseFinancialIdentityProofRequest, projectFinancialIdentityProof,
  makeFinancialSourceReceipt,
  FinancialSourceAbiError, parseFinancialSourceRegisteredHead,
  parseFinancialSourceEventEvidenceRequest, projectFinancialSourceEventEvidence,
  type FinancialSourceRegisteredHeadReader, type FinancialSourceKeyCustody, type FinancialSourceClock,
  type FinancialSourceEventEvidenceRequest, type FinancialSourceEventEvidenceLoadResult,
  type FinancialIdentityProofRequest, type FinancialIdentityProofLoadResult,
  type FinancialIdentityProofCurrentResult,
} from "./financial-source-abi.ts";
import type {
  WorkspaceFinancialSourceService, WorkspaceFinancialSourceSnapshot,
  WorkspaceFinancialSourceHead, WorkspaceFinancialRawEvent,
  WorkspaceFinancialMaterialization,
  WorkspaceFinancialEnrollmentOriginal,
} from "../../../core/domains/workspaces/financial-source.ts";

const checkpointLifetime = 1_000;
const proofLifetime = 60_000;
const controlHistoricalPageLimit = 64;
const slots = ["grant", "issuerSession", "client", "accountGeneration"] as const;
type MutableVector<T> = { -readonly [K in keyof FinancialSourceParentVector<T>]: T };
type MaterializationBudget = {remaining: number};
interface CheckpointState {
  readonly binding: string;
  readonly readTime: () => number;
  readonly createdAt: number;
  readonly expiresAt: number;
}
const checkpoints = new WeakMap<object, CheckpointState>();

function mutationBinding(input: FinancialSourceProtectedMutation): string {
  const { accessToken: _secret, precommitCheckpoint: _checkpoint, ...bound } = input;
  // Optional storage fields absent on the actual row stay absent in the binding.
  // Neither this projection nor a copied checkpoint conveys provenance.
  return canonicalFinancialSourceJson(JSON.parse(JSON.stringify(bound)));
}

/** Internal LOCAL precommit boundary only. Repositories call after all awaited
 * preparation, then validate current durable rows and write without an await.
 * This is not a remote execution-time or cross-database transaction guarantee. */
export function consumeFinancialSourcePrecommitCheckpoint(input: FinancialSourceProtectedMutation): number | undefined {
  const state = checkpoints.get(input.precommitCheckpoint);
  if (!state) return undefined;
  checkpoints.delete(input.precommitCheckpoint);
  const now = state.readTime();
  const deadlines = [state.expiresAt, input.challenge.expiresAt,
    input.expectedAccess.expiresAt, input.expectedGrant.absoluteExpiresAt, input.control.expiresAt,
    ...("proof" in input ? [input.proof.expiresAt] : [])];
  if (!Number.isSafeInteger(now) || now < state.createdAt || now >= state.expiresAt ||
    !Number.isSafeInteger(input.now) || deadlines.some((deadline) => !Number.isSafeInteger(deadline) || deadline <= now) ||
    input.now > now || input.challenge.createdAt > now || input.challenge.expiresAt <= now ||
    input.expectedAccess.expiresAt <= now || input.expectedGrant.absoluteExpiresAt <= now ||
    input.control.expiresAt <= now || "proof" in input && input.proof.expiresAt <= now) return undefined;
  try { return mutationBinding(input) === state.binding ? now : undefined; } catch { return undefined; }
}

export interface AccountsFinancialControlSnapshot {
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly workspaceRef: string;
  readonly accountId: TakosumiSubject;
  readonly evidence: FinancialSourceControlEvidence;
}

/** Implemented by the Accounts adapter ABOVE the actual canonical Control
 * facade. No caller body may construct a snapshot or choose the account. */
export interface AccountsFinancialControl {
  capture(input: { readonly workspaceId: string; readonly accountId: TakosumiSubject }): Promise<AccountsFinancialControlSnapshot | undefined>;
  assertCurrent(snapshot: AccountsFinancialControlSnapshot): Promise<boolean>;
}

/** Private composition data. These descriptors/receipts do not qualify their
 * caller, the selected source or its actual primary/realm/epoch. */
export interface AccountsFinancialGenesisSource {
  readonly registration: FinancialSourceRegistration;
  readonly registrationDigest: FinancialSourceDigest;
  readonly qualificationRef: string;
  readonly sourceSchemaDigest: FinancialSourceDigest;
  readonly sourceCredentialRef: string;
  readonly clockPolicyRef: string;
  readonly originRef: string;
}
export interface AccountsFinancialGenesisPeer {
  readonly receiverRef: string;
  readonly targetRef: string;
  readonly source: AccountsFinancialGenesisSource;
  readonly affectedRef: string;
  readonly genesisQualificationRef: string;
}
export interface AccountsFinancialGenesisCommand {
  readonly admissionRef: string;
  readonly commandRef: string;
  readonly receiptRef: string;
  readonly enrollmentOriginal: WorkspaceFinancialEnrollmentOriginal;
}
export interface AccountsFinancialGenesisReceipt {
  readonly admissionRef: string;
  readonly commandRef: string;
  readonly receiptRef: string;
}
export type AccountsFinancialGenesisPeerRead = Readonly<{
  receiverRef: string;
  targetRef: string;
  command: AccountsFinancialGenesisCommand;
} & (
  | {status: "found"; receipt: AccountsFinancialGenesisReceipt}
  | {status: "absent"}
)>;
export interface AccountsFinancialGenesisCoveragePort {
  readonly peers: readonly AccountsFinancialGenesisPeer[];
  /** The qualified Root bridge selects retained commands before dispatch,
   * reads ONLY those G originals and checks its actual current admission.
   * Unknown/conflict reject; only proven exact-command absence is absent.
   * This is not a remote atomic check or Financial's final local CAS. */
  readCurrentOriginals(input: Readonly<{
    coreSnapshot: WorkspaceFinancialSourceSnapshot;
    coreOriginal: WorkspaceFinancialEnrollmentOriginal;
  }>): Promise<readonly AccountsFinancialGenesisPeerRead[]>;
}

interface AccountsFinancialGenesisBundle {
  readonly family: "G";
  readonly core: WorkspaceFinancialSourceSnapshot;
  readonly coreOriginal: WorkspaceFinancialEnrollmentOriginal;
  readonly peers: readonly {
    readonly configured: AccountsFinancialGenesisPeer;
    readonly command: AccountsFinancialGenesisCommand;
    readonly receipt: AccountsFinancialGenesisReceipt;
  }[];
}

/** Detached original data only. The caller must separately qualify the fixed
 * Financial source, peer, key, realm and command on its own primary. */
export interface AccountsFinancialPreparedOriginal {
  readonly key: {readonly registrationRef: string; readonly incarnation: string; readonly affectedRef: string};
  readonly eventRef: string;
  readonly materialization: FinancialSourceMaterialization;
}

export interface AccountsFinancialPreparedSource {
  readonly kind: "fresh";
  readonly registration: FinancialSourceRegistration;
  readonly parents: FinancialSourceParentVector<AccountsFinancialPreparedOriginal>;
  /** A current Control pointer, not a Control event or install authority. */
  readonly controlSource: FinancialSourceControlEvidence["source"];
}

export interface AccountsFinancialPendingOriginalPage {
  readonly kind: "historical";
  readonly registration: FinancialSourceRegistration;
  readonly entries: readonly {readonly original: AccountsFinancialPreparedOriginal}[];
  readonly nextCursor?: string;
}

export interface AccountsFinancialReceiver {
  readonly receiverRef: string;
  readonly targetRef: string;
  read(materialization: FinancialSourceMaterialization): Promise<FinancialSourceReceipt | undefined>;
  deliver(materialization: FinancialSourceMaterialization): Promise<FinancialSourceReceipt>;
}

export interface AccountsFinancialSourceOptions {
  readonly store: AccountsStore;
  readonly issuer: string;
  readonly clients: readonly OidcClientRegistration[];
  readonly registration: FinancialSourceRegistration;
  readonly challenges?: { read(challengeRef: string): Promise<unknown> };
  readonly control?: AccountsFinancialControl;
  readonly receivers?: readonly AccountsFinancialReceiver[];
  readonly eventEvidence?: AccountsFinancialEventEvidenceOptions;
  /** Trusted in-process clock injection, never request or wire timestamps. */
  readonly now?: () => number;
}

/** Actual qualified private composition supplies these capabilities. Refs are
 * fixed custody identifiers, never body-selected values or key material. */
export interface AccountsFinancialEventEvidenceOptions {
  readonly sourceCredentialRef: string;
  readonly sourceSchemaRef: string;
  readonly receiverRef: string;
  readonly targetRef: string;
  readonly receiverSchemaRef: string;
  readonly registeredHeads?: FinancialSourceRegisteredHeadReader;
  readonly keyCustody?: FinancialSourceKeyCustody;
  readonly clock?: FinancialSourceClock;
}

export class FinancialSourceUnavailable extends Error {
  constructor(readonly code: "source_unavailable" | "invalid_grant" | "invalid_challenge" | "source_pending" | "source_conflict") { super(code); }
}

function genesisConflict(): never { throw new FinancialSourceUnavailable("source_conflict"); }

function genesisRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).length !== keys.length) return genesisConflict();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !("value" in field)) return genesisConflict();
    result[key] = field.value;
  }
  return result;
}

function genesisArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 ||
    Reflect.ownKeys(value).length !== value.length + 1) return genesisConflict();
  return Array.from({length: value.length}, (_, index) => {
    const slot = Object.getOwnPropertyDescriptor(value, String(index));
    return slot && "value" in slot ? slot.value : genesisConflict();
  });
}

function genesisRef(value: unknown): string { return financialSourceRef(value) ? value : genesisConflict(); }
function genesisDigest(value: unknown): FinancialSourceDigest { return financialSourceDigest(value) ? value : genesisConflict(); }
function genesisFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) genesisFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function genesisRegistration(value: unknown): FinancialSourceRegistration {
  const row = genesisRecord(value, ["registrationRef", "incarnation", "genesisDigest", "receivers"]);
  const receivers = genesisArray(row.receivers).map((value) => {
    const peer = genesisRecord(value, ["receiverRef", "targetRef"]);
    return {receiverRef: genesisRef(peer.receiverRef), targetRef: genesisRef(peer.targetRef)};
  });
  if (new Set(receivers.map((peer) => peer.receiverRef)).size !== receivers.length) return genesisConflict();
  return {registrationRef: genesisRef(row.registrationRef), incarnation: genesisRef(row.incarnation),
    genesisDigest: genesisDigest(row.genesisDigest), receivers};
}

function genesisPeer(value: unknown): AccountsFinancialGenesisPeer {
  const peer = genesisRecord(value, ["receiverRef", "targetRef", "source", "affectedRef", "genesisQualificationRef"]);
  const source = genesisRecord(peer.source, ["registration", "registrationDigest", "qualificationRef", "sourceSchemaDigest",
    "sourceCredentialRef", "clockPolicyRef", "originRef"]);
  return {receiverRef: genesisRef(peer.receiverRef), targetRef: genesisRef(peer.targetRef),
    affectedRef: genesisRef(peer.affectedRef), genesisQualificationRef: genesisRef(peer.genesisQualificationRef),
    source: {registration: genesisRegistration(source.registration), registrationDigest: genesisDigest(source.registrationDigest),
      qualificationRef: genesisRef(source.qualificationRef), sourceSchemaDigest: genesisDigest(source.sourceSchemaDigest),
      sourceCredentialRef: genesisRef(source.sourceCredentialRef), clockPolicyRef: genesisRef(source.clockPolicyRef), originRef: genesisRef(source.originRef)}};
}

function genesisOriginal(value: unknown): WorkspaceFinancialEnrollmentOriginal {
  const row = genesisRecord(value, ["workspaceId", "sourceRef", "incarnation", "registrationJson", "enrollmentJson", "identityJson", "enrolledAt"]);
  const json = (value: unknown, maximum: number): string => {
    if (typeof value !== "string" || new TextEncoder().encode(value).length > maximum) return genesisConflict();
    try { if (JSON.stringify(JSON.parse(value)) !== value) return genesisConflict(); }
    catch { return genesisConflict(); }
    return value;
  };
  if (typeof row.enrolledAt !== "string" || row.enrolledAt.length > 35 || !row.enrolledAt.endsWith("Z")) return genesisConflict();
  try { if (new Date(row.enrolledAt).toISOString() !== row.enrolledAt) return genesisConflict(); }
  catch { return genesisConflict(); }
  return {workspaceId: genesisRef(row.workspaceId), sourceRef: genesisRef(row.sourceRef), incarnation: genesisRef(row.incarnation),
    registrationJson: json(row.registrationJson, 16_384), enrollmentJson: json(row.enrollmentJson, 262_144),
    identityJson: json(row.identityJson, 262_144), enrolledAt: row.enrolledAt};
}

function genesisCommand(value: unknown): AccountsFinancialGenesisCommand {
  const row = genesisRecord(value, ["admissionRef", "commandRef", "receiptRef", "enrollmentOriginal"]);
  return {admissionRef: genesisRef(row.admissionRef), commandRef: genesisRef(row.commandRef),
    receiptRef: genesisRef(row.receiptRef), enrollmentOriginal: genesisOriginal(row.enrollmentOriginal)};
}

function genesisReceipt(value: unknown): AccountsFinancialGenesisReceipt {
  const row = genesisRecord(value, ["admissionRef", "commandRef", "receiptRef"]);
  return {admissionRef: genesisRef(row.admissionRef), commandRef: genesisRef(row.commandRef), receiptRef: genesisRef(row.receiptRef)};
}

function sameGenesisOriginal(left: WorkspaceFinancialEnrollmentOriginal, right: WorkspaceFinancialEnrollmentOriginal): boolean {
  return left.workspaceId === right.workspaceId && left.sourceRef === right.sourceRef && left.incarnation === right.incarnation &&
    left.registrationJson === right.registrationJson && left.enrollmentJson === right.enrollmentJson &&
    left.identityJson === right.identityJson && left.enrolledAt === right.enrolledAt;
}

/** Commit exact retained UTF-8 bytes without using the public wire codec's
 * 16KiB string limit. This does not replace any original passed to Root/G. */
async function genesisTextCommitment(domain: string, text: string, maximumBytes: number): Promise<FinancialSourceDigest> {
  const bytes = new Uint8Array(new TextEncoder().encode(text));
  if (bytes.byteLength > maximumBytes || new TextDecoder().decode(bytes) !== text) return genesisConflict();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256: FinancialSourceDigest = `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
  return hashFinancialSourceValue(domain, {utf8Bytes: bytes.byteLength, sha256});
}

async function genesisEvidenceDigest(bundle: AccountsFinancialGenesisBundle): Promise<FinancialSourceDigest> {
  const original = bundle.coreOriginal;
  const coreOriginal = await hashFinancialSourceValue("takosumi.accounts.control-genesis-original@v1", {
    workspaceId: original.workspaceId, sourceRef: original.sourceRef, incarnation: original.incarnation, enrolledAt: original.enrolledAt,
    registrationJson: await genesisTextCommitment("takosumi.accounts.control-genesis-registration-json@v1", original.registrationJson, 16_384),
    enrollmentJson: await genesisTextCommitment("takosumi.accounts.control-genesis-enrollment-json@v1", original.enrollmentJson, 262_144),
    identityJson: await genesisTextCommitment("takosumi.accounts.control-genesis-identity-json@v1", original.identityJson, 262_144),
  });
  const peers: FinancialSourceDigest[] = [];
  for (const peer of bundle.peers) peers.push(await hashFinancialSourceValue("takosumi.accounts.control-genesis-peer@v1", {
    configured: peer.configured, command: {admissionRef: peer.command.admissionRef, commandRef: peer.command.commandRef,
      receiptRef: peer.command.receiptRef, enrollmentOriginal: coreOriginal}, receipt: peer.receipt,
  }));
  // The existing snapshot/wire limits remain unchanged. Only the larger
  // retained JSON strings and repeated peer originals use small commitments.
  const core = await hashFinancialSourceValue("takosumi.financial-source-control-evidence@v1", bundle.core);
  return hashFinancialSourceValue("takosumi.accounts.control-genesis-coverage-evidence@v1", {family: "G", core, coreOriginal, peers});
}

function captureEventEvidenceAuthority(options: AccountsFinancialEventEvidenceOptions | undefined) {
  const sourceCredentialRef = options?.sourceCredentialRef, sourceSchemaRef = options?.sourceSchemaRef;
  const receiverRef = options?.receiverRef, targetRef = options?.targetRef, receiverSchemaRef = options?.receiverSchemaRef;
  const heads = options?.registeredHeads, readHead = heads?.readRegisteredHead;
  const custody = options?.keyCustody, readCredential = custody?.readCredentialContext;
  const clock = options?.clock, readClock = clock?.nowMilliseconds, clockPolicyRef = clock?.policyRef;
  let previousTime = -1;
  const unavailable = (): never => { throw new FinancialSourceAbiError("unavailable"); };
  const now = () => {
    if (!clock || !readClock || !financialSourceRef(clockPolicyRef)) return unavailable();
    const value = Reflect.apply(readClock, clock, []);
    if (!Number.isSafeInteger(value) || value < 0 || value < previousTime) return unavailable();
    previousTime = value;
    return value;
  };
  const authorize = async () => {
    if (!heads || !readHead || !custody || !readCredential ||
      ![sourceCredentialRef, sourceSchemaRef, receiverRef, targetRef, receiverSchemaRef].every(financialSourceRef)) return unavailable();
    now();
    const context = await Reflect.apply(readCredential, custody, [{credentialRef: sourceCredentialRef!, receiverRef: receiverRef!,
      targetRef: targetRef!, receiverSchemaRef: receiverSchemaRef!, purpose: "event-evidence-read"}]);
    if (!context || Reflect.ownKeys(context).length !== 9 || context.credentialRef !== sourceCredentialRef ||
      !financialSourceRef(context.incarnationRef) || context.sourceSchemaRef !== sourceSchemaRef ||
      context.receiverRef !== receiverRef || context.targetRef !== targetRef || context.receiverSchemaRef !== receiverSchemaRef ||
      context.clockPolicyRef !== clockPolicyRef || context.purpose !== "event-evidence-read" ||
      !Number.isSafeInteger(context.validUntil) || context.validUntil <= now()) return unavailable();
    return context.validUntil;
  };
  return {
    authorize,
    now,
    async head(event: FinancialSourceEvent) {
      if (!heads || !readHead) return unavailable();
      const key = {registrationRef: event.registrationRef, incarnation: event.incarnation, affectedRef: event.affectedRef};
      const value = await Reflect.apply(readHead, heads, [{v: 1, head: key}]);
      if (value === undefined) throw new FinancialSourceAbiError("unregistered-source");
      const result = parseFinancialSourceRegisteredHead(value);
      if (canonicalFinancialSourceJson(result.head) !== canonicalFinancialSourceJson(key) ||
        result.sourceCredentialRef !== sourceCredentialRef || result.sourceSchemaRef !== sourceSchemaRef || result.clockPolicyRef !== clockPolicyRef ||
        !result.receivers.some((r) => r.receiverRef === receiverRef && r.targetRef === targetRef) ||
        event.sequence === 1 && event.previousDigest !== result.genesisDigest) throw new FinancialSourceAbiError("unregistered-source");
      return result;
    },
  };
}

/** All callbacks and configuration are captured before any request await.
 * Reflect.apply is local: no .bind property lookup on Worker RPC callables. */
export function createAccountsFinancialSource(options: AccountsFinancialSourceOptions) {
  const store = options.store;
  const issuer = options.issuer;
  const registration = parseFinancialSourceRegistration(structuredClone(options.registration));
  const eventEvidence = captureEventEvidenceAuthority(options.eventEvidence);
  const clients = new Map(options.clients.map((client) => [client.clientId, structuredClone(client)]));
  const rawClock = options.now ?? anchoredClock();
  let lastNow = -1;
  const now = () => {
    const value = rawClock();
    if (!Number.isSafeInteger(value) || value < 0 || value < lastNow) unavailable();
    lastNow = value;
    return value;
  };
  const challengeOwner = options.challenges;
  const readChallenge = challengeOwner?.read;
  const control = options.control;
  const capture = control?.capture;
  const assertCurrent = control?.assertCurrent;
  const receivers = new Map<string, {targetRef: string; read: AccountsFinancialReceiver["read"]; deliver: AccountsFinancialReceiver["deliver"]; receiver: AccountsFinancialReceiver}>();
  for (const receiver of options.receivers ?? []) {
    if (receivers.has(receiver.receiverRef)) unavailable();
    receivers.set(receiver.receiverRef, { targetRef: receiver.targetRef, read: receiver.read, deliver: receiver.deliver, receiver });
  }
  function preparationCapabilities() {
    if (!challengeOwner || !readChallenge || !control || !capture || !assertCurrent ||
      !store.enrollFinancialSourceParents || !store.findFinancialSourceParent || !store.findFinancialSourceRegistration ||
      !store.findFinancialSourceRaw || !store.findFinancialSourceMaterialization || !store.commitFinancialSourceMaterialization ||
      !store.findHostedOidcGrant || !store.getAccountAuthenticationGeneration || !store.findCanonicalAccount ||
      !store.isAccountAuthenticationFenced || !store.isHostedOidcSessionRevoked || !store.isHostedOidcClientRevoked) unavailable();
  }
  function capabilities() {
    if (!challengeOwner || !readChallenge || !control || !capture || !assertCurrent ||
      !store.enrollFinancialSourceParents || !store.issueFinancialSourceProof || !store.findFinancialSourceProofsForOriginalRequest ||
      !store.findFinancialSourceParent || !store.findFinancialSourceRegistration ||
      !store.findFinancialSourceRaw || !store.findFinancialSourceMaterialization ||
      !store.commitFinancialSourceMaterialization || !store.findFinancialSourceReceipt ||
      !store.recordFinancialSourceReceipt || !store.listFinancialSourcePending ||
      !store.findHostedOidcGrant || !store.getAccountAuthenticationGeneration ||
      !store.findCanonicalAccount || !store.isAccountAuthenticationFenced ||
      !store.isHostedOidcSessionRevoked || !store.isHostedOidcClientRevoked ||
      receivers.size !== registration.receivers.length || registration.receivers.some((r) => receivers.get(r.receiverRef)?.targetRef !== r.targetRef)) unavailable();
  }
  async function current(accessToken: string): Promise<{record: TokenRecord; client: OidcClientRegistration}> {
    if (typeof accessToken !== "string" || accessToken.length < 1 || accessToken.length > 4_096) invalidGrant();
    const record = await store.findAccessToken(accessToken);
    const client = record && clients.get(record.clientId);
    if (!record || !client || record.expiresAt <= now() || record.oidcProfile !== "shared-account" ||
      record.interfaceId || record.interfaceBindingId || record.interfaceResolvedRevision !== undefined ||
      !(await hostedGrantIsActive({store, record, client, issuer, now: now()}))) invalidGrant();
    return { record: structuredClone(record), client };
  }
  async function checkpoint<T extends FinancialSourceProtectedMutation>(input: Omit<T, "precommitCheckpoint">): Promise<T> {
    // Perform a final real grant and Control read BEFORE minting the opaque
    // checkpoint; the actual repository repeats durable predicates at commit.
    const time = now();
    const checkpoint = Object.freeze({}) as FinancialSourcePrecommitCheckpoint;
    const mutation = {...input, precommitCheckpoint: checkpoint} as T;
    const expiresAt = Math.min(time + checkpointLifetime, input.challenge.expiresAt,
      input.expectedAccess.expiresAt, input.expectedGrant.absoluteExpiresAt, input.control.expiresAt,
      "proof" in mutation ? mutation.proof.expiresAt : Number.MAX_SAFE_INTEGER);
    checkpoints.set(checkpoint, {binding: mutationBinding(mutation), readTime: now, createdAt: time, expiresAt});
    return mutation;
  }
  async function materialize(eventRef: string, budget = {remaining: FINANCIAL_SOURCE_MAX_PAGE}): Promise<FinancialSourceMaterializationRecord> {
    const existing = await store.findFinancialSourceMaterialization!(eventRef);
    if (existing) return existing;
    if (budget.remaining < 1) throw new FinancialSourceUnavailable("source_pending");
    budget.remaining--;
    const raw = await store.findFinancialSourceRaw!(eventRef);
    if (!raw || raw.raw.registrationRef !== registration.registrationRef || raw.raw.incarnation !== registration.incarnation) unavailable();
    const predecessor = raw.raw.previousEventRef ? await materialize(raw.raw.previousEventRef, budget) : undefined;
    const result = await materializeFinancialSourceEvent({registration, raw: raw.raw, predecessor: predecessor?.materialization});
    if (!(await store.commitFinancialSourceMaterialization!({expectedRaw: raw, expectedPredecessor: predecessor, materialization: result}))) throw new FinancialSourceUnavailable("source_conflict");
    const saved = await store.findFinancialSourceMaterialization!(eventRef);
    if (!saved || canonicalFinancialSourceJson(saved) !== canonicalFinancialSourceJson({rawRecord: raw, materialization: result})) throw new FinancialSourceUnavailable("source_conflict");
    return saved;
  }
  /** Export path always validates the full persisted first original, even if
   * a Memory reader returns an existing materialization without validation. */
  async function materializeOriginal(eventRef: string, budget: MaterializationBudget): Promise<FinancialSourceMaterializationRecord> {
    if (budget.remaining < 1) throw new FinancialSourceUnavailable("source_pending");
    budget.remaining--;
    const raw = await store.findFinancialSourceRaw!(eventRef);
    if (!raw || raw.raw.eventRef !== eventRef || raw.raw.registrationRef !== registration.registrationRef ||
      raw.raw.incarnation !== registration.incarnation) throw new FinancialSourceUnavailable("source_conflict");
    if (raw.raw.sequence !== 1 || raw.raw.previousEventRef !== null) throw new FinancialSourceUnavailable("source_pending");
    let result: FinancialSourceMaterialization;
    try { result = await materializeFinancialSourceEvent({registration, raw: raw.raw}); }
    catch { throw new FinancialSourceUnavailable("source_conflict"); }
    const existing = await store.findFinancialSourceMaterialization!(eventRef);
    if (existing && canonicalFinancialSourceJson(existing) !== canonicalFinancialSourceJson({rawRecord: raw, materialization: result}))
      throw new FinancialSourceUnavailable("source_conflict");
    if (!existing && !(await store.commitFinancialSourceMaterialization!({expectedRaw: raw, materialization: result})))
      throw new FinancialSourceUnavailable("source_conflict");
    const saved = await store.findFinancialSourceMaterialization!(eventRef);
    if (!saved || canonicalFinancialSourceJson(saved) !== canonicalFinancialSourceJson({rawRecord: raw, materialization: result})) throw new FinancialSourceUnavailable("source_conflict");
    return saved;
  }
  async function registered(): Promise<void> {
    const observed = await store.findFinancialSourceRegistration!(registration.registrationRef);
    if (!observed || canonicalFinancialSourceJson(observed) !== canonicalFinancialSourceJson(registration)) unavailable();
  }
  async function freshChallenge(challengeRef: string) {
    if (!financialSourceRef(challengeRef)) throw new FinancialSourceUnavailable("invalid_challenge");
    const challenge = parseFinancialIdentityChallenge(await Reflect.apply(readChallenge!, challengeOwner, [challengeRef]));
    if (challenge.challengeRef !== challengeRef || challenge.registrationRef !== registration.registrationRef ||
      challenge.createdAt > now() || challenge.expiresAt <= now()) throw new FinancialSourceUnavailable("invalid_challenge");
    return challenge;
  }
  async function enrollOriginalParents(input: {
    accessToken: string;
    challenge: Awaited<ReturnType<typeof freshChallenge>>;
    original: Awaited<ReturnType<typeof current>>;
    accessTokenHash: string;
  }) {
    const {accessToken, challenge, original, accessTokenHash} = input;
    const subject = original.record.takosumiSubject!;
    const snapshot = await Reflect.apply(capture!, control, [{workspaceId: challenge.workspaceId, accountId: subject}]);
    if (!snapshot || snapshot.accountId !== subject || snapshot.workspaceId !== challenge.workspaceId ||
      snapshot.organizationId !== challenge.organizationId || snapshot.workspaceRef !== challenge.workspaceRef ||
      snapshot.evidence.expiresAt <= now()) unavailable();
    const scope: FinancialSourceParentVector<FinancialSourceParentScope> = {
      grant: {kind: "grant", sid: original.record.sid!}, issuerSession: {kind: "issuer-session", issuerSessionId: original.record.issuerSessionId!},
      client: {kind: "client", clientId: original.record.clientId}, accountGeneration: {kind: "account-generation", subject, identityGeneration: original.record.identityGeneration ?? 0},
    };
    const parents = {} as MutableVector<{scope: FinancialSourceParentScope; expected?: FinancialSourceParentHead; affectedRef: string; eventRef: string}>;
    for (const slot of slots) {
      const expected = await store.findFinancialSourceParent!(scope[slot]);
      parents[slot] = {scope: scope[slot], expected, affectedRef: expected?.affectedRef ?? hostedOpaqueId("afs_"), eventRef: hostedOpaqueId("afe_")};
    }
    const verify = async (): Promise<Omit<FinancialSourceAuthoritySnapshot, "precommitCheckpoint">> => {
      const challengeNow = await freshChallenge(challenge.challengeRef);
      if (canonicalFinancialSourceJson(challengeNow) !== canonicalFinancialSourceJson(challenge))
        throw new FinancialSourceUnavailable("invalid_challenge");
      const record = (await current(accessToken)).record;
      // Storage readers legitimately project absent optional columns as own
      // undefined properties. Normalize this storage representation only.
      if (canonicalFinancialSourceJson(JSON.parse(JSON.stringify(record))) !==
        canonicalFinancialSourceJson(JSON.parse(JSON.stringify(original.record)))) invalidGrant();
      const grant = await store.findHostedOidcGrant!(record.sid!);
      const generation = await store.getAccountAuthenticationGeneration!(subject);
      if (!grant || generation !== (record.identityGeneration ?? 0)) invalidGrant();
      if (!(await Reflect.apply(assertCurrent!, control, [snapshot])) || snapshot.evidence.expiresAt <= now()) unavailable();
      return {registration, challenge, accessToken, accessTokenHash, expectedAccess: record,
        expectedGrant: structuredClone(grant), expectedIdentityGeneration: generation,
        control: structuredClone(snapshot.evidence), now: now()};
    };
    const enrollment = await checkpoint<import("./identity-state.ts").FinancialSourceEnrollmentMutation>({...await verify(), evidenceRef: challenge.challengeRef, parents});
    const heads = await store.enrollFinancialSourceParents!(enrollment);
    if (!heads) throw new FinancialSourceUnavailable("source_conflict");
    return {heads, scope, snapshot, verify};
  }
  async function preparedOriginal(eventRef: string, budget: MaterializationBudget): Promise<AccountsFinancialPreparedOriginal> {
    const saved = await materializeOriginal(eventRef, budget);
    const record: FinancialSourceRawRecord = saved.rawRecord;
    const raw = record.raw, event = saved.materialization.event, cause = record.cause;
    const exactKeys = (value: object, keys: readonly string[]) =>
      Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    if (!exactKeys(record, ["raw", "parent", "parentRevision", "cause", "capturedAt"]) ||
      !Number.isSafeInteger(record.capturedAt) || record.capturedAt < 0 || record.parentRevision !== 0 ||
      cause.kind !== "enrollment" || !exactKeys(cause, ["kind", "challengeRef", "accessTokenHash", "sid", "identityGeneration"]) ||
      !financialSourceRef(cause.challengeRef) || !financialSourceRef(cause.sid) ||
      !/^sha256:[A-Za-z0-9_-]{43}$/u.test(cause.accessTokenHash) ||
      !Number.isSafeInteger(cause.identityGeneration) || cause.identityGeneration < 0 ||
      record.parent.kind === "grant" && record.parent.sid !== cause.sid ||
      record.parent.kind === "account-generation" && record.parent.identityGeneration !== cause.identityGeneration)
      throw new FinancialSourceUnavailable("source_conflict");
    if (raw.eventRef !== eventRef || raw.sequence !== 1 || raw.previousEventRef !== null || event.eventRef !== eventRef ||
      event.sequence !== 1 || event.previousDigest !== registration.genesisDigest || event.kind === "close" ||
      event.affectedRef !== raw.affectedRef || event.registrationRef !== registration.registrationRef ||
      event.incarnation !== registration.incarnation) throw new FinancialSourceUnavailable("source_pending");
    return structuredClone({key: {registrationRef: event.registrationRef, incarnation: event.incarnation,
      affectedRef: event.affectedRef}, eventRef, materialization: saved.materialization});
  }
  async function acknowledged(head: FinancialSourceParentHead, budget: {remaining: number}): Promise<FinancialSourceParentReference> {
    if (head.state !== "open" || head.registrationRef !== registration.registrationRef || head.incarnation !== registration.incarnation) unavailable();
    const saved = await materialize(head.lastEventRef, budget);
    const event = saved.materialization.event;
    if (event.eventRef !== head.lastEventRef || event.affectedRef !== head.affectedRef || event.sequence !== head.sequence ||
      event.registrationRef !== head.registrationRef || event.incarnation !== head.incarnation || event.kind === "close") unavailable();
    for (const receiver of registration.receivers) {
      const row = await store.findFinancialSourceReceipt!({registrationRef: registration.registrationRef, eventRef: head.lastEventRef, receiverRef: receiver.receiverRef});
      if (!row || row.targetRef !== receiver.targetRef || !financialReceiptMatches(saved.materialization.event, saved.materialization.eventDigest, row.receipt)) throw new FinancialSourceUnavailable("source_pending");
    }
    return {scope: structuredClone(head.scope), registrationRef: head.registrationRef, incarnation: head.incarnation,
      affectedRef: head.affectedRef, sequence: head.sequence, eventRef: head.lastEventRef, eventDigest: saved.materialization.eventDigest};
  }
  async function verifyCurrentProof(value: FinancialIdentityProofRequest, expectedOriginal?: FinancialSourceProofRecord): Promise<FinancialIdentityProofCurrentResult> {
    const request = parseFinancialIdentityProofRequest(value);
    // Detach the FULL private original before the first await. Public proof
    // projections intentionally omit token hash and private expiry custody.
    const expected = expectedOriginal === undefined ? undefined : canonicalFinancialSourceJson(structuredClone(expectedOriginal));
    capabilities();
    if (!store.findFinancialSourceProof || !store.findAccessTokenByHash) unavailable();
    const proof = await store.findFinancialSourceProof(request.proofRef);
    const notCurrent = {v: 1, status: "not-current"} as const;
    if (expected !== undefined && (!proof || canonicalFinancialSourceJson(proof) !== expected)) return notCurrent;
    if (!proof || proof.challenge.challengeRef !== request.challengeRef || proof.challenge.registrationRef !== registration.registrationRef ||
      proof.issuedAt > now() || proof.expiresAt <= now() || proof.accessExpiresAt <= now() || proof.control.expiresAt <= now() ||
      typeof proof.accessTokenHash !== "string") return notCurrent;
    const registered = async () => {
      const observed = await store.findFinancialSourceRegistration!(registration.registrationRef);
      return observed !== undefined && canonicalFinancialSourceJson(observed) === canonicalFinancialSourceJson(registration);
    };
    if (!(await registered())) return notCurrent;
    const record = await store.findAccessTokenByHash(proof.accessTokenHash);
    const client = record && clients.get(record.clientId);
    const active = async (current: TokenRecord | undefined): Promise<boolean> => !!current && !!client &&
      current.expiresAt === proof.accessExpiresAt && current.expiresAt > now() && current.oidcProfile === "shared-account" &&
      current.issuer === proof.issuer && proof.issuer === issuer && current.subject === proof.subject && current.takosumiSubject === proof.subject &&
      current.clientId === proof.clientId && current.sid === proof.sid && current.issuerSessionId === proof.issuerSessionId &&
      (current.identityGeneration ?? 0) === proof.identityGeneration && !current.interfaceId && !current.interfaceBindingId &&
      current.interfaceResolvedRevision === undefined && await hostedGrantIsActive({store, record: current, client, issuer, now: now()});
    if (!(await active(record))) return notCurrent;
    const observedChallenge = await Reflect.apply(readChallenge!, challengeOwner, [request.challengeRef]);
    if (observedChallenge === undefined || canonicalFinancialSourceJson(parseFinancialIdentityChallenge(observedChallenge)) !==
      canonicalFinancialSourceJson(proof.challenge)) return notCurrent;
    const snapshot = await Reflect.apply(capture!, control, [{workspaceId: proof.challenge.workspaceId, accountId: proof.subject}]);
    if (!snapshot || snapshot.accountId !== proof.subject || snapshot.workspaceId !== proof.challenge.workspaceId ||
      snapshot.organizationId !== proof.challenge.organizationId || snapshot.workspaceRef !== proof.challenge.workspaceRef ||
      snapshot.evidence.evidenceRef !== proof.control.evidenceRef || snapshot.evidence.evidenceDigest !== proof.control.evidenceDigest ||
      canonicalFinancialSourceJson(snapshot.evidence.source) !== canonicalFinancialSourceJson(proof.control.source)) return notCurrent;
    const budget = {remaining: FINANCIAL_SOURCE_MAX_PAGE};
    for (const slot of slots) {
      const expected = proof.parents[slot];
      const head = await store.findFinancialSourceParent!(expected.scope);
      if (!head || head.state !== "open" || head.registrationRef !== expected.registrationRef || head.incarnation !== expected.incarnation ||
        head.affectedRef !== expected.affectedRef || head.sequence !== expected.sequence || head.lastEventRef !== expected.eventRef) return notCurrent;
      try {
        if (canonicalFinancialSourceJson(await acknowledged(head, budget)) !== canonicalFinancialSourceJson(expected)) return notCurrent;
      } catch (error) {
        if (error instanceof FinancialSourceUnavailable && ["source_pending", "source_unavailable"].includes(error.code)) return notCurrent;
        throw error;
      }
    }
    const currentToken = await store.findAccessTokenByHash(proof.accessTokenHash);
    if (!(await active(currentToken)) || !(await Reflect.apply(assertCurrent!, control, [snapshot])) || !(await registered())) return notCurrent;
    const observedAt = now();
    if (proof.expiresAt <= observedAt || proof.challenge.expiresAt <= observedAt || proof.accessExpiresAt <= observedAt ||
      proof.control.expiresAt <= observedAt || snapshot.evidence.expiresAt <= observedAt) return notCurrent;
    return {v: 1, status: "current", proof: projectFinancialIdentityProof(proof), observedAt};
  }
  return {
    /** Read-only ORIGINAL materialization custody. No enrollment, SHA-driven
     * materialization write, current grant or new command is created here. */
    async loadFinancialSourceEventEvidence(value: FinancialSourceEventEvidenceRequest): Promise<FinancialSourceEventEvidenceLoadResult> {
      const request = parseFinancialSourceEventEvidenceRequest(value);
      const validUntil = await eventEvidence.authorize();
      if (!store.findFinancialSourceRegistration || !store.findFinancialSourceMaterialization || !store.findFinancialSourceRaw)
        throw new FinancialSourceAbiError("unavailable");
      const enrolled = await store.findFinancialSourceRegistration(registration.registrationRef);
      if (!enrolled || canonicalFinancialSourceJson(enrolled) !== canonicalFinancialSourceJson(registration))
        throw new FinancialSourceAbiError("unregistered-source");
      const record = await store.findFinancialSourceMaterialization(request.eventRef);
      if (!record) {
        await eventEvidence.authorize();
        if (validUntil <= eventEvidence.now()) throw new FinancialSourceAbiError("unavailable");
        return {v: 1, status: "not-found"};
      }
      const original = await store.findFinancialSourceRaw(request.eventRef);
      if (!original || canonicalFinancialSourceJson(original) !== canonicalFinancialSourceJson(record.rawRecord) ||
        original.raw.registrationRef !== registration.registrationRef || original.raw.incarnation !== registration.incarnation)
        throw new FinancialSourceAbiError("conflict");
      const predecessor = original.raw.previousEventRef === null ? undefined : await store.findFinancialSourceMaterialization(original.raw.previousEventRef);
      if (predecessor) {
        const priorRaw = await store.findFinancialSourceRaw(original.raw.previousEventRef!);
        if (!priorRaw || canonicalFinancialSourceJson(priorRaw) !== canonicalFinancialSourceJson(predecessor.rawRecord) ||
          await financialSourceEventDigest(predecessor.materialization.event) !== predecessor.materialization.eventDigest)
          throw new FinancialSourceAbiError("conflict");
      }
      const expected = await materializeFinancialSourceEvent({registration, raw: original.raw, predecessor: predecessor?.materialization});
      if (canonicalFinancialSourceJson(expected) !== canonicalFinancialSourceJson(record.materialization) || expected.eventDigest !== request.eventDigest)
        throw new FinancialSourceAbiError("conflict");
      const head = await eventEvidence.head(expected.event);
      if (head.genesisDigest !== registration.genesisDigest ||
        canonicalFinancialSourceJson(head.receivers) !== canonicalFinancialSourceJson(registration.receivers))
        throw new FinancialSourceAbiError("unregistered-source");
      const result = await projectFinancialSourceEventEvidence({request, materialization: record.materialization, registeredHead: head});
      const finalRegistration = await store.findFinancialSourceRegistration(registration.registrationRef);
      const finalHead = await eventEvidence.head(expected.event);
      await eventEvidence.authorize();
      if (!finalRegistration || canonicalFinancialSourceJson(finalRegistration) !== canonicalFinancialSourceJson(enrolled) ||
        canonicalFinancialSourceJson(finalHead) !== canonicalFinancialSourceJson(head) || validUntil <= eventEvidence.now())
        throw new FinancialSourceAbiError("unavailable");
      return result;
    },
    /** Immutable original custody, including after expiry or revocation. This
     * read never confers fresh grant, Principal, payer or dispatch authority. */
    async loadFinancialIdentityProof(value: FinancialIdentityProofRequest): Promise<FinancialIdentityProofLoadResult> {
      const request = parseFinancialIdentityProofRequest(value);
      if (!store.findFinancialSourceProof) unavailable();
      const record = await store.findFinancialSourceProof(request.proofRef);
      if (!record || record.challenge.challengeRef !== request.challengeRef ||
        record.challenge.registrationRef !== registration.registrationRef) return {v: 1, status: "not-found"};
      return {v: 1, status: "found", proof: projectFinancialIdentityProof(record)};
    },
    /** Fresh observations of the actual original token/grant, identity roots,
     * Control vector and complete ACK set. The Financial owner still performs
     * its L1/L2 same-primary CAS; this remote result is not that atomic guard. */
    async verifyCurrentFinancialIdentityProof(value: FinancialIdentityProofRequest): Promise<FinancialIdentityProofCurrentResult> {
      return verifyCurrentProof(value);
    },
    /** Explicit first-event originals for a separately qualified Financial M.
     * No receiver callback, ACK or proof issuer is used by this preparation. */
    async prepareFinancialIdentityProofSource(input: {readonly accessToken: string; readonly challengeRef: string}): Promise<AccountsFinancialPreparedSource> {
      const {accessToken, challengeRef} = input;
      preparationCapabilities();
      const challenge = await freshChallenge(challengeRef);
      await registered();
      const original = await current(accessToken);
      if (original.client.clientId !== challenge.clientId) invalidGrant();
      const accessTokenHash = await sha256Text(accessToken);
      const {heads, scope, snapshot, verify} = await enrollOriginalParents({accessToken, challenge, original, accessTokenHash});
      const prepared = {} as MutableVector<AccountsFinancialPreparedOriginal>;
      const rawBefore = {} as MutableVector<FinancialSourceMaterializationRecord["rawRecord"]>;
      const budget: MaterializationBudget = {remaining: FINANCIAL_SOURCE_MAX_PAGE};
      for (const slot of slots) {
        const head = heads[slot];
        if (head.state !== "open" || head.sequence !== 1 || head.registrationRef !== registration.registrationRef ||
          head.incarnation !== registration.incarnation || canonicalFinancialSourceJson(head.scope) !== canonicalFinancialSourceJson(scope[slot]))
          throw new FinancialSourceUnavailable("source_pending");
        const raw = await store.findFinancialSourceRaw!(head.lastEventRef);
        if (!raw || canonicalFinancialSourceJson(raw.parent) !== canonicalFinancialSourceJson(scope[slot]) ||
          raw.raw.affectedRef !== head.affectedRef) throw new FinancialSourceUnavailable("source_conflict");
        rawBefore[slot] = raw;
        prepared[slot] = await preparedOriginal(head.lastEventRef, budget);
        if (prepared[slot].key.affectedRef !== head.affectedRef) throw new FinancialSourceUnavailable("source_conflict");
      }
      await verify();
      await registered();
      for (const slot of slots) {
        const head = await store.findFinancialSourceParent!(scope[slot]);
        const raw = await store.findFinancialSourceRaw!(heads[slot].lastEventRef);
        const saved = await store.findFinancialSourceMaterialization!(heads[slot].lastEventRef);
        if (!head || canonicalFinancialSourceJson(head) !== canonicalFinancialSourceJson(heads[slot]) ||
          !raw || canonicalFinancialSourceJson(raw) !== canonicalFinancialSourceJson(rawBefore[slot]) ||
          !saved || canonicalFinancialSourceJson(saved.rawRecord) !== canonicalFinancialSourceJson(raw) ||
          canonicalFinancialSourceJson(saved.materialization) !== canonicalFinancialSourceJson(prepared[slot].materialization))
          throw new FinancialSourceUnavailable("source_conflict");
      }
      await verify();
      return structuredClone({kind: "fresh", registration, parents: prepared, controlSource: snapshot.evidence.source});
    },
    /** One historical pending page only. No token, C0, fresh grant, receiver,
     * proof or Financial M is consulted or invoked. Cursor is scheduling only. */
    async preparePendingFinancialSourceOriginals(input: {readonly after?: string; readonly limit: number}): Promise<AccountsFinancialPendingOriginalPage> {
      const {after, limit} = input;
      if (!store.listFinancialSourcePending || !store.findFinancialSourceRegistration || !store.findFinancialSourceParent ||
        !store.findFinancialSourceRaw || !store.findFinancialSourceMaterialization || !store.commitFinancialSourceMaterialization ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > FINANCIAL_SOURCE_MAX_PAGE ||
        after !== undefined && !financialSourceRef(after)) unavailable();
      await registered();
      const page = await store.listFinancialSourcePending({registrationRef: registration.registrationRef, after, limit});
      if (!Array.isArray(page.entries) || page.entries.length > limit ||
        page.nextCursor !== undefined && !financialSourceRef(page.nextCursor)) unavailable();
      const entries: {original: AccountsFinancialPreparedOriginal}[] = [];
      const budget: MaterializationBudget = {remaining: FINANCIAL_SOURCE_MAX_PAGE};
      let previousRef = after ?? "";
      for (const pending of page.entries) {
        if (canonicalFinancialSourceJson(pending.registration) !== canonicalFinancialSourceJson(registration) ||
          !financialSourceRef(pending.eventRef) || pending.eventRef <= previousRef)
          throw new FinancialSourceUnavailable("source_conflict");
        previousRef = pending.eventRef;
        const raw = await store.findFinancialSourceRaw(pending.eventRef);
        if (!raw) throw new FinancialSourceUnavailable("source_conflict");
        const head = await store.findFinancialSourceParent(raw.parent);
        if (!head || head.registrationRef !== registration.registrationRef || head.incarnation !== registration.incarnation ||
          head.affectedRef !== raw.raw.affectedRef || head.sequence < raw.raw.sequence ||
          canonicalFinancialSourceJson(head.scope) !== canonicalFinancialSourceJson(raw.parent))
          throw new FinancialSourceUnavailable("source_conflict");
        const original = await preparedOriginal(pending.eventRef, budget);
        const finalRaw = await store.findFinancialSourceRaw(pending.eventRef);
        const finalSaved = await store.findFinancialSourceMaterialization(pending.eventRef);
        const finalHead = await store.findFinancialSourceParent(raw.parent);
        if (!finalRaw || canonicalFinancialSourceJson(finalRaw) !== canonicalFinancialSourceJson(raw) ||
          !finalSaved || canonicalFinancialSourceJson(finalSaved.rawRecord) !== canonicalFinancialSourceJson(raw) ||
          canonicalFinancialSourceJson(finalSaved.materialization) !== canonicalFinancialSourceJson(original.materialization) ||
          !finalHead || canonicalFinancialSourceJson(finalHead) !== canonicalFinancialSourceJson(head))
          throw new FinancialSourceUnavailable("source_conflict");
        entries.push({original});
      }
      if (page.nextCursor !== undefined && (entries.length !== limit || page.nextCursor !== previousRef))
        throw new FinancialSourceUnavailable("source_conflict");
      await registered();
      return structuredClone({kind: "historical", registration, entries, ...(page.nextCursor === undefined ? {} : {nextCursor: page.nextCursor})});
    },
    /** Input conveys the actual grant and a Financial-owned challenge REF only.
     * The proof identifies current identity/context, never a Principal or payer. */
    async prove(input: {readonly accessToken: string; readonly challengeRef: string}): Promise<{readonly proofRef: string}> {
      // Capture mutable local input BEFORE the first await. A later mutation
      // must not select a different token, challenge or recovery key.
      const {accessToken, challengeRef} = input;
      capabilities();
      const challenge = await freshChallenge(challengeRef);
      await registered();
      const original = await current(accessToken);
      if (original.client.clientId !== challenge.clientId) invalidGrant();
      const subject = original.record.takosumiSubject!;
      const accessTokenHash = await sha256Text(accessToken);
      const lookup = {registrationRef: registration.registrationRef, challengeRef, accessTokenHash};
      const census = () => store.findFinancialSourceProofsForOriginalRequest!(lookup);
      const originalCaller = {issuer, subject, clientId: original.record.clientId, sid: original.record.sid!,
        issuerSessionId: original.record.issuerSessionId!, identityGeneration: original.record.identityGeneration ?? 0};
      // This opaque rendezvous identifies the SAME retained-census set. Full
      // challenge/caller/vector differences must not choose another PK under a
      // concurrent PostgreSQL statement snapshot. They remain rejection checks
      // below, never authority conferred by this locator.
      const requestDigest = await sha256Text(canonicalFinancialSourceJson({
        domain: "takosumi.accounts.financial-proof-original-custody@v1",
        value: {registrationRef: registration.registrationRef, challengeRef, accessTokenHash},
      }));
      const proofRef = "afp_" + requestDigest.slice("sha256:".length);
      const recover = async (): Promise<{readonly proofRef: string}> => {
        const matches = await census();
        if (matches.length !== 1) throw new FinancialSourceUnavailable("source_conflict");
        const proof = structuredClone(matches[0]!);
        if (proof.accessTokenHash !== accessTokenHash || proof.accessExpiresAt !== original.record.expiresAt ||
          canonicalFinancialSourceJson(proof.challenge) !== canonicalFinancialSourceJson(challenge) ||
          Object.entries(originalCaller).some(([key, value]) => proof[key as keyof typeof proof] !== value) ||
          slots.some(slot => proof.parents[slot].registrationRef !== registration.registrationRef || proof.parents[slot].incarnation !== registration.incarnation))
          throw new FinancialSourceUnavailable("source_conflict");
        const checked = await verifyCurrentProof({v: 1, proofRef: proof.proofRef, challengeRef}, proof);
        // Preserve the genuine invalid-grant result if revocation won during
        // a currentness await; a retained original never bypasses live auth.
        await current(accessToken);
        if (checked.status !== "current") throw new FinancialSourceUnavailable("source_conflict");
        const final = await census();
        if (final.length !== 1 || canonicalFinancialSourceJson(final[0]) !== canonicalFinancialSourceJson(proof) ||
          proof.expiresAt <= now() || proof.control.expiresAt <= now()) throw new FinancialSourceUnavailable("source_conflict");
        return {proofRef: proof.proofRef};
      };
      if ((await census()).length !== 0) return recover();
      const {heads, verify} = await enrollOriginalParents({accessToken, challenge, original, accessTokenHash});
      const refs = {} as MutableVector<FinancialSourceParentReference>;
      const budget = {remaining: FINANCIAL_SOURCE_MAX_PAGE};
      for (const slot of slots) refs[slot] = await acknowledged(heads[slot], budget);
      const authority = await verify();
      const issuedAt = now();
      const proof: FinancialSourceProofRecord = {v: 1, proofRef, challenge, issuer, subject,
        accessTokenHash, accessExpiresAt: authority.expectedAccess.expiresAt,
        clientId: challenge.clientId, sid: original.record.sid!, issuerSessionId: original.record.issuerSessionId!, identityGeneration: authority.expectedIdentityGeneration,
        control: authority.control, parents: refs, issuedAt, expiresAt: Math.min(issuedAt + proofLifetime, challenge.expiresAt,
          authority.expectedAccess.expiresAt, authority.expectedGrant.absoluteExpiresAt, authority.control.expiresAt)};
      let result: FinancialSourceProofRecord | undefined;
      try {
        result = await store.issueFinancialSourceProof!(await checkpoint<import("./identity-state.ts").FinancialSourceProofMutation>({...authority, expectedParents: heads, proof}));
      } catch {
        // Commit may have succeeded while its reply was lost. Read the original
        // input once; never retry a write, replace its vector or rotate its key.
        return recover();
      }
      if (!result || result.proofRef !== proof.proofRef) return recover();
      return {proofRef: result.proofRef};
    },
    /** One bounded page; nextCursor is explicit and never means a complete
     * closure census. A lost delivery ACK is read back by the ORIGINAL event. */
    async flush(input: {readonly after?: string; readonly limit: number}): Promise<{readonly processed: number; readonly nextCursor?: string}> {
      capabilities();
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > FINANCIAL_SOURCE_MAX_PAGE || input.after !== undefined && !financialSourceRef(input.after)) unavailable();
      const page = await store.listFinancialSourcePending!({registrationRef: registration.registrationRef, ...input});
      if (!Array.isArray(page.entries) || page.entries.length > input.limit ||
        page.nextCursor !== undefined && !financialSourceRef(page.nextCursor)) unavailable();
      let processed = 0;
      const budget = {remaining: FINANCIAL_SOURCE_MAX_PAGE};
      for (const pending of page.entries) {
        if (canonicalFinancialSourceJson(pending.registration) !== canonicalFinancialSourceJson(registration)) unavailable();
        const record = await materialize(pending.eventRef, budget);
        for (const required of registration.receivers) {
          const configured = receivers.get(required.receiverRef)!;
          const existing = await store.findFinancialSourceReceipt!({registrationRef: registration.registrationRef, eventRef: pending.eventRef, receiverRef: required.receiverRef});
          if (existing) {
            if (existing.registrationRef !== registration.registrationRef || existing.receiverRef !== required.receiverRef ||
              existing.targetRef !== required.targetRef || !financialReceiptMatches(record.materialization.event, record.materialization.eventDigest, existing.receipt))
              throw new FinancialSourceUnavailable("source_conflict");
            continue;
          }
          const observed = await Reflect.apply(configured.read, configured.receiver, [structuredClone(record.materialization)]);
          const receipt = parseFinancialSourceReceipt(observed ?? await Reflect.apply(configured.deliver, configured.receiver, [structuredClone(record.materialization)]));
          if (!financialReceiptMatches(record.materialization.event, record.materialization.eventDigest, receipt) ||
            !(await store.recordFinancialSourceReceipt!({expectedMaterialization: record, receipt: {registrationRef: registration.registrationRef,
              receiverRef: required.receiverRef, targetRef: required.targetRef, receipt}}))) throw new FinancialSourceUnavailable("source_conflict");
        }
        processed++;
      }
      return {processed, nextCursor: page.nextCursor};
    },
  };
}

/** Accounts-owned adapter above the SAME canonical Control facade. It never
 * enrolls a source, chooses a payer or accepts a browser-built snapshot. */
export function createAccountsFinancialControlSource(options: {
  readonly service: WorkspaceFinancialSourceService;
  readonly receivers?: readonly AccountsFinancialReceiver[];
  readonly eventEvidence?: AccountsFinancialEventEvidenceOptions & {readonly registration: FinancialSourceRegistration};
  readonly genesisCoverage?: AccountsFinancialGenesisCoveragePort;
  readonly now?: () => number;
}) {
  const service = options.service;
  const capture = service.captureFinancialSourceSnapshot;
  const assertCurrent = service.assertFinancialSourceSnapshotCurrent;
  const readHead = service.readHead;
  const listRaw = service.listRawEvents;
  const readMaterialization = service.readMaterialization;
  const materialize = service.materializeEvent;
  const recordReceipt = service.recordReceipt;
  const readEnrollmentOriginal = service.readEnrollmentOriginal;
  const genesisPort = options.genesisCoverage;
  const readGenesisOriginals = genesisPort?.readCurrentOriginals;
  const genesisPeers = genesisPort && genesisFreeze(genesisArray(genesisPort.peers).map(genesisPeer));
  if (genesisPort && typeof readGenesisOriginals !== "function") throw new FinancialSourceUnavailable("source_unavailable");
  const eventEvidence = captureEventEvidenceAuthority(options.eventEvidence);
  const evidenceRegistration = options.eventEvidence && parseFinancialSourceRegistration(structuredClone(options.eventEvidence.registration));
  const rawClock = options.now ?? anchoredClock();
  let lastNow = -1;
  const now = () => {
    const value = rawClock();
    if (!Number.isSafeInteger(value) || value < 0 || value < lastNow) throw new FinancialSourceUnavailable("source_unavailable");
    lastNow = value;
    return value;
  };
  const snapshots = new WeakMap<object, {original: WorkspaceFinancialSourceSnapshot; binding: string; expiresAt: number;
    genesis?: AccountsFinancialGenesisBundle; genesisDigest?: FinancialSourceDigest}>();
  const receivers = new Map<string, {receiver: AccountsFinancialReceiver; targetRef: string;
    read: AccountsFinancialReceiver["read"]; deliver: AccountsFinancialReceiver["deliver"]}>();
  for (const receiver of options.receivers ?? []) {
    if (!financialSourceRef(receiver.receiverRef) || !financialSourceRef(receiver.targetRef) || receivers.has(receiver.receiverRef))
      throw new FinancialSourceUnavailable("source_unavailable");
    receivers.set(receiver.receiverRef, {receiver, targetRef: receiver.targetRef, read: receiver.read, deliver: receiver.deliver});
  }
  const fail: () => never = () => { throw new FinancialSourceUnavailable("source_conflict"); };
  const hex = (value: string): `sha256:${string}` => /^[a-f0-9]{64}$/u.test(value) ? `sha256:${value}` : fail();
  const registration = (head: WorkspaceFinancialSourceHead): FinancialSourceRegistration => parseFinancialSourceRegistration({
    registrationRef: head.sourceRef, incarnation: head.incarnation, genesisDigest: hex(head.genesisDigest), receivers: head.requiredReceivers,
  });
  const readGenesis = async (core: WorkspaceFinancialSourceSnapshot): Promise<AccountsFinancialGenesisBundle | undefined> => {
    if (!genesisPort || !genesisPeers) return undefined;
    if (typeof readEnrollmentOriginal !== "function" || typeof readGenesisOriginals !== "function")
      throw new FinancialSourceUnavailable("source_unavailable");
    const head = core.head, enrolled = registration(head);
    if (head.permissionSequence !== 0 || head.lastEventRef !== null || head.materializedSequence !== 0 ||
      head.materializedDigest !== head.genesisDigest) return fail();
    let observed: WorkspaceFinancialEnrollmentOriginal | undefined;
    try {
      observed = await Reflect.apply(readEnrollmentOriginal, service,
        [{workspaceId: core.workspace.id, sourceRef: head.sourceRef, incarnation: head.incarnation}]);
    } catch (error) {
      // Classification of a rejection from the captured Core method only;
      // this never treats an error object or its code as source authority.
      const code = error instanceof Error && Object.getOwnPropertyDescriptor(error, "code");
      if (code && "value" in code && (code.value === "conflict" || code.value === "invalid_request"))
        return fail();
      throw new FinancialSourceUnavailable("source_unavailable");
    }
    // We already captured an enrolled head. Missing immutable producer data
    // is unavailable, never a selected G command's positive absence.
    if (observed === undefined) throw new FinancialSourceUnavailable("source_unavailable");
    const coreOriginal = genesisOriginal(observed);
    const retained = genesisRecord(JSON.parse(coreOriginal.registrationJson), ["sourceRef", "incarnation", "genesisDigest", "requiredReceivers"]);
    const retainedRegistration = genesisRegistration({registrationRef: retained.sourceRef, incarnation: retained.incarnation,
      genesisDigest: typeof retained.genesisDigest === "string" ? hex(retained.genesisDigest) : fail(), receivers: retained.requiredReceivers});
    const identity = genesisRecord(JSON.parse(coreOriginal.identityJson), ["sourceRef", "incarnation", "genesisDigest", "requiredReceivers",
      "workspaceId", "workspaceCreatedAt", "organizationRef", "workspaceRef", "bindingIntentId", "bindingJson", "enrolledAt"]);
    const expectedIdentity = {sourceRef: head.sourceRef, incarnation: head.incarnation, genesisDigest: head.genesisDigest,
      requiredReceivers: head.requiredReceivers, workspaceId: head.workspaceId, workspaceCreatedAt: head.workspaceCreatedAt,
      organizationRef: head.organizationRef, workspaceRef: head.workspaceRef, bindingIntentId: head.bindingIntentId,
      bindingJson: head.bindingJson, enrolledAt: head.enrolledAt};
    if (coreOriginal.workspaceId !== core.workspace.id || coreOriginal.sourceRef !== head.sourceRef || coreOriginal.incarnation !== head.incarnation ||
      coreOriginal.enrolledAt !== head.enrolledAt || head.workspaceCreatedAt !== core.workspace.createdAt ||
      canonicalFinancialSourceJson(retainedRegistration) !== canonicalFinancialSourceJson(enrolled) ||
      canonicalFinancialSourceJson(identity) !== canonicalFinancialSourceJson(expectedIdentity) ||
      canonicalFinancialSourceJson(genesisRecord(JSON.parse(coreOriginal.enrollmentJson), ["workspace", "management", "binding", "members"]).binding) !==
        canonicalFinancialSourceJson(JSON.parse(JSON.stringify(core.binding))) ||
      genesisPeers.length !== enrolled.receivers.length) return fail();
    for (const [index, peer] of genesisPeers.entries()) {
      const required = enrolled.receivers[index]!;
      if (peer.receiverRef !== required.receiverRef || peer.targetRef !== required.targetRef || peer.affectedRef !== core.workspace.id ||
        canonicalFinancialSourceJson(peer.source.registration) !== canonicalFinancialSourceJson(enrolled)) return fail();
    }
    // Only the actual qualified Root bridge establishes real source/realm/epoch
    // admission. Its historical G read and this local recheck are not atomic.
    const rows = genesisArray(await Reflect.apply(readGenesisOriginals, genesisPort,
      [{coreSnapshot: structuredClone(core), coreOriginal: structuredClone(coreOriginal)}]));
    if (rows.length !== genesisPeers.length) return fail();
    const peers: AccountsFinancialGenesisBundle["peers"][number][] = [];
    let absent = false;
    for (const [index, value] of rows.entries()) {
      if (!value || typeof value !== "object") return fail();
      const status = Object.getOwnPropertyDescriptor(value, "status");
      if (!status || !("value" in status) || (status.value !== "found" && status.value !== "absent")) return fail();
      const row = genesisRecord(value, status.value === "found" ? ["receiverRef", "targetRef", "command", "status", "receipt"] :
        ["receiverRef", "targetRef", "command", "status"]);
      const configured = genesisPeers[index]!;
      const command = genesisCommand(row.command);
      if (row.receiverRef !== configured.receiverRef || row.targetRef !== configured.targetRef ||
        !sameGenesisOriginal(command.enrollmentOriginal, coreOriginal)) return fail();
      if (row.status === "absent") { absent = true; continue; }
      const receipt = genesisReceipt(row.receipt);
      if (receipt.admissionRef !== command.admissionRef || receipt.commandRef !== command.commandRef || receipt.receiptRef !== command.receiptRef)
        return fail();
      peers.push({configured, command, receipt});
    }
    return absent ? undefined : {family: "G", core: JSON.parse(JSON.stringify(core)), coreOriginal, peers};
  };
  const rawWire = (raw: WorkspaceFinancialRawEvent) => ({v: 1 as const, eventRef: raw.eventRef,
    registrationRef: raw.sourceRef, incarnation: raw.incarnation, sequence: raw.permissionSequence,
    previousEventRef: raw.previousEventRef, kind: raw.closed ? "close" as const : "advance" as const,
    affectedRef: raw.workspaceId, evidenceRef: raw.eventRef});
  const decode = async (stored: WorkspaceFinancialMaterialization, raw: WorkspaceFinancialRawEvent): Promise<FinancialSourceMaterialization> => {
    const event = parseFinancialSourceEvent(JSON.parse(stored.wireJson));
    const {previousEventRef: _previous, ...fields} = rawWire(raw);
    if (stored.eventRef !== raw.eventRef || stored.sourceRef !== raw.sourceRef || stored.incarnation !== raw.incarnation ||
      stored.permissionSequence !== raw.permissionSequence || stored.rawPayloadJson !== raw.payloadJson ||
      canonicalFinancialSourceJson(event) !== stored.wireJson ||
      canonicalFinancialSourceJson(event) !== canonicalFinancialSourceJson({...fields, previousDigest: hex(stored.previousDigest)}) ||
      await financialSourceEventDigest(event) !== hex(stored.digest)) fail();
    return {rawEventDigest: await hashFinancialSourceValue("takosumi.financial-source-raw@v1", rawWire(raw)),
      event, eventDigest: hex(stored.digest)};
  };
  return {
    /** A separate fixed C-source instance. The caller selects its qualified
     * source binding; this never prefix-searches or falls back to Accounts. */
    async loadFinancialSourceEventEvidence(value: FinancialSourceEventEvidenceRequest): Promise<FinancialSourceEventEvidenceLoadResult> {
      const request = parseFinancialSourceEventEvidenceRequest(value);
      if (!evidenceRegistration) throw new FinancialSourceAbiError("unavailable");
      const validUntil = await eventEvidence.authorize();
      const stored = await Reflect.apply(readMaterialization, service, [request.eventRef]);
      if (!stored) {
        await eventEvidence.authorize();
        if (validUntil <= eventEvidence.now()) throw new FinancialSourceAbiError("unavailable");
        return {v: 1, status: "not-found"};
      }
      const event = parseFinancialSourceEvent(JSON.parse(stored.wireJson));
      if (event.registrationRef !== evidenceRegistration.registrationRef || event.incarnation !== evidenceRegistration.incarnation ||
        event.eventRef !== request.eventRef || stored.digest !== request.eventDigest.slice(7)) throw new FinancialSourceAbiError("conflict");
      const actualHead = await Reflect.apply(readHead, service, [event.affectedRef]);
      if (!actualHead || canonicalFinancialSourceJson(registration(actualHead)) !== canonicalFinancialSourceJson(evidenceRegistration))
        throw new FinancialSourceAbiError("unregistered-source");
      const raw = await Reflect.apply(listRaw, service, [{workspaceId: event.affectedRef, afterSequence: event.sequence - 1, limit: 1}]);
      if (raw.length !== 1 || raw[0]!.eventRef !== request.eventRef || raw[0]!.permissionSequence !== event.sequence) throw new FinancialSourceAbiError("conflict");
      const original = raw[0]!;
      const wire = await decode(stored, original);
      let predecessor: FinancialSourceMaterialization | undefined;
      if (original.previousEventRef !== null) {
        const prior = await Reflect.apply(readMaterialization, service, [original.previousEventRef]);
        const priorRaw = await Reflect.apply(listRaw, service, [{workspaceId: event.affectedRef, afterSequence: event.sequence - 2, limit: 1}]);
        if (!prior || priorRaw.length !== 1 || priorRaw[0]!.eventRef !== original.previousEventRef) throw new FinancialSourceAbiError("conflict");
        predecessor = await decode(prior, priorRaw[0]!);
      }
      const expected = await materializeFinancialSourceEvent({registration: evidenceRegistration, raw: rawWire(original), predecessor});
      if (canonicalFinancialSourceJson(expected) !== canonicalFinancialSourceJson(wire)) throw new FinancialSourceAbiError("conflict");
      const registeredHead = await eventEvidence.head(wire.event);
      if (registeredHead.genesisDigest !== evidenceRegistration.genesisDigest ||
        canonicalFinancialSourceJson(registeredHead.receivers) !== canonicalFinancialSourceJson(evidenceRegistration.receivers))
        throw new FinancialSourceAbiError("unregistered-source");
      const result = await projectFinancialSourceEventEvidence({request, materialization: wire, registeredHead});
      const finalHead = await Reflect.apply(readHead, service, [event.affectedRef]);
      const finalQualifiedHead = await eventEvidence.head(wire.event);
      await eventEvidence.authorize();
      if (!finalHead || canonicalFinancialSourceJson(registration(finalHead)) !== canonicalFinancialSourceJson(evidenceRegistration) ||
        canonicalFinancialSourceJson(finalQualifiedHead) !== canonicalFinancialSourceJson(registeredHead) || validUntil <= eventEvidence.now())
        throw new FinancialSourceAbiError("unavailable");
      return result;
    },
    async capture(input: {readonly workspaceId: string; readonly accountId: TakosumiSubject}): Promise<AccountsFinancialControlSnapshot | undefined> {
      const {workspaceId, accountId} = input;
      if (!financialSourceRef(workspaceId) || !financialSourceRef(accountId)) return undefined;
      now();
      const captured = await Reflect.apply(capture, service, [{workspaceId, actorAccountId: accountId}]);
      const original = captured?.head.permissionSequence === 0 ? structuredClone(captured) : captured;
      if (!original || original.workspace.id !== workspaceId || original.member.workspaceId !== workspaceId ||
        original.member.accountId !== accountId || original.member.status !== "active" || original.head.closed ||
        original.binding.workspaceId !== workspaceId || original.head.workspaceId !== workspaceId ||
        original.binding.organizationRef !== original.head.organizationRef || original.binding.workspaceRef !== original.head.workspaceRef ||
        original.head.permissionSequence !== original.head.materializedSequence) return undefined;
      const enrolled = registration(original.head);
      if ((original.head.permissionSequence === 0) !== (original.head.lastEventRef === null)) return fail();
      let genesis: AccountsFinancialGenesisBundle | undefined;
      if (original.head.permissionSequence === 0) {
        if (!(await Reflect.apply(assertCurrent, service, [structuredClone(original)]))) return undefined;
        genesis = await readGenesis(structuredClone(original));
        if (!genesis) return undefined;
      }
      // Storage has legitimate absent optional columns. Normalize only their
      // representation; the exact ORIGINAL Core object is retained privately.
      const digest = genesis ? await genesisEvidenceDigest(genesis) :
        await hashFinancialSourceValue("takosumi.financial-source-control-evidence@v1", JSON.parse(JSON.stringify(original)));
      if (!(await Reflect.apply(assertCurrent, service, [original]))) return undefined;
      const issuedAt = now();
      if (!Number.isSafeInteger(issuedAt + proofLifetime)) return undefined;
      const result: AccountsFinancialControlSnapshot = {workspaceId, accountId,
        organizationId: original.binding.organizationRef, workspaceRef: original.binding.workspaceRef,
        evidence: {evidenceRef: `cfe_${digest.slice(7)}`, evidenceDigest: digest, expiresAt: issuedAt + proofLifetime,
          source: {registrationRef: enrolled.registrationRef, incarnation: enrolled.incarnation, affectedRef: original.workspace.id,
            sequence: original.head.permissionSequence, eventRef: original.head.lastEventRef,
            eventDigest: hex(original.head.materializedDigest), receivers: enrolled.receivers}}};
      snapshots.set(result, {original: structuredClone(original), binding: canonicalFinancialSourceJson(result), expiresAt: result.evidence.expiresAt,
        ...(genesis ? {genesis: structuredClone(genesis), genesisDigest: digest} : {})});
      return result;
    },
    async assertCurrent(snapshot: AccountsFinancialControlSnapshot): Promise<boolean> {
      const retained = snapshots.get(snapshot);
      if (!retained || now() >= retained.expiresAt) return false;
      try { if (canonicalFinancialSourceJson(snapshot) !== retained.binding) return false; } catch { return false; }
      const current = await Reflect.apply(assertCurrent, service, [structuredClone(retained.original)]);
      if (!current) return false;
      if (retained.genesis) {
        const genesis = await readGenesis(structuredClone(retained.original));
        if (!genesis) return false;
        if (await genesisEvidenceDigest(genesis) !== retained.genesisDigest) return fail();
        if (!(await Reflect.apply(assertCurrent, service, [structuredClone(retained.original)]))) return false;
      }
      return now() < retained.expiresAt && canonicalFinancialSourceJson(snapshot) === retained.binding;
    },
    /** Original first Control event, including before any receiver ACK. This is
     * historical source data, not an actor/currentness or M qualification. */
    async prepareInitialFinancialControlSourceOriginal(input: {readonly workspaceId: string}): Promise<{
      readonly kind: "historical";
      readonly registration: FinancialSourceRegistration;
      readonly original: AccountsFinancialPreparedOriginal;
    }> {
      const {workspaceId} = input;
      if (!financialSourceRef(workspaceId)) unavailable();
      const head = await Reflect.apply(readHead, service, [workspaceId]);
      if (!head || head.workspaceId !== workspaceId || head.closed || head.permissionSequence !== 1 || head.lastEventRef === null)
        throw new FinancialSourceUnavailable("source_pending");
      const enrolled = registration(head);
      const page = await Reflect.apply(listRaw, service, [{workspaceId, afterSequence: 0, limit: 1}]);
      if (!Array.isArray(page) || page.length !== 1) throw new FinancialSourceUnavailable("source_conflict");
      const raw = page[0]!;
      if (raw.workspaceId !== workspaceId || raw.eventRef !== head.lastEventRef || raw.permissionSequence !== 1 ||
        raw.previousEventRef !== null || raw.sourceRef !== enrolled.registrationRef ||
        raw.incarnation !== enrolled.incarnation || raw.closed) throw new FinancialSourceUnavailable("source_conflict");
      let wire: FinancialSourceMaterialization;
      try { wire = await materializeFinancialSourceEvent({registration: enrolled, raw: rawWire(raw)}); }
      catch { throw new FinancialSourceUnavailable("source_conflict"); }
      const expected: WorkspaceFinancialMaterialization = {eventRef: raw.eventRef, sourceRef: raw.sourceRef,
        incarnation: raw.incarnation, permissionSequence: 1, rawPayloadJson: raw.payloadJson,
        previousDigest: wire.event.previousDigest.slice(7), wireJson: canonicalFinancialSourceJson(wire.event),
        digest: wire.eventDigest.slice(7)};
      if (wire.event.previousDigest !== enrolled.genesisDigest ||
        ![0, 1].includes(head.materializedSequence) ||
        head.materializedDigest !== (head.materializedSequence === 0 ? head.genesisDigest : expected.digest))
        throw new FinancialSourceUnavailable("source_conflict");
      let stored = await Reflect.apply(readMaterialization, service, [raw.eventRef]);
      if (!stored) {
        if (head.materializedSequence !== 0) throw new FinancialSourceUnavailable("source_conflict");
        // The original Core CAS may succeed and lose its reply. One GET of the
        // same event recovers it; no second CAS or replacement ref is minted.
        try { await Reflect.apply(materialize, service, [{original: structuredClone(raw), expectedHead: structuredClone(head), materialization: expected}]); }
        catch { /* The exact original readback below decides the outcome. */ }
        stored = await Reflect.apply(readMaterialization, service, [raw.eventRef]);
      }
      if (!stored || canonicalFinancialSourceJson(stored) !== canonicalFinancialSourceJson(expected) ||
        canonicalFinancialSourceJson(await decode(stored, raw)) !== canonicalFinancialSourceJson(wire))
        throw new FinancialSourceUnavailable("source_conflict");
      const finalHead = await Reflect.apply(readHead, service, [workspaceId]);
      const finalPage = await Reflect.apply(listRaw, service, [{workspaceId, afterSequence: 0, limit: 1}]);
      const finalStored = await Reflect.apply(readMaterialization, service, [raw.eventRef]);
      const materializedHead = {...head, materializedSequence: 1, materializedDigest: expected.digest};
      if (!finalHead || canonicalFinancialSourceJson(finalHead) !== canonicalFinancialSourceJson(materializedHead) ||
        !Array.isArray(finalPage) || finalPage.length !== 1 ||
        canonicalFinancialSourceJson(finalPage[0]) !== canonicalFinancialSourceJson(raw) ||
        !finalStored || canonicalFinancialSourceJson(finalStored) !== canonicalFinancialSourceJson(expected))
        throw new FinancialSourceUnavailable("source_conflict");
      return structuredClone({kind: "historical", registration: enrolled,
        original: {key: {registrationRef: enrolled.registrationRef, incarnation: enrolled.incarnation,
          affectedRef: workspaceId}, eventRef: raw.eventRef, materialization: wire}});
    },
    /** One bounded page of actual Control history. A cursor is only a paging
     * position; this data never grants current actor or receiver authority. */
    async prepareHistoricalFinancialControlSourceOriginals(input: {
      readonly workspaceId: string;
      readonly afterSequence: number;
      readonly limit: number;
    }): Promise<{
      readonly kind: "historical";
      readonly registration: FinancialSourceRegistration;
      readonly observedPermissionSequence: number;
      readonly observedClosed: boolean;
      readonly entries: readonly {readonly original: AccountsFinancialPreparedOriginal}[];
      readonly nextAfterSequence?: number;
      readonly pageReachedObservedHead: boolean;
    }> {
      const {workspaceId, afterSequence, limit} = input;
      if (!financialSourceRef(workspaceId) || !Number.isSafeInteger(afterSequence) || afterSequence < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > controlHistoricalPageLimit) unavailable();
      const observedHead = await Reflect.apply(readHead, service, [workspaceId]);
      if (!observedHead) unavailable();
      const head: WorkspaceFinancialSourceHead = structuredClone(observedHead);
      if (head.workspaceId !== workspaceId || !Number.isSafeInteger(head.permissionSequence) ||
        head.permissionSequence < 0 || !Number.isSafeInteger(head.materializedSequence) ||
        head.materializedSequence < 0 || head.materializedSequence > head.permissionSequence) fail();
      const enrolled = registration(head);
      if (head.permissionSequence === 0) {
        if (head.lastEventRef !== null || head.materializedSequence !== 0 ||
          head.materializedDigest !== head.genesisDigest) fail();
        throw new FinancialSourceUnavailable("source_pending");
      }
      if (head.lastEventRef === null || afterSequence > head.permissionSequence) fail();
      const exactRaw = async (sequence: number): Promise<WorkspaceFinancialRawEvent> => {
        const rows = await Reflect.apply(listRaw, service, [{workspaceId, afterSequence: sequence - 1, limit: 1}]);
        if (!Array.isArray(rows) || rows.length !== 1 || !Object.hasOwn(rows, 0)) fail();
        const raw: WorkspaceFinancialRawEvent = rows[0]!;
        if (raw.workspaceId !== workspaceId || raw.sourceRef !== enrolled.registrationRef ||
          raw.incarnation !== enrolled.incarnation || raw.permissionSequence !== sequence ||
          !financialSourceRef(raw.eventRef)) fail();
        return structuredClone(raw);
      };
      const tail = await exactRaw(head.permissionSequence);
      if (tail.eventRef !== head.lastEventRef || tail.closed !== head.closed) fail();
      if (head.materializedSequence === 0) {
        if (head.materializedDigest !== head.genesisDigest) fail();
      } else {
        const baselineRaw = await exactRaw(head.materializedSequence);
        const baseline = await Reflect.apply(readMaterialization, service, [baselineRaw.eventRef]);
        if (!baseline || baseline.digest !== head.materializedDigest) fail();
        await decode(baseline, baselineRaw);
      }
      const observedPage = await Reflect.apply(listRaw, service, [{workspaceId, afterSequence, limit}]);
      if (!Array.isArray(observedPage) || observedPage.length > limit || observedPage.length > controlHistoricalPageLimit ||
        observedPage.length === 0 && afterSequence < head.permissionSequence) fail();
      const page: readonly WorkspaceFinancialRawEvent[] = structuredClone(observedPage);
      let predecessor: FinancialSourceMaterialization | undefined;
      let previousRaw: WorkspaceFinancialRawEvent | undefined;
      if (afterSequence > 0) {
        if (afterSequence > head.materializedSequence) throw new FinancialSourceUnavailable("source_pending");
        previousRaw = await exactRaw(afterSequence);
        const previousStored = await Reflect.apply(readMaterialization, service, [previousRaw.eventRef]);
        if (!previousStored) throw new FinancialSourceUnavailable("source_pending");
        predecessor = await decode(previousStored, previousRaw);
        if (afterSequence === head.materializedSequence && previousStored.digest !== head.materializedDigest) fail();
      }
      let remaining = limit;
      let progressSequence = head.materializedSequence;
      let progressDigest = head.materializedDigest;
      const originals: {original: AccountsFinancialPreparedOriginal}[] = [];
      const retainedRaw: WorkspaceFinancialRawEvent[] = [];
      const retainedStored: WorkspaceFinancialMaterialization[] = [];
      for (let index = 0; index < page.length; index++) {
        if (!Object.hasOwn(page, index) || --remaining < 0) fail();
        const raw: WorkspaceFinancialRawEvent = page[index]!;
        const sequence = afterSequence + index + 1;
        if (raw.workspaceId !== workspaceId || raw.sourceRef !== enrolled.registrationRef ||
          raw.incarnation !== enrolled.incarnation || raw.permissionSequence !== sequence ||
          !financialSourceRef(raw.eventRef) || raw.previousEventRef !== (previousRaw?.eventRef ?? null) ||
          previousRaw?.closed || sequence > head.permissionSequence ||
          raw.closed && sequence !== head.permissionSequence) fail();
        if (sequence === head.permissionSequence && (raw.eventRef !== head.lastEventRef || raw.closed !== head.closed)) fail();
        let wire: FinancialSourceMaterialization;
        try { wire = await materializeFinancialSourceEvent({registration: enrolled, raw: rawWire(raw), predecessor}); }
        catch { throw new FinancialSourceUnavailable("source_conflict"); }
        const expected: WorkspaceFinancialMaterialization = {eventRef: raw.eventRef, sourceRef: raw.sourceRef,
          incarnation: raw.incarnation, permissionSequence: sequence, rawPayloadJson: raw.payloadJson,
          previousDigest: wire.event.previousDigest.slice(7), wireJson: canonicalFinancialSourceJson(wire.event),
          digest: wire.eventDigest.slice(7)};
        let stored = await Reflect.apply(readMaterialization, service, [raw.eventRef]);
        if (stored && sequence > head.materializedSequence) fail();
        if (!stored) {
          if (sequence !== progressSequence + 1) throw new FinancialSourceUnavailable("source_pending");
          const currentHead = await Reflect.apply(readHead, service, [workspaceId]);
          const expectedHead = {...head, materializedSequence: progressSequence, materializedDigest: progressDigest};
          if (!currentHead || canonicalFinancialSourceJson(currentHead) !== canonicalFinancialSourceJson(expectedHead)) fail();
          // Core's captured full-head CAS is attempted once. Unknown or false
          // replies are resolved only by GET of this exact event and head.
          try { await Reflect.apply(materialize, service, [{original: structuredClone(raw),
            expectedHead: structuredClone(currentHead), materialization: expected}]); }
          catch { /* Exact readback below decides whether the original committed. */ }
          stored = await Reflect.apply(readMaterialization, service, [raw.eventRef]);
          const afterWriteHead = await Reflect.apply(readHead, service, [workspaceId]);
          if (!afterWriteHead || canonicalFinancialSourceJson(afterWriteHead) !== canonicalFinancialSourceJson({
            ...head, materializedSequence: sequence, materializedDigest: expected.digest})) fail();
          progressSequence = sequence;
          progressDigest = expected.digest;
        }
        if (!stored || canonicalFinancialSourceJson(stored) !== canonicalFinancialSourceJson(expected) ||
          canonicalFinancialSourceJson(await decode(stored, raw)) !== canonicalFinancialSourceJson(wire)) fail();
        retainedRaw.push(structuredClone(raw));
        retainedStored.push(structuredClone(stored));
        originals.push({original: {key: {registrationRef: enrolled.registrationRef, incarnation: enrolled.incarnation,
          affectedRef: workspaceId}, eventRef: raw.eventRef, materialization: wire}});
        previousRaw = raw;
        predecessor = wire;
      }
      const finalHead = await Reflect.apply(readHead, service, [workspaceId]);
      const finalPage = await Reflect.apply(listRaw, service, [{workspaceId, afterSequence, limit}]);
      if (!finalHead || canonicalFinancialSourceJson(finalHead) !== canonicalFinancialSourceJson({
        ...head, materializedSequence: progressSequence, materializedDigest: progressDigest}) ||
        !Array.isArray(finalPage) || canonicalFinancialSourceJson(finalPage) !== canonicalFinancialSourceJson(retainedRaw)) fail();
      for (let index = 0; index < retainedRaw.length; index++) {
        const finalStored = await Reflect.apply(readMaterialization, service, [retainedRaw[index]!.eventRef]);
        if (!finalStored || canonicalFinancialSourceJson(finalStored) !== canonicalFinancialSourceJson(retainedStored[index])) fail();
      }
      const lastSequence = afterSequence + originals.length;
      return structuredClone({kind: "historical", registration: enrolled,
        observedPermissionSequence: head.permissionSequence, observedClosed: head.closed,
        entries: originals, ...(lastSequence < head.permissionSequence ? {nextAfterSequence: lastSequence} : {}),
        pageReachedObservedHead: lastSequence === head.permissionSequence});
    },
    /** Fresh original Control event from this exact canonical facade. Expected
     * source is only an equality filter; neither it nor a WeakMap is authority. */
    async prepareOriginalFinancialControlSource(input: {
      readonly workspaceId: string;
      readonly accountId: TakosumiSubject;
      readonly expectedSource: FinancialSourceControlEvidence["source"];
    }): Promise<{readonly kind: "fresh"; readonly registration: FinancialSourceRegistration; readonly original: AccountsFinancialPreparedOriginal}> {
      const {workspaceId, accountId} = input;
      const expectedSource = structuredClone(input.expectedSource);
      if (!financialSourceRef(workspaceId) || !financialSourceRef(accountId)) unavailable();
      const original = await Reflect.apply(capture, service, [{workspaceId, actorAccountId: accountId}]);
      if (!original || original.workspace.id !== workspaceId || original.member.accountId !== accountId ||
        original.member.workspaceId !== workspaceId || original.member.status !== "active" ||
        original.binding.workspaceId !== workspaceId || original.head.workspaceId !== workspaceId ||
        original.head.closed || original.head.permissionSequence !== original.head.materializedSequence) unavailable();
      const enrolled = registration(original.head);
      const source: FinancialSourceControlEvidence["source"] = {registrationRef: enrolled.registrationRef,
        incarnation: enrolled.incarnation, affectedRef: workspaceId, sequence: original.head.permissionSequence,
        eventRef: original.head.lastEventRef, eventDigest: hex(original.head.materializedDigest), receivers: enrolled.receivers};
      if (canonicalFinancialSourceJson(source) !== canonicalFinancialSourceJson(expectedSource))
        throw new FinancialSourceUnavailable("source_conflict");
      if (source.sequence !== 1 || source.eventRef === null) throw new FinancialSourceUnavailable("source_pending");
      const head = await Reflect.apply(readHead, service, [workspaceId]);
      const raws = await Reflect.apply(listRaw, service, [{workspaceId, afterSequence: 0, limit: 1}]);
      if (!head || canonicalFinancialSourceJson(head) !== canonicalFinancialSourceJson(original.head) ||
        raws.length !== 1) throw new FinancialSourceUnavailable("source_conflict");
      const raw = raws[0]!;
      if (raw.eventRef !== source.eventRef || raw.permissionSequence !== 1 || raw.previousEventRef !== null ||
        raw.workspaceId !== workspaceId || raw.sourceRef !== enrolled.registrationRef ||
        raw.incarnation !== enrolled.incarnation || raw.closed) throw new FinancialSourceUnavailable("source_conflict");
      const stored = await Reflect.apply(readMaterialization, service, [raw.eventRef]);
      if (!stored) throw new FinancialSourceUnavailable("source_pending");
      const wire = await decode(stored, raw);
      const recomputed = await materializeFinancialSourceEvent({registration: enrolled, raw: rawWire(raw)});
      if (canonicalFinancialSourceJson(wire) !== canonicalFinancialSourceJson(recomputed) ||
        wire.eventDigest !== source.eventDigest) throw new FinancialSourceUnavailable("source_conflict");
      if (!(await Reflect.apply(assertCurrent, service, [structuredClone(original)]))) unavailable();
      const finalHead = await Reflect.apply(readHead, service, [workspaceId]);
      const finalRaws = await Reflect.apply(listRaw, service, [{workspaceId, afterSequence: 0, limit: 1}]);
      const finalStored = await Reflect.apply(readMaterialization, service, [raw.eventRef]);
      if (!finalHead || canonicalFinancialSourceJson(finalHead) !== canonicalFinancialSourceJson(head) ||
        finalRaws.length !== 1 || canonicalFinancialSourceJson(finalRaws[0]) !== canonicalFinancialSourceJson(raw) ||
        !finalStored || canonicalFinancialSourceJson(finalStored) !== canonicalFinancialSourceJson(stored) ||
        !(await Reflect.apply(assertCurrent, service, [structuredClone(original)])))
        throw new FinancialSourceUnavailable("source_conflict");
      return structuredClone({kind: "fresh", registration: enrolled,
        original: {key: {registrationRef: enrolled.registrationRef, incarnation: enrolled.incarnation,
          affectedRef: workspaceId}, eventRef: raw.eventRef, materialization: wire}});
    },
    /** One explicit bounded page, never a complete inventory assertion. Lost
     * ACK recovery reads the SAME event before any new delivery attempt. */
    async flush(input: {readonly workspaceId: string; readonly afterSequence: number; readonly limit: number}): Promise<{
      readonly processed: number; readonly nextAfterSequence?: number;
    }> {
      const {workspaceId, afterSequence, limit} = input;
      if (!financialSourceRef(workspaceId) || !Number.isSafeInteger(afterSequence) || afterSequence < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 64) fail();
      const page = await Reflect.apply(listRaw, service, [{workspaceId, afterSequence, limit}]);
      if (!Array.isArray(page) || page.length > limit) fail();
      let processed = 0, previousSequence = afterSequence;
      for (const raw of page) {
        if (raw.workspaceId !== workspaceId || raw.permissionSequence !== previousSequence + 1) fail();
        // Capture the FULL head BEFORE asynchronous codec/SHA preparation.
        const head = await Reflect.apply(readHead, service, [workspaceId]);
        if (!head || head.workspaceId !== raw.workspaceId || head.sourceRef !== raw.sourceRef || head.incarnation !== raw.incarnation) fail();
        const enrolled = registration(head);
        for (const required of enrolled.receivers) {
          if (receivers.get(required.receiverRef)?.targetRef !== required.targetRef) throw new FinancialSourceUnavailable("source_unavailable");
        }
        let predecessor: FinancialSourceMaterialization | undefined;
        if (raw.previousEventRef !== null) {
          const prior = await Reflect.apply(readMaterialization, service, [raw.previousEventRef]);
          const originals = await Reflect.apply(listRaw, service, [{workspaceId, afterSequence: raw.permissionSequence - 2, limit: 1}]);
          if (!prior || originals.length !== 1 || originals[0]!.eventRef !== raw.previousEventRef ||
            originals[0]!.permissionSequence !== raw.permissionSequence - 1) fail();
          predecessor = await decode(prior, originals[0]!);
        }
        const wire = await materializeFinancialSourceEvent({registration: enrolled, raw: rawWire(raw), predecessor});
        const expected: WorkspaceFinancialMaterialization = {eventRef: raw.eventRef, sourceRef: raw.sourceRef, incarnation: raw.incarnation,
          permissionSequence: raw.permissionSequence, rawPayloadJson: raw.payloadJson, previousDigest: wire.event.previousDigest.slice(7),
          wireJson: canonicalFinancialSourceJson(wire.event), digest: wire.eventDigest.slice(7)};
        const stored = await Reflect.apply(readMaterialization, service, [raw.eventRef]);
        if (stored) {
          if (stored.rawPayloadJson !== expected.rawPayloadJson ||
            canonicalFinancialSourceJson({...stored, rawPayloadJson: ""}) !==
              canonicalFinancialSourceJson({...expected, rawPayloadJson: ""})) fail();
          await decode(stored, raw);
        } else if (!(await Reflect.apply(materialize, service, [{original: structuredClone(raw), expectedHead: structuredClone(head), materialization: expected}]))) fail();
        for (const required of enrolled.receivers) {
          const configured = receivers.get(required.receiverRef)!;
          const found = await Reflect.apply(configured.read, configured.receiver, [structuredClone(wire)]);
          const receipt = parseFinancialSourceReceipt(found === undefined ?
            await Reflect.apply(configured.deliver, configured.receiver, [structuredClone(wire)]) : found);
          const expectedReceipt = await makeFinancialSourceReceipt({registrationRef: enrolled.registrationRef,
            receiverRef: required.receiverRef, targetRef: required.targetRef, event: wire.event, eventDigest: wire.eventDigest});
          if (canonicalFinancialSourceJson(receipt) !== canonicalFinancialSourceJson(expectedReceipt) ||
            !(await Reflect.apply(recordReceipt, service, [{eventRef: raw.eventRef, sourceRef: raw.sourceRef, incarnation: raw.incarnation,
              permissionSequence: raw.permissionSequence, receiverRef: required.receiverRef, targetRef: required.targetRef,
              digest: wire.eventDigest.slice(7), receiptRef: receipt.receiptRef, receiptJson: canonicalFinancialSourceJson(receipt)}]))) fail();
        }
        processed++;
        previousSequence = raw.permissionSequence;
      }
      return {processed, ...(page.length === limit ? {nextAfterSequence: previousSequence} : {})};
    },
  };
}

function anchoredClock(): () => number {
  const wall = Date.now(), monotonic = performance.now();
  return () => Math.floor(wall + performance.now() - monotonic);
}
function unavailable(): never { throw new FinancialSourceUnavailable("source_unavailable"); }
function invalidGrant(): never { throw new FinancialSourceUnavailable("invalid_grant"); }
