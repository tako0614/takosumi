import type { OwnerOperationKind, OwnerOperationTarget } from "./owner-operation-contract.ts";
import type { ReviewedRecoveryReviewIssuer } from "./reviewed-recovery-approvals.ts";
import type { IdentityMergeMutation } from "./identity-state.ts";
import { boundedText, canonicalOwnerJson, validOwnerTarget } from "./owner-operation-evidence.ts";
import { base64UrlEncodeBytes } from "./encoding.ts";

const challengeVersion = "takosumi.accounts.review-issuer-availability-challenge@v1";
const statusVersion = "takosumi.accounts.review-issuer-availability@v1";
const signatureDomain = "takosumi.accounts.review-issuer-availability-signature@v1:";
const lifetimeMs = 5000;
const kinds = ["merge", "unlink", "abort-before-active", "restore-after-active"];

export interface ReviewedRecoveryIssuerAvailabilityRequest {
  readonly operationId: string;
  readonly kind: OwnerOperationKind;
  readonly planDigest: string;
}

export interface ReviewedRecoveryIssuerAvailabilityChallenge extends ReviewedRecoveryIssuerAvailabilityRequest {
  readonly version: typeof challengeVersion;
  readonly target: OwnerOperationTarget;
  /** Separately qualified private service identity, never an OAuth RP client. */
  readonly clientId: string;
  readonly environment: "staging";
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface ReviewedRecoveryIssuerAvailabilityStatus {
  readonly version: typeof statusVersion;
  readonly status: "available" | "unavailable";
  readonly challenge: ReviewedRecoveryIssuerAvailabilityChallenge;
  readonly attestation: {
    readonly algorithm: "ES256";
    readonly issuer: string;
    readonly keyId: string;
    readonly signature: string;
  };
}

declare const availabilityReader: unique symbol;
declare const availabilityCheckpoint: unique symbol;
/** Process-local, transient dispatch capability. Never serialize or retain in
 * an audit record, durable operation, SQL argument or RPC response. */
export interface ReviewedRecoveryIssuerAvailabilityCheckpoint {
  readonly [availabilityCheckpoint]: true;
}
export interface ReviewedRecoveryIssuerAvailabilityReader {
  readonly [availabilityReader]: true;
  readonly isAvailable: (request: ReviewedRecoveryIssuerAvailabilityRequest) => Promise<boolean>;
  readonly getAvailabilityCheckpoint: (request: ReviewedRecoveryIssuerAvailabilityRequest) => Promise<ReviewedRecoveryIssuerAvailabilityCheckpoint | undefined>;
}

const readers = new WeakMap<object, OwnerOperationTarget>();
interface CheckpointState {
  readonly reader: ReviewedRecoveryIssuerAvailabilityReader;
  readonly challenge: ReviewedRecoveryIssuerAvailabilityChallenge;
  readonly clock: () => number;
  readonly timeoutMs: number;
  lastNow: number;
  invalid?: true;
  binding?: {
    readonly mutation: string;
    readonly initialNow: number;
    readonly notBefore: number;
    readonly expiresAtExclusive: number;
  };
}
const checkpoints = new WeakMap<object, CheckpointState>();

/** Object identity is required; a copied method, descriptor or boolean is not
 * an issuer availability capability. The callee should also pin its target. */
export function isReviewedRecoveryIssuerAvailabilityReader(value: unknown, expectedTarget?: OwnerOperationTarget): value is ReviewedRecoveryIssuerAvailabilityReader {
  if (!value || typeof value !== "object") return false;
  const target = readers.get(value);
  return !!target && (expectedTarget === undefined || (validOwnerTarget(expectedTarget) && canonicalOwnerJson(target) === canonicalOwnerJson(expectedTarget)));
}

/** Called only by the trusted consent composition after all final snapshot
 * reads and the SAME signed status call. Bounds must include operation,
 * session idle/absolute, proof, context, email and any owning-capture expiry;
 * inclusive email max-age becomes observedAt + maxAge + 1 (integer ms).
 * No asynchronous hashing or second remote proof occurs here.
 *
 * The first binding captures the entire mutation except its refreshed local
 * `now` and the checkpoint itself. Identical binding is idempotent while fresh;
 * a different snapshot cannot repurpose this checkpoint. */
export function bindReviewedRecoveryIssuerAvailabilityCheckpoint(checkpoint: unknown, input: {
  readonly target: OwnerOperationTarget;
  readonly mutation: IdentityMergeMutation;
  readonly notBefore: number;
  readonly expiresAtExclusive: number;
}): boolean {
  try {
    const state = checkpointState(checkpoint), mutation = input.mutation;
    if (!state || !isReviewedRecoveryIssuerAvailabilityReader(state.reader, input.target) ||
      !validReserveMutation(state, mutation) || !validTime(input.notBefore) || !validTime(input.expiresAtExclusive) ||
      input.notBefore < mutation.now || input.expiresAtExclusive <= input.notBefore) return false;
    const now = checkpointNow(state);
    if (now === undefined || now < input.notBefore || now >= input.expiresAtExclusive || mutation.now > now) return false;
    const binding = { mutation: mutationSnapshot(mutation), initialNow: mutation.now,
      notBefore: input.notBefore, expiresAtExclusive: input.expiresAtExclusive };
    if (state.binding) return canonicalOwnerJson(state.binding) === canonicalOwnerJson(binding);
    state.binding = binding;
    return true;
  } catch { return false; }
}

/** Synchronous, non-consuming peek AFTER all backend async preparation. Use
 * its captured trusted time for local input.now, revalidate current snapshots,
 * and build every SQL/JSON value synchronously before the final consume. */
export function readReviewedRecoveryIssuerAvailabilityCheckpoint(checkpoint: unknown, mutation: IdentityMergeMutation): number | undefined {
  try {
    const state = checkpointState(checkpoint), binding = state?.binding;
    if (!state || !binding || !validReserveMutation(state, mutation) || mutation.now < binding.initialNow ||
      mutationSnapshot(mutation) !== binding.mutation) return undefined;
    const now = checkpointNow(state);
    return now !== undefined && now >= binding.notBefore && now < binding.expiresAtExclusive && mutation.now <= now ? now : undefined;
  } catch { return undefined; }
}

/** One final attempt consumes the original object even if that attempt fails.
 * Call immediately before memory mutation/D1 batch/PG query, with NO await in
 * between. Concurrent reuse and retry require a new signed-status exchange.
 * This fences local dispatch, not database server execution or distributed
 * commit; existing durable CAS/current-state checks remain mandatory. */
export function consumeReviewedRecoveryIssuerAvailabilityCheckpoint(checkpoint: unknown, mutation: IdentityMergeMutation): number | undefined {
  const now = readReviewedRecoveryIssuerAvailabilityCheckpoint(checkpoint, mutation);
  if (checkpoint && typeof checkpoint === "object") checkpoints.delete(checkpoint);
  return now;
}

function checkpointState(value: unknown): CheckpointState | undefined {
  return value && typeof value === "object" ? checkpoints.get(value) : undefined;
}
function checkpointNow(state: CheckpointState): number | undefined {
  if (state.invalid || !isReviewedRecoveryIssuerAvailabilityReader(state.reader, state.challenge.target)) return undefined;
  let now: number;
  try { now = state.clock(); } catch { state.invalid = true; return undefined; }
  if (!freshAt(state.challenge, now, state.timeoutMs) || now < state.lastNow) { state.invalid = true; return undefined; }
  state.lastNow = now;
  return now;
}
function validReserveMutation(state: CheckpointState, mutation: IdentityMergeMutation): boolean {
  const next = mutation?.next;
  return state.challenge.kind === "merge" && !!next && mutation.reserve === true &&
    !mutation.activate && !mutation.quarantine && !mutation.restore && !mutation.abort && !mutation.requireRecovery &&
    validTime(mutation.now) && validTime(mutation.expectedRevision) && next.revision === mutation.expectedRevision + 1 &&
    next.operationId === state.challenge.operationId && next.contextPlan?.planDigest === state.challenge.planDigest &&
    boundedText(next.sourceSubject) && boundedText(next.targetSubject) && next.sourceSubject !== next.targetSubject;
}
function mutationSnapshot(mutation: IdentityMergeMutation): string {
  const { now: _now, availabilityCheckpoint: _checkpoint, ...snapshot } = mutation as IdentityMergeMutation & { availabilityCheckpoint?: unknown };
  return canonicalOwnerJson(snapshot);
}

/** Separate signature domain: even a valid availability signature can never
 * establish a human decision, approval reference or recovery ID. */
export function reviewedRecoveryIssuerAvailabilitySignatureInput(record: Pick<ReviewedRecoveryIssuerAvailabilityStatus, "version" | "status" | "challenge"> & {
  readonly attestation: Pick<ReviewedRecoveryIssuerAvailabilityStatus["attestation"], "algorithm" | "issuer" | "keyId">;
}): Uint8Array {
  const { algorithm, issuer, keyId } = record.attestation;
  return new TextEncoder().encode(signatureDomain + canonicalOwnerJson({ version: record.version, status: record.status,
    challenge: record.challenge, attestation: { algorithm, issuer, keyId } }));
}

/** TRUSTED owning-release/operator composition seam, not a qualification API.
 * Before integration, that owner must independently qualify actual issuer/key,
 * private-client and target custody. No such production qualification exists
 * here. Never construct this from env strings, deployment graph metadata,
 * descriptors, method presence or a caller-supplied boolean. No transport,
 * endpoint, key or affirmative default is inferred. Synthetic fixtures may
 * supply ephemeral keys and a real in-memory signed-status exchange.
 *
 * The response proves only current issuer AVAILABILITY. Per-operation human
 * review remains a separate signed approval and durable authority check. */
export function createReviewedRecoveryIssuerAvailabilityReader(input: {
  readonly reviewIssuer?: ReviewedRecoveryReviewIssuer;
  readonly target: OwnerOperationTarget;
  readonly clientId: string;
  readonly environment: "staging";
  readonly readSignedStatus?: (challenge: ReviewedRecoveryIssuerAvailabilityChallenge, context: { readonly signal: AbortSignal }) => Promise<unknown>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}): ReviewedRecoveryIssuerAvailabilityReader {
  const target = Object.freeze(structuredClone(input.target));
  const issuer = input.reviewIssuer && Object.freeze({ ...input.reviewIssuer });
  const clientId = input.clientId, environment = input.environment;
  const transport = input.readSignedStatus, clock = input.now ?? Date.now;
  const timeoutMs = input.timeoutMs ?? 1000;
  const key = issuer?.publicKey;
  const configured = validOwnerTarget(target) && boundedText(clientId) && environment === "staging" &&
    !!issuer && boundedText(issuer.issuer) && boundedText(issuer.keyId) &&
    key?.type === "public" && key.algorithm.name === "ECDSA" && (key.algorithm as EcKeyAlgorithm).namedCurve === "P-256" && key.usages.includes("verify") &&
    typeof transport === "function" && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= lifetimeMs;
  async function getAvailabilityCheckpoint(request: ReviewedRecoveryIssuerAvailabilityRequest): Promise<ReviewedRecoveryIssuerAvailabilityCheckpoint | undefined> {
    if (!configured) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      if (!exactKeys(request, ["operationId", "kind", "planDigest"]) || !boundedText(request.operationId) || !boundedText(request.planDigest) || !kinds.includes(request.kind)) return undefined;
      const startedAt = clock();
      if (!validTime(startedAt) || !Number.isSafeInteger(startedAt + lifetimeMs)) return undefined;
      const challenge: ReviewedRecoveryIssuerAvailabilityChallenge = Object.freeze({ version: challengeVersion,
        operationId: request.operationId, kind: request.kind, planDigest: request.planDigest,
        target, clientId, environment, nonce: base64UrlEncodeBytes(crypto.getRandomValues(new Uint8Array(32))),
        issuedAt: startedAt, expiresAt: startedAt + lifetimeMs });
      // A nonce lives only inside this invocation. Its single transport result
      // is consumed here; no caller can redeem it or supply a reusable proof.
      const deadline = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(undefined); }, timeoutMs);
      });
      const result = await Promise.race([Promise.resolve().then(() => transport!(challenge, { signal: controller.signal })), deadline]);
      const afterTransport = clock();
      if (controller.signal.aborted || !freshAt(challenge, afterTransport, timeoutMs)) return undefined;
      const record = structuredClone(result) as ReviewedRecoveryIssuerAvailabilityStatus;
      if (!validStatus(record) || canonicalOwnerJson(record.challenge) !== canonicalOwnerJson(challenge) ||
        record.attestation.issuer !== issuer!.issuer || record.attestation.keyId !== issuer!.keyId) return undefined;
      const encoded = record.attestation.signature;
      const signature = Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/") + "=="), (char) => char.charCodeAt(0));
      if (signature.byteLength !== 64 || base64UrlEncodeBytes(signature) !== encoded || !await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" }, key!, signature.buffer as ArrayBuffer,
        reviewedRecoveryIssuerAvailabilitySignatureInput(record).buffer as ArrayBuffer,
      )) return undefined;
      const afterVerification = clock();
      if (controller.signal.aborted || afterVerification < afterTransport || !freshAt(challenge, afterVerification, timeoutMs) || record.status !== "available") return undefined;
      const checkpoint = Object.freeze({}) as ReviewedRecoveryIssuerAvailabilityCheckpoint;
      checkpoints.set(checkpoint, { reader, challenge, clock, timeoutMs, lastNow: afterVerification });
      return checkpoint;
    } catch { return undefined; }
    finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  }
  const reader = Object.freeze({ getAvailabilityCheckpoint,
    async isAvailable(request: ReviewedRecoveryIssuerAvailabilityRequest): Promise<boolean> { return !!await getAvailabilityCheckpoint(request); },
  }) as ReviewedRecoveryIssuerAvailabilityReader;
  readers.set(reader, target);
  return reader;
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function validTime(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function freshAt(challenge: ReviewedRecoveryIssuerAvailabilityChallenge, now: number, timeoutMs: number): boolean {
  return validTime(now) && now >= challenge.issuedAt && now < challenge.expiresAt && now - challenge.issuedAt < timeoutMs;
}
function validStatus(value: ReviewedRecoveryIssuerAvailabilityStatus): boolean {
  if (!exactKeys(value, ["version", "status", "challenge", "attestation"]) || JSON.stringify(value).length > 8192 ||
    value.version !== statusVersion || !["available", "unavailable"].includes(value.status)) return false;
  const c = value.challenge, a = value.attestation;
  return exactKeys(c, ["version", "operationId", "kind", "planDigest", "target", "clientId", "environment", "nonce", "issuedAt", "expiresAt"]) &&
    c.version === challengeVersion && [c.operationId, c.planDigest, c.clientId].every(boundedText) && kinds.includes(c.kind) &&
    validOwnerTarget(c.target) && c.environment === "staging" && typeof c.nonce === "string" && /^[A-Za-z0-9_-]{43}$/u.test(c.nonce) &&
    validTime(c.issuedAt) && validTime(c.expiresAt) && c.expiresAt > c.issuedAt && c.expiresAt <= c.issuedAt + lifetimeMs &&
    exactKeys(a, ["algorithm", "issuer", "keyId", "signature"]) && a.algorithm === "ES256" && [a.issuer, a.keyId].every(boundedText) &&
    typeof a.signature === "string" && /^[A-Za-z0-9_-]{86}$/u.test(a.signature);
}
