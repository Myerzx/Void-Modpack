import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  AuthorizedFileOperationError,
  AuthorizedFileService,
  type ReplaceAuthorizedFilePlan,
} from '../src/index.js';

const actorId = '018f6b8c-76a3-7d10-9f2e-1d9e52a63702';

interface Fixture {
  readonly directory: string;
  readonly contentRoot: string;
  readonly revisionRoot: string;
  readonly filePath: string;
  readonly service: AuthorizedFileService;
}

function digest(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'voidfall-authorized-files-'));
  const contentRoot = join(directory, 'content');
  const revisionRoot = join(directory, 'history');
  await mkdir(join(contentRoot, 'config'), { recursive: true });
  const filePath = join(contentRoot, 'config', 'server.properties');
  await writeFile(filePath, 'motd=VoidFall\nmax-players=20\n', 'utf8');
  await writeFile(join(contentRoot, 'secret.bin'), Buffer.from([0, 1, 2]));
  return {
    directory,
    contentRoot,
    revisionRoot,
    filePath,
    service: new AuthorizedFileService({
      revisionRoot,
      roots: [
        {
          rootId: 'server-config',
          rootPath: contentRoot,
          readableExtensions: ['.json', '.properties'],
          writableExtensions: ['.properties'],
          maximumFileBytes: 1_024,
        },
      ],
    }),
  };
}

function replacement(current: string, overrides: Partial<ReplaceAuthorizedFilePlan> = {}): ReplaceAuthorizedFilePlan {
  return {
    rootId: 'server-config',
    filePath: 'config/server.properties',
    revisionId: 'revision-20260803',
    actorId,
    reasonCode: 'manual-config-change',
    changedAt: '2026-08-03T16:00:00.000Z',
    expectedSha256: digest(current),
    content: 'motd=VoidFall Updated\nmax-players=24\n',
    ...overrides,
  };
}

describe('AuthorizedFileService', () => {
  it('lists only authorized files and reads bounded UTF-8 snapshots', async () => {
    const test = await fixture();
    try {
      const root = await test.service.list({
        rootId: 'server-config',
        directoryPath: '',
        maximumEntries: 10,
      });
      assert.deepEqual(root.entries, [{ name: 'config', path: 'config', type: 'directory' }]);
      const config = await test.service.list({
        rootId: 'server-config',
        directoryPath: 'config',
        maximumEntries: 10,
      });
      assert.equal(config.entries[0]?.path, 'config/server.properties');
      const snapshot = await test.service.read({
        rootId: 'server-config',
        filePath: 'config/server.properties',
      });
      assert.equal(snapshot.content, 'motd=VoidFall\nmax-players=20\n');
      assert.equal(snapshot.sha256, digest(snapshot.content));
      assert.equal(Object.isFrozen(snapshot), true);
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('replaces an existing text file after publishing its immutable prior revision', async () => {
    const test = await fixture();
    const previous = await readFile(test.filePath, 'utf8');
    try {
      const receipt = await test.service.replace(replacement(previous));
      assert.equal(await readFile(test.filePath, 'utf8'), 'motd=VoidFall Updated\nmax-players=24\n');
      assert.deepEqual(
        await readFile(join(test.revisionRoot, receipt.revisionReference, 'previous.bin'), 'utf8'),
        previous,
      );
      const manifest = JSON.parse(
        await readFile(join(test.revisionRoot, receipt.revisionReference, 'manifest.json'), 'utf8'),
      ) as {
        readonly state: string;
        readonly previousSha256: string;
        readonly intendedSha256: string;
      };
      assert.equal(manifest.state, 'prepared-before-replacement');
      assert.equal(manifest.previousSha256, digest(previous));
      assert.equal(manifest.intendedSha256, receipt.currentSha256);
      assert.equal(Object.isFrozen(receipt), true);
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('rejects stale hashes and no-op content without modifying the file', async () => {
    const test = await fixture();
    const previous = await readFile(test.filePath, 'utf8');
    try {
      await assert.rejects(
        test.service.replace(replacement(previous, { expectedSha256: 'a'.repeat(64) })),
        (error) =>
          error instanceof AuthorizedFileOperationError && error.code === 'concurrent-modification',
      );
      await assert.rejects(
        test.service.replace(replacement(previous, { content: previous })),
        (error) => error instanceof AuthorizedFileOperationError && error.code === 'no-change',
      );
      assert.equal(await readFile(test.filePath, 'utf8'), previous);
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('rejects traversal, absolute paths, unknown roots and unsupported writes', async () => {
    const test = await fixture();
    const previous = await readFile(test.filePath, 'utf8');
    try {
      for (const filePath of ['../escape.properties', 'C:/server.properties', '/etc/passwd']) {
        await assert.rejects(
          test.service.read({ rootId: 'server-config', filePath }),
          (error) => error instanceof AuthorizedFileOperationError && error.code === 'invalid-plan',
        );
      }
      await assert.rejects(
        test.service.read({ rootId: 'missing-root', filePath: 'config/server.properties' }),
        (error) => error instanceof AuthorizedFileOperationError && error.code === 'unknown-root',
      );
      await assert.rejects(
        test.service.replace(replacement(previous, { filePath: 'settings.json' })),
        (error) =>
          error instanceof AuthorizedFileOperationError && error.code === 'unsupported-extension',
      );
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('rejects hardlinked files and linked parent directories', async (context) => {
    const test = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'voidfall-authorized-outside-'));
    try {
      const hardlinkPath = join(test.contentRoot, 'config', 'duplicate.properties');
      await link(test.filePath, hardlinkPath);
      await assert.rejects(
        test.service.read({ rootId: 'server-config', filePath: 'config/server.properties' }),
        (error) => error instanceof AuthorizedFileOperationError && error.code === 'unsupported-entry',
      );
      await rm(hardlinkPath);

      await writeFile(join(outside, 'linked.properties'), 'outside=true\n', 'utf8');
      const linkedDirectory = join(test.contentRoot, 'linked');
      await symlink(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(
        test.service.read({ rootId: 'server-config', filePath: 'linked/linked.properties' }),
        (error) => error instanceof AuthorizedFileOperationError && error.code === 'unsafe-path',
      );
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === 'EPERM' || error.code === 'EACCES')
      ) {
        context.skip('link creation is unavailable in this environment');
      } else {
        throw error;
      }
    } finally {
      await rm(test.directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects binary text, oversized files and directory overflows', async () => {
    const test = await fixture();
    try {
      await writeFile(join(test.contentRoot, 'config', 'binary.properties'), Buffer.from([0xff, 0xfe]));
      await assert.rejects(
        test.service.read({ rootId: 'server-config', filePath: 'config/binary.properties' }),
        (error) =>
          error instanceof AuthorizedFileOperationError && error.code === 'invalid-text-content',
      );
      await writeFile(join(test.contentRoot, 'config', 'large.properties'), 'x'.repeat(1_025), 'utf8');
      await assert.rejects(
        test.service.read({ rootId: 'server-config', filePath: 'config/large.properties' }),
        (error) => error instanceof AuthorizedFileOperationError && error.code === 'content-too-large',
      );
      await assert.rejects(
        test.service.list({ rootId: 'server-config', directoryPath: 'config', maximumEntries: 1 }),
        (error) =>
          error instanceof AuthorizedFileOperationError && error.code === 'entry-limit-exceeded',
      );
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('keeps revision IDs immutable across later attempts', async () => {
    const test = await fixture();
    const previous = await readFile(test.filePath, 'utf8');
    try {
      await test.service.replace(replacement(previous));
      const current = await readFile(test.filePath, 'utf8');
      await assert.rejects(
        test.service.replace(replacement(current, { content: 'motd=Third\n' })),
        (error) => error instanceof AuthorizedFileOperationError && error.code === 'revision-conflict',
      );
      assert.equal(await readFile(test.filePath, 'utf8'), current);
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('rejects overlapping roots and revision storage during trusted construction', async () => {
    const test = await fixture();
    try {
      assert.throws(
        () =>
          new AuthorizedFileService({
            revisionRoot: join(test.contentRoot, 'history'),
            roots: [
              {
                rootId: 'unsafe',
                rootPath: test.contentRoot,
                readableExtensions: ['.properties'],
                writableExtensions: [],
                maximumFileBytes: 100,
              },
            ],
          }),
        (error) =>
          error instanceof AuthorizedFileOperationError && error.code === 'invalid-definition',
      );
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });
});
