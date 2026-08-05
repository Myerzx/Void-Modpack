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
