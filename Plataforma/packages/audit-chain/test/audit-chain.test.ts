import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AuditEvent } from '@voidfall/contracts';
import {
  AuditChainError,
  InMemoryAuditChain,
  chainAuditEvent,
  createAuditExport,
  sha256,
  verifyAuditChain,
  type AuditChainRecord,
} from '../src/index.js';

const eventId1 = '018f6b8c-76a3-7d10-9f2e-1d9e52a63701';
const eventId2 = '018f6b8c-76a3-7d10-9f2e-1d9e52a63702';
const eventId3 = '018f6b8c-76a3-7d10-9f2e-1d9e52a63703';
const correlationId = '018f6b8c-76a3-7d10-9f2e-1d9e52a63704';
const actorId = '018f6b8c-76a3-7d10-9f2e-1d9e52a63705';
const exportId = '018f6b8c-76a3-7d10-9f2e-1d9e52a63706';

function event(id: string, action = 'player.profile.observed'): AuditEvent {
  return {
    schemaVersion: 1,
    id,
    occurredAt: '2026-08-03T12:00:00.000Z',
    correlationId,
    actor: { type: 'panel-user', id: actorId },
    source: 'api',
    action,
    resource: { type: 'player', id: eventId1 },
    outcome: 'succeeded',
    reason: 'Sanitized fixture event.',
    metadata: { revision: 1, status: 'active' },
  };
}

function assertCode(block: () => unknown, code: AuditChainError['code']): void {
  assert.throws(block, (error: unknown) => {
    assert.ok(error instanceof AuditChainError);
    assert.equal(error.code, code);
    return true;
  });
}

describe('partitioned audit chain', () => {
  it('creates contiguous per-partition chains with independent heads', () => {
    const chain = new InMemoryAuditChain({
      maximumPartitions: 4,
      maximumRecordsPerPartition: 10,
    });
    const first = chain.append('administrative', event(eventId1));
    const second = chain.append('administrative', event(eventId2, 'player.profile.updated'));
    const security = chain.append('security', event(eventId3, 'authorization.denied'));
    assert.equal(first.sequence, 1);
    assert.equal(first.event.integrity?.previousHash, null);
    assert.equal(second.sequence, 2);
    assert.equal(second.event.integrity?.previousHash, first.event.integrity?.eventHash);
    assert.equal(security.sequence, 1);
    assert.equal(security.event.integrity?.previousHash, null);
    assert.equal(chain.verify('administrative').valid, true);
    assert.equal(chain.verify('security').valid, true);
  });

  it('produces deterministic hashes for equivalent sanitized events', () => {
    const first = chainAuditEvent({
      partitionId: 'administrative',
      sequence: 1,
      previousHash: null,
      event: event(eventId1),
    });
    const reordered: AuditEvent = {
      ...event(eventId1),
      metadata: { status: 'active', revision: 1 },
    };
    const second = chainAuditEvent({
      partitionId: 'administrative',
      sequence: 1,
      previousHash: null,
      event: reordered,
    });
    assert.equal(first.event.integrity?.eventHash, second.event.integrity?.eventHash);
  });

  it('rejects producer-supplied integrity and secret-bearing audit data', () => {
    assertCode(
      () =>
        chainAuditEvent({
          partitionId: 'administrative',
          sequence: 1,
          previousHash: null,
          event: {
            ...event(eventId1),
            integrity: { previousHash: null, eventHash: 'a'.repeat(64) },
          },
        }),
      'producer-owned-integrity',
    );
    assertCode(
      () =>
        chainAuditEvent({
          partitionId: 'administrative',
          sequence: 1,
          previousHash: null,
          event: { ...event(eventId1), metadata: { accessToken: '[REDACTED]' } },
        }),
      'invalid-event',
    );
  });

  it('detects altered content, sequence gaps and duplicate event IDs', () => {
    const first = chainAuditEvent({
      partitionId: 'administrative',
      sequence: 1,
      previousHash: null,
      event: event(eventId1),
    });
    const second = chainAuditEvent({
      partitionId: 'administrative',
      sequence: 2,
      previousHash: first.event.integrity?.eventHash ?? null,
      event: event(eventId2, 'player.profile.updated'),
    });
    const tampered: AuditChainRecord = {
      ...second,
      sequence: 3,
      event: { ...second.event, id: eventId1, reason: 'Altered after append.' },
    };
    const result = verifyAuditChain([first, tampered]);
    assert.equal(result.valid, false);
    assert.ok(!result.valid && result.issues.some((issue) => issue.code === 'sequence-gap'));
    assert.ok(!result.valid && result.issues.some((issue) => issue.code === 'duplicate-event'));
    assert.ok(!result.valid && result.issues.some((issue) => issue.code === 'event-hash-mismatch'));
  });

  it('enforces partition, record and event uniqueness limits', () => {
    const chain = new InMemoryAuditChain({
      maximumPartitions: 1,
      maximumRecordsPerPartition: 1,
    });
    chain.append('administrative', event(eventId1));
    assertCode(() => chain.append('administrative', event(eventId2)), 'record-limit-exceeded');
    assertCode(() => chain.append('security', event(eventId3)), 'partition-limit-exceeded');
    assertCode(() => chain.append('security', event(eventId1)), 'duplicate-event');
  });
});

describe('audit export', () => {
  it('exports reproducible canonical NDJSON with a verified manifest', () => {
    const chain = new InMemoryAuditChain({
      maximumPartitions: 2,
      maximumRecordsPerPartition: 10,
    });
    chain.append('administrative', event(eventId1));
    chain.append('administrative', event(eventId2, 'player.profile.updated'));
    const request = {
      exportId,
      generatedAt: '2026-08-03T12:10:00.000Z',
    };
    const first = chain.export('administrative', request);
    const second = createAuditExport(chain.list('administrative'), request);
    assert.deepEqual(second, first);
    assert.equal(first.manifest.recordCount, 2);
    assert.equal(first.manifest.firstSequence, 1);
    assert.equal(first.manifest.lastSequence, 2);
    assert.equal(first.manifest.contentSha256, sha256(first.content));
    assert.equal(first.content.endsWith('\n'), true);
    assert.equal(first.content.trimEnd().split('\n').length, 2);
    assert.equal(Object.isFrozen(first.manifest), true);
  });

  it('supports a contiguous subrange and rejects empty or missing ranges', () => {
    const chain = new InMemoryAuditChain({
      maximumPartitions: 2,
      maximumRecordsPerPartition: 10,
    });
    chain.append('administrative', event(eventId1));
    chain.append('administrative', event(eventId2));
    chain.append('administrative', event(eventId3));
    const artifact = chain.export('administrative', {
      exportId,
      generatedAt: '2026-08-03T12:10:00.000Z',
      firstSequence: 2,
      lastSequence: 3,
    });
    assert.equal(artifact.manifest.firstSequence, 2);
    assert.equal(artifact.manifest.previousHash, chain.list('administrative')[0]?.event.integrity?.eventHash);
    assertCode(
      () =>
        chain.export('administrative', {
          exportId,
          generatedAt: '2026-08-03T12:10:00.000Z',
          firstSequence: 4,
          lastSequence: 4,
        }),
      'invalid-export-range',
    );
    assertCode(
      () =>
        new InMemoryAuditChain({ maximumPartitions: 1, maximumRecordsPerPartition: 1 }).export(
          'administrative',
          { exportId, generatedAt: '2026-08-03T12:10:00.000Z' },
        ),
      'partition-not-found',
    );
  });
});
