import { Type, type Static } from '@sinclair/typebox';
import {
  BuildIdSchema,
  ContractSchemaVersion,
  IsoDateTimeSchema,
  SemanticVersionSchema,
  Sha256Schema,
  SignatureSchema,
  SlugSchema,
} from './common.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

const PreviousChannelRevisionSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    releaseVersion: SemanticVersionSchema,
    buildId: BuildIdSchema,
  },
  { additionalProperties: false },
);

export const LauncherChannelSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    product: Type.Object(
      {
        id: Type.Literal('voidfall'),
        displayName: Type.Literal('VoidFall'),
      },
      { additionalProperties: false },
    ),
    channel: SlugSchema,
    revision: Type.Integer({ minimum: 1 }),
    operation: Type.Union([Type.Literal('promotion'), Type.Literal('rollback')]),
    releaseVersion: SemanticVersionSchema,
    buildId: BuildIdSchema,
    manifestSha256: Sha256Schema,
    manifestUrl: Type.String({ format: 'uri', maxLength: 2_048 }),
    publishedAt: IsoDateTimeSchema,
    previous: Type.Optional(PreviousChannelRevisionSchema),
    signature: SignatureSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/launcher-channel.schema.json',
    additionalProperties: false,
  },
);

export type LauncherChannel = Static<typeof LauncherChannelSchema>;

export function validateLauncherChannel(value: unknown): ContractValidationResult<LauncherChannel> {
  const result = validateContract(LauncherChannelSchema, value);
  if (!result.success) return result;

  const channel = result.value;
  const issues: ContractValidationIssue[] = [];
  if (channel.revision === 1 && channel.previous !== undefined) {
    issues.push(semanticIssue('/previous', 'the first channel revision cannot have a predecessor'));
  }
  if (channel.revision > 1) {
    if (channel.previous === undefined || channel.previous.revision !== channel.revision - 1) {
      issues.push(semanticIssue('/previous', 'channel revisions must form a contiguous chain'));
    }
  }
  if (channel.operation === 'rollback' && channel.previous === undefined) {
    issues.push(semanticIssue('/operation', 'rollback requires a previous channel revision'));
  }
  try {
    const url = new URL(channel.manifestUrl);
    if (url.protocol !== 'https:') {
      issues.push(semanticIssue('/manifestUrl', 'production launcher documents require HTTPS'));
    }
  } catch {
    issues.push(semanticIssue('/manifestUrl', 'manifest URL must be absolute'));
  }
  return appendSemanticIssues(result, issues);
}
