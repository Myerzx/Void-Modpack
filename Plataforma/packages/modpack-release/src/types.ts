import type { LauncherChannel, ModCatalogEntry, ReleaseManifest } from '@voidfall/contracts';

export const VOIDFALL_RELEASE_FORMAT = 'voidfall-release' as const;
export const VOIDFALL_RELEASE_SCHEMA_VERSION = 1 as const;

export type ReleaseChannel = 'beta' | 'stable';

export interface ReleaseExternalGates {
  readonly clientBaseApproved: boolean;
  readonly distributionChainApproved: boolean;
  readonly cleanImportPassed: boolean;
  readonly launchCompatibilityPassed: boolean;
  readonly dependencyBlockerCount: number;
}

export interface ExactReviewedBytesPolicy {
  readonly strategy: 'exact-reviewed-bytes-v1';
}

export interface CanonicalJsonObjectPolicy {
  readonly strategy: 'canonical-json-object-v1';
  readonly allowedKeys: readonly string[];
}

export interface JavaPropertiesAllowlistPolicy {
  readonly strategy: 'java-properties-allowlist-v1';
  readonly allowedKeys: readonly string[];
}

export type ReleaseSanitizationPolicy =
  | ExactReviewedBytesPolicy
  | CanonicalJsonObjectPolicy
  | JavaPropertiesAllowlistPolicy;

export interface ReleaseBuildArtifact {
  readonly catalogEntry: ModCatalogEntry;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly sanitization: ReleaseSanitizationPolicy;
}

export interface ReleaseBuildPlan {
  readonly version: string;
  readonly buildId: string;
  readonly previousVersion?: string;
  readonly createdAt: string;
  readonly message: string;
  readonly runtime: {
    readonly minecraft: string;
    readonly loader: 'forge' | 'neoforge' | 'fabric' | 'quilt';
    readonly loaderVersion: string;
    readonly javaMajor: number;
  };
  readonly serverProfile: {
    readonly id: string;
    readonly displayName: string;
  };
  readonly intendedChannel: ReleaseChannel;
  readonly artifacts: readonly ReleaseBuildArtifact[];
  readonly removedPaths: readonly string[];
  readonly gates: ReleaseExternalGates;
}

export interface ReleaseBuildLimits {
  readonly maximumFiles: number;
  readonly maximumInputFileBytes: number;
  readonly maximumOutputFileBytes: number;
  readonly maximumTotalOutputBytes: number;
}

export const DEFAULT_RELEASE_BUILD_LIMITS: ReleaseBuildLimits = Object.freeze({
  maximumFiles: 100_000,
  maximumInputFileBytes: 2 * 1_024 ** 3,
  maximumOutputFileBytes: 2 * 1_024 ** 3,
  maximumTotalOutputBytes: 32 * 1_024 ** 3,
});

export interface ReleaseSanitizationReceipt {
  readonly strategy: ReleaseSanitizationPolicy['strategy'];
  readonly sourceSha256: string;
  readonly outputSha256: string;
  readonly removedFieldCount: number;
}

export interface StagedReleaseArtifact {
  readonly path: string;
  readonly stagedPath: string;
  readonly size: number;
  readonly sha256: string;
}

export interface PublishReleaseInput {
  readonly manifest: ReleaseManifest;
  readonly manifestSha256: string;
  readonly artifacts: readonly StagedReleaseArtifact[];
}

export interface ReleaseRepository {
  publishRelease(input: PublishReleaseInput): Promise<void>;
}

export interface ReleaseDocumentSigner {
  readonly keyId: string;
  sign(payload: Uint8Array): string;
}

export interface FilesystemReleaseBuilderOptions {
  readonly sourceRoot: string;
  readonly stagingRoot: string;
  readonly repository: ReleaseRepository;
  readonly signer: ReleaseDocumentSigner;
  readonly limits?: Partial<ReleaseBuildLimits>;
}

export interface ReleaseBuildReceipt {
  readonly format: typeof VOIDFALL_RELEASE_FORMAT;
  readonly schemaVersion: typeof VOIDFALL_RELEASE_SCHEMA_VERSION;
  readonly version: string;
  readonly buildId: string;
  readonly manifestSha256: string;
  readonly files: number;
  readonly bytes: number;
  readonly intendedChannel: ReleaseChannel;
  readonly stableEligible: boolean;
  readonly sanitization: readonly ReleaseSanitizationReceipt[];
}

export interface FilesystemReleaseRepositoryOptions {
  readonly root: string;
  readonly signer?: ReleaseDocumentSigner;
  readonly maximumManifestBytes?: number;
}

export interface StoredRelease {
  readonly manifest: ReleaseManifest;
  readonly manifestSha256: string;
}

export interface StoredArtifact {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ChannelPromotionPlan {
  readonly channel: ReleaseChannel;
  readonly expectedRevision: number | null;
  readonly releaseVersion: string;
  readonly buildId: string;
  readonly manifestUrl: string;
  readonly publishedAt: string;
  readonly gates: ReleaseExternalGates;
}

export interface ChannelRollbackPlan {
  readonly channel: ReleaseChannel;
  readonly expectedRevision: number;
  readonly releaseVersion: string;
  readonly buildId: string;
  readonly manifestUrl: string;
  readonly publishedAt: string;
}

export type ChannelMutationReceipt = LauncherChannel;

export type ReleaseRepositoryStage =
  | 'options'
  | 'layout'
  | 'artifact'
  | 'manifest'
  | 'channel'
  | 'cleanup';

export type ReleaseRepositoryErrorCode =
  | 'invalid-options'
  | 'invalid-document'
  | 'unsafe-path'
  | 'immutable-conflict'
  | 'artifact-integrity'
  | 'channel-conflict'
  | 'stable-gate-blocked'
  | 'not-found'
  | 'storage-failure'
  | 'cleanup-failed';

export class ReleaseRepositoryError extends Error {
  public readonly code: ReleaseRepositoryErrorCode;
  public readonly stage: ReleaseRepositoryStage;

  public constructor(code: ReleaseRepositoryErrorCode, stage: ReleaseRepositoryStage) {
    super(`modpack-release:${code}:${stage}`);
    this.name = 'ReleaseRepositoryError';
    this.code = code;
    this.stage = stage;
  }
}

export type ReleaseBuildStage =
  | 'options'
  | 'plan'
  | 'preflight'
  | 'sanitize'
  | 'stage'
  | 'sign'
  | 'publish'
  | 'cleanup';

export type ReleaseBuildErrorCode =
  | 'invalid-options'
  | 'invalid-plan'
  | 'unsafe-path'
  | 'unsupported-entry'
  | 'limit-exceeded'
  | 'source-integrity-mismatch'
  | 'sanitization-failed'
  | 'output-integrity-mismatch'
  | 'stable-gate-blocked'
  | 'repository-failure'
  | 'cleanup-failed';

const ERROR_MESSAGES: Readonly<Record<ReleaseBuildErrorCode, string>> = Object.freeze({
  'invalid-options': 'The release builder options are invalid.',
  'invalid-plan': 'The release build plan is invalid.',
  'unsafe-path': 'The release build rejected an unsafe path.',
  'unsupported-entry': 'The release build found an unsupported filesystem entry.',
  'limit-exceeded': 'The release build exceeded a configured safety limit.',
  'source-integrity-mismatch': 'The release source integrity check failed.',
  'sanitization-failed': 'The release sanitization policy rejected the input.',
  'output-integrity-mismatch': 'The sanitized output does not match the reviewed catalog entry.',
  'stable-gate-blocked': 'Stable release gates are not satisfied.',
  'repository-failure': 'The immutable release repository operation failed.',
  'cleanup-failed': 'The release build could not clean its private staging directory.',
});

export class ReleaseBuildError extends Error {
  public readonly code: ReleaseBuildErrorCode;
  public readonly stage: ReleaseBuildStage;

  public constructor(code: ReleaseBuildErrorCode, stage: ReleaseBuildStage) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ReleaseBuildError';
    this.code = code;
    this.stage = stage;
  }
}
