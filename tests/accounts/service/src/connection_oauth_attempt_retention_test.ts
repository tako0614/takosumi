import { expect, test } from "bun:test";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { AccountsStore, TakosumiAccountRecord } from "../../../../accounts/service/src/store.ts";
import { PGlite } from "@electric-sql/pglite";
import { MemoryIdentityRecordRepository } from "../../../../accounts/service/src/memory-identity-records.ts";
import { D1IdentityRecordRepository } from "../../../../accounts/service/src/d1-identity-records.ts";
import { PostgresIdentityRecordRepository } from "../../../../accounts/service/src/postgres/identity-records.ts";
import { HostedIdentityRecords, type IdentityRecordRepository } from "../../../../accounts/service/src/hosted-identity-records.ts";
import { runScheduledAccountsConnectionOAuthAttemptRetention } from "../../../../deploy/platform/worker.ts";
import type { D1PreparedStatement } from "../../../../worker/src/bindings.ts";
import type { PostgresQueryClient } from "../../../../accounts/service/src/postgres-store.ts";
import { D1AccountsStore, type D1Database } from "../../../../accounts/service/src/d1-store.ts";
import { PostgresAccountsStore } from "../../../../accounts/service/src/postgres-store.ts";
import { connectionOAuthAttemptBucket as bucket, connectionOAuthAttemptPurpose as purpose, connectionOAuthAttemptSweepKey as checkpointKey, connectionOAuthAttemptId, type ConnectionOAuthAttemptRecord } from "../../../../accounts/service/src/connection-oauth-attempt.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { sha256Text } from "../../../../accounts/service/src/encoding.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const baselineSql = `CREATE SCHEMA accounts_v1;
CREATE TABLE accounts_v1.accounts(subject text PRIMARY KEY,email text,email_verified boolean,display_name text,picture text,terms_version text,terms_accepted_at timestamptz,terms_accepted_source text,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE TABLE accounts_v1.upstream_identities(provider_id text,upstream_issuer text,upstream_subject text,subject text REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(provider_id,upstream_issuer,upstream_subject));
CREATE TABLE accounts_v1.account_sessions(session_id text PRIMARY KEY,subject text REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.authorization_codes(code_hash text PRIMARY KEY,client_id text,redirect_uri text,scope text,subject text,takosumi_subject text REFERENCES accounts_v1.accounts(subject),capsule_id text,workspace_id text,role text,nonce text,code_challenge text,code_challenge_method text,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.oauth_access_tokens(token_hash text PRIMARY KEY,client_id text,audience text,scope text,subject text,takosumi_subject text REFERENCES accounts_v1.accounts(subject),capsule_id text,workspace_id text,role text,interface_id text,interface_binding_id text,interface_resolved_revision bigint,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.oauth_refresh_tokens(LIKE accounts_v1.oauth_access_tokens INCLUDING ALL);
CREATE TABLE accounts_v1.protected_references(id text PRIMARY KEY,subject text REFERENCES accounts_v1.accounts(subject),workspace_id text,org_id text,micro_usd bigint);`;

async function fixture(kind: "memory" | "d1" | "postgres") {
  const account = { subject: "tsub_gc_fixture" as const, createdAt: 1, updatedAt: 1 };
  let repo: IdentityRecordRepository;
  let d1: SqliteFakeD1 | undefined;
  let client: PostgresQueryClient | undefined;
  let close = async () => {};
  let lookup: AccountsStore["findAccount"];
  if (kind === "memory") {
    const accounts = new Map<TakosumiSubject, TakosumiAccountRecord>([[account.subject, account]]);
    repo = new MemoryIdentityRecordRepository(accounts, new Map(), new Map(), () => {});
    lookup = subject => accounts.get(subject);
  } else if (kind === "d1") {
    const db = new SqliteFakeD1();
    d1 = db;
    const store = new D1AccountsStore(db as unknown as D1Database);
    await store.saveAccount(account);
    repo = new D1IdentityRecordRepository(db as unknown as D1Database, () => store.initialize(), sha256Text);
    lookup = subject => store.findAccount(subject);
  } else {
    const pg = new PGlite();
    close = () => pg.close();
    await pg.exec(baselineSql);
    await pg.exec(await Bun.file(new URL("../../../../accounts/service/migrations/045_hosted_canonical_identity.sql", import.meta.url)).text());
    client = { queryObject: async <T>(sql: string, args: readonly unknown[] = []) => ({ rows: (await pg.query(sql, [...args])).rows as T[] }) };
    const store = new PostgresAccountsStore(client);
    await store.saveAccount(account);
    repo = new PostgresIdentityRecordRepository(client);
    lookup = subject => store.findAccount(subject);
  }
  const hosted = new HostedIdentityRecords(repo, { findAccount: lookup });
  const record = async (name: string, expiresAt = 100): Promise<ConnectionOAuthAttemptRecord> => {
    const stateDigest = await stableJsonDigest(name);
    return { purpose, id: await connectionOAuthAttemptId("gcp", stateDigest), helperId: "gcp", stateDigest,
      browserBindingHash: await stableJsonDigest("local browser binding"), subject: account.subject,
      scope: "personal", createdAt: 1, expiresAt };
  };
  return { repo, hosted, record, close, d1, client };
}

for (const kind of ["memory", "d1", "postgres"] as const) {
  test(`Connection OAuth retention ${kind} deletes only expired purpose rows and preserves other state`, async () => {
    const f = await fixture(kind);
    try {
      const expired = await f.record("expired");
      const live = await f.record("live", 101);
      await f.hosted.createConnectionOAuthAttempt(expired);
      await f.hosted.createConnectionOAuthAttempt(live);
      await f.repo.put(bucket, "wrong-purpose", { ...expired, id: "wrong-purpose", purpose: "another-purpose" });
      await f.repo.put(bucket, "invalid-expiry", { purpose, expiresAt: "1" });
      await f.repo.put(bucket, "fractional-expiry", { purpose, expiresAt: 1.5 });
      await f.repo.put(bucket, "negative-expiry", { purpose, expiresAt: -1 });
      const canary = { marker: "protected", expiresAt: 1, purpose };
      const otherBuckets = ["authorization_codes", "passkey_challenges", "financial_source_receipts", "upstream_login_transactions", "identity_merge_operations", "audit"];
      for (const name of otherBuckets) await f.repo.put(name, "unchanged", canary);
      const oldRefresh = { generation: 7, cursor: { phase: "chain_links", after: "unchanged" } };
      const oldPasskey = { generation: 8, after: "unchanged", windowStart: 0 };
      await f.repo.put("maintenance_cursors", "refresh-chain-retention", oldRefresh);
      await f.repo.put("maintenance_cursors", "passkey-challenges-v1", oldPasskey);
      expect(await f.hosted.pruneConnectionOAuthAttempts({ now: 100 })).toEqual({ scanned: 6, deleted: 1 });
      expect(await f.repo.get(bucket, expired.id)).toBeUndefined();
      expect(await f.repo.get<ConnectionOAuthAttemptRecord>(bucket, live.id)).toEqual(live);
      expect(await f.repo.get<Record<string, unknown>>(bucket, "wrong-purpose")).toEqual({ ...expired, id: "wrong-purpose", purpose: "another-purpose" });
      expect(await f.repo.get<Record<string, unknown>>(bucket, "invalid-expiry")).toEqual({ purpose, expiresAt: "1" });
      expect(await f.repo.get<Record<string, unknown>>(bucket, "fractional-expiry")).toEqual({ purpose, expiresAt: 1.5 });
      expect(await f.repo.get<Record<string, unknown>>(bucket, "negative-expiry")).toEqual({ purpose, expiresAt: -1 });
      for (const name of otherBuckets) expect(await f.repo.get<Record<string, unknown>>(name, "unchanged")).toEqual(canary);
      expect(await f.repo.get<Record<string, unknown>>("maintenance_cursors", "refresh-chain-retention")).toEqual(oldRefresh);
      expect(await f.repo.get<Record<string, unknown>>("maintenance_cursors", "passkey-challenges-v1")).toEqual(oldPasskey);
      expect(await f.hosted.consumeConnectionOAuthAttempt(expired.id, expired.browserBindingHash, 100)).toBeUndefined();
      expect(await f.hosted.consumeConnectionOAuthAttempt(live.id, live.browserBindingHash, 100)).toEqual(live);
    } finally { await f.close(); }
  });

  test(`Connection OAuth retention ${kind} bounds scans, crosses live prefix and wraps for late expiry and new keys`, async () => {
    const f = await fixture(kind);
    try {
      const records = await Promise.all([0, 1, 2].map(i => f.record(`cursor-${i}`, 101)));
      records.sort((a, b) => a.id.localeCompare(b.id));
      records[2] = { ...records[2]!, expiresAt: 100 };
      for (const r of records) await f.hosted.createConnectionOAuthAttempt(r);
      expect(await f.hosted.pruneConnectionOAuthAttempts({ now: 100, maxRows: 2 })).toEqual({ scanned: 2, deleted: 0 });
      expect((await f.repo.get<{ generation: number; after: string }>("maintenance_cursors", checkpointKey))?.after).toBe(records[1]!.id);
      const incoming = await Promise.all(Array.from({ length: 32 }, (_, i) => f.record(`arrived-behind-cursor-${i}`, 100)));
      const added = incoming.find(r => r.id < records[1]!.id && !records.some(old => old.id === r.id));
      if (!added) throw new Error("controlled normal-key fixture did not straddle the cursor");
      await f.hosted.createConnectionOAuthAttempt(added);
      expect(await f.hosted.pruneConnectionOAuthAttempts({ now: 100, maxRows: 2 })).toEqual({ scanned: 1, deleted: 1 });
      expect((await f.repo.get<{ after: string }>("maintenance_cursors", checkpointKey))?.after).toBe("");
      let deleted = 0;
      for (let i = 0; i < 3; i++) {
        const result = await f.hosted.pruneConnectionOAuthAttempts({ now: 101, maxRows: 2 });
        expect(result.scanned).toBeLessThanOrEqual(2);
        deleted += result.deleted;
      }
      expect(deleted).toBe(3);
      for (const r of [...records, added]) expect(await f.repo.get(bucket, r.id)).toBeUndefined();
    } finally { await f.close(); }
  });

  test(`Connection OAuth retention ${kind} rejects invalid bounds and malformed checkpoint before deletion`, async () => {
    const f = await fixture(kind);
    try {
      const expired = await f.record("guarded");
      await f.hosted.createConnectionOAuthAttempt(expired);
      for (const input of [{ now: NaN }, { now: -1 }, { now: 100, maxRows: 0 }, { now: 100, maxRows: 65 }, { now: 100, maxRows: 1.5 }]) {
        await expect(f.hosted.pruneConnectionOAuthAttempts(input)).rejects.toThrow();
      }
      await f.repo.put("maintenance_cursors", checkpointKey, { generation: -1, after: "" });
      await expect(f.hosted.pruneConnectionOAuthAttempts({ now: 100 })).rejects.toThrow();
      expect(await f.repo.get<ConnectionOAuthAttemptRecord>(bucket, expired.id)).toEqual(expired);
    } finally { await f.close(); }
  });
}


class Gate {
  readonly reached: Promise<void>;
  readonly released: Promise<void>;
  #reach!: () => void;
  #release!: () => void;
  constructor() {
    this.reached = new Promise(resolve => { this.#reach = resolve; });
    this.released = new Promise(resolve => { this.#release = resolve; });
  }
  async pause() { this.#reach(); await this.released; }
  release() { this.#release(); }
}

function holdFirstMutation(f: Awaited<ReturnType<typeof fixture>>, gate: Gate) {
  let armed = true;
  if (f.d1) {
    const original = f.d1.batch.bind(f.d1);
    f.d1.batch = async <T>(statements: readonly D1PreparedStatement[]) => {
      if (armed) { armed = false; await gate.pause(); }
      return original<T>(statements);
    };
  } else {
    const client = f.client!;
    const original = client.queryObject!;
    client.queryObject = async (sql, args = []) => {
      if (armed && sql.includes("WITH removed AS")) { armed = false; await gate.pause(); }
      return original(sql, args);
    };
  }
}

for (const kind of ["d1", "postgres"] as const) {
  for (const change of ["live", "other-purpose"] as const) {
    test(`Connection OAuth retention ${kind} retains a current row changed to ${change} after selection`, async () => {
      const f = await fixture(kind);
      const gate = new Gate();
      let inFlight: Promise<unknown> | undefined;
      try {
        const expired = await f.record("selected expired row");
        await f.hosted.createConnectionOAuthAttempt(expired);
        holdFirstMutation(f, gate);
        const pending = f.hosted.pruneConnectionOAuthAttempts({ now: 100 });
        inFlight = pending;
        await Promise.race([gate.reached, pending.then(() => { throw new Error("sweep missed mutation gate"); })]);
        const replacement = change === "live" ? { ...expired, expiresAt: 101 } : { ...expired, purpose: "other-purpose" };
        await f.repo.put(bucket, expired.id, replacement);
        gate.release();
        expect(await pending).toEqual({ scanned: 1, deleted: 0 });
        expect(await f.repo.get<typeof replacement>(bucket, expired.id)).toEqual(replacement);
      } finally { gate.release(); await inFlight?.catch(() => undefined); await f.close(); }
    });
  }

  test(`Connection OAuth retention ${kind} overlap cannot rewind the newer cursor`, async () => {
    const f = await fixture(kind);
    const gate = new Gate();
    let inFlight: Promise<unknown> | undefined;
    try {
      const records = await Promise.all([f.record("overlap-a"), f.record("overlap-b")]);
      for (const r of records) await f.hosted.createConnectionOAuthAttempt(r);
      holdFirstMutation(f, gate);
      const stale = f.hosted.pruneConnectionOAuthAttempts({ now: 100, maxRows: 1 });
      inFlight = stale;
      await Promise.race([gate.reached, stale.then(() => { throw new Error("sweep missed overlap gate"); })]);
      expect(await f.hosted.pruneConnectionOAuthAttempts({ now: 100, maxRows: 1 })).toEqual({ scanned: 1, deleted: 1 });
      expect(await f.hosted.pruneConnectionOAuthAttempts({ now: 100, maxRows: 1 })).toEqual({ scanned: 1, deleted: 1 });
      const newer = await f.repo.get<{ generation: number; after: string }>("maintenance_cursors", checkpointKey);
      expect(newer?.generation).toBe(2);
      gate.release();
      expect(await stale).toEqual({ scanned: 1, deleted: 0 });
      expect(await f.repo.get<{ generation: number; after: string }>("maintenance_cursors", checkpointKey)).toEqual(newer);
      for (const r of records) expect(await f.repo.get(bucket, r.id)).toBeUndefined();
    } finally { gate.release(); await inFlight?.catch(() => undefined); await f.close(); }
  });
}

test("Connection OAuth retention D1 maximum slice stays below the parameter ceiling", async () => {
  const f = await fixture("d1");
  try {
    for (let i = 0; i < 64; i++) await f.hosted.createConnectionOAuthAttempt(await f.record(`maximum-${i}`));
    expect(await f.hosted.pruneConnectionOAuthAttempts({ now: 100 })).toEqual({ scanned: 64, deleted: 64 });
    expect(await f.repo.page(bucket, undefined, 65)).toEqual([]);
  } finally { await f.close(); }
});

test("Connection OAuth scheduled retention reports unknown counts after committed ACK loss and resumes safely", async () => {
  const f = await fixture("d1");
  const db = f.d1!;
  try {
    const expired = await f.record("scheduled-expired");
    const live = await f.record("scheduled-live", Date.now() + 60_000);
    // Real records have a maximum ten-minute lifetime.
    const currentLive = { ...live, createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
    await f.hosted.createConnectionOAuthAttempt(expired);
    await f.hosted.createConnectionOAuthAttempt(currentLive);
    const originalBatch = db.batch.bind(db);
    let loseAck = true;
    db.batch = async <T>(statements: readonly D1PreparedStatement[]) => {
      const result = await originalBatch<T>(statements);
      if (loseAck) { loseAck = false; throw new Error("synthetic committed ACK loss"); }
      return result;
    };
    const originalPrepare = db.prepare.bind(db);
    let runtimeDdl = 0;
    db.prepare = sql => {
      if (/^\s*(?:CREATE|ALTER|DROP|PRAGMA)\b/iu.test(sql)) { runtimeDdl++; throw new Error("runtime DDL refused"); }
      return originalPrepare(sql);
    };
    const env = { TAKOSUMI_ACCOUNTS_DB: db as unknown as D1Database, TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed" as const };
    expect(await runScheduledAccountsConnectionOAuthAttemptRetention(env)).toEqual({ scanned: null, deleted: null, failures: 1 });
    expect(await f.repo.get(bucket, expired.id)).toBeUndefined();
    expect(await f.repo.get<ConnectionOAuthAttemptRecord>(bucket, currentLive.id)).toEqual(currentLive);
    expect((await f.repo.get<{ generation: number }>("maintenance_cursors", checkpointKey))?.generation).toBe(1);
    expect(await runScheduledAccountsConnectionOAuthAttemptRetention(env)).toEqual({ scanned: 1, deleted: 0, failures: 0 });
    expect(await f.hosted.consumeConnectionOAuthAttempt(expired.id, expired.browserBindingHash, Date.now())).toBeUndefined();
    expect(runtimeDdl).toBe(0);
  } finally { await f.close(); }
});
