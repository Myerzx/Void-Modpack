import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { ActorRef, ArtifactCompatibilityPlan, Job } from '@voidfall/contracts';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';

import { runArtifactWorkerOnce, type CompatibilityPlanFactory } from '../src/artifact-worker.js';

/**
 * The fixture archive is built in code rather than committed as a binary, so
 * every field a test depends on stays reviewable in the diff. No real mod JAR
 * is opened anywhere in this suite.
 */
function buildZip(entries: readonly { readonly name: string; readonly content: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = Buffer.from(entry.content, 'utf8');
    const nameBytes = Buffer.from(entry.name, 'utf8');

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, raw);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + raw.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, eocd]);
}

const modsToml = (minecraftRange: string): string =>
  [
    'modLoader = "javafml"',
    'loaderVersion = "[47,)"',
    'license = "MIT"',
    '',
    '[[mods]]',
    'modId = "voidfall_probe"',
    'version = "1.0.0"',
    'displayName = "VoidFall Probe"',
    '',
    '[[dependencies.voidfall_probe]]',
    'modId = "minecraft"',
    'mandatory = true',
    `versionRange = "${minecraftRange}"`,
    'side = "BOTH"',
    '',
  ].join('\n');

function planFactoryFor(sha256: string, filename: string): CompatibilityPlanFactory {
  return {
    build: async ({ submissionId, inspection }) =>
      ({
        schemaVersion: 1,
        analysisId: 'artifact-worker-test',
        generatedAt: '2026-08-05T12:00:00Z',
        contexts: [
          {
            contextId: 'server-active',
            kind: 'server_active',
            side: 'server',
            runtime: {
              minecraftVersion: '1.20.1',
              loader: 'forge',
              loaderVersion: '1.20.1-47.4.4',
            },
            javaVersion: '17',
          },
        ],
        candidates: [
          {
            artifactId: `submission-${submissionId.slice(0, 8)}`,
            filename,
            inspection,
            reviewedSide: 'both',
            targetContextIds: ['server-active'],
            distributionReviewed: true,
          },
        ],
        installed: [],
        explicitConflicts: [],
      }) satisfies ArtifactCompatibilityPlan,
  };
}

async function fixture(): Promise<{
  readonly database: Database;
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
    slug: 'artifact-worker-test',
    displayName: 'Artifact Worker Test',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '47.4.4',
    maxPlayers: 20,
  });
  return { database, repositories, serverInstanceId, actor: { type: 'panel-user', id: randomUUID() } };
}

function inspectJob(submissionId: string, expectedVersion: number, actor: ActorRef): Job {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    type: 'artifact.inspect',
    resource: { type: 'artifact-submission', id: submissionId },
    status: 'queued',
    stage: 'queued',
    priority: 50,
    payload: { schemaVersion: 1, parameters: { submissionId, expectedVersion } },
    idempotencyKey: `artifact-inspect-${submissionId}`,
    requestedBy: actor,
    correlationId: randomUUID(),
    availableAt: '2026-08-05T12:00:00Z',
    attempt: 0,
    maxAttempts: 1,
  };
}

const WORKER_ID = randomUUID();

describe('artifact worker', () => {
  it('inspects a quarantined archive, chains the analysis and never executes it', async () => {
    const { database, repositories, serverInstanceId, actor } = await fixture();
    try {
      const archive = buildZip([{ name: 'META-INF/mods.toml', content: modsToml('[1.20.1]') }]);
      const sha256 = createHash('sha256').update(archive).digest('hex');
      const created = await repositories.artifactReview.create({
        submissionId: randomUUID(),
        serverInstanceId,
        filename: 'probe-1.0.0.jar',
        sha256,
        sizeBytes: archive.length,
        submittedBy: actor,
        now: new Date('2026-08-05T12:00:00Z'),
      });
      const quarantined = await repositories.artifactReview.transition({
        submissionId: created.submission.submissionId,
        to: 'quarantined',
        expectedVersion: created.submission.version,
        now: new Date('2026-08-05T12:00:05Z'),
      });
      await repositories.jobs.enqueue(
        inspectJob(created.submission.submissionId, quarantined.version, actor),
      );

      const inspection = await runArtifactWorkerOnce({
        database,
        workerId: WORKER_ID,
        reader: { read: async () => archive },
        planFactory: planFactoryFor(sha256, 'probe-1.0.0.jar'),
        now: new Date('2026-08-05T12:00:10Z'),
      });
      assert.equal(inspection.processed, true);
      assert.equal(inspection.processed && inspection.outcome, 'inspected');

      const afterInspection = await repositories.artifactReview.findById(
        created.submission.submissionId,
      );
      assert.equal(afterInspection?.state, 'analyzing');
      assert.deepEqual(afterInspection?.analysis.modIds, ['voidfall_probe']);

      // The analysis was chained as its own durable job.
      const analysis = await runArtifactWorkerOnce({
        database,
        workerId: WORKER_ID,
        reader: {
          read: async () => {
            throw new Error('the analysis stage must not read artifact bytes');
          },
        },
        planFactory: planFactoryFor(sha256, 'probe-1.0.0.jar'),
        now: new Date('2026-08-05T12:00:20Z'),
      });
      assert.equal(analysis.processed, true);
      assert.equal(analysis.processed && analysis.outcome, 'analyzed');

      const analyzed = await repositories.artifactReview.findById(created.submission.submissionId);
      assert.equal(analyzed?.state, 'reviewable');
      assert.equal(analyzed?.analysis.provenBlockerCount, 0);
      const stored = await repositories.artifactReview.findCompatibilityReport(
        created.submission.submissionId,
      );
      assert.notEqual(stored, undefined);
    } finally {
      await database.close();
    }
  });

  it('blocks an artifact whose declaration excludes the target runtime', async () => {
    const { database, repositories, serverInstanceId, actor } = await fixture();
    try {
      const archive = buildZip([{ name: 'META-INF/mods.toml', content: modsToml('[1.19.2]') }]);
      const sha256 = createHash('sha256').update(archive).digest('hex');
      const created = await repositories.artifactReview.create({
        submissionId: randomUUID(),
        serverInstanceId,
        filename: 'old-1.0.0.jar',
        sha256,
        sizeBytes: archive.length,
        submittedBy: actor,
        now: new Date('2026-08-05T12:00:00Z'),
      });
      const quarantined = await repositories.artifactReview.transition({
        submissionId: created.submission.submissionId,
        to: 'quarantined',
        expectedVersion: created.submission.version,
        now: new Date('2026-08-05T12:00:05Z'),
      });
      await repositories.jobs.enqueue(
        inspectJob(created.submission.submissionId, quarantined.version, actor),
      );

      await runArtifactWorkerOnce({
        database,
        workerId: WORKER_ID,
        reader: { read: async () => archive },
        planFactory: planFactoryFor(sha256, 'old-1.0.0.jar'),
        now: new Date('2026-08-05T12:00:10Z'),
      });
      await runArtifactWorkerOnce({
        database,
        workerId: WORKER_ID,
        reader: { read: async () => archive },
        planFactory: planFactoryFor(sha256, 'old-1.0.0.jar'),
        now: new Date('2026-08-05T12:00:20Z'),
      });

      const blocked = await repositories.artifactReview.findById(created.submission.submissionId);
      assert.equal(blocked?.state, 'blocked');
      assert.equal(blocked?.analysis.verdict, 'incompatible');
      assert.ok((blocked?.analysis.provenBlockerCount ?? 0) > 0);
    } finally {
      await database.close();
    }
  });

  it('records a closed failure code when the archive is not a container', async () => {
    const { database, repositories, serverInstanceId, actor } = await fixture();
    try {
      const archive = Buffer.from('this is not a zip archive', 'utf8');
      const sha256 = createHash('sha256').update(archive).digest('hex');
      const created = await repositories.artifactReview.create({
        submissionId: randomUUID(),
        serverInstanceId,
        filename: 'broken.jar',
        sha256,
        sizeBytes: archive.length,
        submittedBy: actor,
        now: new Date('2026-08-05T12:00:00Z'),
      });
      const quarantined = await repositories.artifactReview.transition({
        submissionId: created.submission.submissionId,
        to: 'quarantined',
        expectedVersion: created.submission.version,
        now: new Date('2026-08-05T12:00:05Z'),
      });
      await repositories.jobs.enqueue(
        inspectJob(created.submission.submissionId, quarantined.version, actor),
      );

      const result = await runArtifactWorkerOnce({
        database,
        workerId: WORKER_ID,
        reader: { read: async () => archive },
        planFactory: planFactoryFor(sha256, 'broken.jar'),
        now: new Date('2026-08-05T12:00:10Z'),
      });
      assert.equal(result.processed && result.outcome, 'failed');

      const blocked = await repositories.artifactReview.findById(created.submission.submissionId);
      assert.equal(blocked?.state, 'blocked');
      assert.equal(blocked?.failure?.code, 'not-a-zip-container');
      assert.equal(blocked?.failure?.stage, 'inspection');
      // A refused artifact is never reported as inspected.
      assert.equal(blocked?.analysis.inspected, false);
    } finally {
      await database.close();
    }
  });

  it('refuses a malformed payload before touching the artifact packages', async () => {
    const { database, repositories, serverInstanceId, actor } = await fixture();
    try {
      const created = await repositories.artifactReview.create({
        submissionId: randomUUID(),
        serverInstanceId,
        filename: 'probe.jar',
        sha256: 'a'.repeat(64),
        sizeBytes: 1_024,
        submittedBy: actor,
        now: new Date('2026-08-05T12:00:00Z'),
      });
      const job = inspectJob(created.submission.submissionId, 1, actor);
      await repositories.jobs.enqueue({
        ...job,
        payload: { schemaVersion: 1, parameters: { submissionId: created.submission.submissionId } },
      });

      const result = await runArtifactWorkerOnce({
        database,
        workerId: WORKER_ID,
        reader: {
          read: async () => {
            throw new Error('a malformed payload must never reach the reader');
          },
        },
        planFactory: planFactoryFor('a'.repeat(64), 'probe.jar'),
        now: new Date('2026-08-05T12:00:10Z'),
      });
      assert.equal(result.processed && result.outcome, 'failed');

      // The submission was never moved by an unusable job.
      const untouched = await repositories.artifactReview.findById(created.submission.submissionId);
      assert.equal(untouched?.state, 'uploaded');
    } finally {
      await database.close();
    }
  });

  it('does nothing when the queue holds no artifact job', async () => {
    const { database } = await fixture();
    try {
      const result = await runArtifactWorkerOnce({
        database,
        workerId: WORKER_ID,
        reader: { read: async () => Buffer.alloc(0) },
        planFactory: planFactoryFor('a'.repeat(64), 'probe.jar'),
        now: new Date('2026-08-05T12:00:10Z'),
      });
      assert.deepEqual(result, { processed: false });
    } finally {
      await database.close();
    }
  });
});
