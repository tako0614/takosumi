import type { OwnerOperationKind, OwnerOperationTarget } from "./owner-operation-contract.ts";
import type { ReviewedRecoveryReviewIssuer } from "./reviewed-recovery-approvals.ts";
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
export interface ReviewedRecoveryIssuerAvailabilityReader {
  readonly [availabilityReader]: true;
  readonly isAvailable: (request: ReviewedRecoveryIssuerAvailabilityRequest) => Promise<boolean>;
}

const readers = new WeakMap<object, OwnerOperationTarget>();

/** Object identity is required; a copied method, descriptor or boolean is not
 * an issuer availability capability. The callee should also pin its target. */
export function isReviewedRecoveryIssuerAvailabilityReader(value: unknown, expectedTarget?: OwnerOperationTarget): value is ReviewedRecoveryIssuerAvailabilityReader {
  if (!value || typeof value !== "object") return false;
  const target = readers.get(value);
  return !!target && (expectedTarget === undefined || (validOwnerTarget(expectedTarget) && canonicalOwnerJson(target) === canonicalOwnerJson(expectedTarget)));
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
  const reader = Object.freeze({ async isAvailable(request: ReviewedRecoveryIssuerAvailabilityRequest): Promise<boolean> {
    if (!configured) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      if (!exactKeys(request, ["operationId", "kind", "planDigest"]) || !boundedText(request.operationId) || !boundedText(request.planDigest) || !kinds.includes(request.kind)) return false;
      const startedAt = clock();
      if (!validTime(startedAt) || !Number.isSafeInteger(startedAt + lifetimeMs)) return false;
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
      if (controller.signal.aborted || !freshAt(challenge, afterTransport, timeoutMs)) return false;
      const record = structuredClone(result) as ReviewedRecoveryIssuerAvailabilityStatus;
      if (!validStatus(record) || canonicalOwnerJson(record.challenge) !== canonicalOwnerJson(challenge) ||
        record.attestation.issuer !== issuer!.issuer || record.attestation.keyId !== issuer!.keyId) return false;
      const encoded = record.attestation.signature;
      const signature = Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/") + "=="), (char) => char.charCodeAt(0));
      if (signature.byteLength !== 64 || base64UrlEncodeBytes(signature) !== encoded || !await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" }, key!, signature.buffer as ArrayBuffer,
        reviewedRecoveryIssuerAvailabilitySignatureInput(record).buffer as ArrayBuffer,
      )) return false;
      const afterVerification = clock();
      return !controller.signal.aborted && afterVerification >= afterTransport && freshAt(challenge, afterVerification, timeoutMs) && record.status === "available";
    } catch { return false; }
    finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  } }) as ReviewedRecoveryIssuerAvailabilityReader;
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
