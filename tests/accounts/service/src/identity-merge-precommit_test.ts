/** Local precommit boundaries only. No database execution/2PC guarantee. */
import { expect, test } from "bun:test";
import { prepareIsolatedReserveMutation, type IsolatedExpiryBound } from "../fixtures/identity-merge-precommit-fixture.ts";
import { MemoryIdentityRecordRepository } from "../../../../accounts/service/src/memory-identity-records.ts";
import { D1IdentityRecordRepository } from "../../../../accounts/service/src/d1-identity-records.ts";
import { PostgresIdentityRecordRepository } from "../../../../accounts/service/src/postgres/identity-records.ts";
import { canonicalOwnerJson } from "../../../../accounts/service/src/owner-operation-evidence.ts";
import { sha256Text } from "../../../../accounts/service/src/encoding.ts";
import type { IdentityMergeMutation } from "../../../../accounts/service/src/identity-state.ts";

type Fixture = Awaited<ReturnType<typeof prepareIsolatedReserveMutation>>;
async function vector(f: Fixture): Promise<string> {
  const r = f.repository;
  if (r instanceof MemoryIdentityRecordRepository) return sha256Text(canonicalOwnerJson({
    docs: [...r.records].sort(), accounts: [...r.accounts].sort(), sessions: [...r.sessions].sort(), identities: [...r.identities].sort(),
  }));
  if (r instanceof D1IdentityRecordRepository) return sha256Text(canonicalOwnerJson((await r.db.prepare("SELECT bucket,key,document,updated_at FROM takosumi_accounts_documents ORDER BY bucket,key").all()).results));
  if (r instanceof PostgresIdentityRecordRepository) {
    const snapshot: Record<string, unknown> = {};
    for (const table of ["hosted_identity_records", "accounts", "account_sessions", "upstream_identities", "authorization_codes", "oauth_access_tokens", "oauth_refresh_tokens", "context_protected_refs"])
      snapshot[table] = (await r.client.queryObject(`SELECT row_to_json(t) AS value FROM accounts_v1.${table} t ORDER BY row_to_json(t)::text`)).rows;
    return sha256Text(canonicalOwnerJson(snapshot));
  }
  throw new Error("unknown_isolated_backend");
}
async function unfenced(f: Fixture) {
  expect((await f.store.findIdentityMergeOperation!(f.operation.operationId))?.consentAt).toBeUndefined();
  for (const subject of [f.operation.sourceSubject, f.operation.targetSubject]) {
    expect(await f.store.getAccountAuthenticationGeneration!(subject)).toBe(0);
    expect(await f.store.findIdentityMergeLock!(subject)).toBeUndefined();
  }
}

/** Advance the SAME captured trusted clock only after a genuine awaited
 * backend preparation completes, never by editing the checkpoint. */
async function executeAfterPreparation(f: Fixture, time: number, stage: "prepare" | "hash" = "prepare") {
  const r = f.repository;
  if (r instanceof D1IdentityRecordRepository) {
    let prepares = 0;
    const repository = new D1IdentityRecordRepository(r.db, async () => {
      await r.initialize();
      if (stage === "prepare") { prepares++; f.time(time); }
    }, async (session) => {
      const hash = await r.hashSession(session);
      if (stage === "hash") { prepares++; f.time(time); }
      return hash;
    });
    const result = await repository.mutateMerge(f.mutation);
    expect(prepares).toBeGreaterThan(0);
    return result;
  }
  if (r instanceof PostgresIdentityRecordRepository && stage === "prepare") {
    const get = r.get.bind(r);
    let reads = 0;
    r.get = async <T>(bucket: string, key: string): Promise<T | undefined> => {
      const value = await get<T>(bucket, key);
      if (bucket === "email_candidate_inventory" && key === "global") { reads++; f.time(time); }
      return value;
    };
    try { const result = await f.execute(); expect(reads).toBe(1); return result; }
    finally { r.get = get; }
  }
  const digest = crypto.subtle.digest;
  let hashes = 0;
  crypto.subtle.digest = async (algorithm, data) => {
    const result = await digest.call(crypto.subtle, algorithm, data);
    hashes++; f.time(time);
    return result;
  };
  try { const result = await f.execute(); expect(hashes).toBeGreaterThan(0); return result; }
  finally { crypto.subtle.digest = digest; }
}

for (const kind of ["memory", "native-d1", "postgres"] as const) {
  test(`${kind}: fresh preparation refreshes SQL/audit time and consumes one checkpoint`, async () => {
    const f = await prepareIsolatedReserveMutation(kind);
    try {
      expect(await executeAfterPreparation(f, f.clock() + 3)).toBe(true);
      const audit = await f.repository.get<{at:number;availabilityCheckpoint?:unknown}>("identity_merge_audit", `${f.operation.operationId}:${f.operation.revision + 1}`);
      expect(audit?.at).toBe(f.clock());
      expect(audit?.availabilityCheckpoint).toBeUndefined();
      expect((await f.store.findIdentityMergeOperation!(f.operation.operationId))?.consentAt).toBe(f.mutation.next.consentAt);
      const committed = await vector(f);
      expect(await f.execute()).toBe(false);
      expect(await vector(f)).toBe(committed);
    } finally { await f.close(); }
  }, 20000);

  for (const stage of (kind === "memory" ? ["hash"] : ["prepare", "hash"]) as readonly ("prepare" | "hash")[]) {
    test(`${kind}: signed status expiring after awaited ${stage} leaves the complete root vector unchanged`, async () => {
      const f = await prepareIsolatedReserveMutation(kind);
      try {
        const before = await vector(f);
        expect(await executeAfterPreparation(f, f.clock() + 5000, stage)).toBe(false);
        expect(await vector(f)).toBe(before);
        await unfenced(f);
      } finally { await f.close(); }
    }, 20000);
  }

  for (const bound of ["operation", "session-idle", "session-absolute", "proof", "plan", "context", "email", "email-max-age"] as const satisfies readonly IsolatedExpiryBound[]) {
    test(`${kind}: captured ${bound} deadline rejects even while issuer status is fresh`, async () => {
      const f = await prepareIsolatedReserveMutation(kind, bound);
      try {
        const before = await vector(f);
        expect(await executeAfterPreparation(f, f.deadline)).toBe(false);
        expect(await vector(f)).toBe(before);
        await unfenced(f);
      } finally { await f.close(); }
    }, 20000);
  }

  test(`${kind}: forged/copied/foreign/mutated checkpoint snapshots cannot reserve`, async () => {
    const f = await prepareIsolatedReserveMutation(kind), foreign = await prepareIsolatedReserveMutation("memory");
    try {
      const before = await vector(f);
      const mutations: IdentityMergeMutation[] = [
        { ...f.mutation, availabilityCheckpoint: {} as never },
        { ...f.mutation, availabilityCheckpoint: { ...f.mutation.availabilityCheckpoint } as never },
        { ...f.mutation, availabilityCheckpoint: structuredClone(f.mutation.availabilityCheckpoint) },
        { ...f.mutation, availabilityCheckpoint: foreign.mutation.availabilityCheckpoint },
        { ...f.mutation, next: { ...f.mutation.next, mutationId: "different-attempt" } },
        { ...f.mutation, retryCapacity: 99 },
      ];
      for (const mutation of mutations) expect(await f.execute(mutation)).toBe(false);
      await expect(f.execute({ ...f.mutation, expectedRevision: f.mutation.expectedRevision + 1 })).rejects.toThrow("invalid_identity_merge_mutation");
      expect(await vector(f)).toBe(before);
      await unfenced(f);
    } finally { await foreign.close(); await f.close(); }
  }, 20000);

  test(`${kind}: a failed local dispatch burns the original checkpoint without root writes`, async () => {
    const f = await prepareIsolatedReserveMutation(kind);
    try {
      const before = await vector(f), r = f.repository;
      let dispatches = 0;
      if (r instanceof MemoryIdentityRecordRepository) {
        const set = r.records.set;
        r.records.set = () => { dispatches++; throw new Error("isolated_dispatch_failure"); };
        try { await expect(f.execute()).rejects.toThrow("isolated_dispatch_failure"); }
        finally { r.records.set = set; }
      } else if (r instanceof D1IdentityRecordRepository) {
        const repository = new D1IdentityRecordRepository({ prepare: r.db.prepare.bind(r.db), exec: r.db.exec.bind(r.db),
          batch: async () => { dispatches++; throw new Error("isolated_dispatch_failure"); } }, r.initialize, r.hashSession);
        await expect(repository.mutateMerge(f.mutation)).rejects.toThrow("isolated_dispatch_failure");
      } else if (r instanceof PostgresIdentityRecordRepository) {
        const repository = new PostgresIdentityRecordRepository({ queryObject: async <T>(sql: string, args?: readonly unknown[]) => {
          if (sql.startsWith("WITH ")) { dispatches++; throw new Error("isolated_dispatch_failure"); }
          return r.client.queryObject<T>(sql, args);
        } });
        await expect(repository.mutateMerge(f.mutation)).rejects.toThrow("isolated_dispatch_failure");
      }
      expect(dispatches).toBe(1);
      expect(await vector(f)).toBe(before);
      expect(await f.execute()).toBe(false);
      expect(await vector(f)).toBe(before);
      await unfenced(f);
    } finally { await f.close(); }
  }, 20000);

  test(`${kind}: backwards trusted clock after preparation denies without root writes`, async () => {
    const f = await prepareIsolatedReserveMutation(kind);
    try {
      const before = await vector(f);
      expect(await executeAfterPreparation(f, f.clock() - 1)).toBe(false);
      expect(await vector(f)).toBe(before);
      await unfenced(f);
    } finally { await f.close(); }
  }, 20000);
}
