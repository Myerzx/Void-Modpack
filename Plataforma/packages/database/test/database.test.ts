import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { hashPassword } from '@voidfall/authentication';
import {
  OPENLOADER_ADVANCED_OPTIONS_V1,
  hashConfigurationSchema,
} from '@voidfall/configuration-schemas';
import type { ActorRef, AuditEvent, CompatibilityIssue, Job } from '@voidfall/contracts';
import { PANEL_PERMISSIONS, permissionsForRoles } from '@voidfall/permissions';
import {
  ArtifactReviewError,
  ConfigurationPersistenceError,
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
