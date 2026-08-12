-- A recovery rehearsal has its own operation and capability. It may restore
-- and boot a private copy, but it cannot replace the active world.

ALTER TABLE server_operations DROP CONSTRAINT IF EXISTS server_operations_kind_check;
ALTER TABLE server_operations ADD CONSTRAINT server_operations_kind_check CHECK (
  kind IN ('server.start', 'server.stop', 'server.restart', 'server.command',
           'server.force-kill', 'backup.create', 'backup.restore',
           'backup.verify-restore', 'configuration.apply',
           'configuration.rollback', 'artifact.install')
);

ALTER TABLE server_operations
  DROP CONSTRAINT IF EXISTS server_operations_backup_id_kind_check;
ALTER TABLE server_operations
  ADD CONSTRAINT server_operations_backup_id_kind_check
  CHECK ((kind IN ('backup.create', 'backup.restore', 'backup.verify-restore')) =
         (backup_id IS NOT NULL));

ALTER TABLE agent_capability_grants
  DROP CONSTRAINT agent_capability_grants_capability_check;
ALTER TABLE agent_capability_grants
  ADD CONSTRAINT agent_capability_grants_capability_check CHECK (
    capability IN (
      'heartbeat', 'configuration.apply', 'artifact.inspect', 'artifact.analyze',
      'artifact.install', 'process.observe', 'process.control',
      'process.force-kill', 'console.command', 'backup.create',
      'backup.verify-restore', 'backup.restore', 'datapack-load-order.observe'
    )
  );

ALTER TABLE agent_work_leases
  DROP CONSTRAINT agent_work_leases_capability_check;
ALTER TABLE agent_work_leases
  ADD CONSTRAINT agent_work_leases_capability_check CHECK (
    capability IN (
      'configuration.apply', 'artifact.inspect', 'artifact.analyze',
      'artifact.install', 'process.control', 'process.force-kill',
      'console.command', 'backup.create', 'backup.verify-restore',
      'backup.restore', 'datapack-load-order.observe'
    )
  );
