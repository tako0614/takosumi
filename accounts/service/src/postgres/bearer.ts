import type {
  AccountSessionRecord,
  AccountsBearerCredentialCandidates,
  PersonalAccessTokenRecord,
  TakosumiAccountRecord,
  TokenRecord,
} from "../store.ts";
import { hashSessionId } from "../session-hash-salt.ts";
import { isPreGenerationPostgresSchema } from "../account-authentication-generation.ts";
import {
  accountFromRow,
  type AccountRow,
  accountSessionFromRow,
  type AccountSessionRow,
  hashSecret,
  objectJson,
  personalAccessTokenFromRow,
  type PersonalAccessTokenRow,
  type PostgresQueryClient,
  runQuery,
  tokenFromRow,
  type TokenRow,
} from "./internal.ts";

type BearerCandidateKind =
  | "session"
  | "session_account"
  | "access_token"
  | "pat";

interface BearerCandidateRow {
  readonly kind: BearerCandidateKind;
  readonly document: unknown;
  readonly authentication_generation?: number | string;
}

/**
 * Resolve every credential kind matching one opaque bearer in one exact,
 * bounded statement. This mirrors the D1 resolver: the service layer still
 * applies expiry, scope, account-existence, and collision policy.
 */
export async function resolveAccountsBearerCandidates(
  client: PostgresQueryClient,
  token: string,
): Promise<AccountsBearerCredentialCandidates> {
  const [sessionHash, tokenHash] = await Promise.all([
    hashSessionId(token),
    hashSecret(token),
  ]);
  const resolve = (projectGeneration: boolean) => runQuery<BearerCandidateRow>(
    client,
    `with
      presented_session as (
        select session_id, subject, created_at, expires_at,
          to_jsonb(account_sessions)->'hosted_metadata' AS hosted_metadata
        from accounts_v1.account_sessions
        where session_id = $1
      ),
      presented_access_token as (
        select client_id, audience, scope, subject, takosumi_subject,
          capsule_id, workspace_id, role, interface_id, interface_binding_id,
          interface_resolved_revision, expires_at,
          to_jsonb(oauth_access_tokens)->'hosted_metadata' AS hosted_metadata
        from accounts_v1.oauth_access_tokens
        where token_hash = $2
      ),
      presented_pat as (
        select token_id, token_prefix, subject, name, scopes, workspace_id, app_ids,
          created_at, expires_at, revoked_at, last_used_at
        from accounts_v1.personal_access_tokens
        where token_hash = $2
      )
    select 'session' as kind, to_jsonb(presented_session) as document,
      ${generationProjection(projectGeneration, "presented_session.subject")} as authentication_generation
    from presented_session
    union all
    select 'session_account' as kind, to_jsonb(account_row) as document, 0
    from presented_session
    join accounts_v1.accounts as account_row
      on account_row.subject = presented_session.subject
    union all
    select 'access_token' as kind, to_jsonb(presented_access_token) as document,
      ${generationProjection(projectGeneration, "presented_access_token.takosumi_subject")}
    from presented_access_token
    union all
    select 'pat' as kind, to_jsonb(presented_pat) as document, 0
    from presented_pat`,
    [sessionHash, tokenHash],
  );
  // Keep the protected pre-045 self-host schema usable. Never cache the
  // missing relation across requests because it can be introduced by migration.
  const result = await resolve(true).catch((error) => {
    if (!isPreGenerationPostgresSchema(error)) throw error;
    return resolve(false);
  });

  let session: AccountSessionRecord | undefined;
  let sessionAccount: TakosumiAccountRecord | undefined;
  let sessionAuthenticationGeneration: number | undefined;
  let accessToken: TokenRecord | undefined;
  let accessAuthenticationGeneration: number | undefined;
  let personalAccessToken: PersonalAccessTokenRecord | undefined;
  for (const row of result.rows) {
    if (row.kind === "session") {
      if (session) throw duplicateBearerCandidate(row.kind);
      session = {
        ...accountSessionFromRow(objectJson<AccountSessionRow>(row.document)),
        sessionId: token,
      };
      sessionAuthenticationGeneration = Number(row.authentication_generation ?? 0);
    } else if (row.kind === "session_account") {
      if (sessionAccount) throw duplicateBearerCandidate(row.kind);
      sessionAccount = accountFromRow(objectJson<AccountRow>(row.document));
    } else if (row.kind === "access_token") {
      if (accessToken) throw duplicateBearerCandidate(row.kind);
      accessToken = tokenFromRow(objectJson<TokenRow>(row.document));
      accessAuthenticationGeneration = Number(row.authentication_generation ?? 0);
    } else if (row.kind === "pat") {
      if (personalAccessToken) throw duplicateBearerCandidate(row.kind);
      personalAccessToken = personalAccessTokenFromRow(
        objectJson<PersonalAccessTokenRow>(row.document),
      );
    } else {
      throw new Error(
        "Postgres Accounts bearer candidate lookup returned an unknown kind",
      );
    }
  }
  return {
    ...(session ? { session } : {}),
    ...(sessionAccount ? { sessionAccount } : {}),
    ...(sessionAuthenticationGeneration !== undefined ? { sessionAuthenticationGeneration } : {}),
    ...(accessToken ? { accessToken } : {}),
    ...(accessAuthenticationGeneration !== undefined ? { accessAuthenticationGeneration } : {}),
    ...(personalAccessToken ? { personalAccessToken } : {}),
  };
}

function generationProjection(enabled: boolean, subjectColumn: "presented_session.subject" | "presented_access_token.takosumi_subject"): string {
  return enabled ? `coalesce((select (document->>'generation')::bigint from accounts_v1.hosted_identity_records
    where bucket='authentication_generations' and key=${subjectColumn}),0)` : "0";
}

function duplicateBearerCandidate(kind: BearerCandidateKind): Error {
  return new Error(
    `Postgres Accounts bearer candidate lookup returned duplicate ${kind}`,
  );
}
