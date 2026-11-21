import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import {
  assertPasswordAttempt, assertPasswordAuthorization, passwordCredential,
  passwordReplacement, PASSWORD_ATTEMPT_SWEEP_LIMIT,
  type PasswordAuthStore, type PasswordCredential, type PasswordWriteAuthorization,
} from "../password-store.ts";
import { hashSessionId } from "../session-hash-salt.ts";
import { runQuery, type PostgresQueryClient } from "./internal.ts";

const credentials = "accounts_v1.password_credentials";
const attempts = "accounts_v1.password_auth_attempts";
const identities = "accounts_v1.hosted_identity_records";
const columns = `subject,username,password_hash AS "passwordHash",version`;
const subjectFence = `NOT EXISTS(SELECT 1 FROM ${identities} WHERE bucket='canonical_accounts' AND key=$2)
  AND NOT EXISTS(SELECT 1 FROM ${identities} l WHERE l.bucket='identity_merge_locks' AND l.key=$2
    AND NOT EXISTS(SELECT 1 FROM ${identities} o WHERE o.bucket='identity_merge_operations'
      AND o.key=l.document->>'operationId' AND o.document->>'status'='active'))`;

export class PostgresPasswordAuthStore implements PasswordAuthStore {
  constructor(readonly client: PostgresQueryClient) {}

  private async authorization(subject: TakosumiSubject, authorization: PasswordWriteAuthorization, args: unknown[]): Promise<string> {
    assertPasswordAuthorization(authorization);
    const bind = (value: unknown) => { args.push(value); return `$${args.length}`; };
    const session = bind(await hashSessionId(authorization.sessionId));
    const owner = bind(subject), now = bind(authorization.now), generation = bind(authorization.generation);
    const email = bind(authorization.emailAdmission?.address ?? null);
    const requireVerified = bind(authorization.emailAdmission?.requireVerified ?? false);
    const freshUntil = bind(authorization.freshUntil ?? Number.MAX_SAFE_INTEGER);
    // Lock the authorizing row so a concurrent logout/reset cannot invalidate
    // it between the final check and this write. Competing reset deadlocks
    // abort one whole statement rather than accepting stale authorization.
    // Hosted writes require a Financial-enrollment serialization protocol that
    // this PostgreSQL adapter does not yet implement. Ordinary Node sessions
    // remain supported; never infer safety from an old NOT EXISTS snapshot.
    return `authorized AS MATERIALIZED(SELECT s.session_id FROM accounts_v1.account_sessions s
      JOIN accounts_v1.accounts a ON a.subject=s.subject
      WHERE s.session_id=${session} AND s.subject=${owner} AND s.expires_at>to_timestamp(${now}/1000.0)
      AND (${email}::text IS NULL OR (lower(btrim(a.email))=${email}
        AND (NOT ${requireVerified}::boolean OR a.email_verified IS TRUE)))
      AND ${freshUntil}::bigint>=${now}
      AND (s.hosted_metadata->>'absoluteExpiresAt' IS NULL OR (s.hosted_metadata->>'absoluteExpiresAt')::bigint>${now})
      AND COALESCE((s.hosted_metadata->>'identityGeneration')::bigint,0)=${generation}
      AND COALESCE(s.hosted_metadata->>'policy','')<>'hosted'
      AND COALESCE((SELECT (document->>'generation')::bigint FROM ${identities} WHERE bucket='authentication_generations' AND key=${owner}),0)=${generation}
      AND NOT EXISTS(SELECT 1 FROM ${identities} WHERE bucket='canonical_accounts' AND key=${owner})
      AND NOT EXISTS(SELECT 1 FROM ${identities} l WHERE l.bucket='identity_merge_locks' AND l.key=${owner}
        AND NOT EXISTS(SELECT 1 FROM ${identities} o WHERE o.bucket='identity_merge_operations'
          AND o.key=l.document->>'operationId' AND o.document->>'status'='active')) FOR UPDATE OF s,a)`;
  }

  async findByUsername(username: string): Promise<PasswordCredential | undefined> {
    const record = (await runQuery<PasswordCredential>(this.client,
      `SELECT ${columns} FROM ${credentials} WHERE username=$1`, [username])).rows[0];
    return record ? passwordCredential({ ...record, version: Number(record.version) }) : undefined;
  }

  async findBySubject(subject: TakosumiSubject): Promise<PasswordCredential | undefined> {
    const record = (await runQuery<PasswordCredential>(this.client,
      `SELECT ${columns} FROM ${credentials} WHERE subject=$1`, [subject])).rows[0];
    return record ? passwordCredential({ ...record, version: Number(record.version) }) : undefined;
  }

  async create(credential: PasswordCredential, authorization: PasswordWriteAuthorization): Promise<boolean> {
    const next = passwordCredential(credential);
    if (next.version !== 1) return false;
    const args: unknown[] = [next.passwordHash, next.subject, next.version, next.username];
    const auth = await this.authorization(next.subject, authorization, args);
    try {
      return (await runQuery(this.client, `WITH ${auth} INSERT INTO ${credentials}
        (subject,password_hash,version,username) SELECT $2,$1,$3,$4
        WHERE EXISTS(SELECT 1 FROM accounts_v1.accounts WHERE subject=$2)
        AND EXISTS(SELECT 1 FROM authorized) AND ${subjectFence}
        ON CONFLICT DO NOTHING RETURNING subject`, args)).rows.length === 1;
    } catch (error) {
      if ((error as { code?: string }).code === "40P01") return false;
      throw error;
    }
  }

  async replace(expectedVersion: number, credential: PasswordCredential, now: number, authorization: PasswordWriteAuthorization): Promise<boolean> {
    const next = passwordReplacement(expectedVersion, credential, now);
    const args: unknown[] = [next.passwordHash, next.subject, next.version, expectedVersion, now, next.username];
    const auth = await this.authorization(next.subject, authorization, args);
    const revokeTables = ["account_sessions", "authorization_codes", "oauth_access_tokens", "oauth_refresh_tokens"];
    const revocations = revokeTables.map((table, index) => `revoked${index} AS (
      DELETE FROM accounts_v1.${table} WHERE (subject=$2${table === "account_sessions" ? "" : " OR takosumi_subject=$2"})
      AND EXISTS(SELECT 1 FROM changed) RETURNING subject)`);
    try {
      const result = await runQuery(this.client, `WITH ${auth},
      observed_generation AS MATERIALIZED(SELECT COALESCE((SELECT (document->>'generation')::bigint FROM ${identities}
        WHERE bucket='authentication_generations' AND key=$2),0) AS generation),
      changed AS (
      UPDATE ${credentials} SET password_hash=$1,version=$3
      WHERE subject=$2 AND version=$4 AND username=$6 AND ${subjectFence}
      AND NOT EXISTS(SELECT 1 FROM ${identities} WHERE bucket='financial_source_parents'
        AND document->'scope'->>'kind'='account-generation' AND document->'scope'->>'subject'=$2)
      AND EXISTS(SELECT 1 FROM authorized) RETURNING subject),
      generation AS (INSERT INTO ${identities} AS old(bucket,key,document,subject)
        SELECT 'authentication_generations',subject,jsonb_build_object('subject',subject,'generation',g.generation+1),subject
        FROM changed CROSS JOIN observed_generation g
        ON CONFLICT(bucket,key) DO UPDATE SET document=jsonb_set(old.document,'{generation}',to_jsonb((old.document->>'generation')::bigint+1))
        WHERE (old.document->>'generation')::bigint=(SELECT generation FROM observed_generation) RETURNING key),
      ${revocations.join(",")},
      grants AS (UPDATE ${identities} SET document=jsonb_set(document,'{revokedAt}',to_jsonb($5::bigint))
        WHERE bucket='hosted_oidc_grants' AND document->>'subject'=$2 AND EXISTS(SELECT 1 FROM changed) RETURNING key)
      SELECT subject FROM changed WHERE 1/(SELECT count(*)::integer FROM generation)=1`,
      args);
      return result.rows.length === 1;
    } catch (error) {
      if (["40P01", "22012"].includes((error as { code?: string }).code ?? "")) return false;
      throw error;
    }
  }

  async consumeAttempt(key: string, now: number, limit: number, windowMs: number): Promise<boolean> {
    assertPasswordAttempt(key, now, limit, windowMs);
    // Exclude the requested key from the sweep so this statement never both
    // deletes and updates the same tuple. Expired requested keys reset in place.
    const result = await runQuery(this.client, `WITH swept AS (DELETE FROM ${attempts}
      WHERE key IN (SELECT key FROM ${attempts} WHERE expires_at<=$2 AND key<>$1 ORDER BY expires_at,key LIMIT $5))
      INSERT INTO ${attempts} AS old(key,count,expires_at) VALUES($1,1,$4)
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN old.expires_at<=$2 THEN 1 ELSE old.count+1 END,
      expires_at=CASE WHEN old.expires_at<=$2 THEN excluded.expires_at ELSE old.expires_at END
      WHERE old.expires_at<=$2 OR old.count<$3 RETURNING key`,
    [key, now, limit, now + windowMs, PASSWORD_ATTEMPT_SWEEP_LIMIT]);
    return result.rows.length === 1;
  }
}
