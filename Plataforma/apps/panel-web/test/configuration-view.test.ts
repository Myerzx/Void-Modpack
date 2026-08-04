import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildConfigurationScreen,
  capabilitiesFor,
  changeEntriesFor,
  computeSafeDiff,
  displayValue,
  screenStateForError,
  type ConfigurationResourceStateView,
  type ConfigurationRevisionView,
  type ConfigurationSchemaView,
} from '../lib/configuration-view';

const OWNER_PERMISSIONS = [
  'configuration.view',
  'configuration.validate',
  'configuration.apply',
  'configuration.rollback',
];

function schema(overrides: Partial<ConfigurationSchemaView> = {}): ConfigurationSchemaView {
  return {
    schemaId: 'openloader-advanced-options',
    resourceId: 'openloader-advanced-options',
    definitionVersion: '1.0.0',
    definitionSha256: 'a'.repeat(64),
    codecId: 'openloader-advanced-options-v1',
    applyMode: 'offline-only',
    maximumBytes: 4_096,
    restartRequired: true,
    registered: true,
    fields: [
      { name: 'dataPacks.enabled', type: 'boolean', restartRequired: true, readable: true },
      { name: 'resourcePacks.enabled', type: 'boolean', restartRequired: true, readable: true },
    ],
    ...overrides,
  };
}

function state(
  overrides: Partial<ConfigurationResourceStateView> = {},
): ConfigurationResourceStateView {
  return {
    resourceId: 'openloader-advanced-options',
    status: 'applied',
    currentSha256: 'b'.repeat(64),
    stateVersion: 3,
    updatedAt: '2026-08-04T12:00:00.000Z',
    pendingRevisionId: null,
    lastAppliedRevisionId: 'cfg-0002',
    restartRequired: true,
    valuesAvailable: true,
    values: [
      { name: 'dataPacks.enabled', redacted: false, value: true },
      { name: 'resourcePacks.enabled', redacted: false, value: true },
    ],
    ...overrides,
  };
}

function revision(overrides: Partial<ConfigurationRevisionView> = {}): ConfigurationRevisionView {
  return {
    revisionId: 'cfg-0001',
    operation: 'update',
    status: 'applied',
    changedFields: ['dataPacks.enabled'],
    restartRequired: true,
    reasonCode: 'operator-request',
    failureCode: null,
    rollbackEligible: true,
    createdAt: '2026-08-04T11:00:00.000Z',
    completedAt: '2026-08-04T11:00:05.000Z',
    ...overrides,
  };
}

describe('configuration screen permissions', () => {
  it('maps each permission to exactly one capability', () => {
    assert.deepEqual(capabilitiesFor(OWNER_PERMISSIONS), {
      canView: true,
      canValidate: true,
      canApply: true,
      canRollback: true,
    });
    assert.deepEqual(capabilitiesFor(['configuration.view']), {
      canView: true,
      canValidate: false,
      canApply: false,
      canRollback: false,
    });
    assert.deepEqual(capabilitiesFor(['dashboard.view', 'server.view']), {
      canView: false,
      canValidate: false,
      canApply: false,
      canRollback: false,
    });
  });

  it('shows the denied state instead of a read-only form without view permission', () => {
    const screen = buildConfigurationScreen({
      schema: schema(),
      state: state(),
      revisions: [revision()],
      permissions: ['dashboard.view'],
    });
    assert.equal(screen.kind, 'denied');
  });

  it('offers no editable field or rollback candidate without the matching permission', () => {
    const screen = buildConfigurationScreen({
      schema: schema(),
      state: state(),
      revisions: [revision()],
      permissions: ['configuration.view'],
    });
    assert.equal(screen.kind, 'ready');
    if (screen.kind !== 'ready') return;
    assert.deepEqual(screen.editableFields, []);
    assert.deepEqual(screen.rollbackCandidates, []);
    assert.equal(screen.capabilities.canApply, false);
  });

  it('lists only eligible revisions as rollback candidates', () => {
    const screen = buildConfigurationScreen({
      schema: schema(),
      state: state(),
      revisions: [
        revision({ revisionId: 'cfg-0001', rollbackEligible: true }),
        revision({ revisionId: 'cfg-0002', rollbackEligible: false }),
        revision({
          revisionId: 'cfg-0003',
          status: 'failed',
          rollbackEligible: false,
          failureCode: 'verification-failed',
          changedFields: null,
          restartRequired: null,
        }),
      ],
      permissions: OWNER_PERMISSIONS,
    });
    assert.equal(screen.kind, 'ready');
    if (screen.kind !== 'ready') return;
    assert.deepEqual(
      screen.rollbackCandidates.map((candidate) => candidate.revisionId),
      ['cfg-0001'],
    );
  });
});

describe('configuration screen states', () => {
  it('reports the empty state for an unregistered resource', () => {
    assert.equal(
      buildConfigurationScreen({
        schema: schema({ registered: false }),
        state: undefined,
        revisions: [],
        permissions: OWNER_PERMISSIONS,
      }).kind,
      'empty',
    );
    assert.equal(
      buildConfigurationScreen({
        schema: undefined,
        state: undefined,
        revisions: [],
        permissions: OWNER_PERMISSIONS,
      }).kind,
      'empty',
    );
  });

  it('shows restart strictly as metadata and never as an action', () => {
    const screen = buildConfigurationScreen({
      schema: schema(),
      state: state(),
      revisions: [],
      permissions: OWNER_PERMISSIONS,
    });
    assert.equal(screen.kind, 'ready');
    if (screen.kind !== 'ready') return;
    assert.match(screen.restartNotice ?? '', /reinício do Minecraft/u);
    assert.match(screen.restartNotice ?? '', /não reinicia/u);
    // The screen exposes no restart, start or stop affordance at all.
    assert.equal(Object.keys(screen).some((key) => /restartAction|canRestart/u.test(key)), false);
  });

  it('warns when values are unavailable and blocks the screen while an operation runs', () => {
    const unavailable = buildConfigurationScreen({
      schema: schema(),
      state: state({ valuesAvailable: false, values: [] }),
      revisions: [],
      permissions: OWNER_PERMISSIONS,
    });
    assert.equal(unavailable.kind, 'ready');
    if (unavailable.kind !== 'ready') return;
    assert.match(unavailable.valuesNotice ?? '', /leitor autorizado/u);

    const busy = buildConfigurationScreen({
      schema: schema(),
      state: state({ status: 'prepared', pendingRevisionId: 'cfg-0004' }),
      revisions: [],
      permissions: OWNER_PERMISSIONS,
    });
    assert.equal(busy.kind, 'ready');
    if (busy.kind !== 'ready') return;
    assert.match(busy.busyNotice ?? '', /em andamento/u);
  });

  it('maps each API failure onto a distinct, sanitized screen state', () => {
    assert.equal(screenStateForError(401).kind, 'denied');
    assert.equal(screenStateForError(403).kind, 'denied');
    assert.equal(screenStateForError(404).kind, 'empty');
    const stale = screenStateForError(409, 'CONFIGURATION_STATE_STALE');
    assert.equal(stale.kind, 'conflict');
    assert.match(stale.kind === 'conflict' ? stale.message : '', /Recarregue/u);
    assert.equal(screenStateForError(422, 'CONFIGURATION_CHANGES_INVALID').kind, 'error');
    assert.equal(screenStateForError(500).kind, 'error');

    // No mapped message leaks a path, a host or an internal detail.
    for (const status of [401, 403, 404, 409, 422, 500, 503]) {
      const mapped = screenStateForError(status);
      const message = 'message' in mapped ? mapped.message : '';
      assert.equal(/[A-Z]:\\|\/home\/|node_modules|Error:/u.test(message), false);
    }
  });
});

describe('safe configuration diff', () => {
  it('diffs only readable fields that actually change', () => {
    const diff = computeSafeDiff(schema(), state(), {
      'dataPacks.enabled': false,
      'resourcePacks.enabled': true,
    });
    assert.deepEqual(diff.entries, [
      { name: 'dataPacks.enabled', from: true, to: false, restartRequired: true },
    ]);
    assert.equal(diff.hasChanges, true);
    assert.equal(diff.restartRequired, true);
    assert.deepEqual(diff.undiffableFields, []);
    assert.deepEqual(changeEntriesFor(diff), [{ name: 'dataPacks.enabled', value: false }]);
  });

  it('never renders or diffs a redacted value', () => {
    const redacted = state({
      values: [
        { name: 'dataPacks.enabled', redacted: false, value: true },
        { name: 'resourcePacks.enabled', redacted: true },
      ],
    });
    const diff = computeSafeDiff(schema(), redacted, {
      'dataPacks.enabled': false,
      'resourcePacks.enabled': false,
    });

    assert.deepEqual(
      diff.entries.map((entry) => entry.name),
      ['dataPacks.enabled'],
    );
    assert.deepEqual(diff.undiffableFields, ['resourcePacks.enabled']);
    // A redacted field is excluded from what would be sent, too.
    assert.deepEqual(changeEntriesFor(diff), [{ name: 'dataPacks.enabled', value: false }]);
    assert.equal(displayValue({ name: 'resourcePacks.enabled', redacted: true }), 'Redigido');
  });

  it('treats every field as undiffable when no value could be read', () => {
    const diff = computeSafeDiff(schema(), state({ valuesAvailable: false, values: [] }), {
      'dataPacks.enabled': false,
    });
    assert.deepEqual(diff.entries, []);
    assert.equal(diff.hasChanges, false);
    assert.deepEqual(diff.undiffableFields, ['dataPacks.enabled']);
    assert.deepEqual(changeEntriesFor(diff), []);
  });

  it('ignores a field the reviewed schema does not declare', () => {
    const diff = computeSafeDiff(schema(), state(), {
      'dataPacks.enabled': false,
      'rcon.password': 'super-secret',
    });
    assert.deepEqual(
      diff.entries.map((entry) => entry.name),
      ['dataPacks.enabled'],
    );
    assert.equal(JSON.stringify(diff).includes('super-secret'), false);
    assert.equal(JSON.stringify(changeEntriesFor(diff)).includes('super-secret'), false);
  });

  it('renders booleans as words and never exposes a path', () => {
    assert.equal(displayValue({ name: 'dataPacks.enabled', redacted: false, value: true }), 'Ativado');
    assert.equal(displayValue({ name: 'dataPacks.enabled', redacted: false, value: false }), 'Desativado');
    const screen = buildConfigurationScreen({
      schema: schema(),
      state: state(),
      revisions: [revision()],
      permissions: OWNER_PERMISSIONS,
    });
    const serialized = JSON.stringify(screen);
    assert.equal(serialized.includes('config/openloader'), false);
    assert.equal(serialized.includes('advanced_options.json'), false);
    assert.equal(serialized.includes('filePath'), false);
  });
});
