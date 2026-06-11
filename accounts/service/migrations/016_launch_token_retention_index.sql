CREATE INDEX IF NOT EXISTS launch_tokens_retention_expires_idx
  ON installation_v1.launch_tokens(expires_at);

CREATE INDEX IF NOT EXISTS launch_tokens_retention_used_idx
  ON installation_v1.launch_tokens(used_at)
  WHERE used_at IS NOT NULL;
