import { expect, test } from "bun:test";

import {
  PrivateRunFilesService,
  type PrivateRunFileBlobPort,
  type PrivateRunFileRepositoryPort,
  type PrivateRunFilesAuthorizationPort,
  type PrivateRunFileScope,
  type PrivateRunFileDigest,
  type PrivateRunFileReceipt,
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
  readonly receipts = new Map<string, PrivateRunFileReceipt>();
  acceptedRunId = "run_1";
  acceptedEpoch = 1;
  acceptedLease = "lease_1";
  nextFinalize: "normal" | "unknown_after_commit" = "normal";
  finalizeCalls = 0;
  finalizedReceiptOverride: PrivateRunFileReceipt | undefined;
  lookupReceiptOverride: Awaited<ReturnType<PrivateRunFileRepositoryPort["lookupReceipt"]>> | undefined;

  async readPointer(request: { scope: PrivateRunFileScope }) {
    return this.pointers.get(scopeKey(request.scope));
  }

  async lookupReceipt(request: Parameters<PrivateRunFileRepositoryPort["lookupReceipt"]>[0]) {
    if (this.lookupReceiptOverride) return this.lookupReceiptOverride;
    if (request.runId !== this.acceptedRunId || request.executionAuthorityEpoch !== this.acceptedEpoch || request.leaseToken !== this.acceptedLease) {
      return { kind: "authority_rejected" as const };
    }
    const receipt = this.receipts.get(`${scopeKey(request.scope)}:${request.commitId}`);
    return receipt ? { kind: "found" as const, receipt } : { kind: "absent" as const };
  }

  async commitPointer(request: Parameters<PrivateRunFileRepositoryPort["commitPointer"]>[0]) {
    this.finalizeCalls += 1;
    const key = scopeKey(request.scope);
    const receiptKey = `${key}:${request.commitId}`;
    const current = this.pointers.get(key);
    const version = current?.version ?? 0;
    if (request.runId !== this.acceptedRunId || request.executionAuthorityEpoch !== this.acceptedEpoch || request.leaseToken !== this.acceptedLease) {
      return { kind: "authority_rejected" as const };
    }
    const oldReceipt = this.receipts.get(receiptKey);
    if (oldReceipt) return { kind: "replayed" as const, receipt: this.finalizedReceiptOverride ?? oldReceipt };
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
    return { kind: "committed" as const, receipt: this.finalizedReceiptOverride ?? receipt };
  }
}

class MemoryBlobs implements PrivateRunFileBlobPort {
  readonly objects = new Map<string, Uint8Array>();
  nextId = 0;
  corruptReadback = false;
  returnSharedRead = false;

  async putEncryptedImmutable(request: Parameters<PrivateRunFileBlobPort["putEncryptedImmutable"]>[0]) {
    const blobId = `blob_${++this.nextId}`;
    this.objects.set(blobId, request.bytes.slice());
    return { blobId, digest: request.digest, byteLength: request.bytes.byteLength };
  }

  async readEncryptedVerified(request: Parameters<PrivateRunFileBlobPort["readEncryptedVerified"]>[0]) {
    const bytes = this.objects.get(request.blobId);
    if (!bytes) return undefined;
    const returnedBytes = this.returnSharedRead
      ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : bytes.slice();
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
  expect(repository.finalizeCalls).toBe(3);

  repository.acceptedLease = "lease-takeover";
  const staleReplay = await service.commit({
    scope, authority, expectedVersion: 0, commitId: "intent-A", bytes: new Uint8Array([1]),
  });
  expect(staleReplay.kind).toBe("authority_rejected");
  repository.acceptedLease = authority.leaseToken;
  repository.acceptedEpoch = 5;
  const staleEpochReplay = await service.commit({
    scope, authority, expectedVersion: 0, commitId: "intent-A", bytes: new Uint8Array([1]),
  });
  expect(staleEpochReplay.kind).toBe("authority_rejected");
  expect(blobs.nextId).toBe(2);
  repository.acceptedEpoch = authority.executionAuthorityEpoch;

  const mismatch = await service.commit({ scope, authority, expectedVersion: 0, commitId: "intent-A", bytes: new Uint8Array([9]) });
  expect(mismatch.kind).toBe("conflict");
  expect(blobs.nextId).toBe(2);
});

test("copies Buffer bytes before asynchronous hashing or adapter calls", async () => {
  const { service } = build();
  const input = Buffer.from([1, 2, 3]);
  const pending = service.commit({
    scope, authority, expectedVersion: 0, commitId: "buffer-copy", bytes: input,
  });
  input[0] = 9;
  const committed = await pending;
  expect(committed.kind).toBe("committed");
  const read = await service.read({ scope, authority });
  expect(read.kind).toBe("present");
  if (read.kind === "present") expect(read.bytes).toEqual(new Uint8Array([1, 2, 3]));
});

test("copies blob Buffer views before returning private bytes", async () => {
  const { service, blobs } = build();
  await service.commit({
    scope, authority, expectedVersion: 0, commitId: "blob-buffer-view", bytes: new Uint8Array([4, 5]),
  });
  blobs.returnSharedRead = true;
  const firstRead = await service.read({ scope, authority });
  expect(firstRead.kind).toBe("present");
  if (firstRead.kind !== "present") throw new Error("expected private file");
  firstRead.bytes[0] = 99;
  const secondRead = await service.read({ scope, authority });
  expect(secondRead.kind).toBe("present");
  if (secondRead.kind === "present") expect(secondRead.bytes).toEqual(new Uint8Array([4, 5]));
});

test("returned receipt mutation cannot rewrite stored replay history", async () => {
  const { service } = build();
  const first = await service.commit({
    scope, authority, expectedVersion: 0, commitId: "receipt-copy", bytes: new Uint8Array([1]),
  });
  if (first.kind !== "committed") throw new Error("expected committed receipt");
  const originalBlobId = first.receipt.blobId;
  (first.receipt as { blobId: string }).blobId = "caller-mutated";
  (first.receipt.scope as { slot: string }).slot = "caller-mutated-slot";
  const replay = await service.commit({
    scope, authority, expectedVersion: 0, commitId: "receipt-copy", bytes: new Uint8Array([1]),
  });
  expect(replay.kind).toBe("replayed");
  if (replay.kind === "replayed") {
    expect(replay.receipt.blobId).toBe(originalBlobId);
    expect(replay.receipt.scope.slot).toBe(scope.slot);
  }
});

test("malformed or mismatched receipt lookup cannot be acknowledged", async () => {
  const { service, repository, blobs } = build();
  const committed = await service.commit({
    scope, authority, expectedVersion: 0, commitId: "receipt-validation", bytes: new Uint8Array([1]),
  });
  if (committed.kind !== "committed") throw new Error("expected committed receipt");
  const malformed = [
    { ...committed.receipt, commitId: "different-id" },
    { ...committed.receipt, version: 3 },
    { ...committed.receipt, blobId: "" },
  ];
  for (const receipt of malformed) {
    repository.lookupReceiptOverride = { kind: "found", receipt };
    const replay = await service.commit({
      scope, authority, expectedVersion: 0,
      commitId: "receipt-validation", bytes: new Uint8Array([1]),
    });
    expect(replay.kind).toBe("conflict");
  }
  expect(blobs.nextId).toBe(1);

  repository.lookupReceiptOverride = {
    kind: "found",
    receipt: { ...committed.receipt, commitId: "different-id" },
  };
  const resolve = await service.resolve({
    scope, authority, commitId: "receipt-validation", expectedVersion: 0,
    digest: committed.receipt.digest,
  });
  expect(resolve.kind).toBe("conflict");
});

test("finalization cannot acknowledge a different blob for a new or replayed receipt", async () => {
  const newCommit = build();
  newCommit.repository.finalizedReceiptOverride = {
    scope: { ...scope },
    commitId: "misbound-new",
    expectedVersion: 0,
    version: 1,
    digest: "sha256:" + "0".repeat(64) as PrivateRunFileDigest,
    blobId: "another-nonempty-blob",
  };
  await expect(newCommit.service.commit({
    scope, authority, expectedVersion: 0, commitId: "misbound-new", bytes: new Uint8Array([1]),
  })).rejects.toMatchObject({ code: "integrity_failure" });

  const replayCommit = build();
  const initial = await replayCommit.service.commit({
    scope, authority, expectedVersion: 0, commitId: "misbound-replay", bytes: new Uint8Array([2]),
  });
  if (initial.kind !== "committed") throw new Error("expected committed receipt");
  replayCommit.repository.finalizedReceiptOverride = { ...initial.receipt, blobId: "another-nonempty-blob" };
  await expect(replayCommit.service.commit({
    scope, authority, expectedVersion: 0, commitId: "misbound-replay", bytes: new Uint8Array([2]),
  })).rejects.toMatchObject({ code: "integrity_failure" });
});

test("receipt resolution is fenced against the current Capsule epoch and Run lease", async () => {
  const { service, repository } = build();
  const committed = await service.commit({
    scope, authority, expectedVersion: 0, commitId: "resolve-fence", bytes: new Uint8Array([1]),
  });
  expect(committed.kind).toBe("committed");
  repository.acceptedEpoch = 2;
  const resolved = await service.resolve({
    scope,
    authority,
    commitId: "resolve-fence",
    expectedVersion: 0,
    digest: committed.kind === "committed" ? committed.receipt.digest : `sha256:${"0".repeat(64)}`,
  });
  expect(resolved.kind).toBe("authority_rejected");
});

test("known replay and resolve verify the original immutable blob without writing", async () => {
  const replay = build();
  const initial = await replay.service.commit({
    scope, authority, expectedVersion: 0, commitId: "verified-replay", bytes: new Uint8Array([4, 5]),
  });
  if (initial.kind !== "committed") throw new Error("expected committed receipt");
  replay.blobs.objects.delete(initial.receipt.blobId);
  await expect(replay.service.commit({
    scope, authority, expectedVersion: 0, commitId: "verified-replay", bytes: new Uint8Array([4, 5]),
  })).rejects.toMatchObject({ code: "integrity_failure" });
  expect(replay.blobs.nextId).toBe(1);

  const corruptReplay = build();
  const corruptInitial = await corruptReplay.service.commit({
    scope, authority, expectedVersion: 0, commitId: "corrupt-replay", bytes: new Uint8Array([7]),
  });
  if (corruptInitial.kind !== "committed") throw new Error("expected committed receipt");
  corruptReplay.blobs.corruptReadback = true;
  await expect(corruptReplay.service.commit({
    scope, authority, expectedVersion: 0, commitId: "corrupt-replay", bytes: new Uint8Array([7]),
  })).rejects.toMatchObject({ code: "integrity_failure" });
  expect(corruptReplay.blobs.nextId).toBe(1);

  const missingResolution = build();
  const missingInitial = await missingResolution.service.commit({
    scope, authority, expectedVersion: 0, commitId: "missing-resolve", bytes: new Uint8Array([8]),
  });
  if (missingInitial.kind !== "committed") throw new Error("expected committed receipt");
  missingResolution.blobs.objects.delete(missingInitial.receipt.blobId);
  await expect(missingResolution.service.resolve({
    scope, authority, commitId: "missing-resolve", expectedVersion: 0, digest: missingInitial.receipt.digest,
  })).rejects.toMatchObject({ code: "integrity_failure" });
  expect(missingResolution.blobs.nextId).toBe(1);

  const resolution = build();
  const uncertain = await resolution.service.commit({
    scope, authority, expectedVersion: 0, commitId: "verified-resolve", bytes: new Uint8Array([6]),
  });
  if (uncertain.kind !== "committed") throw new Error("expected committed fixture receipt");
  resolution.blobs.corruptReadback = true;
  await expect(resolution.service.resolve({
    scope, authority, commitId: "verified-resolve", expectedVersion: 0, digest: uncertain.receipt.digest,
  })).rejects.toMatchObject({ code: "integrity_failure" });
  expect(resolution.blobs.nextId).toBe(1);
});

test("rejects stale epoch or lease at the atomic repository boundary", async () => {
  const { service, repository, blobs } = build();
  const stale = await service.commit({
    scope, authority: { ...authority, leaseToken: "expired-lease" },
    expectedVersion: 0, commitId: "stale", bytes: new Uint8Array([1]),
  });
  expect(stale.kind).toBe("authority_rejected");
  expect(repository.pointers.size).toBe(0);
  expect(repository.finalizeCalls).toBe(0);
  expect(blobs.nextId).toBe(0);

  const otherRun = await service.commit({
    scope, authority: { ...authority, runId: "other-run" },
    expectedVersion: 0, commitId: "other-run", bytes: new Uint8Array([2]),
  });
  expect(otherRun.kind).toBe("authority_rejected");
  expect(repository.finalizeCalls).toBe(0);
  expect(blobs.nextId).toBe(0);

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
