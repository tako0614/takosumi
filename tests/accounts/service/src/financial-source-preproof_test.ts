import { expect, test } from "bun:test";
import { InMemoryAccountsStore, type TokenRecord } from "../../../../accounts/service/src/store.ts";
import {
  createAccountsFinancialSource, consumeFinancialSourcePrecommitCheckpoint,
  type AccountsFinancialSourceOptions,
} from "../../../../accounts/service/src/financial-source.ts";
import type {
  FinancialSourceEnrollmentMutation, FinancialSourceParentHead, FinancialSourceParentScope,
  FinancialSourceParentVector, FinancialSourceRawRecord, FinancialSourceMaterializationRecord,
  FinancialSourceProofMutation,
} from "../../../../accounts/service/src/identity-state.ts";
import type { FinancialSourceReceiptRecord, FinancialSourceMaterialization } from "../../../../accounts/service/src/financial-source-contract.ts";

// This fixture uses actual Accounts token/grant/canonical readers. Only the new
// financial repository/Control/receiver seam is synthetic here; backend atomic
// CAS and native store proofs live in the separate store suites.
async function fixture() {
  const store = new InMemoryAccountsStore();
  const subject = "tsub_financial_producer";
  let time = 1_000_000, writes = 0, deliveries = 0, failDeliveryOnce = false;
  const clock = () => time;
  const token = "actual-synthetic-access";
  const issuer = "https://issuer.example.test";
  const record: TokenRecord = {clientId: "hosted", oidcProfile: "shared-account", issuer, subject,
    takosumiSubject: subject, sid: "sid-real", issuerSessionId: "anchor-real", identityGeneration: 0,
    authTime: 990, scope: "openid", expiresAt: time + 200_000};
  await store.saveAccount({subject, createdAt: time, updatedAt: time});
  await store.saveAccessToken(token, record);
  await store.saveHostedOidcGrant({sid: record.sid!, issuerSessionId: record.issuerSessionId!, clientId: "hosted", issuer,
    subject, identityGeneration: 0, scope: "openid", authTime: 990, createdAt: time, absoluteExpiresAt: time + 300_000});
  const registration = {registrationRef: "registration-real", incarnation: "incarnation-real", genesisDigest: `sha256:${"a".repeat(64)}` as const,
    receivers: [{receiverRef: "financial-primary", targetRef: "qualified-target"}]};
  const challenge = {v: 1 as const, challengeRef: "challenge-real", registrationRef: registration.registrationRef,
    clientId: "hosted", workspaceId: "workspace-real", organizationId: "organization-real", workspaceRef: "workspace-original",
    requestFingerprint: `sha256:${"b".repeat(64)}` as const, createdAt: time, expiresAt: time + 120_000};
  const snapshot = {workspaceId: challenge.workspaceId, organizationId: challenge.organizationId, workspaceRef: challenge.workspaceRef,
    accountId: subject, evidence: {evidenceRef: "control-current-evidence", evidenceDigest: `sha256:${"c".repeat(64)}` as const, expiresAt: time + 120_000,
      source: {registrationRef: "control-workspace-source", incarnation: "control-workspace-incarnation", affectedRef: "workspace-real", sequence: 0, eventRef: null,
        eventDigest: `sha256:${"d".repeat(64)}` as const, receivers: [{receiverRef: "financial-primary", targetRef: "qualified-target"}]}}};
  const heads = new Map<string, FinancialSourceParentHead>();
  const raw = new Map<string, FinancialSourceRawRecord>();
  const materials = new Map<string, FinancialSourceMaterializationRecord>();
  const receipts = new Map<string, FinancialSourceReceiptRecord>();
  const remote = new Map<string, FinancialSourceMaterialization>();
  const key = (scope: FinancialSourceParentScope) => JSON.stringify(scope);
  let beforeEnrollment: ((input: FinancialSourceEnrollmentMutation) => void) | undefined;
  let beforeControl: (() => Promise<void>) | undefined;
  const slots = ["grant", "issuerSession", "client", "accountGeneration"] as const;
  Object.assign(store, {
    findFinancialSourceRegistration: async () => registration,
    findFinancialSourceParent: async (scope: FinancialSourceParentScope) => heads.get(key(scope)),
    async enrollFinancialSourceParents(input: FinancialSourceEnrollmentMutation) {
      beforeEnrollment?.(input);
      if (consumeFinancialSourcePrecommitCheckpoint(input) === undefined) return undefined;
      const result = {} as { -readonly [K in keyof FinancialSourceParentVector<FinancialSourceParentHead>]: FinancialSourceParentHead };
      for (const slot of slots) {
        const p = input.parents[slot];
        const existing = heads.get(key(p.scope));
        const head: FinancialSourceParentHead = existing ?? {v: 1, scope: p.scope, registrationRef: registration.registrationRef,
          incarnation: registration.incarnation, affectedRef: p.affectedRef, revision: 0, sequence: 1,
          lastEventRef: p.eventRef, state: "open", createdAt: time, updatedAt: time};
        if (!existing) {
          heads.set(key(p.scope), head);
          raw.set(head.lastEventRef, {raw: {v: 1, eventRef: p.eventRef, registrationRef: head.registrationRef,
            incarnation: head.incarnation, sequence: 1, previousEventRef: null, kind: "advance", affectedRef: head.affectedRef,
            evidenceRef: challenge.challengeRef}, parent: p.scope, parentRevision: 0, capturedAt: time,
            cause: {kind: "enrollment", challengeRef: challenge.challengeRef, accessTokenHash: input.accessTokenHash, sid: record.sid!, identityGeneration: 0}});
        }
        result[slot] = head;
      }
      writes++;
      return result;
    },
    findFinancialSourceRaw: async (ref: string) => raw.get(ref),
    findFinancialSourceMaterialization: async (ref: string) => materials.get(ref),
    async commitFinancialSourceMaterialization(input: {expectedRaw: FinancialSourceRawRecord; materialization: FinancialSourceMaterialization}) {
      materials.set(input.expectedRaw.raw.eventRef, {rawRecord: input.expectedRaw, materialization: input.materialization}); return true;
    },
    findFinancialSourceReceipt: async (input: {eventRef: string; receiverRef: string}) => receipts.get(input.eventRef + input.receiverRef),
    async recordFinancialSourceReceipt(input: {receipt: FinancialSourceReceiptRecord}) {
      receipts.set(input.receipt.receipt.eventRef + input.receipt.receiverRef, input.receipt); return true;
    },
    async listFinancialSourcePending(input: {after?: string; limit: number}) {
      const all = [...raw.keys()].sort().filter((ref) => ref > (input.after ?? ""));
      const page = all.slice(0, input.limit);
      return {entries: page.map((eventRef) => ({registration, eventRef, createdAt: time})), nextCursor: all.length > page.length ? page.at(-1) : undefined};
    },
    async issueFinancialSourceProof(input: FinancialSourceProofMutation) {
      if (consumeFinancialSourcePrecommitCheckpoint(input) === undefined) return undefined;
      writes++; return input.proof;
    },
  });
  function receipt(m: FinancialSourceMaterialization) {
    return {v: 1 as const, eventRef: m.event.eventRef, eventDigest: m.eventDigest, receiptRef: "receipt/" + m.event.eventRef,
      incarnation: m.event.incarnation, sequence: m.event.sequence, state: m.event.kind === "close" ? "admission-closed" as const : "advanced" as const};
  }
  const options: AccountsFinancialSourceOptions = {store, issuer, registration, now: clock,
    clients: [{clientId: "hosted", profile: "shared-account", enabled: true, allowedScopes: ["openid"], redirectUris: ["https://app.example.test/callback"]}],
    challenges: {async read() { return structuredClone(challenge); }},
    control: {async capture() {await beforeControl?.(); return structuredClone(snapshot); }, async assertCurrent() { return true; }},
    receivers: [{receiverRef: "financial-primary", targetRef: "qualified-target", async read(m) { const prior = remote.get(m.event.eventRef); return prior ? receipt(prior) : undefined; },
      async deliver(m) { deliveries++; remote.set(m.event.eventRef, m); if (failDeliveryOnce) {failDeliveryOnce = false; throw new Error("lost_ack");} return receipt(m); }}]};
  const producer = () => createAccountsFinancialSource(options);
  return {store, options, producer, token, record, challenge, snapshot, heads, raw, materials, receipts,
    time: (value: number) => {time = value;}, deliveries: () => deliveries, writes: () => writes,
    beforeEnrollment: (fn: typeof beforeEnrollment) => {beforeEnrollment = fn;}, beforeControl: (fn: typeof beforeControl) => {beforeControl = fn;},
    loseAck: () => {failDeliveryOnce = true;}};
}

test("fresh pre-proof preparation commits four exact originals before any receiver ACK", async () => {
  const f = await fixture();
  const p = createAccountsFinancialSource({...f.options, receivers: undefined});
  const prepared = await p.prepareFinancialIdentityProofSource({accessToken: f.token, challengeRef: f.challenge.challengeRef});
  expect(prepared.kind).toBe("fresh");
  expect(prepared.registration).toEqual(f.options.registration);
  expect(Object.keys(prepared.parents).sort()).toEqual(["accountGeneration", "client", "grant", "issuerSession"]);
  expect(f.heads.size).toBe(4);
  expect(f.raw.size).toBe(4);
  expect(f.receipts.size).toBe(0);
  expect(f.deliveries()).toBe(0);
  for (const slot of ["grant", "issuerSession", "client", "accountGeneration"] as const) {
    const original = prepared.parents[slot];
    expect(original.key).toEqual({registrationRef: f.options.registration.registrationRef,
      incarnation: f.options.registration.incarnation, affectedRef: original.materialization.event.affectedRef});
    expect(original.eventRef).toBe(original.materialization.event.eventRef);
    expect(original.materialization.event.sequence).toBe(1);
    expect(original.materialization.event.previousDigest).toBe(f.options.registration.genesisDigest);
  }
  expect(JSON.stringify(prepared)).not.toContain(f.token);
  expect(JSON.stringify(prepared)).not.toContain(f.record.sid);
  expect(JSON.stringify(prepared)).not.toContain(f.record.issuerSessionId);
  expect(JSON.stringify(prepared)).not.toContain("accessTokenHash");
  await expect(f.producer().prove({accessToken: f.token, challengeRef: f.challenge.challengeRef})).rejects.toThrow("source_pending");
  const replay = await p.prepareFinancialIdentityProofSource({accessToken: f.token, challengeRef: f.challenge.challengeRef});
  expect(replay).toEqual(prepared);
  expect(f.heads.size).toBe(4);
});

test("fresh preparation rejects changed challenge and revoked original grant", async () => {
  const changed = await fixture();
  changed.beforeControl(async () => {changed.challenge.workspaceRef = "changed";});
  await expect(changed.producer().prepareFinancialIdentityProofSource({accessToken: changed.token,
    challengeRef: changed.challenge.challengeRef})).rejects.toThrow("invalid_challenge");
  expect(changed.writes()).toBe(0);
  const revoked = await fixture();
  await revoked.store.revokeHostedOidcGrant(revoked.record.sid!, 1_000_001);
  await expect(revoked.producer().prepareFinancialIdentityProofSource({accessToken: revoked.token,
    challengeRef: revoked.challenge.challengeRef})).rejects.toThrow("invalid_grant");
  expect(revoked.writes()).toBe(0);
});

test("pre-proof export refuses a corrupted stored materialization on Memory path", async () => {
  const f = await fixture();
  const p = f.producer();
  const prepared = await p.prepareFinancialIdentityProofSource({accessToken: f.token, challengeRef: f.challenge.challengeRef});
  const eventRef = prepared.parents.grant.eventRef;
  const saved = f.materials.get(eventRef)!;
  f.materials.set(eventRef, {...saved, materialization: {...saved.materialization,
    eventDigest: `sha256:${"0".repeat(64)}`}});
  await expect(p.prepareFinancialIdentityProofSource({accessToken: f.token,
    challengeRef: f.challenge.challengeRef})).rejects.toThrow("source_conflict");
});

test("pre-proof export refuses replacement of the full private raw original", async () => {
  const f = await fixture();
  const p = f.producer();
  const prepared = await p.prepareFinancialIdentityProofSource({accessToken: f.token, challengeRef: f.challenge.challengeRef});
  const eventRef = prepared.parents.grant.eventRef;
  const original = f.raw.get(eventRef)!;
  f.raw.set(eventRef, {...original, capturedAt: original.capturedAt + 1});
  await expect(p.prepareFinancialIdentityProofSource({accessToken: f.token,
    challengeRef: f.challenge.challengeRef})).rejects.toThrow("source_conflict");
});

test("pre-proof export validates private enrollment cause even if raw and stored copies agree", async () => {
  const f = await fixture();
  const p = f.producer();
  const prepared = await p.prepareFinancialIdentityProofSource({accessToken: f.token, challengeRef: f.challenge.challengeRef});
  const eventRef = prepared.parents.grant.eventRef;
  const raw = f.raw.get(eventRef)!;
  const replaced = {...raw, cause: {...raw.cause, sid: "unrelated-sid"}} as FinancialSourceRawRecord;
  f.raw.set(eventRef, replaced);
  f.materials.set(eventRef, {...f.materials.get(eventRef)!, rawRecord: replaced});
  await expect(p.prepareFinancialIdentityProofSource({accessToken: f.token,
    challengeRef: f.challenge.challengeRef})).rejects.toThrow("source_conflict");
});

test("fresh preparation needs no proof or receipt capability", async () => {
  const f = await fixture();
  Object.assign(f.store, {issueFinancialSourceProof: undefined, findFinancialSourceReceipt: undefined,
    recordFinancialSourceReceipt: undefined});
  const prepared = await createAccountsFinancialSource({...f.options, receivers: undefined})
    .prepareFinancialIdentityProofSource({accessToken: f.token, challengeRef: f.challenge.challengeRef});
  expect(Object.keys(prepared.parents)).toHaveLength(4);
  expect(f.receipts.size).toBe(0);
  expect(f.deliveries()).toBe(0);
});

test("fresh preparation refuses an unsupported later parent head", async () => {
  const f = await fixture();
  const p = f.producer();
  await p.prepareFinancialIdentityProofSource({accessToken: f.token, challengeRef: f.challenge.challengeRef});
  const grantKey = JSON.stringify({kind: "grant", sid: f.record.sid});
  const original = f.heads.get(grantKey)!;
  f.heads.set(grantKey, {...original, sequence: 2, revision: 1, lastEventRef: "later-original-event"});
  await expect(p.prepareFinancialIdentityProofSource({accessToken: f.token,
    challengeRef: f.challenge.challengeRef})).rejects.toThrow("source_pending");
});

test("fresh preparation rechecks the actual Control deadline after materialization awaits", async () => {
  const f = await fixture();
  f.snapshot.evidence.expiresAt = 1_000_100;
  const originalCommit = f.store.commitFinancialSourceMaterialization.bind(f.store);
  let advanced = false;
  f.store.commitFinancialSourceMaterialization = async input => {
    const committed = await originalCommit(input);
    if (!advanced) {advanced = true; f.time(1_000_101);}
    return committed;
  };
  await expect(f.producer().prepareFinancialIdentityProofSource({accessToken: f.token,
    challengeRef: f.challenge.challengeRef})).rejects.toThrow("source_unavailable");
  expect(f.receipts.size).toBe(0);
  expect(f.deliveries()).toBe(0);
});

test("historical pending page retains exact originals after token expiry without grant or delivery", async () => {
  const f = await fixture();
  const p = f.producer();
  await p.prepareFinancialIdentityProofSource({accessToken: f.token, challengeRef: f.challenge.challengeRef});
  const priorWrites = f.writes();
  f.time(1_201_000);
  const page = await p.preparePendingFinancialSourceOriginals({limit: 1});
  expect(page.kind).toBe("historical");
  expect(page.entries).toHaveLength(1);
  expect(page.nextCursor).toBeString();
  expect(page.entries[0]!.original.materialization.event.sequence).toBe(1);
  expect(f.writes()).toBe(priorWrites);
  expect(f.deliveries()).toBe(0);
  expect(f.receipts.size).toBe(0);
  const rest = await p.preparePendingFinancialSourceOriginals({after: page.nextCursor, limit: 3});
  expect(rest.entries).toHaveLength(3);
});

test("actual Memory Accounts repository prepares original four parents before ACK and reads them after expiry", async () => {
  const store = new InMemoryAccountsStore();
  let time = 1_000_000;
  const subject = "tsub_preproof_actual_memory", token = "preproof-test-only-token", sid = "sid-preproof";
  const issuer = "https://issuer.example.test";
  const registration = {registrationRef: "preproof-original-registration", incarnation: "preproof-original-incarnation",
    genesisDigest: `sha256:${"a".repeat(64)}` as const,
    receivers: [{receiverRef: "synthetic-financial-receiver", targetRef: "synthetic-target"}]};
  const challenge = {v: 1 as const, challengeRef: "preproof-original-challenge", registrationRef: registration.registrationRef,
    clientId: "hosted", workspaceId: "preproof-workspace", organizationId: "preproof-org", workspaceRef: "preproof-workspace-ref",
    requestFingerprint: `sha256:${"b".repeat(64)}` as const, createdAt: time, expiresAt: time + 120_000};
  const record: TokenRecord = {clientId: "hosted", oidcProfile: "shared-account", issuer, subject,
    takosumiSubject: subject, sid, issuerSessionId: "preproof-issuer-session", identityGeneration: 0,
    authTime: 990, scope: "openid", expiresAt: time + 200_000};
  await store.saveAccount({subject, createdAt: time, updatedAt: time});
  await store.saveAccessToken(token, record);
  await store.saveHostedOidcGrant({sid, issuerSessionId: record.issuerSessionId!, clientId: "hosted", issuer,
    subject, identityGeneration: 0, scope: "openid", authTime: 990, createdAt: time, absoluteExpiresAt: time + 300_000});
  expect(await store.registerFinancialSourceRegistration(registration)).toBe(true);
  const p = createAccountsFinancialSource({store, issuer, registration, now: () => time,
    clients: [{clientId: "hosted", profile: "shared-account", enabled: true, allowedScopes: ["openid"],
      redirectUris: ["https://app.example.test/callback"]}],
    challenges: {read: async () => structuredClone(challenge)},
    control: {capture: async () => ({workspaceId: challenge.workspaceId, organizationId: challenge.organizationId,
      workspaceRef: challenge.workspaceRef, accountId: subject,
      evidence: {evidenceRef: "preproof-control", evidenceDigest: `sha256:${"c".repeat(64)}` as const,
        expiresAt: time + 120_000, source: {registrationRef: "preproof-control-source", incarnation: "preproof-control-incarnation",
          affectedRef: challenge.workspaceId, sequence: 0, eventRef: null,
          eventDigest: `sha256:${"d".repeat(64)}` as const, receivers: registration.receivers}}}),
    assertCurrent: async () => true}});
  const prepared = await p.prepareFinancialIdentityProofSource({accessToken: token, challengeRef: challenge.challengeRef});
  expect(Object.keys(prepared.parents)).toHaveLength(4);
  expect((await store.listFinancialSourcePending({registrationRef: registration.registrationRef, limit: 100})).entries).toHaveLength(4);
  expect(await store.findFinancialSourceMaterialization(prepared.parents.grant.eventRef)).toMatchObject({
    materialization: prepared.parents.grant.materialization});
  time = 1_201_000;
  const historical = await p.preparePendingFinancialSourceOriginals({limit: 4});
  expect(historical.entries).toHaveLength(4);
  expect(historical.entries.map(({original}) => original.eventRef).sort()).toEqual(
    Object.values(prepared.parents).map(({eventRef}) => eventRef).sort());
});
