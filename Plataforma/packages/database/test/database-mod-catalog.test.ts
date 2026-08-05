import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { hashPassword } from '@voidfall/authentication';
import {
  OPENLOADER_ADVANCED_OPTIONS_V1,
  hashConfigurationSchema,
} from '@voidfall/configuration-schemas';
import type {
  ActorRef,
  AuditEvent,
  CompatibilityIssue,
  Job,
  ModCatalogEntry,
} from '@voidfall/contracts';
import { PANEL_PERMISSIONS, permissionsForRoles } from '@voidfall/permissions';
import {
  AgentTransportError,
  ArtifactReviewError,
  ConfigurationPersistenceError,
  ModCatalogPersistenceError,
  OperationalPersistenceError,
  createRepositories,
  runMigrations,
} from '../src/index.js';
import { createPGliteTestDatabase } from '../src/testing.js';

/**
 * Split out of the former single `database.test.ts`.
 *
 * That file created sixteen WASM Postgres instances in one process, which
 * intermittently tripped a V8 JIT page assertion on the Windows runner. The
 * Node test runner gives each *file* its own process, so splitting by concern
 * bounds how much WASM churn any one process sees. The tests themselves are
 * unchanged.
 */

describe('mod catalog persistence', () => {
  async function catalogFixture(): Promise<{
    readonly database: Awaited<ReturnType<typeof createPGliteTestDatabase>>;
    readonly repositories: ReturnType<typeof createRepositories>;
    readonly serverInstanceId: string;
    readonly actor: ActorRef;
  }> {
    const database = await createPGliteTestDatabase();
    await runMigrations(database);
    const repositories = createRepositories(database);
    const serverInstanceId = randomUUID();
    await repositories.servers.create({
      id: serverInstanceId,
      slug: 'mod-catalog-test',
      displayName: 'Mod Catalog Test',
      environment: 'test',
      minecraftVersion: '1.20.1',
      loader: 'forge',
      loaderVersion: '47.4.4',
      maxPlayers: 20,
    });
    return {
      database,
      repositories,
      serverInstanceId,
      actor: { type: 'panel-user', id: randomUUID() },
    };
  }

  const catalogEntry = (overrides: Record<string, unknown> = {}): ModCatalogEntry =>
    ({
      schemaVersion: 1,
      id: 'voidfall-probe',
      logicalName: 'VoidFall Probe',
      filename: 'probe-1.0.0.jar',
      path: 'mods/probe-1.0.0.jar',
      kind: 'mod',
      side: 'both',
      requirement: 'required',
      version: '1.0.0',
      sizeBytes: 4_096,
      sha256: 'a'.repeat(64),
      runtime: { minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '47.4.4' },
      source: { provider: 'manual-reviewed' },
      distribution: { decision: 'pending' },
      reviewState: 'detected',
      dependencies: [],
      ...overrides,
    }) as ModCatalogEntry;

  it('remembers a reviewed entry across a restart of the process', async () => {
    const { database, repositories, serverInstanceId, actor } = await catalogFixture();
    try {
      const created = await repositories.modCatalog.upsert({
        serverInstanceId,
        entry: catalogEntry(),
        actor,
        reasonCode: 'initial-detection',
        now: new Date('2026-08-05T12:00:00Z'),
      });
      assert.equal(created.version, 1);
      assert.equal(created.entry.reviewState, 'detected');

      // A fresh repository stands in for a restarted process.
      const reopened = createRepositories(database);
      const found = await reopened.modCatalog.findById('voidfall-probe');
      assert.equal(found?.entry.logicalName, 'VoidFall Probe');
      assert.equal(found?.reasonCode, 'initial-detection');
      assert.equal(found?.actor.type, 'panel-user');
    } finally {
      await database.close();
    }
  });

  it('records a human classification over the version the reviewer read', async () => {
    const { database, repositories, serverInstanceId, actor } = await catalogFixture();
    try {
      const created = await repositories.modCatalog.upsert({
        serverInstanceId,
        entry: catalogEntry(),
        actor,
        reasonCode: 'initial-detection',
        now: new Date('2026-08-05T12:00:00Z'),
      });

      const reviewed = await repositories.modCatalog.upsert({
        serverInstanceId,
        entry: catalogEntry({
          reviewState: 'reviewed',
          side: 'server',
          distribution: {
            decision: 'allowed',
            licenseExpression: 'MIT',
            evidenceReference: 'reviewed-by-owner',
            reviewedBy: actor.id,
            reviewedAt: '2026-08-05T12:01:00Z',
          },
        }),
        actor,
        reasonCode: 'owner-review',
        expectedVersion: created.version,
        now: new Date('2026-08-05T12:01:00Z'),
      });
      assert.equal(reviewed.version, 2);
      assert.equal(reviewed.entry.reviewState, 'reviewed');
      assert.equal(reviewed.entry.side, 'server');

      // A decision taken against a stale read loses instead of overwriting.
      await assert.rejects(
        repositories.modCatalog.upsert({
          serverInstanceId,
          entry: catalogEntry({ reviewState: 'quarantined' }),
          actor,
          reasonCode: 'late-review',
          expectedVersion: created.version,
          now: new Date('2026-08-05T12:02:00Z'),
        }),
        (error: unknown) =>
          error instanceof ModCatalogPersistenceError && error.code === 'stale-entry',
      );
      // Creating over an existing entry would discard somebody else's review.
      await assert.rejects(
        repositories.modCatalog.upsert({
          serverInstanceId,
          entry: catalogEntry(),
          actor,
          reasonCode: 'blind-create',
          now: new Date('2026-08-05T12:02:00Z'),
        }),
        (error: unknown) =>
          error instanceof ModCatalogPersistenceError && error.code === 'stale-entry',
      );
    } finally {
      await database.close();
    }
  });

  it('refuses to catalogue the same content under two identifiers', async () => {
    const { database, repositories, serverInstanceId, actor } = await catalogFixture();
    try {
      await repositories.modCatalog.upsert({
        serverInstanceId,
        entry: catalogEntry(),
        actor,
        reasonCode: 'initial-detection',
        now: new Date('2026-08-05T12:00:00Z'),
      });
      await assert.rejects(
        repositories.modCatalog.upsert({
          serverInstanceId,
          entry: catalogEntry({ id: 'voidfall-probe-copy' }),
          actor,
          reasonCode: 'duplicate-detection',
          now: new Date('2026-08-05T12:01:00Z'),
        }),
        (error: unknown) =>
          error instanceof ModCatalogPersistenceError && error.code === 'content-conflict',
      );

      const byContent = await repositories.modCatalog.findBySha256(serverInstanceId, 'a'.repeat(64));
      assert.equal(byContent?.entry.id, 'voidfall-probe');
    } finally {
      await database.close();
    }
  });

  it('pages and filters the catalog by review state and side', async () => {
    const { database, repositories, serverInstanceId, actor } = await catalogFixture();
    try {
      for (const [index, state] of (['detected', 'reviewed', 'quarantined'] as const).entries()) {
        await repositories.modCatalog.upsert({
          serverInstanceId,
          entry: catalogEntry({
            id: `voidfall-probe-${String(index)}`,
            sha256: String(index).repeat(64).slice(0, 64),
            reviewState: state,
            side: index === 0 ? 'client' : 'server',
            ...(state === 'reviewed'
              ? {
                  distribution: {
                    decision: 'allowed',
                    licenseExpression: 'MIT',
                    evidenceReference: 'reviewed-by-owner',
                    reviewedBy: actor.id,
                    reviewedAt: '2026-08-05T12:01:00Z',
                  },
                }
              : {}),
          }),
          actor,
          reasonCode: 'initial-detection',
          now: new Date('2026-08-05T12:00:00Z'),
        });
      }

      const all = await repositories.modCatalog.list({ serverInstanceId, limit: 50, offset: 0 });
      assert.equal(all.total, 3);

      const reviewed = await repositories.modCatalog.list({
        serverInstanceId,
        reviewStates: ['reviewed'],
        limit: 50,
        offset: 0,
      });
      assert.equal(reviewed.total, 1);

      const serverSide = await repositories.modCatalog.list({
        serverInstanceId,
        sides: ['server'],
        limit: 50,
        offset: 0,
      });
      assert.equal(serverSide.total, 2);

      // The bound is clamped in the repository as well as at any route.
      const bounded = await repositories.modCatalog.list({
        serverInstanceId,
        limit: 5_000,
        offset: 0,
      });
      assert.equal(bounded.limit, 100);
    } finally {
      await database.close();
    }
  });
});
