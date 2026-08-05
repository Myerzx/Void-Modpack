-- Phase 10.5 makes maintenance schedules durable.
--
-- A schedule is a typed plan, never a script. The steps live as JSON validated
-- by the contract, and no column here holds a command, a path or an executable:
-- a scheduler that accepted a command string would be a way to run arbitrary
-- work on a timer, which is what a scheduler becomes if nobody stops it.
--
-- The timezone is stored and mandatory. "Restart at 04:00" means nothing
-- without one, and the bug only shows up twice a year when a DST transition
-- moves the run again.

CREATE TABLE server_schedules (
  schedule_id UUID PRIMARY KEY,
  server_instance_id UUID NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  timezone TEXT NOT NULL CHECK (char_length(timezone) BETWEEN 3 AND 64),
  trigger_hour SMALLINT NOT NULL CHECK (trigger_hour BETWEEN 0 AND 23),
  trigger_minute SMALLINT NOT NULL CHECK (trigger_minute BETWEEN 0 AND 59),
  -- Empty means every day. Stored as a sorted array of 0..6, Sunday first.
  weekdays SMALLINT[] NOT NULL DEFAULT '{}',
  steps JSONB NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9._-]{0,63}$'),
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,

  -- A disabled schedule has no next run. Leaving one behind would let a
  -- scheduler pick up work for a schedule an operator switched off.
  CONSTRAINT server_schedules_disabled_has_no_next_run CHECK (
    enabled OR next_run_at IS NULL
  ),
  CONSTRAINT server_schedules_name_unique UNIQUE (server_instance_id, name)
);

CREATE INDEX server_schedules_due_idx
  ON server_schedules (next_run_at)
  WHERE enabled;

-- Runs.
--
-- A run belongs to an *occurrence*, identified by the instant it was scheduled
-- for rather than by when a scheduler noticed it. That is what makes
-- deduplication work: a scheduler that woke twice, two schedulers that woke at
-- once, and one catching up after a crash all resolve to the same occurrence.
CREATE TABLE schedule_runs (
  run_id UUID PRIMARY KEY,
  schedule_id UUID NOT NULL REFERENCES server_schedules(schedule_id) ON DELETE CASCADE,
  server_instance_id UUID NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'running', 'succeeded', 'failed', 'skipped')),
  claimed_by UUID NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  step_index SMALLINT NOT NULL DEFAULT 0 CHECK (step_index BETWEEN 0 AND 8),
  failure_code TEXT CHECK (failure_code IS NULL OR char_length(failure_code) <= 64),
  -- Null when no restart ran. False is a run that restarted and did not come
  -- back, which must never be reported as success.
  post_restart_verified BOOLEAN,

  -- One run per occurrence. This is the deduplication, enforced by the database
  -- rather than by a scheduler's own bookkeeping — two schedulers cannot both
  -- believe they won.
  CONSTRAINT schedule_runs_one_per_occurrence UNIQUE (schedule_id, scheduled_for),
  CONSTRAINT schedule_runs_settled_has_completion CHECK (
    (status IN ('succeeded', 'failed', 'skipped')) = (completed_at IS NOT NULL)
  ),
  CONSTRAINT schedule_runs_failure_matches_status CHECK (
    (status = 'failed') = (failure_code IS NOT NULL)
  ),
  CONSTRAINT schedule_runs_lease_outlives_claim CHECK (lease_expires_at > claimed_at),
  -- A run that restarted and reports success must have seen the server come
  -- back, or "succeeded" means only that the command was sent.
  CONSTRAINT schedule_runs_success_was_verified CHECK (
    status <> 'succeeded' OR post_restart_verified IS NOT FALSE
  )
);

CREATE INDEX schedule_runs_schedule_idx
  ON schedule_runs (schedule_id, scheduled_for DESC);

-- Reclaiming a run whose scheduler died: find the expired leases.
CREATE INDEX schedule_runs_expired_lease_idx
  ON schedule_runs (lease_expires_at)
  WHERE status IN ('claimed', 'running');
