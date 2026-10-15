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
import { createEphemeralAccountsHandler } from "../../../../accounts/service/src/mod.ts";
import { rotateAccountSession, HOSTED_ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { base64UrlEncodeBytes } from "../../../../accounts/service/src/encoding.ts";

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
  return {store, options, producer, token, record, challenge, snapshot, heads, materials, receipts,
    time: (value: number) => {time = value;}, deliveries: () => deliveries, writes: () => writes,
    beforeEnrollment: (fn: typeof beforeEnrollment) => {beforeEnrollment = fn;}, beforeControl: (fn: typeof beforeControl) => {beforeControl = fn;},
    loseAck: () => {failDeliveryOnce = true;}};
}

test("producer uses real shared grant, exact challenge/context and all receiver ACKs before scoped proof", async () => {
  const f = await fixture(), p = f.producer();
  await expect(p.prove({accessToken: f.token, challengeRef: f.challenge.challengeRef})).rejects.toThrow("source_pending");
  expect(f.heads.size).toBe(4);
  expect(await p.flush({limit: 100})).toEqual({processed: 4, nextCursor: undefined});
  const proof = await p.prove({accessToken: f.token, challengeRef: f.challenge.challengeRef});
  expect(Object.keys(proof)).toEqual(["proofRef"]);
  expect(proof.proofRef).toStartWith("afp_");
  // Independent Python hashlib/canonical-JSON vector for this synthetic input.
  expect(proof.proofRef).toBe("afp_UwKyS1ONe9Fu70GKCedgIoFi9kkQZuD15dQFgPHwHZc");
  expect(f.deliveries()).toBe(4);
});

test("lost ACK resumes original event readback without another delivery", async () => {
  const f = await fixture(), p = f.producer();
  await expect(p.prove({accessToken: f.token, challengeRef: f.challenge.challengeRef})).rejects.toThrow("source_pending");
  f.loseAck(); await expect(p.flush({limit: 100})).rejects.toThrow("lost_ack");
  await p.flush({limit: 100}); expect(f.deliveries()).toBe(4);
  expect(f.receipts.size).toBe(4);
});

test("bounded pending delivery exposes continuation and never treats a partial receiver page as proof", async () => {
  const f = await fixture(), p = f.producer();
  await expect(p.prove({accessToken: f.token, challengeRef: f.challenge.challengeRef})).rejects.toThrow("source_pending");
  const first = await p.flush({limit: 1});
  expect(first.processed).toBe(1); expect(first.nextCursor).toBeString();
  await expect(p.prove({accessToken: f.token, challengeRef: f.challenge.challengeRef})).rejects.toThrow("source_pending");
  expect((await p.flush({after: first.nextCursor, limit: 100})).processed).toBe(3);
  expect((await p.prove({accessToken: f.token, challengeRef: f.challenge.challengeRef})).proofRef).toStartWith("afp_");
});

test("actual grant revocation during Control await cannot enroll a source", async () => {
  const f = await fixture(), p = f.producer();
  f.beforeControl(async () => {await f.store.revokeHostedOidcGrant(f.record.sid!, 1_000_001);});
  await expect(p.prove({accessToken: f.token, challengeRef: f.challenge.challengeRef})).rejects.toThrow("invalid_grant");
  expect(f.writes()).toBe(0);
});

test("resource claims and another client never enter shared financial identity lane", async () => {
  for (const patch of [{capsuleId: "capsule"}, {interfaceId: "interface"}, {clientId: "other"}, {oidcProfile: undefined}]) {
    const f = await fixture(); await f.store.saveAccessToken(f.token, {...f.record, ...patch});
    await expect(f.producer().prove({accessToken: f.token, challengeRef: f.challenge.challengeRef})).rejects.toThrow("invalid_grant");
    expect(f.writes()).toBe(0);
  }
});

test("missing or wrong qualified receiver capability never falls back to a grant", async () => {
  for (const receivers of [undefined, [], [{receiverRef: "financial-primary", targetRef: "replacement", read: async () => undefined, deliver: async () => {throw Error();}}]]) {
    const f = await fixture();
    await expect(createAccountsFinancialSource({...f.options, receivers}).prove({accessToken: f.token, challengeRef: f.challenge.challengeRef})).rejects.toThrow("source_unavailable");
    expect(f.writes()).toBe(0);
  }
});

test("opaque checkpoint rejects copied identity, changed scope, expired time and backward clock before write", async () => {
  for (const attack of ["copy", "scope", "expire", "backward", "replay"] as const) {
    const f = await fixture(), p = f.producer();
    f.beforeEnrollment((input) => {
      if (attack === "copy") Object.assign(input, {precommitCheckpoint: {...input.precommitCheckpoint}});
      if (attack === "scope") Object.assign(input, {challenge: {...input.challenge, workspaceId: "wrong"}});
      if (attack === "expire") f.time(1_001_001);
      if (attack === "backward") f.time(999_999);
      if (attack === "replay") expect(consumeFinancialSourcePrecommitCheckpoint(input)).toBe(1_000_000);
    });
    await expect(p.prove({accessToken: f.token, challengeRef: f.challenge.challengeRef})).rejects.toThrow();
    expect(f.writes()).toBe(0);
  }
});

test("actual challenge changed during awaited context is rejected before enrollment", async () => {
  const f = await fixture();
  f.beforeControl(async () => {f.challenge.organizationId = "changed-organization";});
  await expect(f.producer().prove({accessToken: f.token, challengeRef: "challenge-real"})).rejects.toThrow("invalid_challenge");
  expect(f.writes()).toBe(0);
});

test("healthy PG-projected optional undefined storage fields do not become invalid closed wire fields", async () => {
  const f = await fixture();
  await f.store.saveAccessToken(f.token, {...f.record, audience: undefined, capsuleId: undefined,
    workspaceId: undefined, role: undefined, interfaceId: undefined, interfaceBindingId: undefined,
    interfaceResolvedRevision: undefined});
  await expect(f.producer().prove({accessToken: f.token, challengeRef: f.challenge.challengeRef})).rejects.toThrow("source_pending");
  expect(f.heads.size).toBe(4);
});

test("actual issuer HTTP code exchange token reaches financial enrollment with its real optional field projection", async () => {
  const f = await fixture();
  // The real HTTP issuer uses wall-clock validity; this fixture's trusted clock
  // and challenge are moved into that same domain before producing the grant.
  const now = Date.now(); f.time(now);
  Object.assign(f.challenge, {createdAt: now, expiresAt: now + 120_000});
  Object.assign(f.snapshot.evidence, {expiresAt: now + 120_000});
  const issuer = f.options.issuer, verifier = "v".repeat(43);
  const clients = [{...f.options.clients[0]!, clientSecret: "synthetic-client-secret", tokenEndpointAuthMethod: "client_secret_basic" as const}];
  const handler = await createEphemeralAccountsHandler({issuer, store: f.store, clients,
    hostedSessionPolicy: true, allowEphemeralKeyOnHttpsIssuer: true});
  const session = await rotateAccountSession({store: f.store, subject: f.record.subject, now,
    ttlMs: 120_000, hostedPolicy: true, freshlyAuthenticatedAt: Math.floor(now / 1_000)});
  const cookie = `${HOSTED_ACCOUNT_SESSION_COOKIE_NAME}=${session.sessionId}`;
  const codeChallenge = base64UrlEncodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const url = new URL(`${issuer}/oauth/authorize`);
  url.search = new URLSearchParams({response_type: "code", client_id: "hosted", redirect_uri: clients[0]!.redirectUris[0]!,
    scope: "openid", state: "state-real", nonce: "nonce-real", code_challenge: codeChallenge, code_challenge_method: "S256"}).toString();
  let response = await handler(new Request(url, {headers: {cookie}}));
  if (response.status === 200) {
    const transaction = (await response.text()).match(/name="consent_transaction" value="([^"]+)"/)?.[1];
    expect(transaction).toBeTruthy();
    response = await handler(new Request(url, {method: "POST", headers: {cookie, origin: issuer, "content-type": "application/x-www-form-urlencoded"},
      body: new URLSearchParams({consent_transaction: transaction!, approve: "yes"})}));
  }
  expect(response.status).toBe(302);
  const code = new URL(response.headers.get("location")!).searchParams.get("code")!;
  const exchanged = await handler(new Request(`${issuer}/oauth/token`, {method: "POST",
    headers: {authorization: `Basic ${btoa("hosted:synthetic-client-secret")}`, "content-type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({grant_type: "authorization_code", code, redirect_uri: clients[0]!.redirectUris[0]!, code_verifier: verifier})}));
  expect(exchanged.status).toBe(200);
  const {access_token: token} = await exchanged.json() as {access_token: string};
  const actual = await f.store.findAccessToken(token);
  expect(Object.hasOwn(actual!, "capsuleId")).toBe(true);
  expect(actual!.capsuleId).toBeUndefined();
  await expect(f.producer().prove({accessToken: token, challengeRef: f.challenge.challengeRef})).rejects.toThrow("source_pending");
  expect(f.heads.size).toBe(4);
});
