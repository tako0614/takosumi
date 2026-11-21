import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { InMemoryAccountsStore, type AccountsStore } from "../../../../accounts/service/src/store.ts";
import { D1AccountsStore, type D1Database } from "../../../../accounts/service/src/d1-store.ts";
import { PostgresAccountsStore } from "../../../../accounts/service/src/postgres-store.ts";
import { connectionOAuthAttemptId, connectionOAuthAttemptPurpose, type ConnectionOAuthAttemptRecord } from "../../../../accounts/service/src/connection-oauth-attempt.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

// Existing Accounts identity expansion fixture; production migration bytes execute below.
const baselineSql = `CREATE SCHEMA accounts_v1;
CREATE TABLE accounts_v1.accounts(subject text PRIMARY KEY,email text,email_verified boolean,display_name text,picture text,terms_version text,terms_accepted_at timestamptz,terms_accepted_source text,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE TABLE accounts_v1.upstream_identities(provider_id text,upstream_issuer text,upstream_subject text,subject text REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(provider_id,upstream_issuer,upstream_subject));
CREATE TABLE accounts_v1.account_sessions(session_id text PRIMARY KEY,subject text REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.authorization_codes(code_hash text PRIMARY KEY,client_id text,redirect_uri text,scope text,subject text,takosumi_subject text REFERENCES accounts_v1.accounts(subject),capsule_id text,workspace_id text,role text,nonce text,code_challenge text,code_challenge_method text,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.oauth_access_tokens(token_hash text PRIMARY KEY,client_id text,audience text,scope text,subject text,takosumi_subject text REFERENCES accounts_v1.accounts(subject),capsule_id text,workspace_id text,role text,interface_id text,interface_binding_id text,interface_resolved_revision bigint,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.oauth_refresh_tokens(LIKE accounts_v1.oauth_access_tokens INCLUDING ALL);
CREATE TABLE accounts_v1.protected_references(id text PRIMARY KEY,subject text REFERENCES accounts_v1.accounts(subject),workspace_id text,org_id text,micro_usd bigint);`;

for (const kind of ["memory", "d1", "postgres"] as const) {
  test(`Connection OAuth attempt ${kind} atomically consumes only its purpose, binding and live row`, async () => {
    let pg: PGlite | undefined;
    let store: AccountsStore;
    try {
      if (kind === "memory") store = new InMemoryAccountsStore();
      else if (kind === "d1") store = new D1AccountsStore(new SqliteFakeD1() as unknown as D1Database);
      else {
        pg = new PGlite();
        await pg.exec(baselineSql);
        await pg.exec(await Bun.file(new URL("../../../../accounts/service/migrations/045_hosted_canonical_identity.sql", import.meta.url)).text());
        store = new PostgresAccountsStore({ queryObject: async <T>(sql: string, args: readonly unknown[] = []) => ({ rows: (await pg!.query(sql, [...args])).rows as T[] }) });
      }
      const subject = "tsub_oauth_store";
      await store.saveAccount({ subject, createdAt: 1, updatedAt: 1 });
      const stateDigest = await stableJsonDigest("synthetic signed state");
      const browserBindingHash = await stableJsonDigest("synthetic browser binding");
      const record: ConnectionOAuthAttemptRecord = {
        purpose: connectionOAuthAttemptPurpose, id: await connectionOAuthAttemptId("gcp", stateDigest), helperId: "gcp", stateDigest, browserBindingHash,
        subject, scope: "personal", createdAt: 100, expiresAt: 200,
      };
      expect(await store.createConnectionOAuthAttempt!({ ...record, purpose: "upstream-login" } as unknown as ConnectionOAuthAttemptRecord)).toBe(false);
      expect(await store.createConnectionOAuthAttempt!({ ...record, id: await stableJsonDigest("wrong key") })).toBe(false);
      expect(await store.createConnectionOAuthAttempt!(record)).toBe(true);
      expect(await store.createConnectionOAuthAttempt!(record)).toBe(false);
      expect(await store.consumeUpstreamLoginTransaction!(record.id, browserBindingHash, 101)).toBeUndefined();
      expect(await store.consumeAuthorizationCode(record.id)).toBeUndefined();
      expect(await store.consumeConnectionOAuthAttempt!(record.id, "wrong binding", 101)).toBeUndefined();
      const consumed = await Promise.all([
        store.consumeConnectionOAuthAttempt!(record.id, browserBindingHash, 101),
        store.consumeConnectionOAuthAttempt!(record.id, browserBindingHash, 101),
      ]);
      expect(consumed.filter(Boolean)).toEqual([record]);
      expect(await store.consumeConnectionOAuthAttempt!(record.id, browserBindingHash, 101)).toBeUndefined();
      const expiredDigest = await stableJsonDigest("expired synthetic state");
      const expired = { ...record, stateDigest: expiredDigest, id: await connectionOAuthAttemptId("gcp", expiredDigest) };
      expect(await store.createConnectionOAuthAttempt!(expired)).toBe(true);
      expect(await store.consumeConnectionOAuthAttempt!(expired.id, browserBindingHash, 200)).toBeUndefined();
      expect(await store.consumeConnectionOAuthAttempt!(expired.id, browserBindingHash, 201)).toBeUndefined();
    } finally {
      await pg?.close();
    }
  });
}
