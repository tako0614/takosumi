import {
  assertBundleLatest,
  bundleFromJSON,
  isBundleWithCertificateChain,
  isBundleWithMessageSignature,
} from "@sigstore/bundle";
import { PublicKeyDetails, TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import { verifyTLogBody } from "@sigstore/verify/dist/tlog";
import { Buffer } from "node:buffer";
import { sha256HexAsync } from "../../shared/runtime/hash.ts";
import {
  canonicalJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from "./canonical_json.ts";

interface TakoformPublisherPolicyBase {
  readonly oidcIssuer: string;
  readonly sourceRepository: string;
  readonly workflow: string;
}

export type TakoformPublisherPolicy = TakoformPublisherPolicyBase &
  (
    | {
        /**
         * Git ref policy. A branch ref must be exact; a tag ref may use `*`,
         * which matches exactly one non-slash path segment.
         */
        readonly refPattern: string;
        readonly tagPattern?: never;
      }
    | {
        /** @deprecated Use refPattern. Accepted until trust-policy schema v2. */
        readonly tagPattern: string;
        readonly refPattern?: never;
      }
  );

export interface TakoformSigstoreTrustPolicy {
  readonly trustedRootDigest: `sha256:${string}`;
  readonly loadTrustedRoot: () => Promise<Uint8Array>;
  readonly publishers: readonly TakoformPublisherPolicy[];
}

export interface VerifiedTakoformPublisher {
  readonly oidcIssuer: string;
  readonly certificateIdentity: string;
  readonly sourceRepository: string;
  readonly workflow: string;
  readonly ref: string;
}

/** Host trust contribution used by the format verifier. */
export interface TakoformPackageSignatureVerifier {
  readonly id: string;
  verify(
    canonicalPackageIndex: Uint8Array,
    signatureBundle: unknown,
  ): Promise<VerifiedTakoformPublisher>;
}

/**
 * Offline Sigstore verifier for the keyless Takoform Form Package trust lane.
 * The distribution endpoint is not trusted: certificate, CT, Rekor inclusion,
 * publisher identity, bundle signature, and a digest-pinned TrustedRoot are all
 * checked from retained input bytes.
 */
export class SigstoreTakoformPackageSignatureVerifier implements TakoformPackageSignatureVerifier {
  readonly id = "takoform.sigstore-keyless.v1";
  readonly #policy: TakoformSigstoreTrustPolicy;
  #trustedRoot?: ReturnType<typeof TrustedRoot.fromJSON>;
  #trustMaterial?: ReturnType<typeof toTrustMaterial>;

  constructor(policy: TakoformSigstoreTrustPolicy) {
    if (policy.publishers.length === 0) {
      throw new TypeError(
        "at least one trusted Takoform publisher is required",
      );
    }
    for (const publisher of policy.publishers) validatePublisher(publisher);
    if (!/^sha256:[0-9a-f]{64}$/u.test(policy.trustedRootDigest)) {
      throw new TypeError("trustedRootDigest must be an exact sha256 digest");
    }
    this.#policy = policy;
  }

  async verify(
    canonicalPackageIndex: Uint8Array,
    signatureBundle: unknown,
  ): Promise<VerifiedTakoformPublisher> {
    let bundle;
    try {
      bundle = bundleFromJSON(signatureBundle);
      assertBundleLatest(bundle);
    } catch (error) {
      throw new TypeError("invalid Sigstore v0.3 bundle", { cause: error });
    }
    if (!isBundleWithMessageSignature(bundle)) {
      throw new TypeError(
        "Takoform package bundle must sign the canonical index blob",
      );
    }
    if (
      !isBundleWithCertificateChain(bundle) &&
      bundle.verificationMaterial.content.$case !== "certificate"
    ) {
      throw new TypeError(
        "Takoform package bundle must use keyless X.509 identity",
      );
    }
    if (
      bundle.verificationMaterial.tlogEntries.length === 0 ||
      bundle.verificationMaterial.tlogEntries.some(
        (entry) => entry.inclusionProof === undefined,
      )
    ) {
      throw new TypeError(
        "Sigstore bundle has no offline Rekor inclusion proof",
      );
    }

    const signedEntity = toSignedEntity(
      bundle,
      Buffer.from(canonicalPackageIndex),
    );
    const trustedRoot = await this.#trustedRootDocument();
    await verifyOfflineTransparency(
      bundle,
      trustedRoot,
      signedEntity.signature,
    );
    const verifier = new Verifier(await this.#trustedMaterial(), {
      // The retained Rekor SET and checkpoint/Merkle proof are verified above
      // with the key algorithm declared by the TrustedRoot. sigstore-js 4.1.0
      // otherwise calls Node crypto.verify without SHA-256 for Rekor's legacy
      // ECDSA key. Keep its certificate, SCT, subject-signature, and publisher
      // policy verification, but do not repeat that incompatible tlog path.
      tlogThreshold: 0,
      ctlogThreshold: 1,
      // The SET-authenticated integrated time remains on SignedEntity even
      // though tlogEntries are removed from sigstore-js's duplicate verifier.
      timestampThreshold: 1,
    });
    let signer;
    try {
      signer = verifier.verify({ ...signedEntity, tlogEntries: [] });
    } catch (error) {
      throw new TypeError(
        "Sigstore signature or transparency verification failed",
        {
          cause: error,
        },
      );
    }
    const issuer = signer.identity?.extensions?.issuer;
    const identity = signer.identity?.subjectAlternativeName;
    if (!issuer || !identity) {
      throw new TypeError(
        "Sigstore signer has no Fulcio issuer or certificate identity",
      );
    }
    const matched = this.#policy.publishers
      .map((publisher) => matchPublisher(publisher, issuer, identity))
      .find((result) => result !== undefined);
    if (!matched) {
      throw new TypeError(
        "Sigstore signer is outside the host publisher policy",
      );
    }
    return matched;
  }

  async #trustedMaterial(): Promise<ReturnType<typeof toTrustMaterial>> {
    if (this.#trustMaterial) return this.#trustMaterial;
    this.#trustMaterial = toTrustMaterial(await this.#trustedRootDocument());
    return this.#trustMaterial;
  }

  async #trustedRootDocument(): Promise<
    ReturnType<typeof TrustedRoot.fromJSON>
  > {
    if (this.#trustedRoot) return this.#trustedRoot;
    const bytes = await this.#policy.loadTrustedRoot();
    const digest = `sha256:${await sha256HexAsync(bytes)}`;
    if (digest !== this.#policy.trustedRootDigest) {
      throw new TypeError(
        `Sigstore TrustedRoot digest mismatch: expected ${this.#policy.trustedRootDigest}, got ${digest}`,
      );
    }
    try {
      this.#trustedRoot = TrustedRoot.fromJSON(parseCanonicalJson(bytes));
    } catch (error) {
      throw new TypeError("invalid Sigstore TrustedRoot JSON", {
        cause: error,
      });
    }
    return this.#trustedRoot;
  }
}

type ParsedSigstoreBundle = ReturnType<typeof bundleFromJSON>;
type ParsedTrustedRoot = ReturnType<typeof TrustedRoot.fromJSON>;

/**
 * Verify the retained Rekor evidence without network access. Both the signed
 * entry timestamp and checkpoint/Merkle inclusion proof are required: the SET
 * authenticates integrated time and log index, while the proof authenticates
 * actual inclusion in the checkpointed tree.
 */
async function verifyOfflineTransparency(
  bundle: ParsedSigstoreBundle,
  trustedRoot: ParsedTrustedRoot,
  signature: Parameters<typeof verifyTLogBody>[1],
): Promise<void> {
  for (const entry of bundle.verificationMaterial.tlogEntries) {
    const authority = trustedRoot.tlogs.find(
      (candidate) =>
        candidate.logId !== undefined &&
        equalBytes(candidate.logId.keyId, entry.logId.keyId),
    );
    if (!authority?.publicKey) {
      throw new TypeError("Rekor entry log ID is outside the TrustedRoot");
    }
    const integratedTime = safePositiveInteger(
      entry.integratedTime,
      "Rekor integrated time",
    );
    const validFor = authority.publicKey.validFor;
    const integratedDate = new Date(integratedTime * 1000);
    if (
      (validFor?.start && integratedDate < validFor.start) ||
      (validFor?.end && integratedDate > validFor.end)
    ) {
      throw new TypeError("Rekor key was not valid at the integrated time");
    }
    if (!authority.publicKey.rawBytes) {
      throw new TypeError("TrustedRoot Rekor key has no public bytes");
    }
    const publicKeyBytes = Buffer.from(authority.publicKey.rawBytes);
    const publicKey = await importTransparencyLogKey(
      authority.publicKey.keyDetails,
      publicKeyBytes,
    );
    try {
      // Use sigstore-js's versioned body verifier so both legacy
      // hashedrekord@0.0.1 and Rekor v2 hashedRekordV002 entries bind the
      // retained signature content. The host only owns SET/checkpoint/Merkle
      // verification that sigstore-js cannot perform with legacy ECDSA keys.
      verifyTLogBody(entry, signature);
    } catch (error) {
      throw new TypeError("Rekor body does not bind the package signature", {
        cause: error,
      });
    }
    await verifySignedEntryTimestamp(entry, publicKey);
    await verifyCheckpointAndMerkleProof(entry, authority, publicKey);
  }
}

async function verifySignedEntryTimestamp(
  entry: ParsedSigstoreBundle["verificationMaterial"]["tlogEntries"][number],
  publicKey: TransparencyLogKey,
): Promise<void> {
  if (!entry.inclusionPromise) {
    throw new TypeError("Sigstore bundle has no Rekor inclusion promise");
  }
  const logIndex = safePositiveInteger(entry.logIndex, "Rekor log index");
  const integratedTime = safePositiveInteger(
    entry.integratedTime,
    "Rekor integrated time",
  );
  const payload = canonicalJsonBytes({
    body: Buffer.from(entry.canonicalizedBody).toString("base64"),
    integratedTime,
    logIndex,
    logID: Buffer.from(entry.logId.keyId).toString("hex"),
  } as CanonicalJsonValue);
  if (
    !(await verifyWithDeclaredKey(
      publicKey,
      payload,
      entry.inclusionPromise.signedEntryTimestamp,
    ))
  ) {
    throw new TypeError("Rekor inclusion promise signature is invalid");
  }
}

async function verifyCheckpointAndMerkleProof(
  entry: ParsedSigstoreBundle["verificationMaterial"]["tlogEntries"][number],
  authority: ParsedTrustedRoot["tlogs"][number],
  publicKey: TransparencyLogKey,
): Promise<void> {
  const proof = entry.inclusionProof;
  if (!proof?.checkpoint) {
    throw new TypeError("Sigstore bundle has no Rekor inclusion proof");
  }
  const separator = proof.checkpoint.envelope.indexOf("\n\n");
  if (separator < 0) throw new TypeError("Rekor checkpoint is malformed");
  const note = proof.checkpoint.envelope.slice(0, separator + 1);
  const signatureLines = proof.checkpoint.envelope
    .slice(separator + 2)
    .split("\n")
    .filter((line) => line.length > 0);
  const checkpointKeyId =
    authority.checkpointKeyId?.keyId ?? authority.logId?.keyId;
  const expectedName = new URL(authority.baseUrl).hostname;
  let checkpointVerified = false;
  for (const line of signatureLines) {
    const match = /^— ([^\s]+) ([A-Za-z0-9+/]+={0,2})$/u.exec(line);
    if (!match || match[1] !== expectedName || !checkpointKeyId) continue;
    const signature = Buffer.from(match[2]!, "base64");
    if (
      signature.byteLength < 5 ||
      !equalBytes(signature.subarray(0, 4), checkpointKeyId.subarray(0, 4))
    ) {
      continue;
    }
    if (await verifyWithDeclaredKey(publicKey, note, signature.subarray(4))) {
      checkpointVerified = true;
      break;
    }
  }
  if (!checkpointVerified) {
    throw new TypeError("Rekor checkpoint signature is invalid");
  }
  const lines = note.trimEnd().split("\n");
  if (lines.length < 3) throw new TypeError("Rekor checkpoint is incomplete");
  const treeSize = safePositiveInteger(lines[1], "Rekor checkpoint tree size");
  const rootHash = Buffer.from(lines[2]!, "base64");
  if (
    treeSize !== safePositiveInteger(proof.treeSize, "Rekor proof tree size") ||
    !equalBytes(rootHash, proof.rootHash)
  ) {
    throw new TypeError("Rekor proof differs from its signed checkpoint");
  }
  const logIndex = safePositiveInteger(proof.logIndex, "Rekor proof log index");
  if (logIndex >= treeSize) throw new TypeError("Rekor proof index is invalid");
  const { inner, border } = decomposeInclusionProof(
    BigInt(logIndex),
    BigInt(treeSize),
  );
  if (proof.hashes.length !== inner + border) {
    throw new TypeError("Rekor inclusion proof hash count is invalid");
  }
  let calculated = await hashMerkleLeaf(entry.canonicalizedBody);
  for (let index = 0; index < inner; index += 1) {
    const sibling = proof.hashes[index]!;
    calculated =
      (BigInt(logIndex) >> BigInt(index)) & 1n
        ? await hashMerkleChildren(sibling, calculated)
        : await hashMerkleChildren(calculated, sibling);
  }
  for (const sibling of proof.hashes.slice(inner)) {
    calculated = await hashMerkleChildren(sibling, calculated);
  }
  if (!equalBytes(calculated, rootHash)) {
    throw new TypeError("Rekor Merkle inclusion proof is invalid");
  }
}

interface TransparencyLogKey {
  readonly key: CryptoKey;
  readonly algorithm: "ecdsa-p256-sha256" | "ed25519";
}

async function importTransparencyLogKey(
  details: PublicKeyDetails,
  bytes: Uint8Array,
): Promise<TransparencyLogKey> {
  if (details === PublicKeyDetails.PKIX_ECDSA_P256_SHA_256) {
    return {
      key: await crypto.subtle.importKey(
        "spki",
        webCryptoBytes(bytes),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      ),
      algorithm: "ecdsa-p256-sha256",
    };
  }
  if (details === PublicKeyDetails.PKIX_ED25519) {
    return {
      key: await crypto.subtle.importKey(
        "spki",
        webCryptoBytes(bytes),
        { name: "Ed25519" },
        false,
        ["verify"],
      ),
      algorithm: "ed25519",
    };
  }
  throw new TypeError(
    `unsupported Rekor public key details: ${PublicKeyDetails[details] ?? details}`,
  );
}

async function verifyWithDeclaredKey(
  key: TransparencyLogKey,
  data: Uint8Array | string,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    if (key.algorithm === "ed25519") {
      return await crypto.subtle.verify(
        "Ed25519",
        key.key,
        webCryptoBytes(signature),
        webCryptoBytes(Buffer.from(data)),
      );
    }
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key.key,
      webCryptoBytes(ecdsaDerToP1363(signature, 32)),
      webCryptoBytes(Buffer.from(data)),
    );
  } catch {
    return false;
  }
}

function ecdsaDerToP1363(
  signature: Uint8Array,
  fieldBytes: number,
): Uint8Array {
  const bytes = Buffer.from(signature);
  let offset = 0;
  if (bytes[offset++] !== 0x30)
    throw new TypeError("ECDSA signature is not DER");
  const sequenceLength = readDerLength(bytes, offset);
  offset = sequenceLength.next;
  if (sequenceLength.length !== bytes.byteLength - offset) {
    throw new TypeError("ECDSA DER sequence length is invalid");
  }
  const readInteger = () => {
    if (bytes[offset++] !== 0x02)
      throw new TypeError("ECDSA DER integer is missing");
    const length = readDerLength(bytes, offset);
    offset = length.next;
    const value = bytes.subarray(offset, offset + length.length);
    offset += length.length;
    if (
      value.byteLength === 0 ||
      (value[0] === 0 && value.byteLength > 1 && (value[1]! & 0x80) === 0) ||
      (value[0]! & 0x80) !== 0
    ) {
      throw new TypeError("ECDSA DER integer is not minimally positive");
    }
    const magnitude = value[0] === 0 ? value.subarray(1) : value;
    if (magnitude.byteLength > fieldBytes)
      throw new TypeError("ECDSA DER integer exceeds its curve");
    const padded = Buffer.alloc(fieldBytes);
    padded.set(magnitude, fieldBytes - magnitude.byteLength);
    return padded;
  };
  const r = readInteger();
  const s = readInteger();
  if (offset !== bytes.byteLength)
    throw new TypeError("ECDSA DER signature has trailing data");
  return Buffer.concat([r, s]);
}

function readDerLength(bytes: Uint8Array, offset: number) {
  const first = bytes[offset];
  if (first === undefined) throw new TypeError("DER length is missing");
  if ((first & 0x80) === 0) return { length: first, next: offset + 1 };
  const count = first & 0x7f;
  if (count === 0 || count > 2 || offset + count >= bytes.byteLength) {
    throw new TypeError("DER length is invalid");
  }
  let length = 0;
  for (let index = 0; index < count; index += 1) {
    length = (length << 8) | bytes[offset + 1 + index]!;
  }
  if (length < 128) throw new TypeError("DER length is not minimal");
  return { length, next: offset + 1 + count };
}

function decomposeInclusionProof(index: bigint, size: bigint) {
  const inner = bitLength(index ^ (size - 1n));
  const border = (index >> BigInt(inner)).toString(2).split("1").length - 1;
  return { inner, border };
}

function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

async function hashMerkleLeaf(value: Uint8Array): Promise<Uint8Array> {
  return await digestSha256(Buffer.from([0]), value);
}

async function hashMerkleChildren(
  left: Uint8Array,
  right: Uint8Array,
): Promise<Uint8Array> {
  return await digestSha256(Buffer.from([1]), left, right);
}

async function digestSha256(...parts: readonly Uint8Array[]) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
}

function safePositiveInteger(value: bigint | number | string, label: string) {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${label} is outside the safe integer range`);
  }
  return Number(parsed);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function webCryptoBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function validatePublisher(publisher: TakoformPublisherPolicy): void {
  const issuer = new URL(publisher.oidcIssuer);
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.origin !== publisher.oidcIssuer
  ) {
    throw new TypeError("publisher oidcIssuer must be an HTTPS origin");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(publisher.sourceRepository)) {
    throw new TypeError("publisher sourceRepository must be owner/repository");
  }
  if (
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(publisher.workflow)
  ) {
    throw new TypeError(
      "publisher workflow must be a protected GitHub workflow path",
    );
  }
  const refPattern = publisherRefPattern(publisher);
  const branchRef = refPattern.startsWith("refs/heads/");
  const tagRef = refPattern.startsWith("refs/tags/");
  if (
    (!branchRef && !tagRef) ||
    refPattern.includes("**") ||
    (branchRef && refPattern.includes("*")) ||
    refPattern
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError(
      "publisher refPattern must be an exact branch ref or single-segment Git tag glob",
    );
  }
  globToRegExp(refPattern);
}

function matchPublisher(
  publisher: TakoformPublisherPolicy,
  issuer: string,
  certificateIdentity: string,
): VerifiedTakoformPublisher | undefined {
  if (publisher.oidcIssuer !== issuer) return undefined;
  const marker = "@";
  const split = certificateIdentity.lastIndexOf(marker);
  if (split < 1) return undefined;
  const workflowIdentity = certificateIdentity.slice(0, split);
  const ref = certificateIdentity.slice(split + 1);
  const expectedWorkflowIdentity = `https://github.com/${publisher.sourceRepository}/${publisher.workflow}`;
  if (
    workflowIdentity !== expectedWorkflowIdentity ||
    !globToRegExp(publisherRefPattern(publisher)).test(ref)
  ) {
    return undefined;
  }
  return {
    oidcIssuer: issuer,
    certificateIdentity,
    sourceRepository: publisher.sourceRepository,
    workflow: publisher.workflow,
    ref,
  };
}

function publisherRefPattern(publisher: TakoformPublisherPolicy): string {
  const hasRef = typeof publisher.refPattern === "string";
  const hasLegacyTag = typeof publisher.tagPattern === "string";
  if (hasRef === hasLegacyTag) {
    throw new TypeError(
      "publisher requires exactly one of refPattern or deprecated tagPattern",
    );
  }
  return hasRef ? publisher.refPattern! : publisher.tagPattern!;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("[^/]+?");
  return new RegExp(`^${escaped}$`, "u");
}
