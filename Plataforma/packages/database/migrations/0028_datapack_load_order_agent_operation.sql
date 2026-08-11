-- Operational composition for the bounded datapack load-order observation.
--
-- This migration grants no capability. It only lets an operator grant the
-- reviewed name, lets the transport persist a lease for it, and binds an
-- immutable observation to the durable job that produced it. A nullable job
-- keeps the earlier isolated observations valid; operational writes always
-- provide one and the partial unique index is their idempotency boundary.

ALTER TABLE agent_capability_grants
  DROP CONSTRAINT agent_capability_grants_capability_check;

ALTER TABLE agent_capability_grants
  ADD CONSTRAINT agent_capability_grants_capability_check CHECK (
    capability IN (
      'heartbeat',
      'configuration.apply',
      'artifact.inspect',
      'artifact.analyze',
      'process.observe',
      'process.control',
      'process.force-kill',
      'console.command',
      'backup.create',
      'backup.restore',
      'datapack-load-order.observe'
    )
  );

ALTER TABLE agent_work_leases
  DROP CONSTRAINT agent_work_leases_capability_check;

ALTER TABLE agent_work_leases
  ADD CONSTRAINT agent_work_leases_capability_check CHECK (
    capability IN (
      'configuration.apply',
      'artifact.inspect',
      'artifact.analyze',
      'process.control',
      'process.force-kill',
      'console.command',
      'backup.create',
      'backup.restore',
      'datapack-load-order.observe'
    )
  );

ALTER TABLE workspace_datapack_load_order_observations
  ADD COLUMN job_id UUID REFERENCES jobs (id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX workspace_datapack_load_order_observation_job
  ON workspace_datapack_load_order_observations (job_id)
  WHERE job_id IS NOT NULL;
