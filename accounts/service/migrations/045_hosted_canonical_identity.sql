-- Protected expansion only: old subjects, provider bindings, account rows and
-- foreign keys remain intact. Hosted readers opt into these nullable fields.
ALTER TABLE accounts_v1.authorization_codes ADD COLUMN hosted_metadata jsonb;
ALTER TABLE accounts_v1.oauth_access_tokens ADD COLUMN hosted_metadata jsonb;
ALTER TABLE accounts_v1.oauth_refresh_tokens ADD COLUMN hosted_metadata jsonb;
ALTER TABLE accounts_v1.account_sessions ADD COLUMN hosted_metadata jsonb;

CREATE TABLE accounts_v1.hosted_identity_records (
  bucket text NOT NULL,
  key text NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  subject text REFERENCES accounts_v1.accounts(subject) ON DELETE RESTRICT,
  other_subject text REFERENCES accounts_v1.accounts(subject) ON DELETE RESTRICT,
  PRIMARY KEY (bucket, key)
);
CREATE INDEX hosted_identity_records_subject_idx
  ON accounts_v1.hosted_identity_records(bucket, subject, key);
CREATE INDEX hosted_identity_records_session_idx
  ON accounts_v1.hosted_identity_records(bucket, (document->>'issuerSessionId'), key);
CREATE INDEX hosted_identity_records_client_idx
  ON accounts_v1.hosted_identity_records(bucket, (document->>'clientId'), key);
CREATE UNIQUE INDEX hosted_identity_records_code_idx
  ON accounts_v1.hosted_identity_records((document->>'authorizationCodeHash'))
  WHERE bucket = 'hosted_oidc_grants' AND document ? 'authorizationCodeHash';
CREATE INDEX accounts_merge_email_candidate_idx
  ON accounts_v1.accounts(lower(trim(email)), subject);

-- Every account writer, including the old runtime during the expansion window,
-- participates in a durable inventory epoch. A merge CAS claims the observed
-- epoch before changing authority; a concurrent writer makes that CAS lose
-- rather than relying on a process mutex or a stale statement snapshot.
CREATE FUNCTION accounts_v1.bump_identity_candidate_inventory()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO accounts_v1.hosted_identity_records(bucket, key, document)
  VALUES ('email_candidate_inventory', 'global', '{"generation":1}'::jsonb)
  ON CONFLICT (bucket, key) DO UPDATE SET document = jsonb_build_object(
    'generation', (accounts_v1.hosted_identity_records.document->>'generation')::bigint + 1
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER accounts_identity_candidate_inventory_epoch
  AFTER INSERT OR UPDATE OR DELETE ON accounts_v1.accounts
  FOR EACH STATEMENT EXECUTE FUNCTION accounts_v1.bump_identity_candidate_inventory();
