-- Phase 10.1 makes process control and the console operable.
--
-- Two things were missing. The console existed only as a bounded snapshot the
-- adapter held in memory, so nothing could be read incrementally, retained or
-- redacted once. And force kill had nowhere to live: modelling it as a stop
-- would blur exactly the distinction that keeps a world from being corrupted.
--
-- No column here stores a launch plan, an executable, a working directory or a
-- free-form command. The console text is stored already redacted.

-- Force kill is its own operation kind, never a flag on stop.
ALTER TABLE server_operations DROP CONSTRAINT IF EXISTS server_operations_kind_check;
ALTER TABLE server_operations ADD CONSTRAINT server_operations_kind_check CHECK (
  kind IN ('server.start', 'server.stop', 'server.restart', 'server.command',
           'server.force-kill', 'backup.create', 'configuration.apply',
           'configuration.rollback')
);

-- Console output, appended only.
--
-- The sequence is per server and never reused, so a reader's cursor stays
-- meaningful while retention trims behind it: it can tell "nothing new" from
-- "you fell off the end" instead of silently skipping lines the way an offset
-- would.
CREATE TABLE server_console_lines (
  server_instance_id UUID NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL CHECK (sequence >= 1),
  stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr')),
  -- Already redacted on the way in: a secret that reached storage in the clear
  -- would survive every later read policy.
  text TEXT NOT NULL CHECK (char_length(text) <= 2048),
  occurred_at TIMESTAMPTZ NOT NULL,
  truncated BOOLEAN NOT NULL DEFAULT FALSE,
  redacted BOOLEAN NOT NULL DEFAULT FALSE,
  boot_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (server_instance_id, sequence)
);

CREATE INDEX server_console_lines_retention_idx
  ON server_console_lines (server_instance_id, occurred_at);

-- Tracks the next sequence to hand out per server, so appends stay contiguous
-- even when retention has deleted everything behind them.
CREATE TABLE server_console_cursors (
  server_instance_id UUID PRIMARY KEY REFERENCES server_instances(id) ON DELETE CASCADE,
  next_sequence BIGINT NOT NULL DEFAULT 1 CHECK (next_sequence >= 1),
  retained_lines INTEGER NOT NULL DEFAULT 0 CHECK (retained_lines >= 0),
  updated_at TIMESTAMPTZ NOT NULL
);
