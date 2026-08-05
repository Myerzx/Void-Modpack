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
  ArtifactReviewError,
  ConfigurationPersistenceError,
  ModCatalogPersistenceError,
  OperationalPersistenceError,
  createRepositories,
  runMigrations,
} from '../src/index.js';
import { createPGliteTestDatabase } from '../src/testing.js';

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

describe('artifact review persistence', () => {
  const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

  async function reviewFixture(): Promise<{
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
      slug: 'artifact-review-test',
      displayName: 'Artifact Review Test',
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

  const inspectionReport = (sha256: string) => ({
    format: 'voidfall-artifact-inspection' as const,
    schemaVersion: 1 as const,
    sha256,
    sizeBytes: 4_096,
    inspectedAt: '2026-08-05T12:00:30Z',
    container: 'zip' as const,
    entryCount: 12,
    expandedBytes: 900,
    loaders: ['forge' as const],
    mods: [
      {
        modId: 'voidfall_probe',
        displayName: 'VoidFall Probe',
        version: '1.0.0',
        loader: 'forge' as const,
        dependencies: [],
        evidence: 'META-INF/mods.toml' as const,
      },
    ],
    embeddedLibraries: [],
    evidence: ['META-INF/mods.toml' as const],
    metadataIssues: [],
    features: {
      containsClasses: true,
      containsData: false,
      containsAssets: false,
      containsMixins: false,
      containsNestedJars: false,
    },
  });

  const compatibilityReport = (sha256: string, issues: readonly CompatibilityIssue[]) => ({
    schemaVersion: 1 as const,
    analysisId: 'submission-probe',
    generatedAt: '2026-08-05T12:00:40Z',
    contexts: [
      {
        contextId: 'server-active',
        kind: 'server_active' as const,
        side: 'server' as const,
        runtime: {
          minecraftVersion: '1.20.1',
          loader: 'forge' as const,
          loaderVersion: '1.20.1-47.4.4',
        },
        javaVersion: '17',
      },
    ],
    artifacts: [
      {
        artifactId: 'submission-probe',
        filename: 'probe-1.0.0.jar',
        sha256,
        modIds: ['voidfall_probe'],
        status: issues.some(
          (issue) => issue.severity === 'blocker' && issue.determinacy === 'proven',
        )
          ? ('incompatible' as const)
          : ('unknown' as const),
        contexts: [{ contextId: 'server-active', status: 'unknown' as const }],
      },
    ],
    relatedInstalled: [],
    issues: [...issues],
    summary: {
      compatibleArtifacts: 0,
      incompatibleArtifacts: issues.some(
        (issue) => issue.severity === 'blocker' && issue.determinacy === 'proven',
      )
        ? 1
        : 0,
      unknownArtifacts: issues.some(
        (issue) => issue.severity === 'blocker' && issue.determinacy === 'proven',
      )
        ? 0
        : 1,
      blockerCount: issues.filter((issue) => issue.severity === 'blocker').length,
      warningCount: issues.filter((issue) => issue.severity === 'warning').length,
      informationCount: issues.filter((issue) => issue.severity === 'information').length,
    },
  });

  const issue = (overrides: Partial<CompatibilityIssue> = {}): CompatibilityIssue => ({
    code: 'minecraft-version-mismatch',
    severity: 'blocker',
    determinacy: 'proven',
    reason: 'declared-mismatch',
    contextIds: ['server-active'],
    artifactIds: ['submission-probe'],
    modIds: ['voidfall_probe'],
    evidence: ['META-INF/mods.toml'],
    detail: 'required=[1.19.2];running=1.20.1',
    explanation: 'The mod declares a Minecraft range that excludes the target version.',
    recommendedAction: 'match-minecraft-version',
    ...overrides,
  });

  it('carries an artifact from upload to an approved review', async () => {
    const { database, repositories, serverInstanceId, actor } = await reviewFixture();
    try {
      const sha256 = hash('a');
      const created = await repositories.artifactReview.create({
        submissionId: randomUUID(),
        serverInstanceId,
        filename: 'probe-1.0.0.jar',
        sha256,
        sizeBytes: 4_096,
        submittedBy: actor,
        now: new Date('2026-08-05T12:00:00Z'),
      });
      assert.equal(created.replayed, false);
      assert.equal(created.submission.state, 'uploaded');

      const quarantined = await repositories.artifactReview.transition({
        submissionId: created.submission.submissionId,
        to: 'quarantined',
        expectedVersion: created.submission.version,
        now: new Date('2026-08-05T12:00:10Z'),
      });
      assert.equal(quarantined.state, 'quarantined');

      const inspected = await repositories.artifactReview.recordInspection({
        submissionId: created.submission.submissionId,
        expectedVersion: quarantined.version,
        report: inspectionReport(sha256),
        now: new Date('2026-08-05T12:00:30Z'),
      });
      assert.equal(inspected.state, 'analyzing');
      assert.deepEqual(inspected.analysis.modIds, ['voidfall_probe']);
      assert.deepEqual(inspected.analysis.declaredVersions, ['1.0.0']);

      const analyzed = await repositories.artifactReview.recordCompatibility({
        submissionId: created.submission.submissionId,
        expectedVersion: inspected.version,
        report: compatibilityReport(sha256, [issue({ determinacy: 'unproven', reason: 'not-declared' })]),
        now: new Date('2026-08-05T12:00:40Z'),
      });
      // An unproven blocker leaves the artifact reviewable, never silently passed.
      assert.equal(analyzed.state, 'reviewable');
      assert.equal(analyzed.analysis.provenBlockerCount, 0);
      assert.equal(analyzed.analysis.blockerCount, 1);

      const approved = await repositories.artifactReview.recordDecision({
        submissionId: created.submission.submissionId,
        decisionId: randomUUID(),
        decision: 'approved',
        actor,
        reasonCode: 'reviewed-by-owner',
        analyzedSha256: sha256,
        expectedVersion: analyzed.version,
        now: new Date('2026-08-05T12:01:00Z'),
      });
      assert.equal(approved.state, 'approved');
      assert.equal(approved.decision?.reasonCode, 'reviewed-by-owner');
      assert.equal(approved.decision?.analyzedSha256, sha256);

      // The decision is durable on its own, not only as a column.
      const logged = await database.query<{ readonly count: string | number }>(
        'SELECT COUNT(*) AS count FROM artifact_review_decisions WHERE submission_id = $1',
        [created.submission.submissionId],
      );
      assert.equal(Number(logged.rows[0]?.count), 1);
    } finally {
      await database.close();
    }
  });

  it('blocks a proven incompatibility and refuses to approve it', async () => {
    const { database, repositories, serverInstanceId, actor } = await reviewFixture();
    try {
      const sha256 = hash('b');
      const created = await repositories.artifactReview.create({
        submissionId: randomUUID(),
        serverInstanceId,
        filename: 'blocked-1.0.0.jar',
        sha256,
        sizeBytes: 4_096,
        submittedBy: actor,
        now: new Date('2026-08-05T12:00:00Z'),
      });
      const quarantined = await repositories.artifactReview.transition({
        submissionId: created.submission.submissionId,
        to: 'quarantined',
        expectedVersion: created.submission.version,
        now: new Date('2026-08-05T12:00:10Z'),
      });
      const inspected = await repositories.artifactReview.recordInspection({
        submissionId: created.submission.submissionId,
        expectedVersion: quarantined.version,
        report: inspectionReport(sha256),
        now: new Date('2026-08-05T12:00:30Z'),
      });
      const analyzed = await repositories.artifactReview.recordCompatibility({
        submissionId: created.submission.submissionId,
        expectedVersion: inspected.version,
        report: compatibilityReport(sha256, [issue()]),
        now: new Date('2026-08-05T12:00:40Z'),
      });
      assert.equal(analyzed.state, 'blocked');
      assert.equal(analyzed.analysis.provenBlockerCount, 1);

      // A blocked artifact is never silently admitted.
      await assert.rejects(
        repositories.artifactReview.recordDecision({
          submissionId: created.submission.submissionId,
          decisionId: randomUUID(),
          decision: 'approved',
          actor,
          reasonCode: 'looks-fine',
          analyzedSha256: sha256,
          expectedVersion: analyzed.version,
          now: new Date('2026-08-05T12:01:00Z'),
        }),
        (error: unknown) =>
          error instanceof ArtifactReviewError && error.code === 'invalid-transition',
      );

      // Rejecting it explicitly is the only way forward, and it is recorded.
      const rejected = await repositories.artifactReview.recordDecision({
        submissionId: created.submission.submissionId,
        decisionId: randomUUID(),
        decision: 'rejected',
        actor,
        reasonCode: 'incompatible-minecraft-version',
        analyzedSha256: sha256,
        expectedVersion: analyzed.version,
        now: new Date('2026-08-05T12:01:00Z'),
      });
      assert.equal(rejected.state, 'rejected');

      const stored = await repositories.artifactReview.countIssuesBySeverity(
        created.submission.submissionId,
      );
      assert.deepEqual(stored, { blocker: 1, warning: 0, information: 0 });
    } finally {
      await database.close();
    }
  });

  it('refuses a decision on stale analysis or on other bytes', async () => {
    const { database, repositories, serverInstanceId, actor } = await reviewFixture();
    try {
      const sha256 = hash('c');
      const created = await repositories.artifactReview.create({
        submissionId: randomUUID(),
        serverInstanceId,
        filename: 'stale-1.0.0.jar',
        sha256,
        sizeBytes: 4_096,
        submittedBy: actor,
        now: new Date('2026-08-05T12:00:00Z'),
      });
      const quarantined = await repositories.artifactReview.transition({
        submissionId: created.submission.submissionId,
        to: 'quarantined',
        expectedVersion: created.submission.version,
        now: new Date('2026-08-05T12:00:10Z'),
      });
      const inspected = await repositories.artifactReview.recordInspection({
        submissionId: created.submission.submissionId,
        expectedVersion: quarantined.version,
        report: inspectionReport(sha256),
        now: new Date('2026-08-05T12:00:30Z'),
      });
      const analyzed = await repositories.artifactReview.recordCompatibility({
        submissionId: created.submission.submissionId,
        expectedVersion: inspected.version,
        report: compatibilityReport(sha256, []),
        now: new Date('2026-08-05T12:00:40Z'),
      });

      // A version the reviewer did not read loses.
      await assert.rejects(
        repositories.artifactReview.recordDecision({
          submissionId: created.submission.submissionId,
          decisionId: randomUUID(),
          decision: 'approved',
          actor,
          reasonCode: 'reviewed',
          analyzedSha256: sha256,
          expectedVersion: analyzed.version - 1,
          now: new Date('2026-08-05T12:01:00Z'),
        }),
        (error: unknown) => error instanceof ArtifactReviewError && error.code === 'stale-submission',
      );

      // A decision naming other bytes is refused outright.
      await assert.rejects(
        repositories.artifactReview.recordDecision({
          submissionId: created.submission.submissionId,
          decisionId: randomUUID(),
          decision: 'approved',
          actor,
          reasonCode: 'reviewed',
          analyzedSha256: hash('d'),
          expectedVersion: analyzed.version,
          now: new Date('2026-08-05T12:01:00Z'),
        }),
        (error: unknown) => error instanceof ArtifactReviewError && error.code === 'analysis-mismatch',
      );
    } finally {
      await database.close();
    }
  });

  it('resolves the same bytes to one review and lists submissions by state', async () => {
    const { database, repositories, serverInstanceId, actor } = await reviewFixture();
    try {
      const sha256 = hash('e');
      const first = await repositories.artifactReview.create({
        submissionId: randomUUID(),
        serverInstanceId,
        filename: 'probe.jar',
        sha256,
        sizeBytes: 4_096,
        submittedBy: actor,
        now: new Date('2026-08-05T12:00:00Z'),
      });
      const replay = await repositories.artifactReview.create({
        submissionId: randomUUID(),
        serverInstanceId,
        filename: 'probe-renamed.jar',
        sha256,
        sizeBytes: 4_096,
        submittedBy: actor,
        now: new Date('2026-08-05T12:00:05Z'),
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.submission.submissionId, first.submission.submissionId);

      await repositories.artifactReview.create({
        submissionId: randomUUID(),
        serverInstanceId,
        filename: 'other.jar',
        sha256: hash('f'),
        sizeBytes: 2_048,
        submittedBy: actor,
        now: new Date('2026-08-05T12:00:06Z'),
      });

      const page = await repositories.artifactReview.list({
        serverInstanceId,
        states: ['uploaded'],
        limit: 50,
        offset: 0,
      });
      assert.equal(page.total, 2);
      assert.equal(page.submissions.length, 2);

      const empty = await repositories.artifactReview.list({
        serverInstanceId,
        states: ['approved'],
        limit: 50,
        offset: 0,
      });
      assert.equal(empty.total, 0);
    } finally {
      await database.close();
    }
  });
});

describe('operational core persistence', () => {
  async function operationalFixture(): Promise<{
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
      slug: 'operational-core-test',
      displayName: 'Operational Core Test',
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

  const accept = (serverInstanceId: string, actor: ActorRef, overrides: Record<string, unknown> = {}) => ({
    operationId: randomUUID(),
    serverInstanceId,
    kind: 'server.start' as const,
    idempotencyKey: 'operation-start-0001',
    correlationId: randomUUID(),
    requestedBy: actor,
    reasonCode: 'operator-request',
    now: new Date('2026-08-05T12:00:00Z'),
    ...overrides,
  });

  it('returns the original operation for an honest replay and conflicts on a reused key', async () => {
    const { database, repositories, serverInstanceId, actor } = await operationalFixture();
    try {
      const first = await repositories.operations.accept(accept(serverInstanceId, actor));
      assert.equal(first.replayed, false);
      assert.equal(first.operation.status, 'accepted');

      // The same request under the same key is an honest replay.
      const replay = await repositories.operations.accept(
        accept(serverInstanceId, actor, { operationId: randomUUID() }),
      );
      assert.equal(replay.replayed, true);
      assert.equal(replay.operation.operationId, first.operation.operationId);

      // The same key for a different request is a conflict, never a second run.
      await assert.rejects(
        repositories.operations.accept(
          accept(serverInstanceId, actor, { operationId: randomUUID(), kind: 'server.stop' }),
        ),
        (error: unknown) =>
          error instanceof OperationalPersistenceError && error.code === 'idempotency-conflict',
      );
    } finally {
      await database.close();
    }
  });

  it('allows at most one in-flight operation per server', async () => {
    const { database, repositories, serverInstanceId, actor } = await operationalFixture();
    try {
      await repositories.operations.accept(accept(serverInstanceId, actor));

      await assert.rejects(
        repositories.operations.accept(
          accept(serverInstanceId, actor, {
            operationId: randomUUID(),
            idempotencyKey: 'operation-stop-0002',
            kind: 'server.stop',
          }),
        ),
        (error: unknown) =>
          error instanceof OperationalPersistenceError && error.code === 'operation-in-flight',
      );
    } finally {
      await database.close();
    }
  });

  it('settles an operation with a receipt and frees the server for the next one', async () => {
    const { database, repositories, serverInstanceId, actor } = await operationalFixture();
    try {
      const accepted = await repositories.operations.accept(accept(serverInstanceId, actor));
      const running = await repositories.operations.markRunning({
        operationId: accepted.operation.operationId,
        expectedVersion: accepted.operation.version,
        now: new Date('2026-08-05T12:00:05Z'),
      });
      assert.equal(running.status, 'running');

      const bootId = randomUUID();
      const settled = await repositories.operations.settle({
        operationId: accepted.operation.operationId,
        eventId: randomUUID(),
        expectedVersion: running.version,
        outcome: 'succeeded',
        observedLifecycle: 'online',
        observedPid: 4242,
        bootId,
        now: new Date('2026-08-05T12:00:30Z'),
      });
      assert.equal(settled.status, 'succeeded');
      assert.equal(settled.receipt?.observedPid, 4242);
      assert.equal(settled.receipt?.bootId, bootId);

      // A settled operation is final.
      await assert.rejects(
        repositories.operations.settle({
          operationId: accepted.operation.operationId,
          eventId: randomUUID(),
          expectedVersion: settled.version,
          outcome: 'failed',
          failureCode: 'operation-failed',
          observedLifecycle: 'error',
          now: new Date('2026-08-05T12:00:40Z'),
        }),
        (error: unknown) =>
          error instanceof OperationalPersistenceError && error.code === 'invalid-transition',
      );

      // The server is free again once nothing is in flight.
      assert.equal(await repositories.operations.findInFlight(serverInstanceId), undefined);
      const next = await repositories.operations.accept(
        accept(serverInstanceId, actor, {
          operationId: randomUUID(),
          idempotencyKey: 'operation-stop-0002',
          kind: 'server.stop',
        }),
      );
      assert.equal(next.replayed, false);
    } finally {
      await database.close();
    }
  });

  it('refuses to settle over a version the caller did not read', async () => {
    const { database, repositories, serverInstanceId, actor } = await operationalFixture();
    try {
      const accepted = await repositories.operations.accept(accept(serverInstanceId, actor));
      await assert.rejects(
        repositories.operations.settle({
          operationId: accepted.operation.operationId,
          eventId: randomUUID(),
          expectedVersion: accepted.operation.version + 1,
          outcome: 'succeeded',
          observedLifecycle: 'online',
          now: new Date('2026-08-05T12:00:30Z'),
        }),
        (error: unknown) =>
          error instanceof OperationalPersistenceError && error.code === 'stale-operation',
      );
    } finally {
      await database.close();
    }
  });

  it('writes the outbox event in the same transaction as the state change', async () => {
    const { database, repositories, serverInstanceId, actor } = await operationalFixture();
    try {
      const correlationId = randomUUID();
      const accepted = await repositories.operations.accept(
        accept(serverInstanceId, actor, { correlationId }),
      );
      await repositories.operations.settle({
        operationId: accepted.operation.operationId,
        eventId: randomUUID(),
        expectedVersion: accepted.operation.version,
        outcome: 'failed',
        failureCode: 'agent-refused',
        observedLifecycle: 'error',
        now: new Date('2026-08-05T12:00:30Z'),
      });

      const events = await repositories.outbox.findByCorrelationId(correlationId);
      assert.deepEqual(
        events.map((event) => event.topic),
        ['operation.accepted', 'operation.completed'],
      );
      assert.equal(events[1]?.payload.failureCode, 'agent-refused');
      // Nothing is published until a dispatcher says it delivered.
      assert.ok(events.every((event) => event.publishedAt === null));
    } finally {
      await database.close();
    }
  });

  it('never leaves an event behind when the state change rolls back', async () => {
    const { database, repositories, serverInstanceId, actor } = await operationalFixture();
    try {
      const before = await repositories.outbox.countPending();
      // A settle against a missing operation aborts the whole transaction.
      await assert.rejects(
        repositories.operations.settle({
          operationId: randomUUID(),
          eventId: randomUUID(),
          expectedVersion: 1,
          outcome: 'succeeded',
          observedLifecycle: 'online',
          now: new Date('2026-08-05T12:00:30Z'),
        }),
      );
      assert.equal(await repositories.outbox.countPending(), before);

      // And the conflicting accept above wrote nothing either.
      await repositories.operations.accept(accept(serverInstanceId, actor));
      await assert.rejects(
        repositories.operations.accept(
          accept(serverInstanceId, actor, {
            operationId: randomUUID(),
            idempotencyKey: 'operation-stop-0002',
            kind: 'server.stop',
          }),
        ),
      );
      assert.equal(await repositories.outbox.countPending(), before + 1);
    } finally {
      await database.close();
    }
  });

  it('claims outbox events once and publishes only after delivery', async () => {
    const { database, repositories, serverInstanceId, actor } = await operationalFixture();
    try {
      await repositories.operations.accept(accept(serverInstanceId, actor));
      const owner = randomUUID();
      const claimed = await repositories.outbox.claimPending({
        ownerId: owner,
        limit: 10,
        leaseExpiresAt: new Date('2026-08-05T12:05:00Z'),
        now: new Date('2026-08-05T12:00:10Z'),
      });
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.attempts, 1);

      // A second dispatcher sees nothing while the lease holds.
      const contested = await repositories.outbox.claimPending({
        ownerId: randomUUID(),
        limit: 10,
        leaseExpiresAt: new Date('2026-08-05T12:05:00Z'),
        now: new Date('2026-08-05T12:00:20Z'),
      });
      assert.equal(contested.length, 0);

      // Only the lease owner may mark it delivered.
      const eventId = claimed[0]?.eventId as string;
      assert.equal(await repositories.outbox.markPublished(eventId, randomUUID(), new Date('2026-08-05T12:00:30Z')), false);
      assert.equal(await repositories.outbox.markPublished(eventId, owner, new Date('2026-08-05T12:00:30Z')), true);
      assert.equal(await repositories.outbox.countPending(), 0);
    } finally {
      await database.close();
    }
  });

  it('records an observed pid and reconciles it to unknown once nobody is watching', async () => {
    const { database, repositories, serverInstanceId } = await operationalFixture();
    try {
      const agentId = randomUUID();
      await database.query(
        `INSERT INTO agents (id, server_instance_id, public_key_pem, certificate_fingerprint,
           software_version, protocol_version, status)
         VALUES ($1,$2,$3,$4,$5,$6,'online')`,
        [agentId, serverInstanceId, 'pem', 'a'.repeat(64), '0.1.0', '1'],
      );

      const observed = await repositories.processStates.observe({
        serverInstanceId,
        eventId: randomUUID(),
        lifecycle: 'online',
        observedBy: agentId,
        bootId: randomUUID(),
        observedPid: 4242,
        correlationId: randomUUID(),
        now: new Date('2026-08-05T12:00:00Z'),
      });
      assert.equal(observed.lifecycle, 'online');
      assert.equal(observed.observedPid, 4242);
      assert.equal(observed.stale, false);

      // After a restart nobody is watching, so the honest answer is unknown.
      const reconciled = await repositories.processStates.reconcileStale({
        observedBefore: new Date('2026-08-05T12:10:00Z'),
        now: new Date('2026-08-05T12:11:00Z'),
      });
      assert.equal(reconciled.length, 1);
      assert.equal(reconciled[0]?.lifecycle, 'unknown');
      assert.equal(reconciled[0]?.observedPid, null);
      assert.equal(reconciled[0]?.stale, true);

      const current = await repositories.processStates.find(serverInstanceId);
      assert.equal(current?.lifecycle, 'unknown');
    } finally {
      await database.close();
    }
  });

  it('pages and filters operations and follows one correlation id', async () => {
    const { database, repositories, serverInstanceId, actor } = await operationalFixture();
    try {
      const correlationId = randomUUID();
      for (const [index, kind] of (['server.start', 'server.stop', 'server.restart'] as const).entries()) {
        const accepted = await repositories.operations.accept(
          accept(serverInstanceId, actor, {
            operationId: randomUUID(),
            idempotencyKey: `operation-seq-000${String(index)}`,
            kind,
            correlationId,
            now: new Date(`2026-08-05T12:0${String(index)}:00Z`),
          }),
        );
        await repositories.operations.settle({
          operationId: accepted.operation.operationId,
          eventId: randomUUID(),
          expectedVersion: accepted.operation.version,
          outcome: 'succeeded',
          observedLifecycle: 'online',
          now: new Date(`2026-08-05T12:0${String(index)}:30Z`),
        });
      }

      const all = await repositories.operations.list({ serverInstanceId, limit: 2, offset: 0 });
      assert.equal(all.total, 3);
      assert.equal(all.operations.length, 2);

      const stops = await repositories.operations.list({
        serverInstanceId,
        kinds: ['server.stop'],
        limit: 50,
        offset: 0,
      });
      assert.equal(stops.total, 1);

      const settledOnly = await repositories.operations.list({
        serverInstanceId,
        statuses: ['accepted', 'running'],
        limit: 50,
        offset: 0,
      });
      assert.equal(settledOnly.total, 0);

      // One correlation id ties the whole sequence together.
      const correlated = await repositories.operations.findByCorrelationId(correlationId);
      assert.equal(correlated.length, 3);
      const events = await repositories.outbox.findByCorrelationId(correlationId);
      assert.equal(events.length, 6);
    } finally {
      await database.close();
    }
  });
});

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
