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
  ConfigurationOperationError,
  FilesystemConfigurationService,
  JAVA_PROPERTIES_V1,
  parseConfigurationRevisionManifest,
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
      schemaVersion: 'v1',
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
