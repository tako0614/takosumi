-- F30 fix (refresh token chain persistence): persist OIDC refresh-token
-- rotation chains, authorization-code consumption markers, and the
-- mapping from authorization codes to the tokens issued from them.
--
-- Background: the OIDC token endpoint must detect refresh-token reuse
-- (RFC 6749 §10.4 / OAuth 2.1 §4.3.1) and authorization-code reuse
-- (OAuth 2.1 §4.1.4). The reference handler previously tracked these in
-- in-process Maps, which (a) breaks under multi-replica operator
-- distributions because each replica observes a different reuse state,
-- and (b) loses state across restarts so a rotated-out token regains
-- legitimacy after a deploy. This migration stores the chain links,
-- consumption markers, and code->token mappings in Postgres so the
-- reuse-detection guards hold across replicas and restarts.
--
-- The tables hash the token / code values (sha256:base64url) before
-- persisting so a read-only database leak does not yield raw tokens or
-- codes. This is symmetric to accounts_v1.oauth_access_tokens,
-- accounts_v1.oauth_refresh_tokens, and
-- accounts_v1.authorization_codes which already store hashed values.
--
-- Cleanup of stale rows: rows here are NOT deleted by the lifecycle paths
-- (the only chain deletes are the security-driven cascade-revoke on reuse
-- detection), so without retention they grow forever. The store layer now
-- exposes AccountsStore.pruneRefreshChain({ chainBefore, consumedCodeBefore })
-- (Postgres, D1, and in-memory) to delete rows past the refresh-token
-- lifetime (default 30 days; refresh_chain_links / refresh_chain_access_tokens
-- / revoked_refresh_roots) and past the authorization-code lifetime (default
-- 5 minutes; consumed_authorization_codes / auth_code_token_links).
--
-- OPERATOR CLEANUP TASK: run pruneRefreshChain on a schedule alongside
-- pruneLaunchTokens (e.g. the same periodic job), passing chainBefore =
-- now - refresh_token_ttl and consumedCodeBefore = now - auth_code_ttl. The
-- method is retention-only and never removes a row whose token/code is still
-- within its lifetime, so reuse detection is unaffected.

CREATE TABLE IF NOT EXISTS accounts_v1.refresh_chain_links (
  parent_token_hash text PRIMARY KEY CHECK (parent_token_hash LIKE 'sha256:%'),
  child_token_hash text NOT NULL CHECK (child_token_hash LIKE 'sha256:%'),
  root_token_hash text NOT NULL CHECK (root_token_hash LIKE 'sha256:%'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refresh_chain_links_child_idx
  ON accounts_v1.refresh_chain_links(child_token_hash);

CREATE INDEX IF NOT EXISTS refresh_chain_links_root_idx
  ON accounts_v1.refresh_chain_links(root_token_hash);

CREATE TABLE IF NOT EXISTS accounts_v1.revoked_refresh_roots (
  root_token_hash text PRIMARY KEY CHECK (root_token_hash LIKE 'sha256:%'),
  revoked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts_v1.consumed_authorization_codes (
  code_hash text PRIMARY KEY CHECK (code_hash LIKE 'sha256:%'),
  consumed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts_v1.auth_code_token_links (
  code_hash text NOT NULL CHECK (code_hash LIKE 'sha256:%'),
  access_token_hash text CHECK (access_token_hash IS NULL OR access_token_hash LIKE 'sha256:%'),
  refresh_root_hash text CHECK (refresh_root_hash IS NULL OR refresh_root_hash LIKE 'sha256:%'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code_hash, access_token_hash, refresh_root_hash)
);

CREATE INDEX IF NOT EXISTS auth_code_token_links_code_idx
  ON accounts_v1.auth_code_token_links(code_hash);

-- Track every access token minted from each refresh chain. The
-- cascade-revoke path walks this index and deletes the access tokens
-- so that a refresh-token replay attack also invalidates outstanding
-- access tokens minted during chain rotations (not just the refresh
-- tokens themselves).
CREATE TABLE IF NOT EXISTS accounts_v1.refresh_chain_access_tokens (
  root_token_hash text NOT NULL CHECK (root_token_hash LIKE 'sha256:%'),
  access_token_hash text NOT NULL CHECK (access_token_hash LIKE 'sha256:%'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (root_token_hash, access_token_hash)
);

CREATE INDEX IF NOT EXISTS refresh_chain_access_tokens_root_idx
  ON accounts_v1.refresh_chain_access_tokens(root_token_hash);
