export const VOIDFALL_CONFIGURATION_REVISION_FORMAT =
  'voidfall-configuration-revision' as const;
export const VOIDFALL_CONFIGURATION_REVISION_SCHEMA_VERSION = 2 as const;
export const JAVA_PROPERTIES_V1 = 'java-properties-v1' as const;
export const OPENLOADER_ADVANCED_OPTIONS_V1 =
  'openloader-advanced-options-v1' as const;

export type ConfigurationFormat =
  | typeof JAVA_PROPERTIES_V1
  | typeof OPENLOADER_ADVANCED_OPTIONS_V1;

export type ConfigurationValue = string | number | boolean;

interface ConfigurationFieldBase {
  readonly restartRequired: boolean;
}

export interface BooleanConfigurationField extends ConfigurationFieldBase {
  readonly type: 'boolean';
}

export interface IntegerConfigurationField extends ConfigurationFieldBase {
  readonly type: 'integer';
  readonly minimum: number;
  readonly maximum: number;
}

export interface EnumConfigurationField extends ConfigurationFieldBase {
  readonly type: 'enum';
  readonly values: readonly string[];
}

export interface StringConfigurationField extends ConfigurationFieldBase {
  readonly type: 'string';
  readonly maximumLength: number;
}

export type BasicConfigurationField =
  | BooleanConfigurationField
  | IntegerConfigurationField
  | EnumConfigurationField
  | StringConfigurationField;

export interface ConfigurationResourceDefinition {
  readonly resourceId: string;
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly schemaSha256: string;
  readonly filePath: string;
  readonly format: ConfigurationFormat;
  readonly maximumBytes: number;
  readonly fields: Readonly<Record<string, BasicConfigurationField>>;
}

export interface ApplyConfigurationPlan {
  readonly resourceId: string;
  readonly revisionId: string;
  readonly expectedCurrentSha256: string;
  readonly reasonCode: string;
  readonly changes: Readonly<Record<string, ConfigurationValue>>;
}

export interface RollbackConfigurationPlan {
  readonly resourceId: string;
  readonly revisionId: string;
  readonly sourceRevisionId: string;
  readonly expectedCurrentSha256: string;
  readonly reasonCode: string;
}

/**
 * Result of a guarded typed read. It never carries bytes, a path or a manifest;
 * redaction for external consumers is applied separately by the presentation
 * policy, which is the only thing allowed to publish a value.
 */
export interface ConfigurationReadResult {
  readonly resourceId: string;
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly schemaSha256: string;
  readonly currentSha256: string;
  readonly byteLength: number;
  readonly values: Readonly<Record<string, ConfigurationValue>>;
  readonly observedAt: string;
}

export interface ConfigurationConsistencyLease {
  readonly method: 'offline-exclusive-v1';
  readonly acquiredAt: Date;
}

export interface OfflineExclusiveConfigurationGuard {
  runWithExclusiveOfflineAccess<T>(
    resourceId: string,
    operation: (lease: ConfigurationConsistencyLease) => Promise<T>,
  ): Promise<T>;
}

export interface ConfigurationReplacementInput {
  readonly targetPath: string;
  readonly temporaryPath: string;
  readonly content: Uint8Array;
  readonly mode: number;
}

export interface ConfigurationFileReplacer {
  replace(input: ConfigurationReplacementInput): Promise<void>;
}

export type ConfigurationOperation = 'update' | 'rollback';

export interface ConfigurationMutationReceipt {
  readonly operation: ConfigurationOperation;
  readonly revisionId: string;
  readonly resourceId: string;
  readonly createdAt: string;
  readonly previousSha256: string;
  readonly currentSha256: string;
  readonly manifestSha256: string;
  readonly changedFields: readonly string[];
  readonly restartRequired: boolean;
  readonly restoredFromRevisionId?: string;
}

export type ConfigurationOperationStage =
  | 'definition'
  | 'plan'
  | 'guard'
  | 'preflight'
  | 'revision'
  | 'replace'
  | 'verify'
  | 'cleanup';

export type ConfigurationOperationErrorCode =
  | 'invalid-definition'
  | 'invalid-plan'
  | 'consistency-unavailable'
  | 'resource-not-found'
  | 'unsafe-path'
  | 'unsupported-entry'
  | 'content-too-large'
  | 'invalid-content'
  | 'schema-mismatch'
  | 'revision-conflict'
  | 'concurrent-modification'
  | 'no-change'
  | 'revision-integrity-mismatch'
  | 'replacement-failed'
  | 'verification-failed'
  | 'recovery-failed'
  | 'cleanup-failed';

const ERROR_MESSAGES: Readonly<Record<ConfigurationOperationErrorCode, string>> =
  Object.freeze({
    'invalid-definition': 'The configuration resource definition is invalid.',
    'invalid-plan': 'The configuration operation is invalid.',
    'consistency-unavailable': 'Exclusive offline access is unavailable.',
    'resource-not-found': 'The configuration resource was not found.',
    'unsafe-path': 'The configuration path is unsafe.',
    'unsupported-entry': 'The configuration entry type is unsupported.',
    'content-too-large': 'The configuration content exceeds its limit.',
    'invalid-content': 'The configuration content is invalid.',
    'schema-mismatch': 'The configuration schema does not match.',
    'revision-conflict': 'The configuration revision already exists.',
    'concurrent-modification': 'The configuration changed concurrently.',
    'no-change': 'The configuration operation would not change the resource.',
    'revision-integrity-mismatch': 'The configuration revision failed integrity verification.',
    'replacement-failed': 'The configuration could not be replaced.',
    'verification-failed': 'The replaced configuration failed verification.',
    'recovery-failed': 'The previous configuration could not be recovered.',
    'cleanup-failed': 'Configuration cleanup failed.',
  });

export class ConfigurationOperationError extends Error {
  readonly code: ConfigurationOperationErrorCode;
  readonly stage: ConfigurationOperationStage;

  constructor(code: ConfigurationOperationErrorCode, stage: ConfigurationOperationStage) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ConfigurationOperationError';
    this.code = code;
    this.stage = stage;
  }
}

export interface FilesystemConfigurationServiceOptions {
  readonly repositoryRoot: string;
  readonly resources: readonly ConfigurationResourceDefinition[];
  readonly guard: OfflineExclusiveConfigurationGuard;
  readonly clock?: () => Date;
  readonly fileReplacer?: ConfigurationFileReplacer;
}
