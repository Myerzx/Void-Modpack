import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';

import {
  MINECRAFT_SERVER_PROPERTIES_V1 as MINECRAFT_SERVER_SCHEMA_V1,
  OPENLOADER_ADVANCED_OPTIONS_V1 as OPENLOADER_SCHEMA_V1,
  hashConfigurationSchema,
} from '@voidfall/configuration-schemas';
import { createRepositories, runMigrations } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';

import {
  ConfigurationOperationError,
  FilesystemConfigurationService,
  JAVA_PROPERTIES_V1,
  PersistentConfigurationService,
  createReviewedConfigurationResource,
  describeReviewedConfiguration,
  isPublishableConfigurationField,
  listReviewedConfigurationIds,
  parseConfigurationRevisionManifest,
  presentConfigurationValues,
  type ApplyConfigurationPlan,
  type ConfigurationConsistencyLease,
  type ConfigurationFileReplacer,
  type ConfigurationReplacementInput,
  type ConfigurationResourceDefinition,
  type OfflineExclusiveConfigurationGuard,
} from '../src/index.js';

const NOW = new Date('2026-08-03T20:00:00.000Z');
const ORIGINAL_LF = [
  '# VoidFall básico',
  'online-mode=true',
  'max-players=20',
  'difficulty=normal',
  'motd=VoidFall',
  '',
].join('\n');

function digest(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

class TrackingGuard implements OfflineExclusiveConfigurationGuard {
  available = true;
  active = false;
  readonly calls: string[] = [];

  async runWithExclusiveOfflineAccess<T>(
    resourceId: string,
    operation: (lease: ConfigurationConsistencyLease) => Promise<T>,
  ): Promise<T> {
    this.calls.push(resourceId);
    if (!this.available) throw new Error('private guard failure at H:\\secret-server');
    assert.equal(this.active, false);
    this.active = true;
    try {
      return await operation({ method: 'offline-exclusive-v1', acquiredAt: NOW });
    } finally {
      this.active = false;
    }
  }
}

class GuardAwareReplacer implements ConfigurationFileReplacer {
  constructor(private readonly guard: TrackingGuard) {}

  async replace(input: ConfigurationReplacementInput): Promise<void> {
    assert.equal(this.guard.active, true);
    await writeFile(input.temporaryPath, input.content, {
      flag: 'wx',
      mode: input.mode,
    });
    await rename(input.temporaryPath, input.targetPath);
  }
}

class FailingReplacer implements ConfigurationFileReplacer {
  async replace(): Promise<void> {
    throw new Error('private replacement failure');
  }
}

class CorruptingReplacer implements ConfigurationFileReplacer {
  async replace(input: ConfigurationReplacementInput): Promise<void> {
    const text = new TextDecoder().decode(input.content);
    const corrupted = text.replace('max-players=30', 'max-players=31');
    await writeFile(input.temporaryPath, corrupted, { flag: 'wx', mode: input.mode });
    await rename(input.temporaryPath, input.targetPath);
  }
}

interface Fixture {
  readonly root: string;
  readonly configurationDirectory: string;
  readonly filePath: string;
  readonly repositoryRoot: string;
  readonly resource: ConfigurationResourceDefinition;
}

function fields(): ConfigurationResourceDefinition['fields'] {
  return Object.freeze({
    'online-mode': Object.freeze({ type: 'boolean', restartRequired: true }),
    'max-players': Object.freeze({
      type: 'integer',
      minimum: 1,
      maximum: 100,
      restartRequired: false,
    }),
    difficulty: Object.freeze({
      type: 'enum',
      values: Object.freeze(['peaceful', 'easy', 'normal', 'hard']),
      restartRequired: true,
    }),
    motd: Object.freeze({
      type: 'string',
      maximumLength: 64,
      restartRequired: false,
    }),
  });
}

async function createFixture(content = ORIGINAL_LF): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'voidfall-configuration-'));
  const configurationDirectory = join(root, 'configuration');
  const repositoryRoot = join(root, 'revision-repository');
  const filePath = join(configurationDirectory, 'server.properties');
  await mkdir(configurationDirectory);
  await mkdir(repositoryRoot);
  await writeFile(filePath, content, 'utf8');
  return Object.freeze({
    root,
    configurationDirectory,
    filePath,
    repositoryRoot,
    resource: Object.freeze({
      resourceId: 'server-basic',
      schemaId: 'server-basic',
      schemaVersion: 'v1',
      schemaSha256: '1'.repeat(64),
      filePath,
      format: JAVA_PROPERTIES_V1,
      maximumBytes: 4096,
      fields: fields(),
    }),
  });
}

function service(
  fixture: Fixture,
  guard: TrackingGuard,
  options: {
    readonly resource?: ConfigurationResourceDefinition;
    readonly repositoryRoot?: string;
    readonly replacer?: ConfigurationFileReplacer;
    readonly clock?: () => Date;
  } = {},
): FilesystemConfigurationService {
  return new FilesystemConfigurationService({
    repositoryRoot: options.repositoryRoot ?? fixture.repositoryRoot,
    resources: [options.resource ?? fixture.resource],
    guard,
    clock: options.clock ?? (() => NOW),
    ...(options.replacer === undefined ? {} : { fileReplacer: options.replacer }),
  });
}

function plan(
  fixture: Fixture,
  revisionId: string,
  changes: ApplyConfigurationPlan['changes'],
  expectedContent = ORIGINAL_LF,
): ApplyConfigurationPlan {
  return Object.freeze({
    resourceId: fixture.resource.resourceId,
    revisionId,
    expectedCurrentSha256: digest(expectedContent),
    reasonCode: 'operator-change',
    changes,
  });
}

async function expectCode(
  operation: Promise<unknown>,
  code: ConfigurationOperationError['code'],
  forbiddenText?: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof ConfigurationOperationError);
    assert.equal(error.code, code);
    if (forbiddenText !== undefined) assert.doesNotMatch(error.message, new RegExp(forbiddenText, 'iu'));
    return true;
  });
}

async function removeFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}

describe('typed configuration revisions', () => {
  it('coordinates PostgreSQL state, shared lock, filesystem and audit for OpenLoader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'voidfall-persistent-configuration-'));
    const database = await createPGliteTestDatabase();
    try {
      await runMigrations(database);
      const repositories = createRepositories(database);
      const serverInstanceId = '018f6b8c-76a3-7d10-9f2e-1d9e52a63702';
      const actorId = '018f6b8c-76a3-7d10-9f2e-1d9e52a63703';
      await repositories.servers.create({
        id: serverInstanceId,
        slug: 'persistent-configuration',
        displayName: 'Persistent Configuration',
        environment: 'test',
        minecraftVersion: '1.20.1',
        loader: 'forge',
        loaderVersion: '47.4.4',
        maxPlayers: 20,
      });
      const configurationRoot = join(root, 'instance');
      const openLoaderDirectory = join(configurationRoot, 'config', 'openloader');
      const repositoryRoot = join(root, 'revision-repository');
      const filePath = join(openLoaderDirectory, 'advanced_options.json');
      const original = `${JSON.stringify(
        {
          resourcePacks: { enabled: true, additionalFolders: [] },
          dataPacks: { enabled: true, additionalFolders: [] },
        },
        null,
        2,
      )}\n`;
      await mkdir(openLoaderDirectory, { recursive: true });
      await mkdir(repositoryRoot);
      await writeFile(filePath, original, 'utf8');
      const schemaSha256 = hashConfigurationSchema(OPENLOADER_SCHEMA_V1);
      await repositories.configuration.registerSchema({
        revisionId: 'openloader-schema-v1',
        actorId,
        reasonCode: 'reviewed-schema',
        createdAt: NOW.toISOString(),
        expectedSchemaSha256: null,
        schema: OPENLOADER_SCHEMA_V1,
      });
      await repositories.configuration.registerResource({
        serverInstanceId,
        resourceId: 'openloader-advanced-options',
        expectedSchemaSha256: schemaSha256,
        initialCurrentSha256: digest(original),
        createdAt: NOW.toISOString(),
      });
      const guard = new TrackingGuard();
      const resource = createReviewedConfigurationResource(
        configurationRoot,
        'openloader-advanced-options',
      );
      const filesystem = new FilesystemConfigurationService({
        repositoryRoot,
        resources: [resource],
        guard,
        clock: () => NOW,
      });
      const generatedIds = [
        '018f6b8c-76a3-7d10-9f2e-1d9e52a63704',
        '018f6b8c-76a3-7d10-9f2e-1d9e52a63705',
        '018f6b8c-76a3-7d10-9f2e-1d9e52a63706',
        '018f6b8c-76a3-7d10-9f2e-1d9e52a63707',
        '018f6b8c-76a3-7d10-9f2e-1d9e52a63708',
        '018f6b8c-76a3-7d10-9f2e-1d9e52a63709',
      ];
      const persistent = new PersistentConfigurationService({
        serverInstanceId,
        filesystem,
        configurationRepository: repositories.configuration,
        operationalLocks: repositories.operationalLocks,
        clock: () => NOW,
        idGenerator: () => generatedIds.shift() ?? 'invalid',
      });

      const update = await persistent.applyConfiguration({
        resourceId: resource.resourceId,
        revisionId: 'persistent-openloader-update',
        expectedCurrentSha256: digest(original),
        expectedStateVersion: 1,
        reasonCode: 'operator-change',
        changes: { 'dataPacks.enabled': false },
        actor: { type: 'panel-user', id: actorId },
        correlationId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63710',
      });
      const updated = await readFile(filePath, 'utf8');
      assert.equal(update.persistence.state.status, 'applied');
      assert.equal(update.persistence.state.version, 3);
      assert.equal(update.persistence.auditSequence, 1);
      assert.equal(
        await repositories.operationalLocks.current(serverInstanceId, 'minecraft-exclusive'),
        undefined,
      );

      const rollback = await persistent.rollbackConfiguration({
        resourceId: resource.resourceId,
        revisionId: 'persistent-openloader-rollback',
        sourceRevisionId: update.filesystem.revisionId,
        expectedCurrentSha256: digest(updated),
        expectedStateVersion: update.persistence.state.version,
        reasonCode: 'operator-rollback',
        actor: { type: 'panel-user', id: actorId },
        correlationId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63711',
      });
      assert.equal(rollback.persistence.revision.operation, 'rollback');
      assert.equal(rollback.persistence.state.version, 5);
      assert.equal(await readFile(filePath, 'utf8'), original);

      guard.available = false;
      await assert.rejects(
        persistent.applyConfiguration({
          resourceId: resource.resourceId,
          revisionId: 'persistent-openloader-failure',
          expectedCurrentSha256: digest(original),
          expectedStateVersion: rollback.persistence.state.version,
          reasonCode: 'guard-failure',
          changes: { 'resourcePacks.enabled': false },
          actor: { type: 'panel-user', id: actorId },
          correlationId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63712',
        }),
        (error) =>
          error instanceof ConfigurationOperationError &&
          error.code === 'consistency-unavailable',
      );
      const failure = await repositories.configuration.revision(
        'persistent-openloader-failure',
      );
      assert.equal(failure?.status, 'failed');
      assert.equal(failure?.failureCode, 'consistency-unavailable');
      assert.equal((await repositories.audit.verifyPartition('configuration')).valid, true);
      assert.equal(
        await repositories.operationalLocks.current(serverInstanceId, 'minecraft-exclusive'),
        undefined,
      );
    } finally {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies and rolls back the reviewed OpenLoader codec in an isolated directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'voidfall-openloader-configuration-'));
    try {
      const configurationRoot = join(root, 'instance');
      const openLoaderDirectory = join(configurationRoot, 'config', 'openloader');
      const repositoryRoot = join(root, 'revision-repository');
      const filePath = join(openLoaderDirectory, 'advanced_options.json');
      const original = `${JSON.stringify(
        {
          resourcePacks: { enabled: true, additionalFolders: [] },
          dataPacks: { enabled: true, additionalFolders: [] },
        },
        null,
        2,
      )}\n`;
      await mkdir(openLoaderDirectory, { recursive: true });
      await mkdir(repositoryRoot);
      await writeFile(filePath, original, 'utf8');
      const resource = createReviewedConfigurationResource(
        configurationRoot,
        'openloader-advanced-options',
      );
      const configuration = new FilesystemConfigurationService({
        repositoryRoot,
        resources: [resource],
        guard: new TrackingGuard(),
        clock: () => NOW,
      });

      const update = await configuration.applyConfiguration({
        resourceId: resource.resourceId,
        revisionId: 'openloader-update',
        expectedCurrentSha256: digest(original),
        reasonCode: 'operator-change',
        changes: { 'dataPacks.enabled': false },
      });
      const updated = await readFile(filePath, 'utf8');
      assert.equal(update.restartRequired, true);
      assert.deepEqual(update.changedFields, ['dataPacks.enabled']);
      assert.equal(updated.includes('"enabled": false'), true);
      assert.equal(
        await readFile(
          join(
            repositoryRoot,
            'revisions',
            resource.resourceId,
            'openloader-update',
            'previous.json',
          ),
          'utf8',
        ),
        original,
      );

      const rollback = await configuration.rollbackConfiguration({
        resourceId: resource.resourceId,
        revisionId: 'openloader-rollback',
        sourceRevisionId: 'openloader-update',
        expectedCurrentSha256: digest(updated),
        reasonCode: 'operator-rollback',
      });
      assert.equal(rollback.restoredFromRevisionId, 'openloader-update');
      assert.equal(await readFile(filePath, 'utf8'), original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('updates a guarded CRLF document and publishes an immutable previous revision', async () => {
    const original = ORIGINAL_LF.replaceAll('\n', '\r\n');
    const fixture = await createFixture(original);
    const guard = new TrackingGuard();
    const configuration = service(fixture, guard, {
      replacer: new GuardAwareReplacer(guard),
    });
    try {
      const receipt = await configuration.applyConfiguration(
        plan(
          fixture,
          'revision-update-001',
          Object.freeze({ 'online-mode': false, 'max-players': 30, motd: 'VoidFall Ω' }),
          original,
        ),
      );
      const current = await readFile(fixture.filePath, 'utf8');
      assert.equal(
        current,
        original
          .replace('online-mode=true', 'online-mode=false')
          .replace('max-players=20', 'max-players=30')
          .replace('motd=VoidFall', 'motd=VoidFall Ω'),
      );
      assert.equal(current.includes('\r\n'), true);
      assert.deepEqual(receipt.changedFields, ['max-players', 'motd', 'online-mode']);
      assert.equal(receipt.restartRequired, true);
      assert.equal(Object.isFrozen(receipt), true);
      assert.equal(Object.isFrozen(receipt.changedFields), true);
      assert.deepEqual(guard.calls, ['server-basic']);

      const revisionRoot = join(
        fixture.repositoryRoot,
        'revisions',
        'server-basic',
        'revision-update-001',
      );
      assert.equal(await readFile(join(revisionRoot, 'previous.properties'), 'utf8'), original);
      const serializedManifest = await readFile(join(revisionRoot, 'manifest.json'), 'utf8');
      const manifest = parseConfigurationRevisionManifest(serializedManifest);
      assert.equal(manifest.previousSha256, digest(original));
      assert.equal(manifest.intendedSha256, digest(current));
      assert.equal(manifest.operation, 'update');
      assert.equal(manifest.restoredFromRevisionId, null);
      assert.doesNotMatch(serializedManifest, /VoidFall Ω|H:\\|Servidor[\\/]workspace/iu);
      await assert.rejects(writeFile(join(revisionRoot, 'manifest.json'), 'overwrite', { flag: 'wx' }));
    } finally {
      await removeFixture(fixture);
    }
  });

  it('validates typed values and rejects ambiguous or incomplete documents', async () => {
    const fixture = await createFixture();
    const guard = new TrackingGuard();
    const configuration = service(fixture, guard);
    try {
      await expectCode(
        configuration.applyConfiguration(plan(fixture, 'invalid-boolean', { 'online-mode': 'false' })),
        'invalid-content',
      );
      await expectCode(
        configuration.applyConfiguration(plan(fixture, 'invalid-integer', { 'max-players': 101 })),
        'invalid-content',
      );
      await expectCode(
        configuration.applyConfiguration(plan(fixture, 'invalid-enum', { difficulty: 'nightmare' })),
        'invalid-content',
      );
      await expectCode(
        configuration.applyConfiguration(plan(fixture, 'invalid-string', { motd: 'bad\\value' })),
        'invalid-content',
      );
      await expectCode(
        configuration.applyConfiguration(plan(fixture, 'unknown-field', { unknown: true })),
        'invalid-content',
      );

      const invalidDocuments: readonly [string, string, ConfigurationOperationError['code']][] = [
        ['duplicate', ORIGINAL_LF.replace('max-players=20', 'max-players=20\nmax-players=21'), 'invalid-content'],
        ['missing', ORIGINAL_LF.replace('motd=VoidFall\n', ''), 'schema-mismatch'],
        ['unknown', ORIGINAL_LF.replace('motd=VoidFall', 'motd=VoidFall\nsecret=true'), 'invalid-content'],
        ['mixed-lines', ORIGINAL_LF.replace('online-mode=true\n', 'online-mode=true\r\n'), 'invalid-content'],
      ];
      for (const [id, content, code] of invalidDocuments) {
        await writeFile(fixture.filePath, content, 'utf8');
        await expectCode(
          configuration.applyConfiguration(plan(fixture, `invalid-document-${id}`, { 'max-players': 30 }, content)),
          code,
        );
      }
      assert.equal(
        await readFile(fixture.filePath, 'utf8'),
        invalidDocuments.at(-1)?.[1],
      );
    } finally {
      await removeFixture(fixture);
    }
  });

  it('requires the offline guard and optimistic current hash without publishing a revision', async () => {
    const fixture = await createFixture();
    const guard = new TrackingGuard();
    guard.available = false;
    const configuration = service(fixture, guard);
    try {
      await expectCode(
        configuration.applyConfiguration(plan(fixture, 'guard-unavailable', { 'max-players': 30 })),
        'consistency-unavailable',
        'secret-server',
      );
      assert.equal(await readFile(fixture.filePath, 'utf8'), ORIGINAL_LF);
      assert.equal(await directoryExists(join(fixture.repositoryRoot, 'staging')), false);

      guard.available = true;
      await expectCode(
        configuration.applyConfiguration({
          ...plan(fixture, 'stale-hash', { 'max-players': 30 }),
          expectedCurrentSha256: '0'.repeat(64),
        }),
        'concurrent-modification',
      );
      await expectCode(
        configuration.applyConfiguration(plan(fixture, 'no-effective-change', { 'max-players': 20 })),
        'no-change',
      );
      assert.equal(await readFile(fixture.filePath, 'utf8'), ORIGINAL_LF);
      assert.equal(
        await directoryExists(join(fixture.repositoryRoot, 'revisions', 'server-basic', 'stale-hash')),
        false,
      );
    } finally {
      await removeFixture(fixture);
    }
  });

  it('never overwrites a revision and rejects a held resource lock', async () => {
    const fixture = await createFixture();
    const guard = new TrackingGuard();
    const configuration = service(fixture, guard);
    try {
      const first = await configuration.applyConfiguration(
        plan(fixture, 'immutable-revision', { 'max-players': 30 }),
      );
      const current = await readFile(fixture.filePath, 'utf8');
      await expectCode(
        configuration.applyConfiguration(
          plan(fixture, 'immutable-revision', { 'max-players': 40 }, current),
        ),
        'revision-conflict',
      );
      assert.equal(await readFile(fixture.filePath, 'utf8'), current);
      assert.equal(first.currentSha256, digest(current));

      const lockPath = join(fixture.repositoryRoot, 'locks', 'server-basic.lock');
      await writeFile(lockPath, 'held', { flag: 'wx' });
      await expectCode(
        configuration.applyConfiguration(plan(fixture, 'held-lock', { 'max-players': 40 }, current)),
        'concurrent-modification',
      );
      assert.equal(await readFile(fixture.filePath, 'utf8'), current);
      await unlink(lockPath);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('rejects hardlinks, linked parents, overlapping storage and oversized content', async (context) => {
    const hardlinkFixture = await createFixture();
    const hardlinkPath = join(hardlinkFixture.configurationDirectory, 'second.properties');
    try {
      await link(hardlinkFixture.filePath, hardlinkPath);
      await expectCode(
        service(hardlinkFixture, new TrackingGuard()).applyConfiguration(
          plan(hardlinkFixture, 'hardlink-target', { 'max-players': 30 }),
        ),
        'unsupported-entry',
      );
    } finally {
      await removeFixture(hardlinkFixture);
    }

    const linkFixture = await createFixture();
    try {
      const linkedDirectory = join(linkFixture.root, 'linked-configuration');
      try {
        await symlink(
          linkFixture.configurationDirectory,
          linkedDirectory,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        const linkedResource = Object.freeze({
          ...linkFixture.resource,
          filePath: join(linkedDirectory, 'server.properties'),
        });
        await expectCode(
          service(linkFixture, new TrackingGuard(), { resource: linkedResource }).applyConfiguration(
            plan(linkFixture, 'linked-parent', { 'max-players': 30 }),
          ),
          'unsafe-path',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') {
          context.diagnostic('linked-parent assertion skipped because the host denied link creation');
        } else {
          throw error;
        }
      }
    } finally {
      await removeFixture(linkFixture);
    }

    const overlapFixture = await createFixture();
    try {
      const overlappingRepository = join(overlapFixture.configurationDirectory, 'revisions');
      await mkdir(overlappingRepository);
      await expectCode(
        service(overlapFixture, new TrackingGuard(), {
          repositoryRoot: overlappingRepository,
        }).applyConfiguration(plan(overlapFixture, 'overlap', { 'max-players': 30 })),
        'unsafe-path',
      );
    } finally {
      await removeFixture(overlapFixture);
    }

    const sizeFixture = await createFixture();
    try {
      const smallResource = Object.freeze({ ...sizeFixture.resource, maximumBytes: 16 });
      await expectCode(
        service(sizeFixture, new TrackingGuard(), { resource: smallResource }).applyConfiguration(
          plan(sizeFixture, 'too-large', { 'max-players': 30 }),
        ),
        'content-too-large',
      );
    } finally {
      await removeFixture(sizeFixture);
    }
  });

  it('preserves the current file on replacement failure and recovers corrupt output', async () => {
    const failedFixture = await createFixture();
    try {
      await expectCode(
        service(failedFixture, new TrackingGuard(), {
          replacer: new FailingReplacer(),
        }).applyConfiguration(plan(failedFixture, 'failed-replacement', { 'max-players': 30 })),
        'replacement-failed',
      );
      assert.equal(await readFile(failedFixture.filePath, 'utf8'), ORIGINAL_LF);
      assert.equal(
        await directoryExists(
          join(
            failedFixture.repositoryRoot,
            'revisions',
            'server-basic',
            'failed-replacement',
          ),
        ),
        true,
      );
    } finally {
      await removeFixture(failedFixture);
    }

    const corruptFixture = await createFixture();
    try {
      await expectCode(
        service(corruptFixture, new TrackingGuard(), {
          replacer: new CorruptingReplacer(),
        }).applyConfiguration(plan(corruptFixture, 'corrupt-replacement', { 'max-players': 30 })),
        'verification-failed',
      );
      assert.equal(await readFile(corruptFixture.filePath, 'utf8'), ORIGINAL_LF);
      assert.equal(
        await directoryExists(
          join(
            corruptFixture.repositoryRoot,
            'revisions',
            'server-basic',
            'corrupt-replacement',
          ),
        ),
        true,
      );
    } finally {
      await removeFixture(corruptFixture);
    }
  });

  it('rolls back exact bytes and captures the replaced state in another revision', async () => {
    const fixture = await createFixture();
    const guard = new TrackingGuard();
    const configuration = service(fixture, guard);
    try {
      const update = await configuration.applyConfiguration(
        plan(fixture, 'before-update', { 'online-mode': false, 'max-players': 30 }),
      );
      const updated = await readFile(fixture.filePath, 'utf8');
      const rollback = await configuration.rollbackConfiguration({
        resourceId: 'server-basic',
        revisionId: 'before-rollback',
        sourceRevisionId: 'before-update',
        expectedCurrentSha256: update.currentSha256,
        reasonCode: 'operator-rollback',
      });
      assert.equal(await readFile(fixture.filePath, 'utf8'), ORIGINAL_LF);
      assert.equal(rollback.operation, 'rollback');
      assert.equal(rollback.restoredFromRevisionId, 'before-update');
      assert.deepEqual(rollback.changedFields, ['max-players', 'online-mode']);
      assert.equal(rollback.restartRequired, true);
      assert.equal(
        await readFile(
          join(
            fixture.repositoryRoot,
            'revisions',
            'server-basic',
            'before-rollback',
            'previous.properties',
          ),
          'utf8',
        ),
        updated,
      );
      const manifest = parseConfigurationRevisionManifest(
        await readFile(
          join(
            fixture.repositoryRoot,
            'revisions',
            'server-basic',
            'before-rollback',
            'manifest.json',
          ),
          'utf8',
        ),
      );
      assert.equal(manifest.operation, 'rollback');
      assert.equal(manifest.restoredFromRevisionId, 'before-update');
    } finally {
      await removeFixture(fixture);
    }
  });

  it('blocks rollback from a tampered revision or a different schema version', async () => {
    const fixture = await createFixture();
    const guard = new TrackingGuard();
    const configuration = service(fixture, guard);
    try {
      const update = await configuration.applyConfiguration(
        plan(fixture, 'trusted-revision', { 'max-players': 30 }),
      );
      const updated = await readFile(fixture.filePath, 'utf8');
      const previousPath = join(
        fixture.repositoryRoot,
        'revisions',
        'server-basic',
        'trusted-revision',
        'previous.properties',
      );
      await writeFile(previousPath, ORIGINAL_LF.replace('max-players=20', 'max-players=21'));
      await expectCode(
        configuration.rollbackConfiguration({
          resourceId: 'server-basic',
          revisionId: 'tampered-rollback',
          sourceRevisionId: 'trusted-revision',
          expectedCurrentSha256: update.currentSha256,
          reasonCode: 'operator-rollback',
        }),
        'revision-integrity-mismatch',
      );
      assert.equal(await readFile(fixture.filePath, 'utf8'), updated);
    } finally {
      await removeFixture(fixture);
    }

    const schemaFixture = await createFixture();
    const schemaGuard = new TrackingGuard();
    try {
      const v1 = service(schemaFixture, schemaGuard);
      const update = await v1.applyConfiguration(
        plan(schemaFixture, 'schema-v1-revision', { 'max-players': 30 }),
      );
      const updated = await readFile(schemaFixture.filePath, 'utf8');
      const v2Resource = Object.freeze({ ...schemaFixture.resource, schemaVersion: 'v2' });
      await expectCode(
        service(schemaFixture, schemaGuard, { resource: v2Resource }).rollbackConfiguration({
          resourceId: 'server-basic',
          revisionId: 'schema-v2-rollback',
          sourceRevisionId: 'schema-v1-revision',
          expectedCurrentSha256: update.currentSha256,
          reasonCode: 'operator-rollback',
        }),
        'schema-mismatch',
      );
      assert.equal(await readFile(schemaFixture.filePath, 'utf8'), updated);
    } finally {
      await removeFixture(schemaFixture);
    }
  });

  it('rejects invalid definitions, extra plan fields and clocks without leaking details', async () => {
    const fixture = await createFixture();
    try {
      assert.throws(
        () =>
          service(fixture, new TrackingGuard(), {
            resource: { ...fixture.resource, filePath: 'relative.properties' },
          }),
        (error: unknown) =>
          error instanceof ConfigurationOperationError && error.code === 'invalid-definition',
      );
      assert.throws(
        () =>
          service(fixture, new TrackingGuard(), {
            resource: {
              ...fixture.resource,
              fields: {
                ...fixture.resource.fields,
                extra: { type: 'boolean', restartRequired: false, hidden: true },
              } as unknown as ConfigurationResourceDefinition['fields'],
            },
          }),
        (error: unknown) =>
          error instanceof ConfigurationOperationError && error.code === 'invalid-definition',
      );
      const configuration = service(fixture, new TrackingGuard());
      await expectCode(
        configuration.applyConfiguration({
          ...plan(fixture, 'extra-plan-field', { 'max-players': 30 }),
          path: 'H:\\private',
        } as ApplyConfigurationPlan),
        'invalid-plan',
        'private',
      );
      await expectCode(
        service(fixture, new TrackingGuard(), {
          clock: () => {
            throw new Error('H:\\private-clock');
          },
        }).applyConfiguration(plan(fixture, 'invalid-clock', { 'max-players': 30 })),
        'invalid-plan',
        'private-clock',
      );
      assert.equal(await readFile(fixture.filePath, 'utf8'), ORIGINAL_LF);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('preserves LF, missing trailing newline and Unicode comments', async () => {
    const original = [
      '# Configuração Ω',
      'online-mode=true',
      'max-players=20',
      'difficulty=normal',
      'motd=VoidFall',
    ].join('\n');
    const fixture = await createFixture(original);
    try {
      await service(fixture, new TrackingGuard()).applyConfiguration(
        plan(fixture, 'lf-without-trailing-newline', { difficulty: 'hard' }, original),
      );
      const current = await readFile(fixture.filePath, 'utf8');
      assert.equal(current, original.replace('difficulty=normal', 'difficulty=hard'));
      assert.equal(current.endsWith('\n'), false);
      assert.equal(current.includes('\r'), false);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('rejects a Unix socket masquerading as a properties file', async (context) => {
    if (process.platform === 'win32') {
      context.skip('Unix domain socket entry is covered by the Linux CI job');
      return;
    }
    const fixture = await createFixture();
    const server = createServer();
    try {
      await unlink(fixture.filePath);
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(fixture.filePath, () => resolveListen());
      });
      await expectCode(
        service(fixture, new TrackingGuard()).applyConfiguration(
          plan(fixture, 'socket-entry', { 'max-players': 30 }),
        ),
        'unsupported-entry',
      );
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await removeFixture(fixture);
    }
  });
});

async function directoryExists(path: string): Promise<boolean> {
  try {
    await readFile(join(path, 'manifest.json'));
    return true;
  } catch {
    try {
      const entries = await import('node:fs/promises').then(({ readdir }) => readdir(path));
      return entries.length >= 0;
    } catch {
      return false;
    }
  }
}

describe('typed configuration reads and redaction policy', () => {
  it('reads a reviewed resource under the guard without exposing bytes or a path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'voidfall-configuration-read-'));
    try {
      const configurationRoot = join(root, 'instance');
      const openLoaderDirectory = join(configurationRoot, 'config', 'openloader');
      const repositoryRoot = join(root, 'revision-repository');
      const filePath = join(openLoaderDirectory, 'advanced_options.json');
      const original = `${JSON.stringify(
        {
          resourcePacks: { enabled: true, additionalFolders: [] },
          dataPacks: { enabled: false, additionalFolders: [] },
        },
        null,
        2,
      )}\n`;
      await mkdir(openLoaderDirectory, { recursive: true });
      await mkdir(repositoryRoot);
      await writeFile(filePath, original, 'utf8');
      const resource = createReviewedConfigurationResource(
        configurationRoot,
        'openloader-advanced-options',
      );
      const guard = new TrackingGuard();
      const configuration = new FilesystemConfigurationService({
        repositoryRoot,
        resources: [resource],
        guard,
        clock: () => NOW,
      });

      const read = await configuration.readConfiguration(resource.resourceId);

      assert.equal(read.resourceId, 'openloader-advanced-options');
      assert.equal(read.currentSha256, digest(original));
      assert.equal(read.schemaSha256, resource.schemaSha256);
      assert.deepEqual({ ...read.values }, {
        'dataPacks.enabled': false,
        'resourcePacks.enabled': true,
      });
      // The guard must have been used, and no path or byte content may leak.
      assert.equal(guard.calls.length > 0, true);
      assert.equal(Object.hasOwn(read, 'filePath'), false);
      assert.equal(Object.hasOwn(read, 'content'), false);
      assert.equal(JSON.stringify(read).includes(root), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('updates reviewed server security fields while preserving every opaque property', async () => {
    const root = await mkdtemp(join(tmpdir(), 'voidfall-server-properties-'));
    try {
      const configurationRoot = join(root, 'instance');
      const repositoryRoot = join(root, 'revision-repository');
      const filePath = join(configurationRoot, 'server.properties');
      const original = [
        '# Sanitized fixture',
        'online-mode=false',
        'white-list=false',
        'enforce-whitelist=false',
        'enforce-secure-profile=true',
        'enable-rcon=true',
        'broadcast-rcon-to-ops=true',
        'motd=Opaque and preserved',
        'rcon.password=fixture-redacted',
        '\uFEFF\\#Minecraft=server properties',
        '',
      ].join('\r\n');
      await mkdir(configurationRoot, { recursive: true });
      await mkdir(repositoryRoot);
      await writeFile(filePath, original, 'utf8');
      const resource = createReviewedConfigurationResource(
        configurationRoot,
        'minecraft-server-properties',
      );
      const configuration = new FilesystemConfigurationService({
        repositoryRoot,
        resources: [resource],
        guard: new TrackingGuard(),
        clock: () => NOW,
      });

      const read = await configuration.readConfiguration(resource.resourceId);
      assert.deepEqual({ ...read.values }, {
        'broadcast-rcon-to-ops': true,
        'enable-rcon': true,
        'enforce-secure-profile': true,
        'enforce-whitelist': false,
        'online-mode': false,
        'white-list': false,
      });
      assert.equal(JSON.stringify(read).includes('fixture-redacted'), false);

      const update = await configuration.applyConfiguration({
        resourceId: resource.resourceId,
        revisionId: 'server-security-update',
        expectedCurrentSha256: digest(original),
        reasonCode: 'security-review',
        changes: { 'enable-rcon': false, 'online-mode': true },
      });
      const updated = await readFile(filePath, 'utf8');
      assert.deepEqual(update.changedFields, ['enable-rcon', 'online-mode']);
      assert.equal(update.restartRequired, true);
      assert.equal(updated.includes('enable-rcon=false'), true);
      assert.equal(updated.includes('online-mode=true'), true);
      assert.equal(updated.includes('motd=Opaque and preserved'), true);
      assert.equal(updated.includes('rcon.password=fixture-redacted'), true);
      assert.equal(updated.includes('\uFEFF\\#Minecraft=server properties'), true);
      assert.equal(updated.replaceAll('\r\n', '').includes('\n'), false);
      assert.equal(
        await readFile(
          join(
            repositoryRoot,
            'revisions',
            resource.resourceId,
            'server-security-update',
            'previous.properties',
          ),
          'utf8',
        ),
        original,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to read an unregistered resource', async () => {
    const root = await mkdtemp(join(tmpdir(), 'voidfall-configuration-read-denied-'));
    try {
      const configurationRoot = join(root, 'instance');
      const openLoaderDirectory = join(configurationRoot, 'config', 'openloader');
      const repositoryRoot = join(root, 'revision-repository');
      await mkdir(openLoaderDirectory, { recursive: true });
      await mkdir(repositoryRoot);
      await writeFile(
        join(openLoaderDirectory, 'advanced_options.json'),
        `${JSON.stringify(
          {
            resourcePacks: { enabled: true, additionalFolders: [] },
            dataPacks: { enabled: true, additionalFolders: [] },
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      const resource = createReviewedConfigurationResource(
        configurationRoot,
        'openloader-advanced-options',
      );
      const configuration = new FilesystemConfigurationService({
        repositoryRoot,
        resources: [resource],
        guard: new TrackingGuard(),
        clock: () => NOW,
      });

      await expectCode(configuration.readConfiguration('server-basic'), 'resource-not-found');
      await expectCode(
        configuration.readConfiguration('../../etc/passwd'),
        'resource-not-found',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('describes only the reviewed resource, without any path', () => {
    assert.deepEqual(listReviewedConfigurationIds(), [
      'minecraft-server-properties',
      'openloader-advanced-options',
    ]);

    const descriptor = describeReviewedConfiguration('openloader-advanced-options', true);
    assert.equal(descriptor.codecId, 'openloader-advanced-options-v1');
    assert.equal(descriptor.applyMode, 'offline-only');
    assert.equal(descriptor.restartRequired, true);
    assert.equal(descriptor.registered, true);
    assert.deepEqual(
      descriptor.fields.map((field) => field.name),
      ['dataPacks.enabled', 'resourcePacks.enabled'],
    );
    assert.equal(
      descriptor.fields.every((field) => field.type === 'boolean' && field.readable),
      true,
    );
    const serialized = JSON.stringify(descriptor);
    assert.equal(serialized.includes('config/openloader'), false);
    assert.equal(serialized.includes('advanced_options.json'), false);
    assert.equal(serialized.includes('filePath'), false);

    const security = describeReviewedConfiguration('minecraft-server-properties', true);
    assert.equal(security.codecId, 'minecraft-server-properties-v1');
    assert.deepEqual(
      security.fields.map((field) => field.name),
      Object.keys(MINECRAFT_SERVER_SCHEMA_V1.fields),
    );
    assert.equal(JSON.stringify(security).includes('server.properties'), false);

    assert.throws(() => describeReviewedConfiguration('server-basic', true));
  });

  it('publishes reviewed values and redacts anything it cannot vouch for', () => {
    const published = presentConfigurationValues('openloader-advanced-options', {
      'dataPacks.enabled': false,
      'resourcePacks.enabled': true,
    });
    assert.deepEqual(published, [
      { name: 'dataPacks.enabled', redacted: false, value: false },
      { name: 'resourcePacks.enabled', redacted: false, value: true },
    ]);

    // A missing or wrongly typed observation is redacted, never guessed.
    const partial = presentConfigurationValues('openloader-advanced-options', {
      'resourcePacks.enabled': 'true' as never,
    });
    assert.deepEqual(partial, [
      { name: 'dataPacks.enabled', redacted: true },
      { name: 'resourcePacks.enabled', redacted: true },
    ]);
    assert.equal(partial.every((field) => !Object.hasOwn(field, 'value')), true);

    // A value observed for a field outside the reviewed schema is dropped.
    const injected = presentConfigurationValues('openloader-advanced-options', {
      'dataPacks.enabled': true,
      'resourcePacks.enabled': true,
      'rcon.password': 'super-secret' as never,
    });
    assert.equal(injected.length, 2);
    assert.equal(JSON.stringify(injected).includes('super-secret'), false);

    assert.equal(isPublishableConfigurationField('openloader-advanced-options', 'dataPacks.enabled'), true);
    assert.equal(isPublishableConfigurationField('openloader-advanced-options', 'rcon.password'), false);
  });
});
