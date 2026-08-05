-- Phase 9.1 gives the operational core durable memory.
--
-- Until now an operation lived in the memory of one adapter: its idempotency
-- history, its mutual exclusion and the PID it observed all died with the
-- process. These tables hold the same facts durably, so restarting the API or
-- the agent cannot lose a receipt, run an operation twice, or leave the
-- control plane believing in a process nobody is watching.
--
-- No column here stores a launch plan, a path, a working directory or command
-- text. An operation is named by a reviewed kind; a receipt reports what was
-- observed, never how it was produced.

CREATE TABLE server_operations (
  operation_id UUID PRIMARY KEY,
  server_instance_id UUID NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('server.start', 'server.stop', 'server.restart', 'server.command',
             'backup.create', 'configuration.apply', 'configuration.rollback')
  ),
  status TEXT NOT NULL CHECK (
    status IN ('accepted', 'running', 'succeeded', 'failed', 'rejected')
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  -- Digest of the stable request fields only. A key replayed with a different
  -- fingerprint is a conflict, never a silent second run.
  request_fingerprint CHAR(64) NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  correlation_id UUID NOT NULL,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  requested_by JSONB NOT NULL CHECK (jsonb_typeof(requested_by) = 'object'),
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9._-]{0,63}$'),

  receipt_outcome TEXT CHECK (receipt_outcome IS NULL OR receipt_outcome IN ('succeeded', 'failed')),
  receipt_failure_code TEXT CHECK (
    receipt_failure_code IS NULL OR receipt_failure_code IN (
      'precondition-not-met', 'lock-unavailable', 'lease-expired', 'agent-unavailable',
      'agent-refused', 'timed-out', 'operation-failed', 'reconciled-unknown'
    )
  ),
  receipt_lifecycle TEXT CHECK (
    receipt_lifecycle IS NULL OR
    receipt_lifecycle IN ('unknown', 'offline', 'starting', 'online', 'stopping', 'error')
  ),
  receipt_pid BIGINT CHECK (receipt_pid IS NULL OR receipt_pid BETWEEN 1 AND 4294967295),
  receipt_boot_id UUID,
  completed_at TIMESTAMPTZ,

  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  accepted_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,

  -- The same invariants the public contract enforces, so a writer that
  -- bypassed the contract still cannot record an impossible operation.
  CHECK (updated_at >= accepted_at),
  CHECK (
    (status IN ('succeeded', 'failed'))
      = (receipt_outcome IS NOT NULL AND receipt_lifecycle IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CHECK (receipt_outcome IS NULL OR receipt_outcome = status),
  CHECK ((receipt_outcome = 'failed') IS NOT TRUE OR receipt_failure_code IS NOT NULL),
  CHECK ((receipt_outcome = 'succeeded') IS NOT TRUE OR receipt_failure_code IS NULL),
  -- A pid means nothing without the boot it belongs to.
  CHECK (receipt_pid IS NULL OR receipt_boot_id IS NOT NULL),
  CHECK (completed_at IS NULL OR completed_at >= accepted_at)
);

-- Durable mutual exclusion: at most one operation may be in flight per server.
-- This is what replaces the adapter's in-memory exclusion, and unlike it, the
-- guarantee survives a restart of the API or the agent.
CREATE UNIQUE INDEX server_operations_in_flight_idx
  ON server_operations (server_instance_id)
  WHERE status IN ('accepted', 'running');

CREATE INDEX server_operations_history_idx
  ON server_operations (server_instance_id, accepted_at DESC, operation_id);
CREATE INDEX server_operations_correlation_idx ON server_operations (correlation_id);
CREATE INDEX server_operations_job_idx ON server_operations (job_id);

-- The last state an agent reported for a server's process.
CREATE TABLE server_process_states (
  server_instance_id UUID PRIMARY KEY REFERENCES server_instances(id) ON DELETE CASCADE,
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('unknown', 'offline', 'starting', 'online', 'stopping', 'error')
  ),
  observed_pid BIGINT CHECK (observed_pid IS NULL OR observed_pid BETWEEN 1 AND 4294967295),
  -- Identifies one run of the process, so a pid from a previous boot can never
  -- be mistaken for a live one.
  boot_id UUID,
  observed_by UUID REFERENCES agents(id) ON DELETE SET NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  -- True when the control plane could not confirm the observation is current.
  stale BOOLEAN NOT NULL DEFAULT TRUE,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),

  CHECK (observed_pid IS NULL OR boot_id IS NOT NULL),
  CHECK (observed_pid IS NULL OR lifecycle NOT IN ('offline', 'unknown')),
  -- A state nobody is observing is stale by definition.
  CHECK (observed_by IS NOT NULL OR stale),
  CHECK (lifecycle <> 'unknown' OR stale OR observed_by IS NULL)
);

-- Events queued for publication. A row is written in the same transaction as
-- the state change it describes, so there is no dual write: an event cannot
-- exist for a state that never committed, and a committed state cannot lose
-- its event. Delivery is marked separately and is therefore at-least-once.
CREATE TABLE outbox_events (
  event_id UUID PRIMARY KEY,
  topic TEXT NOT NULL CHECK (
    topic IN ('operation.accepted', 'operation.completed', 'process.observed',
              'artifact.state-changed', 'configuration.state-changed')
  ),
  correlation_id UUID NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  resource_id TEXT NOT NULL CHECK (char_length(resource_id) BETWEEN 1 AND 128),
  occurred_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1000000),
  -- Closed payload: a status triple, never an operational detail.
  payload_status TEXT CHECK (payload_status IS NULL OR char_length(payload_status) BETWEEN 1 AND 64),
  payload_outcome TEXT CHECK (payload_outcome IS NULL OR char_length(payload_outcome) BETWEEN 1 AND 64),
  payload_failure_code TEXT CHECK (
    payload_failure_code IS NULL OR char_length(payload_failure_code) BETWEEN 1 AND 64
  ),
  lease_owner UUID,
  lease_expires_at TIMESTAMPTZ,

  CHECK (published_at IS NULL OR published_at >= occurred_at),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

-- Only unpublished rows are ever scanned, so the index stays small however
-- long the published history grows.
CREATE INDEX outbox_events_pending_idx
  ON outbox_events (occurred_at, event_id)
  WHERE published_at IS NULL;
CREATE INDEX outbox_events_correlation_idx ON outbox_events (correlation_id);

-- The reviewed mod catalog, which until now existed only in memory. The
-- reviewed entry is stored whole and validated against its public contract;
-- the columns beside it exist to index and to enforce concurrency, never to
-- become a second source of truth.
CREATE TABLE mod_catalog_entries (
  entry_id TEXT PRIMARY KEY CHECK (entry_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  server_instance_id UUID NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  filename TEXT NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  side TEXT NOT NULL CHECK (side IN ('unknown', 'client', 'server', 'both')),
  requirement TEXT NOT NULL CHECK (requirement IN ('required', 'optional', 'library')),
  review_state TEXT NOT NULL CHECK (review_state IN ('detected', 'reviewed', 'quarantined')),
  distribution_decision TEXT NOT NULL CHECK (
    distribution_decision IN ('pending', 'allowed', 'blocked')
  ),
  entry JSONB NOT NULL CHECK (jsonb_typeof(entry) = 'object'),
  -- Every change names who made it and why, over the state they had read.
  actor JSONB NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9._-]{0,63}$'),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,

  CHECK (updated_at >= created_at),
  UNIQUE (server_instance_id, sha256)
);

CREATE INDEX mod_catalog_entries_server_idx
  ON mod_catalog_entries (server_instance_id, review_state, entry_id);
