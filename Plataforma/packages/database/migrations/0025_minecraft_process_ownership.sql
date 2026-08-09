-- Durable ownership fence for the JVM managed by a ServerInstance.
--
-- The ownership id is minted before spawn. A PID is attached only after the
-- child exists, so an agent crash on either side of spawn leaves a record that
-- makes the next agent fail closed instead of launching a second JVM. A PID is
-- never sufficient to adopt a process: a different agent boot may only mark
-- the record orphaned, or remove it after proving that PID is no longer alive.

CREATE TABLE minecraft_process_ownership (
  server_instance_id UUID PRIMARY KEY REFERENCES server_instances(id) ON DELETE CASCADE,
  ownership_id UUID NOT NULL UNIQUE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_boot_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'running', 'orphaned')),
  pid BIGINT,
  acquired_at TIMESTAMPTZ NOT NULL,
  spawned_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK (pid IS NULL OR pid BETWEEN 1 AND 2147483647),
  CHECK (
    (status = 'reserved' AND pid IS NULL AND spawned_at IS NULL)
    OR (status = 'running' AND pid IS NOT NULL AND spawned_at IS NOT NULL)
    OR status = 'orphaned'
  )
);

CREATE INDEX minecraft_process_ownership_by_agent_boot
  ON minecraft_process_ownership (agent_id, agent_boot_id);
