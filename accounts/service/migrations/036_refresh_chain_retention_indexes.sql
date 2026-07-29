-- Bounded refresh-chain retention walks each append-only security table in
-- (retention timestamp, primary key) order. These covering indexes keep the
-- cursor page bounded at the database read layer as well as at the returned
-- row/delete layer.

CREATE INDEX IF NOT EXISTS refresh_chain_links_retention_idx
  ON accounts_v1.refresh_chain_links(created_at, parent_token_hash);

CREATE INDEX IF NOT EXISTS refresh_chain_access_tokens_retention_idx
  ON accounts_v1.refresh_chain_access_tokens(
    created_at,
    root_token_hash,
    access_token_hash
  );

CREATE INDEX IF NOT EXISTS revoked_refresh_roots_retention_idx
  ON accounts_v1.revoked_refresh_roots(revoked_at, root_token_hash);

CREATE INDEX IF NOT EXISTS consumed_authorization_codes_retention_idx
  ON accounts_v1.consumed_authorization_codes(consumed_at, code_hash);

CREATE INDEX IF NOT EXISTS auth_code_token_links_retention_idx
  ON accounts_v1.auth_code_token_links(
    created_at,
    code_hash,
    access_token_hash,
    refresh_root_hash
  );
