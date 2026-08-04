import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { verifyAgentEnvelopeSignature } from '@voidfall/authentication';
import {
  OPENLOADER_ADVANCED_OPTIONS_V1 as OPENLOADER_SCHEMA_V1,
  hashConfigurationSchema,
} from '@voidfall/configuration-schemas';
import { validateAgentEnvelope, type ConfigurationOperationCommand } from '@voidfall/contracts';
import { createRepositories, runMigrations } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type {
  ConfigurationConsistencyLease,
  OfflineExclusiveConfigurationGuard,
} from '@voidfall/server-configuration';

import {
  AGENT_CONFIGURATION_CAPABILITY,
  ConfigurationCapabilityError,
  ConfigurationOperationCapability,
  createConfigurationResultEnvelope,
} from '../src/configuration-operation.js';

const NOW = new Date('2026-08-04T12:00:00.000Z');
const RESOURCE_ID = 'openloader-advanced-options';

class OfflineGuard implements OfflineExclusiveConfigurationGuard {
  async runWithExclusiveOfflineAccess<T>(
    _resourceId: string,
    operation: (lease: ConfigurationConsistencyLease) => Promise<T>,
  ): Promise<T> {
    return operation({ method: 'offline-exclusive-v1', acquiredAt: NOW });
  }
}

function digest(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

function openLoaderDocument(dataPacks: boolean, resourcePacks: boolean): string {
  return `${JSON.stringify(
    {
      resourcePacks: { enabled: resourcePacks, additionalFolders: [] },
      dataPacks: { enabled: dataPacks, additionalFolders: [] },
    },
    null,
    2,
  )}\n`;
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'voidfall-agent-configuration-'));
  const configurationRoot = join(root, 'instance');
  const revisionRepositoryRoot = join(root, 'revision-repository');
  const openLoaderDirectory = join(configurationRoot, 'config', 'openloader');
  const filePath = join(openLoaderDirectory, 'advanced_options.json');
  const original = openLoaderDocument(true, true);
  await mkdir(openLoaderDirectory, { recursive: true });
  await mkdir(revisionRepositoryRoot);
  await writeFile(filePath, original, 'utf8');

  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'voidfall-agent-test',
    displayName: 'VoidFall Agent Test',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '1.20.1-47.4.4',
    maxPlayers: 20,
  });
  const actorId = randomUUID();
  await repositories.configuration.registerSchema({
    revisionId: 'openloader-schema-1',
    schema: OPENLOADER_SCHEMA_V1,
    expectedSchemaSha256: null,
    actorId,
    reasonCode: 'phase-7-3-fixture',
    createdAt: NOW.toISOString(),
  });
  await repositories.configuration.registerResource({
    serverInstanceId: server.id,
    resourceId: RESOURCE_ID,
    expectedSchemaSha256: hashConfigurationSchema(OPENLOADER_SCHEMA_V1),
    initialCurrentSha256: digest(original),
    createdAt: NOW.toISOString(),
  });

  const capability = new ConfigurationOperationCapability({
    serverInstanceId: server.id,
    runtime: {
      configurationRoot,
      revisionRepositoryRoot,
      authorizedResourceIds: [RESOURCE_ID],
    },
    guard: new OfflineGuard(),
    configurationRepository: repositories.configuration,
    operationalLocks: repositories.operationalLocks,
    clock: () => NOW,
  });

  return {
    root,
    filePath,
    original,
    database,
    repositories,
    server,
    capability,
    async close() {
      await database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function command(
  serverInstanceId: string,
  overrides: Partial<ConfigurationOperationCommand> = {},
): ConfigurationOperationCommand {
  return {
    schemaVersion: 1,
    operation: 'update',
    serverInstanceId,
    resourceId: RESOURCE_ID,
    revisionId: 'agent-update-1',
    sourceRevisionId: null,
    expectedCurrentSha256: digest(openLoaderDocument(true, true)),
    expectedStateVersion: 1,
    reasonCode: 'operator-request',
    correlationId: randomUUID(),
    actor: { type: 'panel-user', id: randomUUID() },
    changes: [{ name: 'dataPacks.enabled', value: false }],
    ...overrides,
  } as ConfigurationOperationCommand;
}

describe('server agent typed configuration capability', () => {
  it('declares only the configuration capability', async () => {
    const context = await harness();
    try {
      assert.deepEqual(context.capability.capabilities(), [AGENT_CONFIGURATION_CAPABILITY]);
      assert.equal(AGENT_CONFIGURATION_CAPABILITY, 'configuration.apply');
    } finally {
      await context.close();
    }
  });

  it('applies a typed command against the temporary directory and audits it', async () => {
    const context = await harness();
    try {
      const result = await context.capability.execute(command(context.server.id));

      assert.equal(result.outcome, 'applied');
      assert.equal(result.operation, 'update');
      assert.deepEqual(result.changedFields, ['dataPacks.enabled']);
      assert.equal(result.restartRequired, true);
      assert.equal(result.failureCode, null);
      assert.equal(result.previousSha256, digest(context.original));

      const written = await readFile(context.filePath, 'utf8');
      assert.equal(written, openLoaderDocument(false, true));
      assert.equal(result.currentSha256, digest(written));

      const revision = await context.repositories.configuration.revision('agent-update-1');
      assert.equal(revision?.status, 'applied');
      const state = await context.repositories.configuration.state(context.server.id, RESOURCE_ID);
      assert.equal(state?.status, 'applied');
      assert.equal(state?.currentSha256, digest(written));

      // The audit trail records the transition without any configuration value.
      const events = await context.repositories.audit.listChain('configuration', 1, 100);
      assert.equal(events.length > 0, true);
      const serialized = JSON.stringify(events);
      assert.equal(serialized.includes('dataPacks'), true);
      assert.equal(/"value"\s*:/u.test(serialized), false);
      assert.equal(serialized.includes(context.root), false);
    } finally {
      await context.close();
    }
  });

  it('refuses a resource, schema or instance the trusted local configuration does not authorize', async () => {
    const context = await harness();
    try {
      await assert.rejects(
        context.capability.execute(command(context.server.id, { resourceId: 'server-basic' })),
        (error: unknown) => {
          assert.ok(error instanceof ConfigurationCapabilityError);
          assert.equal(error.code, 'resource-not-authorized');
          return true;
        },
      );
      await assert.rejects(
        context.capability.execute(command(randomUUID())),
        (error: unknown) => {
          assert.ok(error instanceof ConfigurationCapabilityError);
          assert.equal(error.code, 'server-instance-mismatch');
          return true;
        },
      );
      // Nothing was written or persisted by a refused command.
      assert.equal(await readFile(context.filePath, 'utf8'), context.original);
      assert.equal(await context.repositories.configuration.revision('agent-update-1'), undefined);
    } finally {
      await context.close();
    }
  });

  it('never accepts a root, path or free command through the envelope', async () => {
    const context = await harness();
    try {
      for (const injected of ['configurationRoot', 'filePath', 'command', 'repositoryRoot']) {
        await assert.rejects(
          context.capability.execute({
            ...command(context.server.id),
            [injected]: join(context.root, 'elsewhere'),
          }),
          (error: unknown) => {
            assert.ok(error instanceof ConfigurationCapabilityError);
            assert.equal(error.code, 'invalid-command');
            return true;
          },
        );
      }
      // A field name outside the reviewed schema is shaped like a valid one, so
      // it passes the wire contract and must be stopped by the reviewed codec.
      // It may never be written, and the reported code may not echo the field.
      const unknownField = await context.capability.execute({
        ...command(context.server.id),
        changes: [{ name: 'rcon.password', value: 'secret' }],
      });
      assert.equal(unknownField.outcome, 'failed');
      assert.deepEqual(unknownField.changedFields, []);
      assert.equal(JSON.stringify(unknownField).includes('secret'), false);
      assert.equal(await readFile(context.filePath, 'utf8'), context.original);
    } finally {
      await context.close();
    }
  });

  it('reports a sanitized failure for a stale hash without leaking the host', async () => {
    const context = await harness();
    try {
      const result = await context.capability.execute(
        command(context.server.id, { expectedCurrentSha256: 'f'.repeat(64) }),
      );
      assert.equal(result.outcome, 'failed');
      assert.equal(result.failureCode, 'concurrent-modification');
      assert.deepEqual(result.changedFields, []);
      assert.equal(result.currentSha256, null);
      assert.equal(JSON.stringify(result).includes(context.root), false);
      assert.equal(await readFile(context.filePath, 'utf8'), context.original);
    } finally {
      await context.close();
    }
  });

  it('rolls back to an applied revision and refuses an unknown source', async () => {
    const context = await harness();
    try {
      await context.capability.execute(command(context.server.id));
      const updated = openLoaderDocument(false, true);

      const rollback = await context.capability.execute(
        command(context.server.id, {
          operation: 'rollback',
          revisionId: 'agent-rollback-1',
          sourceRevisionId: 'agent-update-1',
          expectedCurrentSha256: digest(updated),
          expectedStateVersion: 3,
          changes: [],
        }),
      );
      assert.equal(rollback.outcome, 'applied');
      assert.equal(await readFile(context.filePath, 'utf8'), context.original);

      const unknownSource = await context.capability.execute(
        command(context.server.id, {
          operation: 'rollback',
          revisionId: 'agent-rollback-2',
          sourceRevisionId: 'agent-update-missing',
          expectedCurrentSha256: digest(context.original),
          expectedStateVersion: 5,
          changes: [],
        }),
      );
      assert.equal(unknownSource.outcome, 'failed');
      assert.equal(unknownSource.failureCode, 'invalid-transition');
    } finally {
      await context.close();
    }
  });

  it('signs an outbound-only result envelope without values or paths', async () => {
    const context = await harness();
    try {
      const result = await context.capability.execute(command(context.server.id));
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const correlationId = randomUUID();
      const envelope = createConfigurationResultEnvelope(
        {
          agentId: randomUUID(),
          serverInstanceId: context.server.id,
          privateKey,
          keyId: 'agent-key',
        },
        { result, correlationId, observedAt: NOW },
      );

      assert.equal(validateAgentEnvelope(envelope).success, true);
      assert.equal(verifyAgentEnvelopeSignature(envelope, publicKey), true);
      assert.equal(envelope.correlationId, correlationId);
      assert.equal(envelope.kind, 'job.event');
      const serialized = JSON.stringify(envelope);
      assert.equal(serialized.includes(context.root), false);
      assert.equal(serialized.includes('advanced_options.json'), false);
    } finally {
      await context.close();
    }
  });
});
