export const PANEL_PERMISSIONS = [
  'dashboard.view',
  'metrics.view',
  'server.view',
  'server.control.start',
  'server.control.stop',
  'server.control.restart',
  'server.control.force',
  'console.view',
  'console.command',
  'console.command.dangerous',
  'logs.view',
  'logs.export',
  'player.activity.sensitive',
  'players.view',
  'players.kick',
  'players.ban',
  'players.whitelist',
  'players.group',
  'players.teleport',
  'mods.view',
  'mods.manage',
  'mods.classify',
  'mods.licenseReview',
  'files.view',
  'files.edit',
  'files.upload',
  'files.delete',
  'configuration.view',
  'configuration.validate',
  'configuration.apply',
  'configuration.rollback',
  'backups.view',
  'backups.create',
  'backups.restore',
  'backups.delete',
  'modpack.build.request',
  'modpack.build.cancel',
  'modpack.release.approve',
  'modpack.release.promote',
  'modpack.release.rollback',
  'schedules.view',
  'schedules.manage',
  'users.view',
  'users.manage',
  'roles.manage',
  'audit.view',
  'security.manage',
] as const;

export type PanelPermission = (typeof PANEL_PERMISSIONS)[number];

export const PANEL_ROLES = ['owner', 'administrator', 'moderator', 'support', 'read-only'] as const;

export type PanelRole = (typeof PANEL_ROLES)[number];

const readOnlyPermissions = [
  'dashboard.view',
  'metrics.view',
  'server.view',
  'console.view',
  'logs.view',
  'players.view',
  'mods.view',
  'files.view',
  'backups.view',
  'schedules.view',
] as const satisfies readonly PanelPermission[];

export const ROLE_PERMISSION_GRANTS: Readonly<Record<PanelRole, readonly PanelPermission[]>> = {
  owner: PANEL_PERMISSIONS,
  administrator: PANEL_PERMISSIONS.filter(
    (permission) =>
      permission !== 'server.control.force' &&
      permission !== 'console.command.dangerous' &&
      permission !== 'roles.manage' &&
      permission !== 'security.manage',
  ),
  moderator: [
    ...readOnlyPermissions,
    'players.kick',
    'players.ban',
    'players.whitelist',
    'console.command',
    'audit.view',
  ],
  support: [...readOnlyPermissions, 'logs.export'],
  'read-only': readOnlyPermissions,
};

const knownPermissions = new Set<string>(PANEL_PERMISSIONS);

export function isPanelPermission(value: string): value is PanelPermission {
  return knownPermissions.has(value);
}

export function permissionsForRoles(roles: readonly PanelRole[]): readonly PanelPermission[] {
  return [...new Set(roles.flatMap((role) => ROLE_PERMISSION_GRANTS[role]))].sort();
}

export function hasPermission(
  grantedPermissions: readonly string[],
  requiredPermission: PanelPermission,
): boolean {
  return grantedPermissions.includes(requiredPermission);
}
