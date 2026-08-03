import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  canPublishInStable,
  validateModCatalogEntry,
  type ReleaseManifest,
} from '@voidfall/contracts';
import { canonicalJsonBytes, sha256Bytes, type CanonicalJsonValue } from './canonical-json.js';
import { sanitizeReleaseArtifact } from './sanitization.js';
import { signReleaseManifest } from './signing.js';
import {
  DEFAULT_RELEASE_BUILD_LIMITS,
  ReleaseBuildError,
  VOIDFALL_RELEASE_FORMAT,
  VOIDFALL_RELEASE_SCHEMA_VERSION,
  type FilesystemReleaseBuilderOptions,
  type ReleaseBuildArtifact,
  type ReleaseBuildLimits,
  type ReleaseBuildPlan,
  type ReleaseBuildReceipt,
  type ReleaseExternalGates,
  type ReleaseSanitizationReceipt,
  type StagedReleaseArtifact,
} from './types.js';

interface ValidatedOptions {
  readonly sourceRoot: string;
  readonly stagingRoot: string;
  readonly repository: FilesystemReleaseBuilderOptions['repository'];
  readonly signer: FilesystemReleaseBuilderOptions['signer'];
  readonly limits: ReleaseBuildLimits;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function normalizedPath(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function comparePaths(left: string, right: string): number {
  return normalizedPath(left).localeCompare(normalizedPath(right), 'en-US');
}

function validateRelativePath(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    value.includes('\\') ||
    value.includes('\u0000') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value) ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new ReleaseBuildError('invalid-plan', 'plan');
  }
}

function validateSha256(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ReleaseBuildError('invalid-plan', 'plan');
  }
}

function validateAbsolutePath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\u0000')) {
    throw new ReleaseBuildError('invalid-options', 'options');
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function resolveLimits(input: Partial<ReleaseBuildLimits> | undefined): ReleaseBuildLimits {
  const limits = { ...DEFAULT_RELEASE_BUILD_LIMITS, ...input };
  if (
    !positiveInteger(limits.maximumFiles) ||
    !positiveInteger(limits.maximumInputFileBytes) ||
    !positiveInteger(limits.maximumOutputFileBytes) ||
    !positiveInteger(limits.maximumStructuredConfigBytes) ||
    !positiveInteger(limits.maximumTotalOutputBytes) ||
    limits.maximumOutputFileBytes > limits.maximumTotalOutputBytes ||
    limits.maximumStructuredConfigBytes > limits.maximumInputFileBytes
  ) {
    throw new ReleaseBuildError('invalid-options', 'options');
  }
  return Object.freeze(limits);
}

function validateOptions(options: FilesystemReleaseBuilderOptions): ValidatedOptions {
  validateAbsolutePath(options.sourceRoot);
  validateAbsolutePath(options.stagingRoot);
  if (
    options.repository === undefined ||
    typeof options.repository.publishRelease !== 'function' ||
    options.signer === undefined ||
    typeof options.signer.sign !== 'function' ||
    typeof options.signer.keyId !== 'string'
  ) {
    throw new ReleaseBuildError('invalid-options', 'options');
  }
  return Object.freeze({
    sourceRoot: resolve(options.sourceRoot),
    stagingRoot: resolve(options.stagingRoot),
    repository: options.repository,
    signer: options.signer,
    limits: resolveLimits(options.limits),
  });
}

function stableEligible(gates: ReleaseExternalGates): boolean {
  return (
    gates.clientBaseApproved &&
    gates.distributionChainApproved &&
    gates.cleanImportPassed &&
    gates.launchCompatibilityPassed &&
    gates.dependencyBlockerCount === 0
  );
}

function validateGates(value: ReleaseExternalGates): void {
  if (
    value === undefined ||
    typeof value.clientBaseApproved !== 'boolean' ||
    typeof value.distributionChainApproved !== 'boolean' ||
    typeof value.cleanImportPassed !== 'boolean' ||
    typeof value.launchCompatibilityPassed !== 'boolean' ||
    !Number.isSafeInteger(value.dependencyBlockerCount) ||
    value.dependencyBlockerCount < 0
  ) {
    throw new ReleaseBuildError('invalid-plan', 'plan');
  }
  if (value.dependencyBlockerCount > 0) {
    throw new ReleaseBuildError('invalid-plan', 'preflight');
  }
}

function validateArtifacts(
  artifacts: readonly ReleaseBuildArtifact[],
  plan: ReleaseBuildPlan,
  limits: ReleaseBuildLimits,
): readonly ReleaseBuildArtifact[] {
  if (!Array.isArray(artifacts) || artifacts.length < 1 || artifacts.length > limits.maximumFiles) {
    throw new ReleaseBuildError('invalid-plan', 'plan');
  }
  const sourcePaths = new Set<string>();
  const targetPaths = new Set<string>();
  const validated = artifacts.map((artifact) => {
    validateRelativePath(artifact.sourcePath);
    validateSha256(artifact.sourceSha256);
    const catalog = validateModCatalogEntry(artifact.catalogEntry);
    if (!catalog.success || !canPublishInStable(catalog.success ? catalog.value : artifact.catalogEntry)) {
      throw new ReleaseBuildError('invalid-plan', 'preflight');
    }
    if (
      catalog.value.runtime.minecraftVersion !== plan.runtime.minecraft ||
      catalog.value.runtime.loader !== plan.runtime.loader ||
      catalog.value.runtime.loaderVersion !== plan.runtime.loaderVersion
    ) {
      throw new ReleaseBuildError('invalid-plan', 'preflight');
    }
    const sourceKey = normalizedPath(artifact.sourcePath);
    const targetKey = normalizedPath(catalog.value.path);
    if (sourcePaths.has(sourceKey) || targetPaths.has(targetKey)) {
      throw new ReleaseBuildError('invalid-plan', 'preflight');
    }
    sourcePaths.add(sourceKey);
    targetPaths.add(targetKey);
    if (
      artifact.sanitization.strategy !== 'exact-reviewed-bytes-v1' &&
      catalog.value.kind !== 'config'
    ) {
      throw new ReleaseBuildError('invalid-plan', 'preflight');
    }
    return Object.freeze({ ...artifact, catalogEntry: catalog.value });
  });
  validated.sort((left, right) => comparePaths(left.catalogEntry.path, right.catalogEntry.path));
  return Object.freeze(validated);
}

function validatePlan(plan: ReleaseBuildPlan, limits: ReleaseBuildLimits): ReleaseBuildPlan {
  if (
    plan === undefined ||
    !['beta', 'stable'].includes(plan.intendedChannel) ||
    typeof plan.message !== 'string' ||
    plan.message.length < 1 ||
    plan.message.length > 2_000 ||
    !Number.isSafeInteger(plan.runtime.javaMajor) ||
    plan.runtime.javaMajor < 17
  ) {
    throw new ReleaseBuildError('invalid-plan', 'plan');
  }
  validateGates(plan.gates);
  const artifacts = validateArtifacts(plan.artifacts, plan, limits);
  if (!Array.isArray(plan.removedPaths) || plan.removedPaths.length > limits.maximumFiles) {
    throw new ReleaseBuildError('invalid-plan', 'plan');
  }
  const removed = plan.removedPaths.map((path) => {
    validateRelativePath(path);
    return path;
  });
  removed.sort(comparePaths);
  if (new Set(removed.map(normalizedPath)).size !== removed.length) {
    throw new ReleaseBuildError('invalid-plan', 'plan');
  }
  return Object.freeze({ ...plan, artifacts, removedPaths: Object.freeze(removed) });
}

async function requirePlainDirectory(path: string): Promise<string> {
  try {
    const direct = await lstat(path);
    if (!direct.isDirectory() || direct.isSymbolicLink()) {
      throw new ReleaseBuildError('unsafe-path', 'preflight');
    }
    const canonical = await realpath(path);
    const observed = await lstat(canonical);
    if (!observed.isDirectory() || observed.isSymbolicLink()) {
      throw new ReleaseBuildError('unsafe-path', 'preflight');
    }
    return canonical;
  } catch (error) {
    if (error instanceof ReleaseBuildError) throw error;
    throw new ReleaseBuildError('unsafe-path', 'preflight');
  }
}

async function resolveSafeSource(
  sourceRoot: string,
  sourcePath: string,
  maximumBytes: number,
): Promise<{ readonly path: string; readonly size: number }> {
  const parts = sourcePath.split('/');
  let cursor = sourceRoot;
  for (const [index, part] of parts.entries()) {
    cursor = resolve(cursor, part);
    if (!isWithin(sourceRoot, cursor) || cursor === sourceRoot) {
      throw new ReleaseBuildError('unsafe-path', 'preflight');
    }
    let observed;
    try {
      observed = await lstat(cursor);
    } catch {
      throw new ReleaseBuildError('unsafe-path', 'preflight');
    }
    if (observed.isSymbolicLink()) throw new ReleaseBuildError('unsupported-entry', 'preflight');
    const last = index === parts.length - 1;
    if (!last && !observed.isDirectory()) {
      throw new ReleaseBuildError('unsupported-entry', 'preflight');
    }
    if (
      last &&
      (!observed.isFile() || observed.nlink > 1 || observed.size < 1 || observed.size > maximumBytes)
    ) {
      throw new ReleaseBuildError(
        observed.size > maximumBytes ? 'limit-exceeded' : 'unsupported-entry',
        'preflight',
      );
    }
  }
  try {
    const final = await lstat(cursor);
    return Object.freeze({ path: cursor, size: final.size });
  } catch {
    throw new ReleaseBuildError('unsafe-path', 'preflight');
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } catch {
    throw new ReleaseBuildError('unsafe-path', 'stage');
  }
}

async function stageExactBytes(input: {
  readonly sourcePath: string;
  readonly sourceSize: number;
  readonly expectedSourceSha256: string;
  readonly expectedOutputSha256: string;
  readonly expectedOutputSize: number;
  readonly stagedPath: string;
}): Promise<ReleaseSanitizationReceipt> {
  const observedSourceSha256 = await sha256File(input.sourcePath);
  if (observedSourceSha256 !== input.expectedSourceSha256) {
    throw new ReleaseBuildError('source-integrity-mismatch', 'sanitize');
  }
  if (
    input.sourceSize !== input.expectedOutputSize ||
    observedSourceSha256 !== input.expectedOutputSha256
  ) {
    throw new ReleaseBuildError('output-integrity-mismatch', 'sanitize');
  }
  try {
    await copyFile(input.sourcePath, input.stagedPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') {
      throw new ReleaseBuildError('unsafe-path', 'stage');
    }
  }
  const stagedStat = await lstat(input.stagedPath);
  if (
    !stagedStat.isFile() ||
    stagedStat.isSymbolicLink() ||
    stagedStat.nlink > 1 ||
    stagedStat.size !== input.expectedOutputSize ||
    (await sha256File(input.stagedPath)) !== input.expectedOutputSha256
  ) {
    throw new ReleaseBuildError('output-integrity-mismatch', 'stage');
  }
  return Object.freeze({
    strategy: 'exact-reviewed-bytes-v1',
    sourceSha256: observedSourceSha256,
    outputSha256: input.expectedOutputSha256,
    removedFieldCount: 0,
  });
}

async function cleanupWorkspace(workspace: string, stagingRoot: string): Promise<void> {
  if (!isWithin(stagingRoot, workspace) || workspace === stagingRoot || !workspace.endsWith('.partial')) {
    throw new ReleaseBuildError('cleanup-failed', 'cleanup');
  }
  try {
    await rm(workspace, { recursive: true, force: true });
  } catch {
    throw new ReleaseBuildError('cleanup-failed', 'cleanup');
  }
}

export class FilesystemReleaseBuilder {
  readonly #options: ValidatedOptions;

  public constructor(options: FilesystemReleaseBuilderOptions) {
    this.#options = validateOptions(options);
  }

  public async build(planInput: ReleaseBuildPlan): Promise<ReleaseBuildReceipt> {
    const plan = validatePlan(planInput, this.#options.limits);
    const [sourceRoot, stagingRoot] = await Promise.all([
      requirePlainDirectory(this.#options.sourceRoot),
      requirePlainDirectory(this.#options.stagingRoot),
    ]);
    if (isWithin(sourceRoot, stagingRoot) || isWithin(stagingRoot, sourceRoot)) {
      throw new ReleaseBuildError('unsafe-path', 'preflight');
    }

    const workspace = resolve(stagingRoot, `${plan.buildId}-${randomUUID()}.partial`);
    if (!isWithin(stagingRoot, workspace) || workspace === stagingRoot) {
      throw new ReleaseBuildError('unsafe-path', 'stage');
    }
    try {
      await mkdir(resolve(workspace, 'artifacts'), { recursive: true });
    } catch {
      throw new ReleaseBuildError('unsafe-path', 'stage');
    }

    try {
      const stagedArtifacts: StagedReleaseArtifact[] = [];
      const sanitization: ReleaseSanitizationReceipt[] = [];
      let totalBytes = 0;

      for (const artifact of plan.artifacts) {
        if (artifact.catalogEntry.sizeBytes > this.#options.limits.maximumOutputFileBytes) {
          throw new ReleaseBuildError('limit-exceeded', 'preflight');
        }
        const source = await resolveSafeSource(
          sourceRoot,
          artifact.sourcePath,
          this.#options.limits.maximumInputFileBytes,
        );
        const stagedPath = resolve(workspace, 'artifacts', artifact.catalogEntry.sha256);
        let receipt: ReleaseSanitizationReceipt;
        let outputSize: number;
        if (artifact.sanitization.strategy === 'exact-reviewed-bytes-v1') {
          receipt = await stageExactBytes({
            sourcePath: source.path,
            sourceSize: source.size,
            expectedSourceSha256: artifact.sourceSha256,
            expectedOutputSha256: artifact.catalogEntry.sha256,
            expectedOutputSize: artifact.catalogEntry.sizeBytes,
            stagedPath,
          });
          outputSize = source.size;
        } else {
          if (source.size > this.#options.limits.maximumStructuredConfigBytes) {
            throw new ReleaseBuildError('limit-exceeded', 'sanitize');
          }
          const result = sanitizeReleaseArtifact({
            source: await readFile(source.path),
            sourceSha256: artifact.sourceSha256,
            policy: artifact.sanitization,
          });
          if (
            result.bytes.byteLength !== artifact.catalogEntry.sizeBytes ||
            result.receipt.outputSha256 !== artifact.catalogEntry.sha256
          ) {
            throw new ReleaseBuildError('output-integrity-mismatch', 'sanitize');
          }
          try {
            await writeFile(stagedPath, result.bytes, { flag: 'wx', mode: 0o600 });
          } catch (error) {
            if (!isNodeError(error) || error.code !== 'EEXIST') {
              throw new ReleaseBuildError('unsafe-path', 'stage');
            }
            const existingStat = await lstat(stagedPath);
            if (
              existingStat.size !== result.bytes.byteLength ||
              (await sha256File(stagedPath)) !== artifact.catalogEntry.sha256
            ) {
              throw new ReleaseBuildError('output-integrity-mismatch', 'stage');
            }
          }
          receipt = result.receipt;
          outputSize = result.bytes.byteLength;
        }
        totalBytes += outputSize;
        if (totalBytes > this.#options.limits.maximumTotalOutputBytes) {
          throw new ReleaseBuildError('limit-exceeded', 'stage');
        }
        stagedArtifacts.push(
          Object.freeze({
            path: artifact.catalogEntry.path,
            stagedPath,
            size: outputSize,
            sha256: artifact.catalogEntry.sha256,
          }),
        );
        sanitization.push(receipt);
      }

      const unsignedManifest: Omit<ReleaseManifest, 'signature'> = {
        schemaVersion: 1,
        product: { id: 'voidfall', displayName: 'VoidFall' },
        release: {
          version: plan.version,
          buildId: plan.buildId,
          ...(plan.previousVersion === undefined ? {} : { previousVersion: plan.previousVersion }),
          publishedAt: plan.createdAt,
          message: plan.message,
        },
        runtime: plan.runtime,
        serverProfile: plan.serverProfile,
        files: plan.artifacts.map((artifact) => ({
          path: artifact.catalogEntry.path,
          artifactId: `sha256:${artifact.catalogEntry.sha256}`,
          size: artifact.catalogEntry.sizeBytes,
          sha256: artifact.catalogEntry.sha256,
          kind: artifact.catalogEntry.kind,
          side: artifact.catalogEntry.side === 'client' ? 'client' : 'both',
          required: artifact.catalogEntry.requirement !== 'optional',
        })),
        removedPaths: [...plan.removedPaths],
      };
      const manifest = signReleaseManifest(unsignedManifest, this.#options.signer);
      const manifestSha256 = sha256Bytes(canonicalJsonBytes(manifest as CanonicalJsonValue));
      try {
        await this.#options.repository.publishRelease({
          manifest,
          manifestSha256,
          artifacts: Object.freeze(stagedArtifacts),
        });
      } catch (error) {
        if (error instanceof ReleaseBuildError) throw error;
        throw new ReleaseBuildError('repository-failure', 'publish');
      }

      return Object.freeze({
        format: VOIDFALL_RELEASE_FORMAT,
        schemaVersion: VOIDFALL_RELEASE_SCHEMA_VERSION,
        version: plan.version,
        buildId: plan.buildId,
        manifestSha256,
        files: stagedArtifacts.length,
        bytes: totalBytes,
        intendedChannel: plan.intendedChannel,
        stableEligible: stableEligible(plan.gates),
        sanitization: Object.freeze(sanitization),
      });
    } finally {
      await cleanupWorkspace(workspace, stagingRoot);
    }
  }
}
