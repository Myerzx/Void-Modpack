import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { ModCatalogEntry } from '@voidfall/contracts';
import {
  Ed25519ReleaseSigner,
  FilesystemReleaseBuilder,
  FilesystemReleaseRepository,
  sha256Bytes,
} from '@voidfall/modpack-release';
import { buildLauncherApi } from '../src/app.js';
import { readLauncherApiConfig } from '../src/config.js';

const roots: string[] = [];
const reviewerId = '018f6b8c-76a3-7d10-9f2e-1d9e52a63701';

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function releaseFixture(): Promise<{
  readonly repository: FilesystemReleaseRepository;
  readonly keyId: string;
  readonly publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'];
  readonly artifactBytes: Uint8Array;
  readonly artifactSha256: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'voidfall-launcher-api-'));
  roots.push(root);
  const source = join(root, 'source');
  const staging = join(root, 'staging');
  const repositoryRoot = join(root, 'repository');
  await Promise.all([mkdir(source), mkdir(staging), mkdir(repositoryRoot)]);
  const artifactBytes = Buffer.from('launcher-api-artifact-fixture', 'utf8');
  const artifactSha256 = sha256Bytes(artifactBytes);
  await writeFile(join(source, 'voidfall.zip'), artifactBytes);
  const keys = generateKeyPairSync('ed25519');
  const keyId = 'release-test-01';
  const signer = new Ed25519ReleaseSigner({ keyId, privateKey: keys.privateKey });
  const repository = new FilesystemReleaseRepository({ root: repositoryRoot, signer });
  const entry: ModCatalogEntry = {
    schemaVersion: 1,
    id: 'voidfall-textures',
    logicalName: 'VoidFall textures',
    filename: 'voidfall.zip',
    path: 'resourcepacks/voidfall.zip',
    kind: 'resource-pack',
    side: 'client',
    requirement: 'required',
    version: '1.0.0',
    sizeBytes: artifactBytes.byteLength,
    sha256: artifactSha256,
    runtime: {
      minecraftVersion: '1.20.1',
      loader: 'forge',
      loaderVersion: '1.20.1-47.4.4',
    },
    source: { provider: 'manual-reviewed', projectId: 'voidfall-textures', fileId: 'fixture' },
    distribution: {
      decision: 'allowed',
      licenseExpression: 'LicenseRef-VoidFall-Test',
      evidenceReference: 'review://voidfall-textures',
      reviewedBy: reviewerId,
      reviewedAt: '2026-08-03T12:00:00Z',
    },
    reviewState: 'reviewed',
    dependencies: [],
  };
  const builder = new FilesystemReleaseBuilder({ sourceRoot: source, stagingRoot: staging, repository, signer });
  await builder.build({
    version: '1.0.0',
    buildId: 'build-20260803-150000-api',
    createdAt: '2026-08-03T15:00:00Z',
    message: 'Launcher API fixture.',
    runtime: {
      minecraft: '1.20.1',
      loader: 'forge',
      loaderVersion: '1.20.1-47.4.4',
      javaMajor: 17,
    },
    serverProfile: { id: 'voidfall-primary', displayName: 'VoidFall' },
    intendedChannel: 'beta',
    artifacts: [
      {
        catalogEntry: entry,
        sourcePath: 'voidfall.zip',
        sourceSha256: artifactSha256,
        sanitization: { strategy: 'exact-reviewed-bytes-v1' },
      },
    ],
    removedPaths: [],
    gates: {
      clientBaseApproved: false,
      distributionChainApproved: false,
      cleanImportPassed: false,
      launchCompatibilityPassed: false,
      dependencyBlockerCount: 0,
    },
  });
  await repository.promoteChannel({
    channel: 'beta',
    expectedRevision: null,
    releaseVersion: '1.0.0',
    buildId: 'build-20260803-150000-api',
    manifestUrl:
      'https://updates.voidfall.invalid/launcher/v1/releases/1.0.0/build-20260803-150000-api/manifest',
    publishedAt: '2026-08-03T15:05:00Z',
    gates: {
      clientBaseApproved: false,
      distributionChainApproved: false,
      cleanImportPassed: false,
      launchCompatibilityPassed: false,
      dependencyBlockerCount: 0,
    },
  });
  return { repository, keyId, publicKey: keys.publicKey, artifactBytes, artifactSha256 };
}

describe('Launcher API', () => {
  it('serves only verified channels, manifests and immutable artifacts', async () => {
    const fixture = await releaseFixture();
    const app = await buildLauncherApi({
      repository: fixture.repository,
      publicKeys: new Map([[fixture.keyId, fixture.publicKey]]),
    });
    try {
      const health = await app.inject({ method: 'GET', url: '/health/live' });
      assert.equal(health.statusCode, 200);

      const channel = await app.inject({ method: 'GET', url: '/launcher/v1/channels/beta' });
      assert.equal(channel.statusCode, 200);
      assert.equal(channel.headers['cache-control'], 'public, max-age=15, must-revalidate');
      assert.equal(channel.json().revision, 1);

      const manifest = await app.inject({
        method: 'GET',
        url: '/launcher/v1/releases/1.0.0/build-20260803-150000-api/manifest',
      });
      assert.equal(manifest.statusCode, 200);
      assert.equal(manifest.headers['cache-control'], 'public, max-age=31536000, immutable');
      assert.equal(manifest.json().product.id, 'voidfall');

      const artifact = await app.inject({
        method: 'GET',
        url: `/launcher/v1/artifacts/sha256:${fixture.artifactSha256}`,
      });
      assert.equal(artifact.statusCode, 200);
      assert.deepEqual(artifact.rawPayload, Buffer.from(fixture.artifactBytes));
      assert.equal(artifact.headers.etag, `"sha256-${fixture.artifactSha256}"`);

      assert.equal(
        (await app.inject({ method: 'GET', url: '/launcher/v1/channels/stable' })).statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ method: 'POST', url: '/launcher/v1/channels/beta' })).statusCode,
        404,
      );
    } finally {
      await app.close();
    }
  });

  it('fails closed when the pinned release key is wrong', async () => {
    const fixture = await releaseFixture();
    const wrong = generateKeyPairSync('ed25519');
    const app = await buildLauncherApi({
      repository: fixture.repository,
      publicKeys: new Map([[fixture.keyId, wrong.publicKey]]),
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/launcher/v1/channels/beta' });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'SIGNATURE_INVALID');
    } finally {
      await app.close();
    }
  });
});

describe('Launcher API configuration', () => {
  it('loads an absolute repository and Ed25519 public key set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'voidfall-launcher-config-'));
    roots.push(root);
    const keys = generateKeyPairSync('ed25519');
    const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const config = readLauncherApiConfig({
      VOIDFALL_RELEASE_REPOSITORY_ROOT: root,
      VOIDFALL_RELEASE_PUBLIC_KEYS_JSON: JSON.stringify({ 'release-test-01': pem }),
      VOIDFALL_LAUNCHER_PORT: '3211',
    });
    assert.equal(config.repositoryRoot, root);
    assert.equal(config.publicKeys.size, 1);
  });
});
