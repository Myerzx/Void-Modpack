-- The artifact installer is a separately granted agent capability. Updating
-- the contract without these two storage allowlists makes local registration
-- fail before the agent can provision configurations or claim any work.

ALTER TABLE agent_capability_grants
  DROP CONSTRAINT agent_capability_grants_capability_check;

ALTER TABLE agent_capability_grants
  ADD CONSTRAINT agent_capability_grants_capability_check CHECK (
    capability IN (
      'heartbeat',
      'configuration.apply',
      'artifact.inspect',
      'artifact.analyze',
      'artifact.install',
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
      'artifact.install',
      'process.control',
      'process.force-kill',
      'console.command',
      'backup.create',
      'backup.restore',
      'datapack-load-order.observe'
    )
  );
