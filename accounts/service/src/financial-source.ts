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
  materializeFinancialSourceEvent, parseFinancialIdentityChallenge,
  parseFinancialSourceRegistration, parseFinancialSourceReceipt,
  financialReceiptMatches, FINANCIAL_SOURCE_MAX_PAGE,
  type FinancialSourceRegistration,
  type FinancialSourceMaterialization, type FinancialSourceReceipt,
} from "./financial-source-contract.ts";
import { hostedGrantIsActive, hostedOpaqueId } from "./hosted-oidc-profile.ts";
import { sha256Text } from "./encoding.ts";
import {
  parseFinancialIdentityProofRequest, projectFinancialIdentityProof,
  type FinancialIdentityProofRequest, type FinancialIdentityProofLoadResult,
  type FinancialIdentityProofCurrentResult,
} from "./financial-source-abi.ts";

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
  /** Trusted in-process clock injection, never request or wire timestamps. */
  readonly now?: () => number;
}

export class FinancialSourceUnavailable extends Error {
  constructor(readonly code: "source_unavailable" | "invalid_grant" | "invalid_challenge" | "source_pending" | "source_conflict") { super(code); }
}

/** All callbacks and configuration are captured before any request await.
 * Reflect.apply is local: no .bind property lookup on Worker RPC callables. */
export function createAccountsFinancialSource(options: AccountsFinancialSourceOptions) {
  const store = options.store;
  const issuer = options.issuer;
  const registration = parseFinancialSourceRegistration(structuredClone(options.registration));
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
      !store.enrollFinancialSourceParents || !store.issueFinancialSourceProof ||
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
  return {
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
      const request = parseFinancialIdentityProofRequest(value);
      capabilities();
      if (!store.findFinancialSourceProof || !store.findAccessTokenByHash) unavailable();
      const proof = await store.findFinancialSourceProof(request.proofRef);
      const notCurrent = {v: 1, status: "not-current"} as const;
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
    },
    /** Input conveys the actual grant and a Financial-owned challenge REF only.
     * The proof identifies current identity/context, never a Principal or payer. */
    async prove(input: {readonly accessToken: string; readonly challengeRef: string}): Promise<{readonly proofRef: string}> {
      capabilities();
      if (!financialSourceRef(input.challengeRef)) throw new FinancialSourceUnavailable("invalid_challenge");
      const challenge = parseFinancialIdentityChallenge(await Reflect.apply(readChallenge!, challengeOwner, [input.challengeRef]));
      if (challenge.challengeRef !== input.challengeRef || challenge.registrationRef !== registration.registrationRef || challenge.createdAt > now() || challenge.expiresAt <= now()) throw new FinancialSourceUnavailable("invalid_challenge");
      const registered = await store.findFinancialSourceRegistration!(registration.registrationRef);
      if (!registered || canonicalFinancialSourceJson(registered) !== canonicalFinancialSourceJson(registration)) unavailable();
      const original = await current(input.accessToken);
      if (original.client.clientId !== challenge.clientId) invalidGrant();
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
      const accessTokenHash = await sha256Text(input.accessToken);
      const verify = async (): Promise<Omit<FinancialSourceAuthoritySnapshot, "precommitCheckpoint">> => {
        const challengeNow = parseFinancialIdentityChallenge(await Reflect.apply(readChallenge!, challengeOwner, [input.challengeRef]));
        if (canonicalFinancialSourceJson(challengeNow) !== canonicalFinancialSourceJson(challenge) || challengeNow.expiresAt <= now())
          throw new FinancialSourceUnavailable("invalid_challenge");
        const record = (await current(input.accessToken)).record;
        // Storage readers legitimately project absent optional columns as own
        // undefined properties. This comparison is not a closed wire record;
        // normalize that storage representation without relaxing the codec.
        if (canonicalFinancialSourceJson(JSON.parse(JSON.stringify(record))) !==
          canonicalFinancialSourceJson(JSON.parse(JSON.stringify(original.record)))) invalidGrant();
        const grant = await store.findHostedOidcGrant!(record.sid!);
        const generation = await store.getAccountAuthenticationGeneration!(subject);
        if (!grant || generation !== (record.identityGeneration ?? 0)) invalidGrant();
        if (!(await Reflect.apply(assertCurrent!, control, [snapshot]))) unavailable();
        return {registration, challenge, accessToken: input.accessToken, accessTokenHash, expectedAccess: record,
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
      const proof: FinancialSourceProofRecord = {v: 1, proofRef: hostedOpaqueId("afp_"), challenge, issuer, subject,
        accessTokenHash, accessExpiresAt: authority.expectedAccess.expiresAt,
        clientId: challenge.clientId, sid: original.record.sid!, issuerSessionId: original.record.issuerSessionId!, identityGeneration: authority.expectedIdentityGeneration,
        control: authority.control, parents: refs, issuedAt, expiresAt: Math.min(issuedAt + proofLifetime, challenge.expiresAt,
          authority.expectedAccess.expiresAt, authority.expectedGrant.absoluteExpiresAt, authority.control.expiresAt)};
      const result = await store.issueFinancialSourceProof!(await checkpoint<import("./identity-state.ts").FinancialSourceProofMutation>({...authority, expectedParents: heads, proof}));
      if (!result || result.proofRef !== proof.proofRef) throw new FinancialSourceUnavailable("source_conflict");
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

function anchoredClock(): () => number {
  const wall = Date.now(), monotonic = performance.now();
  return () => Math.floor(wall + performance.now() - monotonic);
}
function unavailable(): never { throw new FinancialSourceUnavailable("source_unavailable"); }
function invalidGrant(): never { throw new FinancialSourceUnavailable("invalid_grant"); }
