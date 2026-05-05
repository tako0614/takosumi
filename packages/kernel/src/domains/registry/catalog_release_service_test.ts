import assert from "node:assert/strict";
import {
  type CatalogReleaseDescriptor,
  catalogReleaseDescriptorDigest,
  CatalogReleaseService,
  catalogReleaseSigningBytes,
  CatalogReleaseVerificationError,
  InMemoryCatalogReleaseAdoptionStore,
  InMemoryCatalogReleaseDescriptorStore,
  InMemoryCatalogReleasePublisherKeyStore,
} from "./mod.ts";
import { InMemoryAuditStore } from "../audit/mod.ts";

Deno.test("CatalogReleaseService adopts a signed release and records audit", async () => {
  const signer = await createSigner();
  const stores = storesFixture();
  const service = new CatalogReleaseService({
    stores,
    idFactory: sequenceIds(["key-audit", "adoption-one", "adopt-audit"]),
    clock: () => new Date("2026-05-04T00:00:00.000Z"),
  });
  await service.enrollPublisherKey({
    keyId: "publisher-key:takos",
    publisherId: "takos",
    publicKeyBase64: signer.publicKeyBase64,
  });
  const descriptor = await signer.sign({
    releaseId: "catalog-release-2026-05-04.1",
    publisherId: "takos",
    descriptorRegistryDigest:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    implementationRegistryDigest:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    createdAt: "2026-05-04T00:00:00.000Z",
  });

  const result = await service.adoptCatalogRelease({
    spaceId: "space:acme-prod",
    descriptor,
    adoptedAt: "2026-05-04T00:10:00.000Z",
  });

  assert.equal(result.eventType, "catalog-release-adopted");
  assert.equal(result.verification.ok, true);
  assert.equal(result.adoption.spaceId, "space:acme-prod");
  assert.equal(result.adoption.catalogReleaseId, descriptor.releaseId);
  assert.equal(
    result.adoption.descriptorDigest,
    catalogReleaseDescriptorDigest(descriptor),
  );
  assert.deepEqual(
    await stores.adoptions.currentForSpace("space:acme-prod"),
    result.adoption,
  );
  assert.deepEqual(await stores.releases.get(descriptor.releaseId), descriptor);

  const events = await stores.audit.list();
  assert.deepEqual(events.map((event) => event.type), [
    "publisher-key-enrolled",
    "catalog-release-adopted",
  ]);
});

Deno.test("CatalogReleaseService marks replacement as catalog-release-rotated", async () => {
  const signer = await createSigner();
  const stores = storesFixture();
  const service = new CatalogReleaseService({
    stores,
    idFactory: sequenceIds([
      "enroll-audit",
      "adoption-one",
      "adopt-audit",
      "adoption-two",
      "rotate-audit",
    ]),
  });
  await service.enrollPublisherKey({
    keyId: "publisher-key:takos",
    publisherId: "takos",
    publicKeyBase64: signer.publicKeyBase64,
    enrolledAt: "2026-05-04T00:00:00.000Z",
  });
  await service.adoptCatalogRelease({
    spaceId: "space:prod",
    descriptor: await signer.sign(baseDescriptor("catalog-release-a")),
    adoptedAt: "2026-05-04T00:01:00.000Z",
  });

  const rotated = await service.adoptCatalogRelease({
    spaceId: "space:prod",
    descriptor: await signer.sign(baseDescriptor("catalog-release-b")),
    adoptedAt: "2026-05-04T00:02:00.000Z",
  });

  assert.equal(rotated.eventType, "catalog-release-rotated");
  assert.equal(
    rotated.adoption.rotatedFromCatalogReleaseId,
    "catalog-release-a",
  );
  assert.equal(
    (await stores.adoptions.currentForSpace("space:prod"))?.catalogReleaseId,
    "catalog-release-b",
  );
});

Deno.test("CatalogReleaseService rejects revoked publisher keys fail-closed", async () => {
  const signer = await createSigner();
  const stores = storesFixture();
  const service = new CatalogReleaseService({
    stores,
    idFactory: sequenceIds(["enroll-audit", "revoke-audit"]),
  });
  await service.enrollPublisherKey({
    keyId: "publisher-key:takos",
    publisherId: "takos",
    publicKeyBase64: signer.publicKeyBase64,
    enrolledAt: "2026-05-04T00:00:00.000Z",
  });
  await service.revokePublisherKey({
    keyId: "publisher-key:takos",
    revokedAt: "2026-05-04T00:05:00.000Z",
  });
  const descriptor = await signer.sign(baseDescriptor("catalog-release-a"));

  await assert.rejects(
    () =>
      service.adoptCatalogRelease({
        spaceId: "space:prod",
        descriptor,
      }),
    (error) => {
      assert(error instanceof CatalogReleaseVerificationError);
      assert.equal(error.verification.reason, "publisher-key-revoked");
      assert.equal(error.verification.risk.code, "implementation-unverified");
      return true;
    },
  );
  assert.equal(await stores.adoptions.currentForSpace("space:prod"), undefined);
});

Deno.test("CatalogReleaseService rejects descriptor tampering", async () => {
  const signer = await createSigner();
  const stores = storesFixture();
  const service = new CatalogReleaseService({ stores });
  await service.enrollPublisherKey({
    keyId: "publisher-key:takos",
    publisherId: "takos",
    publicKeyBase64: signer.publicKeyBase64,
  });
  const signed = await signer.sign(baseDescriptor("catalog-release-a"));
  const tampered: CatalogReleaseDescriptor = {
    ...signed,
    descriptorRegistryDigest:
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  };

  const verification = await service.verifyDescriptor(tampered);

  assert.equal(verification.ok, false);
  if (!verification.ok) {
    assert.equal(verification.reason, "signature-invalid");
    assert.equal(verification.risk.code, "implementation-unverified");
  }
});

function storesFixture() {
  return {
    releases: new InMemoryCatalogReleaseDescriptorStore(),
    publisherKeys: new InMemoryCatalogReleasePublisherKeyStore(),
    adoptions: new InMemoryCatalogReleaseAdoptionStore(),
    audit: new InMemoryAuditStore(),
  };
}

function baseDescriptor(
  releaseId: string,
): Omit<CatalogReleaseDescriptor, "signature"> {
  return {
    releaseId,
    publisherId: "takos",
    descriptorRegistryDigest:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    createdAt: "2026-05-04T00:00:00.000Z",
  };
}

async function createSigner(): Promise<{
  readonly publicKeyBase64: string;
  readonly sign: (
    descriptor: Omit<CatalogReleaseDescriptor, "signature">,
  ) => Promise<CatalogReleaseDescriptor>;
}> {
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const rawPublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  return {
    publicKeyBase64: bytesToBase64(rawPublicKey),
    sign: async (descriptor) => {
      const unsigned: CatalogReleaseDescriptor = {
        ...descriptor,
        signature: {
          algorithm: "Ed25519",
          keyId: "publisher-key:takos",
          value: "",
        },
      };
      const signature = await crypto.subtle.sign(
        "Ed25519",
        keyPair.privateKey,
        toArrayBuffer(catalogReleaseSigningBytes(unsigned)),
      );
      return {
        ...unsigned,
        signature: {
          ...unsigned.signature,
          value: bytesToBase64(new Uint8Array(signature)),
        },
      };
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

function sequenceIds(ids: readonly string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `generated-${index}`;
}
