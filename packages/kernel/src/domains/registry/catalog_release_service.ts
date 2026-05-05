import { createHash } from "node:crypto";
import type {
  ActorContext,
  Digest,
  IsoTimestamp,
  JsonObject,
} from "takosumi-contract";
import type { AuditStore } from "../audit/mod.ts";
import type {
  CatalogReleaseAdoptionStore,
  CatalogReleaseDescriptorStore,
  CatalogReleasePublisherKeyStore,
} from "./stores.ts";
import {
  CATALOG_RELEASE_SIGNATURE_ALGORITHM,
  type CatalogReleaseAdoption,
  type CatalogReleaseAdoptionVerification,
  type CatalogReleaseDescriptor,
  type CatalogReleasePublisherKey,
  type CatalogReleaseVerificationFailure,
  type CatalogReleaseVerificationFailureReason,
  type CatalogReleaseVerificationResult,
} from "./types.ts";

export interface CatalogReleaseServiceStores {
  readonly releases: CatalogReleaseDescriptorStore;
  readonly publisherKeys: CatalogReleasePublisherKeyStore;
  readonly adoptions: CatalogReleaseAdoptionStore;
  readonly audit?: AuditStore;
}

export interface CatalogReleaseServiceOptions {
  readonly stores: CatalogReleaseServiceStores;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
}

export interface EnrollCatalogReleasePublisherKeyInput {
  readonly keyId: string;
  readonly publisherId: string;
  readonly publicKeyBase64: string;
  readonly enrolledAt?: string;
  readonly actor?: ActorContext;
  readonly requestId?: string;
}

export interface RevokeCatalogReleasePublisherKeyInput {
  readonly keyId: string;
  readonly revokedAt?: string;
  readonly reason?: string;
  readonly actor?: ActorContext;
  readonly requestId?: string;
}

export interface AdoptCatalogReleaseInput {
  readonly spaceId: string;
  readonly descriptor: CatalogReleaseDescriptor;
  readonly adoptedAt?: string;
  readonly actor?: ActorContext;
  readonly requestId?: string;
}

export interface AdoptCatalogReleaseResult {
  readonly adoption: CatalogReleaseAdoption;
  readonly verification: CatalogReleaseVerificationResult & {
    readonly ok: true;
  };
  readonly eventType: "catalog-release-adopted" | "catalog-release-rotated";
}

export class CatalogReleaseVerificationError extends Error {
  readonly verification: CatalogReleaseVerificationFailure;

  constructor(verification: CatalogReleaseVerificationFailure) {
    super(verification.message);
    this.name = "CatalogReleaseVerificationError";
    this.verification = verification;
  }
}

export class CatalogReleaseService {
  readonly #stores: CatalogReleaseServiceStores;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;

  constructor(options: CatalogReleaseServiceOptions) {
    this.#stores = options.stores;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  async enrollPublisherKey(
    input: EnrollCatalogReleasePublisherKeyInput,
  ): Promise<CatalogReleasePublisherKey> {
    const enrolledAt = input.enrolledAt ?? this.#clock().toISOString();
    const key: CatalogReleasePublisherKey = {
      keyId: input.keyId,
      publisherId: input.publisherId,
      publicKeyBase64: input.publicKeyBase64,
      status: "active",
      enrolledAt,
    };
    const stored = await this.#stores.publisherKeys.put(key);
    await this.#appendAudit({
      type: "publisher-key-enrolled",
      severity: "info",
      actor: input.actor,
      requestId: input.requestId,
      occurredAt: enrolledAt,
      targetType: "catalog-publisher-key",
      targetId: stored.keyId,
      payload: {
        publisherId: stored.publisherId,
        keyId: stored.keyId,
        algorithm: CATALOG_RELEASE_SIGNATURE_ALGORITHM,
      },
    });
    return stored;
  }

  async revokePublisherKey(
    input: RevokeCatalogReleasePublisherKeyInput,
  ): Promise<CatalogReleasePublisherKey | undefined> {
    const existing = await this.#stores.publisherKeys.get(input.keyId);
    if (!existing) return undefined;
    const revokedAt = input.revokedAt ?? this.#clock().toISOString();
    const next: CatalogReleasePublisherKey = {
      ...existing,
      status: "revoked",
      revokedAt,
      ...(input.reason ? { reason: input.reason } : {}),
    };
    const stored = await this.#stores.publisherKeys.put(next);
    await this.#appendAudit({
      type: "publisher-key-revoked",
      severity: "critical",
      actor: input.actor,
      requestId: input.requestId,
      occurredAt: revokedAt,
      targetType: "catalog-publisher-key",
      targetId: stored.keyId,
      payload: {
        publisherId: stored.publisherId,
        keyId: stored.keyId,
        reason: input.reason ?? null,
      },
    });
    return stored;
  }

  async verifyDescriptor(
    descriptor: CatalogReleaseDescriptor,
    verifiedAt: IsoTimestamp = this.#clock().toISOString(),
  ): Promise<CatalogReleaseVerificationResult> {
    const descriptorDigest = catalogReleaseDescriptorDigest(descriptor);
    if (
      descriptor.signature.algorithm !== CATALOG_RELEASE_SIGNATURE_ALGORITHM
    ) {
      return verificationFailure({
        reason: "unsupported-signature-algorithm",
        message:
          `CatalogRelease ${descriptor.releaseId} uses unsupported signature ` +
          `algorithm ${descriptor.signature.algorithm}`,
        descriptorDigest,
        publisherKeyId: descriptor.signature.keyId,
      });
    }

    const key = await this.#stores.publisherKeys.get(
      descriptor.signature.keyId,
    );
    if (!key) {
      return verificationFailure({
        reason: "publisher-key-not-enrolled",
        message:
          `CatalogRelease publisher key ${descriptor.signature.keyId} is not enrolled`,
        descriptorDigest,
        publisherKeyId: descriptor.signature.keyId,
      });
    }
    if (key.status === "revoked") {
      return verificationFailure({
        reason: "publisher-key-revoked",
        message:
          `CatalogRelease publisher key ${descriptor.signature.keyId} is revoked`,
        descriptorDigest,
        publisherKeyId: key.keyId,
      });
    }
    if (key.publisherId !== descriptor.publisherId) {
      return verificationFailure({
        reason: "publisher-key-mismatch",
        message:
          `CatalogRelease publisher ${descriptor.publisherId} does not match ` +
          `publisher key owner ${key.publisherId}`,
        descriptorDigest,
        publisherKeyId: key.keyId,
      });
    }
    if (!releaseIdMatchesDigest(descriptor.releaseId, descriptorDigest)) {
      return verificationFailure({
        reason: "descriptor-digest-mismatch",
        message:
          `CatalogRelease ${descriptor.releaseId} does not match descriptor ` +
          `digest ${descriptorDigest}`,
        descriptorDigest,
        publisherKeyId: key.keyId,
      });
    }

    const valid = await verifyEd25519Signature({
      publicKeyBase64: key.publicKeyBase64,
      signatureBase64: descriptor.signature.value,
      payload: catalogReleaseSigningBytes(descriptor),
    });
    if (!valid) {
      return verificationFailure({
        reason: "signature-invalid",
        message: `CatalogRelease ${descriptor.releaseId} signature is invalid`,
        descriptorDigest,
        publisherKeyId: key.keyId,
      });
    }

    return {
      ok: true,
      descriptorDigest,
      publisherId: descriptor.publisherId,
      publisherKeyId: key.keyId,
      verifiedAt,
    };
  }

  async adoptCatalogRelease(
    input: AdoptCatalogReleaseInput,
  ): Promise<AdoptCatalogReleaseResult> {
    const adoptedAt = input.adoptedAt ?? this.#clock().toISOString();
    const verification = await this.verifyDescriptor(
      input.descriptor,
      adoptedAt,
    );
    if (!verification.ok) {
      throw new CatalogReleaseVerificationError(verification);
    }

    await this.#stores.releases.put(input.descriptor);
    const current = await this.#stores.adoptions.currentForSpace(input.spaceId);
    const eventType = current &&
        current.catalogReleaseId !== input.descriptor.releaseId
      ? "catalog-release-rotated"
      : "catalog-release-adopted";
    const adoptionVerification: CatalogReleaseAdoptionVerification = {
      verifiedAt: verification.verifiedAt,
      algorithm: CATALOG_RELEASE_SIGNATURE_ALGORITHM,
      descriptorDigest: verification.descriptorDigest,
      publisherKeyId: verification.publisherKeyId,
    };
    const adoption: CatalogReleaseAdoption = {
      id: `catalog-release-adoption:${this.#idFactory()}`,
      spaceId: input.spaceId,
      catalogReleaseId: input.descriptor.releaseId,
      publisherId: verification.publisherId,
      publisherKeyId: verification.publisherKeyId,
      descriptorDigest: verification.descriptorDigest,
      adoptedAt,
      ...(eventType === "catalog-release-rotated" && current
        ? { rotatedFromCatalogReleaseId: current.catalogReleaseId }
        : {}),
      verification: adoptionVerification,
    };
    const stored = await this.#stores.adoptions.put(adoption);
    await this.#appendAudit({
      type: eventType,
      severity: "info",
      actor: input.actor,
      requestId: input.requestId,
      occurredAt: adoptedAt,
      spaceId: input.spaceId,
      targetType: "catalog-release",
      targetId: input.descriptor.releaseId,
      payload: {
        catalogReleaseId: input.descriptor.releaseId,
        descriptorDigest: verification.descriptorDigest,
        publisherId: verification.publisherId,
        publisherKeyId: verification.publisherKeyId,
        rotatedFromCatalogReleaseId: stored.rotatedFromCatalogReleaseId ?? null,
      },
    });

    return { adoption: stored, verification, eventType };
  }

  async verifyCurrentReleaseForSpace(
    spaceId: string,
  ): Promise<CatalogReleaseVerificationResult | undefined> {
    const adoption = await this.#stores.adoptions.currentForSpace(spaceId);
    if (!adoption) return undefined;
    const descriptor = await this.#stores.releases.get(
      adoption.catalogReleaseId,
    );
    if (!descriptor) {
      return verificationFailure({
        reason: "descriptor-digest-mismatch",
        message:
          `CatalogRelease ${adoption.catalogReleaseId} is adopted by ${spaceId} ` +
          "but its descriptor is not stored",
        descriptorDigest: adoption.descriptorDigest,
        publisherKeyId: adoption.publisherKeyId,
      });
    }
    const verification = await this.verifyDescriptor(descriptor);
    if (
      verification.ok &&
      verification.descriptorDigest !== adoption.descriptorDigest
    ) {
      return verificationFailure({
        reason: "descriptor-digest-mismatch",
        message:
          `CatalogRelease ${adoption.catalogReleaseId} descriptor digest changed ` +
          `after adoption`,
        descriptorDigest: verification.descriptorDigest,
        publisherKeyId: verification.publisherKeyId,
      });
    }
    return verification;
  }

  async #appendAudit(input: {
    readonly type: string;
    readonly severity: "info" | "warning" | "critical";
    readonly actor?: ActorContext;
    readonly requestId?: string;
    readonly occurredAt: string;
    readonly spaceId?: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly payload: JsonObject;
  }): Promise<void> {
    if (!this.#stores.audit) return;
    await this.#stores.audit.append({
      id: `audit:${this.#idFactory()}`,
      eventClass: input.severity === "critical" ? "security" : "compliance",
      type: input.type,
      severity: input.severity,
      actor: input.actor,
      spaceId: input.spaceId,
      targetType: input.targetType,
      targetId: input.targetId,
      payload: input.payload,
      occurredAt: input.occurredAt,
      requestId: input.requestId,
    });
  }
}

export function catalogReleaseDescriptorDigest(
  descriptor: CatalogReleaseDescriptor,
): Digest {
  return digestOf(catalogReleaseSigningPayload(descriptor));
}

export function catalogReleaseSigningPayload(
  descriptor: CatalogReleaseDescriptor,
): Omit<CatalogReleaseDescriptor, "signature"> {
  const { signature: _signature, ...payload } = descriptor;
  return payload;
}

export function catalogReleaseSigningBytes(
  descriptor: CatalogReleaseDescriptor,
): Uint8Array {
  return new TextEncoder().encode(
    stableStringify(catalogReleaseSigningPayload(descriptor)),
  );
}

function verificationFailure(input: {
  readonly reason: CatalogReleaseVerificationFailureReason;
  readonly message: string;
  readonly descriptorDigest?: Digest;
  readonly publisherKeyId?: string;
}): CatalogReleaseVerificationFailure {
  return {
    ok: false,
    reason: input.reason,
    message: input.message,
    descriptorDigest: input.descriptorDigest,
    publisherKeyId: input.publisherKeyId,
    risk: {
      code: "implementation-unverified",
      severity: "error",
      message: input.message,
    },
  };
}

function releaseIdMatchesDigest(releaseId: string, digest: Digest): boolean {
  const strictPrefix = "catalog-release:sha256:";
  if (!releaseId.startsWith(strictPrefix)) return true;
  return releaseId === `catalog-release:${digest}`;
}

async function verifyEd25519Signature(input: {
  readonly publicKeyBase64: string;
  readonly signatureBase64: string;
  readonly payload: Uint8Array;
}): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(base64ToBytes(input.publicKeyBase64)),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      toArrayBuffer(base64ToBytes(input.signatureBase64)),
      toArrayBuffer(input.payload),
    );
  } catch {
    return false;
  }
}

function digestOf(value: unknown): Digest {
  return `sha256:${
    createHash("sha256").update(stableStringify(value)).digest("hex")
  }`;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${
      Object.keys(object).sort().map((key) =>
        `${JSON.stringify(key)}:${stableStringify(object[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

function base64ToBytes(value: string): Uint8Array {
  const bin = atob(value);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}
