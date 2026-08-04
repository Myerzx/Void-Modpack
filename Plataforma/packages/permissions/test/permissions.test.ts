import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PANEL_PERMISSIONS,
  ROLE_PERMISSION_GRANTS,
  hasPermission,
  isPanelPermission,
  permissionsForRoles,
} from '../src/index.js';

describe('panel RBAC policy', () => {
  it('grants every declared permission only to owner by default', () => {
    assert.deepEqual(ROLE_PERMISSION_GRANTS.owner, PANEL_PERMISSIONS);
    assert.equal(ROLE_PERMISSION_GRANTS.administrator.includes('server.control.force'), false);
    assert.equal(ROLE_PERMISSION_GRANTS.administrator.includes('security.manage'), false);
  });

  it('keeps read-only roles unable to mutate resources', () => {
    const granted = permissionsForRoles(['read-only']);
    assert.equal(hasPermission(granted, 'dashboard.view'), true);
    assert.equal(hasPermission(granted, 'server.control.start'), false);
    assert.equal(hasPermission(granted, 'modpack.release.promote'), false);
  });

  it('rejects unknown permission identifiers instead of treating them as wildcards', () => {
    assert.equal(isPanelPermission('server.*'), false);
    assert.equal(isPanelPermission('owner'), false);
  });

  it('restricts every configuration permission to owner and administrator', () => {
    const configurationPermissions = PANEL_PERMISSIONS.filter((permission) =>
      permission.startsWith('configuration.'),
    );
    assert.deepEqual(configurationPermissions, [
      'configuration.view',
      'configuration.validate',
      'configuration.apply',
      'configuration.rollback',
    ]);

    for (const permission of configurationPermissions) {
      assert.equal(hasPermission(permissionsForRoles(['owner']), permission), true);
      assert.equal(hasPermission(permissionsForRoles(['administrator']), permission), true);
      for (const role of ['moderator', 'support', 'read-only'] as const) {
        assert.equal(hasPermission(permissionsForRoles([role]), permission), false);
      }
    }
  });

  it('never lets a configuration grant imply a Minecraft or console capability', () => {
    const granted = permissionsForRoles(['administrator']);
    assert.equal(hasPermission(granted, 'configuration.apply'), true);
    assert.equal(hasPermission(granted, 'console.command.dangerous'), false);
    assert.equal(hasPermission(granted, 'server.control.force'), false);
  });
});
