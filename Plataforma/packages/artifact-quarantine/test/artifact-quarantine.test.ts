import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  ArtifactQuarantineService,
  QuarantineOperationError,
  type QuarantineArtifactPlan,
} from '../src/index.js';

const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

async function fixture(): Promise<{ readonly directory: string; readonly service: ArtifactQuarantineService }> {
  const directory = await mkdtemp(join(tmpdir(), 'voidfall-quarantine-'));
  return {
    directory,
    service: new ArtifactQuarantineService({
      quarantineRoot: join(directory, 'quarantine'),
      allowedExtensions: ['.jar', '.zip'],
      maximumArtifactBytes: 1_024,
    }),
  };
}

function plan(overrides: Partial<QuarantineArtifactPlan> = {}): QuarantineArtifactPlan {
  return {
    quarantineId: 'artifact-20260803',
    filename: 'example.jar',
    kind: 'mod',
    receivedAt: '2026-08-03T15:00:00.000Z',
    declaredSizeBytes: zipBytes.byteLength,
    expectedSha256: createHash('sha256').update(zipBytes).digest('hex'),
    ...overrides,
  };
}

describe('ArtifactQuarantineService', () => {
  it('streams an opaque JAR into a new immutable quarantine directory', async () => {
    const test = await fixture();
    try {
      const receipt = await test.service.quarantine(plan(), [zipBytes.subarray(0, 3), zipBytes.subarray(3)]);
      assert.equal(receipt.status, 'quarantined');
      assert.equal(receipt.sizeBytes, zipBytes.byteLength);
      assert.equal(Object.isFrozen(receipt), true);

      const artifactRoot = join(test.directory, 'quarantine', 'artifacts', 'artifact-20260803');
      assert.deepEqual(await readdir(artifactRoot), ['manifest.json', 'payload.bin']);
      assert.deepEqual(await readFile(join(artifactRoot, 'payload.bin')), zipBytes);
      const manifest = JSON.parse(await readFile(join(artifactRoot, 'manifest.json'), 'utf8')) as {
        readonly validation: { readonly status: string; readonly strategy: string };
        readonly sha256: string;
      };
      assert.deepEqual(manifest.validation, {
        status: 'quarantined',
        strategy: 'zip-signature-v1',
      });
      assert.equal(manifest.sha256, receipt.sha256);
      assert.equal((await lstat(join(artifactRoot, 'payload.bin'))).nlink, 1);
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('rejects a hash mismatch and removes only the staging artifact', async () => {
    const test = await fixture();
    try {
      await assert.rejects(
        test.service.quarantine(plan({ expectedSha256: 'a'.repeat(64) }), [zipBytes]),
        (error) => error instanceof QuarantineOperationError && error.code === 'hash-mismatch',
      );
      assert.deepEqual(await readdir(join(test.directory, 'quarantine', 'staging')), []);
      assert.deepEqual(await readdir(join(test.directory, 'quarantine', 'artifacts')), []);
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('enforces the declared and configured byte limits while streaming', async () => {
    const test = await fixture();
    try {
      await assert.rejects(
        test.service.quarantine(plan({ declaredSizeBytes: 4 }), [zipBytes]),
        (error) => error instanceof QuarantineOperationError && error.code === 'content-too-large',
      );
      const short = zipBytes.subarray(0, 4);
      await assert.rejects(
        test.service.quarantine(
          plan({ declaredSizeBytes: 5, expectedSha256: createHash('sha256').update(short).digest('hex') }),
          [short],
        ),
        (error) => error instanceof QuarantineOperationError && error.code === 'size-mismatch',
      );
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('rejects content without a ZIP signature even when its hash matches', async () => {
    const test = await fixture();
    const invalid = Buffer.from('not-a-zip');
    try {
      await assert.rejects(
        test.service.quarantine(
          plan({
            declaredSizeBytes: invalid.byteLength,
            expectedSha256: createHash('sha256').update(invalid).digest('hex'),
          }),
          [invalid],
        ),
        (error) =>
          error instanceof QuarantineOperationError &&
          error.code === 'invalid-container-signature',
      );
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('never overwrites an existing quarantine identity', async () => {
    const test = await fixture();
    try {
      const first = await test.service.quarantine(plan(), [zipBytes]);
      await assert.rejects(
        test.service.quarantine(plan(), [zipBytes]),
        (error) => error instanceof QuarantineOperationError && error.code === 'artifact-conflict',
      );
      assert.deepEqual(
        await readFile(join(test.directory, 'quarantine', first.storageReference, 'payload.bin')),
        zipBytes,
      );
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('rejects traversal, unsupported extensions and extra plan fields', async () => {
    const test = await fixture();
    try {
      for (const invalid of [
        plan({ filename: '../escape.jar' }),
        plan({ filename: 'executable.exe' }),
        { ...plan(), absolutePath: 'C:\\server' } as never,
      ]) {
        await assert.rejects(
          test.service.quarantine(invalid, [zipBytes]),
          (error) => error instanceof QuarantineOperationError && error.code === 'invalid-plan',
        );
      }
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('rejects a linked staging root instead of following it', async (context) => {
    const test = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'voidfall-quarantine-outside-'));
    try {
      const quarantineRoot = join(test.directory, 'quarantine');
      await rm(quarantineRoot, { recursive: true, force: true });
      await symlink(outside, quarantineRoot, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(
        test.service.quarantine(plan(), [zipBytes]),
        (error) => error instanceof QuarantineOperationError && error.code === 'unsafe-root',
      );
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === 'EPERM' || error.code === 'EACCES')
      ) {
        context.skip('symlink creation is unavailable in this environment');
      } else {
        throw error;
      }
    } finally {
      await rm(test.directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
