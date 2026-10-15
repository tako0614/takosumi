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
  FinancialSourceMaterializationRecord,
  FinancialSourceControlEvidence,
} from "./identity-state.ts";
import {
  canonicalFinancialSourceJson, financialSourceRef,
  financialSourceEventDigest, hashFinancialSourceValue, parseFinancialSourceEvent,
  materializeFinancialSourceEvent, parseFinancialIdentityChallenge,
  parseFinancialSourceRegistration, parseFinancialSourceReceipt,
  financialReceiptMatches, FINANCIAL_SOURCE_MAX_PAGE,
  type FinancialSourceRegistration,
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
} from "../../../core/domains/workspaces/financial-source.ts";

const checkpointLifetime = 1_000;
const proofLifetime = 60_000;
const slots = ["grant", "issuerSession", "client", "accountGeneration"] as const;
type MutableVector<T> = { -readonly [K in keyof FinancialSourceParentVector<T>]: T };
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
    /** Input conveys the actual grant and a Financial-owned challenge REF only.
     * The proof identifies current identity/context, never a Principal or payer. */
    async prove(input: {readonly accessToken: string; readonly challengeRef: string}): Promise<{readonly proofRef: string}> {
      // Capture mutable local input BEFORE the first await. A later mutation
      // must not select a different token, challenge or recovery key.
      const {accessToken, challengeRef} = input;
      capabilities();
      if (!financialSourceRef(challengeRef)) throw new FinancialSourceUnavailable("invalid_challenge");
      const challenge = parseFinancialIdentityChallenge(await Reflect.apply(readChallenge!, challengeOwner, [challengeRef]));
      if (challenge.challengeRef !== challengeRef || challenge.registrationRef !== registration.registrationRef || challenge.createdAt > now() || challenge.expiresAt <= now()) throw new FinancialSourceUnavailable("invalid_challenge");
      const registered = await store.findFinancialSourceRegistration!(registration.registrationRef);
      if (!registered || canonicalFinancialSourceJson(registered) !== canonicalFinancialSourceJson(registration)) unavailable();
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
        const challengeNow = parseFinancialIdentityChallenge(await Reflect.apply(readChallenge!, challengeOwner, [challengeRef]));
        if (canonicalFinancialSourceJson(challengeNow) !== canonicalFinancialSourceJson(challenge) || challengeNow.expiresAt <= now())
          throw new FinancialSourceUnavailable("invalid_challenge");
        const record = (await current(accessToken)).record;
        // Storage readers legitimately project absent optional columns as own
        // undefined properties. This comparison is not a closed wire record;
        // normalize that storage representation without relaxing the codec.
        if (canonicalFinancialSourceJson(JSON.parse(JSON.stringify(record))) !==
          canonicalFinancialSourceJson(JSON.parse(JSON.stringify(original.record)))) invalidGrant();
        const grant = await store.findHostedOidcGrant!(record.sid!);
        const generation = await store.getAccountAuthenticationGeneration!(subject);
        if (!grant || generation !== (record.identityGeneration ?? 0)) invalidGrant();
        if (!(await Reflect.apply(assertCurrent!, control, [snapshot]))) unavailable();
        return {registration, challenge, accessToken: accessToken, accessTokenHash, expectedAccess: record,
          expectedGrant: structuredClone(grant), expectedIdentityGeneration: generation, control: structuredClone(snapshot.evidence), now: now()};
      };
      const enrollment = await checkpoint<import("./identity-state.ts").FinancialSourceEnrollmentMutation>({...await verify(), evidenceRef: challenge.challengeRef, parents});
      const heads = await store.enrollFinancialSourceParents!(enrollment);
      if (!heads) throw new FinancialSourceUnavailable("source_conflict");
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
  const snapshots = new WeakMap<object, {original: WorkspaceFinancialSourceSnapshot; binding: string; expiresAt: number}>();
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
      const original = await Reflect.apply(capture, service, [{workspaceId, actorAccountId: accountId}]);
      if (!original || original.workspace.id !== workspaceId || original.member.workspaceId !== workspaceId ||
        original.member.accountId !== accountId || original.member.status !== "active" || original.head.closed ||
        original.binding.workspaceId !== workspaceId || original.head.workspaceId !== workspaceId ||
        original.binding.organizationRef !== original.head.organizationRef || original.binding.workspaceRef !== original.head.workspaceRef ||
        original.head.permissionSequence !== original.head.materializedSequence) return undefined;
      const enrolled = registration(original.head);
      // Storage has legitimate absent optional columns. Normalize only their
      // representation; the exact ORIGINAL Core object is retained privately.
      const digest = await hashFinancialSourceValue("takosumi.financial-source-control-evidence@v1", JSON.parse(JSON.stringify(original)));
      if (!(await Reflect.apply(assertCurrent, service, [original]))) return undefined;
      const issuedAt = now();
      if (!Number.isSafeInteger(issuedAt + proofLifetime)) return undefined;
      const result: AccountsFinancialControlSnapshot = {workspaceId, accountId,
        organizationId: original.binding.organizationRef, workspaceRef: original.binding.workspaceRef,
        evidence: {evidenceRef: `cfe_${digest.slice(7)}`, evidenceDigest: digest, expiresAt: issuedAt + proofLifetime,
          source: {registrationRef: enrolled.registrationRef, incarnation: enrolled.incarnation, affectedRef: original.workspace.id,
            sequence: original.head.permissionSequence, eventRef: original.head.lastEventRef,
            eventDigest: hex(original.head.materializedDigest), receivers: enrolled.receivers}}};
      snapshots.set(result, {original: structuredClone(original), binding: canonicalFinancialSourceJson(result), expiresAt: result.evidence.expiresAt});
      return result;
    },
    async assertCurrent(snapshot: AccountsFinancialControlSnapshot): Promise<boolean> {
      const retained = snapshots.get(snapshot);
      if (!retained || now() >= retained.expiresAt) return false;
      try { if (canonicalFinancialSourceJson(snapshot) !== retained.binding) return false; } catch { return false; }
      const current = await Reflect.apply(assertCurrent, service, [structuredClone(retained.original)]);
      return current && now() < retained.expiresAt && canonicalFinancialSourceJson(snapshot) === retained.binding;
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
