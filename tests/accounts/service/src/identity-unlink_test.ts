import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { InMemoryAccountsStore, type AccountsStore, type AccountSessionRecord, type UpstreamIdentityRecord } from "../../../../accounts/service/src/store.ts";
import { D1AccountsStore, type D1Database } from "../../../../accounts/service/src/d1-store.ts";
import { PostgresAccountsStore } from "../../../../accounts/service/src/postgres-store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { createCredentialUnlinkIntent, completeCredentialUnlink, handleCredentialUnlinkIntentRequest, validateCredentialUnlinkReceipt } from "../../../../accounts/service/src/identity-unlink.ts";
import { handleUpstreamUnlinkProofBeginRequest, completeUpstreamUnlinkProof } from "../../../../accounts/service/src/upstream-unlink-proof.ts";
import { handleUpstreamCallbackRequest } from "../../../../accounts/service/src/upstream-oauth-routes.ts";
import { verifiedSocialOAuthProvider } from "../../../../accounts/service/src/upstream-verification.ts";
import { rotateAccountSession, handleHostedGlobalLogout } from "../../../../accounts/service/src/account-session.ts";
import { sha256Text, base64UrlEncodeBytes, base64UrlEncodeJson } from "../../../../accounts/service/src/encoding.ts";
import type { CredentialUnlinkIntent, CredentialUnlinkReceipt, CredentialUnlinkReconciler } from "../../../../accounts/service/src/identity-unlink-state.ts";
import { createEphemeralAccountsHandler, type UpstreamOAuthOptions } from "../../../../accounts/service/src/mod.ts";
import { loadD1AccountsMigrationCatalog, applyD1AccountsMigrationBatch } from "../../../../accounts/service/src/d1-migrations.ts";
import { createIdentityMerge, proveIdentityMerge, consentIdentityMerge, activateIdentityMerge } from "../../../../accounts/service/src/identity-merge.ts";
import type { IdentityOperationReceiptRecord } from "../../../../accounts/service/src/identity-state.ts";

const subject = "tsub_unlink_original";
const google = verifiedSocialOAuthProvider({ id: "social-google", profile: "google-oidc" });
const github = verifiedSocialOAuthProvider({ id: "social-github", profile: "github-oauth" });
const removedIdentity = { providerId: google.id, upstreamIssuer: google.issuer, upstreamSubject: "immutable-google" };
const retainedIdentity = { providerId: github.id, upstreamIssuer: github.issuer, upstreamSubject: "4711" };
const issuer = "https://auth.example.test";
const base = "/api/v1/account/identity-credentials/unlink-intents";

const baselineSql = `CREATE SCHEMA accounts_v1;
CREATE TABLE accounts_v1.accounts(subject text PRIMARY KEY,email text,email_verified boolean,display_name text,picture text,terms_version text,terms_accepted_at timestamptz,terms_accepted_source text,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE TABLE accounts_v1.upstream_identities(provider_id text,upstream_issuer text,upstream_subject text,subject text REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(provider_id,upstream_issuer,upstream_subject));
CREATE TABLE accounts_v1.account_sessions(session_id text PRIMARY KEY,subject text REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.authorization_codes(code_hash text PRIMARY KEY,client_id text,redirect_uri text,scope text,subject text,takosumi_subject text REFERENCES accounts_v1.accounts(subject),capsule_id text,workspace_id text,role text,nonce text,code_challenge text,code_challenge_method text,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.oauth_access_tokens(token_hash text PRIMARY KEY,client_id text,audience text,scope text,subject text,takosumi_subject text REFERENCES accounts_v1.accounts(subject),capsule_id text,workspace_id text,role text,interface_id text,interface_binding_id text,interface_resolved_revision bigint,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.oauth_refresh_tokens(LIKE accounts_v1.oauth_access_tokens INCLUDING ALL);
CREATE TABLE accounts_v1.protected_unlink_refs(id text PRIMARY KEY,subject text REFERENCES accounts_v1.accounts(subject),workspace_id text,org_id text,micro_usd bigint,pending_operation_key text);`;

async function fixture(kind: "memory" | "d1" | "postgres" | "native-d1", retainedAccountSubject = subject, now = Date.now()) {
  let store: AccountsStore;
  let pg: PGlite | undefined;
  let close = async () => {};
  if (kind === "memory") store = new InMemoryAccountsStore();
  else if (kind === "d1") store = new D1AccountsStore(new SqliteFakeD1() as unknown as D1Database);
  else if (kind === "native-d1") {
    const { Miniflare } = await import("miniflare");
    const mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('test');}}", compatibilityDate: "2026-07-01", d1Databases: { ACCOUNTS: "unlink-native" } });
    close = async () => { await mf.dispose(); };
    const db = await mf.getD1Database("ACCOUNTS");
    const catalog = await loadD1AccountsMigrationCatalog();
    for (const migration of catalog.migrations) await applyD1AccountsMigrationBatch(db, migration, 100 + migration.version);
    store = new D1AccountsStore(db as unknown as D1Database, { schemaMode: "predeployed" });
  } else {
    pg = new PGlite();
    close = async () => { await pg!.close(); };
    await pg.exec(baselineSql);
    await pg.exec(await Bun.file(new URL("../../../../accounts/service/migrations/045_hosted_canonical_identity.sql", import.meta.url)).text());
    store = new PostgresAccountsStore({ queryObject: async <T>(sql: string, args: readonly unknown[] = []) => ({ rows: (await pg!.query(sql, [...args])).rows as T[] }) });
  }
  await store.saveAccount({ subject, email: "private@example.test", emailVerified: true, createdAt: 1, updatedAt: 1 });
  if (retainedAccountSubject !== subject) await store.saveAccount({ subject: retainedAccountSubject, email: "private@example.test", emailVerified: true, createdAt: 1, updatedAt: 1 });
  for (const [identity, identitySubject] of [[removedIdentity, subject], [retainedIdentity, retainedAccountSubject]] as const) await store.linkUpstreamIdentity({ ...identity, subject: identitySubject, createdAt: 1, updatedAt: 1 });
  const rotated = await rotateAccountSession({ store, subject, now, ttlMs: 60_000, hostedPolicy: true });
  const session = (await store.findAccountSession(rotated.sessionId))!;
  const browserBindingHash = await sha256Text(`unlink-browser:${"a".repeat(64)}`);
  if (pg) await pg.query("INSERT INTO accounts_v1.protected_unlink_refs VALUES('kept',$1,'workspace-original','org-original',654321,'pending-before-unlink')", [subject]);
  return { store, session, browserBindingHash, now, pg, close };
}

async function pending(f: Awaited<ReturnType<typeof fixture>>, reverse = false) {
  return await createCredentialUnlinkIntent({ store: f.store, session: f.session, removedIdentity: reverse ? retainedIdentity : removedIdentity, retainedIdentity: reverse ? removedIdentity : retainedIdentity, browserBindingHash: f.browserBindingHash, now: f.now });
}

async function receiptFor(f: Awaited<ReturnType<typeof fixture>>, intent: CredentialUnlinkIntent, overrides: Partial<CredentialUnlinkReceipt> = {}) {
  const receipt: CredentialUnlinkReceipt = {
    receiptId: `iupr_${crypto.randomUUID()}`, operationId: intent.operationId, subject: intent.subject,
    removedIdentity: intent.removedIdentity, retainedIdentity: intent.retainedIdentity,
    browserBindingHash: intent.browserBindingHash, issuerSessionHash: intent.issuerSessionHash,
    identityGeneration: intent.identityGeneration, policyVersion: intent.policyVersion,
    transactionDigest: await sha256Text(`synthetic-isolated-oauth:${intent.operationId}`),
    startedAt: f.now, completedAt: f.now, expiresAt: intent.expiresAt, legConsent: true, legConsentAt: f.now,
    method: "upstream-oauth-operation", ...overrides,
  };
  expect(await f.store.createCredentialUnlinkReceipt!(receipt)).toBe(true);
  return receipt;
}

const reconciler: CredentialUnlinkReconciler = {
  acknowledgeCredentialUnlinkIntent: async (context) => ({ ...context, ownerRef: "isolated-owner-ack", acknowledgedAt: Date.now() }),
};

async function expectUnlinkUnchanged(f: Awaited<ReturnType<typeof fixture>>, intent: CredentialUnlinkIntent, receipt: CredentialUnlinkReceipt) {
  expect((await f.store.findCredentialUnlinkIntent!(intent.operationId))?.status).toBe("pending");
  expect((await f.store.findCredentialUnlinkReceipt!(receipt.receiptId))?.consumedByOperation).toBeUndefined();
  expect(await f.store.getAccountAuthenticationGeneration!(subject)).toBe(0);
  expect((await f.store.findUpstreamIdentityStatus!(removedIdentity))?.disabledAt).toBeUndefined();
  expect((await f.store.findUpstreamIdentityStatus!(retainedIdentity))?.disabledAt).toBeUndefined();
}

test("HTTP completion carries the same trusted clock across caller-to-entry I/O before a genuine owner ACK", async () => {
  const f = await fixture("memory");
  try {
    const intent = await pending(f);
    const receipt = await receiptFor(f, intent);
    let current = f.now;
    let ownerCalls = 0;
    const store = new Proxy(f.store, { get(target, property) {
      if (property === "findAccountSession") return async (id: string) => {
        const session = await target.findAccountSession(id);
        current += 1;
        return session;
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const response = await handleCredentialUnlinkIntentRequest({
      request: request(`${base}/${intent.operationId}/complete`, { receiptId: receipt.receiptId, consent: true }, f.session),
      store, issuerOrigin: issuer, now: f.now, clock: () => current,
      reconciler: { acknowledgeCredentialUnlinkIntent: async (context) => {
        ownerCalls++;
        current += 3;
        return { ...context, ownerRef: "isolated-trusted-clock-ack", acknowledgedAt: current };
      } },
    });
    expect(response?.status).toBe(200);
    expect(ownerCalls).toBe(1);
    const committed = await f.store.findCredentialUnlinkIntent!(intent.operationId);
    expect(committed?.updatedAt).toBe(f.now + 4);
    expect(committed?.acknowledgement?.acknowledgedAt).toBe(committed?.updatedAt);
    expect(await f.store.getAccountAuthenticationGeneration!(subject)).toBe(1);
  } finally { await f.close(); }
});

test("the actual HTTP default clock includes pre-helper session I/O before its wall-clock owner ACK", async () => {
  const f = await fixture("memory");
  try {
    const intent = await pending(f);
    const receipt = await receiptFor(f, intent);
    let sessionReads = 0;
    const store = new Proxy(f.store, { get(target, property) {
      if (property === "findAccountSession") return async (id: string) => {
        sessionReads++;
        await Bun.sleep(10);
        return await target.findAccountSession(id);
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const response = await handleCredentialUnlinkIntentRequest({
      request: request(`${base}/${intent.operationId}/complete`, { receiptId: receipt.receiptId, consent: true }, f.session),
      store, issuerOrigin: issuer, reconciler,
    });
    expect(response?.status).toBe(200);
    expect(sessionReads).toBe(1);
    const committed = await f.store.findCredentialUnlinkIntent!(intent.operationId);
    expect(committed?.updatedAt).toBeGreaterThanOrEqual(committed!.acknowledgement!.acknowledgedAt);
    expect(committed?.updatedAt).toBeGreaterThan(f.now);
    expect(await f.store.getAccountAuthenticationGeneration!(subject)).toBe(1);
  } finally { await f.close(); }
});

test("an advancing injected clock keeps an old synthetic epoch without mixing in wall-clock time", async () => {
  const f = await fixture("memory", subject, 1_000);
  try {
    const intent = await pending(f);
    const receipt = await receiptFor(f, intent);
    let current = f.now + 1;
    let clockReads = 0;
    const completed = await completeCredentialUnlink({
      store: f.store, intent, receiptId: receipt.receiptId, now: f.now, clock: () => { clockReads++; return current; },
      reconciler: { acknowledgeCredentialUnlinkIntent: async (context) => {
        current += 7;
        return { ...context, ownerRef: "isolated-synthetic-clock-ack", acknowledgedAt: current };
      } },
    });
    expect(completed.updatedAt).toBe(1_008);
    expect(completed.acknowledgement?.acknowledgedAt).toBe(1_008);
    expect(clockReads).toBe(2);
    expect(await f.store.getAccountAuthenticationGeneration!(subject)).toBe(1);
  } finally { await f.close(); }
});

test("scalar-only clock compatibility still expires retained proof during a real owner wait", async () => {
  const f = await fixture("memory", subject, 1_000);
  try {
    const intent = await pending(f);
    const receipt = await receiptFor(f, intent, { expiresAt: f.now + 100 });
    let ownerCalls = 0;
    await expect(completeCredentialUnlink({
      store: f.store, intent, receiptId: receipt.receiptId, now: f.now,
      reconciler: { acknowledgeCredentialUnlinkIntent: async (context) => {
        ownerCalls++;
        await Bun.sleep(125);
        return { ...context, ownerRef: "isolated-scalar-elapsed-ack", acknowledgedAt: f.now };
      } },
    })).rejects.toThrow("unlink_conflict");
    expect(ownerCalls).toBe(1);
    await expectUnlinkUnchanged(f, intent, receipt);
  } finally { await f.close(); }
});

for (const expiry of ["intent", "receipt"] as const) {
  test(`${expiry} expiry during owner await refuses unlink without consuming the retained proof`, async () => {
    const f = await fixture("memory", subject, 1_000);
    try {
      const intent = await pending(f);
      const receipt = await receiptFor(f, intent, expiry === "receipt" ? { expiresAt: intent.expiresAt - 1 } : {});
      let current = f.now;
      let ownerCalls = 0;
      await expect(completeCredentialUnlink({
        store: f.store, intent, receiptId: receipt.receiptId, now: f.now, clock: () => current,
        reconciler: { acknowledgeCredentialUnlinkIntent: async (context) => {
          ownerCalls++;
          current = expiry === "intent" ? intent.expiresAt : receipt.expiresAt;
          return { ...context, ownerRef: "isolated-expiring-owner-ack", acknowledgedAt: current };
        } },
      })).rejects.toThrow("unlink_conflict");
      expect(ownerCalls).toBe(1);
      await expectUnlinkUnchanged(f, intent, receipt);
    } finally { await f.close(); }
  });
}

test("an owner ACK one millisecond beyond the trusted completion clock remains future and cannot unlink", async () => {
  const f = await fixture("memory", subject, 1_000);
  try {
    const intent = await pending(f);
    const receipt = await receiptFor(f, intent);
    const clock = () => f.now;
    await expect(completeCredentialUnlink({
      store: f.store, intent, receiptId: receipt.receiptId, now: clock(), clock,
      reconciler: { acknowledgeCredentialUnlinkIntent: async (context) => ({ ...context, ownerRef: "isolated-future-owner-ack", acknowledgedAt: clock() + 1 }) },
    })).rejects.toThrow("unlink_reconciliation_pending");
    await expectUnlinkUnchanged(f, intent, receipt);
  } finally { await f.close(); }
});

test("fresh entry time rejects an already expired intent before any owner call", async () => {
  const f = await fixture("memory", subject, 1_000);
  try {
    const intent = await pending(f);
    const receipt = await receiptFor(f, intent);
    let ownerCalls = 0;
    await expect(completeCredentialUnlink({
      store: f.store, intent, receiptId: receipt.receiptId, now: f.now, clock: () => intent.expiresAt,
      reconciler: { acknowledgeCredentialUnlinkIntent: async (context) => {
        ownerCalls++;
        return { ...context, ownerRef: "isolated-too-late-ack", acknowledgedAt: intent.expiresAt };
      } },
    })).rejects.toThrow("unlink_conflict");
    expect(ownerCalls).toBe(0);
    await expectUnlinkUnchanged(f, intent, receipt);
  } finally { await f.close(); }
});

test("a non-integer, invalid or backwards trusted clock fails closed before mutation", async () => {
  const f = await fixture("memory", subject, 1_000);
  try {
    const intent = await pending(f);
    const receipt = await receiptFor(f, intent);
    let ownerCalls = 0;
    const owner: CredentialUnlinkReconciler = { acknowledgeCredentialUnlinkIntent: async (context) => {
      ownerCalls++;
      return { ...context, ownerRef: "isolated-invalid-clock-ack", acknowledgedAt: f.now };
    } };
    for (const invalid of [NaN, Infinity, -1, f.now + 0.5, f.now - 1]) {
      await expect(completeCredentialUnlink({ store: f.store, intent, receiptId: receipt.receiptId, reconciler: owner, now: f.now, clock: () => invalid })).rejects.toThrow("unlink_invalid_clock");
    }
    expect(ownerCalls).toBe(0);
    let current = f.now;
    await expect(completeCredentialUnlink({
      store: f.store, intent, receiptId: receipt.receiptId, now: f.now, clock: () => current,
      reconciler: { acknowledgeCredentialUnlinkIntent: async (context) => {
        current--;
        return { ...context, ownerRef: "isolated-backwards-clock-ack", acknowledgedAt: f.now };
      } },
    })).rejects.toThrow("unlink_invalid_clock");
    for (const invalid of [NaN, Infinity, f.now + 0.5]) {
      current = f.now;
      await expect(completeCredentialUnlink({
        store: f.store, intent, receiptId: receipt.receiptId, now: f.now, clock: () => current,
        reconciler: { acknowledgeCredentialUnlinkIntent: async (context) => {
          current = invalid;
          return { ...context, ownerRef: "isolated-post-ack-invalid-clock", acknowledgedAt: f.now };
        } },
      })).rejects.toThrow("unlink_invalid_clock");
    }
    await expectUnlinkUnchanged(f, intent, receipt);
  } finally { await f.close(); }
});

test("logout while awaiting owner ACK still invalidates the retained proof under the same trusted clock", async () => {
  const f = await fixture("memory", subject, 1_000);
  try {
    const intent = await pending(f);
    const receipt = await receiptFor(f, intent);
    let current = f.now;
    await expect(completeCredentialUnlink({
      store: f.store, intent, receiptId: receipt.receiptId, now: f.now, clock: () => current,
      reconciler: { acknowledgeCredentialUnlinkIntent: async (context) => {
        current++;
        await f.store.revokeHostedOidcSessionGrants!(intent.issuerSessionHash, current);
        return { ...context, ownerRef: "isolated-revoked-owner-ack", acknowledgedAt: current };
      } },
    })).rejects.toThrow("unlink_conflict");
    await expectUnlinkUnchanged(f, intent, receipt);
  } finally { await f.close(); }
});

test("credential inventory rechecks session expiry with the same advancing injected clock", async () => {
  const f = await fixture("memory", subject, 1_000);
  try {
    let current = f.now;
    const store = new Proxy(f.store, { get(target, property) {
      if (property === "listCanonicalUpstreamIdentities") return async (owner: string) => {
        const identities = await target.listCanonicalUpstreamIdentities!(owner);
        current = f.session.expiresAt;
        return identities;
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const response = await handleCredentialUnlinkIntentRequest({ request: inventoryRequest(f.session), store, issuerOrigin: issuer, now: f.now, clock: () => current });
    expect(response?.status).toBe(401);
    expect(await response!.json()).toEqual({ error: "authentication_required" });
  } finally { await f.close(); }
});

for (const kind of ["memory", "d1", "postgres", "native-d1"] as const) {
  test(`${kind}: fresh retained identity receipt atomically disables one credential, preserves account refs and exact idempotence`, async () => {
    const f = await fixture(kind);
    try {
      const intent = await pending(f);
      const receipt = await receiptFor(f, intent);
      await f.store.saveHostedOidcGrant!({ sid: "unlink-old-grant", issuerSessionId: f.session.issuerSessionId!, clientId: "rp", subject, scope: "openid", authTime: Math.floor(f.now / 1000), createdAt: f.now, absoluteExpiresAt: f.now + 300_000 });
      const completed = await completeCredentialUnlink({ store: f.store, intent, receiptId: receipt.receiptId, reconciler, now: Date.now(), clock: Date.now });
      expect(completed.status).toBe("completed");
      expect(await f.store.getAccountAuthenticationGeneration!(subject)).toBe(1);
      expect((await f.store.findUpstreamIdentityStatus!(removedIdentity))?.disabledAt).toBeDefined();
      expect((await f.store.findUpstreamIdentityStatus!(retainedIdentity))?.disabledAt).toBeUndefined();
      expect((await f.store.findUpstreamIdentity(removedIdentity))?.subject).toBe(subject);
      expect((await f.store.findAccount(subject))?.createdAt).toBe(1);
      expect(await f.store.findAccountSession(f.session.sessionId)).toBeUndefined();
      expect((await f.store.findHostedOidcGrant!("unlink-old-grant"))?.revokedAt).toBeDefined();
      expect((await f.store.findCredentialUnlinkReceipt!(receipt.receiptId))?.consumedByOperation).toBe(intent.operationId);
      expect(await completeCredentialUnlink({ store: f.store, intent: completed, receiptId: receipt.receiptId, now: Date.now() })).toEqual(completed);
      expect(await f.store.getAccountAuthenticationGeneration!(subject)).toBe(1);
      expect(await f.store.completeCredentialUnlink!({ expectedRevision: intent.revision, next: { ...completed, retainedIdentity: removedIdentity }, receipt, now: completed.updatedAt })).toBe(false);
      if (f.pg) expect((await f.pg.query("SELECT * FROM accounts_v1.protected_unlink_refs")).rows).toEqual([{ id: "kept", subject, workspace_id: "workspace-original", org_id: "org-original", micro_usd: 654321, pending_operation_key: "pending-before-unlink" }]);
    } finally { await f.close(); }
  }, 30_000);
}

for (const kind of ["memory", "d1", "postgres"] as const) {
  test(`${kind}: no generic session, last credential, replayed receipt or incomplete owner ACK can unlink`, async () => {
    const f = await fixture(kind);
    try {
      await expect(createCredentialUnlinkIntent({ store: f.store, session: f.session, removedIdentity, retainedIdentity: removedIdentity, browserBindingHash: f.browserBindingHash, now: f.now })).rejects.toThrow("unlink_conflict");
      const intent = await pending(f);
      await expect(completeCredentialUnlink({ store: f.store, intent, receiptId: "missing", reconciler, now: f.now })).rejects.toThrow("unlink_conflict");
      const receipt = await receiptFor(f, intent);
      const oldBooleanAdapter = { acknowledgeCredentialUnlink: async () => true };
      await expect(completeCredentialUnlink({ store: f.store, intent, receiptId: receipt.receiptId, reconciler: oldBooleanAdapter as CredentialUnlinkReconciler, now: f.now })).rejects.toThrow("unlink_reconciliation_unavailable");
      await expect(completeCredentialUnlink({ store: f.store, intent, receiptId: receipt.receiptId, reconciler: { acknowledgeCredentialUnlinkIntent: async (context) => ({ ...context, retainedIdentity: removedIdentity, ownerRef: "wrong-tuple", acknowledgedAt: f.now }) }, now: f.now })).rejects.toThrow("unlink_reconciliation_pending");
      expect(await f.store.getAccountAuthenticationGeneration!(subject)).toBe(0);
      expect(await f.store.findUpstreamIdentityStatus!(removedIdentity)).toBeUndefined();
      const second = await pending(f);
      await expect(completeCredentialUnlink({ store: f.store, intent: second, receiptId: receipt.receiptId, reconciler, now: f.now })).rejects.toThrow("unlink_conflict");
      await expect(completeCredentialUnlink({ store: f.store, intent, receiptId: receipt.receiptId, reconciler, now: intent.expiresAt })).rejects.toThrow("unlink_conflict");
    } finally { await f.close(); }
  }, 20_000);

  test(`${kind}: reciprocal concurrent intents cannot disable the last working credential`, async () => {
    const f = await fixture(kind);
    try {
      const intents = [await pending(f), await pending(f, true)];
      const receipts = await Promise.all(intents.map((intent) => receiptFor(f, intent)));
      const results = await Promise.allSettled(intents.map((intent, index) => completeCredentialUnlink({ store: f.store, intent, receiptId: receipts[index]!.receiptId, reconciler, now: Date.now(), clock: Date.now })));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const statuses = await Promise.all([removedIdentity, retainedIdentity].map((identity) => f.store.findUpstreamIdentityStatus!(identity)));
      expect(statuses.filter((status) => status?.disabledAt === undefined)).toHaveLength(1);
      expect(await f.store.getAccountAuthenticationGeneration!(subject)).toBe(1);
    } finally { await f.close(); }
  }, 20_000);

  test(`${kind}: explicit logout fences retained proof but ordinary session rotation preserves its stable anchor`, async () => {
    const f = await fixture(kind);
    try {
      const intent = await pending(f);
      const receipt = await receiptFor(f, intent);
      const rotated = await rotateAccountSession({ store: f.store, oldSessionId: f.session.sessionId, subject, now: f.now + 1, ttlMs: 60_000, hostedPolicy: true });
      expect((await f.store.findAccountSession(rotated.sessionId))?.issuerSessionId).toBe(intent.issuerSessionHash);
      expect(await f.store.findAccountSession(f.session.sessionId)).toBeUndefined();
      const logout = await handleHostedGlobalLogout({ request: request("/api/v1/account/session/logout", {}, f.session), store: f.store, issuer });
      expect(logout.status).toBe(204);
      await expect(completeCredentialUnlink({ store: f.store, intent, receiptId: receipt.receiptId, reconciler, now: Date.now(), clock: Date.now })).rejects.toThrow("unlink_conflict");
      expect((await f.store.findUpstreamIdentityStatus!(removedIdentity))?.disabledAt).toBeUndefined();
    } finally { await f.close(); }
  }, 20_000);
}

function request(path: string, body: unknown, session: AccountSessionRecord, browser = `__Host-takosumi-unlink-browser=${"a".repeat(64)}`, origin = issuer) {
  return new Request(`${issuer}${path}`, { method: "POST", headers: { origin, "content-type": "application/json", cookie: `__Host-takosumi_session=${session.sessionId}; ${browser}` }, body: JSON.stringify(body) });
}

function inventoryRequest(session?: AccountSessionRecord, query = "", headers: Record<string, string> = {}) {
  return new Request(`${issuer}/api/v1/account/identity-credentials${query}`, { headers: { ...(session ? { cookie: `__Host-takosumi_session=${session.sessionId}` } : {}), ...headers } });
}

function inventoryRecords(store: AccountsStore, records: readonly UpstreamIdentityRecord[]): AccountsStore {
  return new Proxy(store, { get(target, property) {
    if (property === "listCanonicalUpstreamIdentities") return async () => records;
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("cookie-only credential inventory supplies browser-selectable immutable tuples without private profile/proof/token metadata", async () => {
  const f = await fixture("memory");
  try {
    const linked = await f.store.listCanonicalUpstreamIdentities!(subject);
    const richRecords = linked.map((record) => ({ ...record, email: "private-inventory@example.test", proof: "isolated-sensitive-proof", token: "isolated-sensitive-token", issuerSessionHash: f.session.issuerSessionId }));
    const inventory = await handleCredentialUnlinkIntentRequest({ request: inventoryRequest(f.session), store: inventoryRecords(f.store, richRecords), issuerOrigin: issuer, now: f.now });
    expect(inventory?.status).toBe(200);
    expect(inventory!.headers.get("cache-control")).toBe("no-store");
    const body = await inventory!.json() as { credentials: Array<typeof removedIdentity & { enabled: boolean }> };
    expect(body).toEqual({ credentials: [{ ...retainedIdentity, enabled: true }, { ...removedIdentity, enabled: true }] });
    const issuerHandler = await createEphemeralAccountsHandler({ issuer, store: f.store, hostedSessionPolicy: true, allowEphemeralKeyOnHttpsIssuer: true });
    const mounted = await issuerHandler(inventoryRequest(f.session));
    expect(mounted.status).toBe(200);
    expect(mounted.headers.get("cache-control")).toBe("no-store");
    expect(await mounted.json()).toEqual(body);
    const serialized = JSON.stringify(body);
    for (const privateValue of ["private-inventory@example.test", "isolated-sensitive-proof", "isolated-sensitive-token", f.session.issuerSessionId!, f.session.sessionId, subject]) expect(serialized).not.toContain(privateValue);
    const { enabled: _removedEnabled, ...browserRemoved } = body.credentials.find((credential) => credential.providerId === google.id)!;
    const { enabled: _retainedEnabled, ...browserRetained } = body.credentials.find((credential) => credential.providerId === github.id)!;
    expect((await handleCredentialUnlinkIntentRequest({ request: request(base, { removedIdentity: browserRemoved, retainedIdentity: browserRetained, consent: true }, f.session), store: f.store, issuerOrigin: issuer, now: f.now }))?.status).toBe(201);
    const forbidden = [inventoryRequest(), inventoryRequest(f.session, "", { authorization: `Bearer ${f.session.sessionId}` }), inventoryRequest(f.session, "", { "x-takosumi-account-session": f.session.sessionId }), inventoryRequest(f.session, "", { cookie: `__Host-takosumi_session=${f.session.sessionId}; __Host-takosumi_session=${f.session.sessionId}` })];
    for (const candidate of forbidden) {
      const response = await handleCredentialUnlinkIntentRequest({ request: candidate, store: f.store, issuerOrigin: issuer, now: f.now });
      expect(response?.status).toBe(401);
      expect(response!.headers.get("cache-control")).toBe("no-store");
    }
    expect((await handleCredentialUnlinkIntentRequest({ request: inventoryRequest(f.session, "?subject=tsub_other"), store: f.store, issuerOrigin: issuer, now: f.now }))?.status).toBe(400);
    expect((await handleCredentialUnlinkIntentRequest({ request: inventoryRequest(f.session, "", { origin: "https://attacker.test" }), store: f.store, issuerOrigin: issuer, now: f.now }))?.status).toBe(403);
  } finally { await f.close(); }
});

test("credential inventory refuses unknown, duplicate, foreign-owned or overflowing backend records", async () => {
  const f = await fixture("memory");
  try {
    const record = (await f.store.findUpstreamIdentity(removedIdentity))!;
    const foreignSubject = "tsub_foreign_inventory";
    await f.store.saveAccount({ subject: foreignSubject, createdAt: 1, updatedAt: 1 });
    const foreign = { ...record, upstreamSubject: "foreign-upstream", subject: foreignSubject };
    await f.store.linkUpstreamIdentity(foreign);
    for (const records of [[{ ...record, upstreamSubject: "missing-upstream" }], [record, record], [foreign], Array.from({ length: 101 }, () => record)]) {
      const response = await handleCredentialUnlinkIntentRequest({ request: inventoryRequest(f.session), store: inventoryRecords(f.store, records), issuerOrigin: issuer, now: f.now });
      expect(response?.status).toBe(503);
      expect(await response!.json()).toEqual({ error: "credential_inventory_unavailable" });
      expect(response!.headers.get("cache-control")).toBe("no-store");
    }
  } finally { await f.close(); }
});

test("credential inventory returns at most 100 validated own canonical credentials", async () => {
  const f = await fixture("memory");
  try {
    for (let index = 0; index < 98; index++) await f.store.linkUpstreamIdentity({ providerId: `isolated-provider-${index}`, upstreamIssuer: "https://isolated-provider.example.test", upstreamSubject: `isolated-sub-${index}`, subject, createdAt: 1, updatedAt: 1 });
    const response = await handleCredentialUnlinkIntentRequest({ request: inventoryRequest(f.session), store: f.store, issuerOrigin: issuer, now: f.now });
    expect(response?.status).toBe(200);
    const value = await response!.json() as { credentials: unknown[] };
    expect(value.credentials).toHaveLength(100);
    await f.store.linkUpstreamIdentity({ providerId: "overflow-provider", upstreamIssuer: "https://isolated-provider.example.test", upstreamSubject: "overflow-sub", subject, createdAt: 1, updatedAt: 1 });
    expect((await handleCredentialUnlinkIntentRequest({ request: inventoryRequest(f.session), store: f.store, issuerOrigin: issuer, now: f.now }))?.status).toBe(503);
  } finally { await f.close(); }
});

test("HTTP intent mint is cookie-only, exact-Origin, bounded, strict and server-selected", async () => {
  const f = await fixture("memory");
  try {
    const body = { removedIdentity, retainedIdentity, consent: true };
    for (const candidate of [request(base, body, f.session, "", "https://attacker.test"), request(base, { ...body, operationId: `iunl_${crypto.randomUUID()}` }, f.session), request(base, { ...body, padding: "x".repeat(5000) }, f.session)]) {
      const response = await handleCredentialUnlinkIntentRequest({ request: candidate, store: f.store, issuerOrigin: issuer, now: f.now });
      expect([400, 403]).toContain(response!.status);
      expect(response!.headers.get("cache-control")).toBe("no-store");
    }
    const bearer = request(base, body, f.session); bearer.headers.set("authorization", `Bearer ${f.session.sessionId}`);
    expect((await handleCredentialUnlinkIntentRequest({ request: bearer, store: f.store, issuerOrigin: issuer, now: f.now }))?.status).toBe(401);
    const valid = await handleCredentialUnlinkIntentRequest({ request: request(base, body, f.session, ""), store: f.store, issuerOrigin: issuer, now: f.now });
    expect(valid?.status).toBe(201);
    expect(valid!.headers.get("set-cookie")).toContain("Secure; HttpOnly; SameSite=Lax");
    const value = await valid!.json() as { operationId: string };
    expect(value.operationId).toMatch(/^iunl_/u);
  } finally { await f.close(); }
});

test("actual GitHub retained OAuth callback yields an opaque unlink receipt and survives ordinary rotation", async () => {
  const f = await fixture("memory");
  const upstreamRequests: { path: string; method: string; authorization: string | null; body: string }[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    upstreamRequests.push({ path, method: req.method, authorization: req.headers.get("authorization"), body: await req.text() });
    if (path === "/token") return Response.json({ access_token: "isolated-private-access", token_type: "bearer" });
    expect(req.headers.get("authorization")).toBe("Bearer isolated-private-access");
    if (path === "/user") return Response.json({ id: 4711, login: "isolated", email: "untrusted-public@attacker.test" });
    return Response.json([{ email: "private@example.test", primary: true, verified: true, visibility: null }]);
  } });
  try {
    const intent = await pending(f);
    const options: UpstreamOAuthOptions = { hostedSessionPolicy: true, subjectSecret: "isolated-unlink-subject-key", providers: [{ providerId: github.id, provider: github, clientId: "isolated-social-client", redirectUri: `${issuer}/oauth/upstream/callback?provider=${github.id}` }], fetch: (async (input, init) => {
      const req = new Request(input, init);
      const target = new URL(req.url);
      const path = req.url === github.tokenEndpoint ? "/token" : req.url === github.userInfoEndpoint ? "/user" :
        target.origin + target.pathname === "https://api.github.com/user/emails" ? "/emails" : undefined;
      if (!path) throw new Error("unexpected fixture upstream target");
      return await fetch(new URL(path + target.search, upstream.url), init);
    }) as typeof fetch };
    const begin = await handleUpstreamUnlinkProofBeginRequest({ request: request(`${base}/${intent.operationId}/upstream-proof/begin`, { consent: true }, f.session), store: f.store, upstreamOAuth: options, issuerOrigin: issuer, secureCookie: true, now: f.now });
    expect(begin?.status).toBe(200);
    const beginBody = await begin!.json() as { authorization_url: string };
    const authUrl = new URL(beginBody.authorization_url);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const stateCookie = begin!.headers.get("set-cookie")!.split(";")[0]!;
    const callbackUrl = new URL(`${issuer}/oauth/upstream/callback?provider=${github.id}&state=${authUrl.searchParams.get("state")}&code=isolated-new-code`);
    const callbackRequest = new Request(callbackUrl, { headers: { cookie: `__Host-takosumi_session=${f.session.sessionId}; __Host-takosumi-unlink-browser=${"a".repeat(64)}; ${stateCookie}` } });
    const callback = await handleUpstreamCallbackRequest({ request: callbackRequest, url: callbackUrl, store: f.store, upstreamOAuth: options, secureCookie: true });
    expect(callback.status).toBe(200);
    const result = await callback.json() as { proof_receipt?: string; unlink_intent_id?: string; session_id?: string };
    expect(result.unlink_intent_id).toBe(intent.operationId);
    expect(result.proof_receipt).toMatch(/^iupr_/u);
    expect(result.session_id).toBeUndefined();
    expect(await f.store.findAccountSession(f.session.sessionId)).toBeUndefined();
    const storedReceipt = await f.store.findCredentialUnlinkReceipt!(result.proof_receipt!);
    expect(storedReceipt?.method).toBe("upstream-oauth-operation");
    expect(storedReceipt?.retainedIdentity).toEqual(retainedIdentity);
    expect(upstreamRequests.map((entry) => entry.path)).toEqual(["/token", "/user", "/emails"]);
    const exchangeBody = new URLSearchParams(upstreamRequests[0]!.body);
    expect(exchangeBody.get("code")).toBe("isolated-new-code");
    expect(exchangeBody.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(upstreamRequests[0]!.authorization).toBeNull();
    expect((await completeCredentialUnlink({ store: f.store, intent, receiptId: result.proof_receipt!, reconciler, now: Date.now(), clock: Date.now })).status).toBe("completed");
    expect((await handleUpstreamCallbackRequest({ request: callbackRequest, url: callbackUrl, store: f.store, upstreamOAuth: options, secureCookie: true })).status).not.toBe(200);
  } finally { upstream.stop(true); await f.close(); }
});

test("normal upstream OAuth transactions cannot mint unlink receipts", async () => {
  const f = await fixture("memory");
  try {
    const result = await completeUpstreamUnlinkProof({ request: request(base, {}, f.session), store: f.store,
      transaction: { id: "ordinary-old-transaction", providerId: github.id, browserBindingHash: "none", codeVerifier: "v".repeat(43), nonce: "none", redirectUri: issuer, createdAt: f.now - 60_000, expiresAt: f.now + 60_000 },
      exchange: { ...retainedIdentity, takosumiSubject: subject, tokenResponse: {}, userInfo: {} }, now: f.now });
    expect(result).toBeUndefined();
  } finally { await f.close(); }
});

test("receipt validation binds immutable direction, browser, epoch, transaction, consent and five-minute lifetime", async () => {
  const f = await fixture("memory");
  try {
    const intent = await pending(f);
    const receipt = await receiptFor(f, intent);
    const invalid: Partial<CredentialUnlinkReceipt>[] = [
      { operationId: `iunl_${crypto.randomUUID()}` }, { subject: "tsub_other" },
      { removedIdentity: retainedIdentity }, { retainedIdentity: removedIdentity },
      { retainedIdentity: { ...retainedIdentity, upstreamSubject: "attacker-numeric-id" } },
      { browserBindingHash: await sha256Text("other-browser") }, { issuerSessionHash: await sha256Text("other-session") },
      { identityGeneration: intent.identityGeneration + 1 }, { policyVersion: "obsolete" },
      { transactionDigest: "caller-input" }, { startedAt: intent.createdAt - 1 }, { completedAt: f.now + 1 },
      { legConsentAt: f.now - 1 }, { expiresAt: intent.expiresAt + 1 }, { consumedByOperation: intent.operationId },
    ];
    for (const override of invalid) expect(() => validateCredentialUnlinkReceipt(intent, { ...receipt, ...override }, f.now)).toThrow("unlink_conflict");
    expect(() => validateCredentialUnlinkReceipt(intent, receipt, f.now)).not.toThrow();
  } finally { await f.close(); }
});

test("proof begin rejects caller selected tuple, forged receipt context and foreign browser without redirecting", async () => {
  const f = await fixture("memory");
  try {
    const intent = await pending(f);
    const options: UpstreamOAuthOptions = { hostedSessionPolicy: true, subjectSecret: "isolated-unlink-begin-key", providers: [{ providerId: github.id, provider: github, clientId: "isolated-client", redirectUri: `${issuer}/oauth/upstream/callback?provider=${github.id}` }] };
    const path = `${base}/${intent.operationId}/upstream-proof/begin`;
    for (const body of [{ consent: false }, { consent: true, providerId: google.id }, { consent: true, identityGeneration: 0 }, { consent: true, receiptId: "forged" }]) {
      const response = await handleUpstreamUnlinkProofBeginRequest({ request: request(path, body, f.session), store: f.store, upstreamOAuth: options, issuerOrigin: issuer, secureCookie: true, now: f.now });
      expect(response?.status).toBe(400);
      expect(response!.headers.get("location")).toBeNull();
      expect(response!.headers.get("cache-control")).toBe("no-store");
    }
    const foreign = await handleUpstreamUnlinkProofBeginRequest({ request: request(path, { consent: true }, f.session, `__Host-takosumi-unlink-browser=${"b".repeat(64)}`), store: f.store, upstreamOAuth: options, issuerOrigin: issuer, secureCookie: true, now: f.now });
    expect(foreign?.status).toBe(409);
    const denied = await handleUpstreamUnlinkProofBeginRequest({ request: request(path, { consent: true }, f.session, undefined, "https://attacker.test"), store: f.store, upstreamOAuth: options, issuerOrigin: issuer, secureCookie: true, now: f.now });
    expect(denied?.status).toBe(403);
  } finally { await f.close(); }
});

test("owning retained callback refuses wrong immutable identity, foreign browser and logout after named proof begin", async () => {
  for (const attack of ["identity", "browser", "logout"] as const) {
    const f = await fixture("memory");
    try {
      const intent = await pending(f);
      const options: UpstreamOAuthOptions = { hostedSessionPolicy: true, subjectSecret: "isolated-unlink-negative-key", providers: [{ providerId: github.id, provider: github, clientId: "isolated-client", redirectUri: `${issuer}/oauth/upstream/callback?provider=${github.id}` }], fetch: (async (input, init) => {
        const req = new Request(input, init);
        if (req.url === github.tokenEndpoint) return Response.json({ access_token: "isolated-negative-access", token_type: "bearer" });
        if (req.url === github.userInfoEndpoint) return Response.json({ id: attack === "identity" ? 4712 : 4711, login: "isolated", email: null });
        return Response.json([{ email: "private@example.test", primary: true, verified: true, visibility: null }]);
      }) as typeof fetch };
      const begin = await handleUpstreamUnlinkProofBeginRequest({ request: request(`${base}/${intent.operationId}/upstream-proof/begin`, { consent: true }, f.session), store: f.store, upstreamOAuth: options, issuerOrigin: issuer, secureCookie: true, now: f.now });
      expect(begin?.status).toBe(200);
      const url = new URL((await begin!.json() as { authorization_url: string }).authorization_url);
      if (attack === "logout") await f.store.revokeHostedOidcSessionGrants!(intent.issuerSessionHash, Date.now());
      const browser = attack === "browser" ? "b".repeat(64) : "a".repeat(64);
      const callbackUrl = new URL(`${issuer}/oauth/upstream/callback?provider=${github.id}&state=${url.searchParams.get("state")}&code=isolated-code`);
      const callbackRequest = new Request(callbackUrl, { headers: { cookie: `__Host-takosumi_session=${f.session.sessionId}; __Host-takosumi-unlink-browser=${browser}; ${begin!.headers.get("set-cookie")!.split(";")[0]}` } });
      const callback = await handleUpstreamCallbackRequest({ request: callbackRequest, url: callbackUrl, store: f.store, upstreamOAuth: options, secureCookie: true });
      expect(callback.status).toBe(502);
      expect(await callback.json()).toEqual({ error: "upstream_oauth_failed", error_description: "Sign-in could not be completed. Please try again." });
      expect(await f.store.getAccountAuthenticationGeneration!(subject)).toBe(0);
      expect((await f.store.findUpstreamIdentityStatus!(removedIdentity))?.disabledAt).toBeUndefined();
      expect((await f.store.findCredentialUnlinkIntent!(intent.operationId))?.status).toBe("pending");
    } finally { await f.close(); }
  }
});

for (const kind of ["memory", "d1", "postgres"] as const) {
  test(`${kind}: unlink after canonical merge preserves the retained credential's original account and immutable resource/billing references`, async () => {
    const originalB = "tsub_unlink_original_B";
    const f = await fixture(kind, originalB);
    try {
      if (f.pg) await f.pg.query("INSERT INTO accounts_v1.protected_unlink_refs VALUES('source-kept',$1,'workspace_B','org_B',111222,'pending-op-B')", [originalB]);
      for (const [identity, identitySubject] of [[removedIdentity, subject], [retainedIdentity, originalB]] as const) await f.store.saveAccountEmailProof!({ ...identity, subject: identitySubject, address: "private@example.test", normalizedAddress: "private@example.test", verification: "provider", authoritative: true, observedAt: f.now, validUntil: f.now + 300_000 });
      let merge = await createIdentityMerge({ store: f.store, actor: subject, sourceSubject: originalB, targetSubject: subject, browserBindingHash: f.browserBindingHash, now: f.now });
      for (const role of ["source", "target"] as const) {
        const tuple = role === "source" ? retainedIdentity : removedIdentity;
        const receipt: IdentityOperationReceiptRecord = { receiptId: `iopr_${crypto.randomUUID()}`, operationId: merge.operationId, role, sourceSubject: originalB, targetSubject: subject, subject: role === "source" ? originalB : subject, ...tuple, browserBindingHash: merge.browserBindingHash, issuerSessionHash: await sha256Text(`isolated-merge-anchor:${role}`), identityGeneration: 0, policyVersion: merge.policyVersion, transactionDigest: await sha256Text(`isolated-merge-txn:${role}`), startedAt: f.now, completedAt: f.now, expiresAt: merge.expiresAt, emailDigest: merge.addressDigest, legConsent: true, legConsentAt: f.now, method: "upstream-oauth-operation" };
        expect(await f.store.createIdentityOperationReceipt!(receipt)).toBe(true);
        merge = await proveIdentityMerge({ store: f.store, operation: merge, session: f.session, receiptId: receipt.receiptId, now: f.now });
      }
      // Isolated synchronous fixture; it never runs a hosted background retry service.
      merge = await consentIdentityMerge({ store: f.store, operation: merge, session: f.session, consent: true, reconciler: { reconcile: async () => undefined }, retryCapability: { pendingCapacity: 100, assertAvailable: async () => {} }, now: f.now });
      await activateIdentityMerge({ store: f.store, operation: merge, now: f.now, reconciler: { reconcile: async (operation) => ({ operationId: operation.operationId, sourceSubject: originalB, targetSubject: subject, externalBindings: "kept-original-bindings", workspaceMembership: "kept-workspaces", billingLedger: "one-ledger-kept", consumerIntentCustody: "kept-pending-op-B-org_B", rpSessions: "revoked", personalWorkspaceId: "workspace-original", reconciledAt: f.now }) } });
      expect((await f.store.findCanonicalAccount!(originalB))?.subject).toBe(subject);
      const login = await rotateAccountSession({ store: f.store, subject, now: Date.now(), ttlMs: 60_000, hostedPolicy: true });
      f.session = (await f.store.findAccountSession(login.sessionId))!;
      f.now = Date.now();
      const inventoryBefore = await handleCredentialUnlinkIntentRequest({ request: inventoryRequest(f.session), store: f.store, issuerOrigin: issuer });
      expect(inventoryBefore?.status).toBe(200);
      expect(await inventoryBefore!.json()).toEqual({ credentials: [{ ...retainedIdentity, enabled: true }, { ...removedIdentity, enabled: true }] });
      const intent = await pending(f);
      const receipt = await receiptFor(f, intent);
      const completed = await completeCredentialUnlink({ store: f.store, intent, receiptId: receipt.receiptId, reconciler, now: Date.now(), clock: Date.now });
      expect(completed.status).toBe("completed");
      expect((await f.store.findUpstreamIdentity(retainedIdentity))?.subject).toBe(originalB);
      expect((await f.store.findAccount(originalB))?.createdAt).toBe(1);
      expect((await f.store.findCanonicalAccount!(originalB))?.subject).toBe(subject);
      expect((await f.store.findUpstreamIdentityStatus!(retainedIdentity))?.disabledAt).toBeUndefined();
      const afterLogin = await rotateAccountSession({ store: f.store, subject, now: Date.now(), ttlMs: 60_000, hostedPolicy: true });
      const afterSession = (await f.store.findAccountSession(afterLogin.sessionId))!;
      const inventoryAfter = await handleCredentialUnlinkIntentRequest({ request: inventoryRequest(afterSession), store: f.store, issuerOrigin: issuer });
      expect(inventoryAfter?.status).toBe(200);
      expect(await inventoryAfter!.json()).toEqual({ credentials: [{ ...retainedIdentity, enabled: true }] });
      if (f.pg) expect((await f.pg.query("SELECT subject,workspace_id,org_id,micro_usd,pending_operation_key FROM accounts_v1.protected_unlink_refs WHERE id='source-kept'")).rows).toEqual([{ subject: originalB, workspace_id: "workspace_B", org_id: "org_B", micro_usd: 111222, pending_operation_key: "pending-op-B" }]);
    } finally { await f.close(); }
  }, 20_000);
}

test("retained Google signed callback without auth_time proves current identity without claiming credential reauthentication", async () => {
  const f = await fixture("memory");
  try {
    const intent = await pending(f, true);
    const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "isolated-unlink-google", alg: "RS256", use: "sig" };
    let idToken = "";
    const options: UpstreamOAuthOptions = { hostedSessionPolicy: true, subjectSecret: "isolated-google-unlink-key", providers: [{ providerId: google.id, provider: google, clientId: "isolated-google-client", redirectUri: `${issuer}/oauth/upstream/callback?provider=${google.id}` }], fetch: (async (input, init) => {
      const req = new Request(input, init);
      if (req.url === google.tokenEndpoint) return Response.json({ access_token: "isolated-google-access", token_type: "Bearer", id_token: idToken });
      if (req.url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
      if (req.url === google.userInfoEndpoint) return Response.json({ sub: removedIdentity.upstreamSubject });
      throw new Error("unexpected isolated Google target");
    }) as typeof fetch };
    const begin = await handleUpstreamUnlinkProofBeginRequest({ request: request(`${base}/${intent.operationId}/upstream-proof/begin`, { consent: true }, f.session), store: f.store, upstreamOAuth: options, issuerOrigin: issuer, secureCookie: true, now: f.now });
    expect(begin?.status).toBe(200);
    const authorization = new URL((await begin!.json() as { authorization_url: string }).authorization_url);
    expect(authorization.searchParams.get("max_age")).toBeNull();
    const seconds = Math.floor(Date.now() / 1000);
    const signed = `${base64UrlEncodeJson({ alg: "RS256", kid: jwk.kid })}.${base64UrlEncodeJson({ iss: google.issuer, aud: "isolated-google-client", sub: removedIdentity.upstreamSubject, nonce: authorization.searchParams.get("nonce"), iat: seconds, exp: seconds + 300, email: "retained@gmail.com", email_verified: true })}`;
    idToken = `${signed}.${base64UrlEncodeBytes(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(signed))))}`;
    const callbackUrl = new URL(`${issuer}/oauth/upstream/callback?provider=${google.id}&state=${authorization.searchParams.get("state")}&code=isolated-google-code`);
    const callback = await handleUpstreamCallbackRequest({ request: new Request(callbackUrl, { headers: { cookie: `__Host-takosumi_session=${f.session.sessionId}; __Host-takosumi-unlink-browser=${"a".repeat(64)}; ${begin!.headers.get("set-cookie")!.split(";")[0]}` } }), url: callbackUrl, store: f.store, upstreamOAuth: options, secureCookie: true });
    expect(callback.status).toBe(200);
    expect(callback.headers.get("cache-control")).toBe("no-store");
    const result = await callback.json() as { proof_receipt: string; unlink_intent_id: string };
    expect(result.unlink_intent_id).toBe(intent.operationId);
    const newCookie = callback.headers.getSetCookie().find((value) => value.startsWith("__Host-takosumi_session="))!;
    const newSessionId = newCookie.split(";")[0]!.slice("__Host-takosumi_session=".length);
    const newSession = await f.store.findAccountSession(newSessionId);
    expect(newSession?.reauthenticatedAt).toBeUndefined();
    expect(newSession?.authTime).toBeDefined();
    expect(newSession?.issuerSessionId).toBe(intent.issuerSessionHash);
    expect((await completeCredentialUnlink({ store: f.store, intent, receiptId: result.proof_receipt, reconciler, now: Date.now(), clock: Date.now })).status).toBe("completed");
    expect((await f.store.findUpstreamIdentityStatus!(retainedIdentity))?.disabledAt).toBeDefined();
    expect((await f.store.findUpstreamIdentityStatus!(removedIdentity))?.disabledAt).toBeUndefined();
  } finally { await f.close(); }
});
