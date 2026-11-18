import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { InMemoryAccountsStore, type AccountsStore, type TakosumiAccountRecord } from "../../../../accounts/service/src/store.ts";
import { D1AccountsStore, type D1Database } from "../../../../accounts/service/src/d1-store.ts";
import { PostgresAccountsStore } from "../../../../accounts/service/src/postgres-store.ts";
import type { PasswordCredential, PasswordWriteAuthorization } from "../../../../accounts/service/src/password-store.ts";
import { MemoryPasswordAuthStore, memoryPasswordSubjectActive, memoryPasswordRevocationAllowed } from "../../../../accounts/service/src/password-store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const baseline = `CREATE SCHEMA accounts_v1;
CREATE TABLE accounts_v1.accounts(subject text PRIMARY KEY,email text,email_verified boolean,display_name text,picture text,terms_version text,terms_accepted_at timestamptz,terms_accepted_source text,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE TABLE accounts_v1.upstream_identities(provider_id text,upstream_issuer text,upstream_subject text,subject text REFERENCES accounts_v1.accounts(subject),created_at timestamptz,updated_at timestamptz,PRIMARY KEY(provider_id,upstream_issuer,upstream_subject));
CREATE TABLE accounts_v1.account_sessions(session_id text PRIMARY KEY,subject text REFERENCES accounts_v1.accounts(subject),created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.authorization_codes(code_hash text PRIMARY KEY,client_id text,redirect_uri text,scope text,subject text,takosumi_subject text REFERENCES accounts_v1.accounts(subject),capsule_id text,workspace_id text,role text,nonce text,code_challenge text,code_challenge_method text,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.oauth_access_tokens(token_hash text PRIMARY KEY,client_id text,audience text,scope text,subject text,takosumi_subject text REFERENCES accounts_v1.accounts(subject),capsule_id text,workspace_id text,role text,interface_id text,interface_binding_id text,interface_resolved_revision bigint,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.oauth_refresh_tokens(LIKE accounts_v1.oauth_access_tokens INCLUDING ALL);
CREATE TABLE accounts_v1.personal_access_tokens(token_id text PRIMARY KEY,token_hash text,token_prefix text,subject text,name text,scopes text[],workspace_id text,app_ids text[],created_at timestamptz,expires_at timestamptz,revoked_at timestamptz,last_used_at timestamptz);`;

const OWNER = "tsub_password_owner";
const OTHER = "tsub_password_other";
function account(subject = OWNER): TakosumiAccountRecord {
  return { subject, email: `${subject}@example.test`, emailVerified: true,
    displayName: "Existing profile", createdAt: 1_000, updatedAt: 1_000 };
}
function credential(overrides: Partial<PasswordCredential> = {}): PasswordCredential {
  return { subject: OWNER, username: "fixture-owner", passwordHash: "fixture-password-verifier", version: 1, ...overrides };
}

type Kind = "memory" | "d1" | "postgres";
async function fixture(kind: Kind) {
  let store: AccountsStore;
  let replica: AccountsStore;
  let d1: SqliteFakeD1 | undefined;
  let pg: PGlite | undefined;
  if (kind === "memory") {
    store = replica = new InMemoryAccountsStore();
  } else if (kind === "d1") {
    d1 = new SqliteFakeD1();
    const raw = d1;
    // Real D1 serializes batch transactions. The asynchronous SQLite helper
    // needs that same scheduler when two store instances race in this process.
    let tail = Promise.resolve();
    const db: D1Database = {
      prepare: (sql) => raw.prepare(sql), exec: (sql) => raw.exec(sql),
      batch: (statements) => {
        const next = tail.then(() => raw.batch(statements));
        tail = next.then(() => {}, () => {});
        return next;
      },
    };
    store = new D1AccountsStore(db);
    replica = new D1AccountsStore(db);
    await (store as D1AccountsStore).initialize();
    await (replica as D1AccountsStore).initialize();
  } else {
    pg = new PGlite();
    await pg.exec(baseline);
    for (const file of ["045_hosted_canonical_identity.sql", "049_password_auth.sql"]) {
      await pg.exec(await Bun.file(new URL(`../../../../accounts/service/migrations/${file}`, import.meta.url)).text());
    }
    const db = pg;
    const client = { async queryObject<T>(sql: string, args: readonly unknown[] = []) {
      return { rows: (await db.query<T>(sql, [...args])).rows };
    } };
    store = new PostgresAccountsStore(client);
    replica = new PostgresAccountsStore(client);
  }
  return {
    store, replica, auth: store.passwordAuth!, peer: replica.passwordAuth!, d1, pg,
    async putIdentity(bucket: string, key: string, document: object) {
      if (pg) await pg.query("INSERT INTO accounts_v1.hosted_identity_records(bucket,key,document) VALUES($1,$2,$3::jsonb) ON CONFLICT(bucket,key) DO UPDATE SET document=excluded.document", [bucket,key,JSON.stringify(document)]);
      else if (d1) await d1.prepare("INSERT INTO takosumi_accounts_documents(bucket,key,document,updated_at) VALUES(?,?,?,0) ON CONFLICT(bucket,key) DO UPDATE SET document=excluded.document").bind(bucket,key,JSON.stringify(document)).run();
      else throw new Error("no direct identity fixture for memory facade");
    },
    async close() { await pg?.close(); },
  };
}

async function session(store: AccountsStore, subject = OWNER): Promise<PasswordWriteAuthorization> {
  const generation = await store.getAccountAuthenticationGeneration!(subject);
  const sessionId = `session-${subject}-${generation}`;
  await store.saveAccountSession({ sessionId, subject, identityGeneration: generation,
    createdAt: 1_000, expiresAt: 50_000 });
  return { sessionId, generation, now: 2_000, emailAdmission: { address: `${subject}@example.test`, requireVerified: true } };
}

for (const kind of ["memory", "d1", "postgres"] as const) {
  describe(`existing-account password persistence (${kind})`, () => {
    test("setting a password needs an existing account and exact live owner session; cannot create identities", async () => {
      const f = await fixture(kind);
      try {
        const auth = { sessionId: "missing", generation: 0, now: 2_000, emailAdmission: { address: account().email!, requireVerified: true } };
        expect(await f.auth.create(credential(), auth)).toBe(false);
        expect(await f.store.findAccount(OWNER)).toBeUndefined();
        await f.store.saveAccount(account());
        await f.store.saveAccount(account(OTHER));
        const other = await session(f.store, OTHER);
        expect(await f.auth.create(credential(), other)).toBe(false);
        const owner = await session(f.store);
        expect(await f.auth.create(credential(), { ...owner, now: 50_000 })).toBe(false);
        expect(await f.auth.create(credential(), { ...owner, generation: 1 })).toBe(false);
        await expect(f.auth.create(credential(), undefined as never)).rejects.toThrow("invalid password authorization");
        const claims = await Promise.all([f.auth.create(credential(), owner), f.peer.create(credential({ passwordHash: "competing" }), owner)]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(await f.auth.findBySubject(OWNER)).toEqual(credential({ passwordHash: claims[0] ? "fixture-password-verifier" : "competing" }));
        expect(await f.store.findAccount(OWNER)).toMatchObject(account());
        const copy = (await f.auth.findBySubject(OWNER))!;
        copy.passwordHash = "cannot-mutate-store";
        expect((await f.auth.findBySubject(OWNER))!.passwordHash).not.toBe(copy.passwordHash);
      } finally { await f.close(); }
    });

    test("distinct accounts cannot claim the same username concurrently", async () => {
      const f = await fixture(kind);
      try {
        await f.store.saveAccount(account());
        await f.store.saveAccount(account(OTHER));
        const owner = await session(f.store);
        const other = await session(f.store, OTHER);
        const first = credential();
        const second = credential({ subject: OTHER });
        const claims = await Promise.all([f.auth.create(first, owner), f.peer.create(second, other)]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(await f.peer.findByUsername(first.username)).toEqual(claims[0] ? first : second);
      } finally { await f.close(); }
    });

    test("CAS invalidates account sessions and OAuth, advances generation, preserves PAT and external identity", async () => {
      const f = await fixture(kind);
      try {
        await f.store.saveAccount(account());
        await f.store.saveAccount(account(OTHER));
        const auth = await session(f.store);
        const other = await session(f.store, OTHER);
        expect(await f.auth.create(credential(), auth)).toBe(true);
        for (const subject of [OWNER, OTHER]) {
          const token = { subject: `pairwise-${subject}`, takosumiSubject: subject,
            clientId: "fixture-client", scope: "openid", expiresAt: 50_000 };
          await f.store.saveAccessToken(`access-${subject}`, token);
          await f.store.saveRefreshToken(`refresh-${subject}`, token);
          await f.store.saveAuthorizationCode(`code-${subject}`, { ...token, redirectUri: "https://fixture.invalid/callback" });
        }
        await f.store.savePersonalAccessToken("fixture-pat", {
          tokenId: "pat-password-test", tokenPrefix: "takpat_fixture", subject: OWNER,
          name: "preserved", scopes: ["read"], createdAt: 1_000,
        });
        const identity = { providerId: "fixture", upstreamIssuer: "https://fixture.invalid",
          upstreamSubject: "external-owner", subject: OWNER, createdAt: 1_000, updatedAt: 1_000 };
        await f.store.linkUpstreamIdentity(identity);
        await f.store.saveHostedOidcGrant!({ sid: "grant-fixture", issuerSessionId: "issuer-session-fixture",
          clientId: "fixture-client", subject: OWNER, scope: "openid", issuer: "https://fixture.invalid",
          identityGeneration: 0, authTime: 1, createdAt: 1_000, absoluteExpiresAt: 50_000 });
        const next = credential({ version: 2, passwordHash: "replacement" });
        expect(await f.auth.replace(1, next, 2_000, auth)).toBe(true);
        expect(await f.peer.findBySubject(OWNER)).toEqual(next);
        expect(await f.store.getAccountAuthenticationGeneration!(OWNER)).toBe(1);
        expect(await f.store.findAccountSession(auth.sessionId)).toBeUndefined();
        expect(await f.store.findAccessToken(`access-${OWNER}`)).toBeUndefined();
        expect(await f.store.findRefreshToken(`refresh-${OWNER}`)).toBeUndefined();
        expect(await f.store.consumeAuthorizationCode(`code-${OWNER}`)).toBeUndefined();
        expect(await f.store.findAccountSession(other.sessionId)).toBeDefined();
        expect(await f.store.findRefreshToken(`refresh-${OTHER}`)).toBeDefined();
        expect(await f.store.findPersonalAccessToken("fixture-pat")).toMatchObject({ subject: OWNER });
        expect(await f.store.findUpstreamIdentity(identity)).toEqual(identity);
        expect(await f.store.findHostedOidcGrant!("grant-fixture")).toMatchObject({ revokedAt: 2_000 });
        const currentAuth = await session(f.store);
        expect(await f.peer.replace(1, next, 3_000, currentAuth)).toBe(false);
        expect(await f.store.findAccountSession(currentAuth.sessionId)).toBeDefined();
        expect(await f.auth.replace(2, { ...next, subject: OTHER, version: 3 }, 3_000, currentAuth)).toBe(false);
        await expect(f.auth.replace(2, { ...next, version: 4 }, 3_000, currentAuth)).rejects.toThrow("invalid password replacement");
        expect(await f.auth.replace(2, { ...next, version: 3 }, 3_000, currentAuth)).toBe(true);
        expect(await f.store.getAccountAuthenticationGeneration!(OWNER)).toBe(2);
      } finally { await f.close(); }
    });

    test("deleted, stale, expired and anchor-revoked sessions cannot authorize writes", async () => {
      const f = await fixture(kind);
      try {
        await f.store.saveAccount(account());
        const auth = await session(f.store);
        expect(await f.auth.create(credential(), auth)).toBe(true);
        const next = credential({ version: 2 });
        await f.store.deleteAccountSession(auth.sessionId);
        expect(await f.auth.replace(1, next, 2_000, auth)).toBe(false);
        for (const explicit of [true, false]) {
          const sessionId = `hosted-${explicit}`;
          const { hostedIssuerSessionId } = await import("../../../../accounts/service/src/hosted-oidc-profile.ts");
          const anchor = await hostedIssuerSessionId(explicit ? "stable-issuer-anchor" : sessionId);
          await f.store.saveAccountSession({ sessionId, subject: OWNER, createdAt: 1_000, expiresAt: 50_000,
            policy: "hosted", absoluteExpiresAt: 50_000, identityGeneration: 0, authTime: 1,
            ...(explicit ? { issuerSessionId: anchor } : {}) });
          await f.store.revokeHostedOidcSessionGrants!(anchor, 1_500);
          expect(await f.store.findAccountSession(sessionId)).toBeDefined();
          expect(await f.auth.replace(1, next, 2_000, { sessionId, generation: 0, now: 2_000, emailAdmission: { address: account().email!, requireVerified: true } })).toBe(false);
        }
        expect(await f.auth.findBySubject(OWNER)).toEqual(credential());
        const fresh = await session(f.store);
        const outcomes = await Promise.all([
          f.auth.replace(1, next, 2_000, fresh),
          f.peer.replace(1, { ...next, passwordHash: "competing" }, 2_000, fresh),
        ]);
        expect(outcomes.filter(Boolean)).toHaveLength(1);
        expect(await f.store.getAccountAuthenticationGeneration!(OWNER)).toBe(1);
        // An in-flight old session write never restores its prior generation.
        await f.store.saveAccountSession({ sessionId: auth.sessionId, subject: OWNER, createdAt: 1_000, expiresAt: 50_000 });
        expect(await f.auth.replace(2, credential({ version: 3 }), 3_000, auth)).toBe(false);
      } finally { await f.close(); }
    });

    test("configured email admission and recent-proof deadline are rechecked on each write", async () => {
      const f = await fixture(kind);
      try {
        await f.store.saveAccount(account());
        const auth = await session(f.store);
        expect(await f.auth.create(credential(), { ...auth, freshUntil: 1_999 })).toBe(false);
        await f.store.saveAccount({ ...account(), email: "changed@example.test" });
        expect(await f.auth.create(credential(), auth)).toBe(false);
        await f.store.saveAccount({ ...account(), emailVerified: false });
        expect(await f.auth.create(credential(), auth)).toBe(false);
        await f.store.saveAccount({ ...account(), email: `  ${account().email!.toUpperCase()}  ` });
        await f.store.saveAccount({ ...account(OTHER), email: account().email });
        expect(await f.auth.create(credential(), { ...auth, freshUntil: 2_000 })).toBe(true);
        const next = credential({ version: 2 });
        expect(await f.auth.replace(1, next, 2_000, { ...auth, freshUntil: 1_999 })).toBe(false);
        await f.store.saveAccount({ ...account(), email: "changed@example.test" });
        expect(await f.auth.replace(1, next, 2_000, auth)).toBe(false);
        await f.store.saveAccount({ ...account(), emailVerified: false });
        expect(await f.auth.replace(1, next, 2_000, auth)).toBe(false);
        expect(await f.auth.findBySubject(OWNER)).toEqual(credential());
        expect(await f.store.getAccountAuthenticationGeneration!(OWNER)).toBe(0);
        expect(await f.store.findAccountSession(auth.sessionId)).toBeDefined();
        // An operator may admit an unverified address. Current-password proof
        // has no recent-session deadline.
        const relaxed = { ...auth, emailAdmission: { address: account().email!, requireVerified: false } };
        expect(await f.auth.replace(1, next, 2_000, relaxed)).toBe(true);
      } finally { await f.close(); }
    });

    test("Hosted writes fail closed only on PostgreSQL; ordinary Node writes remain supported", async () => {
      const f = await fixture(kind);
      try {
        await f.store.saveAccount(account());
        const ordinary = await session(f.store);
        const hosted = { ...ordinary, sessionId: "hosted-password-write" };
        await f.store.saveAccountSession({ sessionId: hosted.sessionId, subject: OWNER,
          createdAt: 1_000, expiresAt: 50_000, policy: "hosted", absoluteExpiresAt: 50_000,
          identityGeneration: 0, authTime: 1 });
        expect(await f.auth.create(credential(), hosted)).toBe(kind !== "postgres");
        if (kind === "postgres") expect(await f.auth.create(credential(), ordinary)).toBe(true);
        expect(await f.auth.replace(1, credential({ version: 2 }), 2_000, hosted)).toBe(kind !== "postgres");
        if (kind === "postgres") {
          expect(await f.auth.findBySubject(OWNER)).toEqual(credential());
          expect(await f.store.getAccountAuthenticationGeneration!(OWNER)).toBe(0);
          expect(await f.auth.replace(1, credential({ version: 2 }), 2_000, ordinary)).toBe(true);
        }
      } finally { await f.close(); }
    });

    test("replicas share atomic attempt limits and bounded TTL cleanup", async () => {
      const f = await fixture(kind);
      try {
        const outcomes = await Promise.all(Array.from({ length: 12 }, (_, i) =>
          (i % 2 ? f.auth : f.peer).consumeAttempt("shared-key", 1_000, 3, 1_000)));
        expect(outcomes.filter(Boolean)).toHaveLength(3);
        expect(await f.peer.consumeAttempt("shared-key", 1_999, 3, 1_000)).toBe(false);
        expect(await f.peer.consumeAttempt("shared-key", 2_000, 3, 1_000)).toBe(true);
        for (let i = 0; i < 65; i++) expect(await f.auth.consumeAttempt(`expired-${i}`, 10_000, 1, 10)).toBe(true);
        expect(await f.auth.consumeAttempt("after-expiry", 10_010, 1, 10)).toBe(true);
        if (f.pg) expect((await f.pg.query<{ count: number }>("SELECT count(*)::integer AS count FROM accounts_v1.password_auth_attempts")).rows[0]!.count).toBeLessThanOrEqual(4);
        if (f.d1) expect((await f.d1.prepare("SELECT count(*) AS count FROM takosumi_accounts_documents WHERE bucket='password_auth_attempts'").first<{ count: number }>())!.count).toBeLessThanOrEqual(4);
        await expect(f.auth.consumeAttempt("", 0, 1, 1)).rejects.toThrow("invalid password attempt");
      } finally { await f.close(); }
    });
  });
}

for (const kind of ["d1", "postgres"] as const) {
  test(`${kind}: canonical and merge fences are checked in the mutation; active winner remains usable`, async () => {
    const f = await fixture(kind);
    try {
      await f.store.saveAccount(account());
      const auth = await session(f.store);
      await f.putIdentity("identity_merge_locks", OWNER, { operationId: "merge-fixture" });
      expect(await f.auth.create(credential(), auth)).toBe(false);
      await f.putIdentity("identity_merge_operations", "merge-fixture", { status: "active" });
      expect(await f.auth.create(credential(), auth)).toBe(true);
      await f.putIdentity("identity_merge_operations", "merge-fixture", { status: "quarantined" });
      expect(await f.auth.replace(1, credential({ version: 2 }), 2_000, auth)).toBe(false);
      await f.putIdentity("identity_merge_operations", "merge-fixture", { status: "active" });
      await f.putIdentity("canonical_accounts", OWNER, { canonicalSubject: OTHER });
      expect(await f.auth.replace(1, credential({ version: 2 }), 2_000, auth)).toBe(false);
      expect(await f.auth.findBySubject(OWNER)).toEqual(credential());
      expect(await f.store.getAccountAuthenticationGeneration!(OWNER)).toBe(0);
    } finally { await f.close(); }
  });

  test(`${kind}: enrolled Financial Source account refuses changes without altering its closure protocol`, async () => {
    const f = await fixture(kind);
    try {
      await f.store.saveAccount(account());
      const auth = await session(f.store);
      expect(await f.auth.create(credential(), auth)).toBe(true);
      await f.putIdentity("financial_source_parents", "generation-parent-fixture", {
        scope: { kind: "account-generation", subject: OWNER, identityGeneration: 0 }, closed: false,
      });
      expect(await f.auth.replace(1, credential({ version: 2 }), 2_000, auth)).toBe(false);
      expect(await f.auth.findBySubject(OWNER)).toEqual(credential());
      expect(await f.store.getAccountAuthenticationGeneration!(OWNER)).toBe(0);
      expect(await f.store.findAccountSession(auth.sessionId)).toBeDefined();
    } finally { await f.close(); }
  });

  test(`${kind}: revocation failure rolls back password CAS and authentication generation together`, async () => {
    const f = await fixture(kind);
    try {
      await f.store.saveAccount(account());
      const auth = await session(f.store);
      expect(await f.auth.create(credential(), auth)).toBe(true);
      if (f.pg) await f.pg.exec(`CREATE FUNCTION reject_password_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'fixture failure'; END; $$;
        CREATE TRIGGER reject_revocation BEFORE DELETE ON accounts_v1.account_sessions
        FOR EACH ROW EXECUTE FUNCTION reject_password_revocation();`);
      else await f.d1!.exec(`CREATE TRIGGER reject_revocation BEFORE DELETE ON takosumi_accounts_documents
        WHEN OLD.bucket='account_sessions' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`);
      await expect(f.auth.replace(1, credential({ version: 2 }), 2_000, auth)).rejects.toThrow();
      expect(await f.auth.findBySubject(OWNER)).toEqual(credential());
      expect(await f.store.getAccountAuthenticationGeneration!(OWNER)).toBe(0);
      expect(await f.store.findAccountSession(auth.sessionId)).toBeDefined();
    } finally { await f.close(); }
  });
}

test("PostgreSQL email updates without a verification claim clear prior verified lookup", async () => {
  const f = await fixture("postgres");
  try {
    await f.store.saveAccount(account());
    expect((await f.store.findAccountByVerifiedEmail(account().email!))?.subject).toBe(OWNER);
    const { emailVerified: _verified, ...withoutClaim } = account();
    await f.store.saveAccount({ ...withoutClaim, email: "different@example.test" });
    expect(await f.store.findAccountByVerifiedEmail(account().email!)).toBeUndefined();
    expect(await f.store.findAccountByVerifiedEmail("different@example.test")).toBeUndefined();
    await f.store.saveAccount(account());
    await f.store.saveAccount({ ...account(), emailVerified: undefined });
    expect(await f.store.findAccountByVerifiedEmail(account().email!)).toBeUndefined();
  } finally { await f.close(); }
});

test("durable constructors do not query password tables while the feature is unused", () => {
  const fail = () => { throw new Error("unexpected query"); };
  expect(new PostgresAccountsStore({ queryObject: fail }).passwordAuth).toBeDefined();
  expect(new D1AccountsStore({ prepare: fail, exec: fail, batch: fail }).passwordAuth).toBeDefined();
});

test("memory policy rejects aliases and Financial enrollment without breaking active merge targets", async () => {
  const records = new Map<string, unknown>();
  const accounts = new Map([[OWNER, account()]]);
  let revocations = 0;
  const auth = new MemoryPasswordAuthStore(accounts, () => { revocations++; }, () => true,
    (subject) => memoryPasswordSubjectActive(records, subject),
    (subject) => memoryPasswordRevocationAllowed(records, subject));
  const authorization = { sessionId: "synthetic-policy-test", generation: 0, now: 2_000, emailAdmission: { address: account().email!, requireVerified: true } };
  records.set(`identity_merge_locks\n${OWNER}`, { operationId: "merge" });
  expect(await auth.create(credential(), authorization)).toBe(false);
  records.set("identity_merge_operations\nmerge", { status: "active" });
  expect(await auth.create(credential(), authorization)).toBe(true);
  records.set(`canonical_accounts\n${OWNER}`, { canonicalSubject: OTHER });
  expect(await auth.replace(1, credential({ version: 2 }), 2_000, authorization)).toBe(false);
  records.delete(`canonical_accounts\n${OWNER}`);
  records.set("financial_source_parents\nparent", {
    scope: { kind: "account-generation", subject: OWNER, identityGeneration: 0 }, closed: false,
  });
  expect(await auth.replace(1, credential({ version: 2 }), 2_000, authorization)).toBe(false);
  expect(revocations).toBe(0);
  expect(await auth.findBySubject(OWNER)).toEqual(credential());
});

test("local workerd D1 executes authorized create/CAS and shared attempt transactions", async () => {
  const { Miniflare } = await import("miniflare");
  const native = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('fixture');}}",
    compatibilityDate: "2026-07-01", d1Databases: { ACCOUNTS: "password-persistence-fixture" } });
  try {
    const db = await native.getD1Database("ACCOUNTS") as unknown as D1Database;
    const store = new D1AccountsStore(db, { sessionHashSalt: "synthetic-password-test-salt" });
    const peer = new D1AccountsStore(db, { sessionHashSalt: "synthetic-password-test-salt" });
    await store.initialize(); await peer.initialize();
    await store.saveAccount(account());
    const auth = await session(store);
    expect(await store.passwordAuth.create(credential(), auth)).toBe(true);
    expect(await peer.passwordAuth.create(credential(), auth)).toBe(false);
    const next = credential({ version: 2 });
    expect(await peer.passwordAuth.replace(1, next, 2_000, auth)).toBe(true);
    expect(await store.passwordAuth.findBySubject(OWNER)).toEqual(next);
    expect(await store.findAccountSession(auth.sessionId)).toBeUndefined();
    expect(await store.getAccountAuthenticationGeneration(OWNER)).toBe(1);
    expect(await store.passwordAuth.consumeAttempt("native-attempt", 1_000, 1, 1_000)).toBe(true);
    expect(await peer.passwordAuth.consumeAttempt("native-attempt", 1_000, 1, 1_000)).toBe(false);
    expect(await peer.passwordAuth.consumeAttempt("native-attempt", 2_000, 1, 1_000)).toBe(true);
  } finally { await native.dispose(); }
}, 30_000);
