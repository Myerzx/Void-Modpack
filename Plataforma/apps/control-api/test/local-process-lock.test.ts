import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  acquireLocalProcessLock,
  LocalProcessLockError,
} from '../src/local-process-lock.js';

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    await rm(directories.pop()!, { recursive: true, force: true });
  }
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'voidfall-local-lock-'));
  directories.push(root, `${root}.lock`);
  return root;
}

describe('local process lock', () => {
  it('allows only one owner of a PGlite state directory at a time', async () => {
    const stateDirectory = await fixture();
    const first = await acquireLocalProcessLock(stateDirectory);

    await assert.rejects(
      acquireLocalProcessLock(stateDirectory),
      (error: unknown) =>
        error instanceof LocalProcessLockError && error.code === 'already-running',
    );

    await first.release();
    const next = await acquireLocalProcessLock(stateDirectory);
    await next.release();
  });

  it('reclaims a complete lock whose owner process is gone', async () => {
    const stateDirectory = await fixture();
    const lockDirectory = `${stateDirectory}.lock`;
    await mkdir(lockDirectory);
    await writeFile(
      join(lockDirectory, 'owner.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 4242,
        token: 'crashed-owner',
        acquiredAt: '2026-08-08T12:00:00.000Z',
      })}\n`,
      'utf8',
    );

    const lock = await acquireLocalProcessLock(stateDirectory, {
      isProcessAlive: () => false,
    });
    await lock.release();
  });
});
