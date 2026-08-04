CREATE TABLE configuration_schemas (
  schema_id TEXT PRIMARY KEY CHECK (schema_id ~ '^[a-z][a-z0-9._-]{0,63}$'),
  resource_id TEXT NOT NULL UNIQUE CHECK (resource_id ~ '^[a-z][a-z0-9._-]{0,63}$'),
  current_revision_id TEXT NOT NULL UNIQUE CHECK (current_revision_id ~ '^[a-z][a-z0-9._-]{0,63}$'),
  current_schema_version TEXT NOT NULL CHECK (current_schema_version ~ '^[a-z0-9][a-z0-9.+_-]{0,127}$'),
  current_schema_sha256 CHAR(64) NOT NULL CHECK (current_schema_sha256 ~ '^[a-f0-9]{64}$'),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE configuration_schema_revisions (
  revision_id TEXT PRIMARY KEY CHECK (revision_id ~ '^[a-z][a-z0-9._-]{0,63}$'),
  schema_id TEXT NOT NULL REFERENCES configuration_schemas(schema_id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL CHECK (schema_version ~ '^[a-z0-9][a-z0-9.+_-]{0,127}$'),
  previous_schema_sha256 CHAR(64) CHECK (previous_schema_sha256 IS NULL OR previous_schema_sha256 ~ '^[a-f0-9]{64}$'),
  schema_sha256 CHAR(64) NOT NULL CHECK (schema_sha256 ~ '^[a-f0-9]{64}$'),
  definition JSONB NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  actor_id UUID NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9._-]{0,63}$'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (schema_id, schema_sha256)
);

CREATE INDEX configuration_schema_revisions_history_idx
  ON configuration_schema_revisions (schema_id, created_at, revision_id);

CREATE TABLE configuration_resources (
  server_instance_id UUID NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL CHECK (resource_id ~ '^[a-z][a-z0-9._-]{0,63}$'),
  schema_id TEXT NOT NULL REFERENCES configuration_schemas(schema_id) ON DELETE RESTRICT,
  schema_sha256 CHAR(64) NOT NULL CHECK (schema_sha256 ~ '^[a-f0-9]{64}$'),
  relative_file_path TEXT NOT NULL CHECK (
    char_length(relative_file_path) BETWEEN 1 AND 512
    AND relative_file_path !~ '(^|/)\.\.(/|$)'
    AND relative_file_path !~ '^[A-Za-z]:'
    AND relative_file_path !~ '^/'
    AND relative_file_path !~ '\\'
  ),
  maximum_bytes INTEGER NOT NULL CHECK (maximum_bytes BETWEEN 1 AND 1048576),
  apply_mode TEXT NOT NULL CHECK (apply_mode = 'offline-only'),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (server_instance_id, resource_id)
);

CREATE TABLE configuration_application_states (
  server_instance_id UUID NOT NULL,
  resource_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('registered', 'prepared', 'applied', 'failed')),
  current_sha256 CHAR(64) NOT NULL CHECK (current_sha256 ~ '^[a-f0-9]{64}$'),
  pending_revision_id TEXT,
  last_applied_revision_id TEXT,
  last_failed_revision_id TEXT,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (server_instance_id, resource_id),
  FOREIGN KEY (server_instance_id, resource_id)
    REFERENCES configuration_resources(server_instance_id, resource_id) ON DELETE CASCADE,
  CHECK (
    (status = 'prepared' AND pending_revision_id IS NOT NULL)
    OR (status <> 'prepared' AND pending_revision_id IS NULL)
  )
);

CREATE TABLE configuration_revisions (
  revision_id TEXT PRIMARY KEY CHECK (revision_id ~ '^[a-z][a-z0-9._-]{0,63}$'),
  server_instance_id UUID NOT NULL,
  resource_id TEXT NOT NULL,
  schema_id TEXT NOT NULL,
  schema_version TEXT NOT NULL CHECK (schema_version ~ '^[a-z0-9][a-z0-9.+_-]{0,127}$'),
  schema_sha256 CHAR(64) NOT NULL CHECK (schema_sha256 ~ '^[a-f0-9]{64}$'),
  operation TEXT NOT NULL CHECK (operation IN ('update', 'rollback')),
  source_revision_id TEXT REFERENCES configuration_revisions(revision_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'applied', 'failed')),
  expected_current_sha256 CHAR(64) NOT NULL CHECK (expected_current_sha256 ~ '^[a-f0-9]{64}$'),
  previous_sha256 CHAR(64) CHECK (previous_sha256 IS NULL OR previous_sha256 ~ '^[a-f0-9]{64}$'),
  current_sha256 CHAR(64) CHECK (current_sha256 IS NULL OR current_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_sha256 CHAR(64) CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[a-f0-9]{64}$'),
  requested_fields JSONB NOT NULL CHECK (jsonb_typeof(requested_fields) = 'array'),
  changed_fields JSONB CHECK (changed_fields IS NULL OR jsonb_typeof(changed_fields) = 'array'),
  restart_required BOOLEAN,
  actor JSONB NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9._-]{0,63}$'),
  correlation_id UUID NOT NULL,
  failure_code TEXT,
  failure_stage TEXT,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (server_instance_id, resource_id)
    REFERENCES configuration_resources(server_instance_id, resource_id) ON DELETE RESTRICT,
  CHECK (
    (operation = 'update' AND source_revision_id IS NULL)
    OR (operation = 'rollback' AND source_revision_id IS NOT NULL)
  ),
  CHECK (
    (status = 'prepared' AND previous_sha256 IS NULL AND current_sha256 IS NULL
      AND manifest_sha256 IS NULL AND changed_fields IS NULL AND restart_required IS NULL
      AND failure_code IS NULL AND failure_stage IS NULL AND completed_at IS NULL)
    OR (status = 'applied' AND previous_sha256 IS NOT NULL AND current_sha256 IS NOT NULL
      AND manifest_sha256 IS NOT NULL AND changed_fields IS NOT NULL
      AND restart_required IS NOT NULL AND failure_code IS NULL AND failure_stage IS NULL
      AND completed_at IS NOT NULL)
    OR (status = 'failed' AND previous_sha256 IS NULL AND current_sha256 IS NULL
      AND manifest_sha256 IS NULL AND changed_fields IS NULL AND restart_required IS NULL
      AND failure_code IS NOT NULL AND failure_stage IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX configuration_revisions_resource_idx
  ON configuration_revisions (server_instance_id, resource_id, created_at, revision_id);
CREATE INDEX configuration_revisions_correlation_idx
  ON configuration_revisions (correlation_id);

ALTER TABLE configuration_application_states
  ADD CONSTRAINT configuration_application_pending_revision_fk
  FOREIGN KEY (pending_revision_id) REFERENCES configuration_revisions(revision_id) ON DELETE RESTRICT;

ALTER TABLE configuration_application_states
  ADD CONSTRAINT configuration_application_last_applied_fk
  FOREIGN KEY (last_applied_revision_id) REFERENCES configuration_revisions(revision_id) ON DELETE RESTRICT;

ALTER TABLE configuration_application_states
  ADD CONSTRAINT configuration_application_last_failed_fk
  FOREIGN KEY (last_failed_revision_id) REFERENCES configuration_revisions(revision_id) ON DELETE RESTRICT;

CREATE TABLE operational_locks (
  server_instance_id UUID NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  lock_name TEXT NOT NULL CHECK (lock_name ~ '^[a-z][a-z0-9._-]{0,63}$'),
  owner_id UUID NOT NULL,
  operation TEXT NOT NULL CHECK (operation ~ '^[a-z][a-z0-9.-]{1,127}$'),
  acquired_at TIMESTAMPTZ NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (server_instance_id, lock_name),
  CHECK (lease_expires_at > acquired_at)
);

CREATE INDEX operational_locks_expiry_idx ON operational_locks (lease_expires_at);
