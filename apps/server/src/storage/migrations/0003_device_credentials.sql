-- M6.4: only credential digest and lifecycle metadata; never raw secrets.
CREATE TABLE device_credentials (
  device_id TEXT PRIMARY KEY NOT NULL REFERENCES devices(device_id),
  credential_id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL CHECK (version > 0),
  secret_digest TEXT NOT NULL CHECK (length(secret_digest) = 64),
  created_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  revoked_at_ms INTEGER,
  CHECK (
    (state = 'active' AND revoked_at_ms IS NULL) OR
    (state = 'revoked' AND revoked_at_ms >= created_at_ms)
  )
);
-- Permanent global non-reuse, including generations overwritten on rotate/reissue.
CREATE TABLE used_device_credential_ids (
  credential_id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(device_id)
);
CREATE INDEX idx_device_credentials_active_digest
  ON device_credentials (device_id, state, secret_digest);
