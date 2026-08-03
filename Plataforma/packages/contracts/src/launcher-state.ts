import { Type, type Static } from '@sinclair/typebox';
import {
  BuildIdSchema,
  ContractSchemaVersion,
  IsoDateTimeSchema,
  RelativePathSchema,
  SemanticVersionSchema,
  Sha256Schema,
  SlugSchema,
} from './common.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

export const LauncherManagedStateSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    product: Type.Object(
      { id: Type.Literal('voidfall'), displayName: Type.Literal('VoidFall') },
      { additionalProperties: false },
    ),
    channel: SlugSchema,
    channelRevision: Type.Integer({ minimum: 1 }),
    releaseVersion: SemanticVersionSchema,
    buildId: BuildIdSchema,
    installedAt: IsoDateTimeSchema,
    files: Type.Array(
      Type.Object(
        { path: RelativePathSchema, sha256: Sha256Schema },
        { additionalProperties: false },
      ),
      { maxItems: 100_000 },
    ),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/launcher-managed-state.schema.json',
    additionalProperties: false,
  },
);

export type LauncherManagedState = Static<typeof LauncherManagedStateSchema>;

function normalizedPath(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

export function validateLauncherManagedState(
  value: unknown,
): ContractValidationResult<LauncherManagedState> {
  const result = validateContract(LauncherManagedStateSchema, value);
  if (!result.success) return result;

  const issues: ContractValidationIssue[] = [];
  const paths = result.value.files.map((file) => normalizedPath(file.path));
  if (new Set(paths).size !== paths.length) {
    issues.push(semanticIssue('/files', 'managed paths must be unique after normalization'));
  }
  for (let index = 1; index < paths.length; index += 1) {
    const previous = paths[index - 1];
    const current = paths[index];
    if (previous !== undefined && current !== undefined && previous.localeCompare(current, 'en-US') >= 0) {
      issues.push(semanticIssue('/files', 'managed paths must be strictly sorted'));
      break;
    }
  }
  return appendSemanticIssues(result, issues);
}
