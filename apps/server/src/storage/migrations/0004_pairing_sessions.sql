-- M6.5: durable pairing lifecycle, only a digest of each pairing code.
CREATE TABLE pairing_sessions (
  pairing_session_id TEXT PRIMARY KEY NOT NULL,
  code_digest TEXT NOT NULL UNIQUE CHECK (length(code_digest) = 64),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  local_correlation_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'expired', 'cancelled')),
  claimed_at_ms INTEGER,
  device_id TEXT REFERENCES devices(device_id),
  CHECK (expires_at_ms > created_at_ms),
  CHECK (
    (state = 'claimed' AND claimed_at_ms >= created_at_ms
      AND claimed_at_ms < expires_at_ms AND device_id IS NOT NULL) OR
    (state <> 'claimed' AND claimed_at_ms IS NULL AND device_id IS NULL)
  )
);
CREATE INDEX idx_pairing_sessions_expiry
  ON pairing_sessions (state, expires_at_ms);
-- Tombstones forbid using a previously expired/pruned code digest.
CREATE TABLE pairing_code_tombstones (
  code_digest TEXT PRIMARY KEY NOT NULL
);
CREATE TABLE pairing_credential_completions (
  pairing_session_id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'pending', 'recovering', 'delivered')),
  device_id TEXT,
  credential_id TEXT,
  credential_version INTEGER,
  recovery_target_credential_id TEXT,
  expires_at_ms INTEGER NOT NULL,
  CHECK (
    (state = 'reserved' AND device_id IS NULL
      AND credential_id IS NULL AND credential_version IS NULL
      AND recovery_target_credential_id IS NULL) OR
    (state IN ('pending', 'delivered') AND device_id IS NOT NULL
      AND credential_id IS NOT NULL AND credential_version > 0
      AND recovery_target_credential_id IS NULL) OR
    (state = 'recovering' AND device_id IS NOT NULL
      AND credential_id IS NOT NULL AND credential_version > 0
      AND recovery_target_credential_id IS NOT NULL)
  )
);
CREATE INDEX idx_pairing_completions_expiry
  ON pairing_credential_completions(expires_at_ms);
