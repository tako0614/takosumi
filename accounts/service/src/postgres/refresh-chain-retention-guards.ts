import {
  MAX_REFRESH_CHAIN_RETENTION_DEPENDENCIES,
  type RefreshChainRetentionPhase,
} from "../refresh-chain-retention.ts";

const PROBE_LIMIT = MAX_REFRESH_CHAIN_RETENTION_DEPENDENCIES + 1;

// Closed table/key expressions only. $2 is the page's bound evaluation time.
function liveToken(table: string, key: string): string {
  return `EXISTS (SELECT 1 FROM accounts_v1.${table} AS token
    WHERE token.token_hash = ${key} AND (token.expires_at IS NULL OR token.expires_at > $2))`;
}

function liveCode(code: string): string {
  return `EXISTS (SELECT 1 FROM accounts_v1.authorization_codes AS code
    WHERE code.code_hash = ${code} AND (code.expires_at IS NULL OR code.expires_at > $2))`;
}

function liveRoot(root: string): string {
  const refresh = `SELECT parent_token_hash, child_token_hash FROM accounts_v1.refresh_chain_links
    WHERE root_token_hash = ${root} LIMIT ${PROBE_LIMIT}`;
  const access = `SELECT access_token_hash FROM accounts_v1.refresh_chain_access_tokens
    WHERE root_token_hash = ${root} LIMIT ${PROBE_LIMIT}`;
  return `(${liveToken("oauth_refresh_tokens", root)}
    OR (SELECT COUNT(*) FROM (${refresh}) AS bounded_refresh) > ${MAX_REFRESH_CHAIN_RETENTION_DEPENDENCIES}
    OR (SELECT COUNT(*) FROM (${access}) AS bounded_access) > ${MAX_REFRESH_CHAIN_RETENTION_DEPENDENCIES}
    OR EXISTS (SELECT 1 FROM (${refresh}) AS family_link
      WHERE ${liveToken("oauth_refresh_tokens", "family_link.parent_token_hash")}
         OR ${liveToken("oauth_refresh_tokens", "family_link.child_token_hash")})
    OR EXISTS (SELECT 1 FROM (${access}) AS family_link
      WHERE ${liveToken("oauth_access_tokens", "family_link.access_token_hash")})
  )`;
}

function liveCodeLink(alias: string): string {
  return `(${liveCode(`${alias}.code_hash`)}
    OR ${liveToken("oauth_access_tokens", `${alias}.access_token_hash`)}
    OR ${liveRoot(`${alias}.refresh_root_hash`)})`;
}

function liveConsumedCode(code: string): string {
  const links = `SELECT code_hash, access_token_hash, refresh_root_hash
    FROM accounts_v1.auth_code_token_links WHERE code_hash = ${code} LIMIT ${PROBE_LIMIT}`;
  return `(${liveCode(code)}
    OR (SELECT COUNT(*) FROM (${links}) AS bounded_issued) > ${MAX_REFRESH_CHAIN_RETENTION_DEPENDENCIES}
    OR EXISTS (SELECT 1 FROM (${links}) AS code_link WHERE ${liveCodeLink("code_link")})
  )`;
}

export function postgresRefreshRetentionLiveDependencySql(
  phase: RefreshChainRetentionPhase,
): string {
  if (phase === "chain_links") {
    return `(${liveToken("oauth_refresh_tokens", "candidate.parent_token_hash")}
      OR ${liveToken("oauth_refresh_tokens", "candidate.child_token_hash")})`;
  }
  if (phase === "chain_access_tokens") {
    return liveToken("oauth_access_tokens", "candidate.access_token_hash");
  }
  if (phase === "revoked_roots") return liveRoot("candidate.root_token_hash");
  if (phase === "consumed_codes") return liveConsumedCode("candidate.code_hash");
  return liveCodeLink("candidate");
}
