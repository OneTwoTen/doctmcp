-- M6.3: chỉ persist device identity và metadata; live connection/status thuộc runtime.
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT,
  runtime_version TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (updated_at_ms >= created_at_ms)
);

-- Owner scope và thứ tự lookup deterministic (createdAt, deviceId).
CREATE INDEX idx_devices_owner_created_id
  ON devices (owner_id, created_at_ms, device_id);

-- Identity/ownership không thể bị sửa qua UPDATE, kể cả ngoài repository.
CREATE TRIGGER trg_devices_immutable_identity
BEFORE UPDATE OF device_id, owner_id ON devices
BEGIN
  SELECT RAISE(ABORT, 'device identity is immutable');
END;
