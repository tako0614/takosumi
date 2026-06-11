-- CLOUD-OIDC fix (multi-isolate WebAuthn challenge store): persist WebAuthn
-- ceremony challenges so the options -> complete round trip and the
-- single-use replay guarantee hold across multiple isolates/replicas. The
-- previous module-local Map broke on the multi-isolate Cloudflare reference
-- distribution (the isolate serving /options may differ from the one serving
-- /complete), and lost the single-use property across replicas.
--
-- A challenge is consumed with a single-shot atomic DELETE ... RETURNING
-- (see postgres/passkeys.ts consumePasskeyChallenge), so a challenge can be
-- used at most once even under concurrent /complete requests. challenge_key
-- is opaque (the route layer composes it, e.g. subject + intent). expires_at
-- bounds the challenge lifetime; rows are removed on consume, and expired
-- rows are treated as absent (and deleted) on read.

CREATE TABLE IF NOT EXISTS accounts_v1.passkey_challenges (
  challenge_key text PRIMARY KEY,
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Supports an optional operator retention sweep of expired challenges that
-- were never consumed (e.g. abandoned ceremonies).
CREATE INDEX IF NOT EXISTS passkey_challenges_expires_at_idx
  ON accounts_v1.passkey_challenges(expires_at);
