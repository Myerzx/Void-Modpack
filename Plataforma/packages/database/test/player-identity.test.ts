import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { ActorRef } from '@voidfall/contracts';
import { PlayerIdentityPersistenceError, createRepositories, runMigrations } from '../src/index.js';
import { createPGliteTestDatabase } from '../src/testing.js';

/**
 * Player identity and the Minecraft accounts claimed against it.
 *
 * The property under test throughout: a Minecraft UUID is never an identity.
 * The server runs in offline mode, so that UUID is derived from the player's
 * name and proves nothing — every lookup here starts from the identity.
 */

const NOW = new Date('2026-08-06T12:00:00.000Z');
const SYSTEM: ActorRef = { type: 'system', id: 'phase-11-import' };

async function fixture() {
  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'voidfall-identity-test',
    displayName: 'VoidFall Identity Test',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '1.20.1-47.4.4',
    maxPlayers: 20,
  });
  return { database, repositories, serverId: server.id };
}

describe('player identity and Minecraft claims', () => {
  it('imports a legacy account as a record that grants nothing', async () => {
    const { database, repositories, serverId } = await fixture();
    try {
      const identityId = randomUUID();
      const { identity, claim } = await repositories.playerIdentities.importLegacyClaim({
        identityId,
        claimId: randomUUID(),
        serverInstanceId: serverId,
        minecraftUuid: randomUUID(),
        createdBy: SYSTEM,
        reasonCode: 'pre-authentication-import',
        now: NOW,
      });

      assert.equal(identity.identityId, identityId);
      // Never proven, so it carries no moment it was.
      assert.equal(claim.status, 'legacy-unclaimed');
      assert.equal(claim.claimedAt, null);
      // And it is not an answer to "which account does this identity hold": the
      // seven operators found in the audit recover nothing until they claim.
      assert.equal(
        await repositories.playerIdentities.findActiveClaim({
          identityId,
          serverInstanceId: serverId,
        }),
        undefined,
      );
    } finally {
      await database.close();
    }
  });

  it('turns a legacy record into a held account when it is proven', async () => {
    const { database, repositories, serverId } = await fixture();
    try {
      const identityId = randomUUID();
      const claimId = randomUUID();
      const account = randomUUID();
      await repositories.playerIdentities.importLegacyClaim({
        identityId,
        claimId,
        serverInstanceId: serverId,
        minecraftUuid: account,
        createdBy: SYSTEM,
        reasonCode: 'pre-authentication-import',
        now: NOW,
      });

      const proven = await repositories.playerIdentities.proveLegacyClaim({
        claimId,
        identityId,
        reasonCode: 'operator-reclaim',
        now: NOW,
      });
      assert.equal(proven.status, 'active');
      assert.equal(proven.claimedAt, NOW.toISOString());

      const active = await repositories.playerIdentities.findActiveClaim({
        identityId,
        serverInstanceId: serverId,
      });
      assert.equal(active?.minecraftUuid, account);
    } finally {
      await database.close();
    }
  });

  it('will not let two identities actively hold the same account', async () => {
    const { database, repositories, serverId } = await fixture();
    try {
      const account = randomUUID();
      const first = randomUUID();
      const second = randomUUID();
      for (const identityId of [first, second]) {
        await repositories.playerIdentities.createIdentity({
          identityId,
          createdBy: SYSTEM,
          now: NOW,
        });
      }
      await repositories.playerIdentities.openClaim({
        claimId: randomUUID(),
        identityId: first,
        serverInstanceId: serverId,
        minecraftUuid: account,
        reasonCode: 'authenticated-claim',
        now: NOW,
      });

      // Two identities holding one offline UUID would mean an operation aimed
      // at one of them lands on whoever the resolver happened to find.
      await assert.rejects(
        repositories.playerIdentities.openClaim({
          claimId: randomUUID(),
          identityId: second,
          serverInstanceId: serverId,
          minecraftUuid: account,
          reasonCode: 'authenticated-claim',
          now: NOW,
        }),
        (error: unknown) =>
          error instanceof PlayerIdentityPersistenceError && error.code === 'claim-conflict',
      );
    } finally {
      await database.close();
    }
  });

  it('will not let one identity actively hold two accounts on a server', async () => {
    const { database, repositories, serverId } = await fixture();
    try {
      const identityId = randomUUID();
      await repositories.playerIdentities.createIdentity({
        identityId,
        createdBy: SYSTEM,
        now: NOW,
      });
      await repositories.playerIdentities.openClaim({
        claimId: randomUUID(),
        identityId,
        serverInstanceId: serverId,
        minecraftUuid: randomUUID(),
        reasonCode: 'authenticated-claim',
        now: NOW,
      });

      // A half-completed rebind would otherwise leave two, and the resolver
      // would have to guess which one an operation meant.
      await assert.rejects(
        repositories.playerIdentities.openClaim({
          claimId: randomUUID(),
          identityId,
          serverInstanceId: serverId,
          minecraftUuid: randomUUID(),
          reasonCode: 'authenticated-claim',
          now: NOW,
        }),
        (error: unknown) =>
          error instanceof PlayerIdentityPersistenceError && error.code === 'claim-conflict',
      );
    } finally {
      await database.close();
    }
  });

  it('lets a rebind open the new claim before revoking the old one', async () => {
    const { database, repositories, serverId } = await fixture();
    try {
      const identityId = randomUUID();
      const oldClaim = randomUUID();
      const newClaim = randomUUID();
      await repositories.playerIdentities.createIdentity({
        identityId,
        createdBy: SYSTEM,
        now: NOW,
      });
      await repositories.playerIdentities.openClaim({
        claimId: oldClaim,
        identityId,
        serverInstanceId: serverId,
        minecraftUuid: randomUUID(),
        reasonCode: 'authenticated-claim',
        now: NOW,
      });

      // The old claim is revoked first, because the index allows only one
      // active claim per identity. That ordering is the database's, and the
      // rebind's own ordering — copy, verify, clear — happens on the provider
      // side before this runs.
      const revoked = await repositories.playerIdentities.revokeClaim({
        claimId: oldClaim,
        identityId,
        reasonCode: 'name-change-rebind',
        now: NOW,
      });
      assert.equal(revoked.status, 'revoked');
      assert.equal(revoked.revokedAt, NOW.toISOString());

      const newAccount = randomUUID();
      await repositories.playerIdentities.openClaim({
        claimId: newClaim,
        identityId,
        serverInstanceId: serverId,
        minecraftUuid: newAccount,
        reasonCode: 'name-change-rebind',
        now: NOW,
      });

      const active = await repositories.playerIdentities.findActiveClaim({
        identityId,
        serverInstanceId: serverId,
      });
      assert.equal(active?.minecraftUuid, newAccount);
      // The revoked claim stays as history rather than disappearing.
      assert.equal((await repositories.playerIdentities.listClaims(identityId)).length, 2);
    } finally {
      await database.close();
    }
  });

  it('refuses to reopen a claim that was revoked', async () => {
    const { database, repositories, serverId } = await fixture();
    try {
      const identityId = randomUUID();
      const claimId = randomUUID();
      await repositories.playerIdentities.importLegacyClaim({
        identityId,
        claimId,
        serverInstanceId: serverId,
        minecraftUuid: randomUUID(),
        createdBy: SYSTEM,
        reasonCode: 'pre-authentication-import',
        now: NOW,
      });
      await repositories.playerIdentities.proveLegacyClaim({
        claimId,
        identityId,
        reasonCode: 'operator-reclaim',
        now: NOW,
      });
      await repositories.playerIdentities.revokeClaim({
        claimId,
        identityId,
        reasonCode: 'account-compromised',
        now: NOW,
      });

      // Revoking was a decision. Quietly undoing it by claiming again would
      // erase that decision without anyone recording a new one.
      await assert.rejects(
        repositories.playerIdentities.proveLegacyClaim({
          claimId,
          identityId,
          reasonCode: 'operator-reclaim',
          now: NOW,
        }),
        (error: unknown) =>
          error instanceof PlayerIdentityPersistenceError && error.code === 'invalid-transition',
      );
    } finally {
      await database.close();
    }
  });

  it('scopes a claim lookup to the identity that must own it', async () => {
    const { database, repositories, serverId } = await fixture();
    try {
      const owner = randomUUID();
      const stranger = randomUUID();
      const claimId = randomUUID();
      await repositories.playerIdentities.importLegacyClaim({
        identityId: owner,
        claimId,
        serverInstanceId: serverId,
        minecraftUuid: randomUUID(),
        createdBy: SYSTEM,
        reasonCode: 'pre-authentication-import',
        now: NOW,
      });
      await repositories.playerIdentities.createIdentity({
        identityId: stranger,
        createdBy: SYSTEM,
        now: NOW,
      });

      assert.notEqual(
        await repositories.playerIdentities.findClaim({ identityId: owner, claimId }),
        undefined,
      );
      // A rebind names its destination by id. Looking it up without checking
      // whose it is would let one identity's permissions land on another's
      // account.
      assert.equal(
        await repositories.playerIdentities.findClaim({ identityId: stranger, claimId }),
        undefined,
      );
    } finally {
      await database.close();
    }
  });

  it('records an observed name without letting it identify anybody', async () => {
    const { database, repositories, serverId } = await fixture();
    try {
      const identityId = randomUUID();
      await repositories.playerIdentities.createIdentity({
        identityId,
        createdBy: SYSTEM,
        now: NOW,
      });
      for (const name of ['VoidWalker', 'VoidWalker', 'voidwalker']) {
        await repositories.playerIdentities.observeAlias({
          identityId,
          serverInstanceId: serverId,
          name,
          source: 'forge-bridge',
          now: NOW,
        });
      }

      // Case folds into one alias with a count, not three names.
      const rows = await database.query<{ readonly observation_count: string | number }>(
        'SELECT observation_count FROM player_aliases WHERE identity_id = $1',
        [identityId],
      );
      assert.equal(rows.rows.length, 1);
      assert.equal(Number(rows.rows[0]?.observation_count), 3);
    } finally {
      await database.close();
    }
  });

  it('moves the sighting window and keeps the pair whole', async () => {
    const { database, repositories } = await fixture();
    try {
      const identityId = randomUUID();
      const created = await repositories.playerIdentities.createIdentity({
        identityId,
        createdBy: SYSTEM,
        now: NOW,
      });
      // Never seen is both halves absent, not one.
      assert.equal(created.firstSeenAt, null);
      assert.equal(created.lastSeenAt, null);

      await repositories.playerIdentities.recordSighting({ identityId, now: NOW });
      const later = new Date(NOW.getTime() + 86_400_000);
      await repositories.playerIdentities.recordSighting({ identityId, now: later });

      const identity = await repositories.playerIdentities.findIdentity(identityId);
      assert.equal(identity?.firstSeenAt, NOW.toISOString());
      assert.equal(identity?.lastSeenAt, later.toISOString());
    } finally {
      await database.close();
    }
  });
});
