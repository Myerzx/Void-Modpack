import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import type {
  LauncherChannel,
  LauncherManagedState,
  ReleaseManifest,
} from '@voidfall/contracts';
import {
  canonicalJsonBytes,
  Ed25519ReleaseSigner,
  sha256Bytes,
  signLauncherChannel,
  signReleaseManifest,
  type CanonicalJsonValue,
} from '@voidfall/modpack-release';
import {
  createPortableUpdatePlan,
  LauncherProtocolError,
  PinnedReleaseKeyring,
} from '../src/index.js';

const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const hashC = 'c'.repeat(64);
const hashD = 'd'.repeat(64);

function signedDocuments(input?: {
  readonly removedPaths?: string[];
}): {
  readonly channel: LauncherChannel;
  readonly manifest: ReleaseManifest;
  readonly keyring: PinnedReleaseKeyring;
} {
  const keys = generateKeyPairSync('ed25519');
  const signer = new Ed25519ReleaseSigner({ keyId: 'release-test-01', privateKey: keys.privateKey });
  const manifest = signReleaseManifest(
    {
      schemaVersion: 1,
      product: { id: 'voidfall', displayName: 'VoidFall' },
      release: {
        version: '2.0.0',
        buildId: 'build-20260803-140000-portable',
        previousVersion: '1.0.0',
        publishedAt: '2026-08-03T14:00:00Z',
        message: 'Portable update fixture.',
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
          path: 'config/a.json',
          artifactId: `sha256:${hashA}`,
          size: 10,
          sha256: hashA,
          kind: 'config',
          side: 'both',
          required: true,
        },
        {
          path: 'mods/b.jar',
          artifactId: `sha256:${hashC}`,
          size: 20,
          sha256: hashC,
          kind: 'mod',
          side: 'both',
          required: true,
        },
        {
          path: 'resourcepacks/new.zip',
          artifactId: `sha256:${hashD}`,
          size: 30,
          sha256: hashD,
          kind: 'resource-pack',
          side: 'client',
          required: true,
        },
      ],
      removedPaths: input?.removedPaths ?? ['mods/old.jar'],
    },
    signer,
  );
  const manifestSha256 = sha256Bytes(canonicalJsonBytes(manifest as CanonicalJsonValue));
  const channel = signLauncherChannel(
    {
      schemaVersion: 1,
      product: { id: 'voidfall', displayName: 'VoidFall' },
      channel: 'stable',
      revision: 2,
      operation: 'promotion',
      releaseVersion: '2.0.0',
      buildId: 'build-20260803-140000-portable',
      manifestSha256,
      manifestUrl:
        'https://updates.voidfall.invalid/launcher/v1/releases/2.0.0/build-20260803-140000-portable/manifest',
      publishedAt: '2026-08-03T14:05:00Z',
      previous: {
        revision: 1,
        releaseVersion: '1.0.0',
        buildId: 'build-20260803-130000-previous',
      },
    },
    signer,
  );
  return {
    channel,
    manifest,
    keyring: new PinnedReleaseKeyring(new Map([[signer.keyId, keys.publicKey]])),
  };
}

function currentState(): LauncherManagedState {
  return {
    schemaVersion: 1,
    product: { id: 'voidfall', displayName: 'VoidFall' },
    channel: 'stable',
    channelRevision: 1,
    releaseVersion: '1.0.0',
    buildId: 'build-20260803-130000-previous',
    installedAt: '2026-08-03T13:05:00Z',
    files: [
      { path: 'config/a.json', sha256: hashA },
      { path: 'mods/b.jar', sha256: hashB },
      { path: 'mods/old.jar', sha256: hashB },
    ],
  };
}

describe('portable launcher update planner', () => {
  it('calculates keep, replace, remove and download without filesystem paths', () => {
    const documents = signedDocuments();
    const result = createPortableUpdatePlan({
      ...documents,
      currentState: currentState(),
      plannedAt: '2026-08-03T14:06:00Z',
      verifier: documents.keyring,
    });

    assert.deepEqual(result.summary, {
      keep: 1,
      download: 1,
      replace: 1,
      remove: 1,
      downloadBytes: 50,
    });
    assert.deepEqual(
      result.operations.map((operation) => [operation.path, operation.operation]),
      [
        ['config/a.json', 'keep'],
        ['mods/b.jar', 'replace'],
        ['mods/old.jar', 'remove'],
        ['resourcepacks/new.zip', 'download'],
      ],
    );
    assert.equal(result.nextState.channelRevision, 2);
    assert.deepEqual(
      result.nextState.files.map((file) => file.path),
      ['config/a.json', 'mods/b.jar', 'resourcepacks/new.zip'],
    );
    assert.equal(JSON.stringify(result).includes('C:\\'), false);
  });

  it('downloads every managed file for a clean install', () => {
    const documents = signedDocuments();
    const result = createPortableUpdatePlan({
      ...documents,
      plannedAt: '2026-08-03T14:06:00Z',
      verifier: documents.keyring,
    });
    assert.equal(result.summary.download, 3);
    assert.equal(result.summary.downloadBytes, 60);
    assert.equal(result.from, undefined);
  });

  it('rejects a stale managed path unless the signed manifest removes it explicitly', () => {
    const documents = signedDocuments({ removedPaths: [] });
    assert.throws(
      () =>
        createPortableUpdatePlan({
          ...documents,
          currentState: currentState(),
          plannedAt: '2026-08-03T14:06:00Z',
          verifier: documents.keyring,
        }),
      (error: unknown) =>
        error instanceof LauncherProtocolError && error.code === 'incomplete-removal-set',
    );
  });

  it('rejects tampering, an unpinned key and channel regression', () => {
    const documents = signedDocuments();
    assert.throws(
      () =>
        createPortableUpdatePlan({
          ...documents,
          manifest: {
            ...documents.manifest,
            release: { ...documents.manifest.release, message: 'tampered' },
          },
          plannedAt: '2026-08-03T14:06:00Z',
          verifier: documents.keyring,
        }),
      (error: unknown) =>
        error instanceof LauncherProtocolError && error.code === 'untrusted-signature',
    );

    const wrongKeys = generateKeyPairSync('ed25519');
    const wrongKeyring = new PinnedReleaseKeyring(
      new Map([[documents.manifest.signature.keyId, wrongKeys.publicKey]]),
    );
    assert.throws(
      () =>
        createPortableUpdatePlan({
          ...documents,
          plannedAt: '2026-08-03T14:06:00Z',
          verifier: wrongKeyring,
        }),
      (error: unknown) =>
        error instanceof LauncherProtocolError && error.code === 'untrusted-signature',
    );

    assert.throws(
      () =>
        createPortableUpdatePlan({
          ...documents,
          currentState: { ...currentState(), channelRevision: 3 },
          plannedAt: '2026-08-03T14:06:00Z',
          verifier: documents.keyring,
        }),
      (error: unknown) =>
        error instanceof LauncherProtocolError && error.code === 'channel-regression',
    );
  });
});
