INSERT INTO roles (id, display_name, protected) VALUES
  ('owner', 'Dono', true),
  ('administrator', 'Administrador', true),
  ('moderator', 'Moderador', true),
  ('support', 'Suporte', true),
  ('read-only', 'Somente leitura', true);

INSERT INTO permissions (id, description) VALUES
  ('dashboard.view', 'View the operational dashboard'),
  ('metrics.view', 'View collected metrics'),
  ('server.view', 'View server instances'),
  ('server.control.start', 'Request a server start'),
  ('server.control.stop', 'Request a graceful server stop'),
  ('server.control.restart', 'Request a server restart'),
  ('server.control.force', 'Force a server process to stop'),
  ('console.view', 'View the Minecraft console'),
  ('console.command', 'Send an allowlisted console command'),
  ('console.command.dangerous', 'Send a dangerous allowlisted console command'),
  ('logs.view', 'View logs'),
  ('logs.export', 'Export authorized logs'),
  ('player.activity.sensitive', 'View sensitive player activity'),
  ('players.view', 'View players'),
  ('players.kick', 'Kick a player'),
  ('players.ban', 'Ban or unban a player'),
  ('players.whitelist', 'Manage the whitelist'),
  ('players.group', 'Change a player group'),
  ('players.teleport', 'Teleport a player'),
  ('mods.view', 'View the mod catalog'),
  ('mods.manage', 'Manage mod candidates'),
  ('mods.classify', 'Classify mod side and requirement'),
  ('mods.licenseReview', 'Review distribution evidence'),
  ('files.view', 'View authorized files'),
  ('files.edit', 'Edit authorized text files'),
  ('files.upload', 'Upload files to quarantine'),
  ('files.delete', 'Delete managed files'),
  ('backups.view', 'View backup metadata'),
  ('backups.create', 'Create a backup'),
  ('backups.restore', 'Restore a backup'),
  ('backups.delete', 'Delete a backup'),
  ('modpack.build.request', 'Request a modpack build'),
  ('modpack.build.cancel', 'Cancel a modpack build'),
  ('modpack.release.approve', 'Approve a release candidate'),
  ('modpack.release.promote', 'Promote a release channel'),
  ('modpack.release.rollback', 'Roll back a release channel'),
  ('schedules.view', 'View schedules'),
  ('schedules.manage', 'Manage schedules'),
  ('users.view', 'View panel users'),
  ('users.manage', 'Manage panel users'),
  ('roles.manage', 'Manage panel roles'),
  ('audit.view', 'View administrative audit events'),
  ('security.manage', 'Manage security-sensitive resources');

INSERT INTO role_permissions (role_id, permission_id)
SELECT 'owner', id FROM permissions;

INSERT INTO role_permissions (role_id, permission_id)
SELECT 'administrator', id FROM permissions
WHERE id NOT IN ('server.control.force', 'console.command.dangerous', 'roles.manage', 'security.manage');

INSERT INTO role_permissions (role_id, permission_id)
SELECT 'moderator', id FROM permissions
WHERE id IN (
  'dashboard.view', 'metrics.view', 'server.view', 'console.view', 'console.command',
  'logs.view', 'players.view', 'players.kick', 'players.ban', 'players.whitelist',
  'mods.view', 'files.view', 'backups.view', 'schedules.view', 'audit.view'
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT 'support', id FROM permissions
WHERE id IN (
  'dashboard.view', 'metrics.view', 'server.view', 'console.view', 'logs.view',
  'logs.export', 'players.view', 'mods.view', 'files.view', 'backups.view', 'schedules.view'
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT 'read-only', id FROM permissions
WHERE id IN (
  'dashboard.view', 'metrics.view', 'server.view', 'console.view', 'logs.view',
  'players.view', 'mods.view', 'files.view', 'backups.view', 'schedules.view'
);
