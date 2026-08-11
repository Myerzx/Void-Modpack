import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { LocalArtifactStore } from '../src/local-artifacts.js';

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    await rm(directories.pop()!, { recursive: true, force: true });
  }
});

async function fixture() {
  const state = await mkdtemp(join(tmpdir(), 'voidfall-local-artifacts-'));
  directories.push(state);
  return { state, store: new LocalArtifactStore(state) };
}

const bytes = Buffer.from('504b0304140000000000000000000000000000000000000000000000000000', 'hex');
const sha256 = createHash('sha256').update(bytes).digest('hex');

async function* stream(content: Uint8Array): AsyncIterable<Uint8Array> {
  yield content;
}

describe('local artifact quarantine', () => {
  it('stores, replays and reads content by its complete digest', async () => {
    const context = await fixture();
    const input = {
      filename: 'reviewed-probe.jar',
      declaredSizeBytes: bytes.byteLength,
      expectedSha256: sha256,
      content: stream(bytes),
      receivedAt: new Date('2026-08-11T20:00:00.000Z'),
    };
    assert.deepEqual(await context.store.quarantineStream({ ...input, content: stream(bytes) }), {
      sha256,
      sizeBytes: bytes.byteLength,
    });
    assert.deepEqual(Buffer.from(await context.store.read(sha256)), bytes);
    assert.deepEqual(await context.store.quarantineStream(input), {
      sha256,
      sizeBytes: bytes.byteLength,
    });
  });

  it('refuses quarantined bytes whose content no longer matches their identity', async () => {
    const context = await fixture();
    await context.store.quarantineStream({
      filename: 'reviewed-probe.jar',
      declaredSizeBytes: bytes.byteLength,
      expectedSha256: sha256,
      content: stream(bytes),
      receivedAt: new Date('2026-08-11T20:00:00.000Z'),
    });
    const artifacts = join(context.state, 'artifact-quarantine', 'artifacts');
    const [artifactDirectory] = await readdir(artifacts);
    assert.ok(artifactDirectory !== undefined);
    await writeFile(join(artifacts, artifactDirectory, 'payload.bin'), Buffer.from('504b0304', 'hex'));
    await assert.rejects(context.store.read(sha256), /integrity-mismatch/u);
  });
});
