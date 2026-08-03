export type GenericConfigurationFormat =
  | 'java-properties'
  | 'json'
  | 'toml'
  | 'yaml'
  | 'cfg';

export type GenericConfigurationValue = string | number | boolean;
export type GenericStringPattern = 'identifier' | 'hostname' | 'relative-path' | 'non-empty';

interface GenericConfigurationFieldBase {
  readonly required: boolean;
  readonly restartRequired: boolean;
  readonly description?: string;
}

export interface GenericBooleanField extends GenericConfigurationFieldBase {
  readonly type: 'boolean';
  readonly defaultValue?: boolean;
}

export interface GenericIntegerField extends GenericConfigurationFieldBase {
  readonly type: 'integer';
  readonly minimum: number;
  readonly maximum: number;
  readonly defaultValue?: number;
}

export interface GenericNumberField extends GenericConfigurationFieldBase {
  readonly type: 'number';
  readonly minimum: number;
  readonly maximum: number;
  readonly defaultValue?: number;
}

export interface GenericStringField extends GenericConfigurationFieldBase {
  readonly type: 'string';
  readonly maximumLength: number;
  readonly pattern?: GenericStringPattern;
  readonly defaultValue?: string;
}

export interface GenericEnumField extends GenericConfigurationFieldBase {
  readonly type: 'enum';
  readonly values: readonly string[];
  readonly defaultValue?: string;
}

export type GenericConfigurationField =
  | GenericBooleanField
  | GenericIntegerField
  | GenericNumberField
  | GenericStringField
  | GenericEnumField;

export interface GenericConfigurationSchema {
  readonly schemaId: string;
  readonly resourceId: string;
  readonly schemaVersion: string;
  readonly format: GenericConfigurationFormat;
  readonly filePath: string;
  readonly fields: Readonly<Record<string, GenericConfigurationField>>;
}

export interface ConfigurationSchemaRegistryOptions {
  readonly maximumSchemas: number;
  readonly maximumRevisionsPerSchema: number;
}

export interface RegisterConfigurationSchemaPlan {
  readonly revisionId: string;
  readonly actorId: string;
  readonly reasonCode: string;
  readonly createdAt: string;
  readonly expectedSchemaSha256: string | null;
  readonly schema: GenericConfigurationSchema;
}

export interface ConfigurationSchemaRevision {
  readonly revisionId: string;
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly actorId: string;
  readonly reasonCode: string;
  readonly createdAt: string;
  readonly previousSchemaSha256: string | null;
  readonly currentSchemaSha256: string;
}

export interface ConfigurationSchemaHistoryEntry {
  readonly revision: ConfigurationSchemaRevision;
  readonly schema: GenericConfigurationSchema;
}

export interface ConfigurationSchemaRevisionReceipt {
  readonly revision: ConfigurationSchemaRevision;
  readonly schema: GenericConfigurationSchema;
}

export type ConfigurationValueIssueCode =
  | 'unknown-field'
  | 'missing-required-field'
  | 'invalid-type'
  | 'out-of-range'
  | 'too-long'
  | 'pattern-mismatch';

export interface ConfigurationValueIssue {
  readonly field: string;
  readonly code: ConfigurationValueIssueCode;
}

export type ConfigurationValueValidationResult =
  | {
      readonly success: true;
      readonly values: Readonly<Record<string, GenericConfigurationValue>>;
      readonly restartRequiredFields: readonly string[];
      readonly issues: readonly [];
    }
  | {
      readonly success: false;
      readonly issues: readonly ConfigurationValueIssue[];
    };

export type ConfigurationSchemaOperationErrorCode =
  | 'invalid-options'
  | 'invalid-plan'
  | 'invalid-schema'
  | 'schema-limit-exceeded'
  | 'history-limit-exceeded'
  | 'schema-conflict'
  | 'revision-conflict'
  | 'concurrent-modification'
  | 'no-change'
  | 'schema-not-found';

export class ConfigurationSchemaOperationError extends Error {
  public readonly code: ConfigurationSchemaOperationErrorCode;

  public constructor(code: ConfigurationSchemaOperationErrorCode) {
    super(`configuration-schema:${code}`);
    this.name = 'ConfigurationSchemaOperationError';
    this.code = code;
  }
}
