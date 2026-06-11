-- CLOUD-STORES fix (PG NULL-in-PRIMARY-KEY crash): the auth_code_token_links
-- table declared PRIMARY KEY (code_hash, access_token_hash, refresh_root_hash)
-- while allowing NULL in access_token_hash / refresh_root_hash. PostgreSQL
-- unconditionally forbids NULL in any PRIMARY KEY column, so the common
-- no-offline_access authorization-code exchange (which has no refresh-token
-- root, refresh_root_hash = NULL) failed with a not-null violation on the
-- Postgres distribution. The D1 store sidesteps this with an empty-string
-- sentinel (`${refreshRootHash ?? ""}`); this migration aligns Postgres on
-- the SAME empty-string sentinel scheme so both reference distributions are
-- representable and consistent.
--
-- Scheme (now consistent across PG and D1): an absent access_token_hash or
-- refresh_root_hash is stored as the empty string '', never NULL. The
-- empty-string sentinel can never collide with a real value because every
-- real hash is 'sha256:%'. The store code writes '' for the absent case and
-- treats '' as "no token" on read.

-- Normalize any existing NULLs to the empty-string sentinel before tightening
-- the constraints. (No rows with NULL can actually exist on Postgres because
-- the prior PRIMARY KEY rejected them at INSERT time, but this is defensive.)
UPDATE accounts_v1.auth_code_token_links
   SET access_token_hash = ''
 WHERE access_token_hash IS NULL;

UPDATE accounts_v1.auth_code_token_links
   SET refresh_root_hash = ''
 WHERE refresh_root_hash IS NULL;

-- Replace the constraints: drop the old NULL-permitting CHECKs and the PK that
-- could never hold a NULL row, then re-add NOT NULL columns whose CHECK admits
-- the empty-string sentinel OR an 'sha256:%' value, and re-add the PK.
ALTER TABLE accounts_v1.auth_code_token_links
  DROP CONSTRAINT IF EXISTS auth_code_token_links_pkey;

ALTER TABLE accounts_v1.auth_code_token_links
  DROP CONSTRAINT IF EXISTS auth_code_token_links_access_token_hash_check;

ALTER TABLE accounts_v1.auth_code_token_links
  DROP CONSTRAINT IF EXISTS auth_code_token_links_refresh_root_hash_check;

ALTER TABLE accounts_v1.auth_code_token_links
  ALTER COLUMN access_token_hash SET DEFAULT '',
  ALTER COLUMN access_token_hash SET NOT NULL,
  ALTER COLUMN refresh_root_hash SET DEFAULT '',
  ALTER COLUMN refresh_root_hash SET NOT NULL;

ALTER TABLE accounts_v1.auth_code_token_links
  ADD CONSTRAINT auth_code_token_links_access_token_hash_check
    CHECK (access_token_hash = '' OR access_token_hash LIKE 'sha256:%');

ALTER TABLE accounts_v1.auth_code_token_links
  ADD CONSTRAINT auth_code_token_links_refresh_root_hash_check
    CHECK (refresh_root_hash = '' OR refresh_root_hash LIKE 'sha256:%');

ALTER TABLE accounts_v1.auth_code_token_links
  ADD CONSTRAINT auth_code_token_links_pkey
    PRIMARY KEY (code_hash, access_token_hash, refresh_root_hash);
