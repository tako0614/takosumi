import { expect, test } from "bun:test";

import {
  PrivateRunFilesService,
  type PrivateRunFileBlobPort,
  type PrivateRunFileRepositoryPort,
  type PrivateRunFilesAuthorizationPort,
  type PrivateRunFileScope,
  type PrivateRunFileDigest,
} from "../../core/domains/private-run-files/mod.ts";

const scope: PrivateRunFileScope = {
  workspaceId: "workspace_1",
  capsuleId: "capsule_1",
  environment: "preview",
  slot: "opaque-slot-1",
};

const authority = {
  runId: "run_1",
  executionAuthorityEpoch: 1,
  leaseToken: "lease_1",
};

function build(maxBytes = 64) {
  const repository = new MemoryRepository();
  const blobs = new MemoryBlobs();
  const authorization: PrivateRunFilesAuthorizationPort = {
    authorize: async () => {},
  };
  return {
    repository,
    blobs,
    service: new PrivateRunFilesService({
      repository,
      blobs,
      authorization,
      maxBytes,
    }),
  };
}

class MemoryRepository implements PrivateRunFileRepositoryPort {
  readonly pointers = new Map<string, { version: number; digest: PrivateRunFileDigest; blobId: string }>();
  readonly receipts = new Map<string, Awaited<ReturnType<PrivateRunFileRepositoryPort["findReceipt"]>>>();
  acceptedEpoch = 1;
  acceptedLease = "lease_1";
  nextFinalize: "normal" | "unknown_after_commit" = "normal";
  finalizeCalls = 0;

  async readPointer(request: { scope: PrivateRunFileScope }) {
    return this.pointers.get(scopeKey(request.scope));
  }

  async findReceipt(request: { scope: PrivateRunFileScope; commitId: string }) {
    return this.receipts.get(`${scopeKey(request.scope)}:${request.commitId}`);
  }

  async commitPointer(request: Parameters<PrivateRunFileRepositoryPort["commitPointer"]>[0]) {
    this.finalizeCalls += 1;
    const key = scopeKey(request.scope);
    const receiptKey = `${key}:${request.commitId}`;
    const oldReceipt = this.receipts.get(receiptKey);
    if (oldReceipt) return { kind: "replayed" as const, receipt: oldReceipt };
    const current = this.pointers.get(key);
    const version = current?.version ?? 0;
    if (request.executionAuthorityEpoch !== this.acceptedEpoch || request.leaseToken !== this.acceptedLease) {
      return { kind: "authority_rejected" as const };
    }
    if (version !== request.expectedVersion) return { kind: "conflict" as const };
    const receipt = {
      scope: request.scope,
      commitId: request.commitId,
      expectedVersion: request.expectedVersion,
      version: version + 1,
      digest: request.digest,
      blobId: request.blobId,
    };
    this.pointers.set(key, {
      version: receipt.version,
      digest: receipt.digest,
      blobId: receipt.blobId,
    });
    this.receipts.set(receiptKey, receipt);
    if (this.nextFinalize === "unknown_after_commit") {
      this.nextFinalize = "normal";
      return { kind: "unknown" as const };
    }
    return { kind: "committed" as const, receipt };
  }
}

class MemoryBlobs implements PrivateRunFileBlobPort {
  readonly objects = new Map<string, Uint8Array>();
  nextId = 0;
  corruptReadback = false;

  async putEncryptedImmutable(request: Parameters<PrivateRunFileBlobPort["putEncryptedImmutable"]>[0]) {
    const blobId = `blob_${++this.nextId}`;
    this.objects.set(blobId, request.bytes.slice());
    return { blobId, digest: request.digest, byteLength: request.bytes.byteLength };
  }

  async readEncryptedVerified(request: Parameters<PrivateRunFileBlobPort["readEncryptedVerified"]>[0]) {
    const bytes = this.objects.get(request.blobId);
    if (!bytes) return undefined;
    const returnedBytes = bytes.slice();
    if (this.corruptReadback) returnedBytes[0] = (returnedBytes[0] ?? 0) ^ 0xff;
    return { bytes: returnedBytes, digest: request.expectedDigest, byteLength: returnedBytes.byteLength };
  }
}

function scopeKey(value: PrivateRunFileScope) {
  return `${value.workspaceId}/${value.capsuleId}/${value.environment}/${value.slot}`;
}

test("distinguishes an absent slot from a committed zero-byte file", async () => {
  const { service } = build();
  expect(await service.read({ scope, authority })).toEqual({ kind: "absent" });

  await service.commit({
    scope,
    authority,
    expectedVersion: 0,
    commitId: "intent-1",
    bytes: new Uint8Array(),
  });

  const read = await service.read({ scope, authority });
  expect(read.kind).toBe("present");
  if (read.kind === "present") {
    expect(read.version).toBe(1);
    expect(read.bytes).toEqual(new Uint8Array());
  }
});

test("requires a positive byte limit and rejects unsafe versions before storage", async () => {
  expect(() => build(0)).toThrow();
  expect(() => build(-1)).toThrow();
  const { service, blobs, repository } = build(2);
  await expect(service.commit({
    scope, authority, expectedVersion: Number.MAX_SAFE_INTEGER + 1,
    commitId: "unsafe-version", bytes: new Uint8Array([1]),
  })).rejects.toMatchObject({ code: "invalid_argument" });
  await expect(service.commit({
    scope, authority, expectedVersion: Number.MAX_SAFE_INTEGER,
    commitId: "overflow-version", bytes: new Uint8Array([1]),
  })).rejects.toMatchObject({ code: "invalid_argument" });
  await expect(service.commit({
    scope, authority, expectedVersion: 0,
    commitId: "too-large", bytes: new Uint8Array([1, 2, 3]),
  })).rejects.toMatchObject({ code: "too_large" });
  expect(blobs.objects.size).toBe(0);
  expect(repository.finalizeCalls).toBe(0);
});

test("replays the exact original receipt after a later pointer advance", async () => {
  const { service, repository, blobs } = build();
  const first = await service.commit({ scope, authority, expectedVersion: 0, commitId: "intent-A", bytes: new Uint8Array([1]) });
  const later = await service.commit({ scope, authority, expectedVersion: 1, commitId: "intent-B", bytes: new Uint8Array([2]) });
  const replay = await service.commit({ scope, authority, expectedVersion: 0, commitId: "intent-A", bytes: new Uint8Array([1]) });
  expect(first.kind).toBe("committed");
  expect(later.kind).toBe("committed");
  expect(replay).toEqual({ kind: "replayed", receipt: first.kind === "committed" ? first.receipt : undefined });
  expect(repository.pointers.get(scopeKey(scope))?.version).toBe(2);
  expect(blobs.nextId).toBe(2);

  const mismatch = await service.commit({ scope, authority, expectedVersion: 0, commitId: "intent-A", bytes: new Uint8Array([9]) });
  expect(mismatch.kind).toBe("conflict");
  expect(blobs.nextId).toBe(2);
});

test("rejects stale epoch or lease at the atomic repository boundary", async () => {
  const { service, repository, blobs } = build();
  const stale = await service.commit({
    scope, authority: { ...authority, leaseToken: "expired-lease" },
    expectedVersion: 0, commitId: "stale", bytes: new Uint8Array([1]),
  });
  expect(stale.kind).toBe("authority_rejected");
  expect(repository.pointers.size).toBe(0);
  expect(repository.finalizeCalls).toBe(1);
  expect(blobs.nextId).toBe(1); // an unreferenced immutable blob is not an ACK

  repository.acceptedEpoch = 2;
  const staleEpoch = await service.commit({
    scope, authority, expectedVersion: 0, commitId: "stale-epoch", bytes: new Uint8Array([4]),
  });
  expect(staleEpoch.kind).toBe("authority_rejected");
  expect(repository.pointers.size).toBe(0);
  repository.acceptedEpoch = 1;

  const winner = await service.commit({ scope, authority, expectedVersion: 0, commitId: "winner", bytes: new Uint8Array([2]) });
  const loser = await service.commit({ scope, authority, expectedVersion: 0, commitId: "loser", bytes: new Uint8Array([3]) });
  expect(winner.kind).toBe("committed");
  expect(loser.kind).toBe("conflict");
  expect(repository.pointers.get(scopeKey(scope))?.version).toBe(1);
});

test("verifies immutable readback before pointer commit and keeps diagnostics value-free", async () => {
  const { service, repository, blobs } = build();
  blobs.corruptReadback = true;
  const secretLookingBytes = new TextEncoder().encode("do-not-print-this-private-value");
  const failure = service.commit({
    scope, authority, expectedVersion: 0, commitId: "readback-failure", bytes: secretLookingBytes,
  });
  await expect(failure).rejects.toMatchObject({ code: "integrity_failure" });
  await expect(failure).rejects.not.toThrow("do-not-print-this-private-value");
  expect(repository.finalizeCalls).toBe(0);
  expect(JSON.stringify(repository.pointers)).not.toContain("do-not-print-this-private-value");
});

test("resolves an uncertain commit only by explicit receipt lookup", async () => {
  const { service, repository } = build();
  repository.nextFinalize = "unknown_after_commit";
  const request = { scope, authority, expectedVersion: 0, commitId: "ack-lost", bytes: new Uint8Array([7]) };
  const uncertain = await service.commit(request);
  expect(uncertain.kind).toBe("unknown");
  expect(repository.finalizeCalls).toBe(1);
  if (uncertain.kind !== "unknown") throw new Error("expected unknown result");

  const resolved = await service.resolve({
    scope, authority, commitId: uncertain.commitId,
    expectedVersion: uncertain.expectedVersion, digest: uncertain.digest,
  });
  expect(resolved.kind).toBe("committed");
  expect(repository.finalizeCalls).toBe(1);
});
