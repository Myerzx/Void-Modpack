import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  AuthorizedFileOperationError,
  AuthorizedFileService,
  diffText,
  redactFileLine,
} from '../src/index.js';

/**
 * The Phase 10.2 mutation set, the bounded diff and restoration.
 *
 * Everything here runs against a temporary directory. No authorized root of the
 * real deployment is touched, and no Minecraft process exists.
 */

const actorId = '018f6b8c-76a3-7d10-9f2e-1d9e52a63702';
const changedAt = '2026-08-05T18:00:00.000Z';

function digest(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

interface Fixture {
  readonly directory: string;
  readonly contentRoot: string;
  readonly service: AuthorizedFileService;
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'voidfall-file-mutations-'));
  const contentRoot = join(directory, 'content');
  await mkdir(join(contentRoot, 'config'), { recursive: true });
  await mkdir(join(contentRoot, 'backup'), { recursive: true });
  await writeFile(
    join(contentRoot, 'config', 'server.properties'),
    'motd=VoidFall\nmax-players=20\n',
    'utf8',
  );
  return {
    directory,
    contentRoot,
    service: new AuthorizedFileService({
      revisionRoot: join(directory, 'history'),
      roots: [
        {
          rootId: 'server-config',
          rootPath: contentRoot,
          readableExtensions: ['.json', '.properties'],
          writableExtensions: ['.properties'],
          maximumFileBytes: 4_096,
        },
        {
          rootId: 'other-root',
          rootPath: join(directory, 'other'),
          readableExtensions: ['.properties'],
          writableExtensions: ['.properties'],
          maximumFileBytes: 4_096,
        },
      ],
    }),
  };
}

const identity = { actorId, reasonCode: 'operator-request', changedAt } as const;

describe('authorized file mutations', () => {
  it('creates a new file and refuses to overwrite anything', async () => {
    const test = await fixture();
    try {
      const receipt = await test.service.create({
        rootId: 'server-config',
        filePath: 'config/extra.properties',
        content: 'level-name=world\n',
        ...identity,
      });
      assert.equal(receipt.operation, 'create');
      assert.equal(receipt.sha256, digest('level-name=world\n'));
      // Nothing was lost, so nothing was preserved.
      assert.equal(receipt.revisionReference, null);
      assert.equal(
        await readFile(join(test.contentRoot, 'config', 'extra.properties'), 'utf8'),
        'level-name=world\n',
      );

      // The second create finds the destination occupied and refuses rather
      // than replacing a file the caller never asked to lose.
      await assert.rejects(
        test.service.create({
          rootId: 'server-config',
          filePath: 'config/extra.properties',
          content: 'level-name=other\n',
          ...identity,
        }),
        (error: AuthorizedFileOperationError) => error.code === 'destination-exists',
      );
      assert.equal(
        await readFile(join(test.contentRoot, 'config', 'extra.properties'), 'utf8'),
        'level-name=world\n',
      );
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('refuses to create outside the policy: unknown root, wrong extension, escaping path', async () => {
    const test = await fixture();
    try {
      for (const plan of [
        { rootId: 'nope', filePath: 'config/a.properties' },
        // Readable but not writable, so it cannot be created.
        { rootId: 'server-config', filePath: 'config/a.json' },
        { rootId: 'server-config', filePath: '../escape.properties' },
        { rootId: 'server-config', filePath: 'config\\windows.properties' },
        // The parent must already exist; a mutation never conjures a tree.
        { rootId: 'server-config', filePath: 'missing/deep/a.properties' },
      ]) {
        await assert.rejects(
          test.service.create({ ...plan, content: 'x=1\n', ...identity }),
          (error: unknown) => error instanceof AuthorizedFileOperationError,
          `expected refusal for ${plan.rootId}:${plan.filePath}`,
        );
      }
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('moves a file, preserving the bytes before the source stops existing', async () => {
    const test = await fixture();
    try {
      const current = 'motd=VoidFall\nmax-players=20\n';
      const receipt = await test.service.move({
        rootId: 'server-config',
        sourcePath: 'config/server.properties',
        destinationPath: 'backup/server.properties',
        revisionId: 'revision-move-1',
        expectedSha256: digest(current),
        ...identity,
      });
      assert.equal(receipt.operation, 'move');
      assert.equal(receipt.destinationPath, 'backup/server.properties');
      assert.equal(receipt.revisionReference, 'revisions/server-config/revision-move-1');

      assert.equal(await readFile(join(test.contentRoot, 'backup', 'server.properties'), 'utf8'), current);
      await assert.rejects(readFile(join(test.contentRoot, 'config', 'server.properties'), 'utf8'));

      // The revision records where the bytes went, which is what tells a
      // restorer this was a move and not a deletion.
      const manifest = JSON.parse(
        await readFile(
          join(test.directory, 'history', 'revisions', 'server-config', 'revision-move-1', 'manifest.json'),
          'utf8',
        ),
      ) as Record<string, unknown>;
      assert.equal(manifest.state, 'preserved-before-move');
      assert.equal(manifest.movedToPath, 'backup/server.properties');
      assert.equal(manifest.previousSha256, digest(current));
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('refuses a move onto an occupied destination and leaves both files intact', async () => {
    const test = await fixture();
    try {
      const current = 'motd=VoidFall\nmax-players=20\n';
      await writeFile(join(test.contentRoot, 'backup', 'server.properties'), 'occupied\n', 'utf8');

      await assert.rejects(
        test.service.move({
          rootId: 'server-config',
          sourcePath: 'config/server.properties',
          destinationPath: 'backup/server.properties',
          revisionId: 'revision-move-2',
          expectedSha256: digest(current),
          ...identity,
        }),
        (error: AuthorizedFileOperationError) => error.code === 'destination-exists',
      );

      assert.equal(await readFile(join(test.contentRoot, 'config', 'server.properties'), 'utf8'), current);
      assert.equal(await readFile(join(test.contentRoot, 'backup', 'server.properties'), 'utf8'), 'occupied\n');
      // The refusal happened before anything was preserved, so no orphan
      // revision was left behind either.
      const revisions = join(test.directory, 'history', 'revisions', 'server-config');
      assert.deepEqual(await readdir(revisions).catch(() => []), []);
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('refuses a move whose source is not the bytes the caller expected', async () => {
    const test = await fixture();
    try {
      await assert.rejects(
        test.service.move({
          rootId: 'server-config',
          sourcePath: 'config/server.properties',
          destinationPath: 'backup/server.properties',
          revisionId: 'revision-move-3',
          expectedSha256: digest('something else entirely'),
          ...identity,
        }),
        (error: AuthorizedFileOperationError) => error.code === 'concurrent-modification',
      );
      assert.equal(
        await readFile(join(test.contentRoot, 'config', 'server.properties'), 'utf8'),
        'motd=VoidFall\nmax-players=20\n',
      );
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('copies without preserving a revision, since nothing is lost', async () => {
    const test = await fixture();
    try {
      const current = 'motd=VoidFall\nmax-players=20\n';
      const receipt = await test.service.copy({
        rootId: 'server-config',
        sourcePath: 'config/server.properties',
        destinationPath: 'backup/copy.properties',
        expectedSha256: digest(current),
        ...identity,
      });
      assert.equal(receipt.operation, 'copy');
      assert.equal(receipt.revisionReference, null);
      assert.equal(await readFile(join(test.contentRoot, 'config', 'server.properties'), 'utf8'), current);
      assert.equal(await readFile(join(test.contentRoot, 'backup', 'copy.properties'), 'utf8'), current);
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('deletes only after the bytes are recoverable, and restores them again', async () => {
    const test = await fixture();
    try {
      const current = 'motd=VoidFall\nmax-players=20\n';
      const receipt = await test.service.delete({
        rootId: 'server-config',
        filePath: 'config/server.properties',
        revisionId: 'revision-delete-1',
        expectedSha256: digest(current),
        ...identity,
      });
      assert.equal(receipt.operation, 'delete');
      assert.equal(receipt.revisionReference, 'revisions/server-config/revision-delete-1');
      await assert.rejects(readFile(join(test.contentRoot, 'config', 'server.properties'), 'utf8'));

      const manifest = JSON.parse(
        await readFile(
          join(test.directory, 'history', 'revisions', 'server-config', 'revision-delete-1', 'manifest.json'),
          'utf8',
        ),
      ) as Record<string, unknown>;
      assert.equal(manifest.state, 'preserved-before-delete');
      // Nothing will exist at the path, and the manifest says so rather than
      // claiming the bytes survive there.
      assert.equal(manifest.intendedSha256, null);
      assert.equal(manifest.movedToPath, undefined);

      const restored = await test.service.restore({
        rootId: 'server-config',
        revisionId: 'revision-delete-1',
        ...identity,
      });
      assert.equal(restored.operation, 'restore');
      assert.equal(restored.filePath, 'config/server.properties');
      assert.equal(await readFile(join(test.contentRoot, 'config', 'server.properties'), 'utf8'), current);

      // A second restore would have to overwrite, so it refuses.
      await assert.rejects(
        test.service.restore({ rootId: 'server-config', revisionId: 'revision-delete-1', ...identity }),
        (error: AuthorizedFileOperationError) => error.code === 'destination-exists',
      );
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('refuses to restore a revision belonging to another root', async () => {
    const test = await fixture();
    try {
      await test.service.delete({
        rootId: 'server-config',
        filePath: 'config/server.properties',
        revisionId: 'revision-cross-root',
        expectedSha256: digest('motd=VoidFall\nmax-players=20\n'),
        ...identity,
      });
      await assert.rejects(
        test.service.restore({ rootId: 'other-root', revisionId: 'revision-cross-root', ...identity }),
        (error: AuthorizedFileOperationError) => error.code === 'unknown-revision',
      );
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('refuses a destination reached through a symbolic link', async (t) => {
    const test = await fixture();
    try {
      try {
        await symlink(join(test.directory, 'outside'), join(test.contentRoot, 'linked'), 'junction');
      } catch {
        t.skip('this platform does not allow creating links in the test environment');
        return;
      }
      await mkdir(join(test.directory, 'outside'), { recursive: true });
      await assert.rejects(
        test.service.create({
          rootId: 'server-config',
          filePath: 'linked/escaped.properties',
          content: 'x=1\n',
          ...identity,
        }),
        (error: AuthorizedFileOperationError) => error.code === 'unsafe-path',
      );
      // Nothing was written through the link.
      assert.deepEqual(await readdir(join(test.directory, 'outside')), []);
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });
});

describe('secret-safe text diff', () => {
  it('reports that a secret changed without showing either value', () => {
    const diff = diffText(
      'motd=VoidFall\nrcon.password=old-secret-value\n',
      'motd=VoidFall\nrcon.password=new-secret-value\n',
    );
    // The change is visible as a change...
    assert.equal(diff.removedCount, 1);
    assert.equal(diff.addedCount, 1);
    assert.equal(diff.containsRedactedChange, true);

    const rendered = diff.lines.map((line) => line.text).join('\n');
    // ...but neither value is.
    assert.ok(!rendered.includes('old-secret-value'));
    assert.ok(!rendered.includes('new-secret-value'));
    // The key survives, so the operator knows which setting moved.
    assert.ok(rendered.includes('rcon.password'));
  });

  it('does not let redaction hide a change by collapsing both sides', () => {
    // Both lines redact to the same masked text. Matching on raw text is what
    // keeps this from being reported as unchanged.
    const diff = diffText('token=aaaaaaaa\n', 'token=bbbbbbbb\n');
    assert.equal(diff.lines.some((line) => line.type === 'unchanged'), false);
    assert.equal(diff.addedCount, 1);
    assert.equal(diff.removedCount, 1);
  });

  it('leaves untouched lines alone and numbers both sides', () => {
    const diff = diffText('a\nb\nc\n', 'a\nc\n');
    assert.deepEqual(
      diff.lines.map((line) => [line.type, line.text, line.previousLineNumber, line.currentLineNumber]),
      [
        ['unchanged', 'a', 1, 1],
        ['removed', 'b', 2, null],
        ['unchanged', 'c', 3, 2],
      ],
    );
    assert.equal(diff.containsRedactedChange, false);
  });

  it('bounds the work rather than aligning two arbitrarily large files', () => {
    const left = Array.from({ length: 3_000 }, (_, index) => `left-${index}`).join('\n');
    const right = Array.from({ length: 3_000 }, (_, index) => `right-${index}`).join('\n');
    assert.throws(
      () => diffText(left, right),
      (error: AuthorizedFileOperationError) => error.code === 'diff-too-large',
    );
  });

  it('masks addresses and host paths in a single line', () => {
    assert.equal(redactFileLine('server-ip=203.0.113.7:25565').redacted, true);
    assert.ok(!redactFileLine('server-ip=203.0.113.7:25565').text.includes('203.0.113.7'));
    assert.ok(!redactFileLine('world=C:\\Servers\\void\\world').text.includes('Servers'));
    assert.equal(redactFileLine('max-players=20').redacted, false);
  });
});

describe('diff against stored state', () => {
  it('compares proposed text and a revision against what is on disk', async () => {
    const test = await fixture();
    try {
      const proposed = await test.service.diff({
        rootId: 'server-config',
        filePath: 'config/server.properties',
        against: { type: 'proposed', content: 'motd=VoidFall\nmax-players=24\n' },
      });
      assert.equal(proposed.previousLabel, 'current');
      assert.equal(proposed.currentLabel, 'proposed');
      assert.equal(proposed.diff.addedCount, 1);
      assert.equal(proposed.diff.removedCount, 1);
      // Nothing was written by asking for a diff.
      assert.equal(
        await readFile(join(test.contentRoot, 'config', 'server.properties'), 'utf8'),
        'motd=VoidFall\nmax-players=20\n',
      );

      await test.service.delete({
        rootId: 'server-config',
        filePath: 'config/server.properties',
        revisionId: 'revision-diff-1',
        expectedSha256: digest('motd=VoidFall\nmax-players=20\n'),
        ...identity,
      });
      // A deleted file compares as empty rather than failing, which is exactly
      // the review a restore needs.
      const againstRevision = await test.service.diff({
        rootId: 'server-config',
        filePath: 'config/server.properties',
        against: { type: 'revision', revisionId: 'revision-diff-1' },
      });
      assert.equal(againstRevision.diff.addedCount, 0);
      assert.equal(againstRevision.diff.removedCount, 2);
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });
});
