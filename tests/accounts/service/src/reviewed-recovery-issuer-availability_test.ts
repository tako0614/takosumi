/** Synthetic ephemeral keys only; no actual issuer custody is qualified. */
import { expect, test } from "bun:test";
import {
  createReviewedRecoveryIssuerAvailabilityReader,
  isReviewedRecoveryIssuerAvailabilityReader,
  reviewedRecoveryIssuerAvailabilitySignatureInput,
  bindReviewedRecoveryIssuerAvailabilityCheckpoint,
  readReviewedRecoveryIssuerAvailabilityCheckpoint,
  consumeReviewedRecoveryIssuerAvailabilityCheckpoint,
  type ReviewedRecoveryIssuerAvailabilityChallenge,
  type ReviewedRecoveryIssuerAvailabilityStatus,
} from "../../../../accounts/service/src/reviewed-recovery-issuer-availability.ts";
import { base64UrlEncodeBytes, sha256Text } from "../../../../accounts/service/src/encoding.ts";
import { reviewedRecoverySignatureInput } from "../../../../accounts/service/src/reviewed-recovery-approvals.ts";
import type { OwnerOperationTarget } from "../../../../accounts/service/src/owner-operation-contract.ts";
import type { IdentityMergeMutation } from "../../../../accounts/service/src/identity-state.ts";

const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
const foreignKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
const target: OwnerOperationTarget = { ownerKind: "hosted-intents", ownerClientId: "isolated-owner", targetBindingDigest: await sha256Text("isolated-fixed-target") };
const request = { operationId: "isolated-operation", kind: "merge" as const, planDigest: "opaque-core-plan-digest" };
const reviewIssuer = { issuer: "isolated-qualified-issuer", keyId: "isolated-ephemeral-key", publicKey: keys.publicKey };

async function signed(challenge: ReviewedRecoveryIssuerAvailabilityChallenge, modify?: (record: ReviewedRecoveryIssuerAvailabilityStatus) => void,
  privateKey = keys.privateKey): Promise<ReviewedRecoveryIssuerAvailabilityStatus> {
  const record: ReviewedRecoveryIssuerAvailabilityStatus = { version: "takosumi.accounts.review-issuer-availability@v1", status: "available",
    challenge: structuredClone(challenge), attestation: { algorithm: "ES256", issuer: reviewIssuer.issuer, keyId: reviewIssuer.keyId, signature: "" } };
  modify?.(record);
  Object.assign(record.attestation, { signature: base64UrlEncodeBytes(new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, privateKey, reviewedRecoveryIssuerAvailabilitySignatureInput(record).buffer as ArrayBuffer,
  ))) });
  return record;
}

function fixture(transport: (challenge: ReviewedRecoveryIssuerAvailabilityChallenge, context: { signal: AbortSignal }) => Promise<unknown> = (challenge) => signed(challenge)) {
  let now = 1000000;
  const reader = createReviewedRecoveryIssuerAvailabilityReader({ reviewIssuer, target, clientId: "isolated-private-client", environment: "staging",
    readSignedStatus: transport, now: () => now });
  return { reader, time: (value: number) => { now = value; } };
}

test("factory identity and captured target are required; methods, wrappers and metadata cannot qualify", async () => {
  const f = fixture();
  expect(Object.isFrozen(f.reader)).toBe(true);
  expect(isReviewedRecoveryIssuerAvailabilityReader(f.reader, target)).toBe(true);
  expect(isReviewedRecoveryIssuerAvailabilityReader(f.reader, { ...target, ownerClientId: "foreign-owner" })).toBe(false);
  expect(isReviewedRecoveryIssuerAvailabilityReader(f.reader, { ...target, targetBindingDigest: await sha256Text("foreign-target") })).toBe(false);
  for (const forged of [undefined, true, { isAvailable: async () => true }, { ...f.reader }, Object.create(f.reader), { target, reviewIssuer, qualified: true }]) {
    expect(isReviewedRecoveryIssuerAvailabilityReader(forged, target)).toBe(false);
  }
  expect(await f.reader.isAvailable(request)).toBe(true);
});

test("every operation receives a fresh server nonce and exact fixed audience/target/environment", async () => {
  const challenges: ReviewedRecoveryIssuerAvailabilityChallenge[] = [];
  const f = fixture(async (challenge) => { challenges.push(challenge); return signed(challenge); });
  expect(await f.reader.isAvailable(request)).toBe(true);
  expect(await f.reader.isAvailable({ ...request, kind: "unlink" })).toBe(true);
  expect(challenges).toHaveLength(2);
  expect(challenges[0]).toMatchObject({ ...request, target, clientId: "isolated-private-client", environment: "staging", issuedAt: 1000000, expiresAt: 1005000 });
  expect(challenges[0]!.nonce).not.toBe(challenges[1]!.nonce);
  expect(challenges[0]!.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(Object.isFrozen(challenges[0])).toBe(true);
  expect(Object.isFrozen(challenges[0]!.target)).toBe(true);
});

test("absent issuer or transport stays unavailable even with complete-looking owner metadata", async () => {
  let reads = 0;
  const input = { target, clientId: "isolated-private-client", environment: "staging" as const, now: () => 1000000 };
  const noIssuer = createReviewedRecoveryIssuerAvailabilityReader({ ...input, readSignedStatus: async (challenge) => { reads++; return signed(challenge); } });
  const noTransport = createReviewedRecoveryIssuerAvailabilityReader({ ...input, reviewIssuer });
  expect(isReviewedRecoveryIssuerAvailabilityReader(noIssuer, target)).toBe(true);
  expect(await noIssuer.isAvailable(request)).toBe(false);
  expect(await noTransport.isAvailable(request)).toBe(false);
  expect(reads).toBe(0);
});

test("factory captures key, client, target and transport independently of later composition edits", async () => {
  const issuer = { ...reviewIssuer }, mutableTarget = { ...target };
  const input = { reviewIssuer: issuer, target: mutableTarget, clientId: "isolated-private-client", environment: "staging" as const,
    readSignedStatus: (challenge: ReviewedRecoveryIssuerAvailabilityChallenge) => signed(challenge), now: () => 1000000 };
  const reader = createReviewedRecoveryIssuerAvailabilityReader(input);
  issuer.publicKey = foreignKeys.publicKey;
  mutableTarget.ownerClientId = "caller-replacement";
  input.clientId = "foreign-client";
  input.readSignedStatus = async () => { throw new Error("replaced"); };
  expect(await reader.isAvailable(request)).toBe(true);
  expect(isReviewedRecoveryIssuerAvailabilityReader(reader, target)).toBe(true);
});

test("a signature by an unqualified key is unavailable", async () => {
  const f = fixture((challenge) => signed(challenge, undefined, foreignKeys.privateKey));
  expect(await f.reader.isAvailable(request)).toBe(false);
});

const mutations: [string, (record: ReviewedRecoveryIssuerAvailabilityStatus) => void][] = [
  ["issuer", (record) => { Object.assign(record.attestation, { issuer: "foreign-issuer" }); }],
  ["key id", (record) => { Object.assign(record.attestation, { keyId: "foreign-key" }); }],
  ["algorithm", (record) => { Object.assign(record.attestation, { algorithm: "RS256" }); }],
  ["status version", (record) => { Object.assign(record, { version: "foreign-status-domain" }); }],
  ["challenge version", (record) => { Object.assign(record.challenge, { version: "foreign-challenge-domain" }); }],
  ["audience", (record) => { Object.assign(record.challenge, { clientId: "foreign-private-client" }); }],
  ["target", (record) => { Object.assign(record.challenge.target, { ownerClientId: "foreign-owner" }); }],
  ["target digest", (record) => { Object.assign(record.challenge.target, { targetBindingDigest: "sha256:" + "A".repeat(43) }); }],
  ["environment", (record) => { Object.assign(record.challenge, { environment: "production" }); }],
  ["nonce", (record) => { Object.assign(record.challenge, { nonce: "A".repeat(43) }); }],
  ["operation id", (record) => { Object.assign(record.challenge, { operationId: "foreign-operation" }); }],
  ["kind", (record) => { Object.assign(record.challenge, { kind: "restore-after-active" }); }],
  ["plan digest", (record) => { Object.assign(record.challenge, { planDigest: "foreign-plan" }); }],
  ["future issue time", (record) => { Object.assign(record.challenge, { issuedAt: record.challenge.issuedAt + 1 }); }],
  ["expiry", (record) => { Object.assign(record.challenge, { expiresAt: record.challenge.expiresAt - 1 }); }],
  ["excessive lifetime", (record) => { Object.assign(record.challenge, { expiresAt: record.challenge.issuedAt + 5001 }); }],
  ["extra approval", (record) => { Object.assign(record, { recoveryId: "caller-recovery", approved: true }); }],
  ["extra challenge claim", (record) => { Object.assign(record.challenge, { humanReview: true }); }],
  ["extra attestation claim", (record) => { Object.assign(record.attestation, { reviewer: "caller-reviewer" }); }],
];
for (const [name, mutate] of mutations) {
  test(`correctly signed ${name} mismatch never establishes availability`, async () => {
    expect(await fixture((challenge) => signed(challenge, mutate)).reader.isAvailable(request)).toBe(false);
  });
}

test("availability signature cannot use the human-review signature domain", async () => {
  const f = fixture(async (challenge) => {
    const record = await signed(challenge);
    Object.assign(record.attestation, { signature: base64UrlEncodeBytes(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey,
      reviewedRecoverySignatureInput(await sha256Text("isolated-review-decision")).buffer as ArrayBuffer))) });
    return record;
  });
  expect(await f.reader.isAvailable(request)).toBe(false);
});

test("post-signature body mutation and noncanonical signature encoding fail closed", async () => {
  for (const mutate of [
    (record: ReviewedRecoveryIssuerAvailabilityStatus) => { Object.assign(record.challenge, { planDigest: "post-signature-plan" }); },
    (record: ReviewedRecoveryIssuerAvailabilityStatus) => { Object.assign(record, { status: "unavailable" }); },
    (record: ReviewedRecoveryIssuerAvailabilityStatus) => { Object.assign(record.attestation, { signature: record.attestation.signature + "=" }); },
  ]) {
    const f = fixture(async (challenge) => { const record = await signed(challenge); mutate(record); return record; });
    expect(await f.reader.isAvailable(request)).toBe(false);
  }
});

test("signed unavailable never becomes human approval or availability", async () => {
  expect(await fixture((challenge) => signed(challenge, (record) => { Object.assign(record, { status: "unavailable" }); })).reader.isAvailable(request)).toBe(false);
  const f = fixture(async (challenge) => {
    const record = await signed(challenge, (value) => { Object.assign(value, { status: "unavailable" }); });
    Object.assign(record, { status: "available" });
    return record;
  });
  expect(await f.reader.isAvailable(request)).toBe(false);
});

test("sequential and concurrent replay of the first signed response fails for every later nonce", async () => {
  let saved: Promise<ReviewedRecoveryIssuerAvailabilityStatus> | undefined;
  const f = fixture((challenge) => saved ??= signed(challenge));
  const results = await Promise.all([f.reader.isAvailable(request), f.reader.isAvailable(request)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await f.reader.isAvailable(request)).toBe(false);
  expect(await f.reader.isAvailable({ ...request, operationId: "different-operation" })).toBe(false);
});

test("trusted clock must remain valid and fresh after transport and signature awaits", async () => {
  for (const endTime of [999999, 1001000, 1005000, Number.NaN, Number.POSITIVE_INFINITY]) {
    let f: ReturnType<typeof fixture>;
    f = fixture(async (challenge) => { const result = await signed(challenge); f.time(endTime); return result; });
    expect(await f.reader.isAvailable(request)).toBe(false);
  }
  for (const initial of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    let reads = 0;
    const f = fixture(async (challenge) => { reads++; return signed(challenge); });
    f.time(initial);
    expect(await f.reader.isAvailable(request)).toBe(false);
    expect(reads).toBe(0);
  }
});

test("clock is rechecked after crypto verification, not only after the transport", async () => {
  let calls = 0;
  const reader = createReviewedRecoveryIssuerAvailabilityReader({ reviewIssuer, target, clientId: "isolated-private-client", environment: "staging",
    readSignedStatus: (challenge) => signed(challenge), now: () => ++calls < 3 ? 1000000 : 1005000 });
  expect(await reader.isAvailable(request)).toBe(false);
  expect(calls).toBe(3);
  const times = [1000000, 1000100, 1000050];
  const rollbackReader = createReviewedRecoveryIssuerAvailabilityReader({ reviewIssuer, target, clientId: "isolated-private-client", environment: "staging",
    readSignedStatus: (challenge) => signed(challenge), now: () => times.shift()! });
  expect(await rollbackReader.isAvailable(request)).toBe(false);
});

test("bounded deadline aborts a hanging transport; late responses cannot be redeemed", async () => {
  let signal: AbortSignal | undefined, finish: ((value: unknown) => void) | undefined;
  let challenge: ReviewedRecoveryIssuerAvailabilityChallenge | undefined;
  const reader = createReviewedRecoveryIssuerAvailabilityReader({ reviewIssuer, target, clientId: "isolated-private-client", environment: "staging", timeoutMs: 5,
    now: () => 1000000, readSignedStatus: async (value, context) => { challenge = value; signal = context.signal; return new Promise((resolve) => { finish = resolve; }); } });
  expect(await reader.isAvailable(request)).toBe(false);
  expect(signal?.aborted).toBe(true);
  finish!(await signed(challenge!));
});

test("throwing or malformed transport cannot turn an arbitrary object into proof", async () => {
  for (const response of [undefined, true, {}, [], { available: true }, "available", { status: "available", approval: true }]) {
    expect(await fixture(async () => response).reader.isAvailable(request)).toBe(false);
  }
  expect(await fixture(async () => { throw new Error("issuer-unreachable"); }).reader.isAvailable(request)).toBe(false);
});

test("missing exact operation or an invalid configuration never calls the transport", async () => {
  let reads = 0;
  const input = { reviewIssuer, target, clientId: "isolated-private-client", environment: "staging" as const,
    readSignedStatus: async (challenge: ReviewedRecoveryIssuerAvailabilityChallenge) => { reads++; return signed(challenge); }, now: () => 1000000 };
  const reader = createReviewedRecoveryIssuerAvailabilityReader(input);
  for (const invalid of [{ ...request, target }, { ...request, kind: "unknown" }, { ...request, operationId: "" }, { ...request, planDigest: "a".repeat(257) }, { kind: "merge" }]) {
    expect(await reader.isAvailable(invalid as never)).toBe(false);
  }
  for (const timeoutMs of [0, -1, 5001, Number.NaN]) {
    expect(await createReviewedRecoveryIssuerAvailabilityReader({ ...input, timeoutMs }).isAvailable(request)).toBe(false);
  }
  expect(await createReviewedRecoveryIssuerAvailabilityReader({ ...input, environment: "production" as never }).isAvailable(request)).toBe(false);
  expect(reads).toBe(0);
});

function mutationFixture(): IdentityMergeMutation {
  return { expectedRevision: 2, now: 1000000, reserve: true, retryCapacity: 100,
    next: { operationId: request.operationId, sourceSubject: "isolated-source", targetSubject: "isolated-target", actor: "isolated-target",
      addressDigest: "isolated-address", browserBindingHash: "isolated-browser", policyVersion: "isolated-policy", status: "proved",
      revision: 3, mutationId: "isolated-mutation", createdAt: 999000, updatedAt: 1000000, consentAt: 1000000, expiresAt: 1000500,
      contextPlan: { planId: "isolated-plan", planDigest: request.planDigest, planningRevision: 1, authorityId: "isolated-core", authorityVersion: "isolated-version", canonicalPersonalWorkspaceId: "isolated-workspace" } } };
}

async function boundCheckpoint(f = fixture(), mutation = mutationFixture(), bounds = { notBefore: 1000000, expiresAtExclusive: 1000500 }) {
  const checkpoint = await f.reader.getAvailabilityCheckpoint(request);
  expect(checkpoint).toBeDefined();
  expect(bindReviewedRecoveryIssuerAvailabilityCheckpoint(checkpoint, { target, mutation, ...bounds })).toBe(true);
  return { ...f, checkpoint, mutation };
}

test("one actual signed status mints a synchronous, one-use local precommit checkpoint", async () => {
  let reads = 0;
  const f = await boundCheckpoint(fixture(async (challenge) => { reads++; return signed(challenge); }));
  expect(reads).toBe(1);
  expect(Object.isFrozen(f.checkpoint)).toBe(true);
  expect(Object.keys(f.checkpoint!)).toEqual([]);
  f.time(1000100);
  expect(readReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, f.mutation)).toBe(1000100);
  const local = { ...f.mutation, now: 1000100 };
  expect(consumeReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, local)).toBe(1000100);
  expect(reads).toBe(1);
  expect(readReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, local)).toBeUndefined();
  expect(consumeReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, local)).toBeUndefined();
});

test("booleans, copied methods, forged objects and cloned checkpoints never pass the synchronous guard", async () => {
  const f = await boundCheckpoint();
  const available = await f.reader.isAvailable(request);
  for (const fake of [undefined, true, available, {}, { ...f.checkpoint }, structuredClone(f.checkpoint), Object.create(f.checkpoint!),
    { ...f.reader }, { read: () => 1000000, consume: () => true }, f.reader.getAvailabilityCheckpoint]) {
    expect(readReviewedRecoveryIssuerAvailabilityCheckpoint(fake, f.mutation)).toBeUndefined();
    expect(consumeReviewedRecoveryIssuerAvailabilityCheckpoint(fake, f.mutation)).toBeUndefined();
    expect(bindReviewedRecoveryIssuerAvailabilityCheckpoint(fake, { target, mutation: f.mutation, notBefore: 1000000, expiresAtExclusive: 1000500 })).toBe(false);
  }
  expect(consumeReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, f.mutation)).toBe(1000000);
});

test("an unbound checkpoint cannot dispatch and identical initial binding is idempotent", async () => {
  const f = fixture(), mutation = mutationFixture();
  const checkpoint = await f.reader.getAvailabilityCheckpoint(request);
  expect(readReviewedRecoveryIssuerAvailabilityCheckpoint(checkpoint, mutation)).toBeUndefined();
  const binding = { target, mutation, notBefore: 1000000, expiresAtExclusive: 1000500 };
  expect(bindReviewedRecoveryIssuerAvailabilityCheckpoint(checkpoint, binding)).toBe(true);
  expect(bindReviewedRecoveryIssuerAvailabilityCheckpoint(checkpoint, binding)).toBe(true);
  expect(bindReviewedRecoveryIssuerAvailabilityCheckpoint(checkpoint, { ...binding, expiresAtExclusive: 1000499 })).toBe(false);
  expect(consumeReviewedRecoveryIssuerAvailabilityCheckpoint(checkpoint, mutation)).toBe(1000000);
  expect(bindReviewedRecoveryIssuerAvailabilityCheckpoint(checkpoint, binding)).toBe(false);
});

test("target and operation provenance must match before a checkpoint can bind", async () => {
  const f = fixture(), mutation = mutationFixture();
  const checkpoint = await f.reader.getAvailabilityCheckpoint(request);
  expect(bindReviewedRecoveryIssuerAvailabilityCheckpoint(checkpoint, { target: { ...target, ownerClientId: "foreign-owner" }, mutation, notBefore: 1000000, expiresAtExclusive: 1000500 })).toBe(false);
  expect(bindReviewedRecoveryIssuerAvailabilityCheckpoint(checkpoint, { target, mutation: { ...mutation, next: { ...mutation.next, operationId: "other-operation" } }, notBefore: 1000000, expiresAtExclusive: 1000500 })).toBe(false);
  const unlink = await f.reader.getAvailabilityCheckpoint({ ...request, kind: "unlink" });
  expect(bindReviewedRecoveryIssuerAvailabilityCheckpoint(unlink, { target, mutation, notBefore: 1000000, expiresAtExclusive: 1000500 })).toBe(false);
  expect(bindReviewedRecoveryIssuerAvailabilityCheckpoint(checkpoint, { target, mutation, notBefore: 1000000, expiresAtExclusive: 1000500 })).toBe(true);
});

const mutationChanges: [string, (mutation: IdentityMergeMutation) => void][] = [
  ["operation", (mutation) => { mutation.next.operationId = "other-operation"; }],
  ["pair", (mutation) => { mutation.next.sourceSubject = "other-source"; }],
  ["revision", (mutation) => { mutation.expectedRevision++; mutation.next.revision++; }],
  ["plan", (mutation) => { mutation.next.contextPlan!.planDigest = "other-plan"; }],
  ["mutation id", (mutation) => { mutation.next.mutationId = "other-mutation"; }],
  ["action", (mutation) => { mutation.activate = true; }],
  ["snapshot deadline", (mutation) => { mutation.next.expiresAt++; }],
  ["session snapshot", (mutation) => { mutation.sessions = [{ subject: "isolated-target", authTime: 1, sessionId: "caller-session" }]; }],
  ["audit time", (mutation) => { mutation.next.updatedAt++; }],
];
for (const [name, mutate] of mutationChanges) {
  test(`bound checkpoint rejects a different ${name} without promoting a refreshed input.now`, async () => {
    const f = await boundCheckpoint();
    const changed = structuredClone(f.mutation);
    mutate(changed);
    expect(readReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, changed)).toBeUndefined();
    expect(consumeReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, changed)).toBeUndefined();
    expect(consumeReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, f.mutation)).toBeUndefined();
  });
}

test("binding captures bounds and mutation synchronously without retaining mutable caller objects", async () => {
  const f = await boundCheckpoint();
  f.mutation.next.sourceSubject = "caller-mutated-source";
  expect(readReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, f.mutation)).toBeUndefined();
  expect(consumeReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, mutationFixture())).toBe(1000000);
});

test("snapshot expiry and earlier owning-capture expiry remain binding during backend async preparation", async () => {
  for (const expiry of [1000001, 1000300, 1000500]) {
    const f = await boundCheckpoint(fixture(), mutationFixture(), { notBefore: 1000000, expiresAtExclusive: expiry });
    let writes = 0;
    await Promise.resolve();
    f.time(expiry);
    const now = readReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, f.mutation);
    if (now !== undefined && consumeReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, { ...f.mutation, now }) !== undefined) writes++;
    expect(now).toBeUndefined();
    expect(writes).toBe(0);
  }
});

test("status deadline is independently enforced even when all caller snapshot bounds last longer", async () => {
  const f = await boundCheckpoint(fixture(), mutationFixture(), { notBefore: 1000000, expiresAtExclusive: 1010000 });
  await Promise.resolve();
  f.time(1001000);
  expect(readReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, f.mutation)).toBeUndefined();
  f.time(1000000);
  expect(consumeReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, f.mutation)).toBeUndefined();
});

test("clock rollback, future caller now and an earlier refreshed now cannot satisfy a bound checkpoint", async () => {
  const f = await boundCheckpoint();
  f.time(1000100);
  expect(readReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, f.mutation)).toBe(1000100);
  expect(readReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, { ...f.mutation, now: 1000101 })).toBeUndefined();
  expect(readReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, { ...f.mutation, now: 999999 })).toBeUndefined();
  f.time(1000050);
  expect(readReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, f.mutation)).toBeUndefined();
  f.time(1000100);
  expect(consumeReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, f.mutation)).toBeUndefined();
});

test("consume rechecks the clock after a valid peek and permits at most one concurrent local write", async () => {
  const f = await boundCheckpoint();
  expect(readReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, f.mutation)).toBe(1000000);
  f.time(1000500);
  expect(consumeReviewedRecoveryIssuerAvailabilityCheckpoint(f.checkpoint, f.mutation)).toBeUndefined();
  const other = await boundCheckpoint();
  let writes = 0;
  const dispatch = async () => {
    await Promise.resolve();
    const now = readReviewedRecoveryIssuerAvailabilityCheckpoint(other.checkpoint, other.mutation);
    if (now === undefined) return;
    const local = { ...other.mutation, now };
    if (consumeReviewedRecoveryIssuerAvailabilityCheckpoint(other.checkpoint, local) !== undefined) writes++;
  };
  await Promise.all([dispatch(), dispatch()]);
  expect(writes).toBe(1);
});

test("invalid capture bounds and missing issuer cannot mint or bind a usable checkpoint", async () => {
  const f = fixture(), mutation = mutationFixture();
  for (const bounds of [{ notBefore: 1000001, expiresAtExclusive: 1000500 }, { notBefore: 999999, expiresAtExclusive: 1000500 },
    { notBefore: 1000000, expiresAtExclusive: 1000000 }, { notBefore: Number.NaN, expiresAtExclusive: 1000500 }]) {
    const checkpoint = await f.reader.getAvailabilityCheckpoint(request);
    expect(bindReviewedRecoveryIssuerAvailabilityCheckpoint(checkpoint, { target, mutation, ...bounds })).toBe(false);
  }
  const unconfigured = createReviewedRecoveryIssuerAvailabilityReader({ target, clientId: "isolated-private-client", environment: "staging" });
  expect(await unconfigured.getAvailabilityCheckpoint(request)).toBeUndefined();
});

test("a genuine checkpoint from a different module instance cannot cross process-local custody", async () => {
  // Bun canonicalizes file query suffixes to the same module. Load the exact
  // source in memory as another module, retaining its real imported verifier.
  const sourceUrl = new URL("../../../../accounts/service/src/reviewed-recovery-issuer-availability.ts", import.meta.url);
  const source = await Bun.file(sourceUrl).text();
  const javascript = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(source)
    .replaceAll("./owner-operation-evidence.ts", new URL("./owner-operation-evidence.ts", sourceUrl).href)
    .replaceAll("./encoding.ts", new URL("./encoding.ts", sourceUrl).href);
  const foreign = await import(`data:text/javascript;base64,${btoa(javascript)}`);
  const foreignReader = foreign.createReviewedRecoveryIssuerAvailabilityReader({ reviewIssuer, target, clientId: "isolated-private-client", environment: "staging",
    readSignedStatus: (challenge: ReviewedRecoveryIssuerAvailabilityChallenge) => signed(challenge), now: () => 1000000 });
  const foreignCheckpoint = await foreignReader.getAvailabilityCheckpoint(request), mutation = mutationFixture();
  const binding = { target, mutation, notBefore: 1000000, expiresAtExclusive: 1000500 };
  expect(foreign.bindReviewedRecoveryIssuerAvailabilityCheckpoint(foreignCheckpoint, binding)).toBe(true);
  expect(readReviewedRecoveryIssuerAvailabilityCheckpoint(foreignCheckpoint, mutation)).toBeUndefined();
  expect(consumeReviewedRecoveryIssuerAvailabilityCheckpoint(foreignCheckpoint, mutation)).toBeUndefined();
  const local = await boundCheckpoint();
  expect(foreign.readReviewedRecoveryIssuerAvailabilityCheckpoint(local.checkpoint, local.mutation)).toBeUndefined();
  expect(consumeReviewedRecoveryIssuerAvailabilityCheckpoint(local.checkpoint, local.mutation)).toBe(1000000);
  expect(foreign.consumeReviewedRecoveryIssuerAvailabilityCheckpoint(foreignCheckpoint, mutation)).toBe(1000000);
});
