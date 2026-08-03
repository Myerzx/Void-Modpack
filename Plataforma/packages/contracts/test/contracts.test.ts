import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canPublishInStable,
  validateAgentEnvelope,
  validateAgentHeartbeatPayload,
  validateAuditEvent,
  validateJob,
  validateModCatalogEntry,
  validateReleaseManifest,
} from '../src/index.js';

const uuid = '018f6b8c-76a3-7d10-9f2e-1d9e52a63701';
const otherUuid = '018f6b8c-76a3-7d10-9f2e-1d9e52a63702';
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const signature = 'A'.repeat(86);

function validJob(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: uuid,
    type: 'modpack.build',
    resource: { type: 'server-instance', id: 'voidfall-primary' },
    status: 'queued',
    stage: 'awaiting-lease',
    priority: 50,
    payload: { schemaVersion: 1, parameters: { requestedVersion: '0.1.0' } },
    idempotencyKey: 'build:voidfall:0.1.0',
    requestedBy: { type: 'panel-user', id: otherUuid },
    correlationId: otherUuid,
    availableAt: '2026-08-03T12:00:00Z',
    attempt: 0,
    maxAttempts: 3,
  };
}

function validCatalogEntry(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'example-mod',
    logicalName: 'Example Mod',
    filename: 'example-mod-1.0.0.jar',
    path: 'mods/example-mod-1.0.0.jar',
    kind: 'mod',
    side: 'both',
    requirement: 'required',
    version: '1.0.0',
    sizeBytes: 1_024,
    sha256: hashA,
    runtime: {
      minecraftVersion: '1.20.1',
      loader: 'forge',
      loaderVersion: '1.20.1-47.4.4',
    },
    source: {
      provider: 'modrinth',
      projectId: 'example-project',
      fileId: 'example-file',
      sourceUrl: 'https://modrinth.com/mod/example',
    },
    distribution: {
      decision: 'allowed',
      licenseExpression: 'MIT',
      evidenceReference: 'https://modrinth.com/mod/example/license',
      reviewedBy: otherUuid,
      reviewedAt: '2026-08-03T12:00:00Z',
    },
    reviewState: 'reviewed',
    dependencies: [],
  };
}

function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    product: { id: 'voidfall', displayName: 'VoidFall' },
    release: {
      version: '0.1.0',
      buildId: 'build-20260803-120000',
      publishedAt: '2026-08-03T12:00:00Z',
      message: 'Primeiro contrato verificável.',
    },
    runtime: {
      minecraft: '1.20.1',
      loader: 'forge',
      loaderVersion: '1.20.1-47.4.4',
      javaMajor: 17,
    },
    serverProfile: { id: 'voidfall-primary', displayName: 'VoidFall' },
    files: [
      {
        path: 'config/example.toml',
        artifactId: `sha256:${hashA}`,
        size: 128,
        sha256: hashA,
        kind: 'config',
        side: 'both',
        required: true,
      },
      {
        path: 'mods/example.jar',
        artifactId: `sha256:${hashB}`,
        size: 1_024,
        sha256: hashB,
        kind: 'mod',
        side: 'both',
        required: true,
      },
    ],
    removedPaths: ['mods/old-example.jar'],
    signature: { algorithm: 'Ed25519', keyId: 'release-2026-01', value: signature },
  };
}

describe('Job', () => {
  it('accepts a queued versioned job', () => {
    assert.equal(validateJob(validJob()).success, true);
  });

  it('rejects unknown top-level fields', () => {
    const job = { ...validJob(), command: 'rm -rf .' };
    assert.equal(validateJob(job).success, false);
  });

  it('requires a lease for running jobs', () => {
    const job = { ...validJob(), status: 'running' };
    const result = validateJob(job);
    assert.equal(result.success, false);
    assert.ok(!result.success && result.issues.some((issue) => issue.path === '/lease'));
  });
});

describe('AgentEnvelope', () => {
  it('accepts the shape of a signed, expiring envelope', () => {
    const envelope = {
      schemaVersion: 1,
      messageId: uuid,
      correlationId: otherUuid,
      agentId: uuid,
      serverInstanceId: otherUuid,
      kind: 'heartbeat',
      issuedAt: '2026-08-03T12:00:00Z',
      expiresAt: '2026-08-03T12:05:00Z',
      nonce: 'n'.repeat(43),
      payloadHash: hashA,
      payload: { schemaVersion: 1, data: { state: 'online' } },
      signature: { algorithm: 'Ed25519', keyId: 'agent-2026-01', value: signature },
    };
    assert.equal(validateAgentEnvelope(envelope).success, true);
  });

  it('rejects an envelope whose expiry precedes issuance', () => {
    const envelope = {
      schemaVersion: 1,
      messageId: uuid,
      correlationId: otherUuid,
      agentId: uuid,
      serverInstanceId: otherUuid,
      kind: 'heartbeat',
      issuedAt: '2026-08-03T12:05:00Z',
      expiresAt: '2026-08-03T12:00:00Z',
      nonce: 'n'.repeat(43),
      payloadHash: hashA,
      payload: { schemaVersion: 1, data: {} },
      signature: { algorithm: 'Ed25519', keyId: 'agent-2026-01', value: signature },
    };
    assert.equal(validateAgentEnvelope(envelope).success, false);
  });

  it('validates heartbeat payloads separately from the generic envelope', () => {
    assert.equal(
      validateAgentHeartbeatPayload({
        status: 'online',
        observedAt: '2026-08-03T12:00:00Z',
        protocolVersion: 1,
        softwareVersion: '0.1.0',
        capabilities: ['heartbeat'],
      }).success,
      true,
    );
    assert.equal(
      validateAgentHeartbeatPayload({ status: 'online', capabilities: ['process.control'] }).success,
      false,
    );
  });
});

describe('ModCatalogEntry', () => {
  it('accepts reviewed provenance and allows stable publication', () => {
    const result = validateModCatalogEntry(validCatalogEntry());
    assert.equal(result.success, true);
    assert.ok(result.success && canPublishInStable(result.value));
  });

  it('keeps unknown-side entries out of stable', () => {
    const result = validateModCatalogEntry({ ...validCatalogEntry(), side: 'unknown' });
    assert.equal(result.success, true);
    assert.ok(result.success && !canPublishInStable(result.value));
  });

  it('rejects allowed distribution without review evidence', () => {
    const entry = validCatalogEntry();
    entry.distribution = { decision: 'allowed' };
    assert.equal(validateModCatalogEntry(entry).success, false);
  });
});

describe('ReleaseManifest', () => {
  it('accepts a canonical VoidFall manifest', () => {
    assert.equal(validateReleaseManifest(validManifest()).success, true);
  });

  it('rejects a different product identity', () => {
    const manifest = validManifest();
    manifest.product = { id: 'another-pack', displayName: 'Another Pack' };
    assert.equal(validateReleaseManifest(manifest).success, false);
  });

  it('rejects traversal and duplicate cross-platform paths', () => {
    const traversal = validManifest();
    const traversalFiles = traversal.files as Array<Record<string, unknown>>;
    traversalFiles[0] = { ...traversalFiles[0], path: '../server.properties' };
    assert.equal(validateReleaseManifest(traversal).success, false);

    const duplicate = validManifest();
    const duplicateFiles = duplicate.files as Array<Record<string, unknown>>;
    duplicateFiles[1] = { ...duplicateFiles[1], path: 'CONFIG/EXAMPLE.TOML' };
    assert.equal(validateReleaseManifest(duplicate).success, false);
  });
});

describe('AuditEvent', () => {
  it('accepts sanitized audit data', () => {
    const event = {
      schemaVersion: 1,
      id: uuid,
      occurredAt: '2026-08-03T12:00:00Z',
      correlationId: otherUuid,
      actor: { type: 'panel-user', id: otherUuid },
      source: 'api',
      action: 'modpack.build.requested',
      resource: { type: 'build', id: 'build-20260803-120000' },
      outcome: 'succeeded',
      after: { requestedVersion: '0.1.0' },
    };
    assert.equal(validateAuditEvent(event).success, true);
  });

  it('rejects secret-bearing keys at any depth', () => {
    const event = {
      schemaVersion: 1,
      id: uuid,
      occurredAt: '2026-08-03T12:00:00Z',
      correlationId: otherUuid,
      actor: { type: 'panel-user', id: otherUuid },
      source: 'api',
      action: 'agent.config.changed',
      resource: { type: 'agent', id: uuid },
      outcome: 'succeeded',
      after: { nested: { accessToken: '[REDACTED]' } },
    };
    assert.equal(validateAuditEvent(event).success, false);
  });
});
