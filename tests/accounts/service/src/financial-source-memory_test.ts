import { expect, test } from "bun:test";
import { InMemoryAccountsStore, type TokenRecord } from "../../../../accounts/service/src/store.ts";
import { MemoryIdentityRecordRepository } from "../../../../accounts/service/src/memory-identity-records.ts";
import { createAccountsFinancialSource, type AccountsFinancialSourceOptions } from "../../../../accounts/service/src/financial-source.ts";
import { rotateAccountSession } from "../../../../accounts/service/src/account-session.ts";
import { financialSourceBuckets, financialSourceScopeKey } from "../../../../accounts/service/src/hosted-identity-records.ts";
import { materializeFinancialSourceEvent, type FinancialSourceMaterialization, type FinancialSourceReceipt } from "../../../../accounts/service/src/financial-source-contract.ts";
import type { FinancialSourceParentHead, FinancialSourceRawRecord } from "../../../../accounts/service/src/identity-state.ts";

const slots = ["grant", "issuerSession", "client", "accountGeneration"] as const;

/** Actual private token map, repository and producer. Only Control/challenge and
 * receiver capabilities are explicitly synthetic; they qualify no real owner. */
async function fixture() {
  const store = new InMemoryAccountsStore();
  const subject = "tsub_financial_memory", token = "isolated-memory-access-never-persist";
  let time = 1_000_000, deliveries = 0, lostAck = false;
  const clock = () => time, issuer = "https://issuer.example.test";
  await store.saveAccount({ subject, createdAt: time, updatedAt: time });
  const login = await rotateAccountSession({ store, subject, now: time, ttlMs: 60_000, hostedPolicy: true });
  const session = (await store.findAccountSession(login.sessionId))!;
  const record: TokenRecord = { clientId: "hosted", oidcProfile: "shared-account", issuer, subject, takosumiSubject: subject,
    sid: "sid-memory", issuerSessionId: session.issuerSessionId, identityGeneration: 0, authTime: 1000, scope: "openid", expiresAt: time + 200_000 };
  await store.saveAccessToken(token, record);
  let repository: MemoryIdentityRecordRepository | undefined;
  const create = MemoryIdentityRecordRepository.prototype.create;
  MemoryIdentityRecordRepository.prototype.create = function (bucket, key, value) { repository = this; return create.call(this, bucket, key, value); };
  try {
    await store.saveHostedOidcGrant({ sid: record.sid!, issuerSessionId: record.issuerSessionId!, clientId: record.clientId, issuer,
      subject, identityGeneration: 0, scope: "openid", authTime: 1000, createdAt: time, absoluteExpiresAt: time + 300_000 });
  } finally { MemoryIdentityRecordRepository.prototype.create = create; }
  if (!repository) throw new Error("actual_memory_repository_not_observed");
  const registration = { registrationRef: "registration-memory", incarnation: "incarnation-memory", genesisDigest: `sha256:${"a".repeat(64)}` as const,
    receivers: [{ receiverRef: "receiver-A", targetRef: "target-A" }, { receiverRef: "receiver-B", targetRef: "target-B" }] };
  expect(await store.registerFinancialSourceRegistration(registration)).toBe(true);
  const challenge = { v: 1 as const, challengeRef: "challenge-memory", registrationRef: registration.registrationRef, clientId: record.clientId,
    workspaceId: "workspace-original", organizationId: "org-original", workspaceRef: "workspace-ref-original", requestFingerprint: `sha256:${"b".repeat(64)}` as const,
    createdAt: time, expiresAt: time + 120_000 };
  const control = { accountId: subject, workspaceId: challenge.workspaceId, organizationId: challenge.organizationId, workspaceRef: challenge.workspaceRef,
    evidence: { evidenceRef: "control-memory", evidenceDigest: `sha256:${"c".repeat(64)}` as const, expiresAt: time + 120_000,
      source: { registrationRef: "control-source-memory", incarnation: "control-incarnation-memory", affectedRef: challenge.workspaceId, sequence: 0, eventRef: null,
        eventDigest: `sha256:${"d".repeat(64)}` as const, receivers: [{ receiverRef: "control-receiver", targetRef: "control-target" }] } } };
  const remote = new Map<string, FinancialSourceMaterialization>();
  const receipt = (materialization: FinancialSourceMaterialization): FinancialSourceReceipt => ({ v: 1,
    eventRef: materialization.event.eventRef, eventDigest: materialization.eventDigest, receiptRef: `receipt/${materialization.event.eventRef}`,
    incarnation: materialization.event.incarnation, sequence: materialization.event.sequence, state: materialization.event.kind === "close" ? "admission-closed" : "advanced" });
  const options: AccountsFinancialSourceOptions = { store, issuer, registration, now: clock,
    clients: [{ clientId: record.clientId, profile: "shared-account", enabled: true, allowedScopes: ["openid"], redirectUris: ["https://app.example.test/callback"] }],
    challenges: { read: async () => structuredClone(challenge) },
    control: { capture: async () => structuredClone(control), assertCurrent: async () => true },
    receivers: registration.receivers.map(receiver => ({ ...receiver,
      async read(materialization) { const prior = remote.get(receiver.receiverRef + "/" + materialization.event.eventRef); return prior ? receipt(prior) : undefined; },
      async deliver(materialization) { deliveries++; remote.set(receiver.receiverRef + "/" + materialization.event.eventRef, structuredClone(materialization));
        if (lostAck) { lostAck = false; throw new Error("isolated-lost-ack"); } return receipt(materialization); },
    })) };
  const producer = createAccountsFinancialSource(options);
  return { store, repository, producer, options, registration, challenge, subject, token, record, session, clock,
    time: (now: number) => { time = now; }, loseAck: () => { lostAck = true; }, deliveries: () => deliveries,
    rows: (bucket: string) => [...repository!.records].filter(([key]) => key.startsWith(bucket + "\n")),
    prove: () => producer.prove({ accessToken: token, challengeRef: challenge.challengeRef }),
  };
}

async function enrolled(f: Awaited<ReturnType<typeof fixture>>) {
  await expect(f.prove()).rejects.toThrow("source_pending");
  const scopes = { grant: { kind: "grant" as const, sid: f.record.sid! }, issuerSession: { kind: "issuer-session" as const, issuerSessionId: f.record.issuerSessionId! },
    client: { kind: "client" as const, clientId: f.record.clientId }, accountGeneration: { kind: "account-generation" as const, subject: f.subject, identityGeneration: 0 } };
  const heads = {} as Record<typeof slots[number], FinancialSourceParentHead>;
  for (const slot of slots) heads[slot] = (await f.store.findFinancialSourceParent(scopes[slot]))!;
  return { scopes, heads };
}

test("memory producer commits four actual parents and all receiver ACKs before issuing a proof; no bearer is persisted", async () => {
  const f = await fixture(), { heads } = await enrolled(f);
  expect(f.rows(financialSourceBuckets.parents)).toHaveLength(4);
  expect(f.rows(financialSourceBuckets.raw)).toHaveLength(4);
  expect((await f.store.listFinancialSourcePending({ registrationRef: f.registration.registrationRef, limit: 100 })).entries).toHaveLength(4);
  for (const head of Object.values(heads)) { expect(head.sequence).toBe(1); expect(head.revision).toBe(0); expect((await f.store.findFinancialSourceRaw(head.lastEventRef))?.raw.previousEventRef).toBeNull(); }
  expect(await f.producer.flush({ limit: 100 })).toEqual({ processed: 4 });
  expect(f.deliveries()).toBe(8);
  expect((await f.store.listFinancialSourcePending({ registrationRef: f.registration.registrationRef, limit: 100 })).entries).toHaveLength(0);
  const issued = await f.prove(), saved = await f.store.findFinancialSourceProof(issued.proofRef);
  expect(saved?.challenge).toEqual(f.challenge);
  expect(Object.keys(saved!.parents)).toEqual(slots);
  expect(f.rows(financialSourceBuckets.parents)).toHaveLength(4);
  expect(f.rows(financialSourceBuckets.raw)).toHaveLength(4);
  expect(JSON.stringify([...f.repository.records])).not.toContain(f.token);
  expect(JSON.stringify(saved)).not.toContain("payer");
});

for (const phase of ["enrollment", "proof"] as const) for (const attack of ["delete", "foreign-rebind"] as const) test(`memory ${phase} refuses ${attack} of the actual affected identity index after all receiver ACKs`, async () => {
  const f = await fixture(), { heads } = await enrolled(f);
  await f.producer.flush({ limit: 100 });
  const key = financialSourceBuckets.affected + "\n" + heads.client.affectedRef;
  const originalIndex = structuredClone(f.repository.records.get(key)) as Record<string, unknown>;
  expect(originalIndex).toEqual({ affectedRef: heads.client.affectedRef, scope: heads.client.scope,
    registrationRef: f.registration.registrationRef, incarnation: f.registration.incarnation });
  const drift = () => {
    if (attack === "delete") f.repository.records.delete(key);
    else f.repository.records.set(key, { ...originalIndex, scope: { kind: "client", clientId: "foreign-client" }, incarnation: "foreign-incarnation" });
  };
  let proofAttempted = false;
  if (phase === "enrollment") drift();
  else {
    const issue = f.store.issueFinancialSourceProof.bind(f.store);
    f.store.issueFinancialSourceProof = async input => { proofAttempted = true; drift(); return await issue(input); };
  }
  await expect(f.prove()).rejects.toThrow("source_conflict");
  expect(proofAttempted).toBe(phase === "proof");
  expect(f.rows(financialSourceBuckets.proofs)).toHaveLength(0);
  expect(f.rows(financialSourceBuckets.raw)).toHaveLength(4);
  expect(f.rows(financialSourceBuckets.pending)).toHaveLength(0);
});

test("memory actual current token map defeats cached-record-only enrollment after token deletion or replacement", async () => {
  for (const attack of ["delete", "replace", "missing-callback"] as const) {
    const f = await fixture();
    const original = f.store.enrollFinancialSourceParents.bind(f.store);
    let other: MemoryIdentityRecordRepository | undefined;
    f.store.enrollFinancialSourceParents = async input => {
      if (attack === "delete") f.store.deleteToken(f.token);
      if (attack === "replace") f.store.saveAccessToken(f.token, { ...f.record, expiresAt: f.record.expiresAt + 1 });
      if (attack === "missing-callback") {
        other = new MemoryIdentityRecordRepository(f.repository.accounts, f.repository.sessions, f.repository.identities, () => {});
        for (const [key, value] of f.repository.records) other.records.set(key, structuredClone(value));
        return other.enrollFinancialSourceParents(input);
      }
      return await original(input);
    };
    await expect(f.prove()).rejects.toThrow("source_conflict");
    expect(f.rows(financialSourceBuckets.parents)).toHaveLength(0);
    expect(f.rows(financialSourceBuckets.raw)).toHaveLength(0);
    expect(f.rows(financialSourceBuckets.pending)).toHaveLength(0);
    if (other) expect([...other.records.keys()].some(key => key.startsWith(financialSourceBuckets.raw + "\n"))).toBe(false);
  }
});

test("memory final map and checkpoint guards run after the actual awaited token hash", async () => {
  for (const attack of ["delete", "revoke", "expire"] as const) {
    const f = await fixture();
    const enroll = f.store.enrollFinancialSourceParents.bind(f.store);
    let delayed = false;
    f.store.enrollFinancialSourceParents = async input => {
      const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = async (algorithm, bytes) => {
        const result = await originalDigest(algorithm, bytes);
        if (new TextDecoder().decode(bytes).endsWith(f.token)) {
          delayed = true;
          if (attack === "delete") f.store.deleteToken(f.token);
          if (attack === "revoke") await f.store.revokeHostedOidcGrant(f.record.sid!, f.clock());
          if (attack === "expire") f.time(f.clock() + 1001);
        }
        return result;
      };
      try { return await enroll(input); } finally { crypto.subtle.digest = originalDigest; }
    };
    await expect(f.prove()).rejects.toThrow("source_conflict");
    expect(delayed).toBe(true);
    expect(f.rows(financialSourceBuckets.raw)).toHaveLength(0);
    expect(f.rows(financialSourceBuckets.pending)).toHaveLength(0);
  }
});

test("memory proof issuance rechecks the actual token map after all parent ACKs and its awaited hash", async () => {
  const f = await fixture(); await enrolled(f); await f.producer.flush({ limit: 100 });
  const issue = f.store.issueFinancialSourceProof.bind(f.store);
  let delayed = false;
  f.store.issueFinancialSourceProof = async input => {
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (algorithm, bytes) => {
      const result = await originalDigest(algorithm, bytes);
      if (new TextDecoder().decode(bytes).endsWith(f.token)) { delayed = true; f.store.deleteToken(f.token); }
      return result;
    };
    try { return await issue(input); } finally { crypto.subtle.digest = originalDigest; }
  };
  await expect(f.prove()).rejects.toThrow("source_conflict");
  expect(delayed).toBe(true);
  expect(f.rows(financialSourceBuckets.proofs)).toHaveLength(0);
  expect(f.rows(financialSourceBuckets.raw)).toHaveLength(4);
});

test("memory enrollment refuses terminal unseen-parent revoke markers without changing existing OAuth semantics", async () => {
  const f = await fixture();
  const unseen = "sid-previously-unseen";
  await f.store.revokeHostedOidcGrant(unseen, f.clock());
  await f.store.saveHostedOidcGrant({ ...(await f.store.findHostedOidcGrant(f.record.sid!))!, sid: unseen });
  f.store.saveAccessToken(f.token, { ...f.record, sid: unseen });
  expect((await f.store.findHostedOidcGrant(unseen))?.revokedAt).toBeUndefined();
  await expect(f.prove()).rejects.toThrow("source_conflict");
  expect(await f.store.findFinancialSourceParent({ kind: "grant", sid: unseen })).toBeUndefined();
  expect(f.repository.records.get(financialSourceBuckets.parents + "\n" + financialSourceScopeKey({ kind: "grant", sid: unseen }))).toEqual({ scope: { kind: "grant", sid: unseen }, closed: true });
  expect(f.rows(financialSourceBuckets.raw)).toHaveLength(0);
  expect(f.rows("hosted_oidc_revoked_grants")).toHaveLength(0);
});

for (const kind of ["grant", "issuer-session", "client"] as const) test(`memory ${kind} revoke atomically closes one actual parent and retains the full receiver outbox`, async () => {
  const f = await fixture(), { scopes, heads } = await enrolled(f);
  await f.producer.flush({ limit: 100 });
  f.time(f.clock() + 1);
  if (kind === "grant") await f.store.revokeHostedOidcGrant(f.record.sid!, f.clock());
  else if (kind === "issuer-session") await f.store.revokeHostedOidcSessionGrants(f.record.issuerSessionId!, f.clock());
  else await f.store.revokeHostedOidcClientGrants(f.record.clientId, f.clock());
  const scope = kind === "grant" ? scopes.grant : kind === "issuer-session" ? scopes.issuerSession : scopes.client;
  const closed = (await f.store.findFinancialSourceParent(scope))!;
  expect(closed.state).toBe("closed"); expect(closed.sequence).toBe(2);
  expect((await f.store.findHostedOidcGrant(f.record.sid!))?.revokedAt).toBe(f.clock());
  const raw = (await f.store.findFinancialSourceRaw(closed.lastEventRef))!;
  expect(raw.raw.previousEventRef).toBe(heads[kind === "grant" ? "grant" : kind === "issuer-session" ? "issuerSession" : "client"].lastEventRef);
  expect(raw.cause.kind).toBe(kind === "grant" ? "grant-revoked" : kind === "issuer-session" ? "issuer-session-revoked" : "client-revoked");
  const pending = await f.store.listFinancialSourcePending({ registrationRef: f.registration.registrationRef, limit: 100 });
  expect(pending.entries).toHaveLength(1); expect(pending.entries[0]!.registration.receivers).toEqual(f.registration.receivers);
  expect(f.rows(financialSourceBuckets.raw)).toHaveLength(5);
  const again = await f.store.revokeHostedOidcScope({ scope, evidenceRef: "second-revoke", now: f.clock() + 1 });
  expect(again).toBe(true); expect(f.rows(financialSourceBuckets.raw)).toHaveLength(5);
  expect(await f.store.findFinancialSourceParent(scope)).toEqual(closed);
  await f.producer.flush({ limit: 100 });
  expect(f.rows(financialSourceBuckets.pending)).toHaveLength(0);
  expect(f.deliveries()).toBe(10);
});

test("memory materialization CAS compares full raw cause, captured head and exact predecessor; pending survives partial or wrong-target ACK", async () => {
  const f = await fixture(), { heads } = await enrolled(f);
  const head = heads.client, raw = (await f.store.findFinancialSourceRaw(head.lastEventRef))!;
  const materialization = await materializeFinancialSourceEvent({ registration: f.registration, raw: raw.raw });
  expect(await f.store.commitFinancialSourceMaterialization({ expectedRaw: { ...raw, capturedAt: raw.capturedAt + 1 }, materialization })).toBe(false);
  expect(await f.store.commitFinancialSourceMaterialization({ expectedRaw: { ...raw, cause: { ...raw.cause, challengeRef: "forged-challenge" } as FinancialSourceRawRecord["cause"] }, materialization })).toBe(false);
  expect(await f.store.commitFinancialSourceMaterialization({ expectedRaw: raw, materialization })).toBe(true);
  expect(await f.store.commitFinancialSourceMaterialization({ expectedRaw: raw, materialization })).toBe(true);
  const saved = (await f.store.findFinancialSourceMaterialization(head.lastEventRef))!;
  const receipt = { registrationRef: f.registration.registrationRef, receiverRef: "receiver-A", targetRef: "target-A", receipt: {
    v: 1 as const, eventRef: head.lastEventRef, eventDigest: materialization.eventDigest, receiptRef: "receipt-explicit", incarnation: f.registration.incarnation, sequence: 1, state: "advanced" as const } };
  expect(await f.store.recordFinancialSourceReceipt({ expectedMaterialization: saved, receipt: { ...receipt, targetRef: "wrong-target" } })).toBe(false);
  expect(await f.store.recordFinancialSourceReceipt({ expectedMaterialization: saved, receipt })).toBe(true);
  expect((await f.store.listFinancialSourcePending({ registrationRef: f.registration.registrationRef, limit: 100 })).entries.some(row => row.eventRef === head.lastEventRef)).toBe(true);
  expect(await f.store.recordFinancialSourceReceipt({ expectedMaterialization: saved, receipt: { ...receipt, receiverRef: "receiver-B", targetRef: "target-B", receipt: { ...receipt.receipt, receiptRef: "receipt-B" } } })).toBe(true);
  expect((await f.store.listFinancialSourcePending({ registrationRef: f.registration.registrationRef, limit: 100 })).entries.some(row => row.eventRef === head.lastEventRef)).toBe(false);
});

test("memory normal issuer rotation preserves parent identity and never creates a financial close", async () => {
  const f = await fixture(), { heads } = await enrolled(f);
  const next = await rotateAccountSession({ store: f.store, subject: f.subject, oldSessionId: f.session.sessionId, now: f.clock() + 1, ttlMs: 60_000, hostedPolicy: true });
  expect((await f.store.findAccountSession(next.sessionId))?.issuerSessionId).toBe(f.record.issuerSessionId);
  for (const head of Object.values(heads)) expect(await f.store.findFinancialSourceParent(head.scope)).toEqual(head);
  expect(f.rows(financialSourceBuckets.raw)).toHaveLength(4);
});

test("memory successful legacy unlink closes the old generation inside the same CAS using explicit revision-zero legacy evidence", async () => {
  const f = await fixture(), { heads } = await enrolled(f);
  const identities = ["first", "second"].map(providerId => ({ subject: f.subject, providerId, upstreamIssuer: `https://${providerId}.example.test`, upstreamSubject: providerId, createdAt: 1, updatedAt: 1 }));
  for (const identity of identities) f.store.linkUpstreamIdentity(identity);
  const session = { ...f.session, reauthenticatedAt: 1000 };
  await f.store.saveAccountSession(session);
  expect(await f.store.unlinkCanonicalUpstreamIdentity({ subject: f.subject, identity: identities[0]!, proof: { sessionId: session.sessionId, subject: f.subject, authTime: 1000 }, operationId: "iunl_actual_legacy", now: f.clock() })).toBe(true);
  expect(await f.store.getAccountAuthenticationGeneration(f.subject)).toBe(1);
  expect(await f.store.findAccountSession(session.sessionId)).toBeUndefined();
  const closed = (await f.store.findFinancialSourceParent(heads.accountGeneration.scope))!;
  expect(closed.state).toBe("closed");
  expect((await f.store.findFinancialSourceRaw(closed.lastEventRef))!.cause).toEqual({ kind: "identity-generation-advanced", subject: f.subject, previousGeneration: 0, nextGeneration: 1,
    operationId: "iunl_actual_legacy", operationRevision: 0, reason: "unlink", legacyUnlink: true });
  expect(f.rows(financialSourceBuckets.raw)).toHaveLength(5);
});

test("memory pending page is bounded and registration/receiver identities are immutable", async () => {
  const f = await fixture(); await enrolled(f);
  expect(await f.store.registerFinancialSourceRegistration(structuredClone(f.registration))).toBe(true);
  expect(await f.store.registerFinancialSourceRegistration({ ...f.registration, receivers: f.registration.receivers.slice(0, 1) })).toBe(false);
  let after: string | undefined; const events = new Set<string>();
  do { const page = await f.store.listFinancialSourcePending({ registrationRef: f.registration.registrationRef, after, limit: 1 });
    expect(page.entries).toHaveLength(1); events.add(page.entries[0]!.eventRef); after = page.nextCursor;
  } while (after !== undefined);
  expect(events.size).toBe(4);
  for (const limit of [0, 101, 1.5]) await expect(f.store.listFinancialSourcePending({ registrationRef: f.registration.registrationRef, limit })).rejects.toThrow();
});
