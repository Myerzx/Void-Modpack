CREATE TABLE audit_chain_heads (
  partition_id TEXT PRIMARY KEY CHECK (partition_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  last_hash CHAR(64),
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (last_sequence = 0 AND last_hash IS NULL)
    OR (last_sequence > 0 AND last_hash ~ '^[a-f0-9]{64}$')
  )
);

ALTER TABLE audit_events
  ADD COLUMN partition_id TEXT,
  ADD COLUMN chain_sequence BIGINT;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_chain_pair_check CHECK (
    (partition_id IS NULL AND chain_sequence IS NULL)
    OR (
      partition_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
      AND chain_sequence >= 1
      AND integrity_hash ~ '^[a-f0-9]{64}$'
    )
  );

CREATE UNIQUE INDEX audit_events_partition_sequence_idx
  ON audit_events (partition_id, chain_sequence)
  WHERE partition_id IS NOT NULL;
