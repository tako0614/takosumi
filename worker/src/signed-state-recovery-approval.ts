/** Purpose-specific operator signatures, independent of Accounts and sessions. */
import { sha256Digest, stableStringify, toArrayBuffer } from "../../core/adapters/source/digest.ts";
import {
  PRIVATE_STATE_STAGE_PURPOSE as STAGE, PRIVATE_STATE_COMMIT_PURPOSE as COMMIT,
  assertPrivateStateRecoveryApproval, PrivateStateRecoveryRefusal,
  type PrivateStateStageApproval,
  type PrivateStateCommitApproval, type QualifiedStateRecoveryApprovalPort,
} from "./private-state-recovery-approval.ts";

const FORMAT = "takosumi.worker.signed-state-recovery-approval/v1";
const DOMAIN = "takosumi.worker.state-recovery-approval-signature/v1";
const HOLDER_DOMAIN = "takosumi.worker.state-recovery-holder/v1";
const MAX_PAYLOAD_BYTES = 16 * 1024;
const encoder = new TextEncoder();
type HolderDigest = PrivateStateStageApproval["plaintextSha256"];
type Purpose = typeof STAGE | typeof COMMIT;

export interface SignedStateRecoveryApprovalRecord {
  readonly format: typeof FORMAT;
  /** Canonical exact JSON, including the domain, fixed issuer/key and closed DTO. */
  readonly payload: string;
  /** Canonical unpadded base64url of the 64-byte Web Crypto ES256 signature. */
  readonly signature: string;
}
export interface IssuedStateRecoveryApproval {
  /** Private bearer material for the explicitly intended holder/channel only. */
  readonly approvalRef: string;
  readonly holderProofDigest: HolderDigest;
  readonly record: SignedStateRecoveryApprovalRecord;
}
export interface CurrentSignedStateRecoveryApprovalLookup {
  /**
   * Fresh authoritative lookup on every call. Absence or a revoked decision
   * must not return an old active row. Only the domain-separated digest crosses
   * this port; never the raw proof. No persistence backend/schema is supplied.
   */
  readCurrentSignedStateRecoveryApproval(input: {
    readonly holderProofDigest: HolderDigest;
  }): Promise<unknown>;
}
interface Identity {
  readonly issuer: string;
  readonly keyId: string;
  readonly selectedTargetId: string;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identity(input: Identity): void {
  if (![input.issuer, input.keyId].every(value => typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) ||
    typeof input.selectedTargetId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(input.selectedTargetId)) throw new PrivateStateRecoveryRefusal();
}
function keyValid(key: CryptoKey, type: "private" | "public", usage: "sign" | "verify"): boolean {
  return key?.type === type && key.algorithm.name === "ECDSA" &&
    (key.algorithm as EcKeyAlgorithm).namedCurve === "P-256" &&
    key.usages.length === 1 && key.usages[0] === usage;
}
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function decode(value: string, size: number): Uint8Array {
  if (typeof value !== "string" || value.length !== Math.ceil(size * 8 / 6) || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new PrivateStateRecoveryRefusal();
  }
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0));
  if (bytes.length !== size || encode(bytes) !== value) throw new PrivateStateRecoveryRefusal();
  return bytes;
}
async function holderDigest(bytes: Uint8Array): Promise<HolderDigest> {
  const prefix = encoder.encode(HOLDER_DOMAIN + "\0");
  const input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix); input.set(bytes, prefix.length);
  return await sha256Digest(input) as HolderDigest;
}
function activeSnapshot(value: unknown): SignedStateRecoveryApprovalRecord {
  if (!record(value) || !exactKeys(value, ["status", "record"]) || value.status !== "active" ||
    !record(value.record) || !exactKeys(value.record, ["format", "payload", "signature"])) {
    throw new PrivateStateRecoveryRefusal();
  }
  const row = value.record;
  if (row.format !== FORMAT || typeof row.payload !== "string" || row.payload.length > MAX_PAYLOAD_BYTES ||
    encoder.encode(row.payload).length > MAX_PAYLOAD_BYTES || typeof row.signature !== "string") {
    throw new PrivateStateRecoveryRefusal();
  }
  // Detach every signed scalar from a mutable lookup result before further awaits.
  return Object.freeze({ format: FORMAT, payload: row.payload, signature: row.signature });
}
function approvalSnapshot(payload: string, config: Identity, purpose: Purpose, digest: HolderDigest, now: number) {
  const value: unknown = JSON.parse(payload);
  if (!record(value) || !exactKeys(value, ["domain", "algorithm", "issuer", "keyId", "holderProofDigest", "approval"]) ||
    stableStringify(value) !== payload || value.domain !== DOMAIN || value.algorithm !== "ES256" ||
    value.issuer !== config.issuer || value.keyId !== config.keyId || value.holderProofDigest !== digest) {
    throw new PrivateStateRecoveryRefusal();
  }
  assertPrivateStateRecoveryApproval(value.approval, purpose, config.selectedTargetId, now);
  return Object.freeze({ ...value.approval });
}

/**
 * Explicit signing only. The owner supplies a qualified private P-256 key and
 * a complete separately reviewed record for each purpose. Never auto-publishes
 * a current row or derives commit authority from a stage receipt.
 */
export function createSignedStateRecoveryApprovalIssuer(input: Identity & {
  readonly signingKey: CryptoKey;
  readonly now?: () => number;
}) {
  const { issuer, keyId, selectedTargetId, signingKey } = input;
  const config = Object.freeze({ issuer, keyId, selectedTargetId });
  const clock = input.now ?? Date.now;
  identity(config);
  if (!keyValid(signingKey, "private", "sign")) throw new PrivateStateRecoveryRefusal();
  const issue = async (value: unknown, purpose: Purpose): Promise<IssuedStateRecoveryApproval> => {
    try {
      assertPrivateStateRecoveryApproval(value, purpose, selectedTargetId, clock());
      const approval = Object.freeze({ ...value });
      const proof = crypto.getRandomValues(new Uint8Array(32));
      const digest = await holderDigest(proof);
      const payload = stableStringify({ domain: DOMAIN, algorithm: "ES256", issuer, keyId,
        holderProofDigest: digest, approval });
      const bytes = encoder.encode(payload);
      if (bytes.length > MAX_PAYLOAD_BYTES) throw new PrivateStateRecoveryRefusal();
      const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" },
        signingKey, toArrayBuffer(bytes)));
      if (signature.length !== 64) throw new PrivateStateRecoveryRefusal();
      assertPrivateStateRecoveryApproval(approval, purpose, selectedTargetId, clock());
      return Object.freeze({ approvalRef: encode(proof), holderProofDigest: digest,
        record: Object.freeze({ format: FORMAT, payload, signature: encode(signature) }) });
    } catch { throw new PrivateStateRecoveryRefusal(); }
  };
  return Object.freeze({
    issueStageApproval(approval: PrivateStateStageApproval) { return issue(approval, STAGE); },
    issueCommitApproval(approval: PrivateStateCommitApproval) { return issue(approval, COMMIT); },
  });
}

/**
 * Public-key-only qualified port. Two fresh current observations surround
 * verification, with no cached record/decision and no raw proof sent upstream.
 * They do not make the external authority and Core commit one atomic unit.
 */
export function createSignedStateRecoveryApprovalReader(input: Identity & {
  readonly publicKey: CryptoKey;
  readonly currentLookup: CurrentSignedStateRecoveryApprovalLookup;
  readonly now?: () => number;
}): QualifiedStateRecoveryApprovalPort {
  const { issuer, keyId, selectedTargetId, publicKey, currentLookup } = input;
  const config = Object.freeze({ issuer, keyId, selectedTargetId });
  const clock = input.now ?? Date.now;
  identity(config);
  if (!keyValid(publicKey, "public", "verify") ||
    typeof currentLookup?.readCurrentSignedStateRecoveryApproval !== "function") throw new PrivateStateRecoveryRefusal();
  return Object.freeze({
    async readApprovedStateRecovery(value: Parameters<QualifiedStateRecoveryApprovalPort["readApprovedStateRecovery"]>[0]) {
      try {
        if (!record(value) || !exactKeys(value, ["approvalRef", "purpose", "selectedTargetId"]) ||
          value.selectedTargetId !== selectedTargetId || (value.purpose !== STAGE && value.purpose !== COMMIT) ||
          typeof value.approvalRef !== "string") return undefined;
        const held = Object.freeze({ approvalRef: value.approvalRef, purpose: value.purpose });
        if (!Number.isFinite(clock())) return undefined;
        const digest = await holderDigest(decode(held.approvalRef, 32));
        const first = activeSnapshot(await currentLookup.readCurrentSignedStateRecoveryApproval({ holderProofDigest: digest }));
        const approval = approvalSnapshot(first.payload, config, held.purpose, digest, clock());
        const signature = decode(first.signature, 64);
        if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey,
          toArrayBuffer(signature), toArrayBuffer(encoder.encode(first.payload)))) return undefined;
        const second = activeSnapshot(await currentLookup.readCurrentSignedStateRecoveryApproval({ holderProofDigest: digest }));
        if (first.format !== second.format || first.payload !== second.payload || first.signature !== second.signature) return undefined;
        assertPrivateStateRecoveryApproval(approval, held.purpose, selectedTargetId, clock());
        return approval;
      } catch { return undefined; }
    },
  });
}
