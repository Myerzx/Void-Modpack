-- One live runtime has exactly one control-plane owner.
--
-- Two ServerInstance rows pointed at the same directory would create two
-- logical agents, each able to start a JVM in the same world. Likewise, two
-- imported workspaces claiming one instance would leave the stored
-- workspace-to-runtime edge ambiguous. Both relationships are one-to-one.

CREATE UNIQUE INDEX server_instances_one_run_directory
  ON server_instances (run_directory)
  WHERE run_directory IS NOT NULL;

DROP INDEX panel_workspaces_by_instance;

CREATE UNIQUE INDEX panel_workspaces_one_server_instance
  ON panel_workspaces (server_instance_id)
  WHERE server_instance_id IS NOT NULL;
