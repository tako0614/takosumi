-- Protected expand migration: authorization-code redemption is one durable
-- lifecycle rather than a delete + consumed marker + token-link composition.
-- Historical tables from migrations 008/019/021 remain intact during the
-- observation window; this table becomes the runtime authority and retains
-- only credential hashes for code/token lineage.

CREATE TABLE IF NOT EXISTS accounts_v1.authorization_code_redemptions (
  code_hash text PRIMARY KEY CHECK (code_hash LIKE 'sha256:%'),
  record_version text NOT NULL CHECK (length(record_version) > 0),
  state text NOT NULL CHECK (state IN ('active', 'issuing', 'issued', 'replayed')),
  claim_id text,
  client_id text,
  redirect_uri text,
  scope text,
  subject text,
  takosumi_subject text,
  capsule_id text,
  workspace_id text,
  role text,
  nonce text,
  code_challenge text,
  code_challenge_method text CHECK (
    code_challenge_method IS NULL OR code_challenge_method IN ('plain', 'S256')
  ),
  access_token_hash text CHECK (
    access_token_hash IS NULL OR access_token_hash LIKE 'sha256:%'
  ),
  refresh_token_hash text CHECK (
    refresh_token_hash IS NULL OR refresh_token_hash LIKE 'sha256:%'
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz,
  claimed_at timestamptz,
  issued_at timestamptz,
  replayed_at timestamptz,
  CHECK (updated_at >= created_at),
  CHECK (
    state NOT IN ('active', 'issuing') OR (
      client_id IS NOT NULL AND
      redirect_uri IS NOT NULL AND
      scope IS NOT NULL AND
      subject IS NOT NULL AND
      expires_at IS NOT NULL
    )
  ),
  CHECK (state <> 'active' OR claim_id IS NULL),
  CHECK (state = 'active' OR claim_id IS NOT NULL),
  CHECK (state <> 'issuing' OR (claim_id IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK (state <> 'issued' OR issued_at IS NOT NULL),
  CHECK (state <> 'replayed' OR replayed_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS authorization_code_redemptions_claim_idx
  ON accounts_v1.authorization_code_redemptions(claim_id)
  WHERE claim_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS authorization_code_redemptions_active_expiry_idx
  ON accounts_v1.authorization_code_redemptions(expires_at, code_hash)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS authorization_code_redemptions_terminal_retention_idx
  ON accounts_v1.authorization_code_redemptions(
    COALESCE(replayed_at, issued_at),
    code_hash
  )
  WHERE state IN ('issued', 'replayed');

-- Existing unconsumed codes become active validation snapshots. The derived
-- versions are opaque CAS values; runtime-created rows use fresh random UUIDs.
INSERT INTO accounts_v1.authorization_code_redemptions AS redemption (
  code_hash,
  record_version,
  state,
  client_id,
  redirect_uri,
  scope,
  subject,
  takosumi_subject,
  capsule_id,
  workspace_id,
  role,
  nonce,
  code_challenge,
  code_challenge_method,
  created_at,
  updated_at,
  expires_at
)
SELECT
  code_hash,
  'legacy-active:' || md5(code_hash || ':037'),
  'active',
  client_id,
  redirect_uri,
  scope,
  subject,
  takosumi_subject,
  capsule_id,
  workspace_id,
  role,
  nonce,
  code_challenge,
  code_challenge_method,
  created_at,
  created_at,
  expires_at
FROM accounts_v1.authorization_codes
ON CONFLICT (code_hash) DO NOTHING;

-- A historical consumed marker is terminal evidence and wins any conflict
-- with the active-code backfill. Preserve any snapshot fields copied above,
-- and recover hashed token lineage from the legacy link table when present.
-- Start terminal retention at this expand migration, not at the historical
-- consume time: pre-expand refresh rotation used rolling expiry, so old live
-- families need one full refresh lifetime of lineage evidence while the new
-- runtime converges them onto an absolute family expiry.
INSERT INTO accounts_v1.authorization_code_redemptions AS redemption (
  code_hash,
  record_version,
  state,
  claim_id,
  access_token_hash,
  refresh_token_hash,
  created_at,
  updated_at,
  issued_at
)
SELECT
  consumed.code_hash,
  'legacy-issued:' || md5(consumed.code_hash || ':037'),
  'issued',
  'legacy-claim:' || md5(consumed.code_hash || ':037'),
  (
    SELECT NULLIF(link.access_token_hash, '')
    FROM accounts_v1.auth_code_token_links AS link
    WHERE link.code_hash = consumed.code_hash
    ORDER BY NULLIF(link.access_token_hash, '') NULLS LAST,
             NULLIF(link.refresh_root_hash, '') NULLS LAST
    LIMIT 1
  ),
  (
    SELECT NULLIF(link.refresh_root_hash, '')
    FROM accounts_v1.auth_code_token_links AS link
    WHERE link.code_hash = consumed.code_hash
    ORDER BY NULLIF(link.access_token_hash, '') NULLS LAST,
             NULLIF(link.refresh_root_hash, '') NULLS LAST
    LIMIT 1
  ),
  consumed.consumed_at,
  consumed.consumed_at,
  CURRENT_TIMESTAMP
FROM accounts_v1.consumed_authorization_codes AS consumed
ON CONFLICT (code_hash) DO UPDATE SET
  record_version = EXCLUDED.record_version,
  state = 'issued',
  claim_id = EXCLUDED.claim_id,
  access_token_hash = COALESCE(
    EXCLUDED.access_token_hash,
    redemption.access_token_hash
  ),
  refresh_token_hash = COALESCE(
    EXCLUDED.refresh_token_hash,
    redemption.refresh_token_hash
  ),
  updated_at = GREATEST(
    redemption.updated_at,
    EXCLUDED.updated_at
  ),
  issued_at = COALESCE(redemption.issued_at, EXCLUDED.issued_at),
  replayed_at = NULL;
