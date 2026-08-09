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

describe('PostgreSQL foundation', () => {
  it('applies immutable migrations and seeds deny-by-default RBAC', async () => {
    const database = await createPGliteTestDatabase();
    try {
      assert.deepEqual(await runMigrations(database), [
        '0001_foundation.sql',
        '0002_rbac_seed.sql',
        '0003_audit_chain.sql',
        '0004_configuration_operations.sql',
        '0005_configuration_permissions.sql',
        '0006_artifact_review.sql',
        '0007_operational_core.sql',
        '0008_agent_transport.sql',
        '0009_process_console.sql',
        '0010_console_command.sql',
        '0011_backup_catalogue.sql',
        '0012_telemetry.sql',
        '0013_schedules.sql',
        '0014_agent_readiness.sql',
        '0015_player_identity.sql',
        '0016_player_profiles_and_moderation.sql',
        '0017_panel_workspaces.sql',
        '0018_workspace_staging_and_sandbox.sql',
        '0019_workspace_releases.sql',
        '0020_server_instance_runtime.sql',
        '0021_capability_grants_catch_up.sql',
        '0022_state_conflict_failure_code.sql',
        '0023_instance_runtime_ownership.sql',
        '0024_process_state_invalidation.sql',
      ]);
      assert.deepEqual(await runMigrations(database), []);
      const repositories = createRepositories(database);
      const user = await repositories.users.create({
        email: 'owner@voidfall.invalid',
        displayName: 'Owner Fixture',
        passwordHash: await hashPassword('database-test-password'),
        roles: ['owner'],
      });
      const permissions = await repositories.permissions.forUser(user.id);
      assert.equal(permissions.includes('security.manage'), true);
      assert.equal(permissions.includes('server.control.force'), true);
    } finally {
      await database.close();
    }
  });

  it('seeds the same configuration grants the TypeScript policy declares', async () => {
    const database = await createPGliteTestDatabase();
    try {
      await runMigrations(database);
      const repositories = createRepositories(database);
      const configurationPermissions = PANEL_PERMISSIONS.filter((permission) =>
        permission.startsWith('configuration.'),
      );

      const seeded = await database.query<{ readonly id: string }>(
        "SELECT id FROM permissions WHERE id LIKE 'configuration.%' ORDER BY id",
      );
      assert.deepEqual(
        seeded.rows.map((row) => row.id),
        [...configurationPermissions].sort(),
      );

      for (const role of ['owner', 'administrator', 'moderator', 'support', 'read-only'] as const) {
        const user = await repositories.users.create({
          email: `${role}-configuration@voidfall.invalid`,
          displayName: `${role} configuration fixture`,
          passwordHash: await hashPassword('database-test-password'),
          roles: [role],
        });
        const granted = await repositories.permissions.forUser(user.id);
        for (const permission of configurationPermissions) {
          assert.equal(
            granted.includes(permission),
            permissionsForRoles([role]).includes(permission),
            `${role} must agree with the policy for ${permission}`,
          );
        }
      }
    } finally {
      await database.close();
    }
  });

  it('chains administrative audit events transactionally and exports a verified range', async () => {
    const database = await createPGliteTestDatabase();
    try {
      await runMigrations(database);
      const repositories = createRepositories(database);
      const correlationId = randomUUID();
      const baseEvent: AuditEvent = {
        schemaVersion: 1,
        id: randomUUID(),
        occurredAt: '2026-08-03T12:00:00.000Z',
        correlationId,
        actor: { type: 'system', id: 'database-test' },
        source: 'system',
        action: 'player.profile.observed',
        resource: { type: 'player', id: randomUUID() },
        outcome: 'succeeded',
        metadata: { revision: 1 },
      };
      const first = await repositories.audit.append(baseEvent);
      const [second, third] = await Promise.all([
        repositories.audit.append({
          ...baseEvent,
          id: randomUUID(),
          occurredAt: '2026-08-03T12:01:00.000Z',
          action: 'player.profile.updated',
          metadata: { revision: 2 },
        }),
        repositories.audit.append({
          ...baseEvent,
          id: randomUUID(),
          occurredAt: '2026-08-03T12:01:01.000Z',
          action: 'player.permission.updated',
          metadata: { revision: 3 },
        }),
      ]);
      assert.equal(first.sequence, 1);
      assert.deepEqual([second.sequence, third.sequence].sort(), [2, 3]);
      const verification = await repositories.audit.verifyPartition('administrative');
      assert.equal(verification.valid, true);
      assert.equal(verification.recordCount, 3);
      const artifact = await repositories.audit.exportPartition('administrative', {
        exportId: randomUUID(),
        generatedAt: '2026-08-03T12:02:00.000Z',
      });
      assert.equal(artifact.manifest.recordCount, 3);
      assert.equal(artifact.content.trimEnd().split('\n').length, 3);
      const listed = await repositories.audit.list();
      assert.equal(listed.length, 3);
      assert.ok(listed.every((event) => event.integrity !== undefined));
    } finally {
      await database.close();
    }
  });

  it('deduplicates jobs, leases only once and completes a harmless no-op', async () => {
    const database = await createPGliteTestDatabase();
    try {
      await runMigrations(database);
      const repositories = createRepositories(database);
      const now = new Date('2026-08-03T12:00:00.000Z');
      const job: Job = {
        schemaVersion: 1,
        id: randomUUID(),
        type: 'system.noop',
        resource: { type: 'diagnostic', id: 'phase-2-gate' },
        status: 'queued',
        stage: 'queued',
        priority: 10,
        payload: { schemaVersion: 1, parameters: { message: 'safe' } },
        idempotencyKey: 'phase2:noop:0001',
        requestedBy: { type: 'system', id: 'phase-2-test' },
        correlationId: randomUUID(),
        availableAt: now.toISOString(),
        attempt: 0,
        maxAttempts: 3,
      };
      const first = await repositories.jobs.enqueue(job);
      const duplicate = await repositories.jobs.enqueue({ ...job, id: randomUUID() });
      assert.equal(duplicate.id, first.id);

      const workerId = randomUUID();
      const leased = await repositories.jobs.lease({
        workerId,
        acceptedTypes: ['system.noop'],
        now,
        leaseMs: 30_000,
      });
      assert.equal(leased?.status, 'running');
      assert.equal(
        await repositories.jobs.lease({
          workerId: randomUUID(),
          acceptedTypes: ['system.noop'],
          now,
          leaseMs: 30_000,
        }),
        undefined,
      );
      assert.equal(await repositories.jobs.complete(first.id, workerId, { ok: true }, now), true);
      assert.equal((await repositories.jobs.findById(first.id))?.status, 'succeeded');
    } finally {
      await database.close();
    }
  });

  it('persists reviewed configuration state with optimistic transitions and atomic audit', async () => {
    const database = await createPGliteTestDatabase();
    try {
      await runMigrations(database);
      const repositories = createRepositories(database);
      const serverInstanceId = randomUUID();
      await repositories.servers.create({
        id: serverInstanceId,
        slug: 'configuration-test',
        displayName: 'Configuration Test',
        environment: 'test',
        minecraftVersion: '1.20.1',
        loader: 'forge',
        loaderVersion: '47.4.4',
        maxPlayers: 20,
      });
      const schemaSha256 = hashConfigurationSchema(OPENLOADER_ADVANCED_OPTIONS_V1);
      const actorId = randomUUID();
      const registeredSchema = await repositories.configuration.registerSchema({
        revisionId: 'openloader-schema-v1',
        actorId,
        reasonCode: 'reviewed-schema',
        createdAt: '2026-08-04T18:00:00.000Z',
        expectedSchemaSha256: null,
        schema: OPENLOADER_ADVANCED_OPTIONS_V1,
      });
      assert.equal(registeredSchema.schemaSha256, schemaSha256);
      assert.equal(
        (await repositories.configuration.currentSchema('openloader-advanced-options'))
          ?.schemaSha256,
        schemaSha256,
      );
      await assert.rejects(
        repositories.configuration.registerSchema({
          revisionId: 'unreviewed-schema-v2',
          actorId,
          reasonCode: 'unreviewed-schema',
          createdAt: '2026-08-04T18:00:01.000Z',
          expectedSchemaSha256: schemaSha256,
          schema: { ...OPENLOADER_ADVANCED_OPTIONS_V1, schemaVersion: '1.0.1' },
        }),
        (error) =>
          error instanceof ConfigurationPersistenceError &&
          error.code === 'schema-not-reviewed',
      );

      const initialSha256 = '1'.repeat(64);
      const nextSha256 = '2'.repeat(64);
      const registered = await repositories.configuration.registerResource({
        serverInstanceId,
        resourceId: 'openloader-advanced-options',
        expectedSchemaSha256: schemaSha256,
        initialCurrentSha256: initialSha256,
        createdAt: '2026-08-04T18:01:00.000Z',
      });
      assert.equal(registered.resource.relativeFilePath, 'config/openloader/advanced_options.json');
      assert.equal(registered.state.version, 1);

      const correlationId = randomUUID();
      const prepared = await repositories.configuration.prepare({
        revisionId: 'openloader-update-1',
        serverInstanceId,
        resourceId: 'openloader-advanced-options',
        operation: 'update',
        sourceRevisionId: null,
        expectedCurrentSha256: initialSha256,
        expectedStateVersion: 1,
        requestedFields: ['dataPacks.enabled'],
        actor: { type: 'panel-user', id: actorId },
        reasonCode: 'operator-change',
        correlationId,
        createdAt: '2026-08-04T18:02:00.000Z',
      });
      assert.equal(prepared.state.status, 'prepared');
      assert.equal(prepared.state.version, 2);
      await assert.rejects(
        repositories.configuration.prepare({
          revisionId: 'stale-update',
          serverInstanceId,
          resourceId: 'openloader-advanced-options',
          operation: 'update',
          sourceRevisionId: null,
          expectedCurrentSha256: initialSha256,
          expectedStateVersion: 1,
          requestedFields: ['resourcePacks.enabled'],
          actor: { type: 'panel-user', id: actorId },
          reasonCode: 'stale-change',
          correlationId: randomUUID(),
          createdAt: '2026-08-04T18:02:01.000Z',
        }),
        (error) =>
          error instanceof ConfigurationPersistenceError &&
          error.code === 'concurrent-modification',
      );

      const applied = await repositories.configuration.markApplied({
        revisionId: prepared.revision.revisionId,
        expectedRevisionVersion: prepared.revision.version,
        expectedStateVersion: prepared.state.version,
        previousSha256: initialSha256,
        currentSha256: nextSha256,
        manifestSha256: '3'.repeat(64),
        changedFields: ['dataPacks.enabled'],
        restartRequired: true,
        completedAt: '2026-08-04T18:03:00.000Z',
        auditEventId: randomUUID(),
      });
      assert.equal(applied.state.status, 'applied');
      assert.equal(applied.state.currentSha256, nextSha256);
      assert.equal(applied.state.version, 3);
      assert.equal(applied.auditSequence, 1);
      const audit = await repositories.audit.list();
      assert.equal(audit[0]?.correlationId, correlationId);
      assert.equal(audit[0]?.action, 'configuration.update.applied');
      assert.equal(JSON.stringify(audit).includes('additionalFolders'), false);
      assert.equal(JSON.stringify(audit).includes('configurationValues'), false);

      const rollback = await repositories.configuration.prepare({
        revisionId: 'openloader-rollback-1',
        serverInstanceId,
        resourceId: 'openloader-advanced-options',
        operation: 'rollback',
        sourceRevisionId: applied.revision.revisionId,
        expectedCurrentSha256: nextSha256,
        expectedStateVersion: applied.state.version,
        requestedFields: [],
        actor: { type: 'panel-user', id: actorId },
        reasonCode: 'operator-rollback',
        correlationId: randomUUID(),
        createdAt: '2026-08-04T18:04:00.000Z',
      });
      const failed = await repositories.configuration.markFailed({
        revisionId: rollback.revision.revisionId,
        expectedRevisionVersion: rollback.revision.version,
        expectedStateVersion: rollback.state.version,
        failureCode: 'replacement-failed',
        failureStage: 'replace',
        completedAt: '2026-08-04T18:05:00.000Z',
        auditEventId: randomUUID(),
      });
      assert.equal(failed.state.status, 'failed');
      assert.equal(failed.state.currentSha256, nextSha256);
      assert.equal(failed.revision.failureCode, 'replacement-failed');
      assert.equal((await repositories.audit.verifyPartition('configuration')).valid, true);
    } finally {
      await database.close();
    }
  });

  it('leases the shared operational lock and replaces it only after expiry', async () => {
    const database = await createPGliteTestDatabase();
    try {
      await runMigrations(database);
      const repositories = createRepositories(database);
      const serverInstanceId = randomUUID();
      await repositories.servers.create({
        id: serverInstanceId,
        slug: 'lock-test',
        displayName: 'Lock Test',
        environment: 'test',
        minecraftVersion: '1.20.1',
        loader: 'forge',
        loaderVersion: '47.4.4',
        maxPlayers: 20,
      });
      const firstOwner = randomUUID();
      const first = await repositories.operationalLocks.acquire({
        serverInstanceId,
        lockName: 'minecraft-exclusive',
        ownerId: firstOwner,
        operation: 'configuration.update',
        acquiredAt: '2026-08-04T19:00:00.000Z',
        leaseExpiresAt: '2026-08-04T19:01:00.000Z',
      });
      assert.equal(first.version, 1);
      const secondOwner = randomUUID();
      await assert.rejects(
        repositories.operationalLocks.acquire({
          serverInstanceId,
          lockName: 'minecraft-exclusive',
          ownerId: secondOwner,
          operation: 'backup.create',
          acquiredAt: '2026-08-04T19:00:30.000Z',
          leaseExpiresAt: '2026-08-04T19:01:30.000Z',
        }),
        (error) =>
          error instanceof ConfigurationPersistenceError && error.code === 'lock-unavailable',
      );
      const replaced = await repositories.operationalLocks.acquire({
        serverInstanceId,
        lockName: 'minecraft-exclusive',
        ownerId: secondOwner,
        operation: 'backup.create',
        acquiredAt: '2026-08-04T19:01:00.000Z',
        leaseExpiresAt: '2026-08-04T19:02:00.000Z',
      });
      assert.equal(replaced.version, 2);
      assert.equal(await repositories.operationalLocks.release({
        serverInstanceId,
        lockName: 'minecraft-exclusive',
        ownerId: firstOwner,
      }), false);
      assert.equal(await repositories.operationalLocks.release({
        serverInstanceId,
        lockName: 'minecraft-exclusive',
        ownerId: secondOwner,
      }), true);
    } finally {
      await database.close();
    }
  });
});
