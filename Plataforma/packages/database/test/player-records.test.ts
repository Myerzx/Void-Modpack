import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { ActorRef } from '@voidfall/contracts';
import { PlayerIdentityPersistenceError, createRepositories, runMigrations } from '../src/index.js';
import { createPGliteTestDatabase } from '../src/testing.js';

/**
 * Profiles and moderation cases, keyed on the identity.
 *
 * The property under test: a punishment survives everything that moves the
 * account. A rename changes the offline UUID, a rebind changes the claim, and
 * neither may hide a case.
 */

const NOW = new Date('2026-08-06T12:00:00.000Z');
const SYSTEM: ActorRef = { type: 'system', id: 'phase-11-import' };
const MODERATOR: ActorRef = { type: 'panel-user', id: '018f6b8c-76a3-7d10-9f2e-1d9e52a63741' };

async function fixture() {
  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'voidfall-records-test',
    displayName: 'VoidFall Records Test',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '1.20.1-47.4.4',
    maxPlayers: 20,
  });
  const identityId = randomUUID();
  await repositories.playerIdentities.createIdentity({
    identityId,
    createdBy: SYSTEM,
    now: NOW,
  });
  return { database, repositories, serverId: server.id, identityId };
}

function incident(name = 'Void_Player') {
  return {
    claimId: randomUUID(),
    minecraftUuid: randomUUID(),
    minecraftName: name,
  };
}

describe('player profiles and moderation cases', () => {
  it('creates one profile per identity per server, idempotently', async () => {
    const { database, repositories, serverId, identityId } = await fixture();
    try {
      const first = await repositories.playerRecords.ensureProfile({
        identityId,
        serverInstanceId: serverId,
        now: NOW,
      });
      const second = await repositories.playerRecords.ensureProfile({
        identityId,
        serverInstanceId: serverId,
        now: new Date(NOW.getTime() + 1_000),
      });
      assert.equal(first.revision, 1);
      // A second sighting is not a second profile, and it does not bump a
      // revision nobody changed anything to earn.
      assert.deepEqual(second, first);
    } finally {
      await database.close();
    }
  });

  it('keeps a case attached to the person after a rename moves the account', async () => {
    const { database, repositories, serverId, identityId } = await fixture();
    try {
      const before = incident('Void_Player');
      await repositories.playerRecords.openCase({
        caseId: randomUUID(),
        subjectIdentityId: identityId,
        serverInstanceId: serverId,
        incidentContext: before,
        action: 'permanent-ban',
        reasonCode: 'abuse-review',
        reason: 'Reviewed fixture reason.',
        requestedBy: MODERATOR,
        expiresAt: null,
        now: NOW,
      });

      // The same person, later, on a different account with a different name.
      const after = incident('Someone_Else');
      await repositories.playerRecords.openCase({
        caseId: randomUUID(),
        subjectIdentityId: identityId,
        serverInstanceId: serverId,
        incidentContext: after,
        action: 'warning',
        reasonCode: 'abuse-review',
        reason: 'Reviewed fixture reason.',
        requestedBy: MODERATOR,
        expiresAt: null,
        now: new Date(NOW.getTime() + 86_400_000),
      });

      const cases = await repositories.playerRecords.listCasesForSubject({
        subjectIdentityId: identityId,
      });
      // Both, because the subject never changed. Keyed on the account, the
      // first would have vanished the moment they renamed.
      assert.equal(cases.length, 2);
      assert.deepEqual(
        cases.map((entry) => entry.incidentContext.minecraftName).sort(),
        ['Someone_Else', 'Void_Player'],
      );
    } finally {
      await database.close();
    }
  });

  it('keeps the incident context readable after the claim is gone', async () => {
    const { database, repositories, serverId, identityId } = await fixture();
    try {
      const context = incident();
      const caseId = randomUUID();
      await repositories.playerRecords.openCase({
        caseId,
        subjectIdentityId: identityId,
        serverInstanceId: serverId,
        incidentContext: context,
        action: 'permanent-ban',
        reasonCode: 'abuse-review',
        reason: 'Reviewed fixture reason.',
        requestedBy: MODERATOR,
        expiresAt: null,
        now: NOW,
      });

      // The claim id in the context is not a foreign key, so a case stays
      // readable after the claim it names has been revoked and removed — which
      // is exactly when somebody is most likely to be reading it.
      const [stored] = await repositories.playerRecords.listCasesForSubject({
        subjectIdentityId: identityId,
      });
      assert.equal(stored?.incidentContext.claimId, context.claimId);
      assert.equal(stored?.incidentContext.minecraftUuid, context.minecraftUuid);
    } finally {
      await database.close();
    }
  });

  it('refuses a temporary ban with no end and a permanent one with an end', async () => {
    const { database, repositories, serverId, identityId } = await fixture();
    try {
      const base = {
        subjectIdentityId: identityId,
        serverInstanceId: serverId,
        incidentContext: incident(),
        reasonCode: 'abuse-review',
        reason: 'Reviewed fixture reason.',
        requestedBy: MODERATOR,
        now: NOW,
      };
      // A temporary ban that never ends is a permanent one nobody decided on.
      await assert.rejects(
        repositories.playerRecords.openCase({
          ...base,
          caseId: randomUUID(),
          action: 'temporary-ban',
          expiresAt: null,
        }),
        (error: unknown) => error instanceof PlayerIdentityPersistenceError,
      );
      // And a permanent ban with an end date is a temporary one nobody reviewed.
      await assert.rejects(
        repositories.playerRecords.openCase({
          ...base,
          caseId: randomUUID(),
          action: 'permanent-ban',
          expiresAt: new Date(NOW.getTime() + 86_400_000),
        }),
        (error: unknown) => error instanceof PlayerIdentityPersistenceError,
      );
    } finally {
      await database.close();
    }
  });

  it('refuses a case against a subject that does not exist', async () => {
    const { database, repositories, serverId } = await fixture();
    try {
      // There is no legacy nullable subject, so an unknown one is refused
      // rather than stored as an anonymous case.
      await assert.rejects(
        repositories.playerRecords.openCase({
          caseId: randomUUID(),
          subjectIdentityId: randomUUID(),
          serverInstanceId: serverId,
          incidentContext: incident(),
          action: 'kick',
          reasonCode: 'abuse-review',
          reason: 'Reviewed fixture reason.',
          requestedBy: MODERATOR,
          expiresAt: null,
          now: NOW,
        }),
        (error: unknown) =>
          error instanceof PlayerIdentityPersistenceError && error.code === 'invalid-transition',
      );
    } finally {
      await database.close();
    }
  });

  it('settles a case once, against the revision it was read at', async () => {
    const { database, repositories, serverId, identityId } = await fixture();
    try {
      const caseId = randomUUID();
      const opened = await repositories.playerRecords.openCase({
        caseId,
        subjectIdentityId: identityId,
        serverInstanceId: serverId,
        incidentContext: incident(),
        action: 'kick',
        reasonCode: 'abuse-review',
        reason: 'Reviewed fixture reason.',
        requestedBy: MODERATOR,
        expiresAt: null,
        now: NOW,
      });
      assert.equal(opened.status, 'requested');

      const settled = await repositories.playerRecords.settleCase({
        caseId,
        expectedRevision: opened.revision,
        status: 'applied',
        // Not optional: a case that says it was applied without naming who
        // applied it and against what receipt is an assertion nobody can check.
        transition: {
          kind: 'applied',
          occurredAt: NOW.toISOString(),
          executorId: 'forge-bridge',
          receiptId: 'receipt-1',
        },
        now: NOW,
      });
      assert.equal(settled.status, 'applied');
      assert.equal(settled.revision, opened.revision + 1);
      assert.equal(settled.transition?.receiptId, 'receipt-1');

      // A second settle against the stale revision is refused, so two readers
      // cannot both believe they closed it.
      await assert.rejects(
        repositories.playerRecords.settleCase({
          caseId,
          expectedRevision: opened.revision,
          status: 'failed',
          transition: {
            kind: 'failed',
            occurredAt: NOW.toISOString(),
            executorId: 'forge-bridge',
            receiptId: 'receipt-2',
          },
          now: NOW,
        }),
        (error: unknown) =>
          error instanceof PlayerIdentityPersistenceError && error.code === 'invalid-transition',
      );
    } finally {
      await database.close();
    }
  });
});
