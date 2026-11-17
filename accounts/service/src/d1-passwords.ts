import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { D1Database } from "./d1-store.ts";
import { hostedIssuerSessionId } from "./hosted-oidc-profile.ts";
import {
  assertPasswordAttempt, assertPasswordAuthorization, passwordCredential,
  passwordReplacement, PASSWORD_ATTEMPT_SWEEP_LIMIT,
  type PasswordAuthStore, type PasswordCredential, type PasswordWriteAuthorization,
} from "./password-store.ts";

const documents = "takosumi_accounts_documents";
const indexes = "takosumi_accounts_indexes";
const credentials = "password_credentials";
const attempts = "password_auth_attempts";
const expiryIndex = "password_auth_attempts_expiry";

/** All multi-row decisions use one D1 batch transaction; no request-time DDL. */
export class D1PasswordAuthStore implements PasswordAuthStore {
  constructor(readonly db: D1Database, readonly initialize: () => Promise<void>, readonly hashSessionId: (value: string) => Promise<string>) {}

  private async authorization(subject: TakosumiSubject, authorization: PasswordWriteAuthorization): Promise<{ sql: string; args: (string | number)[] }> {
    assertPasswordAuthorization(authorization);
    const fence = `NOT EXISTS(SELECT 1 FROM ${documents} WHERE bucket='canonical_accounts' AND key=?)
      AND NOT EXISTS(SELECT 1 FROM ${documents} l WHERE l.bucket='identity_merge_locks' AND l.key=?
        AND NOT EXISTS(SELECT 1 FROM ${documents} o WHERE o.bucket='identity_merge_operations'
          AND o.key=json_extract(l.document,'$.operationId') AND json_extract(o.document,'$.status')='active'))`;
    const sessionHash = await this.hashSessionId(authorization.sessionId);
    const fallbackAnchor = await hostedIssuerSessionId(authorization.sessionId);
    return {
      sql: `EXISTS(SELECT 1 FROM ${documents} s WHERE s.bucket='account_sessions' AND s.key=?
        AND json_extract(s.document,'$.subject')=? AND json_extract(s.document,'$.expiresAt')>?
        AND (json_type(s.document,'$.absoluteExpiresAt') IS NULL OR json_extract(s.document,'$.absoluteExpiresAt')>?)
        AND COALESCE(json_extract(s.document,'$.identityGeneration'),0)=?
        AND (COALESCE(json_extract(s.document,'$.policy'),'')<>'hosted' OR
          (json_extract(s.document,'$.absoluteExpiresAt')>? AND NOT EXISTS(SELECT 1 FROM ${documents} r
            WHERE r.bucket='hosted_oidc_revoked_sessions' AND r.key=COALESCE(json_extract(s.document,'$.issuerSessionId'),?))))
        AND COALESCE((SELECT json_extract(g.document,'$.generation') FROM ${documents} g WHERE g.bucket='authentication_generations' AND g.key=?),0)=?)
        AND ${fence}
        AND EXISTS(SELECT 1 FROM ${documents} a WHERE a.bucket='accounts' AND a.key=?
          AND json_extract(a.document,'$.emailVerified')=1 AND lower(trim(json_extract(a.document,'$.email')))=?)
        AND NOT EXISTS(SELECT 1 FROM ${indexes} e WHERE e.index_name='accounts_by_verified_email'
          AND e.index_key=? AND e.bucket='accounts' AND e.document_key<>?)
        AND ?>=?`,
      args: [sessionHash, subject, authorization.now, authorization.now, authorization.generation,
        authorization.now, fallbackAnchor, subject, authorization.generation, subject, subject,
        subject, authorization.verifiedEmail, authorization.verifiedEmail, subject,
        authorization.freshUntil ?? Number.MAX_SAFE_INTEGER, authorization.now],
    };
  }

  async findBySubject(subject: TakosumiSubject): Promise<PasswordCredential | undefined> {
    await this.initialize();
    const row = await this.db.prepare(`SELECT document FROM ${documents} WHERE bucket=? AND key=?`)
      .bind(credentials, subject).first<{ document: string }>();
    return row ? passwordCredential(JSON.parse(row.document)) : undefined;
  }

  async create(credential: PasswordCredential, authorization: PasswordWriteAuthorization): Promise<boolean> {
    const next = passwordCredential(credential);
    if (next.version !== 1) return false;
    const auth = await this.authorization(next.subject, authorization);
    await this.initialize();
    const result = await this.db.prepare(`INSERT INTO ${documents}(bucket,key,document,updated_at)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM ${documents} WHERE bucket='accounts' AND key=?)
      AND ${auth.sql} ON CONFLICT(bucket,key) DO NOTHING`)
      .bind(credentials, next.subject, JSON.stringify(next), authorization.now, next.subject, ...auth.args).run();
    return result.meta?.changes === 1;
  }

  async replace(expectedVersion: number, credential: PasswordCredential, now: number, authorization: PasswordWriteAuthorization): Promise<boolean> {
    const next = passwordReplacement(expectedVersion, credential, now);
    const auth = await this.authorization(next.subject, authorization);
    await this.initialize();
    const mutation = crypto.randomUUID();
    const guard = `EXISTS(SELECT 1 FROM ${documents} WHERE bucket='${credentials}' AND key=? AND json_extract(document,'$.mutation')=?)`;
    const args = [next.subject, mutation];
    const revoked = `bucket IN ('account_sessions','authorization_codes','access_tokens','refresh_tokens')
      AND (json_extract(document,'$.subject')=? OR json_extract(document,'$.takosumiSubject')=?)`;
    const result = await this.db.batch<{ key: string }>([
      this.db.prepare(`UPDATE ${documents} SET document=?,updated_at=? WHERE bucket=? AND key=?
        AND json_extract(document,'$.subject')=? AND json_extract(document,'$.version')=?
        AND EXISTS(SELECT 1 FROM ${documents} WHERE bucket='accounts' AND key=?)
        AND NOT EXISTS(SELECT 1 FROM ${documents} WHERE bucket='financial_source_parents'
          AND json_extract(document,'$.scope.kind')='account-generation' AND json_extract(document,'$.scope.subject')=?)
        AND ${auth.sql} RETURNING key`)
        .bind(JSON.stringify({ ...next, mutation }), now, credentials, next.subject, next.subject, expectedVersion, next.subject, next.subject, ...auth.args),
      this.db.prepare(`INSERT INTO ${documents}(bucket,key,document,updated_at)
        SELECT 'authentication_generations',?,?,? WHERE ${guard}
        ON CONFLICT(bucket,key) DO UPDATE SET document=json_set(document,'$.generation',json_extract(document,'$.generation')+1),updated_at=excluded.updated_at`)
        .bind(next.subject, JSON.stringify({ subject: next.subject, generation: 1 }), now, ...args),
      this.db.prepare(`DELETE FROM ${indexes} WHERE (bucket,document_key) IN
        (SELECT bucket,key FROM ${documents} WHERE ${revoked}) AND ${guard}`)
        .bind(next.subject, next.subject, ...args),
      this.db.prepare(`DELETE FROM ${documents} WHERE ${revoked} AND ${guard}`)
        .bind(next.subject, next.subject, ...args),
      this.db.prepare(`UPDATE ${documents} SET document=json_set(document,'$.revokedAt',?),updated_at=?
        WHERE bucket='hosted_oidc_grants' AND json_extract(document,'$.subject')=? AND ${guard}`)
        .bind(now, now, next.subject, ...args),
    ]);
    return result[0]?.meta?.changes === 1;
  }

  async consumeAttempt(key: string, now: number, limit: number, windowMs: number): Promise<boolean> {
    assertPasswordAttempt(key, now, limit, windowMs);
    await this.initialize();
    const expired = `SELECT document_key FROM ${indexes} WHERE index_name=? AND index_key='' AND sort_key<=? ORDER BY sort_key,document_key LIMIT ?`;
    const result = await this.db.batch<{ key: string }>([
      this.db.prepare(`DELETE FROM ${documents} WHERE bucket=? AND key IN (${expired}) AND updated_at<=?`)
        .bind(attempts, expiryIndex, now, PASSWORD_ATTEMPT_SWEEP_LIMIT, now),
      this.db.prepare(`DELETE FROM ${indexes} WHERE index_name=? AND index_key='' AND document_key IN (${expired})`)
        .bind(expiryIndex, expiryIndex, now, PASSWORD_ATTEMPT_SWEEP_LIMIT),
      this.db.prepare(`INSERT INTO ${documents}(bucket,key,document,updated_at) VALUES(?,?,json_object('count',1),?)
        ON CONFLICT(bucket,key) DO UPDATE SET document=json_object('count',CASE WHEN updated_at<=? THEN 1 ELSE json_extract(document,'$.count')+1 END),
        updated_at=CASE WHEN updated_at<=? THEN excluded.updated_at ELSE updated_at END
        WHERE updated_at<=? OR json_extract(document,'$.count')<? RETURNING key`)
        .bind(attempts, key, now + windowMs, now, now, now, limit),
      this.db.prepare(`INSERT INTO ${indexes}(index_name,index_key,bucket,document_key,sort_key)
        SELECT ?,'',bucket,key,updated_at FROM ${documents} WHERE bucket=? AND key=?
        ON CONFLICT(index_name,index_key,bucket,document_key) DO UPDATE SET sort_key=excluded.sort_key`)
        .bind(expiryIndex, attempts, key),
    ]);
    return result[2]?.meta?.changes === 1;
  }
}
