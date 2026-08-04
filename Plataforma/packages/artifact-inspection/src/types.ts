export const VOIDFALL_ARTIFACT_INSPECTION_FORMAT = 'voidfall-artifact-inspection' as const;
export const VOIDFALL_ARTIFACT_INSPECTION_SCHEMA_VERSION = 1 as const;

/**
 * Bounds applied to every archive. They are deliberately small: this package
 * inspects declared mod metadata, not arbitrary content, so anything larger is
 * refused rather than truncated.
 */
export interface ArtifactInspectionLimits {
  /** Maximum size of the archive itself. */
  readonly maximumArchiveBytes: number;
  /** Maximum number of entries in the central directory. */
  readonly maximumEntries: number;
  /** Maximum length of a single entry name. */
  readonly maximumEntryNameLength: number;
  /** Maximum path depth of a single entry. */
  readonly maximumEntryDepth: number;
  /** Maximum uncompressed size of one metadata file that will be read. */
  readonly maximumMetadataBytes: number;
  /** Maximum total uncompressed bytes this inspection may expand. */
  readonly maximumExpandedBytes: number;
  /** Maximum uncompressed:compressed ratio tolerated for a read entry. */
  readonly maximumCompressionRatio: number;
  /** Maximum number of embedded JarJar libraries reported. */
  readonly maximumEmbeddedLibraries: number;
  /** Maximum number of declared mods reported. */
  readonly maximumDeclaredMods: number;
  /** Maximum number of declared dependencies reported per mod. */
  readonly maximumDeclaredDependencies: number;
}

export const DEFAULT_ARTIFACT_INSPECTION_LIMITS: ArtifactInspectionLimits = Object.freeze({
  maximumArchiveBytes: 64 * 1024 * 1024,
  maximumEntries: 20_000,
  maximumEntryNameLength: 512,
  maximumEntryDepth: 32,
  maximumMetadataBytes: 512 * 1024,
  maximumExpandedBytes: 4 * 1024 * 1024,
  maximumCompressionRatio: 200,
  maximumEmbeddedLibraries: 64,
  maximumDeclaredMods: 64,
  maximumDeclaredDependencies: 128,
});

export type ArtifactInspectionStage =
  | 'options'
  | 'plan'
  | 'container'
  | 'directory'
  | 'entry'
  | 'metadata'
  | 'report';

export type ArtifactInspectionErrorCode =
  | 'invalid-options'
  | 'invalid-plan'
  | 'content-too-large'
  | 'hash-mismatch'
  | 'not-a-zip-container'
  | 'truncated-archive'
  | 'unsupported-zip-feature'
  | 'encrypted-entry'
  | 'too-many-entries'
  | 'entry-name-too-long'
  | 'entry-depth-exceeded'
  | 'unsafe-entry-name'
  | 'metadata-too-large'
  | 'expansion-limit-exceeded'
  | 'compression-ratio-exceeded'
  | 'entry-size-mismatch'
  | 'invalid-metadata';

const MESSAGES: Readonly<Record<ArtifactInspectionErrorCode, string>> = Object.freeze({
  'invalid-options': 'The inspection options are invalid.',
  'invalid-plan': 'The inspection request is invalid.',
  'content-too-large': 'The artifact exceeds its inspection limit.',
  'hash-mismatch': 'The artifact content does not match the expected hash.',
  'not-a-zip-container': 'The artifact is not a ZIP container.',
  'truncated-archive': 'The ZIP container is truncated or malformed.',
  'unsupported-zip-feature': 'The ZIP container uses an unsupported feature.',
  'encrypted-entry': 'The ZIP container has an encrypted entry.',
  'too-many-entries': 'The ZIP container declares too many entries.',
  'entry-name-too-long': 'A ZIP entry name exceeds its limit.',
  'entry-depth-exceeded': 'A ZIP entry path is too deep.',
  'unsafe-entry-name': 'A ZIP entry name is unsafe.',
  'metadata-too-large': 'A metadata file exceeds its inspection limit.',
  'expansion-limit-exceeded': 'The inspection would expand more bytes than allowed.',
  'compression-ratio-exceeded': 'A metadata file has an implausible compression ratio.',
  'entry-size-mismatch': 'A metadata file does not match its declared size.',
  'invalid-metadata': 'A metadata file could not be read within its strict subset.',
});

/**
 * Public errors are sanitized: they carry a stable code and stage, never a
 * filesystem path, an entry name or a host detail.
 */
export class ArtifactInspectionError extends Error {
  public readonly code: ArtifactInspectionErrorCode;
  public readonly stage: ArtifactInspectionStage;

  public constructor(code: ArtifactInspectionErrorCode, stage: ArtifactInspectionStage) {
    super(MESSAGES[code]);
    this.name = 'ArtifactInspectionError';
    this.code = code;
    this.stage = stage;
  }
}

export type DeclaredLoader = 'forge' | 'neoforge' | 'fabric' | 'legacy-mcmod' | 'unknown';

export type DeclaredSide = 'CLIENT' | 'SERVER' | 'BOTH';

export interface DeclaredDependency {
  readonly target: string;
  readonly mandatory: boolean;
  readonly versionRange: string | null;
  readonly side: DeclaredSide;
  readonly evidence: string;
}

export interface DeclaredMod {
  readonly modId: string;
  readonly displayName: string | null;
  /**
   * Declared version exactly as written. `${file.jarVersion}` and similar
   * substitutions stay unresolved on purpose: this package reports what the
   * artifact declares, it does not evaluate it.
   */
  readonly version: string | null;
  readonly loader: DeclaredLoader;
  readonly dependencies: readonly DeclaredDependency[];
  readonly evidence: string;
}

export interface EmbeddedLibrary {
  readonly identifier: string;
  readonly version: string | null;
  readonly evidence: string;
}

export interface ArtifactInspectionReport {
  readonly format: typeof VOIDFALL_ARTIFACT_INSPECTION_FORMAT;
  readonly schemaVersion: typeof VOIDFALL_ARTIFACT_INSPECTION_SCHEMA_VERSION;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly inspectedAt: string;
  readonly container: 'zip';
  readonly entryCount: number;
  readonly expandedBytes: number;
  readonly loaders: readonly DeclaredLoader[];
  readonly mods: readonly DeclaredMod[];
  readonly embeddedLibraries: readonly EmbeddedLibrary[];
  /** Entry names of the metadata actually read, in a stable order. */
  readonly evidence: readonly string[];
  /**
   * Metadata that was present but could not be read within the strict subset.
   * An unreadable declaration is recorded, never guessed.
   */
  readonly metadataIssues: readonly string[];
  readonly features: {
    readonly containsClasses: boolean;
    readonly containsData: boolean;
    readonly containsAssets: boolean;
    readonly containsMixins: boolean;
    readonly containsNestedJars: boolean;
  };
}
