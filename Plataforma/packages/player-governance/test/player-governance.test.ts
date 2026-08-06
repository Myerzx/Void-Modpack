import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlayerDataPolicy } from '@voidfall/contracts';
import {
  MinecraftPermissionRegistry,
  ModerationCaseRegistry,
  PlayerDataPolicyEngine,
  PlayerGovernanceError,
  PlayerProfileRegistry,
  type MinecraftPermissionProvider,
  type ModerationExecutor,
} from '../src/index.js';

const playerUuid = '018f6b8c-76a3-7d10-9f2e-1d9e52a63701';
/** The stable subject. A profile and a case are about this, not about a name. */
const identityUuid = '018f6b8c-76a3-7d10-9f2e-1d9e52a63721';
const claimUuid = '018f6b8c-76a3-7d10-9f2e-1d9e52a63722';
const incidentContext = {
  claimId: claimUuid,
  minecraftUuid: playerUuid,
  minecraftName: 'Void_Player',
} as const;
const serverUuid = '018f6b8c-76a3-7d10-9f2e-1d9e52a63702';
const actorUuid = '018f6b8c-76a3-7d10-9f2e-1d9e52a63703';
const bindingUuid = '018f6b8c-76a3-7d10-9f2e-1d9e52a63704';
const caseUuid = '018f6b8c-76a3-7d10-9f2e-1d9e52a63705';
const op1 = '018f6b8c-76a3-7d10-9f2e-1d9e52a63711';
const op2 = '018f6b8c-76a3-7d10-9f2e-1d9e52a63712';
const op3 = '018f6b8c-76a3-7d10-9f2e-1d9e52a63713';
const actor = { type: 'panel-user' as const, id: actorUuid };
const options = { maximumRecords: 100, maximumReplays: 100 };

function assertCode(block: () => unknown, code: PlayerGovernanceError['code']): void {
  assert.throws(block, (error: unknown) => {
    assert.ok(error instanceof PlayerGovernanceError);
    assert.equal(error.code, code);
    return true;
  });
}

describe('UUID player profiles and aliases', () => {
  it('creates a UUID profile, merges aliases case-insensitively and replays idempotently', () => {
    const registry = new PlayerProfileRegistry({ ...options, maximumAliasesPerProfile: 4 });
    const plan = {
      operationId: op1,
      identityId: identityUuid,
      expectedRevision: null,
      alias: 'Void_Player',
      source: 'forge-bridge' as const,
      serverInstanceId: serverUuid,
      observedAt: '2026-08-03T12:00:00.000Z',
    };
    const first = registry.observeAlias(plan);
    assert.deepEqual(registry.observeAlias(plan), first);
    const updated = registry.observeAlias({
      ...plan,
      operationId: op2,
      expectedRevision: 1,
      alias: 'VOID_PLAYER',
      observedAt: '2026-08-03T12:05:00.000Z',
    });
    assert.equal(updated.identityId, identityUuid);
    assert.equal(updated.revision, 2);
    assert.equal(updated.aliases.length, 1);
    assert.equal(updated.aliases[0]?.observationCount, 2);
    assert.equal(updated.aliases[0]?.normalizedName, 'void_player');
    assert.equal(Object.isFrozen(updated), true);
  });

  it('enforces revisions, alias limits and inactive-profile protection', () => {
    const registry = new PlayerProfileRegistry({ ...options, maximumAliasesPerProfile: 1 });
    registry.observeAlias({
      operationId: op1,
      identityId: identityUuid,
      expectedRevision: null,
      alias: 'Player_One',
      source: 'manual-review',
      serverInstanceId: serverUuid,
      observedAt: '2026-08-03T12:00:00.000Z',
    });
    assertCode(
      () =>
        registry.observeAlias({
          operationId: op2,
          identityId: identityUuid,
          expectedRevision: 1,
          alias: 'Player_Two',
          source: 'manual-review',
          serverInstanceId: serverUuid,
          observedAt: '2026-08-03T12:01:00.000Z',
        }),
      'alias-limit-exceeded',
    );
    const retired = registry.changeStatus({
      operationId: op3,
      identityId: identityUuid,
      serverInstanceId: serverUuid,
      expectedRevision: 1,
      status: 'retired',
      actor,
      reason: 'Reviewed lifecycle change.',
      changedAt: '2026-08-03T12:02:00.000Z',
    });
    assert.equal(retired.status, 'retired');
    assertCode(
      () =>
        registry.observeAlias({
          operationId: op2,
          identityId: identityUuid,
          expectedRevision: 2,
          alias: 'Player_One',
          source: 'manual-review',
          serverInstanceId: serverUuid,
          observedAt: '2026-08-03T12:03:00.000Z',
        }),
      'profile-not-active',
    );
  });

  it('rejects reuse of an operation ID with different content', () => {
    const registry = new PlayerProfileRegistry({ ...options, maximumAliasesPerProfile: 4 });
    const plan = {
      operationId: op1,
      identityId: identityUuid,
      expectedRevision: null,
      alias: 'Player_One',
      source: 'manual-review' as const,
      serverInstanceId: serverUuid,
      observedAt: '2026-08-03T12:00:00.000Z',
    };
    registry.observeAlias(plan);
    assertCode(() => registry.observeAlias({ ...plan, alias: 'Player_Two' }), 'operation-conflict');
  });
});

describe('provider-neutral Minecraft permissions', () => {
  const setPlan = {
    operationId: op1,
    bindingId: bindingUuid,
    playerUuid,
    serverInstanceId: serverUuid,
    expectedRevision: null,
    groups: ['player', 'moderator'],
    requestedBy: actor,
    reason: 'Reviewed gameplay moderation role.',
    requestedAt: '2026-08-03T12:00:00.000Z',
  } as const;

  it('stores desired groups separately and denies when no provider exists', async () => {
    const registry = new MinecraftPermissionRegistry(options);
    const pending = registry.setGroups(setPlan);
    assert.deepEqual(pending.groups, ['moderator', 'player']);
    const sync = await registry.synchronize({
      operationId: op2,
      bindingId: bindingUuid,
      expectedRevision: 1,
      attemptedAt: '2026-08-03T12:01:00.000Z',
    });
    assert.equal(sync.attempted, false);
    assert.equal(sync.reason, 'provider-unavailable');
    const permission = await registry.checkPermission({
      playerUuid,
      serverInstanceId: serverUuid,
      permissionNode: 'void.modpack.build.request',
      checkedAt: '2026-08-03T12:01:00.000Z',
    });
    assert.deepEqual(permission, { allowed: false, reason: 'provider-unavailable' });
  });

  it('accepts only a correlated provider receipt and preserves deny decisions', async () => {
    const provider: MinecraftPermissionProvider = {
      providerId: 'fixture-provider',
      synchronizeGroups: async (request) => ({
        providerId: 'fixture-provider',
        bindingId: request.bindingId,
        bindingRevision: request.bindingRevision,
        playerUuid: request.playerUuid,
        serverInstanceId: request.serverInstanceId,
        outcome: 'succeeded',
        attemptedAt: '2026-08-03T12:01:00.000Z',
        receiptId: 'sync-fixture-1',
      }),
      checkPermission: async (request) => ({
        ...request,
        providerId: 'fixture-provider',
        allowed: false,
        receiptId: 'check-fixture-1',
      }),
    };
    const registry = new MinecraftPermissionRegistry(options, provider);
    registry.setGroups(setPlan);
    const sync = await registry.synchronize({
      operationId: op2,
      bindingId: bindingUuid,
      expectedRevision: 1,
      attemptedAt: '2026-08-03T12:01:00.000Z',
    });
    assert.equal(sync.attempted, true);
    assert.equal(sync.binding.status, 'synchronized');
    assert.equal(sync.binding.revision, 2);
    const permission = await registry.checkPermission({
      playerUuid,
      serverInstanceId: serverUuid,
      permissionNode: 'void.modpack.build.request',
      checkedAt: '2026-08-03T12:02:00.000Z',
    });
    assert.equal(permission.allowed, false);
    assert.equal(permission.reason, 'denied');
  });

  it('rejects desired state without the baseline player group', () => {
    const registry = new MinecraftPermissionRegistry(options);
    assertCode(() => registry.setGroups({ ...setPlan, groups: ['moderator'] }), 'invalid-groups');
  });
});

describe('typed moderation cases', () => {
  const requestPlan = {
    operationId: op1,
    caseId: caseUuid,
    subjectIdentityId: identityUuid,
    incidentContext,
    serverInstanceId: serverUuid,
    action: 'temporary-ban' as const,
    reasonCode: 'abuse-review',
    reason: 'Reviewed fixture reason.',
    requestedBy: actor,
    requestedAt: '2026-08-03T12:00:00.000Z',
    expiresAt: '2026-08-04T12:00:00.000Z',
  };

  it('leaves a requested case unchanged when no executor is configured', async () => {
    const registry = new ModerationCaseRegistry(options);
    registry.request(requestPlan);
    const decision = await registry.execute({
      operationId: op2,
      caseId: caseUuid,
      expectedRevision: 1,
      attemptedAt: '2026-08-03T12:01:00.000Z',
    });
    assert.equal(decision.attempted, false);
    assert.equal(decision.reason, 'executor-unavailable');
    assert.equal(registry.find(caseUuid)?.status, 'requested');
  });

  it('applies through a typed executor and expires a temporary sanction', async () => {
    const executor: ModerationExecutor = {
      executorId: 'fixture-executor',
      apply: async (request) => ({
        executorId: 'fixture-executor',
        caseId: request.caseId,
        caseRevision: request.caseRevision,
        outcome: 'succeeded',
        attemptedAt: '2026-08-03T12:01:00.000Z',
        receiptId: 'moderation-fixture-1',
      }),
    };
    const registry = new ModerationCaseRegistry(options, executor);
    registry.request(requestPlan);
    const applied = await registry.execute({
      operationId: op2,
      caseId: caseUuid,
      expectedRevision: 1,
      attemptedAt: '2026-08-03T12:01:00.000Z',
    });
    assert.equal(applied.attempted, true);
    assert.equal(applied.moderationCase.status, 'applied');
    const expired = registry.expire(caseUuid, 2, '2026-08-04T12:00:00.000Z');
    assert.equal(expired.status, 'expired');
    assert.equal(expired.revision, 3);
  });

  it('requires expiry for temporary actions and refuses to revoke historical kicks', async () => {
    const registry = new ModerationCaseRegistry(options, {
      executorId: 'fixture-executor',
      apply: async (request) => ({
        executorId: 'fixture-executor',
        caseId: request.caseId,
        caseRevision: request.caseRevision,
        outcome: 'succeeded',
        attemptedAt: '2026-08-03T12:01:00.000Z',
        receiptId: 'moderation-fixture-2',
      }),
    });
    const { expiresAt: _expiry, ...withoutExpiry } = requestPlan;
    assertCode(() => registry.request(withoutExpiry), 'invalid-operation');
    registry.request({ ...withoutExpiry, action: 'kick' });
    await registry.execute({
      operationId: op2,
      caseId: caseUuid,
      expectedRevision: 1,
      attemptedAt: '2026-08-03T12:01:00.000Z',
    });
    assertCode(
      () =>
        registry.revoke({
          operationId: op3,
          caseId: caseUuid,
          expectedRevision: 2,
          revokedAt: '2026-08-03T12:02:00.000Z',
          actor,
          reason: 'Fixture revocation request.',
        }),
      'case-not-actionable',
    );
  });
});

function approvedPolicy(): PlayerDataPolicy {
  return {
    schemaVersion: 1,
    policyId: 'player-safety',
    revision: 1,
    status: 'approved',
    purposeCode: 'moderation-safety',
    purpose: 'Support proportionate moderation review.',
    createdAt: '2026-08-03T10:00:00.000Z',
    updatedAt: '2026-08-03T10:05:00.000Z',
    approvedBy: actor,
    approvedAt: '2026-08-03T10:03:00.000Z',
    effectiveAt: '2026-08-03T10:04:00.000Z',
    rules: [
      {
        category: 'activity',
        collection: 'allowed',
        maximumRetentionSeconds: 3_600,
        viewPermission: 'player.activity.sensitive',
        export: 'disabled',
      },
      {
        category: 'chat',
        collection: 'disabled',
        viewPermission: 'player.activity.sensitive',
        export: 'disabled',
      },
      {
        category: 'coordinates',
        collection: 'disabled',
        viewPermission: 'player.activity.sensitive',
        export: 'disabled',
      },
    ],
  };
}

describe('player-data privacy decisions', () => {
  it('denies every category without an approved policy', () => {
    const engine = new PlayerDataPolicyEngine();
    const decision = engine.decide({
      operation: 'collect',
      category: 'activity',
      purposeCode: 'moderation-safety',
      evaluatedAt: '2026-08-03T12:00:00.000Z',
      observedAt: '2026-08-03T12:00:00.000Z',
    });
    assert.deepEqual(decision, { allowed: false, reason: 'policy-unavailable' });
  });

  it('calculates retention but never receives a sensitive payload', () => {
    const engine = new PlayerDataPolicyEngine(approvedPolicy());
    const decision = engine.decide({
      operation: 'collect',
      category: 'activity',
      purposeCode: 'moderation-safety',
      evaluatedAt: '2026-08-03T12:00:00.000Z',
      observedAt: '2026-08-03T12:00:00.000Z',
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.retentionExpiresAt, '2026-08-03T13:00:00.000Z');
    assert.equal(
      engine.decide({
        operation: 'collect',
        category: 'chat',
        purposeCode: 'moderation-safety',
        evaluatedAt: '2026-08-03T12:00:00.000Z',
        observedAt: '2026-08-03T12:00:00.000Z',
      }).reason,
      'collection-disabled',
    );
  });

  it('requires sensitive permission, retention and separate export approval', () => {
    const engine = new PlayerDataPolicyEngine(approvedPolicy());
    const recordWindow = {
      operation: 'view' as const,
      category: 'activity' as const,
      purposeCode: 'moderation-safety',
      evaluatedAt: '2026-08-03T12:30:00.000Z',
      observedAt: '2026-08-03T12:00:00.000Z',
      retentionExpiresAt: '2026-08-03T13:00:00.000Z',
    };
    assert.equal(engine.decide(recordWindow).reason, 'permission-denied');
    assert.equal(
      engine.decide({
        ...recordWindow,
        grantedPanelPermissions: ['player.activity.sensitive'],
      }).allowed,
      true,
    );
    assert.equal(
      engine.decide({
        ...recordWindow,
        operation: 'export',
        grantedPanelPermissions: ['player.activity.sensitive'],
      }).reason,
      'export-disabled',
    );
    assert.equal(
      engine.decide({
        ...recordWindow,
        evaluatedAt: '2026-08-03T13:00:00.000Z',
        grantedPanelPermissions: ['player.activity.sensitive'],
      }).reason,
      'retention-expired',
    );
  });
});
