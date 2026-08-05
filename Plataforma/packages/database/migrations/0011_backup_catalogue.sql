-- Phase 10.3 makes backup and restore operable.
--
-- The repository itself lives on the agent's host, as trusted local
-- configuration. What the control plane keeps is the catalogue: which backups
-- were asked for, which completed, how large they are, and which keys sealed
-- and encrypted them. That is what a panel can show and what retention can
-- reason about without the API ever holding a path or a key.
--
-- No column here stores a directory, a storage endpoint or key material. The
-- key identifiers are names, not secrets.

-- Restoring is its own operation kind. Modelling it as a backup would blur the
-- one distinction that matters: taking a copy is safe, putting one back
-- destroys everything the world became since.
ALTER TABLE server_operations DROP CONSTRAINT IF EXISTS server_operations_kind_check;
ALTER TABLE server_operations ADD CONSTRAINT server_operations_kind_check CHECK (
  kind IN ('server.start', 'server.stop', 'server.restart', 'server.command',
           'server.force-kill', 'backup.create', 'backup.restore',
           'configuration.apply', 'configuration.rollback')
);

-- Which snapshot the operation is about.
--
-- It lives on the durable operation for the same reason the console command
-- does: auditable there, constrained by the database itself, and the queue keeps
-- carrying nothing but an opaque reference. An agent that read the target from
-- the job payload would be taking direction from the wire.
ALTER TABLE server_operations
  ADD COLUMN backup_id TEXT
  CHECK (backup_id IS NULL OR backup_id ~ '^[a-z][a-z0-9._-]{0,63}$');

-- A backup id belongs to a backup operation and to nothing else.
ALTER TABLE server_operations
  ADD CONSTRAINT server_operations_backup_id_kind_check
  CHECK ((kind IN ('backup.create', 'backup.restore')) = (backup_id IS NOT NULL));

CREATE TABLE server_backups (
  backup_id TEXT PRIMARY KEY CHECK (backup_id ~ '^[a-z][a-z0-9._-]{0,63}$'),
  server_instance_id UUID NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('world', 'configurations', 'complete')),
  status TEXT NOT NULL CHECK (status IN ('creating', 'available', 'failed', 'pruned')),
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9._-]{0,63}$'),
  requested_by JSONB NOT NULL,
  correlation_id UUID NOT NULL,
  operation_id UUID REFERENCES server_operations(operation_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  file_count BIGINT CHECK (file_count IS NULL OR file_count >= 0),
  manifest_sha256 TEXT CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[a-f0-9]{64}$'),
  -- Identifiers only. Which key sealed a backup is operational fact; the key
  -- itself never comes near the control plane.
  seal_key_id TEXT CHECK (seal_key_id IS NULL OR seal_key_id ~ '^[a-z][a-z0-9._-]{0,63}$'),
  encryption_key_id TEXT CHECK (encryption_key_id IS NULL OR encryption_key_id ~ '^[a-z][a-z0-9._-]{0,63}$'),
  failure_code TEXT CHECK (failure_code IS NULL OR char_length(failure_code) <= 64),

  -- An available backup has been measured and sealed. Without this a backup
  -- could be offered for restore on the strength of nobody having checked it.
  CONSTRAINT server_backups_available_is_complete CHECK (
    status <> 'available' OR (
      completed_at IS NOT NULL AND
      size_bytes IS NOT NULL AND
      file_count IS NOT NULL AND
      manifest_sha256 IS NOT NULL AND
      seal_key_id IS NOT NULL
    )
  ),
  CONSTRAINT server_backups_failure_matches_status CHECK (
    (status = 'failed') = (failure_code IS NOT NULL)
  )
);

CREATE INDEX server_backups_server_idx
  ON server_backups (server_instance_id, created_at DESC);

-- One backup may be in flight per server, for the same reason one process
-- operation may: two concurrent copies of the same world compete for the same
-- exclusive offline window and neither would be consistent.
CREATE UNIQUE INDEX server_backups_in_flight_idx
  ON server_backups (server_instance_id)
  WHERE status = 'creating';
