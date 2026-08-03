import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { ModCatalogEntry, ReleaseManifest } from '@voidfall/contracts';
import {
  canonicalJsonBytes,
  Ed25519ReleaseSigner,
  FilesystemReleaseBuilder,
  ReleaseBuildError,
  sanitizeReleaseArtifact,
  sha256Bytes,
  verifyReleaseManifestSignature,
  type PublishReleaseInput,
  type ReleaseBuildPlan,
  type ReleaseRepository,
} from '../src/index.js';

const roots: string[] = [];
const reviewerId = '018f6b8c-76a3-7d10-9f2e-1d9e52a63701';

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function fixtureRoot(): Promise<{ readonly source: string; readonly staging: string }> {
  const root = await mkdtemp(join(tmpdir(), 'voidfall-release-'));
  roots.push(root);
  const source = join(root, 'source');
  const staging = join(root, 'staging');
  await Promise.all([mkdir(source), mkdir(staging)]);
  return { source, staging };
}

function catalogEntry(input: {
  readonly id: string;
  readonly path: string;
  readonly kind: ModCatalogEntry['kind'];
  readonly bytes: Uint8Array;
}): ModCatalogEntry {
  return {
    schemaVersion: 1,
    id: input.id,
    logicalName: input.id,
    filename: input.path.split('/').at(-1) as string,
    path: input.path,
    kind: input.kind,
    side: 'both',
    requirement: 'required',
    version: '1.0.0',
    sizeBytes: input.bytes.byteLength,
    sha256: sha256Bytes(input.bytes),
    runtime: {
      minecraftVersion: '1.20.1',
      loader: 'forge',
      loaderVersion: '1.20.1-47.4.4',
    },
    source: {
      provider: 'manual-reviewed',
      projectId: input.id,
      fileId: 'fixture-v1',
    },
    distribution: {
      decision: 'allowed',
      licenseExpression: 'MIT',
      evidenceReference: `review://${input.id}`,
      reviewedBy: reviewerId,
      reviewedAt: '2026-08-03T12:00:00Z',
    },
    reviewState: 'reviewed',
    dependencies: [],
  };
}

class CapturingRepository implements ReleaseRepository {
  readonly publications: Array<{
    readonly manifest: ReleaseManifest;
    readonly manifestSha256: string;
    readonly artifactBytes: readonly Uint8Array[];
  }> = [];

  async publishRelease(input: PublishReleaseInput): Promise<void> {
    this.publications.push({
      manifest: input.manifest,
      manifestSha256: input.manifestSha256,
      artifactBytes: await Promise.all(input.artifacts.map((artifact) => readFile(artifact.stagedPath))),
    });
  }
}

function plan(input: {
  readonly jsonSource: Uint8Array;
  readonly jsonOutput: Uint8Array;
  readonly binarySource: Uint8Array;
}): ReleaseBuildPlan {
  return {
    version: '1.0.0',
    buildId: 'build-20260803-120000-fixture',
    createdAt: '2026-08-03T12:00:00Z',
    message: 'Release reproduzível de teste.',
    runtime: {
      minecraft: '1.20.1',
      loader: 'forge',
      loaderVersion: '1.20.1-47.4.4',
      javaMajor: 17,
    },
    serverProfile: { id: 'voidfall-primary', displayName: 'VoidFall' },
    intendedChannel: 'stable',
    artifacts: [
      {
        catalogEntry: catalogEntry({
          id: 'visual-options',
          path: 'config/visual-options.json',
          kind: 'config',
          bytes: input.jsonOutput,
        }),
        sourcePath: 'raw/visual-options.json',
        sourceSha256: sha256Bytes(input.jsonSource),
        sanitization: {
          strategy: 'canonical-json-object-v1',
          allowedKeys: ['graphics'],
        },
      },
      {
        catalogEntry: catalogEntry({
          id: 'voidfall-textures',
          path: 'resourcepacks/voidfall.zip',
          kind: 'resource-pack',
          bytes: input.binarySource,
        }),
        sourcePath: 'reviewed/voidfall.zip',
        sourceSha256: sha256Bytes(input.binarySource),
        sanitization: { strategy: 'exact-reviewed-bytes-v1' },
      },
    ],
    removedPaths: ['mods/old-client-mod.jar'],
    gates: {
      clientBaseApproved: false,
      distributionChainApproved: false,
      cleanImportPassed: false,
      launchCompatibilityPassed: false,
      dependencyBlockerCount: 0,
    },
  };
}

describe('release sanitization', () => {
  it('produces canonical JSON and removes fields outside the allowlist', () => {
    const source = Buffer.from('{"serverIp":"10.0.0.5","graphics":"fancy","token":"secret"}', 'utf8');
    const sanitized = sanitizeReleaseArtifact({
      source,
      sourceSha256: sha256Bytes(source),
      policy: { strategy: 'canonical-json-object-v1', allowedKeys: ['graphics'] },
    });
    assert.equal(Buffer.from(sanitized.bytes).toString('utf8'), '{"graphics":"fancy"}');
    assert.equal(sanitized.receipt.removedFieldCount, 2);
  });

  it('canonicalizes the strict properties subset and rejects ambiguous escapes', () => {
    const source = Buffer.from('unused=remove\nquality=high\nparticles=low\n', 'utf8');
    const sanitized = sanitizeReleaseArtifact({
      source,
      sourceSha256: sha256Bytes(source),
      policy: {
        strategy: 'java-properties-allowlist-v1',
        allowedKeys: ['quality', 'particles'],
      },
    });
    assert.equal(Buffer.from(sanitized.bytes).toString('utf8'), 'particles=low\nquality=high\n');
    assert.equal(sanitized.receipt.removedFieldCount, 1);

    const ambiguous = Buffer.from('quality=high\\\ncontinued=true\n', 'utf8');
    assert.throws(
      () =>
        sanitizeReleaseArtifact({
          source: ambiguous,
          sourceSha256: sha256Bytes(ambiguous),
          policy: { strategy: 'java-properties-allowlist-v1', allowedKeys: ['quality'] },
        }),
      (error: unknown) => error instanceof ReleaseBuildError && error.code === 'sanitization-failed',
    );
  });
});

describe('FilesystemReleaseBuilder', () => {
  it('builds the same signed manifest twice and always cleans private staging', async () => {
    const paths = await fixtureRoot();
    await Promise.all([
      mkdir(join(paths.source, 'raw')),
      mkdir(join(paths.source, 'reviewed')),
    ]);
    const jsonSource = Buffer.from('{"token":"remove","graphics":"fancy"}', 'utf8');
    const jsonOutput = canonicalJsonBytes({ graphics: 'fancy' });
    const binarySource = Buffer.from('reviewed-resource-pack-fixture', 'utf8');
    await Promise.all([
      writeFile(join(paths.source, 'raw', 'visual-options.json'), jsonSource),
      writeFile(join(paths.source, 'reviewed', 'voidfall.zip'), binarySource),
    ]);
    const repository = new CapturingRepository();
    const keys = generateKeyPairSync('ed25519');
    const builder = new FilesystemReleaseBuilder({
      sourceRoot: paths.source,
      stagingRoot: paths.staging,
      repository,
      signer: new Ed25519ReleaseSigner({ keyId: 'release-test-01', privateKey: keys.privateKey }),
    });
    const buildPlan = plan({ jsonSource, jsonOutput, binarySource });

    const first = await builder.build(buildPlan);
    const second = await builder.build(buildPlan);

    assert.equal(first.manifestSha256, second.manifestSha256);
    assert.equal(first.stableEligible, false);
    assert.equal(first.files, 2);
    assert.deepEqual(await (await import('node:fs/promises')).readdir(paths.staging), []);
    assert.equal(repository.publications.length, 2);
    const manifest = repository.publications[0]?.manifest;
    assert.ok(manifest !== undefined && verifyReleaseManifestSignature(manifest, keys.publicKey));
    assert.deepEqual(manifest.files.map((file) => file.path), [
      'config/visual-options.json',
      'resourcepacks/voidfall.zip',
    ]);
  });

  it('rejects a changed source before publication and cleans staging', async () => {
    const paths = await fixtureRoot();
    await Promise.all([
      mkdir(join(paths.source, 'raw')),
      mkdir(join(paths.source, 'reviewed')),
    ]);
    const jsonSource = Buffer.from('{"graphics":"fancy"}', 'utf8');
    const jsonOutput = canonicalJsonBytes({ graphics: 'fancy' });
    const binarySource = Buffer.from('reviewed-resource-pack-fixture', 'utf8');
    await Promise.all([
      writeFile(join(paths.source, 'raw', 'visual-options.json'), '{"graphics":"tampered"}'),
      writeFile(join(paths.source, 'reviewed', 'voidfall.zip'), binarySource),
    ]);
    const repository = new CapturingRepository();
    const keys = generateKeyPairSync('ed25519');
    const builder = new FilesystemReleaseBuilder({
      sourceRoot: paths.source,
      stagingRoot: paths.staging,
      repository,
      signer: new Ed25519ReleaseSigner({ keyId: 'release-test-01', privateKey: keys.privateKey }),
    });

    await assert.rejects(
      builder.build(plan({ jsonSource, jsonOutput, binarySource })),
      (error: unknown) =>
        error instanceof ReleaseBuildError && error.code === 'source-integrity-mismatch',
    );
    assert.equal(repository.publications.length, 0);
    assert.deepEqual(await (await import('node:fs/promises')).readdir(paths.staging), []);
  });

  it('rejects hard-linked source files and unreviewed distribution', async () => {
    const paths = await fixtureRoot();
    await mkdir(join(paths.source, 'reviewed'));
    const source = Buffer.from('reviewed-resource-pack-fixture', 'utf8');
    const original = join(paths.source, 'original.zip');
    const linked = join(paths.source, 'reviewed', 'voidfall.zip');
    await writeFile(original, source);
    await link(original, linked);
    const repository = new CapturingRepository();
    const keys = generateKeyPairSync('ed25519');
    const builder = new FilesystemReleaseBuilder({
      sourceRoot: paths.source,
      stagingRoot: paths.staging,
      repository,
      signer: new Ed25519ReleaseSigner({ keyId: 'release-test-01', privateKey: keys.privateKey }),
    });
    const entry = catalogEntry({
      id: 'voidfall-textures',
      path: 'resourcepacks/voidfall.zip',
      kind: 'resource-pack',
      bytes: source,
    });
    const base: ReleaseBuildPlan = {
      ...plan({ jsonSource: source, jsonOutput: source, binarySource: source }),
      artifacts: [
        {
          catalogEntry: entry,
          sourcePath: 'reviewed/voidfall.zip',
          sourceSha256: sha256Bytes(source),
          sanitization: { strategy: 'exact-reviewed-bytes-v1' },
        },
      ],
    };

    await assert.rejects(
      builder.build(base),
      (error: unknown) => error instanceof ReleaseBuildError && error.code === 'unsupported-entry',
    );

    const pending: ModCatalogEntry = {
      ...entry,
      distribution: { decision: 'pending' },
      reviewState: 'detected',
    };
    await assert.rejects(
      builder.build({ ...base, artifacts: [{ ...base.artifacts[0]!, catalogEntry: pending }] }),
      (error: unknown) => error instanceof ReleaseBuildError && error.code === 'invalid-plan',
    );
  });
});
