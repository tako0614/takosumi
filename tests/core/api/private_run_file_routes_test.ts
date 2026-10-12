import { expect, test } from "bun:test";
import { Hono } from "hono";
import { PartitionedSecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import {
  mountPrivateRunFileRoutes,
  PRIVATE_RUN_FILE_HTTP_PATH,
  PRIVATE_RUN_FILE_MAX_BYTES,
} from "../../../core/api/private_run_file_routes.ts";
import { createPrivateRunFileGrantCodec } from "../../../core/domains/private-run-files/grant.ts";
import type { PrivateRunFileGrantCodec } from "../../../core/domains/private-run-files/grant.ts";
import type {
  PrivateRunFileBlobPort,
  PrivateRunFileDigest,
  PrivateRunFilePointer,
  PrivateRunFileReceipt,
  PrivateRunFileRepositoryPort,
  PrivateRunFileScope,
} from "../../../core/domains/private-run-files/mod.ts";

const scope: PrivateRunFileScope = {
  workspaceId: "workspace-1",
  capsuleId: "capsule-1",
  environment: "preview",
  slot: "slot-1",
};
const authority = { runId: "run-1", executionAuthorityEpoch: 3, leaseToken: "private-lease" };
let now = 1_000_000;
const grants = createPrivateRunFileGrantCodec({
  cryptoBoundary: new PartitionedSecretBoundaryCrypto({
    globalPassphrase: "test-only-private-run-file-route-key-0123456789",
  }),
  now: () => now,
});

function fixture() {
  const repository = new Repository();
  const blobs = new Blobs();
  const app = new Hono();
  mountPrivateRunFileRoutes(app, {
    repository,
    blobs,
    grants,
    maxBytes: PRIVATE_RUN_FILE_MAX_BYTES,
  });
  return { app, repository, blobs };
}

async function token(operations: ("read" | "commit" | "resolve")[] = ["read", "commit", "resolve"]) {
  now = 1_000_000;
  return await grants.mint({ scope, authority, operations, expiresAt: now + 60_000 });
}

async function call(app: Hono, operation: string, bearer: string, body: unknown): Promise<Response> {
  return await app.request(`${PRIVATE_RUN_FILE_HTTP_PATH}/${operation}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

class Repository implements PrivateRunFileRepositoryPort {
  pointer: PrivateRunFilePointer | undefined;
  receipts = new Map<string, PrivateRunFileReceipt>();
  active = true;
  readCalls = 0;
  unknownAfterCommit = false;

  private permitted(input: { scope: PrivateRunFileScope; runId: string; executionAuthorityEpoch: number; leaseToken: string }) {
    return this.active && input.scope.workspaceId === scope.workspaceId &&
      input.scope.capsuleId === scope.capsuleId && input.scope.environment === scope.environment &&
      input.scope.slot === scope.slot && input.runId === authority.runId &&
      input.executionAuthorityEpoch === authority.executionAuthorityEpoch &&
      input.leaseToken === authority.leaseToken;
  }

  async readPointer(input: Parameters<PrivateRunFileRepositoryPort["readPointer"]>[0]) {
    this.readCalls += 1;
    if (!this.permitted(input)) return { kind: "authority_rejected" as const };
    return this.pointer
      ? { kind: "present" as const, pointer: this.pointer }
      : { kind: "absent" as const };
  }

  async lookupReceipt(input: Parameters<PrivateRunFileRepositoryPort["lookupReceipt"]>[0]) {
    if (!this.permitted(input)) return { kind: "authority_rejected" as const };
    const receipt = this.receipts.get(input.commitId);
    return receipt ? { kind: "found" as const, receipt } : { kind: "absent" as const };
  }

  async commitPointer(input: Parameters<PrivateRunFileRepositoryPort["commitPointer"]>[0]) {
    if (!this.permitted(input)) return { kind: "authority_rejected" as const };
    const prior = this.receipts.get(input.commitId);
    if (prior) return { kind: "replayed" as const, receipt: prior };
    if ((this.pointer?.version ?? 0) !== input.expectedVersion) return { kind: "conflict" as const };
    const receipt: PrivateRunFileReceipt = {
      scope: input.scope,
      commitId: input.commitId,
      expectedVersion: input.expectedVersion,
      version: input.expectedVersion + 1,
      digest: input.digest,
      blobId: input.blobId,
    };
    this.pointer = { version: receipt.version, digest: receipt.digest, blobId: receipt.blobId };
    this.receipts.set(input.commitId, receipt);
    if (this.unknownAfterCommit) {
      this.unknownAfterCommit = false;
      return { kind: "unknown" as const };
    }
    return { kind: "committed" as const, receipt };
  }
}

class Blobs implements PrivateRunFileBlobPort {
  entries = new Map<string, { bytes: Uint8Array; digest: PrivateRunFileDigest }>();

  async putEncryptedImmutable(input: Parameters<PrivateRunFileBlobPort["putEncryptedImmutable"]>[0]) {
    const blobId = `blob-${this.entries.size + 1}`;
    this.entries.set(blobId, { bytes: input.bytes.slice(), digest: input.digest });
    return { blobId, digest: input.digest, byteLength: input.bytes.byteLength };
  }

  async readEncryptedVerified(input: Parameters<PrivateRunFileBlobPort["readEncryptedVerified"]>[0]) {
    const entry = this.entries.get(input.blobId);
    if (!entry || entry.digest !== input.expectedDigest) return undefined;
    return { bytes: entry.bytes.slice(), digest: entry.digest, byteLength: entry.bytes.byteLength };
  }
}

test("Core HTTP commits, reads and resolves with public receipts only", async () => {
  const { app } = fixture();
  const bearer = await token();
  expect(await (await call(app, "read", bearer, {})).json()).toEqual({ kind: "absent" });
  const commit = await call(app, "commit", bearer, {
    expectedVersion: 0,
    commitId: "commit-1",
    bytesBase64: btoa("journal-v1"),
  });
  expect(commit.status).toBe(200);
  const committed = await commit.json() as Record<string, unknown>;
  expect(committed.kind).toBe("committed");
  expect(JSON.stringify(committed)).not.toContain("blob-");
  expect(JSON.stringify(committed)).not.toContain(authority.leaseToken);
  const receipt = committed.receipt as { digest: string; version: number };
  expect(receipt.version).toBe(1);
  expect(receipt.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(await (await call(app, "read", bearer, {})).json()).toEqual({
    kind: "present", version: 1, digest: receipt.digest, bytesBase64: btoa("journal-v1"),
  });
  expect(await (await call(app, "resolve", bearer, {
    expectedVersion: 0, commitId: "commit-1", digest: receipt.digest,
  })).json()).toEqual({ kind: "committed", receipt: committed.receipt });
});

test("grant expiring during a slow request body cannot reach the repository", async () => {
  const bearer = await token(["read"]);
  let opened!: () => void;
  const openedPromise = new Promise<void>((resolve) => { opened = resolve; });
  let releaseBody!: () => void;
  const bodyGate = new Promise<void>((resolve) => { releaseBody = resolve; });
  const observedGrants: PrivateRunFileGrantCodec = {
    mint: (input) => grants.mint(input),
    open: async (opaque) => {
      const claims = await grants.open(opaque);
      opened();
      return claims;
    },
  };
  const repository = new Repository();
  const blobs = new Blobs();
  const app = new Hono();
  mountPrivateRunFileRoutes(app, {
    grants: observedGrants,
    repository,
    blobs,
    maxBytes: PRIVATE_RUN_FILE_MAX_BYTES,
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
    async pull(controller) {
      await bodyGate;
      controller.enqueue(new TextEncoder().encode("}"));
      controller.close();
    },
  });
  const request = new Request(`https://core.test${PRIVATE_RUN_FILE_HTTP_PATH}/read`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit);
  const responsePromise = app.fetch(request);
  await openedPromise;
  now += 60_000;
  releaseBody();
  const response = await responsePromise;
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ kind: "authorization_rejected" });
  expect(repository.readCalls).toBe(0);
  expect(blobs.entries.size).toBe(0);
});

test("unknown commit ACK resolves to the original durable receipt", async () => {
  const { app, repository } = fixture();
  repository.unknownAfterCommit = true;
  const bearer = await token();
  const result = await (await call(app, "commit", bearer, {
    expectedVersion: 0, commitId: "commit-lost-ack", bytesBase64: btoa("journal-v1"),
  })).json() as { kind: string; digest: string };
  expect(result.kind).toBe("unknown");
  const resolved = await (await call(app, "resolve", bearer, {
    expectedVersion: 0, commitId: "commit-lost-ack", digest: result.digest,
  })).json() as { kind: string; receipt: { commitId: string; version: number } };
  expect(resolved.kind).toBe("committed");
  expect(resolved.receipt.commitId).toBe("commit-lost-ack");
  expect(resolved.receipt.version).toBe(1);
});

test("bad grant, wrong operation, foreign body and stale lease fail closed", async () => {
  const { app, repository } = fixture();
  const bearer = await token(["read"]);
  expect((await call(app, "commit", bearer, { expectedVersion: 0, commitId: "x", bytesBase64: "" })).status).toBe(403);
  expect((await call(app, "read", `${bearer}x`, {})).status).toBe(401);
  expect((await call(app, "read", bearer, { scope })).status).toBe(400);
  repository.active = false;
  expect((await call(app, "read", bearer, {})).status).toBe(403);
  now += 60_000;
  expect((await call(app, "read", bearer, {})).status).toBe(401);
});

test("body cap refuses oversized bytes before storage and browser Origin is rejected", async () => {
  const { app, blobs } = fixture();
  const bearer = await token();
  const oversize = await call(app, "commit", bearer, {
    expectedVersion: 0,
    commitId: "too-big",
    bytesBase64: "A".repeat(Math.ceil(PRIVATE_RUN_FILE_MAX_BYTES / 3) * 4 + 4),
  });
  expect(oversize.status).toBe(413);
  expect(blobs.entries.size).toBe(0);
  const browser = await app.request(`${PRIVATE_RUN_FILE_HTTP_PATH}/read`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, origin: "https://example.test", "content-type": "application/json" },
    body: "{}",
  });
  expect(browser.status).toBe(403);
});

test("oversized streamed body is cancelled before storage", async () => {
  const { app, repository, blobs } = fixture();
  const bearer = await token();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(22_400_001));
    },
    cancel() { cancelled = true; },
  });
  const request = new Request(`https://core.test${PRIVATE_RUN_FILE_HTTP_PATH}/commit`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit);
  const response = await app.fetch(request);
  expect(response.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(repository.pointer).toBeUndefined();
  expect(blobs.entries.size).toBe(0);
});
