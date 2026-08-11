import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { AgentWorkLease, ArtifactSubmission, ServerOperation } from '@voidfall/contracts';
import type { Repositories } from '@voidfall/database';
import type { MinecraftProcessAdapter } from '@voidfall/minecraft-process';

import { createArtifactInstallHandler } from '../src/artifact-install-operation.js';

const directories: string[] = [];
const SERVER_ID = '11111111-1111-4111-8111-111111111111';
const SUBMISSION_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const OPERATION_ID = '44444444-4444-4444-8444-444444444444';
const bytes = Buffer.from('reviewed server mod');
const sha256 = createHash('sha256').update(bytes).digest('hex');

afterEach(async () => {
  while (directories.length > 0) await rm(directories.pop()!, { recursive: true, force: true });
});

function operation(): ServerOperation {
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    serverInstanceId: SERVER_ID,
    kind: 'artifact.install',
    status: 'running',
    idempotencyKey: 'artifact-install-test',
    requestFingerprint: 'a'.repeat(64),
    correlationId: '55555555-5555-4555-8555-555555555555',
    jobId: JOB_ID,
    requestedBy: { type: 'panel-user', id: '66666666-6666-4666-8666-666666666666' },
    reasonCode: 'operator-approved',
    consoleCommand: null,
    backupId: null,
    artifactSubmissionId: SUBMISSION_ID,
    receipt: null,
    version: 2,
    acceptedAt: '2026-08-11T20:00:00.000Z',
    updatedAt: '2026-08-11T20:00:00.000Z',
  };
}

function submission(): ArtifactSubmission {
  return {
    schemaVersion: 1,
    submissionId: SUBMISSION_ID,
    filename: 'reviewed-mod.jar',
    sha256,
    sizeBytes: bytes.byteLength,
    state: 'approved',
    submittedBy: { type: 'panel-user', id: '66666666-6666-4666-8666-666666666666' },
    reviewedSide: 'server',
    submittedAt: '2026-08-11T19:00:00.000Z',
    updatedAt: '2026-08-11T20:00:00.000Z',
    version: 5,
    analysis: {
      inspected: true,
      analyzed: true,
      loaders: ['forge'],
      modIds: ['reviewed_mod'],
      declaredVersions: ['1.0.0'],
      verdict: 'compatible',
      blockerCount: 0,
      warningCount: 0,
      informationCount: 0,
      provenBlockerCount: 0,
    },
    failure: null,
    decision: {
      decision: 'approved',
      actor: { type: 'panel-user', id: '66666666-6666-4666-8666-666666666666' },
      reasonCode: 'operator-approved',
      analyzedSha256: sha256,
      decidedAt: '2026-08-11T20:00:00.000Z',
    },
  };
}

function lease(): AgentWorkLease {
  return {
    schemaVersion: 1,
    leaseId: '77777777-7777-4777-8777-777777777777',
    jobId: JOB_ID,
    capability: 'artifact.install',
    jobType: 'artifact.install',
    correlationId: '55555555-5555-4555-8555-555555555555',
    parameters: { resourceType: 'server-instance', resourceId: SERVER_ID, expectedVersion: 1 },
    leasedAt: '2026-08-11T20:00:00.000Z',
    expiresAt: '2026-08-11T20:05:00.000Z',
    attempt: 1,
  };
}

async function fixture(lifecycle: 'offline' | 'online') {
  const root = await mkdtemp(join(tmpdir(), 'voidfall-artifact-install-'));
  directories.push(root);
  let acquired = 0;
  let released = 0;
  const repositories = {
    operations: { findByJobId: async () => operation() },
    artifactReview: {
      findById: async () => submission(),
      serverInstanceIdFor: async () => SERVER_ID,
    },
    operationalLocks: {
      acquire: async () => {
        acquired += 1;
      },
      release: async () => {
        released += 1;
        return true;
      },
    },
  } as unknown as Repositories;
  const processAdapter = {
    inspect: async () => ({
      state: lifecycle,
      source: 'process-adapter',
      observedAt: '2026-08-11T20:00:00.000Z',
    }),
  } as unknown as MinecraftProcessAdapter;
  return {
    root,
    counts: () => ({ acquired, released }),
    handler: createArtifactInstallHandler({
      repositories,
      reader: { read: async () => bytes },
      processAdapter,
      serverInstanceId: SERVER_ID,
      serverRoot: root,
      clock: () => new Date('2026-08-11T20:00:00.000Z'),
    }),
  };
}

describe('artifact installation capability', () => {
  it('atomically installs the exact approved bytes while the server is offline', async () => {
    const context = await fixture('offline');
    assert.deepEqual(await context.handler(lease()), {
      outcome: 'succeeded',
      observedLifecycle: 'offline',
    });
    assert.deepEqual(await readFile(join(context.root, 'mods', 'reviewed-mod.jar')), bytes);
    assert.deepEqual(context.counts(), { acquired: 1, released: 1 });
  });

  it('refuses installation when the process is online and leaves no mod behind', async () => {
    const context = await fixture('online');
    assert.deepEqual(await context.handler(lease()), {
      outcome: 'failed',
      failureCode: 'precondition-not-met',
    });
    await assert.rejects(readFile(join(context.root, 'mods', 'reviewed-mod.jar')));
    assert.deepEqual(context.counts(), { acquired: 1, released: 1 });
  });
});
