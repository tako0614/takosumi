import type {
  AccountSessionRecord,
  AccountsBearerCredentialCandidates,
  PersonalAccessTokenRecord,
  TakosumiAccountRecord,
  TokenRecord,
} from "../store.ts";
import { hashSessionId } from "../session-hash-salt.ts";
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
  const result = await runQuery<BearerCandidateRow>(
    client,
    `with
      presented_session as (
        select session_id, subject, created_at, expires_at
        from accounts_v1.account_sessions
        where session_id = $1
      ),
      presented_access_token as (
        select client_id, audience, scope, subject, takosumi_subject,
          capsule_id, workspace_id, role, interface_id, interface_binding_id,
          interface_resolved_revision, expires_at
        from accounts_v1.oauth_access_tokens
        where token_hash = $2
      ),
      presented_pat as (
        select token_id, token_prefix, subject, name, scopes, workspace_id,
          created_at, expires_at, revoked_at, last_used_at
        from accounts_v1.personal_access_tokens
        where token_hash = $2
      )
    select 'session' as kind, to_jsonb(presented_session) as document
    from presented_session
    union all
    select 'session_account' as kind, to_jsonb(account_row) as document
    from presented_session
    join accounts_v1.accounts as account_row
      on account_row.subject = presented_session.subject
    union all
    select 'access_token' as kind, to_jsonb(presented_access_token) as document
    from presented_access_token
    union all
    select 'pat' as kind, to_jsonb(presented_pat) as document
    from presented_pat`,
    [sessionHash, tokenHash],
  );

  let session: AccountSessionRecord | undefined;
  let sessionAccount: TakosumiAccountRecord | undefined;
  let accessToken: TokenRecord | undefined;
  let personalAccessToken: PersonalAccessTokenRecord | undefined;
  for (const row of result.rows) {
    if (row.kind === "session") {
      if (session) throw duplicateBearerCandidate(row.kind);
      session = {
        ...accountSessionFromRow(objectJson<AccountSessionRow>(row.document)),
        sessionId: token,
      };
    } else if (row.kind === "session_account") {
      if (sessionAccount) throw duplicateBearerCandidate(row.kind);
      sessionAccount = accountFromRow(objectJson<AccountRow>(row.document));
    } else if (row.kind === "access_token") {
      if (accessToken) throw duplicateBearerCandidate(row.kind);
      accessToken = tokenFromRow(objectJson<TokenRow>(row.document));
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
    ...(accessToken ? { accessToken } : {}),
    ...(personalAccessToken ? { personalAccessToken } : {}),
  };
}

function duplicateBearerCandidate(kind: BearerCandidateKind): Error {
  return new Error(
    `Postgres Accounts bearer candidate lookup returned duplicate ${kind}`,
  );
}
